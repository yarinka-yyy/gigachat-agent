import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSecureStore, type AsyncSafeStorage } from './secure-store';

function fakeSafeStorage(): AsyncSafeStorage {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plainText) => Buffer.from(Buffer.from(plainText, 'utf8').toString('base64'), 'ascii'),
    decryptStringAsync: async (encrypted) => ({
      result: Buffer.from(encrypted.toString('ascii'), 'base64').toString('utf8'),
      shouldReEncrypt: false,
    }),
  };
}

test('secure store persists only encrypted bytes and recovers through OS storage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = 'synthetic-qa-key-not-a-credential';
  const first = createSecureStore(directory, fakeSafeStorage());

  await first.save(secret);
  const file = await readFile(join(directory, 'secrets', 'authorization-key.bin'));
  assert.equal(file.includes(Buffer.from(secret)), false);
  assert.deepEqual(await first.status(), { available: true, saved: true, usable: true });
  assert.equal(await createSecureStore(directory, fakeSafeStorage()).load(), secret);
});

test('secure store fails closed when OS encryption is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSecureStore(directory, {
    ...fakeSafeStorage(),
    isAsyncEncryptionAvailable: async () => false,
  });

  await assert.rejects(store.save('synthetic-qa-key'), /недоступно/);
  assert.deepEqual(await store.status(), { available: false, saved: false, usable: false });
});

test('failed encryption leaves the previously saved secret intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-preserve-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failEncryption = false;
  const adapter = {
    ...fakeSafeStorage(),
    encryptStringAsync: async (plainText: string) => {
      if (failEncryption) throw new Error('synthetic encryption failure');
      return Buffer.from(Buffer.from(plainText, 'utf8').toString('base64'), 'ascii');
    },
  };
  const store = createSecureStore(directory, adapter);
  await store.save('first-synthetic-key');
  failEncryption = true;

  await assert.rejects(store.save('second-synthetic-key'), /зашифровать ключ/);
  assert.equal(await store.load(), 'first-synthetic-key');
});

test('corrupt secure-store data is rejected without replacing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'secrets', 'authorization-key.bin');
  await mkdir(join(directory, 'secrets'), { recursive: true });
  const corrupt = Buffer.from('not encrypted key data');
  await writeFile(filePath, corrupt);
  const store = createSecureStore(directory, fakeSafeStorage());

  await assert.rejects(store.load(), /повреждён/);
  assert.deepEqual(await store.status(), { available: true, saved: true, usable: false });
  assert.deepEqual(await readFile(filePath), corrupt);
});

test('secure store rejects a junctioned secrets directory without touching its target', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-junction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appData = join(directory, 'app-data');
  const outside = join(directory, 'outside');
  await mkdir(appData);
  await mkdir(outside);
  const sentinel = join(outside, 'authorization-key.bin');
  await writeFile(sentinel, 'outside-sentinel');
  await symlink(outside, join(appData, 'secrets'), 'junction');
  const store = createSecureStore(appData, fakeSafeStorage());

  await assert.rejects(store.save('synthetic-qa-key'), /ссылкой/);
  await assert.rejects(store.load(), /ссылкой/);
  await assert.rejects(store.status(), /ссылкой/);
  await assert.rejects(store.clear(), /ссылкой/);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside-sentinel');
});

test('secure store rejects a junctioned user-data root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-root-junction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outside = join(directory, 'outside');
  const linkedRoot = join(directory, 'linked-data');
  await mkdir(outside);
  await symlink(outside, linkedRoot, 'junction');
  const store = createSecureStore(linkedRoot, fakeSafeStorage());

  await assert.rejects(store.save('synthetic-qa-key'), /недоступен/);
  await assert.rejects(store.status(), /недоступен/);
  assert.deepEqual(await readdir(outside), []);
});

test('serialized concurrent saves keep the last submitted value', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-secure-store-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createSecureStore(directory, fakeSafeStorage());

  await Promise.all([store.save('first-synthetic-key'), store.save('last-synthetic-key')]);
  assert.equal(await store.load(), 'last-synthetic-key');
});
