import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
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
