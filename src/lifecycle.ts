import type { CloseAttemptResult } from './contracts';
import { basename, dirname, join, resolve } from 'node:path';

export type { CloseAttemptResult } from './contracts';

export interface InstalledLauncher {
  path: string;
  args: string[];
}

export interface LoginItemLaunch {
  name: string;
  path: string;
  args: string[];
  scope: 'user' | 'machine';
  enabled: boolean;
}

export interface LoginItemSnapshot {
  openAtLogin: boolean;
  launchItems: LoginItemLaunch[];
}

export interface LoginItemApi {
  getSettings(options: InstalledLauncher): LoginItemSnapshot;
  setSettings(settings: InstalledLauncher & { openAtLogin: boolean; enabled: boolean }): void;
}

export function createDetectedFolderOpener(
  candidates: () => readonly string[],
  isFile: (candidate: string) => Promise<boolean>,
  launch: (executable: string, args: string[]) => Promise<void>,
) {
  const detect = async (): Promise<string | null> => {
    for (const candidate of candidates()) {
      if (await isFile(candidate)) return candidate;
    }
    return null;
  };

  return {
    detect,
    async openFolder(folder: string): Promise<boolean> {
      const executable = await detect();
      if (!executable) return false;
      await launch(executable, [folder]);
      return true;
    },
  };
}

export async function resolveSquirrelLauncher(
  executablePath: string,
  isFile: (candidate: string) => Promise<boolean>,
): Promise<InstalledLauncher | null> {
  const versionDirectory = dirname(executablePath);
  if (!/^app-\d+(?:\.\d+){1,3}(?:-[0-9a-z.-]+)?$/i.test(basename(versionDirectory))) return null;

  const installDirectory = dirname(versionDirectory);
  const launcherPath = join(installDirectory, basename(executablePath));
  if (resolve(launcherPath).toLowerCase() === resolve(executablePath).toLowerCase()) return null;
  if (!(await isFile(launcherPath))
    || !(await isFile(join(installDirectory, 'Update.exe')))
    || !(await isFile(join(installDirectory, 'packages', 'RELEASES')))) return null;
  return { path: launcherPath, args: [] };
}

export function readInstalledAutoStart(
  launcher: InstalledLauncher | null,
  api: LoginItemApi,
): boolean {
  if (!launcher) return false;
  const stableOptions = { path: launcher.path, args: [...launcher.args] };
  return confirmedEnabled(api.getSettings(stableOptions), stableOptions);
}

export function migrateCurrentVersionAutoStart(
  launcher: InstalledLauncher | null,
  currentVersion: InstalledLauncher,
  api: LoginItemApi,
): boolean {
  if (!launcher || sameExecutable(launcher.path, currentVersion.path)) return false;
  const stableOptions = { path: launcher.path, args: [...launcher.args] };
  const stableState = api.getSettings(stableOptions);
  if (stableState.openAtLogin) {
    confirmedEnabled(stableState, stableOptions);
    return false;
  }
  const oldOptions = { path: currentVersion.path, args: [...currentVersion.args] };
  const oldState = api.getSettings(oldOptions);
  if (!oldState.openAtLogin) return false;
  const oldItem = confirmedOwnUserItem(oldState, oldOptions);
  api.setSettings({ ...stableOptions, openAtLogin: true, enabled: oldItem.enabled });
  const migratedState = api.getSettings(stableOptions);
  if (!migratedState.openAtLogin || confirmedOwnUserItem(migratedState, stableOptions).enabled !== oldItem.enabled) {
    throw new Error('Не удалось подтвердить перенос записи автозапуска в Windows.');
  }
  return true;
}

export function writeInstalledAutoStart(
  enabled: boolean,
  launcher: InstalledLauncher | null,
  api: LoginItemApi,
): boolean {
  if (!launcher) throw new Error('Автозапуск доступен только в установленной Windows-версии приложения.');
  const options = { path: launcher.path, args: [...launcher.args] };
  api.setSettings({ ...options, openAtLogin: enabled, enabled });
  const state = api.getSettings(options);
  const actual = confirmedEnabled(state, options);
  if (state.openAtLogin !== enabled || actual !== enabled) {
    throw new Error('Не удалось подтвердить изменение автозапуска в Windows.');
  }
  return actual;
}

function sameExecutable(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function confirmedEnabled(snapshot: LoginItemSnapshot, options: InstalledLauncher): boolean {
  if (!snapshot.openAtLogin) return false;
  return confirmedOwnUserItem(snapshot, options).enabled;
}

function confirmedOwnUserItem(snapshot: LoginItemSnapshot, options: InstalledLauncher): LoginItemLaunch {
  const matches = snapshot.launchItems.filter((item) =>
    sameExecutable(item.path, options.path)
    && item.args.length === options.args.length
    && item.args.every((arg, index) => arg === options.args[index]));
  if (matches.length !== 1 || matches[0].scope !== 'user') {
    throw new Error('Не удалось однозначно проверить запись автозапуска приложения.');
  }
  return matches[0];
}

export function acquirePrimaryInstance(
  isSquirrelStartup: boolean,
  requestSingleInstanceLock: () => boolean,
  quit: () => void,
): boolean {
  if (isSquirrelStartup || !requestSingleInstanceLock()) {
    quit();
    return false;
  }
  return true;
}

export function createCloseAdmission() {
  let accepting = true;
  let completed = false;
  let drain: Promise<void> | null = null;
  let closeFailures: unknown[] | null = null;
  const active = new Map<Promise<unknown>, boolean>();

  return {
    run<T>(operation: () => T | Promise<T>, options: { allowWhileClosing?: boolean; critical?: boolean; track?: boolean } = {}): Promise<T> {
      if (!accepting && !options.allowWhileClosing) return Promise.reject(new Error('Приложение закрывается.'));
      const result = Promise.resolve().then(operation);
      if (!accepting || options.track === false) return result;
      active.set(result, options.critical !== false);
      void result.then(() => active.delete(result), (error: unknown) => {
        const critical = active.get(result);
        active.delete(result);
        if (critical && closeFailures) closeFailures.push(error);
      });
      return result;
    },
    beginClose(): Promise<void> {
      if (completed) return Promise.resolve();
      if (drain) return drain;
      accepting = false;
      const failures: unknown[] = [];
      closeFailures = failures;
      const pendingDrain = (async () => {
        while (active.size) await Promise.allSettled([...active.keys()]);
        if (failures.length) throw failures[0];
      })();
      drain = pendingDrain;
      void pendingDrain.then(() => {
        if (drain === pendingDrain) drain = null;
        if (closeFailures === failures) closeFailures = null;
      }, () => {
        if (drain === pendingDrain) drain = null;
        if (closeFailures === failures) closeFailures = null;
      });
      return pendingDrain;
    },
    resume(): void {
      accepting = true;
      completed = false;
      drain = null;
      closeFailures = null;
    },
    complete(): void {
      accepting = false;
      completed = true;
      closeFailures = null;
    },
  };
}

export interface CloseActions {
  pauseBrowserMetadata(): void;
  resumeBrowserMetadata(): void;
  cancelRuntime(): Promise<void>;
  cancelVoice(): Promise<void>;
  flushBrowser(): Promise<void>;
  drainStore(): Promise<void>;
  closeOnboardingBrowser(): Promise<void>;
  destroyBrowser(): void;
  allowClose(): void;
  closeWindow(): void;
}

export function createCloseController(
  admission: ReturnType<typeof createCloseAdmission>,
  actions: CloseActions,
) {
  let pending: Promise<CloseAttemptResult> | null = null;
  let failed = false;
  let failureReason: 'browser-metadata' | 'close' | null = null;
  let closed = false;

  const fail = (reason: 'browser-metadata' | 'close', error: unknown): CloseAttemptResult => {
    actions.resumeBrowserMetadata();
    failed = true;
    failureReason = reason;
    return {
      status: 'failed',
      reason,
      message: error instanceof Error ? error.message : 'Не удалось подготовить приложение к закрытию.',
    };
  };

  const close = (discardBrowserMetadata = false): Promise<CloseAttemptResult> => {
    if (pending) return pending;
    if (closed) return Promise.resolve({ status: 'closed' });
    if (typeof discardBrowserMetadata !== 'boolean') {
      return Promise.resolve({ status: 'failed', reason: 'close', message: 'Некорректный параметр закрытия.' });
    }
    if (discardBrowserMetadata && (!failed || failureReason !== 'browser-metadata')) {
      return Promise.resolve({ status: 'failed', reason: 'close', message: 'Пропустить можно только сохранение метаданных браузера после его ошибки.' });
    }

    const attempt = (async (): Promise<CloseAttemptResult> => {
      actions.pauseBrowserMetadata();
      try {
        await admission.beginClose();
        const cancellations = await Promise.allSettled([actions.cancelRuntime(), actions.cancelVoice()]);
        const cancellationFailure = cancellations.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (cancellationFailure) throw cancellationFailure.reason;
        if (!discardBrowserMetadata) {
          try { await actions.flushBrowser(); }
          catch (error) { return fail('browser-metadata', error); }
        }
        await actions.drainStore();
        await actions.closeOnboardingBrowser();
        actions.destroyBrowser();
        admission.complete();
        actions.allowClose();
        closed = true;
        failed = false;
        failureReason = null;
        actions.closeWindow();
        return { status: 'closed' };
      } catch (error) {
        return fail('close', error);
      }
    })();
    const wrapped = attempt.finally(() => { if (pending === wrapped) pending = null; });
    pending = wrapped;
    return wrapped;
  };

  return {
    close,
    resume(): boolean {
      if (pending || closed) return false;
      if (!failed) return true;
      admission.resume();
      failed = false;
      failureReason = null;
      return true;
    },
    reopen(): boolean {
      if (pending) return false;
      admission.resume();
      failed = false;
      failureReason = null;
      closed = false;
      return true;
    },
  };
}
