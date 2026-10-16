import type { PermissionAction, PermissionProfile, PermissionResource } from './permissions';
import type { GigaChatModelId } from './models';

export type Theme = 'system' | 'emerald' | 'light' | 'dark' | 'warm';
export type ChatKind = 'text' | 'image';
export type PreferredOpener = 'system' | 'explorer' | 'detected-app';
export type CloseAttemptResult =
  | { status: 'closed' }
  | { status: 'failed'; reason: 'browser-metadata' | 'close'; message: string };
export type CloseFailure = Extract<CloseAttemptResult, { status: 'failed' }>;

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

export interface ProjectUpdateResult {
  project: Project;
  warning: string | null;
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
  source?: 'runtime' | 'example';
  functionsStateId?: string;
  attachmentIds?: string[];
}

export interface CompactSnapshot {
  id: string;
  version: 1;
  boundaryMessageId: string;
  coveredThroughMessageId: string;
  coveredPrefixHash: string;
  text: string;
  modelId: GigaChatModelId;
  provenance: 'fixture' | 'provider';
  createdAt: string;
}

export interface CompactionPrefix {
  messages: ChatMessage[];
  protocolHistory: ProviderProtocolExchange[];
  coveredThroughMessageId: string;
  coveredPrefixHash: string;
}

export type ContextProvenance = 'unknown' | 'estimated' | 'verified';

export type ContextPreviewSource = 'home' | 'chat';

export type ContextPreviewUnknownReason =
  | 'token-estimate-unavailable'
  | 'model-limit-undocumented'
  | 'pending-attachment-content'
  | 'historical-attachment-content'
  | 'historical-attachment-metadata'
  | 'opaque-function-state';

export type ContextPreviewBlockSource = ContextBlockSize['source'];

export type ContextPreviewRequest =
  | { source: 'home'; visibleText: string }
  | { source: 'chat'; chatId: string; visibleText: string };

export interface ContextPreviewBlockSummary {
  source: ContextPreviewBlockSource;
  count: number;
  utf8Bytes: number;
}

export interface ContextPreviewView {
  modelId: string | null;
  contextLimit: {
    tokens: number | null;
    provenance: 'official-model-docs' | 'unknown';
    source: string | null;
    verifiedAt: string | null;
  };
  estimatedTokens: null;
  tokenEstimateProvenance: 'unknown';
  preparationWireBytes: number | null;
  maximumWireBytes: number;
  preparationWireBytesIncludeAttachments: false;
  blocks: ContextPreviewBlockSummary[];
  pendingAttachments: { count: number; sizeBytes: number };
  historicalAttachments: { count: number; sizeBytes: number | null };
  unknownReasons: ContextPreviewUnknownReason[];
}

export interface ContextBlockSize {
  source: 'runtime' | 'global' | 'project' | 'skill' | 'summary' | 'message' | 'protocol' | 'function-schema';
  label: string;
  utf8Bytes: number;
}

export type InstructionSource = 'runtime' | 'global' | 'project' | 'skill' | 'summary';

export interface InstructionLayer {
  source: InstructionSource;
  label: string;
  scope?: string;
  text: string;
}

export interface InstructionDocument {
  text: string;
  revision: string;
}

export interface PreservedInstructionVersion {
  path: string;
  text: string | null;
}

export type InstructionSaveResult =
  | { kind: 'saved'; document: InstructionDocument }
  | {
    kind: 'conflict';
    phase: 'before-commit' | 'after-commit';
    current: InstructionDocument;
    preservedVersion?: PreservedInstructionVersion;
  };

export interface InstructionCommitRequest {
  workingFolder: string;
  relativePath: string;
  contents: string;
  expectedHash: string | null;
}

export type InstructionCommitResult =
  | { kind: 'saved' }
  | { kind: 'conflict-before'; currentText: string | null }
  | { kind: 'conflict-after'; currentText: string; preservedPath: string; preservedText: string | null };

export interface ProviderTurnRequest {
  system: InstructionLayer[];
  messages: ChatMessage[];
  protocolHistory?: ProviderProtocolExchange[];
  attachments?: ProviderAttachmentReference[];
  permissionProfile: PermissionProfile;
  modelId: GigaChatModelId | null;
  usageKind?: UsageRequestKind;
  functionCallMode?: 'auto' | 'none';
}

export interface ProviderAttachmentReference {
  messageId: string;
  attachmentId: string;
  fileId: string;
  name: string;
  contentType: string;
  kind: 'document' | 'image';
  sizeBytes: number;
}

export type UsageRequestKind = 'chat' | 'tool-continuation' | 'compaction';
export type UsageReceiptStatus = 'pending' | 'completed' | 'failed' | 'cancelled';
export type UsageCountField = 'promptTokens' | 'completionTokens' | 'totalTokens' | 'precachedPromptTokens';

export interface ProviderUsageValues {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  precachedPromptTokens: number | null;
  providerRequestId?: string;
  providerModel?: string;
}

export interface UsageReceipt extends Omit<ProviderUsageValues, 'providerRequestId' | 'providerModel'> {
  localRequestId: string;
  chatId: string;
  requestKind: UsageRequestKind;
  modelId: GigaChatModelId;
  providerRequestId: string | null;
  providerModel: string | null;
  createdAt: string;
  status: UsageReceiptStatus;
  conflictedFields: UsageCountField[];
}

export interface UsageCounterSummary {
  knownTokens: number;
  unknownRequests: number;
  conflictedRequests: number;
}

export interface UsageAggregate {
  key: string;
  requestCount: number;
  completedRequestCount: number;
  pendingRequestCount: number;
  failedRequestCount: number;
  cancelledRequestCount: number;
  promptTokens: UsageCounterSummary;
  completionTokens: UsageCounterSummary;
  totalTokens: UsageCounterSummary;
  precachedPromptTokens: UsageCounterSummary;
}

export interface UsageLedgerSummary extends UsageAggregate {
  byChat: UsageAggregate[];
  byModel: UsageAggregate[];
  byDay: UsageAggregate[];
}

export interface UsageProfileChatRow {
  chatId: string | null;
  title: string;
  archived: boolean | null;
  aggregate: UsageAggregate;
}

export interface UsageProfileDay {
  date: string;
  aggregate: UsageAggregate;
  byFamily: UsageAggregate[];
}

export type BalanceFamilyId = 'ultra' | 'max' | 'pro' | 'lite';

export interface ProviderBalanceFamily {
  family: BalanceFamilyId;
  state: 'known' | 'missing' | 'ambiguous';
  value?: number;
}

export interface ProviderBalanceObservation {
  observedAt: string;
  unknownUsageCount: number;
  families: ProviderBalanceFamily[];
}

export interface UsageBalanceFamilyView {
  family: BalanceFamilyId;
  state: 'known' | 'missing' | 'ambiguous' | 'unknown' | 'expired';
  snapshotRemainingTokens: number | null;
  usedSinceSnapshot: number;
  estimatedRemainingTokens: number | null;
  unknownRequests: number;
  conflictedRequests: number;
}

export interface UsageBalanceView {
  state: 'unknown' | 'available' | 'expired';
  source: 'api' | 'studio' | null;
  observedAt: string | null;
  expiresAt: string | null;
  unknownUsageCount: number | null;
  isEstimate: boolean;
  incomplete: boolean;
  families: UsageBalanceFamilyView[];
}

export interface StudioBalanceAnchorInput {
  remainingTokens: Record<BalanceFamilyId, number>;
  expiresAt: string;
}

export interface UsageProfileView {
  generatedAt: string;
  timeZone: string;
  balance: UsageBalanceView;
  total: UsageAggregate;
  byFamily: UsageAggregate[];
  byModel: UsageAggregate[];
  byChat: UsageProfileChatRow[];
  providerIdentityConflictCount: number;
  localActivity: {
    activityDates: string[];
    activityDayCount: number;
    streakDays: number;
    today: UsageAggregate;
    week: UsageAggregate;
    month: UsageAggregate;
    rollingYear: { startDate: string; endDate: string; days: UsageProfileDay[] };
  };
  chats: {
    count: number;
    longestByMessages: { chatId: string; title: string; messageCount: number } | null;
    maxTokens: {
      chatId: string | null;
      title: string;
      knownTokens: number;
      unknownRequests: number;
      conflictedRequests: number;
      complete: boolean;
    } | null;
  };
  projects: { count: number };
  skills: { installedCount: number | null; invocationCount: number; unknownTurnCount: number; bySkill: Array<{ skillId: string; invocationCount: number }> };
  tools: { invocationCount: number; unknownInvocationCount: number; byTool: Array<{ tool: string; invocationCount: number; unknownInvocationCount: number }> };
}

export const PROVIDER_ERROR_CATEGORIES = [
  'auth', 'tls', 'network', 'rate-limit', 'quota', 'model', 'context', 'protocol', 'tool', 'storage', 'cancel',
] as const;
export type ProviderErrorCategory = typeof PROVIDER_ERROR_CATEGORIES[number];

export type ProviderConnectionState = 'not-configured' | 'connecting' | 'connected' | 'error';

export interface ProviderConnectionSnapshot {
  state: ProviderConnectionState;
  errorCategory: ProviderErrorCategory | null;
  failedStep?: 'oauth' | 'models';
  httpStatus?: number;
}

export interface ModelRegistrySnapshot {
  state: 'unavailable' | 'ready' | 'error';
  /** Exact raw IDs from /models. This list is never filtered by chat-family policy. */
  modelIds: GigaChatModelId[];
  errorCategory: ProviderErrorCategory | null;
  /** IDs for which the API returned HTTP 402 in this provider session. */
  exhaustedModelIds?: GigaChatModelId[];
}

export interface ProviderFunctionCall {
  name: string;
  arguments: Record<string, unknown>;
  content: string | null;
  functionsStateId: string | null;
  terminalReason: 'function_call';
  wire?: ProviderV2FunctionWire;
}

export type ProviderV2FunctionContentPart =
  | { text: string }
  | { function_call: { id?: string; name: string; arguments: Record<string, unknown> | string } };

/** Exact validated V2 assistant call data; persisted only in the private Store envelope. */
export interface ProviderV2FunctionWire {
  content: ProviderV2FunctionContentPart[];
  messageId?: string;
  toolStateId?: string;
}

export interface ProviderProtocolExchange {
  anchorMessageId: string;
  name: string;
  arguments: Record<string, unknown>;
  content: string | null;
  functionsStateId: string | null;
  result: string;
  receiptId?: string;
  wire?: ProviderV2FunctionWire;
}

export interface ChatToolReceipt extends Omit<ProviderProtocolExchange, 'result' | 'receiptId' | 'wire'> {
  receiptId: string;
  effectId?: string;
  status: 'pending' | 'completed' | 'unknown';
  result: string | null;
  createdAt: string;
}

export interface AcceptedTurnInput {
  turnId: string;
  chatId: string;
  projectId: string | null;
  projectWorkingFolder: string | null;
  messageId: string;
  assistantMessageId: string | null;
  historyBoundary: number;
  messages: ChatMessage[];
  attachmentIds?: string[];
  permissionProfile: PermissionProfile;
  modelId: GigaChatModelId | null;
  skillId: string | null;
  reservation: { permissionProfileRevision: number | null; skillRevision: number | null };
  operation?: 'compaction';
  compactBoundaryMessageId?: string;
  compactExpectedSnapshotId?: string | null;
}

export type ProviderToolName = 'list' | 'search' | 'read' | 'write' | 'open' | 'powershell';

export type ProviderEvent =
  | { type: 'activity'; activity: 'connecting' | 'receiving' | 'waiting-for-tool' | 'tool-started' | 'tool-finished' | 'function-progress'; tool?: ProviderToolName; functionName?: 'get_file_content' | 'text2image'; detail?: string }
  | ({ type: 'usage' } & ProviderUsageValues)
  | { type: 'text-delta'; text: string }
  | { type: 'image-result'; artifactId: string }
  | { type: 'function-call'; functionCall: ProviderFunctionCall }
  | { type: 'completed'; responseId?: string; functionsStateId?: string }
  | { type: 'error'; category: ProviderErrorCategory; retryable: boolean };

export interface GigaChatProvider {
  stream(request: ProviderTurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ProviderFileRecord {
  id: string;
  filename: string;
  bytes: number;
  purpose: 'general';
}

export interface ProviderFileUploadInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ProviderUploadLedgerEntry {
  accountScope: string;
  attachmentId: string;
  uploadFilename: string;
  name: string;
  contentType: string;
  kind: 'document' | 'image';
  sizeBytes: number;
  sha256: string;
  state: 'intent' | 'uploaded' | 'unknown' | 'cleanup-pending';
  remoteFileId: string | null;
  createdAt: string;
}

export interface ProviderGeneratedImageLedgerEntry {
  accountScope: string;
  chatId: string;
  turnId: string;
  anchorMessageId: string;
  assistantMessageId: string;
  artifactId: string;
  modelId: GigaChatModelId;
  createdAt: string;
  state: 'intent' | 'unknown' | 'generated' | 'downloaded' | 'cleanup-pending';
  remoteFileId: string | null;
  contentType: 'image/jpeg' | 'image/png' | null;
  sizeBytes: number | null;
  sha256: string | null;
}

export type RuntimeTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type RuntimeActivity =
  | { kind: 'provider'; at: string; activity: Extract<ProviderEvent, { type: 'activity' }>['activity']; tool?: ProviderToolName; functionName?: 'get_file_content' | 'text2image'; detail?: string }
  | { kind: 'tool'; at: string; tool: ProviderToolName; phase: 'started' | 'completed' | 'failed' | 'cancelled'; durationMs?: number }
  | { kind: 'hook'; at: string; hookId: string; hookName: string; event: HookEvent; status: HookRunResult['status']; reason?: string };

export interface RuntimeTurnSnapshot {
  id: string;
  chatId: string;
  anchorMessageId: string;
  assistantMessageId: string | null;
  operation?: 'compaction';
  modelId?: GigaChatModelId | null;
  /** Non-null between preparing a Skill layer and invoking the first provider iterator step. */
  pendingSkillId?: string | null;
  /** Set only after the first provider iterator step is invoked. */
  invokedSkillId?: string | null;
  status: RuntimeTurnStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  queueDurationMs?: number;
  activeDurationMs?: number;
  activity: RuntimeActivity[];
  draft?: string;
  error?: string;
  errorCategory?: ProviderErrorCategory;
  retryEligible?: boolean;
}

export interface ChatTurnRecord {
  turnId: string;
  anchorMessageId: string;
  assistantMessageId: string | null;
  modelId: GigaChatModelId | null;
  /** Missing in migrated history means pending/call state was not recorded. */
  pendingSkillId?: string | null;
  /** Missing in migrated history means the old Skill-use count is unknown. */
  invokedSkillId?: string | null;
  operation?: 'compaction';
  status: RuntimeTurnStatus | 'interrupted';
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  queueDurationMs?: number;
  activeDurationMs?: number;
  activity: RuntimeActivity[];
  error?: string;
  errorCategory?: ProviderErrorCategory;
}

export interface RuntimeAvailability {
  providerConfigured: boolean;
  helperRecovered: boolean;
  rendererToolApi: false;
  helperUnavailableReason: string | null;
  compactionAvailable: false;
  compactionUnavailableReason: string;
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
  sha256?: string;
  createdAt: string;
  messageId: string | null;
}

export interface HomeDraftAttachment {
  id: string;
  name: string;
  storedName: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface HomeDraftInput {
  revision: number;
  text: string;
  projectId: string | null;
  permissionProfile: PermissionProfile | null;
  skillId: string | null;
  modelId: GigaChatModelId | null;
}

export interface HomeDraftAcceptance {
  sourceRevision: number;
  chatId: string;
  turn: AcceptedTurnInput;
}

export interface HomeDraftRecord extends HomeDraftInput {
  attachments: HomeDraftAttachment[];
  lastAcceptance: HomeDraftAcceptance | null;
}

export interface HomeDraftSendResult {
  detail: ChatDetail;
  turn: AcceptedTurnInput;
  homeDraft: HomeDraftRecord;
  queued: boolean;
  newlyAccepted: boolean;
}

export interface AttachmentImportFailure {
  name: string;
  reason: string;
}

export interface AttachmentImportBatchResult<T> {
  record: T;
  failures: AttachmentImportFailure[];
}

export interface ChatDetail extends ChatSummary {
  draft: string;
  nextTurnPermissionProfile: PermissionProfile | null;
  modelId: GigaChatModelId | null;
  nextTurnSkillId: string | null;
  messages: ChatMessage[];
  turns: ChatTurnRecord[];
  toolReceipts: ChatToolReceipt[];
  artifacts: ChatArtifact[];
  draftAttachments: HomeDraftAttachment[];
  compactSnapshot: CompactSnapshot | null;
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
  ownerId: string | null;
  source: string;
  enabled: boolean;
  trusted: boolean;
  available: boolean;
  contentHash: string;
  actionFile: string;
  unavailableReason: string;
  lastRun?: { event: HookEvent; status: HookRunResult['status']; reason?: string; at: string };
}

export interface HookInspection {
  id: string;
  contentHash: string;
  manifestContents: string;
  actionContents: string;
}

export interface HookDispatchInput {
  event: HookEvent;
  projectId: string | null;
  tool?: ProviderToolName;
  resource?: PermissionResource;
  action?: PermissionAction;
  outcome?: 'completed' | 'failed' | 'cancelled';
}

export interface HookRunResult {
  hookId: string;
  hookName: string;
  event: HookEvent;
  status: 'completed' | 'blocked' | 'failed' | 'skipped' | 'cancelled';
  decision?: 'allow' | 'block';
  reason?: string;
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
  installedLauncherAvailable: boolean;
  autoStartMigrationIssue: string | null;
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
  context: {
    preview(input: ContextPreviewRequest): Promise<ContextPreviewView>;
  };
  homeDraft: {
    get(): Promise<HomeDraftRecord>;
    save(input: HomeDraftInput): Promise<HomeDraftRecord>;
    importFile(): Promise<HomeDraftRecord | null>;
    pickFiles(): Promise<AttachmentImportBatchResult<HomeDraftRecord> | null>;
    stageFiles(files: File[]): Promise<AttachmentImportBatchResult<HomeDraftRecord>>;
    getAttachmentPreview(id: string): Promise<string | null>;
    removeFile(id: string): Promise<HomeDraftRecord>;
    send(expectedRevision: number): Promise<HomeDraftSendResult>;
  };
  projects: {
    list(): Promise<Project[]>;
    create(name: string, workingFolder?: string | null): Promise<Project>;
    pickFolder(): Promise<string | null>;
    instructionsBackupPath(id: string): Promise<string | null>;
    update(id: string, patch: ProjectPatch): Promise<ProjectUpdateResult>;
    remove(id: string): Promise<void>;
    chooseFolder(id: string): Promise<ProjectUpdateResult>;
    openFolder(id: string): Promise<void>;
    readInstructions(id: string): Promise<InstructionDocument>;
    saveInstructions(id: string, contents: string, expectedRevision: string): Promise<InstructionSaveResult>;
    saveInstructionsCopy(id: string, contents: string): Promise<string>;
  };
  chats: {
    list(): Promise<ChatSummary[]>;
    get(id: string): Promise<ChatDetail>;
    create(projectId?: string | null, kind?: ChatKind): Promise<ChatSummary>;
    update(id: string, patch: ChatPatch): Promise<ChatSummary>;
    appendLocalMessage(id: string, text: string, attachmentIds?: string[]): Promise<ChatDetail>;
    pickDraftFiles(id: string): Promise<AttachmentImportBatchResult<ChatDetail> | null>;
    stageDraftFiles(id: string, files: File[]): Promise<AttachmentImportBatchResult<ChatDetail>>;
    getDraftAttachmentPreview(id: string, attachmentId: string): Promise<string | null>;
    getArtifactPreview(id: string, artifactId: string): Promise<string | null>;
    removeDraftFile(id: string, attachmentId: string): Promise<ChatDetail>;
    importFile(id: string | null, projectId?: string | null): Promise<ChatDetail | null>;
    copyMessage(id: string, messageId: string): Promise<void>;
    openArtifact(id: string, artifactId: string): Promise<void>;
    openFolder(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  runtime: {
    getStatus(): Promise<RuntimeAvailability>;
    list(chatId: string): Promise<RuntimeTurnSnapshot[]>;
    cancel(chatId: string, turnId: string): Promise<boolean>;
    retry(chatId: string, turnId: string): Promise<string | null>;
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
    inspect(id: string): Promise<HookInspection & { name: string; event: HookEvent; source: string }>;
    trust(id: string, expectedHash: string): Promise<HookRegistrySnapshot>;
    setEnabled(id: string, enabled: boolean): Promise<HookRegistrySnapshot>;
  };
  models: {
    getRegistry(): Promise<ModelRegistrySnapshot>;
    refresh(): Promise<ModelRegistrySnapshot>;
  };
  onboarding: {
    getKeyStatus(): Promise<SecureStoreStatus>;
    saveKey(key: string): Promise<SecureStoreStatus>;
    getConnectionStatus(): Promise<ProviderConnectionSnapshot>;
    connect(): Promise<ProviderConnectionSnapshot>;
    cancelConnect(): Promise<ProviderConnectionSnapshot>;
    disconnect(): Promise<ProviderConnectionSnapshot>;
    getBrowserStatus(): Promise<OnboardingBrowserStatus>;
    openStudio(): Promise<OnboardingBrowserStatus>;
    closeBrowser(): Promise<void>;
    setBrowserBounds(bounds: BrowserBounds | null): Promise<void>;
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
    readInstructions(): Promise<InstructionDocument>;
    saveInstructions(contents: string, expectedRevision: string): Promise<InstructionSaveResult>;
    saveInstructionsCopy(contents: string): Promise<string>;
    deleteAppData(): Promise<boolean>;
  };
  usage: {
    getLocalStats(): Promise<LocalUsageStats>;
    getLedger(): Promise<UsageLedgerSummary>;
    getProfileView(): Promise<UsageProfileView>;
    refreshBalance(): Promise<UsageProfileView>;
    saveStudioBalanceAnchor(input: StudioBalanceAnchorInput): Promise<UsageProfileView>;
  };
  onCloseRequested(flush: () => Promise<void>, onFailure: (result: CloseFailure) => void): () => void;
  retryClose(discardBrowserMetadata?: boolean): Promise<CloseAttemptResult>;
  returnFromClose(): Promise<void>;
}

declare global {
  interface Window {
    gigaChat: AppApi;
  }
}
