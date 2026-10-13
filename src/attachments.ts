import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { AcceptedTurnInput, ChatArtifact, ProviderAttachmentReference, ProviderFileRecord, ProviderTurnRequest, ProviderUploadLedgerEntry } from './contracts';
import { attachmentContentType, inspectLocalAttachmentContent } from './attachment-policy';
import { GigaChatProviderError, type GigaChatProviderConnection } from './gigachat-provider';
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
  const acceptedMessage = turn.messages.find((message) => message.id === turn.messageId && message.role === 'user');
  const localIds = acceptedMessage?.attachmentIds ?? [];
  if (new Set(localIds).size !== localIds.length || JSON.stringify(turn.attachmentIds ?? []) !== JSON.stringify(localIds)) {
    throw new GigaChatProviderError('protocol');
  }
  const requestMessage = request.messages.find((message) => message.id === turn.messageId);
  if (!requestMessage || requestMessage.role !== 'user'
    || JSON.stringify(requestMessage.attachmentIds ?? []) !== JSON.stringify(localIds)) {
    throw new GigaChatProviderError('protocol');
  }

  const authorizationKey = await options.loadAuthorizationKey();
  if (!authorizationKey) throw new GigaChatProviderError('auth');
  const accountScope = createHash('sha256').update(authorizationKey, 'utf8').digest('hex');
  const entries = await options.store.getProviderUploadEntries(accountScope);
  const detail = await options.store.getChat(turn.chatId);
  const references: ProviderAttachmentReference[] = [];
  let providerFiles: Promise<ProviderFileRecord[]> | null = null;
  const listProviderFiles = (): Promise<ProviderFileRecord[]> => {
    providerFiles ??= options.provider.listFiles(signal);
    return providerFiles;
  };
  for (const attachmentId of localIds) {
    throwIfAborted(signal);
    const artifact = detail.artifacts.find((item) => item.id === attachmentId && item.messageId === turn.messageId);
    if (!artifact) throw new GigaChatProviderError('storage');
    const file = await readVerifiedArtifact(options.store, turn.chatId, artifact, signal);
    const uploadFilename = makeUploadFilename(artifact);
    const identity = {
      accountScope, attachmentId, uploadFilename, name: artifact.name, contentType: file.contentType,
      kind: file.kind, sizeBytes: artifact.size, sha256: file.sha256,
    };
    const existing = entries.find((entry) => entry.attachmentId === attachmentId);
    if (existing && !sameUploadIdentity(existing, identity)) throw new GigaChatProviderError('storage');

    let saved = existing;
    if (saved?.state === 'uploaded' && saved.remoteFileId) {
      const remote = (await listProviderFiles()).find((record) => record.id === saved!.remoteFileId);
      if (!remote) throw missingRemoteAttachmentError();
      if (remote.filename !== saved.uploadFilename || remote.bytes !== saved.sizeBytes || remote.purpose !== 'general') {
        throw new GigaChatProviderError('protocol');
      }
      references.push(toProviderReference(turn.messageId, attachmentId, artifact, file, saved.remoteFileId));
      continue;
    }
    if (saved?.state === 'cleanup-pending') throw new GigaChatProviderError('storage');
    if (saved) {
      const matches = (await listProviderFiles()).filter((record) => record.purpose === 'general'
        && record.filename === saved!.uploadFilename && record.bytes === saved!.sizeBytes);
      if (matches.length === 1) {
        saved = await options.store.putProviderUploadEntry({ ...saved, state: 'uploaded', remoteFileId: matches[0]!.id });
        references.push(toProviderReference(turn.messageId, attachmentId, artifact, file, matches[0]!.id));
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
      ...identity,
      state: 'intent',
      remoteFileId: null,
      createdAt: new Date((options.now ?? Date.now)()).toISOString(),
    };
    await options.store.putProviderUploadEntry(intent);
    let uploaded;
    try {
      throwIfAborted(signal);
      uploaded = await options.provider.uploadFile({ filename: uploadFilename, contentType: file.contentType, bytes: file.bytes }, signal);
    } catch (error) {
      try { await options.store.putProviderUploadEntry({ ...intent, state: 'unknown' }); }
      catch { throw new GigaChatProviderError('storage'); }
      throw error;
    }
    await options.store.putProviderUploadEntry({ ...intent, state: 'uploaded', remoteFileId: uploaded.id });
    references.push(toProviderReference(turn.messageId, attachmentId, artifact, file, uploaded.id));
  }

  await cleanupUnreferencedUploads(accountScope, options, signal, new Set(localIds), listProviderFiles);
  return { ...request, attachments: references };
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

function sameUploadIdentity(
  entry: ProviderUploadLedgerEntry,
  identity: Omit<ProviderUploadLedgerEntry, 'state' | 'remoteFileId' | 'createdAt'>,
): boolean {
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
