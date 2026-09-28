import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserMaximumWidth, browserReleaseWidth, browserVisibleWidth } from './browser-layout';

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
