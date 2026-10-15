import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openStore as openStoreProduction, type StoreFaultStage, type StoreOpenOptions } from './store';
import type { AcceptedTurnInput, ChatMessage, CompactSnapshot, GigaChatProvider, HookDispatchInput, HookRunResult, InstructionCommitRequest, InstructionCommitResult, ProviderEvent, ProviderTurnRequest, RuntimeTurnSnapshot } from './contracts';
import { COMPACTION_TASK_INSTRUCTION, buildNextTurnContext, hashCompactionPrefix } from './context';
import { instructionFileHash } from './instruction-documents';
import { createTurnRuntime, type PreparedTurn } from './runtime';

const timestamp = '2026-09-24T10:00:00.000Z';

const syntheticInstructionCommitter = async (request: InstructionCommitRequest): Promise<InstructionCommitResult> => {
  const target = join(request.workingFolder, request.relativePath);
  const currentBytes = await readFile(target).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  const currentText = currentBytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(currentBytes);
  if (instructionFileHash(currentText) !== request.expectedHash) return { kind: 'conflict-before', currentText };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, request.contents, 'utf8');
  return { kind: 'saved' };
};

function openStore(directory: string, options: StoreOpenOptions = {}) {
  return openStoreProduction(directory, { instructionCommitter: syntheticInstructionCommitter, ...options });
}

async function appendAcceptedAnswer(
  store: Awaited<ReturnType<typeof openStore>>,
  turn: AcceptedTurnInput,
  text: string,
  functionsStateId?: string,
  accountScope?: string,
): Promise<void> {
  const detail = await store.getChat(turn.chatId);
  const accepted = detail.turns.find((item) => item.turnId === turn.turnId);
  assert.ok(accepted);
  const completed: RuntimeTurnSnapshot = {
    id: turn.turnId, chatId: turn.chatId, anchorMessageId: turn.messageId,
    assistantMessageId: turn.assistantMessageId, modelId: turn.modelId, status: 'completed',
    createdAt: accepted.createdAt, endedAt: timestamp, activity: [],
  };
  await store.appendAssistantMessageFromRuntime(turn, text, completed, undefined, functionsStateId, accountScope);
}

function completedCompactionTurn(turn: AcceptedTurnInput, createdAt: string): RuntimeTurnSnapshot {
  return {
    id: turn.turnId, chatId: turn.chatId, anchorMessageId: turn.messageId,
    assistantMessageId: null, operation: 'compaction', modelId: turn.modelId, status: 'completed',
    createdAt, endedAt: timestamp, activity: [],
  };
}

function downgradeHomeSendJournalToSchema8(journal: Record<string, unknown>): void {
  const legacyChat = journal.chat as Record<string, unknown>;
  legacyChat.schemaVersion = 8;
  delete legacyChat.providerStateOwnership;
  delete legacyChat.turns;
  delete legacyChat.draftAttachments;
  for (const message of legacyChat.messages as Array<Record<string, unknown>>) delete message.attachmentIds;
  for (const artifact of legacyChat.artifacts as Array<Record<string, unknown>>) delete artifact.sha256;
  const removeTurnAttachmentIds = (turn: Record<string, unknown>): void => {
    delete turn.attachmentIds;
    delete turn.assistantMessageId;
    for (const message of turn.messages as Array<Record<string, unknown>>) delete message.attachmentIds;
  };
  removeTurnAttachmentIds(journal.turn as Record<string, unknown>);
  const nextDraft = journal.nextDraft as Record<string, unknown>;
  const acceptance = nextDraft.lastAcceptance as Record<string, unknown>;
  removeTurnAttachmentIds(acceptance.turn as Record<string, unknown>);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('persists projects, chats, relationships, drafts, image kind, and settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await openStore(directory);
  const project = await store.createProject('Локальный проект');
  const workingFolder = join(directory, 'work');
  await mkdir(workingFolder);
  const updatedProject = (await store.updateProject(project.id, { workingFolder })).project;
  const chat = await store.createChat(project.id);
  const imageChat = await store.createChat(project.id, 'image');
  const savedChat = await store.updateChat(chat.id, {
    draft: 'Черновик', title: 'Проверка', nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/review',
  });
  await store.updateSettings({
    theme: 'warm',
    sidebarTransparent: true,
    sidebarVisible: false,
    sidebarWidthPx: 320,
    browserPaneOpen: true,
    browserWidthPx: null,
    browserTabs: [{ id: 'tab-one', title: 'Пример', url: 'https://example.com/' }],
    browserActiveTabId: 'tab-one',
    defaultProjectsFolder: 'C:\\projects',
    preferredOpener: 'explorer',
    defaultPermissionProfile: 'approve',
    defaultModelId: 'vendor/model.v4:preview',
    onboardingCompleted: false,
    microphoneConsent: 'allowed',
    notifications: { taskStarted: true, taskCompleted: false, failures: true },
  });

  const restored = await openStore(directory);
  assert.deepEqual(await restored.listProjects(), [updatedProject]);
  assert.deepEqual(new Set((await restored.listChats()).map((item) => item.id)), new Set([savedChat.id, imageChat.id]));
  assert.equal((await restored.getChat(chat.id)).draft, 'Черновик');
  assert.equal((await restored.getChat(chat.id)).nextTurnPermissionProfile, 'full');
  assert.equal((await restored.getChat(chat.id)).nextTurnSkillId, 'global/review');
  assert.equal((await restored.getChat(chat.id)).projectId, project.id);
  assert.equal((await restored.getChat(chat.id)).modelId, null);
  await restored.updateChat(chat.id, { modelId: 'legacy/model-v1' });
  assert.equal((await (await openStore(directory)).getChat(chat.id)).modelId, 'legacy/model-v1');
  assert.equal((await restored.getChat(imageChat.id)).kind, 'image');
  assert.deepEqual(await restored.getSettings(), {
    theme: 'warm',
    sidebarTransparent: true,
    sidebarVisible: false,
    sidebarWidthPx: 320,
    browserPaneOpen: true,
    browserWidthPx: null,
    browserTabs: [{ id: 'tab-one', title: 'Пример', url: 'https://example.com/' }],
    browserActiveTabId: 'tab-one',
    defaultProjectsFolder: 'C:\\projects',
    preferredOpener: 'explorer',
    defaultPermissionProfile: 'approve',
    defaultModelId: 'vendor/model.v4:preview',
    onboardingCompleted: false,
    microphoneConsent: 'allowed',
    notifications: { taskStarted: true, taskCompleted: false, failures: true },
  });
  await assert.rejects(store.updateSettings({ defaultPermissionProfile: 'unknown' } as never));
  await assert.rejects(store.updateSettings({ notifications: { taskStarted: true, taskCompleted: false, failures: 'yes' } } as never));
  await assert.rejects(store.updateChat(chat.id, { nextTurnPermissionProfile: 'unknown' } as never));
  await assert.rejects(store.updateChat(chat.id, { nextTurnSkillId: 'global/../outside' } as never));
  await assert.rejects(store.updateChat(chat.id, { modelId: '\0invalid' } as never));
});

test('home draft and selected files survive reload without creating a chat', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-draft-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.txt');
  await writeFile(source, 'local bytes stay unchanged', 'utf8');

  const store = await openStore(directory);
  const initial = await store.getHomeDraft();
  assert.deepEqual(await store.listChats(), []);
  const saved = await store.saveHomeDraft({
    revision: initial.revision + 1,
    text: 'first line',
    projectId: null,
    permissionProfile: 'approve',
    skillId: 'global/review',
    modelId: 'GigaChat-3-Pro',
  });
  const withFile = await store.stageHomeDraftFile(source);

  assert.equal(withFile.revision, saved.revision + 1);
  assert.equal(withFile.text, 'first line');
  assert.equal(withFile.attachments.length, 1);
  assert.equal(withFile.attachments[0]?.name, 'source.txt');
  assert.deepEqual(await readFile(await store.getHomeDraftAttachmentPath(withFile.attachments[0]!.id)), Buffer.from('local bytes stay unchanged'));
  assert.deepEqual(await store.listChats(), [], 'typing, selections, and file choice stay out of Recents');
  assert.equal(await readFile(source, 'utf8'), 'local bytes stay unchanged');

  const restored = await openStore(directory);
  assert.deepEqual(await restored.getHomeDraft(), withFile);
  assert.deepEqual(await restored.listChats(), []);
  const withoutFile = await restored.removeHomeDraftFile(withFile.attachments[0]!.id);
  assert.equal(withoutFile.attachments.length, 0);
  assert.equal(await readFile(source, 'utf8'), 'local bytes stay unchanged');
});

test('home send rejects a changed effective model before creating a chat or consuming staged files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-model-cas-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'notes.txt');
  await writeFile(source, 'private fixture bytes', 'utf8');
  const store = await openStore(directory);
  const initial = await store.getHomeDraft();
  const saved = await store.saveHomeDraft({ ...initial, revision: initial.revision + 1, text: 'Прочитай файл' });
  const staged = await store.stageHomeDraftFile(source);
  const expectedModel = staged.modelId ?? (await store.getSettings()).defaultModelId;
  const changedModel = expectedModel === 'GigaChat-3-Ultra' ? 'GigaChat-2-Max' : 'GigaChat-3-Ultra';

  await assert.rejects(store.acceptHomeDraft(staged.revision, 'wrong-home-model-turn', changedModel), /Модель изменилась/i);
  assert.deepEqual(await store.listChats(), []);
  assert.equal((await store.getHomeDraft()).revision, staged.revision);
  assert.equal((await store.getHomeDraft()).attachments.length, 1);
  assert.equal(saved.text, 'Прочитай файл');
});

test('home send keeps staged files when connection is lost before the durable send journal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-attachment-connection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'notes.txt');
  await writeFile(source, 'private fixture bytes', 'utf8');
  let connected = true;
  const store = await openStore(directory, { testFaults: { beforeHomeSendJournal: () => { connected = false; } } });
  const initial = await store.getHomeDraft();
  await store.saveHomeDraft({ ...initial, revision: initial.revision + 1, text: 'Прочитай файл' });
  const staged = await store.stageHomeDraftFile(source);
  const expectedModel = staged.modelId ?? (await store.getSettings()).defaultModelId;

  await assert.rejects(store.acceptHomeDraft(staged.revision, 'home-connection-race', expectedModel, () => {
    if (!connected) throw new Error('Соединение изменилось перед отправкой файлов.');
  }), /Соединение изменилось/i);
  assert.deepEqual(await store.listChats(), []);
  assert.equal((await store.getHomeDraft()).text, 'Прочитай файл');
  assert.deepEqual((await store.getHomeDraft()).attachments.map((item) => item.id), [staged.attachments[0]!.id]);
});

test('existing-chat attachment staging stays pending until one accepted message binds it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-staged-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'image-fixture.png');
  const originalBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=', 'base64');
  await writeFile(source, originalBytes);

  const store = await openStore(directory);
  const chat = await store.createChat();
  const attachments = store as typeof store & {
    stageChatDraftFile(chatId: string, sourcePath: string): Promise<import('./contracts').ChatDetail>;
    getChatDraftAttachmentPath(chatId: string, attachmentId: string): Promise<string>;
    acceptLocalMessage(chatId: string, text: string, turnId: string, attachmentIds?: string[], expectedModelId?: unknown, validateBeforeCommit?: () => void): Promise<{ detail: import('./contracts').ChatDetail; turn: AcceptedTurnInput }>;
  };

  const staged = await attachments.stageChatDraftFile(chat.id, source);
  assert.equal(staged.messages.length, 0);
  assert.equal(staged.artifacts.length, 0, 'choosing a file does not make a sent artifact');
  assert.equal(staged.draftAttachments.length, 1);
  assert.deepEqual(await readFile(await attachments.getChatDraftAttachmentPath(chat.id, staged.draftAttachments[0]!.id)), originalBytes);
  assert.equal(await readFile(source).then((bytes) => bytes.equals(originalBytes)), true, 'staging never changes the source');
  assert.equal((await store.listChats()).length, 1, 'staging does not create another chat');

  await assert.rejects(attachments.acceptLocalMessage(chat.id, 'Что на изображении?', 'chat-file-turn-wrong-model',
    [staged.draftAttachments[0]!.id], '__changed-model__'), /Модель изменилась/i);
  await assert.rejects(attachments.acceptLocalMessage(chat.id, 'Что на изображении?', 'chat-file-turn-disconnected',
    [staged.draftAttachments[0]!.id], (await store.getSettings()).defaultModelId,
    () => { throw new Error('Подключите GigaChat перед отправкой файлов.'); }), /Подключите GigaChat/i);
  assert.equal((await store.getChat(chat.id)).messages.length, 0, 'failed model CAS keeps the file pending');
  assert.equal((await store.getChat(chat.id)).draftAttachments.length, 1);
  const settings = await store.getSettings();
  const accepted = await attachments.acceptLocalMessage(chat.id, 'Что на изображении?', 'chat-file-turn',
    [staged.draftAttachments[0]!.id], settings.defaultModelId);
  const userMessage = accepted.detail.messages[accepted.detail.messages.length - 1]!;
  assert.deepEqual(userMessage.attachmentIds, [staged.draftAttachments[0]!.id]);
  assert.deepEqual(accepted.turn.attachmentIds, [staged.draftAttachments[0]!.id]);
  assert.equal(accepted.detail.draftAttachments.length, 0);
  const acceptedArtifact = accepted.detail.artifacts[accepted.detail.artifacts.length - 1];
  assert.equal(acceptedArtifact?.id, staged.draftAttachments[0]?.id);
  assert.equal(acceptedArtifact?.messageId, userMessage.id);
  assert.equal(acceptedArtifact?.sha256, createHash('sha256').update(originalBytes).digest('hex'));

  const restored = await openStore(directory);
  const restoredChat = await restored.getChat(chat.id);
  assert.deepEqual(restoredChat.messages[restoredChat.messages.length - 1]?.attachmentIds, [staged.draftAttachments[0]!.id]);
  assert.equal(restoredChat.artifacts[restoredChat.artifacts.length - 1]?.messageId, userMessage.id);
});

test('rejects a renamed non-image during main-owned staging and leaves the source intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-invalid-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'renamed-executable.png');
  const originalBytes = Buffer.from('MZ\0not an image');
  await writeFile(source, originalBytes);
  const store = await openStore(directory);
  const chat = await store.createChat();
  const attachments = store as typeof store & {
    stageChatDraftFile(chatId: string, sourcePath: string): Promise<import('./contracts').ChatDetail>;
  };

  await assert.rejects(attachments.stageChatDraftFile(chat.id, source), /формат|PNG|изображени/i);
  assert.deepEqual(await readFile(source), originalBytes);
  assert.deepEqual((await store.getChat(chat.id)).draftAttachments, []);
  assert.deepEqual((await store.getChat(chat.id)).artifacts, []);
});

test('provider upload ledger keeps app-owned file references durable and account-scoped', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-upload-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const ledger = store as typeof store & {
    getProviderUploadEntries(scope: string): Promise<import('./contracts').ProviderUploadLedgerEntry[]>;
    putProviderUploadEntry(value: import('./contracts').ProviderUploadLedgerEntry): Promise<import('./contracts').ProviderUploadLedgerEntry>;
    removeProviderUploadEntry(scope: string, attachmentId: string, remoteFileId: string): Promise<void>;
  };
  const accountScope = 'a'.repeat(64);
  const intent: import('./contracts').ProviderUploadLedgerEntry = {
    accountScope,
    attachmentId: 'attachment-local-one',
    uploadFilename: 'gcagent_123e4567-e89b-42d3-a456-426614174000.txt',
    name: 'source.txt', contentType: 'text/plain', kind: 'document', sizeBytes: 4,
    sha256: createHash('sha256').update('data').digest('hex'), state: 'intent', remoteFileId: null,
    createdAt: timestamp,
  };

  assert.deepEqual(await ledger.getProviderUploadEntries(accountScope), []);
  assert.deepEqual(await ledger.putProviderUploadEntry(intent), intent);
  assert.deepEqual(await ledger.getProviderUploadEntries('b'.repeat(64)), []);
  assert.throws(() => ledger.putProviderUploadEntry({ ...intent, state: 'uploaded', remoteFileId: '../other-account-file' }));

  const restored = await openStore(directory) as typeof ledger;
  assert.deepEqual(await restored.getProviderUploadEntries(accountScope), [intent]);
  const unknown = { ...intent, state: 'unknown' as const };
  assert.deepEqual(await restored.putProviderUploadEntry(unknown), unknown);
  const uploaded = { ...unknown, state: 'uploaded' as const, remoteFileId: 'provider-file_1' };
  assert.deepEqual(await restored.putProviderUploadEntry(uploaded), uploaded);
  const cleanup = { ...uploaded, state: 'cleanup-pending' as const };
  await restored.putProviderUploadEntry(cleanup);
  await assert.rejects(restored.removeProviderUploadEntry(accountScope, intent.attachmentId, 'different-file'));
  assert.deepEqual(await restored.getProviderUploadEntries(accountScope), [cleanup]);
  await restored.removeProviderUploadEntry(accountScope, intent.attachmentId, uploaded.remoteFileId);
  assert.deepEqual(await restored.getProviderUploadEntries(accountScope), []);
});

test('files-only home send preserves an empty user message and binds files to the accepted turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-files-only-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'instructions.txt');
  await writeFile(source, 'Read this content exactly.');

  const store = await openStore(directory);
  const staged = await store.stageHomeDraftFile(source);
  const accepted = await store.acceptHomeDraft(staged.revision, 'home-files-only-turn');
  assert.equal(accepted.detail.messages[0]?.text, '');
  assert.deepEqual(accepted.detail.messages[0]?.attachmentIds, [staged.attachments[0]!.id]);
  assert.deepEqual(accepted.turn.attachmentIds, [staged.attachments[0]!.id]);
  assert.equal(accepted.detail.title, 'Прикреплённые файлы');
  assert.equal(accepted.detail.artifacts[0]?.messageId, accepted.detail.messages[0]?.id);
  assert.equal((await store.getHomeDraft()).attachments.length, 0);
});

test('explicit home send creates one linked chat and returns the same frozen snapshot for a duplicate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'fixture.txt');
  await writeFile(source, 'fixture bytes', 'utf8');

  const store = await openStore(directory);
  const draft = await store.saveHomeDraft({
    revision: 1, text: 'Проверь файл', projectId: null,
    permissionProfile: 'approve', skillId: 'global/review', modelId: 'GigaChat-3-Pro',
  });
  const withFile = await store.stageHomeDraftFile(source);
  const accepted = await store.acceptHomeDraft(withFile.revision, 'home-turn-one');
  const duplicate = await store.acceptHomeDraft(withFile.revision, 'home-turn-two');

  assert.equal(accepted.detail.messages.length, 1);
  assert.equal(accepted.detail.messages[0]?.text, 'Проверь файл');
  assert.equal(accepted.detail.projectId, null);
  assert.equal(accepted.detail.modelId, 'GigaChat-3-Pro');
  assert.equal(accepted.detail.nextTurnPermissionProfile, 'approve');
  assert.equal(accepted.detail.nextTurnSkillId, 'global/review');
  assert.equal(accepted.detail.artifacts.length, 1);
  assert.equal(accepted.detail.artifacts[0]?.messageId, accepted.detail.messages[0]?.id);
  assert.equal(accepted.turn.messageId, accepted.detail.messages[0]?.id);
  assert.equal(accepted.turn.modelId, 'GigaChat-3-Pro');
  assert.equal(accepted.turn.permissionProfile, 'approve');
  assert.equal(accepted.turn.skillId, 'global/review');
  assert.equal(duplicate.detail.id, accepted.detail.id);
  assert.equal(duplicate.turn.turnId, accepted.turn.turnId);
  assert.equal((await store.listChats()).length, 1);
  const nextDraft = await store.getHomeDraft();
  assert.equal(nextDraft.text, '');
  assert.equal(nextDraft.attachments.length, 0);
  assert.equal(nextDraft.lastAcceptance?.sourceRevision, withFile.revision);
  assert.equal(await readFile(source, 'utf8'), 'fixture bytes');
  assert.notEqual(draft.revision, withFile.revision);
});

test('accepted but unqueued turns become durable not-sent without overwriting later runtime state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-not-sent-turn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const draft = await store.saveHomeDraft({
    revision: 1, text: 'Сохрани этот запрос', projectId: null,
    permissionProfile: 'ask', skillId: null, modelId: 'GigaChat-3-Pro',
  });
  const accepted = await store.acceptHomeDraft(draft.revision, 'home-not-sent-turn');
  const reason = 'Сохранено локально, не отправлено. Подключитесь и отправьте сообщение ещё раз.';
  const marked = await store.markQueuedTurnNotSent(accepted.turn, reason);
  assert.equal(marked.marked, true);
  const unsent = marked.detail.turns.find((item) => item.turnId === accepted.turn.turnId);
  assert.equal(unsent?.status, 'failed');
  assert.equal(unsent?.startedAt, undefined);
  assert.ok(unsent?.endedAt);
  assert.equal(unsent?.error, reason);
  assert.deepEqual(marked.detail.messages.map(({ role, text }) => ({ role, text })), [{ role: 'user', text: 'Сохрани этот запрос' }]);
  assert.equal(marked.detail.modelId, 'GigaChat-3-Pro');
  assert.equal(marked.detail.nextTurnPermissionProfile, null);

  const duplicate = await store.acceptHomeDraft(draft.revision, 'ignored-duplicate-turn-id');
  assert.equal(duplicate.newlyAccepted, false);
  assert.equal(duplicate.turn.turnId, accepted.turn.turnId);
  assert.equal((await store.markQueuedTurnNotSent(accepted.turn, 'Новое сообщение не должно заменить причину.')).marked, false);

  const chat = await store.createChat();
  const runningAccepted = await store.acceptLocalMessage(chat.id, 'Уже выполняющийся ход', 'running-not-sent-check');
  const queuedRecord = (await store.getChat(chat.id)).turns.find((item) => item.turnId === runningAccepted.turn.turnId);
  assert.ok(queuedRecord);
  await store.updateRuntimeTurn({
    id: runningAccepted.turn.turnId, chatId: chat.id, anchorMessageId: runningAccepted.turn.messageId,
    assistantMessageId: runningAccepted.turn.assistantMessageId, modelId: runningAccepted.turn.modelId,
    status: 'running', createdAt: queuedRecord.createdAt, startedAt: timestamp, activity: [],
  });
  const runningBefore = (await store.getChat(chat.id)).turns.find((item) => item.turnId === runningAccepted.turn.turnId);
  assert.equal((await store.markQueuedTurnNotSent(runningAccepted.turn, reason)).marked, false);
  assert.deepEqual((await store.getChat(chat.id)).turns.find((item) => item.turnId === runningAccepted.turn.turnId), runningBefore);
  await appendAcceptedAnswer(store, runningAccepted.turn, 'Ход действительно завершён.');
  const completedBefore = (await store.getChat(chat.id)).turns.find((item) => item.turnId === runningAccepted.turn.turnId);
  assert.equal(completedBefore?.status, 'completed');
  assert.equal((await store.markQueuedTurnNotSent(runningAccepted.turn, reason)).marked, false);
  assert.deepEqual((await store.getChat(chat.id)).turns.find((item) => item.turnId === runningAccepted.turn.turnId), completedBefore);

  const reopened = await openStore(directory);
  const restoredHome = await reopened.getChat(accepted.turn.chatId);
  assert.equal(restoredHome.turns.find((item) => item.turnId === accepted.turn.turnId)?.status, 'failed');
  assert.equal(restoredHome.turns.find((item) => item.turnId === accepted.turn.turnId)?.startedAt, undefined);
  assert.deepEqual(restoredHome.messages.map(({ role, text }) => ({ role, text })), [{ role: 'user', text: 'Сохрани этот запрос' }]);
  assert.equal(restoredHome.modelId, 'GigaChat-3-Pro');
  const restoredRunningChat = await reopened.getChat(chat.id);
  assert.equal(restoredRunningChat.messages.filter((message) => message.role === 'assistant').length, 1);
  assert.equal(restoredRunningChat.turns.find((item) => item.turnId === runningAccepted.turn.turnId)?.status, 'completed');
  store.releaseTurnReservation(accepted.turn.turnId);
  store.releaseTurnReservation(runningAccepted.turn.turnId);
});

test('a failed home-send journal write leaves the unsent draft and files available', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'keep.txt');
  await writeFile(source, 'keep me', 'utf8');
  const store = await openStore(directory, {
    testFaults: { beforeHomeSendJournal: () => { throw new Error('synthetic journal failure'); } },
  });
  const draft = await store.saveHomeDraft({
    revision: 1, text: 'keep this input', projectId: null,
    permissionProfile: 'ask', skillId: null, modelId: null,
  });
  const withFile = await store.stageHomeDraftFile(source);

  await assert.rejects(store.acceptHomeDraft(withFile.revision, 'home-turn-failed'), /synthetic journal failure/);
  assert.deepEqual(await store.getHomeDraft(), withFile);
  assert.deepEqual(await store.listChats(), []);
  assert.equal(await readFile(source, 'utf8'), 'keep me');
  assert.ok(draft.revision < withFile.revision);
});

test('an interrupted home send journal replays the complete chat without queueing work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'recover.txt');
  await writeFile(source, 'recovery fixture', 'utf8');
  const store = await openStore(directory, {
    testFaults: {
      afterHomeSendStage: (stage) => {
        if (stage === 'chat') throw new Error('simulated process interruption');
      },
    },
  });
  await store.saveHomeDraft({
    revision: 1, text: 'restore this send', projectId: null,
    permissionProfile: 'ask', skillId: null, modelId: 'GigaChat-3-Pro',
  });
  const staged = await store.stageHomeDraftFile(source);

  await assert.rejects(store.acceptHomeDraft(staged.revision, 'home-turn-recovery'), /simulated process interruption/);
  await assert.rejects(store.listChats(), /simulated process interruption/, 'a repeated read waits for journal recovery instead of exposing a partial chat');
  assert.equal(await readFile(source, 'utf8'), 'recovery fixture');

  const recovered = await openStore(directory);
  const chats = await recovered.listChats();
  assert.equal(chats.length, 1);
  const detail = await recovered.getChat(chats[0]!.id);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0]?.text, 'restore this send');
  assert.equal(detail.artifacts[0]?.messageId, detail.messages[0]?.id);
  assert.equal(await readFile(await recovered.getArtifactPath(detail.id, detail.artifacts[0]!.id), 'utf8'), 'recovery fixture');
  assert.equal((await recovered.getHomeDraft()).text, '');
  assert.equal((await recovered.getHomeDraft()).lastAcceptance?.turn.turnId, 'home-turn-recovery');
  assert.equal(await readFile(source, 'utf8'), 'recovery fixture');
});

test('schema 8 home-send journal recovers linked local files without inventing accepted-turn upload refs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-v8-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'legacy-local.txt');
  await writeFile(source, 'local bytes from schema 8', 'utf8');
  const store = await openStore(directory, {
    testFaults: {
      afterHomeSendStage: async (stage) => {
        if (stage !== 'journal') return;
        const journalPath = join(directory, 'home-send.journal.json');
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
        downgradeHomeSendJournalToSchema8(journal);
        await writeFile(journalPath, JSON.stringify(journal), 'utf8');
        throw new Error('simulated interruption after legacy journal write');
      },
    },
  });
  await store.saveHomeDraft({
    revision: 1, text: 'Read this local file', projectId: null,
    permissionProfile: 'ask', skillId: null, modelId: 'GigaChat-3-Pro',
  });
  const staged = await store.stageHomeDraftFile(source);

  await assert.rejects(store.acceptHomeDraft(staged.revision, 'legacy-home-turn'), /simulated interruption/);
  const recovered = await openStore(directory);
  const [summary] = await recovered.listChats();
  assert.ok(summary);
  const detail = await recovered.getChat(summary.id);
  const accepted = (await recovered.getHomeDraft()).lastAcceptance;
  assert.deepEqual(detail.messages[0]?.attachmentIds, [staged.attachments[0]!.id]);
  assert.equal(detail.artifacts[0]?.messageId, detail.messages[0]?.id);
  assert.equal(detail.artifacts[0]?.sha256, undefined, 'legacy artifact metadata remains intact');
  assert.equal(accepted?.turn.attachmentIds, undefined, 'the old accepted turn is never upgraded into an upload request');
  assert.equal(accepted?.turn.messages[0]?.attachmentIds, undefined);
  assert.deepEqual(await readFile(await recovered.getArtifactPath(detail.id, staged.attachments[0]!.id)), Buffer.from('local bytes from schema 8'));
  const savedChat = JSON.parse(await readFile(join(directory, 'chats', detail.id, 'chat.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(savedChat.schemaVersion, 13);
});

test('schema 8 compact snapshot validates against its original linked-file prefix then upgrades the hash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-compact-v8-linked-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'local.txt');
  await writeFile(source, 'local attachment bytes', 'utf8');
  const store = await openStore(directory);
  const chat = await store.createChat();
  const pending = await store.stageChatDraftFile(chat.id, source);
  const pendingId = pending.draftAttachments[0]!.id;
  const accepted = await store.acceptLocalMessage(chat.id, 'Use the attached local file.', 'legacy-linked-file-turn', [pendingId]);
  const chatPath = join(await store.getChatFolder(chat.id), 'chat.json');
  const legacy = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  const legacyMessages = structuredClone(legacy.messages) as Array<Record<string, unknown>>;
  for (const message of legacyMessages) delete message.attachmentIds;
  const oldHash = hashCompactionPrefix(legacyMessages as unknown as ChatMessage[], []);
  legacy.schemaVersion = 8;
  delete legacy.providerStateOwnership;
  delete legacy.draftAttachments;
  delete legacy.turns;
  legacy.messages = legacyMessages;
  for (const artifact of legacy.artifacts as Array<Record<string, unknown>>) delete artifact.sha256;
  legacy.compactSnapshot = {
    id: 'legacy-compact-snapshot', version: 1,
    boundaryMessageId: accepted.turn.messageId, coveredThroughMessageId: accepted.turn.messageId,
    coveredPrefixHash: oldHash, text: 'The local file was attached to the first message.',
    modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  } satisfies CompactSnapshot;
  await writeFile(chatPath, JSON.stringify(legacy), 'utf8');

  const restored = await openStore(directory);
  const detail = await restored.getChat(chat.id);
  assert.deepEqual(detail.messages[0]?.attachmentIds, [pendingId]);
  assert.notEqual(detail.compactSnapshot?.coveredPrefixHash, oldHash, 'migration rehashes only after verifying the authentic schema 8 prefix');
  assert.equal(detail.compactSnapshot?.coveredPrefixHash, hashCompactionPrefix(detail.messages, []));
  assert.equal(await readFile(await restored.getArtifactPath(chat.id, pendingId), 'utf8'), 'local attachment bytes');
  const saved = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.schemaVersion, 13);
  assert.deepEqual((saved.compactSnapshot as CompactSnapshot).coveredPrefixHash, detail.compactSnapshot?.coveredPrefixHash);
});

test('rejects tampered schema 8 attachment migrations without rewriting source bytes', async (t) => {
  await t.test('a bad old compact-prefix hash leaves the schema 8 chat file unchanged', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'gigachat-compact-v8-tamper-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'local.txt');
    await writeFile(source, 'preserve legacy bytes', 'utf8');
    const store = await openStore(directory);
    const chat = await store.createChat();
    const staged = await store.stageChatDraftFile(chat.id, source);
    const attachmentId = staged.draftAttachments[0]!.id;
    const accepted = await store.acceptLocalMessage(chat.id, 'Keep the old attachment link.', 'legacy-hash-tamper', [attachmentId]);
    const chatPath = join(await store.getChatFolder(chat.id), 'chat.json');
    const legacy = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
    const messages = structuredClone(legacy.messages) as Array<Record<string, unknown>>;
    for (const message of messages) delete message.attachmentIds;
    legacy.schemaVersion = 8;
    delete legacy.providerStateOwnership;
    delete legacy.draftAttachments;
    delete legacy.turns;
    legacy.messages = messages;
    for (const artifact of legacy.artifacts as Array<Record<string, unknown>>) delete artifact.sha256;
    legacy.compactSnapshot = {
      id: 'tampered-legacy-snapshot', version: 1,
      boundaryMessageId: accepted.turn.messageId, coveredThroughMessageId: accepted.turn.messageId,
      coveredPrefixHash: 'f'.repeat(64), text: 'Do not accept a changed prefix.',
      modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
    } satisfies CompactSnapshot;
    const corruptedBytes = JSON.stringify(legacy);
    await writeFile(chatPath, corruptedBytes, 'utf8');

    const restored = await openStore(directory);
    assert.deepEqual(await restored.listChats(), [], 'the invalid legacy chat is not exposed as migrated history');
    assert.deepEqual(await readFile(chatPath, 'utf8'), corruptedBytes, 'failed validation leaves the source bytes untouched');
  });

  await t.test('a mismatched old accepted-turn message leaves the journal and draft bytes unchanged', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-v8-tamper-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'local.txt');
    await writeFile(source, 'preserve pending home bytes', 'utf8');
    let corruptedJournal = '';
    const store = await openStore(directory, {
      testFaults: {
        afterHomeSendStage: async (stage) => {
          if (stage !== 'journal') return;
          const journalPath = join(directory, 'home-send.journal.json');
          const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
          downgradeHomeSendJournalToSchema8(journal);
          const turn = journal.turn as Record<string, unknown>;
          const turnMessages = turn.messages as Array<Record<string, unknown>>;
          turnMessages[0]!.text = 'tampered accepted text';
          corruptedJournal = JSON.stringify(journal);
          await writeFile(journalPath, corruptedJournal, 'utf8');
          throw new Error('simulated interruption after tampered legacy journal write');
        },
      },
    });
    const initial = await store.getHomeDraft();
    await store.saveHomeDraft({ ...initial, revision: initial.revision + 1, text: 'Original accepted text' });
    const staged = await store.stageHomeDraftFile(source);
    const homeDraftPath = join(directory, 'home-draft.json');
    const homeDraftBeforeRecovery = await readFile(homeDraftPath);

    await assert.rejects(store.acceptHomeDraft(staged.revision, 'tampered-legacy-turn'), /tampered legacy journal/);
    await assert.rejects(openStore(directory), /storage|home-send/i);
    const journalPath = join(directory, 'home-send.journal.json');
    assert.equal(await readFile(journalPath, 'utf8'), corruptedJournal, 'rejected journal bytes are preserved for recovery');
    assert.deepEqual(await readFile(homeDraftPath), homeDraftBeforeRecovery, 'unsent text and staged-file links remain unchanged');
    assert.deepEqual(await readFile(source), Buffer.from('preserve pending home bytes'));
  });
});

test('home-send recovery preserves a different chat already stored under the journal ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-collision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let conflictTemplate: Record<string, unknown> | null = null;
  const store = await openStore(directory, {
    testFaults: {
      afterHomeSendStage: async (stage) => {
        if (stage !== 'journal' || !conflictTemplate) return;
        const journal = JSON.parse(await readFile(join(directory, 'home-send.journal.json'), 'utf8')) as { chat: { id: string } };
        const conflict = { schemaVersion: 10, ...conflictTemplate, id: journal.chat.id, title: 'Existing unrelated chat' };
        const chatFolder = join(directory, 'chats', journal.chat.id);
        await mkdir(chatFolder, { recursive: true });
        await writeFile(join(chatFolder, 'chat.json'), JSON.stringify(conflict), 'utf8');
      },
    },
  });
  const existing = await store.createChat();
  conflictTemplate = await store.getChat(existing.id) as unknown as Record<string, unknown>;
  const originalMessages = conflictTemplate.messages;
  const originalChatPath = join(directory, 'chats', existing.id, 'chat.json');
  const originalChatBytes = await readFile(originalChatPath, 'utf8');
  const draft = await store.saveHomeDraft({
    revision: 1, text: 'Do not overwrite another chat', projectId: null,
    permissionProfile: 'ask', skillId: null, modelId: 'GigaChat-3-Pro',
  });

  await assert.rejects(store.acceptHomeDraft(draft.revision, 'home-turn-collision'), /чат с тем же ID/);
  const journal = JSON.parse(await readFile(join(directory, 'home-send.journal.json'), 'utf8')) as { chat: { id: string } };
  const preserved = JSON.parse(await readFile(join(directory, 'chats', journal.chat.id, 'chat.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(preserved.title, 'Existing unrelated chat');
  assert.deepEqual(preserved.messages, originalMessages);
  assert.equal(await readFile(originalChatPath, 'utf8'), originalChatBytes, 'the original chat remains untouched');
});

test('deleting an accepted home chat removes its duplicate message snapshot and does not recreate it on a late Send', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-send-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const draft = await store.saveHomeDraft({
    revision: 1, text: 'Удалить вместе с сохранённой копией', projectId: null,
    permissionProfile: null, skillId: null, modelId: 'GigaChat-3-Pro',
  });
  const accepted = await store.acceptHomeDraft(draft.revision, 'home-delete-turn');
  await store.deleteChat(accepted.detail.id);

  const reopened = await openStore(directory);
  assert.deepEqual(await reopened.listChats(), []);
  assert.equal((await reopened.getHomeDraft()).lastAcceptance, null);
  await assert.rejects(reopened.acceptHomeDraft(draft.revision, 'late-home-send'), /изменился|устарела/i);
  assert.deepEqual(await reopened.listChats(), [], 'a late IPC retry must not recreate the deleted chat');
});

test('changing the next model preserves accepted turns, messages, and historical usage IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-model-family-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  await store.updateSettings({ defaultModelId: 'GigaChat-2-Pro' });
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-2-Pro' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Оставить старую модель в принятом ходе', 'model-family-accepted-turn');
  const receipt = {
    localRequestId: '33333333-3333-4333-8333-333333333333',
    chatId: chat.id,
    requestKind: 'chat' as const,
    modelId: 'GigaChat-2-Pro',
    providerRequestId: 'historical-provider-request',
    providerModel: 'GigaChat-2-Pro:2.0.28.2',
    createdAt: timestamp,
    status: 'completed' as const,
    promptTokens: 12,
    completionTokens: 4,
    totalTokens: 16,
    precachedPromptTokens: null,
    conflictedFields: [],
  };
  await store.recordUsageReceipt(receipt);
  await appendAcceptedAnswer(store, accepted.turn, 'Сохранённый ответ');
  const messagesBeforeChange = (await store.getChat(chat.id)).messages;

  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  await store.updateSettings({ defaultModelId: 'GigaChat-3-Lightning' });
  const nextChat = await store.createChat();
  const restored = await openStore(directory);

  assert.equal(accepted.turn.modelId, 'GigaChat-2-Pro', 'accepted turns keep their original provider model');
  assert.deepEqual((await restored.getChat(chat.id)).messages, messagesBeforeChange, 'model migration does not rewrite old messages');
  assert.equal((await restored.getChat(chat.id)).modelId, 'GigaChat-3-Pro', 'only the next model selection changes');
  assert.equal((await restored.getChat(nextChat.id)).modelId, 'GigaChat-3-Lightning');
  const ledger = await restored.getUsageLedger();
  assert.deepEqual(ledger.byModel.map((item) => item.key), ['GigaChat-2-Pro'], 'the raw usage model ID is retained');
  assert.equal(ledger.totalTokens.knownTokens, 16);
});

test('persists deduplicated usage outside chat lifetime, including pending usage after chat deletion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-usage-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const base = {
    localRequestId: '11111111-1111-4111-8111-111111111111',
    chatId: chat.id,
    requestKind: 'chat' as const,
    modelId: 'GigaChat-test',
    providerRequestId: null,
    providerModel: null,
    createdAt: '2026-10-09T00:00:00.000Z',
    status: 'pending' as const,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    precachedPromptTokens: null,
    conflictedFields: [],
  };
  await store.recordUsageReceipt(base);
  await store.recordUsageReceipt({
    ...base, status: 'completed', providerRequestId: 'provider-response-1', providerModel: 'GigaChat-v3',
    promptTokens: 20, completionTokens: 3, totalTokens: 23, precachedPromptTokens: 5,
  });
  await store.deleteChat(chat.id);
  await store.recordUsageReceipt({
    ...base, localRequestId: '22222222-2222-4222-8222-222222222222', requestKind: 'tool-continuation',
  });

  const restored = await openStore(directory);
  const ledger = await restored.getUsageLedger();
  assert.equal(ledger.requestCount, 2);
  assert.equal(ledger.totalTokens.knownTokens, 23);
  assert.equal(ledger.totalTokens.unknownRequests, 1);
  assert.equal(ledger.precachedPromptTokens.knownTokens, 5);
  assert.equal(ledger.byChat.length, 1);
  assert.equal(ledger.byChat[0]?.key, chat.id);
  assert.equal(ledger.pendingRequestCount, 1);
});

test('fails closed on a corrupt usage ledger without rewriting it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-usage-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'usage.json');
  const contents = JSON.stringify({ schemaVersion: 2, receipts: [] });
  await writeFile(path, contents, 'utf8');

  await assert.rejects(openStore(directory), /повреждён или имеет неизвестный формат/);
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('retains an older unavailable model ID when reading a chat after reload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-legacy-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const detail = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  detail.modelId = 'retired/model-v0';
  await writeFile(path, JSON.stringify(detail));

  const restored = await openStore(directory);
  assert.equal((await restored.getChat(chat.id)).modelId, 'retired/model-v0');
});

test('persists a balance anchor over an unchanged historical pending receipt and subtracts only later usage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-balance-anchor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accountA = createHash('sha256').update('synthetic-account-A').digest('hex');
  await store.recordUsageReceipt({
    localRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chatId: chat.id, requestKind: 'chat',
    modelId: 'GigaChat-3-Pro', providerRequestId: 'before-anchor-pending', providerModel: null,
    createdAt: '2026-10-13T09:00:00.000Z', status: 'pending', promptTokens: null,
    completionTokens: null, totalTokens: null, precachedPromptTokens: null, conflictedFields: [],
  });
  const baseline = await store.getUsageReceiptBaseline();
  await store.saveProviderBalanceAnchor(accountA, {
    observedAt: '2026-10-13T10:00:00.000Z', unknownUsageCount: 0,
    families: [
      { family: 'ultra', state: 'known', value: 5_000 },
      { family: 'max', state: 'known', value: 4_000 },
      { family: 'pro', state: 'known', value: 3_000 },
      { family: 'lite', state: 'known', value: 2_000 },
    ],
  }, baseline);
  await store.recordUsageReceipt({
    localRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chatId: chat.id, requestKind: 'tool-continuation',
    modelId: 'GigaChat-3-Pro', providerRequestId: 'after-anchor', providerModel: 'GigaChat-3-Pro',
    createdAt: '2026-10-13T11:00:00.000Z', status: 'completed', promptTokens: 40,
    completionTokens: 8, totalTokens: 37, precachedPromptTokens: 12, conflictedFields: [],
  });

  const restored = await openStore(directory);
  const view = await restored.getUsageProfileView(0, accountA);
  const pro = view.balance.families.find((family) => family.family === 'pro');
  assert.equal(view.balance.source, 'api');
  assert.equal(view.balance.incomplete, false, 'an unchanged old pending receipt is already covered by the observed snapshot');
  assert.equal(pro?.usedSinceSnapshot, 37, 'cached prompt tokens are not subtracted again');
  assert.equal(pro?.estimatedRemainingTokens, 2_963);
  assert.equal((await restored.getUsageProfileView(0, 'b'.repeat(64))).balance.state, 'unknown');
  assert.equal('accountScope' in view.balance, false, 'private account scope never enters the renderer DTO');
  assert.equal('baselineReceiptDigest' in view.balance, false);
});

test('rejects a balance observation if receipt identity changes while the request is in flight', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-balance-cas-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const account = createHash('sha256').update('synthetic-cas-account').digest('hex');
  const baseline = await store.getUsageReceiptBaseline();
  await store.recordUsageReceipt({
    localRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', chatId: chat.id, requestKind: 'chat',
    modelId: 'GigaChat-3-Pro', providerRequestId: null, providerModel: null,
    createdAt: '2026-10-13T11:00:00.000Z', status: 'completed', promptTokens: 10,
    completionTokens: 2, totalTokens: 12, precachedPromptTokens: null, conflictedFields: [],
  });
  await assert.rejects(store.saveProviderBalanceAnchor(account, {
    observedAt: '2026-10-13T10:00:00.000Z', unknownUsageCount: 0,
    families: [
      { family: 'ultra', state: 'known', value: 10 }, { family: 'max', state: 'known', value: 10 },
      { family: 'pro', state: 'known', value: 10 }, { family: 'lite', state: 'known', value: 10 },
    ],
  }, baseline), /история запросов изменилась/i);
  assert.equal((await store.getUsageProfileView(0, account)).balance.state, 'unknown');
});

test('invalidating active balance anchors prevents A to B to A from reusing an old snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-balance-scope-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accountA = createHash('sha256').update('synthetic-old-key-A').digest('hex');
  const baseline = await store.getUsageReceiptBaseline();
  const families = [
    { family: 'ultra', state: 'known', value: 100 }, { family: 'max', state: 'known', value: 100 },
    { family: 'pro', state: 'known', value: 100 }, { family: 'lite', state: 'known', value: 100 },
  ];
  await store.saveProviderBalanceAnchor(accountA, {
    observedAt: '2026-10-13T10:00:00.000Z', unknownUsageCount: 0, families,
  }, baseline);
  await store.recordUsageReceipt({
    localRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', chatId: chat.id, requestKind: 'chat',
    modelId: 'GigaChat-3-Pro', providerRequestId: null, providerModel: null,
    createdAt: '2026-10-13T11:00:00.000Z', status: 'completed', promptTokens: 15,
    completionTokens: 3, totalTokens: 18, precachedPromptTokens: null, conflictedFields: [],
  });
  assert.equal((await store.getUsageProfileView(0, accountA)).balance.families.find((family) => family.family === 'pro')?.estimatedRemainingTokens, 82);

  await store.invalidateUsageBalanceAnchors();
  const reopened = await openStore(directory);
  const returnedToA = await reopened.getUsageProfileView(0, accountA);
  assert.equal(returnedToA.balance.state, 'unknown', 'raw usage has no account scope, so old calibration cannot be revived');
  assert.equal(returnedToA.total.totalTokens.knownTokens, 18, 'invalidation preserves the raw usage ledger');
});

test('persists only explicit complete Studio observations and their provenance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-balance-studio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const account = createHash('sha256').update('synthetic-studio-account').digest('hex');
  const baseline = await store.getUsageReceiptBaseline();
  const input = {
    remainingTokens: { ultra: 49_000, max: 24_000, pro: 39_000, lite: 249_000 },
    expiresAt: '2027-10-12',
  };
  assert.throws(() => store.saveStudioBalanceAnchor(account, {
    ...input, extra: 'not accepted',
  }, baseline));
  assert.equal((await store.getUsageProfileView(0, account)).balance.state, 'unknown');

  await store.saveStudioBalanceAnchor(account, input, baseline);
  const view = await (await openStore(directory)).getUsageProfileView(0, account);
  assert.equal(view.balance.source, 'studio');
  assert.equal(view.balance.families.find((family) => family.family === 'ultra')?.snapshotRemainingTokens, 49_000);
  assert.equal(view.balance.expiresAt, '2027-10-12');
});

test('inserts a queued reply after its user anchor and assembles only history through the next anchor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-queued-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const first = await store.acceptLocalMessage(chat.id, 'user1', 'turn-queued-1');
  const second = await store.acceptLocalMessage(chat.id, 'user2', 'turn-queued-2');
  const third = await store.acceptLocalMessage(chat.id, 'user3', 'turn-queued-3');

  assert.deepEqual(second.turn.messages.map((message) => message.text), ['user1', 'user2']);
  assert.deepEqual(third.turn.messages.map((message) => message.text), ['user1', 'user2', 'user3']);
  await appendAcceptedAnswer(store, first.turn, 'answer1');
  const updated = await store.getChat(chat.id);
  assert.deepEqual(updated.messages.map((message) => message.text), ['user1', 'answer1', 'user2', 'user3']);
  assert.equal(updated.messages[1]?.source, 'runtime');
  assert.deepEqual((await store.getMessagesThrough(chat.id, second.turn.messageId)).map((message) => message.text), [
    'user1', 'answer1', 'user2',
  ]);
  for (const turn of [first.turn, second.turn, third.turn]) store.releaseTurnReservation(turn.turnId);
});

test('compaction captures the fixed queued prefix, keeps tool pairing, and persists without hiding messages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-compaction-prefix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-2-Pro' });
  const first = await store.acceptLocalMessage(chat.id, 'user1', 'turn-compact-user1');
  const receiptId = 'c'.repeat(64);
  await store.beginToolReceipt(chat.id, first.turn.messageId, {
    receiptId, name: 'read', arguments: { path: 'src/example.ts' }, content: null, functionsStateId: 'state-user1',
  });
  await store.completeToolReceipt(chat.id, first.turn.messageId, receiptId, 'completed', JSON.stringify({ ok: true, text: 'tool result' }));
  await appendAcceptedAnswer(store, first.turn, 'answer1');

  const second = await store.acceptLocalMessage(chat.id, 'user2', 'turn-compact-user2');
  const compact = await store.acceptCompactionTurn(chat.id, 'turn-compact');
  assert.equal(compact.turn.messageId, second.turn.messageId);
  await appendAcceptedAnswer(store, second.turn, 'answer2');
  await store.acceptLocalMessage(chat.id, 'user3', 'turn-compact-user3');

  const prefix = await store.getCompactionPrefix(chat.id, compact.turn.messageId);
  assert.deepEqual(prefix.messages.map((message) => message.text), ['user1', 'answer1', 'user2', 'answer2']);
  assert.equal(prefix.coveredThroughMessageId, (await store.getChat(chat.id)).messages[3]?.id);
  assert.deepEqual(prefix.protocolHistory.map((exchange) => ({
    anchorMessageId: exchange.anchorMessageId,
    name: exchange.name,
    functionsStateId: exchange.functionsStateId,
    result: JSON.parse(exchange.result),
  })), [{
    anchorMessageId: first.turn.messageId,
    name: 'read',
    functionsStateId: 'state-user1',
    result: { ok: true, text: 'tool result' },
  }]);

  const snapshot: CompactSnapshot = {
    id: 'snapshot-compact-1', version: 1, boundaryMessageId: compact.turn.messageId,
    coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
    text: 'Сохранены user1, tool result, answer1 и user2.', modelId: 'GigaChat-2-Pro',
    provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, snapshot, compact.turn.compactExpectedSnapshotId ?? null, undefined,
    completedCompactionTurn(compact.turn, (await store.getChat(chat.id)).turns.find((turn) => turn.turnId === compact.turn.turnId)!.createdAt));
  const beforeReload = await store.getChat(chat.id);
  assert.deepEqual(beforeReload.messages.map((message) => message.text), ['user1', 'answer1', 'user2', 'answer2', 'user3']);
  assert.deepEqual(beforeReload.compactSnapshot, snapshot);

  const restored = await openStore(directory);
  const afterReload = await restored.getChat(chat.id);
  assert.deepEqual(afterReload.messages, beforeReload.messages);
  assert.deepEqual(afterReload.compactSnapshot, snapshot);
  store.releaseTurnReservation(first.turn.turnId);
  store.releaseTurnReservation(second.turn.turnId);
  store.releaseTurnReservation(compact.turn.turnId);
});

test('compact snapshot conflicts, save failures, and cancellation leave prior summary and history intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-compaction-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const enteredCommit = deferred();
  const releaseCommit = deferred();
  let holdCommit = false;
  let failCommit = false;
  const store = await openStore(directory, {
    testFaults: {
      beforeCompactSnapshotCommit: async () => {
        if (failCommit) throw new Error('synthetic compact snapshot save failure');
        if (!holdCommit) return;
        enteredCommit.resolve();
        await releaseCommit.promise;
      },
    },
  });
  const chat = await store.createChat();
  const first = await store.acceptLocalMessage(chat.id, 'Первый запрос', 'turn-compact-first');
  const firstPrefix = await store.getCompactionPrefix(chat.id, first.turn.messageId);
  const firstSnapshot: CompactSnapshot = {
    id: 'snapshot-first', version: 1, boundaryMessageId: first.turn.messageId,
    coveredThroughMessageId: firstPrefix.coveredThroughMessageId, coveredPrefixHash: firstPrefix.coveredPrefixHash,
    text: 'Первая сохранённая сводка.', modelId: 'GigaChat-2-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, firstSnapshot, null);

  const conflicting = { ...firstSnapshot, id: 'snapshot-conflict', text: 'Конкурирующая сводка.' };
  await assert.rejects(store.commitCompactSnapshot(chat.id, conflicting, null), /изменилась/);
  const second = await store.acceptLocalMessage(chat.id, 'Второй запрос', 'turn-compact-second');
  const secondPrefix = await store.getCompactionPrefix(chat.id, second.turn.messageId);
  const cancelledSnapshot: CompactSnapshot = {
    id: 'snapshot-cancelled', version: 1, boundaryMessageId: second.turn.messageId,
    coveredThroughMessageId: secondPrefix.coveredThroughMessageId, coveredPrefixHash: secondPrefix.coveredPrefixHash,
    text: 'Эта сводка должна быть отменена.', modelId: 'GigaChat-2-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  const beforeSaveFailure = await store.getChat(chat.id);
  const failedSnapshot = { ...cancelledSnapshot, id: 'snapshot-save-failure', text: 'Эта сводка не должна сохраниться.' };
  failCommit = true;
  await assert.rejects(store.commitCompactSnapshot(chat.id, failedSnapshot, firstSnapshot.id), /synthetic compact snapshot save failure/);
  failCommit = false;

  const afterSaveFailure = await store.getChat(chat.id);
  assert.deepEqual(afterSaveFailure.messages, beforeSaveFailure.messages);
  assert.deepEqual(afterSaveFailure.compactSnapshot, firstSnapshot);
  const reloadedAfterSaveFailure = await openStore(directory);
  const persistedAfterSaveFailure = await reloadedAfterSaveFailure.getChat(chat.id);
  assert.deepEqual(persistedAfterSaveFailure.messages, beforeSaveFailure.messages);
  assert.deepEqual(persistedAfterSaveFailure.compactSnapshot, firstSnapshot);

  holdCommit = true;
  const controller = new AbortController();
  const pendingCommit = store.commitCompactSnapshot(chat.id, cancelledSnapshot, firstSnapshot.id, controller.signal);
  await enteredCommit.promise;
  controller.abort();
  releaseCommit.resolve();
  await assert.rejects(pendingCommit, (error: unknown) => error instanceof Error && error.name === 'AbortError');

  assert.deepEqual((await store.getChat(chat.id)).compactSnapshot, firstSnapshot);
  assert.deepEqual((await (await openStore(directory)).getChat(chat.id)).compactSnapshot, firstSnapshot);
  store.releaseTurnReservation(first.turn.turnId);
  store.releaseTurnReservation(second.turn.turnId);
});

test('runs queued turns through the real context builder and store compaction, then reloads summary with recent history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-compaction-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'future/model-without-capability-metadata' });
  const first = await store.acceptLocalMessage(chat.id, 'Первый запрос', 'turn-e2e-first');
  const second = await store.acceptLocalMessage(chat.id, 'Второй запрос', 'turn-e2e-second');
  const compact = await store.acceptCompactionTurn(chat.id, 'turn-e2e-compact');
  const third = await store.acceptLocalMessage(chat.id, 'Третий запрос', 'turn-e2e-third');
  const requests: ProviderTurnRequest[] = [];
  const hookEvents: string[] = [];
  let reads = 0;
  const provider: GigaChatProvider = {
    stream: async function* (request): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone(request));
      yield { type: 'usage', promptTokens: 8, completionTokens: 2, totalTokens: 10, precachedPromptTokens: 1 };
      if (request.usageKind === 'compaction') {
        yield { type: 'text-delta', text: 'Сводка: первый, второй и результат чтения.' };
      } else {
        const userPrompt = [...request.messages].reverse().find((message) => message.role === 'user')?.text ?? '';
        if (userPrompt === 'Первый запрос' && !request.protocolHistory?.length) {
          yield {
            type: 'function-call',
            functionCall: {
              name: 'read', arguments: { path: 'src/example.ts' }, content: null,
              functionsStateId: 'state-read-first', terminalReason: 'function_call',
            },
          };
          return;
        } else yield { type: 'text-delta', text: `Ответ:${userPrompt}` };
      }
      yield { type: 'completed' };
    },
  };
  const runtime = createTurnRuntime({
    provider,
    tools: { read: async (_projectId: string | null, _profile: unknown, path: string) => { reads += 1; return `fixture:${path}`; } } as never,
    prepareTurn: async (turn: AcceptedTurnInput, signal): Promise<ProviderTurnRequest | PreparedTurn> => {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      await store.validateAcceptedTurn(turn);
      const detail = await store.getChat(turn.chatId);
      const prefix = turn.operation === 'compaction'
        ? await store.getCompactionPrefix(turn.chatId, turn.compactBoundaryMessageId)
        : null;
      const messages = prefix?.messages ?? await store.getMessagesThrough(turn.chatId, turn.messageId);
      const protocolHistory = prefix?.protocolHistory ?? await store.getToolProtocolThrough(turn.chatId, turn.messageId);
      const context = buildNextTurnContext({
        globalText: 'Контекст приложения.',
        selectedSkill: null,
        projectInstructions: [],
        messages,
        protocolHistory,
        compactSnapshot: detail.compactSnapshot,
        permissionProfile: turn.permissionProfile,
        modelId: turn.modelId,
        ...(turn.operation === 'compaction' ? {
          taskInstruction: COMPACTION_TASK_INSTRUCTION,
          usageKind: 'compaction' as const,
          functionCallMode: 'none' as const,
        } : {}),
      });
      if (!prefix || turn.operation !== 'compaction') return context.request;
      return {
        request: context.request,
        compaction: {
          boundaryMessageId: turn.compactBoundaryMessageId!,
          coveredThroughMessageId: prefix.coveredThroughMessageId,
          coveredPrefixHash: prefix.coveredPrefixHash,
          expectedSnapshotId: turn.compactExpectedSnapshotId ?? null,
          provenance: 'fixture',
        },
      };
    },
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, _functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal);
    },
    appendCompaction: async (turn, text, signal, context, terminalTurn) => {
      const snapshot: CompactSnapshot = {
        id: `snapshot-${turn.turnId}`, version: 1, boundaryMessageId: context.boundaryMessageId,
        coveredThroughMessageId: context.coveredThroughMessageId, coveredPrefixHash: context.coveredPrefixHash,
        text, modelId: turn.modelId!, provenance: context.provenance, createdAt: new Date().toISOString(),
      };
      await store.commitCompactSnapshot(turn.chatId, snapshot, context.expectedSnapshotId, signal, terminalTurn);
    },
    compactionEnabled: true,
    beginToolReceipt: (turn, receipt) => store.beginToolReceipt(turn.chatId, turn.messageId, receipt),
    completeToolReceipt: (turn, receiptId, status, result) => store.completeToolReceipt(turn.chatId, turn.messageId, receiptId, status, result),
    recordUsageReceipt: (receipt) => store.recordUsageReceipt(receipt),
    runHooks: async (_turn, input: HookDispatchInput): Promise<HookRunResult[]> => {
      hookEvents.push(input.event);
      return [{ hookId: `global/fixture-${input.event}`, hookName: 'Fixture', event: input.event, status: 'completed' }];
    },
  });

  assert.ok(runtime.enqueue(first.turn));
  assert.ok(runtime.enqueue(second.turn));
  assert.ok(runtime.enqueueCompaction(compact.turn));
  assert.ok(runtime.enqueue(third.turn));
  await runtime.whenIdle();

  assert.equal(reads, 1);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[2]?.messages.map((message) => message.text), [
    'Первый запрос', 'Ответ:Первый запрос', 'Второй запрос',
  ]);
  assert.deepEqual(requests[3]?.messages.map((message) => message.text), [
    'Первый запрос', 'Ответ:Первый запрос', 'Второй запрос', 'Ответ:Второй запрос',
  ]);
  assert.equal(requests[3]?.protocolHistory?.length, 1);
  assert.equal(requests[3]?.protocolHistory?.[0]?.anchorMessageId, first.turn.messageId);
  assert.equal(requests[3]?.protocolHistory?.[0]?.result, JSON.stringify({ ok: true, result: 'fixture:src/example.ts' }));
  assert.equal(requests[3]?.functionCallMode, 'none');
  assert.equal(requests[3]?.usageKind, 'compaction');
  assert.deepEqual(requests[4]?.messages.map((message) => message.text), ['Третий запрос']);
  assert.match(requests[4]?.system.find((layer) => layer.source === 'summary')?.text ?? '', /Сводка: первый, второй/);
  assert.equal(requests[4]?.protocolHistory?.length, 0);
  assert.equal(hookEvents.filter((event) => event === 'before-compaction').length, 1);
  assert.equal(hookEvents.filter((event) => event === 'after-compaction').length, 1);

  const usageFile = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8')) as {
    receipts: Array<{ requestKind: string; status: string }>;
  };
  assert.deepEqual(usageFile.receipts.map((receipt) => receipt.requestKind), [
    'chat', 'tool-continuation', 'chat', 'compaction', 'chat',
  ]);
  assert.ok(usageFile.receipts.every((receipt) => receipt.status === 'completed'));

  const reloaded = await openStore(directory);
  const savedChat = await reloaded.getChat(chat.id);
  const savedCompactionTurn = savedChat.turns.find((turn) => turn.turnId === compact.turn.turnId);
  assert.equal(savedCompactionTurn?.status, 'completed');
  assert.ok(savedCompactionTurn?.activity.some((activity) => activity.kind === 'hook' && activity.event === 'after-compaction'));
  const afterRestart = await reloaded.acceptLocalMessage(chat.id, 'После перезапуска', 'turn-after-restart');
  const futureMessages = await reloaded.getMessagesThrough(chat.id, afterRestart.turn.messageId);
  const futureProtocols = await reloaded.getToolProtocolThrough(chat.id, afterRestart.turn.messageId);
  const futureContext = buildNextTurnContext({
    globalText: 'Контекст приложения.', selectedSkill: null, projectInstructions: [],
    messages: futureMessages, protocolHistory: futureProtocols, compactSnapshot: savedChat.compactSnapshot,
    permissionProfile: afterRestart.turn.permissionProfile, modelId: afterRestart.turn.modelId,
  });
  assert.deepEqual(futureContext.request.messages.map((message) => message.text), [
    'Третий запрос', 'Ответ:Третий запрос', 'После перезапуска',
  ]);
  assert.match(futureContext.request.system.find((layer) => layer.source === 'summary')?.text ?? '', /Сводка: первый, второй/);
  assert.equal(futureContext.request.protocolHistory?.length, 0);
  reloaded.releaseTurnReservation(afterRestart.turn.turnId);
});

test('queued fake provider turns see prior replies but never later accepted prompts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-queued-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'test-model' });
  const accepted = [
    await store.acceptLocalMessage(chat.id, 'user1', 'turn-queued-1'),
    await store.acceptLocalMessage(chat.id, 'user2', 'turn-queued-2'),
    await store.acceptLocalMessage(chat.id, 'user3', 'turn-queued-3'),
  ];
  const requests: ProviderTurnRequest[] = [];
  const provider: GigaChatProvider = {
    stream: async function* (request) {
      requests.push(structuredClone(request));
      const prompt = request.messages[request.messages.length - 1]?.text;
      yield { type: 'text-delta', text: `answer${prompt?.slice(-1) ?? ''}` };
      yield { type: 'completed' };
    },
  };
  const runtime = createTurnRuntime({
    provider,
    tools: {} as never,
    prepareTurn: async (turn): Promise<ProviderTurnRequest> => ({
      system: [],
      modelId: turn.modelId,
      permissionProfile: turn.permissionProfile,
      messages: await store.getMessagesThrough(turn.chatId, turn.messageId),
    }),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, _functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal);
    },
    recordUsageReceipt: (receipt) => store.recordUsageReceipt(receipt),
  });

  for (const item of accepted) assert.ok(runtime.enqueue(item.turn));
  await runtime.whenIdle();

  assert.deepEqual(requests.map((request) => request.messages.map((message) => message.text)), [
    ['user1'],
    ['user1', 'answer1', 'user2'],
    ['user1', 'answer1', 'user2', 'answer2', 'user3'],
  ]);
  assert.deepEqual((await store.getChat(chat.id)).messages.map((message) => message.text), [
    'user1', 'answer1', 'user2', 'answer2', 'user3', 'answer3',
  ]);
});

test('migrates v1 projects, chats, drafts, and theme without losing data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-store-v1-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = {
    id: 'project-1',
    name: 'Старый проект',
    pinned: true,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const chat = {
    id: 'chat-1',
    title: 'Старый чат',
    projectId: project.id,
    pinned: false,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    draft: 'Сохранённый черновик',
  };
  await writeFile(join(directory, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }));
  await writeFile(join(directory, 'chats.json'), JSON.stringify({ schemaVersion: 1, chats: [chat] }));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, settings: { theme: 'dark' } }));

  const store = await openStore(directory);
  assert.deepEqual(await store.listProjects(), [{ ...project, workingFolder: null }]);
  assert.equal((await store.listChats())[0]?.id, chat.id);
  assert.deepEqual(await store.getChat(chat.id), { ...chat, kind: 'text', nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [], draftAttachments: [], toolReceipts: [], turns: [], compactSnapshot: null });
  assert.deepEqual(await store.getSettings(), {
    theme: 'emerald',
    sidebarTransparent: false,
    sidebarVisible: true,
    sidebarWidthPx: null,
    browserPaneOpen: false,
    browserWidthPx: null,
    browserTabs: [],
    browserActiveTabId: null,
    defaultProjectsFolder: null,
    preferredOpener: 'system',
    defaultPermissionProfile: 'ask',
    defaultModelId: null,
    onboardingCompleted: true,
    microphoneConsent: 'unasked',
    notifications: { taskStarted: false, taskCompleted: true, failures: true },
  });
  assert.equal(JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8')).schemaVersion, 2);
  assert.equal(JSON.parse(await readFile(join(directory, 'chats.json'), 'utf8')).schemaVersion, 1);
  assert.equal(await readFile(join(directory, 'chats.json.bak'), 'utf8'), await readFile(join(directory, 'chats.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')).schemaVersion, 13);
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).schemaVersion, 10);
  await store.deleteChat(chat.id);
  assert.deepEqual(await (await openStore(directory)).listChats(), []);
});

test('migrates v2 chats with archive and draft without changing their UUIDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-store-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const chat = { id: '6f2b3e8a-562d-4b34-8228-b028ef758b80', title: 'Архив', projectId: null,
    pinned: true, archived: true, createdAt: timestamp, updatedAt: timestamp, draft: 'Текст', kind: 'image' };
  await writeFile(join(directory, 'chats.json'), JSON.stringify({ schemaVersion: 2, chats: [chat] }));
  const store = await openStore(directory);
  assert.deepEqual(await store.getChat(chat.id), { ...chat, nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [], draftAttachments: [], toolReceipts: [], turns: [], compactSnapshot: null });
  assert.equal((await store.listChats())[0]?.id, chat.id);
  assert.equal((await (await openStore(directory)).getChat(chat.id)).draft, 'Текст');
});

test('unfinished legacy migration preserves existing invalid chat details', async (t) => {
  const cases = [
    { kind: 'corrupt', migrated: false },
    { kind: 'unknown-version', migrated: false },
    { kind: 'id-mismatch', migrated: false },
    { kind: 'valid', migrated: false },
    { kind: 'missing', migrated: false },
    { kind: 'corrupt', migrated: true },
  ];
  for (const { kind, migrated } of cases) {
    await t.test(`${kind}, marker ${migrated ? 'present' : 'absent'}`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'gigachat-unfinished-migration-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const legacy = { id: 'chat-1', title: 'Legacy chat', projectId: null, pinned: false, archived: false,
        createdAt: timestamp, updatedAt: timestamp, draft: 'legacy draft', kind: 'text' };
      const detail = { schemaVersion: 7, ...legacy, draft: 'newer draft', nextTurnPermissionProfile: null,
        nextTurnSkillId: null, modelId: null,
        messages: [{ id: 'message-1', role: 'user', text: 'newer history', createdAt: timestamp }], artifacts: [], toolReceipts: [] };
      const legacyContents = JSON.stringify({ schemaVersion: 2, chats: [legacy] });
      const detailPath = join(directory, 'chats', legacy.id, 'chat.json');
      await mkdir(dirname(detailPath), { recursive: true });
      await writeFile(join(directory, 'chats.json'), legacyContents);
      if (migrated) await writeFile(join(directory, 'chats.migrated'), '3\n');
      const contents = kind === 'missing' ? null
        : kind === 'corrupt' ? JSON.stringify(detail).slice(0, -1)
          : JSON.stringify({ ...detail, ...(kind === 'unknown-version' ? { schemaVersion: 99 }
            : kind === 'id-mismatch' ? { id: 'another-chat' } : {}) });
      if (contents !== null) await writeFile(detailPath, contents);

      const store = await openStore(directory);
      const validUnmarkedLegacyDetail = kind === 'valid' && !migrated;
      if (contents !== null && !validUnmarkedLegacyDetail) {
        assert.equal(await readFile(detailPath, 'utf8'), contents, 'existing invalid bytes must survive migration');
      }
      if (kind === 'valid' || kind === 'missing') {
        const restored = await store.getChat(legacy.id);
        assert.equal(restored.draft, kind === 'valid' ? 'newer draft' : 'legacy draft');
        assert.deepEqual(restored.messages, kind === 'valid' ? detail.messages : []);
        if (validUnmarkedLegacyDetail) {
          const migratedDetail = JSON.parse(await readFile(detailPath, 'utf8')) as Record<string, unknown>;
          assert.equal(migratedDetail.schemaVersion, 13);
          assert.equal(migratedDetail.compactSnapshot, null);
          assert.equal(migratedDetail.draft, 'newer draft');
        }
        assert.deepEqual(await store.getStorageIssues(), []);
      } else {
        assert.deepEqual(await store.listChats(), []);
        assert.match((await store.getStorageIssues()).join('\n'), /chat-1.*повреждён/);
        const reopened = await openStore(directory);
        assert.equal(await readFile(detailPath, 'utf8'), contents);
        assert.deepEqual(await reopened.listChats(), []);
      }
      assert.equal(await readFile(join(directory, 'chats.json'), 'utf8'), legacyContents);
      if (!migrated) assert.equal(await readFile(join(directory, 'chats.json.bak'), 'utf8'), legacyContents);
    });
  }
});

test('saves a local message and clears its draft in one chat file, then reopens history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-message-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Привет' });
  const detail = await store.appendLocalMessage(chat.id, 'Привет');
  assert.equal(detail.messages[0]?.role, 'user');
  assert.equal(detail.draft, '');
  const onDisk = JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8'));
  assert.equal(onDisk.draft, '');
  assert.equal(onDisk.messages[0].text, 'Привет');
  assert.deepEqual(await (await openStore(directory)).getChat(chat.id), detail);
});

test('accepts an immutable turn snapshot with the local message and its project binding', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-turn-acceptance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Проект хода');
  const workingFolder = join(directory, 'working');
  await mkdir(workingFolder);
  await store.updateProject(project.id, { workingFolder });
  const chat = await store.createChat(project.id);
  await store.appendLocalMessage(chat.id, 'Первая реплика');
  await store.updateSettings({ defaultPermissionProfile: 'approve', defaultModelId: 'next/model-v5' });
  await store.updateChat(chat.id, {
    modelId: 'vendor/model.v4:preview',
    nextTurnPermissionProfile: 'full',
    nextTurnSkillId: `project/${project.id}/review`,
  });

  const accepted = await store.acceptLocalMessage(chat.id, 'Ответьте на первую реплику', 'turn-b1');
  await store.appendLocalMessage(chat.id, 'Это уже следующий ход');
  await store.updateChat(chat.id, { modelId: 'legacy/model-v1', nextTurnPermissionProfile: 'ask', nextTurnSkillId: null });

  assert.equal(accepted.detail.messages[accepted.detail.messages.length - 1]?.text, 'Ответьте на первую реплику');
  assert.equal(accepted.detail.draft, '');
  assert.equal(accepted.turn.turnId, 'turn-b1');
  assert.equal(accepted.turn.chatId, chat.id);
  assert.equal(accepted.turn.projectId, project.id);
  assert.equal(accepted.turn.projectWorkingFolder, workingFolder);
  assert.equal(accepted.turn.messageId, accepted.detail.messages[accepted.detail.messages.length - 1]?.id);
  assert.equal(accepted.turn.historyBoundary, 2);
  assert.deepEqual(accepted.turn.messages.map(({ text }) => text), ['Первая реплика', 'Ответьте на первую реплику']);
  assert.equal(accepted.turn.modelId, 'vendor/model.v4:preview');
  assert.equal(accepted.turn.permissionProfile, 'full');
  assert.equal(accepted.turn.skillId, `project/${project.id}/review`);
});

test('reserves one-shot profile and Skill independently and preserves a same-value reselection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-turn-reservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/review' });

  const first = await store.acceptLocalMessage(chat.id, 'B1', 'turn-b1');
  await store.updateChat(chat.id, { nextTurnPermissionProfile: 'approve' });
  const second = await store.acceptLocalMessage(chat.id, 'B2', 'turn-b2');
  assert.equal(first.turn.permissionProfile, 'full');
  assert.equal(first.turn.skillId, 'global/review');
  assert.equal(second.turn.permissionProfile, 'approve');
  assert.equal(second.turn.skillId, null);

  await store.consumeTurnReservation(first.turn);
  let current = await store.getChat(chat.id);
  assert.equal(current.nextTurnPermissionProfile, 'approve');
  assert.equal(current.nextTurnSkillId, null);

  await store.updateChat(chat.id, { nextTurnPermissionProfile: 'approve' });
  await store.consumeTurnReservation(second.turn);
  current = await store.getChat(chat.id);
  assert.equal(current.nextTurnPermissionProfile, 'approve');
});

test('retry transfers only the original unconsumed one-shot reservation before the next message', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-retry-reservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/review' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Оригинальный ход', 'turn-original');

  store.releaseTurnReservation(accepted.turn.turnId);
  const retry = { ...structuredClone(accepted.turn), turnId: 'turn-retry' };
  assert.deepEqual(retry.messages, accepted.turn.messages, 'retry keeps the original accepted prompt/history snapshot');
  await store.reserveRetryTurn(accepted.turn, retry);
  await store.consumeTurnReservation(retry);

  const afterRetry = await store.getChat(chat.id);
  assert.equal(afterRetry.messages.length, 1, 'retry does not append a duplicate user message');
  assert.equal(afterRetry.nextTurnPermissionProfile, null);
  assert.equal(afterRetry.nextTurnSkillId, null);
  const next = await store.acceptLocalMessage(chat.id, 'Следующее новое сообщение', 'turn-next');
  assert.equal(next.turn.reservation.permissionProfileRevision, null);
  assert.equal(next.turn.reservation.skillRevision, null);
});

test('retry does not consume changed one-shot overrides or steal a competing accepted reservation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-retry-reservation-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/review' });
  const original = await store.acceptLocalMessage(chat.id, 'Первый исходный ход', 'turn-original');
  store.releaseTurnReservation(original.turn.turnId);
  await store.updateChat(chat.id, { nextTurnPermissionProfile: 'approve', nextTurnSkillId: 'global/review-next' });
  const retryAfterChange = { ...structuredClone(original.turn), turnId: 'turn-retry-after-change' };
  await store.reserveRetryTurn(original.turn, retryAfterChange);
  await store.consumeTurnReservation(retryAfterChange);
  let current = await store.getChat(chat.id);
  assert.equal(current.nextTurnPermissionProfile, 'approve');
  assert.equal(current.nextTurnSkillId, 'global/review-next');

  const competingChat = await store.createChat();
  await store.updateChat(competingChat.id, { nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/review' });
  const first = await store.acceptLocalMessage(competingChat.id, 'Исходный ход с reservation', 'turn-competing-original');
  store.releaseTurnReservation(first.turn.turnId);
  const competitor = await store.acceptLocalMessage(competingChat.id, 'Другой принятый ход', 'turn-reservation-owner');
  const retry = { ...structuredClone(first.turn), turnId: 'turn-competing-retry' };
  await store.reserveRetryTurn(first.turn, retry);
  await store.consumeTurnReservation(retry);
  current = await store.getChat(competingChat.id);
  assert.equal(current.nextTurnPermissionProfile, 'full');
  assert.equal(current.nextTurnSkillId, 'global/review');
  await store.consumeTurnReservation(competitor.turn);
  current = await store.getChat(competingChat.id);
  assert.equal(current.nextTurnPermissionProfile, null);
  assert.equal(current.nextTurnSkillId, null);
});

test('rejects reservation consumption when the accepted project folder or chat binding changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-accepted-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldFolder = join(directory, 'project-old');
  const newFolder = join(directory, 'project-new');
  await mkdir(oldFolder);
  await mkdir(newFolder);
  const store = await openStore(join(directory, 'profile'));
  const project = await store.createProject('Связанный проект', oldFolder);
  const chat = await store.createChat(project.id);
  await store.updateChat(chat.id, { nextTurnSkillId: 'global/review' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Принятый запрос', 'turn-binding');

  await store.updateProject(project.id, { workingFolder: newFolder });
  await assert.rejects(store.validateAcceptedTurn(accepted.turn), /рабочая папка проекта изменилась/i);
  await assert.rejects(store.consumeTurnReservation(accepted.turn), /рабочая папка проекта изменилась/i);
  assert.equal((await store.getChat(chat.id)).nextTurnSkillId, 'global/review');

  await store.updateChat(chat.id, { projectId: null });
  await assert.rejects(store.validateAcceptedTurn(accepted.turn), /чат перемещён/i);
});

test('does not consume a reservation aborted while queued behind an instruction commit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-accepted-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workingFolder = join(directory, 'workspace');
  await mkdir(workingFolder);
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let announceCommit!: () => void;
  const commitStarted = new Promise<void>((resolve) => { announceCommit = resolve; });
  const store = await openStore(join(directory, 'profile'), {
    instructionCommitter: async (request) => {
      if (request.contents === 'hold store queue') {
        announceCommit();
        await commitGate;
      }
      return syntheticInstructionCommitter(request);
    },
  });
  const project = await store.createProject('Очередь записи', workingFolder);
  const chat = await store.createChat(project.id);
  await store.updateChat(chat.id, {
    nextTurnPermissionProfile: 'full',
    nextTurnSkillId: 'global/review',
  });
  const accepted = await store.acceptLocalMessage(chat.id, 'Принятый запрос', 'turn-abort-queued');
  const document = await store.readProjectInstructionDocument(project.id);
  const writing = store.saveProjectInstructions(project.id, 'hold store queue', document.revision);
  await commitStarted;

  const controller = new AbortController();
  const consuming = store.consumeTurnReservation(accepted.turn, controller.signal);
  controller.abort();
  releaseCommit();
  await writing;
  await assert.rejects(consuming, /отменена/i);

  const current = await store.getChat(chat.id);
  assert.equal(current.nextTurnPermissionProfile, 'full');
  assert.equal(current.nextTurnSkillId, 'global/review');
});

test('trusted runtime assistant append preserves draft and final provider state across reload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Запрос пользователя', 'turn-runtime-assistant');
  assert.ok(accepted.turn.assistantMessageId, 'acceptance reserves the assistant message ID before runtime starts');
  const queued = await store.getChat(chat.id);
  assert.equal(queued.turns[0]?.turnId, accepted.turn.turnId);
  assert.equal(queued.turns[0]?.anchorMessageId, accepted.turn.messageId);
  assert.equal(queued.turns[0]?.assistantMessageId, accepted.turn.assistantMessageId);
  assert.equal(queued.turns[0]?.status, 'queued');
  await store.updateChat(chat.id, { draft: 'Черновик остаётся' });
  const completed = {
    id: accepted.turn.turnId, chatId: chat.id, anchorMessageId: accepted.turn.messageId,
    assistantMessageId: accepted.turn.assistantMessageId!, modelId: accepted.turn.modelId,
    status: 'completed' as const, createdAt: queued.turns[0]!.createdAt,
    startedAt: timestamp, endedAt: timestamp, activeDurationMs: 1250, activity: [],
  };
  const detail = await store.appendAssistantMessageFromRuntime(accepted.turn, 'Ответ провайдера', completed, undefined, 'state-final');
  assert.equal(detail.messages[1]?.role, 'assistant');
  assert.equal(detail.messages[1]?.id, accepted.turn.assistantMessageId);
  assert.equal(detail.messages[1]?.source, 'runtime');
  assert.equal(detail.messages[1]?.text, 'Ответ провайдера');
  assert.equal(detail.messages[1]?.functionsStateId, 'state-final');
  assert.equal(detail.turns[0]?.status, 'completed');
  assert.equal(detail.turns[0]?.activeDurationMs, 1250);
  assert.equal(detail.draft, 'Черновик остаётся');
  const repeatedAck = await store.appendAssistantMessageFromRuntime(accepted.turn, 'Ответ провайдера', completed, undefined, 'state-final');
  assert.deepEqual(repeatedAck.messages, detail.messages, 'the same durable ACK does not create a second assistant message');
  await assert.rejects(
    store.appendAssistantMessageFromRuntime(accepted.turn, 'Другой ответ', completed),
    /уже сохранён с другими данными/,
  );
  const restored = await (await openStore(directory)).getChat(chat.id);
  assert.deepEqual(restored.messages, detail.messages);
  assert.deepEqual(restored.turns, detail.turns);
});

test('schema 11 provider states migrate as unowned without changing public history or compact hashes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-state-schema11-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopeA = 'a'.repeat(64);
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Legacy state fixture.', 'legacy-state-turn');
  await appendAcceptedAnswer(store, accepted.turn, 'Legacy answer.', 'legacy-message-state', scopeA);
  const receipt = {
    receiptId: 'b'.repeat(64), name: 'read', arguments: { path: 'notes.txt' },
    content: 'LEGACY_READ_RESULT', functionsStateId: 'legacy-receipt-state',
  };
  await store.beginToolReceipt(chat.id, accepted.turn.messageId, receipt, scopeA);
  const prefix = await store.getCompactionPrefix(chat.id, accepted.turn.messageId);
  const snapshot: CompactSnapshot = {
    id: 'legacy-state-compact', version: 1, boundaryMessageId: accepted.turn.messageId,
    coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
    text: 'Legacy compact summary.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, snapshot, null, undefined, undefined,
    { accountScope: scopeA, functionsStateId: 'legacy-compact-state' });
  const before = await store.getChat(chat.id);
  const filePath = join(directory, 'chats', chat.id, 'chat.json');
  const schema11 = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  schema11.schemaVersion = 11;
  delete schema11.providerStateOwnership;
  await writeFile(filePath, JSON.stringify(schema11), 'utf8');

  const restored = await openStore(directory);
  const detail = await restored.getChat(chat.id);
  assert.deepEqual(detail.messages, before.messages);
  assert.deepEqual(detail.toolReceipts, before.toolReceipts);
  assert.deepEqual(detail.compactSnapshot, snapshot);
  assert.equal(detail.compactSnapshot?.coveredPrefixHash, before.compactSnapshot?.coveredPrefixHash);
  assert.deepEqual(await restored.getProviderStateOwnership(chat.id, scopeA), {
    messages: [{ messageId: accepted.turn.assistantMessageId, owned: false }],
    receipts: [{ receiptId: receipt.receiptId, anchorMessageId: accepted.turn.messageId, owned: false, wireOwned: false }],
    compact: { snapshotId: snapshot.id, owned: false, functionsStateId: null },
  });
  const migrated = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  assert.equal(migrated.schemaVersion, 13);
  assert.deepEqual(migrated.providerStateOwnership, {
    schemaVersion: 2, messages: [], receipts: [], compact: null,
  });
  const bytesBeforeLegacyRetry = await readFile(filePath);
  await assert.rejects(restored.commitCompactSnapshot(chat.id, snapshot, snapshot.id, undefined, undefined,
    { accountScope: scopeA, functionsStateId: 'legacy-compact-state' }), /владел/i);
  assert.deepEqual(await readFile(filePath), bytesBeforeLegacyRetry, 'an idempotent legacy snapshot retry cannot claim state');
  await assert.rejects(appendAcceptedAnswer(restored, accepted.turn, 'Legacy answer.', 'legacy-message-state', scopeA), /владельц/i);
  assert.deepEqual(await readFile(filePath), bytesBeforeLegacyRetry, 'an idempotent answer retry cannot claim legacy state');
  await assert.rejects(restored.beginToolReceipt(chat.id, accepted.turn.messageId, receipt, scopeA), /владельц/i);
  assert.deepEqual(await readFile(filePath), bytesBeforeLegacyRetry, 'an idempotent receipt retry cannot claim legacy state');
  assert.deepEqual(await restored.getProviderStateOwnership(chat.id, scopeA), {
    messages: [{ messageId: accepted.turn.assistantMessageId, owned: false }],
    receipts: [{ receiptId: receipt.receiptId, anchorMessageId: accepted.turn.messageId, owned: false, wireOwned: false }],
    compact: { snapshotId: snapshot.id, owned: false, functionsStateId: null },
  });
  const publicJson = JSON.stringify(detail);
  assert.equal(publicJson.includes('providerStateOwnership'), false);
  assert.equal(publicJson.includes(scopeA), false);
  assert.equal(publicJson.includes('legacy-compact-state'), false);
});

test('schema 12 accepts only private schema 1 and migrates it as legacy V1 state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-state-schema12-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const scopeA = 'a'.repeat(64);
  const assistantState = 'legacy-assistant-state-schema12';
  const receiptState = 'legacy-receipt-state-schema12';
  const compactState = 'legacy-compact-state-schema12';
  const accepted = await store.acceptLocalMessage(chat.id, 'Nonempty legacy state fixture.', 'schema12-v1-state');
  await appendAcceptedAnswer(store, accepted.turn, 'Legacy assistant answer.', assistantState, scopeA);
  const receipt = {
    receiptId: 'e'.repeat(64), name: 'read', arguments: { path: 'legacy.txt' }, content: null,
    functionsStateId: receiptState,
  };
  assert.equal((await store.beginToolReceipt(chat.id, accepted.turn.messageId, receipt, scopeA)).shouldExecute, true);
  await store.completeToolReceipt(chat.id, accepted.turn.messageId, receipt.receiptId, 'completed',
    JSON.stringify({ ok: true, result: { contents: 'legacy result' } }));
  const prefix = await store.getCompactionPrefix(chat.id, accepted.turn.messageId);
  const snapshot: CompactSnapshot = {
    id: 'schema12-v1-compact', version: 1, boundaryMessageId: accepted.turn.messageId,
    coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
    text: 'Legacy compact summary.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, snapshot, null, undefined, undefined,
    { accountScope: scopeA, functionsStateId: compactState });
  const before = await store.getChat(chat.id);
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  current.schemaVersion = 12;
  const hashState = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
  current.providerStateOwnership = {
    schemaVersion: 1,
    messages: [{ messageId: accepted.turn.assistantMessageId, accountScope: scopeA, stateIdHash: hashState(assistantState) }],
    receipts: [{ receiptId: receipt.receiptId, anchorMessageId: accepted.turn.messageId, accountScope: scopeA, stateIdHash: hashState(receiptState) }],
    compact: { snapshotId: snapshot.id, functionsStateId: compactState, accountScope: scopeA, stateIdHash: hashState(compactState) },
  };
  await writeFile(path, JSON.stringify(current), 'utf8');

  const migratedStore = await openStore(directory);
  const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(migrated.schemaVersion, 13);
  const migratedOwnership = migrated.providerStateOwnership as {
    schemaVersion: number; messages: Array<Record<string, unknown>>; receipts: Array<Record<string, unknown>>;
    compact: Record<string, unknown> | null;
  };
  assert.equal(migratedOwnership.schemaVersion, 2);
  assert.equal(migratedOwnership.messages[0]?.protocolVersion, 'v1');
  assert.equal(migratedOwnership.receipts[0]?.protocolVersion, 'v1');
  assert.equal(migratedOwnership.compact?.protocolVersion, 'v1');
  assert.equal(Object.prototype.hasOwnProperty.call(migratedOwnership.receipts[0]!, 'wire'), false);
  const migratedDetail = await migratedStore.getChat(chat.id);
  assert.deepEqual(migratedDetail.messages, before.messages);
  assert.deepEqual(migratedDetail.toolReceipts, before.toolReceipts);
  assert.deepEqual(migratedDetail.compactSnapshot, snapshot);
  assert.deepEqual(await migratedStore.getProviderStateOwnership(chat.id, scopeA), {
    messages: [{ messageId: accepted.turn.assistantMessageId, owned: false }],
    receipts: [{ receiptId: receipt.receiptId, anchorMessageId: accepted.turn.messageId, owned: false, wireOwned: false }],
    compact: { snapshotId: snapshot.id, owned: false, functionsStateId: null },
  });

  const mismatched = { ...migrated, schemaVersion: 12 };
  const mismatchedBytes = JSON.stringify(mismatched);
  await writeFile(path, mismatchedBytes, 'utf8');
  const rejectedStore = await openStore(directory);
  assert.ok((await rejectedStore.getStorageIssues()).some((issue) => issue.includes('файл истории повреждён')),
    'schema 12 must never accept private schema 2 as an upgrade signal');
  assert.equal(await readFile(path, 'utf8'), mismatchedBytes, 'rejected versions remain byte-for-byte untouched');
});

test('tool receipt writes project only public receipt fields from structurally wider callers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-public-tool-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Private field projection.', 'private-field-projection');
  const input = {
    receiptId: 'a'.repeat(64), name: 'read', arguments: { path: 'fixture.txt' }, content: null,
    functionsStateId: null,
    wire: { content: [{ function_call: { name: 'read', arguments: { path: 'fixture.txt' } } }] },
    wireHash: 'private-wire-hash-sentinel', accountScope: 'private-account-scope-sentinel', protocolVersion: 'v2',
  };
  const begun = await store.beginToolReceipt(chat.id, accepted.turn.messageId, input);
  const detail = await store.getChat(chat.id);
  const publicReceipt = detail.toolReceipts[0]!;
  assert.equal(begun.shouldExecute, true);
  assert.deepEqual(Object.keys(publicReceipt).sort(), [
    'anchorMessageId', 'arguments', 'content', 'createdAt', 'functionsStateId', 'name', 'receiptId', 'result', 'status',
  ]);
  assert.equal(JSON.stringify(detail).includes('private-wire-hash-sentinel'), false);
  assert.equal(JSON.stringify(detail).includes('private-account-scope-sentinel'), false);
  assert.equal(JSON.stringify(detail).includes('"wire"'), false);
  const stored = JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(JSON.stringify(stored.toolReceipts).includes('private-wire-hash-sentinel'), false);
  assert.deepEqual(stored.providerStateOwnership, { schemaVersion: 2, messages: [], receipts: [], compact: null });
});

test('captured assistant state is private, account-bound, idempotent, and saved only after atomic write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-state-message-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopeA = 'a'.repeat(64);
  const scopeB = 'b'.repeat(64);
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Capture state A.', 'turn-state-a');
  await appendAcceptedAnswer(store, accepted.turn, 'The answer.', 'opaque-state-A', scopeA);
  const detail = await store.getChat(chat.id);
  assert.equal(detail.messages[1]?.functionsStateId, 'opaque-state-A');
  assert.equal(Object.prototype.hasOwnProperty.call(detail, 'providerStateOwnership'), false);
  assert.equal(JSON.stringify(detail).includes(scopeA), false);
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeA), {
    messages: [{ messageId: accepted.turn.assistantMessageId, owned: true }], receipts: [], compact: null,
  });
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeB), {
    messages: [{ messageId: accepted.turn.assistantMessageId, owned: false }], receipts: [], compact: null,
  });

  const mutableView = await store.getProviderStateOwnership(chat.id, scopeA);
  mutableView.messages[0]!.owned = false;
  assert.equal((await store.getProviderStateOwnership(chat.id, scopeA)).messages[0]?.owned, true,
    'a returned view cannot mutate the authoritative owner map');
  await appendAcceptedAnswer(store, accepted.turn, 'The answer.', 'opaque-state-A', scopeA);
  await assert.rejects(appendAcceptedAnswer(store, accepted.turn, 'The answer.', 'opaque-state-A', scopeB), /владельц/i);
  assert.equal((await store.getProviderStateOwnership(chat.id, scopeA)).messages[0]?.owned, true);

  const statelessChat = await store.createChat();
  const statelessTurn = await store.acceptLocalMessage(statelessChat.id, 'No provider state.', 'turn-state-empty');
  const statelessBefore = await store.getChat(statelessChat.id);
  await assert.rejects(appendAcceptedAnswer(store, statelessTurn.turn, 'Stateless answer.', undefined, scopeA), /пустому состоянию/i);
  assert.deepEqual(await store.getChat(statelessChat.id), statelessBefore,
    'an owner cannot be attached when the assistant answer contains no provider state');
  assert.deepEqual(await store.getProviderStateOwnership(statelessChat.id, scopeA), { messages: [], receipts: [], compact: null });

  const other = await store.createChat();
  const otherTurn = await store.acceptLocalMessage(other.id, 'A second chat.', 'turn-state-other');
  const otherPath = join(directory, 'chats', other.id, 'chat.json');
  const beforeBytes = await readFile(otherPath);
  const beforeDetail = await store.getChat(other.id);
  const blockedPath = `${otherPath}.held`;
  await rename(otherPath, blockedPath);
  await mkdir(otherPath);
  try {
    await assert.rejects(appendAcceptedAnswer(store, otherTurn.turn, 'Must not commit.', 'opaque-state-failed', scopeA));
    assert.deepEqual(await store.getChat(other.id), beforeDetail, 'failed terminal save leaves public memory unchanged');
    assert.deepEqual(await store.getProviderStateOwnership(other.id, scopeA), { messages: [], receipts: [], compact: null });
    assert.deepEqual(await readFile(blockedPath), beforeBytes, 'failed terminal save leaves the prior chat bytes intact');
  } finally {
    await rm(otherPath, { recursive: true, force: true });
    await rename(blockedPath, otherPath);
  }
  assert.deepEqual(await readFile(otherPath), beforeBytes);
  const reopened = await openStore(directory);
  assert.equal((await reopened.getProviderStateOwnership(chat.id, scopeA)).messages[0]?.owned, true);
  assert.deepEqual(await reopened.getProviderStateOwnership(other.id, scopeA), { messages: [], receipts: [], compact: null });
  await reopened.deleteChat(chat.id);
  assert.deepEqual(await (await openStore(directory)).getProviderStateOwnership(other.id, scopeA), { messages: [], receipts: [], compact: null },
    'deleting one chat does not affect another chat owner');
});

test('legacy V1 tool receipt state remains unowned for V2 across receipt and anchor reuse', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-state-receipts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopeA = 'a'.repeat(64);
  const scopeB = 'b'.repeat(64);
  const store = await openStore(directory);
  const chat = await store.createChat();
  const first = await store.acceptLocalMessage(chat.id, 'First tool request.', 'turn-receipt-one');
  const second = await store.acceptLocalMessage(chat.id, 'Second tool request.', 'turn-receipt-two');
  const input = {
    receiptId: 'c'.repeat(64), name: 'read', arguments: { path: 'same.txt' },
    content: 'SAME_STATE_RESULT', functionsStateId: 'shared-receipt-state',
  };
  assert.equal((await store.beginToolReceipt(chat.id, first.turn.messageId, input, scopeA)).shouldExecute, true);
  const result = JSON.stringify({ ok: true, result: { bytes: 12 } });
  await store.completeToolReceipt(chat.id, first.turn.messageId, input.receiptId, 'completed', result);
  assert.equal((await store.beginToolReceipt(chat.id, second.turn.messageId, input, scopeB)).shouldExecute, false);
  assert.equal((await store.beginToolReceipt(chat.id, second.turn.messageId, input, scopeB)).shouldExecute, false,
    'same-resource retries preserve the same binding');
  const firstA = await store.getProviderStateOwnership(chat.id, scopeA);
  const firstB = await store.getProviderStateOwnership(chat.id, scopeB);
  assert.deepEqual(firstA.receipts, [
    { receiptId: input.receiptId, anchorMessageId: first.turn.messageId, owned: false, wireOwned: false },
    { receiptId: input.receiptId, anchorMessageId: second.turn.messageId, owned: false, wireOwned: false },
  ]);
  assert.deepEqual(firstB.receipts, [
    { receiptId: input.receiptId, anchorMessageId: first.turn.messageId, owned: false, wireOwned: false },
    { receiptId: input.receiptId, anchorMessageId: second.turn.messageId, owned: false, wireOwned: false },
  ]);
  const filePath = join(directory, 'chats', chat.id, 'chat.json');
  const before = await readFile(filePath);
  await assert.rejects(store.beginToolReceipt(chat.id, second.turn.messageId, input, scopeA), /владельц/i);
  assert.deepEqual(await readFile(filePath), before, 'a different owner cannot overwrite an existing receipt binding');
  const reopened = await openStore(directory);
  assert.deepEqual((await reopened.getProviderStateOwnership(chat.id, scopeA)).receipts, firstA.receipts);
  assert.deepEqual((await reopened.getProviderStateOwnership(chat.id, scopeB)).receipts, firstB.receipts);
});

test('compact state commits with its snapshot and a replacement without state clears the old pointer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-state-compact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopeA = 'a'.repeat(64);
  const scopeB = 'b'.repeat(64);
  let failCompactSave = false;
  const store = await openStore(directory, { testFaults: {
    beforeCompactSnapshotCommit: () => { if (failCompactSave) throw new Error('synthetic compact owner save failure'); },
  } });
  const chat = await store.createChat();
  const first = await store.acceptLocalMessage(chat.id, 'First compacted message.', 'turn-compact-owner-one');
  const firstPrefix = await store.getCompactionPrefix(chat.id, first.turn.messageId);
  const firstSnapshot: CompactSnapshot = {
    id: 'compact-owner-first', version: 1, boundaryMessageId: first.turn.messageId,
    coveredThroughMessageId: firstPrefix.coveredThroughMessageId, coveredPrefixHash: firstPrefix.coveredPrefixHash,
    text: 'First compact summary.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, firstSnapshot, null, undefined, undefined,
    { accountScope: scopeA, functionsStateId: 'compact-state-A' });
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeA), {
    messages: [], receipts: [], compact: { snapshotId: firstSnapshot.id, owned: true, functionsStateId: 'compact-state-A' },
  });
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeB), {
    messages: [], receipts: [], compact: { snapshotId: firstSnapshot.id, owned: false, functionsStateId: null },
  });
  const publicDetail = await store.getChat(chat.id);
  assert.equal(Object.prototype.hasOwnProperty.call(publicDetail.compactSnapshot!, 'functionsStateId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicDetail, 'providerStateOwnership'), false);
  const onDiskAfterFirst = JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(onDiskAfterFirst.compactSnapshot as object, 'functionsStateId'), false);
  assert.equal((onDiskAfterFirst.providerStateOwnership as { compact: { functionsStateId: string } }).compact.functionsStateId, 'compact-state-A');
  assert.equal((await (await openStore(directory)).getProviderStateOwnership(chat.id, scopeA)).compact?.functionsStateId, 'compact-state-A',
    'compact ownership survives a close and reopen');

  await store.commitCompactSnapshot(chat.id, firstSnapshot, firstSnapshot.id, undefined, undefined,
    { accountScope: scopeA, functionsStateId: 'compact-state-A' });
  await store.commitCompactSnapshot(chat.id, firstSnapshot, firstSnapshot.id);
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeA), {
    messages: [], receipts: [], compact: { snapshotId: firstSnapshot.id, owned: true, functionsStateId: 'compact-state-A' },
  }, 'same-ID retries with or without the optional owner preserve the original binding');
  const filePath = join(directory, 'chats', chat.id, 'chat.json');
  const bytesBeforeSameIdRejects = await readFile(filePath);
  await assert.rejects(store.commitCompactSnapshot(chat.id, firstSnapshot, firstSnapshot.id, undefined, undefined,
    { accountScope: scopeB, functionsStateId: 'compact-state-B' }), /владел/i);
  assert.deepEqual(await readFile(filePath), bytesBeforeSameIdRejects, 'a same-ID retry cannot rebind compact state');
  await assert.rejects(store.commitCompactSnapshot(chat.id, { ...firstSnapshot, text: 'Conflicting same-ID summary.' }, firstSnapshot.id), /другими данными/);
  assert.deepEqual(await readFile(filePath), bytesBeforeSameIdRejects, 'a same-ID retry cannot replace public snapshot data');

  const second = await store.acceptLocalMessage(chat.id, 'Second compacted message.', 'turn-compact-owner-two');
  const secondPrefix = await store.getCompactionPrefix(chat.id, second.turn.messageId);
  const secondSnapshot: CompactSnapshot = {
    id: 'compact-owner-second', version: 1, boundaryMessageId: second.turn.messageId,
    coveredThroughMessageId: secondPrefix.coveredThroughMessageId, coveredPrefixHash: secondPrefix.coveredPrefixHash,
    text: 'Second compact summary.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  const bytesBeforeFailure = await readFile(filePath);
  const detailBeforeFailure = await store.getChat(chat.id);
  failCompactSave = true;
  await assert.rejects(store.commitCompactSnapshot(chat.id, secondSnapshot, firstSnapshot.id, undefined, undefined,
    { accountScope: scopeB, functionsStateId: 'compact-state-B' }), /synthetic compact owner save failure/);
  failCompactSave = false;
  assert.deepEqual(await readFile(filePath), bytesBeforeFailure);
  assert.deepEqual(await store.getChat(chat.id), detailBeforeFailure);
  assert.equal((await store.getProviderStateOwnership(chat.id, scopeA)).compact?.functionsStateId, 'compact-state-A');
  const wrongPrefix = { ...secondSnapshot, coveredPrefixHash: '0'.repeat(64) };
  await assert.rejects(store.commitCompactSnapshot(chat.id, wrongPrefix, firstSnapshot.id), /История изменилась/);
  assert.deepEqual(await readFile(filePath), bytesBeforeFailure, 'prefix conflict leaves public and private state bytes intact');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.commitCompactSnapshot(chat.id, secondSnapshot, firstSnapshot.id, controller.signal, undefined,
    { accountScope: scopeB, functionsStateId: 'compact-state-B' }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.deepEqual(await readFile(filePath), bytesBeforeFailure, 'abort leaves both public and private state bytes intact');
  assert.equal((await store.getProviderStateOwnership(chat.id, scopeA)).compact?.functionsStateId, 'compact-state-A');

  await store.commitCompactSnapshot(chat.id, secondSnapshot, firstSnapshot.id);
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeA), {
    messages: [], receipts: [], compact: { snapshotId: secondSnapshot.id, owned: false, functionsStateId: null },
  });
  assert.deepEqual(await store.getProviderStateOwnership(chat.id, scopeB), {
    messages: [], receipts: [], compact: { snapshotId: secondSnapshot.id, owned: false, functionsStateId: null },
  });
  const reopened = await openStore(directory);
  assert.deepEqual(await reopened.getProviderStateOwnership(chat.id, scopeA), {
    messages: [], receipts: [], compact: { snapshotId: secondSnapshot.id, owned: false, functionsStateId: null },
  });
  const finalDetail = await reopened.getChat(chat.id);
  assert.deepEqual(finalDetail.messages, detailBeforeFailure.messages);
  assert.deepEqual(finalDetail.toolReceipts, detailBeforeFailure.toolReceipts);
  assert.deepEqual(finalDetail.compactSnapshot, secondSnapshot);
});

test('V2 wire is part of the compact prefix hash and a coherent wire rewrite is rejected after reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-v2-wire-compact-hash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Сохрани V2 вызов в покрытом префиксе.', 'turn-v2-wire-compact');
  const accountScope = '9'.repeat(64);
  const stateId = 'e4e2d3c4-5566-7a88-8b99-aabbccddeeff';
  const wire = {
    content: [{ function_call: { id: 'e4e2d3c4-5566-4a88-8b99-aabbccddeeff', name: 'read', arguments: { path: 'covered.txt' } } }],
    messageId: 'assistant-covered-call', toolStateId: stateId,
  };
  const receipt = {
    receiptId: 'f'.repeat(64), name: 'read', arguments: { path: 'covered.txt' }, content: null,
    functionsStateId: stateId,
  };
  assert.equal((await store.beginToolReceipt(chat.id, accepted.turn.messageId, receipt, accountScope, wire)).shouldExecute, true);
  await store.completeToolReceipt(chat.id, accepted.turn.messageId, receipt.receiptId, 'completed',
    JSON.stringify({ ok: true, result: { contents: 'covered result' } }));
  const prefix = await store.getCompactionPrefix(chat.id, accepted.turn.messageId);
  assert.deepEqual(prefix.protocolHistory[0]?.wire, wire);
  assert.equal(prefix.coveredPrefixHash, hashCompactionPrefix(prefix.messages, prefix.protocolHistory));
  const withoutWire = prefix.protocolHistory.map((exchange) => {
    const copy = structuredClone(exchange);
    delete copy.wire;
    delete copy.receiptId;
    return copy;
  });
  assert.notEqual(prefix.coveredPrefixHash, hashCompactionPrefix(prefix.messages, withoutWire),
    'the V2 call envelope participates in the committed raw-prefix hash');
  const snapshot: CompactSnapshot = {
    id: 'compact-v2-wire-prefix', version: 1, boundaryMessageId: accepted.turn.messageId,
    coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
    text: 'Summary of the covered V2 call.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, snapshot, null);

  const reopened = await openStore(directory);
  const reopenedPrefix = await reopened.getCompactionPrefix(chat.id, accepted.turn.messageId);
  assert.deepEqual(reopenedPrefix.protocolHistory[0]?.wire, wire);
  assert.equal(reopenedPrefix.coveredPrefixHash, snapshot.coveredPrefixHash);

  const chatPath = join(directory, 'chats', chat.id, 'chat.json');
  const stored = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown> & {
    providerStateOwnership: { receipts: Array<{ wire: Record<string, unknown>; wireHash: string }> };
  };
  const binding = stored.providerStateOwnership.receipts[0]!;
  const changedWire = structuredClone(binding.wire) as { messageId?: string };
  changedWire.messageId = 'assistant-covered-call-tampered';
  binding.wire = changedWire;
  binding.wireHash = createHash('sha256').update(JSON.stringify(changedWire), 'utf8').digest('hex');
  await writeFile(chatPath, JSON.stringify(stored), 'utf8');
  const tamperedBytes = await readFile(chatPath);
  const rejected = await openStore(directory);
  assert.ok((await rejected.getStorageIssues()).some((issue) => issue.includes('файл истории повреждён')),
    'a wire change with a recomputed private wire hash still invalidates the compact prefix');
  assert.deepEqual(await readFile(chatPath), tamperedBytes, 'reopen does not rewrite tampered history');
});

test('rejects malformed schema 13 provider-state metadata without rewriting corrupt chat bytes', async (t) => {
  const cases = ['hash', 'scope', 'duplicate', 'unbound-message', 'receipt-hash', 'receipt-duplicate',
    'unbound-receipt', 'compact-snapshot', 'compact-hash', 'unknown-schema'] as const;
  for (const corruption of cases) {
    await t.test(corruption, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), `gigachat-provider-state-corrupt-${corruption}-`));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const scopeA = 'a'.repeat(64);
      const store = await openStore(directory);
      const chat = await store.createChat();
      const accepted = await store.acceptLocalMessage(chat.id, 'Private owner validation.', `turn-corrupt-${corruption}`);
      await appendAcceptedAnswer(store, accepted.turn, 'Owned state.', `state-corrupt-${corruption}`, scopeA);
      const receipt = {
        receiptId: 'a'.repeat(64), name: 'read', arguments: { path: 'private.txt' }, content: 'receipt result',
        functionsStateId: `receipt-state-${corruption}`,
      };
      await store.beginToolReceipt(chat.id, accepted.turn.messageId, receipt, scopeA);
      const prefix = await store.getCompactionPrefix(chat.id, accepted.turn.messageId);
      const snapshot: CompactSnapshot = {
        id: `snapshot-corrupt-${corruption}`, version: 1, boundaryMessageId: accepted.turn.messageId,
        coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
        text: 'Corruption fixture.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
      };
      await store.commitCompactSnapshot(chat.id, snapshot, null, undefined, undefined,
        { accountScope: scopeA, functionsStateId: `compact-state-${corruption}` });
      const path = join(directory, 'chats', chat.id, 'chat.json');
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const ownership = raw.providerStateOwnership as {
        schemaVersion: number;
        messages: Array<Record<string, unknown>>;
        receipts: Array<Record<string, unknown>>;
        compact: Record<string, unknown> | null;
      };
      switch (corruption) {
        case 'hash': ownership.messages[0]!.stateIdHash = '0'.repeat(64); break;
        case 'scope': ownership.messages[0]!.accountScope = 'A'.repeat(64); break;
        case 'duplicate': ownership.messages.push({ ...ownership.messages[0] }); break;
        case 'unbound-message': ownership.messages[0]!.messageId = 'not-a-stored-message'; break;
        case 'receipt-hash': ownership.receipts[0]!.stateIdHash = '0'.repeat(64); break;
        case 'receipt-duplicate': ownership.receipts.push({ ...ownership.receipts[0] }); break;
        case 'unbound-receipt': ownership.receipts[0]!.anchorMessageId = 'not-a-user-anchor'; break;
        case 'compact-snapshot': ownership.compact!.snapshotId = 'not-the-current-snapshot'; break;
        case 'compact-hash': ownership.compact!.stateIdHash = 'f'.repeat(64); break;
        case 'unknown-schema': raw.schemaVersion = 14; break;
      }
      const corruptBytes = JSON.stringify(raw);
      await writeFile(path, corruptBytes, 'utf8');
      const reopened = await openStore(directory);
      assert.deepEqual(await reopened.listChats(), [], 'corrupt private metadata is not partially exposed');
      assert.match((await reopened.getStorageIssues()).join('\n'), /повреждён/);
      assert.equal(await readFile(path, 'utf8'), corruptBytes, 'rejected metadata bytes remain unchanged');
    });
  }
});

test('rejects project-delete journals that change private state ownership without altering source files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-provider-state-project-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopeA = 'a'.repeat(64);
  const scopeB = 'b'.repeat(64);
  const store = await openStore(directory);
  const project = await store.createProject('Journal ownership');
  const chat = await store.createChat(project.id);
  const accepted = await store.acceptLocalMessage(chat.id, 'Keep owner invariant.', 'turn-journal-owner');
  await appendAcceptedAnswer(store, accepted.turn, 'Owned answer.', 'journal-state', scopeA);
  const projectsPath = join(directory, 'projects.json');
  const chatPath = join(directory, 'chats', chat.id, 'chat.json');
  const projects = JSON.parse(await readFile(projectsPath, 'utf8')) as { schemaVersion: number; projects: Array<Record<string, unknown>> };
  const beforeChat = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  const ownership = structuredClone(beforeChat.providerStateOwnership) as {
    schemaVersion: number; messages: Array<Record<string, unknown>>; receipts: Array<Record<string, unknown>>; compact: unknown;
  };
  const tamperedOwnership = { ...ownership, messages: ownership.messages.map((entry) => ({ ...entry, accountScope: scopeB })) };
  const afterChat = { ...beforeChat, projectId: null, providerStateOwnership: tamperedOwnership };
  const journalPath = join(directory, 'project-delete.journal.json');
  const beforeProjectBytes = await readFile(projectsPath);
  const beforeChatBytes = await readFile(chatPath);
  const journal = {
    schemaVersion: 2, operationId: 'journal-owner-change', projectId: project.id,
    before: { projects, chats: [beforeChat], instructionText: null },
    after: {
      projects: { ...projects, projects: projects.projects.filter((entry) => entry.id !== project.id) },
      chats: [afterChat], instructionText: null,
    },
  };
  const journalBytes = JSON.stringify(journal);
  await writeFile(journalPath, journalBytes, 'utf8');
  await assert.rejects(openStore(directory));
  assert.deepEqual(await readFile(projectsPath), beforeProjectBytes);
  assert.deepEqual(await readFile(chatPath), beforeChatBytes);
  assert.equal(await readFile(journalPath, 'utf8'), journalBytes);
  assert.equal((await store.getProviderStateOwnership(chat.id, scopeA)).messages[0]?.owned, true);
});

test('accepted chat and compaction turns stop at the persisted per-chat record limit without changing data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-turn-capacity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const source = join(directory, 'pending.txt');
  await writeFile(source, 'LOCAL_ATTACHMENT_STAYS_PENDING', 'utf8');
  const staged = await store.stageChatDraftFile(chat.id, source);
  await store.appendLocalMessage(chat.id, 'Сохранённое сообщение-якорь');
  await store.updateChat(chat.id, { draft: 'Оставить черновик при достижении предела.' });

  const chatPath = join(directory, 'chats', chat.id, 'chat.json');
  const raw = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  const beforeCapacity = await store.getChat(chat.id);
  const anchor = beforeCapacity.messages[0];
  assert.ok(anchor?.role === 'user');
  raw.turns = Array.from({ length: 50_000 }, (_, index) => ({
    turnId: `capacity-turn-${index}`,
    anchorMessageId: anchor.id,
    assistantMessageId: `capacity-answer-${index}`,
    modelId: beforeCapacity.modelId,
    status: 'interrupted',
    createdAt: timestamp,
    endedAt: timestamp,
    activity: [],
  }));
  await writeFile(chatPath, JSON.stringify(raw), 'utf8');
  const capacityBytes = await readFile(chatPath);

  const atCapacity = await openStore(directory);
  const original = await atCapacity.getChat(chat.id);
  assert.equal(original.turns.length, 50_000);
  assert.equal(original.draft, 'Оставить черновик при достижении предела.');
  assert.deepEqual(original.draftAttachments, staged.draftAttachments);
  await assert.rejects(
    atCapacity.acceptLocalMessage(chat.id, 'Этот текст не должен быть принят.', 'turn-over-capacity', [staged.draftAttachments[0]!.id]),
    /предел записей ходов/i,
  );
  await assert.rejects(
    atCapacity.acceptCompactionTurn(chat.id, 'compact-over-capacity'),
    /предел записей ходов/i,
  );

  assert.deepEqual(await readFile(chatPath), capacityBytes, 'rejected acceptance does not rewrite the chat file');
  const unchanged = await atCapacity.getChat(chat.id);
  assert.deepEqual(unchanged.messages, original.messages);
  assert.deepEqual(unchanged.draftAttachments, original.draftAttachments);
  assert.equal(unchanged.draft, original.draft);
  assert.equal(unchanged.turns.length, 50_000);

  const reloaded = await (await openStore(directory)).getChat(chat.id);
  assert.deepEqual(reloaded.messages, original.messages);
  assert.deepEqual(reloaded.draftAttachments, original.draftAttachments);
  assert.equal(reloaded.draft, original.draft);
  assert.equal(reloaded.turns.length, 50_000, 'the at-capacity chat remains readable after restart');
});

test('schema 9 compact metadata survives turn-record migration without invented history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-v9-compact-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Keep this compact prefix.', 'turn-v9-compact');
  const current = await store.getChat(chat.id);
  const prefix = await store.getCompactionPrefix(chat.id, accepted.turn.messageId);
  const snapshot: CompactSnapshot = {
    id: 'schema-nine-compact', version: 1, boundaryMessageId: accepted.turn.messageId,
    coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
    text: 'The original request is covered.', modelId: 'GigaChat-3-Pro',
    provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, snapshot, null);
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  legacy.schemaVersion = 9;
  delete legacy.providerStateOwnership;
  delete legacy.turns;
  await writeFile(path, JSON.stringify(legacy), 'utf8');

  const restored = await openStore(directory);
  const migrated = await restored.getChat(chat.id);
  assert.deepEqual(migrated.messages, current.messages);
  assert.deepEqual(migrated.compactSnapshot, snapshot);
  assert.deepEqual(migrated.turns, [], 'schema 9 history has no reliable turn metadata to invent');
  const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.schemaVersion, 13);
  assert.deepEqual(saved.compactSnapshot, snapshot);
});

test('migrates a schema 10 chat to 11 without rewriting attachment links, raw usage, or unknown Skill history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-v10-usage-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'linked.txt');
  await writeFile(source, 'schema ten attachment bytes', 'utf8');
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const staged = await store.stageChatDraftFile(chat.id, source);
  const attachmentId = staged.draftAttachments[0]?.id;
  assert.ok(attachmentId);
  const accepted = await store.acceptLocalMessage(chat.id, 'Сохранить принятую историю.', 'turn-v10-preserved', [attachmentId]);
  await appendAcceptedAnswer(store, accepted.turn, 'Исторический ответ.');
  await store.updateChat(chat.id, { draft: 'Оставить текущий черновик.' });
  const prefix = await store.getCompactionPrefix(chat.id, accepted.turn.messageId);
  const snapshot: CompactSnapshot = {
    id: 'schema-ten-compact', version: 1, boundaryMessageId: accepted.turn.messageId,
    coveredThroughMessageId: prefix.coveredThroughMessageId, coveredPrefixHash: prefix.coveredPrefixHash,
    text: 'Сводка прежней истории.', modelId: 'GigaChat-3-Pro', provenance: 'fixture', createdAt: timestamp,
  };
  await store.commitCompactSnapshot(chat.id, snapshot, null);
  const usage = {
    localRequestId: '44444444-4444-4444-8444-444444444444', chatId: chat.id,
    requestKind: 'chat' as const, modelId: 'GigaChat-3-Pro', providerRequestId: 'schema-ten-request',
    providerModel: 'GigaChat-3-Pro:fixture', createdAt: timestamp, status: 'completed' as const,
    promptTokens: 31, completionTokens: 7, totalTokens: 38, precachedPromptTokens: 4, conflictedFields: [],
  };
  await store.recordUsageReceipt(usage);
  const before = await store.getChat(chat.id);
  const usageBefore = await store.getUsageLedger();

  const chatPath = join(directory, 'chats', chat.id, 'chat.json');
  const schemaTen = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  schemaTen.schemaVersion = 10;
  delete schemaTen.providerStateOwnership;
  for (const value of schemaTen.turns as Array<Record<string, unknown>>) {
    delete value.pendingSkillId;
    delete value.invokedSkillId;
  }
  await writeFile(chatPath, JSON.stringify(schemaTen), 'utf8');

  const restored = await openStore(directory);
  const migrated = await restored.getChat(chat.id);
  assert.deepEqual(migrated.messages, before.messages);
  assert.deepEqual(migrated.artifacts, before.artifacts);
  assert.deepEqual(migrated.draftAttachments, before.draftAttachments);
  assert.deepEqual(migrated.messages[0]?.attachmentIds, [attachmentId]);
  assert.equal(migrated.draft, 'Оставить текущий черновик.');
  assert.deepEqual(migrated.compactSnapshot, snapshot);
  const withoutSkillMetadata = (turn: (typeof before.turns)[number]): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...turn };
    delete copy.pendingSkillId;
    delete copy.invokedSkillId;
    return copy;
  };
  assert.deepEqual(migrated.turns.map(withoutSkillMetadata), before.turns.map(withoutSkillMetadata));
  assert.equal(migrated.turns[0]?.turnId, accepted.turn.turnId);
  assert.equal(migrated.turns[0]?.invokedSkillId, undefined, 'schema 10 has no reliable Skill-use marker');
  assert.deepEqual(await restored.getUsageLedger(), usageBefore);
  assert.equal((await restored.getUsageLedger()).totalTokens.knownTokens, 38);
  assert.equal((await restored.getUsageProfileView(0)).skills.unknownTurnCount, 1,
    'legacy completed turn remains unknown rather than being migrated to known-no-Skill');
  const saved = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.schemaVersion, 13);
  assert.equal(((saved.turns as Array<Record<string, unknown>>)[0])?.invokedSkillId, undefined);
});

test('schema 9 home-send journal recovers a stable interrupted turn without replaying it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-home-v9-journal-turn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'schema-nine.txt');
  await writeFile(source, 'preserved local source', 'utf8');
  const store = await openStore(directory, {
    testFaults: {
      afterHomeSendStage: async (stage) => {
        if (stage !== 'journal') return;
        const journalPath = join(directory, 'home-send.journal.json');
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
        const chat = journal.chat as Record<string, unknown>;
        chat.schemaVersion = 9;
        delete chat.providerStateOwnership;
        delete chat.turns;
        delete (journal.turn as Record<string, unknown>).assistantMessageId;
        const nextDraft = journal.nextDraft as Record<string, unknown>;
        const acceptance = nextDraft.lastAcceptance as Record<string, unknown>;
        delete (acceptance.turn as Record<string, unknown>).assistantMessageId;
        await writeFile(journalPath, JSON.stringify(journal), 'utf8');
        throw new Error('simulated schema 9 journal interruption');
      },
    },
  });
  await store.saveHomeDraft({
    revision: 1, text: 'Restore the accepted request.', projectId: null,
    permissionProfile: 'ask', skillId: null, modelId: 'GigaChat-3-Pro',
  });
  const staged = await store.stageHomeDraftFile(source);
  await assert.rejects(store.acceptHomeDraft(staged.revision, 'home-schema-nine-turn'), /simulated schema 9 journal interruption/);

  const recovered = await openStore(directory);
  const [summary] = await recovered.listChats();
  assert.ok(summary);
  const detail = await recovered.getChat(summary.id);
  const accepted = (await recovered.getHomeDraft()).lastAcceptance;
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0]?.text, 'Restore the accepted request.');
  assert.equal(detail.messages[0]?.attachmentIds?.[0], staged.attachments[0]?.id);
  assert.equal(detail.turns.length, 1);
  assert.equal(detail.turns[0]?.turnId, 'home-schema-nine-turn');
  assert.equal(detail.turns[0]?.anchorMessageId, detail.messages[0]?.id);
  assert.equal(detail.turns[0]?.status, 'interrupted');
  assert.ok(detail.turns[0]?.assistantMessageId);
  assert.equal(detail.turns[0]?.assistantMessageId, accepted?.turn.assistantMessageId);
  assert.equal(detail.messages.some((message) => message.role === 'assistant'), false);
  assert.deepEqual(accepted?.turn.messages.map((message) => message.id), [detail.messages[0]?.id]);
  assert.equal(await readFile(source, 'utf8'), 'preserved local source');
  assert.equal((JSON.parse(await readFile(join(directory, 'chats', detail.id, 'chat.json'), 'utf8')) as Record<string, unknown>).schemaVersion, 13);
});

test('persists each provider pairing while reusing a completed side effect for a new state ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-tool-receipt-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const first = await store.acceptLocalMessage(chat.id, 'Запиши файл', 'turn-write-first');
  const firstReceipt = {
    receiptId: 'a'.repeat(64), effectId: 'b'.repeat(64), name: 'write',
    arguments: { path: 'result.txt', contents: 'содержимое' }, content: null, functionsStateId: 'state-one',
  };
  assert.equal((await store.beginToolReceipt(chat.id, first.turn.messageId, firstReceipt)).shouldExecute, true);
  const result = JSON.stringify({ ok: true, result: { bytes: 22 } });
  await store.completeToolReceipt(chat.id, first.turn.messageId, firstReceipt.receiptId, 'completed', result);

  const retryReceipt = { ...firstReceipt, receiptId: 'c'.repeat(64), functionsStateId: 'state-two' };
  const replay = await store.beginToolReceipt(chat.id, first.turn.messageId, retryReceipt);
  assert.equal(replay.shouldExecute, false);
  assert.equal(replay.receipt.result, result);
  const next = await store.acceptLocalMessage(chat.id, 'Ещё одна отдельная запись', 'turn-write-next');
  const independentReceipt = {
    ...firstReceipt, receiptId: 'd'.repeat(64), effectId: 'e'.repeat(64), functionsStateId: 'state-three',
  };
  assert.equal((await store.beginToolReceipt(chat.id, next.turn.messageId, independentReceipt)).shouldExecute, true);

  const reopened = await openStore(directory);
  const history = await reopened.getToolProtocolThrough(chat.id, first.turn.messageId);
  assert.deepEqual(history.map((exchange) => exchange.functionsStateId), ['state-one', 'state-two']);
  assert.deepEqual(history.map((exchange) => exchange.result), [result, result]);
  const detail = await reopened.getChat(chat.id);
  assert.equal(detail.toolReceipts.length, 3);
  assert.equal(detail.toolReceipts[1]?.effectId, firstReceipt.effectId);
});

test('V2 side-effect reuse persists the new call and state envelope without repeating the effect', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-tool-receipt-v2-effect-wire-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const accepted = await store.acceptLocalMessage(chat.id, 'Запиши файл ровно один раз.', 'turn-v2-write-once');
  const accountScope = 'f'.repeat(64);
  const effectId = 'b'.repeat(64);
  const argumentsValue = { path: 'result.txt', contents: 'содержимое' };
  const stateOne = 'b3e2d3c4-5566-7a88-8b99-aabbccddeeff';
  const stateTwo = 'c3e2d3c4-5566-7a88-8b99-aabbccddeeff';
  const firstReceipt = {
    receiptId: 'a'.repeat(64), effectId, name: 'write', arguments: argumentsValue,
    content: 'Сохраню результат.', functionsStateId: stateOne,
  };
  const firstWire = {
    content: [
      { text: 'Сохраню результат.' },
      { function_call: { id: 'a3e2d3c4-5566-4a88-8b99-aabbccddeeff', name: 'write',
        arguments: '{"path":"result.txt","contents":"содержимое"}' } },
    ],
    messageId: 'assistant-write-call-one', toolStateId: stateOne,
  };
  let writeEffects = 0;
  const first = await store.beginToolReceipt(chat.id, accepted.turn.messageId, firstReceipt, accountScope, firstWire);
  assert.equal(first.shouldExecute, true);
  if (first.shouldExecute) writeEffects += 1;
  const result = JSON.stringify({ ok: true, result: { bytes: 22 } });
  await store.completeToolReceipt(chat.id, accepted.turn.messageId, firstReceipt.receiptId, 'completed', result);

  const secondReceipt = { ...firstReceipt, receiptId: 'c'.repeat(64), functionsStateId: stateTwo };
  const secondWire = {
    content: [
      { text: 'Сохраню результат.' },
      { function_call: { id: 'c3e2d3c4-5566-4a88-8b99-aabbccddeeff', name: 'write',
        arguments: '{"path":"result.txt","contents":"содержимое"}' } },
    ],
    messageId: 'assistant-write-call-two', toolStateId: stateTwo,
  };
  const replay = await store.beginToolReceipt(chat.id, accepted.turn.messageId, secondReceipt, accountScope, secondWire);
  assert.equal(replay.shouldExecute, false);
  assert.equal(replay.receipt.result, result);
  assert.equal(writeEffects, 1, 'a new provider call/state envelope reuses the same durable side effect');

  const reopened = await openStore(directory);
  const detail = await reopened.getChat(chat.id);
  assert.equal(detail.toolReceipts.length, 2);
  assert.deepEqual(detail.toolReceipts.map((receipt) => receipt.functionsStateId), [stateOne, stateTwo]);
  assert.equal(JSON.stringify(detail).includes('assistant-write-call-one'), false);
  const exchanges = await reopened.getToolProtocolThrough(chat.id, accepted.turn.messageId);
  assert.deepEqual(exchanges.map((exchange) => exchange.wire), [firstWire, secondWire]);
  assert.deepEqual(exchanges.map((exchange) => exchange.result), [result, result]);
  assert.deepEqual(await reopened.getProviderStateOwnership(chat.id, accountScope), {
    messages: [],
    receipts: [
      { receiptId: firstReceipt.receiptId, anchorMessageId: accepted.turn.messageId, owned: true, wireOwned: true },
      { receiptId: secondReceipt.receiptId, anchorMessageId: accepted.turn.messageId, owned: true, wireOwned: true },
    ],
    compact: null,
  });
});

test('migrates existing chat detail schema 3 and preserves its draft', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-detail-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Сохранённый черновик' });
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const oldDetail = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  oldDetail.schemaVersion = 3;
  delete oldDetail.providerStateOwnership;
  delete oldDetail.turns;
  delete oldDetail.nextTurnPermissionProfile;
  await writeFile(path, JSON.stringify(oldDetail));

  const restored = await openStore(directory);
  assert.equal((await restored.getChat(chat.id)).draft, 'Сохранённый черновик');
  assert.equal((await restored.getChat(chat.id)).nextTurnPermissionProfile, null);
  const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(migrated.schemaVersion, 13);
  assert.equal(migrated.nextTurnPermissionProfile, null);
  assert.equal(migrated.nextTurnSkillId, null);
});

test('migrates schema 8 with an empty pending list and preserves legacy messageId-null artifacts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-detail-v8-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'legacy-local.txt');
  await writeFile(source, 'This was imported before staged attachments.');
  const store = await openStore(directory);
  const chat = await store.createChat();
  const imported = await store.importFile(chat.id, source);
  assert.ok(imported);
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const legacyBytes = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  legacyBytes.schemaVersion = 8;
  delete legacyBytes.providerStateOwnership;
  delete legacyBytes.draftAttachments;
  delete legacyBytes.turns;
  await writeFile(path, JSON.stringify(legacyBytes));

  const restored = await openStore(directory);
  const detail = await restored.getChat(chat.id);
  assert.deepEqual(detail.artifacts, imported.artifacts);
  assert.equal(detail.artifacts[0]?.messageId, null);
  assert.deepEqual(detail.draftAttachments, []);
  const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.schemaVersion, 13);
  assert.deepEqual(saved.draftAttachments, []);
});

test('migrates chat detail schema 4 to 5 without changing history or artifacts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-detail-v4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.appendLocalMessage(chat.id, 'Сохранённая история');
  await store.updateChat(chat.id, { draft: 'Черновик', nextTurnPermissionProfile: 'ask' });
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const oldDetail = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  oldDetail.schemaVersion = 4;
  delete oldDetail.providerStateOwnership;
  delete oldDetail.turns;
  delete oldDetail.nextTurnSkillId;
  await writeFile(path, JSON.stringify(oldDetail));

  const restored = await openStore(directory);
  const detail = await restored.getChat(chat.id);
  assert.equal(detail.nextTurnPermissionProfile, 'ask');
  assert.equal(detail.nextTurnSkillId, null);
  assert.equal(detail.draft, 'Черновик');
  assert.equal(detail.messages[0]?.text, 'Сохранённая история');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 13);
});

test('migrates previous settings and chat schemas with an empty model choice', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-model-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  const chatPath = join(directory, 'chats', chat.id, 'chat.json');
  const settingsPath = join(directory, 'settings.json');
  const oldChat = JSON.parse(await readFile(chatPath, 'utf8')) as Record<string, unknown>;
  const oldSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as { schemaVersion: number; settings: Record<string, unknown> };
  oldChat.schemaVersion = 5;
  delete oldChat.providerStateOwnership;
  delete oldChat.turns;
  delete oldChat.modelId;
  oldSettings.schemaVersion = 6;
  delete oldSettings.settings.defaultModelId;
  await writeFile(chatPath, JSON.stringify(oldChat));
  await writeFile(settingsPath, JSON.stringify(oldSettings));
  const restored = await openStore(directory);
  assert.equal((await restored.getChat(chat.id)).modelId, null);
  assert.equal((await restored.getSettings()).defaultModelId, null);
  assert.equal((await restored.getSettings()).microphoneConsent, 'unasked');
  assert.equal(JSON.parse(await readFile(chatPath, 'utf8')).schemaVersion, 13);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 10);
});

test('imports copies, preserves originals and archived files, and removes only chat copies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.md');
  await writeFile(source, '# Исходный файл\n');
  const store = await openStore(directory);
  const chat = await store.createChat();
  const detail = await store.importFile(chat.id, source);
  const artifact = detail.artifacts[0];
  assert.ok(artifact);
  const copy = await store.getArtifactPath(chat.id, artifact.id);
  assert.equal(await readFile(copy, 'utf8'), '# Исходный файл\n');
  await store.updateChat(chat.id, { archived: true });
  assert.equal(await readFile(copy, 'utf8'), '# Исходный файл\n');
  assert.equal((await (await openStore(directory)).getChat(chat.id)).artifacts[0]?.name, 'source.md');
  await store.deleteChat(chat.id);
  await assert.rejects(stat(copy), { code: 'ENOENT' });
  assert.equal(await readFile(source, 'utf8'), '# Исходный файл\n');
});

test('rejects failed import and failed message without losing a draft', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Сохранить' });
  await assert.rejects(store.importFile(chat.id, join(directory, 'missing.pdf')));
  await assert.rejects(store.appendLocalMessage(chat.id, ''));
  assert.equal((await store.getChat(chat.id)).draft, 'Сохранить');
  assert.deepEqual((await store.getChat(chat.id)).artifacts, []);
});

test('failed atomic replacement keeps the previous chat and draft', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-atomic-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Последняя версия' });
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const backup = `${path}.saved`;
  await rename(path, backup);
  await mkdir(path);
  await assert.rejects(store.appendLocalMessage(chat.id, 'Отправить'));
  assert.equal((await store.getChat(chat.id)).draft, 'Последняя версия');
  assert.deepEqual((await store.getChat(chat.id)).messages, []);
  assert.equal(JSON.parse(await readFile(backup, 'utf8')).draft, 'Последняя версия');
  await rm(path, { recursive: true });
  await rename(backup, path);
  assert.equal((await (await openStore(directory)).getChat(chat.id)).draft, 'Последняя версия');
});

test('preserves the appearance of old dark settings and allows the new dark theme', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-theme-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  const oldSettings = {
    theme: 'dark', sidebarTransparent: true, sidebarVisible: false,
    defaultProjectsFolder: null, preferredOpener: 'system', defaultPermissionProfile: 'ask',
  };
  await writeFile(settingsPath, JSON.stringify({ schemaVersion: 2, settings: oldSettings }));
  const store = await openStore(directory);
  assert.deepEqual(await store.getSettings(), {
    ...oldSettings,
    defaultModelId: null,
    theme: 'emerald',
    onboardingCompleted: true,
    microphoneConsent: 'unasked',
    sidebarWidthPx: null,
    browserPaneOpen: false,
    browserWidthPx: null,
    browserTabs: [],
    browserActiveTabId: null,
    notifications: { taskStarted: false, taskCompleted: true, failures: true },
  });
  await store.updateSettings({ theme: 'dark' });
  const restored = await openStore(directory);
  assert.equal((await restored.getSettings()).theme, 'dark');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 10);
});

test('new profile starts onboarding; migrated profiles do not restart it', async (t) => {
  const freshDirectory = await mkdtemp(join(tmpdir(), 'gigachat-onboarding-fresh-'));
  const existingDirectory = await mkdtemp(join(tmpdir(), 'gigachat-onboarding-existing-'));
  t.after(() => Promise.all([
    rm(freshDirectory, { recursive: true, force: true }),
    rm(existingDirectory, { recursive: true, force: true }),
  ]).then(() => undefined));

  const fresh = await openStore(freshDirectory);
  assert.equal((await fresh.getSettings()).onboardingCompleted, false);
  await fresh.updateSettings({ onboardingCompleted: true });
  assert.equal((await (await openStore(freshDirectory)).getSettings()).onboardingCompleted, true);

  await writeFile(join(existingDirectory, 'settings.json'), JSON.stringify({
    schemaVersion: 4,
    settings: {
      theme: 'emerald', sidebarTransparent: false, sidebarVisible: true,
      defaultProjectsFolder: null, preferredOpener: 'system', defaultPermissionProfile: 'ask',
    },
  }));
  const existing = await openStore(existingDirectory);
  assert.equal((await existing.getSettings()).onboardingCompleted, true);
  assert.equal((await existing.getSettings()).microphoneConsent, 'unasked');
  assert.equal(JSON.parse(await readFile(join(existingDirectory, 'settings.json'), 'utf8')).schemaVersion, 10);
});

test('migrates microphone consent and preserves a later choice', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-microphone-consent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  await openStore(directory);
  const previous = JSON.parse(await readFile(settingsPath, 'utf8')) as { schemaVersion: number; settings: Record<string, unknown> };
  previous.schemaVersion = 7;
  delete previous.settings.microphoneConsent;
  await writeFile(settingsPath, JSON.stringify(previous));
  const store = await openStore(directory);
  assert.equal((await store.getSettings()).microphoneConsent, 'unasked');
  await store.updateSettings({ microphoneConsent: 'declined' });
  assert.equal((await (await openStore(directory)).getSettings()).microphoneConsent, 'declined');
  await assert.rejects(store.updateSettings({ microphoneConsent: 'invalid' } as never));
});

test('migrates settings schema 8 to browser and sidebar defaults', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-browser-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  await openStore(directory);
  const previous = JSON.parse(await readFile(settingsPath, 'utf8')) as { schemaVersion: number; settings: Record<string, unknown> };
  previous.schemaVersion = 8;
  delete previous.settings.sidebarWidthPx;
  delete previous.settings.browserPaneOpen;
  delete previous.settings.browserTabs;
  delete previous.settings.browserActiveTabId;
  await writeFile(settingsPath, JSON.stringify(previous));
  const store = await openStore(directory);
  const settings = await store.getSettings();
  assert.equal(settings.sidebarWidthPx, null);
  assert.equal(settings.browserPaneOpen, false);
  assert.deepEqual(settings.browserTabs, []);
  assert.equal(settings.browserActiveTabId, null);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 10);
});

test('migrates schema 9 browser width and preserves a chosen width', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-browser-width-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json');
  await openStore(directory);
  const previous = JSON.parse(await readFile(settingsPath, 'utf8')) as { schemaVersion: number; settings: Record<string, unknown> };
  previous.schemaVersion = 9;
  delete previous.settings.browserWidthPx;
  await writeFile(settingsPath, JSON.stringify(previous));
  const store = await openStore(directory);
  assert.equal((await store.getSettings()).browserWidthPx, null);
  await store.updateSettings({ browserWidthPx: 535 });
  assert.equal((await (await openStore(directory)).getSettings()).browserWidthPx, 535);
  await assert.rejects(store.updateSettings({ browserWidthPx: 259 }));
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 10);
});

test('counts real local chat, project, and message activity days without counting drafts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-usage-stats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Статистика');
  const firstChat = await store.createChat(project.id);
  const secondChat = await store.createChat();
  await store.appendLocalMessage(firstChat.id, 'Локальное сообщение');

  const projectPath = join(directory, 'projects.json');
  const projectFile = JSON.parse(await readFile(projectPath, 'utf8')) as { projects: Array<Record<string, unknown>> };
  projectFile.projects[0]!.createdAt = '2026-09-20T10:00:00.000Z';
  projectFile.projects[0]!.updatedAt = '2026-09-21T10:00:00.000Z';
  await writeFile(projectPath, JSON.stringify(projectFile));

  const firstPath = join(directory, 'chats', firstChat.id, 'chat.json');
  const firstFile = JSON.parse(await readFile(firstPath, 'utf8')) as Record<string, unknown> & { messages: Array<Record<string, unknown>> };
  firstFile.createdAt = '2026-09-22T10:00:00.000Z';
  firstFile.messages[0]!.createdAt = '2026-09-23T10:00:00.000Z';
  await writeFile(firstPath, JSON.stringify(firstFile));

  const secondPath = join(directory, 'chats', secondChat.id, 'chat.json');
  const secondFile = JSON.parse(await readFile(secondPath, 'utf8')) as Record<string, unknown>;
  secondFile.createdAt = '2026-09-24T10:00:00.000Z';
  secondFile.updatedAt = '2026-09-25T10:00:00.000Z';
  secondFile.draft = 'Черновик без отправки';
  await writeFile(secondPath, JSON.stringify(secondFile));

  const reopened = await openStore(directory);
  assert.deepEqual(await reopened.getLocalUsageStats(), { chatCount: 2, projectCount: 1, activityDayCount: 5 });
});

test('does not rewrite corrupt or unknown-version data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-store-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectPath = join(directory, 'projects.json');
  const corruptContents = '{ broken json';
  await writeFile(projectPath, corruptContents, 'utf8');

  await assert.rejects(openStore(directory), /повреждён или имеет неизвестный формат/);
  assert.equal(await readFile(projectPath, 'utf8'), corruptContents);

  const unknownPath = join(directory, 'settings.json');
  const unknownContents = JSON.stringify({ schemaVersion: 99, settings: { theme: 'dark' } });
  await writeFile(projectPath, JSON.stringify({ schemaVersion: 1, projects: [] }), 'utf8');
  await writeFile(unknownPath, unknownContents, 'utf8');
  await assert.rejects(openStore(directory), /повреждён или имеет неизвестный формат/);
  assert.equal(await readFile(unknownPath, 'utf8'), unknownContents);
});

test('validates every file before creating or migrating siblings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-store-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corruptContents = JSON.stringify({ schemaVersion: 2, projects: 'invalid' });
  await writeFile(join(directory, 'projects.json'), corruptContents, 'utf8');

  await assert.rejects(openStore(directory), /повреждён или имеет неизвестный формат/);
  await assert.rejects(readFile(join(directory, 'chats.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'settings.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'projects.json'), 'utf8'), corruptContents);
});

test('keeps app and project instructions inside app-owned storage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Рабочая папка');

  await store.saveGlobalInstructions('Глобальные правила', (await store.readGlobalInstructionDocument()).revision);
  await store.saveProjectInstructions(project.id, 'Правила проекта', (await store.readProjectInstructionDocument(project.id)).revision);
  assert.equal(await store.readGlobalInstructions(), 'Глобальные правила');
  assert.equal(await store.readProjectInstructions(project.id), 'Правила проекта');
  assert.match(await readFile(join(directory, 'project-instructions', project.id, 'AGENTS.md'), 'utf8'), /Правила проекта/);
  assert.throws(() => store.readProjectInstructions('..'), /Некорректный идентификатор/);
});

test('serializes rapid instruction saves so the last edit wins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-instructions-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Проверка');
  await store.saveGlobalInstructions('первая', (await store.readGlobalInstructionDocument()).revision);
  await store.saveGlobalInstructions('последняя', (await store.readGlobalInstructionDocument()).revision);
  await store.saveProjectInstructions(project.id, 'сначала', (await store.readProjectInstructionDocument(project.id)).revision);
  await store.saveProjectInstructions(project.id, 'потом', (await store.readProjectInstructionDocument(project.id)).revision);
  assert.equal(await store.readGlobalInstructions(), 'последняя');
  assert.equal(await store.readProjectInstructions(project.id), 'потом');
});

test('reopens concurrent project and chat writes with the latest draft, history, files, and settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-concurrent-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.md');
  await writeFile(source, 'attachment');
  const store = await openStore(join(directory, 'data'));
  const project = await store.createProject('Проект');
  const draftChat = await store.createChat(project.id);
  const historyChat = await store.createChat(project.id);

  await Promise.all([
    store.updateChat(draftChat.id, { draft: 'Первый черновик' }),
    store.updateProject(project.id, { name: 'Обновлённый проект' }),
    store.updateChat(draftChat.id, { draft: 'Последний черновик' }),
    store.updateSettings({ theme: 'warm' }),
  ]);
  await store.appendLocalMessage(historyChat.id, 'Сохранённая история');
  const withFile = await store.importFile(historyChat.id, source);
  const importedArtifact = withFile.artifacts[0];
  assert.ok(importedArtifact);
  await store.updateChat(historyChat.id, { archived: true });

  const restored = await openStore(join(directory, 'data'));
  assert.deepEqual((await restored.listProjects()).map((item) => item.id), [project.id]);
  assert.equal((await restored.listProjects())[0]?.name, 'Обновлённый проект');
  assert.equal((await restored.getChat(draftChat.id)).draft, 'Последний черновик');
  const restoredHistory = await restored.getChat(historyChat.id);
  assert.equal(restoredHistory.archived, true);
  assert.equal(restoredHistory.messages[0]?.text, 'Сохранённая история');
  assert.equal(restoredHistory.artifacts[0]?.id, importedArtifact.id);
  assert.equal(await readFile(await restored.getArtifactPath(historyChat.id, importedArtifact.id), 'utf8'), 'attachment');
  assert.equal((await restored.getSettings()).theme, 'warm');
});

test('deleting a project preserves external AGENTS.md, chats, and source files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-delete-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, 'data');
  const workingFolder = join(directory, 'workspace');
  const source = join(directory, 'source.md');
  await mkdir(workingFolder);
  await writeFile(join(workingFolder, 'keep.txt'), 'keep');
  await writeFile(source, 'source');
  const store = await openStore(dataDirectory);
  const project = await store.createProject('Проект');
  await store.updateProject(project.id, { workingFolder });
  const chat = await store.createChat(project.id);
  await store.appendLocalMessage(chat.id, 'История');
  const withFile = await store.importFile(chat.id, source);
  const importedArtifact = withFile.artifacts[0];
  assert.ok(importedArtifact);
  await store.saveProjectInstructions(project.id, 'Инструкция проекта', (await store.readProjectInstructionDocument(project.id)).revision);
  await store.updateChat(chat.id, { nextTurnSkillId: `project/${project.id}/review` });
  const globalSkillChat = await store.createChat();
  await store.updateChat(globalSkillChat.id, { nextTurnSkillId: 'global/review' });
  assert.equal(await readFile(join(workingFolder, 'AGENTS.md'), 'utf8'), 'Инструкция проекта');
  const instructionsPath = join(dataDirectory, 'project-instructions', project.id, 'AGENTS.md');

  await store.deleteProject(project.id);

  await assert.rejects(stat(instructionsPath), { code: 'ENOENT' });
  assert.equal(await readFile(join(workingFolder, 'AGENTS.md'), 'utf8'), 'Инструкция проекта');
  assert.equal(await readFile(join(workingFolder, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(source, 'utf8'), 'source');
  const restored = await openStore(dataDirectory);
  assert.equal((await restored.listProjects()).length, 0);
  const preservedChat = await restored.getChat(chat.id);
  assert.equal(preservedChat.projectId, null);
  assert.equal(preservedChat.nextTurnSkillId, null);
  assert.equal(preservedChat.messages[0]?.text, 'История');
  assert.equal(preservedChat.artifacts[0]?.id, importedArtifact.id);
  assert.equal(await readFile(await restored.getArtifactPath(chat.id, importedArtifact.id), 'utf8'), 'source');
  assert.equal((await restored.getChat(globalSkillChat.id)).nextTurnSkillId, 'global/review');
});

test('rebinds a project when its old folder is missing and preserves instructions in the new folder', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-project-rebind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldFolder = join(directory, 'old-project');
  const newFolder = join(directory, 'new-project');
  await mkdir(oldFolder);
  await mkdir(newFolder);
  await writeFile(join(newFolder, 'AGENTS.md'), 'new folder rules');
  const store = await openStore(join(directory, 'profile'));
  const project = await store.createProject('Перепривязка', oldFolder);
  await rm(oldFolder, { recursive: true });

  const result = await store.updateProject(project.id, { workingFolder: newFolder });

  assert.equal(result.project.workingFolder, newFolder);
  assert.match(result.warning ?? '', /старые инструкции не перенесены/i);
  assert.equal(await readFile(join(newFolder, 'AGENTS.md'), 'utf8'), 'new folder rules');
  assert.equal((await store.listProjects()).find((item) => item.id === project.id)?.workingFolder, newFolder);
});

test('rebinds when the native instruction writer is unavailable and leaves the old AGENTS file intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-project-rebind-no-writer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldFolder = join(directory, 'old-project');
  const newFolder = join(directory, 'new-project');
  await mkdir(oldFolder);
  await mkdir(newFolder);
  const oldInstructions = join(oldFolder, 'AGENTS.md');
  await writeFile(oldInstructions, 'original project rules');
  const store = await openStoreProduction(join(directory, 'profile'));
  const project = await store.createProject('Перепривязка', oldFolder);

  const result = await store.updateProject(project.id, { workingFolder: newFolder });

  assert.equal(result.project.workingFolder, newFolder);
  assert.match(result.warning ?? '', /writer недоступен/i);
  assert.equal(await readFile(oldInstructions, 'utf8'), 'original project rules');
  await assert.rejects(readFile(join(newFolder, 'AGENTS.md'), 'utf8'), { code: 'ENOENT' });
  assert.equal((await store.listProjects()).find((item) => item.id === project.id)?.workingFolder, newFolder);
});

test('does not write project instructions through a linked parent directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-project-linked-parent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outside = join(directory, 'outside');
  const linkedRoot = join(directory, 'linked-root');
  const outsideProject = join(outside, 'project');
  await mkdir(outsideProject, { recursive: true });
  await symlink(outside, linkedRoot, 'junction');
  const store = await openStore(join(directory, 'profile'));
  const project = await store.createProject('Проект за ссылкой');

  await assert.rejects(store.updateProject(project.id, { workingFolder: join(linkedRoot, 'project') }));
  assert.equal((await store.listProjects()).find((item) => item.id === project.id)?.workingFolder, null);
  await assert.rejects(stat(join(outsideProject, 'AGENTS.md')), { code: 'ENOENT' });
});

test('revalidates the project path immediately before committing AGENTS.md', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-project-path-swap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workingFolder = join(directory, 'working');
  const movedFolder = join(directory, 'working-moved');
  const outside = join(directory, 'outside');
  await mkdir(workingFolder);
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel.txt'), 'outside sentinel');
  let swapped = false;
  const store = await openStore(join(directory, 'profile'), {
    testFaults: {
      beforeProjectInstructionCommit: async () => {
        if (swapped) return;
        swapped = true;
        await rename(workingFolder, movedFolder);
        await symlink(outside, workingFolder, 'junction');
      },
    },
  });
  const project = await store.createProject('Подмена пути');
  await store.updateProject(project.id, { workingFolder });

  const current = await store.readProjectInstructionDocument(project.id);
  await assert.rejects(store.saveProjectInstructions(project.id, 'не записывать наружу', current.revision), /ссылка|junction/i);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel');
  await assert.rejects(stat(join(outside, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(movedFolder, 'AGENTS.md')), { code: 'ENOENT' });
});

test('rolls a prepared project deletion forward after a partial durable write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-delete-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Восстанавливаемый проект');
  const firstChat = await store.createChat(project.id);
  const secondChat = await store.createChat(project.id);
  const legacyTurn = await store.acceptLocalMessage(firstChat.id, 'История первого чата', 'delete-recovery-legacy-state');
  await appendAcceptedAnswer(store, legacyTurn.turn, 'Ответ с историческим состоянием.', 'legacy-journal-state', 'f'.repeat(64));
  await store.appendLocalMessage(secondChat.id, 'История второго чата');
  await store.saveProjectInstructions(project.id, 'Старые правила', (await store.readProjectInstructionDocument(project.id)).revision);

  const projectsPath = join(directory, 'projects.json');
  const beforeProjects = JSON.parse(await readFile(projectsPath, 'utf8')) as {
    schemaVersion: number;
    projects: Array<Record<string, unknown>>;
  };
  const afterProjects = { ...beforeProjects, projects: beforeProjects.projects.filter((item) => item.id !== project.id) };
  const firstChatPath = join(directory, 'chats', firstChat.id, 'chat.json');
  const secondChatPath = join(directory, 'chats', secondChat.id, 'chat.json');
  const legacyV11 = (value: Record<string, unknown>): Record<string, unknown> => {
    const chat: Record<string, unknown> = { ...value, schemaVersion: 11 };
    delete chat.providerStateOwnership;
    return chat;
  };
  const beforeFirst = legacyV11(JSON.parse(await readFile(firstChatPath, 'utf8')) as Record<string, unknown>);
  const beforeSecond = legacyV11(JSON.parse(await readFile(secondChatPath, 'utf8')) as Record<string, unknown>);
  const afterFirst = { ...beforeFirst, projectId: null };
  const afterSecond = { ...beforeSecond, projectId: null };
  const before = {
    projects: beforeProjects,
    chats: [beforeFirst, beforeSecond],
    instructionText: 'Старые правила',
  };
  const after = {
    projects: afterProjects,
    chats: [afterSecond, afterFirst],
    instructionText: null,
  };
  await writeFile(firstChatPath, `${JSON.stringify(afterFirst, null, 2)}\n`, 'utf8');
  await writeFile(join(directory, 'project-delete.journal.json'), JSON.stringify({
    schemaVersion: 1,
    operationId: 'delete-recovery-test',
    projectId: project.id,
    before,
    after,
  }), 'utf8');

  const recovered = await openStore(directory);
  assert.deepEqual(await recovered.listProjects(), []);
  assert.equal((await recovered.getChat(firstChat.id)).projectId, null);
  assert.equal((await recovered.getChat(firstChat.id)).messages[0]?.text, 'История первого чата');
  assert.equal((await recovered.getChat(firstChat.id)).messages[1]?.functionsStateId, 'legacy-journal-state');
  assert.deepEqual(await recovered.getProviderStateOwnership(firstChat.id, 'f'.repeat(64)), {
    messages: [{ messageId: legacyTurn.turn.assistantMessageId, owned: false }], receipts: [], compact: null,
  }, 'a v1 public-only journal never claims old state for the active account');
  assert.equal((await recovered.getChat(secondChat.id)).projectId, null);
  assert.equal((await recovered.getChat(secondChat.id)).messages[0]?.text, 'История второго чата');
  await assert.rejects(stat(join(directory, 'project-instructions', project.id, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(directory, 'project-delete.journal.json')), { code: 'ENOENT' });
});

test('rejects duplicate chats in a project deletion journal without changing source data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-delete-duplicate-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Проект с повреждённым журналом');
  const chat = await store.createChat(project.id);
  const projects = JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8')) as {
    schemaVersion: number; projects: Array<Record<string, unknown>>;
  };
  const currentChatDetail = JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')) as Record<string, unknown>;
  const chatDetail: Record<string, unknown> = { ...currentChatDetail, schemaVersion: 11 };
  delete chatDetail.providerStateOwnership;
  const duplicate = { ...chatDetail, projectId: null };
  const afterProjects = { ...projects, projects: projects.projects.filter((item) => item.id !== project.id) };
  const journalPath = join(directory, 'project-delete.journal.json');
  await writeFile(journalPath, JSON.stringify({
    schemaVersion: 1,
    operationId: 'duplicate-chat-test',
    projectId: project.id,
    before: { projects, chats: [chatDetail], instructionText: null },
    after: { projects: afterProjects, chats: [duplicate, duplicate], instructionText: null },
  }), 'utf8');

  await assert.rejects(openStore(directory));
  assert.equal((await store.listProjects()).some((item) => item.id === project.id), true);
  assert.equal((await store.getChat(chat.id)).projectId, project.id);
  assert.equal(await readFile(journalPath, 'utf8').then(() => true), true);
});

test('recovers project deletion after every durable journal stage', async (t) => {
  const cases: Array<{ stage: StoreFaultStage; index?: number }> = [
    { stage: 'journal' },
    { stage: 'chat', index: 0 },
    { stage: 'chat', index: 1 },
    { stage: 'projects' },
    { stage: 'instructions' },
    { stage: 'journal-cleared' },
  ];
  for (const { stage, index } of cases) {
    const directory = await mkdtemp(join(tmpdir(), 'gigachat-delete-fault-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataDirectory = join(directory, 'profile');
    const workingFolder = join(directory, 'external-project');
    await mkdir(workingFolder);
    await writeFile(join(workingFolder, 'keep.txt'), 'external sentinel');
    let injected = false;
    const store = await openStore(dataDirectory, {
      testFaults: {
        afterProjectDeleteStage: (actualStage, actualIndex) => {
          if (!injected && actualStage === stage && actualIndex === index) {
            injected = true;
            throw new Error(`synthetic ${actualStage}`);
          }
        },
      },
    });
    const project = await store.createProject(`Fault at ${stage}:${index ?? '-'}`);
    await store.saveProjectInstructions(project.id, 'project rules', (await store.readProjectInstructionDocument(project.id)).revision);
    await store.updateProject(project.id, { workingFolder });
    const firstChat = await store.createChat(project.id);
    const secondChat = await store.createChat(project.id);
    const firstTurn = await store.acceptLocalMessage(firstChat.id, 'first history', 'delete-first-provider-state');
    await appendAcceptedAnswer(store, firstTurn.turn, 'first answer', 'delete-first-answer-state', 'c'.repeat(64));
    const secondTurn = await store.acceptLocalMessage(secondChat.id, 'second history', 'delete-second-provider-state');
    await store.beginToolReceipt(secondChat.id, secondTurn.turn.messageId, {
      receiptId: 'd'.repeat(64), name: 'read', arguments: { path: 'fixture.txt' }, content: 'second result',
      functionsStateId: 'delete-second-receipt-state',
    }, 'e'.repeat(64));
    await appendAcceptedAnswer(store, secondTurn.turn, 'second answer');

    await assert.rejects(store.deleteProject(project.id), new RegExp(`synthetic ${stage}`),
      `fault injection did not reject at ${stage}:${index ?? '-'} (callback reached: ${injected})`);
    const recovered = await openStore(dataDirectory);
    assert.deepEqual(await recovered.listProjects(), [], `${stage}:${index ?? '-'} project`);
    assert.equal((await recovered.getChat(firstChat.id)).projectId, null, `${stage}:${index ?? '-'} first chat`);
    assert.equal((await recovered.getChat(firstChat.id)).messages[0]?.text, 'first history');
    assert.equal((await recovered.getChat(secondChat.id)).projectId, null, `${stage}:${index ?? '-'} second chat`);
    assert.equal((await recovered.getChat(secondChat.id)).messages[0]?.text, 'second history');
    assert.deepEqual(await recovered.getProviderStateOwnership(firstChat.id, 'c'.repeat(64)), {
      messages: [{ messageId: firstTurn.turn.assistantMessageId, owned: true }], receipts: [], compact: null,
    }, `${stage}:${index ?? '-'} assistant owner`);
    assert.deepEqual(await recovered.getProviderStateOwnership(secondChat.id, 'e'.repeat(64)), {
      messages: [], receipts: [{ receiptId: 'd'.repeat(64), anchorMessageId: secondTurn.turn.messageId, owned: false, wireOwned: false }], compact: null,
    }, `${stage}:${index ?? '-'} receipt owner`);
    await assert.rejects(stat(join(dataDirectory, 'project-delete.journal.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(workingFolder, 'keep.txt'), 'utf8'), 'external sentinel');
    assert.equal(await readFile(join(workingFolder, 'AGENTS.md'), 'utf8'), 'project rules');
    assert.deepEqual(await store.listProjects(), [], `${stage}:${index ?? '-'} same-store retry`);
    const repeated = await openStore(dataDirectory);
    assert.deepEqual(await repeated.listProjects(), []);
    assert.equal((await repeated.getChat(firstChat.id)).messages[0]?.text, 'first history');
    assert.equal((await repeated.getProviderStateOwnership(firstChat.id, 'c'.repeat(64))).messages[0]?.owned, true);
    assert.equal((await repeated.getProviderStateOwnership(secondChat.id, 'e'.repeat(64))).receipts[0]?.owned, false);
  }
});

test('keeps a chat intact when its deletion quarantine cannot be prepared', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-delete-quarantine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Оставить до успешного удаления' });
  await writeFile(join(directory, 'deleted-chats'), 'block quarantine directory');

  await assert.rejects(store.deleteChat(chat.id));
  assert.equal((await store.listChats()).some((item) => item.id === chat.id), true);
  assert.equal((await store.getChat(chat.id)).draft, 'Оставить до успешного удаления');
  assert.equal(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8').then(() => true), true);
  const reopened = await openStore(directory);
  assert.equal((await reopened.getChat(chat.id)).draft, 'Оставить до успешного удаления');
  assert.match((await reopened.getStorageIssues()).join('\n'), /Карантин удаления чатов недоступен/);
});

test('retains only a project Skill that matches the chat destination and keeps global Skills', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-skill-detach-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const first = await store.createProject('Первый проект');
  const second = await store.createProject('Второй проект');
  const chat = await store.createChat(first.id);
  await store.updateChat(chat.id, { nextTurnSkillId: `project/${first.id}/review` });

  await store.updateChat(chat.id, { projectId: first.id });
  assert.equal((await store.getChat(chat.id)).nextTurnSkillId, `project/${first.id}/review`);
  await store.updateChat(chat.id, { projectId: second.id });
  assert.equal((await store.getChat(chat.id)).nextTurnSkillId, null);
  await store.updateChat(chat.id, { nextTurnSkillId: `project/${second.id}/review` });
  await store.updateChat(chat.id, { projectId: null });
  assert.equal((await store.getChat(chat.id)).nextTurnSkillId, null);
  await store.updateChat(chat.id, { nextTurnSkillId: 'global/review' });
  await store.updateChat(chat.id, { projectId: first.id });
  assert.equal((await store.getChat(chat.id)).nextTurnSkillId, 'global/review');
});

test('keeps healthy chats available and reports a damaged chat folder after partial deletion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-partial-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const damagedChat = await store.createChat();
  const healthyChat = await store.createChat();
  await store.appendLocalMessage(healthyChat.id, 'Здоровая история');
  await rm(join(directory, 'chats', damagedChat.id, 'chat.json'));

  const recovered = await openStore(directory);
  assert.equal((await recovered.getChat(healthyChat.id)).messages[0]?.text, 'Здоровая история');
  assert.equal((await stat(join(directory, 'chats', damagedChat.id))).isDirectory(), true);
  const diagnostics = await (recovered as typeof recovered & { getStorageIssues(): Promise<string[]> }).getStorageIssues();
  assert.equal(diagnostics.some((issue) => issue.includes(damagedChat.id)), true);

  const reopened = await openStore(directory);
  const repeatedDiagnostics = await (reopened as typeof reopened & { getStorageIssues(): Promise<string[]> }).getStorageIssues();
  assert.deepEqual(repeatedDiagnostics, diagnostics);
});

test('rejects oversized imports and checks instruction size before reading', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-size-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, 'data');
  const largeFile = join(directory, 'large.bin');
  await writeFile(largeFile, '');
  await truncate(largeFile, 25 * 1024 * 1024 + 1);
  const store = await openStore(dataDirectory);

  await assert.rejects(store.importFile(null, largeFile), /лимит 25 МиБ/);
  assert.deepEqual(await store.listChats(), []);

  const project = await store.createProject('Проект');
  const instructionsPath = join(dataDirectory, 'project-instructions', project.id, 'AGENTS.md');
  await mkdir(join(dataDirectory, 'project-instructions', project.id), { recursive: true });
  await writeFile(instructionsPath, Buffer.alloc(64 * 1024 + 1));
  await assert.rejects(store.readProjectInstructions(project.id), /64 КБ/);
});

test('refuses symlinked app-owned paths after the store has opened', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-symlinks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, 'data');
  const outside = join(directory, 'outside');
  const source = join(directory, 'source.md');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'outside');
  await writeFile(source, 'source');
  const store = await openStore(dataDirectory);

  const importChat = await store.createChat();
  await symlink(outside, join(dataDirectory, 'chats', importChat.id, 'files'), 'junction');
  await assert.rejects(store.importFile(importChat.id, source), /символическую ссылку/);
  assert.deepEqual((await store.getChat(importChat.id)).artifacts, []);

  const project = await store.createProject('Проект');
  const projectInstructions = join(dataDirectory, 'project-instructions');
  await mkdir(projectInstructions);
  await symlink(outside, join(projectInstructions, project.id), 'junction');
  await assert.rejects(store.saveProjectInstructions(project.id, 'не писать наружу', '0'.repeat(64)), /символическую ссылку/);
  await assert.rejects(store.deleteProject(project.id), /символическую ссылку/);
  assert.equal((await store.listProjects()).some((item) => item.id === project.id), true);

  const chat = await store.createChat();
  const withFile = await store.importFile(chat.id, source);
  const importedArtifact = withFile.artifacts[0];
  assert.ok(importedArtifact);
  const chatFolder = join(dataDirectory, 'chats', chat.id);
  await rm(chatFolder, { recursive: true });
  await symlink(outside, chatFolder, 'junction');
  await assert.rejects(store.getArtifactPath(chat.id, importedArtifact.id), /символическую ссылку/);
  await assert.rejects(store.getChatFolder(chat.id), /символическую ссылку/);
  await assert.rejects(store.deleteChat(chat.id), /символическую ссылку/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside');
});

test('cancellation during a committed prepared-Skill save clears pending use before the first provider step and releases FIFO', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-skill-pending-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro', nextTurnSkillId: 'global/review' });
  const first = await store.acceptLocalMessage(chat.id, 'Отменить до первого шага.', 'turn-skill-cancel-before-next');
  await store.updateChat(chat.id, { nextTurnSkillId: null });
  const second = await store.acceptLocalMessage(chat.id, 'Следующий ход.', 'turn-skill-cancel-next');
  const pendingSaved = deferred();
  const saveGate = deferred();
  const secondTerminal = deferred();
  const firstIteratorSteps: string[] = [];
  const provider: GigaChatProvider = {
    stream: async function* (request): AsyncGenerator<ProviderEvent> {
      const prompt = request.messages[request.messages.length - 1]?.text ?? '';
      firstIteratorSteps.push(prompt);
      yield { type: 'text-delta', text: `Ответ: ${prompt}` };
      yield { type: 'completed' };
    },
  };
  let heldPendingSave = false;
  const runtime = createTurnRuntime({
    provider,
    tools: {} as never,
    prepareTurn: async (turn) => ({
      system: turn.skillId ? [{ source: 'skill' as const, label: 'Skill', text: 'Инструкции Skill.' }] : [],
      messages: structuredClone(turn.messages),
      modelId: turn.modelId,
      permissionProfile: turn.permissionProfile,
    }),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: async (snapshot) => {
      await store.updateRuntimeTurn(snapshot);
      if (!heldPendingSave && snapshot.id === first.turn.turnId && snapshot.status === 'running'
        && snapshot.pendingSkillId === 'global/review' && snapshot.invokedSkillId === null) {
        heldPendingSave = true;
        pendingSaved.resolve();
        await saveGate.promise;
      }
    },
    recordUsageReceipt: (receipt) => store.recordUsageReceipt(receipt),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn!, signal, functionsStateId);
    },
    onUpdate: (snapshot) => {
      if (snapshot.id === second.turn.turnId && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
        secondTerminal.resolve();
      }
    },
  });

  const firstRuntimeId = runtime.enqueue(first.turn);
  assert.ok(firstRuntimeId);
  assert.ok(runtime.enqueue(second.turn));
  await pendingSaved.promise;
  const beforeCancel = await store.getChat(chat.id);
  const pendingRecord = beforeCancel.turns.find((turn) => turn.turnId === first.turn.turnId);
  assert.equal(pendingRecord?.pendingSkillId, 'global/review', 'the pending marker is durably committed before cancellation');
  assert.equal(pendingRecord?.invokedSkillId, null);
  assert.equal(firstIteratorSteps.length, 0);

  assert.equal(runtime.cancel(firstRuntimeId), true);
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);
  saveGate.resolve();
  await secondTerminal.promise;
  await runtime.whenIdle();

  const reloaded = await openStore(directory);
  const detail = await reloaded.getChat(chat.id);
  const cancelled = detail.turns.find((turn) => turn.turnId === first.turn.turnId);
  const completed = detail.turns.find((turn) => turn.turnId === second.turn.turnId);
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.pendingSkillId, null);
  assert.equal(cancelled?.invokedSkillId, null, 'cancellation before iterator.next is a known non-invocation');
  assert.equal(completed?.status, 'completed');
  assert.deepEqual(firstIteratorSteps, ['Следующий ход.']);
  const view = await reloaded.getUsageProfileView(0);
  assert.equal(view.skills.invocationCount, 0);
  assert.equal(view.skills.unknownTurnCount, 0);
});

test('confirms one durable Skill invocation across provider tool continuations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-skill-confirmed-continuation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro', nextTurnSkillId: 'global/review' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Прочитай файл.', 'turn-skill-continuation');
  const requests: ProviderTurnRequest[] = [];
  const provider: GigaChatProvider = {
    stream: async function* (request): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield {
          type: 'function-call',
          functionCall: {
            name: 'read', arguments: { path: 'fixture.txt' }, content: null,
            functionsStateId: 'skill-continuation-state', terminalReason: 'function_call',
          },
        };
        return;
      }
      yield { type: 'text-delta', text: 'Файл прочитан.' };
      yield { type: 'completed' };
    },
  };
  const runtime = createTurnRuntime({
    provider,
    tools: { read: async () => 'synthetic fixture bytes' } as never,
    prepareTurn: async (turn) => ({
      system: turn.skillId ? [{ source: 'skill' as const, label: 'Skill', text: 'Инструкции Skill.' }] : [],
      messages: structuredClone(turn.messages),
      modelId: turn.modelId,
      permissionProfile: turn.permissionProfile,
    }),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    recordUsageReceipt: (receipt) => store.recordUsageReceipt(receipt),
    beginToolReceipt: (turn, receipt) => store.beginToolReceipt(turn.chatId, turn.messageId, receipt),
    completeToolReceipt: (turn, receiptId, status, result) => store.completeToolReceipt(turn.chatId, turn.messageId, receiptId, status, result),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn!, signal, functionsStateId);
    },
  });

  assert.ok(runtime.enqueue(accepted.turn));
  await runtime.whenIdle();

  const reloaded = await openStore(directory);
  const detail = await reloaded.getChat(chat.id);
  const turn = detail.turns.find((item) => item.turnId === accepted.turn.turnId);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.system.some((layer) => layer.source === 'skill')));
  assert.equal(turn?.status, 'completed');
  assert.equal(turn?.pendingSkillId, null);
  assert.equal(turn?.invokedSkillId, 'global/review');
  assert.equal((await reloaded.getUsageProfileView(0)).skills.invocationCount, 1);
  assert.ok(turn && turn.status === 'completed');
  const tampered: RuntimeTurnSnapshot = {
    id: turn.turnId, chatId: chat.id, anchorMessageId: turn.anchorMessageId,
    assistantMessageId: turn.assistantMessageId, modelId: turn.modelId, status: 'completed',
    createdAt: turn.createdAt,
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    ...(turn.queueDurationMs === undefined ? {} : { queueDurationMs: turn.queueDurationMs }),
    ...(turn.activeDurationMs === undefined ? {} : { activeDurationMs: turn.activeDurationMs }),
    pendingSkillId: null, invokedSkillId: 'global/another-skill', activity: turn.activity,
  };
  await assert.rejects(reloaded.updateRuntimeTurn(tampered), /Фактически использованный Skill не может быть изменён/);
  assert.equal((await reloaded.getChat(chat.id)).turns.find((item) => item.turnId === turn.turnId)?.invokedSkillId,
    'global/review', 'the rejected update must preserve the immutable confirmed Skill ID');
});

test('observes a rejected first provider step while durable Skill confirmation is pending', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-skill-next-rejection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro', nextTurnSkillId: 'global/review' });
  const first = await store.acceptLocalMessage(chat.id, 'Первый запрос завершится транспортной ошибкой.', 'turn-skill-next-reject');
  await store.updateChat(chat.id, { nextTurnSkillId: null });
  const second = await store.acceptLocalMessage(chat.id, 'Следующий запрос должен продолжиться.', 'turn-skill-next-after-reject');
  const confirmationCommitted = deferred();
  const confirmationGate = deferred();
  const firstStepInvoked = deferred();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  let heldConfirmation = false;
  const provider: GigaChatProvider = {
    stream: async function* (request): AsyncGenerator<ProviderEvent> {
      const prompt = request.messages[request.messages.length - 1]?.text ?? '';
      if (prompt === 'Первый запрос завершится транспортной ошибкой.') {
        firstStepInvoked.resolve();
        throw new Error('synthetic immediate provider rejection');
      }
      yield { type: 'text-delta', text: 'Второй ответ.' };
      yield { type: 'completed' };
    },
  };
  const runtime = createTurnRuntime({
    provider,
    tools: {} as never,
    prepareTurn: async (turn) => ({
      system: turn.skillId ? [{ source: 'skill' as const, label: 'Skill', text: 'Инструкции Skill.' }] : [],
      messages: structuredClone(turn.messages),
      modelId: turn.modelId,
      permissionProfile: turn.permissionProfile,
    }),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: async (snapshot) => {
      await store.updateRuntimeTurn(snapshot);
      if (!heldConfirmation && snapshot.id === first.turn.turnId && snapshot.invokedSkillId === 'global/review'
        && snapshot.pendingSkillId === null && snapshot.status === 'running') {
        heldConfirmation = true;
        confirmationCommitted.resolve();
        await confirmationGate.promise;
      }
    },
    recordUsageReceipt: (receipt) => store.recordUsageReceipt(receipt),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn!, signal, functionsStateId);
    },
  });

  assert.ok(runtime.enqueue(first.turn));
  assert.ok(runtime.enqueue(second.turn));
  await confirmationCommitted.promise;
  await firstStepInvoked.promise;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(unhandled, [], 'the first next() rejection is observed during the delayed durable confirmation');
  confirmationGate.resolve();
  await runtime.whenIdle();

  const reloaded = await openStore(directory);
  const detail = await reloaded.getChat(chat.id);
  const failed = detail.turns.find((turn) => turn.turnId === first.turn.turnId);
  const completed = detail.turns.find((turn) => turn.turnId === second.turn.turnId);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.invokedSkillId, 'global/review', 'the Skill is confirmed once iterator.next() was invoked, even if it rejects immediately');
  assert.equal(failed?.pendingSkillId, null);
  assert.equal(completed?.status, 'completed');
  assert.equal((await reloaded.getUsageProfileView(0)).skills.invocationCount, 1);
});

test('reload preserves an interrupted pending Skill as unknown instead of recording a false invocation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-skill-pending-interrupted-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Возможный вызов.', 'turn-skill-pending-interrupted');
  const running: RuntimeTurnSnapshot = {
    id: accepted.turn.turnId, chatId: chat.id, anchorMessageId: accepted.turn.messageId,
    assistantMessageId: accepted.turn.assistantMessageId, modelId: accepted.turn.modelId,
    status: 'running', createdAt: accepted.turn.messages[accepted.turn.messages.length - 1]!.createdAt,
    startedAt: timestamp, pendingSkillId: 'global/review', invokedSkillId: null, activity: [],
  };
  await store.updateRuntimeTurn(running);

  const reloaded = await openStore(directory);
  const detail = await reloaded.getChat(chat.id);
  const recovered = detail.turns.find((turn) => turn.turnId === accepted.turn.turnId);
  assert.equal(recovered?.status, 'interrupted');
  assert.equal(recovered?.pendingSkillId, 'global/review');
  assert.equal(recovered?.invokedSkillId, null);
  const view = await reloaded.getUsageProfileView(0);
  assert.equal(view.skills.invocationCount, 0);
  assert.equal(view.skills.unknownTurnCount, 1);
});
