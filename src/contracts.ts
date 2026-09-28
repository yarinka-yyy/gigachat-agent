import type { PermissionAction, PermissionProfile, PermissionResource } from './permissions';
import type { GigaChatModelId } from './models';

export type Theme = 'system' | 'emerald' | 'light' | 'dark' | 'warm';
export type ChatKind = 'text' | 'image';
export type PreferredOpener = 'system' | 'explorer' | 'detected-app';

export interface NotificationSettings {
  taskStarted: boolean;
  taskCompleted: boolean;
  failures: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  taskStarted: false,
  taskCompleted: true,
  failures: true,
};

export interface LocalUsageStats {
  chatCount: number;
  projectCount: number;
  activityDayCount: number;
}

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

export type InstructionSource = 'runtime' | 'global' | 'project' | 'skill';

export interface InstructionLayer {
  source: InstructionSource;
  label: string;
  scope?: string;
  text: string;
}

export interface ProviderTurnRequest {
  system: InstructionLayer[];
  messages: ChatMessage[];
  permissionProfile: PermissionProfile;
  modelId: GigaChatModelId | null;
}

export type ProviderToolName = 'list' | 'search' | 'read' | 'write' | 'open' | 'powershell';

export type ProviderEvent =
  | { type: 'activity'; activity: 'connecting' | 'receiving' | 'waiting-for-tool' | 'tool-started' | 'tool-finished'; tool?: ProviderToolName }
  | { type: 'text-delta'; text: string }
  | { type: 'completed'; responseId?: string }
  | { type: 'error'; code: string; retryable: boolean };

export interface GigaChatProvider {
  stream(request: ProviderTurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export type RuntimeTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type RuntimeActivity =
  | { kind: 'provider'; at: string; activity: Extract<ProviderEvent, { type: 'activity' }>['activity']; tool?: ProviderToolName }
  | { kind: 'tool'; at: string; tool: ProviderToolName; phase: 'started' | 'completed' | 'failed' | 'cancelled'; durationMs?: number };

export interface RuntimeTurnSnapshot {
  id: string;
  chatId: string;
  status: RuntimeTurnStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  queueDurationMs?: number;
  activeDurationMs?: number;
  activity: RuntimeActivity[];
  error?: string;
}

export interface RuntimeAvailability {
  providerConfigured: boolean;
  helperRecovered: boolean;
  rendererToolApi: false;
  helperUnavailableReason: string | null;
}

export interface PermissionApprovalRequest {
  id: string;
  resource: PermissionResource;
  action: PermissionAction;
  target: string;
  reason: string;
  expiresAt: string;
}

export interface VoiceAvailability {
  available: boolean;
  reason: string | null;
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
  nextTurnPermissionProfile: PermissionProfile | null;
  modelId: GigaChatModelId | null;
  nextTurnSkillId: string | null;
  messages: ChatMessage[];
  artifacts: ChatArtifact[];
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'pinned' | 'archived' | 'workingFolder'>>;
export type ChatPatch = Partial<Pick<ChatDetail, 'title' | 'projectId' | 'pinned' | 'archived' | 'draft' | 'nextTurnPermissionProfile' | 'nextTurnSkillId' | 'modelId'>>;

export type SkillScope = 'global' | 'project';

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  command: string;
  scope: SkillScope;
  projectId: string | null;
  projectName: string | null;
  source: string;
  enabled: boolean;
}

export interface SkillIssue {
  source: string;
  reason: string;
}

export interface SkillRegistrySnapshot {
  skills: SkillRecord[];
  issues: SkillIssue[];
}

export interface SkillSource {
  id: string;
  name: string;
  source: string;
  contents: string;
}

export type HookEvent =
  | 'session-start' | 'project-start' | 'user-prompt-submitted' | 'before-tool' | 'after-tool'
  | 'permission-request' | 'before-compaction' | 'after-compaction' | 'interrupt' | 'stop' | 'session-end' | 'project-end';

export type HookOrigin = 'global' | 'project' | 'skill' | 'plugin';

export interface HookRecord {
  id: string;
  name: string;
  description: string;
  event: HookEvent;
  origin: HookOrigin;
  scope: string;
  owner: string;
  source: string;
  enabled: false;
  verified: false;
  actionFile: string;
  unavailableReason: string;
}

export interface HookIssue {
  source: string;
  reason: string;
}

export interface HookRegistrySnapshot {
  hooks: HookRecord[];
  issues: HookIssue[];
}

export interface Settings {
  theme: Theme;
  sidebarTransparent: boolean;
  sidebarVisible: boolean;
  sidebarWidthPx: number | null;
  browserPaneOpen: boolean;
  browserWidthPx: number | null;
  browserTabs: BrowserTabRecord[];
  browserActiveTabId: string | null;
  defaultProjectsFolder: string | null;
  preferredOpener: PreferredOpener;
  defaultPermissionProfile: PermissionProfile;
  defaultModelId: GigaChatModelId | null;
  onboardingCompleted: boolean;
  microphoneConsent: 'unasked' | 'allowed' | 'declined';
  notifications: NotificationSettings;
}

export interface BrowserTabRecord {
  id: string;
  title: string;
  url: string;
}

export interface BrowserTabStatus extends BrowserTabRecord {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export interface EmbeddedBrowserStatus {
  tabs: BrowserTabStatus[];
  activeTabId: string | null;
  error: string | null;
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

export interface SecureStoreStatus {
  available: boolean;
  saved: boolean;
  usable: boolean;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OnboardingBrowserStatus {
  open: boolean;
  loading: boolean;
  canGoBack: boolean;
  atStudio: boolean;
  hostname: string | null;
  error: string | null;
}

export interface AppApi {
  projects: {
    list(): Promise<Project[]>;
    create(name: string, workingFolder?: string | null): Promise<Project>;
    pickFolder(): Promise<string | null>;
    instructionsBackupPath(id: string): Promise<string | null>;
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
  runtime: {
    getStatus(): Promise<RuntimeAvailability>;
    list(chatId: string): Promise<RuntimeTurnSnapshot[]>;
    cancel(chatId: string, turnId: string): Promise<boolean>;
    onUpdate(listener: (turn: RuntimeTurnSnapshot) => void): () => void;
  };
  permissions: {
    readConfig(): Promise<{ contents: string; error: string | null }>;
    saveConfig(contents: string, expectedContents: string): Promise<string>;
    respond(id: string, allowed: boolean): Promise<boolean>;
    onRequest(listener: (request: PermissionApprovalRequest) => void): () => void;
  };
  skills: {
    list(): Promise<SkillRegistrySnapshot>;
    readSource(id: string): Promise<SkillSource>;
    setEnabled(id: string, enabled: boolean): Promise<SkillRegistrySnapshot>;
    openFolder(scope: SkillScope, projectId?: string | null): Promise<void>;
  };
  hooks: {
    list(): Promise<HookRegistrySnapshot>;
  };
  onboarding: {
    getKeyStatus(): Promise<SecureStoreStatus>;
    saveKey(key: string): Promise<SecureStoreStatus>;
    getBrowserStatus(): Promise<OnboardingBrowserStatus>;
    openStudio(): Promise<OnboardingBrowserStatus>;
    closeBrowser(): Promise<void>;
    setBrowserBounds(bounds: BrowserBounds): Promise<void>;
    back(): Promise<void>;
    reload(): Promise<void>;
    onBrowserStatus(listener: (status: OnboardingBrowserStatus) => void): () => void;
  };
  browser: {
    getStatus(): Promise<EmbeddedBrowserStatus>;
    newTab(): Promise<EmbeddedBrowserStatus>;
    closeTab(id: string): Promise<EmbeddedBrowserStatus>;
    activateTab(id: string): Promise<EmbeddedBrowserStatus>;
    navigate(input: string): Promise<EmbeddedBrowserStatus>;
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;
    setBounds(bounds: BrowserBounds | null): Promise<void>;
    onStatus(listener: (status: EmbeddedBrowserStatus) => void): () => void;
  };
  voice: {
    getStatus(): Promise<VoiceAvailability>;
    requestAccess(): Promise<boolean>;
    transcribe(requestId: string, audio: Uint8Array, mediaType: string): Promise<string>;
    cancel(requestId: string): Promise<boolean>;
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
    deleteAppData(): Promise<boolean>;
  };
  usage: {
    getLocalStats(): Promise<LocalUsageStats>;
  };
  onCloseRequested(flush: () => Promise<void>): () => void;
}

declare global {
  interface Window {
    gigaChat: AppApi;
  }
}
