import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, link, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Native boundary verification requires Windows.');

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const helper = join(appRoot, 'resources', 'native', 'LocalPowerShell.exe');
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'gigachat-plan007-boundaries-'));
const temporaryJunctions = [];

function isWithin(parent, path) {
  const child = relative(parent, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertTemporaryRoot() {
  assert.ok(isWithin(temporaryRoot, root), 'Boundary fixture root must stay below the OS temporary directory.');
  assert.ok(root.toLocaleLowerCase('en-US').startsWith(
    join(temporaryRoot, 'gigachat-plan007-boundaries-').toLocaleLowerCase('en-US')),
  'Boundary fixture root must retain its unique expected prefix.');
}

function invoke(args, input) {
  return spawnSync(helper, args, {
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function startAsync(args, input) {
  const child = spawn(helper, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let spawnError;
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => { spawnError = error; });
  const result = new Promise((resolveResult) => child.once('close', (status, signal) => {
    resolveResult({ error: spawnError, status, signal, stdout, stderr });
  }));
  child.stdin.end(`${JSON.stringify(input)}\n`);
  return { child, result };
}

function invokeAsync(args, input) {
  return startAsync(args, input).result;
}

function parseOutput(result) {
  assert.equal(result.error, undefined, result.error?.message);
  try { return JSON.parse((result.stdout ?? '').trim()); }
  catch { assert.fail(`Native helper returned no JSON response (exit ${result.status}).`); }
}

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function isProcessRunning(pid) {
  const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
  const result = spawnSync(tasklist, ['/FI', `PID eq ${pid}`], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Cannot inspect the isolated fixture child process: ${result.stderr}`);
  return new RegExp(`\\b${pid}\\b`).test(result.stdout);
}

function snapshot(path) {
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class Plan007BoundarySnapshot {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetNamedSecurityInfoW(string path, uint type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static string Part(IntPtr descriptor, uint information) {
    IntPtr text;
    uint length;
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, information, out text, out length))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return Marshal.PtrToStringUni(text); }
    finally { if (text != IntPtr.Zero) LocalFree(text); }
  }
  public static string[] Read(string path) {
    const uint readAttributes = 0x80, openExisting = 3, openReparsePoint = 0x00200000, backupSemantics = 0x02000000;
    IntPtr handle = CreateFileW(path, readAttributes, 7, IntPtr.Zero, openExisting, openReparsePoint | backupSemantics, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Info info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr owner, group, dacl, sacl, descriptor;
      uint result = GetNamedSecurityInfoW(path, 1, 0x1 | 0x2 | 0x4 | 0x10,
        out owner, out group, out dacl, out sacl, out descriptor);
      if (result != 0) throw new Win32Exception(unchecked((int)result));
      try {
        return new[] {
          info.VolumeSerial.ToString("x8") + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8"),
          info.Links.ToString(), Part(descriptor, 0x1), Part(descriptor, 0x2), Part(descriptor, 0x4), Part(descriptor, 0x10)
        };
      } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    } finally { CloseHandle(handle); }
  }
}
'@ | Out-Null
$parts = [Plan007BoundarySnapshot]::Read($path)
[pscustomobject]@{
  Identity = $parts[0]
  Links = [int]$parts[1]
  Security = [pscustomobject]@{ Owner = $parts[2]; Group = $parts[3]; Dacl = $parts[4]; Label = $parts[5] }
} | ConvertTo-Json -Compress -Depth 3`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Cannot read synthetic Windows security descriptor: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

async function removeFixture() {
  assertTemporaryRoot();
  for (const junction of temporaryJunctions) {
    assert.ok(isWithin(root, junction), 'Only a fixture junction below the unique root may be removed.');
    let info;
    try { info = await lstat(junction); }
    catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
    assert.ok(info.isSymbolicLink(), 'A fixture junction path was replaced; preserving it for inspection.');
    await unlink(junction);
  }
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Fixture root changed type; preserving it.');
  await rm(root, { recursive: true, force: false });
}

assertTemporaryRoot();
try {
  const controlProject = join(root, 'normal-project');
  const controlRuntime = join(root, 'normal-runtime');
  const controlNested = join(controlProject, 'nested');
  await Promise.all([mkdir(controlProject), mkdir(controlRuntime)]);
  await mkdir(controlNested);
  await writeFile(join(controlNested, 'before.txt'), 'rename-control', { flag: 'wx' });
  const normalRun = invoke(['--run', controlRuntime], {
    WorkingFolder: controlProject,
    Script: "$root = $env:GIGACHAT_PROJECT_ROOT; [System.IO.File]::WriteAllText((Join-Path $root 'control.txt'), 'normal-control'); [System.IO.File]::Move((Join-Path $root 'nested\\before.txt'), (Join-Path $root 'nested\\after.txt'))",
    TimeoutMs: 5000,
    MaxOutputBytes: 4096,
  });
  assert.equal(normalRun.status, 0,
    `Normal project execution should remain available: error=${normalRun.error?.message ?? ''}; stdout=${normalRun.stdout}; stderr=${normalRun.stderr}`);
  const normalResponse = parseOutput(normalRun);
  assert.equal(normalResponse.ExitCode, 0,
    `Normal nested-folder write/rename failed: ${JSON.stringify(normalResponse)}; stderr=${normalRun.stderr}`);
  assert.equal(await readFile(join(controlProject, 'control.txt'), 'utf8'), 'normal-control');
  assert.equal(await readFile(join(controlNested, 'after.txt'), 'utf8'), 'rename-control');
  await assert.rejects(readFile(join(controlNested, 'before.txt')), { code: 'ENOENT' });
  process.stdout.write('PASS native AppContainer run remains available for a regular single-link project.\n');

  const fullProject = join(root, 'full-project');
  const fullRuntime = join(root, 'full-runtime');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(fullProject), mkdir(fullRuntime), mkdir(outside)]);
  const outsideTarget = join(outside, 'full-target.txt');
  const originalOutside = 'bounded execution must preserve this file';
  await writeFile(outsideTarget, originalOutside, { flag: 'wx' });
  const boundedOutside = invoke(['--run', fullRuntime], {
    WorkingFolder: fullProject,
    Script: `[System.IO.File]::WriteAllText(${psLiteral(outsideTarget)}, 'bounded-write')`,
    TimeoutMs: 5000,
    MaxOutputBytes: 4096,
  });
  assert.equal(boundedOutside.status, 0,
    `Bounded helper failed before reporting the outside-write result: stdout=${boundedOutside.stdout}; stderr=${boundedOutside.stderr}`);
  assert.notEqual(parseOutput(boundedOutside).ExitCode, 0,
    'Bounded AppContainer execution must reject an outside write.');
  assert.equal(await readFile(outsideTarget, 'utf8'), originalOutside);
  const fullOutside = invoke(['--run', fullRuntime], {
    WorkingFolder: fullProject,
    Script: `[System.IO.File]::WriteAllText(${psLiteral(outsideTarget)}, 'full-write'); Get-Content -Raw ${psLiteral(outsideTarget)}`,
    TimeoutMs: 5000,
    MaxOutputBytes: 4096,
    TrustedFullAccess: true,
    ProjectScoped: true,
  });
  assert.equal(fullOutside.status, 0, `Full execution failed: ${fullOutside.stdout}; ${fullOutside.stderr}`);
  assert.equal(parseOutput(fullOutside).ExitCode, 0);
  assert.equal(await readFile(outsideTarget, 'utf8'), 'full-write');
  process.stdout.write('PASS Full executes as the current user outside the project while bounded AppContainer preserves the same target.\n');

  const fullNoProject = invoke(['--run', fullRuntime], {
    WorkingFolder: fullProject,
    Script: "if (Test-Path Env:GIGACHAT_PROJECT_ROOT) { throw 'unexpected project root' }; 'FULL_NO_PROJECT'",
    TimeoutMs: 5000,
    MaxOutputBytes: 4096,
    TrustedFullAccess: true,
    ProjectScoped: false,
  });
  assert.equal(fullNoProject.status, 0, `Unbound Full execution failed: ${fullNoProject.stdout}; ${fullNoProject.stderr}`);
  assert.equal(parseOutput(fullNoProject).ExitCode, 0);
  assert.match(parseOutput(fullNoProject).Stdout, /FULL_NO_PROJECT/);
  process.stdout.write('PASS Full without a project does not advertise the working directory as a project root.\n');

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('fixture-http-ok');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const localUrl = `http://127.0.0.1:${address.port}/health`;
    const httpScript = `$response = Invoke-WebRequest -UseBasicParsing -Uri ${psLiteral(localUrl)} -TimeoutSec 2; $response.Content`;
    const boundedNetwork = await invokeAsync(['--run', fullRuntime], {
      WorkingFolder: fullProject,
      Script: httpScript,
      TimeoutMs: 5000,
      MaxOutputBytes: 4096,
    });
    assert.equal(boundedNetwork.status, 0,
      `Bounded helper failed before reporting the localhost result: ${boundedNetwork.stdout}; ${boundedNetwork.stderr}`);
    const boundedNetworkResult = parseOutput(boundedNetwork);
    assert.notEqual(boundedNetworkResult.ExitCode, 0, 'Bounded AppContainer must reject a network request.');
    assert.doesNotMatch(boundedNetworkResult.Stdout, /fixture-http-ok/,
      'Bounded AppContainer must not read the local network fixture.');
    const fullNetwork = await invokeAsync(['--run', fullRuntime], {
      WorkingFolder: fullProject,
      Script: httpScript,
      TimeoutMs: 5000,
      MaxOutputBytes: 4096,
      TrustedFullAccess: true,
      ProjectScoped: true,
    });
    assert.equal(fullNetwork.status, 0, `Full local HTTP request failed: ${fullNetwork.stdout}; ${fullNetwork.stderr}`);
    assert.equal(parseOutput(fullNetwork).ExitCode, 0);
    assert.match(parseOutput(fullNetwork).Stdout, /fixture-http-ok/);
    process.stdout.write('PASS only Full execution can reach a disposable localhost HTTP fixture.\n');
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }

  const childProject = join(root, 'full-child-project');
  const childRuntime = join(root, 'full-child-runtime');
  await Promise.all([mkdir(childProject), mkdir(childRuntime)]);
  const fullChildStarted = join(childProject, 'child-started.txt');
  const fullChildPidPath = join(childProject, 'child-pid.txt');
  const fullChildFinished = join(childProject, 'child-finished.txt');
  const childScriptPath = join(childProject, 'child.ps1');
  await writeFile(childScriptPath,
    `Start-Sleep -Seconds 8; [System.IO.File]::WriteAllText(${psLiteral(fullChildFinished)}, 'finished')`, { flag: 'wx' });
  const childRun = startAsync(['--run', childRuntime], {
    WorkingFolder: childProject,
    Script: `$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $child = Start-Process -FilePath $powershell -ArgumentList '-NoProfile -NonInteractive -File', ${psLiteral(childScriptPath)} -WindowStyle Hidden -PassThru; [System.IO.File]::WriteAllText(${psLiteral(fullChildPidPath)}, [string]$child.Id); [System.IO.File]::WriteAllText(${psLiteral(fullChildStarted)}, 'started'); $child.WaitForExit(); 'parent-finished'`,
    TimeoutMs: 30_000,
    MaxOutputBytes: 4096,
    TrustedFullAccess: true,
    ProjectScoped: true,
  });
  const startDeadline = Date.now() + 10_000;
  try {
    while (Date.now() < startDeadline) {
      if (await readFile(fullChildStarted, 'utf8').then(() => true, () => false)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.equal(await readFile(fullChildStarted, 'utf8'), 'started', 'Full child process did not start.');
  } finally {
    childRun.child.kill();
  }
  const cancelledChildRun = await childRun.result;
  assert.notEqual(cancelledChildRun.status, 0, 'Terminating the helper must cancel the active Full process tree.');
  const childPid = Number(await readFile(fullChildPidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  const childExitDeadline = Date.now() + 5000;
  while (Date.now() < childExitDeadline && isProcessRunning(childPid)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(isProcessRunning(childPid), false, 'Closing the helper must terminate its child process through the Job.');
  await assert.rejects(readFile(fullChildFinished), { code: 'ENOENT' }, 'The cancelled child must not finish its write.');
  process.stdout.write('PASS terminating a Full helper stops its child process before the child can write.\n');

  const cliProbe = invoke(['--run', fullRuntime], {
    WorkingFolder: fullProject,
    Script: `
$cli = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $cli) {
  $version = & $cli.Path --version
  if ($LASTEXITCODE -eq 0 -and ($version -join '').Trim() -match '^\\d+(\\.\\d+)+$') { 'DOTNET_OK' } else { 'CLI_UNAVAILABLE' }
} else {
  $python = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $python) { 'CLI_UNAVAILABLE' } else {
    $result = & $python.Path -c 'print("PYTHON_OK")'
    if ($LASTEXITCODE -eq 0 -and ($result -join '').Trim() -eq 'PYTHON_OK') { 'PYTHON_OK' } else { 'CLI_UNAVAILABLE' }
  }
}`,
    TimeoutMs: 15_000,
    MaxOutputBytes: 4096,
    TrustedFullAccess: true,
    ProjectScoped: true,
  });
  assert.equal(cliProbe.status, 0, `Safe Python capability probe failed: ${cliProbe.stdout}; ${cliProbe.stderr}`);
  assert.equal(parseOutput(cliProbe).ExitCode, 0,
    `Safe Python/CLI probe process failed: ${JSON.stringify(parseOutput(cliProbe))}`);
  const cliStatus = parseOutput(cliProbe).Stdout.trim();
  assert.match(cliStatus, /PYTHON_OK|DOTNET_OK|CLI_UNAVAILABLE/);
  const hasOnPath = (executable) => (process.env.PATH ?? '').split(delimiter)
    .some((entry) => existsSync(join(entry.trim().replace(/^"|"$/g, ''), executable)));
  const expectedCliStatus = hasOnPath('dotnet.exe') ? 'DOTNET_OK' : hasOnPath('python.exe') ? 'PYTHON_OK' : 'CLI_UNAVAILABLE';
  assert.equal(cliStatus, expectedCliStatus, 'Full must run an installed CLI from the configured PATH.');
  process.stdout.write(`PASS Full safe Python/CLI probe: ${cliStatus}\n`);

  const project = join(root, 'hardlink-project');
  const runtime = join(root, 'hardlink-runtime');
  await Promise.all([mkdir(project), mkdir(runtime)]);
  const sentinel = join(outside, 'sentinel.txt');
  const alias = join(project, 'alias.txt');
  const childStarted = join(project, 'child-started.txt');
  const originalBytes = Buffer.from('sentinel must stay byte-for-byte unchanged');
  await writeFile(sentinel, originalBytes, { flag: 'wx' });
  await link(sentinel, alias);
  const before = snapshot(sentinel);
  assert.equal(before.Links, 2, 'Synthetic sentinel must be an actual two-link file before the native call.');
  const run = invokeAsync(['--run', runtime], {
    WorkingFolder: project,
    Script: "$root = $env:GIGACHAT_PROJECT_ROOT; [System.IO.File]::WriteAllText((Join-Path $root 'child-started.txt'), 'started'); [System.IO.File]::WriteAllText((Join-Path $root 'alias.txt'), 'changed through a project hard link'); Start-Sleep -Milliseconds 1500",
    TimeoutMs: 5000,
    MaxOutputBytes: 4096,
  });
  const duringPromise = new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    .then(async () => ({ bytes: await readFile(sentinel), snapshot: snapshot(sentinel) }));
  const [result, duringData] = await Promise.all([run, duringPromise]);
  const during = duringData;
  const after = { bytes: await readFile(sentinel), snapshot: snapshot(sentinel) };
  assert.notEqual(result.status, 0,
    `The native helper must reject a working tree with an existing hard-link alias before launch; status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  const refusal = JSON.parse((result.stdout ?? '').trim());
  assert.equal(refusal.ExitCode, undefined, 'The PowerShell child must not have run for the unsafe tree.');
  await assert.rejects(readFile(childStarted), { code: 'ENOENT' },
    'The child-start marker must remain absent when the unsafe tree is rejected before launch.');
  assert.deepEqual(during.bytes, originalBytes, 'Sentinel bytes changed during native boundary setup.');
  assert.deepEqual(after.bytes, originalBytes, 'Sentinel bytes changed after native boundary cleanup.');
  assert.deepEqual(during.snapshot.Security, before.Security, 'Sentinel security changed during native boundary setup.');
  assert.deepEqual(after.snapshot.Security, before.Security, 'Sentinel security changed after native boundary cleanup.');
  assert.equal(after.snapshot.Identity, before.Identity);
  assert.equal(after.snapshot.Links, 2);
  process.stdout.write('PASS native preflight refuses a project hard-link before grant and preserves outside sentinel bytes/security.\n');

  const junctionProject = join(root, 'junction-project');
  const junctionRuntime = join(root, 'junction-runtime');
  const externalDirectory = join(outside, 'external-directory');
  await Promise.all([mkdir(junctionProject), mkdir(junctionRuntime), mkdir(externalDirectory)]);
  await writeFile(join(externalDirectory, 'external.txt'), 'outside', { flag: 'wx' });
  const junction = join(junctionProject, 'linked-directory');
  await symlink(externalDirectory, junction, 'junction');
  temporaryJunctions.push(junction);
  const junctionRun = invoke(['--run', junctionRuntime], {
    WorkingFolder: junctionProject,
    Script: "$root = $env:GIGACHAT_PROJECT_ROOT; [System.IO.File]::WriteAllText((Join-Path $root 'control.txt'), 'must-not-run')",
    TimeoutMs: 5000,
    MaxOutputBytes: 4096,
  });
  assert.notEqual(junctionRun.status, 0, 'Native preflight must not follow a project junction before granting inherited ACLs.');
  await assert.rejects(readFile(join(junctionProject, 'control.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(externalDirectory, 'external.txt'), 'utf8'), 'outside');
  process.stdout.write('PASS native preflight rejects a nested reparse point without following it.\n');
} finally {
  await removeFixture();
}
