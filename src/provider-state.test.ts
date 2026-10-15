import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ChatDetail, ChatMessage, ChatToolReceipt, ProviderProtocolExchange, ProviderTurnRequest } from './contracts';
import { createBalanceScopeGuard } from './usage-view';
import {
  HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE,
  filterProviderStateForOutboundRequest,
  HistoricalProviderStateAttachmentsError,
  assertAuthorizationKeyMatchesOwner,
  assertProviderStateOwner,
  captureProviderStateOwner,
} from './provider-state';

function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && error.message === 'PROVIDER_AUTH'
    && 'category' in error && error.category === 'auth';
}

const fixtureTime = '2026-10-14T09:00:00.000Z';

function stateMessage(id: string, role: 'user' | 'assistant', functionsStateId?: string, attachmentIds?: string[]): ChatMessage {
  return {
    id, role, text: id, createdAt: fixtureTime,
    ...(functionsStateId === undefined ? {} : { functionsStateId }),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
  };
}

function stateReceipt(receiptId: string, anchorMessageId: string, functionsStateId: string): ChatToolReceipt {
  return {
    receiptId, anchorMessageId, name: 'read', arguments: { path: 'fixture.txt' }, content: null,
    functionsStateId, status: 'completed', result: '{"ok":true}', createdAt: fixtureTime,
  };
}

function stateDetail(messages: ChatMessage[], toolReceipts: ChatToolReceipt[] = []): ChatDetail {
  return {
    id: 'chat-state-filter', title: 'State filter fixture', projectId: null, pinned: false, archived: false,
    createdAt: fixtureTime, updatedAt: fixtureTime, kind: 'text', draft: '', nextTurnPermissionProfile: null,
    modelId: 'GigaChat-3-Pro', nextTurnSkillId: null, messages, turns: [], toolReceipts, artifacts: [],
    draftAttachments: [], compactSnapshot: null,
  };
}

function stateRequest(messages: ChatMessage[], protocolHistory: ProviderProtocolExchange[] = []): ProviderTurnRequest {
  return {
    system: [], messages: structuredClone(messages), protocolHistory: structuredClone(protocolHistory),
    permissionProfile: 'ask', modelId: 'GigaChat-3-Pro',
  };
}

test('captures a frozen owner from the exact loaded key without retaining the key', async () => {
  const guard = createBalanceScopeGuard();
  const key = 'synthetic-runtime-key Ω';
  const owner = await captureProviderStateOwner(guard, async () => key);

  assert.deepEqual(owner, {
    accountScope: createHash('sha256').update(key, 'utf8').digest('hex'),
    keyGeneration: 0,
  });
  assert.equal(Object.isFrozen(owner), true);
  assert.equal(JSON.stringify(owner).includes(key), false);
  assertProviderStateOwner(owner, guard);
  assertAuthorizationKeyMatchesOwner(owner, key, guard);
});

test('missing or unreadable keys fail with a fixed authentication error', async () => {
  const guard = createBalanceScopeGuard();
  await assert.rejects(captureProviderStateOwner(guard, async () => null), isAuthFailure);
  await assert.rejects(captureProviderStateOwner(guard, async () => {
    throw new Error('synthetic private-key sentinel');
  }), (error: unknown) => isAuthFailure(error)
    && !String((error as Error).message).includes('synthetic private-key sentinel'));
});

test('a key generation transition during asynchronous capture invalidates the captured request', async () => {
  const guard = createBalanceScopeGuard();
  let resolveKey!: (key: string) => void;
  const pendingKey = new Promise<string>((resolve) => { resolveKey = resolve; });
  const capture = captureProviderStateOwner(guard, () => pendingKey);
  const finishTransition = guard.beginTransition();
  finishTransition();
  resolveKey('synthetic-key-A');

  await assert.rejects(capture, isAuthFailure);
});

test('same-key saves and A-to-B-to-A transitions never revive an old generation', async () => {
  const guard = createBalanceScopeGuard();
  const keyA = 'synthetic-key-A';
  const ownerA = await captureProviderStateOwner(guard, async () => keyA);

  const finishSameKeySave = guard.beginTransition();
  finishSameKeySave();
  assert.throws(() => assertProviderStateOwner(ownerA, guard), isAuthFailure);

  const ownerAfterSameKeySave = await captureProviderStateOwner(guard, async () => keyA);
  const finishKeyB = guard.beginTransition();
  finishKeyB();
  const finishKeyA = guard.beginTransition();
  finishKeyA();
  assert.throws(() => assertProviderStateOwner(ownerAfterSameKeySave, guard), isAuthFailure);
  assertProviderStateOwner(await captureProviderStateOwner(guard, async () => keyA), guard);
});

test('key mismatch and an aborted signal reject before use', async () => {
  const guard = createBalanceScopeGuard();
  const owner = await captureProviderStateOwner(guard, async () => 'synthetic-key-A');
  assert.throws(() => assertAuthorizationKeyMatchesOwner(owner, 'synthetic-key-B', guard), isAuthFailure);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureProviderStateOwner(guard, async () => 'synthetic-key-A', controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.throws(() => assertProviderStateOwner(owner, guard, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
});

test('outbound state survives only exact raw message matches and fully owned receipt groups', () => {
  const rawMessages = [
    stateMessage('anchor-1', 'user'),
    stateMessage('assistant-owned', 'assistant', 'state-A'),
    stateMessage('assistant-unowned', 'assistant', 'state-A'),
    stateMessage('assistant-mismatch', 'assistant', 'state-RAW'),
  ];
  const detail = stateDetail([
    ...rawMessages.slice(0, 2),
    rawMessages[2]!,
    stateMessage('assistant-mismatch', 'assistant', 'state-A'),
  ], [
    stateReceipt('receipt-owned', 'anchor-1', 'receipt-state-owned'),
    stateReceipt('receipt-mixed-one', 'anchor-1', 'receipt-state-mixed'),
    stateReceipt('receipt-mixed-two', 'anchor-1', 'receipt-state-mixed'),
  ]);
  const rawProtocolHistory: ProviderProtocolExchange[] = [
    { anchorMessageId: 'anchor-1', name: 'read', arguments: { path: 'fixture.txt' }, content: null, functionsStateId: 'receipt-state-owned', result: '{"ok":true}' },
    { anchorMessageId: 'anchor-1', name: 'read', arguments: { path: 'fixture.txt' }, content: null, functionsStateId: 'receipt-state-mixed', result: '{"ok":true}' },
  ];
  const ownership = {
    messages: [
      { messageId: 'assistant-owned', owned: true },
      { messageId: 'assistant-unowned', owned: false },
      { messageId: 'assistant-mismatch', owned: true },
    ],
    receipts: [
      { receiptId: 'receipt-owned', anchorMessageId: 'anchor-1', owned: true, wireOwned: false },
      { receiptId: 'receipt-mixed-one', anchorMessageId: 'anchor-1', owned: true, wireOwned: false },
      { receiptId: 'receipt-mixed-two', anchorMessageId: 'anchor-1', owned: false, wireOwned: false },
    ],
    compact: null,
  };
  const request = stateRequest(rawMessages.slice(1), rawProtocolHistory);
  const frozenRaw = structuredClone({ rawMessages, rawProtocolHistory, detail, request });
  const filtered = filterProviderStateForOutboundRequest({
    request, detail, rawMessages, rawProtocolHistory, ownership, currentAnchorMessageId: 'anchor-1',
  });

  assert.notEqual(filtered.request, request);
  assert.equal(filtered.removedState, true);
  assert.deepEqual(filtered.request.messages.map((message) => message.functionsStateId), ['state-A', undefined, undefined]);
  assert.deepEqual(filtered.request.protocolHistory?.map((exchange) => exchange.functionsStateId), ['receipt-state-owned', null]);
  assert.deepEqual({ rawMessages, rawProtocolHistory, detail, request }, frozenRaw,
    'filtering changes only a copied outbound request, not raw history or saved receipts');
});

test('a receipt ID reused across anchors is ambiguous even when both owner bindings say owned', () => {
  const rawMessages = [stateMessage('anchor-one', 'user'), stateMessage('anchor-two', 'user')];
  const rawProtocolHistory: ProviderProtocolExchange[] = [{
    anchorMessageId: 'anchor-one', name: 'read', arguments: { path: 'fixture.txt' }, content: null,
    functionsStateId: 'reused-state', result: '{"ok":true}',
  }];
  const filtered = filterProviderStateForOutboundRequest({
    request: stateRequest(rawMessages, rawProtocolHistory),
    detail: stateDetail(rawMessages, [
      stateReceipt('reused-receipt', 'anchor-one', 'reused-state'),
      stateReceipt('reused-receipt', 'anchor-two', 'reused-state'),
    ]),
    rawMessages,
    rawProtocolHistory,
    ownership: {
      messages: [],
      receipts: [
        { receiptId: 'reused-receipt', anchorMessageId: 'anchor-one', owned: true, wireOwned: false },
        { receiptId: 'reused-receipt', anchorMessageId: 'anchor-two', owned: true, wireOwned: false },
      ],
      compact: null,
    },
    currentAnchorMessageId: 'anchor-two',
  });

  assert.equal(filtered.request.protocolHistory?.[0]?.functionsStateId, null);
  assert.equal(filtered.removedState, true);

  const sameAnchorMessages = [stateMessage('same-anchor', 'user')];
  const sameAnchorProtocol: ProviderProtocolExchange[] = [
    { anchorMessageId: 'same-anchor', name: 'read', arguments: { path: 'one.txt' }, content: null,
      functionsStateId: 'same-anchor-state-one', result: '{"ok":true}' },
    { anchorMessageId: 'same-anchor', name: 'read', arguments: { path: 'two.txt' }, content: null,
      functionsStateId: 'same-anchor-state-two', result: '{"ok":true}' },
  ];
  const sameAnchorFiltered = filterProviderStateForOutboundRequest({
    request: stateRequest(sameAnchorMessages, sameAnchorProtocol),
    detail: stateDetail(sameAnchorMessages, [
      stateReceipt('same-anchor-receipt', 'same-anchor', 'same-anchor-state-one'),
      stateReceipt('same-anchor-receipt', 'same-anchor', 'same-anchor-state-two'),
    ]),
    rawMessages: sameAnchorMessages,
    rawProtocolHistory: sameAnchorProtocol,
    ownership: {
      messages: [],
      receipts: [{ receiptId: 'same-anchor-receipt', anchorMessageId: 'same-anchor', owned: true, wireOwned: false }],
      compact: null,
    },
    currentAnchorMessageId: 'same-anchor',
  });
  assert.deepEqual(sameAnchorFiltered.request.protocolHistory?.map((exchange) => exchange.functionsStateId), [null, null],
    'one owned binding cannot approve two distinct state values for a reused receipt ID');
});

test('a V2 wire and its state pointer are filtered as one ownership unit', () => {
  const stateId = '018f47a2-7b21-7abc-8abc-123456789abc';
  const receiptId = 'f'.repeat(64);
  const anchor = stateMessage('wire-anchor', 'user');
  const receipt = stateReceipt(receiptId, anchor.id, stateId);
  const wire = {
    content: [
      { text: 'Calling a local tool.' },
      { function_call: { id: '550e8400-e29b-41d4-a716-446655440000', name: 'read', arguments: { path: 'fixture.txt' } } },
    ],
    messageId: 'provider-message-1',
    toolStateId: stateId,
  };
  const exchange: ProviderProtocolExchange = {
    receiptId, anchorMessageId: anchor.id, name: 'read', arguments: { path: 'fixture.txt' },
    content: 'Calling a local tool.', functionsStateId: stateId, result: '{"ok":true}', wire,
  };
  const messages = [anchor];
  const filtered = filterProviderStateForOutboundRequest({
    request: stateRequest(messages, [exchange]),
    detail: stateDetail(messages, [receipt]),
    rawMessages: messages,
    rawProtocolHistory: [exchange],
    ownership: {
      messages: [],
      receipts: [{ receiptId, anchorMessageId: anchor.id, owned: false, wireOwned: true }],
      compact: null,
    },
    currentAnchorMessageId: anchor.id,
  });

  const outbound = filtered.request.protocolHistory?.[0];
  assert.equal(filtered.removedState, true);
  assert.equal(outbound?.wire, undefined, 'the wire cannot retain a state pointer whose normalized ownership failed');
  assert.equal(outbound?.receiptId, undefined);
  assert.equal(outbound?.functionsStateId, null);
  assert.equal(receipt.functionsStateId, stateId, 'filtering leaves the saved public receipt untouched');
});

test('unowned state with historical user files fails closed, while current accepted files remain eligible', () => {
  const historical = stateMessage('old-user', 'user', undefined, ['old-file']);
  const assistant = stateMessage('old-assistant', 'assistant', 'old-state');
  const current = stateMessage('current-user', 'user', undefined, ['current-file']);
  const request = stateRequest([assistant, current]);
  const base = {
    request, detail: stateDetail([historical, assistant, current]), rawMessages: [historical, assistant, current],
    rawProtocolHistory: [], ownership: { messages: [{ messageId: assistant.id, owned: false }], receipts: [], compact: null },
  };

  assert.throws(() => filterProviderStateForOutboundRequest({ ...base, currentAnchorMessageId: current.id }),
    (error: unknown) => error instanceof HistoricalProviderStateAttachmentsError
      && error.message === HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE);
  const currentOnly = stateMessage('current-only', 'user', undefined, ['current-file']);
  const filteredCurrent = filterProviderStateForOutboundRequest({
    request: stateRequest([currentOnly]), detail: stateDetail([currentOnly]), rawMessages: [currentOnly],
    rawProtocolHistory: [], ownership: { messages: [], receipts: [], compact: null }, currentAnchorMessageId: currentOnly.id,
  });
  assert.equal(filteredCurrent.removedState, false);
  assert.deepEqual(filteredCurrent.request.messages, [currentOnly]);

  assert.throws(() => filterProviderStateForOutboundRequest({ ...base, currentAnchorMessageId: null }),
    HistoricalProviderStateAttachmentsError, 'compaction has no current attachment exemption');
});

test('strips an unowned legacy assistant state while retaining a newly accepted current file', () => {
  const legacyUser = stateMessage('legacy-plain-user', 'user');
  const legacyAssistant = stateMessage('legacy-plain-assistant', 'assistant', 'legacy-unowned-state');
  const currentUser = stateMessage('new-file-user', 'user', undefined, ['local-current-file']);
  const attachment = {
    messageId: currentUser.id, attachmentId: 'local-current-file', fileId: 'remote-current-file',
    name: 'current.txt', contentType: 'text/plain', kind: 'document' as const, sizeBytes: 9,
  };
  const request = { ...stateRequest([legacyUser, legacyAssistant, currentUser]), attachments: [attachment] };
  const rawMessages = [legacyUser, legacyAssistant, currentUser];
  const filtered = filterProviderStateForOutboundRequest({
    request,
    detail: stateDetail(rawMessages),
    rawMessages,
    rawProtocolHistory: [],
    ownership: { messages: [{ messageId: legacyAssistant.id, owned: false }], receipts: [], compact: null },
    currentAnchorMessageId: currentUser.id,
  });

  assert.equal(filtered.removedState, true);
  assert.equal(Object.prototype.hasOwnProperty.call(filtered.request.messages[1]!, 'functionsStateId'), false);
  assert.deepEqual(filtered.request.messages[2]?.attachmentIds, ['local-current-file']);
  assert.deepEqual(filtered.request.attachments, [attachment]);
});
