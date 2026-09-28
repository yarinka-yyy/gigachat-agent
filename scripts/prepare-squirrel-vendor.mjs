import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDirectory = join(appRoot, 'resources', 'native');
const vendorOutputName = 'squirrel-vendor-7.9.0.83';
const vendorOutput = join(resourcesDirectory, vendorOutputName);
const stagePrefix = '.squirrel-vendor-stage-';
const markerName = '.giga-chat-squirrel-vendor.json';
const pinnedNuget = {
  version: '7.9.0.83',
  releaseVersion: '7.9.0',
  url: 'https://dist.nuget.org/win-x86-commandline/v7.9.0/nuget.exe',
  sizeBytes: 8_695_632,
  sha256: '992d70cac5b06c38efec91806caba64cdcc07e6d963a0959dbbbaf264d33b800',
};

if (process.platform !== 'win32') {
  process.stdout.write('Skipping Windows-only Squirrel vendor preparation.\n');
  process.exit(0);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  const bytes = await readFile(path);
  hash.update(bytes);
  return { sizeBytes: bytes.byteLength, sha256: hash.digest('hex') };
}

async function requireRegularDirectory(path, expectedParent) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Squirrel vendor path must be a regular directory.');
  const resolvedPath = await realpath(path);
  const resolvedParent = await realpath(expectedParent);
  if (dirname(resolvedPath) !== resolvedParent) throw new Error('Squirrel vendor path escaped its expected parent.');
  return resolvedPath;
}

async function collectSourceFiles(sourceVendor) {
  const names = (await readdir(sourceVendor)).sort();
  if (!names.includes('nuget.exe') || !names.includes('Squirrel.exe') || !names.includes('rcedit.exe')) {
    throw new Error('The installed electron-winstaller vendor directory is incomplete.');
  }

  const files = new Map();
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === markerName) throw new Error('Unexpected entry in electron-winstaller vendor directory.');
    const path = join(sourceVendor, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('electron-winstaller vendor entries must be regular files.');
    if (name !== 'nuget.exe') files.set(name, await hashFile(path));
  }
  files.set('nuget.exe', { sizeBytes: pinnedNuget.sizeBytes, sha256: pinnedNuget.sha256 });
  return files;
}

function expectedMarker(files, windInstallerVersion) {
  return {
    formatVersion: 1,
    source: `electron-winstaller ${windInstallerVersion} vendor, with only nuget.exe replaced`,
    nuget: pinnedNuget,
    files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
  };
}

async function validateVendorDirectory(path, expected, expectedParent) {
  await requireRegularDirectory(path, expectedParent);
  const markerPath = join(path, markerName);
  const markerInfo = await lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('Generated Squirrel vendor marker is not a regular file.');
  const actualMarker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (JSON.stringify(actualMarker) !== JSON.stringify(expected)) throw new Error('Generated Squirrel vendor does not match the pinned toolchain.');

  const expectedNames = [...Object.keys(expected.files), markerName].sort();
  const actualNames = (await readdir(path)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('Generated Squirrel vendor contains unexpected entries.');
  for (const [name, pinned] of Object.entries(expected.files)) {
    const filePath = join(path, name);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Generated Squirrel vendor contains a non-file entry.');
    if (name === 'Squirrel-Releasify.log') continue;
    const actual = await hashFile(filePath);
    if (actual.sizeBytes !== pinned.sizeBytes || actual.sha256 !== pinned.sha256) {
      throw new Error(`Generated Squirrel vendor verification failed: ${name}`);
    }
  }
}

async function fetchPinnedNuget() {
  const response = await fetch(pinnedNuget.url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(90_000),
    headers: { 'user-agent': 'GigaChat-Agents-Squirrel-vendor-builder/1.0' },
  });
  if (response.status !== 200 || response.url !== pinnedNuget.url || !response.body) {
    throw new Error(`Pinned NuGet download returned HTTP ${response.status} or an unexpected redirect.`);
  }
  const announcedSize = Number(response.headers.get('content-length'));
  if (announcedSize !== pinnedNuget.sizeBytes) throw new Error('Pinned NuGet download has an unexpected content length.');

  const reader = response.body.getReader();
  const chunks = [];
  let sizeBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sizeBytes += value.byteLength;
    if (sizeBytes > pinnedNuget.sizeBytes) {
      await reader.cancel();
      throw new Error('Pinned NuGet download exceeded its expected size.');
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sizeBytes !== pinnedNuget.sizeBytes || sha256 !== pinnedNuget.sha256) {
    throw new Error('Pinned NuGet checksum or size mismatch.');
  }
  return bytes;
}

async function removeOwnedStage(path, expectedParent) {
  const name = path.slice(dirname(path).length + 1);
  if (!new RegExp(`^${stagePrefix}[0-9a-f-]{36}$`).test(name)) throw new Error('Refusing to remove an unrecognized Squirrel staging directory.');
  await requireRegularDirectory(path, expectedParent);
  for (const entry of await readdir(path)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry)) throw new Error('Unexpected name in Squirrel staging directory.');
    const entryPath = join(path, entry);
    const info = await lstat(entryPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected entry type in Squirrel staging directory.');
    await unlink(entryPath);
  }
  await rmdir(path);
}

await mkdir(resourcesDirectory, { recursive: true });
const resourcesInfo = await lstat(resourcesDirectory);
if (!resourcesInfo.isDirectory() || resourcesInfo.isSymbolicLink()) throw new Error('resources/native must be a regular directory.');
const canonicalResourcesDirectory = await realpath(resourcesDirectory);
const sourceVendor = join(appRoot, 'node_modules', 'electron-winstaller', 'vendor');
await requireRegularDirectory(sourceVendor, dirname(sourceVendor));

const installerPackage = JSON.parse(await readFile(join(appRoot, 'node_modules', 'electron-winstaller', 'package.json'), 'utf8'));
if (installerPackage.version !== '5.4.4') throw new Error(`Unexpected electron-winstaller version: ${installerPackage.version}`);
const sourceFiles = await collectSourceFiles(sourceVendor);
const marker = expectedMarker(sourceFiles, installerPackage.version);

let outputIsVerified = false;
try {
  await validateVendorDirectory(vendorOutput, marker, canonicalResourcesDirectory);
  outputIsVerified = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (outputIsVerified) {
  process.stdout.write(`Verified generated Squirrel vendor (NuGet ${pinnedNuget.version}; SHA-256 pinned).\n`);
} else {
  const nugetBytes = await fetchPinnedNuget();
  const stageName = `${stagePrefix}${randomUUID()}`;
  const stageDirectory = join(canonicalResourcesDirectory, stageName);
  await mkdir(stageDirectory);
  try {
    for (const name of (await readdir(sourceVendor)).sort()) {
      const sourcePath = join(sourceVendor, name);
      const targetPath = join(stageDirectory, name);
      if (name === 'nuget.exe') {
        await writeFile(targetPath, nugetBytes, { flag: 'wx' });
      } else {
        await copyFile(sourcePath, targetPath);
      }
    }
    await writeFile(join(stageDirectory, markerName), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    await validateVendorDirectory(stageDirectory, marker, canonicalResourcesDirectory);
    try {
      await rename(stageDirectory, vendorOutput);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      await validateVendorDirectory(vendorOutput, marker, canonicalResourcesDirectory);
    }
    process.stdout.write(`Prepared Squirrel vendor with NuGet ${pinnedNuget.version}; SHA-256 verified.\n`);
  } finally {
    const stageInfo = await lstat(stageDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stageInfo) await removeOwnedStage(stageDirectory, canonicalResourcesDirectory);
  }
}
