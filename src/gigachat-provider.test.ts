import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import type { ProviderEvent } from './contracts';
import {
  createGigaChatProvider,
  createHttpsTransport,
  GIGACHAT_API_BASE_URL,
  GIGACHAT_OAUTH_URL,
  GigaChatProviderError,
  type ProviderTransport,
  type ProviderTransportRequest,
  type ProviderTransportResponse,
} from './gigachat-provider';

const FIXED_NOW = Date.UTC(2026, 9, 9, 12);
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


function jsonResponse(statusCode: number, value: unknown): ProviderTransportResponse {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
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

function fakeTransport(handler: (request: ProviderTransportRequest) => Promise<ProviderTransportResponse> | ProviderTransportResponse): ProviderTransport {
  return { request: async (request) => handler(request), close() {} };
}

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

  assert.deepEqual(await provider.connect(), { state: 'error', errorCategory: 'model' });
  assert.deepEqual(provider.getModelRegistry(), { state: 'error', modelIds: [], errorCategory: 'model' });
});

test('streams GigaChat v1 SSE across split UTF-8, CRLF and multiline data frames', async () => {
  const completionRequests: ProviderTransportRequest[] = [];
  const firstFrame = Buffer.from('data: {"choices":[\r\ndata: {"index":0,"delta":{"role":"assistant","content":"Привет "}}]}\r\n\r\n');
  const splitAt = firstFrame.indexOf(Buffer.from('Привет')) + 1;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'future/model-v2' }] });
      completionRequests.push(request);
      return eventStreamResponse([
        firstFrame.subarray(0, splitAt), firstFrame.subarray(splitAt),
        Buffer.from('data: {"id":"response-1","model":"future/model-v2","usage":{"prompt_tokens":100,"completion_tokens":40,"total_tokens":140,"precached_prompt_tokens":25},"choices":[{"index":0,"delta":{"content":"мир","functions_state_id":"state-final"},"finish_reason":"stop"}]}\r\n\r\n'),
        Buffer.from('data: [DONE]\r\n\r\n'),
      ]);
    }),
  });

  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [
      { source: 'runtime', label: 'Runtime', text: 'Runtime rules' },
      { source: 'global', label: 'Rules', text: 'Правила' },
    ],
    messages: [
      { id: 'message-1', role: 'user', text: 'Вопрос', createdAt: '2026-10-09T00:00:00.000Z' },
      { id: 'message-2', role: 'assistant', text: 'Ответ', createdAt: '2026-10-09T00:00:01.000Z', functionsStateId: 'state-saved' },
      { id: 'message-3', role: 'user', text: 'Продолжи', createdAt: '2026-10-09T00:00:02.000Z' },
    ],
    protocolHistory: [{
      anchorMessageId: 'message-1', name: 'read', arguments: { path: 'README.md' }, content: null,
      functionsStateId: 'state-1', result: '{"ok":true,"result":"текст"}',
    }],
    permissionProfile: 'ask',
    modelId: 'future/model-v2',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'text-delta', text: 'Привет ' },
    { type: 'usage', promptTokens: 100, completionTokens: 40, totalTokens: 140, precachedPromptTokens: 25, providerRequestId: 'response-1', providerModel: 'future/model-v2' },
    { type: 'text-delta', text: 'мир' },
    { type: 'completed', functionsStateId: 'state-final' },
  ]);
  assert.equal(completionRequests[0]?.method, 'POST');
  assert.equal(completionRequests[0]?.headers.Accept, 'text/event-stream');
  assert.equal(completionRequests[0]?.headers.Authorization, 'Bearer synthetic-token');
  const requestBody = JSON.parse(completionRequests[0]?.body ?? '{}') as {
    model: string; messages: Array<Record<string, unknown>>; functions: Array<{ name: string }>; function_call: string; stream: boolean;
  };
  assert.equal(requestBody.model, 'future/model-v2');
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: '[Runtime]\nRuntime rules\n\n[Rules]\nПравила' },
    { role: 'user', content: 'Вопрос' },
    { role: 'assistant', content: '', functions_state_id: 'state-1', function_call: { name: 'read', arguments: { path: 'README.md' } } },
    { role: 'function', name: 'read', content: '{"ok":true,"result":"текст"}' },
    { role: 'assistant', content: 'Ответ', functions_state_id: 'state-saved' },
    { role: 'user', content: 'Продолжи' },
  ]);
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.function_call, 'auto');
  assert.deepEqual(requestBody.functions.map((fn) => fn.name), ['list', 'search', 'read', 'write', 'open', 'powershell']);
  assert.equal(requestBody.messages.filter((message) => message.role === 'system').length, 1);
});

test('emits validated terminal usage before a later missing-DONE protocol error', async () => {
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => request.url === GIGACHAT_OAUTH_URL
      ? jsonResponse(200, token('synthetic-token'))
      : request.url.endsWith('/models')
        ? jsonResponse(200, { data: [{ id: 'test-model' }] })
        : eventStreamResponse([Buffer.from(`data: ${JSON.stringify({
          id: 'response-usage', model: 'provider-model-v3',
          usage: { prompt_tokens: 8, total_tokens: 10 },
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`) ])),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Question', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'test-model',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'usage', promptTokens: 8, completionTokens: null, totalTokens: 10, precachedPromptTokens: null,
      providerRequestId: 'response-usage', providerModel: 'provider-model-v3' },
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
        ? jsonResponse(200, { data: [{ id: 'test-model' }] })
        : eventStreamResponse([Buffer.from(`data: ${JSON.stringify({
          usage: { prompt_tokens: -1 }, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`), Buffer.from('data: [DONE]\n\n') ])),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Question', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'test-model',
  }, new AbortController().signal)) events.push(event);
  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.equal(events[events.length - 1]?.type, 'error');
});

test('normalizes an unknown bounded function call with object arguments only after DONE', async () => {
  let doneYielded = false;
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'test-model' }] });
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: (async function* () {
          yield Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { function_call: { name: 'archive', arguments: { path: 'a' } }, functions_state_id: 'state-2', }, finish_reason: 'function_call' }] })}\n\n`);
          await delay(1);
          doneYielded = true;
          yield Buffer.from('data: [DONE]\n\n');
        }()),
        cancel() {},
      };
    }),
  });
  assert.equal((await provider.connect()).state, 'connected');
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
    permissionProfile: 'ask', modelId: 'test-model',
  }, new AbortController().signal)) {
    if (event.type === 'function-call') assert.equal(doneYielded, true);
    events.push(event);
  }
  assert.equal(doneYielded, true);
  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'function-call', functionCall: {
      name: 'archive', arguments: { path: 'a' }, content: null, functionsStateId: 'state-2', terminalReason: 'function_call',
    } },
  ]);
});

test('rejects malformed, incomplete, oversized, and unsupported terminal SSE events safely', async (t) => {
  const cases: Array<{ name: string; response: ProviderTransportResponse; category: string }> = [
    {
      name: 'malformed JSON', response: eventStreamResponse([Buffer.from('data: not-json\n\ndata: [DONE]\n\n')]), category: 'protocol',
    },
    {
      name: 'missing DONE', response: eventStreamResponse([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"часть"},"finish_reason":"stop"}]}\n\n')]), category: 'protocol',
    },
    {
      name: 'DONE without stop', response: eventStreamResponse([Buffer.from('data: [DONE]\n\n')]), category: 'protocol',
    },
    {
      name: 'DONE without any terminal finish reason', response: eventStreamResponse([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"часть"}}]}\n\ndata: [DONE]\n\n')]), category: 'protocol',
    },
    {
      name: 'data after stop', response: eventStreamResponse([Buffer.from('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"поздно"}}]}\n\ndata: [DONE]\n\n')]), category: 'protocol',
    },
    {
      name: 'length finish reason', response: eventStreamResponse([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"часть"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')]), category: 'context',
    },
    {
      name: 'function terminal missing arguments', response: eventStreamResponse([Buffer.from('data: {"choices":[{"index":0,"delta":{"function_call":{"name":"read"}},"finish_reason":"function_call"}]}\n\ndata: [DONE]\n\n')]), category: 'protocol',
    },
    {
      name: 'function call missing DONE', response: eventStreamResponse([Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { function_call: { name: 'future', arguments: { x: 1 } }, functions_state_id: 'state-1' }, finish_reason: 'function_call' }] })}\n\n`)]), category: 'protocol',
    },
    {
      name: 'oversized stream', response: eventStreamResponse([Buffer.from(`data: ${'x'.repeat(2 * 1024 * 1024)}\n\n`)]), category: 'protocol',
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
            ? jsonResponse(200, { data: [{ id: 'test-model' }] })
            : item.response),
      });
      assert.equal((await provider.connect()).state, 'connected');
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({
        system: [], messages: [{ id: 'message-1', role: 'user', text: 'Задача', createdAt: '2026-10-09T00:00:00.000Z' }],
        permissionProfile: 'ask', modelId: 'test-model',
      }, new AbortController().signal)) events.push(event);
      assert.deepEqual(events[events.length - 1], { type: 'error', category: item.category, retryable: false });
      assert.equal(events.some((event) => event.type === 'completed'), false);
      if (item.name === 'function call missing DONE') assert.equal(events.some((event) => event.type === 'function-call'), false);
      if (item.category === 'context') assert.ok(events.some((event) => event.type === 'text-delta' && event.text === 'часть'));
    });
  }
});

test('DONE closes a healthy SSE stream without waiting for HTTP EOF', async () => {
  let nextCalls = 0;
  let responseCancelled = false;
  const responseBytes = Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"готово"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const provider = createGigaChatProvider({
    loadAuthorizationKey: async () => 'synthetic-key',
    now: () => FIXED_NOW,
    transport: fakeTransport((request) => {
      if (request.url === GIGACHAT_OAUTH_URL) return jsonResponse(200, token('synthetic-token'));
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'test-model' }] });
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
    permissionProfile: 'ask', modelId: 'test-model',
  }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events, [
    { type: 'activity', activity: 'receiving' },
    { type: 'text-delta', text: 'готово' },
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
        return jsonResponse(200, { data: [{ id: modelRequests === 1 ? 'old-model' : 'current-model' }] });
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
    permissionProfile: 'ask', modelId: 'old-model',
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
      if (request.url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'test-model' }] });
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
    permissionProfile: 'ask', modelId: 'test-model',
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

  assert.deepEqual(status, { state: 'error', errorCategory: 'auth' });
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

      assert.deepEqual(status, { state: 'error', errorCategory: 'protocol' });
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

  assert.deepEqual(status, { state: 'error', errorCategory: 'auth' });
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
    await assert.rejects(async () => {
      for await (const _chunk of jsonResponseBody.body) { /* consume bounded JSON body */ }
    }, (error: unknown) => error instanceof GigaChatProviderError && error.category === 'network');
  } finally {
    transport.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
