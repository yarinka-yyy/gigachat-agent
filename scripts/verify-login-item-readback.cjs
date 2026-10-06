const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');

const nsisFixtureExe = process.env.GIGACHAT_PLAN008_LOGIN_ITEM_FIXTURE_EXE;
const fixture = path.resolve(__dirname, '..', '.qa', nsisFixtureExe
  ? 'plan008-desktop-polish-nsis-login-item-readback'
  : 'plan007-owner-upgrade-20261005/login-item-readback');
const lifecycleSource = fs.readFileSync(path.resolve(__dirname, '../src/lifecycle.ts'), 'utf8');
const ownName = lifecycleSource.match(/export const APP_USER_MODEL_ID = '([^']+)'/)?.[1];
if (!ownName) throw new Error('The stable application identity was not found in lifecycle.ts.');
const stablePath = nsisFixtureExe
  ? path.resolve(nsisFixtureExe)
  : path.join(process.env.LOCALAPPDATA || '', 'gigachat_agents', 'GigaChat Agents.exe');
const profile = path.join(fixture, 'user-data');
const cache = path.join(fixture, 'cache');
const sessionData = path.join(fixture, 'session-data');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe QA directory');
}

function runDriver() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Run this check on Windows with an installed user profile.');
  if (nsisFixtureExe && !path.isAbsolute(nsisFixtureExe)) throw new Error('The NSIS fixture executable path must be absolute.');
  for (const directory of [fixture, profile, cache, sessionData]) ensureDirectory(directory);
  const child = spawn(electron, [
    `--user-data-dir=${path.join(fixture, 'electron-user-data')}`,
    `--disk-cache-dir=${path.join(fixture, 'electron-cache')}`,
    __filename,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  child.once('close', (code, signal) => {
    clearTimeout(timeout);
    const result = { code, signal, timedOut, stdout, stderr };
    fs.writeFileSync(path.join(fixture, 'driver-result.json'), JSON.stringify(result, null, 2));
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (timedOut || code !== 0) process.exitCode = 1;
  });
  child.once('error', (error) => { stderr += String(error); });
}

function ownSnapshot(snapshot) {
  return {
    openAtLogin: snapshot.openAtLogin,
    executableWillLaunchAtLogin: snapshot.executableWillLaunchAtLogin,
    ownItems: (snapshot.launchItems || []).filter((item) => item.name === ownName)
      .map(({ name, path: itemPath, args, scope, enabled }) => ({ name, path: itemPath, args, scope, enabled })),
  };
}

function runElectron(app) {
  try {
    for (const directory of [fixture, profile, cache, sessionData]) ensureDirectory(directory);
    app.setPath('userData', profile);
    app.setPath('cache', cache);
    app.setPath('sessionData', sessionData);
    app.setAppUserModelId(ownName);
  } catch (error) {
    process.stderr.write(String(error?.message || error));
    app.exit(1);
    return;
  }

  app.whenReady().then(() => {
    let result;
    try {
      assert.ok(path.isAbsolute(stablePath), 'LOCALAPPDATA must resolve to an absolute path');
      const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
      const adapterSource = source.match(/function loginItemApi\(\)\s*\{[\s\S]*?\n\}/)?.[0];
      assert.ok(adapterSource, 'production loginItemApi must be present');
      let blockedSetCalls = 0;
      const readOnlyElectronApp = {
        getLoginItemSettings: (options) => app.getLoginItemSettings(options),
        setLoginItemSettings: () => { blockedSetCalls += 1; throw new Error('Native writes are blocked'); },
      };
      const ts = require('typescript');
      const compiled = ts.transpileModule(adapterSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
      }).outputText;
      const api = new Function('app', `${compiled}\nreturn loginItemApi();`)(readOnlyElectronApp);
      assert.throws(() => api.setSettings({ path: stablePath, args: [], openAtLogin: true, enabled: true }), /blocked/);

      const options = { path: stablePath, args: [] };
      const raw = ownSnapshot(app.getLoginItemSettings(options));
      const quoted = ownSnapshot(app.getLoginItemSettings({ ...options, path: `"${stablePath}"` }));
      const productionAdapter = ownSnapshot(api.getSettings(options));
      assert.equal(blockedSetCalls, 1);
      assert.equal(quoted.openAtLogin, true, 'requires the own installed startup item to be enabled');
      assert.equal(quoted.executableWillLaunchAtLogin, true);
      assert.equal(quoted.ownItems.length, 1);
      assert.equal(quoted.ownItems[0].scope, 'user');
      assert.equal(quoted.ownItems[0].enabled, true);
      assert.equal(quoted.ownItems[0].path, stablePath);
      assert.deepEqual(quoted.ownItems[0].args, []);
      assert.deepEqual(productionAdapter, quoted, 'production adapter must preserve the own path and arguments');
      result = { passed: true, electron: process.versions.electron, raw, quoted, productionAdapter, blockedSetCalls };
    } catch (error) {
      result = { passed: false, electron: process.versions.electron, error: String(error?.message || error) };
    }
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (result.passed) app.quit();
    else app.exit(1);
  }).catch((error) => {
    process.stderr.write(String(error?.message || error));
    app.exit(1);
  });
}

if (process.versions.electron) runElectron(electron.app);
else runDriver();
