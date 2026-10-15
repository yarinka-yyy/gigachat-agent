import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { AcceptedTurnInput, ChatArtifact, ProviderAttachmentReference, ProviderFileRecord, ProviderTurnRequest, ProviderUploadLedgerEntry } from './contracts';
import { attachmentContentType, inspectLocalAttachmentContent } from './attachment-policy';
import { GigaChatProviderError, type GigaChatProviderConnection } from './gigachat-provider';
import { HistoricalProviderStateAttachmentsError } from './provider-state';
import type { LocalStore } from './store';

type AttachmentStore = Pick<LocalStore,
  'getChat' | 'getArtifactPath' | 'listChats' | 'getHomeDraft' | 'getProviderUploadEntries' | 'putProviderUploadEntry' | 'removeProviderUploadEntry'>;

export interface AttachmentPreparationOptions {
  store: AttachmentStore;
  provider: Pick<GigaChatProviderConnection, 'uploadFile' | 'listFiles' | 'deleteFile'>;
  loadAuthorizationKey(): Promise<string | null>;
  now?: () => number;
}

export async function prepareTurnAttachments(
  turn: AcceptedTurnInput,
  request: ProviderTurnRequest,
  signal: AbortSignal,
  options: AttachmentPreparationOptions,
): Promise<ProviderTurnRequest> {
  if (turn.operation === 'compaction') return request;
  if (request.attachments?.length) throw new GigaChatProviderError('protocol');
  const acceptedMessages = turn.messages.filter((message) => message.id === turn.messageId);
  const acceptedMessage = acceptedMessages[0];
  if (acceptedMessages.length !== 1 || acceptedMessage?.role !== 'user') throw new GigaChatProviderError('protocol');
  if (turn.messages.indexOf(acceptedMessage) !== turn.messages.length - 1) throw new GigaChatProviderError('protocol');
  const localIds = acceptedMessage.attachmentIds ?? [];
  if (new Set(localIds).size !== localIds.length || JSON.stringify(turn.attachmentIds ?? []) !== JSON.stringify(localIds)) {
    throw new GigaChatProviderError('protocol');
  }
  const requestMessages = request.messages.filter((message) => message.id === turn.messageId);
  const requestMessage = requestMessages[0];
  if (requestMessages.length !== 1 || !requestMessage || requestMessage.role !== 'user'
    || request.messages.indexOf(requestMessage) !== request.messages.length - 1
    || JSON.stringify(requestMessage.attachmentIds ?? []) !== JSON.stringify(localIds)) {
    throw new GigaChatProviderError('protocol');
  }

  const acceptedMessageIndex = turn.messages.indexOf(acceptedMessage);
  const origins: Array<{ messageId: string; attachmentId: string; historical: boolean }> = [];
  const seenMessageIds = new Set<string>();
  const seenAttachmentIds = new Set<string>();
  for (const message of turn.messages.slice(0, acceptedMessageIndex + 1)) {
    if (!message.id || seenMessageIds.has(message.id)) throw new GigaChatProviderError('protocol');
    seenMessageIds.add(message.id);
    const attachmentIds = message.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || (message.role !== 'user' && attachmentIds.length > 0)
      || new Set(attachmentIds).size !== attachmentIds.length) throw new GigaChatProviderError('protocol');
    for (const attachmentId of attachmentIds) {
      if (typeof attachmentId !== 'string' || !attachmentId || seenAttachmentIds.has(attachmentId)) {
        throw new GigaChatProviderError('protocol');
      }
      seenAttachmentIds.add(attachmentId);
      origins.push({ messageId: message.id, attachmentId, historical: message.id !== turn.messageId });
    }
  }

  const authorizationKey = await options.loadAuthorizationKey();
  if (!authorizationKey) throw new GigaChatProviderError('auth');
  const accountScope = createHash('sha256').update(authorizationKey, 'utf8').digest('hex');
  const entries = await options.store.getProviderUploadEntries(accountScope);
  const detail = await options.store.getChat(turn.chatId);
  let providerFiles: Promise<ProviderFileRecord[]> | null = null;
  const listProviderFiles = (): Promise<ProviderFileRecord[]> => {
    providerFiles ??= options.provider.listFiles(signal);
    return providerFiles;
  };
  const selected: Array<{
    messageId: string;
    attachmentId: string;
    historical: boolean;
    artifact: ChatArtifact;
    declaredKind: 'document' | 'image' | null;
  }> = [];
  for (const origin of origins) {
    throwIfAborted(signal);
    const artifactMatches = detail.artifacts.filter((item) => item.id === origin.attachmentId && item.messageId === origin.messageId);
    if (artifactMatches.length !== 1) throw new GigaChatProviderError('storage');
    const artifact = artifactMatches[0]!;
    if (origin.historical && attachmentContentType(artifact.name)?.kind === 'image') continue;
    selected.push({ ...origin, artifact, declaredKind: attachmentContentType(artifact.name)?.kind ?? null });
  }

  if (selected.length > 32 || selected.filter((item) => !item.historical && item.declaredKind === 'image').length > 10) {
    throw new GigaChatProviderError('context');
  }

  const historical = selected.filter((item) => item.historical);
  for (const item of historical) {
    const matchingEntries = entries.filter((entry) => entry.attachmentId === item.attachmentId);
    const existing = matchingEntries[0];
    if (matchingEntries.length > 1) throw new GigaChatProviderError('storage');
    if (!existing || existing.state !== 'uploaded' || !existing.remoteFileId) {
      throw new HistoricalProviderStateAttachmentsError();
    }
  }

  const prepared: Array<{
    messageId: string;
    attachmentId: string;
    historical: boolean;
    artifact: ChatArtifact;
    identity: Omit<ProviderUploadLedgerEntry, 'state' | 'remoteFileId' | 'createdAt'>;
    existing?: ProviderUploadLedgerEntry;
  }> = [];
  for (const item of selected) {
    throwIfAborted(signal);
    const file = await readVerifiedArtifact(options.store, turn.chatId, item.artifact, signal);
    const uploadFilename = makeUploadFilename(item.artifact);
    const identity = {
      accountScope, attachmentId: item.attachmentId, uploadFilename, name: item.artifact.name, contentType: file.contentType,
      kind: file.kind, sizeBytes: item.artifact.size, sha256: file.sha256,
    };
    const matchingEntries = entries.filter((entry) => entry.attachmentId === item.attachmentId);
    if (matchingEntries.length > 1) throw new GigaChatProviderError('storage');
    const existing = matchingEntries[0];
    if (existing && !sameUploadIdentity(existing, identity)) throw new GigaChatProviderError('storage');
    prepared.push({ ...item, identity, ...(existing ? { existing } : {}) });
  }

  const references: ProviderAttachmentReference[] = [];
  if (historical.length) {
    const providerRecords = await listProviderFiles();
    for (const item of prepared.filter((candidate) => candidate.historical)) {
      const saved = item.existing;
      if (!saved?.remoteFileId) throw new HistoricalProviderStateAttachmentsError();
      const remoteMatches = providerRecords.filter((record) => record.id === saved.remoteFileId);
      if (remoteMatches.length !== 1) throw new HistoricalProviderStateAttachmentsError();
      const remote = remoteMatches[0]!;
      if (remote.filename !== saved.uploadFilename || remote.bytes !== saved.sizeBytes || remote.purpose !== 'general') {
        throw new GigaChatProviderError('protocol');
      }
      references.push(toProviderReference(turn.messageId, item.attachmentId, item.artifact,
        { contentType: item.identity.contentType, kind: item.identity.kind }, saved.remoteFileId));
    }
  }

  for (const item of prepared.filter((candidate) => !candidate.historical)) {
    const file = await readVerifiedArtifact(options.store, turn.chatId, item.artifact, signal);
    const currentIdentity = {
      ...item.identity,
      contentType: file.contentType,
      sha256: file.sha256,
    };
    if (!sameUploadIdentity(currentIdentity, item.identity)) throw new GigaChatProviderError('storage');
    let saved = item.existing;
    if (saved?.state === 'uploaded' && saved.remoteFileId) {
      const remoteMatches = (await listProviderFiles()).filter((record) => record.id === saved!.remoteFileId);
      if (remoteMatches.length !== 1) throw missingRemoteAttachmentError();
      const remote = remoteMatches[0]!;
      if (remote.filename !== saved.uploadFilename || remote.bytes !== saved.sizeBytes || remote.purpose !== 'general') {
        throw new GigaChatProviderError('protocol');
      }
      references.push(toProviderReference(turn.messageId, item.attachmentId, item.artifact, file, saved.remoteFileId));
      continue;
    }
    if (saved?.state === 'cleanup-pending') throw new GigaChatProviderError('storage');
    if (saved) {
      const matches = (await listProviderFiles()).filter((record) => record.purpose === 'general'
        && record.filename === saved!.uploadFilename && record.bytes === saved!.sizeBytes);
      if (matches.length === 1) {
        saved = await options.store.putProviderUploadEntry({ ...saved, state: 'uploaded', remoteFileId: matches[0]!.id });
        references.push(toProviderReference(turn.messageId, item.attachmentId, item.artifact, file, matches[0]!.id));
        continue;
      }
      if (matches.length > 1 && saved.state !== 'unknown') {
        await options.store.putProviderUploadEntry({ ...saved, state: 'unknown' });
      } else if (matches.length === 0 && saved.state === 'intent') {
        await options.store.putProviderUploadEntry({ ...saved, state: 'unknown' });
      }
      throw new GigaChatProviderError(matches.length > 1 ? 'protocol' : 'storage');
    }

    const intent: ProviderUploadLedgerEntry = {
      ...item.identity,
      state: 'intent',
      remoteFileId: null,
      createdAt: new Date((options.now ?? Date.now)()).toISOString(),
    };
    await options.store.putProviderUploadEntry(intent);
    let uploaded;
    try {
      throwIfAborted(signal);
      uploaded = await options.provider.uploadFile({ filename: item.identity.uploadFilename, contentType: file.contentType, bytes: file.bytes }, signal);
    } catch (error) {
      try { await options.store.putProviderUploadEntry({ ...intent, state: 'unknown' }); }
      catch { throw new GigaChatProviderError('storage'); }
      throw error;
    }
    await options.store.putProviderUploadEntry({ ...intent, state: 'uploaded', remoteFileId: uploaded.id });
    references.push(toProviderReference(turn.messageId, item.attachmentId, item.artifact, file, uploaded.id));
  }

  const referencedIds = new Set(origins.map((origin) => origin.attachmentId));
  await cleanupUnreferencedUploads(accountScope, options, signal, referencedIds, listProviderFiles);
  const projectedIds = prepared.map((item) => item.attachmentId);
  const messages = JSON.stringify(requestMessage.attachmentIds ?? []) === JSON.stringify(projectedIds)
    ? request.messages
    : request.messages.map((message) => message.id === turn.messageId ? { ...message, attachmentIds: projectedIds } : message);
  return { ...request, messages, attachments: references };
}

async function readVerifiedArtifact(
  store: AttachmentStore,
  chatId: string,
  artifact: ChatArtifact,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; sha256: string; contentType: string; kind: 'document' | 'image' }> {
  if (!artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new GigaChatProviderError('storage');
  const path = await store.getArtifactPath(chatId, artifact.id);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== artifact.size || !samePath(await realpath(path), path)) {
    throw new GigaChatProviderError('storage');
  }
  const bytes = await readFile(path);
  throwIfAborted(signal);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.dev !== before.dev
    || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || !samePath(await realpath(path), path)
    || bytes.byteLength !== artifact.size) throw new GigaChatProviderError('storage');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256) throw new GigaChatProviderError('storage');
  const expected = attachmentContentType(artifact.name);
  let content: ReturnType<typeof inspectLocalAttachmentContent>;
  try { content = inspectLocalAttachmentContent(artifact.name, bytes); }
  catch { throw new GigaChatProviderError('protocol'); }
  if (!expected || !content || content.kind !== expected.kind || content.contentType !== expected.contentType) {
    throw new GigaChatProviderError('protocol');
  }
  return { bytes, sha256, contentType: content.contentType, kind: content.kind };
}

async function cleanupUnreferencedUploads(
  accountScope: string,
  options: AttachmentPreparationOptions,
  signal: AbortSignal,
  currentAttachmentIds: ReadonlySet<string>,
  listProviderFiles: () => Promise<ProviderFileRecord[]>,
): Promise<void> {
  const [entries, chats, homeDraft] = await Promise.all([
    options.store.getProviderUploadEntries(accountScope),
    options.store.listChats(),
    options.store.getHomeDraft(),
  ]);
  const referenced = new Set(currentAttachmentIds);
  for (const attachment of homeDraft.attachments) referenced.add(attachment.id);
  for (const chat of chats) {
    const detail = await options.store.getChat(chat.id);
    for (const attachment of detail.artifacts) referenced.add(attachment.id);
    for (const attachment of detail.draftAttachments) referenced.add(attachment.id);
  }
  for (const entry of entries) {
    throwIfAborted(signal);
    if (referenced.has(entry.attachmentId)) continue;
    let cleanupEntry: ProviderUploadLedgerEntry;
    if (!entry.remoteFileId && (entry.state === 'intent' || entry.state === 'unknown')) {
      let providerFiles: ProviderFileRecord[];
      try { providerFiles = await listProviderFiles(); }
      catch (error) {
        if (signal.aborted) throw error;
        continue;
      }
      const matches = providerFiles.filter((record) => record.purpose === 'general'
        && record.filename === entry.uploadFilename && record.bytes === entry.sizeBytes);
      if (matches.length !== 1) {
        if (entry.state !== 'unknown') await options.store.putProviderUploadEntry({ ...entry, state: 'unknown' });
        continue;
      }
      const recovered = await options.store.putProviderUploadEntry({
        ...entry, state: 'uploaded', remoteFileId: matches[0]!.id,
      });
      cleanupEntry = await options.store.putProviderUploadEntry({ ...recovered, state: 'cleanup-pending' });
    } else if (entry.remoteFileId && (entry.state === 'uploaded' || entry.state === 'cleanup-pending')) {
      cleanupEntry = entry.state === 'cleanup-pending'
        ? entry
        : await options.store.putProviderUploadEntry({ ...entry, state: 'cleanup-pending' });
    } else {
      continue;
    }
    try { await options.provider.deleteFile(cleanupEntry.remoteFileId!, signal); }
    catch (error) {
      if (signal.aborted) throw error;
      continue;
    }
    await options.store.removeProviderUploadEntry(accountScope, cleanupEntry.attachmentId, cleanupEntry.remoteFileId!);
  }
}

function toProviderReference(
  messageId: string,
  attachmentId: string,
  artifact: ChatArtifact,
  file: { contentType: string; kind: 'document' | 'image' },
  fileId: string,
): ProviderAttachmentReference {
  return {
    messageId, attachmentId, fileId,
    name: artifact.name, contentType: file.contentType, kind: file.kind, sizeBytes: artifact.size,
  };
}

function makeUploadFilename(artifact: ChatArtifact): string {
  const extension = extname(artifact.name).toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(artifact.id) || !/^\.(txt|md|pdf|png|jpg|jpeg)$/.test(extension)) {
    throw new GigaChatProviderError('protocol');
  }
  return `gcagent_${artifact.id}${extension === '.md' ? '.txt' : extension}`;
}

export const MISSING_REMOTE_ATTACHMENT_MESSAGE = 'Загруженная копия вложения больше недоступна. Прикрепите файл заново.';

export class MissingRemoteAttachmentError extends GigaChatProviderError {
  readonly code = 'missing_remote_attachment';

  constructor() {
    super('storage');
    this.name = 'MissingRemoteAttachmentError';
    this.message = MISSING_REMOTE_ATTACHMENT_MESSAGE;
  }
}

function missingRemoteAttachmentError(): MissingRemoteAttachmentError {
  return new MissingRemoteAttachmentError();
}

type UploadIdentity = Pick<ProviderUploadLedgerEntry,
  'accountScope' | 'attachmentId' | 'uploadFilename' | 'name' | 'contentType' | 'kind' | 'sizeBytes' | 'sha256'>;

function sameUploadIdentity(entry: UploadIdentity, identity: UploadIdentity): boolean {
  return entry.accountScope === identity.accountScope && entry.attachmentId === identity.attachmentId
    && entry.uploadFilename === identity.uploadFilename && entry.name === identity.name
    && entry.contentType === identity.contentType && entry.kind === identity.kind
    && entry.sizeBytes === identity.sizeBytes && entry.sha256 === identity.sha256;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left).replace(/^\\\\\?\\/, '');
  const b = resolve(right).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new GigaChatProviderError('cancel');
}
