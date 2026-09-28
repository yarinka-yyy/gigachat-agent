import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Project } from './contracts';
import { createHookRegistry, evaluateHookActivation, HOOK_EVENTS } from './hooks';
import type { SkillRecord } from './skills';

const project: Project = {
  id: 'project-1', name: 'Проект', pinned: false, archived: false,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', workingFolder: null,
};
const skill: SkillRecord = {
  id: 'global/review', name: 'Review', description: 'Проверка', command: 'review', scope: 'global',
  projectId: null, projectName: null, source: 'Global/review/SKILL.md', enabled: true,
};

async function createFixture(t: { after(callback: () => void | Promise<void>): void }) {
  const userDataPath = await mkdtemp(join(tmpdir(), 'gigachat-hooks-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const registry = createHookRegistry({
    userDataPath,
    listProjects: async () => [project],
    listSkills: async () => [skill],
  });
  return { userDataPath, registry };
}

async function addHook(userDataPath: string, folder: string, event: string, manifestPatch: Record<string, unknown> = {}): Promise<void> {
  const directory = join(userDataPath, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'hook.json'), JSON.stringify({
    schemaVersion: 1, name: 'Audit', description: 'Локальная проверка', event, actionFile: 'run.ps1', ...manifestPatch,
  }), 'utf8');
  await writeFile(join(directory, 'run.ps1'), 'Write-Output "not executed"', 'utf8');
}

test('scans actual Global, Project, Skill and Plugin hook records but never enables execution', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addHook(userDataPath, 'hooks/global/audit', 'user-prompt-submitted');
  await addHook(userDataPath, `hooks/projects/${project.id}/audit`, 'before-tool');
  await addHook(userDataPath, 'skills/global/review/hooks/audit', 'permission-request');
  await addHook(userDataPath, 'hooks/plugins/audit', 'session-start');

  const snapshot = await registry.list();
  assert.deepEqual(new Set(snapshot.hooks.map((hook) => hook.origin)), new Set(['global', 'project', 'skill', 'plugin']));
  assert.equal(snapshot.hooks.length, 4);
  assert.equal(snapshot.issues.length, 0);
  for (const hook of snapshot.hooks) {
    assert.equal(hook.enabled, false);
    assert.equal(hook.verified, false);
    assert.match(hook.unavailableReason, /отключено/);
    assert.equal(hook.actionFile, 'run.ps1');
  }
  assert.equal(HOOK_EVENTS.includes('permission-request'), true);
  assert.equal(evaluateHookActivation({ verified: false, profile: 'full', projectId: project.id, targetProjectId: project.id }).decision, 'deny');
  assert.equal(evaluateHookActivation({ verified: true, profile: 'full', projectId: project.id, targetProjectId: project.id }).decision, 'deny');
});

test('omits malformed hook manifests and reports bounded source errors', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addHook(userDataPath, 'hooks/global/bad', 'not-an-event');
  await addHook(userDataPath, 'hooks/global/missing', 'session-start', { actionFile: '..\\outside.ps1' });

  const snapshot = await registry.list();
  assert.deepEqual(snapshot.hooks, []);
  assert.equal(snapshot.issues.length, 2);
  assert.match(snapshot.issues[0]?.reason ?? '', /hook.json/);
});

test('does not enumerate a linked Hook container outside app-owned data', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'gigachat-hooks-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await addHook(outside, 'external', 'session-start');
  const hooksRoot = join(userDataPath, 'hooks');
  await mkdir(hooksRoot, { recursive: true });
  await symlink(outside, join(hooksRoot, 'global'), 'junction');

  const snapshot = await registry.list();
  assert.deepEqual(snapshot.hooks, []);
  assert.equal(snapshot.issues.some((issue) => /Global/.test(issue.source)), true);
});
