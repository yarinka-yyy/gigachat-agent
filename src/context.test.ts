import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import type { ChatArtifact, ChatDetail, ChatMessage, ChatToolReceipt, CompactSnapshot, ProviderProtocolExchange } from './contracts';
import { assertCompactionWireReduction, buildNextTurnContext, buildSemanticCompactionReviewRequest, COMPACTION_TASK_INSTRUCTION,
  countContextTextTokens, countEstimatedContextTextTokens, createContextTextTokenCache, hashCompactionPrefix,
  estimateProviderPromptTokens, estimateSerializedProviderPrompt, readContextTextTokenCacheCoverage,
  SEMANTIC_COMPACTION_TASK_INSTRUCTION, validateCompactSummary } from './context';
import { GigaChatProviderError, MAX_PROVIDER_REQUEST_BYTES, serializeProviderTurnRequest } from './gigachat-provider';
import { calculateLiteWorkingBudget, isLitePromptOverMeasuredInputGuard, liteHardInputLimit } from './context-budget';
import { CHAT_MODEL_FAMILIES } from './model-catalog';
import { compileExtractiveCompaction, compileSemanticCompactionMemory,
  compileResolvedSemanticCompactionMemory, createCompactionSources, getSemanticCompactionCoverageRefSet } from './compaction';

const at = '2026-10-09T12:00:00.000Z';
const reviewJson = (value: unknown): string => JSON.stringify(value);
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

function textCountContext(textInputs: string[], modelId = 'cache-model') {
  const context = buildNextTurnContext(input([user('text-count-anchor')], { modelId }));
  context.textInputs = textInputs;
  return context;
}

function stateDetail(messages: ChatMessage[], toolReceipts: ChatDetail['toolReceipts'] = []): ChatDetail {
  return {
    id: 'chat-context-state', title: 'Context state fixture', projectId: null, pinned: false, archived: false,
    createdAt: at, updatedAt: at, kind: 'text', draft: '', nextTurnPermissionProfile: null, modelId: 'GigaChat-3-Pro',
    nextTurnSkillId: null, messages, turns: [], toolReceipts, artifacts: [], draftAttachments: [], compactSnapshot: null,
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

test('preview-only missing model preserves the actual null selection and never claims serialized bytes', () => {
  const noModel = input([user('no-model')], { modelId: null });
  assert.throws(() => buildNextTurnContext(noModel), (error: unknown) =>
    error instanceof GigaChatProviderError && error.category === 'protocol');

  const preview = buildNextTurnContext(noModel, { allowMissingModelForPreview: true });
  assert.equal(preview.request.modelId, null);
  assert.equal(preview.wireBytes, null);
  assert.equal(preview.textTokenCount, null);
  assert.equal(preview.provenance, 'unknown');
  assert.ok(preview.blocks.some((block) => block.source === 'function-schema' && block.utf8Bytes > 0));
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

test('uses hash-covered native messages and tool protocol for a new manifest checkpoint', () => {
  const oldUser: ChatMessage = { ...user('old-user', 'Earlier question'), attachmentIds: ['old-file'] };
  const oldAssistant: ChatMessage = { ...assistant('old-assistant', 'Earlier answer'), functionsStateId: 'old-state' };
  const emptyToolAnchor = user('empty-tool-anchor', '');
  const toolAnswer = assistant('tool-answer', 'Tool-backed answer');
  const fillerUser = user('filler-user', 'Filler question');
  const fillerAssistant = assistant('filler-assistant', 'Filler answer');
  const recentUser = user('recent-user', 'Recent question');
  const recentAssistant = assistant('recent-assistant', 'Recent answer');
  const messages = [oldUser, oldAssistant, emptyToolAnchor, toolAnswer, fillerUser, fillerAssistant, recentUser, recentAssistant];
  const covered = messages.slice(0, 6);
  const oldProtocol: ProviderProtocolExchange = {
    anchorMessageId: emptyToolAnchor.id, name: 'read', arguments: { path: 'notes.txt' }, content: null,
    functionsStateId: 'old-tool-state', result: '{"read":true}',
  };
  const recentProtocol: ProviderProtocolExchange = {
    anchorMessageId: recentUser.id, name: 'search', arguments: { query: 'latest' }, content: null,
    functionsStateId: 'recent-tool-state', result: '{"recent":true}',
  };
  const receipt: ChatToolReceipt = {
    receiptId: 'receipt', anchorMessageId: emptyToolAnchor.id, name: 'read', arguments: { path: 'notes.txt' },
    content: null, functionsStateId: 'old-tool-state', status: 'completed', result: '{"read":true}', createdAt: at,
  };
  const artifact: ChatArtifact = {
    id: 'old-file', name: 'notes.txt', storedName: 'private-file', size: 12,
    sha256: 'a'.repeat(64), createdAt: at, messageId: oldUser.id,
  };
  const sources = createCompactionSources(covered, [receipt], [artifact]);
  const candidate = JSON.stringify({ version: 2, decisions: [
    { sourceRef: 'm0', retain: true },
    { sourceRef: 'm1', retain: false },
    { sourceRef: 'm3', retain: false },
    { sourceRef: 'm4', retain: false },
    { sourceRef: 'm5', retain: false },
  ] });
  const snapshotWithManifest = snapshot('filler-user', 'filler-assistant', covered);
  snapshotWithManifest.text = compileExtractiveCompaction(candidate, sources);
  snapshotWithManifest.coveredPrefixHash = prefixHash(covered, [oldProtocol]);
  const context = buildNextTurnContext(input(messages, {
    compactSnapshot: snapshotWithManifest,
    protocolHistory: [oldProtocol, recentProtocol],
  }));

  assert.deepEqual(context.request.messages, [oldUser, oldAssistant, emptyToolAnchor, toolAnswer, recentUser, recentAssistant]);
  assert.deepEqual(context.request.protocolHistory, [oldProtocol, recentProtocol]);
  assert.equal(context.request.system.some((layer) => layer.source === 'summary'), false);
  assert.ok(context.request.messages.some((message) => message.attachmentIds?.includes('old-file')));
  assert.equal(context.request.messages.find((message) => message.id === oldAssistant.id)?.functionsStateId, 'old-state');
  const wire = serializeProviderTurnRequest(context.request).body;
  assert.doesNotMatch(wire, /retained-source-refs|Filler question|Filler answer/);
  const wireMessages = (JSON.parse(wire) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }).messages;
  assert.ok(['Earlier question', 'Earlier answer', 'Tool-backed answer', 'Recent question', 'Recent answer']
    .every((text) => wireMessages.some((message) => message.content.some((part) => part.text === text))));
  assert.ok(wireMessages.some((message) => message.content.some((part) => JSON.stringify(part).includes('"path":"notes.txt"'))));
  assert.ok(wireMessages.some((message) => message.role === 'tool'
    && (message.content[0]?.function_result as { result?: string } | undefined)?.result === '{"read":true}'));

  const omittedToolAnchor = structuredClone(snapshotWithManifest);
  omittedToolAnchor.text = JSON.stringify([
    ['retained-source-refs', ['m0', 'm1', 'm4', 'm5']],
    ['user', oldUser.text], ['assistant', oldAssistant.text],
  ]);
  assert.throws(() => buildNextTurnContext(input(messages, {
    compactSnapshot: omittedToolAnchor,
    protocolHistory: [oldProtocol, recentProtocol],
  })), /якорь протокола инструмента/);
});

test('compaction uses the complete raw prefix as an inert transcript without prior snapshots or active tool pairs', () => {
  const messages = [user('u1', 'Earlier question'), assistant('a1', 'Earlier answer'),
    user('u2', 'Latest question'), assistant('a2', 'Latest answer')];
  const protocolHistory: ProviderProtocolExchange[] = [{
    anchorMessageId: 'u2', name: 'read', arguments: { path: 'notes.txt' }, content: null,
    functionsStateId: 'private-state-id', result: '{"ok":true}',
  }];
  const receipt: ChatToolReceipt = {
    receiptId: 'private-receipt-id', anchorMessageId: 'u2', name: 'read', arguments: { path: 'notes.txt' },
    content: null, functionsStateId: 'private-state-id', status: 'completed', result: '{"ok":true}', createdAt: at,
  };
  const compactSnapshot = snapshot('u1', 'a1', messages);
  const originalMessages = structuredClone(messages);
  const originalProtocol = structuredClone(protocolHistory);
  const context = buildNextTurnContext(input(messages, {
    compactSnapshot,
    protocolHistory,
    compactionToolReceipts: [receipt],
    compactionArtifacts: [],
    taskInstruction: COMPACTION_TASK_INSTRUCTION,
    usageKind: 'compaction',
    functionCallMode: 'none',
  }));
  const serialized = serializeProviderTurnRequest(context.request);
  const wire = JSON.parse(serialized.body) as {
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  };
  const transcriptMessage = context.request.messages[0];
  const wireTask = wire.messages[wire.messages.length - 1];

  assert.equal(context.request.system.filter((layer) => layer.source === 'summary').length, 0);
  assert.equal(context.request.messages.length, 2);
  assert.equal(transcriptMessage?.role, 'user');
  assert.match(transcriptMessage?.text ?? '', /^АРХИВНЫЕ СООБЩЕНИЯ JSON/);
  assert.match(transcriptMessage?.text ?? '', /Earlier question/);
  assert.match(transcriptMessage?.text ?? '', /Earlier answer/);
  assert.match(transcriptMessage?.text ?? '', /Latest question/);
  assert.match(transcriptMessage?.text ?? '', /Latest answer/);
  assert.doesNotMatch(transcriptMessage?.text ?? '', /"status":"completed"/);
  assert.equal(transcriptMessage?.text?.includes('private-state-id'), false);
  assert.equal(transcriptMessage?.text?.includes('private-receipt-id'), false);
  assert.deepEqual(context.request.messages.map((message) => message.text), [transcriptMessage?.text, COMPACTION_TASK_INSTRUCTION]);
  assert.match(COMPACTION_TASK_INSTRUCTION, /только JSON версии 2 с полем decisions/i);
  assert.match(COMPACTION_TASK_INSTRUCTION, /полным массивом решений \{sourceRef, retain\}/i);
  assert.match(COMPACTION_TASK_INSTRUCTION, /ровно одно решение на каждое непустое сообщение/i);
  assert.match(COMPACTION_TASK_INSTRUCTION, /retain=true/i);
  assert.match(COMPACTION_TASK_INSTRUCTION, /retain=false/i);
  assert.doesNotMatch(COMPACTION_TASK_INSTRUCTION, /"decisions":\[\]/);
  assert.doesNotMatch(COMPACTION_TASK_INSTRUCTION, /m\d+/);
  assert.match(COMPACTION_TASK_INSTRUCTION, /не возвращай цитаты, пересказы, причины или переписанный текст/i);
  assert.match(COMPACTION_TASK_INSTRUCTION, /отрицаний, неопределённости, альтернатив и незавершённой работы/i);
  assert.match(COMPACTION_TASK_INSTRUCTION, /завершённых организационных уведомлений без содержания для продолжения/i);
  assert.equal(context.request.messages[context.request.messages.length - 1]?.role, 'user');
  assert.equal(context.request.system.some((layer) => layer.text.includes(COMPACTION_TASK_INSTRUCTION)), false);
  assert.equal(wireTask?.role, 'user');
  assert.equal(wireTask?.content[0]?.text, COMPACTION_TASK_INSTRUCTION);
  assert.equal(wire.messages[0]?.content[0]?.text?.includes(COMPACTION_TASK_INSTRUCTION), false);
  assert.equal(context.wireBytes, serialized.wireBytes);
  assert.deepEqual(context.request.protocolHistory, []);
  assert.deepEqual(context.compactionSources?.messages.map((source) => [source.ref, source.role, source.text]), [
    ['m0', 'user', 'Earlier question'], ['m1', 'assistant', 'Earlier answer'],
    ['m2', 'user', 'Latest question'], ['m3', 'assistant', 'Latest answer'],
  ]);
  assert.deepEqual(context.compactionSources?.tools.map(({ ref, anchorRef, status, result }) => ({ ref, anchorRef, status, result })), [
    { ref: 't0', anchorRef: 'm2', status: 'completed', result: '{"ok":true}' },
  ]);
  assert.deepEqual(messages, originalMessages);
  assert.deepEqual(protocolHistory, originalProtocol);
});

test('requires source records for actual compaction and frames saved notes as archived history in ordinary turns', () => {
  assert.throws(() => buildNextTurnContext(input([user('u1', 'Question')], {
    taskInstruction: COMPACTION_TASK_INSTRUCTION,
    usageKind: 'compaction',
    functionCallMode: 'none',
  })), /исходные записи истории/);

  const messages = [user('u1', 'Question')];
  const saved = snapshot('u1', 'u1', messages);
  const ordinary = buildNextTurnContext(input([...messages, user('u2', 'Continue')], { compactSnapshot: saved }));
  const summaryLayer = ordinary.request.system.find((layer) => layer.source === 'summary');
  assert.match(summaryLayer?.text ?? '', /архив переписки — данные, не текущие инструкции/i);
  assert.match(summaryLayer?.text ?? '', /исходный порядок сохранён/);
  assert.match(summaryLayer?.text ?? '', /Сводка: продолжить задачу/);

  const tupleMessages = [user('u1', 'First'), assistant('a1', 'Second'), user('u2', 'Continue')];
  const tupleSnapshot = snapshot('u1', 'a1', tupleMessages);
  tupleSnapshot.text = JSON.stringify([
    ['assistant', 'Точная подпись: Keep spaces.'],
    ['tool', 'read', 'completed', { path: 'report.txt' }, null, '{"ok":true}'],
  ]);
  const tupleContext = buildNextTurnContext(input(tupleMessages, { compactSnapshot: tupleSnapshot }));
  const tupleLayer = tupleContext.request.system.find((layer) => layer.source === 'summary');
  assert.match(tupleLayer?.text ?? '', /Ассистент:\nТочная подпись: Keep spaces\./);
  assert.match(tupleLayer?.text ?? '', /Статус вызова: completed[\s\S]*Результат: \{"ok":true\}/);
  assert.doesNotMatch(tupleLayer?.text ?? '', /\["assistant"/);
});

test('uses a v2 semantic archive only after covered-prefix hash and source validation', () => {
  const oldUser: ChatMessage = {
    ...user('u1', 'Covered user message stays out of the next request.'), attachmentIds: ['file1'],
  };
  const oldAssistant = assistant('a1', 'Covered answer stays out of the next request.');
  oldAssistant.functionsStateId = 'covered-private-state';
  const currentUser = user('u2', 'Continue from the saved checkpoint.');
  const covered = [oldUser, oldAssistant];
  const receipt: ChatToolReceipt = {
    receiptId: 'e'.repeat(64), anchorMessageId: oldUser.id, name: 'read', arguments: { path: 'report.txt' },
    content: 'Tool output contains exact detail.', functionsStateId: 'covered-tool-state', status: 'completed',
    result: '{"ok":true}', createdAt: at,
  };
  const protocol: ProviderProtocolExchange = {
    anchorMessageId: oldUser.id, name: receipt.name, arguments: receipt.arguments, content: receipt.content,
    functionsStateId: receipt.functionsStateId, result: receipt.result!,
  };
  const artifact: ChatArtifact = {
    id: 'file1', name: 'report.txt', storedName: 'private-report.txt', size: 12,
    sha256: 'a'.repeat(64), createdAt: at, messageId: oldUser.id,
  };
  const sources = createCompactionSources(covered, [receipt], [artifact]);
  const memory = (activeRef = 'm0', quote = 'exact detail') => ({
    format: 'gigachat-semantic-memory', version: 1,
    activeTask: { text: 'Continue the current task.', sourceRefs: [activeRef] },
    constraints: [], decisions: [], openWork: [],
    facts: [{ text: 'The tool confirmed a detail.', sourceRefs: ['t0'], exactQuotes: [{ sourceRef: 't0', text: quote }] }],
    pastTopics: [],
  });
  const snapshot: CompactSnapshot = {
    id: 'semantic-context-v2', version: 2, boundaryMessageId: oldUser.id, coveredThroughMessageId: oldAssistant.id,
    coveredPrefixHash: hashCompactionPrefix(covered, [protocol]), text: compileSemanticCompactionMemory(JSON.stringify(memory()), sources),
    modelId: 'vendor/model.v4:preview', provenance: 'fixture', createdAt: at,
  };
  const context = buildNextTurnContext(input([...covered, currentUser], {
    compactSnapshot: snapshot,
    protocolHistory: [protocol],
    compactionToolReceipts: [receipt],
    compactionArtifacts: [artifact],
  }));
  const summary = context.request.system.find((layer) => layer.source === 'summary')?.text ?? '';

  assert.deepEqual(context.request.messages.map((message) => message.id), [currentUser.id]);
  assert.deepEqual(context.request.protocolHistory, [], 'covered tool calls are archived, not replayed');
  assert.match(summary, /Архивная семантическая память v1/);
  assert.match(summary, /Continue the current task\./);
  assert.match(summary, /exact detail/);
  assert.doesNotMatch(JSON.stringify(context.request), /Covered user message stays out|Covered answer stays out|covered-private-state/);

  const emptySuffix = buildNextTurnContext(input(covered, {
    compactSnapshot: snapshot,
    protocolHistory: [protocol],
    compactionToolReceipts: [receipt],
    compactionArtifacts: [artifact],
  }));
  assert.deepEqual(emptySuffix.request.messages, [], 'an assistant-covered tail may leave no raw suffix');
  assert.match(emptySuffix.request.system.find((layer) => layer.source === 'summary')?.text ?? '', /Continue the current task\./);

  const fullSources = createCompactionSources([...covered, currentUser], [receipt], [artifact]);
  const futureReference = { ...snapshot, id: 'semantic-future-ref', text: compileSemanticCompactionMemory(JSON.stringify(memory('m2')), fullSources) };
  assert.throws(() => buildNextTurnContext(input([...covered, currentUser], {
    compactSnapshot: futureReference,
    protocolHistory: [protocol],
    compactionToolReceipts: [receipt],
    compactionArtifacts: [artifact],
  })), /неизвестную или повторную ссылку/, 'a source in the uncovered suffix cannot validate a saved reference');

  const falseQuote = { ...snapshot, id: 'semantic-false-quote', text: JSON.stringify(memory('m0', 'not present in the source')) };
  assert.throws(() => buildNextTurnContext(input([...covered, currentUser], {
    compactSnapshot: falseQuote,
    protocolHistory: [protocol],
    compactionToolReceipts: [receipt],
    compactionArtifacts: [artifact],
  })), /Точная цитата не совпадает/);
  assert.throws(() => buildNextTurnContext(input([...covered, currentUser], {
    compactSnapshot: snapshot,
    protocolHistory: [protocol],
  })), /нужны покрытые записи инструментов и вложений/);
});

test('prepares a semantic request from the whole supplied raw prefix without exposing local metadata', () => {
  const messages: ChatMessage[] = [
    { ...user('semantic-first-user', 'Old raw request'), attachmentIds: ['old-attachment'] },
    assistant('semantic-first-assistant', 'Old raw answer'),
    { ...user('semantic-second-user', 'New request'), attachmentIds: ['new-attachment'] },
    assistant('semantic-second-assistant', 'New answer'),
  ];
  const receipts: ChatToolReceipt[] = [
    { receiptId: 'private-receipt-old', anchorMessageId: messages[0]!.id, name: 'read', arguments: { path: 'old.txt' },
      content: null, functionsStateId: 'private-state-old', status: 'completed', result: 'Old tool result.', createdAt: at },
    { receiptId: 'private-receipt-new', anchorMessageId: messages[2]!.id, name: 'search', arguments: { query: 'new' },
      content: 'Search content.', functionsStateId: 'private-state-new', status: 'completed', result: 'New tool result.', createdAt: at },
  ];
  const artifacts: ChatArtifact[] = [
    { id: 'old-attachment', name: 'old.txt', storedName: 'private-old-path', size: 10, sha256: 'a'.repeat(64), createdAt: at, messageId: messages[0]!.id },
    { id: 'new-attachment', name: 'new.txt', storedName: 'private-new-path', size: 20, sha256: 'b'.repeat(64), createdAt: at, messageId: messages[2]!.id },
  ];
  const context = buildNextTurnContext(input(messages, {
    compactionFormat: 'semantic',
    usageKind: 'compaction',
    taskInstruction: COMPACTION_TASK_INSTRUCTION,
    functionCallMode: 'auto',
    compactionToolReceipts: receipts,
    compactionArtifacts: artifacts,
  }));
  const transcript = context.request.messages[0]?.text ?? '';
  const envelope = JSON.parse(transcript.slice(transcript.indexOf('\n') + 1)) as {
    previousMemory: unknown;
    coverageRefSet: string[];
    messages: Array<{ sourceRef: string; role: string; text: string; attachments: Array<Record<string, unknown>> }>;
    tools: Array<{ sourceRef: string; anchorRef: string; name: string; result: string | null }>;
  };

  assert.equal(context.request.compactionFormat, 'semantic');
  assert.equal(context.request.functionCallMode, 'none');
  assert.equal(context.request.messages.length, 2, 'one source archive followed by the service task');
  assert.equal(context.request.messages[1]?.id, 'request-semantic-draft-task');
  assert.equal(context.request.messages[0]?.text, transcript);
  assert.deepEqual(context.request.system[context.request.system.length - 1], {
    source: 'runtime', label: 'Задача текущего запроса', text: SEMANTIC_COMPACTION_TASK_INSTRUCTION,
  });
  assert.equal(context.request.system.filter((layer) => layer.text === SEMANTIC_COMPACTION_TASK_INSTRUCTION).length, 1);
  const semanticWire = JSON.parse(serializeProviderTurnRequest(context.request).body) as {
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  };
  assert.equal(semanticWire.messages.length, envelope.messages.length + 3);
  assert.ok(semanticWire.messages.slice(1).every(message => message.role === 'user'));
  const decodeWire = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.deepEqual({ ...decodeWire(semanticWire.messages[1]!.content[0]!.text!),
    messages: semanticWire.messages.slice(2, -1).map(message => decodeWire(message.content[0]!.text!)) }, envelope);
  assert.equal((semanticWire.messages[0]?.content[0]?.text ?? '').split(SEMANTIC_COMPACTION_TASK_INSTRUCTION).length - 1, 1);
  assert.match(SEMANTIC_COMPACTION_TASK_INSTRUCTION, /каждого sourceRef из coverageRefSet/i);
  assert.doesNotMatch(SEMANTIC_COMPACTION_TASK_INSTRUCTION, /retain=true|сохраняй в constraints/i);
  assert.match(SEMANTIC_COMPACTION_TASK_INSTRUCTION, /ещё не итоговая память/i);
  assert.equal(context.request.system.some((layer) => layer.source === 'summary'), false);
  assert.equal(envelope.previousMemory, null, 'first semantic compaction starts from the supplied raw prefix');
  assert.deepEqual(envelope.coverageRefSet, ['m0', 'm1', 'm2', 'm3', 't0', 't1']);
  assert.deepEqual(envelope.messages.map(({ sourceRef, role, text }) => [sourceRef, role, text]), [
    ['m0', 'user', 'Old raw request'], ['m1', 'assistant', 'Old raw answer'],
    ['m2', 'user', 'New request'], ['m3', 'assistant', 'New answer'],
  ]);
  assert.deepEqual(envelope.messages[0]?.attachments, [{
    name: 'old.txt', sizeBytes: 10, sha256: 'a'.repeat(64), contentAvailable: false,
  }]);
  assert.deepEqual(envelope.tools.map(({ sourceRef, anchorRef, name, result }) => ({ sourceRef, anchorRef, name, result })), [
    { sourceRef: 't0', anchorRef: 'm0', name: 'read', result: 'Old tool result.' },
    { sourceRef: 't1', anchorRef: 'm2', name: 'search', result: 'New tool result.' },
  ]);
  for (const privateValue of ['semantic-first-user', 'private-receipt-old', 'private-state-old', 'private-old-path']) {
    assert.equal(transcript.includes(privateValue), false);
  }

  const legacySnapshot = snapshot(messages[0]!.id, messages[1]!.id, messages);
  const migrated = buildNextTurnContext(input(messages, {
    compactionFormat: 'semantic', usageKind: 'compaction', compactionToolReceipts: receipts,
    compactionArtifacts: artifacts, compactSnapshot: legacySnapshot,
  }));
  const migratedInput = JSON.parse(migrated.request.messages[0]!.text.slice(migrated.request.messages[0]!.text.indexOf('\n') + 1)) as typeof envelope;
  assert.equal(migratedInput.previousMemory, null, 'a v1 extractive snapshot migrates from raw messages, not its old selection');
  assert.equal(migratedInput.messages.length, messages.length);
});

test('preflights the complete provider wire for semantic archives with more than 64 source refs', () => {
  const messages = Array.from({ length: 66 }, (_, index) => index % 2 === 0
    ? user(`semantic-large-user-${index}`, `History item ${index}.`)
    : assistant(`semantic-large-assistant-${index}`, `History item ${index}.`));
  const receipts: ChatToolReceipt[] = [0, 64].map((index) => ({
    receiptId: `semantic-large-receipt-${index}`, anchorMessageId: messages[index]!.id, name: 'read', arguments: { index },
    content: `Read content ${index}.`, functionsStateId: null, status: 'completed',
    result: `Tool result ${index}.`, createdAt: at,
  }));
  const context = buildNextTurnContext(input(messages, {
    usageKind: 'compaction', compactionFormat: 'semantic',
    compactionToolReceipts: receipts, compactionArtifacts: [],
  }));
  const archive = context.request.messages[0]?.text ?? '';
  const envelope = JSON.parse(archive.slice(archive.indexOf('\n') + 1)) as { coverageRefSet: string[] };
  const serialized = serializeProviderTurnRequest(context.request);

  assert.deepEqual(envelope.coverageRefSet, [...messages.map((_, index) => `m${index}`), 't0', 't1']);
  assert.equal(context.wireBytes, serialized.wireBytes);
  assert.equal(context.maxWireBytes, MAX_PROVIDER_REQUEST_BYTES);
  assert.deepEqual(context.textInputs, serialized.textInputs);
  assert.ok(serialized.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
});

test('rolls semantic compaction forward with stable global refs and only the newly covered suffix', () => {
  const covered = [user('rolling-old-user', 'Old raw request.'), assistant('rolling-old-assistant', 'Old raw answer.')];
  const suffix = [user('rolling-new-user', 'New raw request.',), assistant('rolling-new-assistant', 'New raw answer.')];
  const oldReceipt: ChatToolReceipt = {
    receiptId: 'rolling-private-receipt-old', anchorMessageId: covered[0]!.id, name: 'read', arguments: { path: 'old.txt' },
    content: 'Old result.', functionsStateId: 'rolling-private-state-old', status: 'completed', result: 'Old result.', createdAt: at,
  };
  const newReceipt: ChatToolReceipt = {
    receiptId: 'rolling-private-receipt-new', anchorMessageId: suffix[0]!.id, name: 'read', arguments: { path: 'new.txt' },
    content: 'New result.', functionsStateId: 'rolling-private-state-new', status: 'completed', result: 'New result.', createdAt: at,
  };
  const oldProtocol: ProviderProtocolExchange = {
    anchorMessageId: covered[0]!.id, name: 'read', arguments: { path: 'old.txt' }, content: 'Old result.',
    functionsStateId: 'rolling-private-state-old', result: 'Old result.',
  };
  const newProtocol: ProviderProtocolExchange = {
    anchorMessageId: suffix[0]!.id, name: 'read', arguments: { path: 'new.txt' }, content: 'New result.',
    functionsStateId: 'rolling-private-state-new', result: 'New result.',
  };
  const oldSources = createCompactionSources(covered, [oldReceipt, newReceipt], []);
  const priorCandidate = JSON.stringify({
    format: 'gigachat-semantic-memory', version: 1,
    activeTask: { text: 'Continue the older active task.', sourceRefs: ['m0'] },
    constraints: [], decisions: [], openWork: [{ text: 'Keep the old pending item.', sourceRefs: ['m1'] }],
    facts: [{ text: 'The old tool returned its result.', sourceRefs: ['t0'], exactQuotes: [{ sourceRef: 't0', text: 'Old result.' }] }],
    pastTopics: [],
  });
  const priorSnapshot: CompactSnapshot = {
    id: 'rolling-v2-snapshot', version: 2, boundaryMessageId: covered[0]!.id,
    coveredThroughMessageId: covered[1]!.id, coveredPrefixHash: prefixHash(covered, [oldProtocol]),
    text: compileSemanticCompactionMemory(priorCandidate, oldSources), modelId: 'GigaChat-3-Lightning',
    provenance: 'fixture', createdAt: at,
  };
  const allMessages = [...covered, ...suffix];
  const context = buildNextTurnContext(input(allMessages, {
    compactSnapshot: priorSnapshot,
    protocolHistory: [oldProtocol, newProtocol],
    compactionToolReceipts: [oldReceipt, newReceipt],
    compactionArtifacts: [],
    usageKind: 'compaction',
    compactionFormat: 'semantic',
  }));
  const transcript = context.request.messages[0]?.text ?? '';
  const envelope = JSON.parse(transcript.slice(transcript.indexOf('\n') + 1)) as {
    previousMemory: { activeTask: { sourceRefs: string[] }; facts: Array<{ sourceRefs: string[] }> };
    coverageRefSet: string[];
    messages: Array<{ sourceRef: string; text: string }>;
    tools: Array<{ sourceRef: string; anchorRef: string; result: string | null }>;
  };

  assert.deepEqual(envelope.previousMemory, JSON.parse(priorSnapshot.text), 'the previous semantic memory, including valid source quotes, is carried forward');
  assert.deepEqual(envelope.previousMemory.activeTask.sourceRefs, ['m0']);
  assert.deepEqual(envelope.previousMemory.facts[0]?.sourceRefs, ['t0']);
  assert.deepEqual(envelope.coverageRefSet, ['m0', 'm1', 't0', 'm2', 'm3', 't1']);
  assert.deepEqual(envelope.messages.map(({ sourceRef, text }) => [sourceRef, text]), [
    ['m2', 'New raw request.'], ['m3', 'New raw answer.'],
  ]);
  assert.deepEqual(envelope.tools.map(({ sourceRef, anchorRef, result }) => [sourceRef, anchorRef, result]), [['t1', 'm2', 'New result.']]);
  assert.equal(envelope.messages.some(({ text }) => text.includes('Old raw request.') || text.includes('Old raw answer.')), false,
    'prior raw messages are not sent again');
  assert.equal(envelope.tools.some(({ result }) => result === 'Old result.'), false,
    'prior tool records are not sent again even when a short exact quote remains in the memory');
  const nextCandidate = JSON.stringify({
    ...JSON.parse(priorSnapshot.text),
    facts: [
      ...(JSON.parse(priorSnapshot.text) as { facts: unknown[] }).facts,
      { text: 'The new tool returned its result.', sourceRefs: ['t1'], exactQuotes: [{ sourceRef: 't1', text: 'New result.' }] },
    ],
  });
  assert.doesNotThrow(() => compileSemanticCompactionMemory(nextCandidate, context.compactionSources!));
  const notes = JSON.stringify({ taskSubject: 'Current task', state: 'Current task.', notes: Object.fromEntries(envelope.coverageRefSet.map(ref => [ref, 'The old tool returned its result.'])), verbatim: Object.fromEntries(envelope.coverageRefSet.map(ref => [ref, false])) });
  const review = buildSemanticCompactionReviewRequest(context.request, context.compactionSources!, envelope.coverageRefSet, notes);
  assert.ok(review);
  const reviewEnvelope = JSON.parse(review.messages[1]!.text.slice(review.messages[1]!.text.indexOf('\n') + 1)) as typeof envelope;
  assert.deepEqual(reviewEnvelope.previousMemory, envelope.previousMemory);
  assert.deepEqual(reviewEnvelope.tools, envelope.tools);
  const reviewMessages = reviewEnvelope.messages;
  assert.deepEqual({ ...reviewEnvelope, messages: reviewMessages }, envelope, 'segmented review preserves the full rolling archive without replaying old sources');
  assert.deepEqual(reviewMessages, envelope.messages, 'the review sees only the new raw suffix');
  assert.deepEqual(reviewEnvelope.tools, envelope.tools, 'the review sees only suffix tool records');
  assert.match(review.messages[0]!.text, /The old tool returned its result\./,
    'validated prior memory may be reviewed without resending the old raw tool record');
  assert.doesNotMatch(reviewMessages.map(({ text }) => text).join('\n'), /Old raw request\.|Old raw answer\./);
  assert.equal(buildSemanticCompactionReviewRequest(review, context.compactionSources!, envelope.coverageRefSet, nextCandidate), null);

  assert.throws(() => buildNextTurnContext(input(allMessages, {
    compactSnapshot: { ...priorSnapshot, coveredPrefixHash: '0'.repeat(64) }, protocolHistory: [oldProtocol, newProtocol],
    compactionToolReceipts: [oldReceipt, newReceipt], compactionArtifacts: [], usageKind: 'compaction', compactionFormat: 'semantic',
  })), /предыдущей semantic-памятью изменилась/);
  const invalidFutureRef = { ...priorSnapshot, text: JSON.stringify({ ...JSON.parse(priorSnapshot.text), openWork: [{ text: 'Future source', sourceRefs: ['m2'] }] }) };
  assert.throws(() => buildNextTurnContext(input(allMessages, {
    compactSnapshot: invalidFutureRef, protocolHistory: [oldProtocol, newProtocol], compactionToolReceipts: [oldReceipt, newReceipt],
    compactionArtifacts: [], usageKind: 'compaction', compactionFormat: 'semantic',
  })), /неизвестную или повторную ссылку/);
  const invalidFutureQuote = { ...priorSnapshot, text: JSON.stringify({ ...JSON.parse(priorSnapshot.text), facts: [
    { text: 'Old fact.', sourceRefs: ['m0'], exactQuotes: [{ sourceRef: 'm0', text: 'New raw request.' }] },
  ] }) };
  assert.throws(() => buildNextTurnContext(input(allMessages, {
    compactSnapshot: invalidFutureQuote, protocolHistory: [oldProtocol, newProtocol], compactionToolReceipts: [oldReceipt, newReceipt],
    compactionArtifacts: [], usageKind: 'compaction', compactionFormat: 'semantic',
  })), /Точная цитата не совпадает/);
  assert.throws(() => buildNextTurnContext(input(covered, {
    compactSnapshot: priorSnapshot, protocolHistory: [oldProtocol], compactionToolReceipts: [oldReceipt], compactionArtifacts: [],
    usageKind: 'compaction', compactionFormat: 'semantic',
  })), /новый завершённый фрагмент истории/i);
});

test('both semantic wire requests preserve source distinctions for all four selected models', async (t) => {
  const messages = [
    user('scope', 'Do not publish ownerCode values; the field name may appear in the report.'),
    assistant('permission', 'This is discussion only. Do not read or write local files before permission.'),
    user('observed', 'The copy was read on Linux build 4.2. Hash comparison passed; import is untested.'),
  ];
  for (const { currentId } of CHAT_MODEL_FAMILIES) await t.test(currentId, () => {
    const context = buildNextTurnContext(input(messages, { modelId: currentId, usageKind: 'compaction',
      compactionFormat: 'semantic', functionCallMode: 'none', compactionToolReceipts: [], compactionArtifacts: [] }));
    const sources = context.compactionSources!;
    const candidate = JSON.stringify({ taskSubject: 'Current task', state: 'Current task.', notes: { m0: 'Do not publish ownerCode.', m1: 'Read may be permitted.', m2: 'Copy validated.' }, verbatim: { m0: true, m1: true, m2: true } });
    const review = buildSemanticCompactionReviewRequest(context.request, sources, getSemanticCompactionCoverageRefSet(sources), candidate);
    assert.ok(review);
    const compiled = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson({ format: 'gigachat-semantic-memory', version: 1,
      activeTask: { text: 'Copy validated.', sourceRefs: ['m2'] }, decisions: [{ text: 'Keep scope.', sourceRefs: ['m0'] }],
      constraints: [{ scope: 'Files', sourceRefs: ['m1'] }], facts: [{ sourceRefs: ['m2'] }], openWork: [], pastTopics: [], unresolvedDefects: [] }),
    candidate, sources, getSemanticCompactionCoverageRefSet(sources), context.request.messages[0]!.text));
    assert.equal(compiled.decisions[0].text, messages[0]!.text);
    assert.equal(compiled.constraints[0].text, messages[1]!.text);
    assert.equal(compiled.facts[0].text, messages[2]!.text);
    assert.equal(compiled.activeTask.text, messages[2]!.text);
    const decode = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;
    const archive = decode(context.request.messages[0]!.text);
    for (const request of [context.request, review]) {
      const wire = JSON.parse(serializeProviderTurnRequest(request).body) as {
        model: string; messages: Array<{ role: string; content: Array<{ text: string }> }>; tool_config: { mode: string };
      };
      const start = request === context.request ? 1 : 2;
      assert.equal(wire.model, currentId);
      assert.equal(wire.tool_config.mode, 'none');
      assert.deepEqual(request === context.request ? { ...decode(wire.messages[start]!.content[0]!.text),
        messages: wire.messages.slice(start + 1, -1).map(message => decode(message.content[0]!.text)) } : decode(wire.messages[start]!.content[0]!.text), archive);
      assert.ok(wire.messages.slice(1).every(message => message.role === 'user'));
    }
  });
});

test('all four semantic models close subtopics while retaining interleaved work and observed defects', async (t) => {
  const messages = [user('boundary', 'Keep all original reports.'), user('detail', 'Chart layout: compare thin borders.'),
    assistant('subtopic', 'The chart legend uses a compact font.'), user('separate', 'The upload queue still needs investigation.'),
    user('closed', 'Chart styling is complete; leave it inactive.'), user('active', 'Continue the upload investigation.'),
    user('defect', 'UPLOAD-62: length check passed on macOS build 5.7; restored path differs. Upload was not attempted; the mismatch is unresolved.')];
  const refs = messages.map((_message, index) => `m${index}`);
  const candidate = JSON.stringify({ taskSubject: 'Current task', state: 'Chart closed; upload mismatch unresolved.', notes: Object.fromEntries(refs.map(ref => [ref, `Note ${ref}`])),
    verbatim: Object.fromEntries(refs.map(ref => [ref, true])) });
  for (const { currentId } of CHAT_MODEL_FAMILIES) await t.test(currentId, () => {
    const context = buildNextTurnContext(input(messages, { modelId: currentId, usageKind: 'compaction', compactionFormat: 'semantic',
      functionCallMode: 'none', compactionToolReceipts: [], compactionArtifacts: [] }));
    const sources = context.compactionSources!;
    const review = buildSemanticCompactionReviewRequest(context.request, sources, refs, candidate)!;
    const wire = JSON.parse(serializeProviderTurnRequest(review).body);
    assert.equal(wire.model, currentId); assert.equal(wire.tool_config.mode, 'none');
    assert.equal(wire.model_options.response_format.type, 'text');
    const compiled = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson({ format: 'gigachat-semantic-memory', version: 1,
      activeTask: { text: 'Continue upload.', sourceRefs: ['m5'] }, constraints: [{ scope: 'Reports', sourceRefs: ['m0'] }],
      facts: [{ sourceRefs: ['m1'] }, { sourceRefs: ['m2'] }], decisions: [],
      openWork: [{ text: 'Queue pending.', sourceRefs: ['m3'] }, { text: 'Investigate.', sourceRefs: ['m5'] }],
      pastTopics: [{ text: 'Chart complete.', sourceRefs: ['m1', 'm2'], closureEvidence: 'Chart styling is complete; leave it inactive.' }],
      unresolvedDefects: [{ sourceRefs: ['m6'], exactQuotes: [{ sourceRef: 'm6', text: 'length check passed on macOS build 5.7; restored path differs. Upload was not attempted; the mismatch is unresolved.' }] }] }),
    candidate, sources, refs, context.request.messages[0]!.text));
    assert.deepEqual(compiled.facts.map((entry: { sourceRefs: string[] }) => entry.sourceRefs), [['m6']]);
    assert.deepEqual(compiled.decisions, []);
    assert.deepEqual(compiled.openWork.map((entry: { sourceRefs: string[] }) => entry.sourceRefs), [['m3'], ['m5'], ['m6']]);
    assert.equal(compiled.facts[0].text, messages[6]!.text);
    assert.equal(compiled.openWork[2].text, 'Наблюдённый неустранённый дефект: length check passed on macOS build 5.7; restored path differs. Upload was not attempted; the mismatch is unresolved.');
    assert.deepEqual(compiled.unresolvedDefects[0].sourceRefs, compiled.openWork[2].sourceRefs);
    assert.equal(compiled.closedTopics[0].closedBy, 'm4');
    const next = buildNextTurnContext(input([...messages, user('recall', 'What is the current test result?')], {
      modelId: currentId, compactSnapshot: { ...snapshot(messages[6]!.id, messages[6]!.id, messages), text: JSON.stringify(compiled), version: 2, modelId: currentId },
      compactionToolReceipts: [], compactionArtifacts: [],
    }));
    assert.match(JSON.stringify(serializeProviderTurnRequest(next.request).body), /НЕУСТРАНЁННЫЙ ДЕФЕКТ/);
  });
});

test('builds an independent semantic review from the exact current archive and a validated candidate', () => {
  const messages = [
    user('semantic-review-user', 'Continue the current package validation.'),
    assistant('semantic-review-answer', 'The Windows build is ready for review.'),
  ];
  const receipt: ChatToolReceipt = {
    receiptId: 'private-review-receipt', anchorMessageId: messages[0]!.id, name: 'read', arguments: { path: 'status.txt' },
    content: 'The package status was checked.', functionsStateId: 'private-review-state', status: 'completed',
    result: 'The build is ready.', createdAt: at,
  };
  const context = buildNextTurnContext(input(messages, {
    usageKind: 'compaction', compactionFormat: 'semantic', functionCallMode: 'none',
    compactionToolReceipts: [receipt], compactionArtifacts: [],
  }));
  const sources = context.compactionSources!;
  const sourceRefs = getSemanticCompactionCoverageRefSet(sources);
  const candidate = JSON.stringify({ taskSubject: 'Current task', state: 'Current task.', notes: { m0: 'Continue package validation.', m1: 'Review the Windows build.', t0: 'The build is ready.' }, verbatim: { m0: false, m1: false, t0: false } });
  const originalRequest = structuredClone(context.request);

  const review = buildSemanticCompactionReviewRequest(context.request, sources, sourceRefs, candidate);

  assert.ok(review);
  const reviewTaskLayer = review.system[review.system.length - 1]!;
  assert.deepEqual(context.request, originalRequest, 'review preparation does not mutate the original request');
  assert.deepEqual(review.system.slice(0, -1), originalRequest.system.slice(0, -1));
  assert.equal(review.system.length, originalRequest.system.length);
  assert.equal(reviewTaskLayer.source, 'runtime');
  assert.equal(reviewTaskLayer.label, 'Задача текущего запроса');
  assert.match(reviewTaskLayer.text, /^Определи актуальность каждой/);
  assert.notEqual(reviewTaskLayer.text, SEMANTIC_COMPACTION_TASK_INSTRUCTION);
  assert.equal(review.system.filter((layer) => layer.label === 'Задача текущего запроса').length, 1);
  assert.equal(review.system.filter((layer) => layer.text === SEMANTIC_COMPACTION_TASK_INSTRUCTION).length, 0);
  assert.equal(review.modelId, originalRequest.modelId);
  assert.equal(review.permissionProfile, originalRequest.permissionProfile);
  assert.equal(review.usageKind, 'compaction');
  assert.equal(review.compactionFormat, 'semantic');
  assert.equal(Object.prototype.hasOwnProperty.call(review, 'compactionRepair'), false);
  assert.equal(review.functionCallMode, 'none');
  assert.equal(review.maxOutputTokens, 4096);
  assert.equal(review.messages.length, 3);
  assert.ok(review.messages.every(message => message.role === 'user'), 'historical roles never become current instructions');
  const decode = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.deepEqual(decode(review.messages[1]!.text),
    decode(context.request.messages[0]!.text), 'review reconstructs every exact source record after the candidate');
  assert.match(review.messages[0]?.text ?? '', /^ПОИСТОЧНИКОВЫЕ СМЫСЛОВЫЕ ЗАМЕТКИ JSON/);
  assert.match(review.messages[0]?.text ?? '', /Review the Windows build/);
  assert.equal(review.messages[review.messages.length - 1]?.id, 'request-semantic-review-task');
  assert.match(review.messages[review.messages.length - 1]?.text ?? '', /При расхождении заметки с архивом опирайся на архив/);
  assert.doesNotMatch(review.messages.map(({ text }) => text).join('\n'), /Независимо проверь черновик semantic-памяти/);

  const reviewWire = serializeProviderTurnRequest(review);
  assert.ok(reviewWire.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
  const wire = JSON.parse(reviewWire.body) as {
    tools?: unknown[]; tool_config: { mode: string };
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
    model_options: { response_format: { type: string } };
  };
  assert.deepEqual(wire.messages.map(({ role }) => role), ['system', ...review.messages.map(message => message.role)]);
  const systemText = wire.messages[0]?.content[0]?.text ?? '';
  assert.equal(systemText.split(reviewTaskLayer.text).length - 1, 1);
  assert.equal(systemText.split(SEMANTIC_COMPACTION_TASK_INSTRUCTION).length - 1, 0);
  assert.equal(wire.messages[1]?.content[0]?.text, review.messages[0]?.text);
  assert.equal(wire.messages[2]?.content[0]?.text, review.messages[1]?.text);
  assert.equal(wire.messages[3]?.content[0]?.text, review.messages[2]?.text);
  assert.equal(wire.messages[wire.messages.length - 1]?.content[0]?.text, review.messages[review.messages.length - 1]?.text);
  assert.equal(wire.tool_config.mode, 'none');
  assert.equal(wire.tools, undefined);
  assert.equal(wire.model_options.response_format.type, 'text');
  assert.match(review.messages[2]!.text, /unresolvedDefects/);
  assert.doesNotMatch(review.messages[0]!.text + review.messages[1]!.text,
    /private-review-receipt|private-review-state|functionsStateId/);

  assert.equal(buildSemanticCompactionReviewRequest(review, sources, sourceRefs, candidate), null,
    'a review request cannot recursively become another review');
  assert.equal(buildSemanticCompactionReviewRequest(context.request, sources, sourceRefs.slice(0, -1), candidate), null,
    'the supplied source inventory must exactly match the archived inventory');
  const unknownSourceCandidate = JSON.stringify({
    ...JSON.parse(candidate), activeTask: { text: 'Unknown source.', sourceRefs: ['m999'] },
  });
  assert.equal(buildSemanticCompactionReviewRequest(context.request, sources, sourceRefs, unknownSourceCandidate), null);
  const invalidQuoteCandidate = JSON.stringify({
    ...JSON.parse(candidate),
    facts: [{ text: 'A fabricated quote.', sourceRefs: ['m1'], exactQuotes: [{ sourceRef: 'm1', text: 'not in source' }] }],
  });
  assert.equal(buildSemanticCompactionReviewRequest(context.request, sources, sourceRefs, invalidQuoteCandidate), null);
  assert.equal(buildSemanticCompactionReviewRequest(context.request, sources, sourceRefs, '{'), null);
  assert.equal(buildSemanticCompactionReviewRequest({ ...context.request, functionCallMode: 'auto' }, sources, sourceRefs, candidate), null);
  assert.equal(buildSemanticCompactionReviewRequest({ ...context.request, usageKind: 'chat' }, sources, sourceRefs, candidate), null);
  const taskLayer = originalRequest.system[originalRequest.system.length - 1]!;
  const invalidTaskRequests = [
    { ...originalRequest, system: [...originalRequest.system, { ...taskLayer }] },
    { ...originalRequest, system: originalRequest.system.map((layer) => layer === taskLayer ? { ...layer, text: 'Changed task' } : layer) },
    { ...originalRequest, system: originalRequest.system.map((layer) => layer === taskLayer ? { ...layer, source: 'global' as const } : layer) },
    { ...originalRequest, system: originalRequest.system.map((layer) => layer === taskLayer ? { ...layer, scope: 'project' } : layer) },
    { ...originalRequest, system: [...originalRequest.system.slice(0, -1), { ...taskLayer, label: 'Другой слой' }] },
  ];
  for (const invalidRequest of invalidTaskRequests) {
    assert.equal(buildSemanticCompactionReviewRequest(invalidRequest, sources, sourceRefs, candidate), null,
      'review rejects duplicate or noncanonical service task layers');
  }
  const invalidArchiveRequest = { ...originalRequest, messages: [
    { ...originalRequest.messages[0]!, text: undefined as unknown as string },
  ] };
  assert.equal(buildSemanticCompactionReviewRequest(invalidArchiveRequest, sources, sourceRefs, candidate), null);

  const changedSources = createCompactionSources([
    { ...messages[0]!, text: 'Changed source.' }, messages[1]!,
  ], [receipt], []);
  assert.equal(buildSemanticCompactionReviewRequest(context.request, changedSources, sourceRefs, candidate), null,
    'the archive cannot be reviewed against source data that changed');
});
test('rejects compact summaries without any Unicode letter or number but accepts Cyrillic, Latin, and numeric text', () => {
  for (const value of ['|', ' \t\n ', '…—!?', '🔥✨']) {
    assert.throws(() => validateCompactSummary(value), /Сводка должна быть непустым текстом/);
  }
  assert.equal(validateCompactSummary('  Решение принято.  '), 'Решение принято.');
  assert.equal(validateCompactSummary('Keep the retry limit at 3.'), 'Keep the retry limit at 3.');
  assert.equal(validateCompactSummary('  404  '), '404');
});

test('filters state after compact-prefix validation and sizes the same filtered request', () => {
  const oldUser = user('old-user');
  const coveredAssistant = assistant('covered-assistant', 'Earlier covered result');
  coveredAssistant.functionsStateId = 'covered-legacy-state';
  const unownedAssistant = assistant('old-assistant', 'Later retained result');
  unownedAssistant.functionsStateId = 'legacy-state';
  const currentUser = user('current-user', 'Continue');
  const messages = [oldUser, coveredAssistant, unownedAssistant, currentUser];
  const compactSnapshot = snapshot('old-user', 'covered-assistant', [oldUser, coveredAssistant]);
  const ownership = { messages: [
    { messageId: coveredAssistant.id, owned: false },
    { messageId: unownedAssistant.id, owned: false },
  ], receipts: [], compact: null };
  const raw = stateDetail(messages);
  const rawBefore = structuredClone({ messages, protocolHistory: [] as ProviderProtocolExchange[] });
  const context = buildNextTurnContext(input(messages, { compactSnapshot }), {
    providerStateFilter: { detail: raw, ownership, currentAnchorMessageId: currentUser.id },
  });
  const serialized = serializeProviderTurnRequest(context.request);

  assert.deepEqual(context.request.messages.map((message) => message.id), ['old-assistant', 'current-user']);
  assert.equal(Object.prototype.hasOwnProperty.call(context.request.messages[0]!, 'functionsStateId'), false);
  assert.match(context.request.system.find((layer) => layer.source === 'summary')?.text ?? '', /Сводка: продолжить задачу/);
  assert.equal(context.wireBytes, serialized.wireBytes);
  assert.deepEqual(context.textInputs, serialized.textInputs);
  assert.deepEqual({ messages, protocolHistory: [] }, rawBefore, 'request filtering preserves hash-covered raw history');

  const changedCoveredAssistant = { ...coveredAssistant, functionsStateId: 'different-covered-state' };
  const changedMessages = [oldUser, changedCoveredAssistant, unownedAssistant, currentUser];
  assert.throws(() => buildNextTurnContext(input(changedMessages, { compactSnapshot }), {
    providerStateFilter: { detail: raw, ownership, currentAnchorMessageId: currentUser.id },
  }), /История под сводкой изменилась/,
  'a changed state inside the raw compact prefix is rejected before request-only filtering');
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
  const payload = JSON.parse(serialized.body) as {
    messages: Array<{ content: Array<{ text?: string }> }>;
    tools: Array<{ functions: { specifications: unknown[] } }>;
    tool_config: { mode: string };
  };
  assert.equal(serialized.wireBytes, Buffer.byteLength(serialized.body, 'utf8'));
  assert.ok(serialized.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
  assert.equal(payload.tools[0]?.functions.specifications.length, 6);
  assert.equal(payload.tool_config.mode, 'auto');
  assert.equal(serialized.textInputs.length, payload.messages.length);
  assert.equal(context.blocks.find((block) => block.source === 'function-schema')?.label, 'Схема инструментов');

  const measured = await countContextTextTokens(context, {
    countTokens: async (_model, inputs) => inputs.map((text) => ({ object: 'tokens' as const, tokens: 2, characters: [...text].length })),
  }, new AbortController().signal);
  assert.equal(measured.textTokenCount, serialized.textInputs.length * 2);
  assert.equal(measured.textCountProvenance, 'verified');
  assert.equal(measured.provenance, 'unknown');
});

test('estimates actual serialized wire text, function calls, results, tool schema, and framing once', async () => {
  const request = buildNextTurnContext(input([user('estimate-user', 'Read the file.')], {
    modelId: 'GigaChat-3-Lightning',
    protocolHistory: [{
      anchorMessageId: 'estimate-user', name: 'read', arguments: { path: 'notes.txt' }, content: null,
      functionsStateId: null, result: '{"ok":true,"result":"Found the requested note."}',
    }],
  })).request;
  const serialized = serializeProviderTurnRequest(request);
  const payload = JSON.parse(serialized.body) as {
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    tools: Array<{ functions: { specifications: unknown[] } }>;
  };
  const countedTexts: string[] = [];
  const countTextTokens = async (_model: string, texts: readonly string[]) => {
    countedTexts.push(...texts);
    return texts.map((text) => [...text].length);
  };
  const estimate = await estimateProviderPromptTokens(request, countTextTokens, new AbortController().signal,
    createContextTextTokenCache());
  const visibleTexts = payload.messages.flatMap((message) => message.content.flatMap((part) => {
    if (typeof part.text === 'string') return [part.text];
    if (typeof part.function_call === 'object' && part.function_call !== null) {
      const call = part.function_call as { name: string; arguments: unknown };
      return [call.name, JSON.stringify(call.arguments)];
    }
    if (typeof part.function_result === 'object' && part.function_result !== null) {
      return [(part.function_result as { result: string }).result];
    }
    return [];
  }));
  const schemaText = JSON.stringify(payload.tools);
  const visibleTokens = [...visibleTexts, schemaText].reduce((sum, text) => sum + [...text].length, 0);

  assert.deepEqual(estimate, {
    status: 'complete', tokens: visibleTokens + 7 + 5 * payload.messages.length - 44 + 14,
    knownTokens: visibleTokens, provenance: 'estimated', wireMessageCount: payload.messages.length,
    functionCallCount: 1, unknownReasons: [],
  });
  assert.ok(countedTexts.includes('read'));
  assert.ok(countedTexts.includes('{"path":"notes.txt"}'));
  assert.ok(countedTexts.includes('{"ok":true,"result":"Found the requested note."}'));
  assert.ok(countedTexts.includes(schemaText));
  assert.equal(request.maxOutputTokens, 8_192);
  assert.equal(serialized.body, serializeProviderTurnRequest(request).body, 'estimation leaves the provider serializer input untouched');

  const callWithOpaqueField = JSON.parse(serialized.body) as {
    messages: Array<{ content: Array<Record<string, unknown>>; tools_state_id?: string }>;
  };
  const functionPart = callWithOpaqueField.messages.flatMap((message) => message.content)
    .find((part) => typeof part.function_call === 'object' && part.function_call !== null)!;
  (functionPart.function_call as Record<string, unknown>).id = 'opaque-call-id';
  const opaqueCallEstimate = await estimateSerializedProviderPrompt(JSON.stringify(callWithOpaqueField), request,
    countTextTokens, new AbortController().signal);
  assert.equal(opaqueCallEstimate.status, 'partial');
  assert.ok(opaqueCallEstimate.unknownReasons.includes('unsupported-wire-component'));

  const longHistory = JSON.parse(serialized.body) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  const oneMessage = longHistory.messages.find((message) => message.role === 'user')!;
  longHistory.messages = Array.from({ length: 47 }, () => structuredClone(oneMessage));
  const outsideDomain = await estimateSerializedProviderPrompt(JSON.stringify(longHistory), request,
    countTextTokens, new AbortController().signal);
  assert.equal(outsideDomain.status, 'complete');
  assert.equal(outsideDomain.provenance, 'estimated');
  assert.equal(outsideDomain.tokens, outsideDomain.knownTokens! + 7 + 5 * longHistory.messages.length - 44);
  assert.equal(outsideDomain.wireMessageCount, 47);
  assert.equal(outsideDomain.functionCallCount, 0);
  assert.deepEqual(outsideDomain.unknownReasons, []);
  assert.ok(outsideDomain.knownTokens !== null);

  const messageOverflow = JSON.parse(serialized.body) as typeof payload;
  messageOverflow.messages = Array.from({ length: 2_051 }, () => structuredClone(oneMessage));
  const longEstimate = await estimateSerializedProviderPrompt(JSON.stringify(messageOverflow), request,
    countTextTokens, new AbortController().signal);
  assert.equal(longEstimate.status, 'complete');
  assert.equal(longEstimate.provenance, 'estimated');
  assert.equal(longEstimate.wireMessageCount, 2_051);
  assert.equal(longEstimate.functionCallCount, 0);
  assert.deepEqual(longEstimate.unknownReasons, []);
  const longShape = { wireMessageCount: longEstimate.wireMessageCount, functionCallCount: longEstimate.functionCallCount };
  const longBudget = calculateLiteWorkingBudget(null, longShape);
  assert.equal(longBudget.status, 'available');
  assert.equal(longBudget.operationalProfile?.calibrationDomainStatus, 'extrapolated');
  assert.equal(longBudget.operationalProfile?.appliedErrorReserveTokens, 12_073);
  assert.equal(liteHardInputLimit(request, longShape), null);
  assert.equal(isLitePromptOverMeasuredInputGuard(request, longEstimate), false,
    'the extrapolated prompt gets a soft operational budget but no unvalidated hard refusal');

  const callOverflow = JSON.parse(serialized.body) as typeof payload;
  callOverflow.messages = Array.from({ length: 33 }, () => [
    { role: 'assistant', content: [{ function_call: { name: 'read', arguments: { path: 'notes.txt' } } }] },
    { role: 'tool', content: [{ function_result: { name: 'read', result: 'Found the requested note.' } }] },
  ]).flat();
  const callEstimate = await estimateSerializedProviderPrompt(JSON.stringify(callOverflow), request,
    countTextTokens, new AbortController().signal);
  assert.equal(callEstimate.status, 'complete');
  assert.equal(callEstimate.wireMessageCount, 66);
  assert.equal(callEstimate.functionCallCount, 33);
  assert.deepEqual(callEstimate.unknownReasons, []);
  const callBudget = calculateLiteWorkingBudget(null, {
    wireMessageCount: callEstimate.wireMessageCount, functionCallCount: callEstimate.functionCallCount,
  });
  assert.equal(callBudget.operationalProfile?.calibrationDomainStatus, 'extrapolated');
  assert.equal(callBudget.operationalProfile?.appliedErrorReserveTokens, 2_582);
  assert.equal(liteHardInputLimit(request, {
    wireMessageCount: callEstimate.wireMessageCount, functionCallCount: callEstimate.functionCallCount,
  }), null);
});

test('includes response schema in semantic estimates and marks unknown wire, file, state, and schema components partial', async () => {
  const semanticContext = buildNextTurnContext(input([user('semantic-estimate', 'Archive this prefix.')], {
    modelId: 'GigaChat-3-Lightning', usageKind: 'compaction', compactionFormat: 'semantic',
    functionCallMode: 'none', compactionToolReceipts: [], compactionArtifacts: [],
  }));
  const semanticBody = serializeProviderTurnRequest(semanticContext.request).body;
  const semanticPayload = JSON.parse(semanticBody) as { model_options: { response_format: unknown } };
  const counted: string[] = [];
  const counter = async (_model: string, texts: readonly string[]) => {
    counted.push(...texts);
    return texts.map((text) => [...text].length);
  };
  const semanticEstimate = await estimateProviderPromptTokens(semanticContext.request, counter, new AbortController().signal);
  assert.equal(semanticEstimate.status, 'complete');
  assert.equal(semanticEstimate.provenance, 'estimated');
  assert.ok(counted.includes(JSON.stringify(semanticPayload.model_options.response_format)));
  const tamperedResponse = JSON.parse(semanticBody) as { model_options: { response_format: Record<string, unknown> } };
  tamperedResponse.model_options.response_format.extra = true;
  const responseEstimate = await estimateSerializedProviderPrompt(JSON.stringify(tamperedResponse), semanticContext.request,
    counter, new AbortController().signal);
  assert.equal(responseEstimate.status, 'partial');
  assert.ok(responseEstimate.unknownReasons.includes('unrecognized-response-schema'));

  const normalContext = buildNextTurnContext(input([user('tamper-user', 'Question')], {
    modelId: 'GigaChat-3-Lightning', functionCallMode: 'none',
  }));
  const normalRequest = normalContext.request;
  const base = JSON.parse(serializeProviderTurnRequest(normalRequest).body) as Record<string, unknown> & {
    messages: Array<{ role: string; content: Array<Record<string, unknown>>; tools_state_id?: string }>;
    tools?: Array<{ functions: { specifications: Array<Record<string, unknown>> } }>;
  };
  const variants: Array<{ body: string; reason: string }> = [];
  const withFile = structuredClone(base);
  withFile.messages.find((message) => message.role === 'user')!.content.push({ files: [{ id: 'opaque-file' }] });
  variants.push({ body: JSON.stringify(withFile), reason: 'attachment-content' });
  const withOpaqueState = structuredClone(base);
  withOpaqueState.messages[0]!.tools_state_id = 'opaque-state';
  variants.push({ body: JSON.stringify(withOpaqueState), reason: 'opaque-function-state' });
  const withUnknownTopLevel = { ...base, future_field: { private: true } };
  variants.push({ body: JSON.stringify(withUnknownTopLevel), reason: 'unsupported-wire-component' });
  const withTamperedOptions = structuredClone(base);
  withTamperedOptions.model_options = { parallel_tool_calls: false, max_tokens: 8_191 };
  variants.push({ body: JSON.stringify(withTamperedOptions), reason: 'unsupported-wire-component' });
  for (const variant of variants) {
    const partial = await estimateSerializedProviderPrompt(variant.body, normalRequest, counter, new AbortController().signal);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.tokens, null);
    assert.equal(partial.provenance, 'estimated');
    assert.ok(partial.unknownReasons.includes(variant.reason as typeof partial.unknownReasons[number]));
  }

  const withUnknownToolSchema = JSON.parse(serializeProviderTurnRequest(
    buildNextTurnContext(input([user('tool-schema-user')], { modelId: 'GigaChat-3-Lightning' })).request,
  ).body) as Record<string, unknown> & { tools: Array<{ functions: { specifications: Array<Record<string, unknown>> } }> };
  withUnknownToolSchema.tools[0]!.functions.specifications[0]!.description = 'Schema changed';
  const unknownSchema = await estimateSerializedProviderPrompt(JSON.stringify(withUnknownToolSchema), {
    ...buildNextTurnContext(input([user('tool-schema-user')], { modelId: 'GigaChat-3-Lightning' })).request,
  }, counter, new AbortController().signal);
  assert.equal(unknownSchema.status, 'partial');
  assert.ok(unknownSchema.unknownReasons.includes('unrecognized-tool-schema'));
});

test('reuses bounded prompt-token cache, validates request snapshots, cancellation, unsupported models, and overflow', async () => {
  const request = buildNextTurnContext(input([user('estimate-cache', 'A short request.')], {
    modelId: 'GigaChat-3-Lightning', functionCallMode: 'none',
  })).request;
  const cache = createContextTextTokenCache();
  let calls = 0;
  const counter = async (_model: string, texts: readonly string[]) => { calls++; return texts.map((text) => [...text].length); };
  const first = await estimateProviderPromptTokens(request, counter, new AbortController().signal, cache);
  const second = await estimateProviderPromptTokens(request, counter, new AbortController().signal, cache);
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'a second full prompt estimate reuses each exact text cache entry');

  const changingRequest = structuredClone(request);
  await assert.rejects(estimateProviderPromptTokens(changingRequest, async (_model, texts) => {
    changingRequest.messages[0]!.text += ' changed while counting';
    return texts.map((text) => [...text].length);
  }, new AbortController().signal, createContextTextTokenCache()), /Контекст изменился во время подсчёта/);

  const changedThenUnavailable = structuredClone(request);
  await assert.rejects(estimateProviderPromptTokens(changedThenUnavailable, async () => {
    changedThenUnavailable.messages[0]!.text += ' changed before native failure';
    throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
  }, new AbortController().signal), /Контекст изменился во время подсчёта/,
  'native technical failures cannot hide a mutated prompt snapshot');

  const changedThenResourceInvalid = structuredClone(request);
  await assert.rejects(estimateProviderPromptTokens(changedThenResourceInvalid, async () => {
    changedThenResourceInvalid.messages[0]!.text += ' changed before resource denial';
    throw new Error('LOCAL_TOKENIZER_RESOURCE_INVALID');
  }, new AbortController().signal), /Контекст изменился во время подсчёта/,
  'resource integrity denial cannot hide a mutated prompt snapshot');

  let unsupportedCounterCalls = 0;
  const unsupported = await estimateProviderPromptTokens({ ...request, modelId: 'GigaChat-3-Pro' }, async () => {
    unsupportedCounterCalls++;
    return [];
  }, new AbortController().signal);
  assert.equal(unsupported.status, 'unknown');
  assert.deepEqual(unsupported.unknownReasons, ['unsupported-model']);
  assert.equal(unsupportedCounterCalls, 0);

  const tokenizerUnavailable = await estimateProviderPromptTokens(request, async () => {
    throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
  }, new AbortController().signal);
  assert.equal(tokenizerUnavailable.status, 'unknown');
  assert.deepEqual(tokenizerUnavailable.unknownReasons, ['tokenizer-unavailable']);
  await assert.rejects(estimateProviderPromptTokens(request, async (_model, texts) => {
    if (texts.length) throw new Error('LOCAL_TOKENIZER_COUNT_INVALID');
    return [];
  }, new AbortController().signal), /LOCAL_TOKENIZER_COUNT_INVALID/,
  'invalid native counts are not downgraded to an unavailable estimate');
  const tokenizerResourceInvalid = await estimateProviderPromptTokens(request, async () => {
    throw new Error('LOCAL_TOKENIZER_RESOURCE_INVALID');
  }, new AbortController().signal);
  assert.equal(tokenizerResourceInvalid.status, 'unknown');
  assert.equal(tokenizerResourceInvalid.provenance, 'unknown');
  assert.deepEqual(tokenizerResourceInvalid.unknownReasons, ['tokenizer-unavailable']);
  await assert.rejects(estimateProviderPromptTokens(request, async () => {
    throw new Error('LOCAL_TOKENIZER_RESOURCE_INVALID_EXTRA');
  }, new AbortController().signal), /LOCAL_TOKENIZER_RESOURCE_INVALID_EXTRA/,
  'only the exact native resource denial is neutralized');

  const controller = new AbortController();
  await assert.rejects(estimateProviderPromptTokens(request, async (_model, texts, signal) => {
    controller.abort();
    signal.throwIfAborted();
    return texts.map(() => 0);
  }, controller.signal, createContextTextTokenCache()), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await assert.rejects(estimateProviderPromptTokens(request, async (_model, texts) =>
    texts.map(() => Number.MAX_SAFE_INTEGER), new AbortController().signal, createContextTextTokenCache()), /некорректное количество/);
});

test('reuses verified counts by exact model and text, deduping misses while preserving repeated blocks', async () => {
  const cache = createContextTextTokenCache();
  const calls: Array<{ modelId: string; texts: string[] }> = [];
  const provider = {
    countTokens: async (modelId: string, texts: readonly string[]) => {
      calls.push({ modelId, texts: [...texts] });
      return texts.map((text) => ({ object: 'tokens' as const, tokens: text.length, characters: [...text].length }));
    },
  };

  const first = await countContextTextTokens(textCountContext(['same', 'same', 'other']), provider, new AbortController().signal, cache);
  assert.equal(first.textTokenCount, 13);
  assert.equal(first.textCountProvenance, 'verified');
  assert.equal(first.provenance, 'unknown');
  assert.deepEqual(calls, [{ modelId: 'cache-model', texts: ['same', 'other'] }]);

  const repeated = await countContextTextTokens(textCountContext(['same', 'same', 'other']), provider, new AbortController().signal, cache);
  assert.equal(repeated.textTokenCount, 13);
  assert.equal(calls.length, 1, 'a full cache hit makes no provider call');

  await countContextTextTokens(textCountContext(['same', 'changed']), provider, new AbortController().signal, cache);
  await countContextTextTokens(textCountContext(['same', 'changed'], 'another-model'), provider, new AbortController().signal, cache);
  await countContextTextTokens(textCountContext(['same', 'changed']), provider, new AbortController().signal, createContextTextTokenCache());
  assert.deepEqual(calls.slice(1), [
    { modelId: 'cache-model', texts: ['changed'] },
    { modelId: 'another-model', texts: ['same', 'changed'] },
    { modelId: 'cache-model', texts: ['same', 'changed'] },
  ], 'content, model, and cache-instance changes cannot reuse another count');
  assert.equal(JSON.stringify(cache).includes('same'), false, 'the cache object does not serialize its text keys');
});

test('keeps local estimates separate from verified counts and labels their provenance', async () => {
  const estimatedCache = createContextTextTokenCache();
  const verifiedCache = createContextTextTokenCache();
  const context = textCountContext(['same', 'same', 'other']);
  const localCalls: string[][] = [];
  const estimated = await countEstimatedContextTextTokens(context, async (_model, texts) => {
    localCalls.push([...texts]);
    return texts.map((text) => text.length);
  }, new AbortController().signal, estimatedCache);

  assert.equal(estimated.textTokenCount, 13);
  assert.equal(estimated.textCountProvenance, 'estimated');
  assert.equal(estimated.provenance, 'unknown');
  assert.deepEqual(localCalls, [['same', 'other']], 'only distinct text misses reach the local tokenizer');
  assert.deepEqual(readContextTextTokenCacheCoverage(context, estimatedCache), {
    knownTokenCount: 13, missingDistinctTextCount: 0, complete: true,
  });

  let providerCalls = 0;
  const verified = await countContextTextTokens(context, {
    countTokens: async (_model, texts) => {
      providerCalls++;
      return texts.map((text) => ({ object: 'tokens' as const, tokens: 1, characters: [...text].length }));
    },
  }, new AbortController().signal, verifiedCache);
  assert.equal(verified.textTokenCount, 3);
  assert.equal(verified.textCountProvenance, 'verified');
  assert.equal(providerCalls, 1, 'verified counts do not reuse locally estimated cache entries');
});

test('does not cache invalid or cancelled local estimate batches', async () => {
  const cache = createContextTextTokenCache();
  const context = textCountContext(['first', 'second']);
  const coverage = () => readContextTextTokenCacheCoverage(context, cache);
  await assert.rejects(countEstimatedContextTextTokens(context, async () => [3, Number.NaN],
    new AbortController().signal, cache), /некорректное количество/);
  assert.deepEqual(coverage(), { knownTokenCount: 0, missingDistinctTextCount: 2, complete: false });

  const controller = new AbortController();
  let resolveCounts!: (counts: number[]) => void;
  const pending = countEstimatedContextTextTokens(context,
    async () => new Promise((resolve) => { resolveCounts = resolve; }), controller.signal, cache);
  controller.abort();
  resolveCounts([1, 2]);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.deepEqual(coverage(), { knownTokenCount: 0, missingDistinctTextCount: 2, complete: false });
});

test('keeps distinct UTF-16 strings separate when UTF-8 would replace a lone surrogate', async () => {
  const cache = createContextTextTokenCache();
  const loneSurrogate = String.fromCharCode(0xd800);
  const replacementCharacter = String.fromCharCode(0xfffd);
  const calls: string[][] = [];
  const provider = {
    countTokens: async (_model: string, texts: readonly string[]) => {
      calls.push([...texts]);
      return texts.map((text) => ({
        object: 'tokens' as const,
        tokens: text === loneSurrogate ? 5 : 9,
        characters: [...text].length,
      }));
    },
  };

  const first = await countContextTextTokens(textCountContext([loneSurrogate]), provider, new AbortController().signal, cache);
  const second = await countContextTextTokens(textCountContext([replacementCharacter]), provider, new AbortController().signal, cache);
  assert.equal(first.textTokenCount, 5);
  assert.equal(second.textTokenCount, 9);
  assert.deepEqual(calls, [[loneSurrogate], [replacementCharacter]]);
});

test('reads partial cache coverage locally and counts known duplicate blocks in the subtotal', async () => {
  const cache = createContextTextTokenCache();
  let calls = 0;
  const provider = { countTokens: async (_model: string, texts: readonly string[]) => {
    calls++;
    return texts.map((text) => ({ object: 'tokens' as const, tokens: text.length, characters: [...text].length }));
  } };
  await countContextTextTokens(textCountContext(['known']), provider, new AbortController().signal, cache);

  const coverage = readContextTextTokenCacheCoverage(textCountContext(['known', 'known', 'missing', 'missing']), cache);
  assert.deepEqual(coverage, { knownTokenCount: 10, missingDistinctTextCount: 1, complete: false });
  assert.equal(calls, 1, 'coverage reads only local cache state');
});

test('marks an empty text input as a verified zero without calling the provider', async () => {
  let calls = 0;
  const cache = createContextTextTokenCache();
  const measured = await countContextTextTokens(textCountContext([]), {
    countTokens: async () => { calls++; return []; },
  }, new AbortController().signal, cache);

  assert.equal(measured.textTokenCount, 0);
  assert.equal(measured.textCountProvenance, 'verified');
  assert.equal(measured.provenance, 'unknown');
  assert.deepEqual(readContextTextTokenCacheCoverage(textCountContext([]), cache), {
    knownTokenCount: 0, missingDistinctTextCount: 0, complete: true,
  });
  assert.equal(calls, 0);
});

test('does not cache partial, mismatched, or numerically invalid provider rows', async () => {
  const cache = createContextTextTokenCache();
  const context = textCountContext(['short', 'much-longer']);
  const coverage = () => readContextTextTokenCacheCoverage(context, cache);
  await assert.rejects(countContextTextTokens(context, {
    countTokens: async (_model, texts) => texts.slice(0, 1).map((text) => ({
      object: 'tokens' as const, tokens: 1, characters: [...text].length,
    })),
  }, new AbortController().signal, cache), /не совпал/);
  assert.deepEqual(coverage(), { knownTokenCount: 0, missingDistinctTextCount: 2, complete: false });

  await assert.rejects(countContextTextTokens(context, {
    countTokens: async () => [
      { object: 'tokens' as const, tokens: 99, characters: 'much-longer'.length },
      { object: 'tokens' as const, tokens: 1, characters: 'short'.length },
    ],
  }, new AbortController().signal, cache), /некорректное количество/);
  assert.deepEqual(coverage(), { knownTokenCount: 0, missingDistinctTextCount: 2, complete: false });

  await assert.rejects(countContextTextTokens(context, {
    countTokens: async (_model, texts) => texts.map((text, index) => ({
      object: 'tokens' as const, tokens: index === 0 ? Number.NaN : 1, characters: [...text].length,
    })),
  }, new AbortController().signal, cache), /некорректное количество/);
  assert.deepEqual(coverage(), { knownTokenCount: 0, missingDistinctTextCount: 2, complete: false });

  const unicodeContext = textCountContext(['🙂']);
  await assert.rejects(countContextTextTokens(unicodeContext, {
    countTokens: async (_model, texts) => texts.map((text) => ({ object: 'tokens' as const, tokens: 1, characters: text.length })),
  }, new AbortController().signal, cache), /некорректное количество/);
  assert.deepEqual(readContextTextTokenCacheCoverage(unicodeContext, cache), {
    knownTokenCount: 0, missingDistinctTextCount: 1, complete: false,
  });
  const unicodeMeasured = await countContextTextTokens(unicodeContext, {
    countTokens: async (_model, texts) => texts.map((text) => ({ object: 'tokens' as const, tokens: 1, characters: [...text].length })),
  }, new AbortController().signal, cache);
  assert.equal(unicodeMeasured.textTokenCount, 1, 'provider character counts use Unicode code points, not UTF-16 units');

  let validCallCount = 0;
  const measured = await countContextTextTokens(context, {
    countTokens: async (_model, texts) => {
      validCallCount++;
      return texts.map((text) => ({ object: 'tokens' as const, tokens: 1, characters: [...text].length }));
    },
  }, new AbortController().signal, cache);
  assert.equal(validCallCount, 1, 'a failed batch leaves both distinct misses uncached');
  assert.equal(measured.textTokenCount, 2);
  assert.deepEqual(coverage(), { knownTokenCount: 2, missingDistinctTextCount: 0, complete: true });
});

test('rejects an aborted count before publishing rows returned afterward', async () => {
  const cache = createContextTextTokenCache();
  const controller = new AbortController();
  let resolveRows!: (rows: Array<{ object: 'tokens'; tokens: number; characters: number }>) => void;
  const pending = countContextTextTokens(textCountContext(['cancelled']), {
    countTokens: async () => new Promise((resolve) => { resolveRows = resolve; }),
  }, controller.signal, cache);
  controller.abort();
  resolveRows([{ object: 'tokens', tokens: 3, characters: 9 }]);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.deepEqual(readContextTextTokenCacheCoverage(textCountContext(['cancelled']), cache), {
    knownTokenCount: 0, missingDistinctTextCount: 1, complete: false,
  });
});

test('rejects overflow before caching a provider result', async () => {
  const cache = createContextTextTokenCache();
  const context = textCountContext(['huge', 'huge']);
  await assert.rejects(countContextTextTokens(context, {
    countTokens: async () => [{ object: 'tokens', tokens: Number.MAX_SAFE_INTEGER, characters: 4 }],
  }, new AbortController().signal, cache), /некорректное количество/);
  assert.deepEqual(readContextTextTokenCacheCoverage(context, cache), {
    knownTokenCount: 0, missingDistinctTextCount: 1, complete: false,
  });
});

test('rejects a changed model or text snapshot instead of publishing stale counts', async () => {
  const cache = createContextTextTokenCache();
  const context = textCountContext(['original']);
  let resolveRows!: (rows: Array<{ object: 'tokens'; tokens: number; characters: number }>) => void;
  const pending = countContextTextTokens(context, {
    countTokens: async () => new Promise((resolve) => { resolveRows = resolve; }),
  }, new AbortController().signal, cache);
  context.textInputs[0] = 'changed';
  context.request.modelId = 'new-model';
  resolveRows([{ object: 'tokens', tokens: 8, characters: 'original'.length }]);
  await assert.rejects(pending, /Контекст изменился/);
  assert.deepEqual(readContextTextTokenCacheCoverage(textCountContext(['original']), cache), {
    knownTokenCount: 0, missingDistinctTextCount: 1, complete: false,
  });
  assert.deepEqual(readContextTextTokenCacheCoverage(textCountContext(['changed'], 'new-model'), cache), {
    knownTokenCount: 0, missingDistinctTextCount: 1, complete: false,
  });
});

test('rejects an in-place nested provider request change before caching an async count', async () => {
  const cache = createContextTextTokenCache();
  const context = textCountContext(['nested-race']);
  const request = context.request;
  const system = context.request.system;
  const textInputs = context.textInputs;
  const modelId = context.request.modelId;
  let resolveRows!: (rows: Array<{ object: 'tokens'; tokens: number; characters: number }>) => void;
  const pending = countContextTextTokens(context, {
    countTokens: async () => new Promise((resolve) => { resolveRows = resolve; }),
  }, new AbortController().signal, cache);
  context.request.system[0]!.text += ' changed while awaiting count';
  assert.strictEqual(context.request, request);
  assert.strictEqual(context.request.system, system);
  assert.strictEqual(context.textInputs, textInputs);
  assert.equal(context.request.modelId, modelId);
  resolveRows([{ object: 'tokens', tokens: 3, characters: 'nested-race'.length }]);

  await assert.rejects(pending, /Контекст изменился/);
  assert.deepEqual(readContextTextTokenCacheCoverage(context, cache), {
    knownTokenCount: 0, missingDistinctTextCount: 1, complete: false,
  });
});

test('evicts cache entries within entry and byte bounds without rejecting context counts', async () => {
  const cache = createContextTextTokenCache();
  const provider = {
    countTokens: async (_model: string, texts: readonly string[]) => texts.map((text) => ({
      object: 'tokens' as const, tokens: 1, characters: [...text].length,
    })),
  };
  const entryTexts = Array.from({ length: 257 }, (_, index) => `entry-${index}`);
  const measured = await countContextTextTokens(textCountContext(entryTexts, 'entry-model'), provider, new AbortController().signal, cache);
  assert.equal(measured.textTokenCount, 257, 'cache limits do not reject a larger history');
  assert.deepEqual(readContextTextTokenCacheCoverage(textCountContext(['entry-0', 'entry-256'], 'entry-model'), cache), {
    knownTokenCount: 1, missingDistinctTextCount: 1, complete: false,
  });

  const byteBoundTexts = Array.from({ length: 100 }, (_, index) => `byte-${index}`);
  const byteBoundModelId = 'm'.repeat(500);
  const byteBoundContext = textCountContext(byteBoundTexts);
  byteBoundContext.request.modelId = byteBoundModelId;
  await countContextTextTokens(byteBoundContext, provider, new AbortController().signal, cache);
  const byteCoverageContext = textCountContext(['byte-0', 'byte-99']);
  byteCoverageContext.request.modelId = byteBoundModelId;
  assert.deepEqual(readContextTextTokenCacheCoverage(byteCoverageContext, cache), {
    knownTokenCount: 1, missingDistinctTextCount: 1, complete: false,
  }, 'larger model keys trigger the byte bound and evict older entries');
});

test('serializes two images and a document in one V2 user message with tools disabled', () => {
  const base = input([{
    ...user('user-attachments', 'Сравни прикреплённые материалы.'),
    attachmentIds: ['local-doc', 'local-image-one', 'local-image-two'],
  }]);
  const request = {
    ...buildNextTurnContext(base).request,
    functionCallMode: 'none' as const,
    attachments: [
      { messageId: 'user-attachments', attachmentId: 'local-doc', fileId: 'remote-doc', name: 'notes.txt', contentType: 'text/plain', kind: 'document', sizeBytes: 5 },
      { messageId: 'user-attachments', attachmentId: 'local-image-one', fileId: 'remote-image-one', name: 'one.png', contentType: 'image/png', kind: 'image', sizeBytes: 4 },
      { messageId: 'user-attachments', attachmentId: 'local-image-two', fileId: 'remote-image-two', name: 'two.jpeg', contentType: 'image/jpeg', kind: 'image', sizeBytes: 6 },
    ],
  } as unknown as import('./contracts').ProviderTurnRequest;
  const frozenLocalIds = [...request.messages[0]!.attachmentIds!];
  const serialized = serializeProviderTurnRequest(request);
  const body = JSON.parse(serialized.body) as {
    messages: Array<{ role: string; content: Array<{ text?: string; files?: Array<{ id: string }> }> }>;
    tools?: unknown[];
    tool_config: { mode: string };
  };
  const userMessages = body.messages.filter((message) => message.role === 'user');

  assert.deepEqual(userMessages, [
    { role: 'user', content: [
      { text: 'Сравни прикреплённые материалы.' },
      { files: [{ id: 'remote-doc' }, { id: 'remote-image-one' }, { id: 'remote-image-two' }] },
    ] },
  ]);
  assert.equal(body.tool_config.mode, 'none');
  assert.equal(body.tools, undefined, 'none mode does not advertise tool schemas');
  assert.equal(userMessages.flatMap((message) => message.content.flatMap((part) => part.files ?? []))
    .filter((file) => file.id.startsWith('remote-image')).length, 2);
  assert.deepEqual(request.messages[0]!.attachmentIds, frozenLocalIds, 'wire file IDs never replace immutable local attachment IDs');

  const oneImage = serializeProviderTurnRequest({
    ...request,
    messages: request.messages.map((message) => ({ ...message, attachmentIds: ['local-doc', 'local-image-one'] })),
    attachments: request.attachments?.slice(0, 2),
  } as unknown as import('./contracts').ProviderTurnRequest);
  const oneImageUser = (JSON.parse(oneImage.body) as typeof body).messages.filter((message) => message.role === 'user');
  assert.deepEqual(oneImageUser, [
    { role: 'user', content: [
      { text: 'Сравни прикреплённые материалы.' },
      { files: [{ id: 'remote-doc' }, { id: 'remote-image-one' }] },
    ] },
  ], 'single-image requests retain their original text and one V2 file-content part');
});

test('adds an app-owned task only for a current empty-text user anchor with accepted files', () => {
  const fileOnly = { ...user('files-only-anchor', ''), attachmentIds: ['local-file'] };
  const context = buildNextTurnContext(input([fileOnly], { globalText: '', projectInstructions: [], selectedSkill: null }));
  const userMessage = context.request.messages[0];
  const taskLayer = context.request.system.find((layer) => layer.label === 'Задача текущего запроса');
  const wire = JSON.parse(serializeProviderTurnRequest(context.request).body) as {
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  };

  assert.equal(userMessage?.text, '', 'the accepted chat history keeps its empty user text');
  assert.deepEqual(userMessage?.attachmentIds, ['local-file']);
  assert.equal(taskLayer?.source, 'runtime');
  assert.equal(taskLayer?.text, 'Проанализируй приложенные файлы');
  assert.deepEqual(wire.messages.find((message) => message.role === 'user')?.content, [{ text: '' }]);

  const ordinary = buildNextTurnContext(input([user('ordinary-empty-anchor', '')], {
    globalText: '', projectInstructions: [], selectedSkill: null,
  }));
  assert.equal(ordinary.request.system.some((layer) => layer.label === 'Задача текущего запроса'), false,
    'an empty text message without attachments does not gain a task');

  const compacting = buildNextTurnContext(input([fileOnly], {
    globalText: '', projectInstructions: [], selectedSkill: null,
    taskInstruction: 'Сверни историю.', usageKind: 'compaction', functionCallMode: 'none',
    compactionToolReceipts: [],
    compactionArtifacts: [{ id: 'local-file', name: 'file.txt', storedName: 'internal', size: 1, createdAt: at, messageId: fileOnly.id }],
  }));
  assert.equal(compacting.request.system.some((layer) => layer.label === 'Задача текущего запроса'), false);
  assert.equal(compacting.request.messages.length, 2);
  assert.equal(compacting.request.messages[compacting.request.messages.length - 1]?.text, 'Сверни историю.');
});

test('rejects unsupported image counts and media aggregate size before network serialization', () => {
  const requestBase = buildNextTurnContext(input([user('too-many-images', 'Проверь')])).request;
  const attachments = (count: number, sizeBytes: number) => Array.from({ length: count }, (_, index) => ({
    messageId: 'too-many-images', attachmentId: `local-image-${index}`, fileId: `remote-image-${index}`,
    name: `${index}.png`, contentType: 'image/png', kind: 'image', sizeBytes,
  }));
  const serializeWith = (items: ReturnType<typeof attachments>) => serializeProviderTurnRequest({
    ...requestBase,
    messages: requestBase.messages.map((message) => ({ ...message, attachmentIds: items.map((attachment) => attachment.attachmentId) })),
    attachments: items,
  } as unknown as import('./contracts').ProviderTurnRequest);

  assert.throws(() => serializeWith(attachments(11, 1)), (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
  assert.ok(serializeWith(attachments(5, 15_000_000)), '75 MB of images is below the documented aggregate ceiling');
  assert.throws(() => serializeWith(attachments(6, 15_000_000)), (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
  const mediaAt = (lastImageBytes: number) => [15_000_000, 15_000_000, 15_000_000, 15_000_000, 15_000_000, lastImageBytes]
    .map((sizeBytes, index) => ({ ...attachments(1, sizeBytes)[0]!, attachmentId: `aggregate-local-${index}`, fileId: `aggregate-${index}` }));
  assert.ok(serializeWith(mediaAt(4_900_000)), '75 MB remains valid with the serialized request overhead');
  assert.throws(() => serializeWith(mediaAt(4_999_999)), (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
  assert.throws(() => serializeWith(mediaAt(5_000_000)), (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
  assert.ok(serializeWith([{ ...attachments(1, 1)[0]!, sizeBytes: 15_000_000 }]), 'the documented 15 MB image boundary is inclusive');
  assert.throws(() => serializeWith([{ ...attachments(1, 1)[0]!, sizeBytes: 15_000_001 }]),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
});

test('counts the serialized request bytes against the media aggregate boundary', () => {
  const requestBase = buildNextTurnContext(input([user('media-with-prompt', 'p'.repeat(1_500_000))])).request;
  const items = [15_000_000, 15_000_000, 15_000_000, 15_000_000, 15_000_000, 3_500_000]
    .map((sizeBytes, index) => ({
      messageId: 'media-with-prompt', attachmentId: `local-${index}`, fileId: `remote-${index}`,
      name: `${index}.png`, contentType: 'image/png', kind: 'image' as const, sizeBytes,
    }));
  const request = {
    ...requestBase,
    messages: requestBase.messages.map((message) => ({ ...message, attachmentIds: items.map((item) => item.attachmentId) })),
    attachments: items,
  } as unknown as import('./contracts').ProviderTurnRequest;

  assert.throws(() => serializeProviderTurnRequest(request),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'context');
});

test('does not apply the image-media aggregate limit to text documents', () => {
  const requestBase = buildNextTurnContext(input([user('many-documents', 'Сравни документы')])).request;
  const items = Array.from({ length: 4 }, (_, index) => ({
    messageId: 'many-documents', attachmentId: `local-doc-${index}`, fileId: `remote-doc-${index}`,
    name: `${index}.txt`, contentType: 'text/plain', kind: 'document' as const, sizeBytes: 25 * 1024 * 1024,
  }));
  const request = {
    ...requestBase,
    messages: requestBase.messages.map((message) => ({ ...message, attachmentIds: items.map((item) => item.attachmentId) })),
    attachments: items,
  } as unknown as import('./contracts').ProviderTurnRequest;

  assert.ok(serializeProviderTurnRequest(request), 'document byte totals remain governed by local/document limits');
});

test('rejects attachment references that are duplicated, orphaned, or bound to an assistant message', () => {
  const validUser = { ...user('bound-user'), attachmentIds: ['local-one'] };
  const request = buildNextTurnContext(input([validUser])).request;
  const reference = { messageId: 'bound-user', attachmentId: 'local-one', fileId: 'remote-one', name: 'one.png', contentType: 'image/png', kind: 'image', sizeBytes: 8 };
  const withAttachments = (messages: ChatMessage[], attachments: unknown[]) => serializeProviderTurnRequest({
    ...request, messages, attachments,
  } as unknown as import('./contracts').ProviderTurnRequest);

  assert.throws(() => withAttachments([validUser], [{ ...reference, messageId: 'missing-user' }]),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  assert.throws(() => withAttachments([assistant('assistant-target', 'answer')], [{ ...reference, messageId: 'assistant-target' }]),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  assert.throws(() => withAttachments([validUser], [reference, reference]),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  assert.throws(() => withAttachments([{ ...validUser, attachmentIds: ['different-id'] }], [reference]),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
  assert.throws(() => withAttachments([validUser, { ...validUser }], [reference]),
    (error: unknown) => error instanceof GigaChatProviderError && error.category === 'protocol');
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

test('compaction reduction compares real repeated-compaction request bodies and rejects equality or growth', () => {
  const messages = [
    user('u1', `Старый вопрос ${'a'.repeat(800)}`), assistant('a1', `Старый ответ ${'b'.repeat(800)}`),
    user('u2', `Ещё один старый вопрос ${'c'.repeat(800)}`),
    assistant('a2', `Ещё один старый ответ ${'d'.repeat(800)}`),
    { ...user('u3', 'Предпоследний вопрос'), attachmentIds: ['recent-file'] }, assistant('a3', 'Предпоследний ответ'),
    user('u4', 'Последний вопрос'), assistant('a4', 'Последний ответ'),
  ];
  const recentProtocol: ProviderProtocolExchange = {
    anchorMessageId: 'u3', name: 'read', arguments: { path: 'recent.txt' }, content: null,
    functionsStateId: 'current-state', result: '{"ok":true,"result":"recent"}',
  };
  const previousSnapshot = snapshot('u1', 'a1', messages);
  previousSnapshot.text = 'Уже сохранённый контекст.';
  const current = buildNextTurnContext(input(messages, { compactSnapshot: previousSnapshot, protocolHistory: [recentProtocol] }));
  const newSnapshot = snapshot('u2', 'a2', messages);
  newSnapshot.text = 'Короткая новая сводка.';
  const buildProposed = (text: string) => {
    const proposedSnapshot = { ...newSnapshot, text };
    return buildNextTurnContext(input(messages, { compactSnapshot: proposedSnapshot, protocolHistory: [recentProtocol] }));
  };
  const shorter = buildProposed(newSnapshot.text);

  assert.ok(current.wireBytes !== null && shorter.wireBytes !== null);
  assert.equal(current.wireBytes, Buffer.byteLength(serializeProviderTurnRequest(current.request).body));
  assert.equal(shorter.wireBytes, Buffer.byteLength(serializeProviderTurnRequest(shorter.request).body));
  assert.ok(shorter.wireBytes < current.wireBytes, 'the next compaction must be measured against the existing snapshot plus recent exchanges');
  assert.deepEqual(
    current.request.messages.filter((message) => message.id === 'u3'),
    shorter.request.messages.filter((message) => message.id === 'u3'),
    'recent attachment-bearing messages remain byte-identical in both comparison inputs',
  );
  assert.deepEqual(current.request.protocolHistory, [recentProtocol]);
  assert.deepEqual(shorter.request.protocolHistory, [recentProtocol], 'recent tool protocol stays in both comparison inputs');
  assert.doesNotThrow(() => assertCompactionWireReduction(current.wireBytes, shorter.wireBytes));

  const padding = current.wireBytes - shorter.wireBytes;
  const equal = buildProposed(`${newSnapshot.text}${'x'.repeat(padding)}`);
  const larger = buildProposed(`${newSnapshot.text}${'x'.repeat(padding + 1)}`);
  assert.equal(equal.wireBytes, current.wireBytes);
  assert.equal(larger.wireBytes, current.wireBytes + 1);
  for (const proposedBytes of [equal.wireBytes, larger.wireBytes, null]) {
    assert.throws(() => assertCompactionWireReduction(current.wireBytes, proposedBytes), (error: unknown) =>
      error instanceof Error && error.message === 'COMPACTION_NO_REDUCTION'
        && 'category' in error && error.category === 'context');
  }
});
