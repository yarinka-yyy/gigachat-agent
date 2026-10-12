import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRendererOperationTracker, retryUnavailableReason } from './renderer-operations';

test('retry availability requires the frozen original model in the ready registry', () => {
  const turn = { retryEligible: true, modelId: 'GigaChat-3-Ultra' };
  assert.match(retryUnavailableReason(turn, { state: 'unavailable', modelIds: [], errorCategory: null }) ?? '', /Подключите API/);
  assert.match(retryUnavailableReason(turn, { state: 'error', modelIds: [], errorCategory: 'network' }) ?? '', /обновить список/);
  assert.match(retryUnavailableReason(turn, { state: 'ready', modelIds: ['GigaChat-3-Pro'], errorCategory: null }) ?? '', /Исходная модель/);
  assert.equal(retryUnavailableReason(turn, { state: 'ready', modelIds: ['GigaChat-3-Ultra', 'GigaChat-3-Pro'], errorCategory: null }), null);
  assert.match(retryUnavailableReason({ retryEligible: true, modelId: null }, { state: 'ready', modelIds: ['GigaChat-3-Pro'], errorCategory: null }) ?? '', /не указана/);
});

test('retry never substitutes a listed legacy or embedding model for a current chat family', () => {
  const registry = {
    state: 'ready' as const,
    modelIds: ['GigaChat-3-Ultra', 'GigaChat-3-Pro', 'GigaChat-2-Pro', 'GigaEmbeddings-3'],
    errorCategory: null,
  };
  assert.match(retryUnavailableReason({ retryEligible: true, modelId: 'GigaChat-2-Pro' }, registry) ?? '', /Исходная модель/);
  assert.match(retryUnavailableReason({ retryEligible: true, modelId: 'GigaEmbeddings-3' }, registry) ?? '', /Исходная модель/);
  assert.equal(retryUnavailableReason({ retryEligible: true, modelId: 'GigaChat-3-Ultra' }, registry), null);
});

test('retry remains disabled after a quota response without changing the frozen model', () => {
  const registry = {
    state: 'ready' as const,
    modelIds: ['GigaChat-3-Ultra', 'GigaChat-3-Pro'],
    errorCategory: null,
    exhaustedModelIds: ['GigaChat-3-Ultra'],
  };
  assert.match(retryUnavailableReason({ retryEligible: true, modelId: 'GigaChat-3-Ultra' }, registry) ?? '', /Пул этой модели исчерпан/);
  const otherModelReason = retryUnavailableReason({ retryEligible: true, modelId: 'GigaChat-3-Pro' }, registry);
  assert.equal(otherModelReason, null,
    'another listed and verified current model remains available after a quota event for this exact ID');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('renderer close drains accepted operations and operations they start before reporting failure', async () => {
  const tracker = createRendererOperationTracker();
  const outer = deferred<void>();
  const inner = deferred<void>();
  let innerStarted = false;
  const accepted = tracker.track(async () => {
    await outer.promise;
    await tracker.track(() => {
      innerStarted = true;
      return inner.promise;
    });
  });
  const closing = tracker.freezeAndDrain();
  await Promise.resolve();
  assert.equal(tracker.frozen, true);
  assert.equal(innerStarted, false);
  outer.resolve();
  await Promise.resolve();
  assert.equal(innerStarted, true, 'accepted continuations may finish and join the close drain');
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  inner.resolve();
  await Promise.all([accepted, closing]);
  assert.equal(closeSettled, true);
});

test('renderer close waits for all accepted work before reporting a rejection and can resume', async () => {
  const tracker = createRendererOperationTracker();
  const failed = deferred<void>();
  const pending = deferred<void>();
  const failedOperation = tracker.track(() => failed.promise);
  const pendingOperation = tracker.track(() => pending.promise);
  const closing = tracker.freezeAndDrain();
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  failed.reject(new Error('accepted config save failed'));
  await assert.rejects(failedOperation, /accepted config save failed/);
  await Promise.resolve();
  assert.equal(closeSettled, false, 'a separate accepted operation must settle before close failure is shown');
  pending.resolve();
  await pendingOperation;
  await assert.rejects(closing, /accepted config save failed/);
  assert.equal(tracker.frozen, true, 'the page stays frozen until the user returns');
  tracker.resume();
  assert.equal(tracker.frozen, false);
  await tracker.track(() => undefined);
});
