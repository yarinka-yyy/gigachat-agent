import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, screen, session, shell, systemPreferences, WebContentsView, type IpcMainInvokeEvent, type MediaAccessPermissionRequest } from 'electron';
import { openStore, type LocalStore } from './store';
import { buildInstructionRequest } from './instructions';
import { createLocalTools, createPowerShellHelper, resolvePowerShellHelperPath, type LocalTools } from './local-tools';
import { createTurnRuntime, type TurnRuntime } from './runtime';
import type { ChatPatch, FolderOpener, NotificationSettings, PreferredOpener, RuntimeAvailability, SettingsPatch, Theme, VoiceAvailability } from './contracts';
import { requirePermissionProfile } from './permissions';
import { requireModelId } from './models';
import { openCustomPermissions, parseCustomConfig } from './custom-permissions';
import { createPermissionApprovals } from './permission-approvals';
import { createSkillRegistry, isSkillId } from './skills';
import { createHookRegistry } from './hooks';
import { createSecureStore } from './secure-store';
import { createOnboardingBrowser, type BrowserBounds } from './onboarding-browser';
import { createVoiceRuntime, VOICE_MAX_OUTPUT_BYTES, type VoiceRuntime } from './voice';

if (require('electron-squirrel-startup')) {
  app.quit();
}

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let onboardingBrowser: ReturnType<typeof createOnboardingBrowser> | null = null;
let currentTheme: Theme = 'emerald';
let allowClose = false;
let deletingAppData = false;
let approvalBroker: ReturnType<typeof createPermissionApprovals> | null = null;
let microphoneConsentGranted = false;

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
  const allowedFields = ['theme', 'sidebarTransparent', 'sidebarVisible', 'defaultProjectsFolder', 'preferredOpener', 'defaultPermissionProfile', 'defaultModelId', 'onboardingCompleted', 'notifications'];
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

async function verifiedVscode(): Promise<string | null> {
  for (const candidate of getVscodeCandidates()) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await new Promise<void>((resolve, reject) => {
        execFile(candidate, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 2048 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function availableOpeners(): Promise<FolderOpener[]> {
  const openers: FolderOpener[] = [
    { id: 'system', name: 'Приложение Windows по умолчанию' },
    { id: 'explorer', name: 'Проводник Windows' },
  ];
  if (await verifiedVscode()) openers.push({ id: 'vscode', name: 'Visual Studio Code' });
  return openers;
}

function launchDetached(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
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
  const executable = await verifiedVscode();
  if (!executable) throw new Error('Visual Studio Code не найден или не прошёл проверку запуска.');
  await launchDetached(executable, [path]);
}

function requirePreferredOpener(value: unknown): PreferredOpener {
  if (value === 'system' || value === 'explorer' || value === 'detected-app') return value;
  throw new Error('Неизвестная программа для открытия папки.');
}

interface MainRuntimeBundle {
  runtime: TurnRuntime;
  availability: RuntimeAvailability;
  voiceRuntime: VoiceRuntime | null;
  voiceAvailability: VoiceAvailability;
  skills: ReturnType<typeof createSkillRegistry>;
  hooks: ReturnType<typeof createHookRegistry>;
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
    const cacheDirectory = join(userDataPath, 'voice-cache');
    await mkdir(cacheDirectory, { recursive: true });
    const cacheInfo = await lstat(cacheDirectory);
    if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw new Error('cache directory unavailable');
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
      modelDirectory: voiceDirectory,
      cacheDirectory,
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
      run(executable, args, environment, signal) {
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
): Promise<MainRuntimeBundle> {
  const skills = createSkillRegistry({ userDataPath: app.getPath('userData'), listProjects: () => store.listProjects() });
  const hooks = createHookRegistry({
    userDataPath: app.getPath('userData'),
    listProjects: () => store.listProjects(),
    listSkills: async () => (await skills.list()).skills,
  });
  const helperPath = resolvePowerShellHelperPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  let helper: ReturnType<typeof createPowerShellHelper> | undefined;
  let unavailableReason: string | null = null;
  if (helperPath) {
    const candidate = createPowerShellHelper({
      helperPath,
      recoveryDirectory: join(app.getPath('userData'), 'local-runtime'),
    });
    try {
      await candidate.recover();
      helper = candidate;
    } catch {
      // A runtime recovery failure disables tools but does not prevent local chats from opening.
      unavailableReason = 'Не удалось восстановить ограниченный локальный runtime.';
    }
  } else unavailableReason = 'Ограниченные локальные инструменты доступны только в Windows-сборке.';

  const voiceService = await createVoiceService(app.getPath('userData'));

  let runtime: TurnRuntime | null = null;
  const tools: LocalTools = createLocalTools({
    resolveProject: async (id) => (await store.listProjects()).find((project) => project.id === id) ?? null,
    protectedDirectory: app.getPath('userData'),
    getCustomPolicy: customPermissions.policy,
    requestApproval: approvals.request,
    openPath: async (path) => {
      const error = await shell.openPath(path);
      if (error) throw new Error('Не удалось открыть элемент проекта.');
    },
    ...(helper ? { runPowerShell: helper.run, writeFile: helper.writeFile } : {}),
    onEvent: (event) => {
      runtime?.recordToolEvent(event);
      if (event.phase === 'failed') {
        void showLocalNotification(store, 'failures', 'Локальный инструмент завершился с ошибкой', 'Откройте чат, чтобы проверить состояние.');
      }
    },
  });

  const lastNotifiedStatus = new Map<string, string>();
  const turnRuntime = createTurnRuntime({
    provider: null,
    tools,
    prepareTurn: async (chatId) => {
      const chat = await store.getChat(chatId);
      const settings = await store.getSettings();
      const permissionProfile = chat.nextTurnPermissionProfile ?? settings.defaultPermissionProfile;
      const modelId = chat.modelId ?? settings.defaultModelId;
      const projects = await store.listProjects();
      const project = chat.projectId ? projects.find((item) => item.id === chat.projectId) : null;
      if (chat.projectId && !project) throw new Error('Проект чата больше недоступен.');
      const selectedSkill = chat.nextTurnSkillId ? await skills.getEnabled(chat.nextTurnSkillId) : null;
      if (chat.nextTurnSkillId && !selectedSkill) throw new Error('Выбранный Skill удалён или выключен. Включите его снова либо снимите выбор.');
      if (selectedSkill?.scope === 'project' && selectedSkill.projectId !== chat.projectId) {
        throw new Error('Выбранный Skill принадлежит другому проекту; выбор для этого хода не изменён.');
      }
      const projectInstructions = project
        ? await store.readProjectInstructions(project.id)
        : '';
      const request = buildInstructionRequest({
        globalText: await store.readGlobalInstructions(),
        projectInstructions: project ? [{ scope: project.name, text: projectInstructions }] : [],
        selectedSkill: selectedSkill ? {
          name: selectedSkill.name,
          scope: selectedSkill.scope === 'global' ? 'Global' : `Project · ${selectedSkill.projectName ?? project?.name ?? 'неизвестный проект'}`,
          text: selectedSkill.instructions,
        } : null,
        messages: chat.messages,
        permissionProfile,
        modelId,
      });
      if (chat.nextTurnPermissionProfile !== null || chat.nextTurnSkillId !== null) {
        await store.updateChat(chat.id, { nextTurnPermissionProfile: null, nextTurnSkillId: null });
      }
      return request;
    },
    appendAssistant: async (chatId, text) => {
      await store.appendAssistantMessageFromRuntime(chatId, text);
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
  return {
    runtime: turnRuntime,
    availability: {
      providerConfigured: false,
      helperRecovered: Boolean(helper),
      rendererToolApi: false,
      helperUnavailableReason: unavailableReason,
    },
    voiceRuntime: voiceService.runtime,
    voiceAvailability: voiceService.availability,
    skills,
    hooks,
  };
}

async function registerIpcHandlers(
  store: LocalStore,
  mainRuntime: MainRuntimeBundle,
  secureStore: ReturnType<typeof createSecureStore>,
  browser: ReturnType<typeof createOnboardingBrowser>,
  customPermissions: Awaited<ReturnType<typeof openCustomPermissions>>,
  approvals: ReturnType<typeof createPermissionApprovals>,
): Promise<void> {
  const { runtime, availability, voiceRuntime, voiceAvailability, skills, hooks } = mainRuntime;
  const handle = (channel: string, callback: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedSender(event);
      return callback(...args);
    });
  };

  handle('projects:list', () => store.listProjects());
  handle('projects:create', (name) => withLocalFailureNotification(store, () => store.createProject(name)));
  handle('projects:update', async (id, patch) => {
    if (isRecord(patch) && Object.prototype.hasOwnProperty.call(patch, 'workingFolder') && patch.workingFolder !== null) {
      await requireDirectory(patch.workingFolder);
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
      ? withLocalFailureNotification(store, () => store.updateProject(id, { workingFolder: selected }))
      : project;
  });
  handle('projects:open-folder', async (idInput) => {
    const project = (await store.listProjects()).find((item) => item.id === requireId(idInput));
    if (!project?.workingFolder) throw new Error('Для проекта не выбрана рабочая папка.');
    const settings = await store.getSettings();
    await openDirectory(project.workingFolder, settings.preferredOpener);
  });
  handle('projects:read-instructions', (id) => store.readProjectInstructions(requireId(id)));
  handle('projects:save-instructions', (id, contents) => withLocalFailureNotification(store, () => store.saveProjectInstructions(requireId(id), contents)));

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
    const detail = await withLocalFailureNotification(store, () => store.appendLocalMessage(id, text));
    // No provider is configured in the local profile, so this remains a local-only save.
    runtime.enqueue(detail.id);
    return detail;
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
  handle('runtime:status', () => availability);
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
  });
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

  handle('onboarding:key-status', () => secureStore.status());
  handle('onboarding:key-save', async (key) => {
    await secureStore.save(key);
    return secureStore.status();
  });
  handle('onboarding:browser-status', () => browser.getStatus());
  handle('onboarding:browser-open', () => browser.openStudio());
  handle('onboarding:browser-close', () => browser.close());
  handle('onboarding:browser-bounds', (bounds) => browser.setBounds(requireBrowserBounds(bounds)));
  handle('onboarding:browser-back', () => browser.back());
  handle('onboarding:browser-reload', () => browser.reload());
  browser.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('onboarding:browser-status', status);
  });

  handle('settings:get', () => store.getSettings());
  handle('usage:local-stats', () => store.getLocalUsageStats());
  handle('settings:update', async (patchInput) => {
    const patch = requireSettingsPatch(patchInput);
    if (patch.preferredOpener !== undefined) requirePreferredOpener(patch.preferredOpener);
    if (patch.defaultProjectsFolder !== undefined && patch.defaultProjectsFolder !== null) {
      await requireDirectory(patch.defaultProjectsFolder);
    }
    if (patch.preferredOpener === 'detected-app' && !(await verifiedVscode())) {
      throw new Error('Сначала найдите и проверьте Visual Studio Code.');
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
  handle('app:close-ready', async () => {
    await runtime.cancelAll();
    await voiceRuntime?.cancelAll();
    await browser.close();
    allowClose = true;
    mainWindow?.close();
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
  handle('settings:app-info', () => ({
    version: app.getVersion(),
    dataPath: app.getPath('userData'),
    packaged: app.isPackaged,
    platform: process.platform,
  }));
  handle('settings:get-auto-start', () => process.platform === 'win32' ? app.getLoginItemSettings().openAtLogin : false);
  handle('settings:set-auto-start', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Ожидается логическое значение автозапуска.');
    if (process.platform !== 'win32' || !app.isPackaged) {
      throw new Error('Автозапуск доступен только в установленной Windows-версии приложения.');
    }
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
  handle('settings:read-instructions', () => store.readGlobalInstructions());
  handle('settings:save-instructions', (contents) => withLocalFailureNotification(store, () => store.saveGlobalInstructions(contents)));
}

const createWindow = (): void => {
  const entryUrl = new URL(MAIN_WINDOW_WEBPACK_ENTRY);
  const { width: displayWidth, height: displayHeight } = screen.getPrimaryDisplay().workAreaSize;
  const icon = join(app.isPackaged ? process.resourcesPath : app.getAppPath(),
    app.isPackaged ? 'gigachat-icon.ico' : 'src/assets/gigachat-icon.ico');
  const initialZoomFactor = 0.8;
  allowClose = false;
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
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.once('did-finish-load', () => window.webContents.setZoomFactor(initialZoomFactor));
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (allowClose || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
    event.preventDefault();
    window.webContents.send('app:close-requested');
  });
  window.on('closed', () => {
    approvalBroker?.cancelAll();
    mainWindow = null;
    void onboardingBrowser?.close();
  });
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

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

void app.whenReady().then(async () => {
  try {
    configureMainAudioPermission();
    const store = await openStore(app.getPath('userData'));
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
    currentTheme = (await store.getSettings()).theme;
    nativeTheme.on('updated', syncTitleBarOverlay);
    const mainRuntime = await createMainRuntime(store, customPermissions, approvals);
    await registerIpcHandlers(store, mainRuntime, secureStore, onboardingBrowser, customPermissions, approvals);
    createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка локальных данных.';
    dialog.showErrorBox('Не удалось загрузить локальные данные', message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (deletingAppData) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
