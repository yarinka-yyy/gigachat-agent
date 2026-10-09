import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AcceptedTurnInput, ChatToolReceipt, GigaChatProvider, HookDispatchInput, HookRunResult, ProviderEvent, ProviderTurnRequest, RuntimeTurnSnapshot, UsageReceipt } from './contracts';
import type { LocalTools } from './local-tools';
import { LocalToolError } from './local-tools';
import { HookDispatchAbortError } from './hooks';
import { createTurnRuntime, type ToolReceiptInput, type ToolReceiptStart, type TurnRuntimeOptions } from './runtime';
import { mergeUsageReceipt } from './usage';

const testTools = {} as LocalTools;

function makeProvider(stream: GigaChatProvider['stream']): GigaChatProvider {
  return { stream };
}

let nextTurnNumber = 0;

function turnFor(chatId: string, text = chatId): AcceptedTurnInput {
  const turnId = `turn-${++nextTurnNumber}`;
  const message = { id: `message-${turnId}`, role: 'user' as const, text, createdAt: '2026-09-27T00:00:00.000Z' };
  return {
    turnId, chatId, projectId: null, projectWorkingFolder: null, messageId: message.id,
    historyBoundary: 1, messages: [message], modelId: 'GigaChat-2-Pro', permissionProfile: 'ask', skillId: null,
    reservation: { permissionProfileRevision: null, skillRevision: null },
  };
}

function requestFor(turn: AcceptedTurnInput): ProviderTurnRequest {
  return {
    system: [],
    modelId: turn.modelId,
    messages: structuredClone(turn.messages),
    permissionProfile: turn.permissionProfile,
  };
}

function makeRuntime(provider: GigaChatProvider | null, options: {
  appendAssistant?: (chatId: string, text: string, signal: AbortSignal, functionsStateId?: string) => Promise<void>;
  tools?: LocalTools;
  beginToolReceipt?: TurnRuntimeOptions['beginToolReceipt'];
  completeToolReceipt?: TurnRuntimeOptions['completeToolReceipt'];
  runHooks?: TurnRuntimeOptions['runHooks'];
  recordUsageReceipt?: TurnRuntimeOptions['recordUsageReceipt'];
  usageReceipts?: UsageReceipt[];
  timeouts?: TurnRuntimeOptions['timeouts'];
  onUpdate?: (turn: RuntimeTurnSnapshot) => void;
} = {}) {
  const usageReceipts = options.usageReceipts ?? [];
  const runtime = createTurnRuntime({
    provider,
    tools: options.tools ?? testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: options.appendAssistant
      ? async (turn, text, signal, functionsStateId) => options.appendAssistant?.(turn.chatId, text, signal, functionsStateId)
      : async () => undefined,
    recordUsageReceipt: options.recordUsageReceipt ?? (async (receipt) => {
      const index = usageReceipts.findIndex((item) => item.localRequestId === receipt.localRequestId);
      if (index < 0) usageReceipts.push(structuredClone(receipt));
      else usageReceipts[index] = mergeUsageReceipt(usageReceipts[index]!, receipt);
    }),
    ...(options.beginToolReceipt ? { beginToolReceipt: options.beginToolReceipt } : {}),
    ...(options.completeToolReceipt ? { completeToolReceipt: options.completeToolReceipt } : {}),
    ...(options.runHooks ? { runHooks: options.runHooks } : {}),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
  });
  return Object.assign(runtime, { usageReceipts });
}

function makeReceiptStore() {
  const receipts = new Map<string, ChatToolReceipt>();
  const keyFor = (receiptId: string, messageId: string): string => `${receiptId}:${messageId}`;
  return {
    receipts,
    begin: async (turn: AcceptedTurnInput, input: ToolReceiptInput): Promise<ToolReceiptStart> => {
      const key = keyFor(input.receiptId, turn.messageId);
      const existing = receipts.get(key);
      if (existing) {
        if (existing.status === 'pending') {
          const recovered = { ...existing, status: 'unknown' as const, result: JSON.stringify({ ok: false, status: 'unknown', error: 'effect_unknown' }) };
          receipts.set(key, recovered);
          return { shouldExecute: false, receipt: structuredClone(recovered) };
        }
        return { shouldExecute: false, receipt: structuredClone(existing) };
      }
      const earlierEffect = input.effectId
        ? [...receipts.values()].find((receipt) => receipt.effectId === input.effectId && receipt.anchorMessageId === turn.messageId)
        : undefined;
      if (earlierEffect) {
        const status = earlierEffect.status === 'completed' ? 'completed' : 'unknown';
        const receipt: ChatToolReceipt = {
          ...structuredClone(input), anchorMessageId: turn.messageId, status,
          result: status === 'completed' ? earlierEffect.result : JSON.stringify({ ok: false, status: 'unknown', error: 'effect_unknown' }),
          createdAt: new Date().toISOString(),
        };
        receipts.set(key, receipt);
        return { shouldExecute: false, receipt: structuredClone(receipt) };
      }
      const receipt: ChatToolReceipt = {
        ...structuredClone(input), anchorMessageId: turn.messageId, status: 'pending', result: null,
        createdAt: new Date().toISOString(),
      };
      receipts.set(key, receipt);
      return { shouldExecute: true, receipt: structuredClone(receipt) };
    },
    complete: async (turn: AcceptedTurnInput, receiptId: string, status: 'completed' | 'unknown', result: string): Promise<void> => {
      const key = keyFor(receiptId, turn.messageId);
      const receipt = receipts.get(key);
      if (!receipt || receipt.status !== 'pending') throw new Error('Receipt is not pending.');
      receipts.set(key, { ...receipt, status, result });
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function saveUsageReceipt(records: Map<string, UsageReceipt>, receipt: UsageReceipt): void {
  const existing = records.get(receipt.localRequestId);
  records.set(receipt.localRequestId, existing ? mergeUsageReceipt(existing, receipt) : structuredClone(receipt));
}

function functionCall(name: string, args: Record<string, unknown>, functionsStateId: string | null = null): ProviderEvent {
  return {
    type: 'function-call',
    functionCall: { name, arguments: args, content: null, functionsStateId, terminalReason: 'function_call' },
  };
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
  const firstId = runtime.enqueue(turnFor('chat-one'));
  const secondId = runtime.enqueue(turnFor('chat-two'));
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

test('records separate raw usage receipts for chat and tool-continuation requests', async () => {
  let streamCount = 0;
  const provider = makeProvider(async function* () {
    streamCount += 1;
    if (streamCount === 1) {
      yield { type: 'usage', promptTokens: 10, completionTokens: 2, totalTokens: 12, precachedPromptTokens: 3, providerRequestId: 'response-1' };
      yield functionCall('future-tool', {}, 'function-state-1');
      return;
    }
    yield { type: 'usage', promptTokens: 5, completionTokens: 1, totalTokens: 6, precachedPromptTokens: 1, providerRequestId: 'response-2' };
    yield { type: 'text-delta', text: 'Ответ после инструмента' };
    yield { type: 'completed' };
  });
  const receipts = makeReceiptStore();
  const runtime = makeRuntime(provider, { beginToolReceipt: receipts.begin, completeToolReceipt: receipts.complete });
  runtime.enqueue(turnFor('usage-chat'));
  await runtime.whenIdle();

  assert.equal(runtime.usageReceipts.length, 2);
  assert.deepEqual(runtime.usageReceipts.map((receipt) => receipt.requestKind), ['chat', 'tool-continuation']);
  assert.equal(new Set(runtime.usageReceipts.map((receipt) => receipt.localRequestId)).size, 2);
  assert.deepEqual(runtime.usageReceipts.map((receipt) => receipt.providerRequestId), ['response-1', 'response-2']);
  assert.deepEqual(runtime.usageReceipts.map((receipt) => receipt.totalTokens), [12, 6]);
  assert.deepEqual(runtime.usageReceipts.map((receipt) => receipt.status), ['completed', 'completed']);
});

test('preserves measured usage when the provider later reports an error', async () => {
  const provider = makeProvider(async function* (request) {
    if (request.messages[0]?.text === 'without usage') {
      yield { type: 'error', category: 'network', retryable: true };
      return;
    }
    if (request.messages[0]?.text === 'missing done') {
      yield { type: 'usage', promptTokens: 8, completionTokens: 2, totalTokens: 10, precachedPromptTokens: null };
      yield { type: 'error', category: 'protocol', retryable: false };
      return;
    }
    yield { type: 'usage', promptTokens: 21, completionTokens: null, totalTokens: 21, precachedPromptTokens: null };
    yield { type: 'error', category: 'network', retryable: true };
  });
  const runtime = makeRuntime(provider);
  runtime.enqueue(turnFor('usage-error', 'with usage'));
  runtime.enqueue(turnFor('usage-error-empty', 'without usage'));
  runtime.enqueue(turnFor('usage-error-missing-done', 'missing done'));
  await runtime.whenIdle();

  const measured = runtime.usageReceipts.find((receipt) => receipt.chatId === 'usage-error');
  const empty = runtime.usageReceipts.find((receipt) => receipt.chatId === 'usage-error-empty');
  const missingDone = runtime.usageReceipts.find((receipt) => receipt.chatId === 'usage-error-missing-done');
  assert.equal(runtime.usageReceipts.length, 3);
  assert.equal(measured?.status, 'failed');
  assert.equal(measured?.promptTokens, 21);
  assert.equal(measured?.completionTokens, null);
  assert.equal(measured?.totalTokens, 21);
  assert.equal(empty?.status, 'failed');
  assert.equal(empty?.promptTokens, null);
  assert.equal(empty?.totalTokens, null);
  assert.equal(missingDone?.status, 'failed');
  assert.equal(missingDone?.totalTokens, 10);
});

test('cancel during the initial usage save holds FIFO and never starts provider transport', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const records = new Map<string, UsageReceipt>();
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    started.push(request.messages[0]?.text ?? '');
    yield { type: 'text-delta', text: 'answer' };
    yield { type: 'completed' };
  });
  let blockInitialSave = true;
  const runtime = makeRuntime(provider, {
    timeouts: { operationMs: 1000 },
    recordUsageReceipt: async (receipt) => {
      if (receipt.chatId === 'usage-start-cancel' && receipt.status === 'pending' && blockInitialSave) {
        blockInitialSave = false;
        saveStarted.resolve();
        await saveGate.promise;
      }
      saveUsageReceipt(records, receipt);
    },
  });
  const firstId = runtime.enqueue(turnFor('usage-start-cancel', 'first'));
  runtime.enqueue(turnFor('usage-start-next', 'second'));
  assert.ok(firstId);
  await saveStarted.promise;
  assert.equal(runtime.cancel(firstId), true);
  await waitUntil(() => runtime.list('usage-start-cancel')[0]?.error?.includes('Сохранение usage') === true);
  assert.deepEqual(started, []);
  assert.equal(runtime.list('usage-start-next')[0]?.status, 'queued');
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);

  saveGate.resolve();
  await waitUntil(() => runtime.list('usage-start-next')[0]?.status === 'completed');
  await runtime.whenIdle();
  assert.deepEqual(started, ['second']);
  assert.equal([...records.values()].find((receipt) => receipt.chatId === 'usage-start-cancel')?.status, 'cancelled');
});

test('cancel during a measured usage save keeps counts and blocks the next FIFO stream until settlement', async () => {
  const updateStarted = deferred();
  const updateGate = deferred();
  const records = new Map<string, UsageReceipt>();
  const started: string[] = [];
  let blocked = false;
  const provider = makeProvider(async function* (request) {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    if (prompt === 'first') {
      yield { type: 'usage', promptTokens: 17, completionTokens: 4, totalTokens: 21, precachedPromptTokens: 6 };
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'completed' };
      return;
    }
    yield { type: 'text-delta', text: 'second response' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    timeouts: { operationMs: 1000 },
    recordUsageReceipt: async (receipt) => {
      if (!blocked && receipt.chatId === 'usage-measure-cancel' && receipt.totalTokens === 21) {
        blocked = true;
        updateStarted.resolve();
        await updateGate.promise;
      }
      saveUsageReceipt(records, receipt);
    },
  });
  const firstId = runtime.enqueue(turnFor('usage-measure-cancel', 'first'));
  runtime.enqueue(turnFor('usage-measure-next', 'second'));
  assert.ok(firstId);
  await updateStarted.promise;
  assert.equal(runtime.cancel(firstId), true);
  await waitUntil(() => runtime.list('usage-measure-cancel')[0]?.error?.includes('Сохранение usage') === true);
  assert.deepEqual(started, ['first']);
  assert.equal(runtime.list('usage-measure-next')[0]?.status, 'queued');

  updateGate.resolve();
  await waitUntil(() => runtime.list('usage-measure-next')[0]?.status === 'completed');
  await runtime.whenIdle();
  assert.deepEqual(started, ['first', 'second']);
  const cancelled = [...records.values()].find((receipt) => receipt.chatId === 'usage-measure-cancel');
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.promptTokens, 17);
  assert.equal(cancelled?.totalTokens, 21);
  assert.equal(cancelled?.precachedPromptTokens, 6);
});

test('ordinary cancellation after usage persistence saves a terminal receipt without a false pending stop', async () => {
  const waitingForStop = deferred();
  const stopGate = deferred();
  const records = new Map<string, UsageReceipt>();
  const updates: RuntimeTurnSnapshot[] = [];
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    if (prompt === 'first') {
      yield { type: 'usage', promptTokens: 7, completionTokens: 2, totalTokens: 9, precachedPromptTokens: 1 };
      waitingForStop.resolve();
      await stopGate.promise;
      return;
    }
    yield { type: 'text-delta', text: 'second' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    timeouts: { operationMs: 100, stopMs: 100 },
    onUpdate: (turn) => updates.push(turn),
    recordUsageReceipt: async (receipt) => saveUsageReceipt(records, receipt),
  });
  const firstId = runtime.enqueue(turnFor('usage-fast-cancel', 'first'));
  runtime.enqueue(turnFor('usage-fast-cancel-next', 'second'));
  assert.ok(firstId);
  await waitingForStop.promise;
  assert.equal(runtime.cancel(firstId), true);
  stopGate.resolve();
  await waitUntil(() => runtime.list('usage-fast-cancel-next')[0]?.status === 'completed');
  await runtime.whenIdle();

  const receipt = [...records.values()].find((item) => item.chatId === 'usage-fast-cancel');
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(receipt?.status, 'cancelled');
  assert.equal(receipt?.totalTokens, 9);
  assert.equal(updates.some((turn) => turn.chatId === 'usage-fast-cancel' && turn.error?.includes('Сохранение usage')), false);
});

test('cancel during final usage receipt save holds FIFO without discarding completed measurements', async () => {
  const finalSaveStarted = deferred();
  const finalSaveGate = deferred();
  const records = new Map<string, UsageReceipt>();
  const started: string[] = [];
  const appended: string[] = [];
  const provider = makeProvider(async function* (request) {
    started.push(request.messages[0]?.text ?? '');
    yield { type: 'usage', promptTokens: 9, completionTokens: 3, totalTokens: 12, precachedPromptTokens: 2 };
    yield { type: 'text-delta', text: 'answer' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    timeouts: { operationMs: 1000 },
    appendAssistant: async (chatId) => { appended.push(chatId); },
    recordUsageReceipt: async (receipt) => {
      if (receipt.chatId === 'usage-final-cancel' && receipt.status === 'completed') {
        finalSaveStarted.resolve();
        await finalSaveGate.promise;
      }
      saveUsageReceipt(records, receipt);
    },
  });
  const firstId = runtime.enqueue(turnFor('usage-final-cancel', 'first'));
  runtime.enqueue(turnFor('usage-final-next', 'second'));
  assert.ok(firstId);
  await finalSaveStarted.promise;
  assert.equal(runtime.cancel(firstId), true);
  await waitUntil(() => runtime.list('usage-final-cancel')[0]?.error?.includes('Сохранение usage') === true);
  assert.deepEqual(started, ['first']);
  assert.equal(runtime.list('usage-final-next')[0]?.status, 'queued');

  finalSaveGate.resolve();
  await waitUntil(() => runtime.list('usage-final-next')[0]?.status === 'completed');
  await runtime.whenIdle();
  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(appended, ['usage-final-next']);
  const completed = [...records.values()].find((receipt) => receipt.chatId === 'usage-final-cancel');
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.totalTokens, 12);
});

test('fails closed with storage category when initial usage receipt cannot be saved', async () => {
  let providerCalls = 0;
  const runtime = makeRuntime(makeProvider(async function* () {
    providerCalls += 1;
    yield { type: 'text-delta', text: 'must not run' };
    yield { type: 'completed' };
  }), {
    recordUsageReceipt: async () => { throw new Error('synthetic storage failure'); },
  });
  runtime.enqueue(turnFor('usage-start-failure'));
  await runtime.whenIdle();

  assert.equal(providerCalls, 0);
  assert.equal(runtime.list('usage-start-failure')[0]?.status, 'failed');
  assert.equal(runtime.list('usage-start-failure')[0]?.errorCategory, 'storage');
  assert.match(runtime.list('usage-start-failure')[0]?.error ?? '', /сохранить usage/i);
});

test('bounds a stalled initial usage save and holds the FIFO until it settles', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const records = new Map<string, UsageReceipt>();
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    started.push(request.messages[0]?.text ?? '');
    yield { type: 'text-delta', text: 'answer' };
    yield { type: 'completed' };
  });
  let blockInitialSave = true;
  const runtime = makeRuntime(provider, {
    timeouts: { operationMs: 20 },
    recordUsageReceipt: async (receipt) => {
      if (receipt.chatId === 'usage-timeout' && receipt.status === 'pending' && blockInitialSave) {
        blockInitialSave = false;
        saveStarted.resolve();
        await saveGate.promise;
      }
      saveUsageReceipt(records, receipt);
    },
  });
  runtime.enqueue(turnFor('usage-timeout', 'first'));
  runtime.enqueue(turnFor('usage-timeout-next', 'second'));
  await saveStarted.promise;
  await waitUntil(() => runtime.list('usage-timeout')[0]?.error?.includes('Сохранение usage') === true);

  assert.deepEqual(started, []);
  assert.equal(runtime.list('usage-timeout')[0]?.errorCategory, 'storage');
  assert.equal(runtime.list('usage-timeout-next')[0]?.status, 'queued');
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);

  saveGate.resolve();
  await waitUntil(() => runtime.list('usage-timeout-next')[0]?.status === 'completed');
  await runtime.whenIdle();
  assert.deepEqual(started, ['second']);
  assert.equal(runtime.list('usage-timeout')[0]?.status, 'failed');
  assert.equal(runtime.list('usage-timeout')[0]?.errorCategory, 'storage');
  assert.equal([...records.values()].find((receipt) => receipt.chatId === 'usage-timeout')?.status, 'failed');
});

test('does not start a provider request or advance FIFO before the pending usage receipt is saved', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    started.push(request.messages[0]?.text ?? '');
    yield { type: 'text-delta', text: 'saved' };
    yield { type: 'completed' };
  });
  let firstSave = true;
  const runtime = makeRuntime(provider, { recordUsageReceipt: async (receipt) => {
    if (firstSave && receipt.status === 'pending') {
      firstSave = false;
      saveStarted.resolve();
      await saveGate.promise;
    }
  } });
  runtime.enqueue(turnFor('usage-save-one', 'first'));
  runtime.enqueue(turnFor('usage-save-two', 'second'));
  await saveStarted.promise;
  assert.deepEqual(started, []);
  assert.equal(runtime.list('usage-save-two')[0]?.status, 'queued');
  saveGate.resolve();
  await runtime.whenIdle();
  assert.deepEqual(started, ['first', 'second']);
});

test('waits for usage update persistence before continuing after a function response', async () => {
  const updateStarted = deferred();
  const updateGate = deferred();
  let streamCount = 0;
  let blockedUpdate = false;
  const provider = makeProvider(async function* () {
    streamCount += 1;
    if (streamCount === 1) {
      yield { type: 'usage', promptTokens: 12, completionTokens: 2, totalTokens: 14, precachedPromptTokens: 4 };
      yield functionCall('future-tool', {});
      return;
    }
    yield { type: 'text-delta', text: 'done' };
    yield { type: 'completed' };
  });
  const receipts = makeReceiptStore();
  const runtime = makeRuntime(provider, {
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
    recordUsageReceipt: async (receipt) => {
      if (!blockedUpdate && receipt.totalTokens === 14) {
        blockedUpdate = true;
        updateStarted.resolve();
        await updateGate.promise;
      }
    },
  });
  runtime.enqueue(turnFor('usage-save-round-one'));
  runtime.enqueue(turnFor('usage-save-round-two'));
  await updateStarted.promise;
  assert.equal(streamCount, 1);
  assert.equal(runtime.list('usage-save-round-two')[0]?.status, 'queued');
  updateGate.resolve();
  await runtime.whenIdle();
  assert.equal(streamCount, 3);
});

test('keeps the accepted history boundary when preparation is delayed', async () => {
  const prepareGate = deferred();
  const started: string[][] = [];
  const accepted = turnFor('chat-one', 'B1');
  const provider = makeProvider(async function* (request) {
    started.push(request.messages.map((message) => message.text));
    yield { type: 'text-delta', text: 'Ответ B1' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => {
      await prepareGate.promise;
      return requestFor(turn);
    },
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    recordUsageReceipt: async () => undefined,
  });
  runtime.enqueue(accepted);
  accepted.messages.push({ id: 'message-b2', role: 'user', text: 'B2', createdAt: '2026-09-27T00:00:01.000Z' });
  prepareGate.resolve();
  await runtime.whenIdle();

  assert.deepEqual(started, [['B1']]);
});

test('ignores a late prepare result after its deadline and does not consume its reservation', async () => {
  const latePreparation = deferred();
  const started: string[] = [];
  const consumed: string[] = [];
  const provider = makeProvider(async function* (request) {
    const text = request.messages[0]?.text ?? '';
    started.push(text);
    yield { type: 'text-delta', text: `Ответ ${text}` };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => {
      if (turn.chatId === 'chat-one') await latePreparation.promise;
      return requestFor(turn);
    },
    consumeTurn: async (turn) => { consumed.push(turn.chatId); },
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    recordUsageReceipt: async () => undefined,
    timeouts: { prepareMs: 8, stopMs: 20 },
  });
  runtime.enqueue(turnFor('chat-one'));
  runtime.enqueue(turnFor('chat-two'));
  await waitUntil(() => runtime.list('chat-one')[0]?.status === 'failed');
  await runtime.whenIdle();
  latePreparation.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.deepEqual(started, ['chat-two']);
  assert.deepEqual(consumed, ['chat-two']);
});

test('cancels a queued turn without starting it', async () => {
  const firstGate = deferred();
  const started: string[] = [];
  const consumed: string[] = [];
  const provider = makeProvider(async function* (request) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') await firstGate.promise;
    yield { type: 'text-delta', text: 'Готово' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async (turn) => { consumed.push(turn.chatId); },
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    recordUsageReceipt: async () => undefined,
  });
  runtime.enqueue(turnFor('chat-one'));
  const queuedId = runtime.enqueue(turnFor('chat-two'));
  assert.ok(queuedId);
  await waitUntil(() => started.length === 1);
  assert.equal(runtime.cancel(queuedId), true);
  assert.equal(runtime.list('chat-two')[0]?.status, 'cancelled');
  firstGate.resolve();
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one']);
  assert.deepEqual(consumed, ['chat-one']);
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
  const activeId = runtime.enqueue(turnFor('chat-one'));
  const secondId = runtime.enqueue(turnFor('chat-two'));
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
      yield { type: 'error', category: 'auth', retryable: false };
      return;
    }
    yield { type: 'text-delta', text: 'Восстановились' };
    yield { type: 'completed' };
  });
  const saved: string[] = [];
  const runtime = makeRuntime(provider, { appendAssistant: async (_chatId, text) => { saved.push(text); } });
  const failedId = runtime.enqueue(turnFor('chat-one'));
  const recoveredId = runtime.enqueue(turnFor('chat-two'));
  assert.ok(failedId && recoveredId);
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-one')[0]?.status, 'failed');
  assert.match(runtime.list('chat-one')[0]?.error ?? '', /ошибкой/);
  assert.equal(runtime.list('chat-one')[0]?.errorCategory, 'auth');
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
  assert.deepEqual(saved, ['Восстановились']);
});

test('continues the queue after an assistant write rejects instead of treating it as an unknown timeout', async () => {
  const started: string[] = [];
  const provider = makeProvider(async function* (request) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    yield { type: 'text-delta', text: `Ответ ${chatId}` };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    appendAssistant: async (chatId) => {
      if (chatId === 'chat-one') throw new Error('synthetic disk failure');
    },
  });
  const failedId = runtime.enqueue(turnFor('chat-one'));
  const nextId = runtime.enqueue(turnFor('chat-two'));
  assert.ok(failedId && nextId);

  await runtime.whenIdle();

  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-one')[0]?.status, 'failed');
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
});

test('does not start the next stream until timed out iterator cleanup and its pending next are both acknowledged', async () => {
  const pendingNext = deferredValue<IteratorResult<ProviderEvent>>();
  const pendingReturn = deferredValue<IteratorResult<ProviderEvent>>();
  const started: string[] = [];
  let returnCalled = false;
  const provider = makeProvider((request) => {
    const text = request.messages[0]?.text ?? '';
    started.push(text);
    if (text === 'chat-one') {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => pendingNext.promise,
          return: () => { returnCalled = true; return pendingReturn.promise; },
        }),
      };
    }
    return (async function* () {
      yield { type: 'text-delta', text: 'Второй ответ' } as const;
      yield { type: 'completed' } as const;
    })();
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    recordUsageReceipt: async () => undefined,
    timeouts: { nextMs: 5, stopMs: 8, operationMs: 30 },
  });
  runtime.enqueue(turnFor('chat-one'));
  runtime.enqueue(turnFor('chat-two'));
  await waitUntil(() => returnCalled && runtime.list('chat-one')[0]?.status === 'failed');
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);
  assert.deepEqual(started, ['chat-one']);

  pendingReturn.resolve({ done: true, value: undefined });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(started, ['chat-one']);
  pendingNext.resolve({ done: true, value: undefined });
  await waitUntil(() => started.length === 2);
  await runtime.whenIdle();

  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
});

test('does not append or advance while a started local tool still lacks its terminal event', async () => {
  const started: string[] = [];
  const appended: string[] = [];
  const secondStreamEnded = deferred();
  const provider = makeProvider(async function* (request) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') {
      runtime.recordToolEvent({ id: 'owned-tool-a', tool: 'powershell', phase: 'started', at: new Date().toISOString() });
      yield { type: 'text-delta', text: 'Нельзя сохранять до завершения инструмента' };
      yield { type: 'completed' };
    } else {
      runtime.recordToolEvent({ id: 'owned-tool-b', tool: 'powershell', phase: 'started', at: new Date().toISOString() });
      yield { type: 'text-delta', text: 'Второй ход' };
      yield { type: 'completed' };
      secondStreamEnded.resolve();
    }
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async (turn) => { appended.push(turn.chatId); },
    recordUsageReceipt: async () => undefined,
    timeouts: { stopMs: 40 },
  });
  runtime.enqueue(turnFor('chat-one'));
  runtime.enqueue(turnFor('chat-two'));
  await waitUntil(() => runtime.list('chat-one')[0]?.error?.includes('локального инструмента') === true);
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);
  assert.deepEqual(started, ['chat-one']);
  assert.deepEqual(appended, []);

  runtime.recordToolEvent({ id: 'owned-tool-a', tool: 'powershell', phase: 'completed', at: new Date().toISOString() });
  await secondStreamEnded.promise;
  assert.deepEqual(started, ['chat-one', 'chat-two']);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(appended, []);
  runtime.recordToolEvent({ id: 'owned-tool-b', tool: 'powershell', phase: 'completed', at: new Date().toISOString() });
  await runtime.whenIdle();
  assert.deepEqual(appended, ['chat-two']);
  assert.ok(runtime.list('chat-one')[0]?.activity.some((item) => item.kind === 'tool' && item.phase === 'completed'));
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
});

test('aborted reservation commit does not consume a one-shot choice after a delayed store acknowledgement', async () => {
  const consumeStarted = deferred();
  const consumeGate = deferred();
  const started: string[] = [];
  const consumed: string[] = [];
  const provider = makeProvider(async function* (request, signal) {
    const chatId = request.messages[0]?.text ?? '';
    started.push(chatId);
    if (chatId === 'chat-one') {
      yield { type: 'text-delta', text: 'Первый ответ' };
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
    }
    yield { type: 'text-delta', text: 'Второй ответ' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async (turn, signal) => {
      if (turn.chatId !== 'chat-one') { consumed.push(turn.chatId); return; }
      consumeStarted.resolve();
      await consumeGate.promise;
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      consumed.push(turn.chatId);
    },
    releaseTurn: () => undefined,
    appendAssistant: async (turn) => { consumed.push(`append:${turn.chatId}`); },
    recordUsageReceipt: async () => undefined,
    timeouts: { stopMs: 20, operationMs: 8 },
  });
  runtime.enqueue(turnFor('chat-one'));
  runtime.enqueue(turnFor('chat-two'));
  await consumeStarted.promise;
  await waitUntil(() => runtime.list('chat-one')[0]?.error?.includes('Ожидание фиксации параметров') === true);
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);
  assert.deepEqual(started, ['chat-one']);
  consumeGate.resolve();
  await waitUntil(() => started.length === 2);
  await runtime.whenIdle();

  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(consumed.includes('chat-one'), false);
  assert.ok(consumed.includes('chat-two'));
});

test('does not append a response when cancellation arrives before the store commit boundary', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const saved: string[] = [];
  const provider = makeProvider(async function* () {
    yield { type: 'text-delta', text: 'Отменённый ответ' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async (turn, text, signal) => {
      saveStarted.resolve();
      await saveGate.promise;
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      saved.push(`${turn.chatId}:${text}`);
    },
    recordUsageReceipt: async () => undefined,
    timeouts: { operationMs: 100 },
  });
  const id = runtime.enqueue(turnFor('chat-one'));
  assert.ok(id);
  await saveStarted.promise;
  assert.equal(runtime.cancel(id), true);
  saveGate.resolve();
  await runtime.whenIdle();

  assert.deepEqual(saved, []);
  assert.equal(runtime.list('chat-one')[0]?.status, 'cancelled');
});

test('does not create a fake local turn when no provider is configured', () => {
  const updates: unknown[] = [];
  const runtime = makeRuntime(null, { onUpdate: (turn) => updates.push(turn) });
  assert.equal(runtime.enqueue(turnFor('chat-one')), null);
  assert.deepEqual(runtime.list(), []);
  assert.deepEqual(updates, []);
});

test('never calls a provider with an unset model', async () => {
  let called = false;
  let consumed = false;
  const runtime = createTurnRuntime({
    provider: makeProvider(async function* () { called = true; yield { type: 'completed' }; }),
    tools: testTools,
    prepareTurn: async (turn) => ({ ...requestFor(turn), modelId: null }),
    consumeTurn: async () => { consumed = true; },
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    recordUsageReceipt: async () => undefined,
  });
  runtime.enqueue(turnFor('chat-one'));
  await runtime.whenIdle();
  assert.equal(called, false);
  assert.equal(consumed, false);
  assert.match(runtime.list('chat-one')[0]?.error ?? '', /Выберите модель/);
});

test('publishes partial provider text while streaming and clears the draft after a completed save', async () => {
  const finishStream = deferred();
  const updates: RuntimeTurnSnapshot[] = [];
  const provider = makeProvider(async function* () {
    yield { type: 'activity', activity: 'tool-started', tool: 'read' };
    yield { type: 'text-delta', text: 'Промежуточный текст ответа' };
    await finishStream.promise;
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, { onUpdate: (turn) => updates.push(turn) });
  const id = runtime.enqueue(turnFor('chat-one'));
  assert.ok(id);
  await waitUntil(() => runtime.list('chat-one')[0]?.draft === 'Промежуточный текст ответа');
  const streaming = runtime.list('chat-one')[0];
  assert.equal(streaming?.status, 'running');
  assert.equal(streaming?.activity[0]?.kind, 'provider');
  assert.equal(JSON.stringify(streaming).includes('Промежуточный текст ответа'), true);

  finishStream.resolve();
  await runtime.whenIdle();
  const snapshot = runtime.list('chat-one')[0];
  assert.equal(snapshot?.status, 'completed');
  assert.equal(snapshot?.draft, undefined);
  assert.equal(JSON.stringify(snapshot).includes('Промежуточный текст ответа'), false);
  assert.equal(typeof snapshot?.activeDurationMs, 'number');
  assert.ok(updates.some((turn) => turn.status === 'running' && turn.draft === 'Промежуточный текст ответа'));
});

test('provider session cancellation keeps the partial draft and waits for stream stop before the next FIFO turn', async () => {
  const reset = deferred();
  const stopStarted = deferred();
  const allowStop = deferred();
  const started: string[] = [];
  const saved: string[] = [];
  const provider = makeProvider((request) => {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    if (prompt !== 'chat-one') {
      return (async function* () {
        yield { type: 'text-delta', text: 'Ответ второго хода' } as const;
        yield { type: 'completed' } as const;
      })();
    }
    return {
      [Symbol.asyncIterator]: () => {
        let state = 0;
        return {
          next: async (): Promise<IteratorResult<ProviderEvent>> => {
            if (state === 0) { state += 1; return { done: false, value: { type: 'text-delta', text: 'Частичный ответ' } }; }
            if (state === 1) {
              state += 1;
              await reset.promise;
              return { done: false, value: { type: 'error', category: 'cancel', retryable: false } };
            }
            return { done: true, value: undefined };
          },
          return: async (): Promise<IteratorResult<ProviderEvent>> => {
            stopStarted.resolve();
            await allowStop.promise;
            return { done: true, value: undefined };
          },
        };
      },
    };
  });
  const runtime = makeRuntime(provider, { appendAssistant: async (_chatId, text) => { saved.push(text); } });
  const firstId = runtime.enqueue(turnFor('chat-one'));
  const secondId = runtime.enqueue(turnFor('chat-two'));
  assert.ok(firstId && secondId);
  await waitUntil(() => runtime.list('chat-one')[0]?.draft === 'Частичный ответ');

  reset.resolve();
  await stopStarted.promise;
  assert.deepEqual(started, ['chat-one']);
  assert.deepEqual(saved, []);

  allowStop.resolve();
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-one')[0]?.status, 'cancelled');
  assert.equal(runtime.list('chat-one')[0]?.draft, 'Частичный ответ');
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
  assert.deepEqual(saved, ['Ответ второго хода']);
});

test('rejects provider events after completion and does not append an incomplete answer', async () => {
  let appended = false;
  const provider = makeProvider(async function* () {
    yield { type: 'text-delta', text: 'Неполный ответ' };
    yield { type: 'completed' };
    yield { type: 'activity', activity: 'receiving' };
  });
  const runtime = makeRuntime(provider, { appendAssistant: async () => { appended = true; } });
  const id = runtime.enqueue(turnFor('chat-one'));
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
  const id = runtime.enqueue(turnFor('chat-one'));
  assert.ok(id);
  await saveStarted.promise;
  assert.equal(runtime.cancel(id), true);
  saveGate.resolve();
  await runtime.whenIdle();
  assert.equal(runtime.list('chat-one')[0]?.status, 'completed');
});

test('never executes a function call from a provider round that fails before natural completion', async () => {
  let writes = 0;
  const receipts = makeReceiptStore();
  const provider = makeProvider(async function* () {
    yield functionCall('write', { path: 'notes.txt', contents: 'unsafe partial' }, 'state-write');
    yield { type: 'error', category: 'protocol', retryable: false };
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  });

  runtime.enqueue(turnFor('chat-one'));
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-one')[0]?.status, 'failed');
  assert.equal(writes, 0);
  assert.equal(receipts.receipts.size, 0);
});

test('continues GigaChat function rounds with fresh read results and saves the final state ID', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  const readResults: string[] = [];
  const expectedRoots: Array<string | null | undefined> = [];
  let writeCount = 0;
  let savedStateId: string | undefined;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    switch (request.protocolHistory?.length ?? 0) {
      case 0: yield functionCall('read', { path: 'same.txt' }); return;
      case 1: yield functionCall('write', { path: 'same.txt', contents: 'after' }); return;
      case 2: yield functionCall('read', { path: 'same.txt' }); return;
      default:
        yield { type: 'text-delta', text: 'Готово' };
        yield { type: 'completed', functionsStateId: 'state-final' };
    }
  });
  const tools = {
    read: async (_projectId: unknown, _profile: unknown, _path: unknown, options?: { expectedWorkingFolder?: string | null }) => {
      expectedRoots.push(options?.expectedWorkingFolder);
      const contents = readResults.length === 0 ? 'before' : 'after';
      readResults.push(contents);
      return { contents };
    },
    write: async (_projectId: unknown, _profile: unknown, _path: unknown, contents: unknown,
      options?: { expectedWorkingFolder?: string | null }) => {
      expectedRoots.push(options?.expectedWorkingFolder);
      writeCount += 1;
      assert.equal(contents, 'after');
      return { bytes: 5 };
    },
  } as unknown as LocalTools;
  const runtime = makeRuntime(provider, {
    tools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
    appendAssistant: async (_chatId, _text, _signal, stateId) => { savedStateId = stateId; },
  });
  const accepted = turnFor('chat-one');
  accepted.projectId = 'project-one';
  accepted.projectWorkingFolder = 'C:\\fixture\\project';
  runtime.enqueue(accepted);
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-one')[0]?.status, 'completed');
  assert.equal(writeCount, 1);
  assert.deepEqual(readResults, ['before', 'after']);
  assert.deepEqual(expectedRoots, [accepted.projectWorkingFolder, accepted.projectWorkingFolder, accepted.projectWorkingFolder]);
  assert.deepEqual(requests.map((request) => request.protocolHistory?.map((exchange) => exchange.name) ?? []), [[], ['read'], ['read', 'write'], ['read', 'write', 'read']]);
  assert.equal(JSON.parse(requests[1]?.protocolHistory?.[0]?.result ?? '{}').result.contents, 'before');
  assert.equal(JSON.parse(requests[3]?.protocolHistory?.[2]?.result ?? '{}').result.contents, 'after');
  assert.ok(requests.every((request) => request.modelId === accepted.modelId && request.permissionProfile === accepted.permissionProfile));
  assert.equal(savedStateId, 'state-final');
});

test('reports own-name prototype collisions as unknown functions without dispatching them', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  let toolCalls = 0;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    const round = request.protocolHistory?.length ?? 0;
    if (round < 2) yield functionCall(round === 0 ? 'toString' : '__proto__', {});
    else {
      yield { type: 'text-delta', text: 'Обработано безопасно' };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { list: async () => { toolCalls += 1; }, write: async () => { toolCalls += 1; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  });
  runtime.enqueue(turnFor('chat-one'));
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-one')[0]?.status, 'completed');
  assert.equal(toolCalls, 0);
  assert.deepEqual(requests.slice(1, 3).map((request) => {
    const history = request.protocolHistory ?? [];
    return JSON.parse(history[history.length - 1]?.result ?? '{}').error;
  }), [
    'unknown_function', 'unknown_function',
  ]);
  assert.deepEqual(runtime.list('chat-one')[0]?.activity
    .filter((activity) => activity.kind === 'provider' && activity.activity === 'waiting-for-tool')
    .map((activity) => activity.kind === 'provider' ? activity.tool ?? null : null), [null, null]);
});

test('records a proven permission denial as completed and returns permission_denied to GigaChat', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  let writes = 0;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    if (!request.protocolHistory?.length) yield functionCall('write', { path: 'locked.txt', contents: 'no' }, 'state-denied');
    else {
      yield { type: 'text-delta', text: 'Права нет' };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; throw new LocalToolError('Действие не подтверждено.', 'PERMISSION_DENIED'); } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  });
  runtime.enqueue(turnFor('chat-one'));
  await runtime.whenIdle();

  const result = JSON.parse(requests[1]?.protocolHistory?.[0]?.result ?? '{}') as { error?: string; status?: string };
  const receipt = [...receipts.receipts.values()][0];
  assert.equal(runtime.list('chat-one')[0]?.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(result.error, 'permission_denied');
  assert.equal(result.status, undefined);
  assert.equal(receipt?.status, 'completed');
});

test('does not replay a completed write when retry returns a new provider state ID', async () => {
  const receipts = makeReceiptStore();
  let writes = 0;
  let providerRound = 0;
  const provider = makeProvider(async function* (request) {
    providerRound += 1;
    if (providerRound === 1) {
      yield functionCall('write', { path: 'once.txt', contents: 'once' }, 'state-write-once');
    } else if (providerRound === 3) {
      yield functionCall('write', { path: 'once.txt', contents: 'once' }, 'state-write-replayed');
    } else if (providerRound === 2) yield { type: 'error', category: 'network', retryable: true };
    else {
      yield { type: 'text-delta', text: 'Завершено после повтора' };
      yield { type: 'completed' };
    }
  });
  const options = {
    tools: { write: async () => { writes += 1; return { bytes: 4 }; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  };
  const first = turnFor('chat-one', 'один запрос');
  const retryTemplate = turnFor('chat-one', 'retry');
  const retry = { ...retryTemplate, messageId: first.messageId, messages: structuredClone(first.messages) };
  const firstRuntime = makeRuntime(provider, options);
  firstRuntime.enqueue(first);
  await firstRuntime.whenIdle();
  assert.equal(firstRuntime.list('chat-one')[0]?.status, 'failed');
  assert.equal(writes, 1);

  const retryRuntime = makeRuntime(provider, options);
  retryRuntime.enqueue(retry);
  await retryRuntime.whenIdle();
  assert.equal(retryRuntime.list('chat-one')[0]?.status, 'completed');
  assert.equal(writes, 1);
});

test('resets stop confirmation for each provider round and holds FIFO until a cancelled follow-up confirms stop', async () => {
  const stopStarted = deferred();
  const allowStop = deferred();
  const followupNextStarted = deferred();
  const started: string[] = [];
  const saved: string[] = [];
  let writes = 0;
  const provider = makeProvider((request, signal) => {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    if (prompt === 'chat-one' && !request.protocolHistory?.length) {
      return (async function* () { yield functionCall('write', { path: 'done.txt', contents: 'done' }, 'state-write'); }());
    }
    if (prompt === 'chat-one') {
      return {
        [Symbol.asyncIterator]: () => {
          let step = 0;
          return {
            next: async (): Promise<IteratorResult<ProviderEvent>> => {
              if (step++ === 0) return { done: false, value: { type: 'text-delta', text: 'Частичный ответ' } };
              followupNextStarted.resolve();
              return await new Promise<IteratorResult<ProviderEvent>>((resolve) => {
                if (signal.aborted) resolve({ done: true, value: undefined });
                else signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
              });
            },
            return: async (): Promise<IteratorResult<ProviderEvent>> => {
              stopStarted.resolve();
              await allowStop.promise;
              return { done: true, value: undefined };
            },
          };
        },
      };
    }
    return (async function* () {
      yield { type: 'text-delta', text: 'Ответ второго хода' };
      yield { type: 'completed' };
    }());
  });
  const receipts = makeReceiptStore();
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; return { bytes: 4 }; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
    appendAssistant: async (_chatId, text) => { saved.push(text); },
    timeouts: { stopMs: 1000 },
  });
  const firstId = runtime.enqueue(turnFor('chat-one'));
  runtime.enqueue(turnFor('chat-two'));
  assert.ok(firstId);
  await followupNextStarted.promise;
  await waitUntil(() => runtime.list('chat-one')[0]?.draft === 'Частичный ответ');
  assert.equal(runtime.cancel(firstId), true);
  await stopStarted.promise;

  assert.deepEqual(started, ['chat-one', 'chat-one']);
  assert.equal(writes, 1);
  assert.deepEqual(saved, []);
  assert.equal(runtime.list('chat-two')[0]?.status, 'queued');

  allowStop.resolve();
  await runtime.whenIdle();
  assert.deepEqual(started, ['chat-one', 'chat-one', 'chat-two']);
  assert.equal(runtime.list('chat-one')[0]?.status, 'cancelled');
  assert.equal(runtime.list('chat-one')[0]?.draft, 'Частичный ответ');
  assert.equal(runtime.list('chat-two')[0]?.status, 'completed');
  assert.deepEqual(saved, ['Ответ второго хода']);
});

test('caps tool rounds before dispatching a ninth function call', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  let lists = 0;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    yield functionCall('list', { path: '' }, `state-${request.protocolHistory?.length ?? 0}`);
  });
  const runtime = makeRuntime(provider, {
    tools: { list: async () => { lists += 1; return []; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  });
  runtime.enqueue(turnFor('chat-round-limit'));
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-round-limit')[0]?.status, 'failed');
  assert.match(runtime.list('chat-round-limit')[0]?.error ?? '', /лимит последовательных вызовов/);
  assert.equal(requests.length, 9);
  assert.equal(lists, 8);
});

test('returns malformed function arguments to GigaChat without invoking a tool', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  let writes = 0;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    if (!request.protocolHistory?.length) {
      yield functionCall('write', { path: 'safe.txt', contents: 'text', unexpected: true }, 'state-invalid');
    } else {
      yield { type: 'text-delta', text: 'Аргументы отклонены' };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  });
  runtime.enqueue(turnFor('chat-invalid-arguments'));
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-invalid-arguments')[0]?.status, 'completed');
  assert.equal(writes, 0);
  assert.equal(JSON.parse(requests[1]?.protocolHistory?.[0]?.result ?? '{}').error, 'invalid_arguments');
});

test('bounds a tool result before returning it to GigaChat', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    if (!request.protocolHistory?.length) yield functionCall('read', { path: 'large.txt' }, 'state-large-read');
    else {
      yield { type: 'text-delta', text: 'Результат ограничен' };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { read: async () => 'x'.repeat(20 * 1024) } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
  });
  runtime.enqueue(turnFor('chat-result-limit'));
  await runtime.whenIdle();

  const result = requests[1]?.protocolHistory?.[0]?.result ?? '';
  assert.equal(runtime.list('chat-result-limit')[0]?.status, 'completed');
  assert.ok(Buffer.byteLength(result, 'utf8') <= 16 * 1024);
  assert.equal(JSON.parse(result).error, 'result_limit');
});

test('holds FIFO until a timed-out tool intent save settles without running the tool', async () => {
  const intentStarted = deferred();
  const allowIntentSave = deferred();
  const receipts = makeReceiptStore();
  const started: string[] = [];
  let writes = 0;
  const provider = makeProvider(async function* (request) {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    if (prompt === 'intent-first') yield functionCall('write', { path: 'never.txt', contents: 'no' }, 'state-intent');
    else {
      yield { type: 'text-delta', text: `Ответ ${prompt}` };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; } } as unknown as LocalTools,
    beginToolReceipt: async (turn, input) => {
      intentStarted.resolve();
      await allowIntentSave.promise;
      return receipts.begin(turn, input);
    },
    completeToolReceipt: receipts.complete,
    timeouts: { operationMs: 30, toolMs: 100, stopMs: 100 },
  });
  runtime.enqueue(turnFor('intent-first'));
  runtime.enqueue(turnFor('intent-second'));
  await intentStarted.promise;
  await waitUntil(() => runtime.list('intent-first')[0]?.error?.includes('намерения инструмента ожидается') ?? false);

  assert.deepEqual(started, ['intent-first']);
  assert.equal(runtime.list('intent-second')[0]?.status, 'queued');
  assert.equal(writes, 0);
  allowIntentSave.resolve();
  await waitUntil(() => started.length === 2);
  await runtime.whenIdle();

  assert.deepEqual(started, ['intent-first', 'intent-second']);
  assert.equal(runtime.list('intent-first')[0]?.status, 'failed');
  assert.equal(runtime.list('intent-second')[0]?.status, 'completed');
  assert.equal(writes, 0);
});

test('holds FIFO until a timed-out protocol result save settles after the write', async () => {
  const resultSaveStarted = deferred();
  const allowResultSave = deferred();
  const receipts = makeReceiptStore();
  const started: string[] = [];
  let writes = 0;
  const provider = makeProvider(async function* (request) {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    if (prompt === 'save-first') yield functionCall('write', { path: 'once.txt', contents: 'once' }, 'state-save');
    else {
      yield { type: 'text-delta', text: `Ответ ${prompt}` };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; return { bytes: 4 }; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: async (turn, receiptId, status, result) => {
      resultSaveStarted.resolve();
      await allowResultSave.promise;
      await receipts.complete(turn, receiptId, status, result);
    },
    timeouts: { operationMs: 100, toolMs: 30, stopMs: 100 },
  });
  runtime.enqueue(turnFor('save-first'));
  runtime.enqueue(turnFor('save-second'));
  await resultSaveStarted.promise;
  await waitUntil(() => runtime.list('save-first')[0]?.error?.includes('очередь приостановлена') ?? false);

  assert.deepEqual(started, ['save-first']);
  assert.equal(runtime.list('save-second')[0]?.status, 'queued');
  assert.equal(writes, 1);
  allowResultSave.resolve();
  await waitUntil(() => started.length === 2);
  await runtime.whenIdle();

  assert.deepEqual(started, ['save-first', 'save-second']);
  assert.equal(runtime.list('save-first')[0]?.status, 'failed');
  assert.equal(runtime.list('save-second')[0]?.status, 'completed');
  assert.equal(writes, 1);
  assert.equal([...receipts.receipts.values()][0]?.status, 'completed');
});

test('blocks a tool when its before-hook fails and stores a completed non-side-effect receipt', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  const hookInputs: HookDispatchInput[] = [];
  let writes = 0;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    if (!request.protocolHistory?.length) yield functionCall('write', { path: 'blocked.txt', contents: 'no' }, 'state-before-hook');
    else {
      yield { type: 'text-delta', text: 'Проверка остановила запись' };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; return { bytes: 2 }; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
    runHooks: async (_turn, input) => {
      hookInputs.push(input);
      return input.event === 'before-tool'
        ? [{ hookId: 'global/guard', hookName: 'Guard', event: input.event, status: 'failed', reason: 'invalid output' }]
        : [];
    },
  });
  runtime.enqueue(turnFor('chat-hook-before'));
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-hook-before')[0]?.status, 'completed');
  assert.equal(writes, 0);
  assert.deepEqual(hookInputs.map((input) => input.event), ['user-prompt-submitted', 'before-tool', 'stop']);
  assert.equal(JSON.parse(requests[1]?.protocolHistory?.[0]?.result ?? '{}').error, 'hook_blocked');
  const receipt = [...receipts.receipts.values()][0];
  assert.equal(receipt?.status, 'completed');
  assert.equal(JSON.parse(receipt?.result ?? '{}').error, 'hook_blocked');
});

test('after-hook failure records the real tool outcome and does not repeat a completed write', async () => {
  const receipts = makeReceiptStore();
  const requests: ProviderTurnRequest[] = [];
  const hookInputs: HookDispatchInput[] = [];
  let writes = 0;
  const provider = makeProvider(async function* (request) {
    requests.push(structuredClone(request));
    if (!request.protocolHistory?.length) yield functionCall('write', { path: 'once.txt', contents: 'once' }, 'state-after-hook');
    else {
      yield { type: 'text-delta', text: 'Запись выполнена один раз' };
      yield { type: 'completed' };
    }
  });
  const runtime = makeRuntime(provider, {
    tools: { write: async () => { writes += 1; return { bytes: 4 }; } } as unknown as LocalTools,
    beginToolReceipt: receipts.begin,
    completeToolReceipt: receipts.complete,
    runHooks: async (_turn, input): Promise<HookRunResult[]> => {
      hookInputs.push(input);
      return input.event === 'after-tool'
        ? [{ hookId: 'global/audit', hookName: 'Audit', event: input.event, status: 'failed', reason: 'invalid output' }]
        : [];
    },
  });
  runtime.enqueue(turnFor('chat-hook-after'));
  await runtime.whenIdle();

  assert.equal(runtime.list('chat-hook-after')[0]?.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(hookInputs.find((input) => input.event === 'after-tool')?.outcome, 'completed');
  assert.equal(JSON.parse(requests[1]?.protocolHistory?.[0]?.result ?? '{}').ok, true);
  assert.equal([...receipts.receipts.values()][0]?.status, 'completed');
  assert.ok(runtime.list('chat-hook-after')[0]?.activity.some((activity) => activity.kind === 'hook' && activity.status === 'failed'));
});

test('a failing stop-hook does not discard an already completed provider answer', async () => {
  const saved: string[] = [];
  const provider = makeProvider(async function* () {
    yield { type: 'text-delta', text: 'Ответ уже завершён' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    appendAssistant: async (_chatId, text) => { saved.push(text); },
    runHooks: async (_turn, input) => {
      if (input.event === 'stop') throw new Error('hook failed');
      return [];
    },
  });
  runtime.enqueue(turnFor('chat-hook-stop'));
  await runtime.whenIdle();

  assert.deepEqual(saved, ['Ответ уже завершён']);
  assert.equal(runtime.list('chat-hook-stop')[0]?.status, 'completed');
});

test('records hook results once when an active dispatcher aborts its turn', async () => {
  const provider = makeProvider(async function* () {
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    runHooks: async (_turn, input) => {
      if (input.event === 'user-prompt-submitted') {
        throw new HookDispatchAbortError([
          { hookId: 'global/first', hookName: 'First', event: input.event, status: 'completed' },
          { hookId: 'global/cancelled', hookName: 'Cancelled', event: input.event, status: 'cancelled', reason: 'Hook отменён вместе с текущим ходом.' },
        ]);
      }
      return [];
    },
  });
  runtime.enqueue(turnFor('chat-hook-abort'));
  await runtime.whenIdle();

  const turn = runtime.list('chat-hook-abort')[0];
  const hookActivity = turn?.activity.filter((activity) => activity.kind === 'hook') ?? [];
  assert.equal(turn?.status, 'cancelled');
  assert.equal(hookActivity.length, 2);
  assert.equal(hookActivity.filter((activity) => activity.kind === 'hook' && activity.hookId === 'global/first').length, 1);
  assert.equal(hookActivity.filter((activity) => activity.kind === 'hook' && activity.hookId === 'global/cancelled' && activity.status === 'cancelled').length, 1);
});
