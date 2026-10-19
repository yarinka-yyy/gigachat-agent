import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextBudgetInput, ContextBudgetMeasure } from './context-budget';
import { calculateContextBudget } from './context-budget';

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
