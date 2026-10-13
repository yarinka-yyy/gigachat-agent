import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatArtifact, ChatMessage, ChatTurnRecord } from './contracts';
import {
  buildChatNavigationMarks,
  isNearChatScrollEnd,
  nextChatNavigationIndex,
  preserveChatScrollAnchor,
} from './chat-navigation';

const firstTime = '2026-10-13T10:22:00.000Z';

function user(id: string, text: string, attachmentIds?: string[]): ChatMessage {
  return { id, role: 'user', text, createdAt: firstTime, ...(attachmentIds ? { attachmentIds } : {}) };
}

function turn(overrides: Partial<ChatTurnRecord> & Pick<ChatTurnRecord, 'turnId' | 'anchorMessageId'>): ChatTurnRecord {
  const { turnId, anchorMessageId, ...rest } = overrides;
  const createdAt = rest.createdAt ?? firstTime;
  const status = rest.status ?? 'failed';
  const hasStartOverride = Object.prototype.hasOwnProperty.call(rest, 'startedAt');
  const startedAt = hasStartOverride ? rest.startedAt : (status === 'queued' ? undefined : createdAt);
  const hasEndOverride = Object.prototype.hasOwnProperty.call(rest, 'endedAt');
  const endedAt = hasEndOverride ? rest.endedAt
    : status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
      ? new Date(Date.parse(startedAt ?? createdAt) + 2000).toISOString() : undefined;
  return {
    ...rest,
    turnId,
    anchorMessageId,
    assistantMessageId: rest.operation === 'compaction' ? null : (rest.assistantMessageId ?? `assistant-${turnId}`),
    modelId: rest.modelId ?? 'GigaChat-3-Ultra',
    status,
    createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    activeDurationMs: rest.activeDurationMs ?? 2000,
    activity: rest.activity ?? [],
  };
}

function artifact(id: string, name: string, messageId: string | null): ChatArtifact {
  return { id, name, storedName: name, size: 20, createdAt: firstTime, messageId };
}

test('rail creates one mark per user message and uses the latest linked attempt without inventing legacy completion', () => {
  const messages = [
    user('prompt-a', 'Сохрани точный исходный вопрос.'),
    { id: 'answer-a', role: 'assistant', text: 'Ответ.', createdAt: firstTime } satisfies ChatMessage,
    user('files-only', '', ['file-pdf', 'file-code', 'legacy-only']),
    user('old-user-without-turn', 'Старый запрос без сохранённого статуса.'),
  ];
  const turns = [
    turn({ turnId: 'attempt-old', anchorMessageId: 'prompt-a', status: 'failed', createdAt: '2026-10-13T10:20:00.000Z', startedAt: '2026-10-13T10:20:00.000Z', endedAt: '2026-10-13T10:22:00.000Z' }),
    turn({ turnId: 'attempt-latest', anchorMessageId: 'prompt-a', status: 'completed', createdAt: '2026-10-13T10:23:00.000Z', startedAt: '2026-10-13T10:23:00.000Z', endedAt: '2026-10-13T10:23:02.000Z', activeDurationMs: 2000 }),
  ];
  const artifacts = [
    artifact('file-pdf', 'report.pdf', 'files-only'),
    artifact('file-code', 'answer.ts', 'files-only'),
    artifact('legacy-only', 'old-local.xlsx', null),
  ];

  const marks = buildChatNavigationMarks(messages, turns, artifacts, 'ru-RU', 'Europe/Moscow');

  assert.deepEqual(marks.map((mark) => ({
    messageId: mark.messageId,
    preview: mark.preview,
    time: mark.time,
    status: mark.status,
    isLatest: mark.isLatest,
  })), [
    { messageId: 'prompt-a', preview: 'Сохрани точный исходный вопрос.', time: '13:22', status: 'Выполнено за 2 с', isLatest: false },
    { messageId: 'files-only', preview: 'report.pdf · answer.ts', time: '13:22', status: 'Статус не сохранён', isLatest: false },
    { messageId: 'old-user-without-turn', preview: 'Старый запрос без сохранённого статуса.', time: '13:22', status: 'Статус не сохранён', isLatest: true },
  ]);
  assert.match(marks[0].date ?? '', /2026/);
});

test('file-only messages have a useful fallback and a running request remains observable', () => {
  const marks = buildChatNavigationMarks(
    [user('file-only', '', ['not-linked']), user('running', 'Проверь ход.')],
    [turn({ turnId: 'running-turn', anchorMessageId: 'running', status: 'running', startedAt: firstTime })],
    [artifact('not-linked', 'old.pdf', null)],
  );

  assert.equal(marks[0].preview, 'Вложения недоступны');
  assert.equal(marks[0].status, 'Статус не сохранён');
  assert.equal(marks[1].status, 'Выполняется');
  assert.equal(marks[1].isLatest, true);
});

test('rail keyboard navigation clamps at both ends and supports Home and End', () => {
  assert.equal(nextChatNavigationIndex(1, 'ArrowUp', 4), 0);
  assert.equal(nextChatNavigationIndex(1, 'ArrowDown', 4), 2);
  assert.equal(nextChatNavigationIndex(0, 'ArrowUp', 4), 0);
  assert.equal(nextChatNavigationIndex(3, 'ArrowDown', 4), 3);
  assert.equal(nextChatNavigationIndex(2, 'Home', 4), 0);
  assert.equal(nextChatNavigationIndex(0, 'End', 4), 3);
  assert.equal(nextChatNavigationIndex(0, 'ArrowDown', 0), null);
  assert.equal(nextChatNavigationIndex(0, 'Enter', 4), null);
});

test('scroll following is limited to the near end and an explicit anchor offset is preserved', () => {
  assert.equal(isNearChatScrollEnd({ scrollTop: 790, scrollHeight: 1200, clientHeight: 400 }), true);
  assert.equal(isNearChatScrollEnd({ scrollTop: 650, scrollHeight: 1200, clientHeight: 400 }), false);
  assert.equal(preserveChatScrollAnchor(700, 220, 100, 80), 740);
  assert.equal(preserveChatScrollAnchor(30, 0, 100, 80), 0);
});
