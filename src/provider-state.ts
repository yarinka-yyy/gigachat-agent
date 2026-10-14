import { createHash } from 'node:crypto';

export interface ProviderStateOwner {
  readonly accountScope: string;
  readonly keyGeneration: number;
}

export interface ProviderStateScopeGuard {
  getGeneration(): number;
  isCurrent(generation: number): boolean;
}

function providerStateAuthError(): Error {
  return Object.assign(new Error('PROVIDER_AUTH'), { category: 'auth' as const });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

function scopeForKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export async function captureProviderStateOwner(
  guard: ProviderStateScopeGuard,
  loadAuthorizationKey: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<ProviderStateOwner> {
  const keyGeneration = guard.getGeneration();
  throwIfAborted(signal);
  if (!guard.isCurrent(keyGeneration)) throw providerStateAuthError();

  let key: string | null;
  try {
    key = await loadAuthorizationKey();
  } catch {
    throwIfAborted(signal);
    throw providerStateAuthError();
  }

  throwIfAborted(signal);
  if (!guard.isCurrent(keyGeneration) || typeof key !== 'string' || key.length === 0) {
    throw providerStateAuthError();
  }
  return Object.freeze({ accountScope: scopeForKey(key), keyGeneration });
}

export function assertProviderStateOwner(
  owner: ProviderStateOwner | undefined,
  guard: ProviderStateScopeGuard,
  signal?: AbortSignal,
): asserts owner is ProviderStateOwner {
  throwIfAborted(signal);
  if (!owner || typeof owner.accountScope !== 'string' || !/^[a-f0-9]{64}$/.test(owner.accountScope)
    || !Number.isSafeInteger(owner.keyGeneration) || owner.keyGeneration < 0
    || !guard.isCurrent(owner.keyGeneration)) {
    throw providerStateAuthError();
  }
}

export function assertAuthorizationKeyMatchesOwner(
  owner: ProviderStateOwner | undefined,
  key: string | null,
  guard: ProviderStateScopeGuard,
  signal?: AbortSignal,
): asserts key is string {
  assertProviderStateOwner(owner, guard, signal);
  if (typeof key !== 'string' || key.length === 0 || scopeForKey(key) !== owner.accountScope) {
    throw providerStateAuthError();
  }
  assertProviderStateOwner(owner, guard, signal);
}
