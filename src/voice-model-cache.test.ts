import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareVoiceModelCache } from './voice-model-cache';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'voice-model-cache-'));
  const source = join(root, 'resources');
  const profile = join(root, 'profile');
  await mkdir(source);
  await mkdir(profile);
  const bytes = Buffer.from('synthetic pinned model');
  const models = { runtimeVersion: '2.21.0', files: [{ name: 'encoder.onnx', sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }] };
  await writeFile(join(source, 'encoder.onnx'), bytes);
  return { root, source, profile, models, bytes };
}

test('profile staging copies pinned models once and keeps engine writes away from bundled resources', async () => {
  const f = await fixture();
  try {
    const cache = await prepareVoiceModelCache(f.profile, f.source, f.models);
    const copy = join(cache.modelDirectory, 'encoder.onnx');
    const before = await lstat(copy);
    assert.equal(before.nlink, 1);
    await writeFile(join(cache.cacheDirectory, 'encoder_optimized.ort'), 'synthetic optimized graph');
    const reused = await prepareVoiceModelCache(f.profile, f.source, f.models);
    assert.equal(reused.modelDirectory, cache.modelDirectory);
    assert.equal((await lstat(copy)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(join(reused.cacheDirectory, 'encoder_optimized.ort'), 'utf8'), 'synthetic optimized graph');
    await writeFile(copy, Buffer.alloc(f.bytes.length));
    assert.deepEqual(await readFile(join(f.source, 'encoder.onnx')), f.bytes, 'cached writes cannot mutate source');
    assert.deepEqual(await readdir(f.source), ['encoder.onnx']);
    await assert.rejects(prepareVoiceModelCache(f.profile, f.source, f.models), /checksum mismatch/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('runtime/model identity isolates versions and corrupt input never publishes a partial model directory', async () => {
  const f = await fixture();
  try {
    const first = await prepareVoiceModelCache(f.profile, f.source, f.models);
    const next = await prepareVoiceModelCache(f.profile, f.source, { ...f.models, runtimeVersion: 'next-pinned-version' });
    assert.notEqual(first.modelDirectory, next.modelDirectory);
    await assert.rejects(prepareVoiceModelCache(f.profile, f.source, {
      runtimeVersion: 'partial-copy',
      files: [...f.models.files, { name: 'missing.onnx', sizeBytes: 1, sha256: '0'.repeat(64) }],
    }), /ENOENT/);
    assert.equal((await readdir(join(f.profile, 'voice-cache'))).length, 2, 'failed partial staging is not published');
    await writeFile(join(f.source, 'encoder.onnx'), 'bad');
    await assert.rejects(prepareVoiceModelCache(f.profile, f.source, { ...f.models, runtimeVersion: 'invalid-input' }), /size mismatch/);
    assert.equal((await readdir(join(f.profile, 'voice-cache'))).length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('profile/cache junctions and hardlinked graph/model files are rejected before an engine write', async () => {
  const f = await fixture();
  try {
    await symlink(f.source, join(f.profile, 'voice-cache'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareVoiceModelCache(f.profile, f.source, f.models), /Unsafe/);
    await unlink(join(f.profile, 'voice-cache'));
    const cache = await prepareVoiceModelCache(f.profile, f.source, f.models);
    const graph = join(cache.cacheDirectory, 'encoder_optimized.ort');
    await link(join(f.source, 'encoder.onnx'), graph);
    await assert.rejects(cache.validate(), /Unsafe/);
    await unlink(graph);
    const copy = join(cache.modelDirectory, 'encoder.onnx');
    await unlink(copy);
    await link(join(f.source, 'encoder.onnx'), copy);
    await assert.rejects(prepareVoiceModelCache(f.profile, f.source, f.models), /Unsafe/);
    await unlink(copy);
    await writeFile(copy, f.bytes);
    await rm(cache.cacheDirectory, { recursive: true });
    await symlink(f.source, cache.cacheDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(cache.validate(), /Unsafe/);
    assert.deepEqual(await readdir(f.source), ['encoder.onnx']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
