import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ChatMessage, CompactSnapshot, ContextBlockSize, ContextProvenance, InstructionLayer, ProviderProtocolExchange, ProviderTurnRequest } from './contracts';
import { buildInstructionRequest, type InstructionInput } from './instructions';
import { MAX_PROVIDER_REQUEST_BYTES, serializeProviderTurnRequest, type GigaChatProviderConnection } from './gigachat-provider';

export const COMPACTION_TASK_INSTRUCTION = [
  'Составь краткую сводку предыдущего диалога для продолжения работы.',
  'Сохрани текущие задачи, решения, ограничения, открытые вопросы и важные результаты инструментов.',
  'Отделяй подтверждённые факты от предположений. Не добавляй новых фактов и не утверждай, что выполнил действия.',
].join('\n');
export const COMPACTION_UNAVAILABLE_REASON = 'Команда /compact выключена до проверки качества сводки на типовых диалогах. История чата не изменена.';
export const COMPACTION_QUALITY_VERIFIED = false;

const MAX_COMPACT_SUMMARY_BYTES = 32 * 1024;

export interface NextTurnContextInput extends InstructionInput {
  compactSnapshot?: CompactSnapshot | null;
}

export interface NextTurnContext {
  request: ProviderTurnRequest;
  provenance: ContextProvenance;
  textTokenCount: number | null;
  textCountProvenance: ContextProvenance;
  wireBytes: number;
  maxWireBytes: number;
  blocks: ContextBlockSize[];
  textInputs: string[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Контекст содержит значение, которое нельзя сохранить в JSON.');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${entries.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hashCompactionPrefix(
  messages: readonly ChatMessage[],
  protocolHistory: readonly ProviderProtocolExchange[],
): string {
  const canonical = {
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      ...(message.source === undefined ? {} : { source: message.source }),
      ...(message.functionsStateId === undefined ? {} : { functionsStateId: message.functionsStateId }),
    })),
    protocolHistory: protocolHistory.map((exchange) => ({
      anchorMessageId: exchange.anchorMessageId,
      name: exchange.name,
      arguments: exchange.arguments,
      content: exchange.content,
      functionsStateId: exchange.functionsStateId,
      result: exchange.result,
    })),
  };
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex');
}

export function validateCompactSummary(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || byteLength(value) > MAX_COMPACT_SUMMARY_BYTES
    // eslint-disable-next-line no-control-regex -- Reject C0/C1 control characters in the untrusted summary.
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new Error('Сводка должна быть непустым текстом без управляющих символов размером до 32 КиБ.');
  }
  return value.trim();
}

function selectRecentMessages(messages: NextTurnContextInput['messages'], snapshot: CompactSnapshot | null | undefined): {
  messages: ChatMessage[];
  coveredPrefix: null | { messages: ChatMessage[]; coveredAnchors: Set<string> };
} {
  if (!snapshot) return { messages: messages.map((message) => ({ ...message })), coveredPrefix: null };
  validateCompactSummary(snapshot.text);
  const boundaryIndex = messages.findIndex((message) => message.id === snapshot.boundaryMessageId && message.role === 'user');
  if (boundaryIndex < 0) throw new Error('Граница сводки отсутствует в истории чата.');
  const coveredThroughIndex = messages.findIndex((message) => message.id === snapshot.coveredThroughMessageId);
  if (coveredThroughIndex < boundaryIndex) throw new Error('Граница сводки повреждена; контекст не изменён.');
  const coveredMessages = messages.slice(0, coveredThroughIndex + 1).map((message) => ({ ...message }));
  const coveredAnchors = new Set(coveredMessages.filter((message) => message.role === 'user').map((message) => message.id));
  return { messages: messages.slice(coveredThroughIndex + 1), coveredPrefix: { messages: coveredMessages, coveredAnchors } };
}

function sizeBlocks(request: ProviderTurnRequest, functionSchemaBytes: number): ContextBlockSize[] {
  const blocks: ContextBlockSize[] = request.system.map((layer: InstructionLayer) => ({
    source: layer.source,
    label: layer.label,
    utf8Bytes: byteLength(`[${layer.label}]\n${layer.text}`),
  }));
  for (const message of request.messages) {
    blocks.push({ source: 'message', label: `${message.role} · ${message.id}`, utf8Bytes: byteLength(message.text) });
  }
  for (const exchange of request.protocolHistory ?? []) {
    blocks.push({
      source: 'protocol',
      label: `${exchange.name} · ${exchange.anchorMessageId}`,
      utf8Bytes: byteLength(JSON.stringify({ arguments: exchange.arguments, content: exchange.content, result: exchange.result })),
    });
  }
  if (functionSchemaBytes > 0) blocks.push({ source: 'function-schema', label: 'Шесть разрешённых функций', utf8Bytes: functionSchemaBytes });
  return blocks;
}

export function buildNextTurnContext(input: NextTurnContextInput): NextTurnContext {
  const selected = selectRecentMessages(input.messages, input.compactSnapshot);
  let protocolHistory: ProviderProtocolExchange[];
  if (!selected.coveredPrefix) protocolHistory = (input.protocolHistory ?? []).map((exchange) => structuredClone(exchange));
  else {
    const coveredProtocol = (input.protocolHistory ?? []).filter((exchange) => selected.coveredPrefix!.coveredAnchors.has(exchange.anchorMessageId));
    const coveredPrefixHash = hashCompactionPrefix(selected.coveredPrefix.messages, coveredProtocol);
    if (coveredPrefixHash !== input.compactSnapshot?.coveredPrefixHash) {
      throw new Error('История под сводкой изменилась; сжатый контекст не будет применён.');
    }
    protocolHistory = (input.protocolHistory ?? [])
      .filter((exchange) => !selected.coveredPrefix!.coveredAnchors.has(exchange.anchorMessageId))
      .map((exchange) => structuredClone(exchange));
  }
  const request = buildInstructionRequest({
    ...input,
    compactSnapshot: input.compactSnapshot ? { text: input.compactSnapshot.text } : null,
    messages: selected.messages,
    protocolHistory,
  });
  const serialized = serializeProviderTurnRequest(request);
  return {
    request,
    provenance: 'unknown',
    textTokenCount: null,
    textCountProvenance: 'unknown',
    wireBytes: serialized.wireBytes,
    maxWireBytes: MAX_PROVIDER_REQUEST_BYTES,
    blocks: sizeBlocks(request, serialized.functionSchemaBytes),
    textInputs: serialized.textInputs,
  };
}

export async function countContextTextTokens(
  context: NextTurnContext,
  provider: Pick<GigaChatProviderConnection, 'countTokens'>,
  signal: AbortSignal,
): Promise<NextTurnContext> {
  if (!context.request.modelId) throw new Error('Выберите модель перед подсчётом текста контекста.');
  const rows = await provider.countTokens(context.request.modelId, context.textInputs, signal);
  if (rows.length !== context.textInputs.length) throw new Error('Ответ подсчёта текста не совпал с переданными блоками.');
  let total = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.tokens) || row.tokens < 0 || !Number.isSafeInteger(total + row.tokens)) {
      throw new Error('Ответ подсчёта текста содержит некорректное количество токенов.');
    }
    total += row.tokens;
  }
  return { ...context, textTokenCount: total, textCountProvenance: 'verified', provenance: 'unknown' };
}
