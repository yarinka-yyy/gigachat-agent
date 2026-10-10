import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatForDraftSession, createNewChatDraftSession, createRendererOperationTracker, retryUnavailableReason, shouldOpenCreatedDraftChat } from './renderer-operations';

test('retry availability requires the frozen original model in the ready registry', () => {
  const turn = { retryEligible: true, modelId: 'original/model' };
  assert.match(retryUnavailableReason(turn, { state: 'unavailable', modelIds: [], errorCategory: null }) ?? '', /Подключите API/);
  assert.match(retryUnavailableReason(turn, { state: 'error', modelIds: [], errorCategory: 'network' }) ?? '', /обновить список/);
  assert.match(retryUnavailableReason(turn, { state: 'ready', modelIds: ['changed/composer'], errorCategory: null }) ?? '', /Исходная модель/);
  assert.equal(retryUnavailableReason(turn, { state: 'ready', modelIds: ['original/model', 'changed/composer'], errorCategory: null }), null);
  assert.match(retryUnavailableReason({ retryEligible: true, modelId: null }, { state: 'ready', modelIds: ['changed/composer'], errorCategory: null }) ?? '', /не указана/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a pending home draft persists its latest text and project to its own chat', async () => {
  const creation = deferred<{ id: string; projectId: string | null }>();
  const session = createNewChatDraftSession<string>({
    text: 'first draft', projectId: 'project-a', permissionProfile: 'ask', skillId: 'global/one',
  });
  const createdWith: Array<string | null> = [];
  const moved: Array<{ id: string; projectId: string | null }> = [];
  const savedDrafts: Array<{ id: string; text: string }> = [];
  const savedSelections: Array<{ id: string; projectId: string | null; profile: string | null; skill: string | null }> = [];
  const result = createChatForDraftSession(
    session,
    (projectId) => { createdWith.push(projectId); return creation.promise; },
    async (id, projectId) => { moved.push({ id, projectId }); return { id, projectId }; },
    async (id, text) => { savedDrafts.push({ id, text }); },
    async (id, snapshot) => { savedSelections.push({
      id, projectId: snapshot.projectId, profile: snapshot.permissionProfile, skill: snapshot.skillId,
    }); },
  );

  session.text = 'latest draft';
  session.projectId = 'project-b';
  session.permissionProfile = 'allow-read';
  session.skillId = 'project/two';
  creation.resolve({ id: 'chat-a', projectId: 'project-a' });

  assert.deepEqual(await result, { id: 'chat-a', projectId: 'project-b' });
  assert.deepEqual(createdWith, ['project-a']);
  assert.deepEqual(moved, [{ id: 'chat-a', projectId: 'project-b' }]);
  assert.deepEqual(savedDrafts, [{ id: 'chat-a', text: 'latest draft' }]);
  assert.deepEqual(savedSelections, [{ id: 'chat-a', projectId: 'project-b', profile: 'allow-read', skill: 'project/two' }]);
  assert.equal(session.permissionProfile, 'allow-read');
  assert.equal(session.skillId, 'project/two');
});

test('a draft changed while its project move is pending is saved with the final session', async () => {
  let releaseMove!: (chat: { id: string; projectId: string | null }) => void;
  const session = createNewChatDraftSession<string>({
    text: 'before move', projectId: 'project-b', permissionProfile: 'ask', skillId: 'global/one',
  });
  const savedDrafts: string[] = [];
  const savedSelections: Array<{ projectId: string | null; permissionProfile: string | null; skillId: string | null }> = [];
  let moveCalls = 0;
  const moving = createChatForDraftSession(
    session,
    async (): Promise<{ id: string; projectId: string | null }> => ({ id: 'chat-a', projectId: 'project-a' }),
    async (id, projectId) => {
      moveCalls += 1;
      if (moveCalls > 1) return { id, projectId };
      return new Promise((resolve) => {
        releaseMove = (chat) => resolve({ id: chat.id, projectId: chat.projectId });
      });
    },
    async (_id, text) => { savedDrafts.push(text); },
    async (_id, snapshot) => { savedSelections.push({
      projectId: snapshot.projectId, permissionProfile: snapshot.permissionProfile, skillId: snapshot.skillId,
    }); },
  );

  await new Promise((resolve) => setImmediate(resolve));
  session.text = 'after move';
  session.projectId = 'project-c';
  session.permissionProfile = 'allow-read';
  session.skillId = 'project/three';
  releaseMove({ id: 'chat-a', projectId: 'project-b' });

  assert.deepEqual(await moving, { id: 'chat-a', projectId: 'project-c' });
  assert.deepEqual(savedDrafts, ['before move', 'after move']);
  assert.deepEqual(savedSelections, [
    { projectId: 'project-b', permissionProfile: 'ask', skillId: 'global/one' },
    { projectId: 'project-c', permissionProfile: 'allow-read', skillId: 'project/three' },
  ]);
});

test('a completed stale draft session cannot take over a newer home route', () => {
  const older = createNewChatDraftSession({ text: 'A', projectId: null, permissionProfile: null, skillId: null });
  const newer = createNewChatDraftSession({ text: 'B', projectId: 'project-b', permissionProfile: null, skillId: null });

  assert.equal(shouldOpenCreatedDraftChat(older, newer, true), false);
  assert.equal(shouldOpenCreatedDraftChat(older, older, false), false);
  assert.equal(shouldOpenCreatedDraftChat(older, older, true), true);
});

test('renderer close drains accepted operations and operations they start before reporting failure', async () => {
  const tracker = createRendererOperationTracker();
  const outer = deferred<void>();
  const inner = deferred<void>();
  let innerStarted = false;
  const accepted = tracker.track(async () => {
    await outer.promise;
    await tracker.track(() => {
      innerStarted = true;
      return inner.promise;
    });
  });
  const closing = tracker.freezeAndDrain();
  await Promise.resolve();
  assert.equal(tracker.frozen, true);
  assert.equal(innerStarted, false);
  outer.resolve();
  await Promise.resolve();
  assert.equal(innerStarted, true, 'accepted continuations may finish and join the close drain');
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  inner.resolve();
  await Promise.all([accepted, closing]);
  assert.equal(closeSettled, true);
});

test('renderer close waits for all accepted work before reporting a rejection and can resume', async () => {
  const tracker = createRendererOperationTracker();
  const failed = deferred<void>();
  const pending = deferred<void>();
  const failedOperation = tracker.track(() => failed.promise);
  const pendingOperation = tracker.track(() => pending.promise);
  const closing = tracker.freezeAndDrain();
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  failed.reject(new Error('accepted config save failed'));
  await assert.rejects(failedOperation, /accepted config save failed/);
  await Promise.resolve();
  assert.equal(closeSettled, false, 'a separate accepted operation must settle before close failure is shown');
  pending.resolve();
  await pendingOperation;
  await assert.rejects(closing, /accepted config save failed/);
  assert.equal(tracker.frozen, true, 'the page stays frozen until the user returns');
  tracker.resume();
  assert.equal(tracker.frozen, false);
  await tracker.track(() => undefined);
});
