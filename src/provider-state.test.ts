import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createBalanceScopeGuard } from './usage-view';
import {
  assertAuthorizationKeyMatchesOwner,
  assertProviderStateOwner,
  captureProviderStateOwner,
} from './provider-state';

function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && error.message === 'PROVIDER_AUTH'
    && 'category' in error && error.category === 'auth';
}

test('captures a frozen owner from the exact loaded key without retaining the key', async () => {
  const guard = createBalanceScopeGuard();
  const key = 'synthetic-runtime-key Ω';
  const owner = await captureProviderStateOwner(guard, async () => key);

  assert.deepEqual(owner, {
    accountScope: createHash('sha256').update(key, 'utf8').digest('hex'),
    keyGeneration: 0,
  });
  assert.equal(Object.isFrozen(owner), true);
  assert.equal(JSON.stringify(owner).includes(key), false);
  assertProviderStateOwner(owner, guard);
  assertAuthorizationKeyMatchesOwner(owner, key, guard);
});

test('missing or unreadable keys fail with a fixed authentication error', async () => {
  const guard = createBalanceScopeGuard();
  await assert.rejects(captureProviderStateOwner(guard, async () => null), isAuthFailure);
  await assert.rejects(captureProviderStateOwner(guard, async () => {
    throw new Error('synthetic private-key sentinel');
  }), (error: unknown) => isAuthFailure(error)
    && !String((error as Error).message).includes('synthetic private-key sentinel'));
});

test('a key generation transition during asynchronous capture invalidates the captured request', async () => {
  const guard = createBalanceScopeGuard();
  let resolveKey!: (key: string) => void;
  const pendingKey = new Promise<string>((resolve) => { resolveKey = resolve; });
  const capture = captureProviderStateOwner(guard, () => pendingKey);
  const finishTransition = guard.beginTransition();
  finishTransition();
  resolveKey('synthetic-key-A');

  await assert.rejects(capture, isAuthFailure);
});

test('same-key saves and A-to-B-to-A transitions never revive an old generation', async () => {
  const guard = createBalanceScopeGuard();
  const keyA = 'synthetic-key-A';
  const ownerA = await captureProviderStateOwner(guard, async () => keyA);

  const finishSameKeySave = guard.beginTransition();
  finishSameKeySave();
  assert.throws(() => assertProviderStateOwner(ownerA, guard), isAuthFailure);

  const ownerAfterSameKeySave = await captureProviderStateOwner(guard, async () => keyA);
  const finishKeyB = guard.beginTransition();
  finishKeyB();
  const finishKeyA = guard.beginTransition();
  finishKeyA();
  assert.throws(() => assertProviderStateOwner(ownerAfterSameKeySave, guard), isAuthFailure);
  assertProviderStateOwner(await captureProviderStateOwner(guard, async () => keyA), guard);
});

test('key mismatch and an aborted signal reject before use', async () => {
  const guard = createBalanceScopeGuard();
  const owner = await captureProviderStateOwner(guard, async () => 'synthetic-key-A');
  assert.throws(() => assertAuthorizationKeyMatchesOwner(owner, 'synthetic-key-B', guard), isAuthFailure);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureProviderStateOwner(guard, async () => 'synthetic-key-A', controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.throws(() => assertProviderStateOwner(owner, guard, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
});
