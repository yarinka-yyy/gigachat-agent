import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openStore as openStoreProduction, type StoreFaultStage, type StoreOpenOptions } from './store';
import type { GigaChatProvider, InstructionCommitRequest, InstructionCommitResult, ProviderTurnRequest } from './contracts';
import { instructionFileHash } from './instruction-documents';
import { createTurnRuntime } from './runtime';

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
  const updated = await store.appendAssistantMessageFromRuntime(chat.id, first.turn.messageId, 'answer1');
  assert.deepEqual(updated.messages.map((message) => message.text), ['user1', 'answer1', 'user2', 'user3']);
  assert.equal(updated.messages[1]?.source, 'runtime');
  assert.deepEqual((await store.getMessagesThrough(chat.id, second.turn.messageId)).map((message) => message.text), [
    'user1', 'answer1', 'user2',
  ]);
  for (const turn of [first.turn, second.turn, third.turn]) store.releaseTurnReservation(turn.turnId);
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
    appendAssistant: async (turn, text, signal) => {
      await store.appendAssistantMessageFromRuntime(turn.chatId, turn.messageId, text, signal);
    },
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
  assert.deepEqual(await store.getChat(chat.id), { ...chat, kind: 'text', nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [], toolReceipts: [] });
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
  assert.equal(JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')).schemaVersion, 7);
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
  assert.deepEqual(await store.getChat(chat.id), { ...chat, nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [], toolReceipts: [] });
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
      if (contents !== null) assert.equal(await readFile(detailPath, 'utf8'), contents, 'existing bytes must survive migration');
      if (kind === 'valid' || kind === 'missing') {
        const restored = await store.getChat(legacy.id);
        assert.equal(restored.draft, kind === 'valid' ? 'newer draft' : 'legacy draft');
        assert.deepEqual(restored.messages, kind === 'valid' ? detail.messages : []);
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
  await store.updateChat(chat.id, { draft: 'Черновик остаётся' });
  const detail = await store.appendAssistantMessageFromRuntime(chat.id, accepted.turn.messageId, 'Ответ провайдера', undefined, 'state-final');
  assert.equal(detail.messages[1]?.role, 'assistant');
  assert.equal(detail.messages[1]?.source, 'runtime');
  assert.equal(detail.messages[1]?.text, 'Ответ провайдера');
  assert.equal(detail.messages[1]?.functionsStateId, 'state-final');
  assert.equal(detail.draft, 'Черновик остаётся');
  assert.deepEqual((await (await openStore(directory)).getChat(chat.id)).messages, detail.messages);
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

test('migrates existing chat detail schema 3 and preserves its draft', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-chat-detail-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Сохранённый черновик' });
  const path = join(directory, 'chats', chat.id, 'chat.json');
  const oldDetail = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  oldDetail.schemaVersion = 3;
  delete oldDetail.nextTurnPermissionProfile;
  await writeFile(path, JSON.stringify(oldDetail));

  const restored = await openStore(directory);
  assert.equal((await restored.getChat(chat.id)).draft, 'Сохранённый черновик');
  assert.equal((await restored.getChat(chat.id)).nextTurnPermissionProfile, null);
  const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(migrated.schemaVersion, 7);
  assert.equal(migrated.nextTurnPermissionProfile, null);
  assert.equal(migrated.nextTurnSkillId, null);
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
  delete oldDetail.nextTurnSkillId;
  await writeFile(path, JSON.stringify(oldDetail));

  const restored = await openStore(directory);
  const detail = await restored.getChat(chat.id);
  assert.equal(detail.nextTurnPermissionProfile, 'ask');
  assert.equal(detail.nextTurnSkillId, null);
  assert.equal(detail.draft, 'Черновик');
  assert.equal(detail.messages[0]?.text, 'Сохранённая история');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 7);
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
  delete oldChat.modelId;
  oldSettings.schemaVersion = 6;
  delete oldSettings.settings.defaultModelId;
  await writeFile(chatPath, JSON.stringify(oldChat));
  await writeFile(settingsPath, JSON.stringify(oldSettings));
  const restored = await openStore(directory);
  assert.equal((await restored.getChat(chat.id)).modelId, null);
  assert.equal((await restored.getSettings()).defaultModelId, null);
  assert.equal((await restored.getSettings()).microphoneConsent, 'unasked');
  assert.equal(JSON.parse(await readFile(chatPath, 'utf8')).schemaVersion, 7);
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
  await store.appendLocalMessage(firstChat.id, 'История первого чата');
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
  const beforeFirst = JSON.parse(await readFile(firstChatPath, 'utf8')) as Record<string, unknown>;
  const beforeSecond = JSON.parse(await readFile(secondChatPath, 'utf8')) as Record<string, unknown>;
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
  const chatDetail = JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')) as Record<string, unknown>;
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
    await store.appendLocalMessage(firstChat.id, 'first history');
    await store.appendLocalMessage(secondChat.id, 'second history');

    await assert.rejects(store.deleteProject(project.id), new RegExp(`synthetic ${stage}`),
      `fault injection did not reject at ${stage}:${index ?? '-'} (callback reached: ${injected})`);
    const recovered = await openStore(dataDirectory);
    assert.deepEqual(await recovered.listProjects(), [], `${stage}:${index ?? '-'} project`);
    assert.equal((await recovered.getChat(firstChat.id)).projectId, null, `${stage}:${index ?? '-'} first chat`);
    assert.equal((await recovered.getChat(firstChat.id)).messages[0]?.text, 'first history');
    assert.equal((await recovered.getChat(secondChat.id)).projectId, null, `${stage}:${index ?? '-'} second chat`);
    assert.equal((await recovered.getChat(secondChat.id)).messages[0]?.text, 'second history');
    await assert.rejects(stat(join(dataDirectory, 'project-delete.journal.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(workingFolder, 'keep.txt'), 'utf8'), 'external sentinel');
    assert.equal(await readFile(join(workingFolder, 'AGENTS.md'), 'utf8'), 'project rules');
    assert.deepEqual(await store.listProjects(), [], `${stage}:${index ?? '-'} same-store retry`);
    const repeated = await openStore(dataDirectory);
    assert.deepEqual(await repeated.listProjects(), []);
    assert.equal((await repeated.getChat(firstChat.id)).messages[0]?.text, 'first history');
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
