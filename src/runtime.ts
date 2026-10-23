import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AcceptedTurnInput,
  ChatToolReceipt,
  GigaChatProvider,
  HookDispatchInput,
  HookRunResult,
  ImageProtocolDiagnostic,
  ProviderFunctionCall,
  ProviderErrorCategory,
  ProviderEvent,
  ProviderProtocolExchange,
  ProviderTurnRequest,
  ProviderToolName,
  ProviderV2FunctionWire,
  RuntimeActivity,
  RuntimeTurnSnapshot,
  CompactSnapshot,
  UsageReceipt,
  UsageReceiptStatus,
} from './contracts';
import { isImageProtocolDiagnostic, PROVIDER_ERROR_CATEGORIES } from './contracts';
import { LocalToolError, type LocalToolEvent, type LocalTools } from './local-tools';
import { HookDispatchAbortError } from './hooks';
import { MAX_USAGE_COUNT, mergeUsageReceipt } from './usage';
import { compileExtractiveCompaction, type CompactionSources } from './compaction';
import { withLiteNormalOutputCap } from './context-budget';
import { MISSING_REMOTE_ATTACHMENT_MESSAGE, MissingRemoteAttachmentError } from './attachments';
import { HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE, HistoricalProviderStateAttachmentsError } from './provider-state';
import type { ProviderStateOwner } from './provider-state';
import { validateProviderV2FunctionWire } from './provider-wire';

const MAX_ACTIVITY_PER_TURN = 50;
const MAX_ASSISTANT_CHARS = 100_000;
const DRAFT_UPDATE_INTERVAL_MS = 50;
const DEFAULT_PREPARE_TIMEOUT_MS = 15_000;
const DEFAULT_NEXT_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_FUNCTION_ROUNDS = 8;
const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_TOTAL_TOOL_RESULT_BYTES = 128 * 1024;
const STOP_TIMEOUT = Symbol('stop-timeout');
const PROVIDER_TOOL_NAMES: readonly ProviderToolName[] = ['list', 'search', 'read', 'write', 'open', 'powershell'];
const RETRYABLE_ERROR_CATEGORIES = new Set<ProviderErrorCategory>([
  'auth', 'tls', 'network', 'rate-limit', 'quota', 'protocol', 'tool', 'storage',
]);

export type ToolReceiptInput = Omit<ChatToolReceipt, 'anchorMessageId' | 'status' | 'result' | 'createdAt'>;
export interface ToolReceiptStart { shouldExecute: boolean; receipt: ChatToolReceipt }

export interface PreparedCompactionContext {
  boundaryMessageId: string;
  coveredThroughMessageId: string;
  coveredPrefixHash: string;
  expectedSnapshotId: string | null;
  provenance: CompactSnapshot['provenance'];
  sources: CompactionSources;
}

export interface PreparedTurn {
  request: ProviderTurnRequest;
  compaction?: PreparedCompactionContext;
  providerStateOwner?: ProviderStateOwner;
  imageGeneration?: AsyncIterable<ProviderEvent>;
}

export interface TurnRuntimeOptions {
  provider?: GigaChatProvider | null;
  tools: LocalTools;
  prepareTurn(turn: AcceptedTurnInput, signal: AbortSignal): Promise<ProviderTurnRequest | PreparedTurn>;
  prepareProviderRequest?(turn: AcceptedTurnInput, request: ProviderTurnRequest, signal: AbortSignal,
    providerStateOwner?: ProviderStateOwner): Promise<ProviderTurnRequest>;
  preflightProviderRequest?(turn: AcceptedTurnInput, request: ProviderTurnRequest, signal: AbortSignal,
    providerStateOwner?: ProviderStateOwner): Promise<void>;
  assertProviderStateOwner?(providerStateOwner: ProviderStateOwner | undefined, signal: AbortSignal): void;
  consumeTurn(turn: AcceptedTurnInput, signal: AbortSignal): Promise<void>;
  releaseTurn(turn: AcceptedTurnInput): void;
  persistTurnRecord?(turn: RuntimeTurnSnapshot): Promise<void>;
  appendAssistant(turn: AcceptedTurnInput, text: string, signal: AbortSignal, functionsStateId: string | undefined,
    terminalTurn: RuntimeTurnSnapshot, providerStateOwner?: ProviderStateOwner, generatedArtifactId?: string): Promise<void>;
  appendCompaction?(turn: AcceptedTurnInput, text: string, signal: AbortSignal, context: PreparedCompactionContext,
    terminalTurn: RuntimeTurnSnapshot, functionsStateId?: string, providerStateOwner?: ProviderStateOwner): Promise<void>;
  compactionEnabled?: boolean;
  recordUsageReceipt(receipt: UsageReceipt): Promise<void>;
  beginToolReceipt?(turn: AcceptedTurnInput, receipt: ToolReceiptInput, providerStateOwner?: ProviderStateOwner,
    wire?: ProviderV2FunctionWire): Promise<ToolReceiptStart>;
  completeToolReceipt?(turn: AcceptedTurnInput, receiptId: string, status: 'completed' | 'unknown', result: string): Promise<void>;
  runHooks?(turn: AcceptedTurnInput, input: HookDispatchInput, signal: AbortSignal): Promise<HookRunResult[]>;
  validateRetry?(turn: AcceptedTurnInput, original: AcceptedTurnInput): Promise<void>;
  timeouts?: { prepareMs?: number; nextMs?: number; stopMs?: number; operationMs?: number; toolMs?: number; turnMs?: number };
  onUpdate?(turn: RuntimeTurnSnapshot): void;
}

export interface TurnRuntime {
  readonly tools: LocalTools;
  enqueue(turn: unknown): string | null;
  enqueueCompaction(turn: unknown): string | null;
  list(chatId?: unknown): RuntimeTurnSnapshot[];
  cancel(turnId: unknown, chatId?: unknown): boolean;
  retry(turnId: unknown, chatId?: unknown): Promise<string | null>;
  cancelAll(): Promise<void>;
  whenIdle(): Promise<void>;
  onUpdate(listener: (turn: RuntimeTurnSnapshot) => void): () => void;
  recordToolEvent(event: LocalToolEvent): void;
  recordHookResult(result: HookRunResult): void;
}

export async function queueAcceptedTurnOrMarkNotSent<T>(input: {
  shouldQueue: boolean;
  enqueue(): string | null;
  markNotSent(): Promise<T>;
  releaseReservation(): void;
}): Promise<{ queued: true } | { queued: false; persisted: T }> {
  if (input.shouldQueue) {
    try {
      if (input.enqueue() !== null) return { queued: true };
    } catch {
      // Persist the accepted message as unsent; provider errors are deliberately not stored here.
    }
  }
  try {
    return { queued: false, persisted: await input.markNotSent() };
  } finally {
    input.releaseReservation();
  }
}

interface RuntimeTurn extends RuntimeTurnSnapshot {
  input: AcceptedTurnInput;
  controller?: AbortController;
  cancelRequested: boolean;
  persistTail: Promise<void>;
  persistError?: unknown;
  pendingTerminal?: RuntimeTurnSnapshot;
}

interface StopState {
  streamConfirmed: boolean;
  streamStop: Promise<boolean> | null;
  pendingToolIds: Set<string>;
  waiters: Set<() => void>;
  pendingOperationCount: number;
  pendingOutcome: { status: 'completed' | 'failed' | 'cancelled'; error?: string; errorCategory?: ProviderErrorCategory; imageProtocolDiagnostic?: ImageProtocolDiagnostic } | null;
  terminalRecordSaved?: boolean;
}

interface IdleWaiter {
  resolve(): void;
  reject(error: Error): void;
}

function requireChatId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Некорректный идентификатор чата для локального runtime.');
  }
  return value;
}

function copyTurn(turn: RuntimeTurn): RuntimeTurnSnapshot {
  return {
    id: turn.id,
    chatId: turn.chatId,
    anchorMessageId: turn.input.messageId,
    assistantMessageId: turn.input.assistantMessageId,
    ...(turn.input.operation ? { operation: turn.input.operation } : {}),
    modelId: turn.input.modelId,
    pendingSkillId: turn.pendingSkillId ?? null,
    invokedSkillId: turn.invokedSkillId ?? null,
    status: turn.status,
    createdAt: turn.createdAt,
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    ...(turn.queueDurationMs === undefined ? {} : { queueDurationMs: turn.queueDurationMs }),
    ...(turn.activeDurationMs === undefined ? {} : { activeDurationMs: turn.activeDurationMs }),
    activity: structuredClone(turn.activity),
    ...(turn.draft === undefined ? {} : { draft: turn.draft }),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.errorCategory ? { errorCategory: turn.errorCategory } : {}),
    ...(turn.status === 'failed' && turn.errorCategory === 'protocol' && isImageProtocolDiagnostic(turn.imageProtocolDiagnostic)
      ? { imageProtocolDiagnostic: turn.imageProtocolDiagnostic } : {}),
    ...(turn.retryEligible ? { retryEligible: true } : {}),
  };
}

function isProviderErrorCategory(value: unknown): value is ProviderErrorCategory {
  return typeof value === 'string' && (PROVIDER_ERROR_CATEGORIES as readonly string[]).includes(value);
}

function runtimeErrorCategory(error: unknown, turnTimedOut = false): ProviderErrorCategory | undefined {
  if (turnTimedOut) return undefined;
  if (typeof error === 'object' && error !== null && 'category' in error && isProviderErrorCategory(error.category)) {
    return error.category;
  }
  if (!(error instanceof Error)) return undefined;
  switch (error.message) {
    case 'MODEL_NOT_SELECTED': return 'model';
    case 'PROMPT_PREFLIGHT_TIMEOUT': return 'context';
    case 'TURN_PREPARE_TIMEOUT':
    case 'COMPACTION_CONTEXT_UNAVAILABLE':
    case 'COMPACTION_CANDIDATE_REJECTED':
    case 'COMPACTION_NO_REDUCTION':
    case 'UNEXPECTED_COMPACTION_FUNCTION':
    case 'RESPONSE_LIMIT': return 'context';
    case 'PROVIDER_STEP_TIMEOUT':
    case 'ATTACHMENT_PREPARE_TIMEOUT':
    case 'PROVIDER_UNAVAILABLE': return 'network';
    case 'PROVIDER_PROTOCOL':
    case 'BAD_PROVIDER_EVENT':
    case 'INCOMPLETE_PROVIDER_RESPONSE': return 'protocol';
    case 'TURN_CONSUME_TIMEOUT':
    case 'TOOL_INTENT_SAVE_TIMEOUT':
    case 'TURN_RECORD_SAVE_TIMEOUT':
    case 'TURN_RECORD_SAVE_FAILED':
    case 'USAGE_RECEIPT_SAVE_TIMEOUT':
    case 'USAGE_RECEIPT_SAVE_FAILED':
    case 'USAGE_RECEIPT_WRITE_FAILED':
    case 'COMPACTION_SAVE_UNAVAILABLE': return 'storage';
    case 'TOOL_STOP_STATE':
    case 'TOOL_ROUND_LIMIT':
    case 'TOOL_RESULT_LIMIT':
    case 'LOCAL_TOOL_TIMEOUT':
    case 'TOOL_RECEIPT_STORE_UNAVAILABLE': return 'tool';
    default: return undefined;
  }
}

function compileCompactionCandidate(value: string, sources: CompactionSources): string {
  try { return compileExtractiveCompaction(value, sources); }
  catch {
    throw Object.assign(new Error('COMPACTION_CANDIDATE_REJECTED'), { category: 'context' as const });
  }
}

function imageProtocolDiagnosticFromError(error: unknown): ImageProtocolDiagnostic | undefined {
  if (typeof error !== 'object' || error === null || !('category' in error) || error.category !== 'protocol'
    || !('imageProtocolDiagnostic' in error)) return undefined;
  return isImageProtocolDiagnostic(error.imageProtocolDiagnostic) ? error.imageProtocolDiagnostic : undefined;
}

function isProviderToolName(value: string): value is ProviderToolName {
  return (PROVIDER_TOOL_NAMES as readonly string[]).includes(value);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'ABORT_ERR');
}

function abortError(): Error {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

function requireAcceptedTurn(value: unknown): AcceptedTurnInput {
  if (typeof value !== 'object' || value === null) throw new Error('Некорректный принятый ход.');
  const turn = value as Partial<AcceptedTurnInput>;
  const turnId = requireChatId(turn.turnId);
  const chatId = requireChatId(turn.chatId);
  if (!Array.isArray(turn.messages) || !Number.isSafeInteger(turn.historyBoundary)
    || turn.historyBoundary !== turn.messages.length || typeof turn.messageId !== 'string'
    || !turn.messages.some((message) => message.id === turn.messageId && message.role === 'user')
    || (turn.projectId !== null && typeof turn.projectId !== 'string')
    || (turn.projectWorkingFolder !== null && typeof turn.projectWorkingFolder !== 'string')
    || (turn.operation !== undefined && turn.operation !== 'compaction')
    || (turn.operation === 'compaction' ? turn.assistantMessageId !== null : typeof turn.assistantMessageId !== 'string')
    || (turn.operation === 'compaction' && (typeof turn.compactBoundaryMessageId !== 'string'
      || turn.compactBoundaryMessageId !== turn.messageId
      || !(turn.compactExpectedSnapshotId === null || typeof turn.compactExpectedSnapshotId === 'string')))
    || (turn.operation !== 'compaction' && (turn.compactBoundaryMessageId !== undefined || turn.compactExpectedSnapshotId !== undefined))
    || !turn.reservation || typeof turn.reservation !== 'object') {
    throw new Error('Некорректный снимок принятого хода.');
  }
  return structuredClone({ ...turn, turnId, chatId } as AcceptedTurnInput);
}

function assertProviderEvent(value: unknown): asserts value is ProviderEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('BAD_PROVIDER_EVENT');
  const event = value as Record<string, unknown>;
  if (event.type === 'activity') {
    if (!['connecting', 'receiving', 'waiting-for-tool', 'tool-started', 'tool-finished', 'function-progress'].includes(String(event.activity))) {
      throw new Error('BAD_PROVIDER_EVENT');
    }
    if (event.tool !== undefined && !['list', 'search', 'read', 'write', 'open', 'powershell'].includes(String(event.tool))) {
      throw new Error('BAD_PROVIDER_EVENT');
    }
    if (event.activity === 'function-progress') {
      if ((event.functionName !== 'get_file_content' && event.functionName !== 'text2image')
        || typeof event.detail !== 'string' || event.detail.length > 1000
        // eslint-disable-next-line no-control-regex -- Provider progress text is untrusted display metadata.
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(event.detail)) throw new Error('BAD_PROVIDER_EVENT');
    } else if (event.functionName !== undefined || event.detail !== undefined) {
      throw new Error('BAD_PROVIDER_EVENT');
    }
    return;
  }
  if (event.type === 'text-delta' && typeof event.text === 'string') return;
  if (event.type === 'image-result' && typeof event.artifactId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(event.artifactId)) return;
  if (event.type === 'usage'
    && ['promptTokens', 'completionTokens', 'totalTokens', 'precachedPromptTokens'].every((field) => {
      const count = event[field];
      return count === null || typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= MAX_USAGE_COUNT;
    })
    && (event.providerRequestId === undefined || typeof event.providerRequestId === 'string'
      && event.providerRequestId.length > 0 && event.providerRequestId.length <= 512
      // eslint-disable-next-line no-control-regex -- Reject control characters in provider request IDs.
      && !/[\u0000-\u001f\u007f]/.test(event.providerRequestId))
    && (event.providerModel === undefined || typeof event.providerModel === 'string'
      && event.providerModel.length > 0 && event.providerModel.length <= 512
      // eslint-disable-next-line no-control-regex -- Reject control characters in provider model metadata.
      && !/[\u0000-\u001f\u007f]/.test(event.providerModel))) return;
  if (event.type === 'completed' && (event.functionsStateId === undefined
    || typeof event.functionsStateId === 'string' && event.functionsStateId.length > 0 && event.functionsStateId.length <= 4096)) return;
  if (event.type === 'function-call' && isFunctionCall(event.functionCall)) return;
  if (event.type === 'error' && isProviderErrorCategory(event.category) && typeof event.retryable === 'boolean') return;
  throw new Error('BAD_PROVIDER_EVENT');
}

function isFunctionCall(value: unknown): value is ProviderFunctionCall {
  if (typeof value !== 'object' || value === null || !('name' in value) || !('arguments' in value)) return false;
  const call = value as Partial<ProviderFunctionCall>;
  if (typeof call.name !== 'string' || !call.name || call.name.length > 128
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted function names.
    || /[\u0000-\u001f\u007f]/.test(call.name)
    || typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)
    || (call.content !== null && typeof call.content !== 'string')
    || (call.functionsStateId !== null && typeof call.functionsStateId !== 'string')
    || call.terminalReason !== 'function_call') return false;
  try {
    if (Buffer.byteLength(JSON.stringify(call.arguments), 'utf8') > 1_900_000) return false;
    return call.wire === undefined || validateProviderV2FunctionWire(call.wire, {
      name: call.name,
      arguments: call.arguments,
      content: call.content,
      functionsStateId: call.functionsStateId,
    }) !== null;
  }
  catch { return false; }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function isExternalEffect(name: string): boolean {
  return name === 'write' || name === 'powershell' || name === 'open';
}

function receiptIdFor(turn: AcceptedTurnInput, call: ProviderFunctionCall, round: number): string {
  const identity = call.functionsStateId ?? `${turn.turnId}:${round}`;
  return createHash('sha256').update(stableJson([identity, call.name, call.arguments]), 'utf8').digest('hex');
}

function effectIdFor(turn: AcceptedTurnInput, call: ProviderFunctionCall): string | undefined {
  if (!isExternalEffect(call.name)) return undefined;
  return createHash('sha256').update(stableJson([turn.messageId, call.name, call.arguments]), 'utf8').digest('hex');
}

function objectResult(value: unknown): string {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : { ok: true, result: value };
  let encoded: string;
  try { encoded = JSON.stringify(record); }
  catch { encoded = JSON.stringify({ ok: false, error: 'invalid_tool_result', message: 'Инструмент вернул неподдерживаемый результат.' }); }
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_TOOL_RESULT_BYTES) return encoded;
  return JSON.stringify({ ok: false, error: 'result_limit', message: 'Результат инструмента слишком велик для безопасного продолжения.' });
}

function errorResult(error: unknown, unknownSideEffect = false): string {
  if (unknownSideEffect) return JSON.stringify({
    ok: false, status: 'unknown', error: 'effect_unknown',
    message: 'Выполнение было прервано или завершилось неоднозначно; проверьте состояние перед повтором.',
  });
  const message = error instanceof Error ? error.message.slice(0, 1000) : 'Локальный инструмент завершился ошибкой.';
  return objectResult({ ok: false, error: error instanceof LocalToolError && error.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'tool_error', message });
}

type ValidatedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; message: string };

function validateToolArguments(call: ProviderFunctionCall): ValidatedToolArguments {
  const args = call.arguments;
  const allowed: Record<ProviderToolName, readonly string[]> = {
    list: ['path'], search: ['query', 'path'], read: ['path'], write: ['path', 'contents'], open: ['path'],
    powershell: ['script', 'external_access'],
  };
  if (!isProviderToolName(call.name)) return { ok: false, error: 'unknown_function', message: 'Эта функция недоступна в текущем приложении.' };
  const keys = allowed[call.name];
  if (Object.getPrototypeOf(args) !== Object.prototype || Object.keys(args).some((key) => !keys.includes(key))) {
    return { ok: false, error: 'invalid_arguments', message: 'Аргументы функции не соответствуют поддерживаемой схеме.' };
  }
  const requireString = (key: string, required: boolean, maxLength: number, allowEmpty = false): string | null => {
    const value = args[key];
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength || value.includes('\0')) {
      throw new Error(`Аргумент ${key} имеет неверный тип или превышает лимит.`);
    }
    return value;
  };
  try {
    if (call.name === 'list') requireString('path', false, 2048, true);
    else if (call.name === 'search') requireString('query', true, 256);
    else if (call.name === 'read') requireString('path', true, 2048);
    else if (call.name === 'write') {
      requireString('path', true, 2048);
      const contents = requireString('contents', true, 1_048_576, true) ?? '';
      if (Buffer.byteLength(contents, 'utf8') > 1024 * 1024) throw new Error('Содержимое записи превышает лимит 1 МиБ в UTF-8.');
    } else if (call.name === 'open') requireString('path', false, 2048, true);
    else if (call.name === 'powershell') {
      requireString('script', true, 16 * 1024);
      if (args.external_access !== undefined && typeof args.external_access !== 'boolean') throw new Error('Аргумент external_access должен быть логическим.');
    }
  } catch (error) {
    return { ok: false, error: 'invalid_arguments', message: error instanceof Error ? error.message : 'Аргументы функции некорректны.' };
  }
  return { ok: true, args };
}

function settle(promise: Promise<unknown>): Promise<void> {
  return promise.then(() => undefined, () => undefined);
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof STOP_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(STOP_TIMEOUT), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutError: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
  });
  try { return await Promise.race([promise, abort, timeout]); }
  finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createTurnRuntime(options: TurnRuntimeOptions): TurnRuntime {
  const turns = new Map<string, RuntimeTurn>();
  const queue: RuntimeTurn[] = [];
  const listeners = new Set<(turn: RuntimeTurnSnapshot) => void>();
  const stopStates = new Map<string, StopState>();
  const toolOwners = new Map<string, string>();
  const latestTurnByAnchor = new Map<string, string>();
  const retryingAnchors = new Set<string>();
  const pendingPersistenceWaiters = new Set<() => void>();
  let activeTurn: RuntimeTurn | null = null;
  let draining = false;
  let blockedTurnId: string | null = null;
  let pendingPersistenceCount = 0;
  const idleWaiters: IdleWaiter[] = [];
  const prepareTimeoutMs = options.timeouts?.prepareMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
  const nextTimeoutMs = options.timeouts?.nextMs ?? DEFAULT_NEXT_TIMEOUT_MS;
  const stopTimeoutMs = options.timeouts?.stopMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const operationTimeoutMs = options.timeouts?.operationMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const toolTimeoutMs = options.timeouts?.toolMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const turnTimeoutMs = options.timeouts?.turnMs ?? DEFAULT_TURN_TIMEOUT_MS;

  const publish = (turn: RuntimeTurn): void => {
    const snapshot = copyTurn(turn);
    try { options.onUpdate?.(snapshot); } catch { /* Runtime state must survive observer failures. */ }
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* Runtime state must survive observer failures. */ }
    }
  };

  const scheduleTurnRecord = (turn: RuntimeTurn, snapshotInput?: RuntimeTurnSnapshot): Promise<void> => {
    if (!options.persistTurnRecord) return Promise.resolve();
    const snapshot = snapshotInput ? structuredClone(snapshotInput) : copyTurn(turn);
    const writing = turn.persistTail.then(async () => {
      if (turn.persistError !== undefined) throw turn.persistError;
      try { await options.persistTurnRecord!(snapshot); }
      catch (error) { throw Object.assign(new Error('TURN_RECORD_SAVE_FAILED'), { category: 'storage' as const, cause: error }); }
    });
    turn.persistTail = writing.catch((error: unknown) => { turn.persistError ??= error; });
    pendingPersistenceCount += 1;
    void writing.then(() => undefined, () => undefined).then(() => {
      pendingPersistenceCount -= 1;
      if (pendingPersistenceCount === 0) {
        for (const resolve of pendingPersistenceWaiters) resolve();
        pendingPersistenceWaiters.clear();
      }
      finishIdleWaiters();
    });
    return writing;
  };

  const waitForPendingPersistence = (): Promise<void> => pendingPersistenceCount === 0
    ? Promise.resolve()
    : new Promise((resolve) => pendingPersistenceWaiters.add(resolve));

  const anchorKey = (turn: AcceptedTurnInput): string => `${turn.chatId}\0${turn.messageId}`;
  const canRetry = (turn: RuntimeTurn, ignoreRetryLock = false): boolean => {
    const eligibleOutcome = turn.status === 'cancelled'
      || turn.status === 'failed' && Boolean(turn.errorCategory && RETRYABLE_ERROR_CATEGORIES.has(turn.errorCategory));
    const key = anchorKey(turn.input);
    return eligibleOutcome && !turn.input.operation
      && latestTurnByAnchor.get(key) === turn.id
      && !stopStates.has(turn.id)
      && blockedTurnId === null
      && (ignoreRetryLock || !retryingAnchors.has(key));
  };
  const updateRetryEligibility = (turn: RuntimeTurn): void => {
    const eligible = canRetry(turn);
    if (Boolean(turn.retryEligible) === eligible) return;
    if (eligible) turn.retryEligible = true;
    else delete turn.retryEligible;
    publish(turn);
  };
  const refreshRetryEligibility = (): void => {
    for (const turn of turns.values()) updateRetryEligibility(turn);
  };

  const addActivity = (turn: RuntimeTurn, activity: RuntimeActivity, persistAs?: RuntimeTurnSnapshot): void => {
    if (turn.activity.length >= MAX_ACTIVITY_PER_TURN) turn.activity.shift();
    turn.activity.push(activity);
    const snapshot = persistAs
      ? { ...structuredClone(persistAs), activity: structuredClone(turn.activity) }
      : undefined;
    void scheduleTurnRecord(turn, snapshot).catch(() => undefined);
    publish(turn);
  };

  const stopConfirmed = (state: StopState): boolean => state.streamConfirmed && state.pendingToolIds.size === 0;
  const notifyStopWaiters = (state: StopState): void => {
    if (!stopConfirmed(state)) return;
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  };
  const maybeUnblock = (turnId: string): void => {
    const state = stopStates.get(turnId);
    if (!state || !stopConfirmed(state) || state.pendingOperationCount > 0) return;
    if (blockedTurnId !== turnId) return;
    const turn = turns.get(turnId);
    if (turn && state.pendingOutcome) {
      turn.status = state.pendingOutcome.status;
      turn.endedAt = turn.pendingTerminal?.endedAt ?? new Date().toISOString();
      if (turn.pendingTerminal?.activeDurationMs !== undefined) turn.activeDurationMs = turn.pendingTerminal.activeDurationMs;
      else if (turn.startedAt) turn.activeDurationMs = Math.max(0, Date.now() - Date.parse(turn.startedAt));
      if (state.pendingOutcome.status === 'completed') delete turn.draft;
      if (state.pendingOutcome.error) turn.error = state.pendingOutcome.error;
      else delete turn.error;
      if (state.pendingOutcome.errorCategory) turn.errorCategory = state.pendingOutcome.errorCategory;
      else if (state.pendingOutcome.status === 'cancelled') turn.errorCategory = 'cancel';
      else delete turn.errorCategory;
      if (state.pendingOutcome.status === 'failed' && turn.errorCategory === 'protocol'
        && isImageProtocolDiagnostic(state.pendingOutcome.imageProtocolDiagnostic)) {
        turn.imageProtocolDiagnostic = state.pendingOutcome.imageProtocolDiagnostic;
      } else delete turn.imageProtocolDiagnostic;
      turn.controller = undefined;
      if (state.pendingOutcome.status === 'completed' && turn.pendingTerminal) {
        turn.endedAt = turn.pendingTerminal.endedAt;
        turn.activeDurationMs = turn.pendingTerminal.activeDurationMs;
        delete turn.error;
        delete turn.errorCategory;
        delete turn.imageProtocolDiagnostic;
      }
      delete turn.pendingTerminal;
      publish(turn);
      if (state.pendingOutcome.status !== 'completed' && options.persistTurnRecord && !state.terminalRecordSaved) {
        state.pendingOperationCount += 1;
        const savingTerminal = scheduleTurnRecord(turn);
        void savingTerminal.then(() => {
          state.terminalRecordSaved = true;
          state.pendingOperationCount -= 1;
          maybeUnblock(turnId);
        }, () => {
          state.pendingOperationCount -= 1;
          blockedTurnId = turnId;
          turn.errorCategory = 'storage';
          delete turn.imageProtocolDiagnostic;
          turn.error = 'Состояние остановленного хода не сохранено; очередь приостановлена.';
          publish(turn);
          refreshRetryEligibility();
          finishIdleWaiters();
        });
        return;
      }
    }
    stopStates.delete(turnId);
    blockedTurnId = null;
    refreshRetryEligibility();
    finishIdleWaiters();
    if (!draining && queue.some((turn) => turn.status === 'queued')) void drain();
  };

  const finishIdleWaiters = (): void => {
    if (blockedTurnId) {
      const error = new Error('Очередь приостановлена: остановка хода не подтверждена.');
      for (const waiter of idleWaiters.splice(0)) waiter.reject(error);
      return;
    }
    if (draining || activeTurn || queue.some((turn) => turn.status === 'queued')) return;
    if (pendingPersistenceCount > 0) return;
    for (const waiter of idleWaiters.splice(0)) waiter.resolve();
  };

  const persistQueuedCancellation = (turn: RuntimeTurn): void => {
    void scheduleTurnRecord(turn).then(() => {
      finishIdleWaiters();
    }, () => {
      turn.status = 'failed';
      turn.errorCategory = 'storage';
      turn.error = 'Состояние отменённого хода не сохранено; очередь приостановлена.';
      if (!blockedTurnId) blockedTurnId = turn.id;
      publish(turn);
      refreshRetryEligibility();
      finishIdleWaiters();
    });
  };

  const waitForTools = async (state: StopState): Promise<boolean> => {
    if (state.pendingToolIds.size === 0) return true;
    let resolveWaiter!: () => void;
    const pending = new Promise<void>((resolve) => { resolveWaiter = resolve; });
    state.waiters.add(resolveWaiter);
    const result = await bounded(pending, stopTimeoutMs);
    state.waiters.delete(resolveWaiter);
    return result !== STOP_TIMEOUT;
  };

  const requestIteratorStop = (
    turnId: string,
    iterator: AsyncIterator<ProviderEvent>,
    pendingNext: Promise<IteratorResult<ProviderEvent>> | null,
  ): Promise<boolean> => {
    const state = stopStates.get(turnId);
    if (!state) return Promise.resolve(false);
    if (state.streamConfirmed) return Promise.resolve(true);
    if (state.streamStop) return state.streamStop;
    const returnMethod = iterator.return;
    if (!returnMethod) {
      state.streamStop = Promise.resolve(false);
      return state.streamStop;
    }
    const returned = Promise.resolve().then(() => returnMethod.call(iterator)).then(
      (result) => Boolean(result && result.done),
      () => false,
    );
    const nextSettled = pendingNext ? settle(pendingNext).then(() => true) : Promise.resolve(true);
    state.streamStop = Promise.all([returned, nextSettled]).then(([returnConfirmed]) => {
      if (returnConfirmed) state.streamConfirmed = true;
      notifyStopWaiters(state);
      maybeUnblock(turnId);
      return returnConfirmed;
    });
    return state.streamStop;
  };

  const confirmStop = async (
    turn: RuntimeTurn,
    iterator: AsyncIterator<ProviderEvent> | null,
    pendingNext: Promise<IteratorResult<ProviderEvent>> | null,
    naturallyDone: boolean,
  ): Promise<boolean> => {
    const state = stopStates.get(turn.id);
    if (!state) return false;
    if (naturallyDone) state.streamConfirmed = true;
    else if (iterator && !state.streamConfirmed) {
      const streamResult = await bounded(requestIteratorStop(turn.id, iterator, pendingNext), stopTimeoutMs);
      if (streamResult === STOP_TIMEOUT || !streamResult) {
        state.streamStop?.then(() => { notifyStopWaiters(state); maybeUnblock(turn.id); });
        return false;
      }
      state.streamConfirmed = true;
    } else if (!iterator && !state.streamConfirmed) {
      state.streamConfirmed = true;
    }
    if (!(await waitForTools(state))) return false;
    return true;
  };

  const holdForPendingOperation = (
    turn: RuntimeTurn,
    state: StopState,
    outcome: Promise<{ status: 'completed' | 'failed' | 'cancelled'; error?: string; errorCategory?: ProviderErrorCategory; imageProtocolDiagnostic?: ImageProtocolDiagnostic }>,
    message: string,
  ): void => {
    state.pendingOperationCount += 1;
    blockedTurnId = turn.id;
    turn.status = 'running';
    turn.error = message;
    publish(turn);
    refreshRetryEligibility();
    finishIdleWaiters();
    void outcome.then((result) => {
      state.pendingOperationCount -= 1;
      state.pendingOutcome = result;
      if (stopConfirmed(state)) maybeUnblock(turn.id);
    });
  };

  const markStopUnconfirmed = (turn: RuntimeTurn): void => {
    blockedTurnId = turn.id;
    turn.status = 'failed';
    delete turn.retryEligible;
    delete turn.errorCategory;
    delete turn.imageProtocolDiagnostic;
    turn.error = 'Не удалось подтвердить остановку потока или локального инструмента; очередь приостановлена.';
    turn.endedAt = new Date().toISOString();
    const state = stopStates.get(turn.id);
    if (state) state.pendingOutcome = { status: 'failed', error: turn.error };
    publish(turn);
    refreshRetryEligibility();
    finishIdleWaiters();
    if (state) {
      state.streamStop?.then(() => { notifyStopWaiters(state); maybeUnblock(turn.id); });
      if (stopConfirmed(state)) maybeUnblock(turn.id);
    }
  };

  const runTurn = async (turn: RuntimeTurn): Promise<void> => {
    const controller = new AbortController();
    const stopState: StopState = {
      streamConfirmed: false, streamStop: null, pendingToolIds: new Set(), waiters: new Set(),
      pendingOperationCount: 0, pendingOutcome: null,
    };
    stopStates.set(turn.id, stopState);
    turn.controller = controller;
    turn.status = 'running';
    delete turn.retryEligible;
    turn.startedAt = new Date().toISOString();
    turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
    void scheduleTurnRecord(turn).catch(() => undefined);
    publish(turn);
    const started = Date.now();
    let iterator: AsyncIterator<ProviderEvent> | null = null;
    let pendingNext: Promise<IteratorResult<ProviderEvent>> | null = null;
    let naturallyDone = false;
    let stopHooksRan = false;
    let interruptHooksRan = false;
    let reservationConsumed = false;
    let turnTimedOut = false;
    let providerCallStarted = false;
    let imageGenerationTurn = false;
    let answer = '';
    let activeUsageReceipt: UsageReceipt | null = null;
    let usagePersistenceTimedOut = false;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDraftPublishedAt = 0;
    const turnTimer = setTimeout(() => { turnTimedOut = true; controller.abort(); }, turnTimeoutMs);
    const flushDraft = (): void => {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      if (!answer) return;
      turn.draft = answer;
      lastDraftPublishedAt = Date.now();
      publish(turn);
    };
    const scheduleDraftPublish = (): void => {
      turn.draft = answer;
      const delayMs = DRAFT_UPDATE_INTERVAL_MS - (Date.now() - lastDraftPublishedAt);
      if (delayMs <= 0) flushDraft();
      else if (!draftTimer) draftTimer = setTimeout(flushDraft, delayMs);
    };
    const waitTracked = async <T>(
      promise: Promise<T>, timeoutMs: number, timeoutMessage: string, pendingMessage: string,
      signal = controller.signal,
    ): Promise<T> => {
      try { return await waitFor(promise, signal, timeoutMs, timeoutMessage); }
      catch (error) {
        const timedOut = error instanceof Error && error.message === timeoutMessage;
        if (!timedOut && !isAbortError(error)) throw error;
        if (timedOut) {
          if (timeoutMessage === 'USAGE_RECEIPT_SAVE_TIMEOUT') usagePersistenceTimedOut = true;
          controller.abort();
        }
        const pendingOutcome = promise.then(
          () => turn.cancelRequested || !timedOut && controller.signal.aborted && !turnTimedOut
            ? ({ status: 'cancelled' as const, errorCategory: 'cancel' as const })
            : ({ status: 'failed' as const, error: pendingMessage, errorCategory: runtimeErrorCategory(new Error(timeoutMessage)) }),
          (lateError: unknown) => turn.cancelRequested || !timedOut && controller.signal.aborted && !turnTimedOut
            ? ({ status: 'cancelled' as const, errorCategory: 'cancel' as const })
            : ({ status: 'failed' as const, error: lateError instanceof Error ? lateError.message : pendingMessage,
              errorCategory: runtimeErrorCategory(lateError) ?? runtimeErrorCategory(new Error(timeoutMessage)) }),
        );
        holdForPendingOperation(turn, stopState, pendingOutcome, pendingMessage);
        throw timedOut ? new Error(timeoutMessage) : error;
      }
    };
    const flushTurnPersistence = async (signal = controller.signal): Promise<void> => {
      if (!options.persistTurnRecord) return;
      const pending = turn.persistTail.then(() => {
        if (turn.persistError !== undefined) throw turn.persistError;
      });
      await waitTracked(
        pending,
        operationTimeoutMs,
        'TURN_RECORD_SAVE_TIMEOUT',
        'Сохранение состояния хода ожидается; очередь приостановлена.',
        signal,
      );
    };
    const saveUsageReceipt = async (receipt: UsageReceipt): Promise<void> => {
      try { await options.recordUsageReceipt(receipt); }
      catch (error) {
        if (isAbortError(error)) throw error;
        throw new Error('USAGE_RECEIPT_WRITE_FAILED');
      }
    };
    const persistUsageReceipt = async (persistence: Promise<void>, signal = controller.signal): Promise<void> => {
      try {
        await waitTracked(
          persistence,
          operationTimeoutMs,
          'USAGE_RECEIPT_SAVE_TIMEOUT',
          'Сохранение usage не завершено; очередь приостановлена.',
          signal,
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        const timeout = error instanceof Error && error.message === 'USAGE_RECEIPT_SAVE_TIMEOUT';
        turn.errorCategory = 'storage';
        publish(turn);
        throw Object.assign(new Error(timeout ? 'USAGE_RECEIPT_SAVE_TIMEOUT' : 'USAGE_RECEIPT_SAVE_FAILED'), { category: 'storage' });
      }
    };
    const updateActiveUsage = async (patch: Partial<UsageReceipt>, signal = controller.signal): Promise<void> => {
      if (!activeUsageReceipt) return;
      const updated = mergeUsageReceipt(activeUsageReceipt, { ...activeUsageReceipt, ...patch });
      activeUsageReceipt = updated;
      const persistence = Promise.resolve().then(() => saveUsageReceipt(updated)).then(async () => {
        if (updated.status !== 'pending' || !controller.signal.aborted) return;
        const cancelled = turn.cancelRequested || !turnTimedOut && !usagePersistenceTimedOut;
        const terminal = { ...updated, status: cancelled ? 'cancelled' as const : 'failed' as const };
        await saveUsageReceipt(terminal);
        if (activeUsageReceipt?.localRequestId === terminal.localRequestId) activeUsageReceipt = terminal;
      });
      await persistUsageReceipt(persistence, signal);
    };
    const finishActiveUsage = async (status: UsageReceiptStatus, signal = controller.signal): Promise<void> => {
      if (!activeUsageReceipt) return;
      if (activeUsageReceipt.status === 'pending') await updateActiveUsage({ status }, signal);
      activeUsageReceipt = null;
    };
    const runHookEvent = async (
      input: HookDispatchInput,
      signal = controller.signal,
      acceptedTurn = turn.input,
      persistAs?: RuntimeTurnSnapshot,
    ): Promise<HookRunResult[]> => {
      let results: HookRunResult[];
      try {
        results = await options.runHooks?.(acceptedTurn, input, signal) ?? [];
      } catch (error) {
        if (error instanceof HookDispatchAbortError) {
          for (const result of error.hookResults) {
            addActivity(turn, {
              kind: 'hook', at: new Date().toISOString(), hookId: result.hookId, hookName: result.hookName,
              event: result.event, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
            }, persistAs);
          }
          await flushTurnPersistence(signal);
        }
        throw error;
      }
      for (const result of results) {
        addActivity(turn, {
          kind: 'hook', at: new Date().toISOString(), hookId: result.hookId, hookName: result.hookName,
          event: result.event, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
        }, persistAs);
      }
      await flushTurnPersistence(signal);
      if (signal.aborted) throw abortError();
      return results;
    };
    const invokeTool = async (call: ProviderFunctionCall): Promise<unknown> => {
      const validation = validateToolArguments(call);
      if (!validation.ok) return { ok: false, error: validation.error, message: validation.message };
      const args = validation.args;
      const scope = { signal: controller.signal, expectedWorkingFolder: turn.input.projectWorkingFolder, skillId: turn.input.skillId };
      switch (call.name) {
        case 'list': return options.tools.list(turn.input.projectId, turn.input.permissionProfile, args.path ?? '', scope);
        case 'search': return options.tools.search(turn.input.projectId, turn.input.permissionProfile, args.query, args.path ?? '', scope);
        case 'read': return options.tools.read(turn.input.projectId, turn.input.permissionProfile, args.path, scope);
        case 'write': return options.tools.write(turn.input.projectId, turn.input.permissionProfile, args.path, args.contents, scope);
        case 'open': return options.tools.open(turn.input.projectId, turn.input.permissionProfile, args.path ?? '', scope);
        case 'powershell': return options.tools.runPowerShell(turn.input.projectId, turn.input.permissionProfile, args.script, {
          ...scope,
          ...(args.external_access === true ? { fullAccessOnce: true } : {}),
        });
        default: return { ok: false, error: 'unknown_function', message: 'Эта функция недоступна в текущем приложении.' };
      }
    };
    try {
      await flushTurnPersistence();
      if (!options.provider) throw new Error('PROVIDER_UNAVAILABLE');
      if (!turn.input.modelId) throw new Error('MODEL_NOT_SELECTED');
      const preparation = Promise.resolve().then(() => options.prepareTurn(turn.input, controller.signal));
      const prepared = await waitFor(preparation, controller.signal, prepareTimeoutMs, 'TURN_PREPARE_TIMEOUT');
      let request: ProviderTurnRequest;
      let compactionContext: PreparedCompactionContext | null = null;
      let providerStateOwner: ProviderStateOwner | undefined;
      let imageGeneration: AsyncIterable<ProviderEvent> | null = null;
      if (typeof prepared === 'object' && prepared !== null && 'request' in prepared) {
        request = prepared.request;
        compactionContext = prepared.compaction ?? null;
        providerStateOwner = prepared.providerStateOwner;
        imageGeneration = prepared.imageGeneration ?? null;
      } else request = prepared;
      request = withLiteNormalOutputCap(request);
      imageGenerationTurn = imageGeneration !== null;
      if (imageGeneration && (compactionContext || turn.input.operation === 'compaction')) {
        throw Object.assign(new Error('IMAGE_GENERATION_PROTOCOL'), { category: 'protocol' as const });
      }
      if (controller.signal.aborted) throw abortError();
      options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
      if (!request.modelId) throw new Error('MODEL_NOT_SELECTED');
      if (turn.input.operation === 'compaction') {
        if (!compactionContext || !Array.isArray(compactionContext.sources?.messages)
          || compactionContext.sources.messages.length === 0 || !Array.isArray(compactionContext.sources.tools)
          || request.usageKind !== 'compaction' || request.functionCallMode !== 'none'
          || (request.protocolHistory?.length ?? 0) !== 0 || request.messages.length !== 2
          || request.messages.some((message) => message.role !== 'user')) {
          throw new Error('COMPACTION_CONTEXT_UNAVAILABLE');
        }
        const beforeResults = await runHookEvent({ event: 'before-compaction', projectId: turn.input.projectId });
        const rejected = beforeResults.find((result) => result.status !== 'completed' || result.decision === 'block');
        if (rejected) throw new Error(rejected.reason ?? 'Проверка Hook остановила сжатие контекста.');
      } else await runHookEvent({ event: 'user-prompt-submitted', projectId: turn.input.projectId });

      if (!imageGeneration && turn.input.operation !== 'compaction' && options.prepareProviderRequest) {
        options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
        const attachmentPreparation = Promise.resolve().then(() =>
          options.prepareProviderRequest!(turn.input, request, controller.signal, providerStateOwner));
        request = await waitTracked(
          attachmentPreparation,
          prepareTimeoutMs,
          'ATTACHMENT_PREPARE_TIMEOUT',
          'Подготовка вложений не подтверждена; очередь приостановлена.',
        );
        if (controller.signal.aborted) throw abortError();
        options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
      }

      let toolRounds = 0;
      let totalToolResultBytes = 0;
      let generatedArtifactId: string | undefined;
      for (;;) {
        await flushTurnPersistence();
        if (controller.signal.aborted) throw abortError();
        if (stopState.pendingToolIds.size || stopState.pendingOperationCount > 0) throw new Error('TOOL_STOP_STATE');
        if (options.preflightProviderRequest && !imageGeneration) {
          const requestBeforePreflight = request;
          const requestSnapshot = JSON.stringify(request);
          if (requestSnapshot === undefined) throw Object.assign(new Error('Контекст запроса нельзя проверить перед отправкой.'), { category: 'context' as const });
          options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
          const preflight = Promise.resolve().then(() =>
            options.preflightProviderRequest!(turn.input, request, controller.signal, providerStateOwner));
          await waitTracked(
            preflight,
            operationTimeoutMs,
            'PROMPT_PREFLIGHT_TIMEOUT',
            'Проверка размера контекста не завершена; очередь ожидает её остановки.',
          );
          if (controller.signal.aborted) throw abortError();
          options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
          let requestAfterSnapshot: string | undefined;
          try { requestAfterSnapshot = JSON.stringify(request); } catch { requestAfterSnapshot = undefined; }
          if (request !== requestBeforePreflight || requestAfterSnapshot === undefined || requestAfterSnapshot !== requestSnapshot) {
            throw Object.assign(new Error('Контекст запроса изменился во время проверки; ход не отправлен.'), { category: 'context' as const });
          }
        }
        stopState.streamConfirmed = true;
        stopState.streamStop = null;
        naturallyDone = false;
        if (!request.modelId) throw new Error('MODEL_NOT_SELECTED');
        const usageReceipt: UsageReceipt = {
          localRequestId: randomUUID(),
          chatId: turn.input.chatId,
          requestKind: toolRounds > 0 ? 'tool-continuation'
            : turn.input.operation === 'compaction' ? 'compaction' : request.usageKind ?? 'chat',
          modelId: request.modelId,
          providerRequestId: null,
          providerModel: null,
          createdAt: new Date().toISOString(),
          status: 'pending',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          precachedPromptTokens: null,
          conflictedFields: [],
        };
        const initialUsagePersistence = Promise.resolve().then(() => saveUsageReceipt(usageReceipt)).then(async () => {
          if (!controller.signal.aborted) return;
          await saveUsageReceipt({
            ...usageReceipt,
            status: turn.cancelRequested || !turnTimedOut && !usagePersistenceTimedOut ? 'cancelled' : 'failed',
          });
        });
        await persistUsageReceipt(initialUsagePersistence);
        activeUsageReceipt = usageReceipt;
        if (controller.signal.aborted) throw abortError();
        if (toolRounds === 0 && turn.input.operation !== 'compaction' && turn.input.skillId
          && request.system.some((layer) => layer.source === 'skill' && layer.text.trim().length > 0)) {
          turn.pendingSkillId = turn.input.skillId;
          await waitTracked(
            scheduleTurnRecord(turn),
            operationTimeoutMs,
            'TURN_RECORD_SAVE_TIMEOUT',
            'Сохранение подготовки Skill ожидается; очередь приостановлена.',
          );
          if (controller.signal.aborted) {
            turn.pendingSkillId = null;
            throw abortError();
          }
        }
        options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
        stopState.streamConfirmed = false;
        iterator = (imageGeneration ?? options.provider.stream(request, controller.signal))[Symbol.asyncIterator]();
        let completed = false;
        let completedFunctionsStateId: string | undefined;
        let functionCall: ProviderFunctionCall | null = null;
        for (;;) {
          if (!providerCallStarted) {
            let firstNext: Promise<IteratorResult<ProviderEvent>>;
            try { firstNext = iterator.next(); }
            finally { providerCallStarted = true; }
            pendingNext = Promise.resolve(firstNext);
            void pendingNext.catch(() => undefined);
            if (turn.pendingSkillId) {
              turn.invokedSkillId = turn.pendingSkillId;
              turn.pendingSkillId = null;
              await waitTracked(
                scheduleTurnRecord(turn),
                operationTimeoutMs,
                'TURN_RECORD_SAVE_TIMEOUT',
                'Сохранение использования Skill ожидается; очередь приостановлена.',
              );
              if (controller.signal.aborted) throw abortError();
            }
          } else {
            pendingNext = Promise.resolve().then(() => iterator!.next());
          }
          const result = await waitFor(pendingNext, controller.signal, nextTimeoutMs, 'PROVIDER_STEP_TIMEOUT');
          pendingNext = null;
          if (controller.signal.aborted) throw abortError();
          if (result.done) {
            naturallyDone = true;
            stopState.streamConfirmed = true;
            break;
          }
          assertProviderEvent(result.value);
          if (completed || functionCall) throw new Error('PROVIDER_PROTOCOL');
          if (!reservationConsumed) {
            const consuming = options.consumeTurn(turn.input, controller.signal);
            const consumeOutcome = consuming.then(
              () => ({ status: turn.cancelRequested ? 'cancelled' as const : 'failed' as const,
                ...(turn.cancelRequested ? { errorCategory: 'cancel' as const } : {
                  error: 'Не удалось вовремя подтвердить выбор параметров хода.', errorCategory: 'storage' as const,
                }) }),
              (error: unknown) => ({ status: turn.cancelRequested ? 'cancelled' as const : 'failed' as const,
                ...(turn.cancelRequested ? { errorCategory: 'cancel' as const } : {
                  error: error instanceof Error ? error.message : 'Не удалось подтвердить выбор параметров хода.',
                  errorCategory: 'storage' as const,
                }) }),
            );
            const consumed = await bounded(consuming.then(() => true), operationTimeoutMs);
            if (consumed === STOP_TIMEOUT) {
              holdForPendingOperation(turn, stopState, consumeOutcome, 'Ожидание фиксации параметров превысило срок; очередь приостановлена.');
              controller.abort();
              throw new Error('TURN_CONSUME_TIMEOUT');
            }
            reservationConsumed = true;
            if (controller.signal.aborted) throw abortError();
          }
          const rawEvent = result.value;
          if (rawEvent.type === 'activity') {
            addActivity(turn, {
              kind: 'provider', at: new Date().toISOString(), activity: rawEvent.activity,
              ...(rawEvent.tool ? { tool: rawEvent.tool } : {}),
              ...(rawEvent.functionName ? { functionName: rawEvent.functionName } : {}),
              ...(rawEvent.detail ? { detail: rawEvent.detail } : {}),
            });
          } else if (rawEvent.type === 'usage') {
            await updateActiveUsage({
              promptTokens: rawEvent.promptTokens,
              completionTokens: rawEvent.completionTokens,
              totalTokens: rawEvent.totalTokens,
              precachedPromptTokens: rawEvent.precachedPromptTokens,
              ...(rawEvent.providerRequestId ? { providerRequestId: rawEvent.providerRequestId } : {}),
              ...(rawEvent.providerModel ? { providerModel: rawEvent.providerModel } : {}),
            });
          } else if (rawEvent.type === 'text-delta') {
            if (answer.length + rawEvent.text.length > MAX_ASSISTANT_CHARS) throw new Error('RESPONSE_LIMIT');
            answer += rawEvent.text;
            scheduleDraftPublish();
          } else if (rawEvent.type === 'error') {
            if (rawEvent.category === 'cancel') throw abortError();
            const diagnostic = imageGeneration && rawEvent.category === 'protocol' && isImageProtocolDiagnostic(rawEvent.imageProtocolDiagnostic)
              ? rawEvent.imageProtocolDiagnostic : undefined;
            throw Object.assign(new Error('PROVIDER_ERROR'), {
              category: rawEvent.category,
              ...(diagnostic ? { imageProtocolDiagnostic: diagnostic } : {}),
            });
          } else if (rawEvent.type === 'function-call') {
            if (imageGeneration) throw Object.assign(new Error('IMAGE_GENERATION_FUNCTION_CALL'), { category: 'protocol' as const });
            if (completed || functionCall) throw new Error('PROVIDER_PROTOCOL');
            functionCall = rawEvent.functionCall;
          } else if (rawEvent.type === 'image-result') {
            if (!imageGeneration || generatedArtifactId !== undefined) {
              throw Object.assign(new Error('IMAGE_GENERATION_RESULT_INVALID'), { category: 'protocol' as const });
            }
            generatedArtifactId = rawEvent.artifactId;
          } else {
            completed = true;
            if (rawEvent.functionsStateId) completedFunctionsStateId = rawEvent.functionsStateId;
          }
          await flushTurnPersistence();
        }

        if (controller.signal.aborted) throw abortError();
        if (functionCall) {
          if (turn.input.operation === 'compaction') throw Object.assign(new Error('UNEXPECTED_COMPACTION_FUNCTION'), { category: 'context' });
          if (completed) throw new Error('PROVIDER_PROTOCOL');
          if (toolRounds >= MAX_FUNCTION_ROUNDS || (request.protocolHistory?.length ?? 0) >= 256) {
            throw Object.assign(new Error('TOOL_ROUND_LIMIT'), { category: 'tool' });
          }
          if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
            controller.abort();
            flushDraft();
            markStopUnconfirmed(turn);
            return;
          }
          await finishActiveUsage('completed');
          addActivity(turn, {
            kind: 'provider', at: new Date().toISOString(), activity: 'waiting-for-tool',
            ...(isProviderToolName(functionCall.name) ? { tool: functionCall.name } : {}),
          });
          await flushTurnPersistence();
          if (!options.beginToolReceipt || !options.completeToolReceipt) {
            throw Object.assign(new Error('TOOL_RECEIPT_STORE_UNAVAILABLE'), { category: 'tool' });
          }
          const effectId = effectIdFor(turn.input, functionCall);
          const receiptInput: ToolReceiptInput = {
            receiptId: receiptIdFor(turn.input, functionCall, toolRounds),
            ...(effectId ? { effectId } : {}),
            name: functionCall.name,
            arguments: structuredClone(functionCall.arguments),
            content: functionCall.content,
            functionsStateId: functionCall.functionsStateId,
          };
          if (controller.signal.aborted) throw abortError();
          options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
          const beginPromise = options.beginToolReceipt(turn.input, receiptInput, providerStateOwner, functionCall.wire);
          const begun = await waitTracked(beginPromise, operationTimeoutMs, 'TOOL_INTENT_SAVE_TIMEOUT', 'Подтверждение сохранения намерения инструмента ожидается; очередь приостановлена.');
          const storedReceipt = begun.receipt;
          let exchange: ProviderProtocolExchange;
          if (!begun.shouldExecute) {
            exchange = {
              anchorMessageId: turn.input.messageId,
              name: functionCall.name,
              arguments: structuredClone(functionCall.arguments),
              content: functionCall.content,
              functionsStateId: functionCall.functionsStateId,
              result: storedReceipt.result ?? errorResult(new Error('Результат инструмента неизвестен.'), true),
              ...(functionCall.wire ? { receiptId: receiptInput.receiptId, wire: structuredClone(functionCall.wire) } : {}),
            };
          } else {
            const validation = validateToolArguments(functionCall);
            const operation = (async (): Promise<ProviderProtocolExchange> => {
              let resultText: string | null = null;
              let resultStatus: 'completed' | 'unknown' = 'completed';
              let abortAfterSave = false;
              let actualToolOutcome: HookDispatchInput['outcome'] = 'failed';
              if (!validation.ok) resultText = objectResult({ ok: false, error: validation.error, message: validation.message });
              else if (controller.signal.aborted) resultText = objectResult({ ok: false, error: 'cancelled', message: 'Инструмент отменён до запуска.' });
              else {
                let beforeResults: HookRunResult[] = [];
                try {
                  beforeResults = await runHookEvent({
                    event: 'before-tool', projectId: turn.input.projectId,
                    ...(isProviderToolName(functionCall!.name) ? { tool: functionCall!.name } : {}),
                  });
                } catch (hookError) {
                  resultText = errorResult(hookError, false);
                  abortAfterSave = isAbortError(hookError);
                }
                const failedCheck = beforeResults.find((result) => result.status !== 'completed' || result.decision === 'block');
                if (resultText === null && failedCheck) {
                  resultText = objectResult({
                    ok: false,
                    error: 'hook_blocked',
                    message: failedCheck.reason ?? 'Проверка Hook не разрешила запуск инструмента.',
                  });
                }
                if (resultText === null) {
                  try {
                    const result = await invokeTool(functionCall!);
                    const hasSideEffect = functionCall!.name === 'write' || functionCall!.name === 'powershell' || functionCall!.name === 'open';
                    if (controller.signal.aborted && hasSideEffect) {
                      resultStatus = 'unknown';
                      resultText = errorResult(new Error('cancelled'), true);
                      actualToolOutcome = 'cancelled';
                    } else {
                      const commandFailed = functionCall!.name === 'powershell' && typeof result === 'object' && result !== null
                        && (('exitCode' in result && typeof result.exitCode === 'number' && result.exitCode !== 0)
                          || ('timedOut' in result && result.timedOut === true)
                          || ('outputLimited' in result && result.outputLimited === true));
                      actualToolOutcome = commandFailed ? 'failed' : 'completed';
                      if (commandFailed && hasSideEffect) resultStatus = 'unknown';
                      resultText = objectResult({ ok: !commandFailed, result });
                    }
                  } catch (toolError) {
                    const hasSideEffect = functionCall!.name === 'write' || functionCall!.name === 'powershell' || functionCall!.name === 'open';
                    const permissionDenied = toolError instanceof LocalToolError && toolError.code === 'PERMISSION_DENIED';
                    resultStatus = hasSideEffect && !permissionDenied ? 'unknown' : 'completed';
                    actualToolOutcome = isAbortError(toolError) ? 'cancelled' : 'failed';
                    resultText = errorResult(toolError, hasSideEffect && !permissionDenied);
                  }
                  try {
                    await runHookEvent({
                      event: 'after-tool', projectId: turn.input.projectId,
                      ...(isProviderToolName(functionCall!.name) ? { tool: functionCall!.name } : {}),
                      outcome: actualToolOutcome,
                    });
                  } catch (hookError) {
                    if (isAbortError(hookError)) abortAfterSave = true;
                  }
                }
              }
              if (resultText === null) resultText = objectResult({ ok: false, error: 'hook_blocked', message: 'Проверка Hook не завершилась.' });
              if (Buffer.byteLength(resultText, 'utf8') > MAX_TOOL_RESULT_BYTES) {
                resultText = objectResult({ ok: false, error: 'result_limit', message: 'Результат инструмента превышает лимит 16 КиБ.' });
              }
              await options.completeToolReceipt!(turn.input, receiptInput.receiptId, resultStatus, resultText);
              const exchange = {
                anchorMessageId: turn.input.messageId,
                name: functionCall!.name,
                arguments: structuredClone(functionCall!.arguments),
                content: functionCall!.content,
                functionsStateId: functionCall!.functionsStateId,
                result: resultText,
                ...(functionCall!.wire ? { receiptId: receiptInput.receiptId, wire: structuredClone(functionCall!.wire) } : {}),
              };
              if (abortAfterSave || controller.signal.aborted) throw abortError();
              return exchange;
            })();
            exchange = await waitTracked(operation, toolTimeoutMs, 'LOCAL_TOOL_TIMEOUT', 'Локальный инструмент или сохранение результата ещё не остановились; очередь приостановлена.');
          }
          if (controller.signal.aborted) throw abortError();
          totalToolResultBytes += Buffer.byteLength(exchange.result, 'utf8');
          if (totalToolResultBytes > MAX_TOTAL_TOOL_RESULT_BYTES) throw Object.assign(new Error('TOOL_RESULT_LIMIT'), { category: 'tool' });
          request = { ...request, protocolHistory: [...(request.protocolHistory ?? []), structuredClone(exchange)] };
          toolRounds += 1;
          if (draftTimer) clearTimeout(draftTimer);
          draftTimer = null;
          answer = '';
          delete turn.draft;
          publish(turn);
          continue;
        }

        if (!completed || (imageGeneration ? generatedArtifactId === undefined : !answer.trim())) {
          throw Object.assign(new Error('INCOMPLETE_PROVIDER_RESPONSE'), { category: 'protocol' as const });
        }
        if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
          controller.abort();
          flushDraft();
          markStopUnconfirmed(turn);
          return;
        }
        if (controller.signal.aborted) throw abortError();
        await finishActiveUsage('completed');
        stopHooksRan = true;
        await runHookEvent({ event: 'stop', projectId: turn.input.projectId }, new AbortController().signal).catch(() => undefined);
        await flushTurnPersistence();
        flushDraft();
        const terminalTurn = copyTurn({
          ...turn,
          status: 'completed',
          endedAt: new Date().toISOString(),
          activeDurationMs: Math.max(0, Date.now() - started),
          draft: undefined,
          error: undefined,
          errorCategory: undefined,
          imageProtocolDiagnostic: undefined,
          retryEligible: undefined,
        });
        options.assertProviderStateOwner?.(providerStateOwner, controller.signal);
        const appendOperation = turn.input.operation === 'compaction'
          ? options.appendCompaction && compactionContext
            ? options.appendCompaction(turn.input, compileCompactionCandidate(answer, compactionContext.sources), controller.signal, compactionContext,
              terminalTurn, completedFunctionsStateId, providerStateOwner)
              .then(async () => {
                await runHookEvent({ event: 'after-compaction', projectId: turn.input.projectId }, new AbortController().signal, turn.input, terminalTurn).catch(() => undefined);
              })
            : Promise.reject(new Error('COMPACTION_SAVE_UNAVAILABLE'))
          : options.appendAssistant(turn.input, answer, controller.signal, completedFunctionsStateId, terminalTurn,
            providerStateOwner, generatedArtifactId);
        const appending = appendOperation.catch((error: unknown) => {
          if (isAbortError(error)) throw error;
          if (turn.input.operation === 'compaction' && error instanceof Error && error.message === 'COMPACTION_NO_REDUCTION') throw error;
          throw Object.assign(new Error('ASSISTANT_SAVE_FAILED'), { category: 'storage' as const });
        });
        const appendOutcome = appending.then(
          () => ({ status: 'completed' as const }),
          (error: unknown) => turn.cancelRequested || isAbortError(error)
            ? ({ status: 'cancelled' as const, errorCategory: 'cancel' as const })
            : turn.input.operation === 'compaction' && error instanceof Error && error.message === 'COMPACTION_NO_REDUCTION'
              ? ({ status: 'failed' as const, error: 'Сжатие отклонено: запрос не стал короче; прежний контекст сохранён.', errorCategory: 'context' as const })
            : ({ status: 'failed' as const, error: 'Ответ не удалось сохранить. Сообщение пользователя осталось в чате.', errorCategory: 'storage' as const }),
        );
        const appended = await bounded(appending.then(() => true), operationTimeoutMs);
        if (appended === STOP_TIMEOUT) {
          turn.pendingTerminal = terminalTurn;
          holdForPendingOperation(turn, stopState, appendOutcome, 'Подтверждение сохранения ответа ожидается; очередь приостановлена.');
          return;
        }
        delete turn.draft;
        turn.status = 'completed';
        delete turn.error;
        delete turn.errorCategory;
        delete turn.imageProtocolDiagnostic;
        delete turn.retryEligible;
        turn.endedAt = terminalTurn.endedAt;
        turn.activeDurationMs = terminalTurn.activeDurationMs;
        publish(turn);
        break;
      }
    } catch (error) {
      if (!providerCallStarted) turn.pendingSkillId = null;
      flushDraft();
      if (!turn.cancelRequested && !isAbortError(error) && !naturallyDone) controller.abort();
      if (!(await confirmStop(turn, iterator, pendingNext, naturallyDone))) {
        controller.abort();
        flushDraft();
        markStopUnconfirmed(turn);
      } else if (stopState.pendingOperationCount > 0) {
        const errorCategory = runtimeErrorCategory(error, turnTimedOut);
        const imageProtocolDiagnostic = imageGenerationTurn && errorCategory === 'protocol'
          ? imageProtocolDiagnosticFromError(error) : undefined;
        if (blockedTurnId !== turn.id) holdForPendingOperation(turn, stopState, Promise.resolve({
          status: 'failed', error: 'Ожидание локальной операции не завершено.',
          ...(errorCategory ? { errorCategory } : {}),
          ...(imageProtocolDiagnostic ? { imageProtocolDiagnostic } : {}),
        }), 'Ожидание локальной операции не завершено; очередь приостановлена.');
      } else if (stopState.pendingOutcome) {
        maybeUnblock(turn.id);
      } else {
        const terminalSignal = new AbortController().signal;
        const cancelled = turn.cancelRequested || isAbortError(error) && !turnTimedOut;
        let terminalError: unknown = error;
        try { await finishActiveUsage(cancelled ? 'cancelled' : 'failed', terminalSignal); }
        catch (usageError) { terminalError = usageError; }
        if (stopState.pendingOperationCount > 0 || stopState.pendingOutcome || blockedTurnId === turn.id) {
          if (stopState.pendingOperationCount === 0) maybeUnblock(turn.id);
          return;
        }
        if (cancelled && !interruptHooksRan) {
          interruptHooksRan = true;
          await runHookEvent({ event: 'interrupt', projectId: turn.input.projectId, outcome: 'cancelled' }, terminalSignal).catch(() => undefined);
        }
        if (!stopHooksRan) {
          stopHooksRan = true;
          await runHookEvent({
            event: 'stop', projectId: turn.input.projectId,
            outcome: cancelled ? 'cancelled' : 'failed',
          }, terminalSignal).catch(() => undefined);
        }
        turn.status = turn.cancelRequested || isAbortError(terminalError) && !turnTimedOut ? 'cancelled' : 'failed';
        turn.endedAt = new Date().toISOString();
        turn.activeDurationMs = Math.max(0, Date.now() - started);
        const category = runtimeErrorCategory(terminalError, turnTimedOut);
        if (turn.status === 'cancelled') turn.errorCategory = 'cancel';
        else if (category) turn.errorCategory = category;
        else delete turn.errorCategory;
        const imageProtocolDiagnostic = imageGenerationTurn && turn.status === 'failed' && category === 'protocol'
          ? imageProtocolDiagnosticFromError(terminalError) : undefined;
        if (imageProtocolDiagnostic) turn.imageProtocolDiagnostic = imageProtocolDiagnostic;
        else delete turn.imageProtocolDiagnostic;
        if (turn.status === 'failed') {
          turn.error = turnTimedOut
            ? 'Ход превысил общий лимит времени.'
            : terminalError instanceof Error && terminalError.message === 'PROVIDER_UNAVAILABLE'
              ? 'GigaChat API пока не подключён.'
              : terminalError instanceof Error && terminalError.message === 'MODEL_NOT_SELECTED'
                ? 'Выберите модель GigaChat для следующего хода.'
                : terminalError instanceof Error && terminalError.message === 'TURN_PREPARE_TIMEOUT'
                  ? 'Подготовка хода превысила ограниченное время ожидания.'
                  : terminalError instanceof Error && terminalError.message === 'PROMPT_PREFLIGHT_TIMEOUT'
                    ? 'Проверка контекста превысила ограниченное время; запрос не отправлен.'
                  : terminalError instanceof Error && terminalError.message === 'COMPACTION_CANDIDATE_REJECTED'
                    ? 'Сжатие отклонено; прежний контекст сохранён.'
                  : terminalError instanceof Error && terminalError.message === 'COMPACTION_NO_REDUCTION'
                    ? 'Сжатие отклонено: запрос не стал короче; прежний контекст сохранён.'
                  : terminalError instanceof Error && terminalError.message === 'PROVIDER_STEP_TIMEOUT'
                    ? 'Поток не ответил в отведённое время.'
                    : terminalError instanceof Error && terminalError.message === 'TURN_CONSUME_TIMEOUT'
                      ? 'Не удалось зафиксировать параметры хода вовремя.'
                      : terminalError instanceof Error && terminalError.message === 'TOOL_ROUND_LIMIT'
                        ? 'Ход остановлен: достигнут лимит последовательных вызовов инструментов.'
                        : terminalError instanceof Error && terminalError.message === 'TOOL_RESULT_LIMIT'
                          ? 'Ход остановлен: суммарный результат инструментов превысил лимит.'
                          : terminalError instanceof Error && terminalError.message === 'LOCAL_TOOL_TIMEOUT'
                            ? 'Локальный инструмент превысил лимит времени; очередь ожидает подтверждённой остановки.'
                            : terminalError instanceof Error && terminalError.message === 'TOOL_INTENT_SAVE_TIMEOUT'
                              ? 'Не удалось вовремя зафиксировать намерение инструмента.'
                              : terminalError instanceof Error && terminalError.message === 'USAGE_RECEIPT_SAVE_TIMEOUT'
                                ? 'Не удалось вовремя сохранить usage; очередь ожидает завершения записи.'
                                : terminalError instanceof Error && terminalError.message === 'USAGE_RECEIPT_SAVE_FAILED'
                                  ? 'Не удалось сохранить usage; запрос не будет продолжен.'
                                  : terminalError instanceof Error && terminalError.message === 'TOOL_RECEIPT_STORE_UNAVAILABLE'
                                    ? 'Сохранение истории инструментов недоступно; действие не выполнено.'
                                    : terminalError instanceof HistoricalProviderStateAttachmentsError
                                      ? HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE
                                      : terminalError instanceof MissingRemoteAttachmentError
                                        ? MISSING_REMOTE_ATTACHMENT_MESSAGE
                                        : 'Ход завершился ошибкой. Сообщение пользователя сохранено локально.';
        }
        publish(turn);
        if (options.persistTurnRecord) {
          try { await scheduleTurnRecord(turn); }
          catch {
            blockedTurnId = turn.id;
            turn.status = 'failed';
            turn.errorCategory = 'storage';
            delete turn.imageProtocolDiagnostic;
            turn.error = 'Состояние остановленного хода не сохранено; очередь приостановлена.';
            publish(turn);
            refreshRetryEligibility();
            finishIdleWaiters();
            return;
          }
        }
      }
    } finally {
      clearTimeout(turnTimer);
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      if (!reservationConsumed) options.releaseTurn(turn.input);
      if (stopState.pendingOperationCount === 0 && blockedTurnId !== turn.id) turn.controller = undefined;
      if (blockedTurnId !== turn.id && stopConfirmed(stopState)) {
        stopStates.delete(turn.id);
        updateRetryEligibility(turn);
      }
    }
  };

  const drain = async (): Promise<void> => {
    if (draining || blockedTurnId) return;
    draining = true;
    try {
      while (queue.length && !blockedTurnId) {
        if (pendingPersistenceCount > 0) {
          await waitForPendingPersistence();
          continue;
        }
        const turn = queue.shift();
        if (!turn || turn.status !== 'queued') continue;
        activeTurn = turn;
        await runTurn(turn);
        activeTurn = null;
      }
    } finally {
      activeTurn = null;
      draining = false;
      finishIdleWaiters();
      if (!blockedTurnId && queue.some((turn) => turn.status === 'queued')) void drain();
    }
  };

  const enqueueAcceptedTurn = (input: AcceptedTurnInput, queuedAt?: string): string => {
    if (turns.has(input.turnId)) throw new Error('Повторный ID принятого хода.');
    const turn: RuntimeTurn = {
      id: input.turnId,
      chatId: input.chatId,
      anchorMessageId: input.messageId,
      assistantMessageId: input.assistantMessageId,
      status: 'queued',
      pendingSkillId: null,
      invokedSkillId: null,
      createdAt: queuedAt ?? input.messages.find((message) => message.id === input.messageId)?.createdAt ?? new Date().toISOString(),
      activity: [],
      cancelRequested: false,
      persistTail: Promise.resolve(),
      input,
    };
    turns.set(turn.id, turn);
    if (input.operation !== 'compaction') latestTurnByAnchor.set(anchorKey(input), turn.id);
    queue.push(turn);
    void scheduleTurnRecord(turn).catch(() => undefined);
    publish(turn);
    void drain();
    return turn.id;
  };

  return {
    tools: options.tools,
    enqueue: (turnInput) => {
      if (!options.provider) return null;
      const input = requireAcceptedTurn(turnInput);
      if (input.operation !== undefined) throw new Error('Сжатие контекста нельзя поставить как обычный ход.');
      return enqueueAcceptedTurn(input);
    },
    enqueueCompaction: (turnInput) => {
      if (!options.provider || options.compactionEnabled !== true || !options.appendCompaction) return null;
      const input = requireAcceptedTurn(turnInput);
      if (input.operation !== 'compaction') throw new Error('Ожидалась задача сжатия контекста.');
      return enqueueAcceptedTurn(input);
    },
    list: (chatIdInput) => {
      const chatId = chatIdInput === undefined ? undefined : requireChatId(chatIdInput);
      return [...turns.values()]
        .filter((turn) => chatId === undefined || turn.chatId === chatId)
        .map(copyTurn);
    },
    cancel: (turnIdInput, chatIdInput) => {
      if (typeof turnIdInput !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnIdInput)) return false;
      const turn = turns.get(turnIdInput);
      if (!turn || turn.status !== 'queued' && turn.status !== 'running') return false;
      if (chatIdInput !== undefined && turn.chatId !== requireChatId(chatIdInput)) return false;
      if (turn.status === 'queued') {
        turn.status = 'cancelled';
        turn.errorCategory = 'cancel';
        turn.endedAt = new Date().toISOString();
        turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
        options.releaseTurn(turn.input);
        persistQueuedCancellation(turn);
        publish(turn);
        updateRetryEligibility(turn);
        finishIdleWaiters();
      } else {
        turn.cancelRequested = true;
        turn.controller?.abort();
      }
      return true;
    },
    retry: async (turnIdInput, chatIdInput) => {
      if (!options.provider || typeof turnIdInput !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnIdInput)) return null;
      const turn = turns.get(turnIdInput);
      if (!turn || chatIdInput !== undefined && turn.chatId !== requireChatId(chatIdInput)
        || turn.retryEligible !== true || !canRetry(turn)) return null;
      const key = anchorKey(turn.input);
      retryingAnchors.add(key);
      delete turn.retryEligible;
      publish(turn);
      let accepted = false;
      let retryInput: AcceptedTurnInput | null = null;
      try {
        retryInput = requireAcceptedTurn({ ...turn.input, turnId: randomUUID() });
        await options.validateRetry?.(structuredClone(retryInput), structuredClone(turn.input));
        if (!canRetry(turn, true)) return null;
        const retryId = enqueueAcceptedTurn(retryInput, new Date().toISOString());
        accepted = true;
        return retryId;
      } finally {
        retryingAnchors.delete(key);
        if (!accepted) {
          if (retryInput) options.releaseTurn(retryInput);
          updateRetryEligibility(turn);
        }
      }
    },
    cancelAll: async () => {
      for (const turn of queue) {
        if (turn.status === 'queued') {
          turn.status = 'cancelled';
          turn.errorCategory = 'cancel';
          turn.endedAt = new Date().toISOString();
          turn.queueDurationMs = Math.max(0, Date.now() - Date.parse(turn.createdAt));
          options.releaseTurn(turn.input);
          persistQueuedCancellation(turn);
          publish(turn);
          updateRetryEligibility(turn);
        }
      }
      activeTurn?.controller?.abort();
      await new Promise<void>((resolve, reject) => {
        if (blockedTurnId) reject(new Error('Очередь приостановлена: остановка хода не подтверждена.'));
        else if (!draining && !activeTurn && !queue.some((turn) => turn.status === 'queued') && pendingPersistenceCount === 0) resolve();
        else idleWaiters.push({ resolve, reject });
      });
    },
    whenIdle: () => new Promise<void>((resolve, reject) => {
      if (blockedTurnId) reject(new Error('Очередь приостановлена: остановка хода не подтверждена.'));
      else if (!draining && !activeTurn && !queue.some((turn) => turn.status === 'queued') && pendingPersistenceCount === 0) resolve();
      else idleWaiters.push({ resolve, reject });
    }),
    onUpdate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordToolEvent: (event) => {
      if (event.phase === 'started') {
        if (!activeTurn || activeTurn.status !== 'running') return;
        const state = stopStates.get(activeTurn.id);
        if (!state || toolOwners.has(event.id)) return;
        toolOwners.set(event.id, activeTurn.id);
        state.pendingToolIds.add(event.id);
        addActivity(activeTurn, {
          kind: 'tool', at: event.at, tool: event.tool, phase: event.phase,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        });
        return;
      }
      const ownerId = toolOwners.get(event.id);
      if (!ownerId) return;
      toolOwners.delete(event.id);
      const owner = turns.get(ownerId);
      const state = stopStates.get(ownerId);
      if (state) {
        state.pendingToolIds.delete(event.id);
        notifyStopWaiters(state);
        maybeUnblock(ownerId);
      }
      if (owner) addActivity(owner, {
        kind: 'tool', at: event.at, tool: event.tool, phase: event.phase,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
    },
    recordHookResult: (result) => {
      const turn = activeTurn;
      if (!turn) return;
      addActivity(turn, {
        kind: 'hook', at: new Date().toISOString(), hookId: result.hookId, hookName: result.hookName,
        event: result.event, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
      });
    },
  };
}
