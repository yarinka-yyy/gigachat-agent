import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Project } from './contracts';
import { createSkillRegistry, parseSkillMarkdown } from './skills';

const project: Project = {
  id: 'project-1', name: 'Рабочий проект', pinned: false, archived: false,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', workingFolder: null,
};

async function createFixture(t: { after(callback: () => void | Promise<void>): void }) {
  const userDataPath = await mkdtemp(join(tmpdir(), 'gigachat-skills-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const registry = createSkillRegistry({ userDataPath, listProjects: async () => [project] });
  return { userDataPath, registry };
}

async function addSkill(userDataPath: string, scope: 'global' | 'project', slug: string, contents: string): Promise<void> {
  const folder = scope === 'global'
    ? join(userDataPath, 'skills', 'global', slug)
    : join(userDataPath, 'skills', 'projects', project.id, slug);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'SKILL.md'), contents, 'utf8');
}

const reviewSkill = `---
name: Review
description: Проверка изменений
---
Проверяй только факты из diff.
`;

test('discovers app-owned Global and Project Skills and reads source only on request', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addSkill(userDataPath, 'global', 'review', reviewSkill);
  await addSkill(userDataPath, 'project', 'review', reviewSkill.replace('Review', 'Project Review'));

  const snapshot = await registry.list();
  assert.deepEqual(snapshot.skills.map(({ id, scope, projectName, enabled }) => ({ id, scope, projectName, enabled })), [
    { id: 'global/review', scope: 'global', projectName: null, enabled: false },
    { id: `project/${project.id}/review`, scope: 'project', projectName: project.name, enabled: false },
  ]);
  assert.equal(snapshot.issues.length, 0);
  assert.equal((await registry.getEnabled('global/review')), null);
  assert.match((await registry.readSource('global/review')).contents, /Проверяй только факты/);
  assert.equal(await registry.openFolder('global'), join(userDataPath, 'skills', 'global'));
  assert.equal(await registry.openFolder('project', project.id), join(userDataPath, 'skills', 'projects', project.id));
});

test('enables validated Skills, serializes rapid changes, and stops offering a removed source', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addSkill(userDataPath, 'global', 'review', reviewSkill);
  await registry.setEnabled('global/review', true);
  assert.equal((await registry.getEnabled('global/review'))?.instructions, 'Проверяй только факты из diff.');

  await Promise.all([
    registry.setEnabled('global/review', true),
    registry.setEnabled('global/review', false),
  ]);
  assert.equal((await registry.list()).skills[0]?.enabled, false);
  await assert.rejects(registry.setEnabled('global/../outside', true));

  await rm(join(userDataPath, 'skills', 'global', 'review'), { recursive: true });
  assert.deepEqual((await registry.list()).skills, []);
  assert.equal(await registry.getEnabled('global/review'), null);
  await assert.rejects(registry.setEnabled('global/review', true), /не найден/);
});

test('read-only selected Skill lookup leaves the registry and unrelated missing roots untouched', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  const sourcePath = join(userDataPath, 'skills', 'global', 'review', 'SKILL.md');
  const enabledPath = join(userDataPath, 'skills', 'enabled.json');
  const unrelatedProjectRoot = join(userDataPath, 'skills', 'projects', project.id);
  const contents = reviewSkill;
  const enabledContents = `${JSON.stringify({ schemaVersion: 1, enabled: ['global/review', 'global/missing'] }, null, 2)}\n`;
  await mkdir(join(userDataPath, 'skills', 'global', 'review'), { recursive: true });
  await writeFile(sourcePath, contents, 'utf8');
  await writeFile(enabledPath, enabledContents, 'utf8');

  const selected = await registry.getEnabledReadOnly('global/review');
  assert.equal(selected?.instructions, 'Проверяй только факты из diff.');
  assert.equal(await registry.getEnabledReadOnly('global/missing'), null);
  assert.equal((await lstat(unrelatedProjectRoot).catch(() => null)), null,
    'a selected global Skill lookup does not provision unrelated project directories');
  assert.equal(await readFile(sourcePath, 'utf8'), contents);
  assert.equal(await readFile(enabledPath, 'utf8'), enabledContents);
  await assert.rejects(lstat(join(userDataPath, 'skills', 'global', 'missing')),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT');
});

test('does not follow a junction outside the app-owned registry', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'gigachat-skills-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'SKILL.md'), reviewSkill, 'utf8');
  const globalRoot = join(userDataPath, 'skills', 'global');
  await mkdir(globalRoot, { recursive: true });
  await symlink(outside, join(globalRoot, 'external'), 'junction');

  const snapshot = await registry.list();
  assert.deepEqual(snapshot.skills, []);
  assert.deepEqual(snapshot.issues, []);
});

test('accepts only the bounded name/description frontmatter format', () => {
  assert.deepEqual(parseSkillMarkdown(reviewSkill), {
    name: 'Review', description: 'Проверка изменений', instructions: 'Проверяй только факты из diff.',
  });
  assert.throws(() => parseSkillMarkdown('# no metadata'), /YAML-заголовке/);
  assert.throws(() => parseSkillMarkdown(reviewSkill.replace('description:', 'description:\ndescription:')));
  assert.throws(() => parseSkillMarkdown(`${reviewSkill}${'x'.repeat(64 * 1024)}`), /64 КБ/);
});
