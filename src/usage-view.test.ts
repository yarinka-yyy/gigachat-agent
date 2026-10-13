import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsageProfileInput } from './usage-view';
import { buildUsageProfileView } from './usage-view';
import type { ChatToolReceipt, UsageProfileView, UsageReceipt } from './contracts';

const NOW = '2026-10-13T12:00:00.000Z';

function receipt(index: number, overrides: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    localRequestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    chatId: 'chat-a', requestKind: 'chat', modelId: 'GigaChat-3-Pro',
    providerRequestId: null, providerModel: null, createdAt: NOW, status: 'completed',
    promptTokens: 12, completionTokens: 3, totalTokens: 15, precachedPromptTokens: null,
    conflictedFields: [],
    ...overrides,
  };
}

function emptyChat(id: string, overrides: Partial<UsageProfileInput['chats'][number]> = {}): UsageProfileInput['chats'][number] {
  return {
    id, title: id, archived: false,
    messages: [], turns: [], toolReceipts: [],
    ...overrides,
  };
}

function profile(overrides: Partial<UsageProfileInput> = {}): UsageProfileView {
  return buildUsageProfileView({
    generatedAt: NOW,
    timeZone: 'UTC',
    receipts: [],
    chats: [],
    projects: [],
    installedSkillCount: 0,
    ...overrides,
  });
}

function aggregate(view: UsageProfileView, key: string) {
  const result = view.byFamily.find((item) => item.key === key);
  assert.ok(result, `missing family ${key}`);
  return result;
}

test('groups only exact current and legacy model IDs into billing families', () => {
  const view = profile({ receipts: [
    receipt(1, { modelId: 'GigaChat-2-Pro', totalTokens: 40 }),
    receipt(2, { modelId: 'GigaChat-3-Pro', totalTokens: 60 }),
    receipt(3, { modelId: 'GigaChat-2', totalTokens: 7 }),
    receipt(4, { modelId: 'GigaChat-3-Lightning', totalTokens: 9 }),
    receipt(5, { modelId: 'vendor/Pro-preview', totalTokens: 100 }),
  ] });

  assert.equal(aggregate(view, 'pro').totalTokens.knownTokens, 100);
  assert.equal(aggregate(view, 'lite').totalTokens.knownTokens, 16);
  assert.equal(aggregate(view, 'unknown').totalTokens.knownTokens, 100);
  assert.deepEqual(view.byFamily.map((item) => item.key), ['ultra', 'max', 'pro', 'lite', 'unknown']);
});

test('deduplicates compatible provider request IDs and preserves count conflicts and incompatible provenance', () => {
  const shared = { providerRequestId: 'provider-1', createdAt: '2026-10-12T10:00:00.000Z' };
  const view = profile({ receipts: [
    receipt(1, { ...shared, totalTokens: 20 }),
    receipt(2, { ...shared, totalTokens: 20 }),
    receipt(3, { providerRequestId: 'provider-2', createdAt: '2026-10-12T11:00:00.000Z', totalTokens: 30 }),
    receipt(4, { providerRequestId: 'provider-2', chatId: 'chat-b', createdAt: '2026-10-12T11:00:00.000Z', totalTokens: 31 }),
    receipt(5, { providerRequestId: 'provider-3', createdAt: '2026-10-12T12:00:00.000Z', totalTokens: 11 }),
    receipt(6, { providerRequestId: 'provider-3', createdAt: '2026-10-12T12:00:00.000Z', totalTokens: 12 }),
  ] });

  assert.equal(view.total.requestCount, 4, 'compatible provider duplicates collapse, incompatible chat provenance remains separate');
  assert.equal(view.total.totalTokens.knownTokens, 81, 'the conflicting field is not counted as a known zero or sum');
  assert.equal(view.total.totalTokens.conflictedRequests, 1);
  assert.equal(view.providerIdentityConflictCount, 1, 'same provider ID across incompatible chats remains separate and visible as uncertainty');
});

test('treats a stale pending row followed by its completed provider receipt as one settled request', () => {
  const shared = { providerRequestId: 'provider-stale', createdAt: '2026-10-12T10:00:00.000Z' };
  const view = profile({ receipts: [
    receipt(1, { ...shared, status: 'pending', promptTokens: null, completionTokens: null, totalTokens: null }),
    receipt(2, { ...shared, status: 'completed', promptTokens: 20, completionTokens: 5, totalTokens: 25 }),
  ] });
  assert.equal(view.total.requestCount, 1);
  assert.equal(view.total.completedRequestCount, 1);
  assert.equal(view.total.totalTokens.knownTokens, 25);
  assert.equal(view.total.totalTokens.unknownRequests, 0);
  assert.equal(view.providerIdentityConflictCount, 0);
});

test('retains unknown, failed and pending counts without subtracting cached prompt twice', () => {
  const view = profile({ receipts: [
    receipt(1, { promptTokens: 100, precachedPromptTokens: 40, totalTokens: 100 }),
    receipt(2, { localRequestId: '00000000-0000-4000-8000-000000000002', status: 'pending', promptTokens: null, completionTokens: null, totalTokens: null }),
    receipt(3, { localRequestId: '00000000-0000-4000-8000-000000000003', status: 'failed', promptTokens: null, completionTokens: null, totalTokens: null }),
  ] });

  assert.equal(view.total.totalTokens.knownTokens, 100);
  assert.equal(view.total.totalTokens.unknownRequests, 2);
  assert.equal(view.total.promptTokens.knownTokens, 100);
  assert.equal(view.total.precachedPromptTokens.knownTokens, 40);
  assert.equal(view.total.pendingRequestCount, 1);
  assert.equal(view.total.failedRequestCount, 1);
});

test('uses local calendar boundaries for day, week, month, activity and timezone changes', () => {
  const receipts = [
    receipt(1, { createdAt: '2026-03-31T20:59:00.000Z', totalTokens: 4 }),
    receipt(2, { localRequestId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-03-31T21:01:00.000Z', totalTokens: 6 }),
    receipt(3, { localRequestId: '00000000-0000-4000-8000-000000000003', createdAt: '2026-04-01T21:01:00.000Z', totalTokens: 8 }),
  ];
  const acceptedMessage = { id: 'sent-no-api', role: 'user' as const, text: 'Вопрос', createdAt: '2026-03-30T12:00:00.000Z' };
  const moscow = profile({
    generatedAt: '2026-04-02T12:00:00.000Z', timeZone: 'Europe/Moscow', receipts,
    chats: [emptyChat('chat-a', { messages: [
      acceptedMessage,
      { id: 'future', role: 'user', text: 'Future', createdAt: '2026-04-02T13:00:00.000Z' },
      { id: 'example', role: 'user', source: 'example', text: 'Seeded example', createdAt: '2026-04-03T10:00:00.000Z' },
    ] })],
  });
  const losAngeles = profile({ generatedAt: '2026-04-02T12:00:00.000Z', timeZone: 'America/Los_Angeles', receipts });

  assert.equal(moscow.localActivity.today.totalTokens.knownTokens, 8);
  assert.equal(moscow.localActivity.month.totalTokens.knownTokens, 14);
  assert.deepEqual(moscow.localActivity.activityDates, ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']);
  assert.equal(moscow.localActivity.activityDayCount, 4, 'an accepted user message counts even if usage is absent');
  assert.equal(moscow.localActivity.streakDays, 4);
  assert.equal(losAngeles.localActivity.activityDayCount, 2, 'changing the OS timezone changes local-day grouping without mutating UTC receipts');
  assert.equal(moscow.total.totalTokens.knownTokens, 18);
});

test('future messages and receipts do not add local activity or streak before the profile snapshot time', () => {
  const view = profile({
    generatedAt: '2026-10-13T12:00:00.000Z',
    chats: [emptyChat('chat-a', { messages: [
      { id: 'future-user', role: 'user', text: 'Future', createdAt: '2026-10-14T08:00:00.000Z' },
    ] })],
    receipts: [receipt(1, { createdAt: '2026-10-14T08:00:00.000Z' })],
  });
  assert.deepEqual(view.localActivity.activityDates, []);
  assert.equal(view.localActivity.streakDays, 0);
});

test('builds a 365/366-day rolling local calendar across leap day without stepping by DST-sized milliseconds', () => {
  const view = profile({ generatedAt: '2024-03-01T12:00:00.000Z', timeZone: 'UTC' });
  const days = view.localActivity.rollingYear.days;
  assert.ok(days.length === 365 || days.length === 366);
  assert.equal(days[days.length - 1]?.date, '2024-03-01');
  assert.equal(days.length, 366);
  assert.ok(days.some((day) => day.date === '2024-02-29'));
  assert.equal(new Set(days.map((day) => day.date)).size, days.length);
});

test('counts archived chats and projects, keeps deleted-chat usage unlinked, and measures messages separately', () => {
  const archived = emptyChat('archived-chat', {
    title: 'Архивный чат', archived: true,
    messages: [
      { id: 'u', role: 'user', text: 'Вопрос', createdAt: NOW },
      { id: 'a', role: 'assistant', text: 'Ответ', createdAt: NOW },
    ],
  });
  const view = profile({
    chats: [archived],
    projects: [{ id: 'archived-project' }],
    receipts: [
      receipt(1, { chatId: 'archived-chat', totalTokens: 20 }),
      receipt(2, { chatId: 'deleted-chat-id', totalTokens: 50 }),
    ],
  });

  assert.equal(view.chats.count, 1);
  assert.equal(view.projects.count, 1);
  assert.equal(view.total.totalTokens.knownTokens, 70);
  assert.equal(view.chats.longestByMessages?.messageCount, 2);
  assert.equal(view.chats.longestByMessages?.chatId, 'archived-chat');
  assert.equal(view.chats.maxTokens?.knownTokens, 20);
  assert.equal(view.chats.maxTokens?.chatId, 'archived-chat', 'deleted chat identity is not restored as a visible chat');
  assert.ok(view.byChat.some((row) => row.chatId === 'archived-chat' && row.archived));
  assert.ok(view.byChat.some((row) => row.chatId === null && row.title === 'Удалённые чаты'));
});

test('counts only durable actual Skill-use metadata and settled local tool receipts', () => {
  const completedTool: ChatToolReceipt = {
    receiptId: 'a'.repeat(64), anchorMessageId: 'u', name: 'read', arguments: { path: 'a.txt' },
    content: null, functionsStateId: null, status: 'completed', result: '{}', createdAt: NOW,
  };
  const unknownTool: ChatToolReceipt = {
    ...completedTool, receiptId: 'b'.repeat(64), name: 'write', status: 'unknown',
  };
  const pendingTool: ChatToolReceipt = {
    ...completedTool, receiptId: 'c'.repeat(64), name: 'powershell', status: 'pending', result: null,
  };
  const view = profile({
    installedSkillCount: null,
    chats: [emptyChat('chat-a', {
      turns: [
        { invokedSkillId: 'global/review', status: 'completed' as const, startedAt: NOW },
        { invokedSkillId: 'global/review', status: 'completed' as const, startedAt: NOW },
        { invokedSkillId: null, pendingSkillId: 'global/in-flight', status: 'interrupted' as const, startedAt: NOW },
        { status: 'completed' as const, startedAt: NOW },
        { status: 'cancelled' as const },
      ],
      toolReceipts: [completedTool, unknownTool, pendingTool],
    })],
  });

  assert.equal(view.skills.installedCount, null);
  assert.equal(view.skills.invocationCount, 2);
  assert.equal(view.skills.unknownTurnCount, 2, 'legacy and interrupted pending Skill records remain unknown, not counted as used');
  assert.deepEqual(view.skills.bySkill, [{ skillId: 'global/review', invocationCount: 2 }]);
  assert.equal(view.tools.invocationCount, 1);
  assert.equal(view.tools.unknownInvocationCount, 1, 'unknown effect receipts are not presented as confirmed tool invocations');
  assert.deepEqual(view.tools.byTool, [
    { tool: 'read', invocationCount: 1, unknownInvocationCount: 0 },
    { tool: 'write', invocationCount: 0, unknownInvocationCount: 1 },
  ]);
});

test('returns empty and uncertain metrics explicitly instead of inventing chat, Skill, or token counts', () => {
  const view = profile({ installedSkillCount: null, receipts: [receipt(1, { totalTokens: null })] });
  assert.equal(view.chats.count, 0);
  assert.equal(view.chats.longestByMessages, null);
  assert.equal(view.chats.maxTokens, null);
  assert.equal(view.skills.installedCount, null);
  assert.equal(view.skills.invocationCount, 0);
  assert.equal(view.total.totalTokens.knownTokens, 0);
  assert.equal(view.total.totalTokens.unknownRequests, 1);
  assert.equal(view.localActivity.streakDays, 1, 'a recorded API request is an activity day even when its token total is unknown');
});
