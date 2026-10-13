import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AcceptedTurnInput, ChatArtifact, ChatDetail, ProviderAttachmentReference, ProviderTurnRequest, ProviderUploadLedgerEntry } from './contracts';
import { prepareTurnAttachments, type AttachmentPreparationOptions } from './attachments';
import { openStore } from './store';

const at = '2026-10-13T00:00:00.000Z';
const attachmentId = '123e4567-e89b-42d3-a456-426614174000';
const accountScope = createHash('sha256').update('synthetic-authorization-key').digest('hex');

function fixture(chatId = 'chat-one', hasAttachment = true, originalName = 'notes.txt') {
  const bytes = Buffer.from('PRIVATE_TEST_SENTINEL');
  const extension = originalName.slice(originalName.lastIndexOf('.'));
  const path = join(tmpdir(), `gigachat-attachment-${attachmentId}-${extension}`);
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
  };
  const options: AttachmentPreparationOptions = {
    store: {
      getChat: async (id: string) => id === chatId ? structuredClone(detail) : { ...structuredClone(detail), id, artifacts: [] },
      getArtifactPath: async (_id: string, id: string) => id === artifact.id ? path : Promise.reject(new Error('missing fixture artifact')),
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
      listFiles: async () => structuredClone(providerState.files),
      deleteFile: async (id: string) => {
        providerState.deleted.push(id);
        const index = providerState.files.findIndex((file) => file.id === id);
        if (index >= 0) providerState.files.splice(index, 1);
      },
    },
    loadAuthorizationKey: async () => 'synthetic-authorization-key',
    now: () => Date.parse(at),
  };
  return { bytes, path, artifact, detail, turn, request, entries, providerState, options };
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
    messageId: message.id, historyBoundary: 1, messages: [message], permissionProfile: 'ask',
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
    messageId: message.id, historyBoundary: 1, messages: [message], permissionProfile: 'ask',
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
