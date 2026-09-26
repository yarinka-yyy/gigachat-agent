import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell, type IpcMainInvokeEvent } from 'electron';
import { openStore, type LocalStore } from './store';
import type { FolderOpener, PreferredOpener, SettingsPatch, Theme } from './contracts';

if (require('electron-squirrel-startup')) {
  app.quit();
}

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let currentTheme: Theme = 'emerald';
let allowClose = false;

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
  return value as SettingsPatch;
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

async function registerIpcHandlers(store: LocalStore): Promise<void> {
  const handle = (channel: string, callback: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedSender(event);
      return callback(...args);
    });
  };

  handle('projects:list', () => store.listProjects());
  handle('projects:create', (name) => store.createProject(name));
  handle('projects:update', async (id, patch) => {
    if (isRecord(patch) && Object.prototype.hasOwnProperty.call(patch, 'workingFolder') && patch.workingFolder !== null) {
      await requireDirectory(patch.workingFolder);
    }
    return store.updateProject(id, patch);
  });
  handle('projects:delete', (id) => store.deleteProject(id));
  handle('projects:choose-folder', async (idInput) => {
    const id = requireId(idInput);
    const project = (await store.listProjects()).find((item) => item.id === id);
    if (!project) throw new Error('Проект не найден.');
    const selected = await chooseDirectory(project.workingFolder);
    return selected ? store.updateProject(id, { workingFolder: selected }) : project;
  });
  handle('projects:open-folder', async (idInput) => {
    const project = (await store.listProjects()).find((item) => item.id === requireId(idInput));
    if (!project?.workingFolder) throw new Error('Для проекта не выбрана рабочая папка.');
    const settings = await store.getSettings();
    await openDirectory(project.workingFolder, settings.preferredOpener);
  });
  handle('projects:read-instructions', (id) => store.readProjectInstructions(requireId(id)));
  handle('projects:save-instructions', (id, contents) => store.saveProjectInstructions(requireId(id), contents));

  handle('chats:list', () => store.listChats());
  handle('chats:get', (id) => store.getChat(id));
  handle('chats:create', (projectId, kind) => store.createChat(projectId, kind));
  handle('chats:update', (id, patch) => store.updateChat(id, patch));
  handle('chats:append-local-message', (id, text) => store.appendLocalMessage(id, text));
  handle('chats:import-file', async (id, projectId) => {
    const options = { properties: ['openFile'] as Array<'openFile'> };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return store.importFile(id, selected.filePaths[0], projectId);
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
  handle('chats:delete', (id) => store.deleteChat(id));

  handle('settings:get', () => store.getSettings());
  handle('settings:update', async (patchInput) => {
    const patch = requireSettingsPatch(patchInput);
    if (patch.preferredOpener !== undefined) requirePreferredOpener(patch.preferredOpener);
    if (patch.defaultProjectsFolder !== undefined && patch.defaultProjectsFolder !== null) {
      await requireDirectory(patch.defaultProjectsFolder);
    }
    if (patch.preferredOpener === 'detected-app' && !(await verifiedVscode())) {
      throw new Error('Сначала найдите и проверьте Visual Studio Code.');
    }
    const settings = await store.updateSettings(patch);
    currentTheme = settings.theme;
    syncTitleBarOverlay();
    return settings;
  });
  handle('app:close-ready', () => {
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
  handle('settings:save-instructions', (contents) => store.saveGlobalInstructions(contents));
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
    mainWindow = null;
  });
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

void app.whenReady().then(async () => {
  try {
    const store = await openStore(app.getPath('userData'));
    currentTheme = (await store.getSettings()).theme;
    nativeTheme.on('updated', syncTitleBarOverlay);
    await registerIpcHandlers(store);
    createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка локальных данных.';
    dialog.showErrorBox('Не удалось загрузить локальные данные', message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
