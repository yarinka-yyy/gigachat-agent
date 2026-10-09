import { randomUUID } from 'node:crypto';
import type { PermissionApprovalRequest } from './contracts';

export function createPermissionApprovals(
  publish: (request: PermissionApprovalRequest) => void,
  timeoutMs = 60_000,
) {
  const pending = new Map<string, (allowed: boolean) => void>();
  let tail: Promise<void> = Promise.resolve();
  let generation = 0;
  return {
    request: (details: Omit<PermissionApprovalRequest, 'id' | 'expiresAt'>, signal?: AbortSignal): Promise<boolean> => {
      const snapshot = Object.freeze({
        resource: details.resource,
        action: details.action,
        target: details.target,
        reason: details.reason,
      });
      const requestedGeneration = generation;
      const result = tail.then(() => requestedGeneration === generation ? ask(snapshot, signal) : false);
      tail = result.then(() => undefined);
      return result;
    },
    respond: (id: unknown, allowed: unknown): boolean => {
      if (typeof id !== 'string' || typeof allowed !== 'boolean') return false;
      const finish = pending.get(id);
      if (!finish) return false;
      finish(allowed);
      return true;
    },
    cancelAll: (): void => {
      generation++;
      for (const finish of [...pending.values()]) finish(false);
    },
  };

  function ask(details: Omit<PermissionApprovalRequest, 'id' | 'expiresAt'>, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const request = { ...details, id, expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
      const finish = (allowed: boolean): void => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(allowed);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      pending.set(id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      try { publish(request); } catch { finish(false); }
    });
  }
}
