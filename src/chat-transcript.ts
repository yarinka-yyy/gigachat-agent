import type { ChatMessage, ChatTurnRecord, HookEvent, RuntimeTurnSnapshot } from './contracts';

export interface TranscriptTurn extends ChatTurnRecord {
  id: string;
  chatId: string;
  draft?: string;
  retryEligible?: boolean;
  runtimeSnapshot?: RuntimeTurnSnapshot;
}

export type ChatTranscriptItem =
  | { kind: 'message'; message: ChatMessage; turnId?: string }
  | { kind: 'activity'; turn: TranscriptTurn }
  | { kind: 'draft'; turn: TranscriptTurn; text: string };

function isTerminal(status: RuntimeTurnSnapshot['status'] | ChatTurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

function sameTurnBinding(record: ChatTurnRecord, snapshot: RuntimeTurnSnapshot, chatId: string): boolean {
  return snapshot.chatId === chatId
    && snapshot.id === record.turnId
    && snapshot.anchorMessageId === record.anchorMessageId
    && snapshot.assistantMessageId === record.assistantMessageId
    && snapshot.operation === record.operation
    && (snapshot.modelId === undefined || snapshot.modelId === record.modelId);
}

export function mergeRuntimeTurnSnapshots(
  chatId: string,
  current: readonly RuntimeTurnSnapshot[],
  updates: readonly RuntimeTurnSnapshot[],
): RuntimeTurnSnapshot[] {
  const byId = new Map<string, RuntimeTurnSnapshot>();
  for (const turn of current) if (turn.chatId === chatId) byId.set(turn.id, turn);
  for (const turn of updates) if (turn.chatId === chatId) byId.set(turn.id, turn);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function mergeTranscriptTurns(
  chatId: string,
  messages: readonly ChatMessage[],
  persisted: readonly ChatTurnRecord[],
  runtime: readonly RuntimeTurnSnapshot[],
): TranscriptTurn[] {
  const result = new Map<string, TranscriptTurn>();
  const userMessageIds = new Set(messages.filter((message) => message.role === 'user').map((message) => message.id));
  for (const record of persisted) {
    const turn: TranscriptTurn = {
      ...record,
      id: record.turnId,
      chatId,
    };
    result.set(turn.id, turn);
  }

  for (const snapshot of runtime) {
    if (snapshot.chatId !== chatId || !userMessageIds.has(snapshot.anchorMessageId)) continue;
    const existing = result.get(snapshot.id);
    if (existing && !sameTurnBinding(existing, snapshot, chatId)) continue;
    if (!existing) {
      result.set(snapshot.id, {
        turnId: snapshot.id,
        id: snapshot.id,
        chatId,
        anchorMessageId: snapshot.anchorMessageId,
        assistantMessageId: snapshot.assistantMessageId,
        modelId: snapshot.modelId ?? null,
        ...(snapshot.operation ? { operation: snapshot.operation } : {}),
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
        ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
        ...(snapshot.queueDurationMs === undefined ? {} : { queueDurationMs: snapshot.queueDurationMs }),
        ...(snapshot.activeDurationMs === undefined ? {} : { activeDurationMs: snapshot.activeDurationMs }),
        activity: structuredClone(snapshot.activity),
        ...(snapshot.error ? { error: snapshot.error } : {}),
        ...(snapshot.errorCategory ? { errorCategory: snapshot.errorCategory } : {}),
        ...(snapshot.draft === undefined ? {} : { draft: snapshot.draft }),
        ...(snapshot.retryEligible ? { retryEligible: true } : {}),
        runtimeSnapshot: structuredClone(snapshot),
      });
      continue;
    }

    const keepDurableTerminal = isTerminal(existing.status) && !isTerminal(snapshot.status);
    result.set(snapshot.id, {
      ...existing,
      ...(!keepDurableTerminal ? {
        status: snapshot.status,
        ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
        ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
        ...(snapshot.queueDurationMs === undefined ? {} : { queueDurationMs: snapshot.queueDurationMs }),
        ...(snapshot.activeDurationMs === undefined ? {} : { activeDurationMs: snapshot.activeDurationMs }),
        activity: structuredClone(snapshot.activity),
        ...(snapshot.error ? { error: snapshot.error } : { error: undefined }),
        ...(snapshot.errorCategory ? { errorCategory: snapshot.errorCategory } : { errorCategory: undefined }),
        ...(snapshot.draft === undefined ? { draft: undefined } : { draft: snapshot.draft }),
      } : {}),
      ...(snapshot.retryEligible ? { retryEligible: true } : { retryEligible: undefined }),
      runtimeSnapshot: structuredClone(snapshot),
    });
  }

  return [...result.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function buildTranscriptItems(
  messages: readonly ChatMessage[],
  turns: readonly TranscriptTurn[],
): ChatTranscriptItem[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const turnsByAnchor = new Map<string, TranscriptTurn[]>();
  const completedOwners = new Map<string, TranscriptTurn[]>();

  for (const turn of turns) {
    const anchor = messagesById.get(turn.anchorMessageId);
    if (!anchor || anchor.role !== 'user') continue;
    const anchored = turnsByAnchor.get(turn.anchorMessageId) ?? [];
    anchored.push(turn);
    turnsByAnchor.set(turn.anchorMessageId, anchored);
    if (turn.status === 'completed' && turn.operation !== 'compaction' && turn.assistantMessageId !== null) {
      const owners = completedOwners.get(turn.assistantMessageId) ?? [];
      owners.push(turn);
      completedOwners.set(turn.assistantMessageId, owners);
    }
  }

  for (const anchored of turnsByAnchor.values()) {
    anchored.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  const answerOwnerByMessageId = new Map<string, string>();
  for (const [messageId, owners] of completedOwners) {
    if (owners.length === 1) answerOwnerByMessageId.set(messageId, owners[0].turnId);
  }

  const items: ChatTranscriptItem[] = [];
  const insertedAnswers = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && (insertedAnswers.has(message.id) || answerOwnerByMessageId.has(message.id))) continue;
    items.push({ kind: 'message', message });
    if (message.role !== 'user') continue;

    for (const turn of turnsByAnchor.get(message.id) ?? []) {
      items.push({ kind: 'activity', turn });
      const assistantId = turn.assistantMessageId;
      if (assistantId && answerOwnerByMessageId.get(assistantId) === turn.turnId) {
        const response = messagesById.get(assistantId);
        if (response?.role === 'assistant' && !insertedAnswers.has(assistantId)) {
          items.push({ kind: 'message', message: response, turnId: turn.turnId });
          insertedAnswers.add(assistantId);
          continue;
        }
      }
      if (turn.draft !== undefined && turn.draft.length > 0
        && !(assistantId && messagesById.has(assistantId))) {
        items.push({ kind: 'draft', turn, text: turn.draft });
      }
    }
  }
  return items;
}

export function formatElapsedDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  let seconds = Math.round(durationMs / 1000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts = [
    days ? `${days} дн` : '',
    hours ? `${hours} ч` : '',
    minutes ? `${minutes} мин` : '',
    `${seconds} с`,
  ].filter(Boolean);
  return parts.join(' ');
}

export function transcriptTurnStatusLabel(turn: TranscriptTurn): string {
  if (turn.operation === 'compaction') {
    if (turn.status === 'completed') return 'Контекст обновлён';
    if (turn.status === 'running') return 'Обновление контекста';
    if (turn.status === 'queued') return 'Сжатие контекста в очереди';
  }
  if (turn.status === 'completed') {
    const duration = formatElapsedDuration(turn.activeDurationMs);
    return duration ? `Выполнено за ${duration}` : 'Выполнено';
  }
  if (turn.status === 'queued') return 'В очереди';
  if (turn.status === 'running') return 'Выполняется';
  if (turn.status === 'cancelled') return 'Остановлено';
  if (turn.status === 'interrupted') return 'Прервано при закрытии приложения';
  return turn.startedAt === undefined ? 'Не отправлено' : 'Не удалось завершить';
}

export function formatMessageTimestamp(
  value: string,
  locale = 'ru-RU',
  timeZone?: string,
): { time: string; title: string } | null {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const zoneOption = timeZone === undefined ? {} : { timeZone };
  return {
    time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zoneOption }).format(timestamp),
    title: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', ...zoneOption }).format(timestamp),
  };
}

export function hookEventLabel(event: HookEvent): string {
  const labels: Record<HookEvent, string> = {
    'session-start': 'Начало сессии', 'project-start': 'Открытие проекта',
    'user-prompt-submitted': 'Отправка запроса', 'before-tool': 'Перед инструментом',
    'after-tool': 'После инструмента', 'permission-request': 'Запрос разрешения',
    'before-compaction': 'Перед сжатием контекста', 'after-compaction': 'После сжатия контекста',
    interrupt: 'Прерывание', stop: 'Остановка', 'session-end': 'Завершение сессии', 'project-end': 'Завершение проекта',
  };
  return labels[event];
}

export function getCopyableUserMessageText(messages: readonly ChatMessage[], messageId: string): string {
  const message = messages.find((item) => item.id === messageId && item.role === 'user');
  if (!message) throw new Error('Сообщение для копирования не найдено.');
  return message.text;
}
