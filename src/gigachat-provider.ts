import { Buffer } from 'node:buffer';
import { randomUUID, X509Certificate } from 'node:crypto';
import { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import * as tls from 'node:tls';
import { isImageProtocolDiagnostic, type BalanceFamilyId, type GigaChatProvider, type ImageProtocolDiagnostic, type InstructionLayer, type ModelRegistrySnapshot, type ProviderAttachmentReference, type ProviderBalanceObservation, type ProviderConnectionSnapshot, type ProviderErrorCategory, type ProviderEvent, type ProviderFileRecord, type ProviderFileUploadInput, type ProviderFunctionCall, type ProviderProtocolExchange, type ProviderTurnRequest, type ProviderUsageValues, type ProviderV2FunctionWire } from './contracts';
import { discoveredModelRegistry, failedModelRegistry, isModelAvailable, requireModelId, unavailableModelRegistry, type GigaChatModelId } from './models';
import { billingFamilyForUsageLabel, CHAT_MODEL_FAMILIES, isChatModelAvailable } from './model-catalog';
import { attachmentContentType, inspectLocalAttachmentContent, LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES, PROVIDER_IMAGE_LIMIT_BYTES, PROVIDER_MEDIA_LIMIT_BYTES, PROVIDER_REQUEST_LIMIT_BYTES } from './attachment-policy';
import { validateProviderV2FunctionWire } from './provider-wire';
import { COMPACTION_OUTPUT_TOKEN_LIMIT } from './compaction';

export const GIGACHAT_API_BASE_URL = 'https://api.giga.chat/v1';
const GIGACHAT_V2_CHAT_COMPLETIONS_URL = 'https://api.giga.chat/v2/chat/completions';
export const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_ROOT_CA_SHA256 = 'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31';

const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_EVENT_COUNT = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 90_000;
const MAX_FUNCTION_ARGUMENT_BYTES = 1_900_000;
const COMPACTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      version: { type: 'integer', enum: [2] },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sourceRef: { type: 'string' },
            retain: { type: 'boolean' },
          },
          required: ['sourceRef', 'retain'],
          additionalProperties: false,
        },
      },
    },
    required: ['version', 'decisions'],
    additionalProperties: false,
  },
  strict: true,
};
const IMAGE_GENERATION_MODEL_ID = 'GigaChat-3-Ultra';
const IMAGE_GENERATION_TIMEOUT_MS = 90_000;
const MAX_GENERATED_IMAGE_BYTES = Math.min(LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES, PROVIDER_IMAGE_LIMIT_BYTES);
const MAX_GENERATED_IMAGE_TEXT_BYTES = 16_000;
export const MAX_PROVIDER_REQUEST_BYTES = PROVIDER_REQUEST_LIMIT_BYTES;

const GIGACHAT_FUNCTIONS: readonly Record<string, unknown>[] = [
  { name: 'list', description: 'Показывает файлы и папки в доступной рабочей папке с учётом профиля разрешений. Путь задаётся относительно её корня; пустой или отсутствующий путь означает корень. Абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 2048 } }, additionalProperties: false } },
  { name: 'search', description: 'Ищет текст в файле или папке внутри доступной рабочей папки с учётом профиля разрешений. Сопоставляет буквальный фрагмент без учёта регистра; регулярные выражения не поддерживаются. Путь задаётся относительно её корня; пустой или отсутствующий путь означает корень. Абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, path: { type: 'string', maxLength: 2048 } }, required: ['query'], additionalProperties: false } },
  { name: 'read', description: 'Читает небольшой текстовый файл внутри доступной рабочей папки с учётом профиля разрешений. Укажите непустой путь относительно её корня; абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['path'], additionalProperties: false } },
  { name: 'write', description: 'Записывает ровно переданный полный UTF-8 текст в файл внутри доступной рабочей папки с учётом профиля разрешений. Укажите непустой путь относительно её корня; абсолютные пути и переходы за корень не принимаются. Содержимое ограничено 1 МиБ.', parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 2048 }, contents: { type: 'string', maxLength: 1048576, description: 'Передавайте полный текст файла в UTF-8: записывается ровно это содержимое без нормализации переносов или автоматического добавления завершающего перевода строки. При редактировании сохраняйте неизменённые строки, отступы, разделители строк и исходное окончание файла.' } }, required: ['path', 'contents'], additionalProperties: false } },
  { name: 'open', description: 'Открывает или показывает безопасный файл либо папку внутри доступной рабочей папки с учётом профиля разрешений. Путь задаётся относительно её корня; пустой или отсутствующий путь означает корень. Абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 2048 } }, additionalProperties: false } },
  { name: 'powershell', description: 'Выполнение PowerShell через существующий локальный helper и текущий профиль разрешений.', parameters: { type: 'object', properties: { script: { type: 'string', minLength: 1, maxLength: 16384 }, external_access: { type: 'boolean' } }, required: ['script'], additionalProperties: false } },
];

export interface ProviderTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
  streaming?: boolean;
  timeoutMs?: number;
}

export interface ProviderTransportResponse {
  statusCode: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}

export interface ProviderTransport {
  request(options: ProviderTransportRequest): Promise<ProviderTransportResponse>;
  close(): void;
}

export interface SerializedProviderTurnRequest {
  body: string;
  wireBytes: number;
  textInputs: string[];
  functionSchemaBytes: number;
}

export interface ProviderImageGenerationRequest {
  modelId: GigaChatModelId;
  system: InstructionLayer[];
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface ProviderGeneratedImage {
  fileId: string;
  contentType: 'image/jpeg' | 'image/png';
  assistantText?: string;
  functionsStateId?: string;
  responseId?: string;
}

export type ProviderImageGenerationEvent =
  | { type: 'usage'; usage: ProviderUsageValues }
  | { type: 'generated-image'; image: ProviderGeneratedImage }
  | { type: 'completed' }
  | { type: 'error'; category: ProviderErrorCategory; retryable: boolean; imageProtocolDiagnostic?: ImageProtocolDiagnostic };

export function serializeProviderTurnRequest(request: ProviderTurnRequest): SerializedProviderTurnRequest {
  let modelId: string;
  try { modelId = request.modelId === null ? '' : requireModelId(request.modelId); }
  catch { throw new GigaChatProviderError('model'); }
  if (!modelId || !Array.isArray(request.system) || !Array.isArray(request.messages)) {
    throw new GigaChatProviderError('protocol');
  }
  const maxOutputTokens = request.maxOutputTokens !== undefined
    ? request.maxOutputTokens
    : request.usageKind === 'compaction' ? COMPACTION_OUTPUT_TOKEN_LIMIT : undefined;
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    throw new GigaChatProviderError('protocol');
  }
  const systemPrompt = request.system.map((layer) => {
    if (!layer || typeof layer.label !== 'string' || typeof layer.text !== 'string') throw new GigaChatProviderError('protocol');
    return `[${layer.label}]\n${layer.text}`;
  }).join('\n\n');
  const protocolHistory = validateProtocolHistory(request.protocolHistory ?? []);
  const attachments = validateProviderAttachments(request.attachments === undefined ? [] : request.attachments, request.messages);
  const attachmentsByMessage = new Map<string, ProviderAttachmentReference[]>();
  for (const attachment of attachments) {
    const rows = attachmentsByMessage.get(attachment.messageId) ?? [];
    rows.push(attachment);
    attachmentsByMessage.set(attachment.messageId, rows);
  }
  const exchanges = new Map<string, ProviderProtocolExchange[]>();
  for (const exchange of protocolHistory) {
    const rows = exchanges.get(exchange.anchorMessageId) ?? [];
    rows.push(exchange);
    exchanges.set(exchange.anchorMessageId, rows);
  }
  const messages: Array<Record<string, unknown>> = [
    ...(systemPrompt ? [{ role: 'system', content: [{ text: systemPrompt }] }] : []),
  ];
  for (const message of request.messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') {
      throw new GigaChatProviderError('protocol');
    }
    if (message.functionsStateId !== undefined && (message.role !== 'assistant' || typeof message.functionsStateId !== 'string'
      || !message.functionsStateId || message.functionsStateId.length > 4096
      // eslint-disable-next-line no-control-regex -- Reject control characters in provider protocol state IDs.
      || /[\u0000-\u001f\u007f]/.test(message.functionsStateId))) throw new GigaChatProviderError('protocol');
    const messageAttachments = attachmentsByMessage.get(message.id) ?? [];
    const content: Array<Record<string, unknown>> = [{ text: message.text }];
    if (messageAttachments.length) content.push({ files: messageAttachments.map(({ fileId }) => ({ id: fileId })) });
    messages.push({
      role: message.role,
      content,
      ...(message.role === 'assistant' && message.functionsStateId ? { tools_state_id: message.functionsStateId } : {}),
    });
    if (message.role === 'user') {
      for (const exchange of exchanges.get(message.id) ?? []) {
        const assistant: Record<string, unknown> = exchange.wire
          ? {
            role: 'assistant',
            content: structuredClone(exchange.wire.content),
            ...(exchange.wire.messageId ? { message_id: exchange.wire.messageId } : {}),
          }
          : { role: 'assistant', content: [
            ...(exchange.content === null ? [] : [{ text: exchange.content }]),
            { function_call: { name: exchange.name, arguments: structuredClone(exchange.arguments) } },
          ] };
        const stateId = exchange.wire?.toolStateId ?? null;
        if (stateId) assistant.tools_state_id = stateId;
        messages.push(assistant);
        messages.push({
          role: 'tool',
          content: [{ function_result: { name: exchange.name, result: exchange.result } }],
          ...(stateId ? { tools_state_id: stateId } : {}),
        });
      }
    }
  }
  if (protocolHistory.some((exchange) => !request.messages.some((message) => message.role === 'user' && message.id === exchange.anchorMessageId))) {
    throw new GigaChatProviderError('protocol');
  }
  const functionsEnabled = request.functionCallMode !== 'none';
  const tools = functionsEnabled ? [{ functions: { specifications: GIGACHAT_FUNCTIONS } }] : undefined;
  let body: string;
  try {
    body = JSON.stringify({
      model: modelId,
      messages,
      ...(tools ? { tools } : {}),
      model_options: {
        parallel_tool_calls: false,
        ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
        ...(request.usageKind === 'compaction' ? {
          response_format: COMPACTION_RESPONSE_FORMAT,
        } : {}),
      },
      tool_config: { mode: functionsEnabled ? 'auto' : 'none' },
      stream: true,
    });
  } catch { throw new GigaChatProviderError('protocol'); }
  const wireBytes = Buffer.byteLength(body, 'utf8');
  if (wireBytes > MAX_PROVIDER_REQUEST_BYTES) throw new GigaChatProviderError('context');
  const mediaBytes = attachments.reduce((total, attachment) => total + (attachment.kind === 'image' ? attachment.sizeBytes : 0), 0);
  if (mediaBytes + wireBytes >= PROVIDER_MEDIA_LIMIT_BYTES) throw new GigaChatProviderError('context');
  return {
    body,
    wireBytes,
    textInputs: messages.flatMap((message) => Array.isArray(message.content) ? message.content.flatMap((part) => {
      if (!isRecord(part)) return [];
      if (typeof part.text === 'string') return [part.text];
      if (isRecord(part.function_result) && typeof part.function_result.result === 'string') return [part.function_result.result];
      return [];
    }) : []),
    functionSchemaBytes: functionsEnabled ? Buffer.byteLength(JSON.stringify(GIGACHAT_FUNCTIONS), 'utf8') : 0,
  };
}

function validateProviderAttachments(value: unknown, messages: readonly ProviderTurnRequest['messages'][number][]): ProviderAttachmentReference[] {
  if (!Array.isArray(value) || value.length > 32) throw new GigaChatProviderError('protocol');
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string' || !message.id || message.id.length > 256) {
      throw new GigaChatProviderError('protocol');
    }
    if (messageIds.has(message.id)) throw new GigaChatProviderError('protocol');
    messageIds.add(message.id);
  }
  let imageCount = 0;
  const remoteIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const validated = value.map((item): ProviderAttachmentReference => {
    const sizeBytes = isRecord(item) && typeof item.sizeBytes === 'number' ? item.sizeBytes : Number.NaN;
    if (!isRecord(item) || typeof item.messageId !== 'string' || !item.messageId || item.messageId.length > 256
      || typeof item.attachmentId !== 'string' || !item.attachmentId || item.attachmentId.length > 256
      || !isSafeRemoteFileId(item.fileId)
      || typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 255
      || item.name.includes('/') || item.name.includes('\\')
      || typeof item.contentType !== 'string'
      || (item.kind !== 'document' && item.kind !== 'image')
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES
      // eslint-disable-next-line no-control-regex -- Reject control characters in local and remote attachment metadata.
      || /[\u0000-\u001f\u007f]/.test(item.messageId) || /[\u0000-\u001f\u007f]/.test(item.attachmentId) || /[\u0000-\u001f\u007f]/.test(item.name)) {
      throw new GigaChatProviderError('protocol');
    }
    if (remoteIds.has(item.fileId) || attachmentIds.has(item.attachmentId)) throw new GigaChatProviderError('protocol');
    remoteIds.add(item.fileId);
    attachmentIds.add(item.attachmentId);
    const anchor = messages.find((message) => message.id === item.messageId);
    if (!anchor || anchor.role !== 'user' || !Array.isArray(anchor.attachmentIds)
      || !anchor.attachmentIds.includes(item.attachmentId)) throw new GigaChatProviderError('protocol');
    const localType = attachmentContentType(item.name);
    if (!localType || localType.kind !== item.kind || localType.contentType !== item.contentType) {
      throw new GigaChatProviderError('protocol');
    }
    if (item.kind === 'image') {
      if (sizeBytes > PROVIDER_IMAGE_LIMIT_BYTES) throw new GigaChatProviderError('context');
      imageCount += 1;
      if (imageCount > 10) throw new GigaChatProviderError('context');
    }
    return {
      messageId: item.messageId,
      attachmentId: item.attachmentId,
      fileId: item.fileId,
      name: item.name,
      contentType: item.contentType,
      kind: item.kind,
      sizeBytes,
    };
  });
  const byMessage = new Map<string, ProviderAttachmentReference[]>();
  for (const attachment of validated) {
    const rows = byMessage.get(attachment.messageId) ?? [];
    rows.push(attachment);
    byMessage.set(attachment.messageId, rows);
  }
  for (const message of messages) {
    if (message.attachmentIds !== undefined && (!Array.isArray(message.attachmentIds)
      || message.attachmentIds.length > 32 || new Set(message.attachmentIds).size !== message.attachmentIds.length
      || message.attachmentIds.some((id) => typeof id !== 'string' || !id || id.length > 256))) {
      throw new GigaChatProviderError('protocol');
    }
    const rows = byMessage.get(message.id) ?? [];
    const attachedIds = message.attachmentIds ?? [];
    let lastIndex = -1;
    for (const row of rows) {
      const index = attachedIds.indexOf(row.attachmentId);
      if (index <= lastIndex) throw new GigaChatProviderError('protocol');
      lastIndex = index;
    }
  }
  return validated;
}

export interface GigaChatProviderConnection extends GigaChatProvider {
  getConnectionStatus(): ProviderConnectionSnapshot;
  getModelRegistry(): ModelRegistrySnapshot;
  getBalance(signal?: AbortSignal): Promise<ProviderBalanceObservation>;
  connect(): Promise<ProviderConnectionSnapshot>;
  cancelConnect(): ProviderConnectionSnapshot;
  disconnect(): ProviderConnectionSnapshot;
  invalidateSavedKey(): void;
  listModels(signal?: AbortSignal): Promise<string[]>;
  uploadFile(input: ProviderFileUploadInput, signal: AbortSignal): Promise<ProviderFileRecord>;
  listFiles(signal: AbortSignal): Promise<ProviderFileRecord[]>;
  deleteFile(id: string, signal: AbortSignal): Promise<void>;
  generateImage(request: ProviderImageGenerationRequest, signal: AbortSignal): AsyncIterable<ProviderImageGenerationEvent>;
  downloadGeneratedImage(fileId: string, contentType: 'image/jpeg' | 'image/png', signal: AbortSignal): Promise<Uint8Array>;
  countTokens(modelId: GigaChatModelId, input: readonly string[], signal: AbortSignal): Promise<ProviderTokenCount[]>;
}

export interface ProviderTokenCount {
  object: 'tokens';
  tokens: number;
  characters: number;
}

export class GigaChatProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly imageProtocolDiagnostic?: ImageProtocolDiagnostic;

  constructor(category: ProviderErrorCategory, retryable = false, httpStatus?: number, imageProtocolDiagnostic?: ImageProtocolDiagnostic) {
    super(category);
    this.name = 'GigaChatProviderError';
    this.category = category;
    this.retryable = retryable;
    if (httpStatus !== undefined && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
    if (category === 'protocol' && isImageProtocolDiagnostic(imageProtocolDiagnostic)) this.imageProtocolDiagnostic = imageProtocolDiagnostic;
  }
}

function imageProtocolError(diagnostic: ImageProtocolDiagnostic): GigaChatProviderError {
  return new GigaChatProviderError('protocol', false, undefined, diagnostic);
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

interface RefreshFlight {
  generation: number;
  controller: AbortController;
  promise: Promise<AccessToken>;
  waiters: number;
  settled: boolean;
}

export function createHttpsTransport(options: {
  additionalCa?: string;
  expectedAdditionalCaSha256?: string;
  timeoutMs?: number;
} = {}): ProviderTransport {
  if (options.additionalCa && options.expectedAdditionalCaSha256) {
    try {
      const certificate = new X509Certificate(options.additionalCa);
      const fingerprint = certificate.fingerprint256.replace(/:/g, '').toUpperCase();
      if (!certificate.ca || fingerprint !== options.expectedAdditionalCaSha256.replace(/:/g, '').toUpperCase()) {
        throw new Error('untrusted-ca');
      }
    } catch {
      throw new GigaChatProviderError('tls');
    }
  }

  let authorities: string[];
  try {
    authorities = [...tls.getCACertificates('default'), ...tls.getCACertificates('system')];
  } catch {
    authorities = tls.getCACertificates('default');
  }
  if (options.additionalCa) authorities.push(options.additionalCa);
  const agent = new Agent({
    rejectUnauthorized: true,
    keepAlive: true,
    ...(authorities.length ? { ca: [...new Set(authorities)] } : {}),
  });
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    request(requestOptions) {
      const requestTimeoutMs = requestOptions.timeoutMs;
      if (requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs)
        || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS)) {
        return Promise.reject(new GigaChatProviderError('protocol'));
      }
      const timeoutMs = requestTimeoutMs ?? defaultTimeoutMs;
      let url: URL;
      try { url = new URL(requestOptions.url); }
      catch { return Promise.reject(new GigaChatProviderError('protocol')); }
      if (url.protocol !== 'https:' || requestOptions.signal.aborted) {
        return Promise.reject(requestOptions.signal.aborted
          ? new GigaChatProviderError('cancel')
          : new GigaChatProviderError('tls'));
      }

      return new Promise((resolve, reject) => {
        let clientRequest: ClientRequest | null = null;
        let response: IncomingMessage | null = null;
        let headersReceived = false;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        let idleDeadline: ReturnType<typeof setTimeout> | null = null;
        const streaming = requestOptions.streaming === true;
        const timeoutError = (): Error => Object.assign(new Error('request-timeout'), { code: 'ETIMEDOUT' });
        const cleanup = (): void => {
          if (deadline) clearTimeout(deadline);
          if (idleDeadline) clearTimeout(idleDeadline);
          requestOptions.signal.removeEventListener('abort', onAbort);
        };
        const resetIdleDeadline = (): void => {
          if (!streaming || !response) return;
          if (idleDeadline) clearTimeout(idleDeadline);
          idleDeadline = setTimeout(() => response?.destroy(timeoutError()), timeoutMs);
        };
        const onAbort = (): void => {
          const abort = abortError();
          if (response) response.destroy(abort);
          else clientRequest?.destroy(abort);
          cleanup();
        };
        clientRequest = httpsRequest(url, {
          method: requestOptions.method,
          headers: requestOptions.headers,
          agent,
          rejectUnauthorized: true,
        }, (incoming) => {
          headersReceived = true;
          response = incoming;
          if (streaming) {
            if (deadline) clearTimeout(deadline);
            deadline = null;
            resetIdleDeadline();
          }
          const body = (async function* (): AsyncGenerator<Uint8Array> {
            try {
              for await (const chunk of incoming) {
                resetIdleDeadline();
                yield Buffer.from(chunk as Uint8Array);
              }
            } catch (error) {
              throw transportError(error, requestOptions.signal);
            } finally {
              cleanup();
            }
          })();
          resolve({
            statusCode: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body,
            cancel: () => {
              cleanup();
              incoming.destroy();
            },
          });
        });
        requestOptions.signal.addEventListener('abort', onAbort, { once: true });
        deadline = setTimeout(() => {
          if (response) response.destroy(timeoutError());
          else clientRequest?.destroy(timeoutError());
        }, timeoutMs);
        clientRequest.once('error', (error) => {
          cleanup();
          if (!headersReceived) reject(transportError(error, requestOptions.signal));
        });
        if (requestOptions.signal.aborted) onAbort();
        if (requestOptions.body !== undefined) clientRequest.write(requestOptions.body);
        clientRequest.end();
      });
    },
    close: () => agent.destroy(),
  };
}

export function createGigaChatProvider(options: {
  loadAuthorizationKey(): Promise<string | null>;
  transport: ProviderTransport;
  now?: () => number;
}): GigaChatProviderConnection {
  const now = options.now ?? Date.now;
  let connectionStatus: ProviderConnectionSnapshot = { state: 'not-configured', errorCategory: null };
  let generation = 0;
  let sessionController = new AbortController();
  let connectController: AbortController | null = null;
  let accessToken: AccessToken | null = null;
  let refreshFlight: RefreshFlight | null = null;
  let modelRegistry = unavailableModelRegistry();
  const exhaustedModelIds = new Set<string>();
  let modelRegistryGeneration = 0;

  const getStatus = (): ProviderConnectionSnapshot => ({ ...connectionStatus });
  const getModelRegistry = (): ModelRegistrySnapshot => ({
    ...modelRegistry,
    modelIds: [...modelRegistry.modelIds],
    ...(exhaustedModelIds.size ? { exhaustedModelIds: [...exhaustedModelIds].sort() } : {}),
  });
  const setStatus = (status: ProviderConnectionSnapshot): void => { connectionStatus = status; };
  const assertCurrent = (expectedGeneration: number, signal: AbortSignal): void => {
    if (generation !== expectedGeneration || signal.aborted) throw new GigaChatProviderError('cancel');
  };

  const loadKey = async (): Promise<string | null> => {
    let key: string | null;
    try { key = await options.loadAuthorizationKey(); }
    catch { throw new GigaChatProviderError('storage'); }
    if (key === null) return null;
    if (typeof key !== 'string' || !key.trim() || key.length > MAX_TOKEN_CHARS || /[\r\n]/.test(key)) {
      throw new GigaChatProviderError('auth');
    }
    return key;
  };

  const reset = (): number => {
    generation += 1;
    modelRegistryGeneration += 1;
    const previousSession = sessionController;
    sessionController = new AbortController();
    previousSession.abort();
    const activeConnect = connectController;
    connectController = null;
    activeConnect?.abort();
    const activeRefresh = refreshFlight;
    refreshFlight = null;
    activeRefresh?.controller.abort();
    accessToken = null;
    modelRegistry = unavailableModelRegistry();
    exhaustedModelIds.clear();
    setStatus({ state: 'not-configured', errorCategory: null });
    return generation;
  };

  const fetchJson = async (request: ProviderTransportRequest): Promise<unknown> => {
    let response: ProviderTransportResponse;
    try {
      response = await awaitWithAbort(options.transport.request(request), request.signal, (lateResponse) => lateResponse.cancel());
    }
    catch (error) { throw transportError(error, request.signal); }
    if (request.signal.aborted) {
      response.cancel();
      throw new GigaChatProviderError('cancel');
    }
    if (response.statusCode !== 200) {
      response.cancel();
      throw statusError(response.statusCode);
    }
    return readJsonResponse(response, request.signal);
  };

  const fetchAccessToken = async (authorizationKey: string, signal: AbortSignal): Promise<AccessToken> => {
    const body = new URLSearchParams({ scope: 'GIGACHAT_API_PERS' }).toString();
    // Preserve the credentials' bytes while fixing Base64 padding and unused pad bits.
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(authorizationKey) ? Buffer.from(authorizationKey, 'base64') : null;
    const separator = decoded?.indexOf(0x3a) ?? -1;
    const encodedKey = decoded && separator > 0 && separator < decoded.length - 1
      ? decoded.toString('base64') : authorizationKey;
    let value: unknown;
    try { value = await fetchJson({
      url: GIGACHAT_OAUTH_URL,
      method: 'POST',
      headers: {
        Authorization: `Basic ${encodedKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: randomUUID(),
      },
      body,
      signal,
    }); } catch (error) {
      if (error instanceof GigaChatProviderError && error.httpStatus === 400) {
        throw new GigaChatProviderError('auth', false, 400);
      }
      throw error;
    }
    if (!isRecord(value) || typeof value.access_token !== 'string'
      || !value.access_token.trim() || value.access_token.length > MAX_TOKEN_CHARS
      || /[\r\n]/.test(value.access_token)
      || !Number.isSafeInteger(value.expires_at)) {
      throw new GigaChatProviderError('protocol');
    }
    const expiresAt = value.expires_at as number;
    const currentTime = now();
    if (expiresAt <= currentTime + TOKEN_REFRESH_SKEW_MS
      || expiresAt > currentTime + MAX_TOKEN_LIFETIME_MS) {
      throw new GigaChatProviderError('protocol');
    }
    return { value: value.access_token, expiresAt };
  };

  const startRefresh = (authorizationKey: string): RefreshFlight => {
    const controller = new AbortController();
    const flight: RefreshFlight = {
      generation,
      controller,
      promise: Promise.resolve(null as unknown as AccessToken),
      waiters: 0,
      settled: false,
    };
    flight.promise = fetchAccessToken(authorizationKey, controller.signal).then((token) => {
      if (generation !== flight.generation || controller.signal.aborted) throw new GigaChatProviderError('cancel');
      accessToken = token;
      return token;
    }).finally(() => {
      flight.settled = true;
      if (refreshFlight === flight) refreshFlight = null;
    });
    refreshFlight = flight;
    void flight.promise.catch(() => undefined);
    return flight;
  };

  const joinRefresh = (flight: RefreshFlight, signal: AbortSignal): Promise<AccessToken> => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new GigaChatProviderError('cancel'));
      return;
    }
    flight.waiters += 1;
    let waiting = true;
    const finish = (): void => {
      if (!waiting) return;
      waiting = false;
      signal.removeEventListener('abort', onAbort);
      flight.waiters -= 1;
    };
    const onAbort = (): void => {
      finish();
      if (flight.waiters === 0 && !flight.settled && refreshFlight === flight) {
        refreshFlight = null;
        flight.controller.abort();
      }
      reject(new GigaChatProviderError('cancel'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then((token) => {
      if (waiting) { finish(); resolve(token); }
    }, (error: unknown) => {
      if (waiting) { finish(); reject(error); }
    });
  });

  const getAccessToken = async (signal: AbortSignal, expectedGeneration: number, providedKey?: string): Promise<AccessToken> => {
    assertCurrent(expectedGeneration, signal);
    if (accessToken && now() < accessToken.expiresAt - TOKEN_REFRESH_SKEW_MS) return accessToken;
    accessToken = null;
    const authorizationKey = providedKey ?? await loadKey();
    assertCurrent(expectedGeneration, signal);
    if (!authorizationKey) throw new GigaChatProviderError('auth');
    const flight = refreshFlight?.generation === generation
      ? refreshFlight
      : startRefresh(authorizationKey);
    const token = await joinRefresh(flight, signal);
    assertCurrent(expectedGeneration, signal);
    return token;
  };

  const listModelsWithAuthRetry = async (signal: AbortSignal, expectedGeneration: number): Promise<string[]> => {
    let token: AccessToken | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      token = await getAccessToken(signal, expectedGeneration);
      assertCurrent(expectedGeneration, signal);
      let response: ProviderTransportResponse;
      try {
        response = await awaitWithAbort(options.transport.request({
          url: `${GIGACHAT_API_BASE_URL}/models`,
          method: 'GET',
          headers: { Authorization: `Bearer ${token.value}` },
          signal,
        }), signal, (lateResponse) => lateResponse.cancel());
      } catch (error) {
        throw transportError(error, signal);
      }
      if (generation !== expectedGeneration || signal.aborted) {
        response.cancel();
        throw new GigaChatProviderError('cancel');
      }
      if (response.statusCode === 401 && attempt === 0) {
        response.cancel();
        if (accessToken?.value === token.value) accessToken = null;
        continue;
      }
      if (response.statusCode !== 200) {
        response.cancel();
        throw statusError(response.statusCode);
      }
      const value = await readJsonResponse(response, signal);
      try { assertCurrent(expectedGeneration, signal); }
      catch (error) {
        response.cancel();
        throw error;
      }
      return parseModelIds(value);
    }
    throw new GigaChatProviderError('auth');
  };

  const requestWithAuthRetry = async (
    createRequest: (token: string) => ProviderTransportRequest,
    signal: AbortSignal,
    expectedGeneration: number,
  ): Promise<ProviderTransportResponse> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const access = await getAccessToken(signal, expectedGeneration);
      assertCurrent(expectedGeneration, signal);
      let response: ProviderTransportResponse;
      try {
        response = await awaitWithAbort(options.transport.request(createRequest(access.value)), signal, (lateResponse) => lateResponse.cancel());
      } catch (error) {
        throw transportError(error, signal);
      }
      try { assertCurrent(expectedGeneration, signal); }
      catch (error) {
        response.cancel();
        throw error;
      }
      if (response.statusCode === 401 && attempt === 0) {
        response.cancel();
        if (accessToken?.value === access.value) accessToken = null;
        continue;
      }
      return response;
    }
    throw new GigaChatProviderError('auth');
  };

  const uploadFile = async (input: ProviderFileUploadInput, signal: AbortSignal): Promise<ProviderFileRecord> => {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, signal);
    const operationSignal = operation.controller.signal;
    try {
      if (connectionStatus.state !== 'connected' || !isSafeUploadInput(input)) throw new GigaChatProviderError('protocol');
      assertCurrent(operationGeneration, operationSignal);
      let boundary = `----GigaChat-${randomUUID()}`;
      const fileBytes = Buffer.from(input.bytes);
      while (fileBytes.includes(Buffer.from(boundary, 'ascii'))) boundary = `----GigaChat-${randomUUID()}`;
      const filename = input.filename;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n`, 'utf8'),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${input.contentType}\r\n\r\n`, 'utf8'),
        fileBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]);
      const response = await requestWithAuthRetry((tokenValue) => ({
        url: `${GIGACHAT_API_BASE_URL}/files`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          Accept: 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.byteLength),
        },
        body,
        signal: operationSignal,
      }), operationSignal, operationGeneration);
      if (response.statusCode !== 200) {
        response.cancel();
        throw statusError(response.statusCode);
      }
      const receipt = parseFileRecord(await readJsonResponse(response, operationSignal));
      assertCurrent(operationGeneration, operationSignal);
      if (!receipt || receipt.filename !== input.filename || receipt.bytes !== input.bytes.byteLength || receipt.purpose !== 'general') {
        throw new GigaChatProviderError('protocol');
      }
      return receipt;
    } catch (error) {
      throw error instanceof GigaChatProviderError ? error : transportError(error, operationSignal);
    } finally { operation.dispose(); }
  };

  const listFiles = async (signal: AbortSignal): Promise<ProviderFileRecord[]> => {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, signal);
    const operationSignal = operation.controller.signal;
    try {
      if (connectionStatus.state !== 'connected') throw new GigaChatProviderError('auth');
      const response = await requestWithAuthRetry((tokenValue) => ({
        url: `${GIGACHAT_API_BASE_URL}/files`,
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenValue}`, Accept: 'application/json' },
        signal: operationSignal,
      }), operationSignal, operationGeneration);
      if (response.statusCode !== 200) {
        response.cancel();
        throw statusError(response.statusCode);
      }
      const value = await readJsonResponse(response, operationSignal);
      assertCurrent(operationGeneration, operationSignal);
      if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > 10_000 || value.has_more === true) {
        throw new GigaChatProviderError('protocol');
      }
      return value.data.map(parseFileRecord).filter((record): record is ProviderFileRecord => record !== null);
    } catch (error) {
      throw error instanceof GigaChatProviderError ? error : transportError(error, operationSignal);
    } finally { operation.dispose(); }
  };

  const deleteFile = async (id: string, signal: AbortSignal): Promise<void> => {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, signal);
    const operationSignal = operation.controller.signal;
    try {
      if (connectionStatus.state !== 'connected' || !isSafeRemoteFileId(id)) throw new GigaChatProviderError('protocol');
      const response = await requestWithAuthRetry((tokenValue) => ({
        url: `${GIGACHAT_API_BASE_URL}/files/${encodeURIComponent(id)}/delete`,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenValue}`, Accept: 'application/json' },
        signal: operationSignal,
      }), operationSignal, operationGeneration);
      if (response.statusCode !== 200) {
        response.cancel();
        throw statusError(response.statusCode);
      }
      const receipt = await readJsonResponse(response, operationSignal);
      assertCurrent(operationGeneration, operationSignal);
      if (!isRecord(receipt) || receipt.id !== id || receipt.deleted !== true
        || ('access_policy' in receipt && (typeof receipt.access_policy !== 'string' || receipt.access_policy.length > 64
          // eslint-disable-next-line no-control-regex -- Provider deletion metadata is untrusted.
          || /[\u0000-\u001f\u007f]/.test(receipt.access_policy)))) {
        throw new GigaChatProviderError('protocol');
      }
    } catch (error) {
      throw error instanceof GigaChatProviderError ? error : transportError(error, operationSignal);
    } finally { operation.dispose(); }
  };

  const generateImage = async function* (
    request: ProviderImageGenerationRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderImageGenerationEvent> {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, signal);
    let response: ProviderTransportResponse | null = null;
    let cancelResponseOnAbort: (() => void) | null = null;
    try {
      assertCurrent(operationGeneration, operation.controller.signal);
      const body = serializeImageGenerationRequest(request);
      if (connectionStatus.state !== 'connected') throw new GigaChatProviderError('auth');
      if (exhaustedModelIds.has(IMAGE_GENERATION_MODEL_ID)) throw new GigaChatProviderError('quota');
      if (!isChatModelAvailable(getModelRegistry(), IMAGE_GENERATION_MODEL_ID)) throw new GigaChatProviderError('model');
      response = await requestWithAuthRetry((tokenValue) => ({
        url: GIGACHAT_V2_CHAT_COMPLETIONS_URL,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body,
        signal: operation.controller.signal,
        timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
      }), operation.controller.signal, operationGeneration);
      if (response.statusCode !== 200) throw statusError(response.statusCode);
      let hasJsonContentType = false;
      try { hasJsonContentType = isJsonContentType(response.headers); }
      catch (error) {
        if (error instanceof GigaChatProviderError && error.category === 'protocol') throw imageProtocolError('response-json');
        throw error;
      }
      if (!hasJsonContentType) throw imageProtocolError('response-json');
      cancelResponseOnAbort = () => response?.cancel();
      operation.controller.signal.addEventListener('abort', cancelResponseOnAbort, { once: true });

      let value: unknown;
      try { value = await readJsonResponse(response, operation.controller.signal); }
      catch (error) {
        if (error instanceof GigaChatProviderError && error.category === 'protocol') throw imageProtocolError('response-json');
        throw error;
      }
      assertCurrent(operationGeneration, operation.controller.signal);
      const usage = parseProviderUsage(value);
      if (usage.values && hasKnownProviderUsage(usage.values)) yield { type: 'usage', usage: usage.values };

      const parsed = parseImageGenerationResponse(value, IMAGE_GENERATION_MODEL_ID);
      yield { type: 'generated-image', image: parsed.image };
      if (parsed.finishReason === 'context' || parsed.finishReason === 'model') {
        throw new GigaChatProviderError(parsed.finishReason);
      }
      if (parsed.toolFailed) throw new GigaChatProviderError('tool');
      if (usage.invalid) throw imageProtocolError('usage');
      if (parsed.finishReason !== 'stop') throw imageProtocolError('finish-reason');
      assertCurrent(operationGeneration, operation.controller.signal);
      yield { type: 'completed' };
    } catch (error) {
      const normalized = error instanceof GigaChatProviderError
        ? error : transportError(error, operation.controller.signal);
      const diagnostic = normalized.category === 'protocol' && isImageProtocolDiagnostic(normalized.imageProtocolDiagnostic)
        ? normalized.imageProtocolDiagnostic : undefined;
      yield { type: 'error', category: normalized.category, retryable: normalized.retryable,
        ...(diagnostic ? { imageProtocolDiagnostic: diagnostic } : {}) };
    } finally {
      if (cancelResponseOnAbort) operation.controller.signal.removeEventListener('abort', cancelResponseOnAbort);
      response?.cancel();
      operation.dispose();
    }
  };

  const downloadGeneratedImage = async (
    fileId: string,
    contentType: 'image/jpeg' | 'image/png',
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, signal);
    let response: ProviderTransportResponse | null = null;
    let cancelResponseOnAbort: (() => void) | null = null;
    try {
      if (connectionStatus.state !== 'connected' || !isSafeRemoteFileId(fileId)
        || (contentType !== 'image/jpeg' && contentType !== 'image/png')) throw new GigaChatProviderError('protocol');
      assertCurrent(operationGeneration, operation.controller.signal);
      response = await requestWithAuthRetry((tokenValue) => ({
        url: `${GIGACHAT_API_BASE_URL}/files/${encodeURIComponent(fileId)}/content`,
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenValue}`, Accept: 'application/jpg' },
        signal: operation.controller.signal,
      }), operation.controller.signal, operationGeneration);
      if (response.statusCode !== 200) throw statusError(response.statusCode);
      if (!isCompatibleImageContentType(response.headers, contentType)) throw new GigaChatProviderError('protocol');

      const length = readContentLength(response.headers);
      if (length !== null && length > MAX_GENERATED_IMAGE_BYTES) throw new GigaChatProviderError('context');
      cancelResponseOnAbort = () => response?.cancel();
      operation.controller.signal.addEventListener('abort', cancelResponseOnAbort, { once: true });
      const bytes = await readGeneratedImageBytes(response, operation.controller.signal,
        () => assertCurrent(operationGeneration, operation.controller.signal));
      if (bytes.byteLength === 0 || length !== null && length !== bytes.byteLength) throw new GigaChatProviderError('protocol');
      const inspected = inspectGeneratedImageContent(contentType, bytes);
      if (!inspected) throw new GigaChatProviderError('protocol');
      assertCurrent(operationGeneration, operation.controller.signal);
      return bytes;
    } catch (error) {
      throw error instanceof GigaChatProviderError ? error : transportError(error, operation.controller.signal);
    } finally {
      if (cancelResponseOnAbort) operation.controller.signal.removeEventListener('abort', cancelResponseOnAbort);
      response?.cancel();
      operation.dispose();
    }
  };

  const getBalance = async (signal?: AbortSignal): Promise<ProviderBalanceObservation> => {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, ...(signal ? [signal] : []));
    try {
      if (connectionStatus.state !== 'connected') throw new GigaChatProviderError('auth');
      const response = await requestWithAuthRetry((tokenValue) => ({
        url: `${GIGACHAT_API_BASE_URL}/balance`,
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenValue}`, Accept: 'application/json' },
        signal: operation.controller.signal,
      }), operation.controller.signal, operationGeneration);
      if (response.statusCode !== 200) {
        response.cancel();
        throw statusError(response.statusCode);
      }
      const value = await readJsonResponse(response, operation.controller.signal);
      assertCurrent(operationGeneration, operation.controller.signal);
      return parseBalanceObservation(value, new Date(now()).toISOString());
    } catch (error) {
      throw error instanceof GigaChatProviderError ? error : transportError(error, operation.controller.signal);
    } finally { operation.dispose(); }
  };

  const connect = async (): Promise<ProviderConnectionSnapshot> => {
    const operationGeneration = reset();
    const operation = linkAbortSignals(sessionController.signal);
    const controller = operation.controller;
    connectController = controller;
    setStatus({ state: 'connecting', errorCategory: null });
    let failedStep: 'oauth' | 'models' = 'oauth';
    try {
      const authorizationKey = await loadKey();
      assertCurrent(operationGeneration, controller.signal);
      if (!authorizationKey) {
        setStatus({ state: 'not-configured', errorCategory: null });
        return getStatus();
      }
      await getAccessToken(controller.signal, operationGeneration, authorizationKey);
      failedStep = 'models';
      const models = await listModelsWithAuthRetry(controller.signal, operationGeneration);
      assertCurrent(operationGeneration, controller.signal);
      if (models.length === 0) throw new GigaChatProviderError('model');
      modelRegistry = discoveredModelRegistry(models);
      setStatus({ state: 'connected', errorCategory: null });
    } catch (error) {
      if (operationGeneration !== generation) return getStatus();
      const category = errorCategory(error);
      if (controller.signal.aborted || category === 'cancel') {
        setStatus({ state: 'not-configured', errorCategory: null });
      } else {
        modelRegistry = failedModelRegistry(category);
        setStatus({ state: 'error', errorCategory: category, failedStep,
          ...(error instanceof GigaChatProviderError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
        });
      }
    } finally {
      if (connectController === controller) connectController = null;
      operation.dispose();
    }
    return getStatus();
  };

  const cancelConnect = (): ProviderConnectionSnapshot => {
    if (connectionStatus.state === 'connecting') reset();
    return getStatus();
  };

  const stream = async function* (request: ProviderTurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const operationGeneration = generation;
    const operation = linkAbortSignals(sessionController.signal, signal);
    let response: ProviderTransportResponse | null = null;
    let cancelResponseOnAbort: (() => void) | null = null;
    let requestedModelId: string | null = null;
    try {
      assertCurrent(operationGeneration, operation.controller.signal);
      try { requestedModelId = request.modelId === null ? null : requireModelId(request.modelId); }
      catch { throw new GigaChatProviderError('model'); }
      if (connectionStatus.state !== 'connected' || !requestedModelId) {
        throw new GigaChatProviderError('model');
      }
      if (exhaustedModelIds.has(requestedModelId)) throw new GigaChatProviderError('quota');
      if (!isChatModelAvailable(getModelRegistry(), requestedModelId)) throw new GigaChatProviderError('model');
      const serializedRequest = serializeProviderTurnRequest(request);
      let opened = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const access = await getAccessToken(operation.controller.signal, operationGeneration);
        assertCurrent(operationGeneration, operation.controller.signal);
        try {
          response = await awaitWithAbort(options.transport.request({
            url: GIGACHAT_V2_CHAT_COMPLETIONS_URL,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${access.value}`,
              Accept: 'text/event-stream',
              'Content-Type': 'application/json',
            },
            body: serializedRequest.body,
            signal: operation.controller.signal,
            streaming: true,
          }), operation.controller.signal, (lateResponse) => lateResponse.cancel());
        } catch (error) {
          throw transportError(error, operation.controller.signal);
        }
        assertCurrent(operationGeneration, operation.controller.signal);
        if (response.statusCode === 401 && attempt === 0) {
          response.cancel();
          response = null;
          if (accessToken?.value === access.value) accessToken = null;
          continue;
        }
        if (response.statusCode !== 200) throw statusError(response.statusCode);
        const contentType = response.headers['content-type'];
        const contentTypeValue = Array.isArray(contentType) ? contentType.join(',') : contentType ?? '';
        if (!contentTypeValue.toLowerCase().includes('text/event-stream')) throw new GigaChatProviderError('protocol');
        cancelResponseOnAbort = () => response?.cancel();
        operation.controller.signal.addEventListener('abort', cancelResponseOnAbort, { once: true });
        opened = true;
        break;
      }
      if (!opened || !response) throw new GigaChatProviderError('auth');

      yield { type: 'activity', activity: 'receiving' };
      const usage: ProviderUsageValues = {
        promptTokens: null, completionTokens: null, totalTokens: null, precachedPromptTokens: null,
      };
      let terminalReason: 'stop' | 'function_call' | null = null;
      let terminalFunctionsStateId: string | null = null;
      let terminalFunctionCall: ProviderFunctionCallForStream | null = null;
      let deltaText = '';
      let sawDeltaContent = false;
      let responseId: string | undefined;
      let providerModel: string | undefined;
      let receivedDone = false;
      let eventCount = 0;
      for await (const frame of readSseEvents(response.body, operation.controller.signal)) {
        assertCurrent(operationGeneration, operation.controller.signal);
        eventCount += 1;
        if (eventCount > MAX_RESPONSE_EVENT_COUNT || terminalReason || receivedDone || !frame.event) {
          throw new GigaChatProviderError('protocol');
        }
        const payload = parseSsePayload(frame.data);
        const usageUpdate = parseProviderUsage(payload);
        if (usageUpdate.values && hasKnownProviderUsage(usageUpdate.values)) {
          mergeProviderUsage(usage, usageUpdate.values);
          yield { type: 'usage', ...usage };
        }
        const metadata = parseV2Metadata(payload, requestedModelId);
        if (metadata.model !== undefined) {
          if (providerModel !== undefined && providerModel !== metadata.model) throw new GigaChatProviderError('protocol');
          providerModel = metadata.model;
        }
        if (metadata.threadId !== undefined) {
          if (responseId !== undefined && responseId !== metadata.threadId) throw new GigaChatProviderError('protocol');
          responseId = metadata.threadId;
        }
        if (usageUpdate.invalid) throw new GigaChatProviderError('protocol');

        if (frame.event === 'response.tool.in_progress' || frame.event === 'response.tool.completed') {
          const executions = validateBuiltinProgress(payload);
          if (frame.event === 'response.tool.completed') {
            yield { type: 'activity', activity: 'tool-finished' };
          } else {
            const progress = executions.find((execution) => execution.name === 'get_file_content' || execution.name === 'text2image');
            if (progress?.name === 'get_file_content' || progress?.name === 'text2image') {
              yield {
                type: 'activity', activity: 'function-progress', functionName: progress.name,
                detail: progress.secondsLeft === undefined ? '' : `Осталось ${progress.secondsLeft} с.`,
              };
            } else {
              yield { type: 'activity', activity: 'tool-started' };
            }
          }
          continue;
        }

        if (frame.event === 'response.message.delta') {
          if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'finish_reason')) throw new GigaChatProviderError('protocol');
          const message = parseV2AssistantMessage(payload);
          if (message.text !== null || message.functionCall !== null) sawDeltaContent = true;
          if (message.functionCall) {
            if (terminalFunctionCall || deltaText.length > 0) throw new GigaChatProviderError('protocol');
            terminalFunctionCall = message.functionCall;
            terminalFunctionsStateId = mergeStateId(terminalFunctionsStateId, message.functionCall.functionsStateId);
          } else {
            if (terminalFunctionCall) throw new GigaChatProviderError('protocol');
            if (message.text) {
              deltaText += message.text;
              yield { type: 'text-delta', text: message.text };
            }
            terminalFunctionsStateId = mergeStateId(terminalFunctionsStateId, message.functionsStateId);
          }
          continue;
        }

        if (frame.event !== 'response.message.done') throw new GigaChatProviderError('protocol');
        receivedDone = true;
        const finishReason = parseV2FinishReason(payload);
        if (finishReason === 'context' || finishReason === 'model') throw new GigaChatProviderError(finishReason);
        const terminalMessage = getV2TerminalMessage(payload, requestedModelId);
        if (terminalMessage) {
          if (!terminalMessage.contentPresent) {
            if (!sawDeltaContent) throw new GigaChatProviderError('protocol');
            if (terminalFunctionCall) terminalFunctionCall = mergeTerminalFunctionMetadata(terminalFunctionCall, terminalMessage);
          } else if (terminalMessage.functionCall) {
            if (terminalFunctionCall && !sameProviderFunctionCall(terminalFunctionCall, terminalMessage.functionCall)) {
              throw new GigaChatProviderError('protocol');
            }
            if (!terminalFunctionCall && deltaText.length > 0) throw new GigaChatProviderError('protocol');
            terminalFunctionCall = terminalMessage.functionCall;
          } else {
            if (terminalFunctionCall) throw new GigaChatProviderError('protocol');
            if (deltaText && terminalMessage.text !== null && terminalMessage.text !== deltaText) throw new GigaChatProviderError('protocol');
            if (!deltaText && terminalMessage.text) {
              deltaText = terminalMessage.text;
              yield { type: 'text-delta', text: terminalMessage.text };
            }
          }
          terminalFunctionsStateId = mergeStateId(terminalFunctionsStateId, terminalMessage.functionsStateId);
        }
        if (finishReason === 'function_call') {
          if (!terminalFunctionCall) throw new GigaChatProviderError('protocol');
          terminalReason = 'function_call';
          terminalFunctionsStateId = mergeStateId(terminalFunctionsStateId, terminalFunctionCall.functionsStateId);
        } else if (finishReason === 'stop') {
          if (terminalFunctionCall) throw new GigaChatProviderError('protocol');
          terminalReason = 'stop';
        } else {
          throw new GigaChatProviderError('protocol');
        }
        break;
      }
      assertCurrent(operationGeneration, operation.controller.signal);
      if (!terminalReason || !receivedDone) throw new GigaChatProviderError('protocol');
      if (terminalReason === 'function_call' && terminalFunctionCall) yield { type: 'function-call', functionCall: terminalFunctionCall };
      else if (terminalReason === 'stop') yield {
        type: 'completed',
        ...(responseId ? { responseId } : {}),
        ...(terminalFunctionsStateId ? { functionsStateId: terminalFunctionsStateId } : {}),
      };
    } catch (error) {
      const normalized = error instanceof GigaChatProviderError
        ? error : transportError(error, operation.controller.signal);
      if (normalized.category === 'quota' && normalized.httpStatus === 402 && requestedModelId) {
        exhaustedModelIds.add(requestedModelId);
      }
      yield { type: 'error', category: normalized.category, retryable: normalized.retryable };
    } finally {
      if (cancelResponseOnAbort) operation.controller.signal.removeEventListener('abort', cancelResponseOnAbort);
      response?.cancel();
      operation.dispose();
    }
  };

  return {
    getConnectionStatus: getStatus,
    getModelRegistry,
    getBalance,
    connect,
    cancelConnect,
    disconnect: () => { reset(); return getStatus(); },
    invalidateSavedKey: () => { reset(); },
    stream,
    uploadFile,
    listFiles,
    deleteFile,
    generateImage,
    downloadGeneratedImage,
    listModels: async (signal) => {
      const discoveryGeneration = ++modelRegistryGeneration;
      const operationGeneration = generation;
      const operation = linkAbortSignals(sessionController.signal, ...(signal ? [signal] : []));
      try {
        const models = await listModelsWithAuthRetry(operation.controller.signal, operationGeneration);
        assertCurrent(operationGeneration, operation.controller.signal);
        if (discoveryGeneration === modelRegistryGeneration && connectionStatus.state === 'connected') {
          modelRegistry = discoveredModelRegistry(models);
        }
        return models;
      } catch (error) {
        if (discoveryGeneration === modelRegistryGeneration && connectionStatus.state === 'connected') {
          modelRegistry = failedModelRegistry(error instanceof GigaChatProviderError ? error.category : 'network');
        }
        throw error;
      }
      finally { operation.dispose(); }
    },
    countTokens: async (modelInput, input, signal) => {
      const operationGeneration = generation;
      const operation = linkAbortSignals(sessionController.signal, signal);
      try {
        let modelId: GigaChatModelId;
        try { modelId = requireModelId(modelInput); }
        catch { throw new GigaChatProviderError('model'); }
        if (connectionStatus.state !== 'connected' || !isModelAvailable(modelRegistry, modelId)
          || !Array.isArray(input) || input.some((item) => typeof item !== 'string')) {
          throw new GigaChatProviderError('model');
        }
        const body = JSON.stringify({ model: modelId, input });
        if (Buffer.byteLength(body, 'utf8') > MAX_PROVIDER_REQUEST_BYTES) throw new GigaChatProviderError('context');
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const access = await getAccessToken(operation.controller.signal, operationGeneration);
          assertCurrent(operationGeneration, operation.controller.signal);
          let response: ProviderTransportResponse;
          try {
            response = await awaitWithAbort(options.transport.request({
              url: `${GIGACHAT_API_BASE_URL}/tokens/count`,
              method: 'POST',
              headers: {
                Authorization: `Bearer ${access.value}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body,
              signal: operation.controller.signal,
            }), operation.controller.signal, (lateResponse) => lateResponse.cancel());
          } catch (error) {
            throw transportError(error, operation.controller.signal);
          }
          assertCurrent(operationGeneration, operation.controller.signal);
          if (response.statusCode === 401 && attempt === 0) {
            response.cancel();
            if (accessToken?.value === access.value) accessToken = null;
            continue;
          }
          if (response.statusCode !== 200) {
            response.cancel();
            throw statusError(response.statusCode);
          }
          const value = await readJsonResponse(response, operation.controller.signal);
          assertCurrent(operationGeneration, operation.controller.signal);
          return parseTokenCounts(value, input.length);
        }
        throw new GigaChatProviderError('auth');
      } finally { operation.dispose(); }
    },
  };
}

async function readJsonResponse(response: ProviderTransportResponse, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    response.cancel();
    throw new GigaChatProviderError('cancel');
  }
  const cancelOnAbort = (): void => response.cancel();
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    const readBody = async (): Promise<unknown> => {
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            response.cancel();
            throw new GigaChatProviderError('protocol');
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error instanceof GigaChatProviderError) throw error;
        throw transportError(error, signal);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new GigaChatProviderError('protocol'); }
    };
    return await awaitWithAbort(readBody(), signal);
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
  }
}

function serializeImageGenerationRequest(value: unknown): string {
  try {
    if (!isRecord(value) || Object.keys(value).some((key) => !['modelId', 'system', 'messages'].includes(key))) {
      throw new GigaChatProviderError('protocol');
    }
    let modelId: string;
    try { modelId = requireModelId(value.modelId); }
    catch { throw new GigaChatProviderError('model'); }
    if (modelId !== IMAGE_GENERATION_MODEL_ID) throw new GigaChatProviderError('model');
    if (!Array.isArray(value.system) || !Array.isArray(value.messages) || value.messages.length < 1) {
      throw new GigaChatProviderError('protocol');
    }

    const systemPrompt = value.system.map((layer: unknown) => {
      if (!isRecord(layer) || Object.keys(layer).some((key) => !['source', 'label', 'scope', 'text'].includes(key))
        || !['runtime', 'global', 'project', 'skill', 'summary'].includes(String(layer.source))
        || typeof layer.label !== 'string' || layer.label.length < 1 || hasControlCharacters(layer.label)
        || typeof layer.text !== 'string'
        || layer.scope !== undefined && (typeof layer.scope !== 'string' || hasControlCharacters(layer.scope))) {
        throw new GigaChatProviderError('protocol');
      }
      return `[${layer.label}]\n${layer.text}`;
    }).join('\n\n');

    let hasUser = false;
    const messages = value.messages.map((message: unknown) => {
      if (!isRecord(message) || Object.keys(message).some((key) => !['role', 'text'].includes(key))
        || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') {
        throw new GigaChatProviderError('protocol');
      }
      if (message.role === 'user') hasUser = true;
      return { role: message.role, content: [{ text: message.text }] };
    });
    const lastMessage = value.messages[value.messages.length - 1];
    if (!hasUser || !isRecord(lastMessage) || lastMessage.role !== 'user'
      || typeof lastMessage.text !== 'string' || !lastMessage.text.trim()) throw new GigaChatProviderError('protocol');

    const body = JSON.stringify({
      model: IMAGE_GENERATION_MODEL_ID,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: [{ text: systemPrompt }] }] : []),
        ...messages,
      ],
      tools: [{ image_generate: {} }],
      tool_config: { mode: 'forced', tool_name: 'image_generate' },
      model_options: { parallel_tool_calls: false, max_tokens: 128 },
      stream: false,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_PROVIDER_REQUEST_BYTES) throw new GigaChatProviderError('context');
    return body;
  } catch (error) {
    if (error instanceof GigaChatProviderError) throw error;
    throw new GigaChatProviderError('protocol');
  }
}

interface ParsedImageGenerationResponse {
  image: ProviderGeneratedImage;
  finishReason: string | null | undefined;
  toolFailed: boolean;
}

function parseImageGenerationResponse(value: unknown, requestedModelId: string): ParsedImageGenerationResponse {
  if (!isRecord(value)) throw imageProtocolError('metadata');
  if (value.finish_reason !== undefined && value.finish_reason !== null && typeof value.finish_reason !== 'string') {
    throw imageProtocolError('finish-reason');
  }
  const withoutUsage = { ...value, usage: undefined };
  let metadata: V2Metadata;
  try { metadata = parseV2Metadata(withoutUsage, requestedModelId); }
  catch { throw imageProtocolError('metadata'); }
  if (!metadata.model || value.thread_id !== undefined && value.id !== undefined && value.thread_id !== value.id) {
    throw imageProtocolError('metadata');
  }
  if (!Array.isArray(value.messages) || value.messages.length !== 1 || !isRecord(value.messages[0])) {
    throw imageProtocolError('message');
  }
  const message = value.messages[0];
  if (message.role !== 'assistant'
    || Object.keys(message).some((key) => !['role', 'message_id', 'tool_state_id', 'content'].includes(key))
    || message.message_id !== undefined && !safeProviderIdentity(message.message_id)
    || message.tool_state_id !== undefined && !isProviderStateId(message.tool_state_id)) throw imageProtocolError('message');
  if (!Array.isArray(message.content) || message.content.length < 1 || message.content.length > 16) {
    throw imageProtocolError('content');
  }

  let file: ProviderGeneratedImage | null = null;
  let text = '';
  let toolExecutionSeen = false;
  let toolFailed = false;
  for (const part of message.content) {
    if (!isRecord(part) || Object.keys(part).length === 0
      || Object.keys(part).some((key) => !['text', 'files', 'tool_execution'].includes(key))) {
      throw imageProtocolError('content');
    }
    if (Object.prototype.hasOwnProperty.call(part, 'text')) {
      if (typeof part.text !== 'string') throw imageProtocolError('text');
      text += part.text;
      if (Buffer.byteLength(text, 'utf8') > MAX_GENERATED_IMAGE_TEXT_BYTES) throw imageProtocolError('text');
    }
    if (Object.prototype.hasOwnProperty.call(part, 'files')) {
      if (!Array.isArray(part.files) || part.files.length > 1) throw imageProtocolError('file');
      for (const row of part.files) {
        if (file !== null || !isRecord(row)
          || Object.keys(row).some((key) => !['id', 'mime', 'target'].includes(key))
          || !isSafeRemoteFileId(row.id) || (row.mime !== 'image/jpeg' && row.mime !== 'image/png') || row.target !== 'image') {
          throw imageProtocolError('file');
        }
        file = {
          fileId: row.id,
          contentType: row.mime,
          ...(text ? { assistantText: text } : {}),
          ...(typeof message.tool_state_id === 'string' ? { functionsStateId: message.tool_state_id } : {}),
          ...(metadata.threadId ? { responseId: metadata.threadId } : {}),
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(part, 'tool_execution')) {
      if (toolExecutionSeen || !isRecord(part.tool_execution)) throw imageProtocolError('tool-execution');
      toolExecutionSeen = true;
      const execution = part.tool_execution;
      if (Object.keys(execution).some((key) => !['name', 'status', 'seconds_left', 'censored'].includes(key))
        || execution.name !== undefined && !safeProviderIdentity(execution.name)
        || execution.status !== undefined && execution.status !== 'success' && execution.status !== 'fail'
        || execution.seconds_left !== undefined && (!Number.isSafeInteger(execution.seconds_left)
          || (execution.seconds_left as number) < 0 || (execution.seconds_left as number) > 3600)
        || execution.censored !== undefined && typeof execution.censored !== 'boolean') {
        throw imageProtocolError('tool-execution');
      }
      toolFailed = execution.status === 'fail' || execution.censored === true;
    }
  }
  if (!file) throw imageProtocolError('missing-image');
  if (text) file.assistantText = text;
  return { image: file, finishReason: value.finish_reason as string | null | undefined, toolFailed };
}

function responseHeaderValue(headers: ProviderTransportResponse['headers'], name: string): string | null {
  const source = headers as Record<string, string | string[] | undefined>;
  const value = source[name.toLowerCase()] ?? source[name];
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string') throw new GigaChatProviderError('protocol');
    return value[0];
  }
  if (typeof value !== 'string') throw new GigaChatProviderError('protocol');
  return value;
}

function responseMediaType(headers: ProviderTransportResponse['headers']): string | null {
  const value = responseHeaderValue(headers, 'content-type');
  return value === null ? null : value.split(';', 1)[0]!.trim().toLowerCase();
}

function isJsonContentType(headers: ProviderTransportResponse['headers']): boolean {
  return responseMediaType(headers) === 'application/json';
}

function isCompatibleImageContentType(headers: ProviderTransportResponse['headers'], expected: string): boolean {
  const mediaType = responseMediaType(headers);
  return mediaType === expected || mediaType === 'application/octet-stream';
}

function readContentLength(headers: ProviderTransportResponse['headers']): number | null {
  const value = responseHeaderValue(headers, 'content-length');
  if (value === null) return null;
  if (!/^\d{1,16}$/.test(value)) throw new GigaChatProviderError('protocol');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new GigaChatProviderError('protocol');
  return length;
}

async function readGeneratedImageBytes(
  response: ProviderTransportResponse,
  signal: AbortSignal,
  assertCurrentOperation: () => void,
): Promise<Uint8Array> {
  const read = async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        assertCurrentOperation();
        if (!(chunk instanceof Uint8Array)) throw new GigaChatProviderError('protocol');
        if (chunk.byteLength === 0) continue;
        if (size + chunk.byteLength > MAX_GENERATED_IMAGE_BYTES) {
          throw new GigaChatProviderError('context');
        }
        size += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof GigaChatProviderError) throw error;
      throw transportError(error, signal);
    }
    return Buffer.concat(chunks, size);
  };
  return awaitWithAbort(read(), signal);
}

function inspectGeneratedImageContent(contentType: string, bytes: Uint8Array): boolean {
  const name = contentType === 'image/png' ? 'generated.png' : 'generated.jpg';
  try { return inspectLocalAttachmentContent(name, bytes)?.contentType === contentType; }
  catch { return false; }
}

function isSafeUploadInput(value: ProviderFileUploadInput): boolean {
  if (!value || typeof value !== 'object' || typeof value.filename !== 'string' || value.filename.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.filename) || typeof value.contentType !== 'string'
    || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 1
    || value.bytes.byteLength > LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES) return false;
  const expected = attachmentContentType(value.filename);
  if (!expected || expected.contentType !== value.contentType) return false;
  try {
    const content = inspectLocalAttachmentContent(value.filename, value.bytes);
    if (!content || content.contentType !== value.contentType || content.kind !== expected.kind) return false;
  } catch { return false; }
  return expected.kind !== 'image' || value.bytes.byteLength <= PROVIDER_IMAGE_LIMIT_BYTES;
}

function parseFileRecord(value: unknown): ProviderFileRecord | null {
  if (!isRecord(value) || !isSafeRemoteFileId(value.id) || typeof value.filename !== 'string'
    || value.filename.length < 1 || value.filename.length > 255
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || typeof value.purpose !== 'string' || value.purpose.length < 1 || value.purpose.length > 64
    // eslint-disable-next-line no-control-regex -- File metadata comes from an untrusted provider response.
    || /[\u0000-\u001f\u007f]/.test(value.filename) || /[\u0000-\u001f\u007f]/.test(value.purpose)) {
    throw new GigaChatProviderError('protocol');
  }
  if (value.purpose !== 'general') return null;
  return { id: value.id, filename: value.filename, bytes: value.bytes as number, purpose: 'general' };
}

function isSafeRemoteFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function parseTokenCounts(value: unknown, expectedLength: number): ProviderTokenCount[] {
  if (!Array.isArray(value) || value.length !== expectedLength) throw new GigaChatProviderError('protocol');
  return value.map((entry): ProviderTokenCount => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || !('object' in entry) || entry.object !== 'tokens'
      || !('tokens' in entry) || typeof entry.tokens !== 'number' || !Number.isSafeInteger(entry.tokens) || entry.tokens < 0
      || !('characters' in entry) || typeof entry.characters !== 'number' || !Number.isSafeInteger(entry.characters) || entry.characters < 0) {
      throw new GigaChatProviderError('protocol');
    }
    return { object: 'tokens', tokens: entry.tokens, characters: entry.characters };
  });
}

function parseBalanceObservation(value: unknown, observedAt: string): ProviderBalanceObservation {
  if (!isRecord(value) || !Array.isArray(value.balance) || value.balance.length > 128) {
    throw new GigaChatProviderError('protocol');
  }
  const rows = new Map<BalanceFamilyId, number[]>();
  let unknownUsageCount = 0;
  for (const row of value.balance) {
    if (!isRecord(row) || typeof row.usage !== 'string' || !row.usage.trim() || row.usage.length > 200
      // eslint-disable-next-line no-control-regex -- Provider billing labels are untrusted and never returned to the renderer.
      || /[\u0000-\u001f\u007f]/.test(row.usage)
      || !Number.isSafeInteger(row.value) || (row.value as number) < 0) {
      throw new GigaChatProviderError('protocol');
    }
    const family = billingFamilyForUsageLabel(row.usage);
    if (!family) {
      unknownUsageCount += 1;
      continue;
    }
    const familyRows = rows.get(family.family) ?? [];
    familyRows.push(row.value as number);
    rows.set(family.family, familyRows);
  }
  return {
    observedAt,
    unknownUsageCount,
    families: CHAT_MODEL_FAMILIES.map(({ family }) => {
      const values = rows.get(family) ?? [];
      return values.length === 1
        ? { family, state: 'known' as const, value: values[0]! }
        : { family, state: values.length ? 'ambiguous' as const : 'missing' as const };
    }),
  };
}

type ProviderFunctionCallForStream = ProviderFunctionCall;
type V2FinishReason = 'stop' | 'function_call' | 'context' | 'model' | null;
interface V2SseFrame { event: string | null; data: string }
interface ParsedV2AssistantMessage {
  contentPresent: boolean;
  messageId: string | null;
  text: string | null;
  functionsStateId: string | null;
  functionCall: ProviderFunctionCall | null;
}

async function* readSseEvents(body: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<V2SseFrame> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const iterator = body[Symbol.asyncIterator]();
  let buffer = '';
  let totalBytes = 0;
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let dataLength = 0;
  let frameCount = 0;
  let sourceDone = false;
  let skipLeadingLf = false;
  const dispatch = (): V2SseFrame | null => {
    if (eventName === null && dataLines.length === 0) return null;
    if (eventName === null || dataLines.length === 0) throw new GigaChatProviderError('protocol');
    frameCount += 1;
    if (frameCount > MAX_RESPONSE_EVENT_COUNT) throw new GigaChatProviderError('protocol');
    const frame = { event: eventName, data: dataLines.join('\n') };
    eventName = null;
    dataLines = [];
    dataLength = 0;
    return frame;
  };
  const consumeLine = (line: string): V2SseFrame | null => {
    if (line === '') {
      return dispatch();
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      if (eventName !== null || !value || value.length > 128 || hasControlCharacters(value)) {
        throw new GigaChatProviderError('protocol');
      }
      eventName = value;
    } else if (field === 'data') {
      dataLength += Buffer.byteLength(value, 'utf8') + (dataLines.length ? 1 : 0);
      if (dataLength > MAX_RESPONSE_BYTES) throw new GigaChatProviderError('protocol');
      dataLines.push(value);
    } else throw new GigaChatProviderError('protocol');
    return null;
  };
  const appendBytes = (chunk: Uint8Array): void => {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) throw new GigaChatProviderError('protocol');
    try { buffer += decoder.decode(chunk, { stream: true }); }
    catch { throw new GigaChatProviderError('protocol'); }
  };

  try {
    for (;;) {
      const pending = Promise.resolve(iterator.next());
      const result = await awaitWithAbort(pending, signal);
      if (result.done) { sourceDone = true; break; }
      appendBytes(result.value);
      if (skipLeadingLf) {
        if (buffer.startsWith('\n')) buffer = buffer.slice(1);
        skipLeadingLf = false;
      }
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        const line = buffer.slice(start, index);
        if (character === '\r') {
          if (buffer[index + 1] === '\n') index += 1;
          else if (index === buffer.length - 1) skipLeadingLf = true;
        }
        start = index + 1;
        const frame = consumeLine(line);
        if (frame) yield frame;
      }
      buffer = buffer.slice(start);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) throw new GigaChatProviderError('protocol');
    }
    try { buffer += decoder.decode(); }
    catch { throw new GigaChatProviderError('protocol'); }
    if (buffer) {
      const frame = consumeLine(buffer);
      if (frame) yield frame;
      buffer = '';
    }
    const finalFrame = dispatch();
    if (finalFrame) yield finalFrame;
  } catch (error) {
    if (error instanceof GigaChatProviderError) throw error;
    throw transportError(error, signal);
  } finally {
    if (!sourceDone && iterator.return) {
      await Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}

function parseSsePayload(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new GigaChatProviderError('protocol'); }
}

interface ParsedV2Usage { values: ProviderUsageValues | null; invalid: boolean }

function parseProviderUsage(value: unknown): ParsedV2Usage {
  if (!isRecord(value) || value.usage === undefined || value.usage === null) return { values: null, invalid: false };
  if (!isRecord(value.usage)) return { values: null, invalid: true };
  const usage = value.usage;
  let invalid = false;
  const readCount = (count: unknown): number | null => {
    if (count === undefined || count === null) return null;
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 2_147_483_647) {
      invalid = true;
      return null;
    }
    return count as number;
  };
  const details = usage.input_tokens_details;
  if (details !== undefined && details !== null && !isRecord(details)) invalid = true;
  const providerRequestId = safeProviderIdentity(value.id);
  const providerModel = safeProviderIdentity(value.model);
  if (value.id !== undefined && value.id !== null && providerRequestId === undefined) invalid = true;
  if (value.model !== undefined && value.model !== null && providerModel === undefined) invalid = true;
  return {
    values: {
      promptTokens: readCount(usage.input_tokens),
      completionTokens: readCount(usage.output_tokens),
      totalTokens: readCount(usage.total_tokens),
      precachedPromptTokens: isRecord(details) ? readCount(details.cached_tokens) : null,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(providerModel ? { providerModel } : {}),
    },
    invalid,
  };
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeProviderIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 512
    || hasControlCharacters(value)) return undefined;
  return value;
}

function isRequestedProviderModel(value: unknown, requestedModelId: string): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 128) return false;
  if (value === requestedModelId) return true;
  const prefix = `${requestedModelId}:`;
  return value.startsWith(prefix) && /^\d+(?:\.\d+){1,12}$/.test(value.slice(prefix.length));
}

interface V2Metadata { model?: string; threadId?: string }
const V2_METADATA_KEYS = new Set(['model', 'thread_id', 'id', 'created_at', 'object', 'messages', 'finish_reason', 'usage']);

function parseV2Metadata(value: unknown, requestedModelId: string): V2Metadata {
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, 'choices')
    || Object.keys(value).some((key) => !V2_METADATA_KEYS.has(key))) throw new GigaChatProviderError('protocol');
  let model: string | undefined;
  if (value.model !== undefined && value.model !== null) {
    if (!isRequestedProviderModel(value.model, requestedModelId)) throw new GigaChatProviderError('protocol');
    model = value.model;
  }
  for (const key of ['thread_id', 'id'] as const) {
    if (value[key] !== undefined && value[key] !== null && !safeProviderIdentity(value[key])) throw new GigaChatProviderError('protocol');
  }
  if (value.created_at !== undefined && value.created_at !== null
    && !(typeof value.created_at === 'number' && Number.isSafeInteger(value.created_at)
      || typeof value.created_at === 'string' && value.created_at.length > 0 && value.created_at.length <= 64
      && !hasControlCharacters(value.created_at))) throw new GigaChatProviderError('protocol');
  if (value.object !== undefined && value.object !== null
    && (typeof value.object !== 'string' || value.object.length > 128 || hasControlCharacters(value.object))) {
    throw new GigaChatProviderError('protocol');
  }
  if (value.messages !== undefined && !Array.isArray(value.messages)) throw new GigaChatProviderError('protocol');
  if (value.finish_reason !== undefined && value.finish_reason !== null && typeof value.finish_reason !== 'string') {
    throw new GigaChatProviderError('protocol');
  }
  if (value.usage !== undefined && value.usage !== null && !isRecord(value.usage)) throw new GigaChatProviderError('protocol');
  return {
    ...(model ? { model } : {}),
    ...((safeProviderIdentity(value.thread_id) ?? safeProviderIdentity(value.id)) ? { threadId: safeProviderIdentity(value.thread_id) ?? safeProviderIdentity(value.id) } : {}),
  };
}

function parseV2FinishReason(value: unknown): V2FinishReason {
  if (!isRecord(value) || value.finish_reason === undefined || value.finish_reason === null) return null;
  if (value.finish_reason === 'stop') return 'stop';
  if (value.finish_reason === 'function_call') return 'function_call';
  if (value.finish_reason === 'length') return 'context';
  if (value.finish_reason === 'blacklist') return 'model';
  throw new GigaChatProviderError('protocol');
}

function getV2TerminalMessage(value: unknown, requestedModelId: string): ParsedV2AssistantMessage | null {
  parseV2Metadata(value, requestedModelId);
  if (!isRecord(value) || value.messages === undefined) return null;
  return parseV2AssistantMessage(value, true);
}

function parseV2AssistantMessage(value: unknown, allowMissingContent = false): ParsedV2AssistantMessage {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length !== 1 || !isRecord(value.messages[0])) {
    throw new GigaChatProviderError('protocol');
  }
  const message = value.messages[0];
  const allowedMessageKeys = new Set(['role', 'content', 'message_id', 'tool_state_id']);
  if (message.role !== 'assistant' || Object.keys(message).some((key) => !allowedMessageKeys.has(key))) {
    throw new GigaChatProviderError('protocol');
  }
  let content: unknown[] | null = null;
  if (Object.prototype.hasOwnProperty.call(message, 'content')) {
    if (!Array.isArray(message.content)) throw new GigaChatProviderError('protocol');
    content = message.content;
  } else if (!allowMissingContent) throw new GigaChatProviderError('protocol');
  const messageId = message.message_id;
  const stateId = message.tool_state_id;
  if (messageId !== undefined && !safeProviderIdentity(messageId)) throw new GigaChatProviderError('protocol');
  if (stateId !== undefined && !isProviderStateId(stateId)) throw new GigaChatProviderError('protocol');
  if (content === null) return {
    contentPresent: false,
    messageId: typeof messageId === 'string' ? messageId : null,
    text: null,
    functionsStateId: typeof stateId === 'string' ? stateId : null,
    functionCall: null,
  };
  let text = '';
  let hasText = false;
  let rawFunctionCall: Record<string, unknown> | null = null;
  for (const part of content) {
    if (!isRecord(part)) throw new GigaChatProviderError('protocol');
    if (Object.prototype.hasOwnProperty.call(part, 'text') && Object.keys(part).length === 1) {
      if (typeof part.text !== 'string') throw new GigaChatProviderError('protocol');
      hasText = true;
      text += part.text;
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new GigaChatProviderError('protocol');
      continue;
    }
    if (Object.keys(part).length !== 1 || !isRecord(part.function_call) || rawFunctionCall) throw new GigaChatProviderError('protocol');
    rawFunctionCall = part.function_call;
  }
  const normalizedText = hasText ? text : null;
  if (!rawFunctionCall) return {
    contentPresent: true,
    messageId: typeof messageId === 'string' ? messageId : null,
    text: normalizedText,
    functionsStateId: typeof stateId === 'string' ? stateId : null,
    functionCall: null,
  };
  const rawArguments = rawFunctionCall.arguments;
  let argumentsValue: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    if (Buffer.byteLength(rawArguments, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES) throw new GigaChatProviderError('protocol');
    try { argumentsValue = JSON.parse(rawArguments) as unknown; }
    catch { throw new GigaChatProviderError('protocol'); }
  }
  if (!isRecord(argumentsValue)) throw new GigaChatProviderError('protocol');
  let normalizedArguments: Record<string, unknown>;
  try { normalizedArguments = structuredClone(argumentsValue); }
  catch { throw new GigaChatProviderError('protocol'); }
  if (typeof rawFunctionCall.name !== 'string') throw new GigaChatProviderError('protocol');
  const wire = validateProviderV2FunctionWire({
    content,
    ...(messageId === undefined ? {} : { messageId }),
    ...(stateId === undefined ? {} : { toolStateId: stateId }),
  }, {
    name: rawFunctionCall.name,
    arguments: normalizedArguments,
    content: normalizedText,
    functionsStateId: typeof stateId === 'string' ? stateId : null,
  });
  if (!wire) throw new GigaChatProviderError('protocol');
  return {
    contentPresent: true,
    messageId: typeof messageId === 'string' ? messageId : null,
    text: normalizedText,
    functionsStateId: typeof stateId === 'string' ? stateId : null,
    functionCall: {
      name: rawFunctionCall.name,
      arguments: normalizedArguments,
      content: normalizedText,
      functionsStateId: typeof stateId === 'string' ? stateId : null,
      terminalReason: 'function_call',
      wire,
    },
  };
}

function isProviderStateId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-(?:4[0-9a-f]{3}|7[0-9a-f]{3})-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateBuiltinProgress(value: unknown): Array<{ name: string; secondsLeft?: number }> {
  if (!isRecord(value)) throw new GigaChatProviderError('protocol');
  let executions: unknown[] = [];
  if (Array.isArray(value.messages) && value.messages.length === 1 && isRecord(value.messages[0])) {
    const message = value.messages[0];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) throw new GigaChatProviderError('protocol');
    executions = message.content.map((part) => {
      if (!isRecord(part) || Object.keys(part).length !== 1 || !isRecord(part.tool_execution)) throw new GigaChatProviderError('protocol');
      return part.tool_execution;
    });
  } else if (isRecord(value.tool_execution)) executions = [value.tool_execution];
  if (!executions.length) throw new GigaChatProviderError('protocol');
  const validated: Array<{ name: string; secondsLeft?: number }> = [];
  for (const execution of executions) {
    if (!isRecord(execution)) throw new GigaChatProviderError('protocol');
    const name = safeProviderIdentity(execution.name);
    if (!name || Object.keys(execution).some((key) => !['name', 'status', 'seconds_left', 'censored'].includes(key))) {
      throw new GigaChatProviderError('protocol');
    }
    if (execution.status !== undefined && !['in_progress', 'success', 'fail'].includes(String(execution.status))) {
      throw new GigaChatProviderError('protocol');
    }
    if (execution.seconds_left !== undefined && (!Number.isSafeInteger(execution.seconds_left)
      || (execution.seconds_left as number) < 0 || (execution.seconds_left as number) > 3600)) throw new GigaChatProviderError('protocol');
    if (execution.censored !== undefined && typeof execution.censored !== 'boolean') throw new GigaChatProviderError('protocol');
    validated.push({ name, ...(typeof execution.seconds_left === 'number' ? { secondsLeft: execution.seconds_left } : {}) });
  }
  return validated;
}

function mergeProviderUsage(target: ProviderUsageValues, update: ProviderUsageValues): void {
  if (update.promptTokens !== null) target.promptTokens = update.promptTokens;
  if (update.completionTokens !== null) target.completionTokens = update.completionTokens;
  if (update.totalTokens !== null) target.totalTokens = update.totalTokens;
  if (update.precachedPromptTokens !== null) target.precachedPromptTokens = update.precachedPromptTokens;
  if (update.providerRequestId) target.providerRequestId = update.providerRequestId;
  if (update.providerModel) target.providerModel = update.providerModel;
}

function hasKnownProviderUsage(values: ProviderUsageValues): boolean {
  return values.promptTokens !== null || values.completionTokens !== null
    || values.totalTokens !== null || values.precachedPromptTokens !== null;
}

function mergeStateId(current: string | null, next: string | null): string | null {
  if (next === null) return current;
  if (!isProviderStateId(next) || current !== null && current !== next) throw new GigaChatProviderError('protocol');
  return next;
}

function mergeTerminalFunctionMetadata(
  call: ProviderFunctionCall,
  terminal: ParsedV2AssistantMessage,
): ProviderFunctionCall {
  const wire = call.wire;
  if (!wire || wire.messageId !== undefined && terminal.messageId !== null && wire.messageId !== terminal.messageId) {
    throw new GigaChatProviderError('protocol');
  }
  const functionsStateId = mergeStateId(call.functionsStateId, terminal.functionsStateId);
  const messageId = terminal.messageId ?? wire.messageId;
  const mergedWire = validateProviderV2FunctionWire({
    content: wire.content,
    ...(messageId ? { messageId } : {}),
    ...(functionsStateId ? { toolStateId: functionsStateId } : {}),
  }, {
    name: call.name,
    arguments: call.arguments,
    content: call.content,
    functionsStateId,
  });
  if (!mergedWire) throw new GigaChatProviderError('protocol');
  return { ...call, functionsStateId, wire: mergedWire };
}

function sameProviderFunctionCall(left: ProviderFunctionCall, right: ProviderFunctionCall): boolean {
  return left.name === right.name && left.content === right.content
    && left.functionsStateId === right.functionsStateId
    && isDeepStrictEqual(left.arguments, right.arguments)
    && isDeepStrictEqual(left.wire, right.wire);
}

function validateProtocolHistory(value: unknown): ProviderProtocolExchange[] {
  if (!Array.isArray(value) || value.length > 256) throw new GigaChatProviderError('protocol');
  return value.map((entry): ProviderProtocolExchange => {
    if (!isRecord(entry) || typeof entry.anchorMessageId !== 'string' || !entry.anchorMessageId
      || typeof entry.name !== 'string' || !entry.name || entry.name.length > 128
      // eslint-disable-next-line no-control-regex -- Reject control characters in persisted provider function names.
      || /[\u0000-\u001f\u007f]/.test(entry.name)
      || !isRecord(entry.arguments)
      || (entry.content !== null && typeof entry.content !== 'string')
      || (entry.functionsStateId !== null && typeof entry.functionsStateId !== 'string')
      || (entry.receiptId !== undefined && (typeof entry.receiptId !== 'string' || !/^[a-f0-9]{64}$/.test(entry.receiptId)))
      || typeof entry.result !== 'string' || Buffer.byteLength(entry.result, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES) {
      throw new GigaChatProviderError('protocol');
    }
    let argumentsBytes: number;
    try { argumentsBytes = Buffer.byteLength(JSON.stringify(entry.arguments), 'utf8'); }
    catch { throw new GigaChatProviderError('protocol'); }
    if (argumentsBytes > MAX_FUNCTION_ARGUMENT_BYTES || (entry.content !== null && entry.content.length > 16_000)) {
      throw new GigaChatProviderError('protocol');
    }
    let parsedResult: unknown;
    try { parsedResult = JSON.parse(entry.result) as unknown; }
    catch { throw new GigaChatProviderError('protocol'); }
    if (!isRecord(parsedResult)) throw new GigaChatProviderError('protocol');
    let wire: ProviderV2FunctionWire | undefined;
    if (entry.wire !== undefined) {
      const validatedWire = validateProviderV2FunctionWire(entry.wire, {
        name: entry.name,
        arguments: entry.arguments,
        content: entry.content as string | null,
        functionsStateId: entry.functionsStateId as string | null,
      });
      if (typeof entry.receiptId !== 'string' || !validatedWire) throw new GigaChatProviderError('protocol');
      wire = validatedWire;
    }
    return {
      anchorMessageId: entry.anchorMessageId,
      name: entry.name,
      arguments: structuredClone(entry.arguments),
      content: entry.content as string | null,
      functionsStateId: entry.functionsStateId as string | null,
      result: entry.result,
      ...(entry.receiptId === undefined ? {} : { receiptId: entry.receiptId as string }),
      ...(wire ? { wire } : {}),
    };
  });
}

function linkAbortSignals(...signals: AbortSignal[]): { controller: AbortController; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const activeSignals: AbortSignal[] = [];
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else {
      signal.addEventListener('abort', abort, { once: true });
      activeSignals.push(signal);
    }
  }
  return {
    controller,
    dispose: () => activeSignals.forEach((signal) => signal.removeEventListener('abort', abort)),
  };
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void promise.then((value) => onLate?.(value), () => undefined);
    return Promise.reject(new GigaChatProviderError('cancel'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GigaChatProviderError('cancel'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      if (settled) { onLate?.(value); return; }
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function parseModelIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new GigaChatProviderError('protocol');
  const ids = value.data.map((entry: unknown) => {
    if (!isRecord(entry)) throw new GigaChatProviderError('protocol');
    try { return requireModelId(entry.id); }
    catch { throw new GigaChatProviderError('protocol'); }
  });
  if (new Set(ids).size !== ids.length) throw new GigaChatProviderError('protocol');
  return ids;
}

function statusError(statusCode: number): GigaChatProviderError {
  if (statusCode === 401 || statusCode === 403) return new GigaChatProviderError('auth', false, statusCode);
  if (statusCode === 402) return new GigaChatProviderError('quota', false, statusCode);
  if (statusCode === 413) return new GigaChatProviderError('context', false, statusCode);
  if (statusCode === 429) return new GigaChatProviderError('rate-limit', true, statusCode);
  if (statusCode === 404) return new GigaChatProviderError('model', false, statusCode);
  if (statusCode >= 500 || statusCode === 408) return new GigaChatProviderError('network', true, statusCode);
  return new GigaChatProviderError('protocol', false, statusCode);
}

function errorCategory(error: unknown): ProviderErrorCategory {
  if (error instanceof GigaChatProviderError) return error.category;
  if (typeof error === 'object' && error !== null && 'category' in error
    && typeof error.category === 'string'
    && ['auth', 'tls', 'network', 'rate-limit', 'quota', 'model', 'context', 'protocol', 'tool', 'storage', 'cancel'].includes(error.category)) {
    return error.category as ProviderErrorCategory;
  }
  return 'protocol';
}

function transportError(error: unknown, signal?: AbortSignal): GigaChatProviderError {
  if (error instanceof GigaChatProviderError) return error;
  if (signal?.aborted || isAbortError(error)) return new GigaChatProviderError('cancel');
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code)) return new GigaChatProviderError('tls');
  return new GigaChatProviderError('network', true);
}

function abortError(): Error {
  return Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'ABORT_ERR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
