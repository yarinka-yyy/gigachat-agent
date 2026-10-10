import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, safeStorage, screen, session, shell, systemPreferences, Tray, WebContentsView, type IpcMainInvokeEvent, type MediaAccessPermissionRequest } from 'electron';
import { openStore, type LocalStore } from './store';
import { COMPACTION_QUALITY_VERIFIED, COMPACTION_UNAVAILABLE_REASON, COMPACTION_TASK_INSTRUCTION, buildNextTurnContext, validateCompactSummary } from './context';
import { createLocalTools, createPowerShellHelper, resolvePowerShellHelperPath, type LocalTools } from './local-tools';
import { createTurnRuntime, type PreparedCompactionContext, type TurnRuntime } from './runtime';
import type { AcceptedTurnInput, ChatPatch, CompactSnapshot, FolderOpener, HookRunResult, ModelRegistrySnapshot, NotificationSettings, PreferredOpener, RuntimeAvailability, SettingsPatch, Theme, VoiceAvailability } from './contracts';
import { requirePermissionProfile, type PermissionProfile } from './permissions';
import { isModelAvailable, requireModelId } from './models';
import { openCustomPermissions, parseCustomConfig } from './custom-permissions';
import { createPermissionApprovals } from './permission-approvals';
import { createSkillRegistry, isSkillId } from './skills';
import { createHookApprovalGate, createHookDispatcher, createHookRegistry, transitionProjectHookContext, type HookApprovalRequestContext, type HookExecutionContext } from './hooks';
import { createSecureStore } from './secure-store';
import { createGigaChatProvider, createHttpsTransport, GIGACHAT_ROOT_CA_SHA256, GigaChatProviderError, type GigaChatProviderConnection, type ProviderTransport } from './gigachat-provider';
import { createOnboardingBrowser, type BrowserBounds } from './onboarding-browser';
import { createEmbeddedBrowser } from './embedded-browser';
import { createNumberedProjectFolder, prepareProjectFolders, removeEmptyCreatedFolder } from './project-folders';
import { createVoiceRuntime, VOICE_MAX_OUTPUT_BYTES, type VoiceRuntime } from './voice';
import { prepareVoiceModelCache } from './voice-model-cache';
import {
  acquirePrimaryInstance,
  createCloseAdmission,
  createCloseController,
  createDetectedFolderOpener,
  createTrayLifecycle,
  APP_USER_MODEL_ID,
  migrateCurrentVersionAutoStart,
  readInstalledAutoStart,
  resolveInstalledLauncher,
  NSIS_INSTALLER_GUID,
  writeInstalledAutoStart,
  type NsisInstallRegistration,
} from './lifecycle';
import { validateProjectFolder } from './project-paths';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

let mainWindow: BrowserWindow | null = null;
let onboardingBrowser: ReturnType<typeof createOnboardingBrowser> | null = null;
let embeddedBrowser: ReturnType<typeof createEmbeddedBrowser> | null = null;
let currentTheme: Theme = 'emerald';
let allowClose = false;
let allowAppQuit = false;
let deletingAppData = false;
let tray: Tray | null = null;
let createMainWindow: (() => void) | null = null;
const trayLifecycle = createTrayLifecycle();
const closeAdmission = createCloseAdmission();
let closeController: ReturnType<typeof createCloseController> | null = null;
let approvalBroker: ReturnType<typeof createPermissionApprovals> | null = null;
let microphoneConsentGranted = false;
let secondInstancePendingFocus = false;
let autoStartMigrationIssue: string | null = null;

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && createMainWindow) {
      secondInstancePendingFocus = false;
      createMainWindow();
    } else {
      secondInstancePendingFocus = true;
      return;
    }
  }
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    secondInstancePendingFocus = true;
    return;
  }
  secondInstancePendingFocus = false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

let isSquirrelStartup = false;
// Squirrel startup handles install/update argv synchronously before the instance lock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require('electron-squirrel-startup')) isSquirrelStartup = true;
const isPrimaryInstance = acquirePrimaryInstance(
  isSquirrelStartup,
  () => app.requestSingleInstanceLock(),
  () => app.quit(),
);
if (isPrimaryInstance) app.on('second-instance', focusMainWindow);

function titleBarColors(): { color: string; symbolColor: string } {
  const theme = currentTheme === 'system'
    ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    : currentTheme;
  if (theme === 'emerald') return { color: '#04171b', symbolColor: '#dce9e8' };
  if (theme === 'dark') return { color: '#151719', symbolColor: '#e9ebed' };
  if (theme === 'warm') return { color: '#f3ead7', symbolColor: '#382f20' };
  return { color: '#dce5e7', symbolColor: '#18343b' };
}

function syncTitleBarOverlay(): void {
  if (process.platform === 'darwin') return;
  mainWindow?.setTitleBarOverlay({ ...titleBarColors(), height: 42 });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Запрос из недоверенного окна отклонён.');
  }
}

function pathsMatch(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/^\\\\\?\\/, '');
  const normalizedRight = resolve(right).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function resolveAppOwnedUserDataPath(): Promise<string> {
  const configuredAppData = app.getPath('appData');
  const configuredUserData = app.getPath('userData');
  if (!isAbsolute(configuredAppData) || !isAbsolute(configuredUserData)) {
    throw new Error('Путь локальных данных приложения недоступен.');
  }
  const [appDataInfo, userDataInfo] = await Promise.all([lstat(configuredAppData), lstat(configuredUserData)]);
  if (!appDataInfo.isDirectory() || appDataInfo.isSymbolicLink()
    || !userDataInfo.isDirectory() || userDataInfo.isSymbolicLink()) {
    throw new Error('Удаление остановлено: каталог данных содержит ссылку или недоступен.');
  }
  const [appDataPath, userDataPath] = await Promise.all([realpath(configuredAppData), realpath(configuredUserData)]);
  if (!pathsMatch(appDataPath, configuredAppData) || !pathsMatch(userDataPath, configuredUserData)) {
    throw new Error('Удаление остановлено: путь данных перенаправлен.');
  }
  const relativeUserData = relative(appDataPath, userDataPath);
  if (!relativeUserData || relativeUserData === '.' || relativeUserData === '..'
    || relativeUserData.startsWith(`..${sep}`) || isAbsolute(relativeUserData)
    || relativeUserData.includes(sep)
    || !pathsMatch(basename(userDataPath), app.getName())
    || !pathsMatch(dirname(userDataPath), appDataPath)) {
    throw new Error('Удаление остановлено: выбранный каталог не является данными этого приложения.');
  }
  return userDataPath;
}

function launchAppDataDeletionHelper(helperPath: string, userDataPath: string): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helperPath, ['--delete-app-data', String(process.pid)], {
        cwd: dirname(helperPath),
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      rejectReady(new Error('Не удалось подготовить безопасное удаление; локальные данные не изменены.'));
      return;
    }

    const childStdin = child.stdin;
    const childStdout = child.stdout;
    let buffer = '';
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch { /* Startup failure is reported below. */ }
      childStdout?.destroy();
      childStdin?.destroy();
      rejectReady(new Error('Не удалось подготовить безопасное удаление; локальные данные не изменены.'));
    };
    const timeout = setTimeout(fail, 10_000);
    child.once('error', fail);
    child.once('close', fail);
    if (!childStdin || !childStdout) {
      fail();
      return;
    }
    childStdin.on('error', () => undefined);
    childStdout.setEncoding('utf8');
    childStdout.on('data', (chunk: string | Buffer) => {
      if (settled) return;
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > 2048) {
        fail();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      if (!line || buffer.slice(newline + 1).trim()) {
        fail();
        return;
      }
      let response: unknown;
      try { response = JSON.parse(line) as unknown; } catch { fail(); return; }
      if (!isRecord(response) || response.Ready !== true
        || response.ParentProcessId !== process.pid || response.TargetValidated !== true) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      childStdout.removeAllListeners('data');
      childStdout.destroy();
      childStdin.destroy();
      child.unref();
      resolveReady();
    });
    childStdin.end(JSON.stringify({ UserDataPath: userDataPath }), 'utf8');
  });
}

async function showLocalNotification(
  store: LocalStore,
  category: keyof NotificationSettings,
  title: string,
  body: string,
): Promise<void> {
  if (!Notification.isSupported() || !mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  try {
    if (!(await store.getSettings()).notifications[category]
      || !mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
    new Notification({ title, body }).show();
  } catch {
    // A notification failure must not change a saved chat or runtime result.
  }
}

async function withLocalFailureNotification<T>(
  store: LocalStore,
  action: () => Promise<T>,
  shouldNotify: (error: unknown) => boolean = () => true,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (shouldNotify(error)) {
      void showLocalNotification(store, 'failures', 'Не удалось выполнить локальную операцию', 'Откройте приложение, чтобы проверить её состояние.');
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
    || isRecord(value) && value.code === 'ABORT_ERR';
}

function requireText(value: unknown, label: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`${label}: значение некорректно.`);
  }
  return value;
}

function requireId(value: unknown): string {
  const id = requireText(value, 'Идентификатор');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Некорректный идентификатор.');
  return id;
}

function requireSettingsPatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) throw new Error('Некорректные настройки.');
  const allowedFields = ['theme', 'sidebarTransparent', 'sidebarVisible', 'sidebarWidthPx', 'browserPaneOpen', 'browserWidthPx', 'defaultProjectsFolder', 'preferredOpener', 'defaultPermissionProfile', 'defaultModelId', 'onboardingCompleted', 'notifications'];
  if (Object.keys(value).some((key) => !allowedFields.includes(key))) throw new Error('Недопустимое поле настроек.');
  if ('defaultPermissionProfile' in value) requirePermissionProfile(value.defaultPermissionProfile);
  if ('defaultModelId' in value && value.defaultModelId !== null) requireModelId(value.defaultModelId);
  if ('onboardingCompleted' in value && typeof value.onboardingCompleted !== 'boolean') {
    throw new Error('Некорректный статус первичной настройки.');
  }
  if ('notifications' in value) {
    const notifications = value.notifications;
    if (!isRecord(notifications)
      || typeof notifications.taskStarted !== 'boolean'
      || typeof notifications.taskCompleted !== 'boolean'
      || typeof notifications.failures !== 'boolean'
      || Object.keys(notifications).some((key) => !['taskStarted', 'taskCompleted', 'failures'].includes(key))) {
      throw new Error('Некорректные категории уведомлений.');
    }
  }
  return value as SettingsPatch;
}

function requireBrowserBounds(value: unknown): BrowserBounds {
  if (!isRecord(value) || !['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) {
    throw new Error('Некорректная область встроенного браузера.');
  }
  return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
}

function requireChatPatch(value: unknown): ChatPatch {
  if (!isRecord(value)) throw new Error('Некорректные изменения чата.');
  if ('modelId' in value && value.modelId !== null) requireModelId(value.modelId);
  if ('nextTurnPermissionProfile' in value && value.nextTurnPermissionProfile !== null) {
    requirePermissionProfile(value.nextTurnPermissionProfile);
  }
  if ('nextTurnSkillId' in value && value.nextTurnSkillId !== null && !isSkillId(value.nextTurnSkillId)) {
    throw new Error('Некорректный идентификатор Skill для следующего хода.');
  }
  return value as ChatPatch;
}

async function requireDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('Путь к папке должен быть абсолютным.');
  }
  const path = value;
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('Выбранный путь не является папкой.');
  } catch {
    throw new Error('Папка не найдена или недоступна.');
  }
  return path;
}

async function requireProjectDirectory(value: unknown): Promise<string> {
  return validateProjectFolder(value, app.getPath('documents'));
}

async function chooseDirectory(defaultPath?: string | null): Promise<string | null> {
  const startPath = defaultPath ? await requireDirectory(defaultPath).catch(() => undefined) : undefined;
  const options = {
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    ...(startPath ? { defaultPath: startPath } : {}),
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return requireDirectory(result.filePaths[0]);
}

function getVscodeCandidates(): string[] {
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

const vscodeOpener = createDetectedFolderOpener(
  getVscodeCandidates,
  async (candidate) => {
    const info = await lstat(candidate).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  },
  launchDetached,
);

async function getInstalledLauncher() {
  if (process.platform !== 'win32' || !app.isPackaged) return null;
  return resolveInstalledLauncher(process.execPath, async (candidate) => {
    const info = await lstat(candidate).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  }, readNsisInstallRegistrations);
}

function readNsisInstallRegistrations(): Promise<NsisInstallRegistration[] | null> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return Promise.resolve(null);
  const powershellExecutable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$guid = '${NSIS_INSTALLER_GUID}'
$items = [System.Collections.Generic.List[object]]::new()
foreach ($entry in @(
  [pscustomobject]@{ Scope = 'user'; Hive = [Microsoft.Win32.RegistryHive]::CurrentUser },
  [pscustomobject]@{ Scope = 'machine'; Hive = [Microsoft.Win32.RegistryHive]::LocalMachine }
)) {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($entry.Hive, [Microsoft.Win32.RegistryView]::Registry64)
  $installKey = $null
  $uninstallKey = $null
  try {
    $installKey = $baseKey.OpenSubKey('Software\\' + $guid, $false)
    $uninstallKey = $baseKey.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $guid, $false)
    if ($null -ne $installKey -or $null -ne $uninstallKey) {
      $installLocation = if ($null -ne $installKey) { $installKey.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
      $uninstallString = if ($null -ne $uninstallKey) { $uninstallKey.GetValue('UninstallString', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
      [void]$items.Add([pscustomobject]@{ scope = $entry.Scope; installLocation = $installLocation; uninstallString = $uninstallString })
    }
  } finally {
    if ($null -ne $installKey) { $installKey.Close() }
    if ($null -ne $uninstallKey) { $uninstallKey.Close() }
    $baseKey.Close()
  }
}
ConvertTo-Json -InputObject $items.ToArray() -Compress
`;

  return new Promise((resolvePromise) => {
    execFile(powershellExecutable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16_384,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) {
        resolvePromise(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (!Array.isArray(parsed)) {
          resolvePromise(null);
          return;
        }
        const registrations: NsisInstallRegistration[] = [];
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null) {
            resolvePromise(null);
            return;
          }
          const record = item as Record<string, unknown>;
          if ((record.scope !== 'user' && record.scope !== 'machine')
            || (record.installLocation !== null && typeof record.installLocation !== 'string')
            || (record.uninstallString !== null && typeof record.uninstallString !== 'string')) {
            resolvePromise(null);
            return;
          }
          registrations.push({
            scope: record.scope,
            installLocation: record.installLocation,
            uninstallString: record.uninstallString,
          });
        }
        resolvePromise(registrations);
      } catch {
        resolvePromise(null);
      }
    });
  });
}

function loginItemApi() {
  return {
    // Electron parses this Windows path as a command line and truncates at spaces unless quoted.
    getSettings: (options: { path: string; args: string[] }) => app.getLoginItemSettings({ ...options, path: `"${options.path}"` }),
    setSettings: (settings: { path: string; args: string[]; openAtLogin: boolean; enabled: boolean }) => app.setLoginItemSettings(settings),
  };
}

async function availableOpeners(): Promise<FolderOpener[]> {
  const openers: FolderOpener[] = [
    { id: 'system', name: 'Приложение Windows по умолчанию' },
    { id: 'explorer', name: 'Проводник Windows' },
  ];
  if (await vscodeOpener.detect()) openers.push({ id: 'vscode', name: 'Visual Studio Code' });
  return openers;
}

function launchDetached(executable: string, args: string[], windowsHide = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openDirectory(pathInput: unknown, opener: PreferredOpener): Promise<void> {
  const path = await requireDirectory(pathInput);
  if (opener === 'system') {
    const error = await shell.openPath(path);
    if (error) throw new Error('Не удалось открыть папку приложением Windows по умолчанию.');
    return;
  }
  if (opener === 'explorer') {
    const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows';
    const explorer = join(windowsDirectory, 'explorer.exe');
    if (!(await stat(explorer).catch(() => null))?.isFile()) throw new Error('Проводник Windows недоступен.');
    await launchDetached(explorer, [path]);
    return;
  }
  if (!(await vscodeOpener.openFolder(path))) throw new Error('Visual Studio Code не найден.');
}

function requirePreferredOpener(value: unknown): PreferredOpener {
  if (value === 'system' || value === 'explorer' || value === 'detected-app') return value;
  throw new Error('Неизвестная программа для открытия папки.');
}

interface MainRuntimeBundle {
  runtime: TurnRuntime;
  availability: RuntimeAvailability;
  providerConnection: GigaChatProviderConnection;
  voiceRuntime: VoiceRuntime | null;
  voiceAvailability: VoiceAvailability;
  skills: ReturnType<typeof createSkillRegistry>;
  hooks: ReturnType<typeof createHookRegistry>;
  startSessionHooks(): Promise<void>;
  beginCloseHooks(): void;
  endSessionHooks(): Promise<void>;
  resumeSessionHooks(): void;
}

const VOICE_FILES = [
  'gigastt.exe',
  'v3_e2e_rnnt_encoder_int8.onnx',
  'v3_e2e_rnnt_decoder.onnx',
  'v3_e2e_rnnt_joint.onnx',
  'v3_e2e_rnnt_vocab.txt',
  'silero_vad.onnx',
] as const;

async function createVoiceService(userDataPath: string): Promise<{ runtime: VoiceRuntime | null; availability: VoiceAvailability }> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return { runtime: null, availability: { available: false, reason: 'Локальная диктовка доступна только в Windows x64.' } };
  }
  const voiceDirectory = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'voice' : 'resources/voice');
  try {
    const userDataInfo = await lstat(userDataPath);
    if (!isAbsolute(userDataPath) || !userDataInfo.isDirectory() || userDataInfo.isSymbolicLink()
      || !pathsMatch(await realpath(userDataPath), userDataPath)) throw new Error('user data unavailable');
    const directoryInfo = await lstat(voiceDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('resource directory unavailable');
    for (const name of VOICE_FILES) {
      const entry = await lstat(join(voiceDirectory, name));
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('resource file unavailable');
    }
    const modelCache = await prepareVoiceModelCache(userDataPath, voiceDirectory);
    const audioTempRoot = join(userDataPath, 'voice-temp');
    await mkdir(audioTempRoot, { recursive: true });
    const audioTempInfo = await lstat(audioTempRoot);
    if (!audioTempInfo.isDirectory() || audioTempInfo.isSymbolicLink()
      || !pathsMatch(await realpath(audioTempRoot), audioTempRoot)) throw new Error('audio temp directory unavailable');
    const cleanupPreparedAudio = async (directory: string, filePath: string): Promise<void> => {
      const rootInfo = await lstat(audioTempRoot);
      const directoryInfo = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
        || !pathsMatch(await realpath(audioTempRoot), audioTempRoot)
        || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
        || !pathsMatch(dirname(canonicalDirectory), audioTempRoot)) throw new Error('unsafe temp path');
      const fileInfo = await lstat(filePath).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink()
        || !pathsMatch(await realpath(filePath), filePath))) throw new Error('unsafe temp file');
      if (fileInfo) await rm(filePath);
      await rmdir(directory);
    };
    const runtime = createVoiceRuntime({
      executable: join(voiceDirectory, 'gigastt.exe'),
      modelDirectory: modelCache.modelDirectory,
    }, {
      async prepareAudio(audio) {
        const rootInfo = await lstat(audioTempRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
          || !pathsMatch(await realpath(audioTempRoot), audioTempRoot)) {
          throw new Error('Не удалось подготовить временную аудиозапись.');
        }
        const directory = await mkdtemp(join(audioTempRoot, 'gigachat-voice-'));
        const filePath = join(directory, 'recording.webm');
        try {
          const directoryInfo = await lstat(directory);
          if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
            || !pathsMatch(dirname(await realpath(directory)), audioTempRoot)) throw new Error('unsafe temp directory');
          await writeFile(filePath, audio, { flag: 'wx', mode: 0o600 });
        } catch {
          await cleanupPreparedAudio(directory, filePath).catch(() => undefined);
          throw new Error('Не удалось подготовить временную аудиозапись.');
        }
        return {
          filePath,
          async cleanup() {
            try {
              await cleanupPreparedAudio(directory, filePath);
            } catch {
              throw new Error('Не удалось удалить временную аудиозапись.');
            }
          },
        };
      },
      async run(executable, args, environment, signal) {
        await modelCache.validate();
        if (signal.aborted) throw new Error('Распознавание отменено.');
        return new Promise<string>((resolve, reject) => {
          const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
          const temp = app.getPath('temp');
          const child = spawn(executable, args, {
            cwd: voiceDirectory,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: {
              SystemRoot: systemRoot,
              WINDIR: process.env.WINDIR ?? systemRoot,
              PATH: join(systemRoot, 'System32'),
              TEMP: temp,
              TMP: temp,
              ...environment,
            },
          });
          const chunks: Buffer[] = [];
          let outputBytes = 0;
          let failure: Error | null = null;
          const stop = (error: Error): void => {
            if (failure) return;
            failure = error;
            child.kill();
          };
          const timeout = setTimeout(() => stop(new Error('Локальное распознавание превысило время ожидания.')), 180_000);
          const onAbort = (): void => stop(new Error('Распознавание отменено.'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
          child.stdout?.on('data', (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > VOICE_MAX_OUTPUT_BYTES) {
              stop(new Error('Ответ локального распознавания слишком велик.'));
              return;
            }
            chunks.push(chunk);
          });
          child.once('error', () => {
            if (!failure) failure = new Error('Не удалось запустить локальное распознавание.');
          });
          child.once('close', (code) => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
            if (failure) reject(failure);
            else if (code !== 0) reject(new Error('Локальное распознавание завершилось с ошибкой.'));
            else resolve(Buffer.concat(chunks, outputBytes).toString('utf8'));
          });
        });
      },
    });
    return { runtime, availability: { available: true, reason: null } };
  } catch {
    return { runtime: null, availability: { available: false, reason: 'Локальный runtime диктовки не найден или его временное хранилище недоступно.' } };
  }
}

async function createMainRuntime(
  store: LocalStore,
  customPermissions: Awaited<ReturnType<typeof openCustomPermissions>>,
  approvals: ReturnType<typeof createPermissionApprovals>,
  helperCandidate: ReturnType<typeof createPowerShellHelper> | undefined,
  secureStore: ReturnType<typeof createSecureStore>,
): Promise<MainRuntimeBundle> {
  const skills = createSkillRegistry({ userDataPath: app.getPath('userData'), listProjects: () => store.listProjects() });
  const hooks = createHookRegistry({
    userDataPath: app.getPath('userData'),
    listProjects: () => store.listProjects(),
    listSkills: async () => (await skills.list()).skills,
  });
  let helper = helperCandidate;
  let unavailableReason: string | null = null;
  if (helper) {
    try {
      await helper.recover();
    } catch {
      helper = undefined;
      // A runtime recovery failure disables tools but does not prevent local chats from opening.
      unavailableReason = 'Не удалось восстановить локальный PowerShell runtime.';
    }
  } else unavailableReason = 'Локальный PowerShell helper доступен только в Windows-сборке.';

  const voiceService = await createVoiceService(app.getPath('userData'));

  const caBasePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const caPath = join(caBasePath, app.isPackaged ? 'gigachat' : 'resources/gigachat', 'russian_trusted_root_ca_pem.crt');
  let transport: ProviderTransport;
  try {
    const additionalCa = await readFile(caPath, 'utf8');
    transport = createHttpsTransport({ additionalCa, expectedAdditionalCaSha256: GIGACHAT_ROOT_CA_SHA256 });
  } catch {
    // Local use remains available; network access still requires a valid system-trusted HTTPS chain.
    transport = createHttpsTransport();
  }
  const providerConnection = createGigaChatProvider({
    loadAuthorizationKey: () => secureStore.load(),
    transport,
  });

  let activeProjectContext: HookExecutionContext | null = null;
  let currentAcceptedHookContext: HookExecutionContext | null = null;
  let hookApprovalSuppressionDepth = 0;
  let closingHooks = false;
  let sessionStartAttempted = false;
  let sessionEndAttempted = false;
  let tools!: LocalTools;
  let dispatchHookHandlers!: ReturnType<typeof createHookDispatcher>;
  let hookApprovalGate: {
    request(details: Parameters<typeof approvals.request>[0], signal?: AbortSignal, context?: HookApprovalRequestContext): Promise<boolean>;
  };

  const requestLocalApproval = async (
    details: Parameters<typeof approvals.request>[0],
    signal?: AbortSignal,
    requestContext?: { projectId: string | null; profile: PermissionProfile; skillId: string | null; workingFolder: string; resource: HookApprovalRequestContext['resource']; action: HookApprovalRequestContext['action'] },
  ): Promise<boolean> => {
    const acceptedContext = currentAcceptedHookContext;
    const context = requestContext && acceptedContext
      ? { execution: acceptedContext, ...requestContext }
      : undefined;
    return hookApprovalGate.request(details, signal, context);
  };

  let runtime: TurnRuntime | null = null;
  tools = createLocalTools({
    resolveProject: async (id) => (await store.listProjects()).find((project) => project.id === id) ?? null,
    protectedDirectory: app.getPath('userData'),
    getCustomPolicy: customPermissions.policy,
    requestApproval: requestLocalApproval,
    revealItem: async (path) => {
      shell.showItemInFolder(path);
    },
    openTextFile: async (path) => {
      const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows';
      const notepad = join(windowsDirectory, 'System32', 'notepad.exe');
      const notepadInfo = await lstat(notepad).catch(() => null);
      if (!notepadInfo?.isFile() || notepadInfo.isSymbolicLink()) throw new Error('Блокнот Windows недоступен.');
      await launchDetached(notepad, [path], false);
    },
    ...(helper ? { runPowerShell: helper.run, writeFile: helper.writeFile } : {}),
    onEvent: (event) => {
      runtime?.recordToolEvent(event);
      if (event.phase === 'failed') {
        void showLocalNotification(store, 'failures', 'Локальный инструмент завершился с ошибкой', 'Откройте чат, чтобы проверить состояние.');
      }
    },
  });
  dispatchHookHandlers = createHookDispatcher({
    registry: hooks,
    tools,
    isAvailable: () => Boolean(helper),
    onResult: (result) => hooks.recordResult(result),
  });
  hookApprovalGate = createHookApprovalGate({
    dispatch: dispatchHookHandlers,
    isSuppressed: () => closingHooks || hookApprovalSuppressionDepth > 0,
    requestApproval: approvals.request,
    onResult: (result) => runtime?.recordHookResult(result),
  });

  const lastNotifiedStatus = new Map<string, string>();
  const turnRuntime = createTurnRuntime({
    provider: providerConnection,
    tools,
    validateRetry: async (turn, original) => {
      await store.validateAcceptedTurn(turn);
      await store.getMessagesThrough(turn.chatId, turn.messageId);
      if (providerConnection.getConnectionStatus().state !== 'connected') {
        throw new Error('Подключите GigaChat перед повтором этого хода.');
      }
      if (!turn.modelId || !isModelAvailable(providerConnection.getModelRegistry(), turn.modelId)) {
        throw new Error('Выбранная для этого хода модель сейчас недоступна. Выбор исходного хода сохранён.');
      }
      if (turn.skillId && !await skills.getEnabled(turn.skillId)) {
        throw new Error('Skill исходного хода больше не включён; его выбор не заменён автоматически.');
      }
      if (providerConnection.getConnectionStatus().state !== 'connected') {
        throw new Error('Подключение GigaChat изменилось; повтор не поставлен в очередь.');
      }
      await store.reserveRetryTurn(original, turn);
      if (providerConnection.getConnectionStatus().state !== 'connected'
        || !turn.modelId || !isModelAvailable(providerConnection.getModelRegistry(), turn.modelId)) {
        throw new Error('Подключение или доступность модели изменились; повтор не поставлен в очередь.');
      }
      if (turn.skillId && !await skills.getEnabled(turn.skillId)) {
        throw new Error('Skill исходного хода больше не включён; повтор не поставлен в очередь.');
      }
    },
    prepareTurn: async (turn, signal) => {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (turn.operation === 'compaction' && !COMPACTION_QUALITY_VERIFIED) throw new Error(COMPACTION_UNAVAILABLE_REASON);
      await store.validateAcceptedTurn(turn);
      if (!turn.modelId || !isModelAvailable(providerConnection.getModelRegistry(), turn.modelId)) {
        throw new GigaChatProviderError('model');
      }
      const projects = await store.listProjects();
      const project = turn.projectId ? projects.find((item) => item.id === turn.projectId) : null;
      if (turn.projectId && (!project || project.workingFolder !== turn.projectWorkingFolder)) {
        throw new Error('Проект или его рабочая папка изменились после принятия хода.');
      }
      const selectedSkill = turn.skillId ? await skills.getEnabled(turn.skillId) : null;
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (turn.skillId && !selectedSkill) throw new Error('Выбранный Skill удалён или выключен. Включите его снова либо снимите выбор.');
      if (selectedSkill?.scope === 'project' && selectedSkill.projectId !== turn.projectId) {
        throw new Error('Выбранный Skill принадлежит другому проекту; выбор для этого хода не изменён.');
      }
      const projectInstructions = project
        ? await store.readProjectInstructions(project.id, turn.projectWorkingFolder)
        : '';
      const globalText = await store.readGlobalInstructions();
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      await store.validateAcceptedTurn(turn);
      const detail = await store.getChat(turn.chatId);
      const compactionPrefix = turn.operation === 'compaction'
        ? await store.getCompactionPrefix(turn.chatId, turn.compactBoundaryMessageId)
        : null;
      const messages = compactionPrefix?.messages ?? await store.getMessagesThrough(turn.chatId, turn.messageId);
      const protocolHistory = compactionPrefix?.protocolHistory ?? await store.getToolProtocolThrough(turn.chatId, turn.messageId);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const context = buildNextTurnContext({
        globalText,
        projectInstructions: project ? [{ scope: project.name, text: projectInstructions }] : [],
        selectedSkill: selectedSkill ? {
          name: selectedSkill.name,
          scope: selectedSkill.scope === 'global' ? 'Global' : `Project · ${selectedSkill.projectName ?? project?.name ?? 'неизвестный проект'}`,
          text: selectedSkill.instructions,
        } : null,
        messages,
        protocolHistory,
        compactSnapshot: detail.compactSnapshot,
        permissionProfile: turn.permissionProfile,
        modelId: turn.modelId,
        ...(turn.operation === 'compaction' ? {
          taskInstruction: COMPACTION_TASK_INSTRUCTION,
          usageKind: 'compaction' as const,
          functionCallMode: 'none' as const,
        } : {}),
      });
      if (turn.operation === 'compaction' && compactionPrefix) {
        return {
          request: context.request,
          compaction: {
            boundaryMessageId: turn.compactBoundaryMessageId!,
            coveredThroughMessageId: compactionPrefix.coveredThroughMessageId,
            coveredPrefixHash: compactionPrefix.coveredPrefixHash,
            expectedSnapshotId: turn.compactExpectedSnapshotId ?? null,
            provenance: 'provider' as const,
          },
        };
      }
      return context.request;
    },
    consumeTurn: (turn: AcceptedTurnInput, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    beginToolReceipt: (turn, receipt) => store.beginToolReceipt(turn.chatId, turn.messageId, receipt),
    completeToolReceipt: (turn, receiptId, status, result) => store.completeToolReceipt(turn.chatId, turn.messageId, receiptId, status, result),
    appendAssistant: async (turn, text, signal, functionsStateId) => {
      await store.appendAssistantMessageFromRuntime(turn.chatId, turn.messageId, text, signal, functionsStateId);
    },
    appendCompaction: async (turn, text, signal, context: PreparedCompactionContext) => {
      const snapshot: CompactSnapshot = {
        id: randomUUID(),
        version: 1,
        boundaryMessageId: context.boundaryMessageId,
        coveredThroughMessageId: context.coveredThroughMessageId,
        coveredPrefixHash: context.coveredPrefixHash,
        text: validateCompactSummary(text),
        modelId: turn.modelId ?? (() => { throw new Error('Модель для сводки не выбрана.'); })(),
        provenance: context.provenance,
        createdAt: new Date().toISOString(),
      };
      await store.commitCompactSnapshot(turn.chatId, snapshot, context.expectedSnapshotId, signal);
    },
    compactionEnabled: COMPACTION_QUALITY_VERIFIED,
    recordUsageReceipt: (receipt) => store.recordUsageReceipt(receipt),
    runHooks: async (turn, input, signal) => {
      const context: HookExecutionContext = {
        projectId: turn.projectId,
        projectWorkingFolder: turn.projectWorkingFolder,
        permissionProfile: turn.permissionProfile,
        skillId: turn.skillId,
      };
      currentAcceptedHookContext = context;
      const results: HookRunResult[] = [];
      if (input.event === 'user-prompt-submitted') {
        const transition = transitionProjectHookContext(activeProjectContext, context);
        if (transition.end?.projectId) {
          results.push(...await dispatchHookHandlers(transition.end, {
            event: 'project-end', projectId: transition.end.projectId,
          }, signal, { maxHandlers: 2, timeoutMs: 1_500 }));
        }
        if (transition.start?.projectId) {
          results.push(...await dispatchHookHandlers(transition.start, {
            event: 'project-start', projectId: transition.start.projectId,
          }, signal, { maxHandlers: 2, timeoutMs: 1_500 }));
        }
        activeProjectContext = transition.active;
      }
      const terminalEvent = input.event === 'stop' || input.event === 'interrupt' || input.event === 'project-end';
      if (input.event === 'stop' || input.event === 'interrupt') hookApprovalSuppressionDepth += 1;
      try {
        results.push(...await dispatchHookHandlers(context, input, signal, terminalEvent ? { maxHandlers: 2, timeoutMs: 1_500 } : undefined));
      } finally {
        if (input.event === 'stop' || input.event === 'interrupt') hookApprovalSuppressionDepth -= 1;
      }
      return results;
    },
    onUpdate: (turn) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:update', turn);
      if (lastNotifiedStatus.get(turn.id) === turn.status) return;
      lastNotifiedStatus.set(turn.id, turn.status);
      if (turn.status === 'running') {
        void showLocalNotification(store, 'taskStarted', 'Ход начался', 'Очередь начала обработку запроса.');
      } else if (turn.status === 'completed') {
        void showLocalNotification(store, 'taskCompleted', 'Ответ готов', 'Ответ сохранён в чате.');
        lastNotifiedStatus.delete(turn.id);
      } else if (turn.status === 'failed') {
        void showLocalNotification(store, 'failures', 'Ход завершился с ошибкой', 'Откройте чат, чтобы проверить состояние.');
        lastNotifiedStatus.delete(turn.id);
      } else if (turn.status === 'cancelled') {
        lastNotifiedStatus.delete(turn.id);
      }
    },
  });
  runtime = turnRuntime;
  const startSessionHooks = async (): Promise<void> => {
    if (sessionStartAttempted || closingHooks) return;
    sessionStartAttempted = true;
    const settings = await store.getSettings();
    const context: HookExecutionContext = {
      projectId: null, projectWorkingFolder: null,
      permissionProfile: settings.defaultPermissionProfile, skillId: null,
    };
    await dispatchHookHandlers(context, { event: 'session-start', projectId: null }, new AbortController().signal, {
      maxHandlers: 2, timeoutMs: 1_500,
    });
  };
  const endSessionHooks = async (): Promise<void> => {
    if (sessionEndAttempted) return;
    sessionEndAttempted = true;
    closingHooks = true;
    const terminalSignal = new AbortController().signal;
    if (activeProjectContext?.projectId) {
      await dispatchHookHandlers(activeProjectContext, { event: 'project-end', projectId: activeProjectContext.projectId }, terminalSignal, {
        maxHandlers: 2, timeoutMs: 1_500,
      }).catch(() => undefined);
      activeProjectContext = null;
    }
    const settings = await store.getSettings().catch(() => null);
    if (!settings) return;
    await dispatchHookHandlers({
      projectId: null, projectWorkingFolder: null,
      permissionProfile: settings.defaultPermissionProfile, skillId: null,
    }, { event: 'session-end', projectId: null }, terminalSignal, {
      maxHandlers: 2, timeoutMs: 1_500,
    }).catch(() => undefined);
  };
  const beginCloseHooks = (): void => { closingHooks = true; };
  const resumeSessionHooks = (): void => {
    closingHooks = false;
    hookApprovalSuppressionDepth = 0;
    sessionEndAttempted = false;
    currentAcceptedHookContext = null;
  };
  return {
    runtime: turnRuntime,
    providerConnection,
    availability: {
      providerConfigured: false,
      helperRecovered: Boolean(helper),
      rendererToolApi: false,
      helperUnavailableReason: unavailableReason,
      compactionAvailable: COMPACTION_QUALITY_VERIFIED,
      compactionUnavailableReason: COMPACTION_UNAVAILABLE_REASON,
    },
    voiceRuntime: voiceService.runtime,
    voiceAvailability: voiceService.availability,
    skills,
    hooks,
    startSessionHooks,
    beginCloseHooks,
    endSessionHooks,
    resumeSessionHooks,
  };
}

async function registerIpcHandlers(
  store: LocalStore,
  mainRuntime: MainRuntimeBundle,
  secureStore: ReturnType<typeof createSecureStore>,
  browser: ReturnType<typeof createOnboardingBrowser>,
  userBrowser: ReturnType<typeof createEmbeddedBrowser>,
  customPermissions: Awaited<ReturnType<typeof openCustomPermissions>>,
  approvals: ReturnType<typeof createPermissionApprovals>,
): Promise<void> {
  const { runtime, availability, providerConnection, voiceRuntime, voiceAvailability, skills, hooks } = mainRuntime;
  const nonCriticalChannels = new Set([
    'projects:list', 'projects:pick-folder', 'projects:open-folder', 'projects:read-instructions', 'projects:instructions-backup-path',
    'chats:list', 'chats:get', 'chats:open-artifact', 'chats:open-folder',
    'runtime:list', 'runtime:status', 'permissions:read-config', 'permissions:respond',
    'voice:status', 'voice:cancel', 'skills:list', 'skills:read-source', 'skills:open-folder', 'hooks:list', 'hooks:inspect',
    'onboarding:key-status', 'onboarding:browser-status', 'onboarding:browser-open', 'onboarding:browser-close',
    'onboarding:connection-status',
    'models:get-registry', 'models:refresh',
    'onboarding:browser-back', 'onboarding:browser-reload', 'onboarding:browser-bounds',
    'browser:status', 'browser:bounds', 'runtime:cancel',
    'settings:get', 'usage:local-stats', 'usage:get-ledger', 'settings:open-projects-folder', 'settings:list-openers', 'settings:app-info',
    'settings:get-auto-start', 'settings:read-instructions',
  ]);
  const readOnlyChannels = new Set([
    'projects:list', 'projects:read-instructions', 'projects:instructions-backup-path',
    'chats:list', 'chats:get', 'runtime:list', 'runtime:status', 'permissions:read-config',
    'voice:status', 'skills:list', 'skills:read-source', 'hooks:list', 'hooks:inspect', 'onboarding:key-status', 'onboarding:connection-status', 'models:get-registry',
    'onboarding:browser-status', 'browser:status', 'settings:get', 'usage:local-stats', 'usage:get-ledger',
    'settings:list-openers', 'settings:app-info', 'settings:get-auto-start', 'settings:read-instructions',
  ]);
  const availableDuringClose = new Set([
    'runtime:cancel', 'permissions:respond', 'voice:cancel',
    ...readOnlyChannels,
    'onboarding:browser-bounds', 'browser:bounds',
  ]);
  const handle = (
    channel: string,
    callback: (...args: unknown[]) => unknown,
    options: { track?: boolean } = {},
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedSender(event);
      return closeAdmission.run(() => callback(...args), {
        critical: !nonCriticalChannels.has(channel),
        allowWhileClosing: availableDuringClose.has(channel),
        track: options.track,
      });
    });
  };

  const refreshModelRegistry = async (): Promise<ModelRegistrySnapshot> => {
    if (providerConnection.getConnectionStatus().state === 'connected') {
      await providerConnection.listModels().catch(() => undefined);
    }
    return providerConnection.getModelRegistry();
  };

  ipcMain.handle('app:close-handler-ready', (event) => {
    assertTrustedSender(event);
    const shouldRetryClose = trayLifecycle.closeHandlerReady();
    const readyWindow = mainWindow;
    if (shouldRetryClose && readyWindow && !readyWindow.isDestroyed()) {
      setImmediate(() => {
        if (mainWindow === readyWindow && !readyWindow.isDestroyed()) readyWindow.close();
      });
    }
    return true;
  });

  closeController = createCloseController(closeAdmission, {
    pauseBrowserMetadata: () => userBrowser.pauseMetadata(),
    resumeBrowserMetadata: () => userBrowser.resumeMetadata(),
    cancelRuntime: async () => {
      mainRuntime.beginCloseHooks();
      providerConnection.disconnect();
      await runtime.cancelAll();
      await mainRuntime.endSessionHooks();
    },
    cancelVoice: async () => { await voiceRuntime?.cancelAll(); },
    flushBrowser: () => userBrowser.flush(),
    drainStore: async () => { await store.getSettings(); },
    closeOnboardingBrowser: () => browser.close(),
    destroyBrowser: () => userBrowser.destroy(),
    allowClose: () => {
      allowClose = true;
      allowAppQuit = true;
      tray?.destroy();
      tray = null;
    },
    closeWindow: () => {
      const closingWindow = mainWindow;
      setImmediate(() => {
        if (closingWindow && mainWindow === closingWindow && !closingWindow.isDestroyed()) closingWindow.close();
      });
    },
  });

  handle('projects:list', () => store.listProjects());
  handle('projects:pick-folder', async () => {
    const folder = await chooseDirectory(app.getPath('documents'));
    return folder ? requireProjectDirectory(folder) : null;
  });
  handle('projects:create', async (name, folderInput) => withLocalFailureNotification(store, async () => {
    const selected = folderInput === null || folderInput === undefined ? null : await requireProjectDirectory(folderInput);
    const createdFolder = selected ? null : await createNumberedProjectFolder(await requireDirectory(app.getPath('documents')));
    try { return await store.createProject(name, selected ?? createdFolder); }
    catch (error) {
      if (createdFolder) await removeEmptyCreatedFolder(createdFolder);
      throw error;
    }
  }));
  handle('projects:update', async (id, patch) => {
    if (isRecord(patch) && Object.prototype.hasOwnProperty.call(patch, 'workingFolder') && patch.workingFolder !== null) {
      await requireProjectDirectory(patch.workingFolder);
    }
    return withLocalFailureNotification(store, () => store.updateProject(id, patch));
  });
  handle('projects:delete', (id) => withLocalFailureNotification(store, () => store.deleteProject(id)));
  handle('projects:choose-folder', async (idInput) => {
    const id = requireId(idInput);
    const project = (await store.listProjects()).find((item) => item.id === id);
    if (!project) throw new Error('Проект не найден.');
    const selected = await chooseDirectory(project.workingFolder);
    return selected
      ? withLocalFailureNotification(store, async () => store.updateProject(id, { workingFolder: await requireProjectDirectory(selected) }))
      : { project, warning: null };
  });
  handle('projects:open-folder', async (idInput) => {
    const project = (await store.listProjects()).find((item) => item.id === requireId(idInput));
    if (!project?.workingFolder) throw new Error('Для проекта не выбрана рабочая папка.');
    const settings = await store.getSettings();
    await openDirectory(project.workingFolder, settings.preferredOpener);
  });
  handle('projects:read-instructions', (id) => store.readProjectInstructionDocument(requireId(id)));
  handle('projects:save-instructions', (id, contents, expectedRevision) =>
    withLocalFailureNotification(store, () => store.saveProjectInstructions(requireId(id), contents, expectedRevision)));
  handle('projects:save-instructions-copy', (id, contents) =>
    withLocalFailureNotification(store, () => store.saveProjectInstructionsCopy(requireId(id), contents)));
  handle('projects:instructions-backup-path', (id) => store.projectInstructionsBackupPath(requireId(id)));

  handle('chats:list', () => store.listChats());
  handle('chats:get', (id) => store.getChat(id));
  handle('chats:create', (projectId, kind) => withLocalFailureNotification(store, () => store.createChat(projectId, kind)));
  handle('chats:update', async (idInput, patchInput) => {
    const id = requireId(idInput);
    const patch = requireChatPatch(patchInput);
    const existing = await store.getChat(id);
    const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
    if (patch.projectId !== undefined && patch.nextTurnSkillId === undefined && existing.nextTurnSkillId) {
      const projectSkill = /^project\/([^/]+)\//.exec(existing.nextTurnSkillId);
      if (projectSkill && projectSkill[1] !== nextProjectId) patch.nextTurnSkillId = null;
    }
    if (patch.nextTurnSkillId) {
      const selectedSkill = await skills.getEnabled(patch.nextTurnSkillId);
      if (!selectedSkill) throw new Error('Skill удалён или выключен; его нельзя выбрать для следующего хода.');
      if (selectedSkill.scope === 'project' && selectedSkill.projectId !== nextProjectId) {
        throw new Error('Выберите Skill из Global или текущего проекта.');
      }
    }
    return withLocalFailureNotification(store, () => store.updateChat(id, patch));
  });
  handle('chats:append-local-message', async (id, text) => {
    const accepted = await withLocalFailureNotification(store, () => store.acceptLocalMessage(id, text, randomUUID()));
    try {
      if (!runtime.enqueue(accepted.turn)) store.releaseTurnReservation(accepted.turn.turnId);
      return accepted.detail;
    } catch (error) {
      store.releaseTurnReservation(accepted.turn.turnId);
      throw error;
    }
  });
  handle('chats:import-file', async (id, projectId) => {
    const options = { properties: ['openFile'] as Array<'openFile'> };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return withLocalFailureNotification(store, () => store.importFile(id, selected.filePaths[0], projectId));
  });
  handle('chats:open-artifact', async (id, artifactId) => {
    const path = await store.getArtifactPath(id, artifactId);
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error('Копия файла не найдена.');
    const error = await shell.openPath(path);
    if (error) throw new Error(`Не удалось открыть файл: ${error}`);
  });
  handle('chats:open-folder', async (id) => {
    const settings = await store.getSettings();
    await openDirectory(await store.getChatFolder(id), settings.preferredOpener);
  });
  handle('chats:delete', (id) => withLocalFailureNotification(store, () => store.deleteChat(id)));

  handle('runtime:list', async (chatIdInput) => {
    const chatId = requireId(chatIdInput);
    await store.getChat(chatId);
    return runtime.list(chatId);
  });
  handle('runtime:cancel', async (chatIdInput, turnIdInput) => {
    const chatId = requireId(chatIdInput);
    await store.getChat(chatId);
    return runtime.cancel(requireId(turnIdInput), chatId);
  });
  handle('runtime:retry', async (chatIdInput, turnIdInput) => {
    const chatId = requireId(chatIdInput);
    const turnId = requireId(turnIdInput);
    await store.getChat(chatId);
    return runtime.retry(turnId, chatId);
  });
  handle('runtime:status', () => ({
    ...availability,
    providerConfigured: providerConnection.getConnectionStatus().state === 'connected',
  }));
  handle('permissions:read-config', async () => {
    const contents = await customPermissions.read();
    try { parseCustomConfig(contents); return { contents, error: null }; }
    catch (error) { return { contents, error: error instanceof Error ? error.message : 'Неверный config.toml.' }; }
  });
  handle('permissions:save-config', (contents, expected) => {
    if (typeof contents !== 'string' || typeof expected !== 'string') throw new Error('Некорректный текст config.toml.');
    return customPermissions.save(contents, expected);
  });
  handle('permissions:respond', (id, allowed) => approvals.respond(id, allowed));

  handle('voice:status', () => voiceAvailability);
  let accessPrompt: Promise<boolean> | null = null;
  handle('voice:request-access', () => {
    if (accessPrompt) return accessPrompt;
    accessPrompt = (async () => {
      if (process.platform === 'win32') {
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status === 'denied' || status === 'restricted') {
          throw new Error('Windows запрещает доступ настольных приложений к микрофону. Приложение не может изменить этот общий запрет.');
        }
      }
      const settings = await store.getSettings();
      if (settings.microphoneConsent === 'allowed') return true;
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Окно запроса доступа к микрофону недоступно.');
      const decision = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: 'Доступ к микрофону',
        message: 'Разрешить GigaChat Agents использовать микрофон?',
        detail: 'Голос распознаётся локально. Запись не отправляется автоматически.',
        buttons: ['Разрешить', 'Не сейчас'], defaultId: 1, cancelId: 1, noLink: true,
      });
      const allowed = decision.response === 0;
      await store.updateSettings({ microphoneConsent: allowed ? 'allowed' : 'declined' });
      microphoneConsentGranted = allowed;
      return allowed;
    })().finally(() => { accessPrompt = null; });
    return accessPrompt;
  });
  handle('voice:transcribe', (requestId, audio, mediaType) => {
    if (!voiceRuntime) throw new Error(voiceAvailability.reason ?? 'Локальная диктовка недоступна.');
    return withLocalFailureNotification(
      store,
      () => voiceRuntime.transcribe(requestId as string, audio as Uint8Array, mediaType as string),
      (error) => !(error instanceof Error && error.message === 'Распознавание отменено.'),
    );
  }, { track: false });
  handle('voice:cancel', (requestId) => voiceRuntime?.cancel(requestId as string) ?? false);

  handle('skills:list', () => skills.list());
  handle('skills:read-source', (id) => skills.readSource(id));
  handle('skills:set-enabled', (id, enabled) => withLocalFailureNotification(store, () => skills.setEnabled(id, enabled)));
  handle('skills:open-folder', async (scope, projectId) => {
    const folder = await skills.openFolder(scope, projectId);
    const error = await shell.openPath(folder);
    if (error) throw new Error('Не удалось открыть папку Skills приложения.');
  });
  handle('hooks:list', () => hooks.list());
  handle('hooks:inspect', (id) => hooks.inspect(id));
  handle('hooks:trust', (id, expectedHash) => withLocalFailureNotification(store, () => hooks.trust(id, expectedHash)));
  handle('hooks:set-enabled', (id, enabled) => withLocalFailureNotification(store, () => hooks.setEnabled(id, enabled)));

  handle('onboarding:key-status', () => secureStore.status());
  handle('onboarding:key-save', async (key) => {
    providerConnection.invalidateSavedKey();
    await runtime.cancelAll();
    await secureStore.save(key);
    return secureStore.status();
  });
  handle('onboarding:connection-status', () => providerConnection.getConnectionStatus());
  handle('onboarding:connect', () => providerConnection.connect(), { track: false });
  handle('onboarding:connect-cancel', () => providerConnection.cancelConnect());
  handle('onboarding:disconnect', async () => {
    const status = providerConnection.disconnect();
    await runtime.cancelAll();
    return status;
  });
  handle('models:get-registry', () => providerConnection.getModelRegistry());
  handle('models:refresh', () => refreshModelRegistry(), { track: false });
  handle('onboarding:browser-status', () => browser.getStatus());
  handle('onboarding:browser-open', () => browser.openStudio());
  handle('onboarding:browser-close', () => browser.close());
  handle('onboarding:browser-bounds', (bounds) => browser.setBounds(bounds === null ? null : requireBrowserBounds(bounds)));
  handle('onboarding:browser-back', () => browser.back());
  handle('onboarding:browser-reload', () => browser.reload());
  browser.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('onboarding:browser-status', status);
  });

  handle('browser:status', () => userBrowser.getStatus());
  handle('browser:new-tab', () => userBrowser.newTab());
  handle('browser:close-tab', (id) => userBrowser.closeTab(requireId(id)));
  handle('browser:activate-tab', (id) => userBrowser.activateTab(requireId(id)));
  handle('browser:navigate', (input) => userBrowser.navigate(requireText(input, 'Адрес или запрос', 4096)));
  handle('browser:back', () => userBrowser.back());
  handle('browser:forward', () => userBrowser.forward());
  handle('browser:reload', () => userBrowser.reload());
  handle('browser:bounds', (bounds) => userBrowser.setBounds(bounds === null ? null : requireBrowserBounds(bounds)));
  userBrowser.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:status', status);
  });

  handle('settings:get', () => store.getSettings());
  handle('usage:local-stats', () => store.getLocalUsageStats());
  handle('usage:get-ledger', () => store.getUsageLedger());
  handle('settings:update', async (patchInput) => {
    const patch = requireSettingsPatch(patchInput);
    if (patch.preferredOpener !== undefined) requirePreferredOpener(patch.preferredOpener);
    if (patch.defaultProjectsFolder !== undefined && patch.defaultProjectsFolder !== null) {
      await requireDirectory(patch.defaultProjectsFolder);
    }
    if (patch.preferredOpener === 'detected-app' && !(await vscodeOpener.detect())) {
      throw new Error('Сначала установите Visual Studio Code.');
    }
    const settings = await withLocalFailureNotification(store, () => store.updateSettings(patch));
    currentTheme = settings.theme;
    syncTitleBarOverlay();
    return settings;
  });
  handle('settings:delete-app-data', async () => {
    const initialPath = await resolveAppOwnedUserDataPath();
    const options = {
      type: 'warning' as const,
      title: 'Удалить локальные данные?',
      message: 'Это действие нельзя отменить.',
      detail: 'Будут удалены чаты, копии вложений, проекты, настройки, Skills/Hooks, временные файлы и сохранённый ключ. Рабочие папки проектов и исходные файлы не затрагиваются.',
      buttons: ['Отмена', 'Удалить данные'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 1) return false;

    providerConnection.disconnect();
    await runtime.cancelAll();
    await voiceRuntime?.cancelAll();
    await browser.close();
    await store.getSettings();
    const userDataPath = await resolveAppOwnedUserDataPath();
    if (!pathsMatch(initialPath, userDataPath)) throw new Error('Удаление остановлено: путь локальных данных изменился.');

    const helperPath = resolvePowerShellHelperPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
    if (!helperPath || !(await lstat(helperPath).then((info) => info.isFile() && !info.isSymbolicLink()).catch(() => false))) {
      throw new Error('Безопасное удаление после закрытия приложения недоступно. Локальные данные не изменены.');
    }
    await launchAppDataDeletionHelper(helperPath, userDataPath);
    deletingAppData = true;
    allowClose = true;
    mainWindow?.destroy();
    app.exit(0);
    return true;
  });
  ipcMain.handle('app:close-ready', (event, discardBrowserMetadata) => {
    assertTrustedSender(event);
    if (discardBrowserMetadata !== undefined && typeof discardBrowserMetadata !== 'boolean') {
      throw new Error('Некорректный параметр закрытия.');
    }
    if (!closeController) throw new Error('Закрытие приложения ещё не готово.');
    return closeController.close(discardBrowserMetadata === true);
  });
  ipcMain.handle('app:close-return', (event) => {
    assertTrustedSender(event);
    if (!closeController?.resume()) throw new Error('Сейчас нельзя вернуться к работе: закрытие ещё выполняется.');
    trayLifecycle.returnToWork();
    mainRuntime.resumeSessionHooks();
    return true;
  });
  handle('settings:choose-projects-folder', async () => {
    const current = await store.getSettings();
    const selected = await chooseDirectory(current.defaultProjectsFolder);
    return selected ? store.updateSettings({ defaultProjectsFolder: selected }) : current;
  });
  handle('settings:open-projects-folder', async () => {
    const settings = await store.getSettings();
    if (!settings.defaultProjectsFolder) throw new Error('Сначала выберите папку проектов.');
    await openDirectory(settings.defaultProjectsFolder, settings.preferredOpener);
  });
  handle('settings:list-openers', availableOpeners);
  handle('settings:app-info', async () => ({
    version: app.getVersion(),
    dataPath: app.getPath('userData'),
    packaged: app.isPackaged,
    installedLauncherAvailable: Boolean(await getInstalledLauncher()),
    autoStartMigrationIssue,
    platform: process.platform,
  }));
  handle('settings:get-auto-start', async () => {
    const launcher = await getInstalledLauncher();
    return process.platform === 'win32'
      ? readInstalledAutoStart(launcher, loginItemApi())
      : false;
  });
  handle('settings:set-auto-start', async (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Ожидается логическое значение автозапуска.');
    if (process.platform !== 'win32') {
      throw new Error('Автозапуск доступен только в установленной Windows-версии приложения.');
    }
    const saved = writeInstalledAutoStart(enabled, await getInstalledLauncher(), loginItemApi());
    autoStartMigrationIssue = null;
    return saved;
  });
  handle('settings:read-instructions', () => store.readGlobalInstructionDocument());
  handle('settings:save-instructions', (contents, expectedRevision) =>
    withLocalFailureNotification(store, () => store.saveGlobalInstructions(contents, expectedRevision)));
  handle('settings:save-instructions-copy', (contents) =>
    withLocalFailureNotification(store, () => store.saveGlobalInstructionsCopy(contents)));
}

const createWindow = (): void => {
  const entryUrl = new URL(MAIN_WINDOW_WEBPACK_ENTRY);
  const { width: displayWidth, height: displayHeight } = screen.getPrimaryDisplay().workAreaSize;
  const icon = join(app.isPackaged ? process.resourcesPath : app.getAppPath(),
    app.isPackaged ? 'gigachat-icon.ico' : 'src/assets/gigachat-icon.ico');
  const initialZoomFactor = 0.8;
  trayLifecycle.windowCreated();
  allowClose = false;
  allowAppQuit = false;
  closeController?.reopen();
  const window = new BrowserWindow({
    height: Math.min(720, displayHeight),
    minHeight: Math.min(480, displayHeight),
    minWidth: Math.min(560, displayWidth),
    icon,
    show: false,
    title: 'GigaChat Agents',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? {}
      : { titleBarOverlay: { ...titleBarColors(), height: 42 } }),
    width: Math.min(960, displayWidth),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      zoomFactor: initialZoomFactor,
    },
  });
  mainWindow = window;
  syncTitleBarOverlay();

  const zoomSteps = [0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    let factor: number | undefined;
    if (input.key === '0' || input.code === 'Numpad0') factor = 1;
    else if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') {
      factor = zoomSteps.find((step) => step > window.webContents.getZoomFactor() + 0.001);
    } else if (input.key === '-' || input.code === 'NumpadSubtract') {
      factor = zoomSteps.slice().reverse().find((step) => step < window.webContents.getZoomFactor() - 0.001);
    }
    if (factor === undefined) return;
    event.preventDefault();
    window.webContents.setZoomFactor(factor);
  });

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== entryUrl.href) event.preventDefault();
  });
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) trayLifecycle.mainFrameNavigating();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.once('did-finish-load', () => window.webContents.setZoomFactor(initialZoomFactor));
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (allowClose || window.webContents.isDestroyed()) return;
    const decision = trayLifecycle.windowClose(Boolean(tray));
    event.preventDefault();
    if (decision === 'hide') {
      window.hide();
      return;
    }
    if (decision === 'close') window.webContents.send('app:close-requested');
  });
  window.on('closed', () => {
    trayLifecycle.windowDestroyed();
    approvalBroker?.cancelAll();
    mainWindow = null;
    void onboardingBrowser?.close();
    embeddedBrowser?.destroy();
  });
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

function requestApplicationExit(): void {
  const decision = trayLifecycle.requestExit();
  if (decision === 'already-exiting') {
    focusMainWindow();
    return;
  }
  focusMainWindow();
  if (decision === 'close') mainWindow?.close();
}

function createTray(): void {
  if (process.platform !== 'win32') return;
  let applicationTray: Tray | null = null;
  try {
    const icon = join(app.isPackaged ? process.resourcesPath : app.getAppPath(),
      app.isPackaged ? 'gigachat-icon.ico' : 'src/assets/gigachat-icon.ico');
    applicationTray = new Tray(icon);
    applicationTray.setToolTip('GigaChat Agents');
    applicationTray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть приложение', click: focusMainWindow },
      { type: 'separator' },
      { label: 'Выход', click: requestApplicationExit },
    ]));
    applicationTray.on('click', focusMainWindow);
    applicationTray.on('double-click', focusMainWindow);
    tray = applicationTray;
  } catch (error) {
    applicationTray?.destroy();
    tray = null;
    dialog.showErrorBox('Значок приложения недоступен', error instanceof Error ? error.message : 'Не удалось создать значок в области уведомлений.');
  }
}

function configureMainAudioPermission(): void {
  const mainSession = session.defaultSession;
  const isAllowedMainAudio = (webContents: Electron.WebContents | null, origin: string, requestingUrl: string | undefined): boolean => {
    if (!microphoneConsentGranted || !mainWindow || webContents !== mainWindow.webContents) return false;
    try {
      const current = new URL(webContents.getURL());
      if (requestingUrl) return new URL(requestingUrl).href === current.href;
      return current.protocol === 'file:' ? origin === 'file://' : origin === current.origin;
    } catch {
      return false;
    }
  };
  mainSession.setPermissionCheckHandler((webContents, permission, origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && isAllowedMainAudio(webContents, origin, details.requestingUrl));
  mainSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const media = details as MediaAccessPermissionRequest;
    const onlyAudio = media.mediaTypes?.length === 1 && media.mediaTypes[0] === 'audio';
    let origin = media.securityOrigin ?? '';
    if (!origin) {
      try {
        const requestUrl = new URL(media.requestingUrl);
        origin = requestUrl.protocol === 'file:' ? 'file://' : requestUrl.origin;
      } catch { /* malformed request URLs are denied */ }
    }
    callback(permission === 'media' && onlyAudio && isAllowedMainAudio(webContents, origin, media.requestingUrl));
  });
}

if (isPrimaryInstance) void app.whenReady().then(async () => {
  try {
    configureMainAudioPermission();
    const documentsDirectory = app.getPath('documents');
    const userDataDirectory = app.getPath('userData');
    const installedLauncher = await getInstalledLauncher();
    if (installedLauncher) {
      try {
        migrateCurrentVersionAutoStart(installedLauncher, { path: process.execPath, args: [] }, loginItemApi());
      } catch {
        autoStartMigrationIssue = 'Не удалось подтвердить перенос автозапуска. Проверьте настройку в Windows.';
      }
    }
    const helperPath = resolvePowerShellHelperPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
    const helperCandidate = helperPath ? createPowerShellHelper({
      helperPath,
      recoveryDirectory: join(userDataDirectory, 'local-runtime'),
      instructionRecoveryDirectory: join(userDataDirectory, 'instruction-runtime'),
    }) : undefined;
    const instructionRecoveryIssues: string[] = [];
    let instructionCommitter: ReturnType<typeof createPowerShellHelper>['writeInstruction'];
    if (helperCandidate?.recoverInstructions && helperCandidate.writeInstruction) {
      try {
        const conflicts = await helperCandidate.recoverInstructions();
        instructionCommitter = helperCandidate.writeInstruction;
        if (conflicts.length) instructionRecoveryIssues.push(
          `Конфликтующие версии инструкций сохранены и требуют проверки:\n${conflicts.join('\n')}`,
        );
      } catch {
        instructionRecoveryIssues.push('Не удалось проверить журналы записи инструкций; сохранение инструкций временно недоступно. Локальные чаты останутся доступны.');
      }
    }
    const store = await openStore(userDataDirectory, {
      documentsDirectory,
      ...(instructionCommitter ? { instructionCommitter } : {}),
    });
    const projectFolderIssues = await prepareProjectFolders(store, documentsDirectory);
    const storageIssues = await store.getStorageIssues();
    microphoneConsentGranted = (await store.getSettings()).microphoneConsent === 'allowed';
    const customPermissions = await openCustomPermissions(app.getPath('userData'));
    const approvals = createPermissionApprovals((request) => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Окно подтверждения недоступно.');
      mainWindow.webContents.send('permissions:request', request);
    });
    approvalBroker = approvals;
    const secureStore = createSecureStore(app.getPath('userData'), safeStorage);
    onboardingBrowser = createOnboardingBrowser(() => mainWindow, {
      createSession: (partition) => session.fromPartition(partition),
      createView: (options) => new WebContentsView(options),
    });
    const initialSettings = await store.getSettings();
    embeddedBrowser = createEmbeddedBrowser(() => mainWindow, {
      createSession: (partition) => session.fromPartition(partition),
      createView: (options) => new WebContentsView(options),
      persist: (tabs, activeTabId) => store.updateSettings({ browserTabs: tabs, browserActiveTabId: activeTabId }),
    }, initialSettings.browserTabs, initialSettings.browserActiveTabId);
    currentTheme = initialSettings.theme;
    nativeTheme.on('updated', syncTitleBarOverlay);
    const mainRuntime = await createMainRuntime(store, customPermissions, approvals, helperCandidate, secureStore);
    await registerIpcHandlers(store, mainRuntime, secureStore, onboardingBrowser, embeddedBrowser, customPermissions, approvals);
    await mainRuntime.startSessionHooks();
    createMainWindow = createWindow;
    createWindow();
    createTray();
    if (secondInstancePendingFocus) focusMainWindow();
    const startupIssues = [...instructionRecoveryIssues, ...projectFolderIssues, ...storageIssues,
      ...(autoStartMigrationIssue ? [autoStartMigrationIssue] : [])];
    if (startupIssues.length) dialog.showErrorBox('Некоторые локальные данные требуют внимания', startupIssues.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка локальных данных.';
    dialog.showErrorBox('Не удалось загрузить локальные данные', message);
    app.quit();
  }
});

if (isPrimaryInstance) {
  app.on('before-quit', (event) => {
    if (allowAppQuit || deletingAppData) return;
    if (!tray && (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())) {
      allowAppQuit = true;
      return;
    }
    event.preventDefault();
    requestApplicationExit();
  });

  app.on('window-all-closed', () => {
    if (deletingAppData || tray) return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusMainWindow();
  });
}
