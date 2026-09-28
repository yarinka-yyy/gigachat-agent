import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Project } from './contracts';
import { evaluatePermission, type PermissionProfile } from './permissions';
import type { SkillRecord } from './skills';

const MAX_HOOK_BYTES = 16 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const HOOK_EVENTS = [
  'session-start', 'project-start', 'user-prompt-submitted', 'before-tool', 'after-tool',
  'permission-request', 'before-compaction', 'after-compaction', 'interrupt', 'stop', 'session-end', 'project-end',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];
export type HookOrigin = 'global' | 'project' | 'skill' | 'plugin';

export const HOOK_EVENT_LABELS: Record<HookEvent, string> = {
  'session-start': 'Начало сессии',
  'project-start': 'Открытие проекта',
  'user-prompt-submitted': 'Отправка запроса',
  'before-tool': 'Перед инструментом',
  'after-tool': 'После инструмента',
  'permission-request': 'Запрос разрешения',
  'before-compaction': 'Перед сжатием контекста',
  'after-compaction': 'После сжатия контекста',
  interrupt: 'Прерывание',
  stop: 'Остановка',
  'session-end': 'Завершение сессии',
  'project-end': 'Завершение проекта',
};

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
  if (!isWithin(root, target)) throw new Error('Путь Hook выходит за каталог данных приложения.');
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('Каталог Hook содержит ссылку; источник пропущен.');
    if (!isWithin(root, await realpath(current))) throw new Error('Путь Hook выходит за каталог данных приложения.');
  }
}

function validEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

function parseHook(value: unknown): Omit<HookRecord, 'id' | 'origin' | 'scope' | 'owner' | 'source' | 'enabled' | 'verified' | 'unavailableReason'> {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== 'string'
    || typeof value.description !== 'string' || !validEvent(value.event)
    || typeof value.actionFile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.actionFile)
    || value.actionFile === '.' || value.actionFile === '..') {
    throw new Error('Ожидается hook.json версии 1 с именем, описанием, событием и файлом действия.');
  }
  const name = value.name.trim();
  const description = value.description.trim();
  if (!name || name.length > 120 || !description || description.length > 300) {
    throw new Error('Имя Hook должно быть до 120 символов, описание — до 300.');
  }
  return { name, description, event: value.event, actionFile: value.actionFile };
}

export function evaluateHookActivation(input: {
  verified: boolean;
  profile: PermissionProfile;
  projectId: string | null;
  targetProjectId: string | null;
}): { decision: 'allow' | 'ask' | 'deny'; reason: string } {
  if (!input.verified) return { decision: 'deny', reason: 'Источник Hook не проверен; выполнение запрещено.' };
  return evaluatePermission({
    profile: input.profile,
    resource: 'process',
    action: 'execute',
    projectId: input.projectId,
    targetProjectId: input.targetProjectId,
    capabilityAvailable: false,
  });
}

export function createHookRegistry(options: {
  userDataPath: string;
  listProjects(): Promise<Project[]>;
  listSkills(): Promise<SkillRecord[]>;
}): { list(): Promise<HookRegistrySnapshot> } {
  if (!isAbsolute(options.userDataPath)) throw new Error('Путь данных приложения должен быть абсолютным.');
  const userDataPath = resolve(options.userDataPath);
  const hooksRoot = join(userDataPath, 'hooks');
  const skillsRoot = join(userDataPath, 'skills');

  const ensureRoot = async (): Promise<void> => {
    await mkdir(userDataPath, { recursive: true });
    const info = await lstat(userDataPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог данных приложения недоступен.');
    await assertOwnedPath(userDataPath, hooksRoot);
    await mkdir(hooksRoot, { recursive: true });
    await assertOwnedPath(userDataPath, hooksRoot);
  };

  const scanContainer = async (input: {
    container: string;
    origin: HookOrigin;
    owner: string;
    scope: string;
    idPrefix: string;
  }, issues: HookIssue[]): Promise<HookRecord[]> => {
    let entries;
    try {
      await assertOwnedPath(userDataPath, input.container);
      entries = await readdir(input.container, { withFileTypes: true });
    }
    catch (error) {
      if (isMissing(error)) return [];
      issues.push({ source: input.scope, reason: error instanceof Error ? error.message : 'Каталог Hook недоступен.' });
      return [];
    }
    const records: HookRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) continue;
      const directory = join(input.container, entry.name);
      const manifest = join(directory, 'hook.json');
      const source = `${input.scope}/${entry.name}/hook.json`;
      try {
        await assertOwnedPath(userDataPath, manifest);
        const info = await lstat(manifest).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
        if (!info) continue;
        if (!info.isFile() || info.size > MAX_HOOK_BYTES) throw new Error('hook.json должен быть обычным файлом размером не более 16 КБ.');
        const parsed = parseHook(JSON.parse(await readFile(manifest, 'utf8')) as unknown);
        const actionPath = join(directory, parsed.actionFile);
        await assertOwnedPath(userDataPath, actionPath);
        const actionInfo = await lstat(actionPath).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
        if (!actionInfo?.isFile()) throw new Error('Файл действия не найден или не является обычным файлом.');
        records.push({
          ...parsed,
          id: `${input.idPrefix}/${entry.name}`,
          origin: input.origin,
          scope: input.scope,
          owner: input.owner,
          source,
          enabled: false,
          verified: false,
          unavailableReason: 'Выполнение Hooks отключено до проверки источника и разрешения.',
        });
      } catch (error) {
        issues.push({ source, reason: error instanceof Error ? error.message : 'Источник Hook недоступен.' });
      }
    }
    return records;
  };

  return {
    list: async () => {
      await ensureRoot();
      const [projects, skills] = await Promise.all([options.listProjects(), options.listSkills()]);
      const issues: HookIssue[] = [];
      const hooks: HookRecord[] = [];
      hooks.push(...await scanContainer({
        container: join(hooksRoot, 'global'), origin: 'global', owner: 'Приложение', scope: 'Global', idPrefix: 'global',
      }, issues));
      hooks.push(...await scanContainer({
        container: join(hooksRoot, 'plugins'), origin: 'plugin', owner: 'Plugin', scope: 'Plugin', idPrefix: 'plugin',
      }, issues));
      for (const project of projects) {
        hooks.push(...await scanContainer({
          container: join(hooksRoot, 'projects', project.id), origin: 'project', owner: project.name,
          scope: `Project · ${project.name}`, idPrefix: `project/${project.id}`,
        }, issues));
      }
      for (const skill of skills) {
        const skillDirectory = skill.scope === 'global'
          ? join(skillsRoot, 'global', skill.command)
          : join(skillsRoot, 'projects', skill.projectId ?? '', skill.command);
        hooks.push(...await scanContainer({
          container: join(skillDirectory, 'hooks'), origin: 'skill', owner: skill.name,
          scope: `Skill · ${skill.name}`, idPrefix: `skill/${skill.id}`,
        }, issues));
      }
      return {
        hooks: hooks.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name)),
        issues,
      };
    },
  };
}
