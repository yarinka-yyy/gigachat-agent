import { randomUUID } from 'node:crypto';
import type {
  GigaChatProvider,
  ProviderEvent,
  ProviderTurnRequest,
  RuntimeActivity,
  RuntimeTurnSnapshot,
} from './contracts';
import type { LocalToolEvent, LocalTools } from './local-tools';

const MAX_ACTIVITY_PER_TURN = 50;
const MAX_ASSISTANT_CHARS = 100_000;

export interface TurnRuntimeOptions {
  provider?: GigaChatProvider | null;
  tools: LocalTools;
  prepareTurn(chatId: string): Promise<ProviderTurnRequest>;
  appendAssistant(chatId: string, text: string): Promise<void>;
  onUpdate?(turn: RuntimeTurnSnapshot): void;
}

export interface TurnRuntime {
  readonly tools: LocalTools;
  enqueue(chatId: unknown): string | null;
  list(chatId?: unknown): RuntimeTurnSnapshot[];
  cancel(turnId: unknown, chatId?: unknown): boolean;
  cancelAll(): Promise<void>;
  whenIdle(): Promise<void>;
  onUpdate(listener: (turn: RuntimeTurnSnapshot) => void): () => void;
  recordToolEvent(event: LocalToolEvent): void;
}

interface RuntimeTurn extends RuntimeTurnSnapshot {
  controller?: AbortController;
  cancelRequested: boolean;
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
    ...(turn.error ? { error: turn.error } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'ABORT_ERR');
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
  if (event.type === 'error' && typeof event.code === 'string' && typeof event.retryable === 'boolean') return;
  throw new Error('BAD_PROVIDER_EVENT');
}

export function createTurnRuntime(options: TurnRuntimeOptions): TurnRuntime {
  const turns = new Map<string, RuntimeTurn>();
  const queue: RuntimeTurn[] = [];
  const listeners = new Set<(turn: RuntimeTurnSnapshot) => void>();
  let activeTurn: RuntimeTurn | null = null;
  let draining = false;
  const idleWaiters: Array<() => void> = [];

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

  const finishIdleWaiters = (): void => {
    if (draining || activeTurn || queue.some((turn) => turn.status === 'queued')) return;
    for (const resolveWaiter of idleWaiters.splice(0)) resolveWaiter();
  };

  const runTurn = async (turn: RuntimeTurn): Promise<void> => {
    const controller = new AbortController();
    turn.controller = controller;
    turn.status = 'running';
    turn.startedAt = new Date().toISOString();
    turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
    publish(turn);
    const started = Date.now();
    try {
      const request = await options.prepareTurn(turn.chatId);
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (!options.provider) throw new Error('PROVIDER_UNAVAILABLE');
      if (!request.modelId) throw new Error('MODEL_NOT_SELECTED');
      let answer = '';
      let completed = false;
      for await (const rawEvent of options.provider.stream(request, controller.signal)) {
        if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        if (completed) throw new Error('PROVIDER_PROTOCOL');
        assertProviderEvent(rawEvent);
        if (rawEvent.type === 'activity') {
          addActivity(turn, {
            kind: 'provider',
            at: new Date().toISOString(),
            activity: rawEvent.activity,
            ...(rawEvent.tool ? { tool: rawEvent.tool } : {}),
          });
        } else if (rawEvent.type === 'text-delta') {
          if (answer.length + rawEvent.text.length > MAX_ASSISTANT_CHARS) throw new Error('RESPONSE_LIMIT');
          answer += rawEvent.text;
        } else if (rawEvent.type === 'error') {
          throw new Error('PROVIDER_ERROR');
        } else completed = true;
      }
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (!completed || !answer.trim()) throw new Error('INCOMPLETE_PROVIDER_RESPONSE');
      await options.appendAssistant(turn.chatId, answer);
      turn.status = 'completed';
      turn.endedAt = new Date().toISOString();
      turn.activeDurationMs = Math.max(0, Date.now() - started);
      publish(turn);
    } catch (error) {
      turn.status = controller.signal.aborted || turn.cancelRequested || isAbortError(error) ? 'cancelled' : 'failed';
      turn.endedAt = new Date().toISOString();
      turn.activeDurationMs = Math.max(0, Date.now() - started);
      if (turn.status === 'failed') {
        turn.error = error instanceof Error && error.message === 'PROVIDER_UNAVAILABLE'
          ? 'GigaChat API пока не подключён.'
          : error instanceof Error && error.message === 'MODEL_NOT_SELECTED'
            ? 'Выберите модель GigaChat для следующего хода.'
            : 'Ход завершился ошибкой. Сообщение пользователя сохранено локально.';
      }
      publish(turn);
    } finally {
      turn.controller = undefined;
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
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
      if (queue.some((turn) => turn.status === 'queued')) void drain();
    }
  };

  return {
    tools: options.tools,
    enqueue: (chatIdInput) => {
      const chatId = requireChatId(chatIdInput);
      if (!options.provider) return null;
      const turn: RuntimeTurn = {
        id: randomUUID(),
        chatId,
        status: 'queued',
        createdAt: new Date().toISOString(),
        activity: [],
        cancelRequested: false,
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
          publish(turn);
        }
      }
      activeTurn?.controller?.abort();
      await new Promise<void>((resolveWaiter) => {
        if (!draining && !activeTurn && !queue.some((turn) => turn.status === 'queued')) resolveWaiter();
        else idleWaiters.push(resolveWaiter);
      });
    },
    whenIdle: () => new Promise<void>((resolveWaiter) => {
      if (!draining && !activeTurn && !queue.some((turn) => turn.status === 'queued')) resolveWaiter();
      else idleWaiters.push(resolveWaiter);
    }),
    onUpdate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordToolEvent: (event) => {
      if (!activeTurn) return;
      addActivity(activeTurn, {
        kind: 'tool',
        at: event.at,
        tool: event.tool,
        phase: event.phase,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
    },
  };
}
