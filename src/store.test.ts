import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(await restored.listChats(), [savedChat, imageChat]);
  assert.equal((await restored.listChats())[0]?.projectId, project.id);
  assert.equal((await restored.listChats())[1]?.kind, 'image');
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
  assert.deepEqual(await store.listChats(), [{ ...chat, kind: 'text' }]);
  assert.deepEqual(await store.getSettings(), {
    theme: 'emerald',
    sidebarTransparent: false,
    sidebarVisible: true,
    defaultProjectsFolder: null,
    preferredOpener: 'system',
  });
  for (const name of ['projects.json', 'chats.json']) {
    assert.equal(JSON.parse(await readFile(join(directory, name), 'utf8')).schemaVersion, 2);
  }
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).schemaVersion, 3);
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
