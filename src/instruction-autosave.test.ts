import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstructionAutosave } from './instruction-autosave';

test('flush saves the latest edit even when an older save is already running', async () => {
  const writes: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const autosave = createInstructionAutosave(async (_key, value) => {
    if (value === 'первая') await firstWrite;
    writes.push(value);
  }, () => undefined, 60_000);

  autosave.load('global', '');
  autosave.edit('global', 'первая');
  const flushing = autosave.flushAll();
  autosave.edit('global', 'последняя');
  releaseFirst?.();
  await flushing;
  assert.deepEqual(writes, ['первая', 'последняя']);
});
