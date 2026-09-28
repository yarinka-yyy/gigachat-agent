import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from './store';

const timestamp = '2026-09-24T10:00:00.000Z';

test('persists projects, chats, relationships, drafts, image kind, and settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await openStore(directory);
  const project = await store.createProject('Локальный проект');
  const updatedProject = await store.updateProject(project.id, { workingFolder: 'C:\\work' });
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
    browserTabs: [{ id: 'tab-one', title: 'Пример', url: 'https://example.com/' }],
    browserActiveTabId: 'tab-one',
    defaultProjectsFolder: 'C:\\projects',
    preferredOpener: 'explorer',
    defaultPermissionProfile: 'approve',
    defaultModelId: 'GigaChat-2-Pro',
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
  await restored.updateChat(chat.id, { modelId: 'GigaChat-3-Ultra' });
  assert.equal((await (await openStore(directory)).getChat(chat.id)).modelId, 'GigaChat-3-Ultra');
  assert.equal((await restored.getChat(imageChat.id)).kind, 'image');
  assert.deepEqual(await restored.getSettings(), {
    theme: 'warm',
    sidebarTransparent: true,
    sidebarVisible: false,
    sidebarWidthPx: 320,
    browserPaneOpen: true,
    browserTabs: [{ id: 'tab-one', title: 'Пример', url: 'https://example.com/' }],
    browserActiveTabId: 'tab-one',
    defaultProjectsFolder: 'C:\\projects',
    preferredOpener: 'explorer',
    defaultPermissionProfile: 'approve',
    defaultModelId: 'GigaChat-2-Pro',
    onboardingCompleted: false,
    microphoneConsent: 'allowed',
    notifications: { taskStarted: true, taskCompleted: false, failures: true },
  });
  await assert.rejects(store.updateSettings({ defaultPermissionProfile: 'unknown' } as never));
  await assert.rejects(store.updateSettings({ notifications: { taskStarted: true, taskCompleted: false, failures: 'yes' } } as never));
  await assert.rejects(store.updateChat(chat.id, { nextTurnPermissionProfile: 'unknown' } as never));
  await assert.rejects(store.updateChat(chat.id, { nextTurnSkillId: 'global/../outside' } as never));
  await assert.rejects(store.updateChat(chat.id, { modelId: 'not-a-model' } as never));
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
  assert.deepEqual(await store.getChat(chat.id), { ...chat, kind: 'text', nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [] });
  assert.deepEqual(await store.getSettings(), {
    theme: 'emerald',
    sidebarTransparent: false,
    sidebarVisible: true,
    sidebarWidthPx: null,
    browserPaneOpen: false,
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
  assert.equal(JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')).schemaVersion, 6);
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).schemaVersion, 9);
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
  assert.deepEqual(await store.getChat(chat.id), { ...chat, nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [] });
  assert.equal((await store.listChats())[0]?.id, chat.id);
  assert.equal((await (await openStore(directory)).getChat(chat.id)).draft, 'Текст');
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

test('trusted runtime assistant append preserves draft and writes only a supplied completed response', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { draft: 'Черновик остаётся' });
  const detail = await store.appendAssistantMessageFromRuntime(chat.id, 'Ответ провайдера');
  assert.equal(detail.messages[0]?.role, 'assistant');
  assert.equal(detail.messages[0]?.text, 'Ответ провайдера');
  assert.equal(detail.draft, 'Черновик остаётся');
  assert.deepEqual((await (await openStore(directory)).getChat(chat.id)).messages, detail.messages);
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
  assert.equal(migrated.schemaVersion, 6);
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
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 6);
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
  assert.equal(JSON.parse(await readFile(chatPath, 'utf8')).schemaVersion, 6);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 9);
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
    browserTabs: [],
    browserActiveTabId: null,
    notifications: { taskStarted: false, taskCompleted: true, failures: true },
  });
  await store.updateSettings({ theme: 'dark' });
  const restored = await openStore(directory);
  assert.equal((await restored.getSettings()).theme, 'dark');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 9);
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
  assert.equal(JSON.parse(await readFile(join(existingDirectory, 'settings.json'), 'utf8')).schemaVersion, 9);
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
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 9);
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

  await store.saveGlobalInstructions('Глобальные правила');
  await store.saveProjectInstructions(project.id, 'Правила проекта');
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
  await Promise.all([
    store.saveGlobalInstructions('первая'),
    store.saveGlobalInstructions('последняя'),
    store.saveProjectInstructions(project.id, 'сначала'),
    store.saveProjectInstructions(project.id, 'потом'),
  ]);
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

test('deletes only project instructions and preserves chats, their files, and the working folder', async (t) => {
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
  await store.saveProjectInstructions(project.id, 'Инструкция проекта');
  const instructionsPath = join(dataDirectory, 'project-instructions', project.id, 'AGENTS.md');

  await store.deleteProject(project.id);

  await assert.rejects(stat(instructionsPath), { code: 'ENOENT' });
  assert.equal(await readFile(join(workingFolder, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(source, 'utf8'), 'source');
  const restored = await openStore(dataDirectory);
  assert.equal((await restored.listProjects()).length, 0);
  const preservedChat = await restored.getChat(chat.id);
  assert.equal(preservedChat.projectId, null);
  assert.equal(preservedChat.messages[0]?.text, 'История');
  assert.equal(preservedChat.artifacts[0]?.id, importedArtifact.id);
  assert.equal(await readFile(await restored.getArtifactPath(chat.id, importedArtifact.id), 'utf8'), 'source');
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
  await assert.rejects(store.saveProjectInstructions(project.id, 'не писать наружу'), /символическую ссылку/);
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
