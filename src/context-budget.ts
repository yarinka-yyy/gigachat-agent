export type ContextBudgetConfidence = 'documented' | 'tested-safe' | 'unknown';

export interface ContextBudgetMeasure {
  tokens: number | null;
  confidence: ContextBudgetConfidence;
}

export interface ContextBudgetInput {
  chatWindow: ContextBudgetMeasure;
  normalOutputCap: ContextBudgetMeasure;
  compactionWindow: ContextBudgetMeasure;
  compactionOutputCap: ContextBudgetMeasure;
  compactionPromptOverhead: ContextBudgetMeasure;
  errorReserve: ContextBudgetMeasure;
}

type KnownConfidence = Exclude<ContextBudgetConfidence, 'unknown'>;

export type ContextBudgetResult =
  | { status: 'available'; budgetTokens: number; confidence: KnownConfidence }
  | { status: 'exhausted'; budgetTokens: number; confidence: KnownConfidence }
  | { status: 'unknown'; budgetTokens: null; confidence: 'unknown' }
  | { status: 'invalid'; budgetTokens: null; confidence: 'unknown'; reason: 'invalid-input' | 'unsafe-arithmetic' };

type ParsedMeasure =
  | { status: 'known'; tokens: number; confidence: KnownConfidence }
  | { status: 'unknown' }
  | { status: 'invalid' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMeasure(value: unknown, allowZero: boolean): ParsedMeasure {
  if (!isRecord(value)
    || (value.confidence !== 'documented' && value.confidence !== 'tested-safe' && value.confidence !== 'unknown')) {
    return { status: 'invalid' };
  }
  if (value.confidence === 'unknown') {
    return value.tokens === null ? { status: 'unknown' } : { status: 'invalid' };
  }
  if (!Number.isSafeInteger(value.tokens) || (value.tokens as number) < (allowZero ? 0 : 1)) {
    return { status: 'invalid' };
  }
  return {
    status: 'known',
    tokens: value.tokens as number,
    confidence: value.confidence,
  };
}

function subtractSafely(left: number, right: number): number | null {
  const difference = left - right;
  return Number.isSafeInteger(difference) ? difference : null;
}

export function calculateContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  if (!isRecord(input)) return { status: 'invalid', budgetTokens: null, confidence: 'unknown', reason: 'invalid-input' };

  const parsed = [
    parseMeasure(input.chatWindow, false),
    parseMeasure(input.normalOutputCap, false),
    parseMeasure(input.compactionWindow, false),
    parseMeasure(input.compactionOutputCap, false),
    parseMeasure(input.compactionPromptOverhead, true),
    parseMeasure(input.errorReserve, true),
  ];
  if (parsed.some((measure) => measure.status === 'invalid')) {
    return { status: 'invalid', budgetTokens: null, confidence: 'unknown', reason: 'invalid-input' };
  }
  if (parsed.some((measure) => measure.status === 'unknown')) {
    return { status: 'unknown', budgetTokens: null, confidence: 'unknown' };
  }

  const [chatWindow, normalOutputCap, compactionWindow, compactionOutputCap, promptOverhead, errorReserve] =
    parsed as readonly Extract<ParsedMeasure, { status: 'known' }>[];
  const confidence: KnownConfidence = parsed.some((measure) => measure.status === 'known' && measure.confidence === 'tested-safe')
    ? 'tested-safe'
    : 'documented';

  // This estimates context occupancy; provider cache/billing usage is deliberately not an input.
  const chatRemainder = subtractSafely(chatWindow.tokens, normalOutputCap.tokens);
  const compactionAfterOutput = subtractSafely(compactionWindow.tokens, compactionOutputCap.tokens);
  const compactionRemainder = compactionAfterOutput === null
    ? null
    : subtractSafely(compactionAfterOutput, promptOverhead.tokens);
  const beforeErrorReserve = chatRemainder === null || compactionRemainder === null
    ? null
    : Math.min(chatRemainder, compactionRemainder);
  const budgetTokens = beforeErrorReserve === null ? null : subtractSafely(beforeErrorReserve, errorReserve.tokens);

  if (budgetTokens === null) {
    return { status: 'invalid', budgetTokens: null, confidence: 'unknown', reason: 'unsafe-arithmetic' };
  }
  return budgetTokens > 0
    ? { status: 'available', budgetTokens, confidence }
    : { status: 'exhausted', budgetTokens, confidence };
}
