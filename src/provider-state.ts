import { createHash } from 'node:crypto';
import type { ChatDetail, ChatMessage, ProviderProtocolExchange, ProviderTurnRequest } from './contracts';
import type { ProviderStateOwnershipView } from './store';

export const HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE = 'Нельзя подтвердить доступ к прежним вложениям в текущем подключении. Создайте новый чат и прикрепите файлы заново.';

export class HistoricalProviderStateAttachmentsError extends Error {
  constructor() {
    super(HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE);
    this.name = 'HistoricalProviderStateAttachmentsError';
  }
}

export interface ProviderStateOutboundFilterInput {
  request: ProviderTurnRequest;
  detail: ChatDetail;
  rawMessages: readonly ChatMessage[];
  rawProtocolHistory: readonly ProviderProtocolExchange[];
  ownership: ProviderStateOwnershipView;
  currentAnchorMessageId: string | null;
}

export interface ProviderStateOutboundFilterResult {
  request: ProviderTurnRequest;
  removedState: boolean;
}

function stateTupleKey(anchorMessageId: string, functionsStateId: string): string {
  return JSON.stringify([anchorMessageId, functionsStateId]);
}

function receiptTupleKey(receiptId: string, anchorMessageId: string): string {
  return JSON.stringify([receiptId, anchorMessageId]);
}

function uniqueMessageIndex(messages: readonly ChatMessage[]): Map<string, ChatMessage | null> {
  const index = new Map<string, ChatMessage | null>();
  for (const message of messages) index.set(message.id, index.has(message.id) ? null : message);
  return index;
}

function uniqueOwnershipIndex<T extends { owned: boolean }>(
  entries: readonly T[],
  keyFor: (entry: T) => string,
): Map<string, boolean | null> {
  const index = new Map<string, boolean | null>();
  for (const entry of entries) {
    const key = keyFor(entry);
    index.set(key, index.has(key) ? null : entry.owned);
  }
  return index;
}

function ambiguousReceiptIds(entries: readonly { receiptId: string; anchorMessageId: string }[]): Set<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.receiptId)) ambiguous.add(entry.receiptId);
    else seen.add(entry.receiptId);
  }
  return ambiguous;
}

/**
 * Removes opaque state from a request unless its exact raw history value is still
 * present and the main-owned Store confirms the same message or receipt binding.
 */
export function filterProviderStateForOutboundRequest(
  input: ProviderStateOutboundFilterInput,
): ProviderStateOutboundFilterResult {
  const request = structuredClone(input.request);
  const rawMessageIndex = uniqueMessageIndex(input.rawMessages);
  const detailMessageIndex = uniqueMessageIndex(input.detail.messages);
  const ownedMessageIndex = uniqueOwnershipIndex(input.ownership.messages, (entry) => entry.messageId);
  const prefixUserAnchors = new Set(input.rawMessages.filter((message) => message.role === 'user').map((message) => message.id));
  const rawProtocolStates = new Set<string>();
  for (const exchange of input.rawProtocolHistory) {
    if (typeof exchange.functionsStateId === 'string' && exchange.functionsStateId.length > 0) {
      rawProtocolStates.add(stateTupleKey(exchange.anchorMessageId, exchange.functionsStateId));
    }
  }

  const ambiguousRawReceiptIds = ambiguousReceiptIds(input.detail.toolReceipts);
  const ambiguousOwnedReceiptIds = ambiguousReceiptIds(input.ownership.receipts);
  const receiptGroups = new Map<string, Array<{ receiptId: string; anchorMessageId: string }>>();
  for (const receipt of input.detail.toolReceipts) {
    if (receipt.functionsStateId === null || !prefixUserAnchors.has(receipt.anchorMessageId)) continue;
    const key = stateTupleKey(receipt.anchorMessageId, receipt.functionsStateId);
    const group = receiptGroups.get(key) ?? [];
    group.push({ receiptId: receipt.receiptId, anchorMessageId: receipt.anchorMessageId });
    receiptGroups.set(key, group);
  }
  const ownedReceiptIndex = uniqueOwnershipIndex(input.ownership.receipts, (entry) =>
    receiptTupleKey(entry.receiptId, entry.anchorMessageId));
  const ownedReceiptWireIndex = new Map<string, boolean | null>();
  for (const entry of input.ownership.receipts) {
    const key = receiptTupleKey(entry.receiptId, entry.anchorMessageId);
    ownedReceiptWireIndex.set(key, ownedReceiptWireIndex.has(key) ? null : entry.wireOwned);
  }
  const rawProtocolByReceipt = new Map<string, ProviderProtocolExchange[]>();
  for (const exchange of input.rawProtocolHistory) {
    if (!exchange.receiptId || !exchange.wire) continue;
    const key = receiptTupleKey(exchange.receiptId, exchange.anchorMessageId);
    const entries = rawProtocolByReceipt.get(key) ?? [];
    entries.push(exchange);
    rawProtocolByReceipt.set(key, entries);
  }
  const ownedProtocolStates = new Set<string>();
  for (const [key, receipts] of receiptGroups) {
    if (receipts.length > 0 && receipts.every((receipt) =>
      !ambiguousRawReceiptIds.has(receipt.receiptId)
      && !ambiguousOwnedReceiptIds.has(receipt.receiptId)
      &&
      ownedReceiptIndex.get(receiptTupleKey(receipt.receiptId, receipt.anchorMessageId)) === true)) {
      ownedProtocolStates.add(key);
    }
  }

  let removedState = false;
  for (const message of request.messages) {
    if (message.functionsStateId === undefined) continue;
    const raw = rawMessageIndex.get(message.id);
    const detail = detailMessageIndex.get(message.id);
    const stateId = message.functionsStateId;
    const isOwnedExactAssistantState = typeof stateId === 'string' && stateId.length > 0
      && message.role === 'assistant'
      && raw?.role === 'assistant' && raw.functionsStateId === stateId
      && detail?.role === 'assistant' && detail.functionsStateId === stateId
      && ownedMessageIndex.get(message.id) === true;
    if (isOwnedExactAssistantState) continue;
    delete message.functionsStateId;
    removedState = true;
  }

  for (const exchange of request.protocolHistory ?? []) {
    if (exchange.wire) {
      const receiptId = exchange.receiptId;
      const key = receiptId ? receiptTupleKey(receiptId, exchange.anchorMessageId) : null;
      const rawMatches = key ? rawProtocolByReceipt.get(key) : undefined;
      const bindingOwned = key && ownedReceiptWireIndex.get(key) === true;
      const hasExactRawWire = rawMatches?.length === 1 && JSON.stringify(rawMatches[0]?.wire) === JSON.stringify(exchange.wire);
      const matchingReceipts = receiptId === undefined ? [] : input.detail.toolReceipts.filter((receipt) =>
        receipt.receiptId === receiptId && receipt.anchorMessageId === exchange.anchorMessageId);
      const hasMatchingReceipt = matchingReceipts.length === 1 && matchingReceipts[0]?.name === exchange.name
        && JSON.stringify(matchingReceipts[0]?.arguments) === JSON.stringify(exchange.arguments)
        && matchingReceipts[0]?.content === exchange.content
        && matchingReceipts[0]?.functionsStateId === exchange.functionsStateId;
      const wireStateId = exchange.wire.toolStateId ?? null;
      const statePointerMatchesWire = exchange.functionsStateId === wireStateId;
      const stateOwnedWithWire = wireStateId === null || (key !== null
        && !ambiguousRawReceiptIds.has(receiptId ?? '')
        && !ambiguousOwnedReceiptIds.has(receiptId ?? '')
        && ownedReceiptIndex.get(key) === true);
      if (!bindingOwned || !hasExactRawWire || !hasMatchingReceipt || !statePointerMatchesWire || !stateOwnedWithWire) {
        delete exchange.wire;
        delete exchange.receiptId;
        exchange.functionsStateId = null;
        removedState = true;
        continue;
      }
      // The V2 wire and its normalized state pointer form one ownership unit.
      // Do not let the legacy state pass below strip only half of that unit.
      continue;
    }
    if (exchange.functionsStateId === null) continue;
    const stateId = exchange.functionsStateId;
    const key = typeof stateId === 'string' && stateId.length > 0
      ? stateTupleKey(exchange.anchorMessageId, stateId)
      : null;
    if (key && rawProtocolStates.has(key) && ownedProtocolStates.has(key)) continue;
    exchange.functionsStateId = null;
    removedState = true;
  }

  const hasHistoricalUserAttachments = input.rawMessages.some((message) =>
    message.role === 'user'
    && message.id !== input.currentAnchorMessageId
    && Array.isArray(message.attachmentIds)
    && message.attachmentIds.length > 0);
  if (removedState && hasHistoricalUserAttachments) throw new HistoricalProviderStateAttachmentsError();
  return { request, removedState };
}

export interface ProviderStateOwner {
  readonly accountScope: string;
  readonly keyGeneration: number;
}

export interface ProviderStateScopeGuard {
  getGeneration(): number;
  isCurrent(generation: number): boolean;
}

function providerStateAuthError(): Error {
  return Object.assign(new Error('PROVIDER_AUTH'), { category: 'auth' as const });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

function scopeForKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export async function captureProviderStateOwner(
  guard: ProviderStateScopeGuard,
  loadAuthorizationKey: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<ProviderStateOwner> {
  const keyGeneration = guard.getGeneration();
  throwIfAborted(signal);
  if (!guard.isCurrent(keyGeneration)) throw providerStateAuthError();

  let key: string | null;
  try {
    key = await loadAuthorizationKey();
  } catch {
    throwIfAborted(signal);
    throw providerStateAuthError();
  }

  throwIfAborted(signal);
  if (!guard.isCurrent(keyGeneration) || typeof key !== 'string' || key.length === 0) {
    throw providerStateAuthError();
  }
  return Object.freeze({ accountScope: scopeForKey(key), keyGeneration });
}

export function assertProviderStateOwner(
  owner: ProviderStateOwner | undefined,
  guard: ProviderStateScopeGuard,
  signal?: AbortSignal,
): asserts owner is ProviderStateOwner {
  throwIfAborted(signal);
  if (!owner || typeof owner.accountScope !== 'string' || !/^[a-f0-9]{64}$/.test(owner.accountScope)
    || !Number.isSafeInteger(owner.keyGeneration) || owner.keyGeneration < 0
    || !guard.isCurrent(owner.keyGeneration)) {
    throw providerStateAuthError();
  }
}

export function assertAuthorizationKeyMatchesOwner(
  owner: ProviderStateOwner | undefined,
  key: string | null,
  guard: ProviderStateScopeGuard,
  signal?: AbortSignal,
): asserts key is string {
  assertProviderStateOwner(owner, guard, signal);
  if (typeof key !== 'string' || key.length === 0 || scopeForKey(key) !== owner.accountScope) {
    throw providerStateAuthError();
  }
  assertProviderStateOwner(owner, guard, signal);
}
