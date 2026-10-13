import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ChatTurnRecord, RuntimeTurnSnapshot } from './contracts';
import { buildTranscriptItems, formatElapsedDuration, formatMessageTimestamp, getCopyableUserMessageText, hookEventLabel, mergeRuntimeTurnSnapshots, mergeTranscriptTurns, transcriptTurnStatusLabel, type TranscriptTurn } from './chat-transcript';

const at = '2026-10-13T10:22:00.000Z';

function user(id: string, text: string): ChatMessage {
  return { id, role: 'user', text, createdAt: at };
}

function answer(id: string, text: string): ChatMessage {
  return { id, role: 'assistant', source: 'runtime', text, createdAt: at };
}

function turn(overrides: Partial<ChatTurnRecord> & Pick<ChatTurnRecord, 'turnId' | 'anchorMessageId' | 'assistantMessageId'>): ChatTurnRecord {
  const { turnId, anchorMessageId, assistantMessageId, ...rest } = overrides;
  return {
    turnId,
    anchorMessageId,
    assistantMessageId,
    modelId: 'GigaChat-3-Ultra',
    status: 'completed',
    createdAt: at,
    startedAt: at,
    endedAt: at,
    activeDurationMs: 2000,
    activity: [{ kind: 'provider', at, activity: 'receiving' }],
    ...rest,
  };
}

function transcriptTurn(record: ChatTurnRecord): TranscriptTurn {
  return { ...record, id: record.turnId, chatId: 'chat-a' };
}

function runtime(overrides: Partial<RuntimeTurnSnapshot> & Pick<RuntimeTurnSnapshot, 'id' | 'anchorMessageId' | 'assistantMessageId'>): RuntimeTurnSnapshot {
  const { id, anchorMessageId, assistantMessageId, ...rest } = overrides;
  return {
    id,
    chatId: 'chat-a',
    anchorMessageId,
    assistantMessageId,
    modelId: 'GigaChat-3-Ultra',
    status: 'running',
    createdAt: at,
    activity: [],
    ...rest,
  };
}

function itemSummary(items: ReturnType<typeof buildTranscriptItems>): string[] {
  return items.map((item) => item.kind === 'activity'
    ? `turn:${item.turn.turnId}`
    : item.kind === 'draft'
      ? `draft:${item.turn.turnId}:${item.text}`
      : `message:${item.message.id}`);
}

test('transcript binds activity and answers to explicit IDs when message and turn arrays are out of order', () => {
  const messages = [
    user('user-a', 'Вопрос A'),
    user('user-b', 'Вопрос B'),
    answer('answer-a', 'Ответ A'),
    answer('answer-b', 'Ответ B'),
    answer('legacy-answer', 'Старый ответ без связи'),
  ];
  const turns = [
    turn({ turnId: 'turn-b', anchorMessageId: 'user-b', assistantMessageId: 'answer-b' }),
    turn({ turnId: 'turn-a', anchorMessageId: 'user-a', assistantMessageId: 'answer-a' }),
  ];

  assert.deepEqual(itemSummary(buildTranscriptItems(messages, turns.map(transcriptTurn))), [
    'message:user-a', 'turn:turn-a', 'message:answer-a',
    'message:user-b', 'turn:turn-b', 'message:answer-b', 'message:legacy-answer',
  ]);
});

test('an explicitly linked answer that arrives before its user anchor is rendered only after its activity', () => {
  const messages = [answer('answer-a', 'Ответ A'), user('user-a', 'Вопрос A')];
  const turns = [turn({ turnId: 'turn-a', anchorMessageId: 'user-a', assistantMessageId: 'answer-a' })];

  assert.deepEqual(itemSummary(buildTranscriptItems(messages, turns.map(transcriptTurn))), [
    'message:user-a', 'turn:turn-a', 'message:answer-a',
  ]);
});

test('retry attempts sharing one reserved assistant ID render one final answer after the successful attempt', () => {
  const messages = [user('user-a', 'Повтори'), answer('assistant-reserved', 'Итоговый ответ')];
  const turns = [
    turn({ turnId: 'attempt-1', anchorMessageId: 'user-a', assistantMessageId: 'assistant-reserved', status: 'failed', error: 'Сеть' }),
    turn({ turnId: 'attempt-2', anchorMessageId: 'user-a', assistantMessageId: 'assistant-reserved', status: 'completed' }),
  ];

  const items = buildTranscriptItems(messages, turns.map(transcriptTurn));
  assert.deepEqual(itemSummary(items), [
    'message:user-a', 'turn:attempt-1', 'turn:attempt-2', 'message:assistant-reserved',
  ]);
  assert.equal(items.filter((item) => item.kind === 'message' && item.message.id === 'assistant-reserved').length, 1);
});

test('live turn snapshots merge by turn ID only and cannot regress a durable completed answer', () => {
  const persisted = [turn({ turnId: 'turn-a', anchorMessageId: 'user-a', assistantMessageId: 'answer-a' })];
  const live = [
    runtime({ id: 'turn-a', anchorMessageId: 'user-a', assistantMessageId: 'answer-a', status: 'running', draft: 'частичный текст' }),
    runtime({ id: 'wrong-link', anchorMessageId: 'missing-user', assistantMessageId: 'answer-x', status: 'running', draft: 'не показывать' }),
  ];

  const merged = mergeTranscriptTurns('chat-a', [user('user-a', 'Вопрос')], persisted, live);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'completed');
  assert.equal(merged[0].draft, undefined);
  assert.deepEqual(itemSummary(buildTranscriptItems([user('user-a', 'Вопрос'), answer('answer-a', 'Ответ')], merged)), [
    'message:user-a', 'turn:turn-a', 'message:answer-a',
  ]);
});

test('an older active turn remains available among a long FIFO queue and a late list snapshot cannot replace a newer update', () => {
  const active = runtime({ id: 'active', anchorMessageId: 'user-a', assistantMessageId: 'answer-a', status: 'running', draft: 'актуальный ответ' });
  const queued = Array.from({ length: 14 }, (_, index) => runtime({
    id: `queued-${index}`,
    anchorMessageId: `user-${index + 1}`,
    assistantMessageId: `answer-${index + 1}`,
    status: 'queued',
  }));
  const staleListActive = { ...active, status: 'queued' as const, draft: undefined };
  const merged = mergeRuntimeTurnSnapshots('chat-a', [staleListActive, ...queued], [...queued, active]);

  assert.equal(merged.length, 15);
  assert.equal(merged.find((item) => item.id === 'active')?.status, 'running');
  assert.equal(merged.find((item) => item.id === 'active')?.draft, 'актуальный ответ');
});

test('running and interrupted turns keep one unfinished answer location; compaction has no assistant card', () => {
  const messages = [user('user-a', 'Вопрос')];
  const turns: TranscriptTurn[] = [
    { ...transcriptTurn(turn({ turnId: 'running', anchorMessageId: 'user-a', assistantMessageId: 'reserved-running', status: 'running' })), draft: 'Промежуточный ответ' },
    transcriptTurn(turn({ turnId: 'compact', anchorMessageId: 'user-a', assistantMessageId: null, operation: 'compaction', status: 'completed' })),
  ];
  const items = buildTranscriptItems(messages, turns);
  assert.deepEqual(itemSummary(items), [
    'message:user-a', 'turn:compact', 'turn:running', 'draft:running:Промежуточный ответ',
  ]);
  assert.equal(items.filter((item) => item.kind === 'draft' && item.text === 'Промежуточный ответ').length, 1);
  assert.equal(items.some((item) => item.kind === 'message' && item.message.id === 'reserved-running'), false);
});

test('duration summary is compact and does not invent a duration for old records', () => {
  assert.equal(formatElapsedDuration(undefined), null);
  assert.equal(formatElapsedDuration(Number.NaN), null);
  assert.equal(formatElapsedDuration(-1), null);
  assert.equal(formatElapsedDuration(2000), '2 с');
  assert.equal(formatElapsedDuration(119_000), '1 мин 59 с');
  assert.equal(formatElapsedDuration(90_061_000), '1 дн 1 ч 1 мин 1 с');
});

test('failed turns without a start time are labeled not sent while started failures remain failures', () => {
  const notSent = transcriptTurn(turn({ turnId: 'unsent', anchorMessageId: 'user-a', assistantMessageId: 'assistant-a', status: 'failed', startedAt: undefined }));
  const started = transcriptTurn(turn({ turnId: 'failed', anchorMessageId: 'user-a', assistantMessageId: 'assistant-a', status: 'failed', startedAt: at }));
  assert.equal(transcriptTurnStatusLabel(notSent), 'Не отправлено');
  assert.equal(transcriptTurnStatusLabel(started), 'Не удалось завершить');
});

test('message time uses local timezone formatting and keeps an absolute date title', () => {
  const moscow = formatMessageTimestamp(at, 'ru-RU', 'Europe/Moscow');
  const losAngeles = formatMessageTimestamp(at, 'ru-RU', 'America/Los_Angeles');
  assert.equal(moscow?.time, '13:22');
  assert.equal(losAngeles?.time, '03:22');
  assert.match(moscow?.title ?? '', /2026/);
  assert.match(losAngeles?.title ?? '', /2026/);
  assert.equal(formatMessageTimestamp('invalid', 'ru-RU', 'Europe/Moscow'), null);
});

test('hook activity uses the existing Russian event names', () => {
  assert.equal(hookEventLabel('after-compaction'), 'После сжатия контекста');
  assert.equal(hookEventLabel('permission-request'), 'Запрос разрешения');
});

test('copy source accepts only the exact stored user message text', () => {
  const messages = [user('user-a', '  точный текст\nс переносом  '), answer('answer-a', 'Ответ')];
  assert.equal(getCopyableUserMessageText(messages, 'user-a'), '  точный текст\nс переносом  ');
  assert.throws(() => getCopyableUserMessageText(messages, 'missing'), /Сообщение для копирования не найдено/);
  assert.throws(() => getCopyableUserMessageText(messages, 'answer-a'), /Сообщение для копирования не найдено/);
});
