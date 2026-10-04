import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createNumberedProjectFolder, prepareProjectFolders } from './project-folders';
import type { InstructionCommitRequest, InstructionCommitResult } from './contracts';
import { openStore as openStoreProduction } from './store';
import { instructionFileHash } from './instruction-documents';

const syntheticInstructionCommitter = async (request: InstructionCommitRequest): Promise<InstructionCommitResult> => {
  const target = join(request.workingFolder, request.relativePath);
  const currentBytes = await readFile(target).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  const currentText = currentBytes === null ? null : currentBytes.toString('utf8');
  if (instructionFileHash(currentText) !== request.expectedHash) return { kind: 'conflict-before', currentText };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, request.contents, 'utf8');
  return { kind: 'saved' };
};

function openStore(directory: string) {
  return openStoreProduction(directory, { instructionCommitter: syntheticInstructionCommitter });
}

test('automatic folders and migrated projects stay inside the app-owned Projects folder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-project-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = join(root, 'Documents');
  await mkdir(documents);
  const projectsRoot = join(documents, 'GigaChat Agent', 'Projects');
  await mkdir(join(projectsRoot, 'GigaChat Project 1'), { recursive: true });
  assert.equal(await createNumberedProjectFolder(documents), join(projectsRoot, 'GigaChat Project 2'));
  assert.deepEqual(await readdir(documents), ['GigaChat Agent']);
  const store = await openStore(join(root, 'data'));
  const project = await store.createProject('Старый');
  const initialInstructions = await store.readProjectInstructionDocument(project.id);
  await store.saveProjectInstructions(project.id, 'Старые правила', initialInstructions.revision);
  assert.deepEqual(await prepareProjectFolders(store, documents), []);
  const folder = (await store.listProjects())[0]?.workingFolder;
  assert.ok(folder);
  assert.equal(folder, join(projectsRoot, 'GigaChat Project 3'));
  assert.deepEqual(await readdir(documents), ['GigaChat Agent']);
  assert.deepEqual(await readdir(projectsRoot), ['GigaChat Project 1', 'GigaChat Project 2', 'GigaChat Project 3']);
  assert.equal(await readFile(join(folder, 'AGENTS.md'), 'utf8'), 'Старые правила');
  assert.ok(await store.projectInstructionsBackupPath(project.id));
  assert.deepEqual(await prepareProjectFolders(store, documents), []);
  assert.equal((await store.listProjects())[0]?.workingFolder, folder);
});

test('refuses a junction inside the automatic-folder container without writing outside it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-project-folder-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = join(root, 'Documents');
  const outside = join(root, 'outside');
  const appRoot = join(documents, 'GigaChat Agent');
  await mkdir(appRoot, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(appRoot, 'Projects'), 'junction');

  await assert.rejects(createNumberedProjectFolder(documents), /ссылку|junction/i);
  assert.deepEqual(await readdir(outside), []);
});

test('existing folder AGENTS.md wins and legacy text is retained', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-project-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'workspace');
  await mkdir(folder);
  await writeFile(join(folder, 'AGENTS.md'), 'Правила из папки');
  const store = await openStore(join(root, 'data'));
  const project = await store.createProject('Конфликт');
  const initialInstructions = await store.readProjectInstructionDocument(project.id);
  await store.saveProjectInstructions(project.id, 'Старые правила', initialInstructions.revision);
  await store.updateProject(project.id, { workingFolder: folder });
  assert.equal(await store.readProjectInstructions(project.id), 'Правила из папки');
  const backup = await store.projectInstructionsBackupPath(project.id);
  assert.ok(backup);
  assert.equal(await readFile(backup, 'utf8'), 'Старые правила');
  await writeFile(join(folder, 'AGENTS.md'), 'Изменено вне приложения');
  assert.equal(await store.readProjectInstructions(project.id), 'Изменено вне приложения');
  const updatedInstructions = await store.readProjectInstructionDocument(project.id);
  await store.saveProjectInstructions(project.id, 'Новые правила', updatedInstructions.revision);
  assert.equal(await readFile(join(folder, 'AGENTS.md'), 'utf8'), 'Новые правила');
  assert.equal(await readFile(backup, 'utf8'), 'Старые правила');
});

test('reports an instruction-transfer warning while keeping a newly assigned folder bound', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-project-folder-warning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = join(root, 'Documents');
  const profile = join(root, 'data');
  await mkdir(documents);
  const store = await openStoreProduction(profile);
  const project = await store.createProject('Старый проект');
  const legacyPath = join(profile, 'project-instructions', project.id, 'AGENTS.md');
  await mkdir(join(profile, 'project-instructions', project.id), { recursive: true });
  await writeFile(legacyPath, 'legacy project rules');

  const issues = await prepareProjectFolders(store, documents);
  const updated = (await store.listProjects()).find((item) => item.id === project.id);

  assert.ok(updated?.workingFolder);
  assert.equal(await readFile(legacyPath, 'utf8'), 'legacy project rules');
  assert.match(issues.join('\n'), /writer недоступен/i);
  await assert.rejects(readFile(join(updated.workingFolder, 'AGENTS.md'), 'utf8'), { code: 'ENOENT' });
});
