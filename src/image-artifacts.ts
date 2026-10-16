import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { attachmentContentType, PROVIDER_IMAGE_LIMIT_BYTES } from './attachment-policy';
import type { ChatArtifact, ChatDetail } from './contracts';
import { inspectGeneratedImageBytes, type GeneratedImageDimensions } from './image-generation';
import type { LocalStore } from './store';

const MAX_IMAGE_BYTES = PROVIDER_IMAGE_LIMIT_BYTES;
const ACCESS_ERROR = 'Изображение недоступно или повреждено.';
const SAVE_ERROR = 'Не удалось безопасно сохранить изображение.';

export type GeneratedImageContentType = 'image/jpeg' | 'image/png';

export interface VerifiedGeneratedImage {
  bytes: Buffer;
  sha256: string;
  contentType: GeneratedImageContentType;
  dimensions: GeneratedImageDimensions;
  suggestedFileName: string;
  sourcePath: string;
  sourceRealPath: string;
  sourceIdentity: { dev: bigint; ino: bigint };
}

export type GeneratedImageStore = Pick<LocalStore, 'getChat' | 'getArtifactPath'>;

export type GeneratedImageDecoder = (
  bytes: Uint8Array,
  contentType: GeneratedImageContentType,
  dimensions: GeneratedImageDimensions,
) => void | Promise<void>;

export interface GeneratedImageCopyOptions {
  protectedRoots: readonly string[];
  /** Narrow failure seam for proving that a failed replacement preserves its target. */
  renameFile?: typeof rename;
}

function inaccessible(): Error {
  return new Error(ACCESS_ERROR);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function sameIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function expectedContentType(storedName: string): GeneratedImageContentType | null {
  if (storedName.endsWith('.png')) return 'image/png';
  if (storedName.endsWith('.jpg')) return 'image/jpeg';
  return null;
}

function artifactFor(detail: ChatDetail, artifactId: string): ChatArtifact | null {
  const matches = detail.artifacts.filter((artifact) => artifact.id === artifactId);
  return matches.length === 1 ? matches[0]! : null;
}

function assertCompletedImageLink(detail: ChatDetail, artifact: ChatArtifact, artifactId: string): void {
  if (detail.kind !== 'image' || !safeId(artifact.messageId)) throw inaccessible();
  const assistants = detail.messages.filter((message) => message.id === artifact.messageId);
  if (assistants.length !== 1) throw inaccessible();
  const assistant = assistants[0]!;
  if (assistant.role !== 'assistant' || assistant.source !== 'runtime'
    || !Array.isArray(assistant.attachmentIds) || assistant.attachmentIds.length !== 1
    || assistant.attachmentIds[0] !== artifactId) throw inaccessible();
  const assistantIndex = detail.messages.indexOf(assistant);
  const turns = detail.turns.filter((turn) => turn.assistantMessageId === assistant.id);
  if (turns.length !== 1) throw inaccessible();
  const turn = turns[0]!;
  const anchorIndex = detail.messages.findIndex((message) => message.id === turn.anchorMessageId && message.role === 'user');
  if (turn.status !== 'completed' || anchorIndex < 0 || anchorIndex >= assistantIndex) throw inaccessible();
}

export async function loadGeneratedImageArtifact(
  store: GeneratedImageStore,
  chatId: string,
  artifactId: string,
  validateDecodedImage: GeneratedImageDecoder,
): Promise<VerifiedGeneratedImage> {
  try {
    if (!safeId(chatId) || !safeId(artifactId)) throw inaccessible();
    const detail = await store.getChat(chatId);
    if (detail.id !== chatId) throw inaccessible();
    const artifact = artifactFor(detail, artifactId);
    if (!artifact || !safeId(artifact.id) || !Number.isSafeInteger(artifact.size)
      || artifact.size <= 0 || artifact.size > MAX_IMAGE_BYTES
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || typeof artifact.storedName !== 'string' || artifact.storedName !== `${artifactId}.png` && artifact.storedName !== `${artifactId}.jpg`) {
      throw inaccessible();
    }
    const contentType = expectedContentType(artifact.storedName);
    const displayType = typeof artifact.name === 'string' ? attachmentContentType(artifact.name) : null;
    if (!contentType || displayType?.kind !== 'image' || displayType.contentType !== contentType) throw inaccessible();
    assertCompletedImageLink(detail, artifact, artifactId);

    const sourcePath = await store.getArtifactPath(chatId, artifactId);
    if (!isAbsolute(sourcePath)) throw inaccessible();
    const initialPathInfo = await lstat(sourcePath, { bigint: true });
    if (!initialPathInfo.isFile() || initialPathInfo.isSymbolicLink()
      || initialPathInfo.size !== BigInt(artifact.size)) throw inaccessible();

    const handle = await open(sourcePath, 'r');
    let bytes: Buffer;
    let sourceRealPath: string;
    let sourceIdentity: { dev: bigint; ino: bigint };
    try {
      const openedInfo = await handle.stat({ bigint: true });
      const currentPathInfo = await lstat(sourcePath, { bigint: true });
      if (!openedInfo.isFile() || !currentPathInfo.isFile() || currentPathInfo.isSymbolicLink()
        || !sameIdentity(initialPathInfo, openedInfo) || !sameIdentity(openedInfo, currentPathInfo)
        || openedInfo.size !== BigInt(artifact.size) || currentPathInfo.size !== BigInt(artifact.size)) throw inaccessible();

      const bounded = Buffer.alloc(artifact.size + 1);
      let offset = 0;
      while (offset < bounded.byteLength) {
        const result = await handle.read(bounded, offset, bounded.byteLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== artifact.size) throw inaccessible();

      const finalOpenedInfo = await handle.stat({ bigint: true });
      const finalPathInfo = await lstat(sourcePath, { bigint: true });
      if (!finalPathInfo.isFile() || finalPathInfo.isSymbolicLink()
        || !sameIdentity(openedInfo, finalOpenedInfo) || !sameIdentity(openedInfo, finalPathInfo)
        || finalOpenedInfo.size !== BigInt(artifact.size) || finalPathInfo.size !== BigInt(artifact.size)) throw inaccessible();
      sourceRealPath = await realpath(sourcePath);
      sourceIdentity = { dev: finalOpenedInfo.dev, ino: finalOpenedInfo.ino };
      bytes = Buffer.from(bounded.subarray(0, offset));
    } finally {
      await handle.close();
    }

    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw inaccessible();
    const dimensions = inspectGeneratedImageBytes(bytes, contentType);
    if (!dimensions) throw inaccessible();
    await validateDecodedImage(bytes, contentType, dimensions);

    return {
      bytes,
      sha256: artifact.sha256,
      contentType,
      dimensions,
      suggestedFileName: contentType === 'image/png' ? 'Изображение.png' : 'Изображение.jpg',
      sourcePath,
      sourceRealPath,
      sourceIdentity,
    };
  } catch {
    throw inaccessible();
  }
}

interface ExistingFileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function snapshot(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): ExistingFileSnapshot {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}

function sameSnapshot(left: ExistingFileSnapshot, right: ExistingFileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function getDestinationSnapshot(path: string): Promise<ExistingFileSnapshot | null> {
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(SAVE_ERROR);
    return snapshot(info);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const info = await stat(resolved, { bigint: true });
  if (!info.isDirectory()) throw new Error(SAVE_ERROR);
  const canonical = await realpath(resolved);
  const canonicalInfo = await stat(canonical, { bigint: true });
  if (!canonicalInfo.isDirectory()) throw new Error(SAVE_ERROR);
  return canonical;
}

function validateVerifiedImage(image: VerifiedGeneratedImage): void {
  if (!Buffer.isBuffer(image.bytes) || image.bytes.byteLength <= 0 || image.bytes.byteLength > MAX_IMAGE_BYTES
    || (image.contentType !== 'image/png' && image.contentType !== 'image/jpeg')
    || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)
    || createHash('sha256').update(image.bytes).digest('hex') !== image.sha256
    || !isAbsolute(image.sourceRealPath) || !isAbsolute(image.sourcePath)) throw new Error(SAVE_ERROR);
  const dimensions = inspectGeneratedImageBytes(image.bytes, image.contentType);
  if (image.suggestedFileName !== (image.contentType === 'image/png' ? 'Изображение.png' : 'Изображение.jpg')
    || !Number.isSafeInteger(image.dimensions.width) || !Number.isSafeInteger(image.dimensions.height)
    || image.dimensions.width <= 0 || image.dimensions.height <= 0
    || !image.sourceIdentity || typeof image.sourceIdentity.dev !== 'bigint' || typeof image.sourceIdentity.ino !== 'bigint'
    || !dimensions || dimensions.width !== image.dimensions.width || dimensions.height !== image.dimensions.height) throw new Error(SAVE_ERROR);
}

export async function writeGeneratedImageCopy(
  image: VerifiedGeneratedImage,
  destination: string,
  options: GeneratedImageCopyOptions,
): Promise<void> {
  let tempPath: string | null = null;
  let tempIdentity: { dev: bigint; ino: bigint } | null = null;
  let tempOwned = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    validateVerifiedImage(image);
    if (typeof destination !== 'string' || !isAbsolute(destination) || options.protectedRoots.length === 0) throw new Error(SAVE_ERROR);
    const requested = resolve(destination);
    const requestedName = basename(requested);
    const requestedExtension = extname(requestedName).toLowerCase();
    const extensions = image.contentType === 'image/png' ? ['.png'] : ['.jpg', '.jpeg'];
    if (!requestedName || requestedName === '.' || requestedName === '..' || !extensions.includes(requestedExtension)) throw new Error(SAVE_ERROR);

    const parent = await canonicalDirectory(dirname(requested));
    const target = join(parent, requestedName);
    const protectedRoots = await Promise.all(options.protectedRoots.map(canonicalDirectory));
    if (protectedRoots.some((root) => isWithin(root, target))) throw new Error(SAVE_ERROR);
    if (samePath(target, image.sourceRealPath)) throw new Error(SAVE_ERROR);

    const originalTargetSnapshot = await getDestinationSnapshot(target);
    if (originalTargetSnapshot && sameIdentity(originalTargetSnapshot, image.sourceIdentity)) throw new Error(SAVE_ERROR);

    tempPath = join(parent, `.${requestedName}.${randomUUID()}.tmp`);
    handle = await open(tempPath, 'wx', 0o600);
    tempOwned = true;
    const createdInfo = await handle.stat({ bigint: true });
    if (!createdInfo.isFile()) throw new Error(SAVE_ERROR);
    tempIdentity = { dev: createdInfo.dev, ino: createdInfo.ino };
    await handle.writeFile(image.bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    const stagedInfo = await lstat(tempPath, { bigint: true });
    if (stagedInfo.isSymbolicLink() || !stagedInfo.isFile() || !sameIdentity(stagedInfo, tempIdentity)
      || stagedInfo.size !== BigInt(image.bytes.byteLength)) throw new Error(SAVE_ERROR);
    const currentTargetSnapshot = await getDestinationSnapshot(target);
    if (originalTargetSnapshot === null ? currentTargetSnapshot !== null
      : currentTargetSnapshot === null || !sameSnapshot(originalTargetSnapshot, currentTargetSnapshot)) throw new Error(SAVE_ERROR);
    const currentParent = await canonicalDirectory(dirname(requested));
    if (!samePath(currentParent, parent)) throw new Error(SAVE_ERROR);
    const currentProtectedRoots = await Promise.all(options.protectedRoots.map(canonicalDirectory));
    if (currentProtectedRoots.some((root) => isWithin(root, target))) throw new Error(SAVE_ERROR);

    await (options.renameFile ?? rename)(tempPath, target);
    tempOwned = false;
  } catch {
    if (handle) {
      if (tempPath && tempIdentity === null) {
        try {
          const info = await handle.stat({ bigint: true });
          if (info.isFile()) tempIdentity = { dev: info.dev, ino: info.ino };
        } catch { /* Without identity, leave an uncertain path untouched. */ }
      }
      try { await handle.close(); } catch { /* Preserve the fixed save failure. */ }
      handle = null;
    }
    if (tempOwned && tempPath && tempIdentity) {
      try {
        const info = await lstat(tempPath, { bigint: true });
        if (sameIdentity(info, tempIdentity)) await unlink(tempPath);
      } catch { /* Preserve the original destination and the fixed save failure. */ }
    }
    throw new Error(SAVE_ERROR);
  }
}
