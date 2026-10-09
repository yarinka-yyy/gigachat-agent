import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoveredModelRegistry,
  failedModelRegistry,
  isModelAvailable,
  modelIdsForSelection,
  requireModelId,
  unavailableModelRegistry,
} from './models';

test('accepts bounded provider model IDs without a local namespace whitelist', () => {
  assert.equal(requireModelId('future/model.v4:preview'), 'future/model.v4:preview');
  assert.throws(() => requireModelId('  '));
  assert.throws(() => requireModelId(`model-${'x'.repeat(200)}`));
  assert.throws(() => requireModelId('model\ninvalid'));
  assert.throws(() => requireModelId('model\u0085invalid'));
});

test('model registry keeps only discovered IDs and preserves unavailable selections', () => {
  const registry = discoveredModelRegistry(['future/model.v4', 'future/model.v4']);
  assert.deepEqual(registry, { state: 'ready', modelIds: ['future/model.v4'], errorCategory: null });
  assert.deepEqual(modelIdsForSelection(registry, 'legacy/model-v1'), ['future/model.v4', 'legacy/model-v1']);
  assert.equal(isModelAvailable(registry, 'future/model.v4'), true);
  assert.equal(isModelAvailable(registry, 'legacy/model-v1'), false);
  assert.deepEqual(modelIdsForSelection(failedModelRegistry('network'), 'legacy/model-v1'), ['legacy/model-v1']);
  assert.deepEqual(unavailableModelRegistry(), { state: 'unavailable', modelIds: [], errorCategory: null });
  assert.deepEqual(discoveredModelRegistry([]), { state: 'error', modelIds: [], errorCategory: 'model' });
});
