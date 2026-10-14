import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import type { ChatDetail, ChatMessage, CompactSnapshot, ProviderProtocolExchange } from './contracts';
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
  assert.equal(context.request.system.find((layer) => layer.source === 'summary')?.text, compactSnapshot.text);
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
  const payload = JSON.parse(serialized.body) as { messages: Array<{ content: string }>; functions: unknown[]; function_call: string };
  assert.equal(serialized.wireBytes, Buffer.byteLength(serialized.body, 'utf8'));
  assert.ok(serialized.wireBytes <= MAX_PROVIDER_REQUEST_BYTES);
  assert.equal(payload.functions.length, 7);
  assert.equal(payload.function_call, 'auto');
  assert.equal(serialized.textInputs.length, payload.messages.length);

  const measured = await countContextTextTokens(context, {
    countTokens: async (_model, inputs) => inputs.map((text) => ({ object: 'tokens' as const, tokens: 2, characters: text.length })),
  }, new AbortController().signal);
  assert.equal(measured.textTokenCount, serialized.textInputs.length * 2);
  assert.equal(measured.textCountProvenance, 'verified');
  assert.equal(measured.provenance, 'unknown');
});

test('serializes one image per wire message with documents and get_file_content in the same request', () => {
  const base = input([{
    ...user('user-attachments', 'Сравни прикреплённые материалы.'),
    attachmentIds: ['local-doc', 'local-image-one', 'local-image-two'],
  }]);
  const request = {
    ...buildNextTurnContext(base).request,
    attachments: [
      { messageId: 'user-attachments', attachmentId: 'local-doc', fileId: 'remote-doc', name: 'notes.txt', contentType: 'text/plain', kind: 'document', sizeBytes: 5 },
      { messageId: 'user-attachments', attachmentId: 'local-image-one', fileId: 'remote-image-one', name: 'one.png', contentType: 'image/png', kind: 'image', sizeBytes: 4 },
      { messageId: 'user-attachments', attachmentId: 'local-image-two', fileId: 'remote-image-two', name: 'two.jpeg', contentType: 'image/jpeg', kind: 'image', sizeBytes: 6 },
    ],
  } as unknown as import('./contracts').ProviderTurnRequest;
  const frozenLocalIds = [...request.messages[0]!.attachmentIds!];
  const serialized = serializeProviderTurnRequest(request);
  const body = JSON.parse(serialized.body) as {
    messages: Array<{ role: string; content: string; attachments?: string[] }>;
    functions: Array<{ name: string }>;
    function_call: string;
  };
  const userMessages = body.messages.filter((message) => message.role === 'user');

  assert.deepEqual(userMessages, [
    { role: 'user', content: 'Сравни прикреплённые материалы.\n\nИзображение 1/2', attachments: ['remote-doc', 'remote-image-one'] },
    { role: 'user', content: 'Сравни прикреплённые материалы.\n\nИзображение 2/2', attachments: ['remote-image-two'] },
  ]);
  assert.equal(body.function_call, 'auto');
  assert.ok(body.functions.some((fn) => fn.name === 'get_file_content'));
  assert.equal(userMessages.flatMap((message) => message.attachments ?? []).filter((id) => id.startsWith('remote-image')).length, 2);
  assert.deepEqual(request.messages[0]!.attachmentIds, frozenLocalIds, 'wire file IDs never replace immutable local attachment IDs');

  const oneImage = serializeProviderTurnRequest({
    ...request,
    messages: request.messages.map((message) => ({ ...message, attachmentIds: ['local-doc', 'local-image-one'] })),
    attachments: request.attachments?.slice(0, 2),
  } as unknown as import('./contracts').ProviderTurnRequest);
  const oneImageUser = (JSON.parse(oneImage.body) as typeof body).messages.filter((message) => message.role === 'user');
  assert.deepEqual(oneImageUser, [
    { role: 'user', content: 'Сравни прикреплённые материалы.', attachments: ['remote-doc', 'remote-image-one'] },
  ], 'single-image requests retain their original user text and wire shape');
});

test('adds an app-owned task only for a current empty-text user anchor with accepted files', () => {
  const fileOnly = { ...user('files-only-anchor', ''), attachmentIds: ['local-file'] };
  const context = buildNextTurnContext(input([fileOnly], { globalText: '', projectInstructions: [], selectedSkill: null }));
  const userMessage = context.request.messages[0];
  const taskLayer = context.request.system.find((layer) => layer.label === 'Задача текущего запроса');
  const wire = JSON.parse(serializeProviderTurnRequest(context.request).body) as {
    messages: Array<{ role: string; content: string }>;
  };

  assert.equal(userMessage?.text, '', 'the accepted chat history keeps its empty user text');
  assert.deepEqual(userMessage?.attachmentIds, ['local-file']);
  assert.equal(taskLayer?.source, 'runtime');
  assert.equal(taskLayer?.text, 'Проанализируй приложенные файлы');
  assert.equal(wire.messages.find((message) => message.role === 'user')?.content, '');

  const ordinary = buildNextTurnContext(input([user('ordinary-empty-anchor', '')], {
    globalText: '', projectInstructions: [], selectedSkill: null,
  }));
  assert.equal(ordinary.request.system.some((layer) => layer.label === 'Задача текущего запроса'), false,
    'an empty text message without attachments does not gain a task');

  const compacting = buildNextTurnContext(input([fileOnly], {
    globalText: '', projectInstructions: [], selectedSkill: null,
    taskInstruction: 'Сверни историю.', usageKind: 'compaction', functionCallMode: 'none',
  }));
  assert.equal(compacting.request.system.find((layer) => layer.label === 'Задача текущего запроса')?.text, 'Сверни историю.');
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
