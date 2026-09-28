import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse } from '@iarna/toml';

export const LOCAL_ACTIONS = ['list', 'search', 'read', 'write', 'open', 'execute'] as const;
export type LocalAction = typeof LOCAL_ACTIONS[number];
export type LocalDecision = 'allow' | 'ask' | 'deny';
export type LocalRules = Record<LocalAction, LocalDecision>;
export type CustomRoot = { name: string; path: string; rules: LocalRules };
export type CustomPolicy = { project: LocalRules; roots: CustomRoot[] };

export const DEFAULT_CUSTOM_CONFIG = `# Правила применяются только к доступным локальным инструментам.
# Дополнительный каталог: [[permissions.custom.roots]], name, path и правила ниже.
version = 1

[permissions.custom.project]
list = "allow"
search = "allow"
read = "allow"
write = "ask"
open = "ask"
execute = "ask"
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`Неизвестное поле config.toml: ${key}.`);
  }
}

function parseRules(value: unknown, requireAll: boolean): LocalRules {
  if (!isRecord(value)) throw new Error('Правила разрешений должны быть таблицей.');
  checkKeys(value, LOCAL_ACTIONS);
  const rules = {} as LocalRules;
  for (const action of LOCAL_ACTIONS) {
    const decision = value[action];
    if (decision === undefined && !requireAll) rules[action] = 'deny';
    else if (decision === 'allow' || decision === 'ask' || decision === 'deny') rules[action] = decision;
    else throw new Error(`Для ${action} укажите allow, ask или deny.`);
  }
  return rules;
}

export function parseCustomConfig(contents: string): CustomPolicy {
  if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > 64 * 1024) {
    throw new Error('config.toml должен быть текстом размером до 64 КБ.');
  }
  let document: unknown;
  try { document = parse(contents); }
  catch (error) { throw new Error(`Ошибка TOML: ${error instanceof Error ? error.message : 'неверный формат'}`); }
  if (!isRecord(document)) throw new Error('config.toml должен содержать таблицу.');
  checkKeys(document, ['version', 'permissions']);
  if (document.version !== 1 || !isRecord(document.permissions)) throw new Error('Ожидается config.toml версии 1.');
  checkKeys(document.permissions, ['custom']);
  const custom = document.permissions.custom;
  if (!isRecord(custom)) throw new Error('Добавьте таблицу [permissions.custom.project].');
  checkKeys(custom, ['project', 'roots']);
  const project = parseRules(custom.project, true);
  const rootsInput = custom.roots ?? [];
  if (!Array.isArray(rootsInput) || rootsInput.length > 16) throw new Error('Допускается не более 16 дополнительных каталогов.');
  const roots: CustomRoot[] = rootsInput.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error('Дополнительный каталог должен быть таблицей.');
    checkKeys(entry, ['name', 'path', ...LOCAL_ACTIONS]);
    if (typeof entry.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.name)
      || typeof entry.path !== 'string' || !isAbsolute(entry.path) || !/^[A-Za-z]:[\\/]/.test(entry.path)) {
      throw new Error('Каталогу нужны уникальное имя латиницей и локальный абсолютный путь с буквой диска.');
    }
    return { name: entry.name, path: entry.path, rules: parseRules(Object.fromEntries(
      LOCAL_ACTIONS.filter((action) => entry[action] !== undefined).map((action) => [action, entry[action]])), false) };
  });
  if (new Set(roots.map((root) => root.name)).size !== roots.length) throw new Error('Имена дополнительных каталогов должны быть уникальны.');
  return { project, roots };
}

export async function openCustomPermissions(directory: string): Promise<{
  read(): Promise<string>;
  save(contents: string, expectedContents: string): Promise<string>;
  policy(): Promise<CustomPolicy>;
}> {
  if (!isAbsolute(directory)) throw new Error('Путь данных приложения должен быть абсолютным.');
  const path = join(directory, 'config.toml');
  let lastValidPolicy: CustomPolicy | null = null;
  await writeFile(path, DEFAULT_CUSTOM_CONFIG, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const read = async (): Promise<string> => {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) return DEFAULT_CUSTOM_CONFIG;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('config.toml должен быть обычным файлом.');
    const contents = await readFile(path, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 64 * 1024) throw new Error('config.toml превышает 64 КБ.');
    return contents;
  };
  try { lastValidPolicy = parseCustomConfig(await read()); }
  catch { /* Invalid external edits cannot replace the last valid policy. */ }
  const save = async (contents: string, expectedContents: string): Promise<string> => {
    const nextPolicy = parseCustomConfig(contents);
    if (await read() !== expectedContents) throw new Error('config.toml изменён снаружи. Обновите редактор перед сохранением.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: 'wx' });
      if (await read() !== expectedContents) throw new Error('config.toml изменён снаружи. Обновите редактор перед сохранением.');
      await rename(temporary, path);
      lastValidPolicy = nextPolicy;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return contents;
  };
  return { read, save, policy: async () => {
    try {
      const current = parseCustomConfig(await read());
      lastValidPolicy = current;
      return current;
    } catch (error) {
      if (lastValidPolicy) return lastValidPolicy;
      throw error;
    }
  } };
}
