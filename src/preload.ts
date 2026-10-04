import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppApi,
  AppInfo,
  CloseFailure,
  CloseAttemptResult,
  LocalUsageStats,
  BrowserBounds,
  EmbeddedBrowserStatus,
  ChatDetail,
  ChatSummary,
  ChatKind,
  FolderOpener,
  HookRegistrySnapshot,
  Project,
  ProjectUpdateResult,
  RuntimeAvailability,
  RuntimeTurnSnapshot,
  PermissionApprovalRequest,
  OnboardingBrowserStatus,
  SecureStoreStatus,
  SkillRegistrySnapshot,
  SkillScope,
  SkillSource,
  Settings,
  SettingsPatch,
  VoiceAvailability,
} from './contracts';

let closeFlush: (() => Promise<void>) | null = null;
let closeFailureHandler: ((result: CloseFailure) => void) | null = null;
let closeAttempt: Promise<CloseAttemptResult> | null = null;

const runCloseAttempt = (discardBrowserMetadata = false): Promise<CloseAttemptResult> => {
  if (closeAttempt) return closeAttempt;
  const attempt = (async (): Promise<CloseAttemptResult> => {
    try {
      if (!closeFlush) throw new Error('Сохранение данных перед закрытием недоступно.');
      await closeFlush();
      const result = await ipcRenderer.invoke('app:close-ready', discardBrowserMetadata) as CloseAttemptResult;
      if (result.status === 'failed') closeFailureHandler?.(result);
      return result;
    } catch (error) {
      const result: CloseAttemptResult = {
        status: 'failed',
        reason: 'close',
        message: error instanceof Error ? error.message : 'Не удалось сохранить данные перед закрытием.',
      };
      closeFailureHandler?.(result);
      return result;
    }
  })();
  const wrapped = attempt.finally(() => { if (closeAttempt === wrapped) closeAttempt = null; });
  closeAttempt = wrapped;
  return wrapped;
};

const api: AppApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list') as Promise<Project[]>,
    create: (name, workingFolder = null) => ipcRenderer.invoke('projects:create', name, workingFolder) as Promise<Project>,
    pickFolder: () => ipcRenderer.invoke('projects:pick-folder') as Promise<string | null>,
    instructionsBackupPath: (id) => ipcRenderer.invoke('projects:instructions-backup-path', id) as Promise<string | null>,
    update: (id, patch) => ipcRenderer.invoke('projects:update', id, patch) as Promise<ProjectUpdateResult>,
    remove: (id) => ipcRenderer.invoke('projects:delete', id) as Promise<void>,
    chooseFolder: (id) => ipcRenderer.invoke('projects:choose-folder', id) as Promise<ProjectUpdateResult>,
    openFolder: (id) => ipcRenderer.invoke('projects:open-folder', id) as Promise<void>,
    readInstructions: (id) => ipcRenderer.invoke('projects:read-instructions', id) as ReturnType<AppApi['projects']['readInstructions']>,
    saveInstructions: (id, contents, expectedRevision) => ipcRenderer.invoke('projects:save-instructions', id, contents, expectedRevision) as ReturnType<AppApi['projects']['saveInstructions']>,
    saveInstructionsCopy: (id, contents) => ipcRenderer.invoke('projects:save-instructions-copy', id, contents) as ReturnType<AppApi['projects']['saveInstructionsCopy']>,
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list') as Promise<ChatSummary[]>,
    get: (id) => ipcRenderer.invoke('chats:get', id) as Promise<ChatDetail>,
    create: (projectId = null, kind: ChatKind = 'text') =>
      ipcRenderer.invoke('chats:create', projectId, kind) as Promise<ChatSummary>,
    update: (id, patch) => ipcRenderer.invoke('chats:update', id, patch) as Promise<ChatSummary>,
    appendLocalMessage: (id, text) => ipcRenderer.invoke('chats:append-local-message', id, text) as Promise<ChatDetail>,
    importFile: (id, projectId) => ipcRenderer.invoke('chats:import-file', id, projectId) as Promise<ChatDetail | null>,
    openArtifact: (id, artifactId) => ipcRenderer.invoke('chats:open-artifact', id, artifactId) as Promise<void>,
    openFolder: (id) => ipcRenderer.invoke('chats:open-folder', id) as Promise<void>,
    remove: (id) => ipcRenderer.invoke('chats:delete', id) as Promise<void>,
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke('runtime:status') as Promise<RuntimeAvailability>,
    list: (chatId) => ipcRenderer.invoke('runtime:list', chatId) as Promise<RuntimeTurnSnapshot[]>,
    cancel: (chatId, turnId) => ipcRenderer.invoke('runtime:cancel', chatId, turnId) as Promise<boolean>,
    onUpdate: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, turn: RuntimeTurnSnapshot): void => listener(turn);
      ipcRenderer.on('runtime:update', handler);
      return () => ipcRenderer.removeListener('runtime:update', handler);
    },
  },
  permissions: {
    readConfig: () => ipcRenderer.invoke('permissions:read-config') as Promise<{ contents: string; error: string | null }>,
    saveConfig: (contents, expectedContents) => ipcRenderer.invoke('permissions:save-config', contents, expectedContents) as Promise<string>,
    respond: (id, allowed) => ipcRenderer.invoke('permissions:respond', id, allowed) as Promise<boolean>,
    onRequest: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, request: PermissionApprovalRequest): void => listener(request);
      ipcRenderer.on('permissions:request', handler);
      return () => ipcRenderer.removeListener('permissions:request', handler);
    },
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list') as Promise<SkillRegistrySnapshot>,
    readSource: (id) => ipcRenderer.invoke('skills:read-source', id) as Promise<SkillSource>,
    setEnabled: (id, enabled) => ipcRenderer.invoke('skills:set-enabled', id, enabled) as Promise<SkillRegistrySnapshot>,
    openFolder: (scope: SkillScope, projectId = null) => ipcRenderer.invoke('skills:open-folder', scope, projectId) as Promise<void>,
  },
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list') as Promise<HookRegistrySnapshot>,
  },
  onboarding: {
    getKeyStatus: () => ipcRenderer.invoke('onboarding:key-status') as Promise<SecureStoreStatus>,
    saveKey: (key) => ipcRenderer.invoke('onboarding:key-save', key) as Promise<SecureStoreStatus>,
    getBrowserStatus: () => ipcRenderer.invoke('onboarding:browser-status') as Promise<OnboardingBrowserStatus>,
    openStudio: () => ipcRenderer.invoke('onboarding:browser-open') as Promise<OnboardingBrowserStatus>,
    closeBrowser: () => ipcRenderer.invoke('onboarding:browser-close') as Promise<void>,
    setBrowserBounds: (bounds: BrowserBounds | null) => ipcRenderer.invoke('onboarding:browser-bounds', bounds) as Promise<void>,
    back: () => ipcRenderer.invoke('onboarding:browser-back') as Promise<void>,
    reload: () => ipcRenderer.invoke('onboarding:browser-reload') as Promise<void>,
    onBrowserStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: OnboardingBrowserStatus): void => listener(status);
      ipcRenderer.on('onboarding:browser-status', handler);
      return () => ipcRenderer.removeListener('onboarding:browser-status', handler);
    },
  },
  browser: {
    getStatus: () => ipcRenderer.invoke('browser:status') as Promise<EmbeddedBrowserStatus>,
    newTab: () => ipcRenderer.invoke('browser:new-tab') as Promise<EmbeddedBrowserStatus>,
    closeTab: (id) => ipcRenderer.invoke('browser:close-tab', id) as Promise<EmbeddedBrowserStatus>,
    activateTab: (id) => ipcRenderer.invoke('browser:activate-tab', id) as Promise<EmbeddedBrowserStatus>,
    navigate: (input) => ipcRenderer.invoke('browser:navigate', input) as Promise<EmbeddedBrowserStatus>,
    back: () => ipcRenderer.invoke('browser:back') as Promise<void>,
    forward: () => ipcRenderer.invoke('browser:forward') as Promise<void>,
    reload: () => ipcRenderer.invoke('browser:reload') as Promise<void>,
    setBounds: (bounds: BrowserBounds | null) => ipcRenderer.invoke('browser:bounds', bounds) as Promise<void>,
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: EmbeddedBrowserStatus): void => listener(status);
      ipcRenderer.on('browser:status', handler);
      return () => ipcRenderer.removeListener('browser:status', handler);
    },
  },
  voice: {
    getStatus: () => ipcRenderer.invoke('voice:status') as Promise<VoiceAvailability>,
    requestAccess: () => ipcRenderer.invoke('voice:request-access') as Promise<boolean>,
    transcribe: (requestId: string, audio: Uint8Array, mediaType: string) =>
      ipcRenderer.invoke('voice:transcribe', requestId, audio, mediaType) as Promise<string>,
    cancel: (requestId: string) => ipcRenderer.invoke('voice:cancel', requestId) as Promise<boolean>,
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
    update: (patch: SettingsPatch) => ipcRenderer.invoke('settings:update', patch) as Promise<Settings>,
    chooseProjectsFolder: () => ipcRenderer.invoke('settings:choose-projects-folder') as Promise<Settings>,
    openProjectsFolder: () => ipcRenderer.invoke('settings:open-projects-folder') as Promise<void>,
    listOpeners: () => ipcRenderer.invoke('settings:list-openers') as Promise<FolderOpener[]>,
    getAppInfo: () => ipcRenderer.invoke('settings:app-info') as Promise<AppInfo>,
    getAutoStart: () => ipcRenderer.invoke('settings:get-auto-start') as Promise<boolean>,
    setAutoStart: (enabled) => ipcRenderer.invoke('settings:set-auto-start', enabled) as Promise<boolean>,
    readInstructions: () => ipcRenderer.invoke('settings:read-instructions') as ReturnType<AppApi['settings']['readInstructions']>,
    saveInstructions: (contents, expectedRevision) => ipcRenderer.invoke('settings:save-instructions', contents, expectedRevision) as ReturnType<AppApi['settings']['saveInstructions']>,
    saveInstructionsCopy: (contents) => ipcRenderer.invoke('settings:save-instructions-copy', contents) as ReturnType<AppApi['settings']['saveInstructionsCopy']>,
    deleteAppData: () => ipcRenderer.invoke('settings:delete-app-data') as Promise<boolean>,
  },
  usage: {
    getLocalStats: () => ipcRenderer.invoke('usage:local-stats') as Promise<LocalUsageStats>,
  },
  onCloseRequested: (flush, onFailure) => {
    closeFlush = flush;
    closeFailureHandler = onFailure;
    const listener = (): void => {
      void runCloseAttempt(false);
    };
    ipcRenderer.on('app:close-requested', listener);
    return () => {
      ipcRenderer.removeListener('app:close-requested', listener);
      if (closeFlush === flush) {
        closeFlush = null;
        closeFailureHandler = null;
      }
    };
  },
  retryClose: (discardBrowserMetadata = false) => runCloseAttempt(discardBrowserMetadata),
  returnFromClose: async () => { await ipcRenderer.invoke('app:close-return'); },
};

contextBridge.exposeInMainWorld('gigaChat', api);
