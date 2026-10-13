import type { ChatToolReceipt, ChatTurnRecord, Project, UsageAggregate, UsageProfileChatRow, UsageProfileDay, UsageProfileView, UsageReceipt } from './contracts';
import { CHAT_MODEL_FAMILIES, modelFamilyForId } from './model-catalog';
import { summarizeUsage } from './usage';

export interface UsageProfileInput {
  generatedAt: string;
  timeZone: string;
  receipts: readonly UsageReceipt[];
  chats: readonly {
    id: string;
    title: string;
    archived: boolean;
    messages: readonly { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; source?: 'runtime' | 'example' }[];
    turns: readonly Pick<ChatTurnRecord, 'invokedSkillId' | 'pendingSkillId' | 'status' | 'startedAt'>[];
    toolReceipts: readonly Pick<ChatToolReceipt, 'name' | 'status'>[];
  }[];
  projects: readonly Pick<Project, 'id'>[];
  installedSkillCount: number | null;
}

const COUNT_FIELDS = ['promptTokens', 'completionTokens', 'totalTokens', 'precachedPromptTokens'] as const;
const DAY_MS = 86_400_000;
const FAMILY_KEYS = CHAT_MODEL_FAMILIES.map((family) => family.family);
const STATUS_RANK = { pending: 0, failed: 1, cancelled: 1, completed: 2 } as const;

function dateParts(value: Date, formatter: Intl.DateTimeFormat): { year: number; month: number; day: number } {
  const parts = formatter.formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(fields.year);
  const month = Number(fields.month);
  const day = Number(fields.day);
  if (![year, month, day].every(Number.isInteger)) throw new Error('Не удалось определить локальную дату.');
  return { year, month, day };
}

function dateKey(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function localDateKey(timestamp: string, formatter: Intl.DateTimeFormat): string | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? dateKey(dateParts(new Date(parsed), formatter)) : null;
}

function ordinal(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / DAY_MS;
}

function fromOrdinal(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

function localWeekStart(date: string): string {
  const weekday = new Date(ordinal(date) * DAY_MS).getUTCDay();
  return fromOrdinal(ordinal(date) - ((weekday + 6) % 7));
}

function previousYearStart(today: string): string {
  const [yearText, monthText, dayText] = today.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const previousYear = year - 1;
  const previousMonthDays = new Date(Date.UTC(previousYear, month, 0)).getUTCDate();
  const previousYearSameDay = Date.UTC(previousYear, month - 1, Math.min(day, previousMonthDays)) / DAY_MS;
  return fromOrdinal(previousYearSameDay + 1);
}

function sameProvenance(left: UsageReceipt, right: UsageReceipt): boolean {
  return left.chatId === right.chatId && left.modelId === right.modelId
    && left.requestKind === right.requestKind && left.createdAt === right.createdAt;
}

function mergeDuplicateRows(rows: readonly UsageReceipt[]): { receipt: UsageReceipt; metadataConflict: boolean } {
  const first = structuredClone(rows[0]!);
  const conflicts = new Set(first.conflictedFields);
  const providerRequestIds = [...new Set(rows.flatMap((row) => row.providerRequestId ? [row.providerRequestId] : []))];
  const providerModels = [...new Set(rows.flatMap((row) => row.providerModel ? [row.providerModel] : []))];
  const terminalStatuses = new Set(rows.map((row) => row.status).filter((status) => status !== 'pending'));
  const metadataConflict = providerRequestIds.length > 1 || providerModels.length > 1 || terminalStatuses.size > 1;
  for (const field of COUNT_FIELDS) {
    const values = rows.map((row) => row[field]).filter((value): value is number => value !== null);
    if (values.some((value, index) => index > 0 && value !== values[0])) conflicts.add(field);
    if (rows.some((row) => row.conflictedFields.includes(field))) conflicts.add(field);
    if (first[field] === null && values.length > 0) first[field] = values[0]!;
  }
  const selectedStatus = rows.reduce((selected, row) => STATUS_RANK[row.status] > STATUS_RANK[selected] ? row.status : selected, first.status);
  return {
    receipt: {
      ...first,
      providerRequestId: providerRequestIds[0] ?? null,
      providerModel: providerModels[0] ?? null,
      status: selectedStatus,
      conflictedFields: COUNT_FIELDS.filter((field) => conflicts.has(field)),
    },
    metadataConflict,
  };
}

function deduplicateReceipts(receipts: readonly UsageReceipt[]): { receipts: UsageReceipt[]; identityConflicts: number; conflictChatIds: Set<string> } {
  let identityConflicts = 0;
  const conflictChatIds = new Set<string>();
  const addConflictChats = (rows: readonly UsageReceipt[]): void => {
    for (const row of rows) conflictChatIds.add(row.chatId);
  };
  const localGroups = new Map<string, UsageReceipt[]>();
  for (const receipt of receipts) {
    const group = localGroups.get(receipt.localRequestId) ?? [];
    group.push(receipt);
    localGroups.set(receipt.localRequestId, group);
  }

  const localUnique: UsageReceipt[] = [];
  for (const group of localGroups.values()) {
    if (group.length === 1) {
      localUnique.push(structuredClone(group[0]!));
      continue;
    }
    if (group.every((row) => sameProvenance(group[0]!, row))) {
      const merged = mergeDuplicateRows(group);
      if (merged.metadataConflict) {
        identityConflicts += 1;
        addConflictChats(group);
      }
      localUnique.push(merged.receipt);
    } else {
      identityConflicts += 1;
      addConflictChats(group);
      localUnique.push(...group.map((row) => structuredClone(row)));
    }
  }

  const byProviderId = new Map<string, UsageReceipt[]>();
  const withoutProviderId: UsageReceipt[] = [];
  for (const receipt of localUnique) {
    if (!receipt.providerRequestId) withoutProviderId.push(receipt);
    else {
      const group = byProviderId.get(receipt.providerRequestId) ?? [];
      group.push(receipt);
      byProviderId.set(receipt.providerRequestId, group);
    }
  }

  const deduplicated = [...withoutProviderId];
  for (const group of byProviderId.values()) {
    if (group.length === 1) {
      deduplicated.push(group[0]!);
      continue;
    }
    if (!group.every((row) => sameProvenance(group[0]!, row))) {
      identityConflicts += 1;
      addConflictChats(group);
      deduplicated.push(...group);
      continue;
    }
    const merged = mergeDuplicateRows(group);
    if (merged.metadataConflict) {
      identityConflicts += 1;
      addConflictChats(group);
    }
    deduplicated.push(merged.receipt);
  }
  return { receipts: deduplicated, identityConflicts, conflictChatIds };
}

function aggregateFor(key: string, receipts: readonly UsageReceipt[]): UsageAggregate {
  const summary = summarizeUsage(receipts);
  return {
    key,
    requestCount: summary.requestCount,
    completedRequestCount: summary.completedRequestCount,
    pendingRequestCount: summary.pendingRequestCount,
    failedRequestCount: summary.failedRequestCount,
    cancelledRequestCount: summary.cancelledRequestCount,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    precachedPromptTokens: summary.precachedPromptTokens,
  };
}

function groupBy<T>(rows: readonly T[], keyFor: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function familyFor(receipt: UsageReceipt): string {
  return modelFamilyForId(receipt.modelId)?.family ?? 'unknown';
}

function familyAggregates(receipts: readonly UsageReceipt[]): UsageAggregate[] {
  const groups = groupBy(receipts, familyFor);
  return [...FAMILY_KEYS, 'unknown'].map((key) => aggregateFor(key, groups.get(key) ?? []));
}

function streakDays(activityDates: readonly string[], today: string): number {
  const active = new Set(activityDates.map(ordinal));
  const todayOrdinal = ordinal(today);
  let cursor = active.has(todayOrdinal) ? todayOrdinal : active.has(todayOrdinal - 1) ? todayOrdinal - 1 : null;
  if (cursor === null) return 0;
  let count = 0;
  while (active.has(cursor)) {
    count += 1;
    cursor -= 1;
  }
  return count;
}

export function buildUsageProfileView(input: UsageProfileInput): UsageProfileView {
  const generatedAtMs = Date.parse(input.generatedAt);
  if (!Number.isFinite(generatedAtMs) || new Date(generatedAtMs).toISOString() !== input.generatedAt) {
    throw new Error('Некорректное время построения сводки usage.');
  }
  if (input.installedSkillCount !== null && (!Number.isSafeInteger(input.installedSkillCount) || input.installedSkillCount < 0)) {
    throw new Error('Некорректное число установленных Skills.');
  }
  const now = new Date(generatedAtMs);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = dateKey(dateParts(now, formatter));
  const { receipts, identityConflicts, conflictChatIds } = deduplicateReceipts(input.receipts);
  const chatById = new Map(input.chats.map((chat) => [chat.id, chat]));
  const receiptsByChat = groupBy(receipts, (receipt) => receipt.chatId);

  const byChat: UsageProfileChatRow[] = input.chats
    .filter((chat) => receiptsByChat.has(chat.id))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .map((chat) => ({
      chatId: chat.id,
      title: chat.title,
      archived: chat.archived,
      aggregate: aggregateFor(chat.id, receiptsByChat.get(chat.id)!),
    }));
  const unlinked = receipts.filter((receipt) => !chatById.has(receipt.chatId));
  if (unlinked.length > 0) {
    byChat.push({ chatId: null, title: 'Удалённые чаты', archived: null, aggregate: aggregateFor('unlinked', unlinked) });
  }

  const chatTokenCandidates = input.chats.flatMap((chat) => {
    const chatReceipts = receiptsByChat.get(chat.id);
    if (!chatReceipts) return [];
    const aggregate = aggregateFor(chat.id, chatReceipts);
    return {
      chatId: chat.id,
      title: chat.title,
      knownTokens: aggregate.totalTokens.knownTokens,
      unknownRequests: aggregate.totalTokens.unknownRequests,
      conflictedRequests: aggregate.totalTokens.conflictedRequests,
      complete: aggregate.totalTokens.unknownRequests === 0 && aggregate.totalTokens.conflictedRequests === 0
        && !conflictChatIds.has(chat.id),
      sortKey: chat.id,
    };
  }).sort((left, right) => right.knownTokens - left.knownTokens || left.sortKey.localeCompare(right.sortKey));
  const maxTokens = chatTokenCandidates[0] ?? null;

  const longest = [...input.chats].sort((left, right) => right.messages.length - left.messages.length || left.id.localeCompare(right.id))[0];
  const longestByMessages = longest ? { chatId: longest.id, title: longest.title, messageCount: longest.messages.length } : null;

  const apiByLocalDate = new Map<string, UsageReceipt[]>();
  for (const receipt of receipts) {
    const timestamp = Date.parse(receipt.createdAt);
    if (!Number.isFinite(timestamp) || timestamp > generatedAtMs) continue;
    const localDay = localDateKey(receipt.createdAt, formatter);
    if (!localDay || localDay > today) continue;
    const group = apiByLocalDate.get(localDay) ?? [];
    group.push(receipt);
    apiByLocalDate.set(localDay, group);
  }
  const activityDateSet = new Set(apiByLocalDate.keys());
  for (const chat of input.chats) {
    for (const message of chat.messages) {
      if (message.role !== 'user' || message.source === 'example') continue;
      const timestamp = Date.parse(message.createdAt);
      if (!Number.isFinite(timestamp) || timestamp > generatedAtMs) continue;
      const localDay = localDateKey(message.createdAt, formatter);
      if (localDay && localDay <= today) activityDateSet.add(localDay);
    }
  }
  const activityDates = [...activityDateSet].sort();
  const week = localWeekStart(today);
  const month = today.slice(0, 7);
  const startDate = previousYearStart(today);
  const startOrdinal = ordinal(startDate);
  const endOrdinal = ordinal(today);
  const rollingDays: UsageProfileDay[] = [];
  for (let day = startOrdinal; day <= endOrdinal; day += 1) {
    const date = fromOrdinal(day);
    const dayReceipts = apiByLocalDate.get(date) ?? [];
    rollingDays.push({ date, aggregate: aggregateFor(date, dayReceipts), byFamily: familyAggregates(dayReceipts) });
  }

  const skillCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const unknownToolCounts = new Map<string, number>();
  let unknownSkillTurns = 0;
  let unknownToolInvocations = 0;
  for (const chat of input.chats) {
    for (const turn of chat.turns) {
      if (turn.invokedSkillId) skillCounts.set(turn.invokedSkillId, (skillCounts.get(turn.invokedSkillId) ?? 0) + 1);
      else if (turn.pendingSkillId) unknownSkillTurns += 1;
      else if (turn.invokedSkillId === undefined && turn.status !== 'queued'
        && !(turn.status === 'cancelled' && turn.startedAt === undefined)) unknownSkillTurns += 1;
    }
    for (const receipt of chat.toolReceipts) {
      if (receipt.status === 'pending') continue;
      if (receipt.status === 'unknown') {
        unknownToolInvocations += 1;
        unknownToolCounts.set(receipt.name, (unknownToolCounts.get(receipt.name) ?? 0) + 1);
      } else toolCounts.set(receipt.name, (toolCounts.get(receipt.name) ?? 0) + 1);
    }
  }
  const allSkillInvocations = [...skillCounts.values()].reduce((total, count) => total + count, 0);
  const allToolInvocations = [...toolCounts.values()].reduce((total, count) => total + count, 0);
  const localAggregate = (key: string, predicate: (date: string) => boolean): UsageAggregate => aggregateFor(
    key,
    [...apiByLocalDate.entries()].filter(([date]) => predicate(date)).flatMap(([, rows]) => rows),
  );

  return {
    generatedAt: input.generatedAt,
    timeZone: input.timeZone,
    total: aggregateFor('all', receipts),
    byFamily: familyAggregates(receipts),
    byModel: summarizeUsage(receipts).byModel,
    byChat,
    providerIdentityConflictCount: identityConflicts,
    localActivity: {
      activityDates,
      activityDayCount: activityDates.length,
      streakDays: streakDays(activityDates, today),
      today: localAggregate(today, (date) => date === today),
      week: localAggregate(week, (date) => date >= week && date <= today),
      month: localAggregate(month, (date) => date.startsWith(`${month}-`) && date <= today),
      rollingYear: { startDate, endDate: today, days: rollingDays },
    },
    chats: {
      count: input.chats.length,
      longestByMessages,
      maxTokens: maxTokens ? {
        chatId: maxTokens.chatId,
        title: maxTokens.title,
        knownTokens: maxTokens.knownTokens,
        unknownRequests: maxTokens.unknownRequests,
        conflictedRequests: maxTokens.conflictedRequests,
        complete: maxTokens.complete,
      } : null,
    },
    projects: { count: input.projects.length },
    skills: {
      installedCount: input.installedSkillCount,
      invocationCount: allSkillInvocations,
      unknownTurnCount: unknownSkillTurns,
      bySkill: [...skillCounts.entries()].map(([skillId, invocationCount]) => ({ skillId, invocationCount }))
        .sort((left, right) => left.skillId.localeCompare(right.skillId)),
    },
    tools: {
      invocationCount: allToolInvocations,
      unknownInvocationCount: unknownToolInvocations,
      byTool: [...new Set([...toolCounts.keys(), ...unknownToolCounts.keys()])].map((tool) => ({
        tool,
        invocationCount: toolCounts.get(tool) ?? 0,
        unknownInvocationCount: unknownToolCounts.get(tool) ?? 0,
      }))
        .sort((left, right) => left.tool.localeCompare(right.tool)),
    },
  };
}
