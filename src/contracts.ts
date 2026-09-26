export type Theme = 'system' | 'emerald' | 'light' | 'dark' | 'warm';
export type ChatKind = 'text' | 'image';
export type PreferredOpener = 'system' | 'explorer' | 'detected-app';

export interface Project {
  id: string;
  name: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  workingFolder: string | null;
}

export interface Chat {
  id: string;
  title: string;
  projectId: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  draft: string;
  kind: ChatKind;
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'pinned' | 'archived' | 'workingFolder'>>;
export type ChatPatch = Partial<Pick<Chat, 'title' | 'projectId' | 'pinned' | 'archived' | 'draft'>>;

export interface Settings {
  theme: Theme;
  sidebarTransparent: boolean;
  sidebarVisible: boolean;
  defaultProjectsFolder: string | null;
  preferredOpener: PreferredOpener;
}

export type SettingsPatch = Partial<Settings>;

export interface FolderOpener {
  id: PreferredOpener | 'vscode';
  name: string;
}

export interface AppInfo {
  version: string;
  dataPath: string;
  packaged: boolean;
  platform: string;
}

export interface AppApi {
  projects: {
    list(): Promise<Project[]>;
    create(name: string): Promise<Project>;
    update(id: string, patch: ProjectPatch): Promise<Project>;
    remove(id: string): Promise<void>;
    chooseFolder(id: string): Promise<Project>;
    openFolder(id: string): Promise<void>;
    readInstructions(id: string): Promise<string>;
    saveInstructions(id: string, contents: string): Promise<void>;
  };
  chats: {
    list(): Promise<Chat[]>;
    create(projectId?: string | null, kind?: ChatKind): Promise<Chat>;
    update(id: string, patch: ChatPatch): Promise<Chat>;
    remove(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<Settings>;
    chooseProjectsFolder(): Promise<Settings>;
    openProjectsFolder(): Promise<void>;
    listOpeners(): Promise<FolderOpener[]>;
    getAppInfo(): Promise<AppInfo>;
    getAutoStart(): Promise<boolean>;
    setAutoStart(enabled: boolean): Promise<boolean>;
    readInstructions(): Promise<string>;
    saveInstructions(contents: string): Promise<void>;
  };
  onCloseRequested(flush: () => Promise<void>): () => void;
}

declare global {
  interface Window {
    gigaChat: AppApi;
  }
}
