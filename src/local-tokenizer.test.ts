import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { countLocalTokenizerText, createLocalTextTokenCounter, LOCAL_TOKENIZER_MODEL_ID } from './local-tokenizer';

const appPath = resolve(__dirname, '..');
const devPaths = { appPath, isPackaged: false, resourcesPath: '' };

test('loads only the pinned Lite resources and counts the saved edge probes without special tokens', async () => {
  const counter = createLocalTextTokenCounter(devPaths);
  const texts = [
    '',
    '  space\tand\r\nline\t  ',
    '你好，世界。語言。',
    'cafe\u0301',
    'café',
    '👩‍👩‍👧‍👦',
    '<s>',
    '<|role_sep|>\n',
    '0123456789,?!;:...()[]{}',
  ];

  assert.deepEqual(await counter.countTextTokens(LOCAL_TOKENIZER_MODEL_ID, texts, new AbortController().signal),
    [0, 7, 8, 3, 3, 11, 1, 1, 18]);
});

test('rejects other models and packaged resources never fall back to development files', async () => {
  const missingResources = await mkdtemp(join(tmpdir(), 'gigachat-tokenizer-missing-'));
  try {
    const packaged = createLocalTextTokenCounter({ appPath, isPackaged: true, resourcesPath: missingResources });
    const missingDevelopmentAssets = createLocalTextTokenCounter({
      appPath: missingResources, isPackaged: false, resourcesPath: '',
    });
    await assert.rejects(packaged.countTextTokens('GigaChat-3-Pro', ['x'], new AbortController().signal),
      /LOCAL_TOKENIZER_UNAVAILABLE/);
    await assert.rejects(packaged.countTextTokens(LOCAL_TOKENIZER_MODEL_ID, ['x'], new AbortController().signal),
      /LOCAL_TOKENIZER_(?:UNAVAILABLE|RESOURCE_UNAVAILABLE)/);
    await assert.rejects(missingDevelopmentAssets.countTextTokens(LOCAL_TOKENIZER_MODEL_ID, ['x'], new AbortController().signal),
      /LOCAL_TOKENIZER_(?:UNAVAILABLE|RESOURCE_UNAVAILABLE)/);
  } finally {
    await rm(missingResources, { recursive: true, force: true });
  }
});

test('rejects a changed resource hash before attempting to load the native binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gigachat-tokenizer-invalid-'));
  const resourceDirectory = join(root, 'tokenizer');
  await mkdir(resourceDirectory);
  await writeFile(join(resourceDirectory, 'tokenizers.win32-x64-msvc.node'), Buffer.from('not a native addon'));
  await writeFile(join(resourceDirectory, 'tokenizer.json'), '{}');
  try {
    const packaged = createLocalTextTokenCounter({ appPath, isPackaged: true, resourcesPath: root });
    await assert.rejects(packaged.countTextTokens(LOCAL_TOKENIZER_MODEL_ID, ['x'], new AbortController().signal),
      /LOCAL_TOKENIZER_RESOURCE_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a cancelled queued request does not poison the serialized tokenizer queue', async () => {
  const counter = createLocalTextTokenCounter(devPaths);
  const controller = new AbortController();
  const cancelled = counter.countTextTokens(LOCAL_TOKENIZER_MODEL_ID, ['cancelled'], controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.deepEqual(await counter.countTextTokens(LOCAL_TOKENIZER_MODEL_ID, ['ready'], new AbortController().signal), [1]);
});

test('normalizes native encode failures but preserves cancellation and invalid counts', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(countLocalTokenizerText({
    encode: async () => { throw new Error('native encoder failed'); },
  }, 'x', signal), /LOCAL_TOKENIZER_UNAVAILABLE/);
  await assert.rejects(countLocalTokenizerText({
    encode: async () => ({ getLength: () => -1 }),
  }, 'x', signal), /LOCAL_TOKENIZER_COUNT_INVALID/);

  const controller = new AbortController();
  await assert.rejects(countLocalTokenizerText({
    encode: async () => { controller.abort(); throw new Error('native encoder failed during cancellation'); },
  }, 'x', controller.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
});
