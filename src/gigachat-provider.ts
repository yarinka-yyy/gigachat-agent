import { Buffer } from 'node:buffer';
import { randomUUID, X509Certificate } from 'node:crypto';
import { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import * as tls from 'node:tls';
import type { GigaChatProvider, ModelRegistrySnapshot, ProviderConnectionSnapshot, ProviderErrorCategory, ProviderEvent, ProviderTurnRequest } from './contracts';
import { discoveredModelRegistry, failedModelRegistry, isModelAvailable, requireModelId, unavailableModelRegistry } from './models';

export const GIGACHAT_API_BASE_URL = 'https://api.giga.chat/v1';
export const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_ROOT_CA_SHA256 = 'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31';

const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ProviderTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
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

export interface GigaChatProviderConnection extends GigaChatProvider {
  getConnectionStatus(): ProviderConnectionSnapshot;
  getModelRegistry(): ModelRegistrySnapshot;
  connect(): Promise<ProviderConnectionSnapshot>;
  cancelConnect(): ProviderConnectionSnapshot;
  disconnect(): ProviderConnectionSnapshot;
  invalidateSavedKey(): void;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export class GigaChatProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;

  constructor(category: ProviderErrorCategory, retryable = false) {
    super(category);
    this.name = 'GigaChatProviderError';
    this.category = category;
    this.retryable = retryable;
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
  let modelRegistryGeneration = 0;

  const getStatus = (): ProviderConnectionSnapshot => ({ ...connectionStatus });
  const getModelRegistry = (): ModelRegistrySnapshot => ({ ...modelRegistry, modelIds: [...modelRegistry.modelIds] });
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
    const value = await fetchJson({
      url: GIGACHAT_OAUTH_URL,
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorizationKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        RqUID: randomUUID(),
      },
      body,
      signal,
    });
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
      assertCurrent(expectedGeneration, signal);
      return parseModelIds(value);
    }
    throw new GigaChatProviderError('auth');
  };

  const connect = async (): Promise<ProviderConnectionSnapshot> => {
    const operationGeneration = reset();
    const operation = linkAbortSignals(sessionController.signal);
    const controller = operation.controller;
    connectController = controller;
    setStatus({ state: 'connecting', errorCategory: null });
    try {
      const authorizationKey = await loadKey();
      assertCurrent(operationGeneration, controller.signal);
      if (!authorizationKey) {
        setStatus({ state: 'not-configured', errorCategory: null });
        return getStatus();
      }
      await getAccessToken(controller.signal, operationGeneration, authorizationKey);
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
        setStatus({ state: 'error', errorCategory: category });
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
    try {
      assertCurrent(operationGeneration, operation.controller.signal);
      let modelId: string | null;
      try { modelId = request.modelId === null ? null : requireModelId(request.modelId); }
      catch { throw new GigaChatProviderError('model'); }
      if (connectionStatus.state !== 'connected' || !modelId || !isModelAvailable(modelRegistry, modelId)) {
        throw new GigaChatProviderError('model');
      }
      if (!Array.isArray(request.system) || !Array.isArray(request.messages)) throw new GigaChatProviderError('protocol');
      const systemPrompt = request.system.map((layer) => {
        if (!layer || typeof layer.label !== 'string' || typeof layer.text !== 'string') throw new GigaChatProviderError('protocol');
        return `[${layer.label}]\n${layer.text}`;
      }).join('\n\n');
      const messages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...request.messages.map((message) => {
          if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') {
            throw new GigaChatProviderError('protocol');
          }
          return { role: message.role, content: message.text };
        }),
      ];
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
            body: JSON.stringify({ model: modelId, messages, stream: true, function_call: 'none' }),
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
      let receivedStop = false;
      let receivedDone = false;
      for await (const data of readSseData(response.body, operation.controller.signal)) {
        assertCurrent(operationGeneration, operation.controller.signal);
        if (data === '[DONE]') {
          if (!receivedStop || receivedDone) throw new GigaChatProviderError('protocol');
          receivedDone = true;
          break;
        }
        if (receivedStop || receivedDone) throw new GigaChatProviderError('protocol');
        const chunk = parseCompletionChunk(data);
        if (chunk.content) yield { type: 'text-delta', text: chunk.content };
        if (chunk.errorCategory) throw new GigaChatProviderError(chunk.errorCategory);
        if (chunk.finishReasonStop) receivedStop = true;
      }
      assertCurrent(operationGeneration, operation.controller.signal);
      if (!receivedStop || !receivedDone) throw new GigaChatProviderError('protocol');
      yield { type: 'completed' };
    } catch (error) {
      const normalized = error instanceof GigaChatProviderError
        ? error : transportError(error, operation.controller.signal);
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
    connect,
    cancelConnect,
    disconnect: () => { reset(); return getStatus(); },
    invalidateSavedKey: () => { reset(); },
    stream,
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

function parseCompletionChunk(value: string): {
  content: string | null;
  finishReasonStop: boolean;
  errorCategory?: ProviderErrorCategory;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new GigaChatProviderError('protocol'); }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length !== 1) {
    throw new GigaChatProviderError('protocol');
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)
    || (choice.index !== undefined && choice.index !== 0)) {
    throw new GigaChatProviderError('protocol');
  }
  let errorCategory: ProviderErrorCategory | undefined;
  if ('function_call' in choice.delta) errorCategory = 'tool';
  const finishReason = choice.finish_reason;
  let finishReasonStop = false;
  if (finishReason !== undefined && finishReason !== null) {
    if (finishReason === 'length') errorCategory = 'context';
    else if (finishReason === 'function_call') errorCategory = 'tool';
    else if (finishReason === 'blacklist') errorCategory = 'model';
    else if (finishReason === 'stop') finishReasonStop = true;
    else throw new GigaChatProviderError('protocol');
  }
  const content = choice.delta.content;
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new GigaChatProviderError('protocol');
  }
  return {
    content: typeof content === 'string' ? content : null,
    finishReasonStop,
    ...(errorCategory ? { errorCategory } : {}),
  };
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
  if (statusCode === 401 || statusCode === 403) return new GigaChatProviderError('auth');
  if (statusCode === 402) return new GigaChatProviderError('quota');
  if (statusCode === 413) return new GigaChatProviderError('context');
  if (statusCode === 429) return new GigaChatProviderError('rate-limit', true);
  if (statusCode === 404) return new GigaChatProviderError('model');
  if (statusCode >= 500 || statusCode === 408) return new GigaChatProviderError('network', true);
  return new GigaChatProviderError('protocol');
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
