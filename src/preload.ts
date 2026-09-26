import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppApi,
  AppInfo,
  Chat,
  ChatKind,
  FolderOpener,
  Project,
  Settings,
  SettingsPatch,
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
    list: () => ipcRenderer.invoke('chats:list') as Promise<Chat[]>,
    create: (projectId = null, kind: ChatKind = 'text') =>
      ipcRenderer.invoke('chats:create', projectId, kind) as Promise<Chat>,
    update: (id, patch) => ipcRenderer.invoke('chats:update', id, patch) as Promise<Chat>,
    remove: (id) => ipcRenderer.invoke('chats:delete', id) as Promise<void>,
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
