import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextBudgetInput, ContextBudgetMeasure } from './context-budget';
import { calculateContextBudget, calculateLiteWorkingBudget, isLitePromptOverMeasuredInputGuard, liteHardInputLimit,
  LITE_OPERATIONAL_PROFILE, withLiteNormalOutputCap } from './context-budget';

function measure(tokens: number | null, confidence: ContextBudgetMeasure['confidence'] = 'documented'): ContextBudgetMeasure {
  return { tokens, confidence };
}

function input(overrides: Partial<ContextBudgetInput> = {}): ContextBudgetInput {
  return {
    chatWindow: measure(100_000),
    normalOutputCap: measure(4_000),
    compactionWindow: measure(80_000),
    compactionOutputCap: measure(8_000),
    compactionPromptOverhead: measure(6_000, 'tested-safe'),
    errorReserve: measure(2_000, 'tested-safe'),
    ...overrides,
  };
}

test('uses the smaller of chat and compaction capacity, then deducts the reserve', () => {
  assert.deepEqual(calculateContextBudget(input()), {
    status: 'available', budgetTokens: 64_000, confidence: 'tested-safe',
  });
});

test('chat capacity can be the limiting branch', () => {
  assert.deepEqual(calculateContextBudget(input({
    chatWindow: measure(20_000),
    normalOutputCap: measure(5_000),
    compactionWindow: measure(90_000),
    compactionOutputCap: measure(1_000),
    compactionPromptOverhead: measure(1_000),
    errorReserve: measure(2_000),
  })), {
    status: 'available', budgetTokens: 13_000, confidence: 'documented',
  });
});

test('unknown evidence never becomes a numeric budget', () => {
  assert.deepEqual(calculateContextBudget(input({
    chatWindow: measure(null, 'unknown'),
  })), { status: 'unknown', budgetTokens: null, confidence: 'unknown' });
});

test('invalid evidence takes precedence over unknown evidence', () => {
  assert.deepEqual(calculateContextBudget(input({
    chatWindow: measure(null, 'unknown'),
    compactionOutputCap: measure(Number.NaN),
  })), {
    status: 'invalid', budgetTokens: null, confidence: 'unknown', reason: 'invalid-input',
  });
});

test('unknown confidence must not carry a numeric value', () => {
  assert.equal(calculateContextBudget(input({
    chatWindow: measure(100_000, 'unknown'),
  })).status, 'invalid');
});

test('rejects malformed, fractional, negative, zero-cap, and unsafe inputs', () => {
  const cases: Partial<ContextBudgetInput>[] = [
    { chatWindow: measure(0) },
    { normalOutputCap: measure(0) },
    { compactionPromptOverhead: measure(-1) },
    { errorReserve: measure(1.5) },
    { compactionWindow: measure(Number.MAX_SAFE_INTEGER + 1) },
    { compactionOutputCap: { tokens: 10, confidence: 'assumed' as ContextBudgetMeasure['confidence'] } },
  ];
  for (const overrides of cases) {
    assert.equal(calculateContextBudget(input(overrides)).status, 'invalid');
  }
  assert.equal(calculateContextBudget(null as unknown as ContextBudgetInput).status, 'invalid');
});

test('returns exhausted when verified capacities leave zero or negative room', () => {
  const zero = calculateContextBudget(input({
    chatWindow: measure(100),
    normalOutputCap: measure(20),
    compactionWindow: measure(50),
    compactionOutputCap: measure(20),
    compactionPromptOverhead: measure(5),
    errorReserve: measure(25),
  }));
  assert.deepEqual(zero, { status: 'exhausted', budgetTokens: 0, confidence: 'documented' });

  const negative = calculateContextBudget(input({
    chatWindow: measure(100),
    normalOutputCap: measure(101),
    compactionWindow: measure(80),
    compactionOutputCap: measure(10),
    compactionPromptOverhead: measure(5),
    errorReserve: measure(0),
  }));
  assert.deepEqual(negative, { status: 'exhausted', budgetTokens: -1, confidence: 'documented' });
});

test('rejects arithmetic that leaves the safe integer range', () => {
  assert.deepEqual(calculateContextBudget(input({
    chatWindow: measure(1),
    normalOutputCap: measure(1),
    compactionWindow: measure(Number.MAX_SAFE_INTEGER),
    compactionOutputCap: measure(1),
    compactionPromptOverhead: measure(Number.MAX_SAFE_INTEGER),
    errorReserve: measure(Number.MAX_SAFE_INTEGER),
  })), {
    status: 'invalid', budgetTokens: null, confidence: 'unknown', reason: 'unsafe-arithmetic',
  });
});

test('keeps the Lite working budget dynamic and labels missing compactable history', () => {
  const shape = { wireMessageCount: 2, functionCallCount: 0 };
  const withoutPrefix = calculateLiteWorkingBudget(null, shape);
  assert.equal(withoutPrefix.status, 'available');
  assert.equal(withoutPrefix.budgetTokens, 90_000);
  assert.equal(withoutPrefix.compactionStatus, 'not-applicable');
  assert.equal(withoutPrefix.operationalProfile?.officialContextLimitTokens, null);
  assert.equal(withoutPrefix.operationalProfile?.provenance, 'tested-operational-profile');
  assert.equal(withoutPrefix.operationalProfile?.appliedErrorReserveTokens, 2_048);
  assert.equal(withoutPrefix.operationalProfile?.calibrationDomainStatus, 'within-tested-bounds');
  assert.equal(withoutPrefix.operationalProfile?.reserveBasisMaxWireMessages, 46);
  assert.equal(withoutPrefix.operationalProfile?.reserveBasisMaxFunctionCalls, 2);
  assert.equal(withoutPrefix.operationalProfile?.observedBoundMaxWireMessages, 2_050);
  assert.equal(withoutPrefix.operationalProfile?.observedBoundMaxFunctionCalls, 32);
  assert.equal(calculateLiteWorkingBudget(0, shape).budgetTokens, 90_000);
  assert.equal(calculateLiteWorkingBudget(20_000, shape).budgetTokens, 78_522);
  const exhausted = calculateLiteWorkingBudget(98_522, shape);
  assert.equal(exhausted.status, 'exhausted');
  assert.equal(exhausted.budgetTokens, 0);
  assert.equal(exhausted.compactionStatus, 'available');
  assert.equal(exhausted.compactionOverheadTokens, 98_522);
  assert.equal(calculateLiteWorkingBudget(100_000, shape).status, 'exhausted');
  assert.equal(calculateLiteWorkingBudget(undefined, shape).status, 'unknown');
  assert.equal(calculateLiteWorkingBudget(Number.MAX_SAFE_INTEGER, shape).status, 'unknown');
  const scaled = calculateLiteWorkingBudget(20_000, { wireMessageCount: 47, functionCallCount: 3 });
  assert.equal(scaled.operationalProfile?.appliedErrorReserveTokens, 2_067);
  assert.equal(scaled.budgetTokens, 78_503, 'the reserve grows by the frozen per-message and per-call framing beyond tested counts');
  assert.equal(scaled.operationalProfile?.observedWireMessageCount, 47);
  assert.equal(scaled.operationalProfile?.observedFunctionCallCount, 3);
  assert.equal(scaled.operationalProfile?.calibrationDomainStatus, 'within-tested-bounds',
    'reserve scaling basis is independent from the newly observed bounds');
  assert.equal(calculateLiteWorkingBudget(null, { wireMessageCount: -1, functionCallCount: 0 }).status, 'unknown');
  assert.equal(calculateLiteWorkingBudget(undefined, { wireMessageCount: 1, functionCallCount: 0 }).operationalProfile?.normalMeasuredInputTokens,
    101_905, 'unknown budget states still publish aggregate tested envelopes');
  const unknownShape = calculateLiteWorkingBudget(null, { wireMessageCount: null, functionCallCount: 0 });
  assert.equal(unknownShape.status, 'unknown');
  assert.equal(unknownShape.operationalProfile?.calibrationDomainStatus, 'unknown');
  assert.equal(unknownShape.operationalProfile?.appliedErrorReserveTokens, null);
  assert.equal(calculateLiteWorkingBudget(null, { wireMessageCount: 1.5, functionCallCount: 0 }).status, 'unknown');
  assert.equal(calculateLiteWorkingBudget(null, { wireMessageCount: Number.MAX_SAFE_INTEGER + 1, functionCallCount: 0 }).status, 'unknown');
  const extrapolated = calculateLiteWorkingBudget(null, { wireMessageCount: 2_051, functionCallCount: 0 });
  assert.equal(extrapolated.status, 'available');
  assert.equal(extrapolated.budgetTokens, 89_832);
  assert.equal(extrapolated.operationalProfile?.calibrationDomainStatus, 'extrapolated');
  assert.equal(extrapolated.operationalProfile?.appliedErrorReserveTokens, 12_073);
  assert.equal(calculateLiteWorkingBudget(null, { wireMessageCount: 66, functionCallCount: 33 })
    .operationalProfile?.calibrationDomainStatus, 'extrapolated');
  assert.equal(LITE_OPERATIONAL_PROFILE.normalOperationalTotalTokens,
    LITE_OPERATIONAL_PROFILE.normalInputTokens + LITE_OPERATIONAL_PROFILE.normalOutputCapTokens);
  assert.equal(LITE_OPERATIONAL_PROFILE.compactionOperationalTotalTokens,
    LITE_OPERATIONAL_PROFILE.compactionInputTokens + LITE_OPERATIONAL_PROFILE.compactionOutputCapTokens);
});

test('uses separate tested input guards and caps only normal Lightning turns', () => {
  const smallShape = { wireMessageCount: 2, functionCallCount: 0 };
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning' }, smallShape), 99_857);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', usageKind: 'compaction', compactionFormat: 'semantic' }, smallShape), 106_714);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', usageKind: 'compaction' }), null,
    'the old extractive path has no measured semantic input envelope');
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning' }, { wireMessageCount: 47, functionCallCount: 3 }), 99_838,
    'the input guard keeps the original reserve basis while counts remain within observed bounds');
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning' }, { wireMessageCount: 2_051, functionCallCount: 0 }), null,
    'the hard refusal is withheld beyond the observed message bound');
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning' }, { wireMessageCount: 66, functionCallCount: 33 }), null,
    'the hard refusal is withheld beyond the observed call bound');
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning' }, { wireMessageCount: null, functionCallCount: 0 }), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', maxOutputTokens: -1 }, smallShape), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', maxOutputTokens: 8_193 }, smallShape), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', usageKind: 'compaction', compactionFormat: 'semantic', maxOutputTokens: 4_097 }, smallShape), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', maxOutputTokens: Number.NaN }, smallShape), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning' }, { wireMessageCount: 1.5, functionCallCount: 0 }), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Lightning', maxOutputTokens: 9_000 }), null);
  assert.equal(liteHardInputLimit({ modelId: 'GigaChat-3-Pro' }), null);

  const normal = { modelId: 'GigaChat-3-Lightning' as const };
  const other = { modelId: 'GigaChat-3-Pro' as const };
  const overLimit = {
    status: 'complete' as const, tokens: 99_858, knownTokens: 99_850, provenance: 'estimated' as const,
    wireMessageCount: 2, functionCallCount: 0, unknownReasons: [],
  };
  assert.equal(isLitePromptOverMeasuredInputGuard(normal, overLimit), true);
  assert.equal(isLitePromptOverMeasuredInputGuard(normal, { ...overLimit, status: 'partial', tokens: null }), false);
  assert.equal(isLitePromptOverMeasuredInputGuard(normal, { ...overLimit, wireMessageCount: 2_051 }), false);
  assert.equal(isLitePromptOverMeasuredInputGuard(other, overLimit), false);
  assert.deepEqual(withLiteNormalOutputCap(normal), { modelId: normal.modelId, maxOutputTokens: 8_192 });
  assert.deepEqual(withLiteNormalOutputCap({ ...normal, maxOutputTokens: 12_000 }), { ...normal, maxOutputTokens: 8_192 });
  assert.deepEqual(withLiteNormalOutputCap({ ...normal, maxOutputTokens: 2_000 }), { ...normal, maxOutputTokens: 2_000 });
  assert.strictEqual(withLiteNormalOutputCap(other), other);
  const compaction = { modelId: 'GigaChat-3-Lightning' as const, usageKind: 'compaction' as const };
  assert.strictEqual(withLiteNormalOutputCap(compaction), compaction);
});
