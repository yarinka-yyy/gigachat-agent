import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../resources/voice');
const resourcesDirectory = process.env.GIGACHAT_VOICE_RESOURCES || sourceDirectory;
const sourceManifest = JSON.parse(await readFile(join(sourceDirectory, 'manifest.json'), 'utf8'));

async function verifyFile(directory, asset) {
  assert.ok(asset, 'Silero VAD must declare its distributed license file');
  assert.match(asset.name, /^[A-Za-z0-9_.-]+$/);
  const path = join(directory, asset.name);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${asset.name} must be a regular file`);
  assert.equal(info.size, asset.sizeBytes, `${asset.name} size`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), asset.sha256, `${asset.name} SHA-256`);
}

test('distributed voice resources include all pinned assets and the complete Silero MIT notice', async () => {
  const manifest = JSON.parse(await readFile(join(resourcesDirectory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, sourceManifest, 'Distribution must preserve the pinned manifest');
  const license = manifest.vad.licenseFile;
  await verifyFile(resourcesDirectory, license);
  const text = await readFile(join(resourcesDirectory, license.name), 'utf8');
  assert.ok(text.includes('Copyright (c) 2020-present Silero Team'));
  assert.ok(text.includes('Permission is hereby granted, free of charge'));
  assert.ok(text.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
  const assets = [...manifest.runtime.files, ...manifest.recognition.files, manifest.vad.file, license];
  for (const asset of assets) await verifyFile(resourcesDirectory, asset);
  assert.deepEqual((await readdir(resourcesDirectory)).sort(), ['manifest.json', ...assets.map((asset) => asset.name)].sort());
});

test('missing and altered Silero notices fail distribution verification', async (t) => {
  const license = sourceManifest.vad.licenseFile;
  assert.ok(license, 'Silero VAD must declare its distributed license file');
  const fixture = await mkdtemp(join(tmpdir(), 'gigachat-voice-notice-'));
  t.after(async () => {
    await rm(join(fixture, license.name), { force: true });
    await rmdir(fixture);
  });
  await assert.rejects(verifyFile(fixture, license), { code: 'ENOENT' });
  const bytes = await readFile(join(sourceDirectory, license.name));
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  await writeFile(join(fixture, license.name), altered);
  await assert.rejects(verifyFile(fixture, license), /SHA-256/);
  await writeFile(join(fixture, license.name), bytes);
  await verifyFile(fixture, license);
});
