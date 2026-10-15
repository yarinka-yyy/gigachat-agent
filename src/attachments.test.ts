import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { AcceptedTurnInput, ChatArtifact, ChatDetail, ProviderAttachmentReference, ProviderTurnRequest, ProviderUploadLedgerEntry } from './contracts';
import { prepareTurnAttachments, type AttachmentPreparationOptions } from './attachments';
import { HistoricalProviderStateAttachmentsError } from './provider-state';
import { openStore } from './store';

const at = '2026-10-13T00:00:00.000Z';
const attachmentId = '123e4567-e89b-42d3-a456-426614174000';
const accountScope = createHash('sha256').update('synthetic-authorization-key').digest('hex');

function fixture(chatId = 'chat-one', hasAttachment = true, originalName = 'notes.txt', artifactDirectory = tmpdir()) {
  const bytes = Buffer.from('PRIVATE_TEST_SENTINEL');
  const extension = originalName.slice(originalName.lastIndexOf('.'));
  const path = join(artifactDirectory, `gigachat-attachment-${attachmentId}-${extension}`);
  const paths = new Map([[attachmentId, path]]);
  const artifact: ChatArtifact = {
    id: attachmentId, name: originalName, storedName: `${attachmentId}${extension}`, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: at, messageId: 'message-one',
  };
  const userMessage = {
    id: 'message-one', role: 'user' as const, text: 'Read the attached note.', createdAt: at,
    ...(hasAttachment ? { attachmentIds: [attachmentId] } : {}),
  };
  const detail = {
    id: chatId, title: 'Fixture', projectId: null, pinned: false, archived: false, createdAt: at, updatedAt: at,
    kind: 'text', draft: '', nextTurnPermissionProfile: null, modelId: 'GigaChat-3-Pro', nextTurnSkillId: null,
    messages: [userMessage], toolReceipts: [], artifacts: hasAttachment ? [artifact] : [{ ...artifact, messageId: null }],
    draftAttachments: [], compactSnapshot: null,
  } as unknown as ChatDetail;
  const turn: AcceptedTurnInput = {
    turnId: 'turn-one', chatId, projectId: null, projectWorkingFolder: null, messageId: 'message-one',
    assistantMessageId: 'assistant-one',
    historyBoundary: 1, messages: structuredClone(detail.messages), ...(hasAttachment ? { attachmentIds: [attachmentId] } : {}),
    permissionProfile: 'ask', modelId: 'GigaChat-3-Pro', skillId: null,
    reservation: { permissionProfileRevision: null, skillRevision: null },
  };
  const request: ProviderTurnRequest = {
    system: [], messages: structuredClone(detail.messages), permissionProfile: 'ask', modelId: 'GigaChat-3-Pro',
  };
  const entries: ProviderUploadLedgerEntry[] = [];
  const chatSummary = {
    id: chatId, title: 'Fixture', projectId: null, pinned: false, archived: false, createdAt: at, updatedAt: at, kind: 'text' as const,
  };
  const providerState = {
    uploaded: [] as Array<{ filename: string; contentType: string; bytes: Uint8Array }>,
    files: [] as Array<{ id: string; filename: string; bytes: number; purpose: 'general' }>,
    deleted: [] as string[],
    listCalls: 0,
    pathReads: 0,
  };
  const options: AttachmentPreparationOptions = {
    store: {
      getChat: async (id: string) => id === chatId ? structuredClone(detail) : { ...structuredClone(detail), id, artifacts: [] },
      getArtifactPath: async (_id: string, id: string) => {
        providerState.pathReads += 1;
        const found = paths.get(id);
        return found ?? Promise.reject(new Error('missing fixture artifact'));
      },
      listChats: async () => [chatSummary],
      getHomeDraft: async () => ({ attachments: [] } as never),
      getProviderUploadEntries: async (scope: string) => entries.filter((entry) => entry.accountScope === scope).map((entry) => structuredClone(entry)),
      putProviderUploadEntry: async (value: ProviderUploadLedgerEntry) => {
        const entry = structuredClone(value) as ProviderUploadLedgerEntry;
        const index = entries.findIndex((row) => row.accountScope === entry.accountScope && row.attachmentId === entry.attachmentId);
        if (index < 0) entries.push(entry); else entries[index] = entry;
        return structuredClone(entry);
      },
      removeProviderUploadEntry: async (scope: string, id: string, fileId: string) => {
        const index = entries.findIndex((row) => row.accountScope === scope && row.attachmentId === id && row.remoteFileId === fileId);
        if (index >= 0) entries.splice(index, 1);
      },
    } as unknown as AttachmentPreparationOptions['store'],
    provider: {
      uploadFile: async (input: { filename: string; contentType: string; bytes: Uint8Array }) => {
        providerState.uploaded.push({ filename: input.filename, contentType: input.contentType, bytes: Buffer.from(input.bytes) });
        const record = { id: `remote_${providerState.uploaded.length}`, filename: input.filename, bytes: input.bytes.byteLength, purpose: 'general' as const };
        providerState.files.push(record);
        return record;
      },
      listFiles: async () => { providerState.listCalls += 1; return structuredClone(providerState.files); },
      deleteFile: async (id: string) => {
        providerState.deleted.push(id);
        const index = providerState.files.findIndex((file) => file.id === id);
        if (index >= 0) providerState.files.splice(index, 1);
      },
    },
    loadAuthorizationKey: async () => 'synthetic-authorization-key',
    now: () => Date.parse(at),
  };
  return { bytes, path, paths, artifact, detail, turn, request, entries, providerState, options };
}

function syntheticArtifact(id: string, name: string, messageId: string, bytes: Uint8Array): ChatArtifact {
  return {
    id, name, storedName: `${id}${name.slice(name.lastIndexOf('.'))}`, size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: at, messageId,
  };
}

function fixtureId(value: number): string {
  return `123e4567-e89b-42d3-a456-${value.toString().padStart(12, '0')}`;
}

async function writeFixtureArtifact(data: ReturnType<typeof fixture>, artifact: ChatArtifact, bytes: Uint8Array): Promise<void> {
  const extension = artifact.name.slice(artifact.name.lastIndexOf('.'));
  const path = join(dirname(data.path), `fixture-${artifact.id}${extension}`);
  await writeFile(path, bytes);
  data.paths.set(artifact.id, path);
}

function historicalEntry(artifact: ChatArtifact, bytes: Uint8Array, remoteFileId: string): ProviderUploadLedgerEntry {
  const extension = artifact.name.slice(artifact.name.lastIndexOf('.')).toLowerCase();
  return {
    accountScope, attachmentId: artifact.id, uploadFilename: `gcagent_${artifact.id}${extension === '.md' ? '.txt' : extension}`,
    name: artifact.name, contentType: extension === '.pdf' ? 'application/pdf' : 'text/plain', kind: 'document',
    sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
    state: 'uploaded', remoteFileId, createdAt: at,
  };
}

function setTurnHistory(
  data: ReturnType<typeof fixture>,
  history: Array<{ messageId: string; attachmentId?: string; artifact?: ChatArtifact }>,
  currentArtifacts: ChatArtifact[] = [],
): void {
  const current = structuredClone(data.turn.messages.find((message) => message.id === data.turn.messageId)!);
  if (currentArtifacts.length) current.attachmentIds = currentArtifacts.map((item) => item.id);
  else delete current.attachmentIds;
  const messages = [
    ...history.map((item, index) => ({
      id: item.messageId, role: 'user' as const, text: `Historical message ${index + 1}`, createdAt: at,
      ...(item.attachmentId ? { attachmentIds: [item.attachmentId] } : {}),
    })),
    current,
  ];
  data.detail.messages = structuredClone(messages);
  data.detail.artifacts = [...history.flatMap((item) => item.artifact ? [structuredClone(item.artifact)] : []),
    ...currentArtifacts.map((item) => structuredClone(item))];
  data.turn.messages = structuredClone(messages);
  if (currentArtifacts.length) data.turn.attachmentIds = currentArtifacts.map((item) => item.id);
  else delete data.turn.attachmentIds;
  data.request.messages = structuredClone(messages);
}

test('binds only the accepted message local IDs to remote references and reuses its durable upload on retry', async (t) => {
  const data = fixture();
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  const turnBefore = structuredClone(data.turn);
  const messagesBefore = structuredClone(data.request.messages);
  const signal = new AbortController().signal;

  const first = await prepareTurnAttachments(data.turn, data.request, signal, data.options);
  const expected: ProviderAttachmentReference[] = [{
    messageId: 'message-one', attachmentId, fileId: 'remote_1', name: 'notes.txt',
    contentType: 'text/plain', kind: 'document', sizeBytes: data.bytes.length,
  }];
  assert.deepEqual(first.attachments, expected);
  assert.deepEqual(data.turn, turnBefore);
  assert.deepEqual(data.request.messages, messagesBefore);
  assert.deepEqual(data.request.messages[0]?.attachmentIds, [attachmentId], 'the immutable accepted snapshot retains local IDs');
  assert.equal(data.entries[0]?.state, 'uploaded');
  assert.equal(data.providerState.uploaded.length, 1);
  assert.equal(Buffer.from(data.providerState.uploaded[0]!.bytes).toString('utf8'), 'PRIVATE_TEST_SENTINEL');

  const retry = await prepareTurnAttachments({ ...data.turn, turnId: 'turn-retry' }, data.request, signal, data.options);
  assert.deepEqual(retry.attachments, expected);
  assert.equal(data.providerState.uploaded.length, 1, 'retry reuses the persisted provider ID and does not upload again');
  assert.deepEqual(await readFile(data.path), data.bytes, 'the user source remains unchanged');
});

test('does not upload unassociated legacy files or compaction history', async (t) => {
  const data = fixture('legacy-chat', false);
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  const signal = new AbortController().signal;

  const normal = await prepareTurnAttachments(data.turn, data.request, signal, data.options);
  assert.deepEqual(normal.attachments, []);
  assert.equal(data.providerState.uploaded.length, 0);

  const compaction = await prepareTurnAttachments({ ...data.turn, operation: 'compaction' }, data.request, signal, {
    ...data.options,
    loadAuthorizationKey: async () => { throw new Error('compaction must not inspect or upload files'); },
  });
  assert.equal(compaction, data.request);
  assert.equal(data.providerState.uploaded.length, 0);
});

test('uploads Markdown through the verified text/plain .txt cloud alias without changing its local name or bytes', async (t) => {
  const data = fixture('markdown-chat', true, 'readme.md');
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));

  await prepareTurnAttachments(data.turn, data.request, new AbortController().signal, data.options);

  assert.equal(data.artifact.name, 'readme.md');
  assert.equal(data.providerState.uploaded[0]?.filename, `gcagent_${attachmentId}.txt`);
  assert.equal(data.providerState.uploaded[0]?.contentType, 'text/plain');
  assert.deepEqual(data.providerState.uploaded[0]?.bytes, data.bytes);
  assert.equal(data.entries[0]?.name, 'readme.md');
  assert.equal(data.entries[0]?.uploadFilename, `gcagent_${attachmentId}.txt`);
});

test('does not reuse an uploaded ledger ID after the provider no longer lists that exact remote file', async (t) => {
  const data = fixture('expired-upload-chat');
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  const signal = new AbortController().signal;

  await prepareTurnAttachments(data.turn, data.request, signal, data.options);
  data.providerState.files.length = 0;

  await assert.rejects(prepareTurnAttachments({ ...data.turn, turnId: 'retry-expired' }, data.request, signal, data.options),
    (error: unknown) => error instanceof Error && 'category' in error && error.category === 'storage'
      && error.message.includes('Загруженная копия'));
  assert.equal(data.entries[0]?.state, 'uploaded');
  assert.equal(data.entries[0]?.remoteFileId, 'remote_1', 'the durable receipt remains available for later cleanup reconciliation');
  assert.equal(data.providerState.uploaded.length, 1, 'a missing provider ID must not trigger an implicit reupload');
});

test('reconciles one prior exact provider match and fails closed when an intent is ambiguous', async (t) => {
  const data = fixture();
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  const uploadFilename = `gcagent_${attachmentId}.txt`;
  const baseEntry: ProviderUploadLedgerEntry = {
    accountScope, attachmentId, uploadFilename, name: data.artifact.name, contentType: 'text/plain', kind: 'document',
    sizeBytes: data.artifact.size, sha256: data.artifact.sha256!, state: 'intent', remoteFileId: null, createdAt: at,
  };
  data.entries.push(baseEntry);
  data.providerState.files.push({ id: 'remote_recovered', filename: uploadFilename, bytes: data.artifact.size, purpose: 'general' });
  const recovered = await prepareTurnAttachments(data.turn, data.request, new AbortController().signal, data.options);
  assert.equal(recovered.attachments?.[0]?.fileId, 'remote_recovered');
  assert.equal(data.entries[0]?.state, 'uploaded');
  assert.equal(data.providerState.uploaded.length, 0);

  const ambiguous = fixture('ambiguous-chat');
  await writeFile(ambiguous.path, ambiguous.bytes);
  t.after(() => rm(ambiguous.path, { force: true }));
  ambiguous.entries.push({ ...baseEntry, accountScope });
  ambiguous.providerState.files.push(
    { id: 'remote_a', filename: uploadFilename, bytes: ambiguous.artifact.size, purpose: 'general' },
    { id: 'remote_b', filename: uploadFilename, bytes: ambiguous.artifact.size, purpose: 'general' },
  );
  await assert.rejects(prepareTurnAttachments(ambiguous.turn, ambiguous.request, new AbortController().signal, ambiguous.options),
    (error: unknown) => error instanceof Error && 'category' in error && error.category === 'protocol');
  assert.equal(ambiguous.providerState.uploaded.length, 0);
  assert.equal(ambiguous.entries[0]?.state, 'unknown');
});

test('cleans up a lost upload acknowledgment after the chat is removed and preserves unrelated provider files', async (t) => {
  const data = fixture('deleted-chat');
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  data.options.provider.uploadFile = async (input) => {
    data.providerState.uploaded.push({ filename: input.filename, contentType: input.contentType, bytes: Buffer.from(input.bytes) });
    data.providerState.files.push({ id: 'remote_lost_ack', filename: input.filename, bytes: input.bytes.byteLength, purpose: 'general' });
    throw new Error('synthetic response lost after upload acceptance');
  };
  data.providerState.files.push({ id: 'unrelated_file', filename: 'other.txt', bytes: 18, purpose: 'general' });
  await assert.rejects(prepareTurnAttachments(data.turn, data.request, new AbortController().signal, data.options));
  assert.equal(data.entries[0]?.state, 'unknown');
  assert.equal(data.entries[0]?.remoteFileId, null);

  data.options.store.listChats = async () => [];
  const message = { id: 'later-message', role: 'user' as const, text: 'Continue', createdAt: at };
  const cleanupTurn: AcceptedTurnInput = {
    turnId: 'later-turn', chatId: 'later-chat', projectId: null, projectWorkingFolder: null,
    messageId: message.id, assistantMessageId: 'later-assistant', historyBoundary: 1, messages: [message], permissionProfile: 'ask',
    modelId: 'GigaChat-3-Pro', skillId: null,
    reservation: { permissionProfileRevision: null, skillRevision: null },
  };
  const cleanupRequest: ProviderTurnRequest = {
    system: [], messages: [message], permissionProfile: 'ask', modelId: 'GigaChat-3-Pro',
  };
  await prepareTurnAttachments(cleanupTurn, cleanupRequest, new AbortController().signal, data.options);

  assert.deepEqual(data.providerState.deleted, ['remote_lost_ack']);
  assert.deepEqual(data.providerState.files, [{ id: 'unrelated_file', filename: 'other.txt', bytes: 18, purpose: 'general' }]);
  assert.equal(data.entries.length, 0, 'the acknowledged cleanup removes only the app-owned ledger entry');
});

test('orphan cleanup list failures keep their receipt without blocking a text turn, but still honor abort', async (t) => {
  const data = fixture('text-with-old-orphan', false);
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  const orphan: ProviderUploadLedgerEntry = {
    accountScope, attachmentId: '123e4567-e89b-42d3-a456-426614174001',
    uploadFilename: 'gcagent_orphan.txt', name: 'orphan.txt', contentType: 'text/plain', kind: 'document',
    sizeBytes: 18, sha256: 'c'.repeat(64), state: 'unknown', remoteFileId: null, createdAt: at,
  };
  data.entries.push(orphan);
  data.options.provider.listFiles = async () => { throw new Error('synthetic provider list outage'); };

  const prepared = await prepareTurnAttachments(data.turn, data.request, new AbortController().signal, data.options);
  assert.deepEqual(prepared.attachments, [], 'ordinary text generation proceeds when ancillary orphan reconciliation is unavailable');
  assert.deepEqual(data.entries, [orphan], 'the unknown receipt remains durable for later cleanup');

  const aborted = fixture('aborted-text-with-old-orphan', false);
  await writeFile(aborted.path, aborted.bytes);
  t.after(() => rm(aborted.path, { force: true }));
  aborted.entries.push({ ...orphan, accountScope });
  const controller = new AbortController();
  aborted.options.provider.listFiles = async () => {
    controller.abort();
    throw new Error('synthetic provider list aborted');
  };
  await assert.rejects(prepareTurnAttachments(aborted.turn, aborted.request, controller.signal, aborted.options),
    /synthetic provider list aborted/);
  assert.equal(aborted.entries[0]?.state, 'unknown', 'abort does not mutate the unresolved receipt');
});

test('recovers a lost upload acknowledgment through the real LocalStore state transitions after chat deletion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-attachment-ledger-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'read-me.txt');
  await writeFile(source, 'synthetic local file bytes');
  const store = await openStore(directory);
  const chat = await store.createChat();
  const staged = await store.stageChatDraftFile(chat.id, source);
  const accepted = await store.acceptLocalMessage(chat.id, 'Read the attached file.', 'turn-lost-upload-ack', [staged.draftAttachments[0]!.id]);
  const request: ProviderTurnRequest = {
    system: [], messages: await store.getMessagesThrough(chat.id, accepted.turn.messageId),
    permissionProfile: accepted.turn.permissionProfile, modelId: accepted.turn.modelId,
  };
  const files: Array<{ id: string; filename: string; bytes: number; purpose: 'general' }> = [];
  const deleted: string[] = [];
  const provider = {
    uploadFile: async (input: { filename: string; contentType: string; bytes: Uint8Array }) => {
      files.push({ id: 'remote_lost_ack_store', filename: input.filename, bytes: input.bytes.byteLength, purpose: 'general' });
      throw new Error('synthetic acknowledgment lost after server accepted the bytes');
    },
    listFiles: async () => structuredClone(files),
    deleteFile: async (id: string) => {
      deleted.push(id);
      const index = files.findIndex((file) => file.id === id);
      if (index >= 0) files.splice(index, 1);
    },
  } as unknown as AttachmentPreparationOptions['provider'];
  const options: AttachmentPreparationOptions = {
    store,
    provider,
    loadAuthorizationKey: async () => 'synthetic-store-ledger-key',
  };

  await assert.rejects(prepareTurnAttachments(accepted.turn, request, new AbortController().signal, options));
  const scope = createHash('sha256').update('synthetic-store-ledger-key').digest('hex');
  const uncertain = await store.getProviderUploadEntries(scope);
  assert.equal(uncertain[0]?.state, 'unknown');
  assert.equal(uncertain[0]?.remoteFileId, null);

  await store.deleteChat(chat.id);
  const laterChat = await store.createChat();
  const later = await store.acceptLocalMessage(laterChat.id, 'Continue.', 'turn-trigger-cleanup');
  const laterRequest: ProviderTurnRequest = {
    system: [], messages: await store.getMessagesThrough(laterChat.id, later.turn.messageId),
    permissionProfile: later.turn.permissionProfile, modelId: later.turn.modelId,
  };
  await prepareTurnAttachments(later.turn, laterRequest, new AbortController().signal, options);

  assert.deepEqual(deleted, ['remote_lost_ack_store']);
  assert.deepEqual(files, []);
  assert.deepEqual(await store.getProviderUploadEntries(scope), [], 'unknown→uploaded→cleanup-pending→removed is accepted by the real ledger');
  assert.deepEqual(await readFile(source), Buffer.from('synthetic local file bytes'));
});

test('leaves an ambiguous orphan upload durably unknown instead of deleting a candidate', async (t) => {
  const data = fixture('ambiguous-orphan-chat');
  await writeFile(data.path, data.bytes);
  t.after(() => rm(data.path, { force: true }));
  data.options.store.listChats = async () => [];
  data.entries.push({
    accountScope, attachmentId, uploadFilename: `gcagent_${attachmentId}.txt`, name: data.artifact.name,
    contentType: 'text/plain', kind: 'document', sizeBytes: data.artifact.size, sha256: data.artifact.sha256!,
    state: 'unknown', remoteFileId: null, createdAt: at,
  });
  data.providerState.files.push(
    { id: 'remote_candidate_a', filename: `gcagent_${attachmentId}.txt`, bytes: data.artifact.size, purpose: 'general' },
    { id: 'remote_candidate_b', filename: `gcagent_${attachmentId}.txt`, bytes: data.artifact.size, purpose: 'general' },
  );
  const message = { id: 'later-message', role: 'user' as const, text: 'Continue', createdAt: at };
  const cleanupTurn: AcceptedTurnInput = {
    turnId: 'later-turn', chatId: 'later-chat', projectId: null, projectWorkingFolder: null,
    messageId: message.id, assistantMessageId: 'later-assistant', historyBoundary: 1, messages: [message], permissionProfile: 'ask',
    modelId: 'GigaChat-3-Pro', skillId: null,
    reservation: { permissionProfileRevision: null, skillRevision: null },
  };
  const cleanupRequest: ProviderTurnRequest = {
    system: [], messages: [message], permissionProfile: 'ask', modelId: 'GigaChat-3-Pro',
  };

  await prepareTurnAttachments(cleanupTurn, cleanupRequest, new AbortController().signal, data.options);

  assert.equal(data.entries[0]?.state, 'unknown');
  assert.equal(data.entries[0]?.remoteFileId, null);
  assert.deepEqual(data.providerState.deleted, []);
});

test('reuses two owned historical documents in order beside one current file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-historical-documents-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = fixture('historical-documents-chat', false, 'current.txt', directory);
  const firstBytes = Buffer.from('first historical document');
  const secondBytes = Buffer.from('second historical document');
  const firstId = fixtureId(5101);
  const secondId = fixtureId(5102);
  const currentId = fixtureId(5103);
  const firstArtifact = syntheticArtifact(firstId, 'first.txt', 'history-message-one', firstBytes);
  const secondArtifact = syntheticArtifact(secondId, 'second.md', 'history-message-two', secondBytes);
  const currentArtifact = syntheticArtifact(currentId, 'current.txt', data.turn.messageId, data.bytes);
  await writeFixtureArtifact(data, firstArtifact, firstBytes);
  await writeFixtureArtifact(data, secondArtifact, secondBytes);
  await writeFixtureArtifact(data, currentArtifact, data.bytes);
  setTurnHistory(data, [
    { messageId: firstArtifact.messageId!, attachmentId: firstId, artifact: firstArtifact },
    { messageId: secondArtifact.messageId!, attachmentId: secondId, artifact: secondArtifact },
  ], [currentArtifact]);
  const firstEntry = historicalEntry(firstArtifact, firstBytes, 'remote_history_one');
  const secondEntry = historicalEntry(secondArtifact, secondBytes, 'remote_history_two');
  data.entries.push(firstEntry, secondEntry);
  data.providerState.files.push(
    { id: firstEntry.remoteFileId!, filename: firstEntry.uploadFilename, bytes: firstEntry.sizeBytes, purpose: 'general' },
    { id: secondEntry.remoteFileId!, filename: secondEntry.uploadFilename, bytes: secondEntry.sizeBytes, purpose: 'general' },
  );
  const turnBefore = structuredClone(data.turn);
  const requestBefore = structuredClone(data.request);

  const prepared = await prepareTurnAttachments(data.turn, data.request, new AbortController().signal, data.options);

  assert.deepEqual(prepared.attachments?.map(({ messageId, attachmentId, fileId }) => ({ messageId, attachmentId, fileId })), [
    { messageId: data.turn.messageId, attachmentId: firstId, fileId: 'remote_history_one' },
    { messageId: data.turn.messageId, attachmentId: secondId, fileId: 'remote_history_two' },
    { messageId: data.turn.messageId, attachmentId: currentId, fileId: 'remote_1' },
  ]);
  assert.deepEqual(prepared.messages[prepared.messages.length - 1]?.attachmentIds, [firstId, secondId, currentId]);
  assert.deepEqual(data.turn, turnBefore, 'accepted history remains unchanged');
  assert.deepEqual(data.request, requestBefore, 'the input request remains unchanged');
  assert.equal(data.providerState.listCalls, 1, 'historical remote ownership is verified with one memoized list');
  assert.equal(data.providerState.uploaded.length, 1, 'only the newly accepted current file is uploaded');
});

test('fails closed for inaccessible historical documents before uploading a new current file', async (t) => {
  const cases: Array<{
    label: string;
    state?: ProviderUploadLedgerEntry['state'];
    foreign?: boolean;
    remotePresent?: boolean;
    identityMismatch?: boolean;
    artifactHashMismatch?: boolean;
    wrongOrigin?: boolean;
    expected: 'historical' | 'storage';
  }> = [
    { label: 'missing ledger', expected: 'historical' },
    { label: 'other account', state: 'uploaded', foreign: true, remotePresent: true, expected: 'historical' },
    { label: 'intent', state: 'intent', expected: 'historical' },
    { label: 'unknown', state: 'unknown', expected: 'historical' },
    { label: 'cleanup pending', state: 'cleanup-pending', expected: 'historical' },
    { label: 'remote file absent', state: 'uploaded', remotePresent: false, expected: 'historical' },
    { label: 'identity mismatch', state: 'uploaded', remotePresent: true, identityMismatch: true, expected: 'storage' },
    { label: 'artifact bytes do not match its hash', state: 'uploaded', remotePresent: true, artifactHashMismatch: true, expected: 'storage' },
    { label: 'attachment ID is bound to a different origin', state: 'uploaded', remotePresent: true, wrongOrigin: true, expected: 'storage' },
  ];
  for (const [index, scenario] of cases.entries()) {
    const directory = await mkdtemp(join(tmpdir(), `gigachat-historical-fail-${index}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const data = fixture(`historical-fail-${index}`, false, 'current.txt', directory);
    const oldBytes = Buffer.from(`old document ${index}`);
    const oldId = fixtureId(5200 + index);
    const currentId = fixtureId(5300 + index);
    const oldArtifact = syntheticArtifact(oldId, 'old.txt', `old-message-${index}`, oldBytes);
    const currentArtifact = syntheticArtifact(currentId, 'current.txt', data.turn.messageId, data.bytes);
    await writeFixtureArtifact(data, oldArtifact, oldBytes);
    await writeFixtureArtifact(data, currentArtifact, data.bytes);
    if (scenario.artifactHashMismatch) oldArtifact.sha256 = 'f'.repeat(64);
    setTurnHistory(data, [{
      messageId: scenario.wrongOrigin ? `different-origin-${index}` : oldArtifact.messageId!,
      attachmentId: oldId, artifact: oldArtifact,
    }], [currentArtifact]);
    if (scenario.state) {
      const entry = historicalEntry(oldArtifact, oldBytes, 'remote_old');
      entry.state = scenario.state;
      entry.remoteFileId = scenario.state === 'intent' || scenario.state === 'unknown' ? null : 'remote_old';
      if (scenario.foreign) {
        entry.accountScope = createHash('sha256').update('synthetic-other-account-key').digest('hex');
      }
      if (scenario.identityMismatch) entry.sha256 = 'f'.repeat(64);
      data.entries.push(entry);
      if (scenario.remotePresent) {
        data.providerState.files.push({ id: 'remote_old', filename: entry.uploadFilename, bytes: entry.sizeBytes, purpose: 'general' });
      }
    }

    await assert.rejects(prepareTurnAttachments(data.turn, data.request, new AbortController().signal, data.options),
      (error: unknown) => scenario.expected === 'historical'
        ? error instanceof HistoricalProviderStateAttachmentsError
        : error instanceof Error && 'category' in error && error.category === 'storage');
    assert.equal(data.providerState.uploaded.length, 0, `${scenario.label}: current upload is not started`);
    assert.deepEqual(data.providerState.deleted, [], `${scenario.label}: no remote file is deleted`);
    assert.equal(data.providerState.listCalls, scenario.label === 'remote file absent' ? 1 : 0,
      `${scenario.label}: only a confirmed uploaded receipt needs a remote listing`);
  }
});

test('rejects request-only, future, and draft-bound attachment IDs without uploading them', async () => {
  const requestOnly = fixture('request-only-attachment');
  requestOnly.request.messages[requestOnly.request.messages.length - 1]!.attachmentIds = [fixtureId(5801)];
  await assert.rejects(prepareTurnAttachments(requestOnly.turn, requestOnly.request,
    new AbortController().signal, requestOnly.options),
  (error: unknown) => error instanceof Error && 'category' in error && error.category === 'protocol');
  assert.equal(requestOnly.providerState.uploaded.length, 0);

  const future = fixture('future-attachment');
  future.turn.messages.push({
    id: 'future-user-message', role: 'user', text: 'Not part of the accepted turn', createdAt: at, attachmentIds: [fixtureId(5802)],
  });
  future.request.messages = structuredClone(future.turn.messages);
  await assert.rejects(prepareTurnAttachments(future.turn, future.request,
    new AbortController().signal, future.options),
  (error: unknown) => error instanceof Error && 'category' in error && error.category === 'protocol');
  assert.equal(future.providerState.uploaded.length, 0);

  const draftBound = fixture('draft-bound-attachment');
  draftBound.detail.artifacts[0]!.messageId = null;
  await assert.rejects(prepareTurnAttachments(draftBound.turn, draftBound.request,
    new AbortController().signal, draftBound.options),
  (error: unknown) => error instanceof Error && 'category' in error && error.category === 'storage');
  assert.equal(draftBound.providerState.uploaded.length, 0);
});

test('ignores ten historical images for a text follow-up and enforces limits before reading current files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-historical-images-and-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldImages = fixture('ten-old-images', false, 'current.txt', directory);
  const history = Array.from({ length: 10 }, (_, index) => {
    const id = fixtureId(5400 + index);
    const messageId = `image-history-${index}`;
    const artifact = syntheticArtifact(id, `old-${index}.png`, messageId, Buffer.from(`old image metadata ${index}`));
    return { messageId, attachmentId: id, artifact };
  });
  setTurnHistory(oldImages, history);

  const textTurn = await prepareTurnAttachments(oldImages.turn, oldImages.request, new AbortController().signal, oldImages.options);
  assert.deepEqual(textTurn.attachments, []);
  assert.equal(oldImages.providerState.uploaded.length, 0);
  assert.equal(oldImages.providerState.listCalls, 0, 'historical images need no remote ledger lookup');
  assert.equal(oldImages.providerState.pathReads, 0, 'historical images are not reread from disk');
  assert.equal(textTurn.messages[textTurn.messages.length - 1]?.attachmentIds, undefined, 'old images are not projected onto the current question');

  const tooManyDocuments = fixture('too-many-documents', false, 'current.txt', directory);
  const documentHistory = Array.from({ length: 32 }, (_, index) => {
    const id = fixtureId(5500 + index);
    const messageId = `document-history-${index}`;
    const bytes = Buffer.from(`document metadata ${index}`);
    return { messageId, attachmentId: id, artifact: syntheticArtifact(id, `old-${index}.txt`, messageId, bytes) };
  });
  const currentDocument = syntheticArtifact(fixtureId(5600), 'current.txt', tooManyDocuments.turn.messageId, tooManyDocuments.bytes);
  setTurnHistory(tooManyDocuments, documentHistory, [currentDocument]);
  await assert.rejects(prepareTurnAttachments(tooManyDocuments.turn, tooManyDocuments.request,
    new AbortController().signal, tooManyDocuments.options),
  (error: unknown) => error instanceof Error && 'category' in error && error.category === 'context');
  assert.equal(tooManyDocuments.providerState.pathReads, 0, 'combined document limits are checked before reading any file');
  assert.equal(tooManyDocuments.providerState.uploaded.length, 0);

  const tooManyImages = fixture('too-many-current-images', false, 'current.txt', directory);
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write('IHDR', 12, 'ascii');
  png[19] = 1;
  const currentImages = Array.from({ length: 11 }, (_, index) => syntheticArtifact(
    fixtureId(5700 + index), `current-${index}.png`, tooManyImages.turn.messageId, png,
  ));
  setTurnHistory(tooManyImages, [], currentImages);
  await assert.rejects(prepareTurnAttachments(tooManyImages.turn, tooManyImages.request,
    new AbortController().signal, tooManyImages.options),
  (error: unknown) => error instanceof Error && 'category' in error && error.category === 'context');
  assert.equal(tooManyImages.providerState.pathReads, 0, 'current image count is checked before reading any file');
  assert.equal(tooManyImages.providerState.uploaded.length, 0);
});
