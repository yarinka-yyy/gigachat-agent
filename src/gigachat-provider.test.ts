import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import type { AcceptedTurnInput, ImageProtocolDiagnostic, ProviderEvent, ProviderTurnRequest } from './contracts';
import {
  createGigaChatProvider,
  createHttpsTransport,
  GIGACHAT_API_BASE_URL,
  GIGACHAT_OAUTH_URL,
  GigaChatProviderError,
  type ProviderImageGenerationRequest,
  type ProviderTransport,
  type ProviderTransportRequest,
  type ProviderTransportResponse,
} from './gigachat-provider';
import { validateProviderV2FunctionWire } from './provider-wire';
import { createTurnRuntime } from './runtime';
import type { LocalTools } from './local-tools';

const FIXED_NOW = Date.UTC(2026, 9, 9, 12);

test('V2 function wire preserves exact object and string argument representations', () => {
  const expected = {
    name: 'read', arguments: { path: 'notes/a.txt' }, content: 'Read this file.\nKeep its exact text.',
    functionsStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13',
  };
  const objectWire = {
    content: [
      { text: expected.content },
      { function_call: { id: '018f47b2-6c10-4a21-8f2b-1fd4d0470c13', name: 'read', arguments: { path: 'notes/a.txt' } } },
    ],
    messageId: 'message-42',
    toolStateId: expected.functionsStateId,
  };
  assert.deepEqual(validateProviderV2FunctionWire(objectWire, expected), objectWire);

  const stringWire = {
    ...objectWire,
    content: [
      { text: expected.content },
      { function_call: { id: '018f47b2-6c10-4a21-8f2b-1fd4d0470c13', name: 'read', arguments: '{"path":"notes/a.txt"}' } },
    ],
  };
  assert.deepEqual(validateProviderV2FunctionWire(stringWire, expected), stringWire);
});

test('V2 function wire rejects control characters and malformed non-JSON objects safely', () => {
  const base = {
    content: [{ function_call: { name: 'read', arguments: { path: 'notes/a.txt' } } }],
    messageId: 'message-42',
    toolStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13',
  };
  assert.equal(validateProviderV2FunctionWire({ ...base, messageId: 'message\n42' }), null);
  assert.equal(validateProviderV2FunctionWire({ ...base, content: [{ function_call: { name: 'read\n', arguments: { path: 'a' } } }] }), null);
  assert.equal(validateProviderV2FunctionWire({ ...base, content: [{ function_call: { id: 'call\t42', name: 'read', arguments: { path: 'a' } } }] }), null);
  assert.equal(validateProviderV2FunctionWire({ ...base, toolStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13\u007f' }), null);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(validateProviderV2FunctionWire({ content: [{ function_call: { name: 'read', arguments: cyclic } }] }), null);
  assert.equal(validateProviderV2FunctionWire({ content: [{ function_call: { name: 'read', arguments: { path: undefined } } }] }), null);
  assert.equal(validateProviderV2FunctionWire({ content: [{ function_call: { name: 'read', arguments: { path: Number.NaN } } }] }), null);
  const hostile = new Proxy({ path: 'a' }, { getPrototypeOf() { throw new Error('fixture'); } });
  assert.equal(validateProviderV2FunctionWire({ content: [{ function_call: { name: 'read', arguments: hostile } }] }), null);
});
const TEST_SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCzPfEZSXYw3eBW
3ot6iJNDUXuEiKvJUyhA5DBqO+WfS0bD6ZHRq26YtcT3n8X9BeFgE6LsJJ0krnt1
XjRzK5q21jBMKex+OoYsnZ+nphlGadaPkEJrim/yoHz8BjEo922UK+O955G/8O3x
D3xuaTH/PrUgziDO6r8mSW7lMGfHHMjx3FgM6WF5W4kE34F3KMdpnyvbTDr9BYdN
Am1Ji7xd3uA5+/EuPs2w9BvfZNjQOAPYS/7/RWysTRC3sdblC2td1+g570CXkpq7
TiqXm5X41StIuLDlvQBpiJaiDZGjLMmuBZyWM051A7c6kUpPv2RqMqGJ6hSCHUD8
2vJJhN1VAgMBAAECggEANsERSZw7Uqo0wdSx3viho8rcZJwrfhC9FzWd5JXviz2/
nFFZjidEXboJNWvFW4nUUzksZ963cmEqravdceE8HeZIUrvr1pOiMTblcp0201+5
f5md8KQVlpSYGZT6p30OKFlP9M8sounChgUpCcFw2HwbcK4HL65ePh/olHK5AQWy
4IKX1ofxj24LXvTWMpZBogh9hV/FOxNoebgMrDjhkj3bNtoW336N7U8dRctbvrPJ
cvOqeHQImcvFoo5ny3BqJEIXMz8rYD7DrgsG7YXHQlP5El/PqVPXO+UBPWCDqXLw
zRMQ8X0JpRyfAnExMX2CfVG6DfeQVIzkknfgE2TScQKBgQDINtr2SiLFWts1UO35
MtJcbyqQyFEFz5b/WABHSMZuOB6Ay4e8Td1vfocBnG2AMJ0Z0XCmxVmtcf02tlLK
RM94N+PFty9dThy90NKyhphPJfGKCP2JUxUX7yPOqGrAslK83fueBY7EYKNIwjnU
5N0McVjKOBA3ggoaUOiKWpuR4wKBgQDlLyVIrvvn4OxRST6MNnht1scQO3mDF4gp
krGO9PyTAUomL9TA5tuljSajOgHP4FB9m3sqpq62glMh5A/+iVEa7vc17iHA0fMG
cEDJ8uCJXfkEjM0U8KyBHBJ32HgX9iNRTP9UYrykPYXExSolO6OiqhQ1vpKifAtC
gTtc5PoZZwKBgHTvfQGeGSLVRvSj2OnUIgL0tpKrPI89SH7IYhlASwzy3/Xvac60
V6GX77gkKdxWCFuc9MOivhbMXc0HveD/QYGAexruO86uIaFHhtfYPrrzeVhameIL
0WUSOgKoYPk87Y/7wsrvigvuOU/0iJxsMyLiTK6HAgm5fLcUDE1KUFRrAoGAO1vA
nlij6eS5kDwWNR6OhnRQToX47NkVbR8PWeVd3X1CBS3yPpwMW455aWFGwt5oOoAg
oGVXbvHGMkrtUZGjLgSihpdMqrI17X75aNS9DxcFvgXxv/Ct3Sq2JdAtGpenghEd
OG/yR9+fW91tEwOlWCYQ4fKf6/GQwQLTqzWrCRUCgYEAnhTgfg2OSBL/frBoxh9T
emZRd7uYtef2l6wy7xQsR+sJsEJ0tDXI23yA/YugPvd2TemjH4/K/69hrgT9OQsM
ASKVzjBl2AnZJS859aun0wkXp4ejZWkMJfDT9NwRe5hBrNv/iwxXnO5ukZaMH6Nq
PDsZNZvlczuX9WBRyfaf3RI=
-----END PRIVATE KEY-----`;
const TEST_SERVER_CA = `-----BEGIN CERTIFICATE-----
MIIC6TCCAdGgAwIBAgIIJpnRrYnngxYwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UE
AxMJbG9jYWxob3N0MB4XDTI2MTAwODE3MTI1MloXDTI4MTAwOTE3MTI1MlowFDES
MBAGA1UEAxMJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAsz3xGUl2MN3gVt6LeoiTQ1F7hIiryVMoQOQwajvln0tGw+mR0atumLXE95/F
/QXhYBOi7CSdJK57dV40cyuattYwTCnsfjqGLJ2fp6YZRmnWj5BCa4pv8qB8/AYx
KPdtlCvjveeRv/Dt8Q98bmkx/z61IM4gzuq/Jklu5TBnxxzI8dxYDOlheVuJBN+B
dyjHaZ8r20w6/QWHTQJtSYu8Xd7gOfvxLj7NsPQb32TY0DgD2Ev+/0VsrE0Qt7HW
5QtrXdfoOe9Al5Kau04ql5uV+NUrSLiw5b0AaYiWog2RoyzJrgWcljNOdQO3OpFK
T79kajKhieoUgh1A/NrySYTdVQIDAQABoz8wPTAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAqQwDQYJKoZIhvcNAQELBQADggEBAJq3B/EENz4CaP2B271Iy45o1FvBJtghCa+U0KTal/liZJYP
M8P2hDQBJVvaOoS/jC9j4UWUDUupleNR9eJOemf5b0sGYNJdjTOhBe21BrrfUrDK
X5YabujZJaOfUF8j53tCLxo1RdFYPgeRPBfqIaV6uV7M06TshrNJUupQLFS4nyDU
T0OO/HYhTy6JI6COBlRjAZauK9D8PUMR/UCKn0BI9Sg0WEbry2WrsmIBcbJ4izLK
6jgSMDWrT45cbBoA3vMZ/ytDc9o7ia9nRQNrYIMpgHbHyOvvSuH2JHPJr1KH3Ozf
0AopktxuhEhDMdTYRIAfuze32jU/Dt38EgEfo+w=
-----END CERTIFICATE-----`;


function jsonResponse(statusCode: number, value: unknown, contentType = 'application/json'): ProviderTransportResponse {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    statusCode,
    headers: { 'content-type': contentType },
    body: (async function* () { yield bytes; }()),
    cancel() {},
  };
}

function eventStreamResponse(chunks: readonly Uint8Array[], statusCode = 200, contentType = 'text/event-stream'): ProviderTransportResponse {
  return {
    statusCode,
    headers: { 'content-type': contentType },
    body: (async function* () { for (const chunk of chunks) yield chunk; }()),
    cancel() {},
  };
}

function v2Frame(event: string, payload: unknown): Buffer {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, 'utf8');
}

function v2TextResponse(model: string): ProviderTransportResponse {
  return eventStreamResponse([
    v2Frame('response.message.delta', { model, messages: [{ role: 'assistant', content: [{ text: '' }] }] }),
    v2Frame('response.message.done', { model, finish_reason: 'stop' }),
  ]);
}

function fakeTransport(handler: (request: ProviderTransportRequest) => Promise<ProviderTransportResponse> | ProviderTransportResponse): ProviderTransport {
  return { request: async (request) => handler(request), close() {} };
}

const imageGenerationRequestFixture: ProviderImageGenerationRequest = {
  modelId: 'GigaChat-3-Ultra',
  system: [{ source: 'runtime', label: 'Runtime rules', text: 'Keep the request exact.' }],
  messages: [
    { role: 'assistant', text: 'Earlier text.' },
    { role: 'user', text: ' Нарисуй небольшой маяк.\n' },
  ],
};

function imageGenerationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'image-response-fixture',
    model: 'GigaChat-3-Ultra:3.0.1',
    finish_reason: 'stop',
    usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 12 } },
    messages: [{ role: 'assistant', message_id: 'image-message-fixture',
      tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13',
      content: [{ text: 'Готово.' }, { files: [{ id: 'image-file-fixture', mime: 'image/jpeg', target: 'image' }] }] }],
    ...overrides,
  };
}

function createImageTestProvider(
  handler: (request: ProviderTransportRequest) => Promise<ProviderTransportResponse> | ProviderTransportResponse,
  modelIds: string[] = ['GigaChat-3-Ultra'],
) {
  return createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-image-test-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-image-test-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: modelIds.map((id) => ({ id })) });
      return handler(request);
    }),
  });
}

function binaryImageResponse(
  chunks: readonly Uint8Array[],
  options: { statusCode?: number; contentType?: string; contentLength?: string; onCancel?: () => void } = {},
): ProviderTransportResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: {
      ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
      ...(options.contentLength === undefined ? {} : { 'content-length': options.contentLength }),
    },
    body: (async function* () { for (const chunk of chunks) yield chunk; }()),
    cancel: options.onCancel ?? (() => undefined),
  };
}

async function collectImageEvents(
  provider: ReturnType<typeof createImageTestProvider>,
  request: ProviderImageGenerationRequest = imageGenerationRequestFixture,
  signal = new AbortController().signal,
) {
  const events = [];
  for await (const event of provider.generateImage(request, signal)) events.push(event);
  return events;
}

test('image generation sends the exact Ultra builtin request and yields usage, descriptor, then completion', async () => {
  const requests: ProviderTransportRequest[] = [];
  const provider = createImageTestProvider((request) => {
    requests.push(request);
    return jsonResponse(200, imageGenerationPayload());
  });
  assert.equal((await provider.connect()).state, 'connected');

  const events = await collectImageEvents(provider);

  assert.deepEqual(events, [
    { type: 'usage', usage: {
      promptTokens: 100, completionTokens: 5, totalTokens: 105, precachedPromptTokens: 12,
      providerRequestId: 'image-response-fixture', providerModel: 'GigaChat-3-Ultra:3.0.1',
    } },
    { type: 'generated-image', image: {
      fileId: 'image-file-fixture', contentType: 'image/jpeg', assistantText: 'Готово.',
      functionsStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13', responseId: 'image-response-fixture',
    } },
    { type: 'completed' },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://api.giga.chat/v2/chat/completions');
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.headers.Accept, 'application/json');
  assert.equal(requests[0]?.headers['Content-Type'], 'application/json');
  assert.equal(requests[0]?.timeoutMs, 90_000);
  const body = JSON.parse(requests[0]?.body as string) as Record<string, unknown>;
  assert.deepEqual(body, {
    model: 'GigaChat-3-Ultra',
    messages: [
      { role: 'system', content: [{ text: '[Runtime rules]\nKeep the request exact.' }] },
      { role: 'assistant', content: [{ text: 'Earlier text.' }] },
      { role: 'user', content: [{ text: ' Нарисуй небольшой маяк.\n' }] },
    ],
    tools: [{ image_generate: {} }],
    tool_config: { mode: 'forced', tool_name: 'image_generate' },
    model_options: { parallel_tool_calls: false, max_tokens: 128 },
    stream: false,
  });
});

test('image generation allows empty per-part file arrays while requiring one safe image overall', async (t) => {
  const valid = imageGenerationPayload();
  const message = (valid.messages as Array<Record<string, unknown>>)[0]!;
  const content = message.content as unknown[];
  const filePart = content[1];
  const provider = createImageTestProvider(() => jsonResponse(200, imageGenerationPayload({
    messages: [{ ...message, content: [{ files: [] }, content[0], filePart, { files: [] }] }],
  })));
  assert.equal((await provider.connect()).state, 'connected');
  const events = await collectImageEvents(provider);
  assert.deepEqual(events.map((event) => event.type), ['usage', 'generated-image', 'completed']);
  assert.deepEqual(events[1], { type: 'generated-image', image: {
    fileId: 'image-file-fixture', contentType: 'image/jpeg', assistantText: 'Готово.',
    functionsStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13', responseId: 'image-response-fixture',
  } });

  await t.test('empty file arrays without an image remain a fixed missing-image protocol failure', async () => {
    const emptyOnly = createImageTestProvider(() => jsonResponse(200, imageGenerationPayload({
      messages: [{ role: 'assistant', content: [{ files: [] }, { files: [] }] }],
    })));
    assert.equal((await emptyOnly.connect()).state, 'connected');
    const rejected = await collectImageEvents(emptyOnly);
    assert.deepEqual(rejected[rejected.length - 1], {
      type: 'error', category: 'protocol', retryable: false, imageProtocolDiagnostic: 'missing-image',
    });
  });
});

test('image protocol diagnostics expose only fixed codes for malformed JSON and metadata', async (t) => {
  const privateMarker = 'private-image-response-detail';
  const malformedJsonProvider = createImageTestProvider(() => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: (async function* () { yield Buffer.from(`{"detail":"${privateMarker}"`, 'utf8'); }()),
    cancel() {},
  }));
  assert.equal((await malformedJsonProvider.connect()).state, 'connected');
  const malformedJson = await collectImageEvents(malformedJsonProvider);
  assert.deepEqual(malformedJson[malformedJson.length - 1], {
    type: 'error', category: 'protocol', retryable: false, imageProtocolDiagnostic: 'response-json',
  });
  assert.equal(JSON.stringify(malformedJson).includes(privateMarker), false);

  await t.test('ambiguous response content type maps to the fixed JSON diagnostic', async () => {
    const ambiguousHeaderProvider = createImageTestProvider(() => ({
      statusCode: 200,
      headers: { 'content-type': ['application/json', 'application/json'] },
      body: (async function* () { yield Buffer.from(JSON.stringify(imageGenerationPayload()), 'utf8'); }()),
      cancel() {},
    }));
    assert.equal((await ambiguousHeaderProvider.connect()).state, 'connected');
    const events = await collectImageEvents(ambiguousHeaderProvider);
    assert.deepEqual(events, [{
      type: 'error', category: 'protocol', retryable: false, imageProtocolDiagnostic: 'response-json',
    }]);
  });

  await t.test('unknown private metadata is not copied into the diagnostic', async () => {
    const metadataProvider = createImageTestProvider(() => jsonResponse(200, imageGenerationPayload({ private_metadata: privateMarker })));
    assert.equal((await metadataProvider.connect()).state, 'connected');
    const events = await collectImageEvents(metadataProvider);
    assert.deepEqual(events[events.length - 1], {
      type: 'error', category: 'protocol', retryable: false, imageProtocolDiagnostic: 'metadata',
    });
    assert.equal(JSON.stringify(events).includes(privateMarker), false);
  });
});

test('image request validation and connection/model gates stop before completion transport', async () => {
  let requests = 0;
  const provider = createImageTestProvider(() => {
    requests += 1;
    return jsonResponse(200, imageGenerationPayload());
  });
  const disconnected = await collectImageEvents(provider);
  assert.deepEqual(disconnected, [{ type: 'error', category: 'auth', retryable: false }]);

  assert.equal((await provider.connect()).state, 'connected');
  const wrongModel = { ...imageGenerationRequestFixture, modelId: 'GigaChat-3-Lite' as ProviderImageGenerationRequest['modelId'] };
  assert.deepEqual(await collectImageEvents(provider, wrongModel), [
    { type: 'error', category: 'model', retryable: false },
  ]);
  const blankPrompt: ProviderImageGenerationRequest = {
    ...imageGenerationRequestFixture,
    messages: [{ role: 'user', text: ' \n\t' }],
  };
  assert.deepEqual(await collectImageEvents(provider, blankPrompt), [
    { type: 'error', category: 'protocol', retryable: false },
  ]);
  const oversized: ProviderImageGenerationRequest = {
    ...imageGenerationRequestFixture,
    messages: [{ role: 'user', text: 'x'.repeat(2 * 1024 * 1024) }],
  };
  assert.deepEqual(await collectImageEvents(provider, oversized), [
    { type: 'error', category: 'context', retryable: false },
  ]);
  assert.equal(requests, 0);

  const longHistory: ProviderImageGenerationRequest = {
    modelId: 'GigaChat-3-Ultra', system: [],
    messages: Array.from({ length: 257 }, (_, index) => ({
      role: index === 256 ? 'user' as const : 'assistant' as const,
      text: `history-${index}`,
    })),
  };
  const longHistoryEvents = await collectImageEvents(provider, longHistory);
  assert.equal(longHistoryEvents[longHistoryEvents.length - 1]?.type, 'completed');
  assert.equal(requests, 1, 'history is bounded by the serialized 2 MiB request limit, not a new message-count cap');

  const unavailable = createImageTestProvider(() => {
    requests += 1;
    return jsonResponse(200, imageGenerationPayload());
  }, ['GigaChat-3-Lite']);
  assert.equal((await unavailable.connect()).state, 'connected');
  assert.deepEqual(await collectImageEvents(unavailable), [
    { type: 'error', category: 'model', retryable: false },
  ]);
  assert.equal(requests, 1);
});

test('image-only 402 does not exhaust text Ultra; text-side quota still blocks image preflight', async () => {
  let imageRequests = 0;
  const provider = createImageTestProvider((request) => {
    if (request.url === 'https://api.giga.chat/v2/chat/completions') {
      const body = JSON.parse(request.body as string) as { stream?: boolean };
      if (body.stream === false) {
        imageRequests += 1;
        return jsonResponse(402, { message: 'private quota detail' });
      }
      return v2TextResponse('GigaChat-3-Ultra');
    }
    throw new Error('unexpected-image-test-route');
  });
  assert.equal((await provider.connect()).state, 'connected');

  assert.deepEqual(await collectImageEvents(provider), [{ type: 'error', category: 'quota', retryable: false }]);
  assert.equal(provider.getModelRegistry().exhaustedModelIds, undefined);
  const textEvents: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'quota-text', role: 'user', text: 'synthetic text request', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) textEvents.push(event);
  assert.deepEqual(textEvents, [{ type: 'activity', activity: 'receiving' }, { type: 'completed' }]);
  assert.equal(imageRequests, 1);

  let quotaImageRequests = 0;
  const quotaProvider = createImageTestProvider((request) => {
    if (request.url === 'https://api.giga.chat/v2/chat/completions') {
      const body = JSON.parse(request.body as string) as { stream?: boolean };
      if (body.stream === false) {
        quotaImageRequests += 1;
        return jsonResponse(200, imageGenerationPayload());
      }
      return jsonResponse(402, { message: 'private quota detail' });
    }
    throw new Error('unexpected-image-test-route');
  });
  assert.equal((await quotaProvider.connect()).state, 'connected');
  const textError: ProviderEvent[] = [];
  for await (const event of quotaProvider.stream({
    system: [], messages: [{ id: 'quota-text-2', role: 'user', text: 'synthetic text request', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) textError.push(event);
  assert.deepEqual(textError, [{ type: 'error', category: 'quota', retryable: false }]);
  assert.deepEqual(await collectImageEvents(quotaProvider), [{ type: 'error', category: 'quota', retryable: false }]);
  assert.equal(quotaImageRequests, 0, 'text exhaustion blocks a later image request before another completion call');
});

test('image responses keep known usage and an owned descriptor on tool failure or invalid accounting', async (t) => {
  const baseMessage = imageGenerationPayload().messages as Array<Record<string, unknown>>;
  const message = baseMessage[0]!;
  const filePart = (message.content as unknown[])[1];
  const cases: Array<{ label: string; payload: Record<string, unknown>; tail: Array<Record<string, unknown>> }> = [
    {
      label: 'valid alternate builtin execution name',
      payload: imageGenerationPayload({ messages: [{ ...message, content: [filePart, {
        tool_execution: { name: 'image_generation_worker', status: 'success', seconds_left: 3, censored: false },
      }] }] }),
      tail: [{ type: 'completed' }],
    },
    {
      label: 'provider reports a failed builtin execution',
      payload: imageGenerationPayload({ messages: [{ ...message, content: [filePart, {
        tool_execution: { name: 'image_generation_worker', status: 'fail', seconds_left: 3, censored: false },
      }] }] }),
      tail: [{ type: 'error', category: 'tool', retryable: false }],
    },
    {
      label: 'provider marks output censored',
      payload: imageGenerationPayload({ messages: [{ ...message, content: [filePart, {
        tool_execution: { name: 'image_generation_worker', status: 'success', censored: true },
      }] }] }),
      tail: [{ type: 'error', category: 'tool', retryable: false }],
    },
    {
      label: 'invalid usage preserves its valid numeric fields and image identity',
      payload: imageGenerationPayload({ usage: {
        input_tokens: -1, output_tokens: 5, total_tokens: 105,
        input_tokens_details: { cached_tokens: 12, prompt_tokens: 88 },
      } }),
      tail: [{ type: 'generated-image', image: {
        fileId: 'image-file-fixture', contentType: 'image/jpeg', assistantText: 'Готово.',
        functionsStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13', responseId: 'image-response-fixture',
      } }, { type: 'error', category: 'protocol', retryable: false, imageProtocolDiagnostic: 'usage' }],
    },
  ];

  await t.test('valid alternate builtin execution name', async () => {
    const provider = createImageTestProvider(() => jsonResponse(200, cases[0]!.payload));
    assert.equal((await provider.connect()).state, 'connected');
    const events = await collectImageEvents(provider);
    assert.equal(events[1]?.type, 'generated-image');
    assert.deepEqual(events.slice(-1), [{ type: 'completed' }]);
  });
  for (const scenario of cases.slice(1)) {
    await t.test(scenario.label, async () => {
      const provider = createImageTestProvider(() => jsonResponse(200, scenario.payload));
      assert.equal((await provider.connect()).state, 'connected');
      const events = await collectImageEvents(provider);
      assert.equal(events[0]?.type, 'usage');
      if (scenario.label === 'invalid usage preserves its valid numeric fields and image identity') {
        assert.deepEqual(events[0], { type: 'usage', usage: {
          promptTokens: null, completionTokens: 5, totalTokens: 105, precachedPromptTokens: 12,
          providerRequestId: 'image-response-fixture', providerModel: 'GigaChat-3-Ultra:3.0.1',
        } });
        assert.deepEqual(events.slice(1), scenario.tail);
      } else {
        assert.equal(events[1]?.type, 'generated-image');
        assert.deepEqual(events.slice(-1), scenario.tail);
      }
      assert.equal(events.some((event) => event.type === 'completed'), false);
    });
  }
});

test('image response rejects malformed roles, function calls, file rows, state, finish, and tool metadata safely', async (t) => {
  const valid = imageGenerationPayload();
  const goodMessage = (valid.messages as Array<Record<string, unknown>>)[0]!;
  const goodContent = goodMessage.content as unknown[];
  const filePart = goodContent[1];
  const baseFile = { id: 'image-file-fixture', mime: 'image/jpeg', target: 'image' };
  const badToolNameMessage = (name: unknown) => ({
    role: 'assistant', content: [{ files: [baseFile] }, { tool_execution: { name, status: 'success' } }],
  });
  const cases: Array<{ label: string; payload: Record<string, unknown>; diagnostic: ImageProtocolDiagnostic }> = [
    { label: 'wrong model', payload: imageGenerationPayload({ model: 'GigaChat-3-Lite' }), diagnostic: 'metadata' },
    { label: 'wrong role', payload: imageGenerationPayload({ messages: [{ ...goodMessage, role: 'user' }] }), diagnostic: 'message' },
    { label: 'invalid state', payload: imageGenerationPayload({ messages: [{ ...goodMessage, tool_state_id: 'bad-state' }] }), diagnostic: 'message' },
    { label: 'non-stop finish', payload: imageGenerationPayload({ finish_reason: 'function_call' }), diagnostic: 'finish-reason' },
    { label: 'more than sixteen content parts', payload: imageGenerationPayload({
      messages: [{ role: 'assistant', content: Array.from({ length: 17 }, () => ({ text: 'x' })) }],
    }), diagnostic: 'content' },
    { label: 'ordinary text has no generated file', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ text: 'image URL: https://example.invalid/x.png' }] }] }), diagnostic: 'missing-image' },
    { label: 'custom function call is rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ function_call: { name: 'read', arguments: { path: 'x' } } }] }] }), diagnostic: 'content' },
    { label: 'multiple files across parts are rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [filePart, filePart] }] }), diagnostic: 'file' },
    { label: 'multiple files in one part are rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ files: [baseFile, { ...baseFile, id: 'another-image-file' }] }] }] }), diagnostic: 'file' },
    { label: 'non-array file rows are rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ files: baseFile }] }] }), diagnostic: 'file' },
    { label: 'wrong file MIME is rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ files: [{ ...baseFile, mime: 'text/plain' }] }] }] }), diagnostic: 'file' },
    { label: 'wrong file target is rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ files: [{ ...baseFile, target: 'document' }] }] }] }), diagnostic: 'file' },
    { label: 'unsafe file ID is rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ files: [{ ...baseFile, id: '../private' }] }] }] }), diagnostic: 'file' },
    { label: 'non-text content is rejected', payload: imageGenerationPayload({ messages: [{ role: 'assistant', content: [{ text: 42 }, { files: [baseFile] }] }] }), diagnostic: 'text' },
    { label: 'control-bearing tool name is rejected', payload: imageGenerationPayload({ messages: [badToolNameMessage('image\nworker')] }), diagnostic: 'tool-execution' },
    { label: 'non-string tool name is rejected', payload: imageGenerationPayload({ messages: [badToolNameMessage(42)] }), diagnostic: 'tool-execution' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
      const provider = createImageTestProvider(() => jsonResponse(200, scenario.payload));
      assert.equal((await provider.connect()).state, 'connected');
      const events = await collectImageEvents(provider);
      assert.equal(events[0]?.type, 'usage', 'safe known usage is reported before image-shape rejection');
      assert.equal(events.some((event) => event.type === 'completed'), false);
      assert.deepEqual(events[events.length - 1], {
        type: 'error', category: 'protocol', retryable: false, imageProtocolDiagnostic: scenario.diagnostic,
      });
    });
  }

  await t.test('optional tool name may be absent when the image file is valid', async () => {
    const provider = createImageTestProvider(() => jsonResponse(200, imageGenerationPayload({
      messages: [badToolNameMessage(undefined)],
    })));
    assert.equal((await provider.connect()).state, 'connected');
    const events = await collectImageEvents(provider);
    assert.equal(events[1]?.type, 'generated-image');
    assert.deepEqual(events[events.length - 1], { type: 'completed' });
  });

  await t.test('state and response identity remain absent when provider omitted them', async () => {
    const withoutId = { ...valid };
    delete withoutId.id;
    const message = { ...goodMessage };
    delete message.message_id;
    delete message.tool_state_id;
    const provider = createImageTestProvider(() => jsonResponse(200, {
      ...withoutId,
      messages: [{ ...message, content: goodContent }],
      usage: { output_tokens: 5 },
    }));
    assert.equal((await provider.connect()).state, 'connected');
    const events = await collectImageEvents(provider);
    assert.deepEqual(events, [
      { type: 'usage', usage: {
        promptTokens: null, completionTokens: 5, totalTokens: null, precachedPromptTokens: null,
        providerModel: 'GigaChat-3-Ultra:3.0.1',
      } },
      { type: 'generated-image', image: { fileId: 'image-file-fixture', contentType: 'image/jpeg', assistantText: 'Готово.' } },
      { type: 'completed' },
    ]);
  });
});

test('image generation retries one completion 401, maps 429/network, and never repeats generation', async (t) => {
  await t.test('one 401 refresh', async () => {
    let oauthRequests = 0;
    let completionRequests = 0;
    const provider = createGigaChatProvider({
      loadAuthorizationKey: async () => 'synthetic-image-refresh-key', now: () => FIXED_NOW,
      transport: fakeTransport((request) => {
        if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token(`synthetic-image-token-${++oauthRequests}`));
        if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
        completionRequests += 1;
        return completionRequests === 1 ? jsonResponse(401, { error: 'private auth detail' }) : jsonResponse(200, imageGenerationPayload());
      }),
    });
    assert.equal((await provider.connect()).state, 'connected');
    const events = await collectImageEvents(provider);
    assert.equal(events[events.length - 1]?.type, 'completed');
    assert.equal(oauthRequests, 2);
    assert.equal(completionRequests, 2);
  });

  for (const [label, response, expected] of [
    ['429', jsonResponse(429, { error: 'private rate detail' }), { type: 'error', category: 'rate-limit', retryable: true }],
  ] as const) {
    await t.test(label, async () => {
      let completions = 0;
      const provider = createImageTestProvider(() => { completions += 1; return response; });
      assert.equal((await provider.connect()).state, 'connected');
      assert.deepEqual(await collectImageEvents(provider), [expected]);
      assert.equal(completions, 1);
    });
  }
  await t.test('network failure', async () => {
    let completions = 0;
    const provider = createImageTestProvider(() => {
      completions += 1;
      throw Object.assign(new Error('private transport message'), { code: 'ECONNRESET' });
    });
    assert.equal((await provider.connect()).state, 'connected');
    assert.deepEqual(await collectImageEvents(provider), [{ type: 'error', category: 'network', retryable: true }]);
    assert.equal(completions, 1);
  });
});

test('binary image download preserves exact chunked bytes and rejects invalid type, length, content, and size', async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=', 'base64');
  const requests: ProviderTransportRequest[] = [];
  let response: ProviderTransportResponse = binaryImageResponse([png.subarray(0, 19), png.subarray(19)], {
    contentType: 'application/octet-stream', contentLength: String(png.byteLength),
  });
  const provider = createImageTestProvider((request) => { requests.push(request); return response; });
  assert.equal((await provider.connect()).state, 'connected');
  const bytes = await provider.downloadGeneratedImage('image-file-fixture', 'image/png', new AbortController().signal);
  assert.deepEqual(bytes, png);
  assert.equal(requests[0]?.url, `${GIGACHAT_API_BASE_URL}/files/image-file-fixture/content`);
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.headers.Accept, 'application/jpg');

  const jpegSignature = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  response = binaryImageResponse([jpegSignature], { contentType: 'image/jpeg', contentLength: '4' });
  assert.deepEqual(await provider.downloadGeneratedImage('jpeg-fixture', 'image/jpeg', new AbortController().signal), jpegSignature);
  assert.equal(requests[1]?.url, `${GIGACHAT_API_BASE_URL}/files/jpeg-fixture/content`);

  await t.test('invalid ID/MIME blocked before transport', async () => {
    let calls = 0;
    const guarded = createImageTestProvider(() => { calls += 1; return binaryImageResponse([png]); });
    assert.equal((await guarded.connect()).state, 'connected');
    await assert.rejects(guarded.downloadGeneratedImage('../bad', 'image/png', new AbortController().signal),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
    await assert.rejects(guarded.downloadGeneratedImage('safe', 'image/gif' as 'image/png', new AbortController().signal),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
    assert.equal(calls, 0);
  });
  for (const [label, responseValue] of [
    ['conflicting MIME', binaryImageResponse([png], { contentType: 'image/jpeg' })],
    ['JSON body', binaryImageResponse([Buffer.from('{"error":"private"}')], { contentType: 'application/json' })],
    ['empty body', binaryImageResponse([], { contentType: 'image/png', contentLength: '0' })],
    ['length mismatch', binaryImageResponse([png], { contentType: 'image/png', contentLength: '1' })],
    ['malformed length', binaryImageResponse([png], { contentType: 'image/png', contentLength: '1e2' })],
    ['non-image bytes', binaryImageResponse([Buffer.from('<html>bad</html>')], { contentType: 'image/png' })],
    ['oversized declared length', binaryImageResponse([], { contentType: 'image/png', contentLength: '15000001' })],
    ['oversized streamed body', binaryImageResponse([Buffer.alloc(15_000_001)], { contentType: 'application/octet-stream' })],
  ] as const) {
    await t.test(label, async () => {
      let cancelled = 0;
      responseValue.cancel = () => { cancelled += 1; };
      response = responseValue;
      await assert.rejects(provider.downloadGeneratedImage('image-file-fixture', 'image/png', new AbortController().signal),
        (error: unknown) => error instanceof GigaChatProviderError
          && (error.category === 'protocol' || error.category === 'context'));
      assert.ok(cancelled > 0);
    });
  }
  await t.test('non-success status maps safely and closes response', async () => {
    let cancelled = 0;
    response = binaryImageResponse([], { statusCode: 404, onCancel: () => { cancelled += 1; } });
    await assert.rejects(provider.downloadGeneratedImage('image-file-fixture', 'image/png', new AbortController().signal),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'model');
    assert.ok(cancelled > 0);
  });
});

test('generation and binary download cancellation close their response without a completion', async (t) => {
  await t.test('abort while reading generation JSON', async () => {
    const pending = deferred<Uint8Array>();
    let bodyStarted = false;
    let cancelled = 0;
    const provider = createImageTestProvider(() => ({
      statusCode: 200, headers: { 'content-type': 'application/json' },
      body: (async function* () { bodyStarted = true; yield await pending.promise; }()),
      cancel() { cancelled += 1; },
    }));
    assert.equal((await provider.connect()).state, 'connected');
    const controller = new AbortController();
    const collect = collectImageEvents(provider, imageGenerationRequestFixture, controller.signal);
    await waitFor(() => bodyStarted);
    controller.abort();
    const events = await collect;
    assert.deepEqual(events, [{ type: 'error', category: 'cancel', retryable: false }]);
    assert.ok(cancelled > 0);
    pending.resolve(Buffer.from(JSON.stringify(imageGenerationPayload())));
  });

  await t.test('abort while reading binary image', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=', 'base64');
    const pending = deferred<Uint8Array>();
    let bodyStarted = false;
    let cancelled = 0;
    const provider = createImageTestProvider(() => ({
      statusCode: 200, headers: { 'content-type': 'image/png' },
      body: (async function* () { bodyStarted = true; yield await pending.promise; }()),
      cancel() { cancelled += 1; },
    }));
    assert.equal((await provider.connect()).state, 'connected');
    const controller = new AbortController();
    const download = provider.downloadGeneratedImage('image-file-fixture', 'image/png', controller.signal);
    await waitFor(() => bodyStarted);
    controller.abort();
    await assert.rejects(download, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel');
    assert.ok(cancelled > 0);
    pending.resolve(png);
  });

  await t.test('early iterator return cancels the image response and never emits descriptor/completion', async () => {
    let cancelled = 0;
    const provider = createImageTestProvider(() => {
      const response = jsonResponse(200, imageGenerationPayload());
      return { ...response, cancel() { cancelled += 1; } };
    });
    assert.equal((await provider.connect()).state, 'connected');
    const iterator = provider.generateImage(imageGenerationRequestFixture, new AbortController().signal)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'usage');
    await iterator.return?.();
    assert.ok(cancelled > 0);
  });

  await t.test('saved-key invalidation cancels a pending generation and closes a late response', async () => {
    const pendingResponse = deferred<ProviderTransportResponse>();
    let requestStarted = false;
    let cancelled = 0;
    const provider = createImageTestProvider(() => {
      requestStarted = true;
      return pendingResponse.promise;
    });
    assert.equal((await provider.connect()).state, 'connected');
    const eventsPromise = collectImageEvents(provider);
    await waitFor(() => requestStarted);
    provider.invalidateSavedKey();
    assert.deepEqual(await eventsPromise, [{ type: 'error', category: 'cancel', retryable: false }]);
    pendingResponse.resolve({
      statusCode: 200, headers: { 'content-type': 'application/json' },
      body: (async function* () { yield Buffer.from(JSON.stringify(imageGenerationPayload())); }()),
      cancel() { cancelled += 1; },
    });
    await delay(0);
    assert.ok(cancelled > 0, 'a late response is closed instead of being parsed or emitted');
  });
});

function token(accessToken: string, expiresAt = FIXED_NOW + 30 * 60 * 1000): unknown {
  return { access_token: accessToken, expires_at: expiresAt };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await delay(0);
    }
    throw new Error('fixture timed out');
  })();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

test('connect uses OAuth Basic/RqUID/scope, then discovers models without exposing credentials', async () => {
  const requests: ProviderTransportRequest[] = [];
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-authorization-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      requests.push(request);
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-access-token'));
      return jsonResponse(200, { data: [{ id: 'GigaChat-test-model' }] });
    }),
  });

  const status = await provider.connect();

  assert.deepEqual(status, { state: 'connected', errorCategory: null });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.headers.Authorization, 'Basic synthetic-authorization-key');
  assert.equal(requests[0]?.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(requests[0]?.headers.RqUID ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(requests[0]?.body, 'scope=GIGACHAT_API_PERS');
  assert.equal(requests[1]?.url, `${GIGACHAT_API_BASE_URL}/models`);
  assert.equal(requests[1]?.headers.Authorization, 'Bearer synthetic-access-token');
  assert.doesNotMatch(JSON.stringify(status), /synthetic-authorization-key|synthetic-access-token/);
});

test('reads bounded balance through the connected authenticated transport and hides unknown labels', async () => {
  const requests: ProviderTransportRequest[] = [];
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-authorization-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      requests.push(request);
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-access-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      return jsonResponse(200, { balance: [
        { usage: 'GigaChat-Ultra', value: 49_950_331 },
        { usage: 'GigaChat-Max', value: 24_994_339 },
        { usage: 'GigaChat-2-Pro', value: 39_992_622 },
        { usage: 'GigaChat-2', value: 249_993_370 },
        { usage: 'Embeddings', value: 123 },
        { usage: 'private-unknown-label', value: 456 },
      ] });
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');

  const result = await provider.getBalance();

  assert.deepEqual(result, {
    observedAt: new Date(FIXED_NOW).toISOString(),
    unknownUsageCount: 2,
    families: [
      { family: 'ultra', state: 'known', value: 49_950_331 },
      { family: 'max', state: 'known', value: 24_994_339 },
      { family: 'pro', state: 'known', value: 39_992_622 },
      { family: 'lite', state: 'known', value: 249_993_370 },
    ],
  });
  assert.equal(requests.length, 3, 'the connected access token is reused; this call adds one GET only');
  assert.equal(requests[2]?.url, `${GIGACHAT_API_BASE_URL}/balance`);
  assert.equal(requests[2]?.method, 'GET');
  assert.equal(requests[2]?.headers.Authorization, 'Bearer synthetic-access-token');
  assert.doesNotMatch(JSON.stringify(result), /Embeddings|private-unknown-label|synthetic-access-token/);
});

test('balance duplicates remain ambiguous, missing families stay missing, and invalid data fails closed', async () => {
  let responseBody: unknown = { balance: [
    { usage: 'GigaChat-3-Ultra', value: 0 },
    { usage: 'GigaChat-Ultra', value: 2 },
    { usage: 'GigaChat-Pro', value: 3 },
    { usage: 'GigaChat', value: 4 },
  ] };
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      return jsonResponse(200, responseBody);
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');

  const duplicate = await provider.getBalance();
  assert.deepEqual(duplicate.families, [
    { family: 'ultra', state: 'ambiguous' },
    { family: 'max', state: 'missing' },
    { family: 'pro', state: 'known', value: 3 },
    { family: 'lite', state: 'known', value: 4 },
  ]);

  for (const invalid of [
    { balance: [{ usage: 'GigaChat-Ultra', value: -1 }] },
    { balance: [{ usage: 'GigaChat-Ultra', value: 1.5 }] },
    { balance: [{ usage: 'GigaChat-Ultra\n', value: 1 }] },
    { balance: new Array(129).fill({ usage: 'GigaChat-Ultra', value: 1 }) },
  ]) {
    responseBody = invalid;
    await assert.rejects(provider.getBalance(),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  }
});

test('balance retries one 401 with the existing OAuth refresh and surfaces forbidden status safely', async () => {
  let oauthRequests = 0;
  let balanceRequests = 0;
  let forbidden = false;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthRequests += 1;
        return jsonResponse(200, token(`synthetic-token-${oauthRequests}`));
      }
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      balanceRequests += 1;
      if (forbidden) return jsonResponse(403, { private: 'response body must not escape' });
      if (balanceRequests === 1) return jsonResponse(401, { private: 'expired token' });
      return jsonResponse(200, { balance: [{ usage: 'GigaChat-Ultra', value: 5 }] });
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const result = await provider.getBalance();
  assert.equal(result.families[0]?.state, 'known');
  assert.equal(oauthRequests, 2, 'one existing refresh follows the first 401');
  assert.equal(balanceRequests, 2);

  forbidden = true;
  await assert.rejects(provider.getBalance(), (error: unknown) => error instanceof GigaChatProviderError
    && error.category === 'auth' && error.httpStatus === 403 && !error.message.includes('response body'));
  assert.equal(balanceRequests, 3);
  assert.equal(oauthRequests, 2, '403 does not start another OAuth flow');
});

test('saved-key invalidation cancels a pending balance response and rejects its late body', async () => {
  const pending = deferred<ProviderTransportResponse>();
  let balanceStarted = false;
  let cancelled = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      balanceStarted = true;
      return pending.promise;
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');

  const request = provider.getBalance();
  await waitFor(() => balanceStarted);
  provider.invalidateSavedKey();
  await assert.rejects(request,
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel');
  pending.resolve({
    ...jsonResponse(200, { balance: [{ usage: 'GigaChat-Ultra', value: 1 }] }),
    cancel: () => { cancelled += 1; },
  });
  await delay(0);
  assert.equal(cancelled, 1);
  assert.equal(provider.getConnectionStatus().state, 'not-configured');
});

test('uploads binary bytes as multipart without UTF-8 conversion and validates the returned file reference', async () => {
  const requests: ProviderTransportRequest[] = [];
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      requests.push(request);
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
      return jsonResponse(200, {
        object: 'file', id: 'remote-fixture-id', filename: 'gcagent_fixture.pdf', bytes: 8, purpose: 'general',
      });
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');

  const upload = provider as typeof provider & {
    uploadFile(input: { filename: string; contentType: string; bytes: Uint8Array }, signal: AbortSignal): Promise<{ id: string; filename: string; bytes: number }>;
  };
  const fileBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xc3]);
  const result = await upload.uploadFile({ filename: 'gcagent_fixture.pdf', contentType: 'application/pdf', bytes: fileBytes }, new AbortController().signal);

  assert.deepEqual(result, { id: 'remote-fixture-id', filename: 'gcagent_fixture.pdf', bytes: fileBytes.byteLength, purpose: 'general' });
  const request = requests[requests.length - 1]!;
  assert.equal(request.url, `${GIGACHAT_API_BASE_URL}/files`);
  assert.equal(request.method, 'POST');
  assert.match(request.headers['Content-Type'] ?? '', /^multipart\/form-data; boundary=/);
  const body = Buffer.from(request.body as Uint8Array);
  assert.ok(body.includes(Buffer.from('purpose')));
  assert.ok(body.includes(Buffer.from('general')));
  assert.ok(body.includes(Buffer.from('gcagent_fixture.pdf')));
  assert.ok(body.includes(Buffer.from(fileBytes)), 'all bytes, including invalid UTF-8 bytes, survive the multipart encoder');
});

test('rejects an upload HTTP 200 that does not identify the requested binary', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
      return jsonResponse(200, { object: 'file', purpose: 'general', filename: 'other.txt', bytes: 4 });
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const upload = provider as typeof provider & {
    uploadFile(input: { filename: string; contentType: string; bytes: Uint8Array }, signal: AbortSignal): Promise<unknown>;
  };
  await assert.rejects(upload.uploadFile({ filename: 'gcagent_expected.txt', contentType: 'text/plain', bytes: Buffer.from('data') }, new AbortController().signal),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
});

test('lists only general-purpose files and deletes an explicit provider file ID', async () => {
  const requests: ProviderTransportRequest[] = [];
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      requests.push(request);
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
      if (request.url === `${GIGACHAT_API_BASE_URL}/files`) return jsonResponse(200, {
        object: 'list', has_more: false, data: [
          { object: 'file', id: 'owned-fixture-id', filename: 'gcagent_fixture.txt', bytes: 12, purpose: 'general' },
          { object: 'file', id: 'unrelated-purpose-id', filename: 'other.png', bytes: 30, purpose: 'generated' },
        ],
      });
      return jsonResponse(200, { id: 'owned-fixture-id', deleted: true });
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');

  const signal = new AbortController().signal;
  assert.deepEqual(await provider.listFiles(signal), [
    { id: 'owned-fixture-id', filename: 'gcagent_fixture.txt', bytes: 12, purpose: 'general' },
  ]);
  await provider.deleteFile('owned-fixture-id', signal);
  assert.equal(requests[requests.length - 2]?.url, `${GIGACHAT_API_BASE_URL}/files`);
  const deletion = requests[requests.length - 1]!;
  assert.equal(deletion.method, 'POST');
  assert.equal(deletion.url, `${GIGACHAT_API_BASE_URL}/files/owned-fixture-id/delete`);
  assert.equal(deletion.headers.Authorization, 'Bearer synthetic-token');
});

test('keeps a provider file deletion unconfirmed unless the bounded receipt matches the requested ID', async () => {
  const receipts: unknown[] = [
    { id: 'different-file-id', deleted: true },
    { id: 'owned-fixture-id', deleted: false },
    { id: 'owned-fixture-id', deleted: 'true' },
  ];
  for (const receipt of receipts) {
    const provider = createGigaChatProvider({
      loadAuthorizationKey: async () => 'synthetic-key',
      now: () => FIXED_NOW,
      transport: fakeTransport((request) => {
        if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
        if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
        return jsonResponse(200, receipt);
      }),
    });
    assert.equal((await provider.connect()).state, 'connected');
    await assert.rejects(provider.deleteFile('owned-fixture-id', new AbortController().signal),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  }
});

test('rejects remote file IDs that are not one safe URL path segment', async () => {
  let fileRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
      fileRequests += 1;
      return jsonResponse(200, { deleted: true });
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');

  for (const id of ['.', '..', 'folder/file', 'file?query', 'file#fragment', 'file\u0000id', 'file\n']) {
    await assert.rejects(provider.deleteFile(id, new AbortController().signal),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  }
  assert.equal(fileRequests, 0);
});

test('cancels a response that becomes stale before authenticated response handling', async () => {
  let responseCancelled = 0;
  const response: ProviderTransportResponse = {
    ...jsonResponse(200, {
      object: 'file', id: 'late-file-id', filename: 'gcagent_late.txt', bytes: 4, purpose: 'general',
    }),
    cancel: () => { responseCancelled += 1; },
  };
  const transport: ProviderTransport = {
    request: (request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return Promise.resolve(jsonResponse(200, token('synthetic-token')));
      if (request.url.endsWith('/models')) return Promise.resolve(jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] }));
      return {
        then: (onFulfilled?: ((value: ProviderTransportResponse) => unknown) | null) => {
          const result = onFulfilled?.(response);
          provider.disconnect();
          return Promise.resolve(result);
        },
      } as unknown as Promise<ProviderTransportResponse>;
    },
    close() {},
  };
  const provider = createGigaChatProvider({ loadAuthorizationKey: async () => 'synthetic-key', now: () => FIXED_NOW, transport });
  assert.equal((await provider.connect()).state, 'connected');

  await assert.rejects(provider.uploadFile({
    filename: 'gcagent_late.txt', contentType: 'text/plain', bytes: Buffer.from('data'),
  }, new AbortController().signal), (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel');
  assert.equal(responseCancelled, 1);
});

test('reports V2 built-in file-reading progress as activity instead of assistant text', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
      return eventStreamResponse([
        v2Frame('response.tool.in_progress', {
          model: 'GigaChat-3-Pro',
          messages: [{ role: 'assistant', content: [{ tool_execution: { name: 'get_file_content', status: 'in_progress', seconds_left: 2 } }] }],
        }),
        v2Frame('response.message.delta', { model: 'GigaChat-3-Pro', messages: [{ role: 'assistant', content: [{ text: 'Документ изучен.' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Pro', finish_reason: 'stop' }),
      ]);
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'user-file', role: 'user', text: 'Прочитай файл', createdAt: '2026-10-12T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Pro',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events.find((event) => event.type === 'activity' && event.activity === 'function-progress'), {
    type: 'activity', activity: 'function-progress', functionName: 'get_file_content', detail: 'Осталось 2 с.',
  });
  assert.deepEqual(events.filter((event) => event.type === 'text-delta').map((event) => event.text), ['Документ изучен.']);
});

test('passes V2 builtin progress through Runtime without dispatching local tools', async () => {
  const cases = [
    { name: 'get_file_content', expected: { activity: 'function-progress', functionName: 'get_file_content', detail: 'Осталось 2 с.' } },
    { name: 'web_search', expected: { activity: 'tool-started', functionName: null, detail: null } },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const provider = createGigaChatProvider({
      loadAuthorizationKey: async () => 'synthetic-key',
      now: () => FIXED_NOW,
      transport: fakeTransport((request) => {
        if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token(`synthetic-token-${index}`));
        if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Pro' }] });
        return eventStreamResponse([
          v2Frame('response.tool.in_progress', {
            model: 'GigaChat-3-Pro',
            messages: [{ role: 'assistant', content: [{ tool_execution: { name: item.name, status: 'in_progress', seconds_left: 2 } }] }],
          }),
          v2Frame('response.message.delta', { model: 'GigaChat-3-Pro', messages: [{ role: 'assistant', content: [{ text: 'Ответ без запуска локальных инструментов.' }] }] }),
          v2Frame('response.message.done', { model: 'GigaChat-3-Pro', finish_reason: 'stop' }),
        ]);
      }),
    });
    assert.equal((await provider.connect()).state, 'connected');

    let localReadCalls = 0;
    const savedAnswers: string[] = [];
    const runtime = createTurnRuntime({
      provider,
      tools: { read: async () => { localReadCalls += 1; } } as unknown as LocalTools,
      prepareTurn: async (turn) => ({
        system: [], messages: structuredClone(turn.messages), modelId: turn.modelId, permissionProfile: turn.permissionProfile,
      }),
      consumeTurn: async () => undefined,
      releaseTurn: () => undefined,
      appendAssistant: async (_turn, text) => { savedAnswers.push(text); },
      recordUsageReceipt: async () => undefined,
    });
    const chatId = `builtin-progress-${index}`;
    const turn: AcceptedTurnInput = {
      turnId: `builtin-progress-turn-${index}`, chatId, projectId: null, projectWorkingFolder: null,
      messageId: `builtin-progress-user-${index}`, assistantMessageId: `builtin-progress-assistant-${index}`,
      historyBoundary: 1,
      messages: [{ id: `builtin-progress-user-${index}`, role: 'user', text: 'Прочитай вложение', createdAt: '2026-10-12T00:00:00.000Z' }],
      permissionProfile: 'ask', modelId: 'GigaChat-3-Pro', skillId: null,
      reservation: { permissionProfileRevision: null, skillRevision: null },
    };
    assert.ok(runtime.enqueue(turn));
    await runtime.whenIdle();

    const completedTurn = runtime.list(chatId)[0];
    assert.equal(completedTurn?.status, 'completed');
    assert.deepEqual(savedAnswers, ['Ответ без запуска локальных инструментов.']);
    assert.equal(localReadCalls, 0);
    const activity = completedTurn?.activity.find((entry) => entry.kind === 'provider'
      && (entry.activity === 'function-progress' || entry.activity === 'tool-started'));
    assert.deepEqual(activity?.kind === 'provider'
      ? { activity: activity.activity, functionName: activity.functionName ?? null, detail: activity.detail ?? null }
      : null, item.expected);
  }
});

test('discovers future model IDs without inventing model capabilities', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : jsonResponse(200, { data: [{ id: 'vendor/model.v4:preview', context_length: 999_999, functions: true, vision: true }] })),
  });

  assert.equal((await provider.connect()).state, 'connected');
  assert.deepEqual(provider.getModelRegistry(), {
    state: 'ready', modelIds: ['vendor/model.v4:preview'], errorCategory: null,
  });
  assert.deepEqual(Object.keys(provider.getModelRegistry()).sort(), ['errorCategory', 'modelIds', 'state']);
});

test('keeps raw discovery complete but blocks legacy and embedding IDs from chat completion', async () => {
  let completionRequests = 0;
  const rawIds = [
    'GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro', 'GigaChat-3-Lightning',
    'GigaChat-2-Pro', 'GigaChat-2', 'GigaEmbeddings', 'GigaEmbeddings-3', 'vendor/model-v4',
  ];
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: rawIds.map((id) => ({ id })) });
      completionRequests += 1;
      return v2TextResponse('GigaChat-3-Ultra');
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  assert.deepEqual(provider.getModelRegistry().modelIds, rawIds, 'raw /models results remain available for diagnostics');

  for (const modelId of ['GigaChat-2-Pro', 'GigaChat-2', 'GigaEmbeddings', 'GigaEmbeddings-3', 'vendor/model-v4']) {
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      system: [], messages: [{ id: `user-${modelId}`, role: 'user', text: 'Тест', createdAt: '2026-10-09T00:00:00.000Z' }],
      permissionProfile: 'ask', modelId,
    }, new AbortController().signal)) events.push(event);
    assert.deepEqual(events, [{ type: 'error', category: 'model', retryable: false }], `${modelId} must not enter chat completion`);
  }
  assert.equal(completionRequests, 0);

  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'ultra-user', role: 'user', text: 'Тест', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ type: 'activity', activity: 'receiving' }, { type: 'completed' }]);
  assert.equal(completionRequests, 1);
});

test('a 402 exhausts only its current model, survives discovery refresh, and clears on reconnect', async () => {
  const rawIds = ['GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro', 'vendor/model-v4'];
  const requests: ProviderTransportRequest[] = [];
  let completionRequests = 0;
  let discoveryRequests = 0;
  let failWithQuota = true;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      requests.push(request);
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) {
        discoveryRequests += 1;
        return jsonResponse(200, { data: rawIds.map((id) => ({ id })) });
      }
      completionRequests += 1;
      return failWithQuota
        ? jsonResponse(402, { message: 'sensitive provider detail must not escape' })
        : v2TextResponse('GigaChat-3-Ultra');
    }),
  });

  assert.equal((await provider.connect()).state, 'connected');
  const request: ProviderTurnRequest = {
    system: [],
    messages: [{ id: 'quota-user', role: 'user', text: 'synthetic quota check', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask',
    modelId: 'GigaChat-3-Ultra',
  };
  const firstEvents: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) firstEvents.push(event);
  assert.deepEqual(firstEvents, [{ type: 'error', category: 'quota', retryable: false }]);

  const exhaustedSnapshot = provider.getModelRegistry();
  assert.deepEqual(exhaustedSnapshot.modelIds, rawIds, 'quota does not rewrite raw discovery');
  assert.deepEqual(exhaustedSnapshot.exhaustedModelIds, ['GigaChat-3-Ultra']);
  exhaustedSnapshot.exhaustedModelIds?.push('GigaChat-2-Max');
  assert.deepEqual(provider.getModelRegistry().exhaustedModelIds, ['GigaChat-3-Ultra'], 'snapshot arrays are defensive copies');

  await provider.listModels();
  assert.deepEqual(provider.getModelRegistry().modelIds, rawIds);
  assert.deepEqual(provider.getModelRegistry().exhaustedModelIds, ['GigaChat-3-Ultra'], 'ordinary /models refresh does not prove quota renewal');

  failWithQuota = false;
  const blockedEvents: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) blockedEvents.push(event);
  assert.deepEqual(blockedEvents, [{ type: 'error', category: 'quota', retryable: false }]);
  assert.equal(completionRequests, 1, 'an exhausted model is blocked before another billable request');

  assert.equal((await provider.connect()).state, 'connected');
  assert.equal(provider.getModelRegistry().exhaustedModelIds, undefined, 'a fresh explicit connection attempt resets session quota state');
  const reconnectedEvents: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) reconnectedEvents.push(event);
  assert.deepEqual(reconnectedEvents, [{ type: 'activity', activity: 'receiving' }, { type: 'completed' }]);
  assert.equal(completionRequests, 2);
  assert.equal(discoveryRequests, 3);
  assert.equal(requests.some((item) => JSON.stringify(item).includes('sensitive provider detail')), false);
});

test('OAuth canonicalizes Base64 without changing the credential bytes', async (t) => {
  const credentials = '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002';
  const canonical = Buffer.from(credentials, 'utf8').toString('base64');
  const unpadded = canonical.replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const nonzeroPadBits = unpadded.slice(0, -1) + alphabet[alphabet.indexOf(unpadded[unpadded.length - 1]) | 1];
  for (const storedKey of [canonical, unpadded, nonzeroPadBits + '==']) {
    await t.test(storedKey === canonical ? 'canonical' : storedKey === unpadded ? 'missing padding' : 'nonzero pad bits', async () => {
      assert.equal(Buffer.from(storedKey, 'base64').toString('utf8'), credentials);
      const provider = createGigaChatProvider({
        loadAuthorizationKey: async () => storedKey,
        now: () => FIXED_NOW,
        transport: fakeTransport((request) => {
          if (request.url === GIGACHAT_OAUTH_URL) {
            assert.equal(request.headers.Authorization, `Basic ${canonical}`);
            assert.equal(request.headers.Accept, 'application/json');
            return jsonResponse(200, token('synthetic-token'));
          }
          return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
        }),
      });
      assert.deepEqual(await provider.connect(), { state: 'connected', errorCategory: null });
      assert.equal(JSON.stringify(provider.getConnectionStatus()).includes(canonical), false);
    });
  }
});

test('OAuth HTTP 400 reports failed authorization without exposing the server body', async () => {
  let modelRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(400, { message: 'private credential sentinel', access_token: 'private token sentinel' });
      modelRequests += 1;
      return jsonResponse(200, { data: [] });
    }),
  });
  const status = await provider.connect();
  assert.deepEqual(status, { state: 'error', errorCategory: 'auth', failedStep: 'oauth', httpStatus: 400 });
  assert.equal(modelRequests, 0);
  assert.doesNotMatch(JSON.stringify(status), /private|sentinel|synthetic-key/);
});

test('model discovery errors identify their stage and disappear after a successful reconnect', async () => {
  let modelRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : ++modelRequests === 1 ? jsonResponse(500, { private: 'not exposed' }) : jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] })),
  });
  assert.deepEqual(await provider.connect(), { state: 'error', errorCategory: 'network', failedStep: 'models', httpStatus: 500 });
  assert.deepEqual(await provider.connect(), { state: 'connected', errorCategory: null });
});

test('latest model refresh owns one provider registry even when replies finish in reverse order', async () => {
  const firstRefresh = deferred<ProviderTransportResponse>();
  const secondRefresh = deferred<ProviderTransportResponse>();
  let modelRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      modelRequests += 1;
      if (modelRequests === 1) return jsonResponse(200, { data: [{ id: 'initial/model' }] });
      if (modelRequests === 2) return firstRefresh.promise;
      return secondRefresh.promise;
    }),
  });

  assert.equal((await provider.connect()).state, 'connected');
  const first = provider.listModels();
  const second = provider.listModels();
  await waitFor(() => modelRequests === 3);

  secondRefresh.resolve(jsonResponse(200, { data: [{ id: 'current/model-v2' }] }));
  assert.deepEqual(await second, ['current/model-v2']);
  firstRefresh.resolve(jsonResponse(200, { data: [{ id: 'stale/model-v1' }] }));
  assert.deepEqual(await first, ['stale/model-v1']);

  assert.deepEqual(provider.getModelRegistry(), {
    state: 'ready', modelIds: ['current/model-v2'], errorCategory: null,
  });
});

test('empty model discovery is an explicit error snapshot', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : jsonResponse(200, { data: [] })),
  });

  assert.deepEqual(await provider.connect(), { state: 'error', errorCategory: 'model', failedStep: 'models' });
  assert.deepEqual(provider.getModelRegistry(), { state: 'error', modelIds: [], errorCategory: 'model' });
});

test('streams V2 SSE across split UTF-8, split CRLF, and a CR-only final delimiter', async () => {
  const completionRequests: ProviderTransportRequest[] = [];
  const deltaFrame = Buffer.from(`event: response.message.delta\r\ndata: ${JSON.stringify({
    model: 'GigaChat-3-Ultra:3.2.1', created_at: '2026-10-15T00:00:00Z',
    messages: [{ role: 'assistant', content: [{ text: 'Привет, готово.' }] }],
  })}\r\n\r\n`);
  const splitCrlfAt = deltaFrame.indexOf(Buffer.from('\r\n')) + 1;
  const splitUtf8At = deltaFrame.indexOf(Buffer.from('и')) + 1;
  const doneFrame = Buffer.from(`event: response.message.done\rdata: ${JSON.stringify({
    model: 'GigaChat-3-Ultra:3.2.1', created_at: '2026-10-15T00:00:00Z', finish_reason: 'stop',
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140, input_tokens_details: { cached_tokens: 25 } },
  })}\r\r`);
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      completionRequests.push(request);
      return eventStreamResponse([
        deltaFrame.subarray(0, splitCrlfAt), deltaFrame.subarray(splitCrlfAt, splitUtf8At),
        deltaFrame.subarray(splitUtf8At), doneFrame,
      ]);
    }),
  });

  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [{ source: 'runtime', label: 'Runtime', text: 'Runtime rules' }],
    messages: [{ id: 'message-1', role: 'user', text: 'Вопрос', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask',
    modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'text-delta', text: 'Привет, готово.' },
    { type: 'usage', promptTokens: 100, completionTokens: 40, totalTokens: 140, precachedPromptTokens: 25, providerModel: 'GigaChat-3-Ultra:3.2.1' },
    { type: 'completed' },
  ]);
  assert.equal(completionRequests[0]?.method, 'POST');
  assert.equal(completionRequests[0]?.url, 'https://api.giga.chat/v2/chat/completions');
  assert.equal(completionRequests[0]?.headers.Accept, 'text/event-stream');
  assert.equal(completionRequests[0]?.headers.Authorization, 'Bearer synthetic-token');
  const completionBody = completionRequests[0]?.body;
  const requestBody = JSON.parse(typeof completionBody === 'string' ? completionBody : Buffer.from(completionBody ?? []).toString('utf8')) as {
    model: string; messages: Array<Record<string, unknown>>; tools: Array<{ functions: { specifications: Array<{ name: string }> } }>;
    tool_config: { mode: string }; model_options: { parallel_tool_calls: boolean }; stream: boolean;
  };
  assert.equal(requestBody.model, 'GigaChat-3-Ultra');
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: [{ text: '[Runtime]\nRuntime rules' }] },
    { role: 'user', content: [{ text: 'Вопрос' }] },
  ]);
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.tool_config.mode, 'auto');
  assert.equal(requestBody.model_options.parallel_tool_calls, false);
  assert.deepEqual(requestBody.tools[0]?.functions.specifications.map((fn) => fn.name), ['list', 'search', 'read', 'write', 'open', 'powershell']);
  assert.equal(requestBody.messages.filter((message) => message.role === 'system').length, 1);
});

test('accepts terminal-only V2 assistant metadata after validated text deltas', async () => {
  const stateId = '018f47b2-6c10-7a21-8f2b-1fd4d0470c13';
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : request.url.endsWith('/models')
        ? jsonResponse(200, { data: [{ id: 'GigaChat-3-Lightning' }] })
        : eventStreamResponse([
          v2Frame('response.message.delta', { model: 'GigaChat-3-Lightning', messages: [
            { role: 'assistant', content: [{ text: 'Прочитано. ' }] },
          ] }),
          v2Frame('response.message.delta', { model: 'GigaChat-3-Lightning', messages: [
            { role: 'assistant', content: [{ text: 'SYNTHETIC_A' }] },
          ] }),
          v2Frame('response.message.done', {
            model: 'GigaChat-3-Lightning', finish_reason: 'stop',
            messages: [{ role: 'assistant', tool_state_id: stateId }],
            usage: {
              input_tokens: 1838, input_tokens_details: { prompt_tokens: 1838, cached_tokens: 13 },
              output_tokens: 19, total_tokens: 1857,
            },
          }),
        ])),
  });

  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-terminal-metadata', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Lightning',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'text-delta', text: 'Прочитано. ' },
    { type: 'text-delta', text: 'SYNTHETIC_A' },
    { type: 'usage', promptTokens: 1838, completionTokens: 19, totalTokens: 1857, precachedPromptTokens: 13,
      providerModel: 'GigaChat-3-Lightning' },
    { type: 'completed', functionsStateId: stateId },
  ]);
  assert.equal(events.filter((event) => event.type === 'completed').length, 1);
});

test('retains known V2 usage from a nonterminal delta when the stream ends before message.done', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : request.url.endsWith('/models')
        ? jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] })
        : eventStreamResponse([v2Frame('response.message.delta', {
          id: 'response-usage', model: 'GigaChat-3-Ultra:3.2.1',
          usage: { input_tokens: 8, total_tokens: 10 },
          messages: [{ role: 'assistant', content: [{ text: 'part' }] }],
        })])),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Question', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'usage', promptTokens: 8, completionTokens: null, totalTokens: 10, precachedPromptTokens: null,
      providerRequestId: 'response-usage', providerModel: 'GigaChat-3-Ultra:3.2.1' },
    { type: 'text-delta', text: 'part' },
    { type: 'error', category: 'protocol', retryable: false },
  ]);
});

test('rejects malformed usage counts without emitting an unvalidated receipt', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : request.url.endsWith('/models')
        ? jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] })
        : eventStreamResponse([
          v2Frame('response.message.delta', {
            model: 'GigaChat-3-Ultra', usage: { input_tokens: -1 },
            messages: [{ role: 'assistant', content: [{ text: 'part' }] }],
          }),
          v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop' }),
        ])),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Question', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) events.push(event);
  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.equal(events[events.length - 1]?.type, 'error');
});

test('normalizes one unknown bounded V2 function call only after its terminal event', async () => {
  let doneYielded = false;
  const message = {
    role: 'assistant',
    message_id: 'message-function-1',
    tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13',
    content: [{ function_call: {
      id: '018f47b2-6c10-4a21-8f2b-1fd4d0470c13', name: 'archive', arguments: { path: 'a' },
    } }],
  };
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: (async function* () {
          yield v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra', messages: [message] });
          doneYielded = true;
          yield v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'function_call', messages: [message] });
        }()),
        cancel() {},
      };
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) {
    if (event.type === 'function-call') assert.equal(doneYielded, true);
    events.push(event);
  }
  assert.equal(doneYielded, true);
  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'function-call', functionCall: {
      name: 'archive', arguments: { path: 'a' }, content: null,
      functionsStateId: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13', terminalReason: 'function_call',
      wire: {
        content: message.content,
        messageId: message.message_id,
        toolStateId: message.tool_state_id,
      },
    } },
  ]);
});

test('merges terminal-only V2 function metadata without changing the validated call wire', async (t) => {
  const callId = '018f47b2-6c10-4a21-8f2b-1fd4d0470c13';
  const stateA = '018f47b2-6c10-7a21-8f2b-1fd4d0470c13';
  const stateB = '018f47b2-6c10-7b21-8f2b-1fd4d0470c13';
  const args = { path: 'fixture.txt' };
  const cases = [
    { name: 'object arguments', rawArguments: args, terminalMessageId: 'terminal-object', terminalStateId: stateA, accepted: true },
    { name: 'string arguments', rawArguments: JSON.stringify(args), terminalMessageId: 'terminal-string', terminalStateId: stateA, accepted: true },
    { name: 'conflicting terminal state', rawArguments: args, deltaStateId: stateA,
      terminalMessageId: 'terminal-state-conflict', terminalStateId: stateB, accepted: false },
    { name: 'conflicting terminal message identity', rawArguments: args, deltaMessageId: 'delta-message',
      terminalMessageId: 'terminal-message', terminalStateId: stateA, accepted: false },
    { name: 'stop cannot confirm a function call', rawArguments: args, terminalMessageId: 'terminal-stop',
      terminalStateId: stateA, finishReason: 'stop', accepted: false },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const callContent = [{ function_call: { id: callId, name: 'read', arguments: item.rawArguments } }];
      const deltaMessage = {
        role: 'assistant', content: callContent,
        ...(item.deltaMessageId === undefined ? {} : { message_id: item.deltaMessageId }),
        ...(item.deltaStateId === undefined ? {} : { tool_state_id: item.deltaStateId }),
      };
      const provider = createGigaChatProvider({
        loadAuthorizationKey: async () => 'synthetic-key',
        now: () => FIXED_NOW,
        transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
          ? jsonResponse(200, token('synthetic-token'))
          : request.url.endsWith('/models')
            ? jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] })
            : eventStreamResponse([
              v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra', messages: [deltaMessage] }),
              v2Frame('response.message.done', {
                model: 'GigaChat-3-Ultra', finish_reason: item.finishReason ?? 'function_call',
                messages: [{ role: 'assistant', message_id: item.terminalMessageId, tool_state_id: item.terminalStateId }],
              }),
            ])),
      });
      assert.equal((await provider.connect()).state, 'connected');
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({
        system: [], messages: [{ id: 'message-terminal-function-metadata', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
        permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
      }, new AbortController().signal)) events.push(event);

      const functionEvents = events.filter((event) => event.type === 'function-call');
      if (!item.accepted) {
        assert.equal(functionEvents.length, 0);
        assert.deepEqual(events[events.length - 1], { type: 'error', category: 'protocol', retryable: false });
        return;
      }
      assert.equal(functionEvents.length, 1);
      const functionEvent = functionEvents[0];
      assert.ok(functionEvent && functionEvent.type === 'function-call');
      assert.equal(functionEvent.functionCall.name, 'read');
      assert.deepEqual(functionEvent.functionCall.arguments, args);
      assert.equal(functionEvent.functionCall.functionsStateId, stateA);
      assert.deepEqual(functionEvent.functionCall.wire, {
        content: callContent,
        messageId: item.terminalMessageId,
        toolStateId: stateA,
      });
    });
  }
});

test('accepts terminal-only V2 calls over 32 KiB and rejects model, state, or UTF-8 mismatches before a call', async (t) => {
  const callId = '018f47b2-6c10-4a21-8f2b-1fd4d0470c13';
  const stateId = '018f47b2-6c10-7a21-8f2b-1fd4d0470c13';
  const terminalMessage = (name: string, args: Record<string, unknown>, state = stateId) => ({
    role: 'assistant', message_id: 'terminal-assistant-message', tool_state_id: state,
    content: [{ function_call: { id: callId, name, arguments: args } }],
  });
  const oversizedContents = 'x'.repeat(40 * 1024);
  const terminalOnly = terminalMessage('read', { path: 'fixture.txt' });
  const largeArguments = terminalMessage('write', { path: 'fixture.txt', contents: oversizedContents });
  const wrongModel = terminalMessage('read', { path: 'fixture.txt' });
  const invalidState = terminalMessage('read', { path: 'fixture.txt' }, 'not-a-provider-state-id');
  const invalidUtf8 = Buffer.concat([
    Buffer.from('event: response.message.delta\ndata: {"model":"GigaChat-3-Ultra","messages":[{"role":"assistant","content":[{"function_call":{"name":"read","arguments":{"path":"'),
    Buffer.from([0xff]),
    Buffer.from('"}}]}]}\n\n'),
  ]);
  const cases: Array<{
    name: string;
    chunks: readonly Uint8Array[];
    expectedCall?: { name: string; arguments: Record<string, unknown>; message: ReturnType<typeof terminalMessage> };
  }> = [
    {
      name: 'function call present only on the terminal event',
      chunks: [v2Frame('response.message.done', {
        model: 'GigaChat-3-Ultra', finish_reason: 'function_call', messages: [terminalOnly],
      })],
      expectedCall: { name: 'read', arguments: { path: 'fixture.txt' }, message: terminalOnly },
    },
    {
      name: 'complete call arguments above 32 KiB remain intact within the provider bound',
      chunks: [v2Frame('response.message.done', {
        model: 'GigaChat-3-Ultra', finish_reason: 'function_call', messages: [largeArguments],
      })],
      expectedCall: {
        name: 'write', arguments: { path: 'fixture.txt', contents: oversizedContents }, message: largeArguments,
      },
    },
    {
      name: 'wrong requested model',
      chunks: [v2Frame('response.message.done', {
        model: 'GigaChat-3-Pro', finish_reason: 'function_call', messages: [wrongModel],
      })],
    },
    {
      name: 'invalid provider state ID',
      chunks: [v2Frame('response.message.done', {
        model: 'GigaChat-3-Ultra', finish_reason: 'function_call', messages: [invalidState],
      })],
    },
    { name: 'invalid UTF-8 before a function call', chunks: [invalidUtf8] },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const provider = createGigaChatProvider({
        loadAuthorizationKey: async () => 'synthetic-key',
        now: () => FIXED_NOW,
        transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
          ? jsonResponse(200, token('synthetic-token'))
          : request.url.endsWith('/models')
            ? jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] })
            : eventStreamResponse(item.chunks)),
      });
      assert.equal((await provider.connect()).state, 'connected');
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({
        system: [], messages: [{ id: 'message-terminal-call', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
        permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
      }, new AbortController().signal)) events.push(event);

      if (item.expectedCall) {
        const event = events.find((candidate) => candidate.type === 'function-call');
        assert.ok(event && event.type === 'function-call');
        assert.equal(event.functionCall.name, item.expectedCall.name);
        assert.deepEqual(event.functionCall.arguments, item.expectedCall.arguments);
        assert.deepEqual(event.functionCall.wire?.content, item.expectedCall.message.content);
        assert.equal(event.functionCall.wire?.messageId, item.expectedCall.message.message_id);
        assert.equal(event.functionCall.wire?.toolStateId, item.expectedCall.message.tool_state_id);
      } else {
        assert.equal(events.some((event) => event.type === 'function-call'), false);
        assert.deepEqual(events[events.length - 1], { type: 'error', category: 'protocol', retryable: false });
      }
    });
  }
});

test('rejects malformed, incomplete, oversized, and unsupported terminal SSE events safely', async (t) => {
  const cases: Array<{ name: string; response: ProviderTransportResponse; category: string }> = [
    {
      name: 'malformed JSON', response: eventStreamResponse([Buffer.from('event: response.message.done\ndata: not-json\n\n')]), category: 'protocol',
    },
    {
      name: 'missing message.done', response: eventStreamResponse([v2Frame('response.message.delta', {
        model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant', content: [{ text: 'часть' }] }],
      })]), category: 'protocol',
    },
    {
      name: 'message.done without finish reason', response: eventStreamResponse([v2Frame('response.message.done', { model: 'GigaChat-3-Ultra' })]), category: 'protocol',
    },
    {
      name: 'terminal-only metadata cannot complete without preceding assistant content', response: eventStreamResponse([
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop',
          messages: [{ role: 'assistant', tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'metadata-only delta remains invalid', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra',
          messages: [{ role: 'assistant', tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop' }),
      ]), category: 'protocol',
    },
    {
      name: 'null terminal content is not missing metadata', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra',
          messages: [{ role: 'assistant', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop',
          messages: [{ role: 'assistant', content: null, tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'wrong role in terminal metadata', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra',
          messages: [{ role: 'assistant', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop',
          messages: [{ role: 'user', tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'invalid state in terminal metadata', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra',
          messages: [{ role: 'assistant', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop',
          messages: [{ role: 'assistant', tool_state_id: 'invalid-state' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'conflicting state in terminal metadata', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant',
          tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop',
          messages: [{ role: 'assistant', tool_state_id: '018f47b2-6c10-7b21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'metadata-only terminal cannot create a function call', response: eventStreamResponse([
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'function_call',
          messages: [{ role: 'assistant', tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'text cannot be confirmed as a function call by metadata alone', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra',
          messages: [{ role: 'assistant', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'function_call',
          messages: [{ role: 'assistant', tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'stop cannot confirm a preceding function call', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant', content: [
          { function_call: { name: 'read', arguments: { path: 'fixture.txt' } } },
        ] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop',
          messages: [{ role: 'assistant', tool_state_id: '018f47b2-6c10-7a21-8f2b-1fd4d0470c13' }] }),
      ]), category: 'protocol',
    },
    {
      name: 'conflicting terminal content', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'другое' }] }] }),
      ]), category: 'protocol',
    },
    {
      name: 'length finish reason', response: eventStreamResponse([
        v2Frame('response.message.delta', { model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant', content: [{ text: 'часть' }] }] }),
        v2Frame('response.message.done', { model: 'GigaChat-3-Ultra', finish_reason: 'length' }),
      ]), category: 'context',
    },
    {
      name: 'function terminal missing arguments', response: eventStreamResponse([v2Frame('response.message.done', {
        model: 'GigaChat-3-Ultra', finish_reason: 'function_call',
        messages: [{ role: 'assistant', content: [{ function_call: { name: 'read' } }] }],
      })]), category: 'protocol',
    },
    {
      name: 'function call missing terminal', response: eventStreamResponse([v2Frame('response.message.delta', {
        model: 'GigaChat-3-Ultra',
        messages: [{ role: 'assistant', content: [{ function_call: { name: 'future', arguments: { x: 1 } } }] }],
      })]), category: 'protocol',
    },
    {
      name: 'oversized stream', response: eventStreamResponse([v2Frame('response.message.delta', {
        model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant', content: [{ text: 'x'.repeat(2 * 1024 * 1024) }] }],
      })]), category: 'protocol',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const provider = createGigaChatProvider({
        loadAuthorizationKey: async () => 'synthetic-key',
        now: () => FIXED_NOW,
        transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
          ? jsonResponse(200, token('synthetic-token'))
          : request.url.endsWith('/models')
            ? jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] })
            : item.response),
      });
      assert.equal((await provider.connect()).state, 'connected');
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({
        system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
        permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
      }, new AbortController().signal)) events.push(event);
      assert.deepEqual(events[events.length - 1], { type: 'error', category: item.category, retryable: false });
      assert.equal(events.some((event) => event.type === 'completed'), false);
      assert.equal(events.some((event) => event.type === 'function-call'), false);
      if (item.category === 'context') assert.ok(events.some((event) => event.type === 'text-delta' && event.text === 'часть'));
    });
  }
});

test('V2 message.done closes a healthy SSE stream without waiting for HTTP EOF', async () => {
  let nextCalls = 0;
  let responseCancelled = false;
  const responseBytes = Buffer.from(`event: response.message.delta\r\ndata: ${JSON.stringify({
    model: 'GigaChat-3-Ultra', messages: [{ role: 'assistant', content: [{ text: 'готово' }] }],
  })}\r\n\r\nevent: response.message.done\r\ndata: ${JSON.stringify({
    model: 'GigaChat-3-Ultra', finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  })}\r\r`);
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<Uint8Array>> => {
              nextCalls += 1;
              if (nextCalls === 1) return { done: false, value: responseBytes };
              return new Promise<IteratorResult<Uint8Array>>(() => undefined);
            },
            return: async () => ({ done: true, value: undefined }),
          }),
        },
        cancel: () => { responseCancelled = true; },
      };
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'text-delta', text: 'готово' },
    { type: 'usage', promptTokens: 3, completionTokens: 1, totalTokens: 4, precachedPromptTokens: null,
      providerModel: 'GigaChat-3-Ultra' },
    { type: 'completed' },
  ]);
  assert.equal(nextCalls, 1);
  assert.equal(responseCancelled, true);
});

test('does not send a model request for an ID removed by the latest registry refresh', async () => {
  let modelRequests = 0;
  let completionRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) {
        modelRequests += 1;
        return jsonResponse(200, { data: [{ id: modelRequests === 1 ? 'GigaChat-3-Ultra' : 'GigaChat-2-Max' }] });
      }
      completionRequests += 1;
      return eventStreamResponse([Buffer.from('data: [DONE]\n\n')]);
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  await provider.listModels();
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ type: 'error', category: 'model', retryable: false }]);
  assert.equal(completionRequests, 0);
});

test('disconnect aborts an active SSE response with a safe cancel event', async () => {
  const pendingBody = deferred<IteratorResult<Uint8Array>>();
  let bodyReadStarted = false;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: {
          [Symbol.asyncIterator]: () => ({
            next: () => { bodyReadStarted = true; return pendingBody.promise; },
            return: async () => ({ done: true, value: undefined }),
          }),
        },
        cancel() {},
      };
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const iterator = provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'GigaChat-3-Ultra',
  }, new AbortController().signal)[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'activity', activity: 'receiving' } });
  const nextEvent = iterator.next();
  await waitFor(() => bodyReadStarted);
  provider.disconnect();

  assert.deepEqual(await nextEvent, { done: false, value: { type: 'error', category: 'cancel', retryable: false } });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('invalid authorization key returns only the safe auth category', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-invalid-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(401, { error: 'private body sentinel', access_token: 'private token sentinel' })
      : jsonResponse(200, { data: [] })),
  });

  const status = await provider.connect();

  assert.deepEqual(status, { state: 'error', errorCategory: 'auth', failedStep: 'oauth', httpStatus: 401 });
  assert.doesNotMatch(JSON.stringify(status), /synthetic-invalid-key|private body sentinel|private token sentinel/);
});

test('rejects seconds, expired, and out-of-range expiry values before model requests', async (t) => {
  for (const [label, expiresAt] of [
    ['seconds', Math.floor((FIXED_NOW + 30 * 60 * 1000) / 1000)],
    ['too far in the future', FIXED_NOW + 24 * 60 * 60 * 1000 + 1],
    ['overflow', Number.MAX_VALUE],
    ['already expired', FIXED_NOW - 1],
  ] as const) {
    await t.test(label, async () => {
      let oauthRequests = 0;
      let modelRequests = 0;
      const provider = createGigaChatProvider({
        loadAuthorizationKey: async () => 'synthetic-key',
        now: () => FIXED_NOW,
        transport: fakeTransport((request) => {
          if (request.url === GIGACHAT_OAUTH_URL) {
            oauthRequests += 1;
            return jsonResponse(200, token('synthetic-token', expiresAt));
          }
          modelRequests += 1;
          return jsonResponse(200, { data: [{ id: 'test-model' }] });
        }),
      });

      const status = await provider.connect();

      assert.deepEqual(status, { state: 'error', errorCategory: 'protocol', failedStep: 'oauth' });
      assert.equal(oauthRequests, 1);
      assert.equal(modelRequests, 0);
    });
  }
});

test('refreshes near expiry and does not enter a refresh loop', async () => {
  let currentTime = FIXED_NOW;
  let oauthRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => currentTime,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthRequests += 1;
        return jsonResponse(200, token(`synthetic-token-${oauthRequests}`, currentTime + 30 * 60 * 1000));
      }
      return jsonResponse(200, { data: [{ id: 'test-model' }] });
    }),
  });

  assert.equal((await provider.connect()).state, 'connected');
  await provider.listModels();
  assert.equal(oauthRequests, 1);
  currentTime += 30 * 60 * 1000 - 30_000;
  await provider.listModels();
  assert.equal(oauthRequests, 2);
});

test('concurrent callers share refresh; cancelling one waiter leaves the other in control', async () => {
  const pendingOAuth = deferred<ProviderTransportResponse>();
  let oauthSignal: AbortSignal | null = null;
  const getOAuthSignal = (): AbortSignal | null => oauthSignal as AbortSignal | null;
  let oauthRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthRequests += 1;
        oauthSignal = request.signal;
        return pendingOAuth.promise;
      }
      return jsonResponse(200, { data: [{ id: 'test-model' }] });
    }),
  });
  const firstController = new AbortController();
  const first = provider.listModels(firstController.signal);
  const second = provider.listModels();
  await waitFor(() => getOAuthSignal() !== null);

  firstController.abort();
  await assert.rejects(first, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel');
  assert.equal(getOAuthSignal()?.aborted, false);
  pendingOAuth.resolve(jsonResponse(200, token('synthetic-shared-token')));
  assert.deepEqual(await second, ['test-model']);
  assert.equal(oauthRequests, 1);
});

test('cancelling every refresh waiter aborts the shared OAuth request', async () => {
  const pendingOAuth = deferred<ProviderTransportResponse>();
  let oauthSignal: AbortSignal | null = null;
  const getOAuthSignal = (): AbortSignal | null => oauthSignal as AbortSignal | null;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthSignal = request.signal;
        return pendingOAuth.promise;
      }
      return jsonResponse(200, { data: [{ id: 'test-model' }] });
    }),
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = provider.listModels(firstController.signal);
  const second = provider.listModels(secondController.signal);
  await waitFor(() => getOAuthSignal() !== null);
  firstController.abort();
  secondController.abort();
  await Promise.all([
    assert.rejects(first, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel'),
    assert.rejects(second, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel'),
  ]);
  assert.equal(getOAuthSignal()?.aborted, true);
  pendingOAuth.resolve(jsonResponse(200, token('synthetic-late-token')));
  await delay(0);
});

test('retries one models 401 after refresh and stops after a repeated 401', async () => {
  let oauthRequests = 0;
  let modelRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthRequests += 1;
        return jsonResponse(200, token(`synthetic-token-${oauthRequests}`));
      }
      modelRequests += 1;
      return modelRequests === 1
        ? jsonResponse(401, { error: 'private provider detail' })
        : jsonResponse(401, { error: 'private provider detail' });
    }),
  });

  const status = await provider.connect();

  assert.deepEqual(status, { state: 'error', errorCategory: 'auth', failedStep: 'models', httpStatus: 401 });
  assert.equal(oauthRequests, 2);
  assert.equal(modelRequests, 2);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-key|synthetic-token|private provider detail/);
});

test('cancel and saved-key replacement prevent late OAuth/model replies from connecting', async () => {
  const pendingOAuth = deferred<ProviderTransportResponse>();
  let oauthSignal: AbortSignal | null = null;
  const getOAuthSignal = (): AbortSignal | null => oauthSignal as AbortSignal | null;
  let modelRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-old-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthSignal = request.signal;
        return pendingOAuth.promise;
      }
      modelRequests += 1;
      return jsonResponse(200, { data: [{ id: 'test-model' }] });
    }),
  });

  const connecting = provider.connect();
  await waitFor(() => getOAuthSignal() !== null);
  provider.invalidateSavedKey();
  assert.equal(getOAuthSignal()?.aborted, true);
  pendingOAuth.resolve(jsonResponse(200, token('synthetic-late-token')));

  assert.deepEqual(await connecting, { state: 'not-configured', errorCategory: null });
  assert.equal(provider.getConnectionStatus().state, 'not-configured');
  assert.equal(modelRequests, 0);
});

test('disconnect during key loading prevents a late key from starting OAuth in the new session', async () => {
  const pendingOldKey = deferred<string | null>();
  let keyReads = 0;
  const oauthAuthorization: string[] = [];
  const provider = createGigaChatProvider({
    loadAuthorizationKey: () => {
      keyReads += 1;
      return keyReads === 1 ? pendingOldKey.promise : Promise.resolve('synthetic-new-key');
    },
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) {
        oauthAuthorization.push(request.headers.Authorization ?? '');
        return jsonResponse(200, token('synthetic-new-token'));
      }
      return jsonResponse(200, { data: [{ id: 'test-model' }] });
    }),
  });

  const oldRequest = provider.listModels();
  await waitFor(() => keyReads === 1);
  provider.disconnect();
  const newRequest = provider.listModels();
  assert.deepEqual(await newRequest, ['test-model']);
  pendingOldKey.resolve('synthetic-old-key');
  await assert.rejects(oldRequest, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'cancel');

  assert.deepEqual(oauthAuthorization, ['Basic synthetic-new-key']);
});

test('disconnect during models body reading cancels it and ignores a late response', async () => {
  const pendingBody = deferred<void>();
  let modelResponseStarted = false;
  let modelResponseCancelled = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      modelResponseStarted = true;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* () {
          await pendingBody.promise;
          yield Buffer.from('{"data":[{"id":"test-model"}]}');
        }()),
        cancel: () => { modelResponseCancelled += 1; },
      };
    }),
  });

  const connecting = provider.connect();
  await waitFor(() => modelResponseStarted);
  provider.disconnect();
  assert.deepEqual(await connecting, { state: 'not-configured', errorCategory: null });
  assert.ok(modelResponseCancelled > 0);
  pendingBody.resolve();
  await delay(0);
  assert.deepEqual(provider.getConnectionStatus(), { state: 'not-configured', errorCategory: null });
});

test('uses the extra CA only when TLS validates the local test server', async (t) => {
  const server = createHttpsServer({ key: TEST_SERVER_KEY, cert: TEST_SERVER_CA }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('verified');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const url = `https://127.0.0.1:${address.port}/fixture`;
  const signal = new AbortController().signal;

  await t.test('trusted CA', async () => {
    const transport = createHttpsTransport({ additionalCa: TEST_SERVER_CA, timeoutMs: 2_000 });
    try {
      const response = await transport.request({ url, method: 'GET', headers: {}, signal });
      let body = '';
      for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf8');
      assert.equal(body, 'verified');
    } finally {
      transport.close();
    }
  });

  await t.test('untrusted CA', async () => {
    const transport = createHttpsTransport({ timeoutMs: 2_000 });
    try {
      await assert.rejects(
        transport.request({ url, method: 'GET', headers: {}, signal }),
        (error: unknown) => error instanceof GigaChatProviderError && error.category === 'tls',
      );
    } finally {
      transport.close();
    }
  });

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('bounds the TLS handshake with an absolute request deadline', async () => {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const transport = createHttpsTransport({ timeoutMs: 50 });

  try {
    await assert.rejects(
      transport.request({
        url: `https://127.0.0.1:${address.port}/stalled-handshake`,
        method: 'GET',
        headers: {},
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'network',
    );
  } finally {
    transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('applies a validated per-request HTTPS deadline without changing the transport default', async () => {
  let requests = 0;
  const server = createHttpsServer({ key: TEST_SERVER_KEY, cert: TEST_SERVER_CA }, (_request, response) => {
    requests += 1;
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('done');
      }
    }, 140);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const transport = createHttpsTransport({ additionalCa: TEST_SERVER_CA, timeoutMs: 1_000 });
  const request = (timeoutMs?: number): ProviderTransportRequest => ({
    url: `https://127.0.0.1:${address.port}/bounded`, method: 'GET', headers: {},
    signal: new AbortController().signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  try {
    await assert.rejects(transport.request(request(0)),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
    await assert.rejects(transport.request(request(90_001)),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
    assert.equal(requests, 0, 'invalid overrides are rejected before opening a socket');

    const start = Date.now();
    await assert.rejects(transport.request(request(35)),
      (error: unknown) => error instanceof GigaChatProviderError && error.category === 'network');
    assert.ok(Date.now() - start < 500, 'the per-request deadline terminates the delayed response');

    const response = await transport.request(request());
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf8');
    assert.equal(body, 'done', 'requests without an override retain the transport default');
    assert.equal(requests, 2);
  } finally {
    transport.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('keeps SSE streams bounded by idle time while preserving a whole-response deadline for JSON', async () => {
  const server = createHttpsServer({ key: TEST_SERVER_KEY, cert: TEST_SERVER_CA }, (request, response) => {
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': start\n\n');
      void (async () => {
        for (let index = 0; index < 7; index += 1) {
          await delay(25);
          response.write(`data: ${index}\n\n`);
        }
        response.end();
      })();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"data":[');
    void delay(250).then(() => response.end('{"id":"late"}]}'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const transport = createHttpsTransport({ additionalCa: TEST_SERVER_CA, timeoutMs: 100 });

  try {
    const start = Date.now();
    const streamResponse = await transport.request({
      url: `https://127.0.0.1:${address.port}/stream`, method: 'GET', headers: {},
      signal: new AbortController().signal, streaming: true,
    });
    let streamBody = '';
    for await (const chunk of streamResponse.body) streamBody += Buffer.from(chunk).toString('utf8');
    assert.match(streamBody, /data: 6/);
    assert.ok(Date.now() - start > 100, 'a healthy stream may outlive the handshake timeout');

    const jsonResponseBody = await transport.request({
      url: `https://127.0.0.1:${address.port}/json`, method: 'GET', headers: {},
      signal: new AbortController().signal,
    });
    let jsonResponsePrefix = '';
    await assert.rejects(async () => {
      for await (const chunk of jsonResponseBody.body) jsonResponsePrefix += Buffer.from(chunk).toString('utf8');
    }, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'network');
    assert.equal(jsonResponsePrefix, '{"data":[', 'the timed JSON request must have received only its initial prefix');
  } finally {
    transport.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('uses the documented token-count REST array and rejects SDK-wrapper responses', async () => {
  const requests: ProviderTransportRequest[] = [];
  let malformed = false;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-authorization-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      requests.push(request);
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-access-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }, { id: 'GigaChat-test-model' }] });
      return jsonResponse(200, malformed
        ? { tokens: [{ object: 'tokens', tokens: 3, characters: 4 }] }
        : [{ object: 'tokens', tokens: 3, characters: 4 }, { object: 'tokens', tokens: 7, characters: 8 }]);
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const signal = new AbortController().signal;
  assert.deepEqual(await provider.countTokens('GigaChat-test-model', ['text-one', 'text-two'], signal), [
    { object: 'tokens', tokens: 3, characters: 4 }, { object: 'tokens', tokens: 7, characters: 8 },
  ]);
  const countRequest = requests[requests.length - 1]!;
  assert.equal(countRequest.url, `${GIGACHAT_API_BASE_URL}/tokens/count`);
  assert.deepEqual(JSON.parse(typeof countRequest.body === 'string' ? countRequest.body : Buffer.from(countRequest.body ?? []).toString('utf8')),
    { model: 'GigaChat-test-model', input: ['text-one', 'text-two'] });
  malformed = true;
  await assert.rejects(provider.countTokens('GigaChat-test-model', ['text-one', 'text-two'], signal),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
});

test('rejects oversized serialized continuation before transport, including protocol results and function schemas', async () => {
  let transportRequests = 0;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-authorization-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      transportRequests += 1;
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-access-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
      return eventStreamResponse([Buffer.from('data: [DONE]\n\n')]);
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const exchange = (anchorMessageId: string): NonNullable<ProviderTurnRequest['protocolHistory']>[number] => ({
    anchorMessageId, name: 'read', arguments: {}, content: null, functionsStateId: null,
    result: JSON.stringify({ contents: 'x'.repeat(1_100_000) }),
  });
  const request: ProviderTurnRequest = {
    system: [],
    messages: [{ id: 'user-1', role: 'user', text: 'prompt', createdAt: atFixture }],
    protocolHistory: [exchange('user-1'), exchange('user-1')],
    permissionProfile: 'ask',
    modelId: 'GigaChat-3-Ultra',
  };
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);
  const terminalEvent = events[events.length - 1];
  assert.equal(terminalEvent?.type, 'error');
  if (terminalEvent?.type === 'error') assert.equal(terminalEvent.category, 'context');
  assert.equal(transportRequests, 2, 'only OAuth and model discovery ran before the oversized continuation was rejected');
});

const atFixture = '2026-10-09T12:00:00.000Z';
