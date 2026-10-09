import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AcceptedTurnInput,
  ChatToolReceipt,
  GigaChatProvider,
  HookDispatchInput,
  HookRunResult,
  ProviderFunctionCall,
  ProviderErrorCategory,
  ProviderEvent,
  ProviderProtocolExchange,
  ProviderTurnRequest,
  ProviderToolName,
  RuntimeActivity,
  RuntimeTurnSnapshot,
  UsageReceipt,
  UsageReceiptStatus,
} from './contracts';
import { PROVIDER_ERROR_CATEGORIES } from './contracts';
import { LocalToolError, type LocalToolEvent, type LocalTools } from './local-tools';
import { HookDispatchAbortError } from './hooks';
import { MAX_USAGE_COUNT, mergeUsageReceipt } from './usage';

const MAX_ACTIVITY_PER_TURN = 50;
const MAX_ASSISTANT_CHARS = 100_000;
const DRAFT_UPDATE_INTERVAL_MS = 50;
const DEFAULT_PREPARE_TIMEOUT_MS = 15_000;
const DEFAULT_NEXT_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_FUNCTION_ROUNDS = 8;
const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_TOTAL_TOOL_RESULT_BYTES = 128 * 1024;
const STOP_TIMEOUT = Symbol('stop-timeout');
const PROVIDER_TOOL_NAMES: readonly ProviderToolName[] = ['list', 'search', 'read', 'write', 'open', 'powershell'];

export interface ToolReceiptInput extends Omit<ChatToolReceipt, 'anchorMessageId' | 'status' | 'result' | 'createdAt'> {}
export interface ToolReceiptStart { shouldExecute: boolean; receipt: ChatToolReceipt }

export interface TurnRuntimeOptions {
  provider?: GigaChatProvider | null;
  tools: LocalTools;
  prepareTurn(turn: AcceptedTurnInput, signal: AbortSignal): Promise<ProviderTurnRequest>;
  consumeTurn(turn: AcceptedTurnInput, signal: AbortSignal): Promise<void>;
  releaseTurn(turn: AcceptedTurnInput): void;
  appendAssistant(turn: AcceptedTurnInput, text: string, signal: AbortSignal, functionsStateId?: string): Promise<void>;
  recordUsageReceipt(receipt: UsageReceipt): Promise<void>;
  beginToolReceipt?(turn: AcceptedTurnInput, receipt: ToolReceiptInput): Promise<ToolReceiptStart>;
  completeToolReceipt?(turn: AcceptedTurnInput, receiptId: string, status: 'completed' | 'unknown', result: string): Promise<void>;
  runHooks?(turn: AcceptedTurnInput, input: HookDispatchInput, signal: AbortSignal): Promise<HookRunResult[]>;
  timeouts?: { prepareMs?: number; nextMs?: number; stopMs?: number; operationMs?: number; toolMs?: number; turnMs?: number };
  onUpdate?(turn: RuntimeTurnSnapshot): void;
}

export interface TurnRuntime {
  readonly tools: LocalTools;
  enqueue(turn: unknown): string | null;
  list(chatId?: unknown): RuntimeTurnSnapshot[];
  cancel(turnId: unknown, chatId?: unknown): boolean;
  cancelAll(): Promise<void>;
  whenIdle(): Promise<void>;
  onUpdate(listener: (turn: RuntimeTurnSnapshot) => void): () => void;
  recordToolEvent(event: LocalToolEvent): void;
  recordHookResult(result: HookRunResult): void;
}

interface RuntimeTurn extends RuntimeTurnSnapshot {
  input: AcceptedTurnInput;
  controller?: AbortController;
  cancelRequested: boolean;
}

interface StopState {
  streamConfirmed: boolean;
  streamStop: Promise<boolean> | null;
  pendingToolIds: Set<string>;
  waiters: Set<() => void>;
  pendingOperation: boolean;
  pendingOutcome: { status: 'completed' | 'failed' | 'cancelled'; error?: string } | null;
}

interface IdleWaiter {
  resolve(): void;
  reject(error: Error): void;
}

function requireChatId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Некорректный идентификатор чата для локального runtime.');
  }
  return value;
}

function copyTurn(turn: RuntimeTurn): RuntimeTurnSnapshot {
  return {
    id: turn.id,
    chatId: turn.chatId,
    status: turn.status,
    createdAt: turn.createdAt,
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    ...(turn.queueDurationMs === undefined ? {} : { queueDurationMs: turn.queueDurationMs }),
    ...(turn.activeDurationMs === undefined ? {} : { activeDurationMs: turn.activeDurationMs }),
    activity: structuredClone(turn.activity),
    ...(turn.draft === undefined ? {} : { draft: turn.draft }),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.errorCategory ? { errorCategory: turn.errorCategory } : {}),
  };
}

function isProviderErrorCategory(value: unknown): value is ProviderErrorCategory {
  return typeof value === 'string' && (PROVIDER_ERROR_CATEGORIES as readonly string[]).includes(value);
}

function isProviderToolName(value: string): value is ProviderToolName {
  return (PROVIDER_TOOL_NAMES as readonly string[]).includes(value);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'ABORT_ERR');
}

function abortError(): Error {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

function requireAcceptedTurn(value: unknown): AcceptedTurnInput {
  if (typeof value !== 'object' || value === null) throw new Error('Некорректный принятый ход.');
  const turn = value as Partial<AcceptedTurnInput>;
  const turnId = requireChatId(turn.turnId);
  const chatId = requireChatId(turn.chatId);
  if (!Array.isArray(turn.messages) || !Number.isSafeInteger(turn.historyBoundary)
    || turn.historyBoundary !== turn.messages.length || typeof turn.messageId !== 'string'
    || !turn.messages.some((message) => message.id === turn.messageId && message.role === 'user')
    || (turn.projectId !== null && typeof turn.projectId !== 'string')
    || (turn.projectWorkingFolder !== null && typeof turn.projectWorkingFolder !== 'string')
    || !turn.reservation || typeof turn.reservation !== 'object') {
    throw new Error('Некорректный снимок принятого хода.');
  }
  return structuredClone({ ...turn, turnId, chatId } as AcceptedTurnInput);
}

function assertProviderEvent(value: unknown): asserts value is ProviderEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('BAD_PROVIDER_EVENT');
  const event = value as Record<string, unknown>;
  if (event.type === 'activity') {
    if (!['connecting', 'receiving', 'waiting-for-tool', 'tool-started', 'tool-finished'].includes(String(event.activity))) {
      throw new Error('BAD_PROVIDER_EVENT');
    }
    if (event.tool !== undefined && !['list', 'search', 'read', 'write', 'open', 'powershell'].includes(String(event.tool))) {
      throw new Error('BAD_PROVIDER_EVENT');
    }
    return;
  }
  if (event.type === 'text-delta' && typeof event.text === 'string') return;
  if (event.type === 'usage'
    && ['promptTokens', 'completionTokens', 'totalTokens', 'precachedPromptTokens'].every((field) => {
      const count = event[field];
      return count === null || typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= MAX_USAGE_COUNT;
    })
    && (event.providerRequestId === undefined || typeof event.providerRequestId === 'string'
      && event.providerRequestId.length > 0 && event.providerRequestId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(event.providerRequestId))
    && (event.providerModel === undefined || typeof event.providerModel === 'string'
      && event.providerModel.length > 0 && event.providerModel.length <= 512 && !/[\u0000-\u001f\u007f]/.test(event.providerModel))) return;
  if (event.type === 'completed' && (event.functionsStateId === undefined
    || typeof event.functionsStateId === 'string' && event.functionsStateId.length > 0 && event.functionsStateId.length <= 4096)) return;
  if (event.type === 'function-call' && isFunctionCall(event.functionCall)) return;
  if (event.type === 'error' && isProviderErrorCategory(event.category) && typeof event.retryable === 'boolean') return;
  throw new Error('BAD_PROVIDER_EVENT');
}

function isFunctionCall(value: unknown): value is ProviderFunctionCall {
  if (typeof value !== 'object' || value === null || !('name' in value) || !('arguments' in value)) return false;
  const call = value as Partial<ProviderFunctionCall>;
  if (typeof call.name !== 'string' || !call.name || call.name.length > 128 || /[\u0000-\u001f\u007f]/.test(call.name)
    || typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)
    || (call.content !== null && typeof call.content !== 'string')
    || (call.functionsStateId !== null && typeof call.functionsStateId !== 'string')
    || call.terminalReason !== 'function_call') return false;
  try { return Buffer.byteLength(JSON.stringify(call.arguments), 'utf8') <= 1_900_000; }
  catch { return false; }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function isExternalEffect(name: string): boolean {
  return name === 'write' || name === 'powershell' || name === 'open';
}

function receiptIdFor(turn: AcceptedTurnInput, call: ProviderFunctionCall, round: number): string {
  const identity = call.functionsStateId ?? `${turn.turnId}:${round}`;
  return createHash('sha256').update(stableJson([identity, call.name, call.arguments]), 'utf8').digest('hex');
}

function effectIdFor(turn: AcceptedTurnInput, call: ProviderFunctionCall): string | undefined {
  if (!isExternalEffect(call.name)) return undefined;
  return createHash('sha256').update(stableJson([turn.messageId, call.name, call.arguments]), 'utf8').digest('hex');
}

function objectResult(value: unknown): string {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : { ok: true, result: value };
  let encoded: string;
  try { encoded = JSON.stringify(record); }
  catch { encoded = JSON.stringify({ ok: false, error: 'invalid_tool_result', message: 'Инструмент вернул неподдерживаемый результат.' }); }
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_TOOL_RESULT_BYTES) return encoded;
  return JSON.stringify({ ok: false, error: 'result_limit', message: 'Результат инструмента слишком велик для безопасного продолжения.' });
}

function errorResult(error: unknown, unknownSideEffect = false): string {
  if (unknownSideEffect) return JSON.stringify({
    ok: false, status: 'unknown', error: 'effect_unknown',
    message: 'Выполнение было прервано или завершилось неоднозначно; проверьте состояние перед повтором.',
  });
  const message = error instanceof Error ? error.message.slice(0, 1000) : 'Локальный инструмент завершился ошибкой.';
  return objectResult({ ok: false, error: error instanceof LocalToolError && error.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'tool_error', message });
}

type ValidatedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; message: string };

function validateToolArguments(call: ProviderFunctionCall): ValidatedToolArguments {
  const args = call.arguments;
  const allowed: Record<ProviderToolName, readonly string[]> = {
    list: ['path'], search: ['query', 'path'], read: ['path'], write: ['path', 'contents'], open: ['path'],
    powershell: ['script', 'external_access'],
  };
  if (!isProviderToolName(call.name)) return { ok: false, error: 'unknown_function', message: 'Эта функция недоступна в текущем приложении.' };
  const keys = allowed[call.name];
  if (Object.getPrototypeOf(args) !== Object.prototype || Object.keys(args).some((key) => !keys.includes(key))) {
    return { ok: false, error: 'invalid_arguments', message: 'Аргументы функции не соответствуют поддерживаемой схеме.' };
  }
  const requireString = (key: string, required: boolean, maxLength: number, allowEmpty = false): string | null => {
    const value = args[key];
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength || value.includes('\0')) {
      throw new Error(`Аргумент ${key} имеет неверный тип или превышает лимит.`);
    }
    return value;
  };
  try {
    if (call.name === 'list') requireString('path', false, 2048, true);
    else if (call.name === 'search') requireString('query', true, 256);
    else if (call.name === 'read') requireString('path', true, 2048);
    else if (call.name === 'write') {
      requireString('path', true, 2048);
      const contents = requireString('contents', true, 1_048_576, true) ?? '';
      if (Buffer.byteLength(contents, 'utf8') > 1024 * 1024) throw new Error('Содержимое записи превышает лимит 1 МиБ в UTF-8.');
    } else if (call.name === 'open') requireString('path', false, 2048, true);
    else if (call.name === 'powershell') {
      requireString('script', true, 16 * 1024);
      if (args.external_access !== undefined && typeof args.external_access !== 'boolean') throw new Error('Аргумент external_access должен быть логическим.');
    }
  } catch (error) {
    return { ok: false, error: 'invalid_arguments', message: error instanceof Error ? error.message : 'Аргументы функции некорректны.' };
  }
  return { ok: true, args };
}

function settle(promise: Promise<unknown>): Promise<void> {
  return promise.then(() => undefined, () => undefined);
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof STOP_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(STOP_TIMEOUT), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutError: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
  });
  try { return await Promise.race([promise, abort, timeout]); }
  finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createTurnRuntime(options: TurnRuntimeOptions): TurnRuntime {
  const turns = new Map<string, RuntimeTurn>();
  const queue: RuntimeTurn[] = [];
  const listeners = new Set<(turn: RuntimeTurnSnapshot) => void>();
  const stopStates = new Map<string, StopState>();
  const toolOwners = new Map<string, string>();
  let activeTurn: RuntimeTurn | null = null;
  let draining = false;
  let blockedTurnId: string | null = null;
  const idleWaiters: IdleWaiter[] = [];
  const prepareTimeoutMs = options.timeouts?.prepareMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
  const nextTimeoutMs = options.timeouts?.nextMs ?? DEFAULT_NEXT_TIMEOUT_MS;
  const stopTimeoutMs = options.timeouts?.stopMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const operationTimeoutMs = options.timeouts?.operationMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const toolTimeoutMs = options.timeouts?.toolMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const turnTimeoutMs = options.timeouts?.turnMs ?? DEFAULT_TURN_TIMEOUT_MS;

  const publish = (turn: RuntimeTurn): void => {
    const snapshot = copyTurn(turn);
    try { options.onUpdate?.(snapshot); } catch { /* Runtime state must survive observer failures. */ }
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* Runtime state must survive observer failures. */ }
    }
  };

  const addActivity = (turn: RuntimeTurn, activity: RuntimeActivity): void => {
    if (turn.activity.length >= MAX_ACTIVITY_PER_TURN) turn.activity.shift();
    turn.activity.push(activity);
    publish(turn);
  };

  const stopConfirmed = (state: StopState): boolean => state.streamConfirmed && state.pendingToolIds.size === 0;
  const notifyStopWaiters = (state: StopState): void => {
    if (!stopConfirmed(state)) return;
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  };
  const maybeUnblock = (turnId: string): void => {
    const state = stopStates.get(turnId);
    if (!state || !stopConfirmed(state) || state.pendingOperation) return;
    if (blockedTurnId !== turnId) return;
    const turn = turns.get(turnId);
    if (turn && state.pendingOutcome) {
      turn.status = state.pendingOutcome.status;
      turn.endedAt = new Date().toISOString();
      if (state.pendingOutcome.status === 'completed') delete turn.draft;
      if (state.pendingOutcome.error) turn.error = state.pendingOutcome.error;
      else delete turn.error;
      turn.controller = undefined;
      publish(turn);
    }
    stopStates.delete(turnId);
    blockedTurnId = null;
    finishIdleWaiters();
    if (!draining && queue.some((turn) => turn.status === 'queued')) void drain();
  };

  const finishIdleWaiters = (): void => {
    if (blockedTurnId) {
      const error = new Error('Очередь приостановлена: остановка хода не подтверждена.');
      for (const waiter of idleWaiters.splice(0)) waiter.reject(error);
      return;
    }
    if (draining || activeTurn || queue.some((turn) => turn.status === 'queued')) return;
    for (const waiter of idleWaiters.splice(0)) waiter.resolve();
  };

  const waitForTools = async (state: StopState): Promise<boolean> => {
    if (state.pendingToolIds.size === 0) return true;
    let resolveWaiter!: () => void;
    const pending = new Promise<void>((resolve) => { resolveWaiter = resolve; });
    state.waiters.add(resolveWaiter);
    const result = await bounded(pending, stopTimeoutMs);
    state.waiters.delete(resolveWaiter);
    return result !== STOP_TIMEOUT;
  };

  const requestIteratorStop = (
    turnId: string,
    iterator: AsyncIterator<ProviderEvent>,
    pendingNext: Promise<IteratorResult<ProviderEvent>> | null,
  ): Promise<boolean> => {
    const state = stopStates.get(turnId);
    if (!state) return Promise.resolve(false);
    if (state.streamConfirmed) return Promise.resolve(true);
    if (state.streamStop) return state.streamStop;
    const returnMethod = iterator.return;
    if (!returnMethod) {
      state.streamStop = Promise.resolve(false);
      return state.streamStop;
    }
    const returned = Promise.resolve().then(() => returnMethod.call(iterator)).then(
      (result) => Boolean(result && result.done),
      () => false,
    );
    const nextSettled = pendingNext ? settle(pendingNext).then(() => true) : Promise.resolve(true);
    state.streamStop = Promise.all([returned, nextSettled]).then(([returnConfirmed]) => {
      if (returnConfirmed) state.streamConfirmed = true;
      notifyStopWaiters(state);
      maybeUnblock(turnId);
      return returnConfirmed;
    });
    return state.streamStop;
  };

  const confirmStop = async (
    turn: RuntimeTurn,
    iterator: AsyncIterator<ProviderEvent> | null,
    pendingNext: Promise<IteratorResult<ProviderEvent>> | null,
    naturallyDone: boolean,
  ): Promise<boolean> => {
    const state = stopStates.get(turn.id);
    if (!state) return false;
    if (naturallyDone) state.streamConfirmed = true;
    else if (iterator && !state.streamConfirmed) {
      const streamResult = await bounded(requestIteratorStop(turn.id, iterator, pendingNext), stopTimeoutMs);
      if (streamResult === STOP_TIMEOUT || !streamResult) {
        state.streamStop?.then(() => { notifyStopWaiters(state); maybeUnblock(turn.id); });
        return false;
      }
      state.streamConfirmed = true;
    } else if (!iterator && !state.streamConfirmed) {
      state.streamConfirmed = true;
    }
    if (!(await waitForTools(state))) return false;
    return true;
  };

  const holdForPendingOperation = (
    turn: RuntimeTurn,
    state: StopState,
    outcome: Promise<{ status: 'completed' | 'failed' | 'cancelled'; error?: string }>,
    message: string,
  ): void => {
    state.pendingOperation = true;
    blockedTurnId = turn.id;
    turn.status = 'running';
    turn.error = message;
    publish(turn);
    finishIdleWaiters();
    void outcome.then((result) => {
      state.pendingOperation = false;
      state.pendingOutcome = result;
      if (stopConfirmed(state)) maybeUnblock(turn.id);
    });
  };

  const markStopUnconfirmed = (turn: RuntimeTurn): void => {
    blockedTurnId = turn.id;
    turn.status = 'failed';
    turn.error = 'Не удалось подтвердить остановку потока или локального инструмента; очередь приостановлена.';
    turn.endedAt = new Date().toISOString();
    publish(turn);
    finishIdleWaiters();
    const state = stopStates.get(turn.id);
    if (state) {
      state.streamStop?.then(() => { notifyStopWaiters(state); maybeUnblock(turn.id); });
      if (stopConfirmed(state)) maybeUnblock(turn.id);
    }
  };

  const runTurn = async (turn: RuntimeTurn): Promise<void> => {
    const controller = new AbortController();
    const stopState: StopState = {
      streamConfirmed: false, streamStop: null, pendingToolIds: new Set(), waiters: new Set(),
      pendingOperation: false, pendingOutcome: null,
    };
    stopStates.set(turn.id, stopState);
    turn.controller = controller;
    turn.status = 'running';
    turn.startedAt = new Date().toISOString();
    turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
    publish(turn);
    const started = Date.now();
    let iterator: AsyncIterator<ProviderEvent> | null = null;
    let pendingNext: Promise<IteratorResult<ProviderEvent>> | null = null;
    let naturallyDone = false;
    let stopHooksRan = false;
    let interruptHooksRan = false;
    let reservationConsumed = false;
    let turnTimedOut = false;
    let answer = '';
    let activeUsageReceipt: UsageReceipt | null = null;
    let usagePersistenceTimedOut = false;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDraftPublishedAt = 0;
    const turnTimer = setTimeout(() => { turnTimedOut = true; controller.abort(); }, turnTimeoutMs);
    const flushDraft = (): void => {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      if (!answer) return;
      turn.draft = answer;
      lastDraftPublishedAt = Date.now();
      publish(turn);
    };
    const scheduleDraftPublish = (): void => {
      turn.draft = answer;
      const delayMs = DRAFT_UPDATE_INTERVAL_MS - (Date.now() - lastDraftPublishedAt);
      if (delayMs <= 0) flushDraft();
      else if (!draftTimer) draftTimer = setTimeout(flushDraft, delayMs);
    };
    const waitTracked = async <T>(
      promise: Promise<T>, timeoutMs: number, timeoutMessage: string, pendingMessage: string,
      signal = controller.signal,
    ): Promise<T> => {
      try { return await waitFor(promise, signal, timeoutMs, timeoutMessage); }
      catch (error) {
        const timedOut = error instanceof Error && error.message === timeoutMessage;
        if (!timedOut && !isAbortError(error)) throw error;
        if (timedOut) {
          if (timeoutMessage === 'USAGE_RECEIPT_SAVE_TIMEOUT') usagePersistenceTimedOut = true;
          controller.abort();
        }
        const pendingOutcome = promise.then(
          () => turn.cancelRequested || !timedOut && controller.signal.aborted && !turnTimedOut
            ? ({ status: 'cancelled' as const })
            : ({ status: 'failed' as const, error: pendingMessage }),
          (lateError: unknown) => turn.cancelRequested || !timedOut && controller.signal.aborted && !turnTimedOut
            ? ({ status: 'cancelled' as const })
            : ({ status: 'failed' as const, error: lateError instanceof Error ? lateError.message : pendingMessage }),
        );
        holdForPendingOperation(turn, stopState, pendingOutcome, pendingMessage);
        throw timedOut ? new Error(timeoutMessage) : error;
      }
    };
    const saveUsageReceipt = async (receipt: UsageReceipt): Promise<void> => {
      try { await options.recordUsageReceipt(receipt); }
      catch (error) {
        if (isAbortError(error)) throw error;
        throw new Error('USAGE_RECEIPT_WRITE_FAILED');
      }
    };
    const persistUsageReceipt = async (persistence: Promise<void>, signal = controller.signal): Promise<void> => {
      try {
        await waitTracked(
          persistence,
          operationTimeoutMs,
          'USAGE_RECEIPT_SAVE_TIMEOUT',
          'Сохранение usage не завершено; очередь приостановлена.',
          signal,
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        const timeout = error instanceof Error && error.message === 'USAGE_RECEIPT_SAVE_TIMEOUT';
        turn.errorCategory = 'storage';
        publish(turn);
        throw Object.assign(new Error(timeout ? 'USAGE_RECEIPT_SAVE_TIMEOUT' : 'USAGE_RECEIPT_SAVE_FAILED'), { category: 'storage' });
      }
    };
    const updateActiveUsage = async (patch: Partial<UsageReceipt>, signal = controller.signal): Promise<void> => {
      if (!activeUsageReceipt) return;
      const updated = mergeUsageReceipt(activeUsageReceipt, { ...activeUsageReceipt, ...patch });
      activeUsageReceipt = updated;
      const persistence = Promise.resolve().then(() => saveUsageReceipt(updated)).then(async () => {
        if (updated.status !== 'pending' || !controller.signal.aborted) return;
        const cancelled = turn.cancelRequested || !turnTimedOut && !usagePersistenceTimedOut;
        const terminal = { ...updated, status: cancelled ? 'cancelled' as const : 'failed' as const };
        await saveUsageReceipt(terminal);
        if (activeUsageReceipt?.localRequestId === terminal.localRequestId) activeUsageReceipt = terminal;
      });
      await persistUsageReceipt(persistence, signal);
    };
    const finishActiveUsage = async (status: UsageReceiptStatus, signal = controller.signal): Promise<void> => {
      if (!activeUsageReceipt) return;
      if (activeUsageReceipt.status === 'pending') await updateActiveUsage({ status }, signal);
      activeUsageReceipt = null;
    };
    const runHookEvent = async (
      input: HookDispatchInput,
      signal = controller.signal,
      acceptedTurn = turn.input,
    ): Promise<HookRunResult[]> => {
      let results: HookRunResult[];
      try {
        results = await options.runHooks?.(acceptedTurn, input, signal) ?? [];
      } catch (error) {
        if (error instanceof HookDispatchAbortError) {
          for (const result of error.hookResults) {
            addActivity(turn, {
              kind: 'hook', at: new Date().toISOString(), hookId: result.hookId, hookName: result.hookName,
              event: result.event, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
            });
          }
        }
        throw error;
      }
      for (const result of results) {
        addActivity(turn, {
          kind: 'hook', at: new Date().toISOString(), hookId: result.hookId, hookName: result.hookName,
          event: result.event, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
        });
      }
      if (signal.aborted) throw abortError();
      return results;
    };
    const invokeTool = async (call: ProviderFunctionCall): Promise<unknown> => {
      const validation = validateToolArguments(call);
      if (!validation.ok) return { ok: false, error: validation.error, message: validation.message };
      const args = validation.args;
      const scope = { signal: controller.signal, expectedWorkingFolder: turn.input.projectWorkingFolder, skillId: turn.input.skillId };
      switch (call.name) {
        case 'list': return options.tools.list(turn.input.projectId, turn.input.permissionProfile, args.path ?? '', scope);
        case 'search': return options.tools.search(turn.input.projectId, turn.input.permissionProfile, args.query, args.path ?? '', scope);
        case 'read': return options.tools.read(turn.input.projectId, turn.input.permissionProfile, args.path, scope);
        case 'write': return options.tools.write(turn.input.projectId, turn.input.permissionProfile, args.path, args.contents, scope);
        case 'open': return options.tools.open(turn.input.projectId, turn.input.permissionProfile, args.path ?? '', scope);
        case 'powershell': return options.tools.runPowerShell(turn.input.projectId, turn.input.permissionProfile, args.script, {
          signal: controller.signal,
          expectedWorkingFolder: turn.input.projectWorkingFolder,
          ...(args.external_access === true ? { fullAccessOnce: true } : {}),
        });
        default: return { ok: false, error: 'unknown_function', message: 'Эта функция недоступна в текущем приложении.' };
      }
    };
    try {
      if (!options.provider) throw new Error('PROVIDER_UNAVAILABLE');
      if (!turn.input.modelId) throw new Error('MODEL_NOT_SELECTED');
      const preparation = Promise.resolve().then(() => options.prepareTurn(turn.input, controller.signal));
      let request = await waitFor(preparation, controller.signal, prepareTimeoutMs, 'TURN_PREPARE_TIMEOUT');
      if (controller.signal.aborted) throw abortError();
      if (!request.modelId) throw new Error('MODEL_NOT_SELECTED');
      await runHookEvent({ event: 'user-prompt-submitted', projectId: turn.input.projectId });

      let toolRounds = 0;
      let totalToolResultBytes = 0;
      for (;;) {
        if (controller.signal.aborted) throw abortError();
        if (stopState.pendingToolIds.size || stopState.pendingOperation) throw new Error('TOOL_STOP_STATE');
        stopState.streamConfirmed = true;
        stopState.streamStop = null;
        naturallyDone = false;
        if (!request.modelId) throw new Error('MODEL_NOT_SELECTED');
        const usageReceipt: UsageReceipt = {
          localRequestId: randomUUID(),
          chatId: turn.input.chatId,
          requestKind: toolRounds > 0 ? 'tool-continuation' : request.usageKind ?? 'chat',
          modelId: request.modelId,
          providerRequestId: null,
          providerModel: null,
          createdAt: new Date().toISOString(),
          status: 'pending',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          precachedPromptTokens: null,
          conflictedFields: [],
        };
        const initialUsagePersistence = Promise.resolve().then(() => saveUsageReceipt(usageReceipt)).then(async () => {
          if (!controller.signal.aborted) return;
          await saveUsageReceipt({
            ...usageReceipt,
            status: turn.cancelRequested || !turnTimedOut && !usagePersistenceTimedOut ? 'cancelled' : 'failed',
          });
        });
        await persistUsageReceipt(initialUsagePersistence);
        activeUsageReceipt = usageReceipt;
        if (controller.signal.aborted) throw abortError();
        stopState.streamConfirmed = false;
        iterator = options.provider.stream(request, controller.signal)[Symbol.asyncIterator]();
        let completed = false;
        let completedFunctionsStateId: string | undefined;
        let functionCall: ProviderFunctionCall | null = null;
        for (;;) {
          pendingNext = Promise.resolve().then(() => iterator!.next());
          const result = await waitFor(pendingNext, controller.signal, nextTimeoutMs, 'PROVIDER_STEP_TIMEOUT');
          pendingNext = null;
          if (controller.signal.aborted) throw abortError();
          if (result.done) {
            naturallyDone = true;
            stopState.streamConfirmed = true;
            break;
          }
          assertProviderEvent(result.value);
          if (completed || functionCall) throw new Error('PROVIDER_PROTOCOL');
          if (!reservationConsumed) {
            const consuming = options.consumeTurn(turn.input, controller.signal);
            const consumeOutcome = consuming.then(
              () => ({ status: turn.cancelRequested ? 'cancelled' as const : 'failed' as const,
                ...(turn.cancelRequested ? {} : { error: 'Не удалось вовремя подтвердить выбор параметров хода.' }) }),
              (error: unknown) => ({ status: turn.cancelRequested ? 'cancelled' as const : 'failed' as const,
                ...(turn.cancelRequested ? {} : { error: error instanceof Error ? error.message : 'Не удалось подтвердить выбор параметров хода.' }) }),
            );
            const consumed = await bounded(consuming.then(() => true), operationTimeoutMs);
            if (consumed === STOP_TIMEOUT) {
              holdForPendingOperation(turn, stopState, consumeOutcome, 'Ожидание фиксации параметров превысило срок; очередь приостановлена.');
              controller.abort();
              throw new Error('TURN_CONSUME_TIMEOUT');
            }
            reservationConsumed = true;
            if (controller.signal.aborted) throw abortError();
          }
          const rawEvent = result.value;
          if (rawEvent.type === 'activity') {
            addActivity(turn, {
              kind: 'provider', at: new Date().toISOString(), activity: rawEvent.activity,
              ...(rawEvent.tool ? { tool: rawEvent.tool } : {}),
            });
          } else if (rawEvent.type === 'usage') {
            await updateActiveUsage({
              promptTokens: rawEvent.promptTokens,
              completionTokens: rawEvent.completionTokens,
              totalTokens: rawEvent.totalTokens,
              precachedPromptTokens: rawEvent.precachedPromptTokens,
              ...(rawEvent.providerRequestId ? { providerRequestId: rawEvent.providerRequestId } : {}),
              ...(rawEvent.providerModel ? { providerModel: rawEvent.providerModel } : {}),
            });
          } else if (rawEvent.type === 'text-delta') {
            if (answer.length + rawEvent.text.length > MAX_ASSISTANT_CHARS) throw new Error('RESPONSE_LIMIT');
            answer += rawEvent.text;
            scheduleDraftPublish();
          } else if (rawEvent.type === 'error') {
            if (rawEvent.category === 'cancel') throw abortError();
            throw Object.assign(new Error('PROVIDER_ERROR'), { category: rawEvent.category });
          } else if (rawEvent.type === 'function-call') {
            if (completed || functionCall) throw new Error('PROVIDER_PROTOCOL');
            functionCall = rawEvent.functionCall;
          } else {
            completed = true;
            if (rawEvent.functionsStateId) completedFunctionsStateId = rawEvent.functionsStateId;
          }
        }

        if (controller.signal.aborted) throw abortError();
        if (functionCall) {
          if (completed) throw new Error('PROVIDER_PROTOCOL');
          if (toolRounds >= MAX_FUNCTION_ROUNDS || (request.protocolHistory?.length ?? 0) >= 256) {
            throw Object.assign(new Error('TOOL_ROUND_LIMIT'), { category: 'tool' });
          }
          if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
            controller.abort();
            flushDraft();
            markStopUnconfirmed(turn);
            return;
          }
          await finishActiveUsage('completed');
          addActivity(turn, {
            kind: 'provider', at: new Date().toISOString(), activity: 'waiting-for-tool',
            ...(isProviderToolName(functionCall.name) ? { tool: functionCall.name } : {}),
          });
          if (!options.beginToolReceipt || !options.completeToolReceipt) {
            throw Object.assign(new Error('TOOL_RECEIPT_STORE_UNAVAILABLE'), { category: 'tool' });
          }
          const effectId = effectIdFor(turn.input, functionCall);
          const receiptInput: ToolReceiptInput = {
            receiptId: receiptIdFor(turn.input, functionCall, toolRounds),
            ...(effectId ? { effectId } : {}),
            name: functionCall.name,
            arguments: structuredClone(functionCall.arguments),
            content: functionCall.content,
            functionsStateId: functionCall.functionsStateId,
          };
          if (controller.signal.aborted) throw abortError();
          const beginPromise = options.beginToolReceipt(turn.input, receiptInput);
          const begun = await waitTracked(beginPromise, operationTimeoutMs, 'TOOL_INTENT_SAVE_TIMEOUT', 'Подтверждение сохранения намерения инструмента ожидается; очередь приостановлена.');
          const storedReceipt = begun.receipt;
          let exchange: ProviderProtocolExchange;
          if (!begun.shouldExecute) {
            exchange = {
              anchorMessageId: turn.input.messageId,
              name: functionCall.name,
              arguments: structuredClone(functionCall.arguments),
              content: functionCall.content,
              functionsStateId: functionCall.functionsStateId,
              result: storedReceipt.result ?? errorResult(new Error('Результат инструмента неизвестен.'), true),
            };
          } else {
            const validation = validateToolArguments(functionCall);
            const operation = (async (): Promise<ProviderProtocolExchange> => {
              let resultText: string | null = null;
              let resultStatus: 'completed' | 'unknown' = 'completed';
              let abortAfterSave = false;
              let actualToolOutcome: HookDispatchInput['outcome'] = 'failed';
              if (!validation.ok) resultText = objectResult({ ok: false, error: validation.error, message: validation.message });
              else if (controller.signal.aborted) resultText = objectResult({ ok: false, error: 'cancelled', message: 'Инструмент отменён до запуска.' });
              else {
                let beforeResults: HookRunResult[] = [];
                try {
                  beforeResults = await runHookEvent({
                    event: 'before-tool', projectId: turn.input.projectId,
                    ...(isProviderToolName(functionCall!.name) ? { tool: functionCall!.name } : {}),
                  });
                } catch (hookError) {
                  resultText = errorResult(hookError, false);
                  abortAfterSave = isAbortError(hookError);
                }
                const failedCheck = beforeResults.find((result) => result.status !== 'completed' || result.decision === 'block');
                if (resultText === null && failedCheck) {
                  resultText = objectResult({
                    ok: false,
                    error: 'hook_blocked',
                    message: failedCheck.reason ?? 'Проверка Hook не разрешила запуск инструмента.',
                  });
                }
                if (resultText === null) {
                  try {
                    const result = await invokeTool(functionCall!);
                    const hasSideEffect = functionCall!.name === 'write' || functionCall!.name === 'powershell' || functionCall!.name === 'open';
                    if (controller.signal.aborted && hasSideEffect) {
                      resultStatus = 'unknown';
                      resultText = errorResult(new Error('cancelled'), true);
                      actualToolOutcome = 'cancelled';
                    } else {
                      const commandFailed = functionCall!.name === 'powershell' && typeof result === 'object' && result !== null
                        && (('exitCode' in result && typeof result.exitCode === 'number' && result.exitCode !== 0)
                          || ('timedOut' in result && result.timedOut === true)
                          || ('outputLimited' in result && result.outputLimited === true));
                      actualToolOutcome = commandFailed ? 'failed' : 'completed';
                      if (commandFailed && hasSideEffect) resultStatus = 'unknown';
                      resultText = objectResult({ ok: !commandFailed, result });
                    }
                  } catch (toolError) {
                    const hasSideEffect = functionCall!.name === 'write' || functionCall!.name === 'powershell' || functionCall!.name === 'open';
                    const permissionDenied = toolError instanceof LocalToolError && toolError.code === 'PERMISSION_DENIED';
                    resultStatus = hasSideEffect && !permissionDenied ? 'unknown' : 'completed';
                    actualToolOutcome = isAbortError(toolError) ? 'cancelled' : 'failed';
                    resultText = errorResult(toolError, hasSideEffect && !permissionDenied);
                  }
                  try {
                    await runHookEvent({
                      event: 'after-tool', projectId: turn.input.projectId,
                      ...(isProviderToolName(functionCall!.name) ? { tool: functionCall!.name } : {}),
                      outcome: actualToolOutcome,
                    });
                  } catch (hookError) {
                    if (isAbortError(hookError)) abortAfterSave = true;
                  }
                }
              }
              if (resultText === null) resultText = objectResult({ ok: false, error: 'hook_blocked', message: 'Проверка Hook не завершилась.' });
              if (Buffer.byteLength(resultText, 'utf8') > MAX_TOOL_RESULT_BYTES) {
                resultText = objectResult({ ok: false, error: 'result_limit', message: 'Результат инструмента превышает лимит 16 КиБ.' });
              }
              await options.completeToolReceipt!(turn.input, receiptInput.receiptId, resultStatus, resultText);
              const exchange = {
                anchorMessageId: turn.input.messageId,
                name: functionCall!.name,
                arguments: structuredClone(functionCall!.arguments),
                content: functionCall!.content,
                functionsStateId: functionCall!.functionsStateId,
                result: resultText,
              };
              if (abortAfterSave || controller.signal.aborted) throw abortError();
              return exchange;
            })();
            exchange = await waitTracked(operation, toolTimeoutMs, 'LOCAL_TOOL_TIMEOUT', 'Локальный инструмент или сохранение результата ещё не остановились; очередь приостановлена.');
          }
          if (controller.signal.aborted) throw abortError();
          totalToolResultBytes += Buffer.byteLength(exchange.result, 'utf8');
          if (totalToolResultBytes > MAX_TOTAL_TOOL_RESULT_BYTES) throw Object.assign(new Error('TOOL_RESULT_LIMIT'), { category: 'tool' });
          request = { ...request, protocolHistory: [...(request.protocolHistory ?? []), structuredClone(exchange)] };
          toolRounds += 1;
          if (draftTimer) clearTimeout(draftTimer);
          draftTimer = null;
          answer = '';
          delete turn.draft;
          publish(turn);
          continue;
        }

        if (!completed || !answer.trim()) throw new Error('INCOMPLETE_PROVIDER_RESPONSE');
        if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
          controller.abort();
          flushDraft();
          markStopUnconfirmed(turn);
          return;
        }
        if (controller.signal.aborted) throw abortError();
        await finishActiveUsage('completed');
        stopHooksRan = true;
        await runHookEvent({ event: 'stop', projectId: turn.input.projectId }, new AbortController().signal).catch(() => undefined);
        flushDraft();
        const appending = options.appendAssistant(turn.input, answer, controller.signal, completedFunctionsStateId);
        const appendOutcome = appending.then(
          () => ({ status: 'completed' as const }),
          (error: unknown) => turn.cancelRequested || isAbortError(error)
            ? ({ status: 'cancelled' as const })
            : ({ status: 'failed' as const, error: 'Ответ не удалось сохранить. Сообщение пользователя осталось в чате.' }),
        );
        const appended = await bounded(appending.then(() => true), operationTimeoutMs);
        if (appended === STOP_TIMEOUT) {
          holdForPendingOperation(turn, stopState, appendOutcome, 'Подтверждение сохранения ответа ожидается; очередь приостановлена.');
          return;
        }
        delete turn.draft;
        turn.status = 'completed';
        turn.endedAt = new Date().toISOString();
        turn.activeDurationMs = Math.max(0, Date.now() - started);
        publish(turn);
        break;
      }
    } catch (error) {
      flushDraft();
      if (!turn.cancelRequested && !isAbortError(error) && !naturallyDone) controller.abort();
      if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
        controller.abort();
        flushDraft();
        markStopUnconfirmed(turn);
      } else if (stopState.pendingOperation) {
        if (blockedTurnId !== turn.id) holdForPendingOperation(turn, stopState, Promise.resolve({
          status: 'failed', error: 'Ожидание локальной операции не завершено.',
        }), 'Ожидание локальной операции не завершено; очередь приостановлена.');
      } else if (stopState.pendingOutcome) {
        maybeUnblock(turn.id);
      } else {
        const terminalSignal = new AbortController().signal;
        const cancelled = turn.cancelRequested || isAbortError(error) && !turnTimedOut;
        try { await finishActiveUsage(cancelled ? 'cancelled' : 'failed', terminalSignal); }
        catch (usageError) { error = usageError; }
        if (stopState.pendingOperation || stopState.pendingOutcome || blockedTurnId === turn.id) {
          if (!stopState.pendingOperation) maybeUnblock(turn.id);
          return;
        }
        if (cancelled && !interruptHooksRan) {
          interruptHooksRan = true;
          await runHookEvent({ event: 'interrupt', projectId: turn.input.projectId, outcome: 'cancelled' }, terminalSignal).catch(() => undefined);
        }
        if (!stopHooksRan) {
          stopHooksRan = true;
          await runHookEvent({
            event: 'stop', projectId: turn.input.projectId,
            outcome: cancelled ? 'cancelled' : 'failed',
          }, terminalSignal).catch(() => undefined);
        }
        turn.status = turn.cancelRequested || isAbortError(error) && !turnTimedOut ? 'cancelled' : 'failed';
        turn.endedAt = new Date().toISOString();
        turn.activeDurationMs = Math.max(0, Date.now() - started);
        const category = typeof error === 'object' && error !== null && 'category' in error
          && isProviderErrorCategory(error.category) ? error.category : undefined;
        if (turn.status === 'cancelled') turn.errorCategory = 'cancel';
        else if (category) turn.errorCategory = category;
        else delete turn.errorCategory;
        if (turn.status === 'failed') {
          turn.error = turnTimedOut
            ? 'Ход превысил общий лимит времени.'
            : error instanceof Error && error.message === 'PROVIDER_UNAVAILABLE'
              ? 'GigaChat API пока не подключён.'
              : error instanceof Error && error.message === 'MODEL_NOT_SELECTED'
                ? 'Выберите модель GigaChat для следующего хода.'
                : error instanceof Error && error.message === 'TURN_PREPARE_TIMEOUT'
                  ? 'Подготовка хода превысила ограниченное время ожидания.'
                  : error instanceof Error && error.message === 'PROVIDER_STEP_TIMEOUT'
                    ? 'Поток не ответил в отведённое время.'
                    : error instanceof Error && error.message === 'TURN_CONSUME_TIMEOUT'
                      ? 'Не удалось зафиксировать параметры хода вовремя.'
                      : error instanceof Error && error.message === 'TOOL_ROUND_LIMIT'
                        ? 'Ход остановлен: достигнут лимит последовательных вызовов инструментов.'
                        : error instanceof Error && error.message === 'TOOL_RESULT_LIMIT'
                          ? 'Ход остановлен: суммарный результат инструментов превысил лимит.'
                          : error instanceof Error && error.message === 'LOCAL_TOOL_TIMEOUT'
                            ? 'Локальный инструмент превысил лимит времени; очередь ожидает подтверждённой остановки.'
                            : error instanceof Error && error.message === 'TOOL_INTENT_SAVE_TIMEOUT'
                              ? 'Не удалось вовремя зафиксировать намерение инструмента.'
                              : error instanceof Error && error.message === 'USAGE_RECEIPT_SAVE_TIMEOUT'
                                ? 'Не удалось вовремя сохранить usage; очередь ожидает завершения записи.'
                                : error instanceof Error && error.message === 'USAGE_RECEIPT_SAVE_FAILED'
                                  ? 'Не удалось сохранить usage; запрос не будет продолжен.'
                                  : error instanceof Error && error.message === 'TOOL_RECEIPT_STORE_UNAVAILABLE'
                                    ? 'Сохранение истории инструментов недоступно; действие не выполнено.'
                                    : 'Ход завершился ошибкой. Сообщение пользователя сохранено локально.';
        }
        publish(turn);
      }
    } finally {
      clearTimeout(turnTimer);
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      if (!reservationConsumed) options.releaseTurn(turn.input);
      if (!stopState.pendingOperation && blockedTurnId !== turn.id) turn.controller = undefined;
      if (blockedTurnId !== turn.id && stopConfirmed(stopState)) stopStates.delete(turn.id);
    }
  };

  const drain = async (): Promise<void> => {
    if (draining || blockedTurnId) return;
    draining = true;
    try {
      while (queue.length && !blockedTurnId) {
        const turn = queue.shift();
        if (!turn || turn.status !== 'queued') continue;
        activeTurn = turn;
        await runTurn(turn);
        activeTurn = null;
      }
    } finally {
      activeTurn = null;
      draining = false;
      finishIdleWaiters();
      if (!blockedTurnId && queue.some((turn) => turn.status === 'queued')) void drain();
    }
  };

  return {
    tools: options.tools,
    enqueue: (turnInput) => {
      if (!options.provider) return null;
      const input = requireAcceptedTurn(turnInput);
      if (turns.has(input.turnId)) throw new Error('Повторный ID принятого хода.');
      const turn: RuntimeTurn = {
        id: input.turnId,
        chatId: input.chatId,
        status: 'queued',
        createdAt: new Date().toISOString(),
        activity: [],
        cancelRequested: false,
        input,
      };
      turns.set(turn.id, turn);
      queue.push(turn);
      publish(turn);
      void drain();
      return turn.id;
    },
    list: (chatIdInput) => {
      const chatId = chatIdInput === undefined ? undefined : requireChatId(chatIdInput);
      return [...turns.values()]
        .filter((turn) => chatId === undefined || turn.chatId === chatId)
        .map(copyTurn);
    },
    cancel: (turnIdInput, chatIdInput) => {
      if (typeof turnIdInput !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnIdInput)) return false;
      const turn = turns.get(turnIdInput);
      if (!turn || turn.status !== 'queued' && turn.status !== 'running') return false;
      if (chatIdInput !== undefined && turn.chatId !== requireChatId(chatIdInput)) return false;
      if (turn.status === 'queued') {
        turn.status = 'cancelled';
        turn.endedAt = new Date().toISOString();
        turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
        options.releaseTurn(turn.input);
        publish(turn);
        finishIdleWaiters();
      } else {
        turn.cancelRequested = true;
        turn.controller?.abort();
      }
      return true;
    },
    cancelAll: async () => {
      for (const turn of queue) {
        if (turn.status === 'queued') {
          turn.status = 'cancelled';
          turn.endedAt = new Date().toISOString();
          turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
          options.releaseTurn(turn.input);
          publish(turn);
        }
      }
      activeTurn?.controller?.abort();
      await new Promise<void>((resolve, reject) => {
        if (blockedTurnId) reject(new Error('Очередь приостановлена: остановка хода не подтверждена.'));
        else if (!draining && !activeTurn && !queue.some((turn) => turn.status === 'queued')) resolve();
        else idleWaiters.push({ resolve, reject });
      });
    },
    whenIdle: () => new Promise<void>((resolve, reject) => {
      if (blockedTurnId) reject(new Error('Очередь приостановлена: остановка хода не подтверждена.'));
      else if (!draining && !activeTurn && !queue.some((turn) => turn.status === 'queued')) resolve();
      else idleWaiters.push({ resolve, reject });
    }),
    onUpdate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordToolEvent: (event) => {
      if (event.phase === 'started') {
        if (!activeTurn || activeTurn.status !== 'running') return;
        const state = stopStates.get(activeTurn.id);
        if (!state || toolOwners.has(event.id)) return;
        toolOwners.set(event.id, activeTurn.id);
        state.pendingToolIds.add(event.id);
        addActivity(activeTurn, {
          kind: 'tool', at: event.at, tool: event.tool, phase: event.phase,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        });
        return;
      }
      const ownerId = toolOwners.get(event.id);
      if (!ownerId) return;
      toolOwners.delete(event.id);
      const owner = turns.get(ownerId);
      const state = stopStates.get(ownerId);
      if (state) {
        state.pendingToolIds.delete(event.id);
        notifyStopWaiters(state);
        maybeUnblock(ownerId);
      }
      if (owner) addActivity(owner, {
        kind: 'tool', at: event.at, tool: event.tool, phase: event.phase,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
    },
    recordHookResult: (result) => {
      const turn = activeTurn;
      if (!turn) return;
      addActivity(turn, {
        kind: 'hook', at: new Date().toISOString(), hookId: result.hookId, hookName: result.hookName,
        event: result.event, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
      });
    },
  };
}
