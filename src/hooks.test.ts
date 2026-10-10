import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Project } from './contracts';
import { createHookApprovalGate, createHookDispatcher, createHookRegistry, evaluateHookActivation, HOOK_EVENTS, HookDispatchAbortError, transitionProjectHookContext } from './hooks';
import { createLocalTools, createPowerShellHelper } from './local-tools';
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

async function addHook(userDataPath: string, folder: string, event: string, manifestPatch: Record<string, unknown> = {}, actionContents = 'Write-Output "not executed"'): Promise<void> {
  const directory = join(userDataPath, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'hook.json'), JSON.stringify({
    schemaVersion: 1, name: 'Audit', description: 'Локальная проверка', event, actionFile: 'run.ps1', ...manifestPatch,
  }), 'utf8');
  await writeFile(join(directory, 'run.ps1'), actionContents, 'utf8');
}

test('scans Global, Project, Skill and Plugin hook records without enabling or trusting them', async (t) => {
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
    assert.equal(hook.trusted, false);
    if (hook.origin === 'plugin') assert.match(hook.unavailableReason, /не поддерживаются/);
    else assert.match(hook.unavailableReason, /не доверен/);
    assert.equal(hook.actionFile, 'run.ps1');
  }
  assert.equal(snapshot.hooks.find((hook) => hook.origin === 'plugin')?.available, false);
  assert.equal(snapshot.hooks.find((hook) => hook.origin === 'skill')?.available, true);
  assert.equal(HOOK_EVENTS.includes('permission-request'), true);
  assert.equal(evaluateHookActivation({ verified: false, profile: 'full', projectId: project.id, targetProjectId: project.id }).decision, 'deny');
  assert.equal(evaluateHookActivation({ verified: true, profile: 'full', projectId: project.id, targetProjectId: project.id }).decision, 'deny');
});

test('trust is bound to the inspected manifest and action bytes and enablement is separate', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addHook(userDataPath, 'hooks/global/audit', 'user-prompt-submitted');
  const before = await registry.inspect('global/audit');
  assert.match(before.contentHash, /^[a-f0-9]{64}$/);

  await assert.rejects(registry.trust('global/audit', `${before.contentHash.slice(0, -1)}0`), /изменилось после просмотра/);
  await registry.trust('global/audit', before.contentHash);
  let record = (await registry.list()).hooks[0];
  assert.equal(record?.trusted, true);
  assert.equal(record?.enabled, false);
  assert.equal((await registry.getExecutable('user-prompt-submitted', { projectId: project.id, skillId: null })).length, 0);

  await registry.setEnabled('global/audit', true);
  record = (await registry.list()).hooks[0];
  assert.equal(record?.trusted, true);
  assert.equal(record?.enabled, true);
  const actions = await registry.getExecutable('user-prompt-submitted', { projectId: project.id, skillId: null });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.actionContents, 'Write-Output "not executed"');
  assert.equal(actions[0]?.contentHash, before.contentHash);

  await writeFile(join(userDataPath, 'hooks/global/audit/run.ps1'), 'Write-Output "changed"', 'utf8');
  record = (await registry.list()).hooks[0];
  assert.equal(record?.enabled, true);
  assert.equal(record?.trusted, false);
  assert.match(record?.unavailableReason ?? '', /не доверен/);
  assert.equal((await registry.getExecutable('user-prompt-submitted', { projectId: project.id, skillId: null })).length, 0);
  const stored = JSON.parse(await readFile(join(userDataPath, 'hooks/state.json'), 'utf8')) as { entries: Array<{ reviewedHash: string | null }> };
  assert.equal(stored.entries[0]?.reviewedHash, null);
});

test('trust rejects content changed after inspection and cannot enable disabled Skill hooks', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addHook(userDataPath, 'hooks/global/audit', 'session-start');
  const inspected = await registry.inspect('global/audit');
  await writeFile(join(userDataPath, 'hooks/global/audit/run.ps1'), 'Write-Output "new bytes"', 'utf8');
  await assert.rejects(registry.trust('global/audit', inspected.contentHash), /изменилось после просмотра/);

  const disabledRegistry = createHookRegistry({
    userDataPath,
    listProjects: async () => [project],
    listSkills: async () => [{ ...skill, enabled: false }],
  });
  await addHook(userDataPath, 'skills/global/review/hooks/audit', 'session-start');
  await assert.rejects(disabledRegistry.trust('skill/global/review/audit', (await disabledRegistry.inspect('skill/global/review/audit')).contentHash), /Включите Skill/);
  await assert.rejects(disabledRegistry.setEnabled('skill/global/review/audit', true), /Включите Skill/);
});

test('deleting a source revokes trust even when scanning reports the missing action', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  const actionPath = join(userDataPath, 'hooks/global/audit/run.ps1');
  await addHook(userDataPath, 'hooks/global/audit', 'session-start');
  const inspected = await registry.inspect('global/audit');
  await registry.trust('global/audit', inspected.contentHash);
  await registry.setEnabled('global/audit', true);

  await rm(actionPath);
  let snapshot = await registry.list();
  assert.equal(snapshot.hooks.length, 0);
  assert.equal(snapshot.issues.length, 1);
  const stored = JSON.parse(await readFile(join(userDataPath, 'hooks/state.json'), 'utf8')) as { entries: unknown[] };
  assert.equal(stored.entries.length, 0);

  await writeFile(actionPath, inspected.actionContents, 'utf8');
  snapshot = await registry.list();
  assert.equal(snapshot.hooks[0]?.trusted, false);
  assert.equal(snapshot.hooks[0]?.enabled, false);
});

test('corrupt or hard-linked state fails closed without resetting trust', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addHook(userDataPath, 'hooks/global/audit', 'session-start');
  const inspected = await registry.inspect('global/audit');
  await registry.trust('global/audit', inspected.contentHash);
  await registry.setEnabled('global/audit', true);
  const statePath = join(userDataPath, 'hooks/state.json');
  const linkedPath = join(userDataPath, 'hooks/state-copy.json');
  await link(statePath, linkedPath);

  let snapshot = await registry.list();
  assert.equal(snapshot.hooks[0]?.trusted, false);
  assert.equal(snapshot.hooks[0]?.enabled, false);
  assert.equal(snapshot.issues.some((issue) => /отдельным обычным файлом/.test(issue.reason)), true);
  await assert.rejects(registry.trust('global/audit', inspected.contentHash), /отдельным обычным файлом/);

  await rm(linkedPath);
  await writeFile(statePath, '{ broken', 'utf8');
  snapshot = await registry.list();
  assert.equal(snapshot.hooks[0]?.trusted, false);
  assert.equal(snapshot.hooks[0]?.enabled, false);
  assert.equal(snapshot.issues.some((issue) => /повреждён/.test(issue.reason)), true);
  await assert.rejects(registry.setEnabled('global/audit', true), /повреждён/);
});

test('rejects hard-linked action files before they can be inspected or trusted', async (t) => {
  const { userDataPath, registry } = await createFixture(t);
  await addHook(userDataPath, 'hooks/global/audit', 'session-start');
  const outside = join(userDataPath, 'external-action.ps1');
  await link(join(userDataPath, 'hooks/global/audit/run.ps1'), outside);
  const snapshot = await registry.list();
  assert.equal(snapshot.hooks.length, 0);
  assert.match(snapshot.issues[0]?.reason ?? '', /отдельным файлом/);
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

test('dispatcher passes only the bounded typed event and treats block as intent, not permission approval', async () => {
  const action = {
    id: 'global/guard', name: 'Guard', event: 'before-tool' as const,
    contentHash: 'a'.repeat(64), manifestContents: '{}', actionContents: 'Write-Output "fixture"',
  };
  const requests: Array<{ script: unknown; options?: Record<string, unknown> }> = [];
  const reported: string[] = [];
  const dispatcher = createHookDispatcher({
    registry: { getExecutable: async () => [action] },
    tools: { runPowerShell: async (_projectId, _profile, script, options) => {
      requests.push({ script, options: options as Record<string, unknown> });
      return { exitCode: 0, stdout: '{"decision":"block"}', stderr: '', timedOut: false, outputLimited: false };
    } },
    onResult: (result) => reported.push(`${result.hookId}:${result.status}`),
  },
  );
  const context = { projectId: 'project-1', projectWorkingFolder: 'C:\\project', permissionProfile: 'ask' as const, skillId: null };
  const result = await dispatcher(context, {
    event: 'before-tool', projectId: 'project-1', tool: 'write', resource: 'project-files', action: 'write',
  }, new AbortController().signal);

  assert.deepEqual(result.map(({ status, decision, reason }) => ({ status, decision, reason })), [{ status: 'blocked', decision: 'block', reason: 'Hook явно заблокировал действие.' }]);
  assert.deepEqual(reported, ['global/guard:blocked']);
  assert.equal(requests[0]?.script, action.actionContents);
  const encoded = requests[0]?.options?.inputDataBase64;
  assert.equal(typeof encoded, 'string');
  const payload = JSON.parse(Buffer.from(encoded as string, 'base64').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(payload, {
    schemaVersion: 1, event: 'before-tool', projectId: 'project-1', tool: 'write', resource: 'project-files', action: 'write',
  });
  assert.equal(JSON.stringify(payload).includes('prompt'), false);
});

test('same-project turns refresh the context used by project-end hooks', () => {
  const full = { projectId: 'project-1', projectWorkingFolder: 'C:\\project', permissionProfile: 'full' as const, skillId: null };
  const ask = { ...full, permissionProfile: 'ask' as const, skillId: 'global/review' };
  const first = transitionProjectHookContext(null, full);
  assert.equal(first.start?.permissionProfile, 'full');

  const second = transitionProjectHookContext(first.active, ask);
  assert.equal(second.start, null);
  assert.equal(second.end, null);
  assert.equal(second.active?.permissionProfile, 'ask');
  assert.equal(second.active?.skillId, 'global/review');

  const ended = transitionProjectHookContext(second.active, { ...ask, projectId: null, projectWorkingFolder: null, skillId: null });
  assert.equal(ended.end?.permissionProfile, 'ask');
  assert.equal(ended.end?.skillId, 'global/review');
  assert.equal(ended.active, null);
});

test('close and terminal cancellation suppress permission dialogs for hooks', async () => {
  let suppressed = true;
  let approvals = 0;
  let dispatches = 0;
  const gate = createHookApprovalGate({
    dispatch: async () => { dispatches += 1; return []; },
    isSuppressed: () => suppressed,
    requestApproval: async () => { approvals += 1; return true; },
  });
  const details = { resource: 'project-files' as const, action: 'write' as const, target: 'fixture', reason: 'fixture' };
  const context = {
    execution: { projectId: 'project-1', projectWorkingFolder: 'C:\\project', permissionProfile: 'ask' as const, skillId: null },
    projectId: 'project-1', profile: 'ask' as const, skillId: null, workingFolder: 'C:\\project',
    resource: 'project-files' as const, action: 'write' as const,
  };

  assert.equal(await gate.request(details, undefined, context), false);
  assert.equal(approvals, 0);
  assert.equal(dispatches, 0);

  suppressed = false;
  assert.equal(await gate.request(details, undefined, context), true);
  assert.equal(approvals, 1);
  assert.equal(dispatches, 1);
});

test('dispatcher records malformed output, skips unavailable scope, and waits for an aborted runner to settle', async () => {
  const action = {
    id: 'global/guard', name: 'Guard', event: 'before-tool' as const,
    contentHash: 'b'.repeat(64), manifestContents: '{}', actionContents: 'Write-Output "fixture"',
  };
  const results: string[] = [];
  const malformed = createHookDispatcher({
    registry: { getExecutable: async () => [action] },
    tools: { runPowerShell: async () => ({ exitCode: 0, stdout: 'not-json', stderr: '', timedOut: false, outputLimited: false }) },
    onResult: (result) => results.push(result.status),
  });
  const context = { projectId: 'project-1', projectWorkingFolder: 'C:\\project', permissionProfile: 'ask' as const, skillId: null };
  const invalid = await malformed(context, { event: 'before-tool', projectId: context.projectId }, new AbortController().signal);
  assert.equal(invalid[0]?.status, 'failed');
  assert.deepEqual(results, ['failed']);

  let calls = 0;
  const scoped = createHookDispatcher({
    registry: { getExecutable: async () => [action] },
    tools: { runPowerShell: async () => { calls += 1; return { exitCode: 0, stdout: '{}', stderr: '', timedOut: false, outputLimited: false }; } },
  });
  const skipped = await scoped({ ...context, projectId: null, projectWorkingFolder: null }, {
    event: 'before-tool', projectId: null,
  }, new AbortController().signal);
  assert.equal(skipped[0]?.status, 'skipped');
  assert.equal(calls, 0);

  let runnerSignal: AbortSignal | undefined;
  let runnerStopped = false;
  let settleRunner!: () => void;
  const abortResults: string[] = [];
  const abortable = createHookDispatcher({
    registry: { getExecutable: async () => [action] },
    tools: { runPowerShell: async (_projectId, _profile, _script, options) => {
      runnerSignal = options?.signal;
      await new Promise<void>((resolve) => { settleRunner = resolve; });
      runnerStopped = true;
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    } },
    onResult: (result) => abortResults.push(`${result.status}:${result.reason ?? ''}`),
  });
  const controller = new AbortController();
  const pending = abortable(context, { event: 'before-tool', projectId: context.projectId }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert.equal(runnerSignal?.aborted, true);
  assert.equal(runnerStopped, false);
  settleRunner();
  const abortError = await pending.then(() => null, (error: unknown) => error);
  assert.ok(abortError instanceof HookDispatchAbortError);
  assert.deepEqual(abortError.hookResults.map(({ status, reason }) => ({ status, reason })), [
    { status: 'cancelled', reason: 'Hook отменён вместе с текущим ходом.' },
  ]);
  assert.deepEqual(abortResults, ['cancelled:Hook отменён вместе с текущим ходом.']);
  assert.equal(runnerStopped, true);
});

test('dispatcher timeout aborts the runner but waits for its confirmed settlement', async () => {
  const action = {
    id: 'global/timeout', name: 'Timeout', event: 'before-tool' as const,
    contentHash: 'c'.repeat(64), manifestContents: '{}', actionContents: 'Write-Output "fixture"',
  };
  let runnerSignal: AbortSignal | undefined;
  let runnerStopped = false;
  let settleRunner!: () => void;
  let notifyAbort!: () => void;
  const abortSeen = new Promise<void>((resolve) => { notifyAbort = resolve; });
  const reported: string[] = [];
  const dispatcher = createHookDispatcher({
    registry: { getExecutable: async () => [action] },
    tools: { runPowerShell: async (_projectId, _profile, _script, options) => {
      runnerSignal = options?.signal;
      runnerSignal?.addEventListener('abort', notifyAbort, { once: true });
      await new Promise<void>((_resolve, reject) => {
        settleRunner = () => {
          runnerStopped = true;
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        };
      });
      return { exitCode: 0, stdout: '{}', stderr: '', timedOut: false, outputLimited: false };
    } },
    onResult: (result) => reported.push(`${result.status}:${result.reason ?? ''}`),
  });
  const context = { projectId: 'project-1', projectWorkingFolder: 'C:\\project', permissionProfile: 'ask' as const, skillId: null };
  let settled = false;
  const pending = dispatcher(context, { event: 'before-tool', projectId: context.projectId }, new AbortController().signal, { timeoutMs: 100 })
    .then((results) => { settled = true; return results; });
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      abortSeen,
      new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error('Timeout did not abort the Hook runner.')), 2_000); }),
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
  assert.equal(runnerSignal?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.equal(runnerStopped, false);

  settleRunner();
  const results = await pending;
  assert.equal(runnerStopped, true);
  assert.equal(results[0]?.status, 'failed');
  assert.equal(results[0]?.reason, 'Превышен лимит выполнения Hook.');
  assert.deepEqual(reported, ['failed:Превышен лимит выполнения Hook.']);
});

test('dispatcher rejects invalid schema, unknown fields, nonzero exit and output limits', async () => {
  const action = {
    id: 'global/invalid', name: 'Invalid', event: 'before-tool' as const,
    contentHash: 'd'.repeat(64), manifestContents: '{}', actionContents: 'Write-Output "fixture"',
  };
  const cases = [
    { name: 'array schema', output: { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, outputLimited: false } },
    { name: 'unknown field', output: { exitCode: 0, stdout: '{"extra":"value"}', stderr: '', timedOut: false, outputLimited: false } },
    { name: 'nonzero exit', output: { exitCode: 1, stdout: '{}', stderr: '', timedOut: false, outputLimited: false } },
    { name: 'helper output limit', output: { exitCode: 0, stdout: '{}', stderr: '', timedOut: false, outputLimited: true } },
    { name: 'oversized output', output: { exitCode: 0, stdout: 'x'.repeat(8 * 1024 + 1), stderr: '', timedOut: false, outputLimited: false } },
  ];
  const context = { projectId: 'project-1', projectWorkingFolder: 'C:\\project', permissionProfile: 'ask' as const, skillId: null };
  for (const item of cases) {
    const dispatcher = createHookDispatcher({
      registry: { getExecutable: async () => [action] },
      tools: { runPowerShell: async () => item.output },
    });
    const results = await dispatcher(context, { event: 'before-tool', projectId: context.projectId }, new AbortController().signal);
    assert.equal(results[0]?.status, 'failed', item.name);
    assert.ok(results[0]?.reason, item.name);
  }
});

test('executes an explicitly trusted hook snapshot through the existing native helper in a disposable project', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('The native local-tool capability exists only on Windows.');
    return;
  }
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'gigachat-hook-native-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const userDataPath = join(fixtureRoot, 'user-data');
  const projectFolder = join(fixtureRoot, 'project');
  const recoveryDirectory = join(fixtureRoot, 'helper-recovery');
  await Promise.all([mkdir(userDataPath), mkdir(projectFolder), mkdir(recoveryDirectory)]);
  const fixtureProject: Project = { ...project, workingFolder: projectFolder };
  const registry = createHookRegistry({
    userDataPath,
    listProjects: async () => [fixtureProject],
    listSkills: async () => [],
  });
  const action = [
    '$event = Get-Content -LiteralPath $env:GIGACHAT_LOCAL_TOOL_INPUT -Raw | ConvertFrom-Json',
    'if ($event.schemaVersion -ne 1 -or $event.event -ne "before-tool" -or $event.projectId -ne "project-1") { throw "Invalid hook event" }',
    '[pscustomobject]@{ decision = "block" } | ConvertTo-Json -Compress',
  ].join('\n');
  await addHook(userDataPath, 'hooks/projects/project-1/guard', 'before-tool', {}, action);
  const inspected = await registry.inspect('project/project-1/guard');
  await registry.trust(inspected.id, inspected.contentHash);
  await registry.setEnabled(inspected.id, true);

  const helper = createPowerShellHelper({
    helperPath: join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe'),
    recoveryDirectory,
  });
  await helper.recover();
  let markHelperStarted!: () => void;
  let releaseHelper!: () => void;
  const helperStarted = new Promise<void>((resolve) => { markHelperStarted = resolve; });
  const helperGate = new Promise<void>((resolve) => { releaseHelper = resolve; });
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixtureProject.id ? fixtureProject : null,
    runPowerShell: async (request) => {
      markHelperStarted();
      await helperGate;
      return helper.run(request);
    },
  });
  const dispatcher = createHookDispatcher({ registry, tools, isAvailable: () => true, onResult: registry.recordResult });
  const execution = dispatcher({
    projectId: fixtureProject.id, projectWorkingFolder: projectFolder, permissionProfile: 'ask', skillId: null,
  }, { event: 'before-tool', projectId: fixtureProject.id, tool: 'write' }, new AbortController().signal);
  await Promise.race([
    helperStarted,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('The native Hook did not reach the helper.')), 5_000)),
  ]);
  await writeFile(join(userDataPath, 'hooks/projects/project-1/guard/run.ps1'), '[pscustomobject]@{ decision = "allow" } | ConvertTo-Json -Compress', 'utf8');
  releaseHelper();
  const output = await execution;

  assert.deepEqual(output.map(({ status, decision, reason }) => ({ status, decision, reason })), [{ status: 'blocked', decision: 'block', reason: 'Hook явно заблокировал действие.' }]);
  const record = (await registry.list()).hooks[0];
  assert.equal(record?.trusted, false, 'Source mutation revokes future execution trust.');
  assert.equal(record?.lastRun?.status, 'blocked');
});
