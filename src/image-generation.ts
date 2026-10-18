import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type {
  AcceptedTurnInput,
  ChatDetail,
  ProviderEvent,
  ProviderGeneratedImageLedgerEntry,
  ProviderTurnRequest,
  ProviderUsageValues,
} from './contracts';
import { isImageProtocolDiagnostic, PROVIDER_ERROR_CATEGORIES } from './contracts';
import { LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES, PROVIDER_IMAGE_LIMIT_BYTES } from './attachment-policy';
import type {
  GigaChatProviderConnection,
  ProviderGeneratedImage,
  ProviderImageGenerationEvent,
  ProviderImageGenerationRequest,
} from './gigachat-provider';
import { GigaChatProviderError } from './gigachat-provider';
import type { ProviderStateOwner } from './provider-state';
import type { LocalStore } from './store';

import { IMAGE_GENERATION_MODEL_ID } from './image-mode';
export { IMAGE_GENERATION_MODEL_ID } from './image-mode';
const MAX_IMAGE_BYTES = Math.min(PROVIDER_IMAGE_LIMIT_BYTES, LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES);
const MAX_IMAGE_EDGE = 8_192;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_IMAGE_ASSISTANT_TEXT_CHARS = 100_000;
const SAFE_REMOTE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export const IMAGE_RECOVERY_REQUIRED_MESSAGE = 'Предыдущая попытка изображения не подтверждена. Повторная генерация не отправлена.';

export interface GeneratedImageDimensions {
  width: number;
  height: number;
}

export type ImageGenerationStore = Pick<LocalStore,
  'getProviderGeneratedImageEntries' | 'putProviderGeneratedImageEntry' | 'stageGeneratedImage'
  | 'getChat' | 'getArtifactPath' | 'removeProviderGeneratedImageEntry'>;

export type ImageGenerationProvider = Pick<GigaChatProviderConnection,
  'generateImage' | 'downloadGeneratedImage' | 'deleteFile'>;

export interface ImageGenerationStreamOptions {
  store: ImageGenerationStore;
  provider: ImageGenerationProvider;
  owner: ProviderStateOwner;
  turn: AcceptedTurnInput;
  request: ProviderTurnRequest;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): void;
  validateDecodedImage(bytes: Uint8Array, contentType: 'image/jpeg' | 'image/png', dimensions: GeneratedImageDimensions): void | Promise<void>;
  now?: () => Date;
}

function protocolError(): Error {
  return Object.assign(new Error('IMAGE_GENERATION_PROTOCOL'), { category: 'protocol' as const });
}

function storageError(): Error {
  return Object.assign(new Error('IMAGE_GENERATION_STORAGE'), { category: 'storage' as const });
}

function requireImageRequest(turn: AcceptedTurnInput, request: ProviderTurnRequest): ProviderImageGenerationRequest {
  if (turn.operation || turn.modelId !== IMAGE_GENERATION_MODEL_ID || turn.assistantMessageId === null
    || request.modelId !== IMAGE_GENERATION_MODEL_ID || request.protocolHistory?.length || request.attachments?.length
    || !Array.isArray(request.messages) || !Array.isArray(request.system)
    || request.messages.some((message) => message.role === 'user' && message.attachmentIds?.length)) throw protocolError();
  const acceptedAnchor = turn.messages.find((message) => message.id === turn.messageId && message.role === 'user');
  const lastRequestMessage = request.messages[request.messages.length - 1];
  if (!acceptedAnchor || !acceptedAnchor.text.trim() || !lastRequestMessage || lastRequestMessage.role !== 'user'
    || lastRequestMessage.id !== turn.messageId || lastRequestMessage.text !== acceptedAnchor.text) {
    throw protocolError();
  }
  const messages = request.messages.map((message) => {
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') throw protocolError();
    return { role: message.role, text: message.text };
  });
  const imageRequest: ProviderImageGenerationRequest = {
    modelId: IMAGE_GENERATION_MODEL_ID,
    system: structuredClone(request.system),
    messages,
  };
  return imageRequest;
}

function validateRemoteDescriptor(image: ProviderGeneratedImage): void {
  if (!image || typeof image.fileId !== 'string' || !SAFE_REMOTE_ID.test(image.fileId)
    || (image.contentType !== 'image/jpeg' && image.contentType !== 'image/png')) throw protocolError();
}

function usageEvent(usage: ProviderUsageValues): ProviderEvent {
  return {
    type: 'usage',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    precachedPromptTokens: usage.precachedPromptTokens,
    ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}),
    ...(usage.providerModel ? { providerModel: usage.providerModel } : {}),
  };
}

function eventError(error: unknown, signal: AbortSignal, fallback: 'protocol' | 'storage' = 'protocol'): ProviderEvent {
  const candidate = typeof error === 'object' && error !== null && 'category' in error
    ? (error as { category?: unknown }).category : undefined;
  const category = signal.aborted || error instanceof Error && error.name === 'AbortError'
    ? 'cancel'
    : typeof candidate === 'string' && (PROVIDER_ERROR_CATEGORIES as readonly string[]).includes(candidate)
      ? candidate as typeof PROVIDER_ERROR_CATEGORIES[number]
      : fallback;
  const retryable = typeof error === 'object' && error !== null && 'retryable' in error
    && (error as { retryable?: unknown }).retryable === true;
  const diagnosticValue = typeof error === 'object' && error !== null && 'imageProtocolDiagnostic' in error
    ? (error as { imageProtocolDiagnostic?: unknown }).imageProtocolDiagnostic : undefined;
  const imageProtocolDiagnostic = category === 'protocol' && isImageProtocolDiagnostic(diagnosticValue)
    ? diagnosticValue : undefined;
  return { type: 'error', category, retryable,
    ...(imageProtocolDiagnostic ? { imageProtocolDiagnostic } : {}) };
}

function dimensionsAreSafe(dimensions: GeneratedImageDimensions): boolean {
  return Number.isSafeInteger(dimensions.width) && dimensions.width > 0 && dimensions.width <= MAX_IMAGE_EDGE
    && Number.isSafeInteger(dimensions.height) && dimensions.height > 0 && dimensions.height <= MAX_IMAGE_EDGE
    && dimensions.width * dimensions.height <= MAX_IMAGE_PIXELS;
}

function inspectPng(bytes: Uint8Array): GeneratedImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  let offset = 8;
  let dimensions: GeneratedImageDimensions | null = null;
  let sawImageData = false;
  let sawEnd = false;
  let chunkIndex = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return null;
    const length = bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000 + bytes[offset + 2]! * 0x100 + bytes[offset + 3]!;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_IMAGE_BYTES || offset + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const dataOffset = offset + 8;
    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) return null;
      dimensions = {
        width: bytes[dataOffset]! * 0x1000000 + bytes[dataOffset + 1]! * 0x10000 + bytes[dataOffset + 2]! * 0x100 + bytes[dataOffset + 3]!,
        height: bytes[dataOffset + 4]! * 0x1000000 + bytes[dataOffset + 5]! * 0x10000 + bytes[dataOffset + 6]! * 0x100 + bytes[dataOffset + 7]!,
      };
      if (!dimensionsAreSafe(dimensions)) return null;
    } else if (type === 'IHDR') return null;
    if (type === 'IDAT' && length > 0) sawImageData = true;
    offset += 12 + length;
    chunkIndex += 1;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) return null;
      sawEnd = true;
      break;
    }
  }
  return dimensions && sawImageData && sawEnd ? dimensions : null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function inspectJpeg(bytes: Uint8Array): GeneratedImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions: GeneratedImageDimensions | null = null;
  let sawScan = false;
  let inEntropy = false;
  while (offset < bytes.length) {
    let marker: number;
    if (inEntropy) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      marker = bytes[offset++]!;
      if (marker === 0x00 || marker >= 0xd0 && marker <= 0xd7) continue;
      inEntropy = false;
    } else {
      if (bytes[offset] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      marker = bytes[offset++]!;
    }
    if (marker === 0xd9) return dimensions && sawScan && offset === bytes.length ? dimensions : null;
    if (marker === 0xd8 || marker === 0x00) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset]! << 8) + bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const data = offset + 2;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) return null;
      const height = (bytes[data + 1]! << 8) + bytes[data + 2]!;
      const width = (bytes[data + 3]! << 8) + bytes[data + 4]!;
      const next = { width, height };
      if (dimensions || !dimensionsAreSafe(next)) return null;
      dimensions = next;
    }
    offset += segmentLength;
    if (marker === 0xda) {
      if (!dimensions || segmentLength < 6) return null;
      sawScan = true;
      inEntropy = true;
    }
  }
  return null;
}

export function inspectGeneratedImageBytes(bytes: Uint8Array, contentType: 'image/jpeg' | 'image/png'): GeneratedImageDimensions | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  if (contentType === 'image/png') return inspectPng(bytes);
  if (contentType === 'image/jpeg') return inspectJpeg(bytes);
  return null;
}

async function hasVerifiedLocalOriginal(
  store: ImageGenerationStore,
  detail: ChatDetail,
  entry: ProviderGeneratedImageLedgerEntry,
): Promise<boolean> {
  if (entry.state !== 'downloaded' && entry.state !== 'cleanup-pending') return false;
  if (entry.remoteFileId === null || entry.contentType === null || entry.sizeBytes === null || entry.sha256 === null) return false;
  const artifact = detail.artifacts.find((item) => item.id === entry.artifactId);
  if (!artifact || artifact.messageId !== entry.assistantMessageId || artifact.size !== entry.sizeBytes
    || artifact.sha256 !== entry.sha256 || artifact.storedName !== `${entry.artifactId}.${entry.contentType === 'image/png' ? 'png' : 'jpg'}`
    || !detail.messages.some((message) => message.id === entry.assistantMessageId && message.role === 'assistant')) return false;
  try {
    const path = await store.getArtifactPath(entry.chatId, entry.artifactId);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || stat.size !== entry.sizeBytes) return false;
    const bytes = await readFile(path);
    if (bytes.byteLength !== stat.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return false;
    return inspectGeneratedImageBytes(bytes, entry.contentType) !== null;
  } catch {
    return false;
  }
}

async function cleanupEligibleRemoteFiles(options: ImageGenerationStreamOptions, signal: AbortSignal): Promise<void> {
  const rows = await options.store.getProviderGeneratedImageEntries(options.owner.accountScope);
  for (const row of rows) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (row.accountScope !== options.owner.accountScope || row.remoteFileId === null
      || !SAFE_REMOTE_ID.test(row.remoteFileId)
      || row.state !== 'generated' && row.state !== 'downloaded' && row.state !== 'cleanup-pending') continue;
    let detail: ChatDetail;
    try { detail = await options.store.getChat(row.chatId); }
    catch { continue; }
    if (detail.id !== row.chatId || detail.kind !== 'image') continue;
    const turn = detail.turns.find((item) => item.turnId === row.turnId);
    if (!turn || turn.anchorMessageId !== row.anchorMessageId || turn.assistantMessageId !== row.assistantMessageId
      || turn.modelId !== row.modelId) continue;
    const explicitlyCancelled = turn.status === 'cancelled';
    const localOriginal = turn.status === 'completed' && await hasVerifiedLocalOriginal(options.store, detail, row);
    if (!explicitlyCancelled && !localOriginal) continue;

    options.assertCurrent(signal);
    if (row.state !== 'cleanup-pending') {
      try {
        const pending = await options.store.putProviderGeneratedImageEntry({ ...row, state: 'cleanup-pending' });
        if (pending.state !== 'cleanup-pending' || pending.remoteFileId !== row.remoteFileId) throw storageError();
      } catch {
        throw storageError();
      }
    }
    options.assertCurrent(signal);
    try {
      await options.provider.deleteFile(row.remoteFileId, signal);
    } catch (error) {
      const category = error instanceof Error && 'category' in error ? (error as Error & { category?: unknown }).category : null;
      if (category === 'network' || category === 'rate-limit'
        || error instanceof GigaChatProviderError && error.httpStatus === 404) continue;
      throw error;
    }
    options.assertCurrent(signal);
    try { await options.store.removeProviderGeneratedImageEntry(options.owner.accountScope, row.artifactId, row.remoteFileId); }
    catch { throw storageError(); }
  }
}

async function confirmProviderIteratorReturn(
  iterator: AsyncIterator<ProviderImageGenerationEvent> | null,
  generationDone: boolean,
): Promise<void> {
  if (!iterator || generationDone) return;
  if (typeof iterator.return !== 'function') throw protocolError();
  const settled = await iterator.return();
  if (!settled || settled.done !== true) throw protocolError();
}

function imageEntry(options: ImageGenerationStreamOptions, artifactId: string, createdAt: string): ProviderGeneratedImageLedgerEntry {
  return {
    accountScope: options.owner.accountScope,
    chatId: options.turn.chatId,
    turnId: options.turn.turnId,
    anchorMessageId: options.turn.messageId,
    assistantMessageId: options.turn.assistantMessageId!,
    artifactId,
    modelId: IMAGE_GENERATION_MODEL_ID,
    createdAt,
    state: 'intent',
    remoteFileId: null,
    contentType: null,
    sizeBytes: null,
    sha256: null,
  };
}

export function createImageGenerationStream(options: ImageGenerationStreamOptions): AsyncIterable<ProviderEvent> {
  return (async function* imageGenerationEvents(): AsyncGenerator<ProviderEvent> {
    let entry: ProviderGeneratedImageLedgerEntry | null = null;
    let generationIterator: AsyncIterator<ProviderImageGenerationEvent> | null = null;
    let generationDone = false;
    let usage: ProviderUsageValues | null = null;
    let usageForwarded = false;
    let image: ProviderGeneratedImage | null = null;
    let providerCompleted = false;
    try {
      if (options.turn.operation || options.turn.modelId !== IMAGE_GENERATION_MODEL_ID || options.turn.assistantMessageId === null) throw protocolError();
      const imageRequest = requireImageRequest(options.turn, options.request);
      if (options.turn.attachmentIds?.length) throw protocolError();
      if (options.owner.accountScope.length !== 64 || !/^[a-f0-9]{64}$/.test(options.owner.accountScope)) throw protocolError();
      if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      options.assertCurrent(options.signal);
      const chat = await options.store.getChat(options.turn.chatId);
      if (chat.kind !== 'image') throw protocolError();
      const storedTurn = chat.turns.find((item) => item.turnId === options.turn.turnId);
      if (!storedTurn || storedTurn.anchorMessageId !== options.turn.messageId
        || storedTurn.assistantMessageId !== options.turn.assistantMessageId
        || storedTurn.status !== 'queued' && storedTurn.status !== 'running') throw protocolError();

      const existing = await options.store.getProviderGeneratedImageEntries(options.owner.accountScope);
      if (existing.some((row) => row.chatId === options.turn.chatId && row.anchorMessageId === options.turn.messageId)) {
        throw Object.assign(new Error(IMAGE_RECOVERY_REQUIRED_MESSAGE), { category: 'storage' as const });
      }
      await cleanupEligibleRemoteFiles(options, options.signal);
      options.assertCurrent(options.signal);
      const artifactId = randomUUID();
      const createdAt = (options.now?.() ?? new Date()).toISOString();
      try { entry = await options.store.putProviderGeneratedImageEntry(imageEntry(options, artifactId, createdAt)); }
      catch { throw storageError(); }
      options.assertCurrent(options.signal);

      generationIterator = options.provider.generateImage(imageRequest, options.signal)[Symbol.asyncIterator]();
      for (;;) {
        const next = await generationIterator.next();
        if (next.done) {
          generationDone = true;
          break;
        }
        if (providerCompleted) throw protocolError();
        const event = next.value;
        if (event.type === 'usage') {
          if (usage !== null) throw protocolError();
          usage = structuredClone(event.usage);
          if (image) {
            usageForwarded = true;
            yield usageEvent(usage);
          }
        } else if (event.type === 'generated-image') {
          if (image || !entry) throw protocolError();
          validateRemoteDescriptor(event.image);
          image = structuredClone(event.image);
          const generatedEntry: ProviderGeneratedImageLedgerEntry = {
            ...entry,
            state: 'generated',
            remoteFileId: image.fileId,
            contentType: image.contentType,
          };
          try { entry = await options.store.putProviderGeneratedImageEntry(generatedEntry); }
          catch { entry = generatedEntry; throw storageError(); }
          if (usage && !usageForwarded) {
            usageForwarded = true;
            yield usageEvent(usage);
          }
          if (typeof image.assistantText === 'string' && image.assistantText.length > MAX_IMAGE_ASSISTANT_TEXT_CHARS
            || image.functionsStateId !== undefined && (typeof image.functionsStateId !== 'string'
              || image.functionsStateId.length === 0 || image.functionsStateId.length > 4096)
            || image.responseId !== undefined && (typeof image.responseId !== 'string' || image.responseId.length === 0 || image.responseId.length > 512)) {
            throw protocolError();
          }
          options.assertCurrent(options.signal);
        } else if (event.type === 'completed') {
          providerCompleted = true;
        } else if (event.type === 'error') {
          if (!image && entry?.state === 'intent') {
            try { entry = await options.store.putProviderGeneratedImageEntry({ ...entry, state: 'unknown' }); }
            catch { throw storageError(); }
          }
          if (usage && !usageForwarded) {
            usageForwarded = true;
            yield usageEvent(usage);
          }
          const imageProtocolDiagnostic = event.category === 'protocol' && isImageProtocolDiagnostic(event.imageProtocolDiagnostic)
            ? event.imageProtocolDiagnostic : undefined;
          yield { type: 'error', category: event.category, retryable: event.retryable,
            ...(imageProtocolDiagnostic ? { imageProtocolDiagnostic } : {}) };
          return;
        } else throw protocolError();
      }
      if (usage && !usageForwarded) {
        usageForwarded = true;
        yield usageEvent(usage);
      }
      if (!generationDone || !providerCompleted || !image || !entry || entry.state !== 'generated') throw protocolError();
      options.assertCurrent(options.signal);
      const bytes = await options.provider.downloadGeneratedImage(image.fileId, image.contentType, options.signal);
      options.assertCurrent(options.signal);
      const dimensions = inspectGeneratedImageBytes(bytes, image.contentType);
      if (!dimensions) throw protocolError();
      try { await options.validateDecodedImage(bytes, image.contentType, dimensions); }
      catch { throw protocolError(); }
      options.assertCurrent(options.signal);
      let downloaded: ProviderGeneratedImageLedgerEntry;
      try { downloaded = await options.store.stageGeneratedImage(options.owner.accountScope, entry.artifactId, bytes, options.signal); }
      catch { throw storageError(); }
      options.assertCurrent(options.signal);
      if (downloaded.state !== 'downloaded' || downloaded.artifactId !== entry.artifactId
        || downloaded.remoteFileId !== image.fileId || downloaded.contentType !== image.contentType
        || downloaded.sizeBytes !== bytes.byteLength || typeof downloaded.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(downloaded.sha256)) throw storageError();
      yield { type: 'image-result', artifactId: entry.artifactId };
      if (image.assistantText) yield { type: 'text-delta', text: image.assistantText };
      yield {
        type: 'completed',
        ...(image.functionsStateId ? { functionsStateId: image.functionsStateId } : {}),
        ...(image.responseId ? { responseId: image.responseId } : {}),
      };
    } catch (caught) {
      let error: unknown = caught;
      if (entry?.state === 'intent') {
        try { await options.store.putProviderGeneratedImageEntry({ ...entry, state: 'unknown' }); }
        catch { error = storageError(); }
      }
      if (usage && !usageForwarded) {
        usageForwarded = true;
        yield usageEvent(usage);
      }
      yield eventError(error, options.signal, error instanceof Error && error.message === 'IMAGE_GENERATION_STORAGE' ? 'storage' : 'protocol');
    } finally {
      await confirmProviderIteratorReturn(generationIterator, generationDone);
    }
  })();
}
