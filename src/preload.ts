import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppApi,
  AppInfo,
  LocalUsageStats,
  BrowserBounds,
  ChatDetail,
  ChatSummary,
  ChatKind,
  FolderOpener,
  HookRegistrySnapshot,
  Project,
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

const api: AppApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list') as Promise<Project[]>,
    create: (name) => ipcRenderer.invoke('projects:create', name) as Promise<Project>,
    update: (id, patch) => ipcRenderer.invoke('projects:update', id, patch) as Promise<Project>,
    remove: (id) => ipcRenderer.invoke('projects:delete', id) as Promise<void>,
    chooseFolder: (id) => ipcRenderer.invoke('projects:choose-folder', id) as Promise<Project>,
    openFolder: (id) => ipcRenderer.invoke('projects:open-folder', id) as Promise<void>,
    readInstructions: (id) => ipcRenderer.invoke('projects:read-instructions', id) as Promise<string>,
    saveInstructions: (id, contents) => ipcRenderer.invoke('projects:save-instructions', id, contents) as Promise<void>,
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
    setBrowserBounds: (bounds: BrowserBounds) => ipcRenderer.invoke('onboarding:browser-bounds', bounds) as Promise<void>,
    back: () => ipcRenderer.invoke('onboarding:browser-back') as Promise<void>,
    reload: () => ipcRenderer.invoke('onboarding:browser-reload') as Promise<void>,
    onBrowserStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: OnboardingBrowserStatus): void => listener(status);
      ipcRenderer.on('onboarding:browser-status', handler);
      return () => ipcRenderer.removeListener('onboarding:browser-status', handler);
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
    readInstructions: () => ipcRenderer.invoke('settings:read-instructions') as Promise<string>,
    saveInstructions: (contents) => ipcRenderer.invoke('settings:save-instructions', contents) as Promise<void>,
    deleteAppData: () => ipcRenderer.invoke('settings:delete-app-data') as Promise<boolean>,
  },
  usage: {
    getLocalStats: () => ipcRenderer.invoke('usage:local-stats') as Promise<LocalUsageStats>,
  },
  onCloseRequested: (flush) => {
    const listener = (): void => {
      void flush().then(() => ipcRenderer.invoke('app:close-ready')).catch(() => undefined);
    };
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
};

contextBridge.exposeInMainWorld('gigaChat', api);
