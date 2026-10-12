export interface HomeDraftRevision {
  revision: number;
}

export function mergeHomeDraftPersistence<T extends HomeDraftRevision>(local: T, persisted: T): T {
  if (local.revision <= persisted.revision) return structuredClone(persisted);
  return { ...structuredClone(persisted), ...structuredClone(local), revision: local.revision };
}

export function createHomeDraftSaveQueue<T extends HomeDraftRevision>(save: (snapshot: T) => Promise<T>) {
  let queuedRevision = 0;
  let tail: Promise<void> = Promise.resolve();
  let latest: Promise<unknown> = Promise.resolve();

  return {
    enqueue(snapshot: T): Promise<T> {
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision <= queuedRevision) {
        return Promise.reject(new Error('Ревизия домашнего черновика устарела.'));
      }
      queuedRevision = snapshot.revision;
      const acceptedSnapshot = structuredClone(snapshot);
      const operation = tail.then(() => save(acceptedSnapshot));
      latest = operation;
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async flush(): Promise<void> {
      await tail;
      await latest;
    },
    async synchronize(revision: number): Promise<void> {
      await tail;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Ревизия домашнего черновика некорректна.');
      queuedRevision = revision;
      latest = Promise.resolve();
    },
  };
}
