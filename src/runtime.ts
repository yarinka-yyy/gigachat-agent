import type {
  AcceptedTurnInput,
  GigaChatProvider,
  ProviderErrorCategory,
  ProviderEvent,
  ProviderTurnRequest,
  RuntimeActivity,
  RuntimeTurnSnapshot,
} from './contracts';
import { PROVIDER_ERROR_CATEGORIES } from './contracts';
import type { LocalToolEvent, LocalTools } from './local-tools';

const MAX_ACTIVITY_PER_TURN = 50;
const MAX_ASSISTANT_CHARS = 100_000;
const DRAFT_UPDATE_INTERVAL_MS = 50;
const DEFAULT_PREPARE_TIMEOUT_MS = 15_000;
const DEFAULT_NEXT_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT = Symbol('stop-timeout');

export interface TurnRuntimeOptions {
  provider?: GigaChatProvider | null;
  tools: LocalTools;
  prepareTurn(turn: AcceptedTurnInput, signal: AbortSignal): Promise<ProviderTurnRequest>;
  consumeTurn(turn: AcceptedTurnInput, signal: AbortSignal): Promise<void>;
  releaseTurn(turn: AcceptedTurnInput): void;
  appendAssistant(turn: AcceptedTurnInput, text: string, signal: AbortSignal): Promise<void>;
  timeouts?: { prepareMs?: number; nextMs?: number; stopMs?: number; operationMs?: number };
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
  if (event.type === 'completed') return;
  if (event.type === 'error' && isProviderErrorCategory(event.category) && typeof event.retryable === 'boolean') return;
  throw new Error('BAD_PROVIDER_EVENT');
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
    let reservationConsumed = false;
    let answer = '';
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDraftPublishedAt = 0;
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
    try {
      if (!options.provider) throw new Error('PROVIDER_UNAVAILABLE');
      if (!turn.input.modelId) throw new Error('MODEL_NOT_SELECTED');
      const preparation = Promise.resolve().then(() => options.prepareTurn(turn.input, controller.signal));
      const request = await waitFor(preparation, controller.signal, prepareTimeoutMs, 'TURN_PREPARE_TIMEOUT');
      if (controller.signal.aborted) throw abortError();
      if (!request.modelId) throw new Error('MODEL_NOT_SELECTED');

      const stream = options.provider.stream(request, controller.signal);
      const activeIterator = stream[Symbol.asyncIterator]();
      iterator = activeIterator;
      let completed = false;
      for (;;) {
        pendingNext = Promise.resolve().then(() => activeIterator.next());
        const nextPromise = pendingNext;
        const result = await waitFor(nextPromise, controller.signal, nextTimeoutMs, 'PROVIDER_STEP_TIMEOUT');
        pendingNext = null;
        if (controller.signal.aborted) throw abortError();
        if (result.done) {
          naturallyDone = true;
          stopState.streamConfirmed = true;
          break;
        }
        if (completed) throw new Error('PROVIDER_PROTOCOL');
        assertProviderEvent(result.value);
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
        } else if (rawEvent.type === 'text-delta') {
          if (answer.length + rawEvent.text.length > MAX_ASSISTANT_CHARS) throw new Error('RESPONSE_LIMIT');
          answer += rawEvent.text;
          scheduleDraftPublish();
        } else if (rawEvent.type === 'error') {
          if (rawEvent.category === 'cancel') throw abortError();
          throw Object.assign(new Error('PROVIDER_ERROR'), { category: rawEvent.category });
        } else completed = true;
      }
      if (controller.signal.aborted) throw abortError();
      if (!completed || !answer.trim()) throw new Error('INCOMPLETE_PROVIDER_RESPONSE');
      if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
        controller.abort();
        flushDraft();
        markStopUnconfirmed(turn);
        return;
      }
      if (controller.signal.aborted) throw abortError();
      flushDraft();
      const appending = options.appendAssistant(turn.input, answer, controller.signal);
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
        turn.status = turn.cancelRequested || isAbortError(error) ? 'cancelled' : 'failed';
        turn.endedAt = new Date().toISOString();
        turn.activeDurationMs = Math.max(0, Date.now() - started);
        const category = typeof error === 'object' && error !== null && 'category' in error
          && isProviderErrorCategory(error.category) ? error.category : undefined;
        if (turn.status === 'cancelled') turn.errorCategory = 'cancel';
        else if (category) turn.errorCategory = category;
        else delete turn.errorCategory;
        if (turn.status === 'failed') {
          turn.error = error instanceof Error && error.message === 'PROVIDER_UNAVAILABLE'
            ? 'GigaChat API пока не подключён.'
            : error instanceof Error && error.message === 'MODEL_NOT_SELECTED'
              ? 'Выберите модель GigaChat для следующего хода.'
              : error instanceof Error && error.message === 'TURN_PREPARE_TIMEOUT'
                ? 'Подготовка хода превысила ограниченное время ожидания.'
                : error instanceof Error && error.message === 'PROVIDER_STEP_TIMEOUT'
                  ? 'Поток не ответил в отведённое время.'
                  : error instanceof Error && error.message === 'TURN_CONSUME_TIMEOUT'
                    ? 'Не удалось зафиксировать параметры хода вовремя.'
                  : 'Ход завершился ошибкой. Сообщение пользователя сохранено локально.';
        }
        publish(turn);
      }
    } finally {
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
  };
}
