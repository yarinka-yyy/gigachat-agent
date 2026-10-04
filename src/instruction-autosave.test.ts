import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstructionAutosave } from './instruction-autosave';
import type { InstructionSaveResult } from './contracts';
import { createInstructionDocument } from './instruction-documents';

test('flush saves the latest edit even when an older save is already running', async () => {
  const writes: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const initial = createInstructionDocument('global', '');
  const firstSaved = createInstructionDocument('global', 'первая');
  const autosave = createInstructionAutosave(async (_key, value, expectedRevision) => {
    assert.equal(expectedRevision, writes.length === 0 ? initial.revision : firstSaved.revision);
    if (value === 'первая') await firstWrite;
    writes.push(value);
    return { kind: 'saved', document: createInstructionDocument('global', value) };
  }, () => undefined, 60_000);

  autosave.load('global', initial);
  autosave.edit('global', 'первая');
  const flushing = autosave.flushAll();
  autosave.edit('global', 'последняя');
  releaseFirst?.();
  await flushing;
  assert.deepEqual(writes, ['первая', 'последняя']);
});

test('a revision conflict keeps the local buffer and stops autosave until reload', async () => {
  const statuses: string[] = [];
  let writes = 0;
  const current = createInstructionDocument('global', 'external edit');
  const conflict: InstructionSaveResult = { kind: 'conflict', phase: 'before-commit', current };
  const autosave = createInstructionAutosave(async () => {
    writes += 1;
    return conflict;
  }, (_key, status) => statuses.push(status), 60_000);

  autosave.load('global', createInstructionDocument('global', 'initial'));
  autosave.edit('global', 'local draft');
  await assert.rejects(autosave.flushAll(), /Разрешите конфликт/);
  const firstConflictStatus = statuses.indexOf('conflict');
  await assert.rejects(autosave.flush('global'), /Разрешите конфликт/);
  await assert.rejects(autosave.flushAll(), /Разрешите конфликт/);
  assert.equal(writes, 1);
  assert.equal(statuses.slice(firstConflictStatus).includes('saved'), false, 'a repeated flush must not clear the visible conflict');
  assert.equal(autosave.load('global', current), 'local draft');

  autosave.edit('global', 'new local draft');
  await assert.rejects(autosave.flushAll(), /Разрешите конфликт/);

  assert.equal(writes, 1);
  assert.ok(statuses.includes('conflict'));
  assert.equal(autosave.load('global', current), 'new local draft');
  assert.equal(autosave.reload('global', current), 'external edit');
});
