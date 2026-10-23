import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInstructionRequest } from './instructions';
import { serializeProviderTurnRequest } from './gigachat-provider';

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

test('passes the internal output cap through the common request builder', () => {
  const request = buildInstructionRequest({
    globalText: '',
    messages: [userMessage],
    permissionProfile: 'ask',
    modelId: 'GigaChat-3-Lightning',
    maxOutputTokens: 256,
  });
  const wire = JSON.parse(serializeProviderTurnRequest(request).body) as {
    model_options: Record<string, unknown>;
  };

  assert.equal(request.maxOutputTokens, 256);
  assert.deepEqual(wire.model_options, { parallel_tool_calls: false, max_tokens: 256 });
});

test('keeps ordinary task instructions in the system after a prior summary', () => {
  const request = buildInstructionRequest({
    globalText: 'Global',
    projectInstructions: [{ scope: 'project', text: 'Project' }],
    selectedSkill: { name: 'Review', scope: 'Global', text: 'Skill' },
    compactSnapshot: { text: 'Prior summary' },
    taskInstruction: 'Summarize the covered prefix.',
    functionCallMode: 'none',
    messages: [userMessage],
    permissionProfile: 'ask',
    modelId: 'vendor/model.v4:preview',
  });
  assert.deepEqual(request.system.map((layer) => layer.source), ['runtime', 'global', 'project', 'skill', 'summary', 'runtime']);
  assert.equal(request.functionCallMode, 'none');
  assert.deepEqual(request.messages, [userMessage]);
});

test('puts a compaction task after completed history as one deterministic request-only V2 user message', () => {
  const history = [
    userMessage,
    { id: 'assistant-1', role: 'assistant' as const, text: 'Earlier answer', createdAt: '2026-09-27T00:01:00.000Z' },
  ];
  const historyBefore = structuredClone(history);
  const taskInstruction = 'Summarize the covered prefix.';
  const build = () => buildInstructionRequest({
    globalText: 'Global',
    compactSnapshot: { text: 'Prior summary' },
    taskInstruction,
    usageKind: 'compaction',
    functionCallMode: 'none',
    messages: history,
    permissionProfile: 'ask',
    modelId: 'GigaChat-2-Pro',
  });
  const request = build();
  const repeated = build();
  const taskMessage = request.messages[request.messages.length - 1];
  const wire = JSON.parse(serializeProviderTurnRequest(request).body) as {
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  };
  const taskOccurrences = wire.messages.flatMap((message) => message.content)
    .filter((part) => part.text === taskInstruction).length;

  assert.equal(taskMessage?.role, 'user');
  assert.equal(taskMessage?.text, taskInstruction);
  assert.ok(taskMessage?.id.startsWith('request-compaction-'));
  assert.equal(taskMessage?.id, repeated.messages[repeated.messages.length - 1]?.id,
    'request-only identity is deterministic for the same history');
  assert.deepEqual(request.messages.slice(0, history.length), history);
  assert.equal(request.messages.length, history.length + 1);
  assert.equal(request.system.some((layer) => layer.text.includes(taskInstruction)), false);
  assert.equal(wire.messages[wire.messages.length - 1]?.role, 'user');
  assert.deepEqual(wire.messages[wire.messages.length - 1]?.content, [{ text: taskInstruction }]);
  assert.equal(taskOccurrences, 1);
  assert.deepEqual(history, historyBefore, 'building the request leaves persisted source messages untouched');
});

test('passes the semantic compaction discriminator and disables tool mode', () => {
  const request = buildInstructionRequest({
    globalText: '',
    messages: [userMessage],
    taskInstruction: 'Prepare semantic memory.',
    permissionProfile: 'ask',
    modelId: 'GigaChat-3-Lightning',
    usageKind: 'compaction',
    compactionFormat: 'semantic',
    functionCallMode: 'auto',
  });

  assert.equal(request.compactionFormat, 'semantic');
  assert.equal(request.functionCallMode, 'none');
  assert.throws(() => buildInstructionRequest({
    globalText: '', messages: [userMessage], permissionProfile: 'ask', compactionFormat: 'semantic',
  }), /только для запроса сжатия/);
});

test('keeps a semantic service task in one runtime system layer and leaves the archive untouched', () => {
  const history = [{ ...userMessage, text: 'Archived source data.' }];
  const input = {
    globalText: 'Global',
    projectInstructions: [{ scope: 'project', text: 'Project' }],
    compactSnapshot: { text: 'Prior memory' },
    taskInstruction: 'Prepare semantic memory.',
    messages: history,
    permissionProfile: 'ask' as const,
    modelId: 'GigaChat-3-Lightning' as const,
    usageKind: 'compaction' as const,
    compactionFormat: 'semantic' as const,
    functionCallMode: 'auto' as const,
  };
  const inputBefore = structuredClone(input);
  const request = buildInstructionRequest(input);
  const repeated = buildInstructionRequest(input);
  const serialized = serializeProviderTurnRequest(request);
  const repeatedSerialized = serializeProviderTurnRequest(repeated);
  const wire = JSON.parse(serialized.body) as { messages: Array<{ role: string; content: Array<{ text?: string }> }> };
  const systemText = wire.messages[0]?.content[0]?.text ?? '';
  const serviceLayers = request.system.filter((layer) => layer.label === 'Задача текущего запроса');

  assert.deepEqual(serviceLayers, [{ source: 'runtime', label: 'Задача текущего запроса', text: input.taskInstruction }]);
  assert.equal(request.system[request.system.length - 1], serviceLayers[0], 'the task follows all baseline instruction layers');
  assert.deepEqual(request.messages, history);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages.some((message) => message.text === input.taskInstruction), false);
  assert.deepEqual(wire.messages.map(({ role }) => role), ['system', 'user']);
  assert.equal(wire.messages[1]?.content[0]?.text, history[0]?.text);
  assert.equal(systemText.split(input.taskInstruction).length - 1, 1);
  assert.equal(serialized.body, repeatedSerialized.body, 'repeated builds have identical provider wire');
  assert.equal(request.permissionProfile, input.permissionProfile);
  assert.equal(request.modelId, input.modelId);
  assert.equal(request.compactionFormat, 'semantic');
  assert.equal(request.functionCallMode, 'none');
  assert.deepEqual(input, inputBefore, 'building a request does not mutate caller input');

  const emptyTask = buildInstructionRequest({ ...input, taskInstruction: ' \t ' });
  assert.deepEqual(emptyTask.messages, history);
  assert.equal(emptyTask.system.some((layer) => layer.label === 'Задача текущего запроса'), false);
});

test('rejects malformed project instruction sources', () => {
  assert.throws(() => buildInstructionRequest({
    globalText: '',
    projectInstructions: [{ scope: '', text: 'invalid' }],
    messages: [],
    permissionProfile: 'ask',
  }));
});
