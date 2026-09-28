import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  process.stdout.write('Skipping the Windows-only local runtime build.\n');
  process.exit(0);
}

const projectDirectory = join(appRoot, 'native', 'LocalPowerShell');
const outputDirectory = join(appRoot, 'resources', 'native');
await mkdir(outputDirectory, { recursive: true });
const result = spawnSync('dotnet', [
  'publish', 'LocalPowerShell.csproj', '--configuration', 'Release', '--runtime', 'win-x64',
  '--self-contained', 'true', '--output', outputDirectory,
], { cwd: projectDirectory, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

process.stdout.write('Built resources/native/LocalPowerShell.exe with the pinned .NET SDK.\n');
