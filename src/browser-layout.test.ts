import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserMaximumWidth, browserReleaseWidth, browserVisibleWidth, shouldSnapBrowserToFullOnLeftEdge } from './browser-layout';

test('browser preserves the 560px chat in split mode and fills a narrow overlay by default', () => {
  assert.equal(browserMaximumWidth(1200), 640);
  assert.equal(browserMaximumWidth(879), 879);
  assert.equal(browserVisibleWidth(1200, null), 420);
  assert.equal(browserVisibleWidth(900, 500), 340);
  assert.equal(browserVisibleWidth(800, null), 800);
  assert.equal(browserVisibleWidth(800, 520), 800);
  assert.equal(browserVisibleWidth(879, 420), 879);
  assert.equal(browserVisibleWidth(880, 420), 320);
});

test('release below 260 collapses; between 260 and 320 snaps to 320', () => {
  assert.equal(browserReleaseWidth(259, 1200), null);
  assert.equal(browserReleaseWidth(260, 1200), 320);
  assert.equal(browserReleaseWidth(900, 1200), 640);
});

test('browser edge snap uses the workspace origin and the first 12 CSS pixels', () => {
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(12, 13, 0, 1200, true), true);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(0, 1, 0, 1200, true), true);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(12.01, 13, 0, 1200, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(-0.01, 0, 0, 1200, true), true, 'captured movement can cross the edge between pointer events');
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(-10, 30, 0, 1200, true), true, 'a fast drag across the full hot zone still snaps');
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(-88, -87, -100, 1200, true), true);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(512, 513, 500, 1200, true), true);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(490, 510, 500, 1200, true), true, 'crossing a shifted workspace edge still snaps');
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(13, 14, 0, 1200, true), false, 'ordinary maximum-width clamp is not an edge snap');
});

test('browser edge snap requires an active leftward gesture in wide split mode', () => {
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(8, 9, 0, 1200, false), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(9, 8, 0, 1200, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(8, 8, 0, 1200, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(8, 9, 0, 879, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(8, 9, 0, 880, true), true);
});

test('browser edge snap rejects non-finite geometry', () => {
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(Number.NaN, 1, 0, 1200, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(1, Number.POSITIVE_INFINITY, 0, 1200, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(1, 2, Number.NaN, 1200, true), false);
  assert.equal(shouldSnapBrowserToFullOnLeftEdge(1, 2, 0, Number.POSITIVE_INFINITY, true), false);
});
