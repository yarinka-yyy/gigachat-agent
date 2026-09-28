import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const FILE_NAME = 'authorization-key.bin';
const HEADER = Buffer.from('GIGA-SECRET-1\n', 'utf8');
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_STORED_BYTES = MAX_SECRET_BYTES * 4 + 64 * 1024;

export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface SecureStoreStatus {
  available: boolean;
  saved: boolean;
  usable: boolean;
}

export function createSecureStore(userDataPath: string, safeStorage: AsyncSafeStorage) {
  let operationQueue: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const getPaths = async (): Promise<{ directory: string; filePath: string }> => {
    const rootPath = resolve(userDataPath);
    try {
      const rootStat = await lstat(rootPath);
      if (!isAbsolute(userDataPath) || rootPath.includes('\0') || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('invalid-root');
      }
      const root = await realpath(rootPath);
      if (root !== rootPath) throw new Error('reparse-root');
      const directory = join(rootPath, 'secrets');
      return { directory, filePath: join(directory, FILE_NAME) };
    } catch {
      throw new Error('Каталог локальных данных приложения недоступен.');
    }
  };

  const assertOwnedDirectory = async (create: boolean): Promise<{ directory: string; filePath: string } | null> => {
    const paths = await getPaths();
    let directoryStat;
    try {
      directoryStat = await lstat(paths.directory);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        if (!create) return null;
      } else {
        throw new Error('Каталог защищённого хранилища недоступен.');
      }
      await mkdir(paths.directory).catch(() => undefined);
      directoryStat = await lstat(paths.directory).catch(() => null);
    }
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Каталог защищённого хранилища не может быть ссылкой.');
    }
    if ((await realpath(paths.directory)) !== paths.directory) {
      throw new Error('Каталог защищённого хранилища вышел за границу данных приложения.');
    }
    return paths;
  };

  const readEncrypted = async (): Promise<Buffer | null> => {
    const paths = await assertOwnedDirectory(false);
    if (!paths) return null;
    const { filePath } = paths;
    let fileStat;
    try {
      fileStat = await lstat(filePath);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw new Error('Не удалось проверить защищённое хранилище.');
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || (await realpath(filePath)) !== filePath) {
      throw new Error('Файл защищённого хранилища не может быть ссылкой.');
    }
    if (fileStat.size > MAX_STORED_BYTES) throw new Error('Файл защищённого хранилища превышает допустимый размер.');
    try {
      return await readFile(filePath);
    } catch {
      throw new Error('Не удалось прочитать защищённое хранилище.');
    }
  };

  const assertAvailable = async (): Promise<void> => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Защищённое хранилище ОС недоступно; ключ не сохранён.');
    }
  };

  const saveUnlocked = async (input: unknown): Promise<void> => {
    if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input.trim(), 'utf8') > MAX_SECRET_BYTES) {
      throw new Error('Введите ключ длиной не более 16 КБ.');
    }
    await assertAvailable();
    let encrypted: Buffer;
    try {
      encrypted = await safeStorage.encryptStringAsync(input.trim());
    } catch {
      throw new Error('Не удалось зашифровать ключ средствами ОС; прежнее значение сохранено.');
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new Error('ОС не вернула зашифрованные данные; ключ не сохранён.');
    }

    const paths = await assertOwnedDirectory(true);
    if (!paths) throw new Error('Каталог защищённого хранилища недоступен.');
    const { directory, filePath } = paths;
    const temporaryPath = join(directory, `.authorization-key-${randomUUID()}.tmp`);
    if (HEADER.length + encrypted.length > MAX_STORED_BYTES) {
      throw new Error('ОС вернула слишком большой зашифрованный ключ.');
    }
    try {
      await writeFile(temporaryPath, Buffer.concat([HEADER, encrypted]), { flag: 'wx', mode: 0o600 });
      if (!(await assertOwnedDirectory(false))) throw new Error('Каталог защищённого хранилища недоступен.');
      const existing = await lstat(filePath).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || (await realpath(filePath)) !== filePath)) {
        throw new Error('Файл защищённого хранилища не может быть ссылкой.');
      }
      await rename(temporaryPath, filePath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error('Не удалось сохранить ключ в защищённом хранилище.');
    }
  };

  const decrypt = async (contents: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> => {
    if (contents.length <= HEADER.length || !contents.subarray(0, HEADER.length).equals(HEADER)) {
      throw new Error('Файл защищённого хранилища повреждён; исходные данные не изменены.');
    }
    await assertAvailable();
    try {
      const decrypted = await safeStorage.decryptStringAsync(contents.subarray(HEADER.length));
      if (typeof decrypted.result !== 'string') throw new Error('invalid-result');
      return decrypted;
    } catch {
      throw new Error('Не удалось расшифровать ключ средствами ОС.');
    }
  };

  const loadUnlocked = async (): Promise<string | null> => {
    const contents = await readEncrypted();
    if (!contents) return null;
    const decrypted = await decrypt(contents);
    if (decrypted.shouldReEncrypt) await saveUnlocked(decrypted.result);
    return decrypted.result;
  };

  const statusUnlocked = async (): Promise<SecureStoreStatus> => {
    const available = await safeStorage.isAsyncEncryptionAvailable();
    const contents = await readEncrypted();
    if (!contents) return { available, saved: false, usable: false };
    if (!available) return { available: false, saved: true, usable: false };
    try {
      await decrypt(contents);
      return { available: true, saved: true, usable: true };
    } catch {
      return { available: true, saved: true, usable: false };
    }
  };

  const clearUnlocked = async (): Promise<void> => {
    const paths = await getPaths();
    const directoryStat = await lstat(paths.directory).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw new Error('Каталог защищённого хранилища недоступен.');
    });
    if (!directoryStat) return;
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (await realpath(paths.directory)) !== paths.directory) {
      throw new Error('Каталог защищённого хранилища не может быть ссылкой.');
    }
    const fileStat = await lstat(paths.filePath).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw new Error('Не удалось проверить защищённое хранилище.');
    });
    if (!fileStat) return;
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || (await realpath(paths.filePath)) !== paths.filePath) {
      throw new Error('Файл защищённого хранилища не может быть ссылкой.');
    }
    await rm(paths.filePath);
  };

  return {
    clear: () => serialize(clearUnlocked),
    load: () => serialize(loadUnlocked),
    save: (input: unknown) => serialize(() => saveUnlocked(input)),
    status: () => serialize(statusUnlocked),
  };
}
