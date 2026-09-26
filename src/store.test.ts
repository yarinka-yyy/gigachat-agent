import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  const savedChat = await store.updateChat(chat.id, { draft: 'Черновик', title: 'Проверка' });
  await store.updateSettings({
    theme: 'warm',
    sidebarTransparent: true,
    sidebarVisible: false,
    defaultProjectsFolder: 'C:\\projects',
    preferredOpener: 'explorer',
  });

  const restored = await openStore(directory);
  assert.deepEqual(await restored.listProjects(), [updatedProject]);
  assert.deepEqual(new Set((await restored.listChats()).map((item) => item.id)), new Set([savedChat.id, imageChat.id]));
  assert.equal((await restored.getChat(chat.id)).draft, 'Черновик');
  assert.equal((await restored.getChat(chat.id)).projectId, project.id);
  assert.equal((await restored.getChat(imageChat.id)).kind, 'image');
  assert.deepEqual(await restored.getSettings(), {
    theme: 'warm',
    sidebarTransparent: true,
    sidebarVisible: false,
    defaultProjectsFolder: 'C:\\projects',
    preferredOpener: 'explorer',
  });
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
  assert.deepEqual(await store.getChat(chat.id), { ...chat, kind: 'text', messages: [], artifacts: [] });
  assert.deepEqual(await store.getSettings(), {
    theme: 'emerald',
    sidebarTransparent: false,
    sidebarVisible: true,
    defaultProjectsFolder: null,
    preferredOpener: 'system',
  });
  assert.equal(JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8')).schemaVersion, 2);
  assert.equal(JSON.parse(await readFile(join(directory, 'chats.json'), 'utf8')).schemaVersion, 1);
  assert.equal(await readFile(join(directory, 'chats.json.bak'), 'utf8'), await readFile(join(directory, 'chats.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(directory, 'chats', chat.id, 'chat.json'), 'utf8')).schemaVersion, 3);
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).schemaVersion, 3);
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
  assert.deepEqual(await store.getChat(chat.id), { ...chat, messages: [], artifacts: [] });
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
    defaultProjectsFolder: null, preferredOpener: 'system',
  };
  await writeFile(settingsPath, JSON.stringify({ schemaVersion: 2, settings: oldSettings }));
  const store = await openStore(directory);
  assert.deepEqual(await store.getSettings(), { ...oldSettings, theme: 'emerald' });
  await store.updateSettings({ theme: 'dark' });
  const restored = await openStore(directory);
  assert.equal((await restored.getSettings()).theme, 'dark');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).schemaVersion, 3);
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
