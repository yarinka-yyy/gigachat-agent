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

export interface ChatSummary {
  id: string;
  title: string;
  projectId: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  kind: ChatKind;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface ChatArtifact {
  id: string;
  name: string;
  storedName: string;
  size: number;
  createdAt: string;
  messageId: string | null;
}

export interface ChatDetail extends ChatSummary {
  draft: string;
  messages: ChatMessage[];
  artifacts: ChatArtifact[];
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'pinned' | 'archived' | 'workingFolder'>>;
export type ChatPatch = Partial<Pick<ChatDetail, 'title' | 'projectId' | 'pinned' | 'archived' | 'draft'>>;

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
    list(): Promise<ChatSummary[]>;
    get(id: string): Promise<ChatDetail>;
    create(projectId?: string | null, kind?: ChatKind): Promise<ChatSummary>;
    update(id: string, patch: ChatPatch): Promise<ChatSummary>;
    appendLocalMessage(id: string, text: string): Promise<ChatDetail>;
    importFile(id: string | null, projectId?: string | null): Promise<ChatDetail | null>;
    openArtifact(id: string, artifactId: string): Promise<void>;
    openFolder(id: string): Promise<void>;
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
