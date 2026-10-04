import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, open, readdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('Native recovery verification requires Windows.');
}

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const helper = join(appRoot, 'resources', 'native', 'LocalPowerShell.exe');
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'gigachat-plan007-recovery-'));

function isWithin(parent, path) {
  const child = relative(parent, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertTemporaryRoot() {
  assert.ok(isWithin(temporaryRoot, root), 'Temporary harness root must stay below the OS temp directory.');
  assert.ok(root.toLocaleLowerCase('en-US').startsWith(
    join(temporaryRoot, 'gigachat-plan007-recovery-').toLocaleLowerCase('en-US')),
  'Temporary harness root must keep its unique expected prefix.');
}

assertTemporaryRoot();
const temporaryJunctions = [];

function invoke(args, input) {
  return spawnSync(helper, args, {
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function invokeAsync(args, input) {
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

async function writeLargeFixture(path, sizeBytes) {
  const file = await open(path, 'wx');
  try {
    const block = Buffer.alloc(1024 * 1024, 0x5a);
    for (let remaining = sizeBytes; remaining > 0;) {
      const length = Math.min(block.length, remaining);
      let offset = 0;
      while (offset < length) {
        const { bytesWritten } = await file.write(block, offset, length - offset, null);
        if (bytesWritten === 0) throw new Error('Unable to advance the synthetic race fixture write.');
        offset += bytesWritten;
      }
      remaining -= length;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function parseOutput(result) {
  assert.equal(result.error, undefined, result.error?.message);
  try { return JSON.parse((result.stdout ?? '').trim()); }
  catch { assert.fail(`Native helper returned no JSON response (exit ${result.status}).`); }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function instructionJournal({
  id, workingFolder, relativePath = 'AGENTS.md', targetExisted = false,
  expectedBytes = null, targetIdentity = null, intendedBytes, intendedIdentity = null,
  expectedSecurity = null, stage = 'prepared',
}) {
  return {
    Version: 1,
    Id: id,
    WorkingFolder: workingFolder,
    RelativePath: relativePath,
    TargetExisted: targetExisted,
    ExpectedHash: expectedBytes === null ? null : sha256(expectedBytes),
    TargetIdentity: targetIdentity,
    IntendedHash: sha256(intendedBytes),
    IntendedIdentity: intendedIdentity,
    ExpectedSecurity: expectedSecurity,
    TemporaryLeaf: `.gigachat-instruction-${id}.tmp`,
    BackupLeaf: `.gigachat-instruction-${id}.bak`,
    Stage: stage,
  };
}

async function assertMissingFile(path, message) {
  try { await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return; else throw error; }
  assert.fail(message);
}

async function seedInstructionJournal(runtime, journal) {
  const path = join(runtime, `instruction-write-${journal.Id}.json`);
  const bytes = `${JSON.stringify(journal)}\n`;
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, bytes };
}

async function seedBrokerJournal(runtime, journal) {
  const path = join(runtime, `write-${journal.Id}.json`);
  const bytes = `${JSON.stringify(journal)}\n`;
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, bytes };
}

function assertTargetConflict(result, target, message) {
  assert.equal(result.status, 0, result.stdout);
  const recovery = parseOutput(result);
  assert.equal(recovery.Recovered, false, message);
  assert.ok(Array.isArray(recovery.Conflicts) && recovery.Conflicts.some((path) => samePath(path, target)), message);
}

function samePath(left, right) {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US');
}

function readNativeFileIdentityAndSecurity(path) {
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class Plan007FileSnapshot {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetNamedSecurityInfoW(string path, uint type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
  static string Part(IntPtr descriptor, uint information) {
    IntPtr text;
    uint length;
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, information, out text, out length))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return Marshal.PtrToStringUni(text); }
    finally { if (text != IntPtr.Zero) LocalFree(text); }
  }
  public static string[] Read(string path) {
    const uint readAttributes = 0x80, openExisting = 3, openReparsePoint = 0x00200000;
    IntPtr handle = CreateFileW(path, readAttributes, 7, IntPtr.Zero, openExisting, openReparsePoint, IntPtr.Zero);
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
          Part(descriptor, 0x1), Part(descriptor, 0x2), Part(descriptor, 0x4), Part(descriptor, 0x10)
        };
      } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    } finally { CloseHandle(handle); }
  }
}
'@ | Out-Null
$parts = [Plan007FileSnapshot]::Read($path)
[pscustomobject]@{
  Identity = $parts[0]
  Security = [pscustomobject]@{ Owner = $parts[1]; Group = $parts[2]; Dacl = $parts[3]; Label = $parts[4] }
} | ConvertTo-Json -Compress -Depth 3`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Cannot read Windows file snapshot: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

try {
  const project = join(root, 'project');
  const recovery = join(root, 'runtime');
  await Promise.all([mkdir(project), mkdir(recovery)]);

  const id = 'a07c45a6ddf34ceda1b23dc5b11b2301';
  const target = join(project, 'AGENTS.md');
  const backupLeaf = `.gigachat-write-${id}.bak`;
  const temporaryLeaf = `.gigachat-write-${id}.tmp`;
  const journal = join(recovery, `write-${id}.json`);
  await Promise.all([
    writeFile(target, 'external version', { flag: 'wx' }),
    writeFile(join(project, backupLeaf), 'previous version', { flag: 'wx' }),
    writeFile(join(project, temporaryLeaf), 'pending intended version', { flag: 'wx' }),
    writeFile(journal, JSON.stringify({
      Id: id,
      WorkingFolder: project,
      RelativePath: 'AGENTS.md',
      TargetExisted: true,
      TemporaryLeaf: temporaryLeaf,
      BackupLeaf: backupLeaf,
    }), { flag: 'wx' }),
  ]);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = invoke(['--recover', recovery]);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(await readFile(target, 'utf8'), 'external version',
      'Recovery must not overwrite a target changed by an external editor.');
    assert.notEqual(result.status, 0,
      'Recovery must report conflict when the target changed while a backup exists.');
    assert.doesNotMatch(result.stdout ?? '', /"recovered"\s*:\s*true/,
      'Recovery must not report success while preserving an unresolved conflict.');
  }
  assert.equal(await readFile(join(project, backupLeaf), 'utf8'), 'previous version');
  assert.equal(await readFile(join(project, temporaryLeaf), 'utf8'), 'pending intended version');
  assert.equal(await readFile(journal, 'utf8').then(() => true, () => false), true);
  process.stdout.write('PASS native broker recovery preserves external target, backup, temp, and conflict journal.\n');

  const brokerCommittedRoot = join(root, 'broker-committed-project');
  const brokerCommittedRuntime = join(root, 'broker-committed-runtime');
  await Promise.all([mkdir(brokerCommittedRoot), mkdir(brokerCommittedRuntime)]);
  const brokerCommittedId = '5fc19897bd104d72a23456789abcdef0';
  const brokerCommittedTarget = join(brokerCommittedRoot, 'notes.md');
  const brokerCommittedBackup = join(brokerCommittedRoot, `.gigachat-write-${brokerCommittedId}.bak`);
  const brokerCommittedOld = Buffer.from('original broker file');
  const brokerCommittedNew = Buffer.from('committed broker file');
  await Promise.all([
    writeFile(brokerCommittedTarget, brokerCommittedNew, { flag: 'wx' }),
    writeFile(brokerCommittedBackup, brokerCommittedOld, { flag: 'wx' }),
  ]);
  const brokerCommittedTargetSnapshot = readNativeFileIdentityAndSecurity(brokerCommittedTarget);
  const brokerCommittedBackupSnapshot = readNativeFileIdentityAndSecurity(brokerCommittedBackup);
  const brokerCommittedJournal = {
    Version: 1,
    Id: brokerCommittedId,
    WorkingFolder: brokerCommittedRoot,
    RelativePath: 'notes.md',
    TargetExisted: true,
    ExpectedHash: sha256(brokerCommittedOld),
    TargetIdentity: brokerCommittedBackupSnapshot.Identity,
    IntendedHash: sha256(brokerCommittedNew),
    IntendedIdentity: brokerCommittedTargetSnapshot.Identity,
    ExpectedSecurity: brokerCommittedBackupSnapshot.Security,
    TemporaryLeaf: `.gigachat-write-${brokerCommittedId}.tmp`,
    BackupLeaf: `.gigachat-write-${brokerCommittedId}.bak`,
    Stage: 'committed',
  };
  const brokerCommittedJournalFiles = await seedBrokerJournal(brokerCommittedRuntime, brokerCommittedJournal);
  const brokerCommittedRecovery = invoke(['--recover', brokerCommittedRuntime]);
  assert.equal(brokerCommittedRecovery.status, 0, brokerCommittedRecovery.stdout);
  assert.equal(parseOutput(brokerCommittedRecovery).recovered, true,
    'A versioned committed broker write should finish only after target and displaced snapshots match.');
  assert.deepEqual(await readFile(brokerCommittedTarget), brokerCommittedNew);
  await assertMissingFile(brokerCommittedBackup,
    'A verified committed broker backup should be removed after durable committed recovery.');
  await assertMissingFile(brokerCommittedJournalFiles.path,
    'A verified committed broker journal should be removed after recovery.');
  process.stdout.write('PASS versioned committed broker recovery preserves the target and finishes verified cleanup.\n');

  const brokerWriterRoot = join(root, 'broker-writer-project');
  const brokerWriterRuntime = join(root, 'broker-writer-runtime');
  await Promise.all([mkdir(brokerWriterRoot), mkdir(brokerWriterRuntime)]);
  const opaqueTarget = join(brokerWriterRoot, 'opaque.dat');
  const opaqueOriginal = Buffer.from([0xff, 0x00, 0x80, 0x7f]);
  const opaqueReplacement = Buffer.from('generic write over a binary original');
  await writeFile(opaqueTarget, opaqueOriginal, { flag: 'wx' });
  const opaqueWrite = invoke(['--write', brokerWriterRuntime], {
    WorkingFolder: brokerWriterRoot,
    RelativePath: 'opaque.dat',
    ContentsBase64: opaqueReplacement.toString('base64'),
  });
  assert.equal(opaqueWrite.status, 0, `Generic broker replacement failed: ${opaqueWrite.stdout}`);
  assert.deepEqual(parseOutput(opaqueWrite), { Bytes: opaqueReplacement.length, ReplacedExisting: true });
  assert.deepEqual(await readFile(opaqueTarget), opaqueReplacement,
    'Generic writes must retain support for replacing an existing file that was not UTF-8 text.');

  const createdTarget = join(brokerWriterRoot, 'created.md');
  const createdBytes = Buffer.from('new generic broker file');
  const createWrite = invoke(['--write', brokerWriterRuntime], {
    WorkingFolder: brokerWriterRoot,
    RelativePath: 'created.md',
    ContentsBase64: createdBytes.toString('base64'),
  });
  assert.equal(createWrite.status, 0, `Generic broker create failed: ${createWrite.stdout}`);
  assert.deepEqual(parseOutput(createWrite), { Bytes: createdBytes.length, ReplacedExisting: false });
  assert.deepEqual(await readFile(createdTarget), createdBytes);
  assert.equal((await readdir(brokerWriterRoot)).some((name) => name.startsWith('.gigachat-write-')), false,
    'Successful create and replace must leave no broker temp or backup files.');
  process.stdout.write('PASS generic broker create and replacement fingerprint raw existing bytes.\n');

  const brokerCleanupRaceRoot = join(root, 'broker-cleanup-race-project');
  const brokerCleanupRaceRuntime = join(root, 'broker-cleanup-race-runtime');
  await Promise.all([mkdir(brokerCleanupRaceRoot), mkdir(brokerCleanupRaceRuntime)]);
  const brokerCleanupRaceTarget = join(brokerCleanupRaceRoot, 'large.bin');
  const brokerCleanupRaceBackupPath = join(brokerCleanupRaceRoot, '.external-race-preserved.bin');
  const brokerCleanupRaceBackupLeaf = (id) => join(brokerCleanupRaceRoot, `.gigachat-write-${id}.bak`);
  const brokerCleanupRaceExternal = Buffer.from('external version installed during broker cleanup');
  const brokerCleanupRaceReplacement = Buffer.from('new target bytes');
  await writeLargeFixture(brokerCleanupRaceTarget, 128 * 1024 * 1024);
  const brokerCleanupRaceCall = invokeAsync(['--write', brokerCleanupRaceRuntime], {
    WorkingFolder: brokerCleanupRaceRoot,
    RelativePath: 'large.bin',
    ContentsBase64: brokerCleanupRaceReplacement.toString('base64'),
  });
  let brokerCleanupRaceFinished = false;
  const brokerCleanupRaceResultPromise = brokerCleanupRaceCall.result.then((result) => {
    brokerCleanupRaceFinished = true;
    return result;
  });
  const brokerCleanupRaceDeadline = Date.now() + 30_000;
  let brokerCleanupRaceStageSeen = false;
  let brokerCleanupRaceBlockedAttempts = 0;
  let brokerCleanupRaceReplaced = false;
  let brokerCleanupRaceBackupMissing = false;
  let brokerCleanupRaceDelayApplied = false;
  let brokerCleanupRaceBackup = null;
  while (!brokerCleanupRaceFinished && Date.now() < brokerCleanupRaceDeadline) {
    const names = await readdir(brokerCleanupRaceRuntime);
    let journal = null;
    for (const name of names.filter((item) => /^write-[0-9a-f]{32}\.json$/i.test(item))) {
      try {
        journal = { path: join(brokerCleanupRaceRuntime, name), value: JSON.parse(await readFile(join(brokerCleanupRaceRuntime, name), 'utf8')) };
        break;
      } catch (error) {
        if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      }
    }
    if (journal?.value.Stage === 'committed') {
      brokerCleanupRaceStageSeen = true;
      brokerCleanupRaceBackup ??= brokerCleanupRaceBackupLeaf(journal.value.Id);
      if (!brokerCleanupRaceDelayApplied) {
        brokerCleanupRaceDelayApplied = true;
        await delay(8);
      }
      try {
        await rename(brokerCleanupRaceBackup, brokerCleanupRaceBackupPath);
        await writeFile(brokerCleanupRaceBackup, brokerCleanupRaceExternal, { flag: 'wx' });
        brokerCleanupRaceReplaced = true;
        break;
      } catch (error) {
        if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
          brokerCleanupRaceBlockedAttempts++;
        } else if (error.code === 'ENOENT') {
          brokerCleanupRaceBackupMissing = true;
          break;
        } else {
          throw error;
        }
      }
    }
    await delay(1);
  }
  const brokerCleanupRaceResult = await brokerCleanupRaceResultPromise;
  assert.equal(brokerCleanupRaceResult.error, undefined, brokerCleanupRaceResult.error?.message);
  assert.ok(brokerCleanupRaceStageSeen, 'The bounded cleanup race must observe a durable committed journal stage.');
  assert.ok(brokerCleanupRaceReplaced || brokerCleanupRaceBlockedAttempts > 0,
    'The bounded cleanup race must either replace the backup or observe the handle denying replacement.');
  assert.deepEqual(await readFile(brokerCleanupRaceTarget), brokerCleanupRaceReplacement);
  if (brokerCleanupRaceReplaced) {
    assert.deepEqual(await readFile(brokerCleanupRaceBackup), brokerCleanupRaceExternal,
      'A version installed at the backup path during cleanup must remain there.');
  } else if (brokerCleanupRaceResult.status === 0) {
    await assertMissingFile(brokerCleanupRaceBackup,
      'A successful cleanup should remove the verified displaced version after blocking the external rename.');
    assert.equal((await readdir(brokerCleanupRaceRuntime)).some((name) => /^write-[0-9a-f]{32}\.json$/i.test(name)), false,
      'A successful cleanup should finish its broker journal after deleting only the verified backup handle.');
  } else {
    assert.ok(brokerCleanupRaceBlockedAttempts > 0 || brokerCleanupRaceBackupMissing,
      'A failed cleanup must preserve its unresolved backup and journal.');
  }
  process.stdout.write(`PASS broker cleanup resists backup-path replacement (blocked=${brokerCleanupRaceBlockedAttempts}, replaced=${brokerCleanupRaceReplaced}).\n`);

  const brokerPreparedRoot = join(root, 'broker-prepared-project');
  const brokerPreparedRuntime = join(root, 'broker-prepared-runtime');
  await Promise.all([mkdir(brokerPreparedRoot), mkdir(brokerPreparedRuntime)]);
  const brokerPreparedId = '6ad2a8cb4c884a75839500ce221199aa';
  const brokerPreparedTarget = join(brokerPreparedRoot, 'notes.md');
  const brokerPreparedTemp = join(brokerPreparedRoot, `.gigachat-write-${brokerPreparedId}.tmp`);
  const brokerPreparedOld = Buffer.from('original before interrupted broker replace');
  const brokerPreparedNew = Buffer.from('temporary broker version');
  await Promise.all([
    writeFile(brokerPreparedTarget, brokerPreparedOld, { flag: 'wx' }),
    writeFile(brokerPreparedTemp, brokerPreparedNew, { flag: 'wx' }),
  ]);
  const brokerPreparedTargetSnapshot = readNativeFileIdentityAndSecurity(brokerPreparedTarget);
  const brokerPreparedTempSnapshot = readNativeFileIdentityAndSecurity(brokerPreparedTemp);
  assert.deepEqual(brokerPreparedTargetSnapshot.Security, brokerPreparedTempSnapshot.Security);
  const brokerPreparedJournal = {
    Version: 1,
    Id: brokerPreparedId,
    WorkingFolder: brokerPreparedRoot,
    RelativePath: 'notes.md',
    TargetExisted: true,
    ExpectedHash: sha256(brokerPreparedOld),
    TargetIdentity: brokerPreparedTargetSnapshot.Identity,
    IntendedHash: sha256(brokerPreparedNew),
    IntendedIdentity: brokerPreparedTempSnapshot.Identity,
    ExpectedSecurity: brokerPreparedTargetSnapshot.Security,
    TemporaryLeaf: `.gigachat-write-${brokerPreparedId}.tmp`,
    BackupLeaf: `.gigachat-write-${brokerPreparedId}.bak`,
    Stage: 'prepared',
  };
  const brokerPreparedJournalFiles = await seedBrokerJournal(brokerPreparedRuntime, brokerPreparedJournal);
  const brokerPreparedRecovery = invoke(['--recover', brokerPreparedRuntime]);
  assert.equal(brokerPreparedRecovery.status, 0, brokerPreparedRecovery.stdout);
  assert.equal(parseOutput(brokerPreparedRecovery).recovered, true);
  assert.deepEqual(await readFile(brokerPreparedTarget), brokerPreparedOld,
    'Prepared rollback must leave the unchanged original target intact.');
  await assertMissingFile(brokerPreparedTemp, 'Prepared rollback should remove only its verified temp.');
  await assertMissingFile(brokerPreparedJournalFiles.path, 'Prepared rollback should remove its resolved journal.');
  process.stdout.write('PASS prepared broker recovery removes only its verified temporary version.\n');

  const brokerChangedRoot = join(root, 'broker-external-project');
  const brokerChangedRuntime = join(root, 'broker-external-runtime');
  await Promise.all([mkdir(brokerChangedRoot), mkdir(brokerChangedRuntime)]);
  const brokerChangedId = '7be3b9dc5d994b8694a611df3322a1bb';
  const brokerChangedTarget = join(brokerChangedRoot, 'notes.md');
  const brokerChangedBackup = join(brokerChangedRoot, `.gigachat-write-${brokerChangedId}.bak`);
  const brokerOldBytes = Buffer.from('original broker version');
  const brokerIntendedBytes = Buffer.from('same broker bytes after external replacement');
  const brokerOriginalIntendedPath = join(brokerChangedRoot, 'intended-original.tmp');
  const brokerExternalReplacementPath = join(brokerChangedRoot, 'external-replacement.tmp');
  await Promise.all([
    writeFile(brokerChangedTarget, brokerIntendedBytes, { flag: 'wx' }),
    writeFile(brokerChangedBackup, brokerOldBytes, { flag: 'wx' }),
  ]);
  const brokerOriginalTargetSnapshot = readNativeFileIdentityAndSecurity(brokerChangedTarget);
  const brokerChangedBackupSnapshot = readNativeFileIdentityAndSecurity(brokerChangedBackup);
  await rename(brokerChangedTarget, brokerOriginalIntendedPath);
  await writeFile(brokerExternalReplacementPath, brokerIntendedBytes, { flag: 'wx' });
  const brokerExternalSnapshot = readNativeFileIdentityAndSecurity(brokerExternalReplacementPath);
  assert.notEqual(brokerExternalSnapshot.Identity, brokerOriginalTargetSnapshot.Identity);
  await rename(brokerExternalReplacementPath, brokerChangedTarget);
  const brokerChangedJournal = {
    Version: 1,
    Id: brokerChangedId,
    WorkingFolder: brokerChangedRoot,
    RelativePath: 'notes.md',
    TargetExisted: true,
    ExpectedHash: sha256(brokerOldBytes),
    TargetIdentity: brokerChangedBackupSnapshot.Identity,
    IntendedHash: sha256(brokerIntendedBytes),
    IntendedIdentity: brokerOriginalTargetSnapshot.Identity,
    ExpectedSecurity: brokerChangedBackupSnapshot.Security,
    TemporaryLeaf: `.gigachat-write-${brokerChangedId}.tmp`,
    BackupLeaf: `.gigachat-write-${brokerChangedId}.bak`,
    Stage: 'displaced',
  };
  const brokerChangedJournalFiles = await seedBrokerJournal(brokerChangedRuntime, brokerChangedJournal);
  const brokerChangedRecovery = invoke(['--recover', brokerChangedRuntime]);
  assert.notEqual(brokerChangedRecovery.status, 0,
    'A same-content external replacement with a different file identity must remain unresolved.');
  assert.deepEqual(await readFile(brokerChangedTarget), brokerIntendedBytes);
  assert.deepEqual(await readFile(brokerChangedBackup), brokerOldBytes);
  assert.deepEqual(await readFile(brokerOriginalIntendedPath), brokerIntendedBytes);
  assert.equal(await readFile(brokerChangedJournalFiles.path, 'utf8'), brokerChangedJournalFiles.bytes);
  process.stdout.write('PASS broker recovery preserves an external same-content replacement with a new identity.\n');

  const profile = join(root, 'profile');
  const instructionRuntime = join(root, 'instruction-runtime');
  const missingProject = join(root, 'missing-project');
  const writerProject = join(root, 'writer-project');
  await Promise.all([mkdir(profile), mkdir(instructionRuntime), mkdir(writerProject)]);

  const writerTarget = join(writerProject, 'AGENTS.md');
  const firstRevision = Buffer.from('first instruction revision');
  const firstWrite = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: writerProject,
    RelativePath: 'AGENTS.md',
    ContentsBase64: firstRevision.toString('base64'),
    ExpectedHash: null,
  });
  assert.equal(firstWrite.status, 0, `Native instruction create failed: ${firstWrite.stdout}`);
  assert.equal(parseOutput(firstWrite).Kind, 'saved');
  assert.deepEqual(await readFile(writerTarget), firstRevision);

  const bomRevision = Buffer.from('\uFEFF# BOM instruction revision\n');
  const updateWrite = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: writerProject,
    RelativePath: 'AGENTS.md',
    ContentsBase64: bomRevision.toString('base64'),
    ExpectedHash: sha256(firstRevision),
  });
  assert.equal(updateWrite.status, 0,
    `Native instruction update must release its staged-file read handle before replacement: ${updateWrite.stdout}`);
  assert.equal(parseOutput(updateWrite).Kind, 'saved');
  assert.deepEqual(await readFile(writerTarget), bomRevision,
    'Update must preserve the exact BOM bytes written by the editor.');

  const latestRevision = Buffer.from('plain revision after BOM');
  const postBomWrite = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: writerProject,
    RelativePath: 'AGENTS.md',
    ContentsBase64: latestRevision.toString('base64'),
    ExpectedHash: sha256(bomRevision),
  });
  assert.equal(postBomWrite.status, 0,
    `A revision computed from a valid leading BOM must allow the next update: ${postBomWrite.stdout}`);
  assert.equal(parseOutput(postBomWrite).Kind, 'saved');
  assert.deepEqual(await readFile(writerTarget), latestRevision,
    'The post-BOM update must commit the exact latest bytes.');

  const staleWrite = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: writerProject,
    RelativePath: 'AGENTS.md',
    ContentsBase64: Buffer.from('stale draft').toString('base64'),
    ExpectedHash: sha256(firstRevision),
  });
  assert.equal(staleWrite.status, 0, staleWrite.stdout);
  const staleResult = parseOutput(staleWrite);
  assert.equal(staleResult.Kind, 'conflict-before',
    'A stale expected revision must report conflict before writing.');
  assert.equal(staleResult.CurrentText, latestRevision.toString(),
    'A stale revision must return the latest plain text after the BOM revision.');
  assert.deepEqual(await readFile(writerTarget), latestRevision,
    'A stale write must leave the latest revision byte-for-byte unchanged.');
  assert.equal((await readdir(writerProject)).some((name) => name.startsWith('.gigachat-instruction-')), false,
    'Successful and stale writes must not leave instruction temp or backup files.');
  process.stdout.write('PASS native instruction create, BOM update, post-BOM update, and stale-revision conflict.\n');

  const unresolvedId = '10a1b2c3d4e54a67890123456789abcd';
  const intended = Buffer.from('pending instruction');
  const unresolvedJournal = {
    Version: 1,
    Id: unresolvedId,
    WorkingFolder: missingProject,
    RelativePath: 'AGENTS.md',
    TargetExisted: false,
    ExpectedHash: null,
    TargetIdentity: null,
    IntendedHash: sha256(intended),
    IntendedIdentity: null,
    ExpectedSecurity: null,
    TemporaryLeaf: `.gigachat-instruction-${unresolvedId}.tmp`,
    BackupLeaf: `.gigachat-instruction-${unresolvedId}.bak`,
    Stage: 'prepared',
  };
  const unresolvedJournalPath = join(instructionRuntime, `instruction-write-${unresolvedId}.json`);
  const unresolvedJournalBytes = `${JSON.stringify(unresolvedJournal)}\n`;
  await writeFile(unresolvedJournalPath, unresolvedJournalBytes, { flag: 'wx' });

  const copyId = 'a5c1d3e4-f567-4890-abcd-ef0123456789';
  const localDraft = Buffer.from('local draft to preserve');
  const copyPath = join(profile, 'instruction-conflicts', 'project', `${copyId}.md`);
  const copyResult = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: profile,
    RelativePath: `instruction-conflicts/project/${copyId}.md`,
    ContentsBase64: localDraft.toString('base64'),
    ExpectedHash: null,
  });
  assert.equal(copyResult.error, undefined, copyResult.error?.message);
  assert.equal(copyResult.status, 0, `A valid unresolved journal for another target must not block a separate app-owned copy: ${copyResult.stdout}`);
  assert.equal(parseOutput(copyResult).Kind, 'saved');
  assert.deepEqual(await readFile(copyPath), localDraft,
    'The separate app-owned copy must be created with the exact local draft bytes.');
  assert.equal(await readFile(unresolvedJournalPath, 'utf8'), unresolvedJournalBytes,
    'Recovery must preserve a valid unresolved journal for the missing target.');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recoveryResult = invoke(['--recover-instructions', instructionRuntime]);
    assert.equal(recoveryResult.status, 0, recoveryResult.stdout);
    const recoveryState = parseOutput(recoveryResult);
    assert.equal(recoveryState.Recovered, false);
    assert.ok(Array.isArray(recoveryState.Conflicts)
      && recoveryState.Conflicts.some((conflict) => samePath(conflict, join(missingProject, 'AGENTS.md'))),
    'Repeated recovery must report the validated target-specific conflict.');
    assert.equal(await readFile(unresolvedJournalPath, 'utf8'), unresolvedJournalBytes);
    assert.deepEqual(await readFile(copyPath), localDraft,
      'Recovery must preserve the independent saved copy.');
  }
  process.stdout.write('PASS valid unresolved instruction journal preserves its target and allows a separate app-owned copy.\n');

  const malformedId = 'b6d2e4f5a6784901bcdef0123456789a';
  const malformed = {
    ...unresolvedJournal,
    Id: malformedId,
    TemporaryLeaf: '.unexpected.tmp',
    BackupLeaf: `.gigachat-instruction-${malformedId}.bak`,
  };
  const malformedPath = join(instructionRuntime, `instruction-write-${malformedId}.json`);
  const malformedBytes = `${JSON.stringify(malformed)}\n`;
  await writeFile(malformedPath, malformedBytes, { flag: 'wx' });
  const refusedId = 'c7e3f506-b789-4012-cdef-0123456789ab';
  const refusedPath = join(profile, 'instruction-conflicts', 'project', `${refusedId}.md`);
  const refusedResult = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: profile,
    RelativePath: `instruction-conflicts/project/${refusedId}.md`,
    ContentsBase64: Buffer.from('must remain absent').toString('base64'),
    ExpectedHash: null,
  });
  assert.notEqual(refusedResult.status, 0,
    'Malformed instruction recovery metadata must continue to fail closed globally.');
  assert.equal(await readFile(malformedPath, 'utf8'), malformedBytes,
    'Malformed journal must remain available for diagnosis.');
  let refusedCopyExists = true;
  try { await readFile(refusedPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') refusedCopyExists = false; else throw error; }
  assert.equal(refusedCopyExists, false, 'A malformed journal must prevent a new app-owned copy.');
  process.stdout.write('PASS malformed instruction journal remains globally fail-closed.\n');

  await unlink(malformedPath);
  const resumedResult = invoke(['--write-instruction', instructionRuntime], {
    WorkingFolder: profile,
    RelativePath: `instruction-conflicts/project/${refusedId}.md`,
    ContentsBase64: Buffer.from('must remain absent').toString('base64'),
    ExpectedHash: null,
  });
  assert.equal(resumedResult.error, undefined, resumedResult.error?.message);
  assert.equal(resumedResult.status, 0,
    `Removing only malformed metadata must allow the valid separate copy despite the unresolved project journal: ${resumedResult.stdout}`);
  assert.equal(parseOutput(resumedResult).Kind, 'saved');
  assert.deepEqual(await readFile(refusedPath), Buffer.from('must remain absent'));
  assert.equal(await readFile(unresolvedJournalPath, 'utf8'), unresolvedJournalBytes,
    'The independent save must leave the valid unresolved target journal untouched.');
  process.stdout.write('PASS valid missing-target journal does not block a separate app-owned copy after malformed journal removal.\n');

  const preparedRoot = join(root, 'prepared-project');
  const preparedRuntime = join(root, 'prepared-runtime');
  await Promise.all([mkdir(preparedRoot), mkdir(preparedRuntime)]);
  const preparedId = 'd8f41627c8904a13def0123456789abc';
  const preparedBytes = Buffer.from('prepared instruction');
  const preparedTemp = join(preparedRoot, `.gigachat-instruction-${preparedId}.tmp`);
  await writeFile(preparedTemp, preparedBytes, { flag: 'wx' });
  const preparedSnapshot = readNativeFileIdentityAndSecurity(preparedTemp);
  const preparedJournal = instructionJournal({
    id: preparedId,
    workingFolder: preparedRoot,
    intendedBytes: preparedBytes,
    intendedIdentity: preparedSnapshot.Identity,
    expectedSecurity: preparedSnapshot.Security,
  });
  const preparedJournalFiles = await seedInstructionJournal(preparedRuntime, preparedJournal);
  const preparedRecovery = invoke(['--recover-instructions', preparedRuntime]);
  assert.equal(preparedRecovery.status, 0, preparedRecovery.stdout);
  assert.equal(parseOutput(preparedRecovery).Recovered, true,
    'A prepared write with a matching recorded temp identity and security can be rolled back.');
  await assertMissingFile(join(preparedRoot, 'AGENTS.md'), 'Prepared rollback must not create the target.');
  await assertMissingFile(preparedTemp, 'Prepared rollback should remove only its verified temp.');
  await assertMissingFile(preparedJournalFiles.path, 'Prepared rollback should remove its resolved journal.');
  process.stdout.write('PASS prepared instruction journal rolls back its verified temporary file.\n');

  const unexpectedTempRoot = join(root, 'unexpected-temp-project');
  const unexpectedTempRuntime = join(root, 'unexpected-temp-runtime');
  await Promise.all([mkdir(unexpectedTempRoot), mkdir(unexpectedTempRuntime)]);
  const unexpectedTempId = 'e9a52738d9014b24ef0123456789abcd';
  const sameContentTemp = Buffer.from('same content, different recorded identity');
  const unexpectedTempPath = join(unexpectedTempRoot, `.gigachat-instruction-${unexpectedTempId}.tmp`);
  await writeFile(unexpectedTempPath, sameContentTemp, { flag: 'wx' });
  const actualTempSnapshot = readNativeFileIdentityAndSecurity(unexpectedTempPath);
  const unexpectedIdentity = actualTempSnapshot.Identity === '0'.repeat(24) ? '1'.repeat(24) : '0'.repeat(24);
  const unexpectedTempJournal = instructionJournal({
    id: unexpectedTempId,
    workingFolder: unexpectedTempRoot,
    intendedBytes: sameContentTemp,
    intendedIdentity: unexpectedIdentity,
    expectedSecurity: actualTempSnapshot.Security,
  });
  const unexpectedTempJournalFiles = await seedInstructionJournal(unexpectedTempRuntime, unexpectedTempJournal);
  const unexpectedTempRecovery = invoke(['--recover-instructions', unexpectedTempRuntime]);
  assertTargetConflict(unexpectedTempRecovery, join(unexpectedTempRoot, 'AGENTS.md'),
    'Same-content temp with a different file identity must remain unresolved.');
  assert.deepEqual(await readFile(unexpectedTempPath), sameContentTemp);
  assert.equal(await readFile(unexpectedTempJournalFiles.path, 'utf8'), unexpectedTempJournalFiles.bytes);
  process.stdout.write('PASS prepared recovery preserves a same-content temp with an unexpected identity.\n');

  const changedDescriptorRoot = join(root, 'changed-descriptor-project');
  const changedDescriptorRuntime = join(root, 'changed-descriptor-runtime');
  await Promise.all([mkdir(changedDescriptorRoot), mkdir(changedDescriptorRuntime)]);
  const changedDescriptorId = 'fa6b3849e0124c35af0123456789abcd';
  const descriptorTempBytes = Buffer.from('descriptor checked temp');
  const descriptorTempPath = join(changedDescriptorRoot, `.gigachat-instruction-${changedDescriptorId}.tmp`);
  await writeFile(descriptorTempPath, descriptorTempBytes, { flag: 'wx' });
  const descriptorTempSnapshot = readNativeFileIdentityAndSecurity(descriptorTempPath);
  const wrongSecurity = { ...descriptorTempSnapshot.Security, Dacl: 'descriptor changed after journal' };
  const changedDescriptorJournal = instructionJournal({
    id: changedDescriptorId,
    workingFolder: changedDescriptorRoot,
    intendedBytes: descriptorTempBytes,
    intendedIdentity: descriptorTempSnapshot.Identity,
    expectedSecurity: wrongSecurity,
  });
  const changedDescriptorJournalFiles = await seedInstructionJournal(changedDescriptorRuntime, changedDescriptorJournal);
  const changedDescriptorRecovery = invoke(['--recover-instructions', changedDescriptorRuntime]);
  assertTargetConflict(changedDescriptorRecovery, join(changedDescriptorRoot, 'AGENTS.md'),
    'Prepared recovery must not delete a temp whose descriptor differs from the journal.');
  assert.deepEqual(await readFile(descriptorTempPath), descriptorTempBytes);
  assert.equal(await readFile(changedDescriptorJournalFiles.path, 'utf8'), changedDescriptorJournalFiles.bytes);
  process.stdout.write('PASS prepared recovery preserves a temp with a changed security descriptor.\n');

  const committedRoot = join(root, 'committed-project');
  const committedRuntime = join(root, 'committed-runtime');
  await Promise.all([mkdir(committedRoot), mkdir(committedRuntime)]);
  const committedId = '0a7c495a123d4e56b0123456789abcde';
  const committedOld = Buffer.from('committed original version');
  const committedNew = Buffer.from('committed intended version');
  const committedTarget = join(committedRoot, 'AGENTS.md');
  const committedBackup = join(committedRoot, `.gigachat-instruction-${committedId}.bak`);
  await Promise.all([
    writeFile(committedTarget, committedNew, { flag: 'wx' }),
    writeFile(committedBackup, committedOld, { flag: 'wx' }),
  ]);
  const committedTargetSnapshot = readNativeFileIdentityAndSecurity(committedTarget);
  const committedBackupSnapshot = readNativeFileIdentityAndSecurity(committedBackup);
  assert.notEqual(committedTargetSnapshot.Identity, committedBackupSnapshot.Identity);
  assert.deepEqual(committedTargetSnapshot.Security, committedBackupSnapshot.Security,
    'Synthetic target and backup should retain their inherited Windows descriptor.');
  const committedJournal = instructionJournal({
    id: committedId,
    workingFolder: committedRoot,
    targetExisted: true,
    expectedBytes: committedOld,
    targetIdentity: committedBackupSnapshot.Identity,
    intendedBytes: committedNew,
    intendedIdentity: committedTargetSnapshot.Identity,
    expectedSecurity: committedBackupSnapshot.Security,
    stage: 'committed',
  });
  const committedJournalFiles = await seedInstructionJournal(committedRuntime, committedJournal);
  const committedRecovery = invoke(['--recover-instructions', committedRuntime]);
  assert.equal(committedRecovery.status, 0, committedRecovery.stdout);
  assert.equal(parseOutput(committedRecovery).Recovered, true,
    'A committed replace with exact file identities and descriptors should finish cleanup.');
  assert.deepEqual(await readFile(committedTarget), committedNew);
  assert.deepEqual(readNativeFileIdentityAndSecurity(committedTarget).Security, committedTargetSnapshot.Security,
    'Recovery must preserve the committed target descriptor.');
  await assertMissingFile(committedBackup, 'A verified committed backup should be cleaned up.');
  await assertMissingFile(committedJournalFiles.path, 'A verified committed journal should be cleaned up.');
  process.stdout.write('PASS committed replace recovery validates identity and descriptor before cleanup.\n');

  const unexpectedBackupRoot = join(root, 'unexpected-backup-project');
  const unexpectedBackupRuntime = join(root, 'unexpected-backup-runtime');
  await Promise.all([mkdir(unexpectedBackupRoot), mkdir(unexpectedBackupRuntime)]);
  const unexpectedBackupId = '0b8d5a6b234e4f67c123456789abcdef';
  const unexpectedBackupTarget = join(unexpectedBackupRoot, 'AGENTS.md');
  const unexpectedBackupPath = join(unexpectedBackupRoot, `.gigachat-instruction-${unexpectedBackupId}.bak`);
  const unexpectedBackupNew = Buffer.from('created target with unowned backup');
  const unexpectedBackupOld = Buffer.from('unexpected backup version');
  await Promise.all([
    writeFile(unexpectedBackupTarget, unexpectedBackupNew, { flag: 'wx' }),
    writeFile(unexpectedBackupPath, unexpectedBackupOld, { flag: 'wx' }),
  ]);
  const unexpectedBackupTargetSnapshot = readNativeFileIdentityAndSecurity(unexpectedBackupTarget);
  const unexpectedBackupJournal = instructionJournal({
    id: unexpectedBackupId,
    workingFolder: unexpectedBackupRoot,
    intendedBytes: unexpectedBackupNew,
    intendedIdentity: unexpectedBackupTargetSnapshot.Identity,
    expectedSecurity: unexpectedBackupTargetSnapshot.Security,
    stage: 'committed',
  });
  const unexpectedBackupJournalFiles = await seedInstructionJournal(unexpectedBackupRuntime, unexpectedBackupJournal);
  const unexpectedBackupRecovery = invoke(['--recover-instructions', unexpectedBackupRuntime]);
  assertTargetConflict(unexpectedBackupRecovery, unexpectedBackupTarget,
    'A committed create with an unexpected backup must remain unresolved.');
  assert.deepEqual(await readFile(unexpectedBackupTarget), unexpectedBackupNew);
  assert.deepEqual(await readFile(unexpectedBackupPath), unexpectedBackupOld);
  assert.equal(await readFile(unexpectedBackupJournalFiles.path, 'utf8'), unexpectedBackupJournalFiles.bytes);
  process.stdout.write('PASS committed create recovery preserves an unexpected backup and its journal.\n');

  const unexpectedCommittedRoot = join(root, 'unexpected-committed-project');
  const unexpectedCommittedRuntime = join(root, 'unexpected-committed-runtime');
  await Promise.all([mkdir(unexpectedCommittedRoot), mkdir(unexpectedCommittedRuntime)]);
  const unexpectedCommittedId = '1b8d5a6b234e4f67c123456789abcdef';
  const unexpectedCommittedTarget = join(unexpectedCommittedRoot, 'AGENTS.md');
  const unexpectedCommittedBackup = join(unexpectedCommittedRoot, `.gigachat-instruction-${unexpectedCommittedId}.bak`);
  const unexpectedCommittedTemp = join(unexpectedCommittedRoot, `.gigachat-instruction-${unexpectedCommittedId}.tmp`);
  const unexpectedCommittedNew = Buffer.from('committed target with unexpected temp');
  const unexpectedCommittedOld = Buffer.from('expected displaced version');
  await Promise.all([
    writeFile(unexpectedCommittedTarget, unexpectedCommittedNew, { flag: 'wx' }),
    writeFile(unexpectedCommittedBackup, unexpectedCommittedOld, { flag: 'wx' }),
    writeFile(unexpectedCommittedTemp, 'unexpected version', { flag: 'wx' }),
  ]);
  const unexpectedCommittedTargetSnapshot = readNativeFileIdentityAndSecurity(unexpectedCommittedTarget);
  const unexpectedCommittedBackupSnapshot = readNativeFileIdentityAndSecurity(unexpectedCommittedBackup);
  const unexpectedCommittedJournal = instructionJournal({
    id: unexpectedCommittedId,
    workingFolder: unexpectedCommittedRoot,
    targetExisted: true,
    expectedBytes: unexpectedCommittedOld,
    targetIdentity: unexpectedCommittedBackupSnapshot.Identity,
    intendedBytes: unexpectedCommittedNew,
    intendedIdentity: unexpectedCommittedTargetSnapshot.Identity,
    expectedSecurity: unexpectedCommittedBackupSnapshot.Security,
    stage: 'committed',
  });
  const unexpectedCommittedJournalFiles = await seedInstructionJournal(unexpectedCommittedRuntime, unexpectedCommittedJournal);
  const unexpectedCommittedRecovery = invoke(['--recover-instructions', unexpectedCommittedRuntime]);
  assertTargetConflict(unexpectedCommittedRecovery, unexpectedCommittedTarget,
    'A committed journal with an unexpected temporary version must remain unresolved.');
  assert.deepEqual(await readFile(unexpectedCommittedTarget), unexpectedCommittedNew);
  assert.deepEqual(await readFile(unexpectedCommittedBackup), unexpectedCommittedOld);
  assert.equal(await readFile(unexpectedCommittedTemp, 'utf8'), 'unexpected version');
  assert.equal(await readFile(unexpectedCommittedJournalFiles.path, 'utf8'), unexpectedCommittedJournalFiles.bytes);
  process.stdout.write('PASS committed recovery preserves target, backup, journal, and unexpected temp.\n');

  const changedIdentityRoot = join(root, 'changed-identity-project');
  const changedIdentityRuntime = join(root, 'changed-identity-runtime');
  await Promise.all([mkdir(changedIdentityRoot), mkdir(changedIdentityRuntime)]);
  const changedIdentityId = '2c9e6b7c345f4078d23456789abcdef0';
  const changedIdentityTarget = join(changedIdentityRoot, 'AGENTS.md');
  const changedIdentityBackup = join(changedIdentityRoot, `.gigachat-instruction-${changedIdentityId}.bak`);
  const externalSameContent = Buffer.from('same intended content, external replacement');
  const displacedBytes = Buffer.from('displaced before external replacement');
  const oldIntendedPath = join(changedIdentityRoot, 'intended-original.tmp');
  const newIdentityPath = join(changedIdentityRoot, 'external-replacement.tmp');
  await Promise.all([
    writeFile(changedIdentityTarget, externalSameContent, { flag: 'wx' }),
    writeFile(changedIdentityBackup, displacedBytes, { flag: 'wx' }),
  ]);
  const originalIntendedSnapshot = readNativeFileIdentityAndSecurity(changedIdentityTarget);
  const changedIdentityBackupSnapshot = readNativeFileIdentityAndSecurity(changedIdentityBackup);
  await rename(changedIdentityTarget, oldIntendedPath);
  await writeFile(newIdentityPath, externalSameContent, { flag: 'wx' });
  const externalReplacementSnapshot = readNativeFileIdentityAndSecurity(newIdentityPath);
  assert.notEqual(externalReplacementSnapshot.Identity, originalIntendedSnapshot.Identity);
  await rename(newIdentityPath, changedIdentityTarget);
  const changedIdentityJournal = instructionJournal({
    id: changedIdentityId,
    workingFolder: changedIdentityRoot,
    targetExisted: true,
    expectedBytes: displacedBytes,
    targetIdentity: changedIdentityBackupSnapshot.Identity,
    intendedBytes: externalSameContent,
    intendedIdentity: originalIntendedSnapshot.Identity,
    expectedSecurity: changedIdentityBackupSnapshot.Security,
    stage: 'displaced',
  });
  const changedIdentityJournalFiles = await seedInstructionJournal(changedIdentityRuntime, changedIdentityJournal);
  const changedIdentityRecovery = invoke(['--recover-instructions', changedIdentityRuntime]);
  assertTargetConflict(changedIdentityRecovery, changedIdentityTarget,
    'A same-content external replacement with a new file identity must remain a conflict.');
  assert.deepEqual(await readFile(changedIdentityTarget), externalSameContent);
  assert.deepEqual(await readFile(changedIdentityBackup), displacedBytes);
  assert.deepEqual(await readFile(oldIntendedPath), externalSameContent);
  assert.equal(await readFile(changedIdentityJournalFiles.path, 'utf8'), changedIdentityJournalFiles.bytes);
  process.stdout.write('PASS instruction recovery preserves a same-content external replacement with a new identity.\n');

  const largeRoot = join(root, 'oversized-project');
  const largeRuntime = join(root, 'oversized-runtime');
  await Promise.all([mkdir(largeRoot), mkdir(largeRuntime)]);
  const largeId = '3daf7c8d45604189e3456789abcdef01';
  const oversizedBytes = Buffer.alloc(64 * 1024 + 1, 0x61);
  const oversizedTarget = join(largeRoot, 'AGENTS.md');
  await writeFile(oversizedTarget, oversizedBytes, { flag: 'wx' });
  const largeJournal = instructionJournal({
    id: largeId,
    workingFolder: largeRoot,
    targetExisted: true,
    expectedBytes: oversizedBytes,
    targetIdentity: '4'.repeat(24),
    intendedBytes: Buffer.from('pending bounded write'),
  });
  const largeJournalFiles = await seedInstructionJournal(largeRuntime, largeJournal);
  const largeCopyId = 'd8a7395c-4681-42a3-89b3-ef0123456789';
  const largeCopy = join(profile, 'instruction-conflicts', 'project', `${largeCopyId}.md`);
  const largeCopyBytes = Buffer.from('copy despite another oversized target');
  const largeCopyResult = invoke(['--write-instruction', largeRuntime], {
    WorkingFolder: profile,
    RelativePath: `instruction-conflicts/project/${largeCopyId}.md`,
    ContentsBase64: largeCopyBytes.toString('base64'),
    ExpectedHash: null,
  });
  assert.equal(largeCopyResult.status, 0, `Oversized unrelated target must be isolated: ${largeCopyResult.stdout}`);
  assert.equal(parseOutput(largeCopyResult).Kind, 'saved');
  assert.deepEqual(await readFile(largeCopy), largeCopyBytes);
  assert.deepEqual(await readFile(oversizedTarget), oversizedBytes);
  assert.equal(await readFile(largeJournalFiles.path, 'utf8'), largeJournalFiles.bytes);
  process.stdout.write('PASS oversized unresolved target preserves its bytes and allows a separate app-owned copy.\n');

  const linkedTarget = join(root, 'linked-project-target');
  const linkedRoot = join(root, 'linked-project-root');
  const linkedRuntime = join(root, 'linked-runtime');
  await Promise.all([mkdir(linkedTarget), mkdir(linkedRuntime)]);
  await symlink(linkedTarget, linkedRoot, 'junction');
  temporaryJunctions.push(linkedRoot);
  assert.equal((await lstat(linkedRoot)).isSymbolicLink(), true);
  const linkedId = '4eb08d9e5671429a83456789abcdef12';
  const linkedBytes = Buffer.from('linked-root pending instruction');
  const linkedJournal = instructionJournal({
    id: linkedId,
    workingFolder: linkedRoot,
    intendedBytes: linkedBytes,
  });
  const linkedJournalFiles = await seedInstructionJournal(linkedRuntime, linkedJournal);
  const linkedCopyId = 'e9b84a6d-5792-43b4-90c4-f0123456789a';
  const linkedCopy = join(profile, 'instruction-conflicts', 'project', `${linkedCopyId}.md`);
  const linkedCopyBytes = Buffer.from('copy despite linked unresolved target');
  const linkedCopyResult = invoke(['--write-instruction', linkedRuntime], {
    WorkingFolder: profile,
    RelativePath: `instruction-conflicts/project/${linkedCopyId}.md`,
    ContentsBase64: linkedCopyBytes.toString('base64'),
    ExpectedHash: null,
  });
  assert.equal(linkedCopyResult.status, 0, `Linked unrelated root must become only a target conflict: ${linkedCopyResult.stdout}`);
  assert.equal(parseOutput(linkedCopyResult).Kind, 'saved');
  assert.deepEqual(await readFile(linkedCopy), linkedCopyBytes);
  await assertMissingFile(join(linkedTarget, 'AGENTS.md'), 'Recovery must not follow the linked working-folder root.');
  assert.equal(await readFile(linkedJournalFiles.path, 'utf8'), linkedJournalFiles.bytes);
  process.stdout.write('PASS linked unresolved root is isolated while a separate app-owned copy is saved.\n');
} finally {
  assertTemporaryRoot();
  for (const junction of temporaryJunctions) {
    assert.ok(isWithin(root, junction), 'Synthetic junction cleanup must remain inside the unique harness root.');
    let junctionStat;
    try { junctionStat = await lstat(junction); }
    catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
    assert.equal(junctionStat.isSymbolicLink(), true,
      'Refuse recursive cleanup if the synthetic junction path was replaced.');
    await rm(junction, { recursive: true, force: true });
  }
  const rootStat = await lstat(root);
  assert.equal(rootStat.isSymbolicLink(), false, 'Harness cleanup root must not be a link.');
  assert.equal(rootStat.isDirectory(), true, 'Harness cleanup root must remain a directory.');
  await rm(root, { recursive: true, force: true });
}
