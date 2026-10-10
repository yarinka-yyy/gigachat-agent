import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import type { ChatMessage, CompactSnapshot, ProviderProtocolExchange } from './contracts';
import { buildNextTurnContext, countContextTextTokens, hashCompactionPrefix } from './context';
import { GigaChatProviderError, MAX_PROVIDER_REQUEST_BYTES, serializeProviderTurnRequest } from './gigachat-provider';

const at = '2026-10-09T12:00:00.000Z';
const user = (id: string, text = id): ChatMessage => ({ id, role: 'user', text, createdAt: at });
const assistant = (id: string, text = id): ChatMessage => ({ id, role: 'assistant', text, createdAt: at, source: 'runtime' });

function prefixHash(messages: readonly ChatMessage[], protocolHistory: readonly ProviderProtocolExchange[] = []): string {
  return hashCompactionPrefix(messages, protocolHistory);
}

function snapshot(boundaryMessageId: string, coveredThroughMessageId: string, messages: readonly ChatMessage[]): CompactSnapshot {
  const covered = messages.slice(0, messages.findIndex((message) => message.id === coveredThroughMessageId) + 1);
  return {
    id: 'snapshot-1', version: 1, boundaryMessageId, coveredThroughMessageId,
    coveredPrefixHash: prefixHash(covered), text: 'Сводка: продолжить задачу.',
    modelId: 'vendor/model.v4:preview', provenance: 'fixture', createdAt: at,
  };
}

function input(messages: ChatMessage[], extra: Partial<Parameters<typeof buildNextTurnContext>[0]> = {}) {
  return {
    globalText: 'Global instructions',
    projectInstructions: [{ scope: 'project', text: 'Project instructions' }],
    selectedSkill: { name: 'Review', scope: 'Global', text: 'Skill instructions' },
    messages,
    permissionProfile: 'ask' as const,
    modelId: 'vendor/model.v4:preview',
    ...extra,
  };
}

test('builds ordered next-turn layers and keeps only protocol pairs after the exact compact boundary', () => {
  const history = [user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3')];
  const recentExchange: ProviderProtocolExchange = {
    anchorMessageId: 'u3', name: 'read', arguments: { path: 'x.txt' }, content: null,
    functionsStateId: 'state-3', result: '{"ok":true}',
  };
  const requestContext = buildNextTurnContext(input(history, {
    compactSnapshot: snapshot('u2', 'a2', history),
    protocolHistory: [recentExchange],
  }));

  assert.deepEqual(requestContext.request.system.map((layer) => layer.source), ['runtime', 'global', 'project', 'skill', 'summary']);
  assert.deepEqual(requestContext.request.messages.map((message) => message.id), ['u3']);
  assert.deepEqual(requestContext.request.protocolHistory, [recentExchange]);
  assert.equal(requestContext.provenance, 'unknown');
  assert.equal(requestContext.textTokenCount, null);
});

test('keeps an answer inserted after a boundary that the saved snapshot did not cover', () => {
  const beforeReply = [user('u1')];
  const current = [user('u1'), assistant('retry-answer'), user('u2')];
  const requestContext = buildNextTurnContext(input(current, {
    compactSnapshot: snapshot('u1', 'u1', beforeReply),
  }));
  assert.deepEqual(requestContext.request.messages.map((message) => message.id), ['retry-answer', 'u2']);
});

test('fails closed when the prefix under a snapshot changed and does not hide orphan protocol history', () => {
  const oldMessages = [user('u1')];
  const oldSnapshot = snapshot('u1', 'u1', oldMessages);
  assert.throws(() => buildNextTurnContext(input([user('u1', 'edited'), user('u2')], { compactSnapshot: oldSnapshot })),
    /История под сводкой изменилась/);
  assert.throws(() => buildNextTurnContext(input([user('u1')], {
    protocolHistory: [{ anchorMessageId: 'missing', name: 'read', arguments: {}, content: null, functionsStateId: null, result: '{"ok":true}' }],
  })), (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
});

test('hashes saved prefixes independently of JSON key order, including nested function arguments', () => {
  const beforeSave: ChatMessage[] = [
    { id: 'u1', role: 'user', text: 'Запрос', createdAt: at },
    { id: 'a1', role: 'assistant', source: 'runtime', text: 'Ответ', createdAt: at },
  ];
  const afterReload: ChatMessage[] = [
    { text: 'Запрос', createdAt: at, role: 'user', id: 'u1' },
    { text: 'Ответ', createdAt: at, id: 'a1', role: 'assistant', source: 'runtime' },
  ];
  const beforeProtocol: ProviderProtocolExchange[] = [{
    anchorMessageId: 'u1', name: 'read',
    arguments: { path: 'file.txt', options: { encoding: 'utf8', limit: 7 } },
    content: null, functionsStateId: 'state', result: '{"ok":true}',
  }];
  const afterProtocol: ProviderProtocolExchange[] = [{
    result: '{"ok":true}', functionsStateId: 'state', content: null, name: 'read', anchorMessageId: 'u1',
    arguments: { options: { limit: 7, encoding: 'utf8' }, path: 'file.txt' },
  }];
  assert.equal(hashCompactionPrefix(beforeSave, beforeProtocol), hashCompactionPrefix(afterReload, afterProtocol));
});

test('bounds the complete wire payload including all function schemas and counts only supplied text blocks', async () => {
  const context = buildNextTurnContext(input([user('u1', 'Привет') ]));
  const serialized = serializeProviderTurnRequest(context.request);
  const payload = JSON.parse(serialized.body) as { messages: Array<{ content: string }>; functions: unknown[]; function_call: string };
  assert.equal(serialized.wireBytes, Buffer.byteLength(serialized.body, 'utf8'));
  assert.ok(serialized.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
  assert.equal(payload.functions.length, 6);
  assert.equal(payload.function_call, 'auto');
  assert.equal(serialized.textInputs.length, payload.messages.length);

  const measured = await countContextTextTokens(context, {
    countTokens: async (_model, inputs) => inputs.map((text) => ({ object: 'tokens' as const, tokens: 2, characters: text.length })),
  }, new AbortController().signal);
  assert.equal(measured.textTokenCount, serialized.textInputs.length * 2);
  assert.equal(measured.textCountProvenance, 'verified');
  assert.equal(measured.provenance, 'unknown');
});

test('keeps a large selected Skill and an unknown model in the bounded wire request', () => {
  const skillText = 'S'.repeat(512 * 1024);
  const context = buildNextTurnContext(input([user('u-future-model', 'Продолжи работу')], {
    selectedSkill: { name: 'Large fixture Skill', scope: 'Global', text: skillText },
    modelId: 'future/model-without-capability-metadata',
  }));
  const serialized = serializeProviderTurnRequest(context.request);
  const skillBlock = context.request.system.find((layer) => layer.source === 'skill');

  assert.equal(context.request.modelId, 'future/model-without-capability-metadata');
  assert.equal(skillBlock?.text, skillText);
  assert.ok(serialized.wireBytes > 512 * 1024);
  assert.ok(serialized.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
  assert.equal(context.provenance, 'unknown');
});

test('rejects an oversized request before it reaches the provider transport', () => {
  assert.throws(() => buildNextTurnContext(input([user('u-large', 'x'.repeat(MAX_PROVIDER_REQUEST_BYTES))])),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
});
