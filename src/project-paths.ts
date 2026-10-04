import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const MAX_PROJECT_INSTRUCTION_BYTES = 64 * 1024;

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
}

function containsPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function assertAbsolutePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('Путь к рабочей папке проекта должен быть абсолютным.');
  }
}

export async function validateProjectFolder(value: unknown, redirectedDocumentsPath?: string | null): Promise<string> {
  assertAbsolutePath(value);
  const folder = resolve(value);
  const allowedDocumentsAlias = redirectedDocumentsPath ? resolve(redirectedDocumentsPath) : null;
  const folderIsInDocumentsAlias = allowedDocumentsAlias !== null && containsPath(allowedDocumentsAlias, folder);
  const pathRoot = parse(folder).root;
  let allowedDocumentsPhysical: string | null = null;
  let canonicalFolder: string;
  if (folderIsInDocumentsAlias && allowedDocumentsAlias) {
    allowedDocumentsPhysical = await realpath(allowedDocumentsAlias);
    const relativeFolder = relative(allowedDocumentsAlias, folder);
    const expectedPhysicalFolder = resolve(allowedDocumentsPhysical, relativeFolder);
    let current = allowedDocumentsPhysical;
    for (const component of relativeFolder.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, component);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Рабочая папка проекта не может проходить через ссылку или junction.');
      if (!info.isDirectory()) throw new Error('Рабочая папка проекта содержит компонент, который не является папкой.');
    }
    canonicalFolder = await realpath(folder);
    if (!samePath(canonicalFolder, expectedPhysicalFolder)) {
      throw new Error('Папка проекта вышла за пределы перенаправленной папки Documents.');
    }
  } else {
    let current = pathRoot;
    const components = folder.slice(pathRoot.length).split(/[\\/]+/).filter(Boolean);
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Рабочая папка проекта не может проходить через ссылку или junction.');
      if (index < components.length - 1 && !info.isDirectory()) {
        throw new Error('Рабочая папка проекта содержит компонент, который не является папкой.');
      }
    }
    canonicalFolder = await realpath(folder);
    if (!samePath(canonicalFolder, folder)) {
      throw new Error('Рабочая папка проекта была перенаправлена через ссылку или junction.');
    }
  }

  const finalInfo = await lstat(canonicalFolder);
  if (!finalInfo.isDirectory()) throw new Error('Рабочая папка проекта не является папкой.');
  return canonicalFolder;
}

export async function validateProjectInstructionsPath(workingFolder: string): Promise<string> {
  const folder = await validateProjectFolder(workingFolder);
  const instructionsPath = join(folder, 'AGENTS.md');
  const info = await lstat(instructionsPath).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isFile())) {
    throw new Error('AGENTS.md должен быть обычным файлом, а не ссылкой или папкой.');
  }
  if (info && info.size > MAX_PROJECT_INSTRUCTION_BYTES) {
    throw new Error('Инструкция должна быть текстом размером не более 64 КБ.');
  }
  if (info && !samePath(await realpath(instructionsPath), instructionsPath)) {
    throw new Error('AGENTS.md перенаправлен; запись остановлена.');
  }
  return instructionsPath;
}
