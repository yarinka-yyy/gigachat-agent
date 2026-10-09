import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookDispatchInput, HookEvent, HookInspection, HookIssue, HookOrigin, HookRecord, HookRegistrySnapshot, HookRunResult, Project } from './contracts';
import { evaluatePermission, type PermissionAction, type PermissionProfile, type PermissionResource } from './permissions';
import { LocalToolError, type LocalTools } from './local-tools';
import type { SkillRecord } from './skills';

const MAX_HOOK_BYTES = 16 * 1024;
const MAX_ACTION_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const HOOK_EVENTS: readonly HookEvent[] = [
  'session-start', 'project-start', 'user-prompt-submitted', 'before-tool', 'after-tool',
  'permission-request', 'before-compaction', 'after-compaction', 'interrupt', 'stop', 'session-end', 'project-end',
];

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

export interface HookExecutableAction extends HookInspection {
  name: string;
  event: HookEvent;
}

export interface HookExecutionContext {
  projectId: string | null;
  projectWorkingFolder: string | null;
  permissionProfile: PermissionProfile;
  skillId: string | null;
}

export interface HookDispatchLimits {
  maxHandlers?: number;
  timeoutMs?: number;
}

export interface HookApprovalRequestContext {
  execution: HookExecutionContext;
  projectId: string | null;
  profile: PermissionProfile;
  skillId: string | null;
  workingFolder: string;
  resource: PermissionResource;
  action: PermissionAction;
}

export class HookDispatchAbortError extends Error {
  constructor(readonly hookResults: HookRunResult[]) {
    super('Hook execution cancelled.');
    this.name = 'AbortError';
  }
}

export function transitionProjectHookContext(
  active: HookExecutionContext | null,
  next: HookExecutionContext,
): { end: HookExecutionContext | null; start: HookExecutionContext | null; active: HookExecutionContext | null } {
  const sameProject = active?.projectId === next.projectId
    && active?.projectWorkingFolder === next.projectWorkingFolder;
  if (active?.projectId && sameProject) return { end: null, start: null, active: next };
  if (active?.projectId) {
    return { end: active, start: next.projectId ? next : null, active: next.projectId ? next : null };
  }
  if (next.projectId) return { end: null, start: next, active: next };
  return { end: null, start: null, active: null };
}

export function createHookDispatcher(options: {
  registry: { getExecutable(event: HookEvent, context: { projectId: string | null; skillId: string | null }): Promise<HookExecutableAction[]> };
  tools: Pick<LocalTools, 'runPowerShell'>;
  isAvailable?(): boolean;
  onResult?(result: HookRunResult): void;
}): (
  context: HookExecutionContext,
  input: HookDispatchInput,
  parentSignal: AbortSignal,
  limits?: HookDispatchLimits,
) => Promise<HookRunResult[]> {
  return async (context, input, parentSignal, limits = {}) => {
    if (parentSignal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const handlers = await options.registry.getExecutable(input.event, { projectId: input.projectId, skillId: context.skillId });
    const maxHandlers = Math.max(0, Math.min(64, limits.maxHandlers ?? 8));
    const timeoutMs = Math.max(100, Math.min(15_000, limits.timeoutMs ?? 2_000));
    const results: HookRunResult[] = [];
    const record = (result: HookRunResult): void => {
      results.push(result);
      try { options.onResult?.(result); } catch { /* Reporting does not change an approved action. */ }
    };

    for (const [index, handler] of handlers.entries()) {
      if (parentSignal.aborted) {
        record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'cancelled', reason: 'Hook отменён вместе с текущим ходом.' });
        throw new HookDispatchAbortError(results);
      }
      if (index >= maxHandlers) {
        record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'skipped', reason: 'Достигнут лимит обработчиков этого события.' });
        continue;
      }
      if (options.isAvailable && !options.isAvailable()) {
        record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'skipped', reason: 'Локальный helper недоступен.' });
        continue;
      }
      if (!context.projectId && context.permissionProfile !== 'full') {
        record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'skipped', reason: 'Для обработчика вне проекта нужен профиль Full access.' });
        continue;
      }

      const eventPayload = {
        schemaVersion: 1,
        event: input.event,
        projectId: input.projectId,
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.resource ? { resource: input.resource } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
      };
      const eventBytes = Buffer.from(JSON.stringify(eventPayload), 'utf8');
      if (eventBytes.byteLength > MAX_HOOK_BYTES) {
        record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'failed', reason: 'Контекст события превышает безопасный лимит.' });
        continue;
      }
      const localController = new AbortController();
      let timedOut = false;
      const abortFromTurn = (): void => localController.abort();
      parentSignal.addEventListener('abort', abortFromTurn, { once: true });
      if (parentSignal.aborted) localController.abort();
      const timer = setTimeout(() => { timedOut = true; localController.abort(); }, timeoutMs);
      try {
        const output = await options.tools.runPowerShell(context.projectId, context.permissionProfile, handler.actionContents, {
          timeoutMs,
          maxOutputBytes: 8 * 1024,
          signal: localController.signal,
          expectedWorkingFolder: context.projectWorkingFolder,
          skillId: context.skillId,
          inputDataBase64: eventBytes.toString('base64'),
        });
        if (parentSignal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        if (timedOut || output.timedOut || output.outputLimited || output.exitCode !== 0
          || Buffer.byteLength(output.stdout, 'utf8') > 8 * 1024) {
          record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'failed', reason: timedOut || output.timedOut ? 'Превышен лимит выполнения Hook.' : 'Команда Hook завершилась с ошибкой или превысила лимит вывода.' });
          continue;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(output.stdout.trim()) as unknown; }
        catch {
          record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'failed', reason: 'Hook должен вернуть JSON-объект с необязательным decision.' });
          continue;
        }
        if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== 'decision')
          || 'decision' in parsed && parsed.decision !== 'allow' && parsed.decision !== 'block') {
          record({ hookId: handler.id, hookName: handler.name, event: input.event, status: 'failed', reason: 'Hook вернул JSON вне ограниченной схемы.' });
          continue;
        }
        const decision = 'decision' in parsed ? parsed.decision as 'allow' | 'block' : undefined;
        record({
          hookId: handler.id,
          hookName: handler.name,
          event: input.event,
          status: decision === 'block' ? 'blocked' : 'completed',
          ...(decision ? { decision } : {}),
          ...(decision === 'block' ? { reason: 'Hook явно заблокировал действие.' } : {}),
        });
      } catch (error) {
        if (parentSignal.aborted || isAbortError(error) && !timedOut) {
          record({
            hookId: handler.id,
            hookName: handler.name,
            event: input.event,
            status: 'cancelled',
            reason: parentSignal.aborted ? 'Hook отменён вместе с текущим ходом.' : 'Выполнение Hook было отменено.',
          });
          throw new HookDispatchAbortError(results);
        }
        record({
          hookId: handler.id,
          hookName: handler.name,
          event: input.event,
          status: error instanceof LocalToolError && error.code === 'PERMISSION_DENIED' ? 'skipped' : 'failed',
          reason: timedOut ? 'Превышен лимит выполнения Hook.' : 'Команда Hook не смогла завершиться безопасно.',
        });
      } finally {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', abortFromTurn);
      }
      const last = results[results.length - 1];
      if ((input.event === 'before-tool' || input.event === 'permission-request')
        && (last?.status !== 'completed' || last.decision === 'block')) break;
    }
    return results;
  };
}

export function createHookApprovalGate<TDetails>(options: {
  dispatch: ReturnType<typeof createHookDispatcher>;
  isSuppressed(): boolean;
  requestApproval(details: TDetails, signal?: AbortSignal): Promise<boolean>;
  onResult?(result: HookRunResult): void;
}): {
  request(details: TDetails, signal?: AbortSignal, context?: HookApprovalRequestContext): Promise<boolean>;
} {
  let permissionHookDepth = 0;
  return {
    request: async (details, signal, context) => {
      if (options.isSuppressed()) return false;
      const matchesExecution = context
        && context.execution.projectId === context.projectId
        && context.execution.projectWorkingFolder === context.workingFolder
        && context.execution.permissionProfile === context.profile
        && context.execution.skillId === context.skillId;
      if (matchesExecution && permissionHookDepth === 0) {
        permissionHookDepth += 1;
        try {
          let results: HookRunResult[];
          try {
            results = await options.dispatch(context.execution, {
              event: 'permission-request',
              projectId: context.projectId,
              resource: context.resource,
              action: context.action,
            }, signal ?? new AbortController().signal, { maxHandlers: 2, timeoutMs: 1_000 });
          } catch (error) {
            if (error instanceof HookDispatchAbortError) {
              for (const result of error.hookResults) options.onResult?.(result);
            }
            throw error;
          }
          for (const result of results) options.onResult?.(result);
          if (results.some((result) => result.status === 'failed' || result.status === 'blocked' || result.status === 'cancelled' || result.decision === 'block')) return false;
        } finally {
          permissionHookDepth -= 1;
        }
      }
      if (options.isSuppressed()) return false;
      return options.requestApproval(details, signal);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
    || isRecord(error) && error.code === 'ABORT_ERR';
}

interface LocatedHook {
  record: Omit<HookRecord, 'enabled' | 'trusted' | 'unavailableReason'>;
  manifestContents: string;
  actionContents: string;
  ownerEnabled: boolean;
}

interface HookStateEntry {
  enabled: boolean;
  reviewedHash: string | null;
}

interface HookState {
  schemaVersion: 1;
  entries: Map<string, HookStateEntry>;
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

function parseHook(value: unknown): Omit<LocatedHook['record'], 'id' | 'origin' | 'scope' | 'owner' | 'ownerId' | 'source' | 'available' | 'contentHash'> {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== 'string'
    || typeof value.description !== 'string' || !validEvent(value.event)
    || typeof value.actionFile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.ps1$/i.test(value.actionFile)) {
    throw new Error('Ожидается hook.json версии 1 с именем, описанием, событием и PowerShell-файлом действия.');
  }
  const name = value.name.trim();
  const description = value.description.trim();
  if (!name || name.length > 120 || /[\r\n\0]/.test(name) || !description || description.length > 300 || /[\r\n\0]/.test(description)) {
    throw new Error('Имя Hook должно быть до 120 символов, описание — до 300.');
  }
  return { name, description, event: value.event, actionFile: value.actionFile };
}

async function readOwnedText(root: string, path: string, maximumBytes: number, label: string): Promise<{ contents: string; bytes: Buffer }> {
  await assertOwnedPath(root, path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumBytes) {
    throw new Error(`${label} должен быть обычным отдельным файлом размером не более ${Math.floor(maximumBytes / 1024)} КБ.`);
  }
  const bytes = await readFile(path);
  if (bytes.length > maximumBytes) throw new Error(`${label} превышает допустимый размер.`);
  await assertOwnedPath(root, path);
  try {
    return { contents: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes };
  } catch {
    throw new Error(`${label} должен быть в UTF-8.`);
  }
}

function parseState(value: unknown): HookState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error('Файл состояния Hooks имеет неизвестный формат; настройки не изменены.');
  }
  const entries = new Map<string, HookStateEntry>();
  for (const item of value.entries) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.length > 512 || /[\r\n\0]/.test(item.id)
      || typeof item.enabled !== 'boolean'
      || !(item.reviewedHash === null || typeof item.reviewedHash === 'string' && /^[a-f0-9]{64}$/.test(item.reviewedHash))
      || entries.has(item.id)) {
      throw new Error('Файл состояния Hooks повреждён; настройки не изменены.');
    }
    entries.set(item.id, { enabled: item.enabled, reviewedHash: item.reviewedHash as string | null });
  }
  return { schemaVersion: 1, entries };
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
}): {
  list(): Promise<HookRegistrySnapshot>;
  inspect(id: unknown): Promise<HookInspection & { name: string; event: HookEvent; source: string }>;
  trust(id: unknown, expectedHash: unknown): Promise<HookRegistrySnapshot>;
  setEnabled(id: unknown, enabled: unknown): Promise<HookRegistrySnapshot>;
  getExecutable(event: HookEvent, context: { projectId: string | null; skillId: string | null }): Promise<HookExecutableAction[]>;
  recordResult(result: HookRunResult): void;
} {
  if (!isAbsolute(options.userDataPath)) throw new Error('Путь данных приложения должен быть абсолютным.');
  const userDataPath = resolve(options.userDataPath);
  const hooksRoot = join(userDataPath, 'hooks');
  const skillsRoot = join(userDataPath, 'skills');
  const statePath = join(hooksRoot, 'state.json');
  let stateQueue: Promise<void> = Promise.resolve();
  const lastResults = new Map<string, NonNullable<HookRecord['lastRun']>>();

  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const result = stateQueue.then(action);
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensureRoot = async (): Promise<void> => {
    await mkdir(userDataPath, { recursive: true });
    const info = await lstat(userDataPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог данных приложения недоступен.');
    await assertOwnedPath(userDataPath, hooksRoot);
    await mkdir(hooksRoot, { recursive: true });
    await assertOwnedPath(userDataPath, hooksRoot);
  };

  const loadState = async (): Promise<HookState> => {
    await assertOwnedPath(userDataPath, statePath);
    let info;
    try { info = await lstat(statePath); }
    catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, entries: new Map() };
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_STATE_BYTES) {
      throw new Error('Файл состояния Hooks должен быть отдельным обычным файлом ограниченного размера.');
    }
    const bytes = await readFile(statePath);
    if (bytes.length > MAX_STATE_BYTES) throw new Error('Файл состояния Hooks превышает допустимый размер.');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new Error('Файл состояния Hooks повреждён; настройки не изменены.'); }
    return parseState(value);
  };

  const saveState = async (state: HookState): Promise<void> => {
    await assertOwnedPath(userDataPath, statePath);
    const existing = await lstat(statePath).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
      throw new Error('Файл состояния Hooks не является отдельным обычным файлом.');
    }
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    const entries = [...state.entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, entry]) => ({ id, enabled: entry.enabled, reviewedHash: entry.reviewedHash }));
    const contents = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAX_STATE_BYTES) throw new Error('Файл состояния Hooks превысит допустимый размер.');
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      await assertOwnedPath(userDataPath, temporary);
      const info = await lstat(temporary);
      if (!info.isFile() || info.nlink !== 1) throw new Error('Временный файл состояния Hooks небезопасен.');
      await rename(temporary, statePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  const scanContainer = async (input: {
    container: string;
    origin: HookOrigin;
    owner: string;
    ownerId: string | null;
    ownerEnabled: boolean;
    scope: string;
    idPrefix: string;
  }, issues: HookIssue[]): Promise<LocatedHook[]> => {
    let entries;
    try {
      await assertOwnedPath(userDataPath, input.container);
      entries = await readdir(input.container, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      issues.push({ source: input.scope, reason: error instanceof Error ? error.message : 'Каталог Hook недоступен.' });
      return [];
    }
    const records: LocatedHook[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) continue;
      const directory = join(input.container, entry.name);
      const manifest = join(directory, 'hook.json');
      const source = `${input.scope}/${entry.name}/hook.json`;
      try {
        const manifestFile = await readOwnedText(userDataPath, manifest, MAX_HOOK_BYTES, 'hook.json');
        const parsed = parseHook(JSON.parse(manifestFile.contents) as unknown);
        const actionPath = join(directory, parsed.actionFile);
        const actionFile = await readOwnedText(userDataPath, actionPath, MAX_ACTION_BYTES, 'Файл действия Hook');
        const contentHash = createHash('sha256')
          .update(manifestFile.bytes)
          .update(Buffer.from([0]))
          .update(actionFile.bytes)
          .digest('hex');
        records.push({
          record: {
            ...parsed,
            id: `${input.idPrefix}/${entry.name}`,
            origin: input.origin,
            scope: input.scope,
            owner: input.owner,
            ownerId: input.ownerId,
            source,
            available: input.origin !== 'plugin' && (input.origin !== 'skill' || input.ownerEnabled),
            contentHash,
          },
          manifestContents: manifestFile.contents,
          actionContents: actionFile.contents,
          ownerEnabled: input.ownerEnabled,
        });
      } catch (error) {
        issues.push({ source, reason: error instanceof Error ? error.message : 'Источник Hook недоступен.' });
      }
    }
    return records;
  };

  const scanSources = async (): Promise<{ located: LocatedHook[]; issues: HookIssue[] }> => {
    await ensureRoot();
    const [projects, skills] = await Promise.all([options.listProjects(), options.listSkills()]);
    const issues: HookIssue[] = [];
    const located: LocatedHook[] = [];
    located.push(...await scanContainer({
      container: join(hooksRoot, 'global'), origin: 'global', owner: 'Приложение', ownerId: null,
      ownerEnabled: true, scope: 'Global', idPrefix: 'global',
    }, issues));
    located.push(...await scanContainer({
      container: join(hooksRoot, 'plugins'), origin: 'plugin', owner: 'Plugin', ownerId: null,
      ownerEnabled: false, scope: 'Plugin', idPrefix: 'plugin',
    }, issues));
    for (const project of projects) {
      located.push(...await scanContainer({
        container: join(hooksRoot, 'projects', project.id), origin: 'project', owner: project.name, ownerId: project.id,
        ownerEnabled: true, scope: `Project · ${project.name}`, idPrefix: `project/${project.id}`,
      }, issues));
    }
    for (const skill of skills) {
      const skillDirectory = skill.scope === 'global'
        ? join(skillsRoot, 'global', skill.command)
        : join(skillsRoot, 'projects', skill.projectId ?? '', skill.command);
      located.push(...await scanContainer({
        container: join(skillDirectory, 'hooks'), origin: 'skill', owner: skill.name, ownerId: skill.id,
        ownerEnabled: skill.enabled, scope: `Skill · ${skill.name}`, idPrefix: `skill/${skill.id}`,
      }, issues));
    }
    located.sort((a, b) => a.record.scope.localeCompare(b.record.scope) || a.record.name.localeCompare(b.record.name));
    return { located, issues };
  };

  const buildSnapshot = async (): Promise<{ snapshot: HookRegistrySnapshot; located: LocatedHook[]; stateValid: boolean }> => {
    const scanned = await scanSources();
    let state: HookState;
    let stateValid = true;
    try { state = await loadState(); }
    catch (error) {
      state = { schemaVersion: 1, entries: new Map() };
      stateValid = false;
      scanned.issues.push({ source: 'hooks/state.json', reason: error instanceof Error ? error.message : 'Состояние Hooks недоступно.' });
    }
    if (stateValid) {
      let changed = false;
      for (const item of scanned.located) {
        const entry = state.entries.get(item.record.id);
        if (entry?.reviewedHash && entry.reviewedHash !== item.record.contentHash) {
          entry.reviewedHash = null;
          changed = true;
        }
      }
      const currentIds = new Set(scanned.located.map((item) => item.record.id));
      for (const id of state.entries.keys()) {
        if (!currentIds.has(id)) {
          state.entries.delete(id);
          changed = true;
        }
      }
      if (changed) {
        try { await saveState(state); }
        catch (error) {
          stateValid = false;
          scanned.issues.push({ source: 'hooks/state.json', reason: error instanceof Error ? error.message : 'Не удалось отозвать доверие к изменённому Hook.' });
        }
      }
    }
    const hooks = scanned.located.map(({ record }) => {
      const entry = state.entries.get(record.id);
      const enabled = stateValid && Boolean(entry?.enabled);
      const trusted = stateValid && entry?.reviewedHash === record.contentHash;
      let unavailableReason = '';
      if (!record.available) unavailableReason = record.origin === 'plugin'
        ? 'Plugin/MCP hooks не поддерживаются.'
        : 'Включите Skill, чтобы использовать его Hook.';
      else if (!trusted) unavailableReason = 'Источник не доверен; проверьте содержимое и подтвердите эту версию.';
      else if (!enabled) unavailableReason = 'Hook выключен.';
      const lastRun = lastResults.get(record.id);
      return { ...record, enabled, trusted, unavailableReason, ...(lastRun ? { lastRun } : {}) };
    });
    return { snapshot: { hooks, issues: scanned.issues }, located: scanned.located, stateValid };
  };

  const requireSupported = (record: LocatedHook): void => {
    if (record.record.origin === 'plugin') throw new Error('Plugin/MCP hooks не поддерживаются.');
    if (record.record.origin === 'skill' && !record.ownerEnabled) throw new Error('Включите Skill, чтобы использовать его Hook.');
  };

  const requireId = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value)) {
      throw new Error('Некорректный идентификатор Hook.');
    }
    return value;
  };

  const requireLocated = (located: LocatedHook[], id: string): LocatedHook => {
    const record = located.find((item) => item.record.id === id);
    if (!record) throw new Error('Hook отсутствует или его источник недоступен.');
    return record;
  };

  const list = (): Promise<HookRegistrySnapshot> => serialized(async () => (await buildSnapshot()).snapshot);

  return {
    list,
    recordResult: (result) => {
      if (typeof result.hookId !== 'string' || !result.hookId) return;
      lastResults.delete(result.hookId);
      lastResults.set(result.hookId, {
        event: result.event,
        status: result.status,
        ...(result.reason ? { reason: result.reason.slice(0, 240) } : {}),
        at: new Date().toISOString(),
      });
      while (lastResults.size > 256) {
        const oldest = lastResults.keys().next().value as string | undefined;
        if (!oldest) break;
        lastResults.delete(oldest);
      }
    },
    inspect: async (idInput) => {
      const id = requireId(idInput);
      const { located } = await scanSources();
      const item = requireLocated(located, id);
      return {
        id,
        contentHash: item.record.contentHash,
        manifestContents: item.manifestContents,
        actionContents: item.actionContents,
        name: item.record.name,
        event: item.record.event,
        source: item.record.source,
      };
    },
    trust: async (idInput, expectedHash) => {
      const id = requireId(idInput);
      if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Хэш Hook для проверки некорректен.');
      await serialized(async () => {
        const { located } = await scanSources();
        const item = requireLocated(located, id);
        requireSupported(item);
        if (item.record.contentHash !== expectedHash) throw new Error('Содержимое Hook изменилось после просмотра; откройте его заново.');
        const state = await loadState();
        const previous = state.entries.get(id);
        state.entries.set(id, { enabled: previous?.enabled ?? false, reviewedHash: expectedHash });
        await saveState(state);
      });
      return list();
    },
    setEnabled: async (idInput, enabledInput) => {
      const id = requireId(idInput);
      if (typeof enabledInput !== 'boolean') throw new Error('Состояние Hook должно быть логическим значением.');
      await serialized(async () => {
        const { located } = await scanSources();
        const item = requireLocated(located, id);
        requireSupported(item);
        const state = await loadState();
        const previous = state.entries.get(id);
        if (enabledInput && previous?.reviewedHash !== item.record.contentHash) {
          throw new Error('Сначала проверьте и подтвердите текущую версию Hook.');
        }
        state.entries.set(id, { enabled: enabledInput, reviewedHash: previous?.reviewedHash ?? null });
        await saveState(state);
      });
      return list();
    },
    getExecutable: (event, context) => serialized(async () => {
      const { snapshot, located } = await buildSnapshot();
      const executable = new Map(snapshot.hooks
        .filter((hook) => hook.event === event && hook.enabled && hook.trusted && hook.available)
        .filter((hook) => hook.origin === 'global'
          || hook.origin === 'project' && hook.ownerId === context.projectId
          || hook.origin === 'skill' && hook.ownerId === context.skillId)
        .map((hook) => [hook.id, hook]));
      return located
        .filter((item) => executable.has(item.record.id))
        .map((item) => ({
          id: item.record.id,
          name: item.record.name,
          contentHash: item.record.contentHash,
          manifestContents: item.manifestContents,
          actionContents: item.actionContents,
          event: item.record.event,
        }));
    }),
  };
}
