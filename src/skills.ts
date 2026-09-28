import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Project } from './contracts';

const MAX_SKILL_BYTES = 64 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SKILL_ID_PATTERN = /^(?:global\/[a-z0-9][a-z0-9_-]{0,63}|project\/[A-Za-z0-9_-]{1,128}\/[a-z0-9][a-z0-9_-]{0,63})$/;

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

export interface SkillRegistry {
  list(): Promise<SkillRegistrySnapshot>;
  readSource(id: unknown): Promise<SkillSource>;
  setEnabled(id: unknown, enabled: unknown): Promise<SkillRegistrySnapshot>;
  openFolder(scope: unknown, projectId?: unknown): Promise<string>;
  getEnabled(id: unknown): Promise<(SkillRecord & { instructions: string }) | null>;
}

interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
}

interface LocatedSkill {
  record: Omit<SkillRecord, 'enabled'>;
  filePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function assertOwnedPath(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) throw new Error('Путь Skills выходит за каталог данных приложения.');
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('Папка Skills содержит ссылку; запись и чтение остановлены.');
    if (!isWithin(root, await realpath(current))) throw new Error('Путь Skills выходит за каталог данных приложения.');
  }
}

function requireSkillId(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_ID_PATTERN.test(value)) throw new Error('Некорректный идентификатор Skill.');
  return value;
}

function parseScalar(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text[0] === '"' && text.charAt(text.length - 1) === '"') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return parsed.trim();
    } catch { /* The value is validated below as an unquoted scalar. */ }
  }
  if (text.length >= 2 && text[0] === "'" && text.charAt(text.length - 1) === "'") return text.slice(1, -1).replace(/''/g, "'").trim();
  return text;
}

export function parseSkillMarkdown(contents: string): ParsedSkill {
  if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error('SKILL.md должен быть текстом размером не более 64 КБ.');
  }
  const normalized = contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') throw new Error('В SKILL.md нужны поля name и description в YAML-заголовке.');
  const closing = lines.indexOf('---', 1);
  if (closing < 0 || closing > 20) throw new Error('Не найден короткий YAML-заголовок SKILL.md.');
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (!field?.[1] || field[2] === undefined || fields.has(field[1])) throw new Error('Заголовок SKILL.md поддерживает только уникальные поля name и description.');
    fields.set(field[1], parseScalar(field[2]));
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  const instructions = lines.slice(closing + 1).join('\n').trim();
  if (!name || name.length > 120 || /[\r\n\0]/.test(name)) throw new Error('Название Skill должно содержать от 1 до 120 символов.');
  if (!description || description.length > 300 || /[\r\n\0]/.test(description)) throw new Error('Описание Skill должно содержать от 1 до 300 символов.');
  if (!instructions) throw new Error('В SKILL.md нет текста инструкций.');
  return { name, description, instructions };
}

export function isSkillId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_ID_PATTERN.test(value);
}

export function createSkillRegistry(options: {
  userDataPath: string;
  listProjects(): Promise<Project[]>;
}): SkillRegistry {
  if (!isAbsolute(options.userDataPath)) throw new Error('Путь данных приложения должен быть абсолютным.');
  const userDataPath = resolve(options.userDataPath);
  const skillsRoot = join(userDataPath, 'skills');
  const enabledPath = join(skillsRoot, 'enabled.json');
  let writeQueue: Promise<void> = Promise.resolve();

  const ensureRoot = async (): Promise<void> => {
    await mkdir(userDataPath, { recursive: true });
    const rootInfo = await lstat(userDataPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Каталог данных приложения недоступен.');
    await realpath(userDataPath);
    await assertOwnedPath(userDataPath, skillsRoot);
    await mkdir(skillsRoot, { recursive: true });
    await assertOwnedPath(userDataPath, skillsRoot);
  };

  const ensureFolder = async (folder: string): Promise<void> => {
    await assertOwnedPath(userDataPath, folder);
    await mkdir(folder, { recursive: true });
    await assertOwnedPath(userDataPath, folder);
  };

  const loadEnabled = async (): Promise<Set<string>> => {
    await assertOwnedPath(userDataPath, enabledPath);
    let contents: string;
    try { contents = await readFile(enabledPath, 'utf8'); }
    catch (error) {
      if (isMissing(error)) return new Set();
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(contents) as unknown; }
    catch { throw new Error('Файл состояния Skills повреждён; настройки не изменены.'); }
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.enabled)
      || value.enabled.some((item) => !isSkillId(item)) || new Set(value.enabled).size !== value.enabled.length) {
      throw new Error('Файл состояния Skills имеет неизвестный формат; настройки не изменены.');
    }
    return new Set(value.enabled as string[]);
  };

  const saveEnabled = async (ids: Set<string>): Promise<void> => {
    await assertOwnedPath(userDataPath, enabledPath);
    const temporary = `${enabledPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, enabled: [...ids].sort() }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await assertOwnedPath(userDataPath, temporary);
      await rename(temporary, enabledPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  const locateSkills = async (): Promise<{ found: LocatedSkill[]; issues: SkillIssue[] }> => {
    await ensureRoot();
    const projects = await options.listProjects();
    const roots: Array<{ scope: SkillScope; projectId: string | null; projectName: string | null; path: string }> = [
      { scope: 'global', projectId: null, projectName: null, path: join(skillsRoot, 'global') },
      ...projects.map((project) => ({
        scope: 'project' as const, projectId: project.id, projectName: project.name,
        path: join(skillsRoot, 'projects', project.id),
      })),
    ];
    const found: LocatedSkill[] = [];
    const issues: SkillIssue[] = [];
    for (const root of roots) {
      await ensureFolder(root.path);
      const entries = await readdir(root.path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) continue;
        const directory = join(root.path, entry.name);
        const filePath = join(directory, 'SKILL.md');
        const location = root.scope === 'global'
          ? `Global/${entry.name}/SKILL.md`
          : `Project/${root.projectName ?? root.projectId}/${entry.name}/SKILL.md`;
        try {
          await assertOwnedPath(userDataPath, filePath);
          const info = await lstat(filePath).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
          if (!info) continue;
          if (!info.isFile() || info.size > MAX_SKILL_BYTES) throw new Error('Файл должен быть обычным текстом размером не более 64 КБ.');
          const parsed = parseSkillMarkdown(await readFile(filePath, 'utf8'));
          const id = root.scope === 'global' ? `global/${entry.name}` : `project/${root.projectId}/${entry.name}`;
          found.push({
            record: {
              id, name: parsed.name, description: parsed.description, command: entry.name,
              scope: root.scope, projectId: root.projectId, projectName: root.projectName, source: location,
            },
            filePath,
          });
        } catch (error) {
          issues.push({ source: location, reason: error instanceof Error ? error.message : 'Источник Skill недоступен.' });
        }
      }
    }
    return {
      found: found.sort((a, b) => (a.record.scope === 'global' ? 0 : 1) - (b.record.scope === 'global' ? 0 : 1)
        || a.record.name.localeCompare(b.record.name) || a.record.id.localeCompare(b.record.id)),
      issues,
    };
  };

  const snapshot = async (): Promise<SkillRegistrySnapshot> => {
    const [{ found, issues }, enabled] = await Promise.all([locateSkills(), loadEnabled()]);
    return {
      skills: found.map(({ record }) => ({ ...record, enabled: enabled.has(record.id) })),
      issues,
    };
  };

  const findLocated = async (idInput: unknown): Promise<LocatedSkill> => {
    const id = requireSkillId(idInput);
    const { found } = await locateSkills();
    const skill = found.find((item) => item.record.id === id);
    if (!skill) throw new Error('Skill не найден или его источник недоступен.');
    return skill;
  };

  return {
    list: snapshot,
    readSource: async (idInput) => {
      const skill = await findLocated(idInput);
      await assertOwnedPath(userDataPath, skill.filePath);
      const info = await lstat(skill.filePath);
      if (!info.isFile() || info.size > MAX_SKILL_BYTES) throw new Error('Источник Skill изменился и больше не подходит для чтения.');
      return { id: skill.record.id, name: skill.record.name, source: skill.record.source, contents: await readFile(skill.filePath, 'utf8') };
    },
    setEnabled: async (idInput, enabledInput) => {
      const id = requireSkillId(idInput);
      if (typeof enabledInput !== 'boolean') throw new Error('Состояние Skill должно быть логическим.');
      const write = writeQueue.catch(() => undefined).then(async () => {
        await findLocated(id);
        const enabled = await loadEnabled();
        if (enabledInput) enabled.add(id);
        else enabled.delete(id);
        await saveEnabled(enabled);
      });
      writeQueue = write.then(() => undefined, () => undefined);
      await write;
      return snapshot();
    },
    openFolder: async (scopeInput, projectIdInput) => {
      await ensureRoot();
      let folder: string;
      if (scopeInput === 'global') folder = join(skillsRoot, 'global');
      else if (scopeInput === 'project') {
        if (typeof projectIdInput !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectIdInput)) {
          throw new Error('Выберите проект для его Skills.');
        }
        const project = (await options.listProjects()).find((item) => item.id === projectIdInput);
        if (!project) throw new Error('Проект не найден.');
        folder = join(skillsRoot, 'projects', project.id);
      } else throw new Error('Неизвестная область Skills.');
      await ensureFolder(folder);
      return folder;
    },
    getEnabled: async (idInput) => {
      const id = requireSkillId(idInput);
      const [{ found }, enabled] = await Promise.all([locateSkills(), loadEnabled()]);
      const skill = found.find((item) => item.record.id === id);
      if (!skill || !enabled.has(id)) return null;
      await assertOwnedPath(userDataPath, skill.filePath);
      const info = await lstat(skill.filePath);
      if (!info.isFile() || info.size > MAX_SKILL_BYTES) return null;
      const parsed = parseSkillMarkdown(await readFile(skill.filePath, 'utf8'));
      return { ...skill.record, enabled: true, instructions: parsed.instructions };
    },
  };
}
