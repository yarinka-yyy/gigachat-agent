import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateProjectFolder, validateProjectInstructionsPath } from './project-paths';
import { createNumberedProjectFolder } from './project-folders';

test('accepts a direct project folder and returns its canonical path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-path-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'project');
  await mkdir(folder);

  assert.equal(await validateProjectFolder(folder), folder);
  assert.equal(await validateProjectInstructionsPath(folder), join(folder, 'AGENTS.md'));
});

test('rejects a symlinked project root and parent without following them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-path-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  const project = join(outside, 'project');
  const linkedRoot = join(root, 'linked-root');
  await mkdir(project, { recursive: true });
  await symlink(outside, linkedRoot, 'junction');

  await assert.rejects(validateProjectFolder(linkedRoot), /ссылку|junction/i);
  await assert.rejects(validateProjectFolder(join(linkedRoot, 'project')), /ссылку|junction/i);
});

test('allows only the supplied redirected Documents root and returns its physical path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-path-documents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physicalDocuments = join(root, 'physical-documents');
  const documentsAlias = join(root, 'Documents');
  const project = join(physicalDocuments, 'GigaChat Project 1');
  await mkdir(project, { recursive: true });
  await symlink(physicalDocuments, documentsAlias, 'junction');

  assert.equal(await validateProjectFolder(documentsAlias, documentsAlias), physicalDocuments);
  assert.equal(await validateProjectFolder(join(documentsAlias, 'GigaChat Project 1'), documentsAlias), project);
  const created = await createNumberedProjectFolder(documentsAlias);
  assert.equal(created, join(physicalDocuments, 'GigaChat Agent', 'Projects', 'GigaChat Project 1'));
  assert.equal((await lstat(created)).isDirectory(), true);
  await assert.rejects(lstat(join(physicalDocuments, 'GigaChat Project 2')), { code: 'ENOENT' });
  await assert.rejects(validateProjectFolder(join(documentsAlias, 'GigaChat Project 1')),
    /ссылку|junction/i);
});

test('does not require Documents to validate a project outside Documents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-path-missing-documents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentsAlias = join(root, 'missing-documents');
  const externalProject = join(root, 'external-project');
  await mkdir(externalProject);

  assert.equal(await validateProjectFolder(externalProject, documentsAlias), externalProject);
});

test('canonicalizes a redirected Documents path with a junctioned ancestor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-path-documents-ancestor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physicalProfile = join(root, 'physical-profile');
  const documentsAliasParent = join(root, 'profile-alias');
  const physicalDocuments = join(physicalProfile, 'Documents');
  const documentsAlias = join(documentsAliasParent, 'Documents');
  const project = join(physicalDocuments, 'GigaChat Project 1');
  await mkdir(project, { recursive: true });
  await symlink(physicalProfile, documentsAliasParent, 'junction');

  assert.equal(await validateProjectFolder(documentsAlias, documentsAlias), physicalDocuments);
  assert.equal(await validateProjectFolder(join(documentsAlias, 'GigaChat Project 1'), documentsAlias), project);
});

test('rejects a junction at AGENTS.md and preserves the target outside the project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-path-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel.txt'), 'outside sentinel');
  await symlink(outside, join(project, 'AGENTS.md'), 'junction');

  await assert.rejects(validateProjectInstructionsPath(project), /обычным файлом|ссылкой/i);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel');
});
