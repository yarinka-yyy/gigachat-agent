import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHomeDraftSaveQueue, mergeHomeDraftPersistence } from './composer-draft';

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => { resolve = done; }),
    resolve(value: T) { resolve(value); },
  };
}

test('home draft writes serialize revisions and close flush waits through the latest save', async () => {
  const first = deferred<{ revision: number; text: string }>();
  const writes: Array<{ revision: number; text: string }> = [];
  const queue = createHomeDraftSaveQueue(async (snapshot: { revision: number; text: string }) => {
    writes.push(snapshot);
    return snapshot.revision === 1 ? first.promise : snapshot;
  });
  const firstWrite = queue.enqueue({ revision: 1, text: 'a' });
  const latestWrite = queue.enqueue({ revision: 2, text: 'a'.repeat(101) });
  let flushed = false;
  const closing = queue.flush().then(() => { flushed = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [{ revision: 1, text: 'a' }]);
  assert.equal(flushed, false, 'close must wait while an earlier serialized write is unsettled');
  first.resolve({ revision: 1, text: 'a' });
  await Promise.all([firstWrite, latestWrite, closing]);

  assert.deepEqual(writes, [
    { revision: 1, text: 'a' },
    { revision: 2, text: 'a'.repeat(101) },
  ]);
  assert.equal(flushed, true);
  await assert.rejects(queue.enqueue({ revision: 2, text: 'stale' }), /Ревизия|устарела/i);
});

test('queued draft snapshot is frozen at enqueue while an earlier write is pending', async () => {
  const first = deferred<{ revision: number; text: string }>();
  const writes: Array<{ revision: number; text: string }> = [];
  const queue = createHomeDraftSaveQueue(async (snapshot: { revision: number; text: string }) => {
    writes.push(snapshot);
    return snapshot.revision === 1 ? first.promise : snapshot;
  });
  const firstWrite = queue.enqueue({ revision: 1, text: 'first' });
  const queued = { revision: 2, text: 'accepted' };
  const secondWrite = queue.enqueue(queued);
  queued.text = 'later mutation';
  first.resolve({ revision: 1, text: 'first' });

  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(writes, [
    { revision: 1, text: 'first' },
    { revision: 2, text: 'accepted' },
  ]);
});

test('a failed autosave does not prevent the next draft revision from being saved', async () => {
  const writes: number[] = [];
  const queue = createHomeDraftSaveQueue(async (snapshot: { revision: number }) => {
    writes.push(snapshot.revision);
    if (snapshot.revision === 1) throw new Error('disk unavailable');
    return snapshot;
  });
  await assert.rejects(queue.enqueue({ revision: 1 }), /disk unavailable/);
  assert.deepEqual(await queue.enqueue({ revision: 2 }), { revision: 2 });
  await queue.flush();
  assert.deepEqual(writes, [1, 2]);
});

test('a completed file import can advance the persisted revision without admitting an older queued edit', async () => {
  const writes: number[] = [];
  const queue = createHomeDraftSaveQueue(async (snapshot: { revision: number }) => {
    writes.push(snapshot.revision);
    return snapshot;
  });
  await queue.enqueue({ revision: 1 });
  await queue.synchronize(2);
  await assert.rejects(queue.enqueue({ revision: 2 }), /Ревизия|устарела/i);
  await queue.enqueue({ revision: 3 });
  await queue.flush();
  assert.deepEqual(writes, [1, 3]);
});

test('a delayed save response cannot replace later text or selection with its older snapshot', () => {
  const local: { revision: number; text: string; projectId: string | null; attachments: Array<{ id: string }> } = {
    revision: 2, text: 'draft B', projectId: 'project-b', attachments: [{ id: 'file-1' }],
  };
  const persisted: typeof local = { revision: 1, text: 'draft A', projectId: null, attachments: [{ id: 'file-1' }] };
  assert.deepEqual(mergeHomeDraftPersistence(local, persisted), local);
  assert.deepEqual(mergeHomeDraftPersistence(local, { ...persisted, revision: 3, text: '' }), { ...persisted, revision: 3, text: '' });
});
