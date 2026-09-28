import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewExitTimer, maxSidebarWidth } from './sidebar-behavior';

test('sidebar leaves the composer and chat minimum width before its 440px cap', () => {
  assert.equal(maxSidebarWidth(1600, 900), 440);
  assert.equal(maxSidebarWidth(1200, 900), 268);
  assert.equal(maxSidebarWidth(944, 500), 364);
});

test('entering the preview cancels closing; leaving and window blur clear the delay', () => {
  const callbacks = new Map<number, () => void>();
  let nextId = 0;
  let closed = 0;
  const timer = createPreviewExitTimer((callback, delay) => {
    assert.equal(delay, 300);
    callbacks.set(++nextId, callback);
    return nextId;
  }, (id) => { callbacks.delete(id); });
  timer.schedule(() => { closed++; });
  timer.clear();
  assert.equal(callbacks.size, 0);
  timer.schedule(() => { closed++; });
  const callback = callbacks.get(nextId);
  callbacks.delete(nextId);
  callback?.();
  assert.equal(closed, 1);
  timer.schedule(() => { closed++; });
  timer.clear();
  assert.equal(callbacks.size, 0);
  assert.equal(closed, 1);
});
