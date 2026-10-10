import type {
  UsageAggregate,
  UsageCountField,
  UsageLedgerSummary,
  UsageReceipt,
  UsageReceiptStatus,
  UsageRequestKind,
} from './contracts';
import { requireModelId } from './models';

export const MAX_USAGE_RECEIPTS = 100_000;
export const MAX_USAGE_COUNT = 2_147_483_647;

const COUNT_FIELDS: readonly UsageCountField[] = [
  'promptTokens', 'completionTokens', 'totalTokens', 'precachedPromptTokens',
];
const REQUEST_KINDS: readonly UsageRequestKind[] = ['chat', 'tool-continuation', 'compaction'];
const RECEIPT_STATUSES: readonly UsageReceiptStatus[] = ['pending', 'completed', 'failed', 'cancelled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireOptionalProviderValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    // eslint-disable-next-line no-control-regex -- Reject control characters in provider-supplied usage metadata.
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function requireCount(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_USAGE_COUNT) {
    throw new Error('Invalid usage count.');
  }
  return value as number;
}

export function validateUsageReceipt(value: unknown): UsageReceipt {
  if (!isRecord(value)
    || typeof value.localRequestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.localRequestId)
    || typeof value.chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.chatId)
    || typeof value.requestKind !== 'string' || !(REQUEST_KINDS as readonly string[]).includes(value.requestKind)
    || typeof value.modelId !== 'string'
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.status !== 'string' || !(RECEIPT_STATUSES as readonly string[]).includes(value.status)
    || !Array.isArray(value.conflictedFields)
    || value.conflictedFields.some((field) => typeof field !== 'string' || !(COUNT_FIELDS as readonly string[]).includes(field))) {
    throw new Error('Invalid usage receipt.');
  }
  const conflictedFields = value.conflictedFields as UsageCountField[];
  if (new Set(conflictedFields).size !== conflictedFields.length) throw new Error('Duplicate usage conflict field.');
  const modelId = requireModelId(value.modelId);
  const receipt: UsageReceipt = {
    localRequestId: value.localRequestId,
    chatId: value.chatId,
    requestKind: value.requestKind as UsageRequestKind,
    modelId,
    providerRequestId: requireOptionalProviderValue(value.providerRequestId, 'provider request ID'),
    providerModel: requireOptionalProviderValue(value.providerModel, 'provider model'),
    createdAt: value.createdAt,
    status: value.status as UsageReceiptStatus,
    promptTokens: requireCount(value.promptTokens),
    completionTokens: requireCount(value.completionTokens),
    totalTokens: requireCount(value.totalTokens),
    precachedPromptTokens: requireCount(value.precachedPromptTokens),
    conflictedFields: [...conflictedFields],
  };
  if (receipt.conflictedFields.some((field) => receipt[field] === null)) {
    throw new Error('Conflicting usage value is missing.');
  }
  return receipt;
}

export function mergeUsageReceipt(existingValue: UsageReceipt, incomingValue: UsageReceipt): UsageReceipt {
  const existing = validateUsageReceipt(existingValue);
  const incoming = validateUsageReceipt(incomingValue);
  if (existing.localRequestId !== incoming.localRequestId
    || existing.chatId !== incoming.chatId
    || existing.requestKind !== incoming.requestKind
    || existing.modelId !== incoming.modelId
    || existing.createdAt !== incoming.createdAt) {
    throw new Error('Usage request identity changed.');
  }
  for (const field of ['providerRequestId', 'providerModel'] as const) {
    if (existing[field] !== null && incoming[field] !== null && existing[field] !== incoming[field]) {
      throw new Error('Provider usage identity changed.');
    }
  }
  if (existing.status !== 'pending' && incoming.status !== 'pending' && existing.status !== incoming.status) {
    throw new Error('Usage request terminal status changed.');
  }

  const conflictedFields = new Set<UsageCountField>([...existing.conflictedFields, ...incoming.conflictedFields]);
  const merged = { ...existing };
  for (const field of COUNT_FIELDS) {
    const oldValue = existing[field];
    const newValue = incoming[field];
    if (oldValue !== null && newValue !== null && oldValue !== newValue) conflictedFields.add(field);
    if (oldValue === null && newValue !== null && !conflictedFields.has(field)) merged[field] = newValue;
  }
  const nextStatus = existing.status === 'pending' ? incoming.status : existing.status;
  return validateUsageReceipt({
    ...merged,
    providerRequestId: existing.providerRequestId ?? incoming.providerRequestId,
    providerModel: existing.providerModel ?? incoming.providerModel,
    status: nextStatus,
    conflictedFields: COUNT_FIELDS.filter((field) => conflictedFields.has(field)),
  });
}

function createAggregate(key: string, receipts: readonly UsageReceipt[]): UsageAggregate {
  const aggregate: UsageAggregate = {
    key,
    requestCount: receipts.length,
    completedRequestCount: receipts.filter((receipt) => receipt.status === 'completed').length,
    pendingRequestCount: receipts.filter((receipt) => receipt.status === 'pending').length,
    failedRequestCount: receipts.filter((receipt) => receipt.status === 'failed').length,
    cancelledRequestCount: receipts.filter((receipt) => receipt.status === 'cancelled').length,
    promptTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
    completionTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
    totalTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
    precachedPromptTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
  };
  for (const field of COUNT_FIELDS) {
    const summary = aggregate[field];
    for (const receipt of receipts) {
      if (receipt.conflictedFields.includes(field)) summary.conflictedRequests += 1;
      else if (receipt[field] === null) summary.unknownRequests += 1;
      else summary.knownTokens += receipt[field] as number;
    }
  }
  return aggregate;
}

function groupBy(receipts: readonly UsageReceipt[], keyFor: (receipt: UsageReceipt) => string): UsageAggregate[] {
  const groups = new Map<string, UsageReceipt[]>();
  for (const receipt of receipts) {
    const key = keyFor(receipt);
    const rows = groups.get(key) ?? [];
    rows.push(receipt);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => createAggregate(key, rows)).sort((left, right) => left.key.localeCompare(right.key));
}

export function summarizeUsage(receipts: readonly UsageReceipt[]): UsageLedgerSummary {
  const total = createAggregate('all', receipts);
  return {
    ...total,
    byChat: groupBy(receipts, (receipt) => receipt.chatId),
    byModel: groupBy(receipts, (receipt) => receipt.modelId),
    byDay: groupBy(receipts, (receipt) => new Date(receipt.createdAt).toISOString().slice(0, 10)),
  };
}
