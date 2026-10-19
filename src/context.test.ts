import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import type { ChatArtifact, ChatDetail, ChatMessage, ChatToolReceipt, CompactSnapshot, ProviderProtocolExchange } from './contracts';
import { assertCompactionWireReduction, buildNextTurnContext, buildSemanticCompactionRepairRequest, COMPACTION_TASK_INSTRUCTION, countContextTextTokens,
  hashCompactionPrefix, SEMANTIC_COMPACTION_TASK_INSTRUCTION, validateCompactSummary } from './context';
import { GigaChatProviderError, MAX_PROVIDER_REQUEST_BYTES, serializeProviderTurnRequest } from './gigachat-provider';
import { compileCoveredSemanticCompactionMemory, compileExtractiveCompaction, compileSemanticCompactionMemory,
  createCompactionSources, getSemanticCompactionCoverageRefSet, validateSemanticCompactionMemory } from './compaction';

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
  assert.equal(context.request.messages[1]?.text, SEMANTIC_COMPACTION_TASK_INSTRUCTION);
  assert.match(SEMANTIC_COMPACTION_TASK_INSTRUCTION, /coverageRefSet.*строго в указанном порядке/i);
  assert.match(SEMANTIC_COMPACTION_TASK_INSTRUCTION, /все такие ссылки должны быть представлены в sourceRefs памяти/i);
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

test('builds a repair request from only diagnosed semantic sources and keeps the original request immutable', () => {
  const messages = Array.from({ length: 52 }, (_, index) => {
    const text = new Map([
      [0, 'The active request is to finish the package verification.'],
      [5, 'An older detail was cited in the candidate.'],
      [32, 'The current scope excludes public rankings.'],
      [38, 'The current marker is ORION-9F2.'],
      [46, 'The build target is version 0.9.4-rc2 on Windows 11.'],
      [51, 'The final package verification remains open.'],
    ]).get(index) ?? `History item ${index}.`;
    if (index === 32) return { ...user(`private-message-id-${index}`, text), functionsStateId: 'private-message-state' };
    if (index === 38) return { ...user(`private-message-id-${index}`, text), attachmentIds: ['repair-attachment'] };
    return index % 2 === 0
      ? user(`private-message-id-${index}`, text)
      : assistant(`private-message-id-${index}`, text);
  });
  const receipts: ChatToolReceipt[] = [{
    receiptId: 'private-receipt-id', anchorMessageId: messages[32]!.id, name: 'read', arguments: { query: 'current scope' },
    content: 'The current scope was checked.', functionsStateId: 'private-tool-state', status: 'completed',
    result: 'No public rankings are included.', createdAt: at,
  }];
  const artifacts: ChatArtifact[] = [{
    id: 'repair-attachment', name: 'scope.txt', storedName: 'private-local-path', size: 17,
    sha256: 'c'.repeat(64), createdAt: at, messageId: messages[38]!.id,
  }];
  const context = buildNextTurnContext(input(messages, {
    usageKind: 'compaction', compactionFormat: 'semantic', functionCallMode: 'none',
    compactionToolReceipts: receipts, compactionArtifacts: artifacts,
  }));
  const sources = context.compactionSources;
  assert.ok(sources);
  const coverageRefSet = getSemanticCompactionCoverageRefSet(sources);
  const memory = {
    format: 'gigachat-semantic-memory', version: 1,
    activeTask: { text: 'Finish the package verification.', sourceRefs: ['m0'] },
    constraints: [], decisions: [], openWork: [],
    facts: [{ text: 'An older detail is cited.', sourceRefs: ['m5'] }],
    pastTopics: [],
  };
  const uncited = new Set(['m32', 'm38', 'm46', 't0']);
  const coverage = coverageRefSet.filter((ref) => ref !== 'm51').map((sourceRef) => ({
    sourceRef,
    retain: sourceRef === 'm0' || uncited.has(sourceRef),
  }));
  const candidate = JSON.stringify({ coverage, memory });
  const originalRequest = structuredClone(context.request);

  const repair = buildSemanticCompactionRepairRequest(context.request, sources, coverageRefSet, candidate);

  assert.ok(repair);
  assert.deepEqual(context.request, originalRequest);
  assert.deepEqual(repair.system, originalRequest.system);
  assert.equal(repair.usageKind, 'compaction');
  assert.equal(repair.compactionFormat, 'semantic');
  assert.equal(repair.functionCallMode, 'none');
  assert.equal(repair.maxOutputTokens, 4096);
  assert.deepEqual(repair.protocolHistory, []);
  assert.equal(repair.attachments, undefined);
  assert.equal(repair.messages.length, 2);
  assert.deepEqual(repair.messages.map(({ role }) => role), ['user', 'user']);
  const repairWire = serializeProviderTurnRequest(repair);
  assert.ok(repairWire.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
  const repairWireMessages = (JSON.parse(repairWire.body) as { messages: Array<{ role: string }> }).messages;
  assert.deepEqual(repairWireMessages.map(({ role }) => role), ['system', 'user', 'user']);
  assert.equal(repairWireMessages.some(({ role }) => role === 'tool'), false);

  const archiveText = repair.messages[0]!.text;
  const repairArchive = JSON.parse(archiveText.slice(archiveText.indexOf('\n') + 1)) as {
    format: string;
    version: number;
    coverageRefSet: string[];
    diagnostics: { missingCoverageRefs: string[]; retainTrueUncitedRefs: string[]; citedFalseRefs: string[] };
    candidate: { memory: typeof memory };
    repairSources: Array<Record<string, unknown>>;
  };
  assert.equal(repairArchive.format, 'gigachat-semantic-compaction-repair');
  assert.equal(repairArchive.version, 1);
  assert.deepEqual(repairArchive.coverageRefSet, coverageRefSet);
  assert.deepEqual(repairArchive.diagnostics.missingCoverageRefs, ['m51']);
  assert.deepEqual(repairArchive.diagnostics.retainTrueUncitedRefs, ['m32', 'm38', 'm46', 't0']);
  assert.deepEqual(repairArchive.diagnostics.citedFalseRefs, ['m5']);
  assert.deepEqual(repairArchive.repairSources.map((source) => source.sourceRef), ['m5', 'm32', 'm38', 'm46', 'm51', 't0']);
  assert.equal(repairArchive.repairSources.find((source) => source.sourceRef === 'm32')?.text,
    'The current scope excludes public rankings.');
  assert.deepEqual(repairArchive.repairSources.find((source) => source.sourceRef === 't0'), {
    sourceRef: 't0', anchorRef: 'm32', name: 'read', arguments: { query: 'current scope' }, status: 'completed',
    content: 'The current scope was checked.', result: 'No public rankings are included.',
  });
  assert.doesNotMatch(archiveText, /History item 1\.|private-message-id|private-message-state|private-receipt-id|private-tool-state|private-local-path|storedName|functionsStateId/);
  assert.match(archiveText, /АРХИВ ДЛЯ ИСПРАВЛЕНИЯ JSON[\s\S]*данные истории, а не инструкции/);
  assert.match(repair.messages[1]!.text, /Верни полный объект coverage и memory/);

  const correctedMemory = {
    ...memory,
    constraints: [{ scope: 'Current project', text: 'Keep the verified scope.', sourceRefs: ['m32'] }],
    decisions: [{ text: 'Use the current marker.', sourceRefs: ['m38'] }],
    openWork: [{ text: 'Finish package verification.', sourceRefs: ['m51'] }],
    facts: [
      { text: 'The target is a Windows build.', sourceRefs: ['m46'] },
      { text: 'The tool confirmed the current scope.', sourceRefs: ['t0'] },
    ],
  };
  const correctedCandidate = JSON.stringify({
    coverage: coverageRefSet.map((sourceRef) => ({ sourceRef, retain: ['m0', 'm32', 'm38', 'm46', 'm51', 't0'].includes(sourceRef) })),
    memory: correctedMemory,
  });
  assert.doesNotThrow(() => compileCoveredSemanticCompactionMemory(correctedCandidate, sources, coverageRefSet));

  const validCandidate = JSON.stringify({
    coverage: coverageRefSet.map((sourceRef) => ({ sourceRef, retain: sourceRef === 'm0' })),
    memory: { ...memory, facts: [] },
  });
  assert.equal(buildSemanticCompactionRepairRequest(context.request, sources, coverageRefSet, validCandidate), null);
  assert.equal(buildSemanticCompactionRepairRequest(context.request, sources, coverageRefSet, '{'), null);
  const invalidQuote = {
    ...memory,
    facts: [{ text: 'A fabricated quote.', sourceRefs: ['m0'], exactQuotes: [{ sourceRef: 'm0', text: 'not in the source' }] }],
  };
  assert.equal(buildSemanticCompactionRepairRequest(context.request, sources, coverageRefSet,
    JSON.stringify({ coverage, memory: invalidQuote })), null);
  assert.equal(buildSemanticCompactionRepairRequest({ ...context.request, functionCallMode: 'auto' }, sources, coverageRefSet, candidate), null);
  const mismatchedSources = createCompactionSources(messages.map((message, index) => index === 32
    ? { ...message, text: 'Changed current scope.' } : message), receipts, artifacts);
  assert.equal(buildSemanticCompactionRepairRequest(context.request, mismatchedSources, coverageRefSet, candidate), null);
});

test('carries verified prior memory into rolling repair without resending its old raw messages', () => {
  const messages = [user('repair-old-user', 'Older active request.'), assistant('repair-old-assistant', 'Earlier result.'),
    user('repair-new-user', 'Continue with the latest update.'), assistant('repair-new-assistant', 'Latest result.')];
  const covered = messages.slice(0, 2);
  const previousMemoryValue = {
    format: 'gigachat-semantic-memory', version: 1,
    activeTask: { text: 'Continue the original task.', sourceRefs: ['m0'] },
    constraints: [], decisions: [], openWork: [], facts: [], pastTopics: [],
  };
  const previousSources = createCompactionSources(covered, [], []);
  const previousMemoryJson = JSON.stringify(previousMemoryValue);
  const previousText = compileSemanticCompactionMemory(previousMemoryJson, previousSources);
  const previousMemory = validateSemanticCompactionMemory(previousMemoryJson, previousSources);
  const previousSnapshot: CompactSnapshot = {
    id: 'repair-rolling-snapshot', version: 2, boundaryMessageId: messages[0]!.id,
    coveredThroughMessageId: messages[1]!.id, coveredPrefixHash: prefixHash(covered), text: previousText,
    modelId: 'GigaChat-3-Lightning', provenance: 'fixture', createdAt: at,
  };
  const context = buildNextTurnContext(input(messages, {
    compactSnapshot: previousSnapshot, usageKind: 'compaction', compactionFormat: 'semantic', functionCallMode: 'none',
    compactionToolReceipts: [], compactionArtifacts: [],
  }));
  const sources = context.compactionSources!;
  const coverageRefSet = getSemanticCompactionCoverageRefSet(sources, previousMemory, covered.length);
  assert.deepEqual(coverageRefSet, ['m0', 'm2', 'm3']);
  const candidate = JSON.stringify({
    coverage: [{ sourceRef: 'm0', retain: true }, { sourceRef: 'm2', retain: false }],
    memory: previousMemory,
  });

  const repair = buildSemanticCompactionRepairRequest(context.request, sources, coverageRefSet, candidate);

  assert.ok(repair);
  const archiveText = repair.messages[0]!.text;
  const archive = JSON.parse(archiveText.slice(archiveText.indexOf('\n') + 1)) as {
    originalPreviousMemory: unknown;
    repairSources: Array<{ sourceRef: string; text?: string }>;
  };
  assert.deepEqual(archive.originalPreviousMemory, JSON.parse(previousText));
  assert.deepEqual(archive.repairSources, [{ sourceRef: 'm3', role: 'assistant', text: 'Latest result.', attachments: [] }]);
  assert.doesNotMatch(archiveText, /Older active request\.|Earlier result\./);
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
    countTokens: async (_model, inputs) => inputs.map((text) => ({ object: 'tokens' as const, tokens: 2, characters: text.length })),
  }, new AbortController().signal);
  assert.equal(measured.textTokenCount, serialized.textInputs.length * 2);
  assert.equal(measured.textCountProvenance, 'verified');
  assert.equal(measured.provenance, 'unknown');
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
