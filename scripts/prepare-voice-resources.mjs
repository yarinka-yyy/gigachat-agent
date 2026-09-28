import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDirectory = join(appRoot, 'resources', 'voice');
const manifestPath = join(resourcesDirectory, 'manifest.json');
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_HTTP_REDIRECTS = 8;
const allowedHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com']);

if (process.platform !== 'win32') {
  process.stdout.write('Skipping Windows-only voice resources.\n');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('Voice resources are pinned for Windows x64 builds only.');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.formatVersion !== 1 || manifest.runtime?.name !== 'gigastt' || manifest.runtime?.version !== '2.21.0'
  || manifest.recognition?.variant !== 'e2e_rnnt' || manifest.vad?.version !== '5.1.2') {
  throw new Error('The pinned voice resource manifest is invalid.');
}

await mkdir(resourcesDirectory, { recursive: true });
const rootStat = await lstat(resourcesDirectory);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Voice resource directory must be a regular directory.');
const canonicalResourcesDirectory = await realpath(resourcesDirectory);

async function removeStageDirectory(path, expectedName) {
  if (resolve(dirname(path)) !== resolve(resourcesDirectory) || !new RegExp(`^\\.stage-[0-9a-f-]{36}$`).test(expectedName)) {
    throw new Error('Refusing to clean a path outside the generated voice staging area.');
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path).then(dirname) !== canonicalResourcesDirectory) {
    throw new Error('Generated voice staging path is not a regular child directory.');
  }

  const removeRegularFile = async (filePath) => {
    const fileInfo = await lstat(filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Unexpected file type in generated voice staging area.');
    await rm(filePath);
  };
  for (const name of await readdir(path)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Unexpected name in generated voice staging area.');
    const childPath = join(path, name);
    const childInfo = await lstat(childPath);
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink() && name === 'extract') {
      const extractPath = await realpath(childPath);
      if (dirname(extractPath) !== await realpath(path)) throw new Error('Extracted voice staging directory escaped its parent.');
      for (const extractedName of await readdir(childPath)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(extractedName)) throw new Error('Unexpected extracted voice resource name.');
        await removeRegularFile(join(childPath, extractedName));
      }
      await rmdir(childPath);
    } else if (childInfo.isFile() && !childInfo.isSymbolicLink()) {
      await removeRegularFile(childPath);
    } else {
      throw new Error('Unexpected directory or reparse point in generated voice staging area.');
    }
  }
  await rmdir(path);
}

for (const name of await readdir(resourcesDirectory)) {
  if (!/^\.stage-[0-9a-f-]{36}$/.test(name)) continue;
  await removeStageDirectory(join(resourcesDirectory, name), name);
}

const buildId = randomUUID();
const stageName = `.stage-${buildId}`;
const stageDirectory = join(resourcesDirectory, stageName);
await mkdir(stageDirectory);
const temporaryFiles = new Set();

function validateAsset(asset) {
  if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(asset.name)
    || !digestPattern.test(asset.sha256) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
    throw new Error('Voice resource manifest contains an invalid file entry.');
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes: size, sha256: hash.digest('hex') };
}

async function isVerified(path, expected) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const actual = await hashFile(path);
    return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function fetchResponse(urlInput) {
  let url = new URL(urlInput);
  if (!allowedHosts.has(url.hostname)) throw new Error('Voice resource URL host is not pinned.');
  for (let redirects = 0; redirects <= MAX_HTTP_REDIRECTS; redirects += 1) {
    if (url.protocol !== 'https:') throw new Error('Voice resource URL must use HTTPS.');
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'GigaChat-Agents-voice-resource-builder/1.0' },
      signal: AbortSignal.timeout(300_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Voice resource redirect omitted its destination.');
      url = new URL(location, url);
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
        throw new Error('Voice resource redirected to an unverified host.');
      }
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Voice resource download failed (HTTP ${response.status}).`);
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !allowedHosts.has(finalUrl.hostname)) {
      throw new Error('Voice resource redirected to an unverified host.');
    }
    return response;
  }
  throw new Error('Voice resource exceeded the redirect limit.');
}

async function downloadAsset(asset, url) {
  validateAsset(asset);
  const target = join(resourcesDirectory, asset.name);
  if (await isVerified(target, asset)) return;

  const existing = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-file voice resource: ${asset.name}`);
  }

  const temporary = join(stageDirectory, `${asset.name}.${randomUUID()}.download`);
  temporaryFiles.add(temporary);
  const response = await fetchResponse(url);
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > asset.sizeBytes) throw new Error(`Voice resource is larger than pinned: ${asset.name}`);

  let sizeBytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > asset.sizeBytes) {
        callback(new Error(`Voice resource is larger than pinned: ${asset.name}`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }));
  if (sizeBytes !== asset.sizeBytes || hash.digest('hex') !== asset.sha256) {
    throw new Error(`Voice resource checksum or size mismatch: ${asset.name}`);
  }
  await rename(temporary, target);
  temporaryFiles.delete(temporary);
}

async function copyVerified(source, asset) {
  validateAsset(asset);
  const target = join(resourcesDirectory, asset.name);
  if (await isVerified(target, asset)) return;
  const temporary = join(stageDirectory, `${asset.name}.${randomUUID()}.copy`);
  temporaryFiles.add(temporary);
  await copyFile(source, temporary);
  const actual = await hashFile(temporary);
  if (actual.sizeBytes !== asset.sizeBytes || actual.sha256 !== asset.sha256) {
    throw new Error(`Extracted voice resource checksum or size mismatch: ${asset.name}`);
  }
  const existing = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-file voice resource: ${asset.name}`);
  }
  await rename(temporary, target);
  temporaryFiles.delete(temporary);
}

try {
  const runtimeFiles = manifest.runtime.files;
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length !== 3) throw new Error('Runtime file manifest is incomplete.');
  for (const file of runtimeFiles) validateAsset(file);
  const requiredRuntime = new Set(runtimeFiles.map((file) => file.name));
  for (const name of ['gigastt.exe', 'LICENSE', 'NOTICE']) {
    if (!requiredRuntime.has(name)) throw new Error(`Runtime manifest is missing ${name}.`);
  }

  const missingRuntime = [];
  for (const file of runtimeFiles) if (!(await isVerified(join(resourcesDirectory, file.name), file))) missingRuntime.push(file);
  if (missingRuntime.length) {
    const archiveAsset = manifest.runtime.archive;
    validateAsset({ ...archiveAsset, name: 'gigastt-2.21.0-windows-x64.tar.gz' });
    const archivePath = join(stageDirectory, 'gigastt-2.21.0-windows-x64.tar.gz');
    temporaryFiles.add(archivePath);
    const archiveResponse = await fetchResponse(archiveAsset.url);
    const length = Number(archiveResponse.headers.get('content-length'));
    if (Number.isFinite(length) && length > archiveAsset.sizeBytes) throw new Error('Runtime archive is larger than pinned.');
    let archiveSize = 0;
    const archiveHash = createHash('sha256');
    const archiveMeter = new Transform({
      transform(chunk, _encoding, callback) {
        archiveSize += chunk.length;
        if (archiveSize > archiveAsset.sizeBytes) {
          callback(new Error('Runtime archive is larger than pinned.'));
          return;
        }
        archiveHash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(archiveResponse.body), archiveMeter, createWriteStream(archivePath, { flags: 'wx' }));
    if (archiveSize !== archiveAsset.sizeBytes || archiveHash.digest('hex') !== archiveAsset.sha256) {
      throw new Error('Runtime archive checksum or size mismatch.');
    }

    const listing = spawnSync('tar.exe', ['-tzf', archivePath], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 });
    if (listing.error) throw listing.error;
    if (listing.status !== 0) throw new Error(`Could not inspect pinned runtime archive (exit ${listing.status}).`);
    const members = listing.stdout.split(/\r?\n/).filter(Boolean);
    const allowedMembers = new Set(['./', './CHANGELOG.md', './gigastt.exe', './LICENSE', './NOTICE', './README.md']);
    if (members.some((member) => !allowedMembers.has(member)) || !members.includes('./gigastt.exe')) {
      throw new Error('Pinned runtime archive contains an unexpected path.');
    }

    const extraction = spawnSync('tar.exe', [
      '-xzf', archivePath, '-C', stageDirectory, './gigastt.exe', './LICENSE', './NOTICE',
    ], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024,
    });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) throw new Error(`Could not extract pinned runtime archive (exit ${extraction.status}).`);
    const extractedNames = (await readdir(stageDirectory)).filter((name) => name !== 'gigastt-2.21.0-windows-x64.tar.gz');
    if (extractedNames.some((name) => !requiredRuntime.has(name))) throw new Error('Runtime archive extracted an unexpected path.');
    for (const file of missingRuntime) await copyVerified(join(stageDirectory, file.name), file);
    for (const file of extractedNames) await rm(join(stageDirectory, file), { force: true });
    await rm(archivePath, { force: true });
    temporaryFiles.delete(archivePath);
  }

  const modelFiles = manifest.recognition.files;
  if (!Array.isArray(modelFiles) || modelFiles.length !== 4) throw new Error('Recognition model manifest is incomplete.');
  for (const file of modelFiles) await downloadAsset(file, file.url);
  await downloadAsset(manifest.vad.file, manifest.vad.url);

  const expectedNames = new Set([
    'manifest.json', 'gigastt.exe', 'LICENSE', 'NOTICE',
    ...modelFiles.map((file) => file.name), manifest.vad.file.name,
  ]);
  const actualNames = await readdir(resourcesDirectory);
  if (actualNames.some((name) => name !== `.stage-${buildId}` && !expectedNames.has(name))) {
    throw new Error('Voice resource directory contains an unlisted file.');
  }
  for (const file of [...runtimeFiles, ...modelFiles, manifest.vad.file]) {
    if (!(await isVerified(join(resourcesDirectory, file.name), file))) {
      throw new Error(`Voice resource verification failed: ${file.name}`);
    }
  }
  process.stdout.write('Prepared pinned offline voice runtime and models (SHA-256 verified).\n');
} finally {
  for (const path of temporaryFiles) await rm(path, { force: true }).catch(() => undefined);
  for (const name of ['gigastt.exe', 'LICENSE', 'NOTICE']) {
    await rm(join(stageDirectory, name), { force: true }).catch(() => undefined);
  }
  await removeStageDirectory(stageDirectory, stageName).catch(() => undefined);
}
