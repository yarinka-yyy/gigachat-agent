import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInstructionRequest } from './instructions';

const userMessage = { id: 'message-1', role: 'user' as const, text: 'Задача', createdAt: '2026-09-27T00:00:00.000Z' };

test('builds instruction layers in order and keeps chat history separate', () => {
  const request = buildInstructionRequest({
    globalText: 'Глобальная настройка',
    projectInstructions: [
      { scope: 'workspace', text: 'Общие правила' },
      { scope: 'nested', text: 'Уточнение проекта' },
    ],
    selectedSkill: { name: 'Review', scope: 'project', text: 'Проверяй изменения' },
    messages: [userMessage],
    permissionProfile: 'ask',
  });

  assert.deepEqual(request.system.map((layer) => layer.source), ['runtime', 'global', 'project', 'project', 'skill']);
  assert.deepEqual(request.system.filter((layer) => layer.source === 'project').map((layer) => layer.scope), ['workspace', 'nested']);
  assert.deepEqual(request.messages, [userMessage]);
  assert.equal(request.system.some((layer) => layer.text.includes(userMessage.text)), false);
  assert.equal(request.permissionProfile, 'ask');
});

test('omits empty optional instruction layers without moving chat messages into system text', () => {
  const request = buildInstructionRequest({ globalText: '  ', projectInstructions: [], messages: [userMessage], permissionProfile: 'full' });
  assert.deepEqual(request.system.map((layer) => layer.source), ['runtime']);
  assert.equal(request.messages[0]?.text, 'Задача');
});

test('keeps a provider model ID outside the former static list in the accepted request', () => {
  const request = buildInstructionRequest({
    globalText: '',
    messages: [userMessage],
    permissionProfile: 'ask',
    modelId: 'vendor/model.v4:preview',
  });
  assert.equal(request.modelId, 'vendor/model.v4:preview');
});

test('appends a prior summary and bounded task after the existing instruction order', () => {
  const request = buildInstructionRequest({
    globalText: 'Global',
    projectInstructions: [{ scope: 'project', text: 'Project' }],
    selectedSkill: { name: 'Review', scope: 'Global', text: 'Skill' },
    compactSnapshot: { text: 'Prior summary' },
    taskInstruction: 'Summarize the covered prefix.',
    usageKind: 'compaction',
    functionCallMode: 'none',
    messages: [userMessage],
    permissionProfile: 'ask',
    modelId: 'vendor/model.v4:preview',
  });
  assert.deepEqual(request.system.map((layer) => layer.source), ['runtime', 'global', 'project', 'skill', 'summary', 'runtime']);
  assert.equal(request.usageKind, 'compaction');
  assert.equal(request.functionCallMode, 'none');
  assert.deepEqual(request.messages, [userMessage]);
});

test('rejects malformed project instruction sources', () => {
  assert.throws(() => buildInstructionRequest({
    globalText: '',
    projectInstructions: [{ scope: '', text: 'invalid' }],
    messages: [],
    permissionProfile: 'ask',
  }));
});
