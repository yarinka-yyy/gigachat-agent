import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AcceptedTurnInput, ChatToolReceipt, CompactSnapshot, GigaChatProvider, HookDispatchInput, HookRunResult, Project, ProviderEvent, ProviderTurnRequest, RuntimeTurnSnapshot, UsageReceipt } from './contracts';
import type { CustomPolicy } from './custom-permissions';
import type { LocalTools, LocalToolsOptions, PowerShellRequest } from './local-tools';
import { createLocalTools, LocalToolError } from './local-tools';
import { createHookApprovalGate, createHookDispatcher, createHookRegistry, HookDispatchAbortError, type HookExecutionContext } from './hooks';
import { createTurnRuntime, queueAcceptedTurnOrMarkNotSent, type PreparedTurn, type ToolReceiptInput, type ToolReceiptStart, type TurnRuntimeOptions } from './runtime';
import { mergeUsageReceipt } from './usage';
import { createBalanceScopeGuard } from './usage-view';
import {
  HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE,
  assertProviderStateOwner,
  captureProviderStateOwner,
  filterProviderStateForOutboundRequest,
} from './provider-state';
import { MISSING_REMOTE_ATTACHMENT_MESSAGE, prepareTurnAttachments } from './attachments';
import { serializeProviderTurnRequest } from './gigachat-provider';
import { openStore, type LocalStore } from './store';

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
    assistantMessageId: `assistant-${turnId}`,
    historyBoundary: 1, messages: [message], modelId: 'GigaChat-2-Pro', permissionProfile: 'ask', skillId: null,
    reservation: { permissionProfileRevision: null, skillRevision: null },
  };
}

function compactionTurnFor(chatId: string): AcceptedTurnInput {
  const turn = turnFor(chatId, 'Сожми историю');
  return {
    ...turn,
    assistantMessageId: null,
    operation: 'compaction',
    compactBoundaryMessageId: turn.messageId,
    compactExpectedSnapshotId: null,
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
  appendAssistant?: (chatId: string, text: string, signal: AbortSignal, functionsStateId?: string, acceptedTurn?: AcceptedTurnInput, terminalTurn?: RuntimeTurnSnapshot) => Promise<void>;
  tools?: LocalTools;
  beginToolReceipt?: TurnRuntimeOptions['beginToolReceipt'];
  completeToolReceipt?: TurnRuntimeOptions['completeToolReceipt'];
  runHooks?: TurnRuntimeOptions['runHooks'];
  recordUsageReceipt?: TurnRuntimeOptions['recordUsageReceipt'];
  usageReceipts?: UsageReceipt[];
  timeouts?: TurnRuntimeOptions['timeouts'];
  validateRetry?: TurnRuntimeOptions['validateRetry'];
  releaseTurn?: TurnRuntimeOptions['releaseTurn'];
  onUpdate?: (turn: RuntimeTurnSnapshot) => void;
} = {}) {
  const usageReceipts = options.usageReceipts ?? [];
  const runtime = createTurnRuntime({
    provider,
    tools: options.tools ?? testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: options.releaseTurn ?? (() => undefined),
    appendAssistant: options.appendAssistant
      ? async (turn, text, signal, functionsStateId, terminalTurn) => options.appendAssistant?.(turn.chatId, text, signal, functionsStateId, turn, terminalTurn)
      : async () => undefined,
    recordUsageReceipt: options.recordUsageReceipt ?? (async (receipt) => {
      const index = usageReceipts.findIndex((item) => item.localRequestId === receipt.localRequestId);
      if (index < 0) usageReceipts.push(structuredClone(receipt));
      else usageReceipts[index] = mergeUsageReceipt(usageReceipts[index]!, receipt);
    }),
    ...(options.beginToolReceipt ? { beginToolReceipt: options.beginToolReceipt } : {}),
    ...(options.completeToolReceipt ? { completeToolReceipt: options.completeToolReceipt } : {}),
    ...(options.runHooks ? { runHooks: options.runHooks } : {}),
    ...(options.validateRetry ? { validateRetry: options.validateRetry } : {}),
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

function makeOwnedStoreRuntime(
  store: LocalStore,
  provider: GigaChatProvider,
  loadAuthorizationKey: () => Promise<string | null>,
  tools: LocalTools = testTools,
  filterOutboundState = false,
  guard = createBalanceScopeGuard(),
) {
  let providerRequestPreparationCount = 0;
  const runtime = createTurnRuntime({
    provider,
    tools,
    prepareTurn: async (turn, signal): Promise<ProviderTurnRequest | PreparedTurn> => {
      const providerStateOwner = await captureProviderStateOwner(guard, loadAuthorizationKey, signal);
      await store.validateAcceptedTurn(turn);
      let request: ProviderTurnRequest;
      let compaction: PreparedTurn['compaction'];
      if (turn.operation === 'compaction') {
        const prefix = await store.getCompactionPrefix(turn.chatId, turn.compactBoundaryMessageId);
        request = {
          system: [], messages: prefix.messages, protocolHistory: prefix.protocolHistory,
          permissionProfile: turn.permissionProfile, modelId: turn.modelId,
          usageKind: 'compaction', functionCallMode: 'none',
        };
        compaction = {
          boundaryMessageId: turn.compactBoundaryMessageId!,
          coveredThroughMessageId: prefix.coveredThroughMessageId,
          coveredPrefixHash: prefix.coveredPrefixHash,
          expectedSnapshotId: turn.compactExpectedSnapshotId ?? null,
          provenance: 'provider',
        };
      } else {
        request = {
          system: [],
          messages: await store.getMessagesThrough(turn.chatId, turn.messageId),
          protocolHistory: await store.getToolProtocolThrough(turn.chatId, turn.messageId),
          permissionProfile: turn.permissionProfile,
          modelId: turn.modelId,
        };
      }
      if (filterOutboundState) {
        assertProviderStateOwner(providerStateOwner, guard, signal);
        const detail = await store.getChat(turn.chatId);
        assertProviderStateOwner(providerStateOwner, guard, signal);
        const ownership = await store.getProviderStateOwnership(turn.chatId, providerStateOwner.accountScope);
        assertProviderStateOwner(providerStateOwner, guard, signal);
        request = filterProviderStateForOutboundRequest({
          request,
          detail,
          rawMessages: request.messages,
          rawProtocolHistory: request.protocolHistory ?? [],
          ownership,
          currentAnchorMessageId: turn.operation === 'compaction' ? null : turn.messageId,
        }).request;
      }
      assertProviderStateOwner(providerStateOwner, guard, signal);
      return { request, providerStateOwner, ...(compaction ? { compaction } : {}) };
    },
    assertProviderStateOwner: (owner, signal) => assertProviderStateOwner(owner, guard, signal),
    prepareProviderRequest: async (_turn, request, signal, owner) => {
      assertProviderStateOwner(owner, guard, signal);
      providerRequestPreparationCount += 1;
      return request;
    },
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    beginToolReceipt: (turn, receipt, owner) => {
      assertProviderStateOwner(owner, guard);
      return store.beginToolReceipt(turn.chatId, turn.messageId, receipt,
        receipt.functionsStateId ? owner.accountScope : undefined);
    },
    completeToolReceipt: (turn, receiptId, status, result) =>
      store.completeToolReceipt(turn.chatId, turn.messageId, receiptId, status, result),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn, owner) => {
      assertProviderStateOwner(owner, guard, signal);
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal, functionsStateId,
        functionsStateId ? owner.accountScope : undefined);
    },
    appendCompaction: async (turn, text, signal, context, terminalTurn, functionsStateId, owner) => {
      assertProviderStateOwner(owner, guard, signal);
      const snapshot: CompactSnapshot = {
        id: `snapshot-${turn.turnId}`, version: 1,
        boundaryMessageId: context.boundaryMessageId,
        coveredThroughMessageId: context.coveredThroughMessageId,
        coveredPrefixHash: context.coveredPrefixHash,
        text,
        modelId: turn.modelId ?? (() => { throw new Error('Missing fixture model.'); })(),
        provenance: 'provider',
        createdAt: new Date().toISOString(),
      };
      await store.commitCompactSnapshot(turn.chatId, snapshot, context.expectedSnapshotId, signal, terminalTurn,
        functionsStateId ? { accountScope: owner.accountScope, functionsStateId } : undefined);
    },
    compactionEnabled: true,
    recordUsageReceipt: async () => undefined,
  });
  return { runtime, guard, providerRequestPreparationCount: () => providerRequestPreparationCount };
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

test('accepted turns blocked from queueing persist not-sent before releasing their reservation', async () => {
  for (const blockedBy of ['disconnected', 'unavailable model']) {
    const calls: string[] = [];
    const result = await queueAcceptedTurnOrMarkNotSent({
      shouldQueue: false,
      enqueue: () => { calls.push('enqueue'); return 'turn'; },
      markNotSent: async () => { calls.push('persist'); return blockedBy; },
      releaseReservation: () => { calls.push('release'); },
    });
    assert.deepEqual(result, { queued: false, persisted: blockedBy });
    assert.deepEqual(calls, ['persist', 'release']);
  }

  for (const enqueue of [() => null, () => { throw new Error('synthetic queue failure'); }]) {
    const calls: string[] = [];
    const result = await queueAcceptedTurnOrMarkNotSent({
      shouldQueue: true,
      enqueue: () => { calls.push('enqueue'); return enqueue(); },
      markNotSent: async () => { calls.push('persist'); return 'saved'; },
      releaseReservation: () => { calls.push('release'); },
    });
    assert.deepEqual(result, { queued: false, persisted: 'saved' });
    assert.deepEqual(calls, ['enqueue', 'persist', 'release']);
  }

  const queuedCalls: string[] = [];
  const queued = await queueAcceptedTurnOrMarkNotSent({
    shouldQueue: true,
    enqueue: () => { queuedCalls.push('enqueue'); return 'turn'; },
    markNotSent: async () => { queuedCalls.push('persist'); return undefined; },
    releaseReservation: () => { queuedCalls.push('release'); },
  });
  assert.deepEqual(queued, { queued: true });
  assert.deepEqual(queuedCalls, ['enqueue']);

  const failedSaveCalls: string[] = [];
  await assert.rejects(queueAcceptedTurnOrMarkNotSent({
    shouldQueue: false,
    enqueue: () => { failedSaveCalls.push('enqueue'); return 'turn'; },
    markNotSent: async () => { failedSaveCalls.push('persist'); throw new Error('synthetic terminal save failure'); },
    releaseReservation: () => { failedSaveCalls.push('release'); },
  }), /synthetic terminal save failure/);
  assert.deepEqual(failedSaveCalls, ['persist', 'release']);
});

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

test('runtime keeps the FIFO turn running until assistant and completed turn persist atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-turn-commit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const first = await store.acceptLocalMessage(chat.id, 'first accepted request', 'turn-commit-first');
  const second = await store.acceptLocalMessage(chat.id, 'second accepted request', 'turn-commit-second');
  const finalSaveStarted = deferred();
  const allowFirstSave = deferred();
  let providerStarts = 0;
  const provider = makeProvider(async function* () {
    providerStarts += 1;
    yield { type: 'text-delta', text: `answer-${providerStarts}` };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider, tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      if (turn.turnId === first.turn.turnId) {
        finalSaveStarted.resolve();
        await allowFirstSave.promise;
      }
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal, functionsStateId);
    },
    recordUsageReceipt: async () => undefined,
  });

  assert.ok(runtime.enqueue(first.turn));
  assert.ok(runtime.enqueue(second.turn));
  await finalSaveStarted.promise;

  assert.equal(runtime.list().find((turn) => turn.id === first.turn.turnId)?.status, 'running');
  assert.equal(runtime.list().find((turn) => turn.id === second.turn.turnId)?.status, 'queued');
  assert.equal(providerStarts, 1, 'the next provider request waits for the first durable final save');
  const pendingDetail = await store.getChat(chat.id);
  assert.equal(pendingDetail.messages.some((message) => message.role === 'assistant'), false);
  assert.equal(pendingDetail.turns.find((turn) => turn.turnId === first.turn.turnId)?.status, 'running');

  allowFirstSave.resolve();
  await runtime.whenIdle();

  const detail = await (await openStore(directory)).getChat(chat.id);
  assert.equal(providerStarts, 2);
  assert.deepEqual(detail.messages.map((message) => [message.role, message.text]), [
    ['user', 'first accepted request'], ['assistant', 'answer-1'],
    ['user', 'second accepted request'], ['assistant', 'answer-2'],
  ]);
  assert.deepEqual(detail.turns.map((turn) => [turn.turnId, turn.anchorMessageId, turn.assistantMessageId, turn.status]), [
    [first.turn.turnId, first.turn.messageId, first.turn.assistantMessageId, 'completed'],
    [second.turn.turnId, second.turn.messageId, second.turn.assistantMessageId, 'completed'],
  ]);
});

test('persists scoped Hook activity IDs and multiline provider progress through runtime and store reload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-scoped-hook-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const project = await store.createProject('Scoped Hook record', directory);
  const chat = await store.createChat(project.id);
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Read the document safely.', 'turn-scoped-hooks');
  const progress = 'Страница 1:\nчитаю\tготово';
  const provider = makeProvider(async function* () {
    yield { type: 'activity', activity: 'function-progress', functionName: 'get_file_content', detail: progress };
    yield { type: 'text-delta', text: 'Содержимое прочитано.' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider, tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal, functionsStateId);
    },
    recordUsageReceipt: async () => undefined,
    runHooks: async (_turn, input) => input.event === 'user-prompt-submitted' ? [
      { hookId: 'global/guard', hookName: 'Guard', event: input.event, status: 'completed' },
      { hookId: `project/${project.id}/audit`, hookName: 'Audit', event: input.event, status: 'completed' },
      { hookId: 'skill/global/reader/guard', hookName: 'Global Skill guard', event: input.event, status: 'completed' },
      { hookId: `skill/project/${project.id}/reader/audit`, hookName: 'Project Skill audit', event: input.event, status: 'completed' },
    ] : [],
  });

  runtime.enqueue(accepted.turn);
  await runtime.whenIdle();

  const restored = await (await openStore(directory)).getChat(chat.id);
  const record = restored.turns.find((turn) => turn.turnId === accepted.turn.turnId);
  assert.equal(record?.status, 'completed');
  assert.deepEqual(record?.activity.filter((item) => item.kind === 'hook').map((item) => item.kind === 'hook' ? item.hookId : ''), [
    'global/guard', `project/${project.id}/audit`, 'skill/global/reader/guard', `skill/project/${project.id}/reader/audit`,
  ]);
  assert.equal(record?.activity.find((item) => item.kind === 'provider' && item.activity === 'function-progress')?.kind, 'provider');
  const savedProgress = record?.activity.find((item) => item.kind === 'provider' && item.activity === 'function-progress');
  assert.equal(savedProgress?.kind === 'provider' ? savedProgress.detail : undefined, progress);
  assert.equal(restored.messages.find((message) => message.id === accepted.turn.assistantMessageId)?.text, 'Содержимое прочитано.');
});

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

test('keeps provider built-in file progress in activity instead of answer text or local tool dispatch', async () => {
  let localToolCalls = 0;
  const saved: string[] = [];
  const provider = makeProvider(async function* () {
    yield { type: 'activity', activity: 'function-progress', functionName: 'get_file_content', detail: 'Осталось:\n2 секунды\tпроверяем' };
    yield { type: 'text-delta', text: 'Прочитанное содержимое' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    tools: { read: async () => { localToolCalls += 1; } } as unknown as LocalTools,
    appendAssistant: async (_chatId, text) => { saved.push(text); },
  });

  runtime.enqueue(turnFor('file-progress-chat'));
  await runtime.whenIdle();

  const turn = runtime.list('file-progress-chat')[0]!;
  assert.equal(turn.status, 'completed');
  assert.equal(localToolCalls, 0);
  assert.deepEqual(saved, ['Прочитанное содержимое']);
  assert.deepEqual(turn.activity.filter((item) => item.kind === 'provider' && item.activity === 'function-progress')
    .map((item) => item.kind === 'provider' ? { functionName: item.functionName, detail: item.detail } : null), [
      { functionName: 'get_file_content', detail: 'Осталось:\n2 секунды\tпроверяем' },
    ]);
  assert.doesNotMatch(saved.join(' '), /Осталось:|2 секунды|get_file_content/);
});

test('holds FIFO through delayed compaction save and its single after hook', async () => {
  const saveStarted = deferred();
  const allowSave = deferred();
  const afterHookStarted = deferred();
  const allowAfterHook = deferred();
  const started: string[] = [];
  const hookEvents: string[] = [];
  let summarySaved = false;
  const provider = makeProvider(async function* (request) {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    yield { type: 'text-delta', text: prompt === 'Сожми историю' ? 'Сводка истории' : 'Ответ после сжатия' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn): Promise<ProviderTurnRequest | { request: ProviderTurnRequest; compaction: {
      boundaryMessageId: string; coveredThroughMessageId: string; coveredPrefixHash: string;
      expectedSnapshotId: string | null; provenance: 'fixture';
    } }> => turn.operation === 'compaction'
      ? {
        request: requestFor(turn),
        compaction: {
          boundaryMessageId: turn.messageId,
          coveredThroughMessageId: turn.messageId,
          coveredPrefixHash: 'a'.repeat(64),
          expectedSnapshotId: null,
          provenance: 'fixture',
        },
      }
      : requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    appendCompaction: async () => {
      saveStarted.resolve();
      await allowSave.promise;
      summarySaved = true;
    },
    compactionEnabled: true,
    recordUsageReceipt: async () => undefined,
    runHooks: async (_turn, input) => {
      hookEvents.push(input.event);
      if (input.event === 'after-compaction') {
        afterHookStarted.resolve();
        await allowAfterHook.promise;
      }
      return [];
    },
    timeouts: { operationMs: 20, stopMs: 1000 },
  });
  const compactId = runtime.enqueueCompaction(compactionTurnFor('chat-compact'));
  assert.ok(compactId);
  const nextId = runtime.enqueue(turnFor('chat-next'));
  assert.ok(nextId);
  await saveStarted.promise;
  await waitUntil(() => runtime.list('chat-compact')[0]?.error?.includes('сохранения ответа ожидается') === true);

  assert.deepEqual(started, ['Сожми историю']);
  assert.equal(runtime.list('chat-next')[0]?.status, 'queued');
  assert.equal(summarySaved, false);
  assert.equal(hookEvents.filter((event) => event === 'after-compaction').length, 0);

  allowSave.resolve();
  await afterHookStarted.promise;
  assert.equal(summarySaved, true);
  assert.deepEqual(started, ['Сожми историю']);
  assert.equal(runtime.list('chat-next')[0]?.status, 'queued');
  assert.equal(hookEvents.filter((event) => event === 'after-compaction').length, 1);

  allowAfterHook.resolve();
  await waitUntil(() => runtime.list('chat-compact')[0]?.status === 'completed');
  await runtime.whenIdle();
  assert.deepEqual(started, ['Сожми историю', 'chat-next']);
  assert.equal(runtime.list('chat-compact')[0]?.status, 'completed');
  assert.equal(runtime.list('chat-next')[0]?.status, 'completed');
  assert.equal(hookEvents.filter((event) => event === 'after-compaction').length, 1);
});

test('a rejected compaction append skips the after hook and releases FIFO only after settlement', async () => {
  const saveStarted = deferred();
  let rejectSave!: (error: Error) => void;
  const pendingSave = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const started: string[] = [];
  const hookEvents: string[] = [];
  const provider = makeProvider(async function* (request) {
    const prompt = request.messages[0]?.text ?? '';
    started.push(prompt);
    yield { type: 'text-delta', text: prompt === 'Сожми историю' ? 'Сводка истории' : 'Ответ следующего хода' };
    yield { type: 'completed' };
  });
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn): Promise<ProviderTurnRequest | { request: ProviderTurnRequest; compaction: {
      boundaryMessageId: string; coveredThroughMessageId: string; coveredPrefixHash: string;
      expectedSnapshotId: string | null; provenance: 'fixture';
    } }> => turn.operation === 'compaction'
      ? {
        request: requestFor(turn),
        compaction: {
          boundaryMessageId: turn.compactBoundaryMessageId!,
          coveredThroughMessageId: turn.messageId,
          coveredPrefixHash: 'e'.repeat(64),
          expectedSnapshotId: null,
          provenance: 'fixture',
        },
      }
      : requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    appendCompaction: async () => {
      saveStarted.resolve();
      await pendingSave;
    },
    compactionEnabled: true,
    recordUsageReceipt: async () => undefined,
    runHooks: async (_turn, input) => { hookEvents.push(input.event); return []; },
  });

  const compactId = runtime.enqueueCompaction(compactionTurnFor('chat-compact-rejected-save'));
  assert.ok(compactId);
  const nextId = runtime.enqueue(turnFor('chat-after-rejected-compact'));
  assert.ok(nextId);
  await saveStarted.promise;

  assert.deepEqual(started, ['Сожми историю']);
  assert.equal(runtime.list('chat-after-rejected-compact')[0]?.status, 'queued');
  assert.equal(hookEvents.includes('after-compaction'), false);

  rejectSave(new Error('synthetic compaction append failure'));
  await waitUntil(() => runtime.list('chat-after-rejected-compact')[0]?.status === 'completed');
  assert.equal(runtime.list('chat-compact-rejected-save')[0]?.status, 'failed');
  assert.deepEqual(started, ['Сожми историю', 'chat-after-rejected-compact']);
  assert.equal(hookEvents.includes('after-compaction'), false);
});

test('keeps production compaction disabled and refuses unexpected summarizer function calls', async () => {
  const input = compactionTurnFor('chat-compact-disabled');
  const provider = makeProvider(async function* () {
    yield functionCall('write', { path: 'must-not-exist.txt', contents: 'no side effect' }, 'unexpected-state');
  });
  const disabled = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => requestFor(turn),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    appendCompaction: async () => undefined,
    recordUsageReceipt: async () => undefined,
  });
  assert.equal(disabled.enqueueCompaction(input), null);
  assert.deepEqual(disabled.list(), []);

  let writes = 0;
  let snapshots = 0;
  const hookEvents: string[] = [];
  const fixture = createTurnRuntime({
    provider,
    tools: { write: async () => { writes += 1; } } as unknown as LocalTools,
    prepareTurn: async (turn): Promise<ProviderTurnRequest | { request: ProviderTurnRequest; compaction: {
      boundaryMessageId: string; coveredThroughMessageId: string; coveredPrefixHash: string;
      expectedSnapshotId: string | null; provenance: 'fixture';
    } }> => ({
      request: { ...requestFor(turn), functionCallMode: 'none' },
      compaction: {
        boundaryMessageId: turn.messageId,
        coveredThroughMessageId: turn.messageId,
        coveredPrefixHash: 'b'.repeat(64),
        expectedSnapshotId: null,
        provenance: 'fixture',
      },
    }),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    appendCompaction: async () => { snapshots += 1; },
    compactionEnabled: true,
    recordUsageReceipt: async () => undefined,
    runHooks: async (_turn, input) => { hookEvents.push(input.event); return []; },
  });
  assert.ok(fixture.enqueueCompaction(input));
  await fixture.whenIdle();
  assert.equal(fixture.list('chat-compact-disabled')[0]?.status, 'failed');
  assert.equal(writes, 0);
  assert.equal(snapshots, 0);
  assert.equal(hookEvents.filter((event) => event === 'before-compaction').length, 1);
  assert.equal(hookEvents.filter((event) => event === 'after-compaction').length, 0);
});

test('pre-compaction Hook blocks provider work and provider errors never commit a summary', async () => {
  let providerCalls = 0;
  let snapshots = 0;
  const hookEvents: string[] = [];
  const provider = makeProvider(async function* () {
    providerCalls += 1;
    yield { type: 'error', category: 'network', retryable: true };
  });
  const makeCompactionRuntime = (blocked: boolean) => createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn): Promise<ProviderTurnRequest | { request: ProviderTurnRequest; compaction: {
      boundaryMessageId: string; coveredThroughMessageId: string; coveredPrefixHash: string;
      expectedSnapshotId: string | null; provenance: 'fixture';
    } }> => ({
      request: requestFor(turn),
      compaction: {
        boundaryMessageId: turn.compactBoundaryMessageId!,
        coveredThroughMessageId: turn.messageId,
        coveredPrefixHash: 'c'.repeat(64),
        expectedSnapshotId: null,
        provenance: 'fixture',
      },
    }),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    appendCompaction: async () => { snapshots += 1; },
    compactionEnabled: true,
    recordUsageReceipt: async () => undefined,
    runHooks: async (_turn, input): Promise<HookRunResult[]> => {
      hookEvents.push(`${input.event}${blocked ? ':blocked-case' : ':provider-error-case'}`);
      return input.event === 'before-compaction' && blocked
        ? [{ hookId: 'fixture-block', hookName: 'Fixture', event: input.event, status: 'blocked', decision: 'block', reason: 'fixture denial' }]
        : [];
    },
  });

  const blockedRuntime = makeCompactionRuntime(true);
  const blockedId = blockedRuntime.enqueueCompaction(compactionTurnFor('chat-compact-hook-block'));
  assert.ok(blockedId);
  await blockedRuntime.whenIdle();
  assert.equal(blockedRuntime.list()[0]?.status, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(snapshots, 0);
  assert.equal(hookEvents.filter((event) => event === 'before-compaction:blocked-case').length, 1);
  assert.equal(hookEvents.includes('after-compaction:blocked-case'), false);

  const providerErrorRuntime = makeCompactionRuntime(false);
  const errorId = providerErrorRuntime.enqueueCompaction(compactionTurnFor('chat-compact-provider-error'));
  assert.ok(errorId);
  await providerErrorRuntime.whenIdle();
  assert.equal(providerErrorRuntime.list()[0]?.status, 'failed');
  assert.equal(providerCalls, 1);
  assert.equal(snapshots, 0);
  assert.equal(hookEvents.filter((event) => event === 'before-compaction:provider-error-case').length, 1);
  assert.equal(hookEvents.includes('after-compaction:provider-error-case'), false);
});

test('cancelling a running compaction never saves a snapshot or runs its after hook', async () => {
  const streamStarted = deferred();
  let snapshots = 0;
  const hookEvents: string[] = [];
  const provider: GigaChatProvider = {
    stream: async function* (_request, signal): AsyncGenerator<ProviderEvent> {
      yield { type: 'text-delta', text: 'Неполная сводка' };
      streamStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
    },
  };
  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn) => ({
      request: requestFor(turn),
      compaction: {
        boundaryMessageId: turn.compactBoundaryMessageId!,
        coveredThroughMessageId: turn.messageId,
        coveredPrefixHash: 'd'.repeat(64),
        expectedSnapshotId: null,
        provenance: 'fixture' as const,
      },
    }),
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    appendCompaction: async () => { snapshots += 1; },
    compactionEnabled: true,
    recordUsageReceipt: async () => undefined,
    runHooks: async (_turn, input) => { hookEvents.push(input.event); return []; },
  });

  const id = runtime.enqueueCompaction(compactionTurnFor('chat-compact-cancel'));
  assert.ok(id);
  await streamStarted.promise;
  assert.equal(runtime.cancel(id), true);
  await runtime.whenIdle();

  assert.equal(runtime.list()[0]?.status, 'cancelled');
  assert.equal(snapshots, 0);
  assert.equal(hookEvents.filter((event) => event === 'before-compaction').length, 1);
  assert.equal(hookEvents.includes('after-compaction'), false);
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

test('keeps FIFO blocked when persisting a queued cancellation fails', async () => {
  const firstGate = deferred();
  let cancelledSaveStarted = false;
  let rejectCancelledSave!: (error: Error) => void;
  const cancelledSave = new Promise<void>((_resolve, reject) => { rejectCancelledSave = reject; });
  const started: string[] = [];
  let cancelledTurnId = '';
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
    consumeTurn: async () => undefined,
    releaseTurn: () => undefined,
    appendAssistant: async () => undefined,
    recordUsageReceipt: async () => undefined,
    persistTurnRecord: async (turn) => {
      if (turn.id === cancelledTurnId && turn.status === 'cancelled') {
        cancelledSaveStarted = true;
        await cancelledSave;
      }
    },
  });
  runtime.enqueue(turnFor('chat-one'));
  cancelledTurnId = runtime.enqueue(turnFor('chat-two'))!;
  runtime.enqueue(turnFor('chat-three'));
  await waitUntil(() => started.length === 1);
  assert.equal(runtime.cancel(cancelledTurnId), true);
  await waitUntil(() => cancelledSaveStarted);
  const idle = assert.rejects(runtime.whenIdle(), /остановка хода не подтверждена/i);

  firstGate.resolve();
  await waitUntil(() => runtime.list('chat-one')[0]?.status === 'completed');
  assert.deepEqual(started, ['chat-one']);

  rejectCancelledSave(new Error('synthetic queued cancellation save failure'));
  await waitUntil(() => runtime.list('chat-two')[0]?.status === 'failed');
  await idle;
  assert.equal(runtime.list('chat-two')[0]?.errorCategory, 'storage');
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
  assert.equal(runtime.list('chat-one')[0]?.retryEligible, true);
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

test('runtime binds assistant, tool and compact state to the captured account and leaves state-free results unowned', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-provider-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const toolTurn = await store.acceptLocalMessage(chat.id, 'Прочитай файл с захваченным состоянием', 'turn-state-tool');
  const noStateToolTurn = await store.acceptLocalMessage(chat.id, 'Прочитай файл без состояния', 'turn-state-free-tool');
  const noStateTurn = await store.acceptLocalMessage(chat.id, 'Ответь без состояния', 'turn-state-free-answer');
  let compactCalls = 0;
  const toolCallsByPrompt = new Set<string>();
  const provider = makeProvider(async function* (request) {
    if (request.usageKind === 'compaction') {
      compactCalls += 1;
      yield { type: 'text-delta', text: `Сводка ${compactCalls}` };
      yield compactCalls === 1
        ? { type: 'completed', functionsStateId: 'state-compact-owned' }
        : { type: 'completed' };
      return;
    }
    const lastUserText = [...request.messages].reverse().find((message) => message.role === 'user')?.text ?? '';
    if (lastUserText.includes('захваченным состоянием')) {
      if (toolCallsByPrompt.has(lastUserText)) {
        yield { type: 'text-delta', text: 'Содержимое прочитано.' };
        yield { type: 'completed', functionsStateId: 'state-assistant-owned' };
      } else {
        toolCallsByPrompt.add(lastUserText);
        yield functionCall('read', { path: 'fixture.txt' }, 'state-tool-owned');
      }
      return;
    }
    if (lastUserText.startsWith('Прочитай файл без состояния')) {
      if (toolCallsByPrompt.has(lastUserText)) {
        yield { type: 'text-delta', text: 'Результат чтения.' };
        yield { type: 'completed' };
      } else {
        toolCallsByPrompt.add(lastUserText);
        yield functionCall('read', { path: 'fixture.txt' });
      }
      return;
    }
    yield { type: 'text-delta', text: 'Ответ без серверного состояния.' };
    yield { type: 'completed' };
  });
  const tools = { read: async () => ({ contents: 'Синтетический файл.' }) } as unknown as LocalTools;
  const keyA = 'synthetic-provider-state-account-A';
  const keyB = 'synthetic-provider-state-account-B';
  const { runtime, guard } = makeOwnedStoreRuntime(store, provider, async () => keyA, tools);

  assert.ok(runtime.enqueue(toolTurn.turn));
  assert.ok(runtime.enqueue(noStateToolTurn.turn));
  assert.ok(runtime.enqueue(noStateTurn.turn));
  await runtime.whenIdle();

  assert.ok(runtime.list(chat.id).every((turn) => turn.status === 'completed'));
  const stateA = await captureProviderStateOwner(guard, async () => keyA);
  const restored = await openStore(directory);
  const detail = await restored.getChat(chat.id);
  const publicJson = JSON.stringify({ detail, turns: runtime.list(chat.id) });
  assert.equal(publicJson.includes(stateA.accountScope), false, 'the account owner is not exposed through chat or runtime snapshots');
  assert.equal(publicJson.includes('providerStateOwnership'), false);
  assert.equal(detail.messages.find((message) => message.id === toolTurn.turn.assistantMessageId)?.functionsStateId,
    'state-assistant-owned');
  assert.equal(Object.prototype.hasOwnProperty.call(
    detail.messages.find((message) => message.id === noStateTurn.turn.assistantMessageId)!, 'functionsStateId'), false);
  assert.deepEqual(detail.toolReceipts.map((receipt) => receipt.functionsStateId), ['state-tool-owned', null]);

  const stateAView = await restored.getProviderStateOwnership(chat.id, stateA.accountScope);
  assert.deepEqual(stateAView.messages, [{ messageId: toolTurn.turn.assistantMessageId, owned: true }]);
  assert.deepEqual(stateAView.receipts, [{ receiptId: detail.toolReceipts[0]!.receiptId,
    anchorMessageId: toolTurn.turn.messageId, owned: true }]);
  assert.deepEqual((await restored.getToolProtocolThrough(chat.id, noStateToolTurn.turn.messageId))
    .map((exchange) => exchange.functionsStateId), ['state-tool-owned', null]);

  const compactTurn = await restored.acceptCompactionTurn(chat.id, 'turn-state-compact-owned');
  const originalMessages = (await restored.getChat(chat.id)).messages;
  assert.ok(runtime.enqueueCompaction(compactTurn.turn));
  await runtime.whenIdle();
  const compacted = await (await openStore(directory)).getChat(chat.id);
  assert.deepEqual(compacted.messages, originalMessages, 'compaction keeps the public raw message history intact');
  assert.equal(compacted.compactSnapshot?.text, 'Сводка 1');
  assert.deepEqual(await (await openStore(directory)).getProviderStateOwnership(chat.id, stateA.accountScope), {
    ...stateAView,
    compact: { snapshotId: compacted.compactSnapshot!.id, owned: true, functionsStateId: 'state-compact-owned' },
  });

  const noStateCompactTurn = await (await openStore(directory)).acceptCompactionTurn(chat.id, 'turn-state-compact-unowned');
  assert.ok(runtime.enqueueCompaction(noStateCompactTurn.turn));
  await runtime.whenIdle();
  const noStateCompactedStore = await openStore(directory);
  const noStateCompacted = await noStateCompactedStore.getChat(chat.id);
  assert.equal(noStateCompacted.compactSnapshot?.text, 'Сводка 2');
  assert.deepEqual((await noStateCompactedStore.getProviderStateOwnership(chat.id, stateA.accountScope)).compact,
    { snapshotId: noStateCompacted.compactSnapshot!.id, owned: false, functionsStateId: null },
    'a new compact snapshot without a returned state does not inherit the prior owner');

  const finishKeyTransition = guard.beginTransition();
  finishKeyTransition();
  const stateB = await captureProviderStateOwner(guard, async () => keyB);
  const stateBView = await noStateCompactedStore.getProviderStateOwnership(chat.id, stateB.accountScope);
  assert.ok(stateBView.messages.every((message) => !message.owned));
  assert.ok(stateBView.receipts.every((receipt) => !receipt.owned));
  assert.equal(stateBView.compact?.owned, false);
});

test('plain assistant state stays owned through A-to-B-to-A runtime switches and Store reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-plain-state-account-switch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const keyA = 'synthetic-provider-plain-state-A';
  const keyB = 'synthetic-provider-plain-state-B';
  let activeKey = keyA;
  const guard = createBalanceScopeGuard();
  const requestsA: ProviderTurnRequest[] = [];
  const firstTurn = await store.acceptLocalMessage(chat.id, 'Ответь с состоянием.', 'turn-plain-state-A1');
  const runtimeA = makeOwnedStoreRuntime(store, makeProvider(async function* (request) {
    requestsA.push(structuredClone(request));
    yield { type: 'text-delta', text: 'Ответ A1.' };
    yield { type: 'completed', functionsStateId: 'plain-state-A1' };
  }), async () => activeKey, testTools, true, guard);
  assert.ok(runtimeA.runtime.enqueue(firstTurn.turn));
  await runtimeA.runtime.whenIdle();
  assert.equal(requestsA.length, 1);

  const ownerA = await captureProviderStateOwner(guard, async () => keyA);
  const ownerB = await captureProviderStateOwner(guard, async () => keyB);
  const reopenedForB = await openStore(directory);
  const afterA = await reopenedForB.getChat(chat.id);
  assert.equal(afterA.messages[1]?.functionsStateId, 'plain-state-A1');
  assert.deepEqual(await reopenedForB.getProviderStateOwnership(chat.id, ownerA.accountScope), {
    messages: [{ messageId: firstTurn.turn.assistantMessageId, owned: true }], receipts: [], compact: null,
  });
  assert.deepEqual(await reopenedForB.getProviderStateOwnership(chat.id, ownerB.accountScope), {
    messages: [{ messageId: firstTurn.turn.assistantMessageId, owned: false }], receipts: [], compact: null,
  });

  const finishToB = guard.beginTransition();
  finishToB();
  activeKey = keyB;
  const foreignTurn = await reopenedForB.acceptLocalMessage(chat.id, 'Обычное продолжение B.', 'turn-plain-state-B1');
  const requestsB: ProviderTurnRequest[] = [];
  const runtimeB = makeOwnedStoreRuntime(reopenedForB, makeProvider(async function* (request) {
    requestsB.push(structuredClone(request));
    yield { type: 'text-delta', text: 'Ответ B1.' };
    yield { type: 'completed' };
  }), async () => activeKey, testTools, true, guard);
  assert.ok(runtimeB.runtime.enqueue(foreignTurn.turn));
  await runtimeB.runtime.whenIdle();

  assert.equal(requestsB.length, 1);
  const bAssistant = requestsB[0]!.messages.find((message) => message.id === firstTurn.turn.assistantMessageId)!;
  assert.equal(Object.prototype.hasOwnProperty.call(bAssistant, 'functionsStateId'), false,
    'the foreign account request does not send the unowned assistant state');
  const afterB = await (await openStore(directory)).getChat(chat.id);
  assert.deepEqual(afterB.messages.slice(0, afterA.messages.length), afterA.messages,
    'filtering does not rewrite the original persisted history');
  assert.equal(afterB.messages[1]?.functionsStateId, 'plain-state-A1');
  assert.equal(Object.prototype.hasOwnProperty.call(afterB.messages[3]!, 'functionsStateId'), false,
    'the foreign account result is stored without fabricating provider state');

  const finishBackToA = guard.beginTransition();
  finishBackToA();
  activeKey = keyA;
  const reopenedForA = await openStore(directory);
  const beforeReturn = await reopenedForA.getChat(chat.id);
  const requestsBackA: ProviderTurnRequest[] = [];
  const returnTurn = await reopenedForA.acceptLocalMessage(chat.id, 'Продолжение A после reopen.', 'turn-plain-state-A2');
  const runtimeBackA = makeOwnedStoreRuntime(reopenedForA, makeProvider(async function* (request) {
    requestsBackA.push(structuredClone(request));
    yield { type: 'text-delta', text: 'Ответ A2.' };
    yield { type: 'completed' };
  }), async () => activeKey, testTools, true, guard);
  assert.ok(runtimeBackA.runtime.enqueue(returnTurn.turn));
  await runtimeBackA.runtime.whenIdle();

  assert.deepEqual(requestsBackA[0]?.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.functionsStateId), ['plain-state-A1', undefined]);
  const reopenedAfterA = await openStore(directory);
  const finalDetail = await reopenedAfterA.getChat(chat.id);
  assert.deepEqual(finalDetail.messages.slice(0, beforeReturn.messages.length), beforeReturn.messages);
  assert.deepEqual(await reopenedAfterA.getProviderStateOwnership(chat.id, ownerA.accountScope), {
    messages: [{ messageId: firstTurn.turn.assistantMessageId, owned: true }], receipts: [], compact: null,
  });
  assert.deepEqual(await reopenedAfterA.getProviderStateOwnership(chat.id, ownerB.accountScope), {
    messages: [{ messageId: firstTurn.turn.assistantMessageId, owned: false }], receipts: [], compact: null,
  });
});

test('runtime stops before provider when another account would lose access to historical attachments', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-unowned-history-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'historical.txt');
  await writeFile(source, 'synthetic historical attachment bytes', 'utf8');
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const staged = await store.stageChatDraftFile(chat.id, source);
  const attachmentId = staged.draftAttachments[0]!.id;
  const first = await store.acceptLocalMessage(chat.id, 'Сначала прочитай файл', 'turn-state-history-first', [attachmentId]);
  const keyA = 'synthetic-provider-state-history-A';
  const keyB = 'synthetic-provider-state-history-B';
  let activeKey = keyA;
  let providerCalls = 0;
  let readEffects = 0;
  const observedRequests: ProviderTurnRequest[] = [];
  const provider = makeProvider(async function* (request) {
    providerCalls += 1;
    observedRequests.push(structuredClone(request));
    const lastUserText = [...request.messages].reverse().find((message) => message.role === 'user')?.text ?? '';
    if (lastUserText.includes('Сначала прочитай файл') && request.protocolHistory?.length !== 1) {
      yield functionCall('read', { path: 'historical.txt' }, 'state-history-receipt-A');
      return;
    }
    yield { type: 'text-delta', text: 'Результат сохранён в истории.' };
    yield { type: 'completed', functionsStateId: 'state-history-assistant-A' };
  });
  const tools = {
    read: async () => { readEffects += 1; return { contents: 'synthetic file contents' }; },
  } as unknown as LocalTools;
  const { runtime, guard, providerRequestPreparationCount } = makeOwnedStoreRuntime(store, provider, async () => activeKey, tools, true);

  assert.ok(runtime.enqueue(first.turn));
  await runtime.whenIdle();
  const followUp = await store.acceptLocalMessage(chat.id, 'Продолжи ответ.', 'turn-state-history-follow-up');
  assert.ok(runtime.enqueue(followUp.turn));
  await runtime.whenIdle();
  assert.equal(runtime.list(chat.id).filter((turn) => turn.status === 'completed').length, 2);
  assert.equal(providerCalls, 3);
  assert.equal(readEffects, 1);
  assert.deepEqual(observedRequests[2]?.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.functionsStateId), ['state-history-assistant-A']);
  assert.deepEqual(observedRequests[2]?.protocolHistory?.map((exchange) => exchange.functionsStateId), ['state-history-receipt-A']);

  const beforeForeignTurn = await store.getChat(chat.id);
  const frozenHistory = structuredClone({ messages: beforeForeignTurn.messages, toolReceipts: beforeForeignTurn.toolReceipts, artifacts: beforeForeignTurn.artifacts });
  const preparationsBeforeForeignTurn = providerRequestPreparationCount();
  const finishKeyTransition = guard.beginTransition();
  finishKeyTransition();
  activeKey = keyB;
  const foreignTurn = await store.acceptLocalMessage(chat.id, 'Ещё один вопрос.', 'turn-state-history-foreign');
  assert.ok(runtime.enqueue(foreignTurn.turn));
  await runtime.whenIdle();

  const failed = runtime.list(chat.id).find((turn) => turn.id === foreignTurn.turn.turnId);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE);
  assert.equal(providerCalls, 3, 'the unsafe continuation fails during preparation, before a provider stream');
  assert.equal(providerRequestPreparationCount(), preparationsBeforeForeignTurn,
    'historical file safety rejects before provider request preparation or upload');
  assert.equal(readEffects, 1, 'historical local effects are not repeated');
  const afterForeignTurn = await store.getChat(chat.id);
  assert.deepEqual(afterForeignTurn.messages.slice(0, frozenHistory.messages.length), frozenHistory.messages,
    'the original user text, assistant state, and historical file links remain unchanged');
  assert.deepEqual(afterForeignTurn.toolReceipts, frozenHistory.toolReceipts);
  assert.deepEqual(afterForeignTurn.artifacts, frozenHistory.artifacts);
  assert.equal(afterForeignTurn.messages.length, frozenHistory.messages.length + 1);
  assert.equal(afterForeignTurn.messages[afterForeignTurn.messages.length - 1]?.text, 'Ещё один вопрос.');
  assert.deepEqual(afterForeignTurn.messages[afterForeignTurn.messages.length - 1]?.attachmentIds, undefined);

  const reopenedAsB = await openStore(directory);
  const reopenedBDetail = await reopenedAsB.getChat(chat.id);
  const ownerA = await captureProviderStateOwner(guard, async () => keyA);
  const ownerB = await captureProviderStateOwner(guard, async () => keyB);
  assert.deepEqual(await reopenedAsB.getProviderStateOwnership(chat.id, ownerA.accountScope), {
    messages: [
      { messageId: first.turn.assistantMessageId, owned: true },
      { messageId: followUp.turn.assistantMessageId, owned: true },
    ],
    receipts: [{ receiptId: afterForeignTurn.toolReceipts[0]!.receiptId, anchorMessageId: first.turn.messageId, owned: true }],
    compact: null,
  });
  const ownershipForB = await reopenedAsB.getProviderStateOwnership(chat.id, ownerB.accountScope);
  assert.ok(ownershipForB.messages.every((entry) => !entry.owned));
  assert.ok(ownershipForB.receipts.every((entry) => !entry.owned));
  assert.equal(JSON.stringify(reopenedBDetail).includes(ownerA.accountScope), false);
  assert.equal(JSON.stringify(reopenedBDetail).includes(ownerB.accountScope), false);

  const finishReturnTransition = guard.beginTransition();
  finishReturnTransition();
  activeKey = keyA;
  const returnedStore = await openStore(directory);
  const beforeReturn = await returnedStore.getChat(chat.id);
  const returnRequestMessages: ProviderTurnRequest[] = [];
  const returnedRuntime = makeOwnedStoreRuntime(returnedStore, makeProvider(async function* (request) {
    returnRequestMessages.push(structuredClone(request));
    yield { type: 'text-delta', text: 'Ответ после повторного подключения.' };
    yield { type: 'completed', functionsStateId: 'state-history-assistant-return-A' };
  }), async () => activeKey, tools, true, guard);
  const returnTurn = await returnedStore.acceptLocalMessage(chat.id, 'Продолжи после возврата ключа A.', 'turn-state-history-return-A');
  assert.ok(returnedRuntime.runtime.enqueue(returnTurn.turn));
  await returnedRuntime.runtime.whenIdle();

  assert.equal(returnRequestMessages.length, 1);
  assert.deepEqual(returnRequestMessages[0]?.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.functionsStateId), ['state-history-assistant-A', 'state-history-assistant-A']);
  assert.deepEqual(returnRequestMessages[0]?.protocolHistory?.map((exchange) => exchange.functionsStateId), ['state-history-receipt-A']);
  const reopenedAsA = await openStore(directory);
  const afterReturn = await reopenedAsA.getChat(chat.id);
  assert.deepEqual(afterReturn.messages.slice(0, beforeReturn.messages.length), beforeReturn.messages,
    'switching back to the original account preserves the raw accepted history');
  assert.deepEqual(afterReturn.toolReceipts.slice(0, beforeReturn.toolReceipts.length), beforeReturn.toolReceipts);
  assert.equal(JSON.stringify(afterReturn).includes(ownerA.accountScope), false);
  assert.equal((await reopenedAsA.getProviderStateOwnership(chat.id, ownerA.accountScope)).messages
    .some((entry) => entry.messageId === returnTurn.turn.assistantMessageId && entry.owned), true);
  assert.deepEqual((await reopenedAsA.getProviderStateOwnership(chat.id, ownerA.accountScope)).messages, [
    { messageId: first.turn.assistantMessageId, owned: true },
    { messageId: followUp.turn.assistantMessageId, owned: true },
    { messageId: returnTurn.turn.assistantMessageId, owned: true },
  ]);
  assert.equal((await reopenedAsA.getProviderStateOwnership(chat.id, ownerB.accountScope)).messages
    .some((entry) => entry.owned), false);
});

test('a key transition during the awaited Store state-owner lookup fails before provider or tool effects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-state-owner-read-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const turn = await store.acceptLocalMessage(chat.id, 'Проверка смены ключа во время чтения состояния.', 'turn-state-owner-read-race');
  const keyA = 'synthetic-provider-state-read-A';
  const keyB = 'synthetic-provider-state-read-B';
  const ownershipReadStarted = deferred();
  const finishOwnershipRead = deferred();
  const getOwnership = store.getProviderStateOwnership.bind(store);
  store.getProviderStateOwnership = async (chatId, accountScope) => {
    ownershipReadStarted.resolve();
    await finishOwnershipRead.promise;
    return getOwnership(chatId, accountScope);
  };
  let activeKey = keyA;
  let providerCalls = 0;
  let localToolCalls = 0;
  const { runtime, guard, providerRequestPreparationCount } = makeOwnedStoreRuntime(store, makeProvider(async function* () {
    providerCalls += 1;
    yield { type: 'text-delta', text: 'Не должно быть отправлено.' };
    yield { type: 'completed' };
  }), async () => activeKey, {
    read: async () => { localToolCalls += 1; return { contents: 'unexpected' }; },
  } as unknown as LocalTools, true);

  assert.ok(runtime.enqueue(turn.turn));
  await ownershipReadStarted.promise;
  const finishTransition = guard.beginTransition();
  finishTransition();
  activeKey = keyB;
  finishOwnershipRead.resolve();
  await runtime.whenIdle();

  assert.equal(providerCalls, 0);
  assert.equal(localToolCalls, 0);
  assert.equal(providerRequestPreparationCount(), 0, 'the key race fails before provider request preparation or upload');
  assert.equal((await store.getChat(chat.id)).messages.some((message) => message.role === 'assistant'), false);
  assert.equal(runtime.list(chat.id).find((item) => item.id === turn.turn.turnId)?.errorCategory, 'auth');
});

test('key transition during preparation and delayed provider results cannot write under the next account', async (t) => {
  const preparationDirectory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-state-prepare-transition-'));
  t.after(() => rm(preparationDirectory, { recursive: true, force: true }));
  const preparationStore = await openStore(preparationDirectory);
  const preparationChat = await preparationStore.createChat();
  await preparationStore.updateChat(preparationChat.id, { modelId: 'GigaChat-3-Pro' });
  const preparationTurn = await preparationStore.acceptLocalMessage(preparationChat.id, 'Подготовка с ключом A', 'turn-state-prepare-transition');
  const keyLoadStarted = deferred();
  const pendingKey = deferredValue<string | null>();
  let preparationStreams = 0;
  const preparationRuntime = makeOwnedStoreRuntime(preparationStore, makeProvider(async function* () {
    preparationStreams += 1;
    yield { type: 'text-delta', text: 'не должно начаться' };
    yield { type: 'completed', functionsStateId: 'state-not-started' };
  }), async () => {
    keyLoadStarted.resolve();
    return pendingKey.promise;
  });
  assert.ok(preparationRuntime.runtime.enqueue(preparationTurn.turn));
  await keyLoadStarted.promise;
  const finishPreparationTransition = preparationRuntime.guard.beginTransition();
  finishPreparationTransition();
  pendingKey.resolve('synthetic-provider-state-account-A');
  await preparationRuntime.runtime.whenIdle();
  assert.equal(preparationStreams, 0);
  assert.equal((await preparationStore.getChat(preparationChat.id)).messages.some((message) => message.role === 'assistant'), false);

  const lateResultDirectory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-state-late-result-'));
  t.after(() => rm(lateResultDirectory, { recursive: true, force: true }));
  const lateResultStore = await openStore(lateResultDirectory);
  const lateResultChat = await lateResultStore.createChat();
  await lateResultStore.updateChat(lateResultChat.id, { modelId: 'GigaChat-3-Pro' });
  const lateResultTurn = await lateResultStore.acceptLocalMessage(lateResultChat.id, 'Запрос ключа A', 'turn-state-late-result');
  const streamStarted = deferred();
  const releaseProviderResult = deferred();
  const lateEvent = functionCall('read', { path: 'fixture.txt' }, 'state-late-tool-receipt');
  let toolCalls = 0;
  const lateRuntime = makeOwnedStoreRuntime(lateResultStore, makeProvider(async function* () {
    streamStarted.resolve();
    await releaseProviderResult.promise;
    yield lateEvent;
  }), async () => 'synthetic-provider-state-account-A', {
    read: async () => { toolCalls += 1; return { contents: 'should not run' }; },
  } as unknown as LocalTools);
  assert.ok(lateRuntime.runtime.enqueue(lateResultTurn.turn));
  await streamStarted.promise;
  const finishLateResultTransition = lateRuntime.guard.beginTransition();
  finishLateResultTransition();
  releaseProviderResult.resolve();
  await lateRuntime.runtime.whenIdle();
  const lateReceiptDetail = await lateResultStore.getChat(lateResultChat.id);
  assert.equal(lateReceiptDetail.toolReceipts.length, 0, 'a late function call is rejected before receipt or tool execution');
  assert.equal(toolCalls, 0);
  assert.equal(lateReceiptDetail.messages.some((message) => message.role === 'assistant'), false);

  const completionDirectory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-state-late-completion-'));
  t.after(() => rm(completionDirectory, { recursive: true, force: true }));
  const completionStore = await openStore(completionDirectory);
  const completionChat = await completionStore.createChat();
  await completionStore.updateChat(completionChat.id, { modelId: 'GigaChat-3-Pro' });
  const completionTurn = await completionStore.acceptLocalMessage(completionChat.id, 'Поздний ответ ключа A', 'turn-state-late-completion');
  const completionStarted = deferred();
  const releaseCompletion = deferred();
  const completionRuntime = makeOwnedStoreRuntime(completionStore, makeProvider(async function* () {
    completionStarted.resolve();
    await releaseCompletion.promise;
    yield { type: 'text-delta', text: 'поздний ответ' };
    yield { type: 'completed', functionsStateId: 'state-late-assistant' };
  }), async () => 'synthetic-provider-state-account-A');
  assert.ok(completionRuntime.runtime.enqueue(completionTurn.turn));
  await completionStarted.promise;
  const finishCompletionTransition = completionRuntime.guard.beginTransition();
  finishCompletionTransition();
  releaseCompletion.resolve();
  await completionRuntime.runtime.whenIdle();
  const completionDetail = await completionStore.getChat(completionChat.id);
  assert.equal(completionDetail.messages.some((message) => message.role === 'assistant'), false,
    'a completed provider result captured under A is not committed after the account generation changes');
});

test('uploads only the accepted message attachments inside the FIFO turn and does not resend them on a text follow-up', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-attachment-fifo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'one-turn.txt');
  await writeFile(source, 'synthetic local attachment bytes');
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const draft = await store.stageChatDraftFile(chat.id, source);
  const localAttachmentId = draft.draftAttachments[0]!.id;
  const first = await store.acceptLocalMessage(chat.id, 'Прочитай этот файл', 'turn-attachment-first', [localAttachmentId]);
  const second = await store.acceptLocalMessage(chat.id, 'Продолжи без повторной отправки файла', 'turn-attachment-second');
  const acceptedSnapshot = structuredClone(first.turn);

  const uploadStarted = deferred();
  const allowUpload = deferred();
  const uploaded: string[] = [];
  const requests: ProviderTurnRequest[] = [];
  const provider = {
    stream: async function* (request: ProviderTurnRequest): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone(request));
      yield { type: 'text-delta', text: 'Ответ' };
      yield { type: 'completed' };
    },
    uploadFile: async (input: { filename: string; contentType: string; bytes: Uint8Array }, signal: AbortSignal) => {
      uploadStarted.resolve();
      await allowUpload.promise;
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      uploaded.push(input.filename);
      return { id: 'remote_attachment_one', filename: input.filename, bytes: input.bytes.byteLength, purpose: 'general' as const };
    },
    listFiles: async () => [],
    deleteFile: async () => undefined,
  } as unknown as import('./gigachat-provider').GigaChatProviderConnection;

  const runtime = createTurnRuntime({
    provider,
    tools: testTools,
    prepareTurn: async (turn, signal) => {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      await store.validateAcceptedTurn(turn);
      return {
        system: [],
        messages: await store.getMessagesThrough(turn.chatId, turn.messageId),
        permissionProfile: turn.permissionProfile,
        modelId: turn.modelId,
      };
    },
    prepareProviderRequest: (turn, request, signal) => prepareTurnAttachments(turn, request, signal, {
      store,
      provider,
      loadAuthorizationKey: async () => 'synthetic-attachment-account-key',
    }),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal, functionsStateId);
    },
    recordUsageReceipt: async () => undefined,
  });

  assert.ok(runtime.enqueue(first.turn));
  await uploadStarted.promise;
  assert.equal(requests.length, 0, 'provider stream waits until the durable upload receipt is ready');
  assert.ok(runtime.enqueue(second.turn));
  assert.equal(requests.length, 0, 'the next accepted turn stays behind the pending upload in the same FIFO');

  allowUpload.resolve();
  await runtime.whenIdle();

  assert.deepEqual(first.turn, acceptedSnapshot, 'preparation leaves the accepted turn and local IDs immutable');
  assert.equal(uploaded.length, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.attachments?.map((item) => ({ messageId: item.messageId, attachmentId: item.attachmentId, fileId: item.fileId })), [
    { messageId: first.turn.messageId, attachmentId: localAttachmentId, fileId: 'remote_attachment_one' },
  ]);
  const firstWire = JSON.parse(serializeProviderTurnRequest(requests[0]!).body) as { messages: Array<Record<string, unknown>> };
  assert.deepEqual(firstWire.messages.find((message) => message.role === 'user' && 'attachments' in message)?.attachments, ['remote_attachment_one']);
  assert.deepEqual(requests[1]?.attachments, [], 'a text follow-up does not reload or resend the prior image/document');
  const secondWire = JSON.parse(serializeProviderTurnRequest(requests[1]!).body) as { messages: Array<Record<string, unknown>> };
  assert.equal(secondWire.messages.some((message) => 'attachments' in message), false);
  const detail = await store.getChat(chat.id);
  assert.deepEqual(detail.messages.find((message) => message.id === first.turn.messageId)?.attachmentIds, [localAttachmentId]);
  assert.equal(detail.artifacts.find((artifact) => artifact.id === localAttachmentId)?.messageId, first.turn.messageId);
});

test('a missing prior remote upload asks to reattach and never silently uploads again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-missing-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'local.txt');
  await writeFile(source, 'previously accepted local bytes', 'utf8');
  const store = await openStore(directory);
  const chat = await store.createChat();
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Pro' });
  const staged = await store.stageChatDraftFile(chat.id, source);
  const attachmentId = staged.draftAttachments[0]!.id;
  const accepted = await store.acceptLocalMessage(chat.id, 'Read the attached file.', 'turn-missing-upload', [attachmentId]);
  const artifact = accepted.detail.artifacts.find((item) => item.id === attachmentId);
  assert.ok(artifact?.sha256);
  const authorizationKey = 'synthetic-attachment-account-key';
  const accountScope = createHash('sha256').update(authorizationKey, 'utf8').digest('hex');
  const uploadIntent = {
    accountScope, attachmentId, uploadFilename: `gcagent_${attachmentId}.txt`,
    name: artifact.name, contentType: 'text/plain', kind: 'document', sizeBytes: artifact.size,
    sha256: artifact.sha256, state: 'intent' as const, remoteFileId: null, createdAt: new Date().toISOString(),
  };
  await store.putProviderUploadEntry(uploadIntent);
  await store.putProviderUploadEntry({ ...uploadIntent, state: 'uploaded', remoteFileId: 'remote-file-no-longer-listed' });
  let uploadCalls = 0;
  let streamCalls = 0;
  const provider = {
    stream: async function* (): AsyncGenerator<ProviderEvent> {
      streamCalls += 1;
      yield { type: 'text-delta', text: 'unexpected' };
      yield { type: 'completed' };
    },
    uploadFile: async () => { uploadCalls += 1; throw new Error('must not re-upload'); },
    listFiles: async () => [],
    deleteFile: async () => undefined,
  } as unknown as import('./gigachat-provider').GigaChatProviderConnection;
  const runtime = createTurnRuntime({
    provider, tools: testTools,
    prepareTurn: async (turn) => {
      await store.validateAcceptedTurn(turn);
      return {
        system: [], messages: await store.getMessagesThrough(turn.chatId, turn.messageId),
        permissionProfile: turn.permissionProfile, modelId: turn.modelId,
      };
    },
    prepareProviderRequest: (turn, request, signal) => prepareTurnAttachments(turn, request, signal, {
      store, provider, loadAuthorizationKey: async () => authorizationKey,
    }),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn) => {
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal, functionsStateId);
    },
    recordUsageReceipt: async () => undefined,
  });

  runtime.enqueue(accepted.turn);
  await runtime.whenIdle();

  const result = runtime.list(chat.id)[0];
  assert.equal(result?.status, 'failed');
  assert.equal(result?.error, MISSING_REMOTE_ATTACHMENT_MESSAGE);
  assert.equal(result?.errorCategory, 'storage');
  assert.equal(uploadCalls, 0);
  assert.equal(streamCalls, 0);
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

test('explicit retry preserves the accepted turn and does not replay a completed write under a new provider state ID', async () => {
  const receipts = makeReceiptStore();
  let writes = 0;
  let providerRound = 0;
  const provider = makeProvider(async function* () {
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
  const accepted: AcceptedTurnInput = { ...first, projectId: 'project-one', projectWorkingFolder: 'C:\\Project', permissionProfile: 'full', skillId: 'global/audit' };
  const retryInputs: AcceptedTurnInput[] = [];
  const runtime = makeRuntime(provider, {
    ...options,
    validateRetry: async (input) => { retryInputs.push(structuredClone(input)); },
  });
  const firstId = runtime.enqueue(accepted);
  assert.equal(firstId, accepted.turnId);
  assert.equal(runtime.list('chat-one')[0]?.createdAt, first.messages[0]?.createdAt,
    'the first attempt remains anchored to the accepted user message time');
  await runtime.whenIdle();
  assert.equal(runtime.list('chat-one')[0]?.status, 'failed');
  assert.equal(runtime.list('chat-one')[0]?.errorCategory, 'network');
  assert.equal(runtime.list('chat-one')[0]?.retryEligible, true);
  assert.equal(writes, 1);

  accepted.messages[0]!.text = 'изменённый внешний объект';
  accepted.permissionProfile = 'ask';
  accepted.projectWorkingFolder = 'C:\\Other';
  accepted.skillId = null;
  const retryRequestedAt = Date.now();
  const retryId = await runtime.retry(accepted.turnId, 'chat-one');
  assert.ok(retryId);
  await runtime.whenIdle();
  assert.equal(runtime.list('chat-one').length, 2);
  assert.equal(runtime.list('chat-one')[1]?.id, retryId);
  assert.equal(runtime.list('chat-one')[1]?.status, 'completed');
  assert.ok(Date.parse(runtime.list('chat-one')[1]!.createdAt) >= retryRequestedAt - 1000,
    'the retry attempt starts its queue clock when it is accepted');
  assert.ok((runtime.list('chat-one')[1]?.queueDurationMs ?? Number.POSITIVE_INFINITY) < 10_000,
    'time spent on the original attempt is not reported as retry queue time');
  assert.equal(runtime.list('chat-one')[0]?.retryEligible, undefined);
  assert.equal(retryInputs.length, 1);
  assert.notEqual(retryInputs[0]?.turnId, accepted.turnId);
  assert.equal(retryInputs[0]?.messageId, first.messageId);
  assert.equal(retryInputs[0]?.projectId, 'project-one');
  assert.equal(retryInputs[0]?.projectWorkingFolder, 'C:\\Project');
  assert.equal(retryInputs[0]?.permissionProfile, 'full');
  assert.equal(retryInputs[0]?.skillId, 'global/audit');
  assert.equal(retryInputs[0]?.messages[0]?.text, 'один запрос');
  assert.equal(writes, 1);
  assert.equal(await runtime.retry(accepted.turnId, 'chat-one'), null, 'a stale failed row loses retry authority after success');
  assert.equal(runtime.list('chat-one').length, 2);
});

test('double-click retry admits only one immutable attempt', async () => {
  const validationStarted = deferred();
  const validationGate = deferred();
  let validations = 0;
  let providerRounds = 0;
  const provider = makeProvider(async function* () {
    providerRounds += 1;
    if (providerRounds === 1) yield { type: 'error', category: 'network', retryable: true };
    else { yield { type: 'text-delta', text: 'Повтор завершён' }; yield { type: 'completed' }; }
  });
  const runtime = makeRuntime(provider, {
    validateRetry: async () => {
      validations += 1;
      validationStarted.resolve();
      await validationGate.promise;
    },
  });
  const original = turnFor('retry-race');
  const originalId = runtime.enqueue(original);
  assert.ok(originalId);
  await runtime.whenIdle();

  const firstRetry = runtime.retry(originalId, 'retry-race');
  await validationStarted.promise;
  assert.equal(await runtime.retry(originalId, 'retry-race'), null);
  validationGate.resolve();
  assert.ok(await firstRetry);
  await runtime.whenIdle();
  assert.equal(validations, 1);
  assert.equal(providerRounds, 2);
  assert.equal(runtime.list('retry-race').length, 2);
  assert.equal(runtime.list('retry-race')[0]?.retryEligible, undefined);

  const failedRetryId = runtime.list('retry-race')[1]?.id;
  assert.ok(failedRetryId);
  assert.equal(await runtime.retry(failedRetryId, 'retry-race'), null, 'successful retry is no longer eligible');
});

test('retry validation failure keeps the source snapshot eligible and starts no provider round', async () => {
  let providerRounds = 0;
  const retryReservations = new Set<string>();
  const reservedRetryIds: string[] = [];
  const releasedReservations: string[] = [];
  const provider = makeProvider(async function* () {
    providerRounds += 1;
    yield { type: 'error', category: 'network', retryable: true };
  });
  const runtime = makeRuntime(provider, {
    validateRetry: async (turn) => {
      retryReservations.add(turn.turnId);
      reservedRetryIds.push(turn.turnId);
      throw new Error('Подключите GigaChat перед повтором этого хода.');
    },
    releaseTurn: (turn) => {
      releasedReservations.push(turn.turnId);
      retryReservations.delete(turn.turnId);
    },
  });
  const originalId = runtime.enqueue(turnFor('retry-validation'));
  assert.ok(originalId);
  await runtime.whenIdle();

  await assert.rejects(runtime.retry(originalId, 'retry-validation'), /Подключите GigaChat/);
  assert.equal(providerRounds, 1);
  assert.equal(runtime.list('retry-validation').length, 1);
  assert.equal(runtime.list('retry-validation')[0]?.modelId, 'GigaChat-2-Pro', 'the retry UI receives the frozen model ID from the accepted turn');
  assert.equal(runtime.list('retry-validation')[0]?.retryEligible, true);
  assert.equal(releasedReservations.length, 1);
  assert.deepEqual(releasedReservations, reservedRetryIds);
  assert.equal(releasedReservations[0] === originalId, false, 'the source turn reservation must not be released for a failed retry');
  assert.equal(retryReservations.size, 0, 'a reservation made during validation is released when retry admission fails');
});

test('retry availability follows a global pending save and returns only after settlement', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const provider = makeProvider(async function* (request) {
    if (request.messages[0]?.text === 'retry-source') {
      yield { type: 'error', category: 'network', retryable: true };
      return;
    }
    yield { type: 'text-delta', text: 'Ответ после сохранения' };
    yield { type: 'completed' };
  });
  const runtime = makeRuntime(provider, {
    timeouts: { operationMs: 15 },
    appendAssistant: async (chatId) => {
      if (chatId === 'pending-save') {
        saveStarted.resolve();
        await saveGate.promise;
      }
    },
  });
  const retrySourceId = runtime.enqueue(turnFor('retry-source'));
  assert.ok(retrySourceId);
  await runtime.whenIdle();
  assert.equal(runtime.list('retry-source')[0]?.retryEligible, true);

  runtime.enqueue(turnFor('pending-save'));
  await saveStarted.promise;
  await waitUntil(() => runtime.list('pending-save')[0]?.error?.includes('очередь приостановлена') === true);
  assert.equal(runtime.list('retry-source')[0]?.retryEligible, undefined);
  assert.equal(await runtime.retry(retrySourceId, 'retry-source'), null);
  await assert.rejects(runtime.whenIdle(), /очередь приостановлена/i);

  saveGate.resolve();
  await waitUntil(() => runtime.list('pending-save')[0]?.status === 'completed');
  await runtime.whenIdle();
  assert.equal(runtime.list('retry-source')[0]?.retryEligible, true);
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

test('PowerShell approval hooks receive the accepted Skill and can block both runtime access modes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-runtime-powershell-skill-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userDataPath = join(directory, 'user-data');
  const projectPath = join(directory, 'project');
  await mkdir(userDataPath);
  await mkdir(projectPath);
  const project: Project = {
    id: 'runtime-skill-context-project', name: 'Runtime Skill context fixture', pinned: false, archived: false,
    createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', workingFolder: projectPath,
  };
  const hookId = `project/${project.id}/skill-guard`;
  const hookDirectory = join(userDataPath, 'hooks', 'projects', project.id, 'skill-guard');
  const hookAction = `Write-Output '{"decision":"block"}'`;
  await mkdir(hookDirectory, { recursive: true });
  await writeFile(join(hookDirectory, 'hook.json'), JSON.stringify({
    schemaVersion: 1, name: 'Skill context guard', description: 'Blocks the approved fixture command.',
    event: 'permission-request', actionFile: 'action.ps1',
  }), 'utf8');
  await writeFile(join(hookDirectory, 'action.ps1'), hookAction, 'utf8');
  const registry = createHookRegistry({
    userDataPath,
    listProjects: async () => [project],
    listSkills: async () => [],
  });
  const inspected = await registry.inspect(hookId);
  await registry.trust(hookId, inspected.contentHash);
  await registry.setEnabled(hookId, true);
  const customPolicy: CustomPolicy = {
    project: { list: 'allow', search: 'allow', read: 'allow', write: 'ask', open: 'ask', execute: 'ask' },
    roots: [],
  };

  for (const externalAccess of [false, true]) {
    const skillId = 'global/accepted-runtime-skill';
    const chatId = `chat-powershell-skill-${externalAccess ? 'external' : 'ordinary'}`;
    const script = `Write-Output 'runtime-command-${externalAccess ? 'external' : 'ordinary'}'`;
    const permissionProfile: AcceptedTurnInput['permissionProfile'] = externalAccess ? 'ask' : 'custom';
    const turn: AcceptedTurnInput = {
      ...turnFor(chatId, 'Run the approved PowerShell fixture.'),
      projectId: project.id, projectWorkingFolder: projectPath, skillId, permissionProfile,
    };
    const providerRequests: ProviderTurnRequest[] = [];
    const provider = makeProvider(async function* (request) {
      providerRequests.push(structuredClone(request));
      if (!request.protocolHistory?.length) {
        yield functionCall('powershell', { script, ...(externalAccess ? { external_access: true } : {}) });
      } else {
        yield { type: 'text-delta', text: 'The command was checked.' };
        yield { type: 'completed' };
      }
    });
    const runtimeToolCalls: Array<{
      projectId: unknown; profile: unknown; script: unknown;
      options: Parameters<LocalTools['runPowerShell']>[3];
    }> = [];
    type ApprovalDetails = Parameters<NonNullable<LocalToolsOptions['requestApproval']>>[0];
    const approvalRequests: Array<{
      details: ApprovalDetails;
      signal: AbortSignal | undefined;
      context: { projectId: string | null; profile: string; skillId: string | null; workingFolder: string } | undefined;
    }> = [];
    const runnerRequests: PowerShellRequest[] = [];
    const hookResults: HookRunResult[] = [];
    let modelCommandApprovals = 0;
    let hookActionApprovals = 0;
    let acceptedExecution: HookExecutionContext | null = null;
    let gate: ReturnType<typeof createHookApprovalGate<ApprovalDetails>> | null = null;
    const baseTools = createLocalTools({
      resolveProject: async (id) => id === project.id ? project : null,
      getCustomPolicy: async () => customPolicy,
      protectedDirectory: userDataPath,
      requestApproval: async (details, signal, context) => {
        approvalRequests.push({ details, signal, context });
        if (!gate) throw new Error('The approval gate was not initialized.');
        const gateContext = acceptedExecution && context ? { execution: acceptedExecution, ...context } : undefined;
        return gate.request(details, signal, gateContext);
      },
      runPowerShell: async (request) => {
        runnerRequests.push(request);
        if (request.script === hookAction) {
          return { exitCode: 0, stdout: '{"decision":"block"}\r\n', stderr: '', timedOut: false, outputLimited: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, outputLimited: false };
      },
    });
    const dispatcher = createHookDispatcher({
      registry,
      tools: baseTools,
      isAvailable: () => true,
      onResult: (result) => registry.recordResult(result),
    });
    gate = createHookApprovalGate({
      dispatch: dispatcher,
      isSuppressed: () => false,
      requestApproval: async (details) => {
        if (details.target.endsWith(`PowerShell:\n${hookAction}`)) hookActionApprovals += 1;
        else modelCommandApprovals += 1;
        return true;
      },
      onResult: (result) => hookResults.push(result),
    });
    const tools: LocalTools = {
      ...baseTools,
      runPowerShell: async (projectIdInput, profileInput, scriptInput, options) => {
        runtimeToolCalls.push({ projectId: projectIdInput, profile: profileInput, script: scriptInput, options });
        return baseTools.runPowerShell(projectIdInput, profileInput, scriptInput, options);
      },
    };
    const receipts = makeReceiptStore();
    const runtime = makeRuntime(provider, {
      tools,
      beginToolReceipt: receipts.begin,
      completeToolReceipt: receipts.complete,
      runHooks: async (acceptedTurn, input, signal) => {
        acceptedExecution = {
          projectId: acceptedTurn.projectId,
          projectWorkingFolder: acceptedTurn.projectWorkingFolder,
          permissionProfile: acceptedTurn.permissionProfile,
          skillId: acceptedTurn.skillId,
        };
        return dispatcher(acceptedExecution, input, signal ?? new AbortController().signal);
      },
    });
    assert.ok(runtime.enqueue(turn));
    await runtime.whenIdle();

    const modelCall = runtimeToolCalls.find((call) => call.script === script);
    assert.ok(modelCall, 'runtime forwards the original model command to LocalTools');
    assert.equal(modelCall.projectId, project.id);
    assert.equal(modelCall.profile, permissionProfile);
    assert.equal(modelCall.options?.expectedWorkingFolder, projectPath);
    assert.equal(modelCall.options?.skillId, skillId);
    assert.ok(modelCall.options?.signal instanceof AbortSignal);
    assert.equal(modelCall.options?.signal.aborted, false);
    assert.equal(modelCall.options?.fullAccessOnce, externalAccess ? true : undefined);
    const modelApproval = approvalRequests.find((item) => item.details.target.includes(script));
    assert.ok(modelApproval, 'LocalTools requests approval for the original command');
    assert.equal(modelApproval.details.resource, 'process');
    assert.equal(modelApproval.details.action, 'execute');
    assert.equal(modelApproval.context?.projectId, project.id);
    assert.equal(modelApproval.context?.profile, permissionProfile);
    assert.equal(modelApproval.context?.skillId, skillId);
    assert.equal(modelApproval.context?.workingFolder, projectPath);
    assert.ok(modelApproval.signal instanceof AbortSignal);
    assert.equal(modelApproval.signal.aborted, false);
    assert.equal(modelApproval.details.target, externalAccess
      ? `PowerShell без AppContainer\nРабочая папка: ${projectPath}\nКоманда:\n${script}`
      : `${projectPath}\n\nPowerShell:\n${script}`);
    assert.equal(hookResults.filter((result) => result.event === 'permission-request' && result.status === 'blocked'
      && result.decision === 'block').length, 1, 'the accepted-Skill permission Hook vetoes the command');
    assert.equal(modelCommandApprovals, 0, 'a blocking Hook prevents ordinary approval of the model command');
    assert.equal(hookActionApprovals, externalAccess ? 0 : 1,
      'the Hook action uses Custom approval when required; project-scoped Ask remains automatic');
    assert.equal(runnerRequests.filter((request) => request.script === hookAction).length, 1);
    assert.equal(runnerRequests.filter((request) => request.script === script).length, 0,
      'the fake command runner never receives the model command');
    assert.equal(providerRequests.length, 2);
    assert.equal(runtime.list(chatId)[0]?.status, 'completed');
  }
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
