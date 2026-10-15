import { Buffer } from 'node:buffer';
import { randomUUID, X509Certificate } from 'node:crypto';
import { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import * as tls from 'node:tls';
import type { BalanceFamilyId, GigaChatProvider, ModelRegistrySnapshot, ProviderAttachmentReference, ProviderBalanceObservation, ProviderConnectionSnapshot, ProviderErrorCategory, ProviderEvent, ProviderFileRecord, ProviderFileUploadInput, ProviderProtocolExchange, ProviderTurnRequest, ProviderUsageValues } from './contracts';
import { discoveredModelRegistry, failedModelRegistry, isModelAvailable, requireModelId, unavailableModelRegistry, type GigaChatModelId } from './models';
import { billingFamilyForUsageLabel, CHAT_MODEL_FAMILIES, isChatModelAvailable } from './model-catalog';
import { attachmentContentType, inspectLocalAttachmentContent, LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES, PROVIDER_IMAGE_LIMIT_BYTES, PROVIDER_MEDIA_LIMIT_BYTES, PROVIDER_REQUEST_LIMIT_BYTES } from './attachment-policy';

export const GIGACHAT_API_BASE_URL = 'https://api.giga.chat/v1';
export const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_ROOT_CA_SHA256 = 'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31';

const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_FUNCTION_ARGUMENT_BYTES = 1_900_000;
export const MAX_PROVIDER_REQUEST_BYTES = PROVIDER_REQUEST_LIMIT_BYTES;

const GIGACHAT_FUNCTIONS: readonly Record<string, unknown>[] = [
  { name: 'list', description: 'Показывает файлы и папки в доступной рабочей папке с учётом профиля разрешений. Путь задаётся относительно её корня; пустой или отсутствующий путь означает корень. Абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 2048 } }, additionalProperties: false } },
  { name: 'search', description: 'Ищет текст в файле или папке внутри доступной рабочей папки с учётом профиля разрешений. Путь задаётся относительно её корня; пустой или отсутствующий путь означает корень. Абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, path: { type: 'string', maxLength: 2048 } }, required: ['query'], additionalProperties: false } },
  { name: 'read', description: 'Читает небольшой текстовый файл внутри доступной рабочей папки с учётом профиля разрешений. Укажите непустой путь относительно её корня; абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['path'], additionalProperties: false } },
  { name: 'write', description: 'Записывает ровно переданный полный UTF-8 текст в файл внутри доступной рабочей папки с учётом профиля разрешений. Укажите непустой путь относительно её корня; абсолютные пути и переходы за корень не принимаются. Содержимое ограничено 1 МиБ.', parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 2048 }, contents: { type: 'string', maxLength: 1048576, description: 'Передавайте полный текст файла в UTF-8: записывается ровно это содержимое без нормализации переносов или автоматического добавления завершающего перевода строки. При редактировании сохраняйте неизменённые строки, отступы, разделители строк и исходное окончание файла.' } }, required: ['path', 'contents'], additionalProperties: false } },
  { name: 'open', description: 'Открывает или показывает безопасный файл либо папку внутри доступной рабочей папки с учётом профиля разрешений. Путь задаётся относительно её корня; пустой или отсутствующий путь означает корень. Абсолютные пути и переходы за корень не принимаются.', parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 2048 } }, additionalProperties: false } },
  { name: 'powershell', description: 'Выполнение PowerShell через существующий локальный helper и текущий профиль разрешений.', parameters: { type: 'object', properties: { script: { type: 'string', minLength: 1, maxLength: 16384 }, external_access: { type: 'boolean' } }, required: ['script'], additionalProperties: false } },
];

const GIGACHAT_BUILTIN_FUNCTIONS: readonly Record<string, unknown>[] = [
  { name: 'get_file_content' },
];

export interface ProviderTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
  streaming?: boolean;
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

export function serializeProviderTurnRequest(request: ProviderTurnRequest): SerializedProviderTurnRequest {
  let modelId: string;
  try { modelId = request.modelId === null ? '' : requireModelId(request.modelId); }
  catch { throw new GigaChatProviderError('model'); }
  if (!modelId || !Array.isArray(request.system) || !Array.isArray(request.messages)) {
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
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
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
    const imageCount = messageAttachments.filter((attachment) => attachment.kind === 'image').length;
    const groups: Array<{ fileIds: string[]; imageIndex: number | null }> = [{ fileIds: [], imageIndex: null }];
    let nextImageIndex = 0;
    for (const attachment of messageAttachments) {
      if (attachment.kind === 'image') {
        if (nextImageIndex > 0) groups.push({ fileIds: [], imageIndex: null });
        nextImageIndex += 1;
        groups[groups.length - 1]!.imageIndex = nextImageIndex;
      }
      groups[groups.length - 1]!.fileIds.push(attachment.fileId);
    }
    const imageTask = message.text || request.system.find((layer) => layer.source === 'runtime'
      && layer.label === 'Задача текущего запроса')?.text || '';
    const wireContent = (group: typeof groups[number]): string => {
      if (imageCount <= 1 || group.imageIndex === null) return message.text;
      const label = `Изображение ${group.imageIndex}/${imageCount}`;
      return imageTask ? `${imageTask}\n\n${label}` : label;
    };
    messages.push({
      role: message.role,
      content: wireContent(groups[0]!),
      ...(groups[0]!.fileIds.length ? { attachments: groups[0]!.fileIds } : {}),
      ...(message.role === 'assistant' && message.functionsStateId ? { functions_state_id: message.functionsStateId } : {}),
    });
    for (const group of groups.slice(1)) {
      messages.push({ role: 'user', content: wireContent(group), attachments: group.fileIds });
    }
    if (message.role === 'user') {
      for (const exchange of exchanges.get(message.id) ?? []) {
        messages.push({
          role: 'assistant', content: exchange.content ?? '',
          ...(exchange.functionsStateId ? { functions_state_id: exchange.functionsStateId } : {}),
          function_call: { name: exchange.name, arguments: exchange.arguments },
        });
        messages.push({ role: 'function', name: exchange.name, content: exchange.result });
      }
    }
  }
  if (protocolHistory.some((exchange) => !request.messages.some((message) => message.role === 'user' && message.id === exchange.anchorMessageId))) {
    throw new GigaChatProviderError('protocol');
  }
  const functionsEnabled = request.functionCallMode !== 'none';
  let body: string;
  try {
    body = JSON.stringify({
      model: modelId,
      messages,
      ...(functionsEnabled ? { functions: [...GIGACHAT_FUNCTIONS, ...GIGACHAT_BUILTIN_FUNCTIONS] } : {}),
      stream: true,
      function_call: functionsEnabled ? 'auto' : 'none',
    });
  } catch { throw new GigaChatProviderError('protocol'); }
  const wireBytes = Buffer.byteLength(body, 'utf8');
  if (wireBytes > MAX_PROVIDER_REQUEST_BYTES) throw new GigaChatProviderError('context');
  const mediaBytes = attachments.reduce((total, attachment) => total + (attachment.kind === 'image' ? attachment.sizeBytes : 0), 0);
  if (mediaBytes + wireBytes >= PROVIDER_MEDIA_LIMIT_BYTES) throw new GigaChatProviderError('context');
  return {
    body,
    wireBytes,
    textInputs: messages.flatMap((message) => typeof message.content === 'string' ? [message.content] : []),
    functionSchemaBytes: functionsEnabled ? Buffer.byteLength(JSON.stringify([...GIGACHAT_FUNCTIONS, ...GIGACHAT_BUILTIN_FUNCTIONS]), 'utf8') : 0,
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

  constructor(category: ProviderErrorCategory, retryable = false, httpStatus?: number) {
    super(category);
    this.name = 'GigaChatProviderError';
    this.category = category;
    this.retryable = retryable;
    if (httpStatus !== undefined && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
  }
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    request(requestOptions) {
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
            url: `${GIGACHAT_API_BASE_URL}/chat/completions`,
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
      let terminalReason: 'stop' | 'function_call' | null = null;
      let terminalFunctionsStateId: string | null = null;
      let terminalFunctionCall: NonNullable<ReturnType<typeof parseCompletionChunk>['functionCall']> | null = null;
      let receivedDone = false;
      for await (const data of readSseData(response.body, operation.controller.signal)) {
        assertCurrent(operationGeneration, operation.controller.signal);
        if (data === '[DONE]') {
          if (!terminalReason || receivedDone) throw new GigaChatProviderError('protocol');
          receivedDone = true;
          break;
        }
        if (terminalReason || receivedDone) throw new GigaChatProviderError('protocol');
        const payload = parseSsePayload(data);
        const usage = parseProviderUsage(payload);
        if (usage) yield { type: 'usage', ...usage };
        const chunk = parseCompletionChunk(payload);
        if (chunk.functionProgress) {
          yield {
            type: 'activity',
            activity: 'function-progress',
            functionName: chunk.functionProgress.name,
            detail: chunk.functionProgress.detail,
          };
          continue;
        }
        if (chunk.finishReason === 'function_call') {
          if (chunk.errorCategory) throw new GigaChatProviderError(chunk.errorCategory);
          if (!chunk.functionCall) throw new GigaChatProviderError('protocol');
          terminalReason = 'function_call';
          terminalFunctionsStateId = chunk.functionCall.functionsStateId;
          terminalFunctionCall = chunk.functionCall;
        } else {
          if (chunk.content) yield { type: 'text-delta', text: chunk.content };
          if (chunk.errorCategory) throw new GigaChatProviderError(chunk.errorCategory);
          if (chunk.functionsStateId) terminalFunctionsStateId = chunk.functionsStateId;
          if (chunk.finishReason === 'stop') terminalReason = 'stop';
        }
      }
      assertCurrent(operationGeneration, operation.controller.signal);
      if (!terminalReason || !receivedDone) throw new GigaChatProviderError('protocol');
      if (terminalReason === 'function_call' && terminalFunctionCall) yield { type: 'function-call', functionCall: terminalFunctionCall };
      else if (terminalReason === 'stop') yield { type: 'completed', ...(terminalFunctionsStateId ? { functionsStateId: terminalFunctionsStateId } : {}) };
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

async function* readSseData(body: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const iterator = body[Symbol.asyncIterator]();
  let buffer = '';
  let totalBytes = 0;
  let dataLines: string[] = [];
  let dataLength = 0;
  const consumeLine = (line: string): string | null => {
    if (line === '') {
      if (dataLines.length === 0) return null;
      const data = dataLines.join('\n');
      dataLines = [];
      dataLength = 0;
      return data;
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataLength += value.length + (dataLines.length ? 1 : 0);
      if (dataLength > MAX_RESPONSE_BYTES) throw new GigaChatProviderError('protocol');
      dataLines.push(value);
    }
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
      if (result.done) break;
      appendBytes(result.value);
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === buffer.length - 1) break;
        const line = buffer.slice(start, index);
        if (character === '\r' && buffer[index + 1] === '\n') index += 1;
        start = index + 1;
        const data = consumeLine(line);
        if (data !== null) yield data;
      }
      buffer = buffer.slice(start);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) throw new GigaChatProviderError('protocol');
    }
    try { buffer += decoder.decode(); }
    catch { throw new GigaChatProviderError('protocol'); }
    if (buffer) {
      const data = consumeLine(buffer);
      if (data !== null) yield data;
      buffer = '';
    }
    if (dataLines.length) yield dataLines.join('\n');
  } catch (error) {
    if (error instanceof GigaChatProviderError) throw error;
    throw transportError(error, signal);
  } finally {
    if (signal.aborted && iterator.return) {
      await Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}

function parseSsePayload(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new GigaChatProviderError('protocol'); }
}

function parseProviderUsage(value: unknown): ProviderUsageValues | null {
  if (!isRecord(value)) return null;
  const rawUsage = value.usage;
  if (rawUsage !== undefined && rawUsage !== null && !isRecord(rawUsage)) throw new GigaChatProviderError('protocol');
  const hasIdentity = (value.id !== undefined && value.id !== null) || (value.model !== undefined && value.model !== null);
  if (!rawUsage && !hasIdentity) return null;
  const usage = isRecord(rawUsage) ? rawUsage : {};
  const readCount = (key: string): number | null => {
    const count = usage[key];
    if (count === undefined || count === null) return null;
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 2_147_483_647) {
      throw new GigaChatProviderError('protocol');
    }
    return count as number;
  };
  const readIdentity = (key: string): string | undefined => {
    const metadata = value[key];
    if (metadata === undefined || metadata === null) return undefined;
    if (typeof metadata !== 'string' || metadata.length < 1 || metadata.length > 512
      // eslint-disable-next-line no-control-regex -- Reject control characters in provider usage identity fields.
      || /[\u0000-\u001f\u007f]/.test(metadata)) {
      throw new GigaChatProviderError('protocol');
    }
    return metadata;
  };
  const providerRequestId = readIdentity('id');
  const providerModel = readIdentity('model');
  return {
    promptTokens: readCount('prompt_tokens'),
    completionTokens: readCount('completion_tokens'),
    totalTokens: readCount('total_tokens'),
    precachedPromptTokens: readCount('precached_prompt_tokens'),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerModel ? { providerModel } : {}),
  };
}

function parseCompletionChunk(parsed: unknown): {
  content: string | null;
  functionsStateId: string | null;
  finishReason: 'stop' | 'function_call' | null;
  functionProgress?: { name: 'get_file_content' | 'text2image'; detail: string };
  functionCall?: { name: string; arguments: Record<string, unknown>; content: string | null; functionsStateId: string | null; terminalReason: 'function_call' };
  errorCategory?: ProviderErrorCategory;
} {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length !== 1) {
    throw new GigaChatProviderError('protocol');
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)
    || (choice.index !== undefined && choice.index !== 0)) {
    throw new GigaChatProviderError('protocol');
  }
  let errorCategory: ProviderErrorCategory | undefined;
  const role = choice.delta.role;
  if (role !== undefined && role !== 'assistant' && role !== 'function_in_progress') {
    throw new GigaChatProviderError('protocol');
  }
  const finishReason = choice.finish_reason;
  let terminal: 'stop' | 'function_call' | null = null;
  if (finishReason !== undefined && finishReason !== null) {
    if (finishReason === 'length') errorCategory = 'context';
    else if (finishReason === 'function_call') terminal = 'function_call';
    else if (finishReason === 'blacklist') errorCategory = 'model';
    else if (finishReason === 'stop') terminal = 'stop';
    else throw new GigaChatProviderError('protocol');
  }
  const content = choice.delta.content;
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new GigaChatProviderError('protocol');
  }
  const rawStateId = choice.delta.functions_state_id;
  if (rawStateId !== undefined && (typeof rawStateId !== 'string' || rawStateId.length === 0 || rawStateId.length > 4096
    // eslint-disable-next-line no-control-regex -- Reject control characters in provider protocol state IDs.
    || /[\u0000-\u001f\u007f]/.test(rawStateId))) throw new GigaChatProviderError('protocol');
  const functionsStateId = typeof rawStateId === 'string' ? rawStateId : null;
  let functionProgress: { name: 'get_file_content' | 'text2image'; detail: string } | undefined;
  if (role === 'function_in_progress') {
    const name = choice.delta.name;
    if ((name !== 'get_file_content' && name !== 'text2image') || typeof content !== 'string'
      || content.length > 1000 || terminal !== null || 'function_call' in choice.delta) {
      throw new GigaChatProviderError('protocol');
    }
    functionProgress = { name, detail: content };
  } else if ('name' in choice.delta) {
    throw new GigaChatProviderError('protocol');
  }
  let functionCall: ReturnType<typeof parseProviderFunctionCall> | undefined;
  if ('function_call' in choice.delta) {
    if (terminal !== 'function_call') throw new GigaChatProviderError('protocol');
    functionCall = parseProviderFunctionCall(choice.delta.function_call, typeof content === 'string' ? content : null, functionsStateId);
  } else if (terminal === 'function_call') throw new GigaChatProviderError('protocol');
  return {
    content: typeof content === 'string' ? content : null,
    functionsStateId,
    finishReason: terminal,
    ...(functionProgress ? { functionProgress } : {}),
    ...(functionCall ? { functionCall } : {}),
    ...(errorCategory ? { errorCategory } : {}),
  };
}

function parseProviderFunctionCall(
  value: unknown,
  content: string | null,
  functionsStateId: string | null,
): { name: string; arguments: Record<string, unknown>; content: string | null; functionsStateId: string | null; terminalReason: 'function_call' } {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name || value.name.length > 128
    // eslint-disable-next-line no-control-regex -- Reject control characters in provider-supplied function names.
    || /[\u0000-\u001f\u007f]/.test(value.name) || !isRecord(value.arguments)) {
    throw new GigaChatProviderError('protocol');
  }
  let encoded: string;
  try { encoded = JSON.stringify(value.arguments); }
  catch { throw new GigaChatProviderError('protocol'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES || (content?.length ?? 0) > 16_000) {
    throw new GigaChatProviderError('protocol');
  }
  return { name: value.name, arguments: value.arguments, content, functionsStateId, terminalReason: 'function_call' };
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
    return {
      anchorMessageId: entry.anchorMessageId,
      name: entry.name,
      arguments: structuredClone(entry.arguments),
      content: entry.content as string | null,
      functionsStateId: entry.functionsStateId as string | null,
      result: entry.result,
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
