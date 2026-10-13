import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_NOTIFICATION_SETTINGS, PROVIDER_ERROR_CATEGORIES, type AcceptedTurnInput, type BrowserTabRecord, type ChatArtifact, type ChatDetail, type ChatKind, type ChatMessage, type ChatPatch, type ChatSummary, type ChatToolReceipt, type ChatTurnRecord, type CompactSnapshot, type CompactionPrefix, type HomeDraftAttachment, type HomeDraftInput, type HomeDraftRecord, type HookEvent, type HookRunResult, type InstructionCommitRequest, type InstructionCommitResult, type InstructionDocument, type InstructionSaveResult, type LocalUsageStats, type NotificationSettings, type Project, type ProjectPatch, type ProjectUpdateResult, type ProviderErrorCategory, type ProviderProtocolExchange, type ProviderToolName, type ProviderUploadLedgerEntry, type RuntimeActivity, type RuntimeTurnSnapshot, type Settings, type SettingsPatch, type Theme, type UsageLedgerSummary, type UsageReceipt } from './contracts';
import { requirePermissionProfile, type PermissionProfile } from './permissions';
import { requireModelId } from './models';
import { isSkillId } from './skills';
import { validateProjectFolder, validateProjectInstructionsPath } from './project-paths';
import { createInstructionDocument, instructionFileHash } from './instruction-documents';
import { MAX_USAGE_RECEIPTS, mergeUsageReceipt, summarizeUsage, validateUsageReceipt } from './usage';
import { hashCompactionPrefix, validateCompactSummary } from './context';
import { attachmentContentType, inspectLocalAttachmentContent, LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES, PROVIDER_IMAGE_LIMIT_BYTES } from './attachment-policy';

type ProjectFile = { schemaVersion: 2; projects: Project[] };
type LegacyChat = ChatSummary & { draft: string };
type ChatFile = { schemaVersion: 2; chats: LegacyChat[] };
type SettingsFile = { schemaVersion: 10; settings: Settings };
type UsageFile = { schemaVersion: 1; receipts: UsageReceipt[] };
type ProviderUploadFile = { schemaVersion: 1; entries: ProviderUploadLedgerEntry[] };
type ProjectDeleteState = { projects: ProjectFile; chats: ChatDetail[]; instructionText: string | null };
type ProjectDeleteJournal = {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  before: ProjectDeleteState;
  after: ProjectDeleteState;
};
type HomeSendJournal = {
  schemaVersion: 1;
  operationId: string;
  sourceRevision: number;
  chat: ChatDetail;
  turn: AcceptedTurnInput;
  attachments: HomeDraftAttachment[];
  nextDraft: HomeDraftRecord;
};
export type StoreFaultStage = 'journal' | 'chat' | 'projects' | 'instructions' | 'journal-cleared';
export type HomeSendFaultStage = 'journal' | 'chat' | 'draft' | 'journal-cleared';
export interface StoreTestFaults {
  afterProjectDeleteStage?: (stage: StoreFaultStage, chatIndex?: number) => void | Promise<void>;
  beforeProjectInstructionCommit?: (targetPath: string) => void | Promise<void>;
  beforeCompactSnapshotCommit?: () => void | Promise<void>;
  beforeHomeSendJournal?: () => void | Promise<void>;
  afterHomeSendStage?: (stage: HomeSendFaultStage) => void | Promise<void>;
}

export type InstructionCommitter = (request: InstructionCommitRequest) => Promise<InstructionCommitResult>;

export interface StoreOpenOptions {
  documentsDirectory?: string | null;
  testFaults?: StoreTestFaults;
  instructionCommitter?: InstructionCommitter;
}

const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_USAGE_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDER_UPLOAD_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_UPLOAD_ENTRIES = 10_000;
const MAX_TOOL_RECEIPTS_PER_CHAT = 256;
const MAX_TURN_ACTIVITY_PER_TURN = 50;
const MAX_TURN_RECORDS_PER_CHAT = 50_000;
const MAX_TOOL_ARGUMENTS_BYTES = 1_900_000;
const MAX_TOOL_RESULT_BYTES = 32 * 1024;
const MAX_HOME_DRAFT_BYTES = 1_000_000;
const MAX_HOME_DRAFT_FILES = 32;
const MAX_HOME_DRAFT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_HOME_DRAFT_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_CHAT_DRAFT_FILES = 32;
const MAX_CHAT_DRAFT_TOTAL_BYTES = 100 * 1024 * 1024;
const SIDE_EFFECT_TOOLS = new Set(['write', 'powershell', 'open']);
const UNKNOWN_TOOL_RESULT = JSON.stringify({
  ok: false,
  status: 'unknown',
  error: 'Результат локального инструмента неизвестен после прерывания; проверьте эффект перед повтором.',
});

interface InstructionSnapshot {
  document: InstructionDocument;
  exists: boolean;
}

export interface LocalStore {
  listProjects(): Promise<Project[]>;
  createProject(name: unknown, workingFolder?: unknown): Promise<Project>;
  updateProject(id: unknown, patch: unknown): Promise<ProjectUpdateResult>;
  migrateProjectInstructions(id: unknown): Promise<void>;
  projectInstructionsBackupPath(id: unknown): Promise<string | null>;
  deleteProject(id: unknown): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  getHomeDraft(): Promise<HomeDraftRecord>;
  getHomeDraftAttachmentPath(attachmentId: unknown): Promise<string>;
  saveHomeDraft(input: unknown): Promise<HomeDraftRecord>;
  stageHomeDraftFile(sourcePath: string): Promise<HomeDraftRecord>;
  removeHomeDraftFile(id: unknown): Promise<HomeDraftRecord>;
  stageChatDraftFile(chatId: unknown, sourcePath: string): Promise<ChatDetail>;
  removeChatDraftFile(chatId: unknown, attachmentId: unknown): Promise<ChatDetail>;
  getChatDraftAttachmentPath(chatId: unknown, attachmentId: unknown): Promise<string>;
  acceptHomeDraft(expectedRevision: unknown, turnId: unknown, expectedModelId?: unknown, validateBeforeCommit?: () => void): Promise<{ detail: ChatDetail; turn: AcceptedTurnInput; newlyAccepted: boolean }>;
  getChat(id: unknown): Promise<ChatDetail>;
  getMessagesThrough(chatId: unknown, messageId: unknown): Promise<ChatMessage[]>;
  getToolProtocolThrough(chatId: unknown, messageId: unknown): Promise<ProviderProtocolExchange[]>;
  getCompactionPrefix(chatId: unknown, boundaryMessageId: unknown): Promise<CompactionPrefix>;
  beginToolReceipt(chatId: unknown, messageId: unknown, receipt: Omit<ChatToolReceipt, 'anchorMessageId' | 'status' | 'result' | 'createdAt'>): Promise<{ shouldExecute: boolean; receipt: ChatToolReceipt }>;
  completeToolReceipt(chatId: unknown, messageId: unknown, receiptId: unknown, status: 'completed' | 'unknown', result: unknown): Promise<void>;
  createChat(projectId?: unknown, kind?: unknown): Promise<ChatSummary>;
  updateChat(id: unknown, patch: unknown): Promise<ChatSummary>;
  appendLocalMessage(id: unknown, text: unknown): Promise<ChatDetail>;
  acceptLocalMessage(id: unknown, text: unknown, turnId: unknown, attachmentIds?: unknown, expectedModelId?: unknown, validateBeforeCommit?: () => void): Promise<{ detail: ChatDetail; turn: AcceptedTurnInput }>;
  acceptCompactionTurn(id: unknown, turnId: unknown): Promise<{ detail: ChatDetail; turn: AcceptedTurnInput }>;
  releaseTurnReservation(turnId: unknown): void;
  markQueuedTurnNotSent(turn: AcceptedTurnInput, reason: unknown): Promise<{ detail: ChatDetail; marked: boolean }>;
  reserveRetryTurn(original: AcceptedTurnInput, retry: AcceptedTurnInput): Promise<void>;
  consumeTurnReservation(turn: AcceptedTurnInput, signal?: AbortSignal): Promise<void>;
  validateAcceptedTurn(turn: AcceptedTurnInput): Promise<void>;
  updateRuntimeTurn(turn: RuntimeTurnSnapshot): Promise<void>;
  appendAssistantMessageFromRuntime(turn: AcceptedTurnInput, text: unknown, terminalTurn: RuntimeTurnSnapshot, signal?: AbortSignal, functionsStateId?: unknown): Promise<ChatDetail>;
  commitCompactSnapshot(id: unknown, snapshot: CompactSnapshot, expectedSnapshotId: string | null, signal?: AbortSignal, terminalTurn?: RuntimeTurnSnapshot): Promise<ChatDetail>;
  importFile(id: unknown, sourcePath: string, projectId?: unknown): Promise<ChatDetail>;
  getArtifactPath(id: unknown, artifactId: unknown): Promise<string>;
  getChatFolder(id: unknown): Promise<string>;
  deleteChat(id: unknown): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: unknown): Promise<Settings>;
  getLocalUsageStats(): Promise<LocalUsageStats>;
  recordUsageReceipt(receipt: unknown): Promise<void>;
  getUsageLedger(): Promise<UsageLedgerSummary>;
  getProviderUploadEntries(accountScope: unknown): Promise<ProviderUploadLedgerEntry[]>;
  putProviderUploadEntry(value: unknown): Promise<ProviderUploadLedgerEntry>;
  removeProviderUploadEntry(accountScope: unknown, attachmentId: unknown, remoteFileId: unknown): Promise<void>;
  getStorageIssues(): Promise<string[]>;
  readGlobalInstructions(): Promise<string>;
  readGlobalInstructionDocument(): Promise<InstructionDocument>;
  saveGlobalInstructions(contents: unknown, expectedRevision: unknown): Promise<InstructionSaveResult>;
  saveGlobalInstructionsCopy(contents: unknown): Promise<string>;
  readProjectInstructions(id: unknown, expectedWorkingFolder?: unknown): Promise<string>;
  readProjectInstructionDocument(id: unknown): Promise<InstructionDocument>;
  saveProjectInstructions(id: unknown, contents: unknown, expectedRevision: unknown): Promise<InstructionSaveResult>;
  saveProjectInstructionsCopy(id: unknown, contents: unknown): Promise<string>;
}

type Loaded<T> = { value: T; needsWrite: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function storageError(filePath: string): Error {
  return new Error(`Локальный файл «${basename(filePath)}» повреждён или имеет неизвестный формат. Файл не изменён.`);
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Некорректный идентификатор.');
  }
  return value;
}

function requireName(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}: укажите текстовое значение.`);
  const name = value.trim();
  if (!name || name.length > maxLength) {
    throw new Error(`${label}: длина должна быть от 1 до ${maxLength} символов.`);
  }
  return name;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}: ожидается логическое значение.`);
  return value;
}

function requireFolderPath(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || value.length > 4096) {
    throw new Error(`${label}: выберите существующую папку.`);
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Некорректная временная метка в локальных данных.');
  }
  return value;
}

function validateProject(value: unknown, version: 1 | 2): Project {
  if (!isRecord(value)) throw new Error('Project record is invalid.');
  return {
    id: requireId(value.id),
    name: requireName(value.name, 'Название проекта', 120),
    pinned: requireBoolean(value.pinned, 'Закрепление проекта'),
    archived: requireBoolean(value.archived, 'Архив проекта'),
    createdAt: requireTimestamp(value.createdAt),
    updatedAt: requireTimestamp(value.updatedAt),
    workingFolder: version === 1 ? null : requireFolderPath(value.workingFolder, 'Рабочая папка проекта'),
  };
}

function validateChat(value: unknown, version: 1 | 2): LegacyChat {
  if (!isRecord(value)) throw new Error('Chat record is invalid.');
  if (value.projectId !== null && value.projectId !== undefined && typeof value.projectId !== 'string') {
    throw new Error('Некорректный проект чата.');
  }
  if (typeof value.draft !== 'string') throw new Error('Некорректный черновик чата.');
  const kind = version === 1 ? 'text' : value.kind;
  if (kind !== 'text' && kind !== 'image') throw new Error('Некорректный тип чата.');
  return {
    id: requireId(value.id),
    title: requireName(value.title, 'Название чата', 160),
    projectId: value.projectId == null ? null : requireId(value.projectId),
    pinned: requireBoolean(value.pinned, 'Закрепление чата'),
    archived: requireBoolean(value.archived, 'Архив чата'),
    createdAt: requireTimestamp(value.createdAt),
    updatedAt: requireTimestamp(value.updatedAt),
    draft: value.draft,
    kind,
  };
}

function validateTheme(value: unknown): Theme {
  if (value === 'system' || value === 'emerald' || value === 'light' || value === 'dark' || value === 'warm') return value;
  throw new Error('Неизвестная тема оформления.');
}

function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!isRecord(value)
    || typeof value.taskStarted !== 'boolean'
    || typeof value.taskCompleted !== 'boolean'
    || typeof value.failures !== 'boolean'
    || Object.keys(value).some((key) => !['taskStarted', 'taskCompleted', 'failures'].includes(key))) {
    throw new Error('Некорректные категории уведомлений.');
  }
  return { taskStarted: value.taskStarted, taskCompleted: value.taskCompleted, failures: value.failures };
}

function requireSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 242 || value > 440) {
    throw new Error('Некорректная ширина боковой панели.');
  }
  return value;
}

function requireBrowserWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 320 || value > 16384) {
    throw new Error('Некорректная ширина браузера.');
  }
  return value;
}

function validateBrowserTabs(value: unknown): BrowserTabRecord[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Некорректные вкладки браузера.');
  const tabs = value.map((item): BrowserTabRecord => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
      || typeof item.title !== 'string' || item.title.length > 160 || typeof item.url !== 'string' || item.url.length > 4096) {
      throw new Error('Некорректная вкладка браузера.');
    }
    if (item.url) {
      let url: URL;
      try { url = new URL(item.url); } catch { throw new Error('Некорректный адрес вкладки.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Недопустимый адрес вкладки.');
    }
    return { id: item.id, title: item.title, url: item.url };
  });
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) throw new Error('Повтор вкладки браузера.');
  return tabs;
}

function validateSettings(value: unknown, version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10): Settings {
  if (!isRecord(value)) throw new Error('Settings record is invalid.');
  if (version >= 8 && value.microphoneConsent !== 'unasked' && value.microphoneConsent !== 'allowed' && value.microphoneConsent !== 'declined') {
    throw new Error('Некорректное разрешение микрофона.');
  }
  const browserTabs = version >= 9 ? validateBrowserTabs(value.browserTabs) : [];
  const activeTabId = version >= 9 ? value.browserActiveTabId : null;
  if (activeTabId !== null && (typeof activeTabId !== 'string' || !browserTabs.some((tab) => tab.id === activeTabId))) {
    throw new Error('Некорректная активная вкладка браузера.');
  }
  const theme = validateTheme(value.theme);
  const migratedTheme = version < 3 && theme === 'dark' ? 'emerald' : theme;
  if (version === 1) {
    return {
      theme: migratedTheme,
      sidebarTransparent: false,
      sidebarVisible: true,
      sidebarWidthPx: null,
      browserPaneOpen: false,
      browserWidthPx: null,
      browserTabs: [],
      browserActiveTabId: null,
      defaultProjectsFolder: null,
      preferredOpener: 'system',
      defaultPermissionProfile: 'ask',
      defaultModelId: null,
      onboardingCompleted: true,
      microphoneConsent: 'unasked',
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    };
  }
  if (value.preferredOpener !== 'system' && value.preferredOpener !== 'explorer' && value.preferredOpener !== 'detected-app') {
    throw new Error('Некорректное приложение для открытия папок.');
  }
  return {
    theme: migratedTheme,
    sidebarTransparent: requireBoolean(value.sidebarTransparent, 'Прозрачность боковой панели'),
    sidebarVisible: requireBoolean(value.sidebarVisible, 'Видимость боковой панели'),
    sidebarWidthPx: version >= 9 && value.sidebarWidthPx !== null ? requireSidebarWidth(value.sidebarWidthPx) : null,
    browserPaneOpen: version >= 9 ? requireBoolean(value.browserPaneOpen, 'Видимость браузера') : false,
    browserWidthPx: version >= 10 && value.browserWidthPx !== null ? requireBrowserWidth(value.browserWidthPx) : null,
    browserTabs,
    browserActiveTabId: activeTabId as string | null,
    defaultProjectsFolder: requireFolderPath(value.defaultProjectsFolder, 'Папка проектов'),
    preferredOpener: value.preferredOpener,
    defaultPermissionProfile: version >= 4 ? requirePermissionProfile(value.defaultPermissionProfile) : 'ask',
    defaultModelId: version >= 7 && value.defaultModelId !== null ? requireModelId(value.defaultModelId) : null,
    onboardingCompleted: version >= 5
      ? requireBoolean(value.onboardingCompleted, 'Статус первичной настройки')
      : true,
    microphoneConsent: version >= 8 && (value.microphoneConsent === 'unasked' || value.microphoneConsent === 'allowed' || value.microphoneConsent === 'declined')
      ? value.microphoneConsent : 'unasked',
    notifications: version >= 6 ? validateNotificationSettings(value.notifications) : { ...DEFAULT_NOTIFICATION_SETTINGS },
  };
}

function validateRows<T>(
  value: unknown,
  key: 'projects' | 'chats',
  version: 1 | 2,
  validate: (row: unknown, version: 1 | 2) => T,
): T[] {
  if (!isRecord(value) || value.schemaVersion !== version || !Array.isArray(value[key])) {
    throw new Error(`Invalid ${key} file.`);
  }
  const rows = (value[key] as unknown[]).map((row) => validate(row, version));
  const ids = rows.map((row) => (row as Project | LegacyChat).id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ID in ${key} file.`);
  return rows;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isUnavailableProjectFolder(error: unknown): boolean {
  return isRecord(error) && ['ENOENT', 'EACCES', 'EPERM', 'ENODEV', 'ESTALE', 'ENXIO'].includes(String(error.code));
}

function isOutside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

async function assertOwnedPath(root: string, targetPath: string): Promise<void> {
  const relativePath = relative(root, targetPath);
  if (isOutside(root, targetPath)) {
    throw new Error('Путь локальных данных выходит за границу хранилища.');
  }

  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error('Путь локальных данных содержит символическую ссылку.');
    }
    if (isOutside(root, await realpath(current))) {
      throw new Error('Путь локальных данных выходит за границу хранилища.');
    }
  }
}

function createAbortError(): Error {
  return Object.assign(new Error('Операция отменена.'), { name: 'AbortError' });
}

async function writeAtomic(filePath: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (signal?.aborted) throw createAbortError();
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, value, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function loadVersioned<T>(
  filePath: string,
  initial: T,
  parse: (value: unknown) => Loaded<T>,
): Promise<Loaded<T>> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return { value: initial, needsWrite: true };
    throw error;
  }

  try {
    return parse(JSON.parse(contents) as unknown);
  } catch {
    throw storageError(filePath);
  }
}

async function loadUsageLedger(filePath: string): Promise<Loaded<UsageFile>> {
  let info;
  try { info = await lstat(filePath); }
  catch (error) {
    if (isMissingFile(error)) return { value: { schemaVersion: 1, receipts: [] }, needsWrite: true };
    throw error;
  }
  if (!info.isFile() || info.size > MAX_USAGE_LEDGER_BYTES) throw storageError(filePath);
  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_USAGE_LEDGER_BYTES) throw storageError(filePath);
  try { return parseUsageFile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown); }
  catch { throw storageError(filePath); }
}

function parseProjectFile(value: unknown): Loaded<ProjectFile> {
  if (!isRecord(value)) throw new Error('Invalid projects file.');
  if (value.schemaVersion === 1) {
    return {
      value: { schemaVersion: 2, projects: validateRows(value, 'projects', 1, validateProject) },
      needsWrite: true,
    };
  }
  return {
    value: { schemaVersion: 2, projects: validateRows(value, 'projects', 2, validateProject) },
    needsWrite: false,
  };
}

function parseUsageFile(value: unknown): Loaded<UsageFile> {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.receipts)
    || value.receipts.length > MAX_USAGE_RECEIPTS) throw new Error('Invalid usage ledger.');
  const receipts = value.receipts.map(validateUsageReceipt);
  if (new Set(receipts.map((receipt) => receipt.localRequestId)).size !== receipts.length) {
    throw new Error('Duplicate usage request.');
  }
  return { value: { schemaVersion: 1, receipts }, needsWrite: false };
}

function parseChatFile(value: unknown): Loaded<ChatFile> {
  if (!isRecord(value)) throw new Error('Invalid chats file.');
  if (value.schemaVersion === 1) {
    return {
      value: { schemaVersion: 2, chats: validateRows(value, 'chats', 1, validateChat) },
      needsWrite: true,
    };
  }
  return {
    value: { schemaVersion: 2, chats: validateRows(value, 'chats', 2, validateChat) },
    needsWrite: false,
  };
}

function validateCompactSnapshot(value: unknown, messages: readonly ChatMessage[]): CompactSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 1 || typeof value.coveredPrefixHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.coveredPrefixHash)
    || (value.provenance !== 'fixture' && value.provenance !== 'provider')) {
    throw new Error('Invalid compact snapshot.');
  }
  const boundaryMessageId = requireId(value.boundaryMessageId);
  if (!messages.some((message) => message.id === boundaryMessageId && message.role === 'user')) throw new Error('Invalid compact boundary.');
  const coveredThroughMessageId = requireId(value.coveredThroughMessageId);
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryMessageId);
  const coveredIndex = messages.findIndex((message) => message.id === coveredThroughMessageId);
  if (coveredIndex < boundaryIndex) throw new Error('Invalid compact covered prefix.');
  return {
    id: requireId(value.id),
    version: 1,
    boundaryMessageId,
    coveredThroughMessageId,
    coveredPrefixHash: value.coveredPrefixHash,
    text: validateCompactSummary(value.text),
    modelId: requireModelId(value.modelId),
    provenance: value.provenance,
    createdAt: requireTimestamp(value.createdAt),
  };
}

const CHAT_TURN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
const CHAT_TURN_PROVIDER_EVENTS = ['connecting', 'receiving', 'waiting-for-tool', 'tool-started', 'tool-finished', 'function-progress'] as const;
const CHAT_TURN_TOOL_NAMES = ['list', 'search', 'read', 'write', 'open', 'powershell'] as const;
const CHAT_TURN_HOOK_EVENTS = ['session-start', 'project-start', 'user-prompt-submitted', 'before-tool', 'after-tool', 'permission-request', 'before-compaction', 'after-compaction', 'interrupt', 'stop', 'session-end', 'project-end'] as const;
const CHAT_TURN_HOOK_STATUSES = ['completed', 'blocked', 'failed', 'skipped', 'cancelled'] as const;
const MAX_TURN_DURATION_MS = 366 * 24 * 60 * 60 * 1000;

function validateRuntimeActivity(value: unknown): RuntimeActivity {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('Некорректная запись активности хода.');
  if (value.kind === 'provider') {
    if (!(CHAT_TURN_PROVIDER_EVENTS as readonly unknown[]).includes(value.activity)
      || (value.tool !== undefined && !(CHAT_TURN_TOOL_NAMES as readonly unknown[]).includes(value.tool))
      || (value.functionName !== undefined && value.functionName !== 'get_file_content' && value.functionName !== 'text2image')
      || (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 1000
        // eslint-disable-next-line no-control-regex -- Allow line breaks/tabs but reject other control characters in persisted provider activity.
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.detail)))) {
      throw new Error('Некорректная запись активности провайдера.');
    }
    if (value.activity === 'function-progress' && (typeof value.functionName !== 'string' || typeof value.detail !== 'string')) {
      throw new Error('В записи активности отсутствуют данные функции.');
    }
    if (value.activity !== 'function-progress' && (value.functionName !== undefined || value.detail !== undefined)) {
      throw new Error('Данные функции не привязаны к событию активности.');
    }
    return {
      kind: 'provider', at: requireTimestamp(value.at),
      activity: value.activity as Extract<RuntimeActivity, { kind: 'provider' }>['activity'],
      ...(value.tool === undefined ? {} : { tool: value.tool as ProviderToolName }),
      ...(value.functionName === undefined ? {} : { functionName: value.functionName as 'get_file_content' | 'text2image' }),
      ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    } as RuntimeActivity;
  }
  if (value.kind === 'tool') {
    if (!(CHAT_TURN_TOOL_NAMES as readonly unknown[]).includes(value.tool)
      || !['started', 'completed', 'failed', 'cancelled'].includes(String(value.phase))
      || (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0 || (value.durationMs as number) > MAX_TURN_DURATION_MS))) {
      throw new Error('Некорректная запись локального инструмента.');
    }
    return {
      kind: 'tool', at: requireTimestamp(value.at), tool: value.tool as 'list' | 'search' | 'read' | 'write' | 'open' | 'powershell',
      phase: value.phase as 'started' | 'completed' | 'failed' | 'cancelled',
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs as number }),
    };
  }
  if (value.kind === 'hook') {
    if (!(CHAT_TURN_HOOK_EVENTS as readonly unknown[]).includes(value.event)
      || !(CHAT_TURN_HOOK_STATUSES as readonly unknown[]).includes(value.status)
      || typeof value.hookName !== 'string' || !value.hookName.trim() || value.hookName.length > 120
      || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 500))) {
      throw new Error('Некорректная запись Hook.');
    }
    return {
      kind: 'hook', at: requireTimestamp(value.at), hookId: requireScopedHookId(value.hookId), hookName: value.hookName,
      event: value.event as HookEvent, status: value.status as HookRunResult['status'],
      ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    } as RuntimeActivity;
  }
  throw new Error('Неизвестный вид активности хода.');
}

function requireScopedHookId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512
    // eslint-disable-next-line no-control-regex -- Hook IDs are opaque scoped registry identifiers; controls are never valid.
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Некорректный идентификатор Hook.');
  }
  return value;
}

function validateChatTurnRecord(value: unknown): ChatTurnRecord {
  if (!isRecord(value) || !(CHAT_TURN_STATUSES as readonly unknown[]).includes(value.status)
    || (value.operation !== undefined && value.operation !== 'compaction')
    || (value.modelId !== null && value.modelId !== undefined && typeof value.modelId !== 'string')
    || !Array.isArray(value.activity) || value.activity.length > MAX_TURN_ACTIVITY_PER_TURN
    || (value.startedAt !== undefined && !Number.isFinite(Date.parse(String(value.startedAt))))
    || (value.endedAt !== undefined && !Number.isFinite(Date.parse(String(value.endedAt))))
    || (value.queueDurationMs !== undefined && (!Number.isSafeInteger(value.queueDurationMs) || (value.queueDurationMs as number) < 0 || (value.queueDurationMs as number) > MAX_TURN_DURATION_MS))
    || (value.activeDurationMs !== undefined && (!Number.isSafeInteger(value.activeDurationMs) || (value.activeDurationMs as number) < 0 || (value.activeDurationMs as number) > MAX_TURN_DURATION_MS))
    || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 1000))
    || (value.errorCategory !== undefined && !(PROVIDER_ERROR_CATEGORIES as readonly unknown[]).includes(value.errorCategory))) {
    throw new Error('Некорректная запись хода чата.');
  }
  const operation = value.operation as 'compaction' | undefined;
  const assistantMessageId = value.assistantMessageId === null ? null : requireId(value.assistantMessageId);
  if ((operation === 'compaction') !== (assistantMessageId === null)
    || (value.status !== 'queued' && value.status !== 'running' && value.endedAt === undefined)) {
    throw new Error('Идентификаторы или время завершения хода не согласованы.');
  }
  return {
    turnId: requireId(value.turnId),
    anchorMessageId: requireId(value.anchorMessageId),
    assistantMessageId,
    modelId: value.modelId === null || value.modelId === undefined ? null : requireModelId(value.modelId),
    ...(operation ? { operation } : {}),
    status: value.status as ChatTurnRecord['status'],
    createdAt: requireTimestamp(value.createdAt),
    ...(value.startedAt === undefined ? {} : { startedAt: requireTimestamp(value.startedAt) }),
    ...(value.endedAt === undefined ? {} : { endedAt: requireTimestamp(value.endedAt) }),
    ...(value.queueDurationMs === undefined ? {} : { queueDurationMs: value.queueDurationMs as number }),
    ...(value.activeDurationMs === undefined ? {} : { activeDurationMs: value.activeDurationMs as number }),
    activity: value.activity.map(validateRuntimeActivity),
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.errorCategory === undefined ? {} : { errorCategory: value.errorCategory as ProviderErrorCategory }),
  };
}

function assistantMessageIdForLegacyTurn(turnId: string): string {
  return `legacy-assistant-${createHash('sha256').update(turnId).digest('hex').slice(0, 32)}`;
}

function recordForAcceptedTurn(turn: AcceptedTurnInput): ChatTurnRecord {
  const anchor = turn.messages.find((message) => message.id === turn.messageId && message.role === 'user');
  if (!anchor) throw new Error('Принятый ход не содержит исходное сообщение.');
  return {
    turnId: turn.turnId,
    anchorMessageId: turn.messageId,
    assistantMessageId: turn.assistantMessageId,
    modelId: turn.modelId,
    ...(turn.operation ? { operation: turn.operation } : {}),
    status: 'queued',
    createdAt: anchor.createdAt,
    activity: [],
  };
}

function recordFromRuntimeTurn(turn: RuntimeTurnSnapshot): ChatTurnRecord {
  return validateChatTurnRecord({
    turnId: turn.id,
    anchorMessageId: turn.anchorMessageId,
    assistantMessageId: turn.assistantMessageId,
    modelId: turn.modelId ?? null,
    ...(turn.operation ? { operation: turn.operation } : {}),
    status: turn.status,
    createdAt: turn.createdAt,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
    ...(turn.queueDurationMs === undefined ? {} : { queueDurationMs: turn.queueDurationMs }),
    ...(turn.activeDurationMs === undefined ? {} : { activeDurationMs: turn.activeDurationMs }),
    activity: turn.activity,
    ...(turn.error === undefined ? {} : { error: turn.error }),
    ...(turn.errorCategory === undefined ? {} : { errorCategory: turn.errorCategory }),
  });
}

function validateChatDetail(value: unknown): Loaded<ChatDetail> {
  if (!isRecord(value) || (value.schemaVersion !== 3 && value.schemaVersion !== 4 && value.schemaVersion !== 5 && value.schemaVersion !== 6 && value.schemaVersion !== 7 && value.schemaVersion !== 8 && value.schemaVersion !== 9 && value.schemaVersion !== 10)
    || !Array.isArray(value.messages) || !Array.isArray(value.artifacts)
    || (value.schemaVersion >= 7 && !Array.isArray(value.toolReceipts))
    || (value.schemaVersion >= 8 && !('compactSnapshot' in value))
    || (value.schemaVersion >= 9 && !Array.isArray(value.draftAttachments))
    || (value.schemaVersion === 10 && !Array.isArray(value.turns))
    || (value.schemaVersion < 10 && value.turns !== undefined)) {
    throw new Error('Invalid chat detail.');
  }
  const version = value.schemaVersion;
  const chat = validateChat(value, 2);
  const messages: ChatMessage[] = value.messages.map((entry: unknown) => {
    if (!isRecord(entry) || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string') {
      throw new Error('Invalid chat message.');
    }
    if (version < 9 && entry.attachmentIds !== undefined) throw new Error('Invalid legacy chat message attachments.');
    if (entry.source !== undefined && entry.source !== 'runtime' && entry.source !== 'example') throw new Error('Invalid chat message source.');
    if (entry.functionsStateId !== undefined && (version < 7 || entry.role !== 'assistant' || typeof entry.functionsStateId !== 'string'
      || !entry.functionsStateId || entry.functionsStateId.length > 4096
      // eslint-disable-next-line no-control-regex -- Reject control characters in persisted provider state IDs.
      || /[\u0000-\u001f\u007f]/.test(entry.functionsStateId))) {
      throw new Error('Invalid assistant function state.');
    }
    const attachmentIds = entry.attachmentIds === undefined ? [] : entry.attachmentIds;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_CHAT_DRAFT_FILES
      || attachmentIds.some((id) => typeof id !== 'string')
      || new Set(attachmentIds).size !== attachmentIds.length
      || (attachmentIds.length > 0 && entry.role !== 'user')) {
      throw new Error('Invalid chat message attachments.');
    }
    return {
      id: requireId(entry.id), role: entry.role, text: entry.text, createdAt: requireTimestamp(entry.createdAt),
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.functionsStateId === undefined ? {} : { functionsStateId: entry.functionsStateId }),
      ...(attachmentIds.length ? { attachmentIds: attachmentIds.map(requireId) } : {}),
    };
  });
  const artifacts: ChatArtifact[] = value.artifacts.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 255
      || typeof entry.storedName !== 'string' || !/^[A-Za-z0-9_-]{1,128}(\.[A-Za-z0-9]{1,12})?$/.test(entry.storedName)
      || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0
      || (entry.messageId !== null && typeof entry.messageId !== 'string')) {
      throw new Error('Invalid chat artifact.');
    }
    return {
      id: requireId(entry.id), name: entry.name, storedName: entry.storedName, size: entry.size as number,
      ...(entry.sha256 === undefined ? {} : { sha256: typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)
        ? entry.sha256 : (() => { throw new Error('Invalid chat artifact hash.'); })() }),
      createdAt: requireTimestamp(entry.createdAt), messageId: entry.messageId === null ? null : requireId(entry.messageId),
    };
  });
  const messagesBeforeAttachmentMigration = structuredClone(messages);
  if (version < 9) {
    for (const message of messages) {
      if (message.role === 'user') {
        const migratedIds = artifacts.filter((artifact) => artifact.messageId === message.id).map((artifact) => artifact.id);
        if (migratedIds.length) message.attachmentIds = migratedIds;
      }
    }
  }
  const draftAttachmentValues: unknown[] = version >= 9 && Array.isArray(value.draftAttachments) ? value.draftAttachments : [];
  const draftAttachments = draftAttachmentValues.map(validateHomeDraftAttachment);
  if (draftAttachments.length > MAX_CHAT_DRAFT_FILES
    || new Set(draftAttachments.map((attachment) => attachment.id)).size !== draftAttachments.length
    || new Set(draftAttachments.map((attachment) => attachment.storedName)).size !== draftAttachments.length
    || draftAttachments.reduce((total, attachment) => total + attachment.size, 0) > MAX_CHAT_DRAFT_TOTAL_BYTES) {
    throw new Error('Duplicate or oversized chat draft attachments.');
  }
  const toolReceipts: ChatToolReceipt[] = (version >= 7 && Array.isArray(value.toolReceipts) ? value.toolReceipts : []).map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.receiptId !== 'string' || !/^[a-f0-9]{64}$/.test(entry.receiptId)
      || typeof entry.anchorMessageId !== 'string' || typeof entry.name !== 'string' || !entry.name || entry.name.length > 128
      || (entry.effectId !== undefined && (typeof entry.effectId !== 'string' || !/^[a-f0-9]{64}$/.test(entry.effectId)))
      || (version >= 7 && SIDE_EFFECT_TOOLS.has(entry.name) && typeof entry.effectId !== 'string')
      // eslint-disable-next-line no-control-regex -- Reject control characters in persisted tool names.
      || /[\u0000-\u001f\u007f]/.test(entry.name)
      || !isRecord(entry.arguments) || (entry.content !== null && typeof entry.content !== 'string')
      || (entry.functionsStateId !== null && typeof entry.functionsStateId !== 'string')
      || (entry.status !== 'pending' && entry.status !== 'completed' && entry.status !== 'unknown')
      || (entry.result !== null && typeof entry.result !== 'string')
      || (entry.status === 'pending' && entry.result !== null)
      || (entry.status !== 'pending' && typeof entry.result !== 'string')
      || typeof entry.createdAt !== 'string') {
      throw new Error('Invalid tool receipt.');
    }
    let argumentsText: string;
    try { argumentsText = JSON.stringify(entry.arguments); }
    catch { throw new Error('Invalid tool receipt arguments.'); }
    if (Buffer.byteLength(argumentsText, 'utf8') > MAX_TOOL_ARGUMENTS_BYTES || (entry.content !== null && Buffer.byteLength(entry.content, 'utf8') > 16_000)
      || (entry.functionsStateId !== null && (entry.functionsStateId.length === 0 || entry.functionsStateId.length > 4096
        // eslint-disable-next-line no-control-regex -- Reject control characters in persisted provider state IDs.
        || /[\u0000-\u001f\u007f]/.test(entry.functionsStateId)))
      || (entry.result !== null && (Buffer.byteLength(entry.result, 'utf8') > MAX_TOOL_RESULT_BYTES || !isJsonObjectText(entry.result)))) {
      throw new Error('Tool receipt exceeds its limits.');
    }
    return {
      receiptId: entry.receiptId,
      ...(entry.effectId === undefined ? {} : { effectId: entry.effectId }),
      anchorMessageId: requireId(entry.anchorMessageId),
      name: entry.name,
      arguments: structuredClone(entry.arguments),
      content: entry.content as string | null,
      functionsStateId: entry.functionsStateId as string | null,
      status: entry.status,
      result: entry.result as string | null,
      createdAt: requireTimestamp(entry.createdAt),
    };
  });
  const turns = (version >= 10 ? value.turns as unknown[] : []).map(validateChatTurnRecord);
  if (new Set(messages.map((message) => message.id)).size !== messages.length
    || new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length
    || artifacts.some((artifact) => artifact.messageId && !messages.some((message) => message.id === artifact.messageId))
    || new Set([...draftAttachments.map((attachment) => attachment.id), ...artifacts.map((artifact) => artifact.id)]).size !== draftAttachments.length + artifacts.length
    || new Set([...draftAttachments.map((attachment) => attachment.storedName), ...artifacts.map((artifact) => artifact.storedName)]).size !== draftAttachments.length + artifacts.length
    || messages.some((message) => message.attachmentIds?.some((attachmentId) => !artifacts.some((artifact) => artifact.id === attachmentId && artifact.messageId === message.id)))
    || artifacts.some((artifact) => artifact.messageId && !messages.find((message) => message.id === artifact.messageId)?.attachmentIds?.includes(artifact.id))
    || toolReceipts.length > MAX_TOOL_RECEIPTS_PER_CHAT
    || toolReceipts.some((receipt) => !messages.some((message) => message.id === receipt.anchorMessageId && message.role === 'user'))
    || new Set(toolReceipts.map((receipt) => `${receipt.receiptId}:${receipt.anchorMessageId}`)).size !== toolReceipts.length
    || turns.length > MAX_TURN_RECORDS_PER_CHAT
    || new Set(turns.map((turn) => turn.turnId)).size !== turns.length
    || turns.some((turn) => !messages.some((message) => message.id === turn.anchorMessageId && message.role === 'user')
      || turn.assistantMessageId !== null && messages.some((message) => message.id === turn.assistantMessageId && message.role !== 'assistant')
      || turn.status === 'completed' && turn.operation !== 'compaction'
        && !messages.some((message) => message.id === turn.assistantMessageId && message.role === 'assistant'))) {
    throw new Error('Duplicate or unbound chat resource.');
  }
  const nextTurnPermissionProfile = version === 3
    ? null
    : value.nextTurnPermissionProfile === null ? null : requirePermissionProfile(value.nextTurnPermissionProfile);
  let nextTurnSkillId: string | null = null;
  if (version >= 5 && value.nextTurnSkillId !== null) {
    if (!isSkillId(value.nextTurnSkillId)) throw new Error('Invalid next-turn Skill.');
    nextTurnSkillId = value.nextTurnSkillId;
  }
  let compactSnapshot = version >= 8 ? validateCompactSnapshot(value.compactSnapshot, messages) : null;
  if (compactSnapshot) {
    const storedChat = { ...chat, messages, artifacts, draftAttachments, toolReceipts, turns, nextTurnPermissionProfile, nextTurnSkillId,
      modelId: version >= 6 && value.modelId !== null ? requireModelId(value.modelId) : null,
      compactSnapshot };
    if (version < 9) {
      const legacyChat = { ...storedChat, messages: messagesBeforeAttachmentMigration };
      const legacyPrefix = buildCompactionPrefix(legacyChat, compactSnapshot.boundaryMessageId, compactSnapshot.coveredThroughMessageId);
      if (legacyPrefix.coveredThroughMessageId !== compactSnapshot.coveredThroughMessageId
        || legacyPrefix.coveredPrefixHash !== compactSnapshot.coveredPrefixHash) throw new Error('Invalid legacy compact prefix hash.');
      const migratedPrefix = buildCompactionPrefix(storedChat, compactSnapshot.boundaryMessageId, compactSnapshot.coveredThroughMessageId);
      compactSnapshot = { ...compactSnapshot, coveredPrefixHash: migratedPrefix.coveredPrefixHash };
    } else {
      const prefix = buildCompactionPrefix(storedChat, compactSnapshot.boundaryMessageId, compactSnapshot.coveredThroughMessageId);
      if (prefix.coveredThroughMessageId !== compactSnapshot.coveredThroughMessageId
        || prefix.coveredPrefixHash !== compactSnapshot.coveredPrefixHash) throw new Error('Invalid compact prefix hash.');
    }
  }
  return {
    value: { ...chat, messages, artifacts, draftAttachments, toolReceipts, turns, nextTurnPermissionProfile, nextTurnSkillId,
      modelId: version >= 6 && value.modelId !== null ? requireModelId(value.modelId) : null,
      compactSnapshot },
    needsWrite: version < 10,
  };
}

function summary(chat: ChatDetail): ChatSummary {
  return {
    id: chat.id, title: chat.title, projectId: chat.projectId, pinned: chat.pinned,
    archived: chat.archived, createdAt: chat.createdAt, updatedAt: chat.updatedAt, kind: chat.kind,
  };
}

function detailFile(chat: ChatDetail): Record<string, unknown> {
  return { schemaVersion: 10, ...chat };
}

function validateHomeDraftAttachment(value: unknown): HomeDraftAttachment {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255
    // eslint-disable-next-line no-control-regex -- Reject control characters in persisted attachment names.
    || /[\u0000-\u001f\u007f]/.test(value.name)
    || typeof value.storedName !== 'string' || !/^[A-Za-z0-9_-]{1,128}(\.[A-Za-z0-9]{1,12})?$/.test(value.storedName)
    || !Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_HOME_DRAFT_FILE_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Некорректный файл домашнего черновика.');
  }
  return {
    id: requireId(value.id), name: value.name, storedName: value.storedName, size: value.size as number,
    sha256: value.sha256, createdAt: requireTimestamp(value.createdAt),
  };
}

function validateProviderUploadEntry(value: unknown): ProviderUploadLedgerEntry {
  if (!isRecord(value) || typeof value.accountScope !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountScope)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255
    // eslint-disable-next-line no-control-regex -- Reject controls in persisted provider file metadata.
    || /[\u0000-\u001f\u007f]/.test(value.name)
    || typeof value.uploadFilename !== 'string'
    || !/^gcagent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(txt|md|pdf|png|jpe?g)$/i.test(value.uploadFilename)
    || typeof value.contentType !== 'string' || (value.kind !== 'document' && value.kind !== 'image')
    || !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 1
    || (value.sizeBytes as number) > LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || (value.state !== 'intent' && value.state !== 'uploaded' && value.state !== 'unknown' && value.state !== 'cleanup-pending')
    || (value.remoteFileId !== null && (typeof value.remoteFileId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.remoteFileId)))) {
    throw new Error('Некорректная запись загрузки файла.');
  }
  const expectedType = attachmentContentType(value.name);
  const uploadExtension = value.uploadFilename.split('.').pop()?.toLowerCase();
  const validExtensions = extensionsForContentType(value.contentType);
  if (!expectedType || expectedType.kind !== value.kind || expectedType.contentType !== value.contentType
    || value.state === 'intent' && value.remoteFileId !== null
    || value.state === 'unknown' && value.remoteFileId !== null
    || (value.state === 'uploaded' || value.state === 'cleanup-pending') && value.remoteFileId === null
    || (value.kind === 'image' && (value.sizeBytes as number) > PROVIDER_IMAGE_LIMIT_BYTES)
    || !validExtensions.includes(uploadExtension ?? '')) {
    throw new Error('Запись загрузки не соответствует типу или состоянию файла.');
  }
  return {
    accountScope: value.accountScope,
    attachmentId: requireId(value.attachmentId),
    uploadFilename: value.uploadFilename,
    name: value.name,
    contentType: value.contentType,
    kind: value.kind,
    sizeBytes: value.sizeBytes as number,
    sha256: value.sha256,
    state: value.state,
    remoteFileId: value.remoteFileId as string | null,
    createdAt: requireTimestamp(value.createdAt),
  };
}

function extensionsForContentType(contentType: string): string[] {
  switch (contentType) {
    case 'text/plain': return ['txt', 'md'];
    case 'application/pdf': return ['pdf'];
    case 'image/png': return ['png'];
    case 'image/jpeg': return ['jpg', 'jpeg'];
    default: return [];
  }
}

function parseProviderUploadFile(value: unknown): Loaded<ProviderUploadFile> {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)
    || value.entries.length > MAX_PROVIDER_UPLOAD_ENTRIES) throw new Error('Invalid provider upload ledger.');
  const entries = value.entries.map(validateProviderUploadEntry);
  if (new Set(entries.map((entry) => `${entry.accountScope}\0${entry.attachmentId}`)).size !== entries.length
    || new Set(entries.map((entry) => `${entry.accountScope}\0${entry.uploadFilename}`)).size !== entries.length) {
    throw new Error('Duplicate provider upload identity.');
  }
  return { value: { schemaVersion: 1, entries }, needsWrite: false };
}

async function loadProviderUploadLedger(filePath: string): Promise<Loaded<ProviderUploadFile>> {
  let info;
  try { info = await lstat(filePath); }
  catch (error) {
    if (isMissingFile(error)) return { value: { schemaVersion: 1, entries: [] }, needsWrite: true };
    throw error;
  }
  if (!info.isFile() || info.size > MAX_PROVIDER_UPLOAD_LEDGER_BYTES) throw storageError(filePath);
  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_PROVIDER_UPLOAD_LEDGER_BYTES) throw storageError(filePath);
  try { return parseProviderUploadFile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown); }
  catch { throw storageError(filePath); }
}

function validateAcceptedTurnRecord(value: unknown, allowLegacyAssistantId = true): AcceptedTurnInput {
  if (!isRecord(value) || !Array.isArray(value.messages) || !Number.isSafeInteger(value.historyBoundary)
    || (value.historyBoundary as number) < 1 || value.historyBoundary !== value.messages.length || !isRecord(value.reservation)) {
    throw new Error('Некорректный принятый ход домашнего черновика.');
  }
  const messages = value.messages.map((entry: unknown): ChatMessage => {
    if (!isRecord(entry) || (entry.role !== 'user' && entry.role !== 'assistant')
      || typeof entry.text !== 'string' || entry.text.length > 100_000
      || (entry.source !== undefined && entry.source !== 'runtime' && entry.source !== 'example')
      || (entry.functionsStateId !== undefined && (entry.role !== 'assistant' || typeof entry.functionsStateId !== 'string' || !entry.functionsStateId || entry.functionsStateId.length > 4096))) {
      throw new Error('Некорректное сообщение принятого хода.');
    }
    const attachmentIds = entry.attachmentIds === undefined ? [] : entry.attachmentIds;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_CHAT_DRAFT_FILES
      || attachmentIds.some((id) => typeof id !== 'string')
      || new Set(attachmentIds).size !== attachmentIds.length
      || (attachmentIds.length > 0 && entry.role !== 'user')) throw new Error('Некорректные вложения принятого сообщения.');
    return {
      id: requireId(entry.id), role: entry.role, text: entry.text, createdAt: requireTimestamp(entry.createdAt),
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.functionsStateId === undefined ? {} : { functionsStateId: entry.functionsStateId }),
      ...(attachmentIds.length ? { attachmentIds: attachmentIds.map(requireId) } : {}),
    };
  });
  const ids = messages.map((message) => message.id);
  if (new Set(ids).size !== ids.length) throw new Error('Повтор сообщения в принятом ходе.');
  const turnId = requireId(value.turnId);
  const legacyAssistantId = value.assistantMessageId === undefined;
  if (legacyAssistantId && !allowLegacyAssistantId) throw new Error('В принятом ходе отсутствует зарезервированный ответ.');
  const assistantMessageId = legacyAssistantId ? assistantMessageIdForLegacyTurn(turnId)
    : value.assistantMessageId === null ? null : requireId(value.assistantMessageId);
  const projectWorkingFolder = value.projectWorkingFolder === null ? null : requireFolderPath(value.projectWorkingFolder, 'Рабочая папка принятого хода');
  const revision = (input: unknown): number | null => {
    if (input === null) return null;
    if (!Number.isSafeInteger(input) || (input as number) < 0) throw new Error('Некорректная ревизия принятого хода.');
    return input as number;
  };
  const attachmentIds = value.attachmentIds === undefined ? [] : value.attachmentIds;
  if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_CHAT_DRAFT_FILES
    || attachmentIds.some((id) => typeof id !== 'string') || new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error('Некорректные вложения принятого хода.');
  }
  const turn: AcceptedTurnInput = {
    turnId, chatId: requireId(value.chatId),
    projectId: value.projectId === null ? null : requireId(value.projectId), projectWorkingFolder,
    messageId: requireId(value.messageId), assistantMessageId, historyBoundary: value.historyBoundary as number, messages,
    ...(attachmentIds.length ? { attachmentIds: attachmentIds.map(requireId) } : {}),
    permissionProfile: requirePermissionProfile(value.permissionProfile),
    modelId: value.modelId === null ? null : requireModelId(value.modelId),
    skillId: value.skillId === null ? null : (isSkillId(value.skillId) ? value.skillId : (() => { throw new Error('Некорректный Skill принятого хода.'); })()),
    reservation: {
      permissionProfileRevision: revision(value.reservation.permissionProfileRevision),
      skillRevision: revision(value.reservation.skillRevision),
    },
  };
  if (value.operation !== undefined) throw new Error('Домашний черновик не может принимать служебный ход.');
  const sourceMessage = messages.find((message) => message.id === turn.messageId && message.role === 'user');
  if (!sourceMessage) throw new Error('В принятом ходе отсутствует исходный запрос.');
  if (assistantMessageId === null || ids.includes(assistantMessageId)) throw new Error('Зарезервированный ответ принятого хода повреждён.');
  if (value.attachmentIds !== undefined && JSON.stringify(turn.attachmentIds ?? []) !== JSON.stringify(sourceMessage.attachmentIds ?? [])) {
    throw new Error('Вложения принятого сообщения не совпадают со снимком хода.');
  }
  return turn;
}

function validateHomeDraftRecord(value: unknown): HomeDraftRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0 || typeof value.text !== 'string' || value.text.length > 100_000
    || !Array.isArray(value.attachments) || value.attachments.length > MAX_HOME_DRAFT_FILES
    || (value.lastAcceptance !== null && !isRecord(value.lastAcceptance))) {
    throw new Error('Некорректный файл домашнего черновика.');
  }
  const attachments = value.attachments.map(validateHomeDraftAttachment);
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length
    || new Set(attachments.map((attachment) => attachment.storedName)).size !== attachments.length
    || attachments.reduce((total, attachment) => total + attachment.size, 0) > MAX_HOME_DRAFT_TOTAL_BYTES) {
    throw new Error('Повтор или превышение лимита файлов домашнего черновика.');
  }
  let lastAcceptance: HomeDraftRecord['lastAcceptance'] = null;
  if (value.lastAcceptance !== null) {
    const accepted = value.lastAcceptance as Record<string, unknown>;
    if (!Number.isSafeInteger(accepted.sourceRevision) || (accepted.sourceRevision as number) < 1
      || (accepted.sourceRevision as number) > (value.revision as number)) throw new Error('Некорректная ревизия отправки черновика.');
    lastAcceptance = {
      sourceRevision: accepted.sourceRevision as number,
      chatId: requireId(accepted.chatId),
      turn: validateAcceptedTurnRecord(accepted.turn),
    };
    if (lastAcceptance.turn.chatId !== lastAcceptance.chatId) throw new Error('Привязка принятого хода повреждена.');
  }
  return {
    revision: value.revision as number, text: value.text,
    projectId: value.projectId === null ? null : requireId(value.projectId),
    permissionProfile: value.permissionProfile === null ? null : requirePermissionProfile(value.permissionProfile),
    skillId: value.skillId === null ? null : (isSkillId(value.skillId) ? value.skillId : (() => { throw new Error('Некорректный Skill домашнего черновика.'); })()),
    modelId: value.modelId === null ? null : requireModelId(value.modelId),
    attachments, lastAcceptance,
  };
}

function parseHomeDraftFile(value: unknown): Loaded<HomeDraftRecord> {
  const legacyAcceptance = isRecord(value) && isRecord(value.lastAcceptance)
    && isRecord(value.lastAcceptance.turn) && !Object.prototype.hasOwnProperty.call(value.lastAcceptance.turn, 'assistantMessageId');
  return { value: validateHomeDraftRecord(value), needsWrite: legacyAcceptance };
}

async function loadHomeDraftFile(filePath: string): Promise<Loaded<HomeDraftRecord>> {
  let info;
  try { info = await lstat(filePath); }
  catch (error) {
    if (isMissingFile(error)) {
      return { value: { revision: 0, text: '', projectId: null, permissionProfile: null, skillId: null, modelId: null, attachments: [], lastAcceptance: null }, needsWrite: true };
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HOME_DRAFT_BYTES) throw storageError(filePath);
  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_HOME_DRAFT_BYTES) throw storageError(filePath);
  try { return parseHomeDraftFile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown); }
  catch { throw storageError(filePath); }
}

function validateHomeSendJournal(value: unknown): HomeSendJournal {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.sourceRevision)
    || (value.sourceRevision as number) < 1 || !Array.isArray(value.attachments) || !isRecord(value.nextDraft)) {
    throw new Error('Некорректный журнал отправки домашнего черновика.');
  }
  const rawChat = isRecord(value.chat) ? value.chat : null;
  const legacySchema8 = rawChat?.schemaVersion === 8;
  const legacySchema9 = rawChat?.schemaVersion === 9;
  let chat = validateChatDetail(value.chat).value;
  const turn = validateAcceptedTurnRecord(value.turn, legacySchema8 || legacySchema9);
  const attachments = value.attachments.map(validateHomeDraftAttachment);
  const nextDraft = validateHomeDraftRecord(value.nextDraft);
  const acceptance = nextDraft.lastAcceptance;
  const userMessage = chat.messages[0];
  const rawTurn = value.turn;
  const rawAcceptance = isRecord(value.nextDraft.lastAcceptance) && isRecord(value.nextDraft.lastAcceptance.turn)
    ? value.nextDraft.lastAcceptance.turn : null;
  const containsLegacyAttachmentIds = (messages: unknown): boolean => Array.isArray(messages)
    && messages.some((message) => isRecord(message) && Object.prototype.hasOwnProperty.call(message, 'attachmentIds'));
  const hasOwnAttachmentIds = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  if (legacySchema8 && (rawChat === null || containsLegacyAttachmentIds(rawChat.messages)
    || !isRecord(rawTurn) || hasOwnAttachmentIds(rawTurn, 'attachmentIds') || containsLegacyAttachmentIds(rawTurn.messages)
    || !rawAcceptance || hasOwnAttachmentIds(rawAcceptance, 'attachmentIds') || containsLegacyAttachmentIds(rawAcceptance.messages))) {
    throw new Error('Некорректное представление вложений в старом журнале отправки.');
  }
  if ((!legacySchema8 && !legacySchema9 && (!isRecord(rawTurn) || !Object.prototype.hasOwnProperty.call(rawTurn, 'assistantMessageId')
      || !rawAcceptance || !Object.prototype.hasOwnProperty.call(rawAcceptance, 'assistantMessageId')))
    || (legacySchema8 || legacySchema9) && (!isRecord(rawTurn) || Object.prototype.hasOwnProperty.call(rawTurn, 'assistantMessageId')
      || !rawAcceptance || Object.prototype.hasOwnProperty.call(rawAcceptance, 'assistantMessageId'))) {
    throw new Error('Представление зарезервированного ответа в журнале отправки повреждено.');
  }
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length
    || new Set(attachments.map((attachment) => attachment.storedName)).size !== attachments.length
    || attachments.reduce((total, attachment) => total + attachment.size, 0) > MAX_HOME_DRAFT_TOTAL_BYTES) {
    throw new Error('Повтор или превышение лимита файлов в журнале отправки.');
  }
  if (!userMessage || userMessage.role !== 'user' || chat.messages.length !== 1
    || turn.chatId !== chat.id || turn.messageId !== userMessage.id || turn.projectId !== chat.projectId
    || turn.modelId !== chat.modelId || turn.historyBoundary !== chat.messages.length
    || JSON.stringify(turn.messages) !== JSON.stringify(legacySchema8
      ? chat.messages.map((message) => {
        const legacyMessage = { ...message };
        delete legacyMessage.attachmentIds;
        return legacyMessage;
      }) : chat.messages)
    || (!legacySchema8 && JSON.stringify(turn.attachmentIds ?? []) !== JSON.stringify(attachments.map((attachment) => attachment.id)))
    || JSON.stringify(userMessage.attachmentIds ?? []) !== JSON.stringify(attachments.map((attachment) => attachment.id))
    || chat.draftAttachments.length !== 0
    || attachments.length !== chat.artifacts.length
    || attachments.some((attachment) => !chat.artifacts.some((artifact) => artifact.id === attachment.id
      && artifact.storedName === attachment.storedName && artifact.name === attachment.name
      && artifact.size === attachment.size && artifact.messageId === userMessage.id))
    || (chat.nextTurnPermissionProfile !== null && chat.nextTurnPermissionProfile !== turn.permissionProfile)
    || chat.nextTurnSkillId !== turn.skillId
    || nextDraft.revision !== (value.sourceRevision as number) + 1 || nextDraft.text !== '' || nextDraft.attachments.length !== 0
    || !acceptance || acceptance.sourceRevision !== value.sourceRevision || acceptance.chatId !== chat.id
    || JSON.stringify(acceptance.turn) !== JSON.stringify(turn)) {
    throw new Error('Связи журнала отправки домашнего черновика повреждены.');
  }
  const storedTurn = chat.turns.find((item) => item.turnId === turn.turnId);
  if (legacySchema8 || legacySchema9) {
    if (chat.turns.length !== 0) throw new Error('Старый журнал отправки неожиданно содержит записи ходов.');
    chat = { ...chat, turns: [recordForAcceptedTurn(turn)] };
  } else if (!storedTurn || storedTurn.anchorMessageId !== turn.messageId
    || storedTurn.assistantMessageId !== turn.assistantMessageId || storedTurn.status !== 'queued') {
    throw new Error('Связь принятого хода с записью чата повреждена.');
  }
  if (acceptance && (legacySchema8 || legacySchema9)) acceptance.turn = structuredClone(turn);
  return {
    schemaVersion: 1, operationId: requireId(value.operationId), sourceRevision: value.sourceRevision as number,
    chat, turn, attachments, nextDraft,
  };
}

function buildCompactionPrefix(chat: ChatDetail, boundaryMessageId: string, coveredThroughMessageId?: string): CompactionPrefix {
  const anchorIndex = chat.messages.findIndex((message) => message.id === boundaryMessageId && message.role === 'user');
  if (anchorIndex < 0) throw new Error('Граница сжатия отсутствует в истории чата.');
  const coveredIndex = coveredThroughMessageId === undefined
    ? (chat.messages[anchorIndex + 1]?.role === 'assistant' ? anchorIndex + 1 : anchorIndex)
    : chat.messages.findIndex((message) => message.id === coveredThroughMessageId);
  if (coveredIndex < anchorIndex) throw new Error('Покрытая граница отсутствует в истории чата.');
  const endIndex = coveredIndex + 1;
  const messages = structuredClone(chat.messages.slice(0, endIndex));
  const userAnchors = new Set(messages.filter((message) => message.role === 'user').map((message) => message.id));
  const receipts = chat.toolReceipts.filter((receipt) => userAnchors.has(receipt.anchorMessageId));
  const protocolHistory: ProviderProtocolExchange[] = receipts.map((receipt) => ({
    anchorMessageId: receipt.anchorMessageId,
    name: receipt.name,
    arguments: structuredClone(receipt.arguments),
    content: receipt.content,
    functionsStateId: receipt.functionsStateId,
    result: receipt.status === 'pending' ? UNKNOWN_TOOL_RESULT : receipt.result ?? UNKNOWN_TOOL_RESULT,
  }));
  const resolvedCoveredThroughMessageId = messages[messages.length - 1]?.id;
  if (!resolvedCoveredThroughMessageId) throw new Error('Пустой префикс сжатия.');
  const coveredPrefixHash = hashCompactionPrefix(messages, protocolHistory);
  return {
    messages,
    protocolHistory,
    coveredThroughMessageId: resolvedCoveredThroughMessageId,
    coveredPrefixHash,
  };
}

function isJsonObjectText(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed);
  } catch { return false; }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function detachProjectSkill(skillId: string | null, projectId: string): string | null {
  const match = skillId ? /^project\/([^/]+)\//.exec(skillId) : null;
  return match?.[1] === projectId ? null : skillId;
}

function skillForProject(skillId: string | null, projectId: string | null): string | null {
  const match = skillId ? /^project\/([^/]+)\//.exec(skillId) : null;
  return match && match[1] !== projectId ? null : skillId;
}

function validateProjectDeleteJournal(value: unknown): ProjectDeleteJournal {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.before) || !isRecord(value.after)) {
    throw new Error('Invalid project deletion journal.');
  }
  const operationId = requireId(value.operationId);
  const projectId = requireId(value.projectId);
  const readState = (input: Record<string, unknown>): ProjectDeleteState => {
    if (!isRecord(input.projects) || !Array.isArray(input.chats)
      || (input.instructionText !== null && typeof input.instructionText !== 'string')) {
      throw new Error('Invalid project deletion state.');
    }
    const projects = parseProjectFile(input.projects).value;
    const chats = input.chats.map((chat) => validateChatDetail(chat).value);
    return {
      projects,
      chats,
      instructionText: input.instructionText === null ? null : requireInstructions(input.instructionText),
    };
  };
  const before = readState(value.before);
  const after = readState(value.after);
  if (!before.projects.projects.some((project) => project.id === projectId)
    || after.projects.projects.some((project) => project.id === projectId)
    || !sameJson(before.projects.projects.filter((project) => project.id !== projectId), after.projects.projects)) {
    throw new Error('Project deletion journal has inconsistent project snapshots.');
  }
  const beforeById = new Map(before.chats.map((chat) => [chat.id, chat]));
  const afterById = new Map(after.chats.map((chat) => [chat.id, chat]));
  if (beforeById.size !== before.chats.length || afterById.size !== after.chats.length
    || beforeById.size !== afterById.size) {
    throw new Error('Project deletion journal has inconsistent chat snapshots.');
  }
  for (const [id, previous] of beforeById) {
    const next = afterById.get(id);
    if (!next || previous.projectId !== projectId || next.projectId !== null
      || !sameJson({ ...previous, projectId: null, updatedAt: next.updatedAt,
        nextTurnSkillId: detachProjectSkill(previous.nextTurnSkillId, projectId) }, next)) {
      throw new Error('Project deletion journal has inconsistent chat snapshots.');
    }
  }
  if (after.instructionText !== null) throw new Error('Project deletion journal has an invalid instruction target.');
  return { schemaVersion: 1, operationId, projectId, before, after };
}

function parseSettingsFile(value: unknown): Loaded<SettingsFile> {
  if (!isRecord(value)) throw new Error('Invalid settings file.');
  if (value.schemaVersion === 1) {
    return {
      value: { schemaVersion: 10, settings: validateSettings(value.settings, 1) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion === 2) {
    return {
      value: { schemaVersion: 10, settings: validateSettings(value.settings, 2) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion === 3) {
    return {
      value: { schemaVersion: 10, settings: validateSettings(value.settings, 3) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion === 4) {
    return {
      value: { schemaVersion: 10, settings: validateSettings(value.settings, 4) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion === 5) {
    return {
      value: { schemaVersion: 10, settings: validateSettings(value.settings, 5) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion === 6 || value.schemaVersion === 7 || value.schemaVersion === 8 || value.schemaVersion === 9) return { value: { schemaVersion: 10, settings: validateSettings(value.settings, value.schemaVersion) }, needsWrite: true };
  if (value.schemaVersion !== 10) throw new Error('Unknown settings file version.');
  return {
    value: { schemaVersion: 10, settings: validateSettings(value.settings, 10) },
    needsWrite: false,
  };
}

function validateProjectPatch(value: unknown): ProjectPatch {
  if (!isRecord(value)) throw new Error('Некорректные изменения проекта.');
  const patch: ProjectPatch = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'name') patch.name = requireName(item, 'Название проекта', 120);
    else if (key === 'pinned') patch.pinned = requireBoolean(item, 'Закрепление проекта');
    else if (key === 'archived') patch.archived = requireBoolean(item, 'Архив проекта');
    else if (key === 'workingFolder') patch.workingFolder = requireFolderPath(item, 'Рабочая папка проекта');
    else throw new Error('Недопустимое поле проекта.');
  }
  return patch;
}

function validateChatPatch(value: unknown): ChatPatch {
  if (!isRecord(value)) throw new Error('Некорректные изменения чата.');
  const patch: ChatPatch = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'title') patch.title = requireName(item, 'Название чата', 160);
    else if (key === 'projectId') patch.projectId = item === null ? null : requireId(item);
    else if (key === 'pinned') patch.pinned = requireBoolean(item, 'Закрепление чата');
    else if (key === 'archived') patch.archived = requireBoolean(item, 'Архив чата');
    else if (key === 'draft') {
      if (typeof item !== 'string') throw new Error('Черновик должен быть текстом.');
      patch.draft = item;
    } else if (key === 'nextTurnPermissionProfile') {
      patch.nextTurnPermissionProfile = item === null ? null : requirePermissionProfile(item);
    } else if (key === 'nextTurnSkillId') {
      if (item !== null && !isSkillId(item)) throw new Error('Некорректный идентификатор Skill для следующего хода.');
      patch.nextTurnSkillId = item as string | null;
    } else if (key === 'modelId') {
      patch.modelId = item === null ? null : requireModelId(item);
    } else throw new Error('Недопустимое поле чата.');
  }
  return patch;
}

function validateSettingsPatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) throw new Error('Некорректные настройки.');
  const patch: SettingsPatch = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'theme') patch.theme = validateTheme(item);
    else if (key === 'sidebarTransparent') patch.sidebarTransparent = requireBoolean(item, 'Прозрачность боковой панели');
    else if (key === 'sidebarVisible') patch.sidebarVisible = requireBoolean(item, 'Видимость боковой панели');
    else if (key === 'sidebarWidthPx') patch.sidebarWidthPx = item === null ? null : requireSidebarWidth(item);
    else if (key === 'browserPaneOpen') patch.browserPaneOpen = requireBoolean(item, 'Видимость браузера');
    else if (key === 'browserWidthPx') patch.browserWidthPx = item === null ? null : requireBrowserWidth(item);
    else if (key === 'browserTabs') patch.browserTabs = validateBrowserTabs(item);
    else if (key === 'browserActiveTabId') patch.browserActiveTabId = item === null ? null : requireId(item);
    else if (key === 'defaultProjectsFolder') patch.defaultProjectsFolder = requireFolderPath(item, 'Папка проектов');
    else if (key === 'preferredOpener' && (item === 'system' || item === 'explorer' || item === 'detected-app')) {
      patch.preferredOpener = item;
    } else if (key === 'defaultPermissionProfile') patch.defaultPermissionProfile = requirePermissionProfile(item);
    else if (key === 'defaultModelId') patch.defaultModelId = item === null ? null : requireModelId(item);
    else if (key === 'onboardingCompleted') patch.onboardingCompleted = requireBoolean(item, 'Статус первичной настройки');
    else if (key === 'microphoneConsent' && (item === 'unasked' || item === 'allowed' || item === 'declined')) patch.microphoneConsent = item;
    else if (key === 'notifications') patch.notifications = validateNotificationSettings(item);
    else throw new Error('Недопустимое поле настроек.');
  }
  return patch;
}

function requireInstructions(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_INSTRUCTION_BYTES) {
    throw new Error('Инструкция должна быть текстом размером не более 64 КБ.');
  }
  return value;
}

function requireInstructionRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Ревизия инструкции устарела или некорректна. Перечитайте файл перед сохранением.');
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
}

export async function openStore(directory: string, options: StoreOpenOptions = {}): Promise<LocalStore> {
  const { documentsDirectory = null, testFaults, instructionCommitter } = options;
  await mkdir(directory, { recursive: true });
  const storageRoot = await realpath(directory);
  const instructionIssues: string[] = [];
  const projectPath = join(storageRoot, 'projects.json');
  const chatPath = join(storageRoot, 'chats.json');
  const chatsDirectory = join(storageRoot, 'chats');
  const deletedChatsDirectory = join(storageRoot, 'deleted-chats');
  const projectDeleteJournalPath = join(storageRoot, 'project-delete.journal.json');
  const migrationMarker = join(storageRoot, 'chats.migrated');
  const settingsPath = join(storageRoot, 'settings.json');
  const usagePath = join(storageRoot, 'usage.json');
  const providerUploadPath = join(storageRoot, 'provider-uploads.json');
  const homeDraftPath = join(storageRoot, 'home-draft.json');
  const homeDraftFilesDirectory = join(storageRoot, 'home-draft', 'files');
  const homeSendJournalPath = join(storageRoot, 'home-send.journal.json');
  const writeOwnedAtomic = async (filePath: string, value: unknown, signal?: AbortSignal): Promise<void> => {
    await assertOwnedPath(storageRoot, filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await assertOwnedPath(storageRoot, filePath);
    await writeAtomic(filePath, value, signal);
  };
  const writeOwnedTextAtomic = async (filePath: string, value: string): Promise<void> => {
    await assertOwnedPath(storageRoot, filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await assertOwnedPath(storageRoot, filePath);
    await writeTextAtomic(filePath, value);
  };
  const hashFile = async (filePath: string): Promise<{ size: number; sha256: string }> => {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Файл черновика недоступен.');
    const bytes = await readFile(filePath);
    return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const readHomeSendJournal = async (): Promise<HomeSendJournal | null> => {
    await assertOwnedPath(storageRoot, homeSendJournalPath);
    let info;
    try { info = await lstat(homeSendJournalPath); }
    catch (error) { if (isMissingFile(error)) return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HOME_DRAFT_BYTES + 2_000_000) {
      throw storageError(homeSendJournalPath);
    }
    const bytes = await readFile(homeSendJournalPath);
    if (bytes.byteLength > MAX_HOME_DRAFT_BYTES + 2_000_000) throw storageError(homeSendJournalPath);
    try { return validateHomeSendJournal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown); }
    catch { throw storageError(homeSendJournalPath); }
  };
  const homeSendJournalFile = (journal: HomeSendJournal): Record<string, unknown> => ({
    schemaVersion: 1,
    operationId: journal.operationId,
    sourceRevision: journal.sourceRevision,
    chat: detailFile(journal.chat),
    turn: journal.turn,
    attachments: journal.attachments,
    nextDraft: { schemaVersion: 1, ...journal.nextDraft },
  });
  const applyHomeSendJournal = async (journal: HomeSendJournal): Promise<void> => {
    const chatFolderPath = join(chatsDirectory, journal.chat.id);
    const chatFilePath = join(chatFolderPath, 'chat.json');
    await assertOwnedPath(storageRoot, chatFilePath);
    const existingChatContents = await readFile(chatFilePath, 'utf8').catch((error: unknown) => {
      if (isMissingFile(error)) return null;
      throw error;
    });
    if (existingChatContents !== null) {
      let existingChat: ChatDetail;
      try { existingChat = validateChatDetail(JSON.parse(existingChatContents) as unknown).value; }
      catch { throw storageError(chatFilePath); }
      if (!sameJson(existingChat, journal.chat)) {
        throw new Error('Отправка приостановлена: чат с тем же ID уже содержит другие данные. Существующий чат сохранён.');
      }
    }
    const targetFilesDirectory = join(chatFolderPath, 'files');
    if (journal.attachments.length > 0) {
      await assertOwnedPath(storageRoot, targetFilesDirectory);
      await mkdir(targetFilesDirectory, { recursive: true });
    }
    for (const attachment of journal.attachments) {
      const source = join(homeDraftFilesDirectory, attachment.storedName);
      const target = join(targetFilesDirectory, attachment.storedName);
      await assertOwnedPath(storageRoot, source);
      await assertOwnedPath(storageRoot, target);
      const sourceHash = await hashFile(source);
      if (sourceHash.size !== attachment.size || sourceHash.sha256 !== attachment.sha256) {
        throw new Error('Копия подготовленного файла изменилась; исходный файл и черновик сохранены.');
      }
      await copyFile(source, target, constants.COPYFILE_EXCL).catch(async (error: unknown) => {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error;
        const existing = await hashFile(target);
        if (existing.size !== attachment.size || existing.sha256 !== attachment.sha256) {
          throw new Error('Копия файла чата не совпадает с принятым черновиком.');
        }
      });
      const copied = await hashFile(target);
      if (copied.size !== attachment.size || copied.sha256 !== attachment.sha256) {
        throw new Error('Копирование файла чата не прошло проверку целостности.');
      }
    }
    if (existingChatContents === null) await writeOwnedAtomic(chatFilePath, detailFile(journal.chat));
    await testFaults?.afterHomeSendStage?.('chat');
    await writeOwnedAtomic(homeDraftPath, { schemaVersion: 1, ...journal.nextDraft });
    await testFaults?.afterHomeSendStage?.('draft');
    await assertOwnedPath(storageRoot, homeSendJournalPath);
    await unlink(homeSendJournalPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
    await testFaults?.afterHomeSendStage?.('journal-cleared');
    for (const attachment of journal.attachments) {
      try {
        const source = join(homeDraftFilesDirectory, attachment.storedName);
        await assertOwnedPath(storageRoot, source);
        await unlink(source);
      } catch { /* The accepted chat is durable; an orphaned staged copy is safe to leave behind. */ }
    }
  };
  const readOwnedInstructions = async (filePath: string): Promise<string> => {
    await assertOwnedPath(storageRoot, filePath);
    return readInstructionsFile(filePath);
  };
  const readInstructionSnapshot = async (
    filePath: string,
    ownedRoot?: string,
    revalidatePath?: () => Promise<string | null>,
  ): Promise<InstructionSnapshot> => {
    if (ownedRoot) await assertOwnedPath(ownedRoot, filePath);
    if (revalidatePath && !samePath(await revalidatePath() ?? '', filePath)) {
      throw new Error('Рабочая папка проекта изменилась перед чтением AGENTS.md.');
    }
    const file = await lstat(filePath).catch((error: unknown) => {
      if (isMissingFile(error)) return null;
      throw error;
    });
    if (!file) {
      if (revalidatePath && !samePath(await revalidatePath() ?? '', filePath)) {
        throw new Error('Рабочая папка проекта изменилась во время чтения AGENTS.md.');
      }
      return { document: createInstructionDocument(filePath, null), exists: false };
    }
    if (!file.isFile()) throw new Error('Файл инструкции недоступен для чтения.');
    if (!samePath(await realpath(filePath), filePath)) throw new Error('Путь инструкции изменился и был перенаправлен. Файл не изменён.');
    if (file.size > MAX_INSTRUCTION_BYTES) {
      throw new Error('Инструкция должна быть текстом размером не более 64 КБ.');
    }
    const bytes = await readFile(filePath);
    if (bytes.byteLength > MAX_INSTRUCTION_BYTES) throw new Error('Инструкция должна быть текстом размером не более 64 КБ.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('Файл инструкции содержит некорректный UTF-8 и не изменён.'); }
    const verified = await lstat(filePath);
    if (!verified.isFile() || verified.isSymbolicLink() || verified.size !== bytes.byteLength
      || verified.dev !== file.dev || verified.ino !== file.ino || verified.mtimeMs !== file.mtimeMs
      || !samePath(await realpath(filePath), filePath)) {
      throw new Error('Файл инструкции изменился во время чтения. Перечитайте его перед сохранением.');
    }
    if (revalidatePath && !samePath(await revalidatePath() ?? '', filePath)) {
      throw new Error('Рабочая папка проекта изменилась во время чтения AGENTS.md.');
    }
    return { document: createInstructionDocument(filePath, requireInstructions(text)), exists: true };
  };
  const readInstructionsFile = async (filePath: string): Promise<string> => {
    return (await readInstructionSnapshot(filePath)).document.text;
  };
  const commitInstruction = async (
    path: string,
    workingFolder: string,
    relativePath: string,
    contents: string,
    current: InstructionSnapshot,
    expectedRevision: string,
  ): Promise<InstructionSaveResult> => {
    if (current.document.revision !== expectedRevision) {
      return { kind: 'conflict', phase: 'before-commit', current: current.document };
    }
    if (!instructionCommitter) throw new Error('Безопасный writer инструкций недоступен; файл не изменён.');
    const result = await instructionCommitter({
      workingFolder,
      relativePath,
      contents,
      expectedHash: current.exists ? instructionFileHash(current.document.text) : null,
    });
    if (result.kind === 'conflict-before') {
      return {
        kind: 'conflict',
        phase: 'before-commit',
        current: createInstructionDocument(path, result.currentText),
      };
    }
    if (result.kind === 'conflict-after') {
      return {
        kind: 'conflict',
        phase: 'after-commit',
        current: createInstructionDocument(path, result.currentText),
        preservedVersion: { path: result.preservedPath, text: result.preservedText },
      };
    }
    const written = await readInstructionSnapshot(path, workingFolder === storageRoot ? storageRoot : undefined);
    if (!written.exists || written.document.text !== contents) {
      return { kind: 'conflict', phase: 'after-commit', current: written.document };
    }
    return { kind: 'saved', document: written.document };
  };
  const saveInstructionCopy = async (scope: string, contents: string): Promise<string> => {
    if (!instructionCommitter) throw new Error('Безопасное сохранение отдельной копии недоступно.');
    const folder = join(storageRoot, 'instruction-conflicts', scope);
    await mkdir(folder, { recursive: true });
    await assertOwnedPath(storageRoot, folder);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const path = join(folder, `${randomUUID()}.md`);
      await assertOwnedPath(storageRoot, path);
      const current = await readInstructionSnapshot(path, storageRoot);
      if (current.exists) continue;
      const result = await commitInstruction(path, storageRoot, relative(storageRoot, path), contents, current, current.document.revision);
      if (result.kind === 'saved') return path;
      if (result.phase === 'after-commit') throw new Error('Не удалось проверить отдельную копию инструкции; её файл сохранён для проверки.');
    }
    throw new Error('Не удалось выделить новое имя для отдельной копии инструкции.');
  };
  const applyProjectDeleteJournal = async (journal: ProjectDeleteJournal): Promise<void> => {
    const projectInstructionsPath = join(storageRoot, 'project-instructions', journal.projectId, 'AGENTS.md');
    const projectContents = await readFile(projectPath, 'utf8').catch((error: unknown) => {
      if (isMissingFile(error)) throw storageError(projectPath);
      throw error;
    });
    let currentProjects: ProjectFile;
    try { currentProjects = parseProjectFile(JSON.parse(projectContents) as unknown).value; }
    catch { throw storageError(projectPath); }
    if (!sameJson(currentProjects, journal.before.projects) && !sameJson(currentProjects, journal.after.projects)) {
      throw new Error('Удаление проекта приостановлено: список проектов изменился после записи журнала. Данные сохранены.');
    }

    const afterChats = new Map(journal.after.chats.map((chat) => [chat.id, chat]));
    const chatWrites: Array<{ path: string; detail: ChatDetail }> = [];
    for (const before of journal.before.chats) {
      const after = afterChats.get(before.id);
      if (!after) throw new Error('Журнал удаления проекта повреждён.');
      const path = join(chatsDirectory, before.id, 'chat.json');
      await assertOwnedPath(storageRoot, path);
      const contents = await readFile(path, 'utf8').catch((error: unknown) => {
        if (isMissingFile(error)) throw storageError(path);
        throw error;
      });
      let current: ChatDetail;
      try { current = validateChatDetail(JSON.parse(contents) as unknown).value; }
      catch { throw storageError(path); }
      if (sameJson(current, before)) chatWrites.push({ path, detail: after });
      else if (!sameJson(current, after)) {
        throw new Error(`Удаление проекта приостановлено: чат ${before.id} изменился после записи журнала. Данные сохранены.`);
      }
    }

    await assertOwnedPath(storageRoot, projectInstructionsPath);
    const instructionInfo = await lstat(projectInstructionsPath).catch((error: unknown) => {
      if (isMissingFile(error)) return null;
      throw error;
    });
    if (instructionInfo && !instructionInfo.isFile()) throw new Error('Файл инструкции проекта недоступен для удаления.');
    const currentInstructions = instructionInfo ? await readInstructionsFile(projectInstructionsPath) : null;
    if (currentInstructions !== journal.before.instructionText && currentInstructions !== journal.after.instructionText) {
      throw new Error('Удаление проекта приостановлено: инструкция изменилась после записи журнала. Данные сохранены.');
    }

    for (const [index, item] of chatWrites.entries()) {
      await writeOwnedAtomic(item.path, detailFile(item.detail));
      await testFaults?.afterProjectDeleteStage?.('chat', index);
    }
    if (!sameJson(currentProjects, journal.after.projects)) {
      await writeOwnedAtomic(projectPath, journal.after.projects);
      await testFaults?.afterProjectDeleteStage?.('projects');
    }
    if (currentInstructions !== null) {
      await unlink(projectInstructionsPath);
      await testFaults?.afterProjectDeleteStage?.('instructions');
    }
    await assertOwnedPath(storageRoot, projectDeleteJournalPath);
    await unlink(projectDeleteJournalPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
    await testFaults?.afterProjectDeleteStage?.('journal-cleared');
  };
  const externalInstructionsPath = async (project: Project): Promise<string | null> => {
    if (!project.workingFolder) return null;
    const folder = await validateProjectFolder(project.workingFolder, documentsDirectory);
    return validateProjectInstructionsPath(folder);
  };
  const copyLegacyInstructions = async (project: Project): Promise<void> => {
    const legacy = await readOwnedInstructions(projectInstructionsPath(project.id));
    if (!legacy) return;
    const target = await externalInstructionsPath(project);
    if (!target) return;
    const workingFolder = project.workingFolder;
    if (!workingFolder) throw new Error('Рабочая папка проекта недоступна.');
    const current = await readInstructionSnapshot(target, undefined, () => externalInstructionsPath(project));
    if (current.exists) return;
    await testFaults?.beforeProjectInstructionCommit?.(target);
    const verifiedTarget = await externalInstructionsPath(project);
    if (verifiedTarget !== target) throw new Error('Рабочая папка проекта изменилась перед записью AGENTS.md.');
    if (!instructionCommitter) {
      instructionIssues.push(`Старые инструкции проекта ${project.name} сохранены в приложении (${projectInstructionsPath(project.id)}); безопасный writer недоступен, ${target} не изменён.`);
      return;
    }
    let result: InstructionSaveResult;
    try { result = await commitInstruction(target, workingFolder, 'AGENTS.md', legacy, current, current.document.revision); }
    catch {
      instructionIssues.push(`Перенос старых инструкций проекта ${project.name} не подтверждён; исходный текст сохранён в приложении (${projectInstructionsPath(project.id)}), проверьте ${target}.`);
      return;
    }
    if (result.kind === 'conflict') {
      instructionIssues.push(result.phase === 'after-commit'
        ? `Перенос AGENTS.md завершился конфликтом; сохранённая внешняя версия доступна по пути ${result.preservedVersion?.path ?? target}.`
        : `Перенос AGENTS.md остановлен: файл появился в папке проекта и не был заменён (${target}); исходный текст сохранён в приложении (${projectInstructionsPath(project.id)}).`);
    }
  };
  const copyInstructionsOnFolderChange = async (previous: Project, next: Project): Promise<string | null> => {
    let source: string | null;
    try { source = await externalInstructionsPath(previous); }
    catch (error) {
      if (!isUnavailableProjectFolder(error)) throw error;
      const backup = await readOwnedInstructions(projectInstructionsPath(previous.id));
      let copiedBackup = false;
      let backupConflict: Extract<InstructionSaveResult, { kind: 'conflict' }> | null = null;
      let backupConflictTarget: string | null = null;
      if (backup) {
        const target = await externalInstructionsPath(next);
        if (target) {
          const workingFolder = next.workingFolder;
          if (!workingFolder) throw new Error('Рабочая папка проекта недоступна.');
          const current = await readInstructionSnapshot(target, undefined, () => externalInstructionsPath(next));
          if (!current.exists && instructionCommitter) {
            let result: InstructionSaveResult;
            try { result = await commitInstruction(target, workingFolder, 'AGENTS.md', backup, current, current.document.revision); }
            catch {
              return `Папка проекта перепривязана, перенос инструкций не подтверждён; исходный текст сохранён в приложении (${projectInstructionsPath(previous.id)}), проверьте ${target}.`;
            }
            copiedBackup = result.kind === 'saved';
            if (result.kind === 'conflict') {
              backupConflict = result;
              backupConflictTarget = target;
            }
          }
        }
      }
      if (backupConflict?.phase === 'after-commit') {
        return `Папка проекта перепривязана с конфликтом инструкций. Резервный текст записан в новую папку; фактически вытесненная версия доступна по пути ${backupConflict.preservedVersion?.path ?? backupConflictTarget}.`;
      }
      if (backupConflict) {
        return `Папка проекта перепривязана, но AGENTS.md в новой папке появился во время переноса и не был заменён (${backupConflictTarget}). Резервный текст сохранён в приложении: ${projectInstructionsPath(previous.id)}.`;
      }
      if (backup && !copiedBackup) {
        return `Папка проекта перепривязана, но резервные инструкции не перенесены: безопасный writer недоступен или файл уже существует. Исходный текст сохранён в приложении (${projectInstructionsPath(previous.id)}); проверьте ${await externalInstructionsPath(next)}.`;
      }
      return copiedBackup
        ? 'Папка проекта перепривязана. Прежняя папка недоступна, поэтому в новую перенесена только резервная версия AGENTS.md; проверьте её содержимое.'
        : 'Папка проекта перепривязана, старые инструкции не перенесены: прежнюю папку не удалось проверить. Проверьте AGENTS.md в новой папке.';
    }
    let text: string | null;
    try { text = source ? await readInstructionsFile(source) : await readOwnedInstructions(projectInstructionsPath(previous.id)); }
    catch (error) {
      if (!isUnavailableProjectFolder(error)) throw error;
      return 'Папка проекта перепривязана, но старые инструкции не перенесены: прежняя папка недоступна.';
    }
    if (!text) return null;
    const target = await externalInstructionsPath(next);
    if (!target) return null;
    const workingFolder = next.workingFolder;
    if (!workingFolder) throw new Error('Рабочая папка проекта недоступна.');
    const current = await readInstructionSnapshot(target, undefined, () => externalInstructionsPath(next));
    if (current.exists) return null;
    if (!instructionCommitter) {
      return `Папка проекта перепривязана, но перенос AGENTS.md не выполнен: безопасный writer недоступен. Исходный файл сохранён по пути ${source ?? projectInstructionsPath(previous.id)}; новая папка ${target} не изменена.`;
    }
    await testFaults?.beforeProjectInstructionCommit?.(target);
    const verifiedTarget = await externalInstructionsPath(next);
    if (verifiedTarget !== target) throw new Error('Рабочая папка проекта изменилась перед записью AGENTS.md.');
    let result: InstructionSaveResult;
    try { result = await commitInstruction(target, workingFolder, 'AGENTS.md', text, current, current.document.revision); }
    catch {
      return `Папка проекта перепривязана, состояние переноса AGENTS.md не подтверждено. Исходный файл сохранён по пути ${source ?? projectInstructionsPath(previous.id)}; проверьте также ${target}.`;
    }
    if (result.kind === 'conflict') {
      if (result.phase === 'after-commit') {
        return `Папка проекта перепривязана с конфликтом инструкций. Текст из прежней папки записан, а фактически вытеснённая версия сохранена по пути ${result.preservedVersion?.path ?? target}.`;
      }
      const sourcePath = source ?? projectInstructionsPath(previous.id);
      return `Папка проекта перепривязана, но AGENTS.md в новой папке уже изменился и не был перезаписан (${target}). Переносимый текст остаётся по исходному пути: ${sourcePath}.`;
    }
    return null;
  };

  await Promise.all([
    assertOwnedPath(storageRoot, projectPath),
    assertOwnedPath(storageRoot, chatPath),
    assertOwnedPath(storageRoot, chatsDirectory),
    assertOwnedPath(storageRoot, deletedChatsDirectory),
    assertOwnedPath(storageRoot, projectDeleteJournalPath),
    assertOwnedPath(storageRoot, migrationMarker),
    assertOwnedPath(storageRoot, settingsPath),
    assertOwnedPath(storageRoot, usagePath),
    assertOwnedPath(storageRoot, providerUploadPath),
    assertOwnedPath(storageRoot, homeDraftPath),
    assertOwnedPath(storageRoot, homeDraftFilesDirectory),
    assertOwnedPath(storageRoot, homeSendJournalPath),
  ]);

  const pendingHomeSend = await readHomeSendJournal();
  if (pendingHomeSend) await applyHomeSendJournal(pendingHomeSend);

  const journalContents = await readFile(projectDeleteJournalPath, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  if (journalContents !== null) {
    let journal: ProjectDeleteJournal;
    try { journal = validateProjectDeleteJournal(JSON.parse(journalContents) as unknown); }
    catch { throw storageError(projectDeleteJournalPath); }
    await applyProjectDeleteJournal(journal);
  }

  // Parse every existing file before creating or migrating any of them.
  const [projectFile, settingsFile, usageFile, homeDraftFile, providerUploadFile] = await Promise.all([
    loadVersioned<ProjectFile>(projectPath, { schemaVersion: 2, projects: [] }, parseProjectFile),
    loadVersioned<SettingsFile>(settingsPath, {
      schemaVersion: 10,
      settings: {
        theme: 'emerald',
        sidebarTransparent: false,
        sidebarVisible: true,
        sidebarWidthPx: null,
        browserPaneOpen: false,
        browserWidthPx: null,
        browserTabs: [],
        browserActiveTabId: null,
        defaultProjectsFolder: null,
        preferredOpener: 'system',
        defaultPermissionProfile: 'ask',
        defaultModelId: null,
        onboardingCompleted: false,
        microphoneConsent: 'unasked',
        notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
      },
    }, parseSettingsFile),
    loadUsageLedger(usagePath),
    loadHomeDraftFile(homeDraftPath),
    loadProviderUploadLedger(providerUploadPath),
  ]);

  await assertOwnedPath(storageRoot, migrationMarker);
  const migrated = await readFile(migrationMarker, 'utf8').then(() => true, (error: unknown) => {
    if (isMissingFile(error)) return false;
    throw error;
  });
  if (!migrated) await assertOwnedPath(storageRoot, chatPath);
  const legacyContents = migrated ? null : await readFile(chatPath, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  let legacyChats: LegacyChat[] = [];
  if (legacyContents !== null) {
    try { legacyChats = parseChatFile(JSON.parse(legacyContents) as unknown).value.chats; }
    catch { throw storageError(chatPath); }
  }
  await assertOwnedPath(storageRoot, chatsDirectory);
  const entries = await readdir(chatsDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingFile(error)) return [];
    throw error;
  });
  const loadedChats: ChatDetail[] = [];
  const existingChatDetails = new Set<string>();
  const chatsNeedingMigration: ChatDetail[] = [];
  const storageIssues: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Каталог чата не может быть символической ссылкой.');
    if (!entry.isDirectory()) continue;
    const detailPath = join(chatsDirectory, entry.name, 'chat.json');
    await assertOwnedPath(storageRoot, detailPath);
    let contents: string;
    try { contents = await readFile(detailPath, 'utf8'); }
    catch (error) {
      if (!migrated && legacyChats.some((chat) => chat.id === entry.name) && isMissingFile(error)) continue;
      if (isMissingFile(error)) {
        storageIssues.push(`Чат ${entry.name} недоступен: файл истории отсутствует; каталог сохранён.`);
        continue;
      }
      throw error;
    }
    existingChatDetails.add(entry.name);
    try {
      const detail = validateChatDetail(JSON.parse(contents) as unknown);
      if (detail.value.id !== entry.name) throw new Error('Chat ID mismatch.');
      const recoveryAt = new Date().toISOString();
      const turns = detail.value.turns.map((turn) => turn.status === 'queued' || turn.status === 'running'
        ? { ...turn, status: 'interrupted' as const, endedAt: recoveryAt, error: turn.error ?? 'Приложение завершилось до сохранения ответа.' }
        : turn);
      const recoveredChat = turns.some((turn, index) => turn !== detail.value.turns[index])
        ? { ...detail.value, turns } : detail.value;
      loadedChats.push(recoveredChat);
      if (detail.needsWrite || recoveredChat !== detail.value) chatsNeedingMigration.push(recoveredChat);
    } catch {
      storageIssues.push(`Чат ${entry.name} недоступен: файл истории повреждён; каталог сохранён.`);
    }
  }

  const deletedChatsInfo = await lstat(deletedChatsDirectory).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  const deletedChatEntries = deletedChatsInfo?.isDirectory()
    ? await readdir(deletedChatsDirectory, { withFileTypes: true })
    : [];
  if (deletedChatsInfo && !deletedChatsInfo.isDirectory()) {
    storageIssues.push('Карантин удаления чатов недоступен; здоровые чаты загружены, данные карантина сохранены.');
  }
  for (const entry of deletedChatEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !/^[A-Za-z0-9_-]{1,128}\.deleted-[0-9a-f-]{36}$/i.test(entry.name)) {
      storageIssues.push('В карантине удаления чатов остались неизвестные данные; они сохранены без изменений.');
      continue;
    }
    const quarantinePath = join(deletedChatsDirectory, entry.name);
    try {
      await assertOwnedPath(storageRoot, quarantinePath);
      await rm(quarantinePath, { recursive: true });
    } catch {
      storageIssues.push(`Не удалось завершить очистку чата ${entry.name.split('.deleted-')[0]}; данные сохранены в карантине.`);
    }
  }

  if (!migrated) {
    if (legacyContents !== null) {
      await copyFile(chatPath, join(directory, 'chats.json.bak'), constants.COPYFILE_EXCL)
        .catch((error: unknown) => { if (!isRecord(error) || error.code !== 'EEXIST') throw error; });
    }
    for (const legacy of legacyChats) {
      if (existingChatDetails.has(legacy.id)) continue;
      const detail: ChatDetail = { ...legacy, nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], turns: [], toolReceipts: [], artifacts: [], draftAttachments: [], compactSnapshot: null };
      await writeOwnedAtomic(join(chatsDirectory, legacy.id, 'chat.json'), detailFile(detail));
      loadedChats.push(detail);
    }
    await writeOwnedTextAtomic(migrationMarker, '3\n');
  }

  for (const chat of chatsNeedingMigration) {
    await writeOwnedAtomic(join(chatsDirectory, chat.id, 'chat.json'), detailFile(chat));
  }

  if (projectFile.needsWrite) await writeOwnedAtomic(projectPath, projectFile.value);
  if (settingsFile.needsWrite) await writeOwnedAtomic(settingsPath, settingsFile.value);
  if (usageFile.needsWrite) await writeOwnedAtomic(usagePath, usageFile.value);
  if (providerUploadFile.needsWrite) await writeOwnedAtomic(providerUploadPath, providerUploadFile.value);
  const initialHomeDraft = homeDraftFile.needsWrite
    ? { ...homeDraftFile.value, modelId: settingsFile.value.settings.defaultModelId }
    : homeDraftFile.value;
  if (homeDraftFile.needsWrite) await writeOwnedAtomic(homeDraftPath, { schemaVersion: 1, ...initialHomeDraft });

  let projects = projectFile.value.projects;
  let chats = loadedChats;
  let settings = settingsFile.value.settings;
  let usageReceipts = usageFile.value.receipts;
  let providerUploadEntries = providerUploadFile.value.entries;
  let homeDraft = initialHomeDraft;
  const selectionRevisions = new Map(chats.map((chat) => [chat.id, { permissionProfile: 0, skill: 0 }]));
  const turnReservations = new Map<string, {
    chatId: string;
    permissionProfile: { value: PermissionProfile; revision: number } | null;
    skill: { value: string; revision: number } | null;
  }>();
  let writeQueue: Promise<void> = Promise.resolve();
  let pendingProjectDelete: ProjectDeleteJournal | null = null;
  let pendingHomeSendJournal: HomeSendJournal | null = null;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(async () => {
      if (pendingHomeSendJournal) {
        const journal = pendingHomeSendJournal;
        await applyHomeSendJournal(journal);
        pendingHomeSendJournal = null;
        homeDraft = journal.nextDraft;
        chats = chats.some((chat) => chat.id === journal.chat.id)
          ? chats.map((chat) => chat.id === journal.chat.id ? journal.chat : chat)
          : [...chats, journal.chat];
      }
      if (pendingProjectDelete) {
        const journal = pendingProjectDelete;
        await applyProjectDeleteJournal(journal);
        projects = journal.after.projects.projects;
        const updates = new Map(journal.after.chats.map((chat) => [chat.id, chat]));
        chats = chats.map((chat) => updates.get(chat.id) ?? chat);
        pendingProjectDelete = null;
      }
      return operation();
    });
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const saveProjects = async (next: Project[]): Promise<void> => {
    await writeOwnedAtomic(projectPath, { schemaVersion: 2, projects: next });
    projects = next;
  };
  const saveUsageReceipts = async (next: UsageReceipt[]): Promise<void> => {
    if (next.length > MAX_USAGE_RECEIPTS) throw new Error('Лимит истории usage достигнут; существующие измерения сохранены.');
    const value = { schemaVersion: 1 as const, receipts: next };
    if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8') > MAX_USAGE_LEDGER_BYTES) {
      throw new Error('Usage ledger превысил безопасный размер; существующие измерения сохранены.');
    }
    await writeOwnedAtomic(usagePath, value);
    usageReceipts = next;
  };
  const saveProviderUploadEntries = async (next: ProviderUploadLedgerEntry[]): Promise<void> => {
    if (next.length > MAX_PROVIDER_UPLOAD_ENTRIES) throw new Error('Лимит записей загрузки достигнут; история не сокращена.');
    const value: ProviderUploadFile = { schemaVersion: 1, entries: next };
    if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8') > MAX_PROVIDER_UPLOAD_LEDGER_BYTES) {
      throw new Error('Журнал загрузок превысил безопасный размер; существующие записи сохранены.');
    }
    await writeOwnedAtomic(providerUploadPath, value);
    providerUploadEntries = next;
  };
  const chatFolder = (id: string): string => join(chatsDirectory, requireId(id));
  const saveChat = async (chat: ChatDetail, signal?: AbortSignal): Promise<void> => {
    await writeOwnedAtomic(join(chatFolder(chat.id), 'chat.json'), detailFile(chat), signal);
    chats = chats.some((item) => item.id === chat.id)
      ? chats.map((item) => item.id === chat.id ? chat : item)
      : [...chats, chat];
  };
  const findChat = (idInput: unknown): ChatDetail => {
    const chat = chats.find((item) => item.id === requireId(idInput));
    if (!chat) throw new Error('Чат не найден.');
    return chat;
  };
  const validateAcceptedTurnBinding = (turn: AcceptedTurnInput): ChatDetail => {
    const chat = findChat(turn.chatId);
    if (turn.operation === 'compaction'
      && (turn.compactBoundaryMessageId !== turn.messageId
        || (chat.compactSnapshot?.id ?? null) !== (turn.compactExpectedSnapshotId ?? null))) {
      throw new Error('Сводка или её граница изменилась после постановки сжатия в очередь.');
    }
    if (turn.operation !== undefined && turn.operation !== 'compaction') throw new Error('Неизвестная операция хода.');
    if (chat.projectId !== turn.projectId) throw new Error('Чат перемещён после принятия хода; запрос остановлен.');
    const project = turn.projectId ? projects.find((item) => item.id === turn.projectId) : null;
    if (turn.projectId && (!project || project.workingFolder !== turn.projectWorkingFolder)) {
      throw new Error('Рабочая папка проекта изменилась после принятия хода; запрос остановлен.');
    }
    if (!turn.projectId && turn.projectWorkingFolder !== null) throw new Error('Привязка папки хода повреждена.');
    if (!chat.messages.some((message) => message.id === turn.messageId && message.role === 'user')) {
      throw new Error('Исходное сообщение принятого хода отсутствует.');
    }
    return chat;
  };
  const createStoredChat = async (projectId: string | null, kind: ChatKind): Promise<ChatDetail> => {
    const now = new Date().toISOString();
    const chat: ChatDetail = {
      id: randomUUID(), title: kind === 'image' ? 'Новое изображение' : 'Новый чат', projectId,
      pinned: false, archived: false, createdAt: now, updatedAt: now, draft: '', kind,
      nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: settings.defaultModelId, messages: [], turns: [], toolReceipts: [], artifacts: [], draftAttachments: [],
      compactSnapshot: null,
    };
    await saveChat(chat);
    selectionRevisions.set(chat.id, { permissionProfile: 0, skill: 0 });
    return chat;
  };
  const createAcceptedTurn = (
    detail: ChatDetail,
    turnId: string,
    messageId: string,
    operation?: 'compaction',
  ): AcceptedTurnInput => {
    if (detail.turns.length >= MAX_TURN_RECORDS_PER_CHAT) {
      throw new Error('Достигнут безопасный предел записей ходов в чате; история сохранена.');
    }
    const project = detail.projectId ? projects.find((item) => item.id === detail.projectId) : null;
    const revisions = selectionRevisions.get(detail.id) ?? { permissionProfile: 0, skill: 0 };
    const profileAlreadyReserved = [...turnReservations.values()].some((item) => item.chatId === detail.id
      && item.permissionProfile?.revision === revisions.permissionProfile);
    const skillAlreadyReserved = [...turnReservations.values()].some((item) => item.chatId === detail.id
      && item.skill?.revision === revisions.skill);
    const profileReservation = detail.nextTurnPermissionProfile !== null && !profileAlreadyReserved
      ? { value: detail.nextTurnPermissionProfile, revision: revisions.permissionProfile }
      : null;
    const skillReservation = detail.nextTurnSkillId !== null && !skillAlreadyReserved
      ? { value: detail.nextTurnSkillId, revision: revisions.skill }
      : null;
    const boundaryIndex = detail.messages.findIndex((message) => message.id === messageId && message.role === 'user');
    if (boundaryIndex < 0) throw new Error('Принятое сообщение отсутствует в истории чата.');
    const messages = operation === 'compaction' ? detail.messages.slice(0, boundaryIndex + 1) : detail.messages;
    const turn: AcceptedTurnInput = {
      turnId,
      chatId: detail.id,
      projectId: detail.projectId,
      projectWorkingFolder: project?.workingFolder ?? null,
      messageId,
      assistantMessageId: operation === 'compaction' ? null : randomUUID(),
      historyBoundary: messages.length,
      messages: structuredClone(messages),
      ...(messages[boundaryIndex]?.attachmentIds?.length ? { attachmentIds: [...messages[boundaryIndex]!.attachmentIds!] } : {}),
      permissionProfile: profileReservation?.value ?? settings.defaultPermissionProfile,
      modelId: detail.modelId ?? settings.defaultModelId,
      skillId: skillReservation?.value ?? null,
      reservation: {
        permissionProfileRevision: profileReservation?.revision ?? null,
        skillRevision: skillReservation?.revision ?? null,
      },
      ...(operation ? {
        operation,
        compactBoundaryMessageId: messageId,
        compactExpectedSnapshotId: detail.compactSnapshot?.id ?? null,
      } : {}),
    };
    turnReservations.set(turnId, { chatId: detail.id, permissionProfile: profileReservation, skill: skillReservation });
    return turn;
  };
  const appendLocalMessage = async (idInput: unknown, textInput: unknown): Promise<ChatDetail> => {
    const chat = findChat(idInput);
    if (typeof textInput !== 'string' || !textInput.trim() || textInput.length > 100_000) {
      throw new Error('Сообщение должно содержать от 1 до 100 000 символов.');
    }
    const now = new Date().toISOString();
    const message: ChatMessage = { id: randomUUID(), role: 'user', text: textInput.trim(), createdAt: now };
    const updated = { ...chat, draft: '', updatedAt: now, messages: [...chat.messages, message] };
    await saveChat(updated);
    return structuredClone(updated);
  };
  const saveHomeDraftRecord = async (next: HomeDraftRecord): Promise<void> => {
    const serialized = JSON.stringify({ schemaVersion: 1, ...next });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HOME_DRAFT_BYTES) {
      throw new Error('Домашний черновик превысил безопасный размер; предыдущая версия сохранена.');
    }
    await writeOwnedAtomic(homeDraftPath, { schemaVersion: 1, ...next });
    homeDraft = next;
  };
  const homeDraftInput = (input: unknown): HomeDraftInput => {
    if (!isRecord(input) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0
      || typeof input.text !== 'string' || input.text.length > 100_000) {
      throw new Error('Некорректный домашний черновик.');
    }
    return {
      revision: input.revision as number, text: input.text,
      projectId: input.projectId === null ? null : requireId(input.projectId),
      permissionProfile: input.permissionProfile === null ? null : requirePermissionProfile(input.permissionProfile),
      skillId: input.skillId === null ? null : (isSkillId(input.skillId) ? input.skillId : (() => { throw new Error('Некорректный Skill домашнего черновика.'); })()),
      modelId: input.modelId === null ? null : requireModelId(input.modelId),
    };
  };
  const saveSettings = async (next: Settings): Promise<void> => {
    await writeOwnedAtomic(settingsPath, { schemaVersion: 10, settings: next });
    settings = next;
  };
  const projectInstructionsPath = (idInput: unknown): string => {
    const id = requireId(idInput);
    if (!projects.some((project) => project.id === id)) throw new Error('Проект не найден.');
    return join(storageRoot, 'project-instructions', id, 'AGENTS.md');
  };

  return {
    listProjects: () => serialize(async () => projects.map((project) => ({ ...project }))),
    getHomeDraft: () => serialize(async () => structuredClone(homeDraft)),
    getHomeDraftAttachmentPath: (attachmentIdInput) => serialize(async () => {
      const attachment = homeDraft.attachments.find((item) => item.id === requireId(attachmentIdInput));
      if (!attachment) throw new Error('Подготовленный файл не найден.');
      const path = join(homeDraftFilesDirectory, attachment.storedName);
      await assertOwnedPath(storageRoot, path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.size) {
        throw new Error('Копия подготовленного файла недоступна или изменилась. Исходный файл сохранён.');
      }
      const copied = await hashFile(path);
      if (copied.sha256 !== attachment.sha256) throw new Error('Целостность копии подготовленного файла не подтверждена.');
      return path;
    }),
    saveHomeDraft: (input) => serialize(async () => {
      const nextInput = homeDraftInput(input);
      if (nextInput.revision === homeDraft.revision) {
        if (nextInput.text === homeDraft.text && nextInput.projectId === homeDraft.projectId
          && nextInput.permissionProfile === homeDraft.permissionProfile && nextInput.skillId === homeDraft.skillId
          && nextInput.modelId === homeDraft.modelId) return structuredClone(homeDraft);
        throw new Error('Домашний черновик изменился; сохраните последнюю версию.');
      }
      if (nextInput.revision !== homeDraft.revision + 1) throw new Error('Ревизия домашнего черновика устарела.');
      if (nextInput.projectId && !projects.some((project) => project.id === nextInput.projectId && !project.archived)) {
        throw new Error('Выбранный проект недоступен.');
      }
      const next: HomeDraftRecord = { ...nextInput, attachments: homeDraft.attachments, lastAcceptance: homeDraft.lastAcceptance };
      const validated = validateHomeDraftRecord({ schemaVersion: 1, ...next });
      await saveHomeDraftRecord(validated);
      return structuredClone(homeDraft);
    }),
    stageHomeDraftFile: (sourcePath) => serialize(async () => {
      if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0') || !isAbsolute(sourcePath)) {
        throw new Error('Выберите доступный локальный файл.');
      }
      if (homeDraft.attachments.length >= MAX_HOME_DRAFT_FILES) throw new Error('В домашний черновик можно добавить не более 32 файлов.');
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > MAX_HOME_DRAFT_FILE_BYTES) {
        throw new Error('Выбранный файл недоступен или превышает лимит 25 МиБ.');
      }
      inspectLocalAttachmentContent(basename(sourcePath), await readFile(sourcePath));
      const sourceRealPath = await realpath(sourcePath);
      if (!samePath(sourceRealPath, sourcePath)) throw new Error('Символические ссылки на файлы не поддерживаются.');
      if (homeDraft.attachments.reduce((total, attachment) => total + attachment.size, 0) + sourceInfo.size > MAX_HOME_DRAFT_TOTAL_BYTES) {
        throw new Error('Подготовленные файлы превышают локальный лимит 100 МиБ.');
      }
      const id = randomUUID();
      const extension = extname(sourcePath).match(/^\.[A-Za-z0-9]{1,12}$/)?.[0].toLowerCase() ?? '';
      const storedName = `${id}${extension}`;
      const target = join(homeDraftFilesDirectory, storedName);
      await assertOwnedPath(storageRoot, target);
      await mkdir(homeDraftFilesDirectory, { recursive: true });
      await assertOwnedPath(storageRoot, target);
      try {
        await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
        const sourceAfter = await lstat(sourcePath);
        if (!sourceAfter.isFile() || sourceAfter.isSymbolicLink() || sourceAfter.size !== sourceInfo.size
          || sourceAfter.mtimeMs !== sourceInfo.mtimeMs || !samePath(await realpath(sourcePath), sourceRealPath)) {
          throw new Error('Исходный файл изменился во время подготовки; он не изменён.');
        }
        const copied = await hashFile(target);
        const attachment: HomeDraftAttachment = {
          id, name: requireName(basename(sourcePath), 'Имя файла', 255), storedName,
          size: copied.size, sha256: copied.sha256, createdAt: new Date().toISOString(),
        };
        const next = validateHomeDraftRecord({ schemaVersion: 1, ...homeDraft,
          revision: homeDraft.revision + 1, attachments: [...homeDraft.attachments, attachment] });
        await saveHomeDraftRecord(next);
        return structuredClone(homeDraft);
      } catch (error) {
        await unlink(target).catch(() => undefined);
        throw error;
      }
    }),
    removeHomeDraftFile: (idInput) => serialize(async () => {
      const id = requireId(idInput);
      const attachment = homeDraft.attachments.find((item) => item.id === id);
      if (!attachment) throw new Error('Подготовленный файл не найден.');
      const next = validateHomeDraftRecord({ schemaVersion: 1, ...homeDraft,
        revision: homeDraft.revision + 1, attachments: homeDraft.attachments.filter((item) => item.id !== id) });
      await saveHomeDraftRecord(next);
      const path = join(homeDraftFilesDirectory, attachment.storedName);
      await assertOwnedPath(storageRoot, path);
      await unlink(path).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
      return structuredClone(homeDraft);
    }),
    stageChatDraftFile: (chatIdInput, sourcePath) => serialize(async () => {
      const chat = findChat(chatIdInput);
      if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0') || !isAbsolute(sourcePath)) {
        throw new Error('Выберите доступный локальный файл.');
      }
      if (chat.draftAttachments.length >= MAX_CHAT_DRAFT_FILES) throw new Error('В черновик можно добавить не более 32 файлов.');
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > MAX_HOME_DRAFT_FILE_BYTES) {
        throw new Error('Выбранный файл недоступен или превышает локальный лимит 25 МиБ.');
      }
      const sourceRealPath = await realpath(sourcePath);
      if (!samePath(sourceRealPath, sourcePath)) throw new Error('Символические ссылки на файлы не поддерживаются.');
      if (chat.draftAttachments.reduce((total, attachment) => total + attachment.size, 0) + sourceInfo.size > MAX_CHAT_DRAFT_TOTAL_BYTES) {
        throw new Error('Подготовленные файлы превышают локальный лимит 100 МиБ.');
      }
      const name = requireName(basename(sourcePath), 'Имя файла', 255);
      inspectLocalAttachmentContent(name, await readFile(sourcePath));
      const id = randomUUID();
      const extension = extname(sourcePath).match(/^\.[A-Za-z0-9]{1,12}$/)?.[0].toLowerCase() ?? '';
      const storedName = `${id}${extension}`;
      const target = join(chatFolder(chat.id), 'files', storedName);
      let copied = false;
      try {
        await assertOwnedPath(storageRoot, target);
        await mkdir(dirname(target), { recursive: true });
        await assertOwnedPath(storageRoot, target);
        await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
        copied = true;
        const sourceAfter = await lstat(sourcePath);
        if (!sourceAfter.isFile() || sourceAfter.isSymbolicLink() || sourceAfter.size !== sourceInfo.size
          || sourceAfter.mtimeMs !== sourceInfo.mtimeMs || !samePath(await realpath(sourcePath), sourceRealPath)) {
          throw new Error('Исходный файл изменился во время подготовки; он не изменён.');
        }
        const copiedFile = await hashFile(target);
        if (copiedFile.size !== sourceInfo.size) throw new Error('Копия файла изменилась при подготовке.');
        const attachment: HomeDraftAttachment = {
          id, name, storedName, size: copiedFile.size, sha256: copiedFile.sha256, createdAt: new Date().toISOString(),
        };
        const updated = validateChatDetail({ ...detailFile(chat), draftAttachments: [...chat.draftAttachments, attachment] }).value;
        await saveChat({ ...updated, updatedAt: new Date().toISOString() });
        return structuredClone(findChat(chat.id));
      } catch (error) {
        if (copied) await assertOwnedPath(storageRoot, target).then(() => unlink(target)).catch(() => undefined);
        throw error;
      }
    }),
    removeChatDraftFile: (chatIdInput, attachmentIdInput) => serialize(async () => {
      const chat = findChat(chatIdInput);
      const id = requireId(attachmentIdInput);
      const attachment = chat.draftAttachments.find((item) => item.id === id);
      if (!attachment) throw new Error('Подготовленный файл не найден.');
      const updated = { ...chat, updatedAt: new Date().toISOString(), draftAttachments: chat.draftAttachments.filter((item) => item.id !== id) };
      await saveChat(updated);
      const path = join(chatFolder(chat.id), 'files', attachment.storedName);
      await assertOwnedPath(storageRoot, path);
      await unlink(path).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
      return structuredClone(findChat(chat.id));
    }),
    getChatDraftAttachmentPath: (chatIdInput, attachmentIdInput) => serialize(async () => {
      const chat = findChat(chatIdInput);
      const attachment = chat.draftAttachments.find((item) => item.id === requireId(attachmentIdInput));
      if (!attachment) throw new Error('Подготовленный файл не найден.');
      const path = join(chatFolder(chat.id), 'files', attachment.storedName);
      await assertOwnedPath(storageRoot, path);
      const fileInfo = await lstat(path);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== attachment.size) {
        throw new Error('Копия подготовленного файла недоступна или изменилась. Исходный файл сохранён.');
      }
      const copiedFile = await hashFile(path);
      if (copiedFile.sha256 !== attachment.sha256) throw new Error('Целостность копии подготовленного файла не подтверждена.');
      return path;
    }),
    acceptHomeDraft: (expectedRevisionInput, turnIdInput, expectedModelIdInput, validateBeforeCommit) => serialize(async () => {
      if (!Number.isSafeInteger(expectedRevisionInput) || (expectedRevisionInput as number) < 1) {
        throw new Error('Ревизия домашнего черновика некорректна.');
      }
      const expectedRevision = expectedRevisionInput as number;
      if (homeDraft.lastAcceptance?.sourceRevision === expectedRevision) {
        return { detail: structuredClone(findChat(homeDraft.lastAcceptance.chatId)), turn: structuredClone(homeDraft.lastAcceptance.turn), newlyAccepted: false };
      }
      if (expectedRevision !== homeDraft.revision) throw new Error('Черновик изменился перед отправкой; отправьте актуальную версию.');
      const effectiveModelId = homeDraft.modelId ?? settings.defaultModelId;
      if (expectedModelIdInput !== undefined && expectedModelIdInput !== effectiveModelId) {
        throw new Error('Модель изменилась во время проверки файлов. Черновик сохранён; проверьте выбор и отправьте ещё раз.');
      }
      const text = homeDraft.text.trim();
      if ((!text && homeDraft.attachments.length === 0) || text.length > 100_000) throw new Error('Введите сообщение или прикрепите файл перед отправкой.');
      const project = homeDraft.projectId ? projects.find((item) => item.id === homeDraft.projectId && !item.archived) : null;
      if (homeDraft.projectId && !project) throw new Error('Выбранный проект недоступен.');
      if (homeDraft.skillId && skillForProject(homeDraft.skillId, homeDraft.projectId) !== homeDraft.skillId) {
        throw new Error('Выбранный Skill не относится к этому проекту.');
      }
      const turnId = requireId(turnIdInput);
      const now = new Date().toISOString();
      const message: ChatMessage = {
        id: randomUUID(), role: 'user', text, createdAt: now,
        ...(homeDraft.attachments.length ? { attachmentIds: homeDraft.attachments.map((attachment) => attachment.id) } : {}),
      };
      const chatId = randomUUID();
      const baseChat: ChatDetail = {
        id: chatId,
        title: text ? requireName(text.split(/\r?\n/, 1)[0]?.slice(0, 60) ?? '', 'Название чата', 160) : 'Прикреплённые файлы',
        projectId: homeDraft.projectId, pinned: false, archived: false, createdAt: now, updatedAt: now,
        draft: '', kind: 'text',
        nextTurnPermissionProfile: homeDraft.permissionProfile === settings.defaultPermissionProfile ? null : homeDraft.permissionProfile,
        nextTurnSkillId: homeDraft.skillId,
        modelId: homeDraft.modelId ?? settings.defaultModelId,
        messages: [message], turns: [], toolReceipts: [], draftAttachments: [],
        artifacts: homeDraft.attachments.map((attachment) => ({
          id: attachment.id, name: attachment.name, storedName: attachment.storedName,
          size: attachment.size, sha256: attachment.sha256, createdAt: attachment.createdAt, messageId: message.id,
        })),
        compactSnapshot: null,
      };
      const turn = createAcceptedTurn(baseChat, turnId, message.id);
      const chat: ChatDetail = { ...baseChat, turns: [recordForAcceptedTurn(turn)] };
      const nextDraft: HomeDraftRecord = {
        ...homeDraft, revision: homeDraft.revision + 1, text: '', attachments: [],
        lastAcceptance: { sourceRevision: expectedRevision, chatId, turn: structuredClone(turn) },
      };
      let journal: HomeSendJournal;
      try {
        journal = validateHomeSendJournal({
          schemaVersion: 1, operationId: randomUUID(), sourceRevision: expectedRevision,
          chat: detailFile(chat), turn, attachments: homeDraft.attachments, nextDraft: { schemaVersion: 1, ...nextDraft },
        });
      } catch (error) {
        turnReservations.delete(turn.turnId);
        throw error;
      }
      try {
        await testFaults?.beforeHomeSendJournal?.();
        validateBeforeCommit?.();
        await writeOwnedAtomic(homeSendJournalPath, homeSendJournalFile(journal));
      } catch (error) {
        turnReservations.delete(turn.turnId);
        throw error;
      }
      pendingHomeSendJournal = journal;
      await testFaults?.afterHomeSendStage?.('journal');
      await applyHomeSendJournal(journal);
      pendingHomeSendJournal = null;
      homeDraft = journal.nextDraft;
      chats = [...chats, journal.chat];
      return { detail: structuredClone(journal.chat), turn: structuredClone(turn), newlyAccepted: true };
    }),
    createProject: (nameInput, folderInput = null) => serialize(async () => {
      const now = new Date().toISOString();
      const requestedFolder = requireFolderPath(folderInput, 'Рабочая папка проекта');
      const project: Project = {
        id: randomUUID(),
        name: requireName(nameInput, 'Название проекта', 120),
        pinned: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        workingFolder: requestedFolder ? await validateProjectFolder(requestedFolder, documentsDirectory) : null,
      };
      await saveProjects([...projects, project]);
      return { ...project };
    }),
    updateProject: (idInput, patchInput) => serialize(async () => {
      const id = requireId(idInput);
      let patch = validateProjectPatch(patchInput);
      if (patch.workingFolder !== undefined && patch.workingFolder !== null) {
        patch = { ...patch, workingFolder: await validateProjectFolder(patch.workingFolder, documentsDirectory) };
      }
      const project = projects.find((item) => item.id === id);
      if (!project) throw new Error('Проект не найден.');
      const updated = { ...project, ...patch, updatedAt: new Date().toISOString() };
      let warning: string | null = null;
      if (patch.workingFolder && patch.workingFolder !== project.workingFolder) {
        await externalInstructionsPath(updated);
        warning = await copyInstructionsOnFolderChange(project, updated);
      }
      await saveProjects(projects.map((item) => item.id === id ? updated : item));
      return { project: { ...updated }, warning };
    }),
    migrateProjectInstructions: (idInput) => serialize(async () => {
      const project = projects.find((item) => item.id === requireId(idInput));
      if (!project) throw new Error('Проект не найден.');
      await externalInstructionsPath(project);
      await copyLegacyInstructions(project);
    }),
    projectInstructionsBackupPath: (idInput) => serialize(async () => {
      const project = projects.find((item) => item.id === requireId(idInput));
      if (!project) throw new Error('Проект не найден.');
      const target = await externalInstructionsPath(project);
      if (!target) return null;
      const legacyPath = projectInstructionsPath(project.id);
      const legacy = await readOwnedInstructions(legacyPath);
      if (!legacy) return null;
      const current = await lstat(target).catch((error: unknown) => {
        if (isMissingFile(error)) return null;
        throw error;
      });
      if (!current) return null;
      await readInstructionsFile(target);
      return legacyPath;
    }),
    deleteProject: (idInput) => serialize(async () => {
      const id = requireId(idInput);
      if (!projects.some((project) => project.id === id)) throw new Error('Проект не найден.');
      const instructionsPath = projectInstructionsPath(id);
      await assertOwnedPath(storageRoot, instructionsPath);
      const instructions = await lstat(instructionsPath).catch((error: unknown) => {
        if (isMissingFile(error)) return null;
        throw error;
      });
      if (instructions && !instructions.isFile()) throw new Error('Файл инструкции проекта недоступен для удаления.');
      const linkedChats = chats.filter((item) => item.projectId === id);
      const now = new Date().toISOString();
      const instructionText = instructions ? await readInstructionsFile(instructionsPath) : null;
      const before: ProjectDeleteState = {
        projects: { schemaVersion: 2, projects: projects.map((item) => ({ ...item })) },
        chats: linkedChats.map((item) => structuredClone(item)),
        instructionText,
      };
      const after: ProjectDeleteState = {
        projects: { schemaVersion: 2, projects: projects.filter((item) => item.id !== id) },
        chats: linkedChats.map((chat) => ({
          ...chat,
          projectId: null,
          nextTurnSkillId: detachProjectSkill(chat.nextTurnSkillId, id),
          updatedAt: now,
        })),
        instructionText: null,
      };
      const journalRecord = {
        schemaVersion: 1,
        operationId: randomUUID(),
        projectId: id,
        before: { ...before, chats: before.chats.map(detailFile) },
        after: { ...after, chats: after.chats.map(detailFile) },
      };
      const journal = validateProjectDeleteJournal(journalRecord);
      await writeOwnedAtomic(projectDeleteJournalPath, journalRecord);
      pendingProjectDelete = journal;
      await testFaults?.afterProjectDeleteStage?.('journal');
      await applyProjectDeleteJournal(journal);
      projects = journal.after.projects.projects;
      const updates = new Map(journal.after.chats.map((chat) => [chat.id, chat]));
      chats = chats.map((chat) => updates.get(chat.id) ?? chat);
      pendingProjectDelete = null;
    }),
    listChats: () => serialize(async () => chats.map(summary)),
    getChat: (id) => serialize(async () => structuredClone(findChat(id))),
    getMessagesThrough: (chatId, messageId) => serialize(async () => {
      const detail = findChat(chatId);
      const anchor = requireId(messageId);
      const endIndex = detail.messages.findIndex((message) => message.id === anchor && message.role === 'user');
      if (endIndex < 0) throw new Error('Принятое сообщение не найдено в истории чата.');
      return structuredClone(detail.messages.slice(0, endIndex + 1));
    }),
    getCompactionPrefix: (chatIdInput, boundaryMessageIdInput) => serialize(async () => {
      const chat = findChat(chatIdInput);
      return buildCompactionPrefix(chat, requireId(boundaryMessageIdInput));
    }),
    getToolProtocolThrough: (chatId, messageId) => serialize(async () => {
      const detail = findChat(chatId);
      const anchor = requireId(messageId);
      const endIndex = detail.messages.findIndex((message) => message.id === anchor && message.role === 'user');
      if (endIndex < 0) throw new Error('Принятое сообщение не найдено в истории чата.');
      const visibleAnchors = new Set(detail.messages.slice(0, endIndex + 1)
        .filter((message) => message.role === 'user').map((message) => message.id));
      return detail.toolReceipts.filter((receipt) => visibleAnchors.has(receipt.anchorMessageId)).map((receipt) => ({
        anchorMessageId: receipt.anchorMessageId,
        name: receipt.name,
        arguments: structuredClone(receipt.arguments),
        content: receipt.content,
        functionsStateId: receipt.functionsStateId,
        result: receipt.status === 'pending' ? UNKNOWN_TOOL_RESULT : receipt.result ?? UNKNOWN_TOOL_RESULT,
      }));
    }),
    beginToolReceipt: (chatIdInput, messageIdInput, receiptInput) => serialize(async () => {
      const chat = findChat(chatIdInput);
      const messageId = requireId(messageIdInput);
      if (!chat.messages.some((message) => message.id === messageId && message.role === 'user')) {
        throw new Error('Инструмент не привязан к принятому сообщению.');
      }
      if (!receiptInput || typeof receiptInput.receiptId !== 'string' || !/^[a-f0-9]{64}$/.test(receiptInput.receiptId)
        || typeof receiptInput.name !== 'string' || !receiptInput.name || receiptInput.name.length > 128
        || (receiptInput.effectId !== undefined && (typeof receiptInput.effectId !== 'string' || !/^[a-f0-9]{64}$/.test(receiptInput.effectId)))
        || (SIDE_EFFECT_TOOLS.has(receiptInput.name) && typeof receiptInput.effectId !== 'string')
        // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted tool names before persisting receipts.
        || /[\u0000-\u001f\u007f]/.test(receiptInput.name) || !isRecord(receiptInput.arguments)
        || (receiptInput.content !== null && typeof receiptInput.content !== 'string')
        || (receiptInput.functionsStateId !== null && typeof receiptInput.functionsStateId !== 'string')) {
        throw new Error('Некорректный идентификатор инструмента.');
      }
      let argumentText: string;
      try { argumentText = JSON.stringify(receiptInput.arguments); }
      catch { throw new Error('Некорректные аргументы инструмента.'); }
      if (Buffer.byteLength(argumentText, 'utf8') > MAX_TOOL_ARGUMENTS_BYTES || (receiptInput.content !== null && Buffer.byteLength(receiptInput.content, 'utf8') > 16_000)
        || (receiptInput.functionsStateId !== null && (receiptInput.functionsStateId.length === 0
          || receiptInput.functionsStateId.length > 4096
          // eslint-disable-next-line no-control-regex -- Reject control characters in provider state IDs before persisting receipts.
          || /[\u0000-\u001f\u007f]/.test(receiptInput.functionsStateId)))) {
        throw new Error('Аргументы инструмента превышают допустимый размер.');
      }
      const existingRows = chat.toolReceipts.filter((receipt) => receipt.receiptId === receiptInput.receiptId);
      if (existingRows.some((receipt) => receipt.name !== receiptInput.name
        || !sameJson(receipt.arguments, receiptInput.arguments)
        || receipt.effectId !== receiptInput.effectId
        || (!SIDE_EFFECT_TOOLS.has(receiptInput.name)
          && (receipt.content !== receiptInput.content || receipt.functionsStateId !== receiptInput.functionsStateId)))) {
        throw new Error('Идентификатор запроса инструмента уже связан с другими аргументами.');
      }
      const sameAnchor = existingRows.find((receipt) => receipt.anchorMessageId === messageId);
      if (sameAnchor) {
        if (sameAnchor.status === 'pending') {
          const recovered: ChatToolReceipt = { ...sameAnchor, status: 'unknown', result: UNKNOWN_TOOL_RESULT };
          const updated = { ...chat, updatedAt: new Date().toISOString(), toolReceipts: chat.toolReceipts.map((row) => row === sameAnchor ? recovered : row) };
          await saveChat(updated);
          return { shouldExecute: false, receipt: structuredClone(recovered) };
        }
        return { shouldExecute: false, receipt: structuredClone(sameAnchor) };
      }
      const priorEffectRows = receiptInput.effectId
        ? chat.toolReceipts.filter((receipt) => receipt.effectId === receiptInput.effectId)
        : [];
      if (priorEffectRows.some((receipt) => receipt.anchorMessageId !== messageId || receipt.name !== receiptInput.name
        || !sameJson(receipt.arguments, receiptInput.arguments))) {
        throw new Error('Идентификатор side effect уже связан с другим запросом.');
      }
      const priorEffect = priorEffectRows[0];
      if (priorEffect) {
        const now = new Date().toISOString();
        const priorStatus = priorEffect.status === 'completed' ? 'completed' : 'unknown';
        const receipt: ChatToolReceipt = {
          ...structuredClone(receiptInput), anchorMessageId: messageId,
          status: priorStatus,
          result: priorStatus === 'completed' ? priorEffect.result : UNKNOWN_TOOL_RESULT,
          createdAt: now,
        };
        const toolReceipts = chat.toolReceipts.map((row) => row === priorEffect && row.status === 'pending'
          ? { ...row, status: 'unknown' as const, result: UNKNOWN_TOOL_RESULT }
          : row);
        if (toolReceipts.length >= MAX_TOOL_RECEIPTS_PER_CHAT) throw new Error('Лимит истории локальных инструментов чата достигнут.');
        const updated = { ...chat, updatedAt: now, toolReceipts: [...toolReceipts, receipt] };
        await saveChat(updated);
        return { shouldExecute: false, receipt: structuredClone(receipt) };
      }
      const earlier = existingRows[0];
      const now = new Date().toISOString();
      const receipt: ChatToolReceipt = earlier
        ? {
          ...earlier,
          anchorMessageId: messageId,
          status: earlier.status === 'completed' ? 'completed' : 'unknown',
          result: earlier.status === 'completed' ? earlier.result : UNKNOWN_TOOL_RESULT,
          createdAt: now,
        }
        : {
          ...structuredClone(receiptInput), anchorMessageId: messageId,
          status: 'pending', result: null, createdAt: now,
        };
      if (chat.toolReceipts.length >= MAX_TOOL_RECEIPTS_PER_CHAT) throw new Error('Лимит истории локальных инструментов чата достигнут.');
      const updated = { ...chat, updatedAt: now, toolReceipts: [...chat.toolReceipts, receipt] };
      await saveChat(updated);
      return { shouldExecute: !earlier, receipt: structuredClone(receipt) };
    }),
    completeToolReceipt: (chatIdInput, messageIdInput, receiptIdInput, statusInput, resultInput) => serialize(async () => {
      const chat = findChat(chatIdInput);
      const messageId = requireId(messageIdInput);
      if (typeof receiptIdInput !== 'string' || !/^[a-f0-9]{64}$/.test(receiptIdInput)
        || (statusInput !== 'completed' && statusInput !== 'unknown') || typeof resultInput !== 'string'
        || Buffer.byteLength(resultInput, 'utf8') > MAX_TOOL_RESULT_BYTES || !isJsonObjectText(resultInput)) {
        throw new Error('Некорректный результат инструмента.');
      }
      const receipt = chat.toolReceipts.find((row) => row.receiptId === receiptIdInput && row.anchorMessageId === messageId);
      if (!receipt) throw new Error('Намерение инструмента не найдено.');
      if (receipt.status !== 'pending') {
        if (receipt.status === statusInput && receipt.result === resultInput) return;
        throw new Error('Результат инструмента уже зафиксирован.');
      }
      const completed: ChatToolReceipt = { ...receipt, status: statusInput, result: resultInput };
      const updated = { ...chat, updatedAt: new Date().toISOString(), toolReceipts: chat.toolReceipts.map((row) => row === receipt ? completed : row) };
      await saveChat(updated);
    }),
    createChat: (projectIdInput = null, kindInput = 'text') => serialize(async () => {
      const projectId = projectIdInput === null || projectIdInput === undefined
        ? null
        : requireId(projectIdInput);
      if (kindInput !== 'text' && kindInput !== 'image') throw new Error('Неизвестный тип чата.');
      if (projectId && !projects.some((project) => project.id === projectId && !project.archived)) {
        throw new Error('Выбранный проект недоступен.');
      }
      return summary(await createStoredChat(projectId, kindInput as ChatKind));
    }),
    updateChat: (idInput, patchInput) => serialize(async () => {
      const id = requireId(idInput);
      let patch = validateChatPatch(patchInput);
      if (patch.projectId && !projects.some((project) => project.id === patch.projectId && !project.archived)) {
        throw new Error('Выбранный проект недоступен.');
      }
      const chat = findChat(id);
      if (patch.projectId !== undefined && patch.nextTurnSkillId === undefined) {
        const nextTurnSkillId = skillForProject(chat.nextTurnSkillId, patch.projectId);
        if (nextTurnSkillId !== chat.nextTurnSkillId) patch = { ...patch, nextTurnSkillId };
      }
      const updated = { ...chat, ...patch, updatedAt: new Date().toISOString() };
      await saveChat(updated);
      const revisions = selectionRevisions.get(id) ?? { permissionProfile: 0, skill: 0 };
      if ('nextTurnPermissionProfile' in patch) revisions.permissionProfile += 1;
      if ('nextTurnSkillId' in patch) revisions.skill += 1;
      selectionRevisions.set(id, revisions);
      return summary(updated);
    }),
    appendLocalMessage: (id, textInput) => serialize(() => appendLocalMessage(id, textInput)),
    acceptLocalMessage: (idInput, textInput, turnIdInput, attachmentIdsInput = [], expectedModelIdInput, validateBeforeCommit) => serialize(async () => {
      const turnId = requireId(turnIdInput);
      if (turnReservations.has(turnId)) throw new Error('Ход с таким идентификатором уже принят.');
      const before = findChat(idInput);
      if (before.projectId && !projects.some((item) => item.id === before.projectId)) {
        throw new Error('Проект чата больше недоступен.');
      }
      if (typeof textInput !== 'string' || textInput.length > 100_000) throw new Error('Сообщение не должно превышать 100 000 символов.');
      if (!Array.isArray(attachmentIdsInput) || attachmentIdsInput.length > MAX_CHAT_DRAFT_FILES
        || attachmentIdsInput.some((id) => typeof id !== 'string') || new Set(attachmentIdsInput).size !== attachmentIdsInput.length) {
        throw new Error('Список подготовленных файлов изменился.');
      }
      const selectedIds = attachmentIdsInput.map(requireId);
      const selectedAttachments = selectedIds.map((id) => {
        const attachment = before.draftAttachments.find((item) => item.id === id);
        if (!attachment) throw new Error('Подготовленный файл изменился перед отправкой.');
        return attachment;
      });
      if (expectedModelIdInput !== undefined && expectedModelIdInput !== (before.modelId ?? settings.defaultModelId)) {
        throw new Error('Модель изменилась во время проверки файлов. Черновик сохранён; проверьте выбор и отправьте ещё раз.');
      }
      const text = textInput.trim();
      if (!text && selectedAttachments.length === 0) throw new Error('Введите сообщение или прикрепите файл перед отправкой.');
      const now = new Date().toISOString();
      const message: ChatMessage = {
        id: randomUUID(), role: 'user', text, createdAt: now,
        ...(selectedIds.length ? { attachmentIds: selectedIds } : {}),
      };
      const updated: ChatDetail = {
        ...before, draft: '', updatedAt: now,
        messages: [...before.messages, message],
        draftAttachments: before.draftAttachments.filter((item) => !selectedIds.includes(item.id)),
        artifacts: [...before.artifacts, ...selectedAttachments.map((attachment) => ({
          id: attachment.id, name: attachment.name, storedName: attachment.storedName,
          size: attachment.size, sha256: attachment.sha256, createdAt: attachment.createdAt, messageId: message.id,
        }))],
      };
      const acceptedMessage = updated.messages[updated.messages.length - 1];
      if (!acceptedMessage || acceptedMessage.role !== 'user') throw new Error('Принятое сообщение отсутствует в истории чата.');
      validateBeforeCommit?.();
      const turn = createAcceptedTurn(updated, turnId, acceptedMessage.id);
      const acceptedChat = { ...updated, turns: [...updated.turns, recordForAcceptedTurn(turn)] };
      try { await saveChat(acceptedChat); }
      catch (error) { turnReservations.delete(turnId); throw error; }
      const detail = structuredClone(findChat(before.id));
      return { detail, turn };
    }),
    acceptCompactionTurn: (idInput, turnIdInput) => serialize(async () => {
      const turnId = requireId(turnIdInput);
      if (turnReservations.has(turnId)) throw new Error('Ход с таким идентификатором уже принят.');
      const detail = findChat(idInput);
      const lastUserMessage = [...detail.messages].reverse().find((message) => message.role === 'user');
      if (!lastUserMessage) throw new Error('Сначала добавьте сообщение перед сжатием контекста.');
      if (detail.projectId && !projects.some((item) => item.id === detail.projectId)) {
        throw new Error('Проект чата больше недоступен.');
      }
      const turn = createAcceptedTurn(detail, turnId, lastUserMessage.id, 'compaction');
      const accepted = { ...detail, updatedAt: new Date().toISOString(), turns: [...detail.turns, recordForAcceptedTurn(turn)] };
      try { await saveChat(accepted); }
      catch (error) { turnReservations.delete(turnId); throw error; }
      return { detail: structuredClone(findChat(detail.id)), turn };
    }),
    releaseTurnReservation: (turnIdInput) => {
      if (typeof turnIdInput === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(turnIdInput)) turnReservations.delete(turnIdInput);
    },
    markQueuedTurnNotSent: (turnInput, reasonInput) => serialize(async () => {
      const accepted = validateAcceptedTurnRecord(structuredClone(turnInput), false);
      if (accepted.operation || accepted.assistantMessageId === null || typeof reasonInput !== 'string'
        || !reasonInput.trim() || reasonInput.length > 500) {
        throw new Error('Некорректная запись хода, который не был отправлен.');
      }
      const chat = validateAcceptedTurnBinding(accepted);
      const index = chat.turns.findIndex((item) => item.turnId === accepted.turnId);
      const existing = index >= 0 ? chat.turns[index] : null;
      if (!existing || existing.anchorMessageId !== accepted.messageId
        || existing.assistantMessageId !== accepted.assistantMessageId || existing.modelId !== accepted.modelId
        || existing.operation !== accepted.operation) {
        throw new Error('Запись принятого хода изменилась перед фиксацией результата очереди.');
      }
      if (existing.status !== 'queued' || existing.startedAt !== undefined || existing.endedAt !== undefined
        || existing.activity.length > 0) {
        return { detail: structuredClone(chat), marked: false };
      }
      const failed: ChatTurnRecord = {
        ...existing,
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: reasonInput,
      };
      const turns = [...chat.turns];
      turns[index] = failed;
      await saveChat({ ...chat, turns, updatedAt: new Date().toISOString() });
      return { detail: structuredClone(findChat(chat.id)), marked: true };
    }),
    reserveRetryTurn: (originalInput, retryInput) => serialize(async () => {
      const original = structuredClone(originalInput);
      const retry = structuredClone(retryInput);
      const sameSnapshot = original.chatId === retry.chatId && original.projectId === retry.projectId
        && original.projectWorkingFolder === retry.projectWorkingFolder && original.messageId === retry.messageId
        && original.historyBoundary === retry.historyBoundary && JSON.stringify(original.messages) === JSON.stringify(retry.messages)
        && original.permissionProfile === retry.permissionProfile && original.modelId === retry.modelId
        && original.skillId === retry.skillId
        && original.reservation.permissionProfileRevision === retry.reservation.permissionProfileRevision
        && original.reservation.skillRevision === retry.reservation.skillRevision;
      if (original.operation || retry.operation || original.turnId === retry.turnId || !sameSnapshot) {
        throw new Error('Повтор должен сохранять исходный снимок хода.');
      }
      const chat = validateAcceptedTurnBinding(original);
      validateAcceptedTurnBinding(retry);
      if (!chat.messages.some((message) => message.id === original.messageId && message.role === 'user')) {
        throw new Error('Исходное сообщение для повтора отсутствует.');
      }
      if (turnReservations.has(retry.turnId)) throw new Error('Ход с таким идентификатором уже принят.');

      const currentRevisions = selectionRevisions.get(chat.id) ?? { permissionProfile: 0, skill: 0 };
      const previousReservation = turnReservations.get(original.turnId);
      const isOwnedByAnotherTurn = (kind: 'permissionProfile' | 'skill', revision: number): boolean =>
        [...turnReservations.entries()].some(([turnId, reservation]) => turnId !== original.turnId
          && reservation.chatId === chat.id && reservation[kind]?.revision === revision);
      const profileRevision = original.reservation.permissionProfileRevision;
      const skillRevision = original.reservation.skillRevision;
      const permissionProfile = profileRevision !== null
        && currentRevisions.permissionProfile === profileRevision
        && chat.nextTurnPermissionProfile === original.permissionProfile
        && !isOwnedByAnotherTurn('permissionProfile', profileRevision)
        ? { value: original.permissionProfile, revision: profileRevision }
        : null;
      const skill = skillRevision !== null
        && currentRevisions.skill === skillRevision
        && original.skillId !== null
        && chat.nextTurnSkillId === original.skillId
        && !isOwnedByAnotherTurn('skill', skillRevision)
        ? { value: original.skillId!, revision: skillRevision }
        : null;
      if (permissionProfile || skill) {
        turnReservations.set(retry.turnId, {
          chatId: chat.id,
          permissionProfile,
          skill,
        });
      }
      if (previousReservation) turnReservations.delete(original.turnId);
    }),
    validateAcceptedTurn: (turn) => serialize(async () => {
      validateAcceptedTurnBinding(turn);
    }),
    consumeTurnReservation: (turn, signal) => serialize(async () => {
      if (signal?.aborted) throw createAbortError();
      const chat = validateAcceptedTurnBinding(turn);
      const reservation = turnReservations.get(turn.turnId);
      if (!reservation) return;
      if (reservation.chatId !== turn.chatId) throw new Error('Резервирование хода повреждено.');
      const revisions = selectionRevisions.get(chat.id) ?? { permissionProfile: 0, skill: 0 };
      let updated = chat;
      let clearProfile = false;
      let clearSkill = false;
      if (reservation.permissionProfile && turn.reservation.permissionProfileRevision === reservation.permissionProfile.revision
        && revisions.permissionProfile === reservation.permissionProfile.revision
        && chat.nextTurnPermissionProfile === reservation.permissionProfile.value) {
        updated = { ...updated, nextTurnPermissionProfile: null };
        clearProfile = true;
      }
      if (reservation.skill && turn.reservation.skillRevision === reservation.skill.revision
        && revisions.skill === reservation.skill.revision
        && chat.nextTurnSkillId === reservation.skill.value) {
        updated = { ...updated, nextTurnSkillId: null };
        clearSkill = true;
      }
      if (clearProfile || clearSkill) {
        updated = { ...updated, updatedAt: new Date().toISOString() };
        await saveChat(updated, signal);
        if (clearProfile) revisions.permissionProfile += 1;
        if (clearSkill) revisions.skill += 1;
        selectionRevisions.set(chat.id, revisions);
      }
      if (signal?.aborted) throw createAbortError();
      turnReservations.delete(turn.turnId);
    }),
    updateRuntimeTurn: (turnInput) => serialize(async () => {
      const snapshot = structuredClone(turnInput);
      const record = recordFromRuntimeTurn(snapshot);
      const chat = findChat(snapshot.chatId);
      if (!chat.messages.some((message) => message.id === record.anchorMessageId && message.role === 'user')) {
        throw new Error('Исходное сообщение хода отсутствует в чате.');
      }
      const existingIndex = chat.turns.findIndex((item) => item.turnId === record.turnId);
      const existing = existingIndex >= 0 ? chat.turns[existingIndex] : null;
      if (existing) {
        if (existing.anchorMessageId !== record.anchorMessageId || existing.assistantMessageId !== record.assistantMessageId
          || existing.modelId !== record.modelId || existing.operation !== record.operation) {
          throw new Error('Запись runtime не совпадает с принятым ходом.');
        }
        if (existing.status === 'completed') {
          const sameCompletion = record.status === 'completed' && record.createdAt === existing.createdAt
            && record.startedAt === existing.startedAt && record.endedAt === existing.endedAt
            && record.activeDurationMs === existing.activeDurationMs
            && JSON.stringify(record.activity.slice(0, existing.activity.length)) === JSON.stringify(existing.activity);
          if (!sameCompletion) throw new Error('Устаревшее обновление завершённого хода.');
          if (JSON.stringify(record) === JSON.stringify(existing)) return;
          record.createdAt = existing.createdAt;
        } else if (existing.status === 'failed' || existing.status === 'cancelled' || existing.status === 'interrupted') {
          if (JSON.stringify({ ...record, createdAt: existing.createdAt }) === JSON.stringify(existing)) return;
          throw new Error('Устаревшее обновление записи завершённого хода.');
        }
        if (existing.status !== 'completed') {
          if (record.status === 'completed') throw new Error('Завершение хода должно атомарно сохраняться вместе с ответом.');
          if (record.status === 'queued' && existing.status === 'running') throw new Error('Запись хода не может вернуться в очередь.');
          record.createdAt = existing.createdAt;
        }
      } else {
        if (record.status !== 'queued' || chat.turns.length >= MAX_TURN_RECORDS_PER_CHAT) {
          throw new Error('Нельзя восстановить отсутствующую запись уже начатого хода.');
        }
        if (record.assistantMessageId && chat.messages.some((message) => message.id === record.assistantMessageId)) {
          throw new Error('Зарезервированный ответ уже занят другим сообщением.');
        }
      }
      const turns = [...chat.turns];
      if (existingIndex >= 0) turns[existingIndex] = record;
      else turns.push(record);
      await saveChat({ ...chat, turns, updatedAt: new Date().toISOString() });
    }),
    appendAssistantMessageFromRuntime: (turnInput, textInput, terminalTurnInput, signal, functionsStateIdInput) => serialize(async () => {
      if (signal?.aborted) throw createAbortError();
      const acceptedTurn = structuredClone(turnInput);
      validateAcceptedTurnBinding(acceptedTurn);
      const terminalTurn = recordFromRuntimeTurn(terminalTurnInput);
      if (terminalTurnInput.chatId !== acceptedTurn.chatId || acceptedTurn.operation || acceptedTurn.assistantMessageId === null || terminalTurn.status !== 'completed'
        || terminalTurn.operation || terminalTurn.turnId !== acceptedTurn.turnId || terminalTurn.anchorMessageId !== acceptedTurn.messageId
        || terminalTurn.assistantMessageId !== acceptedTurn.assistantMessageId || terminalTurn.modelId !== acceptedTurn.modelId) {
        throw new Error('Завершённый ответ не совпадает с зарезервированным ходом.');
      }
      const chat = findChat(acceptedTurn.chatId);
      const messageId = requireId(acceptedTurn.messageId);
      const anchor = chat.messages.findIndex((message) => message.id === messageId && message.role === 'user');
      if (anchor < 0) throw new Error('Ответ не привязан к принятому сообщению чата.');
      if (typeof textInput !== 'string' || !textInput.trim() || textInput.length > 100_000) {
        throw new Error('Ответ должен содержать от 1 до 100 000 символов.');
      }
      if (functionsStateIdInput !== undefined && (typeof functionsStateIdInput !== 'string' || !functionsStateIdInput
        || functionsStateIdInput.length > 4096
        // eslint-disable-next-line no-control-regex -- Reject control characters in persisted provider state IDs.
        || /[\u0000-\u001f\u007f]/.test(functionsStateIdInput))) {
        throw new Error('Некорректное состояние ответа GigaChat.');
      }
      const now = terminalTurn.endedAt ?? new Date().toISOString();
      const currentTurnIndex = chat.turns.findIndex((item) => item.turnId === acceptedTurn.turnId);
      const currentTurn = currentTurnIndex >= 0 ? chat.turns[currentTurnIndex] : null;
      if (currentTurn && (currentTurn.anchorMessageId !== terminalTurn.anchorMessageId
        || currentTurn.assistantMessageId !== terminalTurn.assistantMessageId || currentTurn.modelId !== terminalTurn.modelId
        || currentTurn.operation || currentTurn.status === 'interrupted')) {
        throw new Error('Запись ответа не совпадает с историей хода.');
      }
      const existingMessage = chat.messages.find((message) => message.id === acceptedTurn.assistantMessageId);
      if (existingMessage) {
        const savedTurn = currentTurn;
        if (existingMessage.role === 'assistant' && existingMessage.source === 'runtime'
          && existingMessage.text === textInput.trim()
          && existingMessage.functionsStateId === functionsStateIdInput
          && savedTurn?.status === 'completed') return structuredClone(chat);
        throw new Error('Зарезервированный ответ уже сохранён с другими данными.');
      }
      if (currentTurn && ['failed', 'cancelled', 'interrupted'].includes(currentTurn.status)) {
        throw new Error('Завершённый ход уже был остановлен.');
      }
      const message: ChatMessage = {
        id: acceptedTurn.assistantMessageId, role: 'assistant', source: 'runtime', text: textInput.trim(), createdAt: now,
        ...(functionsStateIdInput === undefined ? {} : { functionsStateId: functionsStateIdInput }),
      };
      const messages = [...chat.messages];
      messages.splice(anchor + 1, 0, message);
      const completedRecord = { ...terminalTurn, createdAt: currentTurn?.createdAt ?? terminalTurn.createdAt };
      const turns = [...chat.turns];
      if (currentTurnIndex >= 0) turns[currentTurnIndex] = completedRecord;
      else turns.push(completedRecord);
      const updated = { ...chat, updatedAt: now, messages, turns };
      await saveChat(updated, signal);
      return structuredClone(updated);
    }),
    commitCompactSnapshot: (idInput, snapshotInput, expectedSnapshotIdInput, signal, terminalTurnInput) => serialize(async () => {
      if (signal?.aborted) throw createAbortError();
      const chat = findChat(idInput);
      if (expectedSnapshotIdInput !== null && typeof expectedSnapshotIdInput !== 'string') {
        throw new Error('Некорректная версия сводки.');
      }
      const currentSnapshotId = chat.compactSnapshot?.id ?? null;
      if (currentSnapshotId !== expectedSnapshotIdInput) throw new Error('Сводка чата изменилась; новая сводка не сохранена.');
      const snapshot = validateCompactSnapshot(snapshotInput, chat.messages);
      if (!snapshot) throw new Error('Некорректная сводка чата.');
      const prefix = buildCompactionPrefix(chat, snapshot.boundaryMessageId, snapshot.coveredThroughMessageId);
      if (prefix.coveredPrefixHash !== snapshot.coveredPrefixHash) throw new Error('История изменилась во время сжатия; прежняя сводка сохранена.');
      const previousBoundaryIndex = chat.compactSnapshot
        ? chat.messages.findIndex((message) => message.id === chat.compactSnapshot?.boundaryMessageId)
        : -1;
      const nextBoundaryIndex = chat.messages.findIndex((message) => message.id === snapshot.boundaryMessageId);
      if (nextBoundaryIndex < previousBoundaryIndex) throw new Error('Сводка не может откатывать уже покрытую историю.');
      let turns = chat.turns;
      if (terminalTurnInput) {
        const terminalTurn = recordFromRuntimeTurn(terminalTurnInput);
        if (terminalTurnInput.chatId !== chat.id || terminalTurn.status !== 'completed' || terminalTurn.operation !== 'compaction'
          || terminalTurn.assistantMessageId !== null || terminalTurn.anchorMessageId !== snapshot.boundaryMessageId
          || terminalTurn.modelId !== snapshot.modelId || terminalTurn.turnId === '') {
          throw new Error('Завершённая сводка не совпадает с принятым ходом.');
        }
        const index = chat.turns.findIndex((item) => item.turnId === terminalTurn.turnId);
        const existing = index < 0 ? null : chat.turns[index]!;
        if (existing && (existing.operation !== 'compaction' || existing.anchorMessageId !== terminalTurn.anchorMessageId
          || existing.assistantMessageId !== null || existing.modelId !== terminalTurn.modelId
          || ['failed', 'cancelled', 'interrupted'].includes(existing.status))) {
          throw new Error('Запись сводки не совпадает с историей хода.');
        }
        turns = [...chat.turns];
        const completed = { ...terminalTurn, createdAt: existing?.createdAt ?? terminalTurn.createdAt };
        if (index < 0) turns.push(completed);
        else turns[index] = completed;
      }
      await testFaults?.beforeCompactSnapshotCommit?.();
      if (signal?.aborted) throw createAbortError();
      const updated = { ...chat, compactSnapshot: snapshot, turns, updatedAt: new Date().toISOString() };
      await saveChat(updated, signal);
      return structuredClone(updated);
    }),
    importFile: (idInput, sourcePath, projectIdInput = null) => serialize(async () => {
      if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')) throw new Error('Файл не выбран.');
      const source = await stat(sourcePath);
      if (!source.isFile()) throw new Error('Выбранный путь не является файлом.');
      if (!Number.isSafeInteger(source.size)) throw new Error('Размер файла недоступен.');
      if (source.size > LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES) throw new Error('Размер файла превышает лимит 25 МиБ.');
      const existing = idInput === null ? null : findChat(idInput);
      const projectId = projectIdInput === null ? null : requireId(projectIdInput);
      if (!existing && projectId && !projects.some((project) => project.id === projectId && !project.archived)) {
        throw new Error('Выбранный проект недоступен.');
      }
      const chat = existing ?? await createStoredChat(projectId, 'text');
      const id = randomUUID();
      const extension = extname(sourcePath).match(/^\.[A-Za-z0-9]{1,12}$/)?.[0].toLowerCase() ?? '';
      const storedName = `${id}${extension}`;
      const target = join(chatFolder(chat.id), 'files', storedName);
      let targetReady = false;
      let copied = false;
      try {
        await assertOwnedPath(storageRoot, target);
        await mkdir(dirname(target), { recursive: true });
        await assertOwnedPath(storageRoot, target);
        targetReady = true;
        await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
        copied = true;
        await assertOwnedPath(storageRoot, target);
        const storedFile = await stat(target);
        if (!storedFile.isFile() || storedFile.size > LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES) {
          throw new Error('Размер файла превышает лимит 25 МиБ.');
        }
        const now = new Date().toISOString();
        const artifact: ChatArtifact = {
          id, name: basename(sourcePath), storedName, size: storedFile.size, createdAt: now, messageId: null,
        };
        const updated = { ...chat, updatedAt: now, artifacts: [...chat.artifacts, artifact] };
        await saveChat(updated);
        return structuredClone(updated);
      } catch (error) {
        if (targetReady && (copied || !isRecord(error) || error.code !== 'EEXIST')) {
          await assertOwnedPath(storageRoot, target).then(() => unlink(target)).catch(() => undefined);
        }
        if (!existing) {
          chats = chats.filter((item) => item.id !== chat.id);
          const folder = chatFolder(chat.id);
          await assertOwnedPath(storageRoot, folder).then(() => rm(folder, { recursive: true, force: true })).catch(() => undefined);
        }
        throw error;
      }
    }),
    getArtifactPath: (id, artifactId) => serialize(async () => {
      const chat = findChat(id);
      const artifact = chat.artifacts.find((item) => item.id === requireId(artifactId));
      if (!artifact) throw new Error('Файл чата не найден.');
      const path = join(chatFolder(chat.id), 'files', artifact.storedName);
      await assertOwnedPath(storageRoot, path);
      return path;
    }),
    getChatFolder: (id) => serialize(async () => {
      const path = chatFolder(findChat(id).id);
      await assertOwnedPath(storageRoot, path);
      return path;
    }),
    deleteChat: (idInput) => serialize(async () => {
      const chat = findChat(idInput);
      if (homeDraft.lastAcceptance?.chatId === chat.id) {
        await saveHomeDraftRecord({ ...homeDraft, revision: homeDraft.revision + 1, lastAcceptance: null });
      }
      const path = chatFolder(chat.id);
      await assertOwnedPath(storageRoot, path);
      const sourceInfo = await lstat(path);
      if (!sourceInfo.isDirectory()) throw new Error('Каталог чата недоступен для безопасного удаления.');
      await mkdir(deletedChatsDirectory, { recursive: true });
      await assertOwnedPath(storageRoot, deletedChatsDirectory);
      const quarantinePath = join(deletedChatsDirectory, `${chat.id}.deleted-${randomUUID()}`);
      await assertOwnedPath(storageRoot, quarantinePath);
      await rename(path, quarantinePath);
      chats = chats.filter((item) => item.id !== chat.id);
      selectionRevisions.delete(chat.id);
      for (const [turnId, reservation] of turnReservations) {
        if (reservation.chatId === chat.id) turnReservations.delete(turnId);
      }
      try { await rm(quarantinePath, { recursive: true }); }
      catch { storageIssues.push(`Не удалось завершить очистку чата ${chat.id}; данные сохранены в карантине.`); }
    }),
    getSettings: () => serialize(async () => ({ ...settings })),
    updateSettings: (patchInput) => serialize(async () => {
      const patch = validateSettingsPatch(patchInput);
      const next = validateSettings({ ...settings, ...patch }, 10);
      await saveSettings(next);
      return { ...settings };
    }),
    getLocalUsageStats: () => serialize(async () => {
      const activityDays = new Set<string>();
      const addActivityDay = (value: string): void => {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) activityDays.add(new Date(timestamp).toISOString().slice(0, 10));
      };
      for (const project of projects) {
        addActivityDay(project.createdAt);
        addActivityDay(project.updatedAt);
      }
      for (const chat of chats) {
        addActivityDay(chat.createdAt);
        for (const message of chat.messages) addActivityDay(message.createdAt);
      }
      return { chatCount: chats.length, projectCount: projects.length, activityDayCount: activityDays.size };
    }),
    recordUsageReceipt: (receiptInput) => {
      const incoming = validateUsageReceipt(receiptInput);
      return serialize(async () => {
        const index = usageReceipts.findIndex((receipt) => receipt.localRequestId === incoming.localRequestId);
        if (index >= 0) {
          const merged = mergeUsageReceipt(usageReceipts[index]!, incoming);
          if (sameJson(merged, usageReceipts[index])) return;
          const next = [...usageReceipts];
          next[index] = merged;
          await saveUsageReceipts(next);
          return;
        }
        if (usageReceipts.length >= MAX_USAGE_RECEIPTS) {
          throw new Error('Лимит истории usage достигнут; существующие измерения сохранены.');
        }
        await saveUsageReceipts([...usageReceipts, incoming]);
      });
    },
    getUsageLedger: () => serialize(async () => structuredClone(summarizeUsage(usageReceipts))),
    getProviderUploadEntries: (scopeInput) => serialize(async () => {
      if (typeof scopeInput !== 'string' || !/^[a-f0-9]{64}$/.test(scopeInput)) throw new Error('Не удалось подтвердить область файлового аккаунта.');
      return structuredClone(providerUploadEntries.filter((entry) => entry.accountScope === scopeInput));
    }),
    putProviderUploadEntry: (value) => {
      const entry = validateProviderUploadEntry(value);
      return serialize(async () => {
        const index = providerUploadEntries.findIndex((row) => row.accountScope === entry.accountScope && row.attachmentId === entry.attachmentId);
        const previous = index < 0 ? null : providerUploadEntries[index]!;
        if (!previous) {
          if (entry.state !== 'intent') throw new Error('Загрузка должна начинаться с сохранённого намерения.');
        } else {
          const sameIdentity = previous.accountScope === entry.accountScope && previous.attachmentId === entry.attachmentId
            && previous.uploadFilename === entry.uploadFilename && previous.name === entry.name
            && previous.contentType === entry.contentType && previous.kind === entry.kind
            && previous.sizeBytes === entry.sizeBytes && previous.sha256 === entry.sha256
            && previous.createdAt === entry.createdAt;
          const stateCanAdvance = previous.state === 'intent'
            ? entry.state === 'intent' || entry.state === 'uploaded' || entry.state === 'unknown'
            : previous.state === 'unknown'
              ? entry.state === 'unknown' || entry.state === 'uploaded'
              : previous.state === 'uploaded'
                ? entry.state === 'uploaded' || entry.state === 'cleanup-pending'
                : entry.state === 'cleanup-pending';
          if (!sameIdentity || !stateCanAdvance
            || (previous.remoteFileId !== null && entry.remoteFileId !== previous.remoteFileId)) {
            throw new Error('Состояние облачной копии изменилось; файл не будет переиспользован.');
          }
          if (sameJson(previous, entry)) return structuredClone(previous);
        }
        const next = [...providerUploadEntries];
        if (index < 0) next.push(entry);
        else next[index] = entry;
        await saveProviderUploadEntries(next);
        return structuredClone(entry);
      });
    },
    removeProviderUploadEntry: (scopeInput, attachmentIdInput, remoteFileIdInput) => serialize(async () => {
      if (typeof scopeInput !== 'string' || !/^[a-f0-9]{64}$/.test(scopeInput)) throw new Error('Не удалось подтвердить область файлового аккаунта.');
      const attachmentId = requireId(attachmentIdInput);
      if (typeof remoteFileIdInput !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(remoteFileIdInput)) {
        throw new Error('Удаление облачной копии не подтверждено.');
      }
      const entry = providerUploadEntries.find((row) => row.accountScope === scopeInput && row.attachmentId === attachmentId);
      if (!entry) return;
      if (entry.state !== 'cleanup-pending' || entry.remoteFileId !== remoteFileIdInput) {
        throw new Error('Удаляется только подтверждённая app-owned облачная копия.');
      }
      await saveProviderUploadEntries(providerUploadEntries.filter((row) => row !== entry));
    }),
    getStorageIssues: () => serialize(async () => [...instructionIssues, ...storageIssues]),
    readGlobalInstructions: () => serialize(() => readOwnedInstructions(join(storageRoot, 'GIGACHAT.md'))),
    readGlobalInstructionDocument: () => serialize(async () =>
      (await readInstructionSnapshot(join(storageRoot, 'GIGACHAT.md'), storageRoot)).document),
    saveGlobalInstructions: (contents, expectedRevision) => {
      const validatedContents = requireInstructions(contents);
      const revision = requireInstructionRevision(expectedRevision);
      const path = join(storageRoot, 'GIGACHAT.md');
      return serialize(async () => {
        const current = await readInstructionSnapshot(path, storageRoot);
        return commitInstruction(path, storageRoot, 'GIGACHAT.md', validatedContents, current, revision);
      });
    },
    saveGlobalInstructionsCopy: (contents) => {
      const validatedContents = requireInstructions(contents);
      return serialize(() => saveInstructionCopy('global', validatedContents));
    },
    readProjectInstructions: (id, expectedWorkingFolderInput) => {
      const validatedId = requireId(id);
      const expectedWorkingFolder = expectedWorkingFolderInput === undefined
        ? undefined : requireFolderPath(expectedWorkingFolderInput, 'Рабочая папка проекта');
      return serialize(async () => {
        const project = projects.find((item) => item.id === validatedId);
        if (!project) throw new Error('Проект не найден.');
        if (expectedWorkingFolder !== undefined && project.workingFolder !== expectedWorkingFolder) {
          throw new Error('Рабочая папка проекта изменилась после принятия хода.');
        }
        const target = await externalInstructionsPath(project);
        return target ? readInstructionsFile(target) : readOwnedInstructions(projectInstructionsPath(project.id));
      });
    },
    readProjectInstructionDocument: (id) => {
      const validatedId = requireId(id);
      return serialize(async () => {
        const project = projects.find((item) => item.id === validatedId);
        if (!project) throw new Error('Проект не найден.');
        const target = await externalInstructionsPath(project);
        return (await readInstructionSnapshot(
          target ?? projectInstructionsPath(project.id),
          target ? undefined : storageRoot,
          target ? () => externalInstructionsPath(project) : undefined,
        )).document;
      });
    },
    saveProjectInstructions: (id, contents, expectedRevision) => {
      const validatedId = requireId(id);
      const validatedContents = requireInstructions(contents);
      const revision = requireInstructionRevision(expectedRevision);
      return serialize(async () => {
        const project = projects.find((item) => item.id === validatedId);
        if (!project) throw new Error('Проект не найден.');
        const target = await externalInstructionsPath(project);
        const path = target ?? projectInstructionsPath(validatedId);
        const root = target ? project.workingFolder : storageRoot;
        if (!root) throw new Error('Рабочая папка проекта недоступна.');
        const relativePath = target ? 'AGENTS.md' : relative(storageRoot, path);
        const current = await readInstructionSnapshot(
          path,
          target ? undefined : storageRoot,
          target ? () => externalInstructionsPath(project) : undefined,
        );
        await testFaults?.beforeProjectInstructionCommit?.(path);
        if (target) {
          const verifiedTarget = await externalInstructionsPath(project);
          if (verifiedTarget !== target) throw new Error('Рабочая папка проекта изменилась перед записью AGENTS.md.');
        }
        return commitInstruction(path, root, relativePath, validatedContents, current, revision);
      });
    },
    saveProjectInstructionsCopy: (id, contents) => {
      const validatedId = requireId(id);
      const validatedContents = requireInstructions(contents);
      return serialize(async () => {
        if (!projects.some((project) => project.id === validatedId)) throw new Error('Проект не найден.');
        return saveInstructionCopy(validatedId, validatedContents);
      });
    },
  };
}
