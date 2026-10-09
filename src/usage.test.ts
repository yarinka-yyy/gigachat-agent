import assert from 'node:assert/strict';
import test from 'node:test';
import type { UsageReceipt } from './contracts';
import { mergeUsageReceipt, summarizeUsage, validateUsageReceipt } from './usage';

function receipt(overrides: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    localRequestId: '11111111-1111-4111-8111-111111111111',
    chatId: 'chat-one',
    requestKind: 'chat',
    modelId: 'GigaChat-test',
    providerRequestId: null,
    providerModel: null,
    createdAt: '2026-10-09T00:00:00.000Z',
    status: 'pending',
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    precachedPromptTokens: null,
    conflictedFields: [],
    ...overrides,
  };
}

test('merges repeated request receipts without double-counting and preserves raw cache fields', () => {
  const started = receipt();
  const measured = receipt({
    providerRequestId: 'response-1', providerModel: 'GigaChat-2',
    promptTokens: 100, completionTokens: 40, totalTokens: 140, precachedPromptTokens: 25,
  });
  const completed = receipt({ ...measured, status: 'completed' });
  const merged = mergeUsageReceipt(mergeUsageReceipt(started, measured), completed);

  assert.equal(merged.promptTokens, 100);
  assert.equal(merged.totalTokens, 140);
  assert.equal(merged.precachedPromptTokens, 25);
  assert.equal(merged.status, 'completed');
  assert.equal(summarizeUsage([merged]).requestCount, 1);
  assert.equal(summarizeUsage([merged]).totalTokens.knownTokens, 140);
});

test('marks conflicting duplicate values unknown while retaining one raw value', () => {
  const original = receipt({ promptTokens: 12, totalTokens: 12 });
  const conflicting = receipt({ promptTokens: 13, totalTokens: 12, status: 'failed' });
  const merged = mergeUsageReceipt(original, conflicting);
  const summary = summarizeUsage([merged]);

  assert.equal(merged.promptTokens, 12);
  assert.deepEqual(merged.conflictedFields, ['promptTokens']);
  assert.deepEqual(summary.promptTokens, { knownTokens: 0, unknownRequests: 0, conflictedRequests: 1 });
  assert.equal(summary.totalTokens.knownTokens, 12);
});

test('keeps absent fields unknown and aggregates UTC day, model and chat groups', () => {
  const first = receipt({
    createdAt: '2026-10-08T22:30:00.000Z', promptTokens: 8, totalTokens: 10,
    status: 'failed',
  });
  const second = receipt({
    localRequestId: '22222222-2222-4222-8222-222222222222',
    chatId: 'chat-two', modelId: 'GigaChat-other', requestKind: 'tool-continuation',
    createdAt: '2026-10-09T01:00:00.000Z', completionTokens: 4,
  });
  const summary = summarizeUsage([first, second]);

  assert.equal(summary.promptTokens.knownTokens, 8);
  assert.equal(summary.promptTokens.unknownRequests, 1);
  assert.equal(summary.totalTokens.knownTokens, 10);
  assert.equal(summary.totalTokens.unknownRequests, 1);
  assert.deepEqual(summary.byDay.map((day) => day.key), ['2026-10-08', '2026-10-09']);
  assert.deepEqual(summary.byModel.map((model) => model.key), ['GigaChat-other', 'GigaChat-test']);
  assert.deepEqual(summary.byChat.map((chat) => chat.key), ['chat-one', 'chat-two']);
  assert.equal(summary.failedRequestCount, 1);
});

test('rejects malformed, negative, fractional and overflowing usage counts', () => {
  for (const promptTokens of [-1, 1.5, 2_147_483_648]) {
    assert.throws(() => validateUsageReceipt(receipt({ promptTokens })), /Invalid usage count/);
  }
  assert.throws(() => validateUsageReceipt(receipt({ localRequestId: 'not-a-uuid' })), /Invalid usage receipt/);
});
