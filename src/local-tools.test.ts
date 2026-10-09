import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { GigaChatProvider, Project, ProviderTurnRequest } from './contracts';
import { DEFAULT_CUSTOM_CONFIG, parseCustomConfig } from './custom-permissions';
import {
  createLocalTools,
  LocalToolError,
  createPowerShellHelper,
  MAX_LOCAL_FILE_BYTES,
  resolvePowerShellHelperPath,
  type LocalToolEvent,
  type PowerShellRequest,
  type PowerShellRunner,
  type ProjectFileWriteRequest,
} from './local-tools';
import { createTurnRuntime, type ToolReceiptInput } from './runtime';

const projectId = 'local-tools-project';

async function createFixture(): Promise<{
  root: string;
  projectFolder: string;
  outsideFolder: string;
  project: Project;
  cleanup(): Promise<void>;
}> {
  const appRoot = resolve(process.cwd());
  const gitDirectory = await lstat(join(appRoot, '.git'));
  assert.ok(gitDirectory.isDirectory(), 'tests must run from the app Git checkout');

  const qaRoot = join(appRoot, '.qa', 'pre-api', 'local-tools-tests');
  let parent = join(appRoot, '.qa');
  await mkdir(parent, { recursive: true });
  assert.equal((await lstat(parent)).isSymbolicLink(), false, 'QA root cannot be a symlink');
  for (const component of ['pre-api', 'local-tools-tests']) {
    parent = join(parent, component);
    await mkdir(parent, { recursive: true });
    assert.equal((await lstat(parent)).isSymbolicLink(), false, 'QA path cannot contain a symlink');
  }
  const qaReal = await realpath(qaRoot);
  const root = await mkdtemp(join(qaReal, 'run-'));
  const rel = relative(qaReal, root);
  assert.ok(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`), 'fixture must stay inside .qa/pre-api');
  const projectFolder = join(root, 'project');
  const outsideFolder = join(root, 'outside');
  await mkdir(projectFolder);
  await mkdir(outsideFolder);
  const project: Project = {
    id: projectId,
    name: 'Synthetic QA project',
    pinned: false,
    archived: false,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    workingFolder: projectFolder,
  };

  return {
    root, projectFolder, outsideFolder, project,
    async cleanup() {
      const rootInfo = await lstat(root).catch(() => null);
      if (!rootInfo) return;
      assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'refusing to remove a changed QA root');
      const cleanupRel = relative(qaReal, resolve(root));
      assert.ok(cleanupRel.startsWith('run-') && !cleanupRel.startsWith('..'), 'refusing cleanup outside QA');
      await rm(root, { recursive: true, force: true });
    },
  };
}

function makeTools(project: Project, events: LocalToolEvent[], opened: string[], runPowerShell?: PowerShellRunner,
  writeFile?: (request: ProjectFileWriteRequest) => Promise<{ bytes: number; replacedExisting: boolean }>) {
  return createLocalTools({
    resolveProject: async (id) => id === project.id ? project : null,
    revealItem: async (path) => { opened.push(path); },
    openTextFile: async (path) => { opened.push(path); },
    ...(runPowerShell ? { runPowerShell } : {}),
    ...(writeFile ? { writeFile } : {}),
    onEvent: (event) => { events.push(event); },
  });
}

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function fakeChild(kill: () => void = () => undefined): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  Object.assign(child, { kill });
  return child as unknown as FakeChild;
}

function finishFakeChild(child: FakeChild, output: string, exitCode = 0): void {
  setImmediate(() => {
    child.stdout.end(output);
    child.stderr.end();
    setImmediate(() => child.emit('close', exitCode, null));
  });
}

test('selects the packaged or development helper path without enabling a non-Windows shell', () => {
  const appPath = resolve(process.cwd());
  const resourcesPath = join(appPath, 'out', 'resources');
  assert.equal(resolvePowerShellHelperPath({ platform: 'win32', isPackaged: true, resourcesPath, appPath }),
    join(resourcesPath, 'LocalPowerShell.exe'));
  assert.equal(resolvePowerShellHelperPath({ platform: 'win32', isPackaged: false, resourcesPath, appPath }),
    join(appPath, 'resources', 'native', 'LocalPowerShell.exe'));
  assert.equal(resolvePowerShellHelperPath({ platform: 'linux', isPackaged: false, resourcesPath, appPath }), null);
});

test('sends PowerShell only as JSON stdin and keeps script text out of helper argv', async () => {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions; input: string }> = [];
  const spawnProcess = (command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    const child = fakeChild();
    const call = { command, args, options, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk: Buffer) => { call.input += chunk.toString('utf8'); });
    child.stdin.once('finish', () => {
      if (args[0] === '--run') {
        finishFakeChild(child, `${JSON.stringify({ ExitCode: 0, Stdout: 'ok', Stderr: '', TimedOut: false, OutputLimited: false })}\n`);
      }
    });
    return child;
  };
  const helperPath = join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe');
  const recoveryDirectory = join(process.cwd(), '.qa', 'pre-api', 'runtime');
  const script = 'Write-Output "private script text"';
  const helper = createPowerShellHelper({ helperPath, recoveryDirectory, spawnProcess });

  assert.deepEqual(await helper.run({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    script,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    trustedFullAccess: true,
    projectScoped: false,
  }), { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, outputLimited: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, helperPath);
  assert.deepEqual(calls[0]?.args, ['--run', recoveryDirectory]);
  assert.equal(JSON.stringify(calls[0]?.args).includes(script), false);
  assert.deepEqual(JSON.parse(calls[0]?.input), {
    WorkingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    Script: script,
    TimeoutMs: 10_000,
    MaxOutputBytes: 1024,
    TrustedFullAccess: true,
    ProjectScoped: false,
  });
  assert.equal(calls[0]?.options.shell, false);
  assert.deepEqual(calls[0]?.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('sends project writes as structured JSON without a script or payload in argv', async () => {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions; input: string }> = [];
  const contents = Buffer.from('Сохранено: ёж', 'utf8');
  const spawnProcess = (command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    const child = fakeChild();
    const call = { command, args, options, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk: Buffer) => { call.input += chunk.toString('utf8'); });
    child.stdin.once('finish', () => {
      finishFakeChild(child, `${JSON.stringify({ Bytes: contents.byteLength, ReplacedExisting: true })}\n`);
    });
    return child;
  };
  const helperPath = join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe');
  const recoveryDirectory = join(process.cwd(), '.qa', 'pre-api', 'runtime');
  const helper = createPowerShellHelper({ helperPath, recoveryDirectory, spawnProcess });
  const root = join(process.cwd(), '.qa', 'pre-api', 'project');

  assert.deepEqual(await helper.writeFile({
    workingFolder: root,
    relativePath: 'nested/result.txt',
    contentsBase64: contents.toString('base64'),
  }), { bytes: contents.byteLength, replacedExisting: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, helperPath);
  assert.deepEqual(calls[0]?.args, ['--write', recoveryDirectory]);
  assert.equal(JSON.stringify(calls[0]?.args).includes(contents.toString('base64')), false);
  assert.deepEqual(JSON.parse(calls[0]?.input ?? ''), {
    WorkingFolder: root,
    RelativePath: 'nested\\result.txt',
    ContentsBase64: contents.toString('base64'),
  });
  assert.equal(calls[0]?.options.shell, false);
  assert.deepEqual(calls[0]?.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('preserves a valid UTF-8 BOM when forwarding instruction text to the native writer', async () => {
  const calls: Array<{ args: string[]; input: string }> = [];
  const spawnProcess = (_command: string, args: string[]): ChildProcessWithoutNullStreams => {
    const child = fakeChild();
    const call = { args, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk: Buffer) => { call.input += chunk.toString('utf8'); });
    child.stdin.once('finish', () => finishFakeChild(child, '{"Kind":"saved"}\n'));
    return child;
  };
  const helper = createPowerShellHelper({
    helperPath: join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe'),
    recoveryDirectory: join(process.cwd(), '.qa', 'pre-api', 'runtime'),
    instructionRecoveryDirectory: join(process.cwd(), '.qa', 'pre-api', 'instruction-runtime'),
    spawnProcess,
  });
  const contents = '\uFEFFproject rules';

  assert.deepEqual(await helper.writeInstruction?.({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    relativePath: 'AGENTS.md',
    contents,
    expectedHash: null,
  }), { kind: 'saved' });
  assert.equal(calls.length, 1, 'valid BOM text must reach the native writer');
  assert.deepEqual(calls[0]?.args, ['--write-instruction', join(process.cwd(), '.qa', 'pre-api', 'instruction-runtime')]);
  const input = JSON.parse(calls[0]?.input ?? '') as { ContentsBase64: string };
  assert.equal(Buffer.from(input.ContentsBase64, 'base64').toString('utf8'), contents);
});

test('serializes project writes with PowerShell through the same helper queue', async () => {
  const modes: string[] = [];
  let pendingRun: FakeChild | null = null;
  const spawnProcess = (_command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    assert.equal(options.shell, false);
    const mode = args[0] ?? '';
    modes.push(mode);
    const child = fakeChild();
    child.stdin.once('finish', () => {
      if (mode === '--run') pendingRun = child;
      else if (mode === '--write') finishFakeChild(child, '{"Bytes":1,"ReplacedExisting":false}\n');
    });
    return child;
  };
  const helper = createPowerShellHelper({
    helperPath: join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe'),
    recoveryDirectory: join(process.cwd(), '.qa', 'pre-api', 'runtime'),
    spawnProcess,
  });
  const runPending = helper.run({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    script: "Write-Output 'done'",
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const writePending = helper.writeFile({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    relativePath: 'out.txt',
    contentsBase64: Buffer.from('x').toString('base64'),
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(modes, ['--run']);
  assert.ok(pendingRun);
  finishFakeChild(pendingRun, '{"ExitCode":0,"Stdout":"","Stderr":"","TimedOut":false,"OutputLimited":false}\n');
  await runPending;
  assert.deepEqual(await writePending, { bytes: 1, replacedExisting: false });
  assert.deepEqual(modes, ['--run', '--write']);
});

test('recovers a cancelled structured write and reports an unknown commit result', async () => {
  const modes: string[] = [];
  let writeChild: FakeChild | null = null;
  const helperPath = join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe');
  const recoveryDirectory = join(process.cwd(), '.qa', 'pre-api', 'runtime');
  const spawnProcess = (_command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    assert.equal(options.shell, false);
    const mode = args[0] ?? '';
    modes.push(mode);
    if (mode === '--recover') {
      const child = fakeChild();
      child.stdin.once('finish', () => finishFakeChild(child, '{"recovered":true}\n'));
      return child;
    }
    const child = fakeChild(() => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    });
    child.stdin.once('finish', () => { writeChild = child; });
    return child;
  };
  const helper = createPowerShellHelper({ helperPath, recoveryDirectory, spawnProcess });
  const controller = new AbortController();
  const pending = helper.writeFile({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    relativePath: 'out.txt',
    contentsBase64: Buffer.from('x').toString('base64'),
    signal: controller.signal,
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.ok(writeChild);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error
    && error.name === 'AbortError' && /результат мог уже зафиксироваться/.test(error.message));
  assert.deepEqual(modes, ['--write', '--recover']);
});

test('waits for a cancelled helper to exit before running ACL recovery', async () => {
  const order: string[] = [];
  const calls: string[][] = [];
  const helperPath = join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe');
  const recoveryDirectory = join(process.cwd(), '.qa', 'pre-api', 'runtime');
  const spawnProcess = (command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    calls.push(args);
    assert.equal(command, helperPath);
    assert.equal(options.shell, false);
    if (args[0] === '--recover') {
      const child = fakeChild();
      child.stdin.once('finish', () => {
        order.push('recovery-start');
        finishFakeChild(child, '{"recovered":true}\n');
      });
      child.once('close', () => order.push('recovery-close'));
      return child;
    }
    const child = fakeChild(() => {
      order.push('run-kill');
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => {
        order.push('run-close');
        child.emit('close', null, 'SIGTERM');
      });
    });
    child.once('close', () => order.push('run-closed-listener'));
    return child;
  };
  const controller = new AbortController();
  const helper = createPowerShellHelper({
    helperPath,
    recoveryDirectory,
    spawnProcess,
  });
  const pending = helper.run({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    script: 'Start-Sleep -Seconds 10',
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    signal: controller.signal,
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  assert.deepEqual(calls, [['--run', recoveryDirectory], ['--recover', recoveryDirectory]]);
  assert.ok(order.indexOf('run-close') < order.indexOf('recovery-start'));
});

test('recovers from a malformed successful helper response without reentrant locking', { timeout: 5000 }, async () => {
  const calls: string[] = [];
  const helperPath = join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe');
  const recoveryDirectory = join(process.cwd(), '.qa', 'pre-api', 'runtime');
  const spawnProcess = (_command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
    assert.equal(options.shell, false);
    calls.push(args[0] ?? '');
    const child = fakeChild();
    child.stdin.once('finish', () => {
      finishFakeChild(child, args[0] === '--recover' ? '{"recovered":true}\n' : '{}\n');
    });
    return child;
  };
  const helper = createPowerShellHelper({ helperPath, recoveryDirectory, spawnProcess });

  await assert.rejects(helper.run({
    workingFolder: join(process.cwd(), '.qa', 'pre-api', 'project'),
    script: "Write-Output 'ok'",
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  }), /некорректный ответ/);
  assert.deepEqual(calls, ['--run', '--recover']);
});

test('lists, searches, reads, sends structured writes, and opens files inside a selected project', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await mkdir(join(fixture.projectFolder, 'docs'));
  await writeFile(join(fixture.projectFolder, 'docs', 'readme.md'), 'GigaChat local tools\nsecond line\n');
  const events: LocalToolEvent[] = [];
  const opened: string[] = [];
  const requests: PowerShellRequest[] = [];
  const writeRequests: ProjectFileWriteRequest[] = [];
  const readText = 'Локальный файл: ёж\nвторая строка\n';
  const runPowerShell: PowerShellRunner = async (request) => {
    requests.push(request);
    if (request.script.includes('GIGACHAT_LOCAL_TOOL:list')) {
      return { exitCode: 0, stdout: JSON.stringify([
        { path: 'docs', kind: 'directory', size: null },
      ]), stderr: '', timedOut: false, outputLimited: false };
    }
    if (request.script.includes('GIGACHAT_LOCAL_TOOL:search')) {
      return { exitCode: 0, stdout: JSON.stringify([
        { path: 'docs/readme.md', line: 1, text: 'GigaChat local tools' },
      ]), stderr: '', timedOut: false, outputLimited: false };
    }
    const output = Buffer.from(readText, 'utf8');
    return { exitCode: 0, stdout: output.toString('base64') + '\n',
      stderr: '', timedOut: false, outputLimited: false };
  };
  const projectWriter = async (request: ProjectFileWriteRequest) => {
    writeRequests.push(request);
    return { bytes: Buffer.from(request.contentsBase64, 'base64').byteLength, replacedExisting: false };
  };
  const tools = makeTools(fixture.project, events, opened, runPowerShell, projectWriter);

  assert.deepEqual(await tools.list(projectId, 'ask'), [
    { path: 'docs', kind: 'directory', size: null },
  ]);
  assert.deepEqual(await tools.search(projectId, 'ask', 'LOCAL TOOLS'), [
    { path: 'docs/readme.md', line: 1, text: 'GigaChat local tools' },
  ]);
  assert.equal(await tools.read(projectId, 'ask', 'docs/readme.md'), readText);
  assert.deepEqual(await tools.write(projectId, 'ask', 'result.txt', 'Сохранено: ёж'),
    { bytes: Buffer.byteLength('Сохранено: ёж', 'utf8') });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.workingFolder === fixture.projectFolder));
  assert.match(requests[0]?.script ?? '', /GIGACHAT_LOCAL_TOOL:list/);
  assert.match(requests[0]?.script ?? '', /GetFileSystemEntries\(\$target\)/);
  assert.match(requests[0]?.script ?? '', /ReparsePoint/);
  assert.match(requests[1]?.script ?? '', /GIGACHAT_LOCAL_TOOL:search/);
  assert.match(requests[1]?.script ?? '', /inspectedDirectories -gt 500/);
  assert.match(requests[1]?.script ?? '', /inspectedEntries -gt 5000/);
  assert.match(requests[2]?.script ?? '', /\$Candidate\.Substring\(\$rootPrefix\.Length\)/);
  assert.doesNotMatch(requests[2]?.script ?? '', /GetRelativePath/);
  assert.equal(requests[0]?.maxOutputBytes, 1024 * 1024);
  assert.equal(requests[1]?.maxOutputBytes, 1024 * 1024);
  assert.equal(requests[2]?.maxOutputBytes, 2 * 1024 * 1024);
  assert.equal(writeRequests.length, 1);
  assert.equal(writeRequests[0]?.workingFolder, fixture.projectFolder);
  assert.equal(writeRequests[0]?.relativePath, 'result.txt');
  assert.equal(Buffer.from(writeRequests[0]?.contentsBase64 ?? '', 'base64').toString('utf8'), 'Сохранено: ёж');
  await tools.open(projectId, 'full', 'docs');
  await tools.open(projectId, 'full', 'docs/readme.md');
  const canonicalProject = await realpath(fixture.projectFolder);
  assert.deepEqual(opened, [join(canonicalProject, 'docs'), join(canonicalProject, 'docs', 'readme.md')]);
  assert.equal(requests.length, 4);
  assert.match(requests[3]?.script ?? '', /\$stream = \[IO\.File\]::Open/);
  assert.equal(events.filter((event) => event.phase === 'started').length, 6);
  assert.equal(events.filter((event) => event.phase === 'completed').length, 6);
  assert.ok(events.every((event) => !('script' in event) && !('path' in event)));
});

test('does not dispatch a project command through the operating-system file association', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const deniedNames = ['setup.cmd', 'program.exe', 'run.bat', 'script.ps1', 'shortcut.lnk', 'link.url', 'file.txt.exe', 'unknown.bin'];
  await Promise.all(deniedNames.map((name) => writeFile(join(fixture.projectFolder, name), 'unsafe')));
  const opened: string[] = [];
  const tools = makeTools(fixture.project, [], opened);

  for (const name of deniedNames) {
    await assert.rejects(tools.open(projectId, 'full', name), /просмотр|недоступ|поддерж/i);
  }
  assert.deepEqual(opened, []);
});

test('reveals directories and opens only bounded UTF-8 documents through the fixed text viewer', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await mkdir(join(fixture.projectFolder, 'docs'));
  await writeFile(join(fixture.projectFolder, 'docs', 'readme.md'), 'safe text');
  await writeFile(join(fixture.projectFolder, 'setup.cmd'), 'echo unsafe');
  await writeFile(join(fixture.projectFolder, 'unknown.bin'), Buffer.from([0xff, 0x00]));
  await writeFile(join(fixture.projectFolder, 'broken.txt'), 'invalid utf8');
  await writeFile(join(fixture.projectFolder, 'too-large.txt'), Buffer.alloc(MAX_LOCAL_FILE_BYTES + 1, 0x61));
  const revealed: string[] = [];
  const viewed: string[] = [];
  const reads: PowerShellRequest[] = [];
  let nextRead = Buffer.from('safe text', 'utf8');
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    revealItem: async (path) => { revealed.push(path); },
    openTextFile: async (path) => { viewed.push(path); },
    runPowerShell: async (request) => {
      reads.push(request);
      return { exitCode: 0, stdout: `${nextRead.toString('base64')}\n`, stderr: '', timedOut: false, outputLimited: false };
    },
  });

  await tools.open(projectId, 'full', 'docs');
  await tools.open(projectId, 'full', 'docs/readme.md');
  assert.deepEqual(revealed, [join(fixture.projectFolder, 'docs')]);
  assert.deepEqual(viewed, [join(fixture.projectFolder, 'docs', 'readme.md')]);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.maxOutputBytes, 2 * 1024 * 1024);
  await assert.rejects(tools.open(projectId, 'full', 'setup.cmd'), /нельзя безопасно открыть/);
  await assert.rejects(tools.open(projectId, 'full', 'unknown.bin'), /нельзя безопасно открыть/);

  nextRead = Buffer.from([0xff, 0x00]);
  await assert.rejects(tools.open(projectId, 'full', 'broken.txt'), /Бинарный файл|корректный UTF-8/);
  nextRead = Buffer.alloc(MAX_LOCAL_FILE_BYTES + 1, 0x61);
  await assert.rejects(tools.open(projectId, 'full', 'too-large.txt'), /превышает лимит|больше данных/);
  assert.equal(reads.length, 3);
  assert.equal(viewed.length, 1);
});

test('checks custom open and project-read rules before revealing or viewing a file', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await writeFile(join(fixture.projectFolder, 'notes.md'), 'safe text');
  const reads: PowerShellRequest[] = [];
  const viewed: string[] = [];
  const approvals: Array<[string, string]> = [];
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    getCustomPolicy: async () => parseCustomConfig(DEFAULT_CUSTOM_CONFIG.replace('read = "allow"', 'read = "ask"')),
    requestApproval: async ({ resource, action }) => {
      approvals.push([resource, action]);
      return resource === 'application';
    },
    openTextFile: async (path) => { viewed.push(path); },
    runPowerShell: async (request) => {
      reads.push(request);
      return { exitCode: 0, stdout: `${Buffer.from('safe text').toString('base64')}\n`, stderr: '', timedOut: false, outputLimited: false };
    },
  });

  await assert.rejects(tools.open(projectId, 'custom', 'notes.md'), /Действие не подтверждено/);
  assert.deepEqual(approvals, [['application', 'open'], ['project-files', 'read']]);
  assert.equal(reads.length, 0);
  assert.deepEqual(viewed, []);

  const deniedViewed: string[] = [];
  const denied = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    getCustomPolicy: async () => parseCustomConfig(DEFAULT_CUSTOM_CONFIG
      .replace('open = "ask"', 'open = "allow"').replace('read = "allow"', 'read = "deny"')),
    openTextFile: async (path) => { deniedViewed.push(path); },
    runPowerShell: async () => {
      throw new Error('Read policy must deny before the file helper runs.');
    },
  });
  await assert.rejects(denied.open(projectId, 'custom', 'notes.md'), /Запрещено пользовательским профилем/);
  assert.deepEqual(deniedViewed, []);
});

test('keeps existing file contents when structured broker rejects a write', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const existingPath = join(fixture.projectFolder, 'existing.txt');
  const previousText = 'keep previous content';
  await writeFile(existingPath, previousText, 'utf8');
  const events: LocalToolEvent[] = [];
  const requests: ProjectFileWriteRequest[] = [];
  const projectWriter = async (request: ProjectFileWriteRequest) => {
    requests.push(request);
    throw new Error('Файловый writer отказал: дескриптор не поддерживается.');
  };
  const tools = makeTools(fixture.project, events, [], undefined, projectWriter);

  await assert.rejects(tools.write(projectId, 'ask', 'existing.txt', 'replacement'), /дескриптор не поддерживается/);
  assert.equal(await readFile(existingPath, 'utf8'), previousText);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.relativePath, 'existing.txt');
  assert.equal(Buffer.from(requests[0]?.contentsBase64 ?? '', 'base64').toString('utf8'), 'replacement');
  assert.equal(events[events.length - 1]?.phase, 'failed');
});

test('rejects traversal, malformed requests, oversized writes, and project symlinks', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await writeFile(join(fixture.outsideFolder, 'sentinel.txt'), 'outside');
  await writeFile(join(fixture.projectFolder, 'keep.txt'), 'preserve');
  await writeFile(join(fixture.projectFolder, 'not-a-folder.txt'), 'still here');
  const events: LocalToolEvent[] = [];
  const reader: PowerShellRunner = async () => ({
    exitCode: 0, stdout: `${Buffer.from('preserve').toString('base64')}\n`, stderr: '', timedOut: false, outputLimited: false,
  });
  const tools = makeTools(fixture.project, events, [], reader, async () => {
    throw new Error('Validation should reject the write before the helper runs.');
  });

  await assert.rejects(tools.read(projectId, 'ask', '../outside/sentinel.txt'), /относительный путь|недопустимый компонент/);
  await assert.rejects(tools.read(projectId, 'ask', join(fixture.outsideFolder, 'sentinel.txt')), /относительный путь/);
  await assert.rejects(tools.read('missing-project', 'ask', 'keep.txt'), /рабочая папка/);
  await assert.rejects(tools.read(projectId, 'custom', 'keep.txt'), /Конфигурация пользовательского профиля недоступна/);
  await assert.rejects(tools.write(projectId, 'ask', 'keep.txt', 'x'.repeat(MAX_LOCAL_FILE_BYTES + 1)), /1 МиБ/);
  await assert.rejects(tools.write(projectId, 'ask', 'not-a-folder.txt/child.txt', 'replacement'), /Компонент пути не является папкой/);
  assert.equal(await readFile(join(fixture.projectFolder, 'keep.txt'), 'utf8'), 'preserve');
  assert.equal(await readFile(join(fixture.projectFolder, 'not-a-folder.txt'), 'utf8'), 'still here');
  await tools.open(projectId, 'ask', 'keep.txt');

  const link = join(fixture.projectFolder, 'outside-link');
  await symlink(fixture.outsideFolder, link, 'junction');
  await assert.rejects(tools.read(projectId, 'ask', 'outside-link/sentinel.txt'), /ссыл|повторной обработки/);
  assert.equal(events.filter((event) => event.phase === 'failed').length, 7);
});

test('rechecks the working-folder path on every request and keeps PowerShell disabled without a verified helper', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await writeFile(join(fixture.projectFolder, 'before.txt'), 'ok');
  const events: LocalToolEvent[] = [];
  const runPowerShell: PowerShellRunner = async () => ({
    exitCode: 0, stdout: Buffer.from('ok', 'utf8').toString('base64') + '\n',
    stderr: '', timedOut: false, outputLimited: false,
  });
  const tools = makeTools(fixture.project, events, [], runPowerShell);
  assert.equal(await tools.read(projectId, 'ask', 'before.txt'), 'ok');

  const moved = join(fixture.root, 'moved');
  await rename(fixture.projectFolder, moved);
  await symlink(moved, fixture.projectFolder, 'junction');
  await assert.rejects(tools.read(projectId, 'ask', 'before.txt'), /ссыл/);
  const unavailable = makeTools(fixture.project, [], []);
  await assert.rejects(unavailable.runPowerShell(projectId, 'full', 'Get-Location'), /пока недоступен/);
  assert.equal(events.filter((event) => event.phase === 'failed').length, 1);
});

test('Full PowerShell uses the selected project or verified cwd and Ask never selects native Full mode', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('The native local-tool capability exists only on Windows.');
    return;
  }
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const requests: PowerShellRequest[] = [];
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    runPowerShell: async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, outputLimited: false };
    },
  });

  await tools.runPowerShell(null, 'full', 'Write-Output "full without project"');
  assert.equal(requests[0]?.workingFolder, process.cwd());
  assert.equal(requests[0]?.trustedFullAccess, true);
  assert.equal(requests[0]?.projectScoped, false);

  await tools.runPowerShell(projectId, 'full', 'Write-Output "full in project"');
  assert.equal(requests[1]?.workingFolder, fixture.projectFolder);
  assert.equal(requests[1]?.trustedFullAccess, true);
  assert.equal(requests[1]?.projectScoped, true);

  await tools.runPowerShell(projectId, 'ask', 'Write-Output "bounded"');
  assert.equal(requests[2]?.trustedFullAccess, false);
  assert.equal(requests[2]?.projectScoped, true);
  await assert.rejects(tools.runPowerShell(null, 'ask', 'Write-Output "no project"'), /project|проект|идентификатор/i);
  assert.equal(requests.length, 3);
});

test('one-time Full shell escape requires a whole-command approval and uses the manual fallback', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('The native local-tool capability exists only on Windows.');
    return;
  }
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const command = "Invoke-WebRequest -Uri 'http://127.0.0.1:8123/fixture'";
  const approvals: Array<{ resource: string; action: string; target: string; reason: string }> = [];
  const requests: PowerShellRequest[] = [];
  let allow = false;
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    requestApproval: async (request) => { approvals.push(request); return allow; },
    runPowerShell: async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, outputLimited: false };
    },
  });

  await assert.rejects(tools.runPowerShell(projectId, 'ask', command, { fullAccessOnce: true }), (error: unknown) =>
    error instanceof LocalToolError && error.code === 'PERMISSION_DENIED' && /не подтверждено/.test(error.message));
  assert.equal(requests.length, 0, 'A denied full-access approval must not launch PowerShell.');
  assert.deepEqual(approvals[0], {
    resource: 'process',
    action: 'execute',
    target: `PowerShell без AppContainer\nРабочая папка: ${fixture.projectFolder}\nКоманда:\n${command}`,
    reason: 'Действие выходит за границу проекта и требует вашего подтверждения. Команда получит доступ к файлам, доступным текущей учётной записи, и сети; доступ не ограничен одним путём.',
  });

  allow = true;
  await tools.runPowerShell(projectId, 'approve', command, { fullAccessOnce: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.script, command);
  assert.equal(requests[0]?.workingFolder, fixture.projectFolder);
  assert.equal(requests[0]?.trustedFullAccess, true);
  assert.equal(requests[0]?.projectScoped, true);
  assert.match(approvals[1]?.reason ?? '', /Автоматическая проверка не настроена/);
});

test('can cancel a long search between filesystem operations', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const controller = new AbortController();
  const events: LocalToolEvent[] = [];
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    onEvent: (event) => {
      events.push(event);
      if (event.tool === 'search' && event.phase === 'started') setTimeout(() => controller.abort(), 0);
    },
  });
  await writeFile(join(fixture.projectFolder, 'one.txt'), 'search me');
  await assert.rejects(tools.search(projectId, 'ask', 'search', '', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(events[events.length - 1]?.phase, 'cancelled');
});

test('rejects malformed or over-bound list/search helper output', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  let output = '[]';
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    runPowerShell: async () => ({
      exitCode: 0,
      stdout: output,
      stderr: '', timedOut: false, outputLimited: false,
    }),
  });

  output = JSON.stringify([{ path: '../outside/sentinel.txt', kind: 'file', size: 1 }]);
  await assert.rejects(tools.list(projectId, 'ask'), /путь вне выбранной папки|недопустимый компонент/);
  output = JSON.stringify(Array.from({ length: 501 }, (_, index) => ({
    path: `item-${index}`, kind: 'file', size: 0,
  })));
  await assert.rejects(tools.list(projectId, 'ask'), /слишком много элементов/);
  output = JSON.stringify([{ path: '../outside/sentinel.txt', line: 1, text: 'outside' }]);
  await assert.rejects(tools.search(projectId, 'ask', 'sentinel'), /путь вне выбранной папки|недопустимый компонент/);
  output = JSON.stringify(Array.from({ length: 201 }, (_, index) => ({
    path: `file-${index}.txt`, line: 1, text: 'match',
  })));
  await assert.rejects(tools.search(projectId, 'ask', 'match'), /слишком много результатов/);
});

test('rejects a project folder change from the accepted runtime tool scope before writing', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const acceptedFolder = fixture.projectFolder;
  let writes = 0;
  const tools = makeTools(fixture.project, [], [], undefined, async (request) => {
    writes += 1;
    return { bytes: Buffer.from(request.contentsBase64, 'base64').byteLength, replacedExisting: false };
  });
  fixture.project.workingFolder = fixture.outsideFolder;

  await assert.rejects(
    tools.write(projectId, 'full', 'guard.txt', 'must stay in accepted folder', { expectedWorkingFolder: acceptedFolder }),
    /Рабочая папка проекта изменилась после принятия хода/,
  );
  assert.equal(writes, 0);
});

test('runs GigaChat read and approved write through the actual native helper in a disposable project', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('The native local-tool capability exists only on Windows.');
    return;
  }
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const recoveryDirectory = join(fixture.root, 'helper-recovery');
  await mkdir(recoveryDirectory);
  const helper = createPowerShellHelper({
    helperPath: join(process.cwd(), 'resources', 'native', 'LocalPowerShell.exe'),
    recoveryDirectory,
  });
  await helper.recover();
  const approvals: Array<{ resource: string; action: string; target: string }> = [];
  const policy = {
    project: { list: 'allow', search: 'allow', read: 'allow', write: 'ask', open: 'ask', execute: 'ask' } as const,
    roots: [],
  };
  const tools = createLocalTools({
    resolveProject: async (id) => id === fixture.project.id ? fixture.project : null,
    getCustomPolicy: async () => policy,
    requestApproval: async (request) => { approvals.push(request); return true; },
    runPowerShell: helper.run,
    writeFile: helper.writeFile,
  });
  await writeFile(join(fixture.projectFolder, 'source.txt'), 'Исходный текст');
  const requests: ProviderTurnRequest[] = [];
  const provider: GigaChatProvider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (!request.protocolHistory?.length) {
        yield { type: 'function-call', functionCall: {
          name: 'read', arguments: { path: 'source.txt' }, content: null,
          functionsStateId: 'helper-read-state', terminalReason: 'function_call',
        } };
      } else if (request.protocolHistory.length === 1) {
        yield { type: 'function-call', functionCall: {
          name: 'write', arguments: { path: 'result.txt', contents: 'Записано после подтверждения' }, content: null,
          functionsStateId: 'helper-write-state', terminalReason: 'function_call',
        } };
      } else {
        yield { type: 'text-delta', text: 'Запись завершена' };
        yield { type: 'completed' };
      }
    },
  };
  const receipts = new Map<string, { input: ToolReceiptInput; result: string | null; status: 'pending' | 'completed' | 'unknown' }>();
  const runtime = createTurnRuntime({
    provider,
    tools,
    prepareTurn: async () => ({
      system: [], modelId: 'GigaChat-2-Pro', permissionProfile: 'custom', messages: [{
        id: 'message-helper', role: 'user', text: 'Прочитай и запиши файл', createdAt: '2026-09-27T00:00:00.000Z',
      }],
    }),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    beginToolReceipt: async (turn, input) => {
      const receipt = { input, result: null, status: 'pending' as const };
      receipts.set(input.receiptId, receipt);
      return { shouldExecute: true, receipt: {
        ...input, anchorMessageId: turn.messageId, status: 'pending', result: null,
        createdAt: '2026-09-27T00:00:00.000Z',
      } };
    },
    completeToolReceipt: async (_turn, receiptId, status, result) => {
      const receipt = receipts.get(receiptId);
      assert.ok(receipt);
      receipts.set(receiptId, { ...receipt, result, status });
    },
  });
  runtime.enqueue({
    turnId: 'turn-helper', chatId: 'chat-helper', projectId: fixture.project.id,
    projectWorkingFolder: fixture.projectFolder, messageId: 'message-helper', historyBoundary: 1,
    messages: [{ id: 'message-helper', role: 'user', text: 'Прочитай и запиши файл', createdAt: '2026-09-27T00:00:00.000Z' }],
    modelId: 'GigaChat-2-Pro', permissionProfile: 'custom', skillId: null,
    reservation: { permissionProfileRevision: null, skillRevision: null },
  });
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-helper')[0]?.status, 'completed');
  assert.ok(approvals.some((approval) => approval.action === 'write' && approval.target.endsWith('result.txt')));
  assert.equal(JSON.parse(requests[1]?.protocolHistory?.[0]?.result ?? '{}').result, 'Исходный текст');
  assert.equal(await readFile(join(fixture.projectFolder, 'result.txt'), 'utf8'), 'Записано после подтверждения');
});
