import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GigaChatProvider, ProviderTurnRequest, RuntimeTurnSnapshot } from './contracts';
import type { LocalTools } from './local-tools';
import { createTurnRuntime } from './runtime';

const testTools = {} as LocalTools;

function makeProvider(stream: GigaChatProvider['stream']): GigaChatProvider {
  return { stream };
}

function requestFor(chatId: string): ProviderTurnRequest {
  return {
    system: [],
    messages: [{ id: chatId, role: 'user', text: chatId, createdAt: '2026-09-27T00:00:00.000Z' }],
    permissionProfile: 'ask',
  };
}

function makeRuntime(provider: GigaChatProvider | null, options: {
  appendAssistant?: (chatId: string, text: string) => Promise<void>;
  onUpdate?: (turn: RuntimeTurnSnapshot) => void;
} = {}) {
  return createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (chatId) => requestFor(chatId),
    appendAssistant: options.appendAssistant ?? (async () => undefined),
    ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime state.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('runs turns from two chats FIFO with one active adapter and appends only a completed answer', async () => {
  const firstGate = deferred();
  const started: string[] = [];
  const saved: Array<{ chatId: string; text: string }> = [];
  const provider = makeProvider(async function* (request) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') await firstGate.promise;
    yield { type: 'activity', activity: 'receiving' };
    yield { type: 'text-delta', text: `Ответ ${chatId}` };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, { appendAssistant: async (chatId, text) => { saved.push({ chatId, text }); } });
  const firstId = runtime.enqueue('chat-one');
  const secondId = runtime.enqueue('chat-two');
  assert.ok(firstId && secondId);
  await waitUntil(() => started.length === 1);
  assert.equal(runtime.list('chat-two')[0]?.status, 'queued');
  assert.deepEqual(started, ['chat-one']);

  firstGate.resolve();
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.deepEqual(saved, [
    { chatId: 'chat-one', text: 'Ответ chat-one' },
    { chatId: 'chat-two', text: 'Ответ chat-two' },
  ]);
  assert.equal(runtime.list('chat-one')[0]?.status, 'completed');
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
});

test('cancels a queued turn without starting it', async () => {
  const firstGate = deferred();
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') await firstGate.promise;
    yield { type: 'text-delta', text: 'Готово' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider);
  runtime.enqueue('chat-one');
  const queuedId = runtime.enqueue('chat-two');
  assert.ok(queuedId);
  await waitUntil(() => started.length === 1);
  assert.equal(runtime.cancel(queuedId), true);
  assert.equal(runtime.list('chat-two')[0]?.status, 'cancelled');
  firstGate.resolve();
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one']);
});

test('cancels an active turn, waits for it to stop, then starts the next turn', async () => {
  const firstStarted = deferred();
  const started: string[] = [];
  const provider = makeProvider(async function* (request, signal) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') {
      firstStarted.resolve();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
    }
    yield { type: 'text-delta', text: 'Ответ' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider);
  const activeId = runtime.enqueue('chat-one');
  const secondId = runtime.enqueue('chat-two');
  assert.ok(activeId && secondId);
  await firstStarted.promise;
  assert.equal(runtime.cancel(activeId), true);
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-one')[0]?.status, 'cancelled');
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
});

test('records a safe failure and starts the next turn after adapter error', async () => {
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') {
      yield { type: 'error', code: 'PRIVATE_PROVIDER_DETAIL', retryable: false };
      return;
    }
    yield { type: 'text-delta', text: 'Восстановились' };
    yield { type: 'completed' };
  });
  const saved: string[] = [];
  const runtime = makeRuntime(provider, { appendAssistant: async (_chatId, text) => { saved.push(text); } });
  const failedId = runtime.enqueue('chat-one');
  const recoveredId = runtime.enqueue('chat-two');
  assert.ok(failedId && recoveredId);
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-one')[0]?.status, 'failed');
  assert.match(runtime.list('chat-one')[0]?.error ?? '', /ошибкой/);
  assert.doesNotMatch(runtime.list('chat-one')[0]?.error ?? '', /PRIVATE_PROVIDER_DETAIL/);
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
  assert.deepEqual(saved, ['Восстановились']);
});

test('does not create a fake local turn when no provider is configured', () => {
  const updates: unknown[] = [];
  const runtime = makeRuntime(null, { onUpdate: (turn) => updates.push(turn) });
  assert.equal(runtime.enqueue('chat-one'), null);
  assert.deepEqual(runtime.list(), []);
  assert.deepEqual(updates, []);
});

test('keeps observable activity metadata and omits provider text from timeline snapshots', async () => {
  const provider = makeProvider(async function* () {
    yield { type: 'activity', activity: 'tool-started', tool: 'read' };
    yield { type: 'text-delta', text: 'Промежуточный текст ответа' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider);
  const id = runtime.enqueue('chat-one');
  assert.ok(id);
  await runtime.whenIdle();
  const snapshot = runtime.list('chat-one')[0];
  assert.equal(snapshot?.status, 'completed');
  assert.equal(snapshot?.activity[0]?.kind, 'provider');
  assert.equal(JSON.stringify(snapshot).includes('Промежуточный текст ответа'), false);
  assert.equal(typeof snapshot?.activeDurationMs, 'number');
});

test('rejects provider events after completion and does not append an incomplete answer', async () => {
  let appended = false;
  const provider = makeProvider(async function* () {
    yield { type: 'text-delta', text: 'Неполный ответ' };
    yield { type: 'completed' };
    yield { type: 'activity', activity: 'receiving' };
  });
  const runtime = makeRuntime(provider, { appendAssistant: async () => { appended = true; } });
  const id = runtime.enqueue('chat-one');
  assert.ok(id);
  await runtime.whenIdle();
  assert.equal(runtime.list('chat-one')[0]?.status, 'failed');
  assert.equal(appended, false);
});

test('treats cancellation during trusted assistant persistence as completed after commit', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const provider = makeProvider(async function* () {
    yield { type: 'text-delta', text: 'Ответ сохранится' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    appendAssistant: async () => {
      saveStarted.resolve();
      await saveGate.promise;
    },
  });
  const id = runtime.enqueue('chat-one');
  assert.ok(id);
  await saveStarted.promise;
  assert.equal(runtime.cancel(id), true);
  saveGate.resolve();
  await runtime.whenIdle();
  assert.equal(runtime.list('chat-one')[0]?.status, 'completed');
});
