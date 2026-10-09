import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPermissionApprovals } from './permission-approvals';

const details = {
  resource: 'machine-files' as const,
  action: 'write' as const,
  target: 'C:\\Users\\fixture\\outside.txt',
  reason: 'Запись вне выбранного проекта.',
};

test('publishes the exact action and target and consumes approval only once', async () => {
  const published: Array<{ id: string; resource: string; action: string; target: string; reason: string; expiresAt: string }> = [];
  const approvals = createPermissionApprovals((request) => { published.push(request); }, 1000);
  const pending = approvals.request(details);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(published.length, 1);
  const request = published[0];
  assert.ok(request);
  assert.equal(request.resource, details.resource);
  assert.equal(request.action, details.action);
  assert.equal(request.target, details.target);
  assert.equal(request.reason, details.reason);
  assert.ok(Number.isFinite(Date.parse(request.expiresAt)));
  assert.equal(approvals.respond(request.id, true), true);
  assert.equal(await pending, true);
  assert.equal(approvals.respond(request.id, true), false);
  assert.equal(approvals.respond(request.id, 'yes'), false);
});

test('cancellation and timeout deny the pending request and prevent later reuse', async () => {
  const published: Array<{ id: string }> = [];
  const approvals = createPermissionApprovals((request) => { published.push(request); }, 20);
  const controller = new AbortController();
  const cancelled = approvals.request(details, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelledRequest = published[0];
  assert.ok(cancelledRequest);
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(approvals.respond(cancelledRequest.id, true), false);

  const timedOut = approvals.request(details);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const timedOutRequest = published[1];
  assert.ok(timedOutRequest);
  assert.equal(await timedOut, false);
  assert.equal(approvals.respond(timedOutRequest.id, true), false);
});

test('cancelAll rejects active and queued requests without publishing the queued request', async () => {
  const published: Array<{ id: string }> = [];
  const approvals = createPermissionApprovals((request) => { published.push(request); }, 1000);
  const active = approvals.request(details);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queued = approvals.request({ ...details, target: 'C:\\Users\\fixture\\second.txt' });
  approvals.cancelAll();

  assert.equal(await active, false);
  assert.equal(await queued, false);
  assert.equal(published.length, 1);
  assert.equal(approvals.respond(published[0]!.id, true), false);
});

test('captures approval details when a queued request is submitted', async () => {
  const published: Array<{ id: string; target: string }> = [];
  const approvals = createPermissionApprovals((request) => { published.push(request); }, 1000);
  const first = approvals.request(details);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queuedDetails = { ...details, target: 'C:\\Users\\fixture\\captured.txt' };
  const queued = approvals.request(queuedDetails);
  queuedDetails.target = 'C:\\Users\\fixture\\mutated.txt';

  assert.equal(approvals.respond(published[0]!.id, true), true);
  assert.equal(await first, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(published[1]?.target, 'C:\\Users\\fixture\\captured.txt');
  assert.equal(approvals.respond(published[1]!.id, true), true);
  assert.equal(await queued, true);
});
