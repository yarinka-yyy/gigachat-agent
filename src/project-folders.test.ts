import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNumberedProjectFolder, prepareProjectFolders } from './project-folders';
import { openStore } from './store';

test('numbered folders skip occupied names and project migration is repeatable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-project-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = join(root, 'Documents');
  await mkdir(documents);
  await mkdir(join(documents, 'GigaChat Project 1'));
  assert.equal(await createNumberedProjectFolder(documents), join(documents, 'GigaChat Project 2'));
  const store = await openStore(join(root, 'data'));
  const project = await store.createProject('Старый');
  await store.saveProjectInstructions(project.id, 'Старые правила');
  assert.deepEqual(await prepareProjectFolders(store, documents), []);
  const folder = (await store.listProjects())[0]?.workingFolder;
  assert.ok(folder);
  assert.equal(folder, join(documents, 'GigaChat Project 3'));
  assert.equal(await readFile(join(folder, 'AGENTS.md'), 'utf8'), 'Старые правила');
  assert.ok(await store.projectInstructionsBackupPath(project.id));
  assert.deepEqual(await prepareProjectFolders(store, documents), []);
  assert.equal((await store.listProjects())[0]?.workingFolder, folder);
});

test('existing folder AGENTS.md wins and legacy text is retained', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-project-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'workspace');
  await mkdir(folder);
  await writeFile(join(folder, 'AGENTS.md'), 'Правила из папки');
  const store = await openStore(join(root, 'data'));
  const project = await store.createProject('Конфликт');
  await store.saveProjectInstructions(project.id, 'Старые правила');
  await store.updateProject(project.id, { workingFolder: folder });
  assert.equal(await store.readProjectInstructions(project.id), 'Правила из папки');
  const backup = await store.projectInstructionsBackupPath(project.id);
  assert.ok(backup);
  assert.equal(await readFile(backup, 'utf8'), 'Старые правила');
  await writeFile(join(folder, 'AGENTS.md'), 'Изменено вне приложения');
  assert.equal(await store.readProjectInstructions(project.id), 'Изменено вне приложения');
  await store.saveProjectInstructions(project.id, 'Новые правила');
  assert.equal(await readFile(join(folder, 'AGENTS.md'), 'utf8'), 'Новые правила');
  assert.equal(await readFile(backup, 'utf8'), 'Старые правила');
});
