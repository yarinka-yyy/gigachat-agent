import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Project } from './contracts';
import { DEFAULT_CUSTOM_CONFIG, openCustomPermissions, parseCustomConfig } from './custom-permissions';
import { createLocalTools } from './local-tools';
import { createPermissionApprovals } from './permission-approvals';
import { evaluatePermission } from './permissions';

test('validates TOML, keeps the last valid policy after an invalid external edit, and saves atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await openCustomPermissions(directory);
  assert.equal((await config.policy()).project.read, 'allow');
  const previous = await config.read();
  await assert.rejects(config.save(previous.replace('write = "ask"', 'write = "unknown"'), previous), /allow, ask или deny/);
  assert.equal(await readFile(join(directory, 'config.toml'), 'utf8'), previous);
  const next = previous.replace('write = "ask"', 'write = "deny"');
  await config.save(next, previous);
  assert.equal((await config.policy()).project.write, 'deny');
  await writeFile(join(directory, 'config.toml'), 'version = 1\n[permissions.custom.project]\nread = "bad"');
  assert.equal((await config.policy()).project.write, 'deny');
  await assert.rejects(config.save(DEFAULT_CUSTOM_CONFIG, next), /изменён снаружи/);
  assert.throws(() => parseCustomConfig(next.replace('version = 1', 'version = 2')), /версии 1/);
  assert.throws(() => parseCustomConfig(`${next}\n[permissions.custom.unknown]\na = 1`), /Неизвестное поле/);
  assert.throws(() => parseCustomConfig(`${next}\n[[permissions.custom.roots]]\nname = "network"\npath = "\\\\\\\\server\\\\share"\nread = "allow"`), /локальный абсолютный путь/);
});

test('routes custom allow, ask, deny and additional roots through local tools', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data');
  const projectFolder = join(directory, 'project');
  const extra = join(directory, 'extra');
  await Promise.all([mkdir(data), mkdir(projectFolder), mkdir(extra)]);
  const config = await openCustomPermissions(data);
  const rules = `${DEFAULT_CUSTOM_CONFIG}\n[[permissions.custom.roots]]\nname = "extra"\npath = ${JSON.stringify(extra)}\nwrite = "allow"\n`;
  await config.save(rules, await config.read());
  const project: Project = {
    id: 'project-1', name: 'Test', workingFolder: projectFolder, archived: false, pinned: false,
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  };
  let approvals = 0;
  let writes = 0;
  let allow = false;
  const tools = createLocalTools({
    resolveProject: async (id) => id === project.id ? project : null,
    protectedDirectory: data,
    getCustomPolicy: config.policy,
    requestApproval: async () => { approvals++; return allow; },
    writeFile: async (request) => { writes++; return { bytes: Buffer.from(request.contentsBase64, 'base64').byteLength, replacedExisting: false }; },
  });
  await assert.rejects(tools.write(project.id, 'custom', 'file.md', 'text'), /не подтверждено/);
  assert.equal(writes, 0);
  allow = true;
  await tools.write(project.id, 'custom', 'file.md', 'text');
  assert.equal(approvals, 2);
  assert.equal(writes, 1);
  await tools.write('root:extra', 'custom', 'file.md', 'text');
  assert.equal(approvals, 2);
  assert.equal(writes, 2);
  await assert.rejects(tools.write('root:extra', 'ask', 'file.md', 'text'), /недоступен/);
  await assert.rejects(tools.write(project.id, 'custom', '..\\outside.md', 'text'), /путь/i);
  await assert.rejects(tools.write('root:missing', 'custom', 'file.md', 'text'), /не найдена/);
  assert.equal(evaluatePermission({ profile: 'custom', resource: 'project-files', action: 'open',
    projectId: project.id, targetProjectId: project.id, capabilityAvailable: false, customPolicy: await config.policy() }).decision, 'deny');
});

test('approval requests resolve on decision, cancellation, and timeout', async () => {
  const seen: string[] = [];
  const broker = createPermissionApprovals((request) => { seen.push(request.id); }, 20);
  const details = { resource: 'project-files' as const, action: 'write' as const, target: 'C:\\file.md', reason: 'Нужно подтверждение.' };
  const permitted = broker.request(details);
  await Promise.resolve();
  assert.equal(broker.respond(seen[0], true), true);
  assert.equal(await permitted, true);
  const controller = new AbortController();
  const cancelled = broker.request(details, controller.signal);
  await Promise.resolve();
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(broker.respond(seen[1], true), false);
  assert.equal(await broker.request(details), false);
});
