import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  APP_USER_MODEL_ID,
  NSIS_INSTALLER_GUID,
  acquirePrimaryInstance,
  createCloseAdmission,
  createCloseController,
  createDetectedFolderOpener,
  createTrayLifecycle,
  migrateCurrentVersionAutoStart,
  readInstalledAutoStart,
  resolveInstalledLauncher,
  resolveNsisLauncher,
  resolveSquirrelLauncher,
  writeInstalledAutoStart,
  type LoginItemApi,
  type LoginItemLaunch,
  type NsisInstallRegistration,
} from './lifecycle';
import { createVoiceRuntime } from './voice';

test('VS Code discovery is passive and the executable launches only for explicit folder open', async () => {
  const candidates = ['missing.exe', 'Code.exe'];
  const launches: Array<{ executable: string; args: string[] }> = [];
  const opener = createDetectedFolderOpener(
    () => candidates,
    async (candidate) => candidate === 'Code.exe',
    async (executable, args) => { launches.push({ executable, args }); },
  );

  assert.equal(await opener.detect(), 'Code.exe');
  assert.deepEqual(launches, [], 'Settings discovery must not start the GUI executable');
  assert.equal(await opener.openFolder('C:\\work\\project'), true);
  assert.deepEqual(launches, [{ executable: 'Code.exe', args: ['C:\\work\\project'] }]);
});

test('Squirrel launcher and login-item settings stay stable across version updates', async () => {
  const installRoot = await mkdtemp(join(tmpdir(), 'gigachat-plan007-launcher-'));
  const versionOne = join(installRoot, 'app-1.0.0');
  const versionTwo = join(installRoot, 'app-2.0.0');
  const stablePath = join(installRoot, 'GigaChat Agents.exe');
  const versionOnePath = join(versionOne, 'GigaChat Agents.exe');
  const versionTwoPath = join(versionTwo, 'GigaChat Agents.exe');
  const isFile = async (path: string): Promise<boolean> => {
    const info = await lstat(path).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  };

  try {
    await mkdir(versionOne);
    await mkdir(join(installRoot, 'packages'));
    await writeFile(stablePath, 'stub');
    await writeFile(join(installRoot, 'Update.exe'), 'update');
    await writeFile(join(installRoot, 'packages', 'RELEASES'), 'release');
    await writeFile(versionOnePath, 'v1');

    const ownEntry = { name: APP_USER_MODEL_ID, path: versionOnePath, args: [] as string[], scope: 'user' as const, enabled: false };
    const foreignEntry: LoginItemLaunch = {
      name: 'other-app', path: 'C:\\Other\\Agent.exe', args: ['--background'], scope: 'user', enabled: true,
    };
    const samePathForeignArgs: LoginItemLaunch = {
      name: 'other-args', path: versionOnePath, args: ['--background'], scope: 'user', enabled: true,
    };
    const samePathMachineEntry: LoginItemLaunch = {
      name: 'machine-app', path: versionOnePath, args: ['--machine'], scope: 'machine', enabled: true,
    };
    const foreignBefore = structuredClone(foreignEntry);
    const samePathForeignBefore = structuredClone(samePathForeignArgs);
    const samePathMachineBefore = structuredClone(samePathMachineEntry);
    let ownRegistered = true;
    const calls: Array<{ operation: string; path: string; args: string[] }> = [];
    const api: LoginItemApi = {
      getSettings(options) {
        calls.push({ operation: 'get', path: options.path, args: [...options.args] });
        const matching = [ownEntry, foreignEntry, samePathForeignArgs, samePathMachineEntry]
          .filter((entry) => entry.path.toLowerCase() === options.path.toLowerCase());
        return {
          openAtLogin: ownRegistered
            && ownEntry.path.toLowerCase() === options.path.toLowerCase()
            && ownEntry.args.length === options.args.length
            && ownEntry.args.every((arg, index) => arg === options.args[index]),
          launchItems: matching.map((entry) => ({ ...entry })),
        };
      },
      setSettings(settings) {
        calls.push({ operation: 'set', path: settings.path, args: [...settings.args] });
        ownEntry.path = settings.path;
        ownEntry.args = [...settings.args];
        ownEntry.enabled = settings.enabled;
        ownRegistered = settings.openAtLogin;
      },
    };

    const launcherV1 = await resolveSquirrelLauncher(versionOnePath, isFile);
    assert.deepEqual(launcherV1, { path: stablePath, args: [] });
    assert.deepEqual(
      await resolveInstalledLauncher(versionOnePath, isFile, async () => assert.fail('Squirrel proof must not query NSIS registration')),
      launcherV1,
    );
    assert.equal(migrateCurrentVersionAutoStart(launcherV1, { path: versionOnePath, args: [] }, api), true);
    assert.equal(readInstalledAutoStart(launcherV1, api), false);
    assert.deepEqual(ownEntry, { name: APP_USER_MODEL_ID, path: stablePath, args: [], scope: 'user', enabled: false }, 'migration preserves Task Manager disabled state');
    assert.deepEqual(foreignEntry, foreignBefore, 'migration leaves foreign login entries untouched');
    assert.deepEqual(samePathForeignArgs, samePathForeignBefore, 'path-filtered launch items with other arguments remain untouched');
    assert.deepEqual(samePathMachineEntry, samePathMachineBefore, 'machine-scope entries remain untouched');

    await rm(versionOne, { recursive: true });
    await mkdir(versionTwo);
    await writeFile(versionTwoPath, 'v2');
    const launcherV2 = await resolveSquirrelLauncher(versionTwoPath, isFile);
    assert.deepEqual(launcherV2, { path: stablePath, args: [] });
    assert.equal(readInstalledAutoStart(launcherV2, api), false);
    assert.equal(writeInstalledAutoStart(true, launcherV2, api), true);
    assert.deepEqual(ownEntry, { name: APP_USER_MODEL_ID, path: stablePath, args: [], scope: 'user', enabled: true });
    assert.equal(writeInstalledAutoStart(false, launcherV2, api), false, 'explicit opt-out removes the own login item');
    assert.equal(ownRegistered, false);
    assert.ok(calls.every(({ path, args }) => (path === stablePath || path === versionOnePath) && args.length === 0));
    assert.ok(calls.filter(({ operation }) => operation === 'set').every(({ args }) => args.length === 0));
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
});

test('NSIS launcher requires one exact registration pair and preserves disabled login state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-plan008-nsis-'));
  const installDirectory = join(root, 'Папка пользователя', 'Программы с пробелами', 'GigaChat Agents');
  const executablePath = join(installDirectory, 'GigaChat Agents.exe');
  const uninstallerPath = join(installDirectory, 'Uninstall GigaChat Agents.exe');
  const isFile = async (candidate: string): Promise<boolean> => {
    const info = await lstat(candidate).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  };

  try {
    await mkdir(installDirectory, { recursive: true });
    await writeFile(executablePath, 'NSIS installed executable fixture');
    await writeFile(uninstallerPath, 'NSIS uninstaller fixture');
    const userRegistration: NsisInstallRegistration = {
      scope: 'user',
      installLocation: installDirectory,
      uninstallString: `"${uninstallerPath}" /currentuser`,
    };
    const launcher = await resolveNsisLauncher(executablePath, [userRegistration], isFile);
    assert.deepEqual(launcher, { path: resolve(executablePath), args: [] });

    const machineLauncher = await resolveNsisLauncher(executablePath, [{
      scope: 'machine',
      installLocation: installDirectory,
      uninstallString: `"${uninstallerPath}" /allusers`,
    }], isFile);
    assert.deepEqual(machineLauncher, launcher, 'the exact machine-scope registration pair is also accepted');
    assert.equal(await resolveNsisLauncher(executablePath, null, isFile), null);
    assert.equal(await resolveNsisLauncher(executablePath, [], isFile), null, 'an adjacent uninstaller is not installation proof');
    assert.equal(await resolveNsisLauncher(executablePath, [userRegistration, userRegistration], isFile), null, 'duplicate scopes are ambiguous');
    assert.equal(await resolveNsisLauncher(executablePath, [{
      ...userRegistration,
      installLocation: root,
    }], isFile), null, 'a foreign registered folder is rejected');
    assert.equal(await resolveNsisLauncher(executablePath, [{
      ...userRegistration,
      uninstallString: `"${uninstallerPath}" /allusers`,
    }], isFile), null, 'scope and uninstall arguments must agree');
    assert.equal(await resolveNsisLauncher(join(root, 'portable', 'GigaChat Agents.exe'), [userRegistration], isFile), null);
    assert.equal(await resolveInstalledLauncher(join(root, 'portable', 'GigaChat Agents.exe'), async () => true, async () => [userRegistration]), null);

    const config = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8');
    assert.ok(config.includes(`appId: ${APP_USER_MODEL_ID}`));
    assert.ok(config.includes(`  guid: ${NSIS_INSTALLER_GUID}`));

    const oldPath = join(root, 'app-1.0.2', 'GigaChat Agents.exe');
    let registeredPath = oldPath;
    let enabled = false;
    const ownItem: LoginItemLaunch = {
      name: APP_USER_MODEL_ID,
      path: oldPath,
      args: [],
      scope: 'user',
      enabled,
    };
    const api: LoginItemApi = {
      getSettings(options) {
        const matches = registeredPath.toLowerCase() === options.path.toLowerCase();
        return {
          openAtLogin: matches,
          launchItems: matches ? [{ ...ownItem, path: registeredPath }] : [],
        };
      },
      setSettings(settings) {
        enabled = settings.enabled;
        ownItem.path = settings.path;
        ownItem.enabled = settings.enabled;
        registeredPath = settings.openAtLogin ? settings.path : '';
      },
    };
    assert.equal(migrateCurrentVersionAutoStart(launcher, { path: oldPath, args: [] }, api), true);
    assert.equal(registeredPath, executablePath);
    assert.equal(enabled, false, 'migration keeps the Windows Task Manager disabled state');
    assert.equal(readInstalledAutoStart(launcher, api), false);
    assert.equal(writeInstalledAutoStart(true, launcher, api), true);
    assert.equal(writeInstalledAutoStart(false, launcher, api), false);
    assert.throws(() => writeInstalledAutoStart(true, launcher, {
      getSettings: () => ({ openAtLogin: false, launchItems: [] }),
      setSettings: () => {},
    }), /подтвердить изменение/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('autostart reads and writes reject an exact-command foreign AppUserModelId', () => {
  const launcher = { path: 'C:\\Apps\\GigaChat Agents\\GigaChat Agents.exe', args: [] };
  let writes = 0;
  const api: LoginItemApi = {
    getSettings: () => ({
      openAtLogin: false,
      launchItems: [{ name: 'another-application', ...launcher, scope: 'user', enabled: false }],
    }),
    setSettings: () => { writes += 1; },
  };

  assert.throws(() => readInstalledAutoStart(launcher, api), /однозначно/);
  assert.throws(() => writeInstalledAutoStart(true, launcher, api), /однозначно/);
  assert.throws(() => writeInstalledAutoStart(true, launcher, {
    getSettings: () => ({ openAtLogin: true, launchItems: [] }),
    setSettings: () => { writes += 1; },
  }), /однозначно/);
  assert.equal(writes, 0, 'foreign login items are rejected before any write');
});

test('ambiguous same-command login entries are preserved instead of migrating', async () => {
  const installRoot = await mkdtemp(join(tmpdir(), 'gigachat-plan007-ambiguous-login-'));
  const versionDirectory = join(installRoot, 'app-1.0.0');
  const versionPath = join(versionDirectory, 'GigaChat Agents.exe');
  const stablePath = join(installRoot, 'GigaChat Agents.exe');
  const isFile = async (path: string): Promise<boolean> => {
    const info = await lstat(path).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  };
  try {
    await mkdir(versionDirectory);
    await mkdir(join(installRoot, 'packages'));
    await writeFile(versionPath, 'v1');
    await writeFile(stablePath, 'stub');
    await writeFile(join(installRoot, 'Update.exe'), 'update');
    await writeFile(join(installRoot, 'packages', 'RELEASES'), 'release');
    const launcher = await resolveSquirrelLauncher(versionPath, isFile);
    let writes = 0;
    const api: LoginItemApi = {
      getSettings(options) {
        const isLegacy = options.path === versionPath;
        return {
          openAtLogin: isLegacy,
          launchItems: isLegacy ? [
            { name: APP_USER_MODEL_ID, path: versionPath, args: [], scope: 'user', enabled: true },
            { name: 'ambiguous-app', path: versionPath, args: [], scope: 'user', enabled: true },
          ] : [],
        };
      },
      setSettings() { writes += 1; },
    };
    assert.throws(
      () => migrateCurrentVersionAutoStart(launcher, { path: versionPath, args: [] }, api),
      /однозначно/,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
});

test('autostart migration and explicit changes fail when Windows does not confirm the write', () => {
  const oldPath = 'C:\\GigaChat\\app-1.0.0\\GigaChat Agents.exe';
  const stablePath = 'C:\\GigaChat\\GigaChat Agents.exe';
  const oldItem: LoginItemLaunch = { name: APP_USER_MODEL_ID, path: oldPath, args: [], scope: 'user', enabled: true };
  let writes = 0;
  const api: LoginItemApi = {
    getSettings(options) {
      const matches = options.path === oldPath ? [oldItem] : [];
      return { openAtLogin: options.path === oldPath, launchItems: matches };
    },
    setSettings() { writes += 1; },
  };

  assert.throws(
    () => migrateCurrentVersionAutoStart({ path: stablePath, args: [] }, { path: oldPath, args: [] }, api),
    /подтвердить перенос/,
  );
  assert.throws(
    () => writeInstalledAutoStart(true, { path: stablePath, args: [] }, api),
    /подтвердить изменение/,
  );
  assert.equal(writes, 2, 'neither failed readback is reported as a successful migration or setting');
});

test('portable and Squirrel-shaped folders without installation markers do not enable autostart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-plan007-portable-'));
  const versionPath = join(root, 'app-1.0.0', 'GigaChat Agents.exe');
  const stablePath = join(root, 'GigaChat Agents.exe');
  const isFile = async (path: string): Promise<boolean> => {
    const info = await lstat(path).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  };
  try {
    await mkdir(join(root, 'app-1.0.0'));
    await writeFile(versionPath, 'portable');
    await writeFile(stablePath, 'lookalike');
    assert.equal(await resolveSquirrelLauncher(versionPath, isFile), null);
    assert.equal(readInstalledAutoStart(null, {
      getSettings: () => assert.fail('portable state must not query Windows login items'),
      setSettings: () => assert.fail('portable state must not write Windows login items'),
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Squirrel service launch quits without requesting the application instance lock', () => {
  let lockRequests = 0;
  let quitCalls = 0;
  const primary = acquirePrimaryInstance(true, () => { lockRequests += 1; return true; }, () => { quitCalls += 1; });

  assert.equal(primary, false);
  assert.equal(lockRequests, 0);
  assert.equal(quitCalls, 1);
});

test('secondary application launch quits without becoming a writer', () => {
  let lockRequests = 0;
  let quitCalls = 0;
  const primary = acquirePrimaryInstance(false, () => { lockRequests += 1; return false; }, () => { quitCalls += 1; });

  assert.equal(primary, false);
  assert.equal(lockRequests, 1);
  assert.equal(quitCalls, 1);
});

test('primary application launch keeps the process running after acquiring the lock', () => {
  let lockRequests = 0;
  let quitCalls = 0;
  const primary = acquirePrimaryInstance(false, () => { lockRequests += 1; return true; }, () => { quitCalls += 1; });

  assert.equal(primary, true);
  assert.equal(lockRequests, 1);
  assert.equal(quitCalls, 0);
});

test('tray hides on ordinary close and waits for the renderer close listener before Exit', () => {
  const tray = createTrayLifecycle();
  tray.windowCreated();
  assert.equal(tray.windowClose(true), 'hide');
  assert.equal(tray.windowClose(false), 'wait', 'without a tray, close still waits for the renderer handler');
  assert.equal(tray.closeHandlerReady(), true);
  assert.equal(tray.windowClose(false), 'close', 'the no-tray fallback keeps the normal safe close path');
  tray.returnToWork();
  assert.equal(tray.requestExit(), 'close');
  tray.mainFrameNavigating();
  assert.equal(tray.requestExit(), 'already-exiting');
  assert.equal(tray.closeHandlerReady(), true, 'a main-frame reload re-arms the pending Exit after listener readiness');
  assert.equal(tray.windowClose(true), 'close');
  tray.returnToWork();
  tray.windowCreated();
  assert.equal(tray.requestExit(), 'wait', 'an early tray Exit stays pending until the renderer listener is installed');
  assert.equal(tray.requestExit(), 'already-exiting', 'repeated Exit cannot start a second close attempt');
  assert.equal(tray.closeHandlerReady(), true, 'preload acknowledgement releases the pending close');
  assert.equal(tray.windowClose(true), 'close', 'Exit bypasses hide only after the renderer close path is ready');
  tray.returnToWork();
  assert.equal(tray.windowClose(true), 'hide', 'Return resets the Exit intent');
});

test('close admission drains accepted IPC, rejects new work, and resumes after a failed close', async () => {
  const admission = createCloseAdmission();
  const controls: { release: (() => void) | null } = { release: null };
  let operationFinished = false;
  const accepted = admission.run(() => new Promise<void>((resolve) => {
    controls.release = () => { operationFinished = true; resolve(); };
  }));
  const drain = admission.beginClose();
  assert.equal(admission.beginClose(), drain, 'repeated close requests share one drain');
  await assert.rejects(admission.run(() => undefined), /Приложение закрывается/);
  assert.equal(await admission.run(() => 'browser presentation', { allowWhileClosing: true, critical: false }), 'browser presentation');
  assert.equal(operationFinished, false);

  const release = controls.release;
  if (!release) throw new Error('Accepted IPC operation did not start');
  release();
  await Promise.all([accepted, drain]);
  assert.equal(operationFinished, true);

  admission.resume();
  await admission.run(() => undefined);
  admission.complete();
  await assert.rejects(admission.run(() => undefined), /Приложение закрывается/);
});

test('close admission reports a failed accepted save only after every accepted operation settles', async () => {
  const admission = createCloseAdmission();
  const controls: { rejectSave: ((error: Error) => void) | null; finishOther: (() => void) | null } = { rejectSave: null, finishOther: null };
  const failedSave = admission.run(() => new Promise<void>((_resolve, reject) => { controls.rejectSave = reject; }));
  const pendingImport = admission.run(() => new Promise<void>((resolve) => { controls.finishOther = resolve; }));
  await Promise.resolve();
  const drain = admission.beginClose();
  let drainSettled = false;
  void drain.then(() => { drainSettled = true; }, () => { drainSettled = true; });

  const { rejectSave, finishOther } = controls;
  if (!rejectSave || !finishOther) throw new Error('Accepted operations did not start');
  rejectSave(new Error('Accepted save failed'));
  await Promise.resolve();
  assert.equal(drainSettled, false, 'close must wait for the other accepted operation before reporting the failure');
  finishOther();
  await assert.rejects(failedSave, /Accepted save failed/);
  await pendingImport;
  await assert.rejects(drain, /Accepted save failed/);
});

test('return after a renderer-only flush failure leaves the unopened main gate available', async () => {
  const admission = createCloseAdmission();
  const controller = createCloseController(admission, {
    pauseBrowserMetadata: () => undefined,
    resumeBrowserMetadata: () => undefined,
    cancelRuntime: async () => undefined,
    cancelVoice: async () => undefined,
    flushBrowser: async () => undefined,
    drainStore: async () => undefined,
    closeOnboardingBrowser: async () => undefined,
    destroyBrowser: () => assert.fail('renderer-only failure did not complete main close'),
    allowClose: () => assert.fail('renderer-only failure did not complete main close'),
    closeWindow: () => assert.fail('renderer-only failure did not complete main close'),
  });

  assert.equal(controller.resume(), true, 'return is a harmless no-op before main close-ready ran');
  await admission.run(() => undefined);
});

test('close controller single-flights, drains accepted work, and closes only after persistence', async () => {
  const admission = createCloseAdmission();
  const order: string[] = [];
  const controls: { finishAccepted: (() => void) | null } = { finishAccepted: null };
  const accepted = admission.run(() => new Promise<void>((resolve) => { controls.finishAccepted = resolve; }));
  const controller = createCloseController(admission, {
    pauseBrowserMetadata: () => order.push('pause'),
    resumeBrowserMetadata: () => order.push('resume'),
    cancelRuntime: async () => { order.push('runtime'); },
    cancelVoice: async () => { order.push('voice'); },
    flushBrowser: async () => { order.push('browser'); },
    drainStore: async () => { order.push('store'); },
    closeOnboardingBrowser: async () => { order.push('onboarding'); },
    destroyBrowser: () => order.push('destroy'),
    allowClose: () => order.push('allow'),
    closeWindow: () => order.push('close-window'),
  });

  const first = controller.close();
  assert.equal(controller.close(), first, 'repeated close events share the in-flight attempt');
  assert.deepEqual(order, ['pause']);
  await admission.run(() => order.push('presentation'), { allowWhileClosing: true, critical: false });
  const finishAccepted = controls.finishAccepted;
  if (!finishAccepted) throw new Error('Accepted operation did not start');
  finishAccepted();
  await accepted;
  assert.deepEqual(await first, { status: 'closed' });
  assert.deepEqual(order, ['pause', 'presentation', 'runtime', 'voice', 'browser', 'store', 'onboarding', 'destroy', 'allow', 'close-window']);
});

test('browser metadata failure offers return and retry after storage recovers', async () => {
  const admission = createCloseAdmission();
  let failBrowser = true;
  let browserFlushes = 0;
  let closed = false;
  const controller = createCloseController(admission, {
    pauseBrowserMetadata: () => undefined,
    resumeBrowserMetadata: () => undefined,
    cancelRuntime: async () => undefined,
    cancelVoice: async () => undefined,
    flushBrowser: async () => { browserFlushes += 1; if (failBrowser) throw new Error('browser disk full'); },
    drainStore: async () => undefined,
    closeOnboardingBrowser: async () => undefined,
    destroyBrowser: () => { closed = true; },
    allowClose: () => undefined,
    closeWindow: () => undefined,
  });

  assert.deepEqual(await controller.close(true), {
    status: 'failed', reason: 'close', message: 'Пропустить можно только сохранение метаданных браузера после его ошибки.',
  });
  assert.equal(browserFlushes, 0, 'browser metadata may only be discarded after a real browser persist failure');
  assert.deepEqual(await controller.close(), {
    status: 'failed', reason: 'browser-metadata', message: 'browser disk full',
  });
  assert.equal(closed, false, 'a failed save must keep browser views alive');
  assert.equal(controller.resume(), true, 'the user can return and continue working');
  await admission.run(() => undefined);

  failBrowser = false;
  assert.equal((await controller.close()).status, 'closed', 'a regular retry persists browser state before closing');
  assert.equal(browserFlushes, 2);
  assert.equal(closed, true);
});

test('browser-only discard is allowed only after a failed browser metadata save', async () => {
  const admission = createCloseAdmission();
  let browserFlushes = 0;
  let closed = false;
  const controller = createCloseController(admission, {
    pauseBrowserMetadata: () => undefined,
    resumeBrowserMetadata: () => undefined,
    cancelRuntime: async () => undefined,
    cancelVoice: async () => undefined,
    flushBrowser: async () => { browserFlushes += 1; throw new Error('browser disk full'); },
    drainStore: async () => undefined,
    closeOnboardingBrowser: async () => undefined,
    destroyBrowser: () => { closed = true; },
    allowClose: () => undefined,
    closeWindow: () => undefined,
  });

  assert.equal((await controller.close(true)).status, 'failed', 'the first attempt cannot skip browser persistence');
  assert.equal(browserFlushes, 0);
  const browserFailure = await controller.close();
  if (browserFailure.status !== 'failed') throw new Error('Browser flush failure was not reported');
  assert.equal(browserFailure.reason, 'browser-metadata');
  assert.equal(closed, false);
  assert.equal((await controller.close(true)).status, 'closed', 'explicit browser-only discard can close after the metadata error');
  assert.equal(browserFlushes, 1, 'discard does not retry or silently save browser metadata');
  assert.equal(closed, true);
});

test('a failed accepted mutation blocks close instead of becoming browser-only discard', async () => {
  const admission = createCloseAdmission();
  const controller = createCloseController(admission, {
    pauseBrowserMetadata: () => undefined,
    resumeBrowserMetadata: () => undefined,
    cancelRuntime: async () => undefined,
    cancelVoice: async () => undefined,
    flushBrowser: async () => undefined,
    drainStore: async () => undefined,
    closeOnboardingBrowser: async () => undefined,
    destroyBrowser: () => assert.fail('failed accepted work must not destroy browser views'),
    allowClose: () => assert.fail('failed accepted work must not close the window'),
    closeWindow: () => assert.fail('failed accepted work must not close the window'),
  });
  const controls: { rejectSave: ((error: Error) => void) | null } = { rejectSave: null };
  const save = admission.run(() => new Promise<void>((_resolve, reject) => { controls.rejectSave = reject; }));
  const first = await controller.close(true);
  if (first.status !== 'failed') throw new Error('Discard without browser failure unexpectedly closed the app');
  assert.equal(first.reason, 'close', 'browser discard cannot bypass an accepted chat write');
  const closing = controller.close();
  await Promise.resolve();
  const rejectSave = controls.rejectSave;
  if (!rejectSave) throw new Error('Accepted save did not start');
  rejectSave(new Error('chat save failed'));
  await assert.rejects(save, /chat save failed/);
  assert.deepEqual(await closing, {
    status: 'failed', reason: 'close', message: 'chat save failed',
  });
  assert.equal(controller.resume(), true);
});

test('close cancels an owned voice transcribe outside the IPC drain and waits for cleanup', async () => {
  const admission = createCloseAdmission();
  let runStarted: (() => void) | null = null;
  let cleanupCount = 0;
  let cancelVoiceCalls = 0;
  let destroyed = false;
  const order: string[] = [];
  const runtime = createVoiceRuntime({ executable: 'synthetic', modelDirectory: 'synthetic' }, {
    prepareAudio: async () => ({ filePath: 'synthetic.webm', cleanup: async () => { cleanupCount += 1; } }),
    run: (_executable, _args, _environment, signal) => new Promise<string>((_resolve, reject) => {
      runStarted?.();
      const onAbort = () => reject(new Error('Распознавание отменено.'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }),
  });
  const controller = createCloseController(admission, {
    pauseBrowserMetadata: () => order.push('pause'),
    resumeBrowserMetadata: () => order.push('resume'),
    cancelRuntime: async () => { order.push('runtime'); },
    cancelVoice: async () => {
      cancelVoiceCalls += 1;
      await runtime.cancelAll();
      assert.equal(cleanupCount, 1, 'voice cancel ack includes prepared-audio cleanup');
      order.push('voice-ack');
    },
    flushBrowser: async () => { order.push('browser'); },
    drainStore: async () => { order.push('store'); },
    closeOnboardingBrowser: async () => { order.push('onboarding'); },
    destroyBrowser: () => { destroyed = true; order.push('destroy'); },
    allowClose: () => order.push('allow'),
    closeWindow: () => order.push('close-window'),
  });
  const transcribe = admission.run(
    () => runtime.transcribe('01234567-89ab-42cd-8e01-234567890abc', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm'),
    { track: false },
  );
  await new Promise<void>((resolve) => { runStarted = resolve; });
  const close = controller.close();
  await assert.rejects(transcribe, /Распознавание отменено/);
  assert.deepEqual(await close, { status: 'closed' });
  assert.equal(cancelVoiceCalls, 1);
  assert.equal(destroyed, true);
  assert.deepEqual(order, ['pause', 'runtime', 'voice-ack', 'browser', 'store', 'onboarding', 'destroy', 'allow', 'close-window']);

  let lateTranscribeStarted = false;
  await assert.rejects(admission.run(() => { lateTranscribeStarted = true; }, { track: false }), /Приложение закрывается/);
  assert.equal(lateTranscribeStarted, false, 'the close gate still rejects new transcriptions');
});
