import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ChatArtifact, ChatDetail, ChatKind, ChatMessage, ChatPatch, ChatSummary, Project, ProjectPatch, Settings, SettingsPatch, Theme } from './contracts';

type ProjectFile = { schemaVersion: 2; projects: Project[] };
type LegacyChat = ChatSummary & { draft: string };
type ChatFile = { schemaVersion: 2; chats: LegacyChat[] };
type SettingsFile = { schemaVersion: 3; settings: Settings };

export interface LocalStore {
  listProjects(): Promise<Project[]>;
  createProject(name: unknown): Promise<Project>;
  updateProject(id: unknown, patch: unknown): Promise<Project>;
  deleteProject(id: unknown): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  getChat(id: unknown): Promise<ChatDetail>;
  createChat(projectId?: unknown, kind?: unknown): Promise<ChatSummary>;
  updateChat(id: unknown, patch: unknown): Promise<ChatSummary>;
  appendLocalMessage(id: unknown, text: unknown): Promise<ChatDetail>;
  importFile(id: unknown, sourcePath: string, projectId?: unknown): Promise<ChatDetail>;
  getArtifactPath(id: unknown, artifactId: unknown): Promise<string>;
  getChatFolder(id: unknown): Promise<string>;
  deleteChat(id: unknown): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: unknown): Promise<Settings>;
  readGlobalInstructions(): Promise<string>;
  saveGlobalInstructions(contents: unknown): Promise<void>;
  readProjectInstructions(id: unknown): Promise<string>;
  saveProjectInstructions(id: unknown, contents: unknown): Promise<void>;
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

function validateSettings(value: unknown, version: 1 | 2 | 3): Settings {
  if (!isRecord(value)) throw new Error('Settings record is invalid.');
  const theme = validateTheme(value.theme);
  const migratedTheme = version < 3 && theme === 'dark' ? 'emerald' : theme;
  if (version === 1) {
    return {
      theme: migratedTheme,
      sidebarTransparent: false,
      sidebarVisible: true,
      defaultProjectsFolder: null,
      preferredOpener: 'system',
    };
  }
  if (value.preferredOpener !== 'system' && value.preferredOpener !== 'explorer' && value.preferredOpener !== 'detected-app') {
    throw new Error('Некорректное приложение для открытия папок.');
  }
  return {
    theme: migratedTheme,
    sidebarTransparent: requireBoolean(value.sidebarTransparent, 'Прозрачность боковой панели'),
    sidebarVisible: requireBoolean(value.sidebarVisible, 'Видимость боковой панели'),
    defaultProjectsFolder: requireFolderPath(value.defaultProjectsFolder, 'Папка проектов'),
    preferredOpener: value.preferredOpener,
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

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
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

function validateChatDetail(value: unknown): ChatDetail {
  if (!isRecord(value) || value.schemaVersion !== 3 || !Array.isArray(value.messages) || !Array.isArray(value.artifacts)) {
    throw new Error('Invalid chat detail.');
  }
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
  return { ...chat, messages, artifacts };
}

function summary(chat: ChatDetail): ChatSummary {
  return {
    id: chat.id, title: chat.title, projectId: chat.projectId, pinned: chat.pinned,
    archived: chat.archived, createdAt: chat.createdAt, updatedAt: chat.updatedAt, kind: chat.kind,
  };
}

function detailFile(chat: ChatDetail): Record<string, unknown> {
  return { schemaVersion: 3, ...chat };
}

function parseSettingsFile(value: unknown): Loaded<SettingsFile> {
  if (!isRecord(value)) throw new Error('Invalid settings file.');
  if (value.schemaVersion === 1) {
    return {
      value: { schemaVersion: 3, settings: validateSettings(value.settings, 1) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion === 2) {
    return {
      value: { schemaVersion: 3, settings: validateSettings(value.settings, 2) },
      needsWrite: true,
    };
  }
  if (value.schemaVersion !== 3) throw new Error('Unknown settings file version.');
  return {
    value: { schemaVersion: 3, settings: validateSettings(value.settings, 3) },
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
    else if (key === 'defaultProjectsFolder') patch.defaultProjectsFolder = requireFolderPath(item, 'Папка проектов');
    else if (key === 'preferredOpener' && (item === 'system' || item === 'explorer' || item === 'detected-app')) {
      patch.preferredOpener = item;
    } else throw new Error('Недопустимое поле настроек.');
  }
  return patch;
}

function requireInstructions(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    throw new Error('Инструкция должна быть текстом размером не более 64 КБ.');
  }
  return value;
}

async function readInstructions(filePath: string): Promise<string> {
  try {
    const value = await readFile(filePath, 'utf8');
    return requireInstructions(value);
  } catch (error) {
    if (isMissingFile(error)) return '';
    throw error;
  }
}

export async function openStore(directory: string): Promise<LocalStore> {
  await mkdir(directory, { recursive: true });
  const projectPath = join(directory, 'projects.json');
  const chatPath = join(directory, 'chats.json');
  const chatsDirectory = join(directory, 'chats');
  const migrationMarker = join(directory, 'chats.migrated');
  const settingsPath = join(directory, 'settings.json');

  // Parse every existing file before creating or migrating any of them.
  const [projectFile, settingsFile] = await Promise.all([
    loadVersioned<ProjectFile>(projectPath, { schemaVersion: 2, projects: [] }, parseProjectFile),
    loadVersioned<SettingsFile>(settingsPath, {
      schemaVersion: 3,
      settings: {
        theme: 'emerald',
        sidebarTransparent: false,
        sidebarVisible: true,
        defaultProjectsFolder: null,
        preferredOpener: 'system',
      },
    }, parseSettingsFile),
  ]);

  const migrated = await readFile(migrationMarker, 'utf8').then(() => true, (error: unknown) => {
    if (isMissingFile(error)) return false;
    throw error;
  });
  const legacyContents = migrated ? null : await readFile(chatPath, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  let legacyChats: LegacyChat[] = [];
  if (legacyContents !== null) {
    try { legacyChats = parseChatFile(JSON.parse(legacyContents) as unknown).value.chats; }
    catch { throw storageError(chatPath); }
  }
  const entries = await readdir(chatsDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingFile(error)) return [];
    throw error;
  });
  const loadedChats: ChatDetail[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const detailPath = join(chatsDirectory, entry.name, 'chat.json');
    let contents: string;
    try { contents = await readFile(detailPath, 'utf8'); }
    catch (error) {
      if (!migrated && legacyChats.some((chat) => chat.id === entry.name) && isMissingFile(error)) continue;
      throw storageError(detailPath);
    }
    try {
      const detail = validateChatDetail(JSON.parse(contents) as unknown);
      if (detail.id !== entry.name) throw new Error('Chat ID mismatch.');
      loadedChats.push(detail);
    } catch { throw storageError(detailPath); }
  }

  if (!migrated) {
    if (legacyContents !== null) {
      await copyFile(chatPath, join(directory, 'chats.json.bak'), constants.COPYFILE_EXCL)
        .catch((error: unknown) => { if (!isRecord(error) || error.code !== 'EEXIST') throw error; });
    }
    for (const legacy of legacyChats) {
      if (loadedChats.some((chat) => chat.id === legacy.id)) continue;
      const detail: ChatDetail = { ...legacy, messages: [], artifacts: [] };
      await writeAtomic(join(chatsDirectory, legacy.id, 'chat.json'), detailFile(detail));
      loadedChats.push(detail);
    }
    await writeTextAtomic(migrationMarker, '3\n');
  }

  if (projectFile.needsWrite) await writeAtomic(projectPath, projectFile.value);
  if (settingsFile.needsWrite) await writeAtomic(settingsPath, settingsFile.value);

  let projects = projectFile.value.projects;
  let chats = loadedChats;
  let settings = settingsFile.value.settings;
  let writeQueue: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const saveProjects = async (next: Project[]): Promise<void> => {
    await writeAtomic(projectPath, { schemaVersion: 2, projects: next });
    projects = next;
  };
  const chatFolder = (id: string): string => join(chatsDirectory, id);
  const saveChat = async (chat: ChatDetail): Promise<void> => {
    await writeAtomic(join(chatFolder(chat.id), 'chat.json'), detailFile(chat));
    chats = chats.some((item) => item.id === chat.id)
      ? chats.map((item) => item.id === chat.id ? chat : item)
      : [...chats, chat];
  };
  const findChat = (idInput: unknown): ChatDetail => {
    const chat = chats.find((item) => item.id === requireId(idInput));
    if (!chat) throw new Error('Чат не найден.');
    return chat;
  };
  const createStoredChat = async (projectId: string | null, kind: ChatKind): Promise<ChatDetail> => {
    const now = new Date().toISOString();
    const chat: ChatDetail = {
      id: randomUUID(), title: kind === 'image' ? 'Новое изображение' : 'Новый чат', projectId,
      pinned: false, archived: false, createdAt: now, updatedAt: now, draft: '', kind,
      messages: [], artifacts: [],
    };
    await saveChat(chat);
    return chat;
  };
  const saveSettings = async (next: Settings): Promise<void> => {
    await writeAtomic(settingsPath, { schemaVersion: 3, settings: next });
    settings = next;
  };
  const projectInstructionsPath = (idInput: unknown): string => {
    const id = requireId(idInput);
    if (!projects.some((project) => project.id === id)) throw new Error('Проект не найден.');
    return join(directory, 'project-instructions', id, 'AGENTS.md');
  };

  return {
    listProjects: () => serialize(async () => projects.map((project) => ({ ...project }))),
    createProject: (nameInput) => serialize(async () => {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name: requireName(nameInput, 'Название проекта', 120),
        pinned: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        workingFolder: null,
      };
      await saveProjects([...projects, project]);
      return { ...project };
    }),
    updateProject: (idInput, patchInput) => serialize(async () => {
      const id = requireId(idInput);
      const patch = validateProjectPatch(patchInput);
      const project = projects.find((item) => item.id === id);
      if (!project) throw new Error('Проект не найден.');
      const updated = { ...project, ...patch, updatedAt: new Date().toISOString() };
      await saveProjects(projects.map((item) => item.id === id ? updated : item));
      return { ...updated };
    }),
    deleteProject: (idInput) => serialize(async () => {
      const id = requireId(idInput);
      if (!projects.some((project) => project.id === id)) throw new Error('Проект не найден.');
      const now = new Date().toISOString();
      for (const chat of chats.filter((item) => item.projectId === id)) {
        await saveChat({ ...chat, projectId: null, updatedAt: now });
      }
      await saveProjects(projects.filter((project) => project.id !== id));
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
      const patch = validateChatPatch(patchInput);
      if (patch.projectId && !projects.some((project) => project.id === patch.projectId && !project.archived)) {
        throw new Error('Выбранный проект недоступен.');
      }
      const chat = findChat(id);
      const updated = { ...chat, ...patch, updatedAt: new Date().toISOString() };
      await saveChat(updated);
      return summary(updated);
    }),
    appendLocalMessage: (id, textInput) => serialize(async () => {
      const chat = findChat(id);
      if (typeof textInput !== 'string' || !textInput.trim() || textInput.length > 100_000) {
        throw new Error('Сообщение должно содержать от 1 до 100 000 символов.');
      }
      const now = new Date().toISOString();
      const message: ChatMessage = { id: randomUUID(), role: 'user', text: textInput.trim(), createdAt: now };
      const updated = { ...chat, draft: '', updatedAt: now, messages: [...chat.messages, message] };
      await saveChat(updated);
      return structuredClone(updated);
    }),
    importFile: (idInput, sourcePath, projectIdInput = null) => serialize(async () => {
      if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')) throw new Error('Файл не выбран.');
      const source = await stat(sourcePath);
      if (!source.isFile()) throw new Error('Выбранный путь не является файлом.');
      if (!Number.isSafeInteger(source.size)) throw new Error('Размер файла недоступен.');
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
      await mkdir(dirname(target), { recursive: true });
      try {
        await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
        const now = new Date().toISOString();
        const artifact: ChatArtifact = {
          id, name: basename(sourcePath), storedName, size: source.size, createdAt: now, messageId: null,
        };
        const updated = { ...chat, updatedAt: now, artifacts: [...chat.artifacts, artifact] };
        await saveChat(updated);
        return structuredClone(updated);
      } catch (error) {
        await unlink(target).catch(() => undefined);
        if (!existing) {
          chats = chats.filter((item) => item.id !== chat.id);
          await rm(chatFolder(chat.id), { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
      }
    }),
    getArtifactPath: (id, artifactId) => serialize(async () => {
      const chat = findChat(id);
      const artifact = chat.artifacts.find((item) => item.id === requireId(artifactId));
      if (!artifact) throw new Error('Файл чата не найден.');
      return join(chatFolder(chat.id), 'files', artifact.storedName);
    }),
    getChatFolder: (id) => serialize(async () => chatFolder(findChat(id).id)),
    deleteChat: (idInput) => serialize(async () => {
      const chat = findChat(idInput);
      await rm(chatFolder(chat.id), { recursive: true });
      chats = chats.filter((item) => item.id !== chat.id);
    }),
    getSettings: () => serialize(async () => ({ ...settings })),
    updateSettings: (patchInput) => serialize(async () => {
      const patch = validateSettingsPatch(patchInput);
      const next = { ...settings, ...patch };
      await saveSettings(next);
      return { ...settings };
    }),
    readGlobalInstructions: () => serialize(() => readInstructions(join(directory, 'GIGACHAT.md'))),
    saveGlobalInstructions: (contents) => serialize(() => writeTextAtomic(join(directory, 'GIGACHAT.md'), requireInstructions(contents))),
    readProjectInstructions: (id) => {
      const validatedId = requireId(id);
      return serialize(() => readInstructions(projectInstructionsPath(validatedId)));
    },
    saveProjectInstructions: (id, contents) => {
      const validatedId = requireId(id);
      const validatedContents = requireInstructions(contents);
      return serialize(() => writeTextAtomic(projectInstructionsPath(validatedId), validatedContents));
    },
  };
}
