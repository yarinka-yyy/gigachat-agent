import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import manifest from '../resources/voice/manifest.json';

interface ModelFile { name: string; sizeBytes: number; sha256: string }
interface ModelSet { runtimeVersion: string; files: readonly ModelFile[] }

const pinnedModels: ModelSet = {
  runtimeVersion: manifest.runtime.version,
  files: [...manifest.recognition.files, manifest.vad.file],
};

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function requireDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink()
    || !samePath(await realpath(path), resolve(path))) throw new Error('Unsafe voice model directory.');
}

async function requireFile(path: string, independent: boolean): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (independent && info.nlink !== 1)
    || !samePath(await realpath(path), resolve(path))) throw new Error('Unsafe voice model file.');
}

async function verifyModel(path: string, file: ModelFile, independent: boolean): Promise<void> {
  await requireFile(path, independent);
  if ((await lstat(path)).size !== file.sizeBytes) throw new Error('Voice model size mismatch.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256) throw new Error('Voice model checksum mismatch.');
}

export interface VoiceModelCache {
  modelDirectory: string;
  cacheDirectory: string;
  validate(): Promise<void>;
}

// gigastt 2.21 CPU writes optimized graphs beside --model-dir. Independent
// copies keep those writes in the profile, including for read-only installs.
export async function prepareVoiceModelCache(
  userDataPath: string,
  sourceDirectory: string,
  models: ModelSet = pinnedModels,
): Promise<VoiceModelCache> {
  if (!models.files.length || models.files.some((file) => !/^[a-zA-Z0-9_.-]+$/.test(file.name)
    || file.name === '.' || file.name === '..' || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new Error('Invalid pinned voice model manifest.');
  }
  await requireDirectory(userDataPath);
  await requireDirectory(sourceDirectory);
  const root = join(userDataPath, 'voice-cache');
  await mkdir(root, { recursive: true });
  await requireDirectory(root);
  const identity = createHash('sha256').update(JSON.stringify(models)).digest('hex').slice(0, 16);
  const modelDirectory = join(root, `models-${identity}`);
  const exists = await lstat(modelDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) {
    const stage = await mkdtemp(join(root, '.models-'));
    try {
      await requireDirectory(stage);
      for (const file of models.files) {
        const source = join(sourceDirectory, file.name);
        await verifyModel(source, file, false);
        await copyFile(source, join(stage, file.name), constants.COPYFILE_EXCL);
        await verifyModel(join(stage, file.name), file, true);
      }
      await requireDirectory(root);
      await rename(stage, modelDirectory);
    } catch (error) {
      // Delete only known regular staging copies, never a recursive tree.
      await requireDirectory(stage);
      for (const file of models.files) {
        const path = join(stage, file.name);
        const info = await lstat(path).catch((cleanupError: NodeJS.ErrnoException) => {
          if (cleanupError.code === 'ENOENT') return null;
          throw cleanupError;
        });
        if (!info) continue;
        await requireFile(path, true);
        await unlink(path);
      }
      await rmdir(stage);
      throw error;
    }
  }
  await requireDirectory(modelDirectory);
  for (const file of models.files) await verifyModel(join(modelDirectory, file.name), file, true);
  const cacheDirectory = join(modelDirectory, 'optimized_cache');
  await mkdir(cacheDirectory, { recursive: true });
  const validate = async (): Promise<void> => {
    await requireDirectory(userDataPath);
    await requireDirectory(root);
    await requireDirectory(modelDirectory);
    await requireDirectory(cacheDirectory);
    for (const file of models.files) await requireFile(join(modelDirectory, file.name), true);
    for (const name of await readdir(cacheDirectory)) await requireFile(join(cacheDirectory, name), true);
  };
  await validate();
  return { modelDirectory, cacheDirectory, validate };
}
