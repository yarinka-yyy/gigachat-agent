import type { ContextLiteOperationalProfileView, ContextPromptEstimate, ContextWorkingBudgetView, ProviderTurnRequest } from './contracts';

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

export const LITE_OPERATIONAL_PROFILE = Object.freeze({
  profileId: 'gigachat-3-lightning-32.4.16.3-bounded-operational-envelope',
  modelId: 'GigaChat-3-Lightning',
  providerVersion: '32.4.16.3',
  provenance: 'tested-operational-profile' as const,
  officialContextLimitTokens: null,
  normalInputTokens: 101_905,
  normalOutputCapTokens: 8_192,
  normalOperationalTotalTokens: 110_097,
  compactionInputTokens: 108_762,
  compactionOutputCapTokens: 4_096,
  compactionOperationalTotalTokens: 112_858,
  errorReserveTokens: 2_048,
  workingCeilingTokens: 90_000,
  reserveBasisMaxWireMessages: 46,
  reserveBasisMaxFunctionCalls: 2,
  // These are observed per-dimension maxima, not an exhaustive proof of every combined shape.
  observedMaxWireMessages: 2_050,
  observedMaxFunctionCalls: 32,
});

export type LiteWorkingBudget = ContextWorkingBudgetView;

export interface LitePromptEstimateShape {
  wireMessageCount: number | null;
  functionCallCount: number | null;
}

function hasInvalidLitePromptShape(shape?: LitePromptEstimateShape): boolean {
  return Boolean(shape && [shape.wireMessageCount, shape.functionCallCount]
    .some((count) => count !== null && (!Number.isSafeInteger(count) || count < 0)));
}

function hasKnownLitePromptShape(shape?: LitePromptEstimateShape): shape is {
  wireMessageCount: number;
  functionCallCount: number;
} {
  return Boolean(shape && Number.isSafeInteger(shape.wireMessageCount) && shape.wireMessageCount! >= 0
    && Number.isSafeInteger(shape.functionCallCount) && shape.functionCallCount! >= 0);
}

function isWithinObservedLiteBounds(shape: { wireMessageCount: number; functionCallCount: number }): boolean {
  return shape.wireMessageCount <= LITE_OPERATIONAL_PROFILE.observedMaxWireMessages
    && shape.functionCallCount <= LITE_OPERATIONAL_PROFILE.observedMaxFunctionCalls;
}

export function litePromptCalibrationExcess(shape?: LitePromptEstimateShape): number {
  if (hasInvalidLitePromptShape(shape)) return Number.MAX_SAFE_INTEGER;
  const extraMessages = shape && Number.isSafeInteger(shape.wireMessageCount)
    ? Math.max(0, shape.wireMessageCount! - LITE_OPERATIONAL_PROFILE.reserveBasisMaxWireMessages) : 0;
  const extraCalls = shape && Number.isSafeInteger(shape.functionCallCount)
    ? Math.max(0, shape.functionCallCount! - LITE_OPERATIONAL_PROFILE.reserveBasisMaxFunctionCalls) : 0;
  const reserve = extraMessages * 5 + extraCalls * 14;
  return Number.isSafeInteger(reserve) ? reserve : Number.MAX_SAFE_INTEGER;
}

function liteOperationalProfileView(shape?: LitePromptEstimateShape): ContextLiteOperationalProfileView {
  const reserveExcess = litePromptCalibrationExcess(shape);
  const appliedErrorReserveTokens = LITE_OPERATIONAL_PROFILE.errorReserveTokens + reserveExcess;
  const knownShape = hasKnownLitePromptShape(shape);
  return {
    profileId: LITE_OPERATIONAL_PROFILE.profileId,
    modelId: LITE_OPERATIONAL_PROFILE.modelId,
    providerVersion: LITE_OPERATIONAL_PROFILE.providerVersion,
    provenance: LITE_OPERATIONAL_PROFILE.provenance,
    officialContextLimitTokens: null,
    normalMeasuredInputTokens: LITE_OPERATIONAL_PROFILE.normalInputTokens,
    normalOutputCapTokens: LITE_OPERATIONAL_PROFILE.normalOutputCapTokens,
    normalOperationalTotalTokens: LITE_OPERATIONAL_PROFILE.normalOperationalTotalTokens,
    semanticMeasuredInputTokens: LITE_OPERATIONAL_PROFILE.compactionInputTokens,
    semanticOutputCapTokens: LITE_OPERATIONAL_PROFILE.compactionOutputCapTokens,
    semanticOperationalTotalTokens: LITE_OPERATIONAL_PROFILE.compactionOperationalTotalTokens,
    baseErrorReserveTokens: LITE_OPERATIONAL_PROFILE.errorReserveTokens,
    appliedErrorReserveTokens: knownShape && Number.isSafeInteger(appliedErrorReserveTokens) ? appliedErrorReserveTokens : null,
    scaledReserveBasis: '5-per-message-and-14-per-call-beyond-reserve-basis',
    reserveBasisMaxWireMessages: LITE_OPERATIONAL_PROFILE.reserveBasisMaxWireMessages,
    reserveBasisMaxFunctionCalls: LITE_OPERATIONAL_PROFILE.reserveBasisMaxFunctionCalls,
    observedBoundMaxWireMessages: LITE_OPERATIONAL_PROFILE.observedMaxWireMessages,
    observedBoundMaxFunctionCalls: LITE_OPERATIONAL_PROFILE.observedMaxFunctionCalls,
    calibrationDomainStatus: !knownShape ? 'unknown' : isWithinObservedLiteBounds(shape) ? 'within-tested-bounds' : 'extrapolated',
    observedWireMessageCount: shape?.wireMessageCount ?? null,
    observedFunctionCallCount: shape?.functionCallCount ?? null,
    workingCeilingTokens: LITE_OPERATIONAL_PROFILE.workingCeilingTokens,
  };
}

export function withLiteNormalOutputCap<T extends {
  modelId: string | null;
  usageKind?: 'chat' | 'tool-continuation' | 'compaction';
  maxOutputTokens?: number;
}>(request: T): T {
  if (request.modelId !== LITE_OPERATIONAL_PROFILE.modelId || request.usageKind === 'compaction') return request;
  const maxOutputTokens = Math.min(request.maxOutputTokens ?? LITE_OPERATIONAL_PROFILE.normalOutputCapTokens,
    LITE_OPERATIONAL_PROFILE.normalOutputCapTokens);
  return request.maxOutputTokens === maxOutputTokens ? request : { ...request, maxOutputTokens };
}

export function liteHardInputLimit(request: {
  modelId: string | null;
  usageKind?: 'chat' | 'tool-continuation' | 'compaction';
  compactionFormat?: 'semantic';
  maxOutputTokens?: number;
}, shape?: LitePromptEstimateShape): number | null {
  if (request.modelId !== LITE_OPERATIONAL_PROFILE.modelId) return null;
  const semantic = request.usageKind === 'compaction' && request.compactionFormat === 'semantic';
  if (request.usageKind === 'compaction' && !semantic) return null;
  if (request.compactionFormat !== undefined && request.usageKind !== 'compaction') return null;
  const outputCap = semantic ? LITE_OPERATIONAL_PROFILE.compactionOutputCapTokens : LITE_OPERATIONAL_PROFILE.normalOutputCapTokens;
  if (request.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 0 || request.maxOutputTokens > outputCap)) return null;
  if (!hasKnownLitePromptShape(shape) || hasInvalidLitePromptShape(shape) || !isWithinObservedLiteBounds(shape)) return null;
  const measuredInput = semantic ? LITE_OPERATIONAL_PROFILE.compactionInputTokens : LITE_OPERATIONAL_PROFILE.normalInputTokens;
  const reserve = LITE_OPERATIONAL_PROFILE.errorReserveTokens + litePromptCalibrationExcess(shape);
  const limit = measuredInput - reserve;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

export function calculateLiteWorkingBudget(
  compactionOverheadTokens: number | null | undefined,
  shape?: LitePromptEstimateShape,
): LiteWorkingBudget {
  const { normalInputTokens, workingCeilingTokens } = LITE_OPERATIONAL_PROFILE;
  const operationalProfile = liteOperationalProfileView(shape);
  const appliedReserve = operationalProfile.appliedErrorReserveTokens;
  if (hasInvalidLitePromptShape(shape) || !hasKnownLitePromptShape(shape) || appliedReserve === null) {
    return { status: 'unknown', budgetTokens: null, provenance: 'unknown', compactionStatus: 'unknown', compactionOverheadTokens: null, operationalProfile };
  }
  if (compactionOverheadTokens === undefined) {
    return { status: 'unknown', budgetTokens: null, provenance: 'unknown', compactionStatus: 'unknown', compactionOverheadTokens: null, operationalProfile };
  }
  if (compactionOverheadTokens === null) {
    const normalBudget = normalInputTokens - appliedReserve;
    return Number.isSafeInteger(normalBudget) && normalBudget > 0
      ? { status: 'available', budgetTokens: Math.min(normalBudget, workingCeilingTokens), provenance: 'estimated',
        compactionStatus: 'not-applicable', compactionOverheadTokens: null, operationalProfile }
      : { status: 'exhausted', budgetTokens: Number.isSafeInteger(normalBudget) ? normalBudget : null, provenance: 'estimated',
        compactionStatus: 'not-applicable', compactionOverheadTokens: null, operationalProfile };
  }
  if (!Number.isSafeInteger(compactionOverheadTokens) || compactionOverheadTokens < 0) {
    return { status: 'unknown', budgetTokens: null, provenance: 'unknown', compactionStatus: 'unknown', compactionOverheadTokens: null, operationalProfile };
  }
  const budget = calculateContextBudget({
    chatWindow: { tokens: LITE_OPERATIONAL_PROFILE.normalOperationalTotalTokens, confidence: 'tested-safe' },
    normalOutputCap: { tokens: LITE_OPERATIONAL_PROFILE.normalOutputCapTokens, confidence: 'tested-safe' },
    compactionWindow: { tokens: LITE_OPERATIONAL_PROFILE.compactionOperationalTotalTokens, confidence: 'tested-safe' },
    compactionOutputCap: { tokens: LITE_OPERATIONAL_PROFILE.compactionOutputCapTokens, confidence: 'tested-safe' },
    compactionPromptOverhead: {
      tokens: compactionOverheadTokens + LITE_OPERATIONAL_PROFILE.normalOutputCapTokens,
      confidence: 'tested-safe',
    },
    errorReserve: { tokens: appliedReserve, confidence: 'tested-safe' },
  });
  if (budget.status === 'unknown' || budget.status === 'invalid' || !Number.isSafeInteger(budget.budgetTokens)) {
    return { status: 'unknown', budgetTokens: null, provenance: 'unknown', compactionStatus: 'unknown', compactionOverheadTokens, operationalProfile };
  }
  const budgetTokens = budget.budgetTokens > 0 ? Math.min(budget.budgetTokens, workingCeilingTokens) : budget.budgetTokens;
  return { status: budgetTokens > 0 ? 'available' : 'exhausted', budgetTokens, provenance: 'estimated',
    compactionStatus: 'available', compactionOverheadTokens, operationalProfile };
}

export function isLitePromptOverMeasuredInputGuard(
  request: Pick<ProviderTurnRequest, 'modelId' | 'usageKind' | 'compactionFormat' | 'maxOutputTokens'>,
  estimate: ContextPromptEstimate,
): boolean {
  const inputLimit = liteHardInputLimit(request, {
    wireMessageCount: estimate.wireMessageCount,
    functionCallCount: estimate.functionCallCount,
  });
  return inputLimit !== null && estimate.status === 'complete' && estimate.provenance === 'estimated'
    && estimate.unknownReasons.length === 0 && Number.isSafeInteger(estimate.tokens)
    && Number.isSafeInteger(estimate.wireMessageCount)
    && estimate.wireMessageCount! >= 0
    && estimate.wireMessageCount! <= LITE_OPERATIONAL_PROFILE.observedMaxWireMessages
    && Number.isSafeInteger(estimate.functionCallCount)
    && estimate.functionCallCount! >= 0
    && estimate.functionCallCount! <= LITE_OPERATIONAL_PROFILE.observedMaxFunctionCalls
    && estimate.tokens! > inputLimit;
}

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
