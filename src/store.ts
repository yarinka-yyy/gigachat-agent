import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_NOTIFICATION_SETTINGS, type AcceptedTurnInput, type BrowserTabRecord, type ChatArtifact, type ChatDetail, type ChatKind, type ChatMessage, type ChatPatch, type ChatSummary, type InstructionCommitRequest, type InstructionCommitResult, type InstructionDocument, type InstructionSaveResult, type LocalUsageStats, type NotificationSettings, type Project, type ProjectPatch, type ProjectUpdateResult, type Settings, type SettingsPatch, type Theme } from './contracts';
import { requirePermissionProfile, type PermissionProfile } from './permissions';
import { requireModelId } from './models';
import { isSkillId } from './skills';
import { validateProjectFolder, validateProjectInstructionsPath } from './project-paths';
import { createInstructionDocument, instructionFileHash } from './instruction-documents';

type ProjectFile = { schemaVersion: 2; projects: Project[] };
type LegacyChat = ChatSummary & { draft: string };
type ChatFile = { schemaVersion: 2; chats: LegacyChat[] };
type SettingsFile = { schemaVersion: 10; settings: Settings };
type ProjectDeleteState = { projects: ProjectFile; chats: ChatDetail[]; instructionText: string | null };
type ProjectDeleteJournal = {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  before: ProjectDeleteState;
  after: ProjectDeleteState;
};
export type StoreFaultStage = 'journal' | 'chat' | 'projects' | 'instructions' | 'journal-cleared';
export interface StoreTestFaults {
  afterProjectDeleteStage?: (stage: StoreFaultStage, chatIndex?: number) => void | Promise<void>;
  beforeProjectInstructionCommit?: (targetPath: string) => void | Promise<void>;
}

export type InstructionCommitter = (request: InstructionCommitRequest) => Promise<InstructionCommitResult>;

export interface StoreOpenOptions {
  documentsDirectory?: string | null;
  testFaults?: StoreTestFaults;
  instructionCommitter?: InstructionCommitter;
}

const MAX_IMPORTED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INSTRUCTION_BYTES = 64 * 1024;

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
  getChat(id: unknown): Promise<ChatDetail>;
  createChat(projectId?: unknown, kind?: unknown): Promise<ChatSummary>;
  updateChat(id: unknown, patch: unknown): Promise<ChatSummary>;
  appendLocalMessage(id: unknown, text: unknown): Promise<ChatDetail>;
  acceptLocalMessage(id: unknown, text: unknown, turnId: unknown): Promise<{ detail: ChatDetail; turn: AcceptedTurnInput }>;
  releaseTurnReservation(turnId: unknown): void;
  consumeTurnReservation(turn: AcceptedTurnInput, signal?: AbortSignal): Promise<void>;
  validateAcceptedTurn(turn: AcceptedTurnInput): Promise<void>;
  appendAssistantMessageFromRuntime(id: unknown, text: unknown, signal?: AbortSignal): Promise<ChatDetail>;
  importFile(id: unknown, sourcePath: string, projectId?: unknown): Promise<ChatDetail>;
  getArtifactPath(id: unknown, artifactId: unknown): Promise<string>;
  getChatFolder(id: unknown): Promise<string>;
  deleteChat(id: unknown): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: unknown): Promise<Settings>;
  getLocalUsageStats(): Promise<LocalUsageStats>;
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

function validateChatDetail(value: unknown): Loaded<ChatDetail> {
  if (!isRecord(value) || (value.schemaVersion !== 3 && value.schemaVersion !== 4 && value.schemaVersion !== 5 && value.schemaVersion !== 6)
    || !Array.isArray(value.messages) || !Array.isArray(value.artifacts)) {
    throw new Error('Invalid chat detail.');
  }
  const version = value.schemaVersion;
  const chat = validateChat(value, 2);
  const messages: ChatMessage[] = value.messages.map((entry: unknown) => {
    if (!isRecord(entry) || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string') {
      throw new Error('Invalid chat message.');
    }
    return { id: requireId(entry.id), role: entry.role, text: entry.text, createdAt: requireTimestamp(entry.createdAt) };
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
      createdAt: requireTimestamp(entry.createdAt), messageId: entry.messageId === null ? null : requireId(entry.messageId),
    };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length
    || new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length
    || artifacts.some((artifact) => artifact.messageId && !messages.some((message) => message.id === artifact.messageId))) {
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
  return {
    value: { ...chat, messages, artifacts, nextTurnPermissionProfile, nextTurnSkillId,
      modelId: version >= 6 && value.modelId !== null ? requireModelId(value.modelId) : null },
    needsWrite: version < 6,
  };
}

function summary(chat: ChatDetail): ChatSummary {
  return {
    id: chat.id, title: chat.title, projectId: chat.projectId, pinned: chat.pinned,
    archived: chat.archived, createdAt: chat.createdAt, updatedAt: chat.updatedAt, kind: chat.kind,
  };
}

function detailFile(chat: ChatDetail): Record<string, unknown> {
  return { schemaVersion: 6, ...chat };
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
  ]);

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
  const [projectFile, settingsFile] = await Promise.all([
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
      loadedChats.push(detail.value);
      if (detail.needsWrite) chatsNeedingMigration.push(detail.value);
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
      const detail: ChatDetail = { ...legacy, nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: null, messages: [], artifacts: [] };
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

  let projects = projectFile.value.projects;
  let chats = loadedChats;
  let settings = settingsFile.value.settings;
  const selectionRevisions = new Map(chats.map((chat) => [chat.id, { permissionProfile: 0, skill: 0 }]));
  const turnReservations = new Map<string, {
    chatId: string;
    permissionProfile: { value: PermissionProfile; revision: number } | null;
    skill: { value: string; revision: number } | null;
  }>();
  let writeQueue: Promise<void> = Promise.resolve();
  let pendingProjectDelete: ProjectDeleteJournal | null = null;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(async () => {
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
    if (chat.projectId !== turn.projectId) throw new Error('Чат перемещён после принятия хода; запрос остановлен.');
    const project = turn.projectId ? projects.find((item) => item.id === turn.projectId) : null;
    if (turn.projectId && (!project || project.workingFolder !== turn.projectWorkingFolder)) {
      throw new Error('Рабочая папка проекта изменилась после принятия хода; запрос остановлен.');
    }
    if (!turn.projectId && turn.projectWorkingFolder !== null) throw new Error('Привязка папки хода повреждена.');
    return chat;
  };
  const createStoredChat = async (projectId: string | null, kind: ChatKind): Promise<ChatDetail> => {
    const now = new Date().toISOString();
    const chat: ChatDetail = {
      id: randomUUID(), title: kind === 'image' ? 'Новое изображение' : 'Новый чат', projectId,
      pinned: false, archived: false, createdAt: now, updatedAt: now, draft: '', kind,
      nextTurnPermissionProfile: null, nextTurnSkillId: null, modelId: settings.defaultModelId, messages: [], artifacts: [],
    };
    await saveChat(chat);
    selectionRevisions.set(chat.id, { permissionProfile: 0, skill: 0 });
    return chat;
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
    acceptLocalMessage: (idInput, textInput, turnIdInput) => serialize(async () => {
      const turnId = requireId(turnIdInput);
      if (turnReservations.has(turnId)) throw new Error('Ход с таким идентификатором уже принят.');
      const before = findChat(idInput);
      if (before.projectId && !projects.some((item) => item.id === before.projectId)) {
        throw new Error('Проект чата больше недоступен.');
      }
      const detail = await appendLocalMessage(idInput, textInput);
      const project = detail.projectId ? projects.find((item) => item.id === detail.projectId) : null;
      if (detail.projectId && !project) throw new Error('Проект чата больше недоступен.');
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
      turnReservations.set(turnId, { chatId: detail.id, permissionProfile: profileReservation, skill: skillReservation });
      const message = detail.messages[detail.messages.length - 1];
      if (!message || message.role !== 'user') throw new Error('Принятое сообщение отсутствует в истории чата.');
      const turn: AcceptedTurnInput = {
        turnId,
        chatId: detail.id,
        projectId: detail.projectId,
        projectWorkingFolder: project?.workingFolder ?? null,
        messageId: message.id,
        historyBoundary: detail.messages.length,
        messages: structuredClone(detail.messages),
        permissionProfile: profileReservation?.value ?? settings.defaultPermissionProfile,
        modelId: detail.modelId ?? settings.defaultModelId,
        skillId: skillReservation?.value ?? null,
        reservation: {
          permissionProfileRevision: profileReservation?.revision ?? null,
          skillRevision: skillReservation?.revision ?? null,
        },
      };
      return { detail, turn };
    }),
    releaseTurnReservation: (turnIdInput) => {
      if (typeof turnIdInput === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(turnIdInput)) turnReservations.delete(turnIdInput);
    },
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
    appendAssistantMessageFromRuntime: (id, textInput, signal) => serialize(async () => {
      if (signal?.aborted) throw createAbortError();
      const chat = findChat(id);
      if (typeof textInput !== 'string' || !textInput.trim() || textInput.length > 100_000) {
        throw new Error('Ответ должен содержать от 1 до 100 000 символов.');
      }
      const now = new Date().toISOString();
      const message: ChatMessage = { id: randomUUID(), role: 'assistant', text: textInput.trim(), createdAt: now };
      const updated = { ...chat, updatedAt: now, messages: [...chat.messages, message] };
      await saveChat(updated, signal);
      return structuredClone(updated);
    }),
    importFile: (idInput, sourcePath, projectIdInput = null) => serialize(async () => {
      if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')) throw new Error('Файл не выбран.');
      const source = await stat(sourcePath);
      if (!source.isFile()) throw new Error('Выбранный путь не является файлом.');
      if (!Number.isSafeInteger(source.size)) throw new Error('Размер файла недоступен.');
      if (source.size > MAX_IMPORTED_FILE_BYTES) throw new Error('Размер файла превышает лимит 25 МиБ.');
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
        if (!storedFile.isFile() || storedFile.size > MAX_IMPORTED_FILE_BYTES) {
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
