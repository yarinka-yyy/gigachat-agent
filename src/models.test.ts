import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoveredModelRegistry,
  failedModelRegistry,
  isModelAvailable,
  requireModelId,
  unavailableModelRegistry,
} from './models';
import {
  billingFamilyForUsageLabel,
  CHAT_MODEL_FAMILIES,
  chatModelUnavailableReason,
  chatModelOptions,
  isChatModelAvailable,
  legacyModelUpgrade,
} from './model-catalog';
import { basicAgentWorkflowStatus, getModelCapabilities, getModelContextLimit } from './model-capabilities';

test('accepts bounded provider model IDs without a local namespace whitelist', () => {
  assert.equal(requireModelId('future/model.v4:preview'), 'future/model.v4:preview');
  assert.throws(() => requireModelId('  '));
  assert.throws(() => requireModelId(`model-${'x'.repeat(200)}`));
  assert.throws(() => requireModelId('model\ninvalid'));
  assert.throws(() => requireModelId('model\u0085invalid'));
});

test('raw model registry keeps only the exact discovered IDs', () => {
  const registry = discoveredModelRegistry(['future/model.v4', 'future/model.v4']);
  assert.deepEqual(registry, { state: 'ready', modelIds: ['future/model.v4'], errorCategory: null });
  assert.equal(isModelAvailable(registry, 'future/model.v4'), true);
  assert.equal(isModelAvailable(registry, 'legacy/model-v1'), false);
  assert.deepEqual(unavailableModelRegistry(), { state: 'unavailable', modelIds: [], errorCategory: null });
  assert.deepEqual(discoveredModelRegistry([]), { state: 'error', modelIds: [], errorCategory: 'model' });
});

test('chat catalogue is the four named current families while raw discovery stays complete', () => {
  const rawIds = [
    'GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro', 'GigaChat-3-Lightning',
    'GigaChat-2-Pro', 'GigaChat-2', 'GigaEmbeddings', 'GigaEmbeddings-3', 'vendor/model-v4',
  ];
  const registry = discoveredModelRegistry(rawIds);
  assert.deepEqual(registry.modelIds, rawIds);
  assert.deepEqual(CHAT_MODEL_FAMILIES.map(({ displayName, currentId }) => [displayName, currentId]), [
    ['GigaChat Ultra', 'GigaChat-3-Ultra'],
    ['GigaChat Max', 'GigaChat-2-Max'],
    ['GigaChat Pro', 'GigaChat-3-Pro'],
    ['GigaChat Lite', 'GigaChat-3-Lightning'],
  ]);
  assert.deepEqual(chatModelOptions(registry).map(({ displayName, currentId }) => [displayName, currentId]), [
    ['GigaChat Ultra', 'GigaChat-3-Ultra'],
    ['GigaChat Max', 'GigaChat-2-Max'],
    ['GigaChat Pro', 'GigaChat-3-Pro'],
    ['GigaChat Lite', 'GigaChat-3-Lightning'],
  ]);
  assert.deepEqual(chatModelOptions(registry).map(({ selectable }) => selectable), [true, true, true, true],
    'the four current IDs are selectable when listed and their real basic workflows are verified');
  assert.notEqual(chatModelOptions(registry)[0]?.poolEvidence, CHAT_MODEL_FAMILIES[0]?.poolEvidence);
  const chatCatalogIds: string[] = chatModelOptions(registry).map(({ displayName, currentId }) => `${displayName}:${currentId}`);
  assert.equal(chatCatalogIds.some((entry) => entry.includes('Embeddings') || entry.includes('GigaChat-2-Pro')), false);
});

test('balance billing labels match only exact current, legacy, display, and observed Ultra aliases', () => {
  for (const family of CHAT_MODEL_FAMILIES) {
    for (const label of [family.currentId, family.displayName, ...family.legacyIds,
      ...('billingAliases' in family ? family.billingAliases : [])]) {
      assert.equal(billingFamilyForUsageLabel(label)?.family, family.family);
    }
  }
  assert.equal(billingFamilyForUsageLabel('GigaChat-Ultra')?.family, 'ultra');
  for (const label of ['GigaChat3Ultra', 'GigaChat3-Ultra', 'Embeddings', 'my-GigaChat-Ultra', 'GigaChat Ultra v2', '']) {
    assert.equal(billingFamilyForUsageLabel(label), null);
  }
});

test('chat enforcement requires an exact listed current ID and verified basic capability', () => {
  const registry = discoveredModelRegistry([
    'GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro', 'GigaChat-3-Lightning',
    'GigaChat-2-Pro', 'GigaEmbeddings-3',
  ]);
  assert.equal(isChatModelAvailable(registry, 'GigaChat-3-Ultra'), true, 'the previously verified Ultra basic workflow remains available');
  assert.equal(isChatModelAvailable(registry, 'GigaChat-2-Pro'), false, 'a listed legacy ID is never a chat choice');
  assert.equal(isChatModelAvailable(registry, 'GigaEmbeddings-3'), false, 'embedding IDs cannot reach chat completion');
  assert.equal(isChatModelAvailable(registry, 'GigaChat-2-Max'), true, 'the verified Max workflow is available when the current ID is listed');
  assert.equal(isChatModelAvailable(registry, 'GigaChat-3-Pro'), true, 'Pro local-read, text, and function-call workflow passed the bounded real probe');
  assert.equal(isChatModelAvailable(registry, 'GigaChat-3-Lightning'), true, 'Lite local-read, text, and function-call workflow passed the bounded real probe');
  assert.equal(isChatModelAvailable(discoveredModelRegistry(['GigaChat-2-Max']), 'GigaChat-3-Ultra'), false,
    'a current ID missing from the fresh registry is unavailable');
  assert.equal(isChatModelAvailable(failedModelRegistry('network'), 'GigaChat-3-Ultra'), false,
    'an unsuccessful refresh never preserves an implicit send path');
  assert.equal(isChatModelAvailable(unavailableModelRegistry(), 'GigaChat-3-Ultra'), false);
  assert.match(chatModelUnavailableReason(registry, 'GigaEmbeddings-3') ?? '', /не входит в актуальный каталог/);
  assert.match(chatModelUnavailableReason(failedModelRegistry('network'), 'GigaChat-3-Ultra') ?? '', /подтвердить актуальный список/);
});

test('keeps document and JPEG capability evidence separate and per-model', () => {
  const ultra = getModelCapabilities('GigaChat-3-Ultra');
  assert.equal(ultra.md, 'verified', 'the real Ultra probe semantically read the Markdown text/plain fixture');
  assert.equal(ultra.jpeg, 'verified', 'the supplemental real Ultra probe identified the JPEG fixture');
  for (const modelId of ['GigaChat-2-Max', 'GigaChat-3-Pro', 'GigaChat-3-Lightning']) {
    const capabilities = getModelCapabilities(modelId);
    assert.equal(capabilities.md, 'unverified', `${modelId} has no separate Markdown proof`);
    assert.equal(capabilities.jpeg, 'unverified', `${modelId} has no separate JPEG proof`);
  }
  assert.equal('multipleImages' in ultra, false, 'a single-image proof does not establish grouped multi-image capability');
});

test('quota exhaustion affects only the reported model while independent models and raw discovery remain intact', () => {
  const rawIds = ['GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro'];
  const registry = { ...discoveredModelRegistry(rawIds), exhaustedModelIds: ['GigaChat-3-Ultra'] };
  assert.deepEqual(registry.modelIds, rawIds);
  assert.equal(isChatModelAvailable(registry, 'GigaChat-3-Ultra'), false);
  assert.equal(isChatModelAvailable(registry, 'GigaChat-2-Max'), true, 'the independently verified Max model remains available');
  assert.equal(isChatModelAvailable(registry, 'GigaChat-3-Pro'), true, 'quota exhaustion for Ultra does not disable another verified listed model');
  assert.match(chatModelUnavailableReason(registry, 'GigaChat-3-Ultra') ?? '', /Пул этой модели исчерпан/);
  const options = chatModelOptions(registry);
  assert.equal(options.find(({ family }) => family === 'ultra')?.quotaExhausted, true);
  assert.equal(options.find(({ family }) => family === 'ultra')?.selectable, false);
  assert.equal(options.find(({ family }) => family === 'max')?.quotaExhausted, false);
  assert.equal(options.find(({ family }) => family === 'max')?.selectable, true);
  assert.deepEqual(registry.modelIds, rawIds, 'presentation and quota state never filter the raw registry');
});

test('legacy next-model migration maps only documented aliases and never chooses a fallback', () => {
  assert.deepEqual(legacyModelUpgrade('GigaChat-2'), {
    family: 'lite', displayName: 'GigaChat Lite', currentId: 'GigaChat-3-Lightning',
  });
  assert.deepEqual(legacyModelUpgrade('GigaChat-2-Pro'), {
    family: 'pro', displayName: 'GigaChat Pro', currentId: 'GigaChat-3-Pro',
  });
  assert.deepEqual(legacyModelUpgrade('GigaChat-Pro'), {
    family: 'pro', displayName: 'GigaChat Pro', currentId: 'GigaChat-3-Pro',
  });
  assert.equal(legacyModelUpgrade('vendor/model-v4'), null);
  assert.equal(legacyModelUpgrade('GigaChat-2-Max'), null, 'the current Max ID is not a migration source');
});

test('capability gates distinguish verified, unverified, and unavailable workflows without shared mutable evidence', () => {
  const unknown = getModelCapabilities('future/model-v5');
  unknown.textStream = 'verified';
  unknown.functionCalls = 'verified';
  unknown.localRead = 'unverified';
  assert.equal(basicAgentWorkflowStatus(unknown), 'unverified');
  unknown.localRead = 'verified';
  assert.equal(basicAgentWorkflowStatus(unknown), 'verified');
  unknown.functionCalls = 'unavailable';
  assert.equal(basicAgentWorkflowStatus(unknown), 'unavailable');
  assert.equal(getModelCapabilities('future/model-v5').functionCalls, 'unverified');

  const ultra = getModelCapabilities('GigaChat-3-Ultra');
  ultra.evidence.details = 'mutated test copy';
  ultra.txt = 'unavailable';
  assert.equal(getModelCapabilities('GigaChat-3-Ultra').txt, 'verified');
  assert.notEqual(getModelCapabilities('GigaChat-3-Ultra').evidence.details, 'mutated test copy');
});

test('context limits are documented only for the exact Ultra 3 and Max 2 API IDs', () => {
  for (const modelId of ['GigaChat-3-Ultra', 'GigaChat-2-Max']) {
    assert.deepEqual(getModelContextLimit(modelId), {
      limitTokens: 128_000,
      provenance: 'official-model-docs',
      source: 'developers.sber.ru models/main + models/updates',
      verifiedAt: '2026-10-14',
    });
  }
  for (const modelId of [
    'GigaChat-3-Pro', 'GigaChat-3-Lightning', 'GigaChat-2-Pro', 'GigaChat-2', 'future/model-v5', null,
  ]) {
    assert.deepEqual(getModelContextLimit(modelId), {
      limitTokens: null, provenance: 'unknown', source: null, verifiedAt: null,
    });
  }
  for (const inheritedKey of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(getModelContextLimit(inheritedKey), {
      limitTokens: null, provenance: 'unknown', source: null, verifiedAt: null,
    });
  }
});

test('real Stage1 evidence gates file formats independently from the verified chat workflow', () => {
  const max = getModelCapabilities('GigaChat-2-Max');
  const pro = getModelCapabilities('GigaChat-3-Pro');
  const lite = getModelCapabilities('GigaChat-3-Lightning');
  for (const capabilities of [max, pro, lite]) {
    assert.equal(basicAgentWorkflowStatus(capabilities), 'verified');
    assert.equal(capabilities.txt, 'verified');
    assert.equal(capabilities.pdf, 'unverified', 'HTTP 200 with an ambiguous OCR marker does not verify PDF reading');
  }
  assert.equal(max.png, 'unverified', 'a rectangle answer does not match the square image check');
  assert.equal(pro.png, 'unverified', 'a rectangle answer does not match the square image check');
  assert.equal(lite.png, 'unavailable', 'this PNG request was rejected with HTTP 422');
  for (const capabilities of [max, pro, lite]) {
    assert.match(capabilities.evidence.source, /results-04c31349-0b7a-416b-8d67-49863e200376\.jsonl/);
    assert.equal(capabilities.evidence.verifiedAt, '2026-10-12');
  }
});
