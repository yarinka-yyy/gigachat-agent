import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatDetail } from './contracts';
import { openStore } from './store';
import { loadGeneratedImageArtifact, writeGeneratedImageCopy, type GeneratedImageStore } from './image-artifacts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==', 'base64');

interface StoredFixture {
  root: string;
  store: Awaited<ReturnType<typeof openStore>>;
  chatId: string;
  artifactId: string;
  accountScope: string;
  imagePath: string;
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg';
}

async function createStoredImage(root: string, bytes: Buffer, contentType: StoredFixture['contentType']): Promise<StoredFixture> {
  const store = await openStore(root);
  const chat = await store.createChat(undefined, 'image');
  await store.updateChat(chat.id, { modelId: 'GigaChat-3-Ultra' });
  const accepted = await store.acceptLocalMessage(chat.id, 'Create a synthetic image.', randomUUID());
  const queued = await store.getChat(chat.id);
  const queuedTurn = queued.turns.find((turn) => turn.turnId === accepted.turn.turnId);
  assert.ok(queuedTurn);
  const artifactId = randomUUID();
  const accountScope = createHash('sha256').update(randomUUID()).digest('hex');
  const intent = {
    accountScope,
    chatId: chat.id,
    turnId: accepted.turn.turnId,
    anchorMessageId: accepted.turn.messageId,
    assistantMessageId: accepted.turn.assistantMessageId!,
    artifactId,
    modelId: accepted.turn.modelId!,
    createdAt: new Date().toISOString(),
    state: 'intent' as const,
    remoteFileId: null,
    contentType: null,
    sizeBytes: null,
    sha256: null,
  };
  await store.putProviderGeneratedImageEntry(intent);
  const remoteFileId = `synthetic-${randomUUID()}`;
  await store.putProviderGeneratedImageEntry({
    ...intent,
    state: 'generated',
    remoteFileId,
    contentType,
  });
  const downloaded = await store.stageGeneratedImage(accountScope, artifactId, bytes);
  const completed = {
    id: accepted.turn.turnId,
    chatId: chat.id,
    anchorMessageId: accepted.turn.messageId,
    assistantMessageId: accepted.turn.assistantMessageId!,
    modelId: accepted.turn.modelId,
    status: 'completed' as const,
    createdAt: queuedTurn.createdAt,
    endedAt: new Date().toISOString(),
    activity: [],
  };
  await store.appendAssistantMessageFromRuntime(accepted.turn, '', completed, undefined, undefined, accountScope, artifactId);

  await store.putProviderGeneratedImageEntry({ ...downloaded, state: 'cleanup-pending' });
  await store.removeProviderGeneratedImageEntry(accountScope, artifactId, remoteFileId);
  const reopened = await openStore(root);
  return {
    root,
    store: reopened,
    chatId: chat.id,
    artifactId,
    accountScope,
    imagePath: await reopened.getArtifactPath(chat.id, artifactId),
    bytes,
    contentType,
  };
}

function alteredStore(base: GeneratedImageStore, mutate: (detail: ChatDetail) => void): GeneratedImageStore {
  return {
    getChat: async (chatId) => {
      const detail = await base.getChat(chatId);
      mutate(detail);
      return detail;
    },
    getArtifactPath: (chatId, artifactId) => base.getArtifactPath(chatId, artifactId),
  };
}

async function verified(fixture: StoredFixture) {
  return loadGeneratedImageArtifact(fixture.store, fixture.chatId, fixture.artifactId, () => undefined);
}

test('owned generated PNG and JPEG load from reopened Store with exact bytes and hash', async (t) => {
  assert.equal(JPEG.byteLength, 631);
  assert.equal(createHash('sha256').update(JPEG).digest('hex'), 'cb3811c1599a9871648272ceaaa21982c7e92deabc367facea3a6941e9804a9b');
  for (const [label, bytes, contentType] of [
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
  ] as const) {
    await t.test(label, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `gigachat-image-access-${label}-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const fixture = await createStoredImage(root, bytes, contentType);
      let decodeCalls = 0;
      const loaded = await loadGeneratedImageArtifact(fixture.store, fixture.chatId, fixture.artifactId, (decoded, mime, dimensions) => {
        decodeCalls += 1;
        assert.deepEqual(decoded, bytes);
        assert.equal(mime, contentType);
        assert.deepEqual(dimensions, { width: 1, height: 1 });
      });
      assert.equal(decodeCalls, 1);
      assert.deepEqual(loaded.bytes, bytes);
      assert.equal(loaded.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(loaded.contentType, contentType);
      assert.equal(loaded.suggestedFileName, contentType === 'image/png' ? 'Изображение.png' : 'Изображение.jpg');
      assert.deepEqual(await readFile(fixture.imagePath), bytes);
      assert.deepEqual(await fixture.store.getProviderGeneratedImageEntries(fixture.accountScope), [], 'the loader does not depend on retained remote ownership');
    });
  }
});

test('loader rejects non-owned, malformed, truncated, and undecodable image artifacts without exposing paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-image-access-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createStoredImage(root, PNG, 'image/png');
  const base = fixture.store;
  const cases: Array<[string, (detail: ChatDetail) => void]> = [
    ['wrong-chat-kind', (detail) => { detail.kind = 'text'; }],
    ['example-assistant', (detail) => {
      const assistant = detail.messages.find((message) => message.id === detail.artifacts[0]!.messageId)!;
      assistant.source = 'example';
    }],
    ['assistant-with-user-role', (detail) => {
      const assistant = detail.messages.find((message) => message.id === detail.artifacts[0]!.messageId)!;
      assistant.role = 'user';
    }],
    ['missing-completed-turn', (detail) => { detail.turns[0]!.status = 'running'; }],
    ['hash-mismatch', (detail) => { detail.artifacts[0]!.sha256 = '0'.repeat(64); }],
    ['oversize-metadata', (detail) => { detail.artifacts[0]!.size = 15_000_001; }],
    ['missing-backlink', (detail) => { delete detail.messages.find((message) => message.id === detail.artifacts[0]!.messageId)!.attachmentIds; }],
    ['wrong-stored-extension', (detail) => { detail.artifacts[0]!.storedName = `${fixture.artifactId}.jpeg`; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      let pathLookups = 0;
      const viewed = alteredStore({
        getChat: (chatId) => base.getChat(chatId),
        getArtifactPath: async (chatId, artifactId) => { pathLookups += 1; return base.getArtifactPath(chatId, artifactId); },
      }, mutate);
      await assert.rejects(loadGeneratedImageArtifact(viewed, fixture.chatId, fixture.artifactId, () => undefined), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /недоступно или повреждено/i);
        assert.equal(error.message.includes(fixture.imagePath), false);
        return true;
      });
      if (label === 'oversize-metadata') assert.equal(pathLookups, 0);
    });
  }

  const otherChat = await base.createChat(undefined, 'text');
  await assert.rejects(loadGeneratedImageArtifact({
    getChat: async () => base.getChat(otherChat.id),
    getArtifactPath: (chatId, artifactId) => base.getArtifactPath(chatId, artifactId),
  }, fixture.chatId, fixture.artifactId, () => undefined), /недоступно или повреждено/i);

  const userImageChat = await base.createChat(undefined, 'image');
  const userSource = join(root, 'ordinary-user.png');
  await writeFile(userSource, PNG);
  const staged = await base.stageChatDraftFile(userImageChat.id, userSource);
  const userAttachment = staged.draftAttachments[0];
  assert.ok(userAttachment);
  const acceptedUser = await base.acceptLocalMessage(userImageChat.id, 'A user attached this image.', randomUUID(), [userAttachment.id]);
  const linkedUserArtifact = acceptedUser.detail.artifacts.find((artifact) => artifact.id === userAttachment.id);
  const linkedUserMessage = acceptedUser.detail.messages.find((message) => message.id === linkedUserArtifact?.messageId);
  assert.equal(linkedUserMessage?.role, 'user');
  assert.deepEqual(linkedUserMessage?.attachmentIds, [userAttachment.id]);
  assert.deepEqual(await readFile(await base.getArtifactPath(userImageChat.id, userAttachment.id)), PNG);
  await assert.rejects(loadGeneratedImageArtifact(base, userImageChat.id, userAttachment.id, () => undefined), /недоступно или повреждено/i);

  const original = await readFile(fixture.imagePath);
  await writeFile(fixture.imagePath, original.subarray(0, original.length - 1));
  await assert.rejects(verified(fixture), /недоступно или повреждено/i);
  await writeFile(fixture.imagePath, original);
  await assert.rejects(loadGeneratedImageArtifact(base, fixture.chatId, fixture.artifactId, () => { throw new Error('native decode rejected'); }), /недоступно или повреждено/i);
  assert.deepEqual(await readFile(fixture.imagePath), original);

  const outside = join(root, 'outside.png');
  await writeFile(outside, original);
  await rm(fixture.imagePath);
  await symlink(outside, fixture.imagePath, 'file');
  await assert.rejects(verified(fixture), /недоступно или повреждено/i);
  await rm(fixture.imagePath);
  await writeFile(fixture.imagePath, original);
});

test('export writes exact original bytes, safely replaces, and retains the destination on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-image-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, 'user-data');
  const exports = join(root, 'exports');
  await mkdir(storage);
  await mkdir(exports);
  const fixture = await createStoredImage(storage, JPEG, 'image/jpeg');
  const image = await verified(fixture);
  const options = { protectedRoots: [storage] };
  const destination = join(exports, 'saved-image.jpg');

  await writeGeneratedImageCopy(image, destination, options);
  assert.deepEqual(await readFile(destination), JPEG);
  assert.deepEqual(await readFile(fixture.imagePath), JPEG);

  await writeFile(destination, Buffer.from('old user-selected copy'));
  await writeGeneratedImageCopy(image, destination, options);
  assert.deepEqual(await readFile(destination), JPEG);

  const previousDestination = Buffer.from('preserve this destination');
  await writeFile(destination, previousDestination);
  await assert.rejects(writeGeneratedImageCopy(image, destination, {
    ...options,
    renameFile: async () => { throw new Error('injected pre-rename failure'); },
  }), /безопасно сохранить/i);
  assert.deepEqual(await readFile(destination), previousDestination);
  assert.deepEqual(await readFile(fixture.imagePath), JPEG);
  assert.deepEqual(await readdir(exports), ['saved-image.jpg'], 'the failed operation removes only its own temporary file');

  await assert.rejects(writeGeneratedImageCopy(image, fixture.imagePath, options), /безопасно сохранить/i);
  await assert.rejects(writeGeneratedImageCopy(image, join(storage, 'inside.jpg'), options), /безопасно сохранить/i);
  assert.deepEqual(await readFile(fixture.imagePath), JPEG);
  await assert.rejects(writeGeneratedImageCopy(image, join(exports, 'wrong.png'), options), /безопасно сохранить/i);

  const junction = join(root, 'user-data-junction');
  await symlink(storage, junction, 'junction');
  await assert.rejects(writeGeneratedImageCopy(image, join(junction, 'junction-copy.jpg'), options), /безопасно сохранить/i);
  const hardLinkTarget = join(exports, 'same-original.jpg');
  await link(fixture.imagePath, hardLinkTarget);
  await assert.rejects(writeGeneratedImageCopy(image, hardLinkTarget, options), /безопасно сохранить/i);
  assert.deepEqual(await readFile(hardLinkTarget), JPEG);
  await rm(hardLinkTarget);
  assert.deepEqual(await readFile(fixture.imagePath), JPEG);

  const directoryTarget = join(exports, 'folder.jpg');
  await mkdir(directoryTarget);
  await assert.rejects(writeGeneratedImageCopy(image, directoryTarget, options), /безопасно сохранить/i);
});

test('export refuses a symlink destination and leaves its target untouched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-image-export-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, 'user-data');
  const exports = join(root, 'exports');
  await mkdir(storage);
  await mkdir(exports);
  const fixture = await createStoredImage(storage, PNG, 'image/png');
  const image = await verified(fixture);
  const outside = join(root, 'outside.png');
  const destination = join(exports, 'link.png');
  const bytes = Buffer.from('do not replace symlink target');
  await writeFile(outside, bytes);
  await symlink(outside, destination, 'file');

  await assert.rejects(writeGeneratedImageCopy(image, destination, { protectedRoots: [storage] }), /безопасно сохранить/i);
  assert.deepEqual(await readFile(outside), bytes);
  assert.deepEqual(await readFile(fixture.imagePath), PNG);
});
