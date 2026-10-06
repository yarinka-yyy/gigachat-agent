import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runNodeDriver() {
  const { register } = await import('tsx/esm/api');
  register();
  const { rules } = await import('../webpack.rules.ts');
  const webpack = require('webpack');
  const forgeWebpackEntry = fileURLToPath(import.meta.resolve('@electron-forge/plugin-webpack'));
  const forgeWebpackDist = dirname(forgeWebpackEntry);
  const relocatorModule = await import(pathToFileURL(join(forgeWebpackDist, 'util', 'AssetRelocatorPatch.js')).href);
  const AssetRelocatorPatch = relocatorModule.default ?? relocatorModule.AssetRelocatorPatch;
  const qaDirectory = await realpath(join(repo, '.qa')).catch(async () => {
    await mkdir(join(repo, '.qa'), { recursive: true });
    return realpath(join(repo, '.qa'));
  });
  const fixture = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(qaDirectory, 'plan008-desktop-polish-renderer-')));
  assert.equal(dirname(fixture), qaDirectory, 'fixture must be a direct child of ignored app/.qa');
  console.log(`Renderer QA fixture: ${fixture}`);
  const bundleDirectory = join(fixture, 'renderer');
  const userDataDirectory = join(fixture, 'user-data');
  await mkdir(bundleDirectory, { recursive: true });
  await mkdir(userDataDirectory, { recursive: true });

  const compiler = webpack({
    module: { rules: [
      { test: /\.png$/i, type: 'asset/resource' },
      ...rules,
      { test: /\.css$/, use: [{ loader: 'style-loader' }, { loader: 'css-loader' }] },
    ] },
    resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'] },
    mode: 'development',
    devtool: false,
    entry: resolve(repo, 'src/renderer.tsx'),
    target: 'web',
    output: { path: bundleDirectory, filename: 'renderer.js', publicPath: '' },
    plugins: [new AssetRelocatorPatch(false, false)],
    optimization: { minimize: false },
  });
  console.log('Compiling actual renderer bundle');
  const stats = await new Promise((resolveStats, reject) => compiler.run((error, result) => {
    if (error) reject(error);
    else if (!result || result.hasErrors()) reject(new Error(result?.toString({ all: false, errors: true }) ?? 'Webpack returned no stats'));
    else resolveStats(result);
  }));
  await new Promise((resolveClose, reject) => compiler.close((error) => error ? reject(error) : resolveClose()));
  console.log('Actual renderer bundle compiled');
  if (stats.hasWarnings()) process.stdout.write(`Renderer bundle warnings: ${stats.toString({ all: false, warnings: true })}\n`);

  const html = (await readFile(join(repo, 'src/index.html'), 'utf8'))
    .replace('</body>', '  <script defer src="./renderer.js"></script>\n  </body>');
  await writeFile(join(bundleDirectory, 'index.html'), html, 'utf8');
  await writeFile(join(fixture, 'preload.cjs'), fakePreloadSource, 'utf8');

  const electronPath = require('electron');
  const child = spawn(electronPath, [`--user-data-dir=${userDataDirectory}`, fileURLToPath(import.meta.url)], {
    cwd: repo,
    env: { ...process.env, GIGACHAT_AUDIT_ROOT: fixture },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`Electron host spawned: ${child.pid}`);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron renderer host timed out; fixture: ${fixture}`));
    }, 120_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`Electron renderer host stopped by ${signal}; fixture: ${fixture}`));
      else resolveExit(code ?? 1);
    });
  });
  assert.equal(exitCode, 0, `Electron renderer host failed.\n${stderr}\n${stdout}\nFixture: ${fixture}`);
  process.stdout.write(`Renderer fixture retained for review: ${fixture}\n`);
}

async function runElectronHost() {
  console.log('Electron host entry reached');
  const { app, BrowserWindow, ipcMain } = require('electron');
  console.log('Electron API loaded');
  const fixture = process.env.GIGACHAT_AUDIT_ROOT;
  assert.ok(fixture, 'synthetic GIGACHAT_AUDIT_ROOT is required');
  const fixturePath = await realpath(fixture);
  assert.equal(dirname(fixturePath), await realpath(join(repo, '.qa')));
  const profile = join(fixturePath, 'user-data');
  const bundleDirectory = join(fixturePath, 'renderer');
  app.setPath('userData', profile);

  const timestamp = '2026-10-03T00:00:00.000Z';
  const makeProject = (id, name, workingFolder = null) => ({ id, name, pinned: false, archived: false, createdAt: timestamp, updatedAt: timestamp, workingFolder });
  const makeChat = (id, title, projectId = null) => ({ id, title, projectId, pinned: false, archived: false, createdAt: timestamp, updatedAt: timestamp, kind: 'text' });
  const makeDetail = (summary, text, draft = '') => ({
    ...summary, draft, nextTurnPermissionProfile: null, modelId: null, nextTurnSkillId: null,
    messages: [{ id: `${summary.id}-message`, role: 'assistant', text, createdAt: timestamp }], artifacts: [],
  });
  const projects = [
    makeProject('project-a', 'Project A', 'C:\\audit\\project-a'),
    makeProject('project-b', 'Project B', 'C:\\audit\\project-b'),
    ...Array.from({ length: 12 }, (_, index) => makeProject(
      `scroll-project-${index + 1}`,
      `Long Project ${String(index + 1).padStart(2, '0')}`,
      `C:\\audit\\scroll-project-${index + 1}`,
    )),
  ];
  const chatA = makeChat('chat-a', 'Chat A');
  const chatB = makeChat('chat-b', 'Chat B');
  const chats = [
    chatA,
    chatB,
    ...Array.from({ length: 24 }, (_, index) => makeChat(`history-${index + 1}`, `History chat ${String(index + 1).padStart(2, '0')}`)),
  ];
  const details = new Map(chats.map((chat, index) => [chat.id, makeDetail(chat, index === 0 ? 'A baseline' : index === 1 ? 'B baseline' : 'History baseline')]));
  const state = {
    projects, chats, details,
    deferChatGets: false, pendingGets: new Map(), rejectNextGet: null,
    deferCreate: false, rejectNextCreate: false, pendingCreates: [], createCalls: [],
    deferDraftUpdates: false, pendingDraftUpdates: [], deferProjectMoves: false, pendingProjectMoves: [], updateCalls: [],
    deferSkillUpdates: false, pendingSkillUpdates: [], deferPermissionUpdates: false, pendingPermissionUpdates: [], appendCalls: [],
    deferImports: false, pendingImports: [], importCalls: [],
    deferSettingUpdates: false, pendingSettingUpdates: [], deferConfigSaves: false, pendingConfigSaves: [], configContents: '',
    deferKeySaves: false, pendingKeySaves: [], keySaveCalls: 0,
    deferOnboardingBounds: false, pendingOnboardingBounds: [], onboardingBoundsCalls: [], openStudioCalls: 0,
    browserBoundsCalls: [],
    voiceAvailable: true, voiceAccessCalls: 0, deferVoiceAccess: false, pendingVoiceAccess: [],
    voiceTranscribeCalls: [], deferVoiceTranscribe: false, pendingVoiceTranscribes: [], voiceCancelCalls: 0, voiceCancelFailuresRemaining: 0,
    deferProjectReads: false, rejectProjectRead: null, pendingProjectReads: new Map(), projectReadCalls: [],
    conflictNextProjectSave: false, projectSaveCalls: [], projectInstructionCopies: [],
    deferChooseFolder: false, pendingFolderChanges: [], folderCalls: [],
    closeReadyCalls: 0, closeReadyArgs: [], closeReadyResults: [], closeReturnCalls: 0, permissionResponses: [],
    appSettings: {
      theme: 'dark', sidebarTransparent: false, sidebarVisible: true, sidebarWidthPx: 264,
      browserPaneOpen: false, browserWidthPx: 420, browserTabs: [], browserActiveTabId: null,
      defaultProjectsFolder: null, preferredOpener: 'detected-app', defaultPermissionProfile: 'ask',
      defaultModelId: null, onboardingCompleted: true, microphoneConsent: 'declined',
      notifications: { taskStarted: false, taskCompleted: true, failures: true },
    },
  };

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const updateSummary = (id, patch) => {
    const summary = state.chats.find((item) => item.id === id);
    const detail = state.details.get(id);
    if (!summary || !detail) throw new Error(`Unknown synthetic chat: ${id}`);
    Object.assign(summary, patch, { updatedAt: timestamp });
    Object.assign(detail, patch, { updatedAt: timestamp });
    state.updateCalls.push({ id, patch: clone(patch) });
    return clone(summary);
  };
  const resolveCreate = (record) => {
    const summary = makeChat(`chat-new-${record.index}`, `New chat ${record.index}`, record.projectId);
    state.chats.unshift(summary);
    state.details.set(summary.id, makeDetail(summary, '', ''));
    record.resolve(clone(summary));
  };
  const resolveSkillUpdate = (record) => record.resolve(updateSummary(record.id, record.patch));
  const resolvePermissionUpdate = (record) => record.resolve(updateSummary(record.id, record.patch));
  const resolveSettingUpdate = (record) => {
    Object.assign(state.appSettings, record.patch);
    record.resolve(clone(state.appSettings));
  };
  const resolveConfigSave = (record) => {
    state.configContents = record.contents;
    record.resolve(record.contents);
  };
  const readProjectInstructions = (id) => {
    state.projectReadCalls.push(id);
    if (state.rejectProjectRead === id) {
      state.rejectProjectRead = null;
      throw new Error(`Synthetic instruction read failed for ${id}`);
    }
    if (state.deferProjectReads) {
      const request = deferred();
      const pending = state.pendingProjectReads.get(id) ?? [];
      pending.push(request);
      state.pendingProjectReads.set(id, pending);
      return request.promise;
    }
    return { text: `# instructions ${id}`, revision: `revision-${id}` };
  };

  ipcMain.handle('audit:api', async (_event, group, method, args) => {
    console.log(`Synthetic bridge call: ${group}.${method}`);
    if (group === 'projects' && method === 'list') return clone(state.projects);
    if (group === 'projects' && method === 'readInstructions') return readProjectInstructions(args[0]);
    if (group === 'projects' && method === 'instructionsBackupPath') return null;
    if (group === 'projects' && method === 'saveInstructions') {
      state.projectSaveCalls.push({ id: args[0], text: args[1], expectedRevision: args[2] });
      if (state.conflictNextProjectSave) {
        state.conflictNextProjectSave = false;
        return { kind: 'conflict', phase: 'before-commit', current: { text: `# external ${args[0]}`, revision: `external-${args[0]}` } };
      }
      return { kind: 'saved', document: { text: args[1], revision: `saved-${state.projectSaveCalls.length}` } };
    }
    if (group === 'projects' && method === 'saveInstructionsCopy') {
      state.projectInstructionCopies.push({ id: args[0], text: args[1] });
      return `C:\\audit\\instruction-copies\\${args[0]}.md`;
    }
    if (group === 'projects' && method === 'chooseFolder') {
      const id = args[0];
      state.folderCalls.push(id);
      if (state.deferChooseFolder) {
        const request = deferred();
        state.pendingFolderChanges.push({ id, request });
        return request.promise;
      }
      const project = state.projects.find((item) => item.id === id);
      Object.assign(project, { workingFolder: `C:\\audit\\changed-${id}`, updatedAt: timestamp });
      return { project: clone(project), warning: null };
    }
    if (group === 'projects' && method === 'update') {
      const [id, patch] = args;
      const project = state.projects.find((item) => item.id === id);
      Object.assign(project, patch, { updatedAt: timestamp });
      return { project: clone(project), warning: null };
    }
    if (group === 'chats' && method === 'list') return clone(state.chats);
    if (group === 'chats' && method === 'get') {
      const id = args[0];
      if (state.rejectNextGet === id) {
        state.rejectNextGet = null;
        throw new Error(`Synthetic chat read failed for ${id}`);
      }
      if (state.deferChatGets) {
        const request = deferred();
        const pending = state.pendingGets.get(id) ?? [];
        pending.push(request);
        state.pendingGets.set(id, pending);
        return request.promise;
      }
      return clone(state.details.get(id));
    }
    if (group === 'chats' && method === 'create') {
      const [projectId] = args;
      const record = { projectId, index: state.createCalls.length + 1 };
      state.createCalls.push(clone(record));
      if (state.rejectNextCreate) {
        state.rejectNextCreate = false;
        throw new Error('Synthetic create failure');
      }
      if (state.deferCreate) {
        const request = deferred();
        state.pendingCreates.push({ ...record, resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      const summary = makeChat(`chat-new-${record.index}`, `New chat ${record.index}`, projectId);
      state.chats.unshift(summary);
      state.details.set(summary.id, makeDetail(summary, '', ''));
      return clone(summary);
    }
    if (group === 'chats' && method === 'update') {
      const [id, patch] = args;
      if (state.deferDraftUpdates && Object.hasOwn(patch, 'draft')) {
        const request = deferred();
        state.pendingDraftUpdates.push({ id, patch: clone(patch), resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      if (state.deferSkillUpdates && Object.hasOwn(patch, 'nextTurnSkillId')) {
        const request = deferred();
        state.pendingSkillUpdates.push({ id, patch: clone(patch), resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      if (state.deferPermissionUpdates && Object.hasOwn(patch, 'nextTurnPermissionProfile')) {
        const request = deferred();
        state.pendingPermissionUpdates.push({ id, patch: clone(patch), resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      if (state.deferProjectMoves && Object.hasOwn(patch, 'projectId')) {
        const request = deferred();
        state.pendingProjectMoves.push({ id, patch: clone(patch), resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      return updateSummary(id, patch);
    }
    if (group === 'chats' && method === 'importFile') {
      const [id, projectId] = args;
      state.importCalls.push({ id, projectId });
      if (!state.deferImports) return null;
      const request = deferred();
      state.pendingImports.push({ id, request });
      return request.promise;
    }
    if (group === 'chats' && method === 'appendLocalMessage') {
      const [id, text] = args;
      const detail = state.details.get(id);
      state.appendCalls.push({ id, text, nextTurnSkillId: detail.nextTurnSkillId, nextTurnPermissionProfile: detail.nextTurnPermissionProfile });
      detail.messages.push({ id: `${id}-${detail.messages.length}`, role: 'user', text, createdAt: timestamp });
      detail.draft = '';
      updateSummary(id, { draft: '' });
      return clone(detail);
    }
    if (group === 'settings' && method === 'get') return clone(state.appSettings);
    if (group === 'settings' && method === 'update') {
      if (state.deferSettingUpdates) {
        const request = deferred();
        state.pendingSettingUpdates.push({ patch: clone(args[0]), resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      Object.assign(state.appSettings, args[0]);
      return clone(state.appSettings);
    }
    if (group === 'settings' && method === 'readInstructions') return { text: '', revision: 'global-1' };
    if (group === 'onboarding' && method === 'saveKey') {
      state.keySaveCalls += 1;
      if (state.deferKeySaves) {
        const request = deferred();
        state.pendingKeySaves.push({ resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      return { available: true, saved: true, usable: true };
    }
    if (group === 'onboarding' && method === 'getKeyStatus') return { available: true, saved: false, usable: false };
    if (group === 'onboarding' && method === 'getBrowserStatus') {
      return { open: false, loading: false, canGoBack: false, atStudio: false, hostname: null, error: null };
    }
    if (group === 'onboarding' && method === 'setBrowserBounds') {
      state.onboardingBoundsCalls.push(clone(args[0]));
      if (!state.deferOnboardingBounds) return;
      const request = deferred();
      state.pendingOnboardingBounds.push(request);
      return request.promise;
    }
    if (group === 'onboarding' && method === 'openStudio') {
      state.openStudioCalls += 1;
      return { open: true, loading: false, canGoBack: false, atStudio: true, hostname: 'developers.sber.ru', error: null };
    }
    if (group === 'permissions' && method === 'readConfig') return { contents: state.configContents, error: null };
    if (group === 'permissions' && method === 'respond') {
      state.permissionResponses.push({ id: args[0], allowed: args[1] });
      return true;
    }
    if (group === 'permissions' && method === 'saveConfig') {
      const [contents] = args;
      if (state.deferConfigSaves) {
        const request = deferred();
        state.pendingConfigSaves.push({ contents, resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      state.configContents = contents;
      return contents;
    }
    if (group === 'skills' && method === 'list') return { skills: [
      { id: 'global/audit', name: 'Audit', description: 'Synthetic audit skill', command: 'global/audit', scope: 'global', projectId: null, projectName: null, source: 'synthetic', enabled: true },
      { id: 'global/other', name: 'Other', description: 'Synthetic second skill', command: 'global/other', scope: 'global', projectId: null, projectName: null, source: 'synthetic', enabled: true },
    ], issues: [] };
    if (group === 'hooks' && method === 'list') return { hooks: [], issues: [] };
    if (group === 'runtime' && method === 'list') return [];
    if (group === 'voice' && method === 'getStatus') return { available: state.voiceAvailable, reason: state.voiceAvailable ? null : 'Disabled in synthetic test host.' };
    if (group === 'voice' && method === 'requestAccess') {
      state.voiceAccessCalls += 1;
      if (state.deferVoiceAccess) {
        const request = deferred();
        state.pendingVoiceAccess.push(request);
        return request.promise;
      }
      return true;
    }
    if (group === 'voice' && method === 'transcribe') {
      state.voiceTranscribeCalls.push({ requestId: args[0], audioLength: args[1]?.byteLength, mediaType: args[2] });
      if (state.deferVoiceTranscribe) {
        const request = deferred();
        state.pendingVoiceTranscribes.push(request);
        return request.promise;
      }
      return 'Synthetic dictation ready.';
    }
    if (group === 'voice' && method === 'cancel') {
      state.voiceCancelCalls += 1;
      if (state.voiceCancelFailuresRemaining > 0) {
        state.voiceCancelFailuresRemaining -= 1;
        throw new Error('Synthetic cleanup failure');
      }
      return false;
    }
    if (group === 'settings' && method === 'getAutoStart') return false;
    if (group === 'settings' && method === 'listOpeners') return [];
    if (group === 'settings' && method === 'getAppInfo') return { version: 'audit', dataPath: profile, packaged: false, installedLauncherAvailable: false, autoStartMigrationIssue: null, platform: 'win32' };
    if (group === 'browser' && method === 'getStatus') return {
      tabs: [{ id: 'audit-browser-tab', title: 'Synthetic page', url: 'https://example.test/', canGoBack: false, canGoForward: false, loading: false, error: null }],
      activeTabId: 'audit-browser-tab', error: null,
    };
    if (group === 'browser' && method === 'setBounds') {
      state.browserBoundsCalls.push(clone(args[0]));
      return true;
    }
    if (group === 'usage' && method === 'getLocalStats') return { chatCount: state.chats.length, projectCount: state.projects.length, activityDayCount: 0 };
    return null;
  });
  ipcMain.handle('audit:close-ready', (_event, discardBrowserMetadata) => {
    state.closeReadyCalls += 1;
    state.closeReadyArgs.push(discardBrowserMetadata);
    return state.closeReadyResults.shift()
      ?? { status: 'failed', reason: 'close', message: 'Synthetic close keeps the renderer host open.' };
  });
  ipcMain.handle('audit:close-return', () => { state.closeReturnCalls += 1; return true; });

  let window;
  let passCount = 0;
  const layoutMeasurements = [];
  const passed = (name) => { passCount += 1; console.log(`PASS ${name}`); };
  const sleep = (duration = 60) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration));
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitUntil = async (name, check, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(40);
    }
    throw new Error(`Timed out waiting for ${name}`);
  };
  const waitDom = (name, expression, timeout) => waitUntil(name, () => evaluate(expression), timeout);
  const measureLayout = async (label) => {
    const layout = await evaluate(`JSON.stringify((() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: rect.x, right: rect.right, width: rect.width, height: rect.height,
          paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
          boxSizing: style.boxSizing, minWidth: style.minWidth, cssWidth: style.width,
          marginRight: style.marginRight, borderLeftWidth: style.borderLeftWidth,
          borderRadius: style.borderRadius, overflowY: style.overflowY,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
        };
      };
      const workspace = document.querySelector('.workspace');
      const resizer = document.querySelector('.sidebar-resizer');
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        gridTemplateColumns: workspace ? getComputedStyle(workspace).gridTemplateColumns : null,
        sidebarWidthVariable: workspace ? getComputedStyle(workspace).getPropertyValue('--sidebar-width').trim() : null,
        workspace: box('.workspace'), sidebar: box('.sidebar'), sidebarInner: box('.sidebar-inner'), mainPanel: box('.main-panel'),
        resizer: box('.sidebar-resizer'), sidebarLibrary: box('.sidebar-library'),
        resizerAccentTop: resizer ? getComputedStyle(resizer, '::after').top : null,
        dividerHitTest: (() => {
          const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
          if (!sidebar) return null;
          const y = Math.min(sidebar.bottom - 2, Math.max(sidebar.top + 2, sidebar.top + 80));
          const leftHit = document.elementFromPoint(sidebar.right - 1, y);
          const rightHit = document.elementFromPoint(sidebar.right + 1, y);
          return {
            leftHitsResizer: Boolean(leftHit?.closest('.sidebar-resizer')),
            rightHitsResizer: Boolean(rightHit?.closest('.sidebar-resizer')),
          };
        })(),
      };
    })())`);
    console.log(`LAYOUT ${label} ${layout}`);
    const measured = JSON.parse(layout);
    layoutMeasurements.push({ label, ...measured });
    return measured;
  };
  const measureSidebarTracks = async () => {
    const originalSize = window.getSize();
    const originalZoom = window.webContents.getZoomFactor();
    window.setSize(960, 720);
    window.webContents.setZoomFactor(1);
    await sleep(350);
    const originalStyle = await evaluate(`document.querySelector('.workspace')?.getAttribute('style') ?? null`);
    const originalClass = await evaluate(`document.querySelector('.workspace')?.className ?? null`);
    const originalSidebarStyle = await evaluate(`document.querySelector('.sidebar')?.getAttribute('style') ?? null`);
    const originalSidebarInnerStyle = await evaluate(`document.querySelector('.sidebar-inner')?.getAttribute('style') ?? null`);
    assert.ok(await evaluate(`document.querySelector('.sidebar-resizer') !== null`), 'sidebar track probe requires desktop layout and a visible resizer');
    try {
      await evaluate(`document.querySelector('.workspace').classList.add('sidebar-dragging')`);
      for (const width of [242, 180, 22, 14, 0]) {
        await evaluate(`document.querySelector('.workspace').style.setProperty('--sidebar-width', '${width}px')`);
        await sleep(260);
        const measured = await measureLayout(`forced-transient-track-${width}`);
        assert.ok(Math.abs(measured.sidebar.width - width) <= 1, `sidebar box must stay inside the ${width}px grid track; actual ${measured.sidebar.width}px`);
        assert.ok(Math.abs(measured.mainPanel.x - measured.sidebar.right) <= 1, `main edge must meet the ${width}px sidebar edge; main ${measured.mainPanel.x}px/sidebar ${measured.sidebar.right}px`);
        assert.ok(Math.abs(Number.parseFloat(measured.gridTemplateColumns) - width) <= 1, `computed grid track must remain ${width}px`);
        assert.equal(measured.mainPanel.borderRadius.split(' ')[0], '0px', 'main panel top-left corner must be square');
        assert.equal(measured.resizerAccentTop, '0px', 'resizer accent must reach the top edge');
        if (width === 242) {
          assert.ok(Math.abs(measured.sidebar.right - measured.sidebarLibrary.right - 2) <= 1, `sidebar scroll viewport must end within 2px of divider; actual gap ${measured.sidebar.right - measured.sidebarLibrary.right}px`);
          assert.ok(measured.sidebarLibrary.scrollHeight > measured.sidebarLibrary.clientHeight, 'many-chat fixture must produce a scrollable sidebar');
          assert.equal(measured.dividerHitTest.leftHitsResizer, false, 'resizer hit target must not cover the left-side scrollbar edge');
          assert.equal(measured.dividerHitTest.rightHitsResizer, true, 'divider hit target must begin on the main-panel side');
        }
        if (width === 0) {
          await evaluate(`document.querySelector('.sidebar-inner').style.setProperty('padding-inline', '0px')`);
          await measureLayout('forced-transient-track-0-inner-padding-inline-0');
          await evaluate(`(() => { const sidebarInner = document.querySelector('.sidebar-inner'); const original = ${JSON.stringify(originalSidebarInnerStyle)}; if (original === null) sidebarInner.removeAttribute('style'); else sidebarInner.setAttribute('style', original); })()`);
        }
      }
    } finally {
      await evaluate(`(() => {
        const workspace = document.querySelector('.workspace');
        const sidebar = document.querySelector('.sidebar');
        const sidebarInner = document.querySelector('.sidebar-inner');
        const originalWorkspaceStyle = ${JSON.stringify(originalStyle)};
        const originalWorkspaceClass = ${JSON.stringify(originalClass)};
        const originalSidebarStyle = ${JSON.stringify(originalSidebarStyle)};
        const originalSidebarInnerStyle = ${JSON.stringify(originalSidebarInnerStyle)};
        if (workspace) {
          if (originalWorkspaceStyle === null) workspace.removeAttribute('style'); else workspace.setAttribute('style', originalWorkspaceStyle);
          if (originalWorkspaceClass !== null) workspace.className = originalWorkspaceClass;
        }
        if (sidebar) {
          if (originalSidebarStyle === null) sidebar.removeAttribute('style'); else sidebar.setAttribute('style', originalSidebarStyle);
        }
        if (sidebarInner) {
          if (originalSidebarInnerStyle === null) sidebarInner.removeAttribute('style'); else sidebarInner.setAttribute('style', originalSidebarInnerStyle);
        }
      })()`);
      window.webContents.setZoomFactor(originalZoom);
      window.setSize(originalSize[0], originalSize[1]);
      await sleep(350);
    }
  };
  const click = async (selector) => {
    const result = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return false; element.click(); return true; })()`);
    assert.equal(result, true, `button not found or disabled: ${selector}`);
  };
  const clickText = async (selector, value) => {
    const result = await evaluate(`(() => { const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.includes(${JSON.stringify(value)})); if (!element || element.disabled) return false; element.click(); return true; })()`);
    assert.equal(result, true, `visible action not found: ${value}`);
  };
  const sendMouseClick = async (selector, text) => {
    const rect = await evaluate(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => ${text == null ? 'true' : `item.textContent.includes(${JSON.stringify(text)})`});
      if (!element || element.disabled || !element.isConnected) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    assert.ok(rect, `visible input target not found: ${text ?? selector}`);
    const zoom = window.webContents.getZoomFactor();
    const x = Math.round(rect.x * zoom);
    const y = Math.round(rect.y * zoom);
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const sendKey = async (keyCode) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await sleep(80);
  };
  const focusProjectEditorThenAction = async (value) => {
    const originalSize = window.getSize();
    const originalZoom = window.webContents.getZoomFactor();
    window.setSize(960, 720);
    window.webContents.setZoomFactor(0.8);
    window.show();
    window.focus();
    window.webContents.focus();
    await sleep(120);
    const armed = await evaluate(`(() => {
      const editor = document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]');
      const action = [...document.querySelectorAll('.project-settings-dialog button')].find((button) => button.textContent.includes(${JSON.stringify(value)}));
      if (!editor || !action || action.disabled || !editor.isConnected || !action.isConnected) return null;
      window.__auditProjectEditorBlurCount = 0;
      editor.addEventListener('blur', () => { window.__auditProjectEditorBlurCount += 1; }, { once: true });
      return { editorConnected: editor.isConnected, actionConnected: action.isConnected, actionText: action.textContent.trim() };
    })()`);
    assert.ok(armed, `could not arm editor/action focus check: ${value}`);
    let mouseDown = false;
    let pressedAt = null;
    try {
      await sendMouseClick('textarea[aria-label="Инструкции проекта AGENTS.md"]');
      await waitDom('synthetic editor receives real mouse focus', `document.activeElement === document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')`);
      const rect = await evaluate(`(() => {
        const action = [...document.querySelectorAll('.project-settings-dialog button')].find((button) => button.textContent.includes(${JSON.stringify(value)}));
        if (!action || action.disabled || !action.isConnected) return null;
        action.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = action.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()`);
      assert.ok(rect, `project action disappeared before actual input: ${value}`);
      const zoom = window.webContents.getZoomFactor();
      const x = Math.round(rect.x * zoom);
      const y = Math.round(rect.y * zoom);
      pressedAt = { x, y };
      window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      mouseDown = true;
      await waitDom(`real editor blur before ${value}`, 'window.__auditProjectEditorBlurCount === 1');
      await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const afterBlur = JSON.parse(await evaluate(`(() => {
        const editor = document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]');
        const action = [...document.querySelectorAll('.project-settings-dialog button')].find((button) => button.textContent.includes(${JSON.stringify(value)}));
        const rect = action?.getBoundingClientRect();
        return JSON.stringify({
          blurCount: window.__auditProjectEditorBlurCount,
          activeTag: document.activeElement?.tagName ?? null,
          activeText: document.activeElement?.textContent?.trim() ?? null,
          editorConnected: Boolean(editor?.isConnected),
          editorText: editor?.value ?? null,
          actionConnected: Boolean(action?.isConnected),
          actionText: action?.textContent?.trim() ?? null,
          actionRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
          conflictVisible: Boolean(document.querySelector('.project-settings-dialog [role="alert"] strong')?.textContent.includes('AGENTS.md изменён')),
          dialogError: document.querySelector('.project-settings-dialog .dialog-error')?.textContent ?? null,
        });
      })()`));
      assert.equal(afterBlur.blurCount, 1, `actual editor blur count: ${JSON.stringify(afterBlur)}`);
      assert.equal(afterBlur.activeTag, 'BUTTON', `actual focused element: ${JSON.stringify(afterBlur)}`);
      assert.ok(afterBlur.activeText?.includes(value), `actual focused action: ${JSON.stringify(afterBlur)}`);
      assert.equal(afterBlur.editorConnected, true, `editor detached during blur: ${JSON.stringify(afterBlur)}`);
      assert.equal(afterBlur.editorText, '# local conflict draft', `local draft changed during blur: ${JSON.stringify(afterBlur)}`);
      assert.equal(afterBlur.actionConnected, true, `action detached during blur: ${JSON.stringify(afterBlur)}`);
      assert.equal(afterBlur.conflictVisible, true, `conflict card disappeared during blur: ${JSON.stringify(afterBlur)}`);
      assert.equal(afterBlur.dialogError, null, `duplicate error appeared beside the conflict card: ${JSON.stringify(afterBlur)}`);
      const movement = Math.max(
        Math.abs(afterBlur.actionRect.left - rect.left),
        Math.abs(afterBlur.actionRect.top - rect.top),
        Math.abs(afterBlur.actionRect.width - rect.width),
        Math.abs(afterBlur.actionRect.height - rect.height),
      );
      assert.ok(movement <= 1, `blur moved the recovery action by ${movement}px: before=${JSON.stringify(rect)} after=${JSON.stringify(afterBlur)}`);
      if (value === 'Сохранить черновик отдельно') await capture('project-conflict-blur-stable-copy-960x720-zoom-0_8');
      window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      mouseDown = false;
    } catch (error) {
      const diagnostic = await evaluate(`JSON.stringify({
        blurCount: window.__auditProjectEditorBlurCount,
        activeTag: document.activeElement?.tagName ?? null,
        activeText: document.activeElement?.textContent?.trim() ?? null,
        editorConnected: Boolean(document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.isConnected),
        editorText: document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value ?? null,
        actionConnected: [...document.querySelectorAll('.project-settings-dialog button')].some((button) => button.textContent.includes(${JSON.stringify(value)}) && button.isConnected),
        conflictVisible: Boolean(document.querySelector('.project-settings-dialog [role="alert"] strong')?.textContent.includes('AGENTS.md изменён')),
      })`);
      error.message += `; actual-input state: ${diagnostic}`;
      throw error;
    } finally {
      if (mouseDown && pressedAt) window.webContents.sendInputEvent({ type: 'mouseUp', ...pressedAt, button: 'left', clickCount: 1 });
      window.webContents.setZoomFactor(originalZoom);
      window.setSize(originalSize[0], originalSize[1]);
    }
  };
  const fillTextarea = async (selector, value) => {
    const result = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} })); return true; })()`);
    assert.equal(result, true, `textarea not found or disabled: ${selector}`);
  };
  const fillInput = async (selector, value) => {
    const result = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} })); return true; })()`);
    assert.equal(result, true, `input not found or disabled: ${selector}`);
  };
  const clickChat = async (title) => {
    const result = await evaluate(`(() => { const element = [...document.querySelectorAll('.list-row-main')].find((item) => item.textContent.includes(${JSON.stringify(title)})); if (!element) return false; element.click(); return true; })()`);
    assert.equal(result, true, `chat row not found: ${title}`);
  };
  const installSyntheticMedia = () => evaluate(`(() => {
    const audit = {
      getUserMediaCalls: 0, trackStopCalls: 0, streams: [], recorders: [],
      deferGetUserMedia: false, pendingGetUserMedia: [], nextArrayBuffer: null,
    };
    const NativeBlob = window.Blob;
    const makeStream = () => {
      const track = { stopped: false, stop() { this.stopped = true; audit.trackStopCalls += 1; } };
      const stream = { getTracks: () => [track] };
      audit.streams.push({ stream, track });
      return stream;
    };
    class SyntheticBlob extends NativeBlob {
      constructor(parts, options) {
        super(parts, options);
        const held = audit.nextArrayBuffer;
        if (held) {
          audit.nextArrayBuffer = null;
          held.called = true;
          this.arrayBuffer = () => held.promise;
        }
      }
    }
    class SyntheticRecorder {
      static isTypeSupported() { return true; }
      constructor(stream, options) {
        this.stream = stream;
        this.mimeType = options.mimeType;
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
        this.onerror = null;
      }
      start() { this.state = 'recording'; audit.recorders.push(this); }
      stop() {
        if (this.state !== 'recording') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new NativeBlob([new Uint8Array(6)], { type: this.mimeType }) });
        queueMicrotask(() => this.onstop?.());
      }
    }
    audit.makeArrayBufferHold = () => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      audit.nextArrayBuffer = { promise, resolve, called: false };
    };
    audit.releaseArrayBuffer = () => audit.lastArrayBuffer?.resolve(new Uint8Array([1, 2, 3]).buffer);
    audit.resolveGetUserMedia = (index) => audit.pendingGetUserMedia[index]?.resolve(audit.pendingGetUserMedia[index].stream);
    audit.emitLateData = (index, byteLength) => audit.recorders[index]?.ondataavailable?.({
      data: new NativeBlob([new Uint8Array(byteLength)], { type: 'audio/webm' }),
    });
    const originalMakeHold = audit.makeArrayBufferHold;
    audit.makeArrayBufferHold = () => {
      originalMakeHold();
      audit.lastArrayBuffer = audit.nextArrayBuffer;
    };
    Object.defineProperty(window, 'Blob', { configurable: true, value: SyntheticBlob });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: SyntheticRecorder });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => {
        audit.getUserMediaCalls += 1;
        const stream = makeStream();
        if (!audit.deferGetUserMedia) return Promise.resolve(stream);
        return new Promise((resolve) => audit.pendingGetUserMedia.push({ stream, resolve }));
      },
    } });
    window.__auditVoiceMedia = audit;
    return true;
  })()`);
  const capture = async (name) => {
    if (!window.isVisible()) window.showInactive();
    if (name === 'close-pending-import-settings-config') {
      console.log(`MIXED_CLOSE capture before RAF ${JSON.stringify({
        visible: window.isVisible(),
        state: await evaluate(`JSON.stringify({ visibility: document.visibilityState, pending: document.querySelector('.close-pending-dialog')?.open ?? false })`),
      })}`);
    }
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (name === 'close-pending-import-settings-config') {
      console.log(`MIXED_CLOSE capture after RAF ${JSON.stringify({
        visible: window.isVisible(),
        state: await evaluate(`JSON.stringify({ visibility: document.visibilityState, pending: document.querySelector('.close-pending-dialog')?.open ?? false })`),
      })}`);
    }
    let image = await window.webContents.capturePage();
    if (image.isEmpty()) {
      window.showInactive();
      await sleep(120);
      image = await window.webContents.capturePage();
    }
    assert.equal(image.isEmpty(), false, `screenshot is empty: ${name}`);
    const screenshotPath = join(fixturePath, `${name}.png`);
    await writeFile(screenshotPath, image.toPNG());
    console.log(`SCREENSHOT ${screenshotPath}`);
  };

  try {
    await app.whenReady();
    console.log('Electron app ready');
    assert.equal(await realpath(app.getPath('userData')), await realpath(profile), 'Electron userData must be the synthetic fixture');
    window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 760,
      webPreferences: {
        preload: join(fixturePath, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', (_event, detailsOrLevel, message, line, sourceId) => {
      const text = typeof detailsOrLevel === 'object'
        ? `${detailsOrLevel.level ?? ''}: ${detailsOrLevel.message ?? ''}`
        : `${detailsOrLevel}: ${message ?? ''} (${sourceId ?? ''}:${line ?? ''})`;
      console.error(`Renderer console: ${text}`);
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`Renderer preload error: ${preloadPath}: ${error?.stack ?? String(error)}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error(`Renderer process gone: ${JSON.stringify(details)}`);
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error(`Renderer navigation failed: ${errorCode} ${errorDescription}; mainFrame=${isMainFrame}; url=${validatedURL}`);
    });
    await window.loadFile(join(bundleDirectory, 'index.html'));
    console.log('Renderer document loaded');
    try {
      await waitDom('initial synthetic app load', `!document.querySelector('.loading-state') && document.querySelector('.composer textarea')`);
    } catch (error) {
      let domState = 'unavailable';
      try {
        domState = await evaluate(`JSON.stringify({ title: document.title, body: document.body?.innerText?.slice(0, 1500), bridge: typeof window.gigaChat, loading: document.querySelector('.loading-state')?.innerText })`);
      } catch (readError) { domState = `DOM evaluation failed: ${String(readError)}`; }
      console.error(`Initial renderer diagnostics: ${domState}`);
      try { await capture('renderer-initialization-failure'); }
      catch (captureError) { console.error(`Initial renderer screenshot failed: ${String(captureError)}`); }
      throw error;
    }
    console.log('Synthetic React app ready');

    const originalSize = window.getSize();
    const originalZoom = window.webContents.getZoomFactor();
    for (const [width, height, zoom] of [[1120, 760, 1], [960, 720, 1], [802, 720, 1], [560, 480, 1], [960, 720, 0.8], [1424, 892, 1]]) {
      window.setSize(width, height);
      window.webContents.setZoomFactor(zoom);
      await sleep(350);
      await measureLayout(`before-${width}x${height}-zoom-${zoom}`);
    }
    window.setSize(...originalSize);
    window.webContents.setZoomFactor(originalZoom);
    await sleep(180);
    await measureSidebarTracks();
    window.show();
    window.focus();
    window.webContents.focus();
    await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await sleep(40);
    const sidebarToggleSelector = 'button[aria-controls="application-sidebar"]';
    const initialSidebarToggle = JSON.parse(await evaluate(`JSON.stringify((() => {
      const button = document.querySelector(${JSON.stringify(sidebarToggleSelector)});
      const path = button?.querySelector('.icon path:last-of-type');
      return { exists: Boolean(button), collapsed: button?.dataset.sidebarCollapsed, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, pathName: path?.tagName, transition: path ? getComputedStyle(path).transition : null, transform: path ? getComputedStyle(path).transform : null };
    })())`));
    console.log(`D4 animation baseline ${JSON.stringify(initialSidebarToggle)}`);
    assert.equal(initialSidebarToggle.exists, true, 'desktop sidebar toggle must be present after track probe');
    assert.equal(initialSidebarToggle.collapsed, 'false', 'synthetic desktop starts with sidebar expanded');
    await sendMouseClick(sidebarToggleSelector);
    await waitDom('sidebar collapse state', `document.querySelector(${JSON.stringify(sidebarToggleSelector)})?.dataset.sidebarCollapsed === 'true'`);
    await waitUntil('sidebar divider begins collapsing', async () => {
      const frame = JSON.parse(await evaluate(`JSON.stringify((() => {
        const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
        return new DOMMatrixReadOnly(getComputedStyle(path).transform).m41;
      })())`));
      return frame < -0.1 && frame > -5;
    }, 1000);
    const collapseFrame = JSON.parse(await evaluate(`JSON.stringify((() => {
      const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
      return { x: new DOMMatrixReadOnly(getComputedStyle(path).transform).m41, clip: getComputedStyle(path).clipPath };
    })())`));
    if (!initialSidebarToggle.reducedMotion) assert.ok(collapseFrame.x < -0.1 && collapseFrame.x > -5, `sidebar line should be moving before the collapsed endpoint; x=${collapseFrame.x}`);
    await sendMouseClick(sidebarToggleSelector);
    await sleep(35);
    const reversalFrame = JSON.parse(await evaluate(`JSON.stringify((() => {
      const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
      return new DOMMatrixReadOnly(getComputedStyle(path).transform).m41;
    })())`));
    if (!initialSidebarToggle.reducedMotion) assert.ok(reversalFrame > collapseFrame.x, `rapid reverse should move the divider line back toward zero; collapse=${collapseFrame.x}, reverse=${reversalFrame}`);
    await waitDom('sidebar rapid reversal returns to expanded', `document.querySelector(${JSON.stringify(sidebarToggleSelector)})?.dataset.sidebarCollapsed === 'false'`);
    await sleep(260);
    const expandedLine = JSON.parse(await evaluate(`JSON.stringify((() => {
      const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
      return { x: new DOMMatrixReadOnly(getComputedStyle(path).transform).m41, clip: getComputedStyle(path).clipPath };
    })())`));
    assert.ok(Math.abs(expandedLine.x) <= 0.1, `expanded divider line must return to x=0; actual ${expandedLine.x}`);
    assert.match(expandedLine.clip, /inset\(0px\)/, 'expanded divider line must be fully visible');
    await sendMouseClick(sidebarToggleSelector);
    await waitDom('sidebar final collapsed state', `document.querySelector(${JSON.stringify(sidebarToggleSelector)})?.dataset.sidebarCollapsed === 'true'`);
    await sleep(260);
    const collapsedLine = JSON.parse(await evaluate(`JSON.stringify((() => {
      const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
      return { x: new DOMMatrixReadOnly(getComputedStyle(path).transform).m41, clip: getComputedStyle(path).clipPath };
    })())`));
    assert.ok(Math.abs(collapsedLine.x + 5) <= 0.1, `collapsed divider line must be shifted left 5px; actual ${collapsedLine.x}`);
    assert.match(collapsedLine.clip, /inset\(1px/, 'collapsed divider line must be slightly clipped at its rounded endpoints');
    await capture('sidebar-toggle-collapsed');
    await sendMouseClick(sidebarToggleSelector);
    await waitDom('sidebar final expanded state', `document.querySelector(${JSON.stringify(sidebarToggleSelector)})?.dataset.sidebarCollapsed === 'false'`);
    await sleep(260);
    await capture('sidebar-toggle-expanded');
    passed('Rendered sidebar toggle animates, reverses, and clips only the collapsed divider line');

    const dragWindowSize = window.getSize();
    const dragZoom = window.webContents.getZoomFactor();
    window.setSize(1424, 892);
    window.webContents.setZoomFactor(1);
    window.show();
    window.focus();
    window.webContents.focus();
    await sleep(350);
    const dragCapturedPointer = async (label, deltaX, cancel = false) => {
      const widthMargin = Math.max(10, Math.abs(deltaX) / 2);
      const start = JSON.parse(await evaluate(`JSON.stringify((() => {
        const divider = document.querySelector('.sidebar-resizer');
        const sidebar = document.querySelector('.sidebar');
        if (!divider) return null;
        const rect = divider.getBoundingClientRect();
        window.__auditPointerProbe = null;
        window.__auditPointerEvents = [];
        const recordPointerEvent = (event) => {
          const pointer = window.__auditPointerProbe;
          if (!pointer || event.pointerId !== pointer.pointerId) return;
          const currentDivider = document.querySelector('.sidebar-resizer');
          window.__auditPointerEvents.push({
            type: event.type,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            buttons: event.buttons,
            clientX: event.clientX,
            target: event.target?.className?.baseVal ?? event.target?.className ?? event.target?.tagName ?? null,
            captured: currentDivider?.hasPointerCapture(event.pointerId) ?? false,
            dragging: document.querySelector('.workspace')?.classList.contains('sidebar-dragging') ?? false,
            width: document.querySelector('.sidebar')?.getBoundingClientRect().width ?? null,
          });
        };
        window.addEventListener('pointerdown', (event) => {
          window.__auditPointerProbe = { pointerId: event.pointerId, pointerType: event.pointerType };
          recordPointerEvent(event);
        }, { capture: true, once: true });
        window.__auditPointerListeners = ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']
          .map((type) => ({ type, listener: recordPointerEvent }));
        for (const { type, listener } of window.__auditPointerListeners) window.addEventListener(type, listener, { capture: true });
        return {
          x: rect.left + 4,
          y: rect.top + 80,
          width: sidebar?.getBoundingClientRect().width ?? 0,
          ariaWidth: Number(divider.getAttribute('aria-valuenow')),
        };
      })())`));
      assert.ok(start, `${label}: visible sidebar resizer is required`);
      const zoom = window.webContents.getZoomFactor();
      const x = Math.round(start.x * zoom);
      const y = Math.round(start.y * zoom);
      let held = false;
      try {
        window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        held = true;
        await waitUntil(`${label} pointer capture is active`, async () => evaluate(`(() => {
          const divider = document.querySelector('.sidebar-resizer');
          const pointer = window.__auditPointerProbe;
          return Boolean(divider && pointer && pointer.pointerType === 'mouse' && divider.hasPointerCapture(pointer.pointerId));
        })()`));
        const pointer = JSON.parse(await evaluate('JSON.stringify(window.__auditPointerProbe)'));
        const movedX = Math.round((start.x + deltaX) * zoom);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: movedX, y, button: 'left', modifiers: ['leftButtonDown'] });
        await waitUntil(`${label} transient width changes`, async () => {
          const currentWidth = Number(await evaluate(`document.querySelector('.sidebar-resizer')?.getAttribute('aria-valuenow')`) ?? 0);
          return deltaX >= 0 ? currentWidth > start.width + widthMargin : currentWidth < start.width - widthMargin;
        });
        const transient = await measureLayout(`pointer-${label}-during`);
        assert.ok(deltaX >= 0 ? transient.sidebar.width > start.width + widthMargin : transient.sidebar.width < start.width - widthMargin,
          `${label}: captured pointer movement should resize the sidebar`);
        if (cancel) {
          const cancellation = await evaluate(`(() => {
            const divider = document.querySelector('.sidebar-resizer');
            const pointerId = ${pointer.pointerId};
            const capturedBefore = divider.hasPointerCapture(pointerId);
            divider.dispatchEvent(new PointerEvent('pointercancel', {
              bubbles: true, pointerId, pointerType: 'mouse', button: 0, buttons: 0,
              clientX: ${start.x + deltaX}, clientY: ${start.y},
            }));
            return { capturedBefore, type: 'pointercancel' };
          })()`);
          assert.equal(cancellation.capturedBefore, true, `${label}: pointercancel must be sent during capture`);
          window.webContents.sendInputEvent({ type: 'mouseUp', x: movedX, y, button: 'left', clickCount: 1 });
          held = false;
          await waitDom(`${label} ends dragging`, `!document.querySelector('.workspace')?.classList.contains('sidebar-dragging')`);
          await waitUntil(`${label} preserves saved width`, () => state.appSettings.sidebarWidthPx === start.width);
          assert.equal(state.appSettings.sidebarVisible, true, `${label}: cancellation must not hide the sidebar`);
        } else {
          window.webContents.sendInputEvent({ type: 'mouseUp', x: movedX, y, button: 'left', clickCount: 1 });
          held = false;
          await waitUntil(`${label} saves released width`, () => deltaX >= 0
            ? state.appSettings.sidebarWidthPx > start.width + widthMargin
            : state.appSettings.sidebarWidthPx < start.width - widthMargin);
          await waitDom(`${label} ends dragging`, `!document.querySelector('.workspace')?.classList.contains('sidebar-dragging')`);
        }
        const pointerEvents = JSON.parse(await evaluate('JSON.stringify(window.__auditPointerEvents ?? [])'));
        await evaluate(`(() => {
          for (const { type, listener } of window.__auditPointerListeners ?? []) window.removeEventListener(type, listener, true);
          window.__auditPointerListeners = [];
        })()`);
        return { startWidth: start.width, ariaStartWidth: start.ariaWidth, transientWidth: transient.sidebar.width, persistedWidth: state.appSettings.sidebarWidthPx, pointerId: pointer.pointerId, canceled: cancel, pointerEvents };
      } catch (error) {
        const diagnostic = await evaluate(`JSON.stringify({
          pointerEvents: window.__auditPointerEvents ?? [],
          width: document.querySelector('.sidebar')?.getBoundingClientRect().width ?? null,
          ariaWidth: document.querySelector('.sidebar-resizer')?.getAttribute('aria-valuenow') ?? null,
          dragging: document.querySelector('.workspace')?.classList.contains('sidebar-dragging') ?? null,
          capture: (() => {
            const pointer = window.__auditPointerProbe;
            const divider = document.querySelector('.sidebar-resizer');
            return pointer && divider ? divider.hasPointerCapture(pointer.pointerId) : null;
          })(),
        })`);
        error.message += `; synthetic pointer state: ${diagnostic}`;
        throw error;
      } finally {
        if (held) window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }
    };
    const releasedDrag = await dragCapturedPointer('release', 60);
    assert.ok(releasedDrag.persistedWidth > releasedDrag.startWidth + 40, `release: setting should persist the dragged width; ${JSON.stringify(releasedDrag)}`);
    const canceledDrag = await dragCapturedPointer('cancel', 70, true);
    assert.equal(canceledDrag.persistedWidth, releasedDrag.persistedWidth, 'pointercancel must discard the transient width');
    await waitUntil('canceled transient width returns to its saved layout', async () => {
      const actualWidth = Number(await evaluate(`document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0`));
      return Math.abs(actualWidth - canceledDrag.persistedWidth) <= 0.5;
    });
    console.log(`Synthetic pointer drag evidence ${JSON.stringify({ releasedDrag, canceledDrag })}`);
    const restoreDrag = await dragCapturedPointer('restore-width', releasedDrag.startWidth - releasedDrag.persistedWidth);
    assert.equal(restoreDrag.persistedWidth, releasedDrag.startWidth, 'synthetic drag probe must restore its initial saved width');
    await waitUntil('restored sidebar width reaches its saved layout', async () => {
      const actualWidth = Number(await evaluate(`document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0`));
      return Math.abs(actualWidth - restoreDrag.persistedWidth) <= 0.5;
    });
    window.webContents.setZoomFactor(dragZoom);
    window.setSize(dragWindowSize[0], dragWindowSize[1]);
    await sleep(350);
    passed('Synthetic captured pointer release persists width and pointercancel discards it');

    const debuggerWasAttached = window.webContents.debugger.isAttached();
    if (!debuggerWasAttached) window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await waitDom('reduced-motion media emulation is active', `matchMedia('(prefers-reduced-motion: reduce)').matches`);
      const reducedMotionStyle = JSON.parse(await evaluate(`JSON.stringify((() => {
        const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
        const durations = getComputedStyle(path).transitionDuration.split(',').map((value) => {
          const duration = value.trim();
          const amount = Number.parseFloat(duration);
          return duration.endsWith('ms') ? amount : amount * 1000;
        });
        return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, transitionMs: Math.max(...durations) };
      })())`));
      assert.equal(reducedMotionStyle.reduced, true);
      assert.ok(reducedMotionStyle.transitionMs <= 0.011, `reduced-motion divider transition should be at most 0.01ms; actual ${reducedMotionStyle.transitionMs}ms`);
      await sendMouseClick(sidebarToggleSelector);
      await waitDom('reduced-motion sidebar collapse state', `document.querySelector(${JSON.stringify(sidebarToggleSelector)})?.dataset.sidebarCollapsed === 'true'`);
      await sleep(40);
      const reducedMotionEndpoint = JSON.parse(await evaluate(`JSON.stringify((() => {
        const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
        return { x: new DOMMatrixReadOnly(getComputedStyle(path).transform).m41, clip: getComputedStyle(path).clipPath };
      })())`));
      assert.ok(Math.abs(reducedMotionEndpoint.x + 5) <= 0.1, `reduced-motion collapse must reach its endpoint; x=${reducedMotionEndpoint.x}`);
      assert.match(reducedMotionEndpoint.clip, /inset\(1px/, 'reduced-motion collapse keeps the clipped endpoint');
      await sendMouseClick(sidebarToggleSelector);
      await waitDom('reduced-motion sidebar restored expanded', `document.querySelector(${JSON.stringify(sidebarToggleSelector)})?.dataset.sidebarCollapsed === 'false'`);
      await sleep(40);
      assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
      const reducedMotionExpandedEndpoint = JSON.parse(await evaluate(`JSON.stringify((() => {
        const path = document.querySelector(${JSON.stringify(sidebarToggleSelector)}).querySelector('.icon path:last-of-type');
        return { x: new DOMMatrixReadOnly(getComputedStyle(path).transform).m41, clip: getComputedStyle(path).clipPath };
      })())`));
      assert.ok(Math.abs(reducedMotionExpandedEndpoint.x) <= 0.1, `reduced-motion expanded endpoint must return to zero; x=${reducedMotionExpandedEndpoint.x}`);
      assert.match(reducedMotionExpandedEndpoint.clip, /inset\(0px\)/, 'reduced-motion expanded endpoint must be fully visible');
      passed('Rendered sidebar toggle reaches both endpoints with reduced motion enabled');
    } finally {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      if (!debuggerWasAttached && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    }

    const layoutReport = join(fixturePath, 'layout-measurements.json');
    await writeFile(layoutReport, `${JSON.stringify(layoutMeasurements, null, 2)}\n`, 'utf8');
    console.log(`Layout measurement report retained: ${layoutReport}`);

    const draftSelector = '.composer textarea';
    const closeCreateStart = state.pendingCreates.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    state.deferCreate = true;
    await fillTextarea(draftSelector, 'close waits for accepted home draft');
    await waitUntil('home draft creation before close', () => state.pendingCreates.length === closeCreateStart + 1);
    const closePendingCreate = state.pendingCreates[closeCreateStart];
    const closeAttempt = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('pending close dialog', `document.querySelector('.close-pending-dialog')?.open === true`);
    await capture('close-pending-home-create');
    window.webContents.send('audit:permission', {
      id: 'approval-during-close', resource: 'project-files', action: 'read', target: 'synthetic file',
      reason: 'Synthetic close-barrier approval request.', expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await sleep(120);
    assert.equal(await evaluate(`document.querySelector('.close-pending-dialog')?.open === true`), true,
      'a late permission approval must not cover the close-pending modal');
    assert.equal(await evaluate(`document.querySelector('.approval-dialog')?.open === true`), false);
    assert.equal(state.closeReadyCalls, 0, 'renderer must finish an accepted home create and its final draft before main close-ready');
    const createsBeforeBlockedInput = state.createCalls.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    assert.equal(state.createCalls.length, createsBeforeBlockedInput, 'frozen close must block new background actions');
    resolveCreate(closePendingCreate);
    await waitUntil('close-ready after accepted home draft settles', () => state.closeReadyCalls === 1);
    assert.equal((await closeAttempt).status, 'failed');
    assert.equal(state.details.get(`chat-new-${closePendingCreate.index}`)?.draft, 'close waits for accepted home draft');
    await waitDom('close failure dialog after accepted home create', `document.querySelector('.close-error-dialog')?.open === true`);
    await capture('close-error-home-create');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('renderer resumes after close failure', async () => state.closeReturnCalls === 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    await waitDom('deferred approval becomes available after return', `document.querySelector('.approval-dialog')?.open === true`);
    await clickText('.approval-dialog button', 'Отклонить');
    await waitUntil('synthetic deferred approval is rejected', () => state.permissionResponses.some((response) => response.id === 'approval-during-close' && response.allowed === false));
    state.deferCreate = false;
    passed('Rendered close waits for an accepted home create and persists its final draft');

    state.deferChatGets = true;
    const updatesBeforeLoading = state.updateCalls.length;
    await clickChat('Chat A');
    await waitUntil('first A read', () => (state.pendingGets.get('chat-a')?.length ?? 0) === 1);
    await waitDom('loading visual state', `document.querySelector('.chat-view .loading-state')?.textContent.includes('Загрузка')`);
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.disabled`), true, 'composer input must remain disabled until the original chat detail loads');
    assert.equal(state.updateCalls.length, updatesBeforeLoading, 'loading chat must not autosave an empty draft');
    await capture('chat-loading');
    await clickChat('Chat B');
    await waitUntil('B read', () => (state.pendingGets.get('chat-b')?.length ?? 0) === 1);
    await clickChat('Chat A');
    await waitUntil('second A read', () => (state.pendingGets.get('chat-a')?.length ?? 0) === 2);
    state.pendingGets.get('chat-a')[1].resolve(clone(makeDetail(chatA, 'A current')));
    await waitDom('current A content', `document.querySelector('.chat-history')?.textContent.includes('A current')`);
    state.pendingGets.get('chat-b')[0].resolve(clone(makeDetail(chatB, 'B stale')));
    state.pendingGets.get('chat-a')[0].resolve(clone(makeDetail(chatA, 'A stale')));
    await sleep(120);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat A');
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('A current')`), true);
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('A stale') || document.querySelector('.chat-history')?.textContent.includes('B stale')`), false);

    window.webContents.send('audit:runtime', {
      id: 'turn-a-completed', chatId: 'chat-a', status: 'completed', createdAt: timestamp, activity: [],
    });
    await waitUntil('runtime completion detail read', () => (state.pendingGets.get('chat-a')?.length ?? 0) === 3);
    await clickChat('Chat B');
    await waitUntil('B read after runtime completion', () => (state.pendingGets.get('chat-b')?.length ?? 0) === 2);
    await clickChat('Chat A');
    await waitUntil('new A read after runtime completion', () => (state.pendingGets.get('chat-a')?.length ?? 0) === 4);
    state.pendingGets.get('chat-a')[3].resolve(clone(makeDetail(chatA, 'A after completed turn')));
    await waitDom('new A after completed turn', `document.querySelector('.chat-history')?.textContent.includes('A after completed turn')`);
    state.pendingGets.get('chat-a')[2].resolve(clone(makeDetail(chatA, 'A stale completed turn')));
    state.pendingGets.get('chat-b')[1].resolve(clone(makeDetail(chatB, 'B stale after completed turn')));
    await sleep(120);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat A');
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('A after completed turn')`), true);
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('stale completed turn')`), false);
    state.deferChatGets = false;
    passed('Rendered chat load and completed-turn reads ignore late A→B→A responses');

    state.rejectNextGet = 'chat-b';
    await clickChat('Chat B');
    await waitDom('chat load error and retry', `document.querySelector('.chat-view [role="alert"] button')?.textContent.includes('Повторить')`);
    await capture('chat-load-error');
    await clickText('.chat-view [role="alert"] button', 'Повторить');
    await waitDom('retried chat B', `document.querySelector('.chat-history')?.textContent.includes('B baseline')`);
    passed('Rendered chat load error keeps retry available');

    state.deferDraftUpdates = true;
    await clickChat('Chat A');
    await waitDom('chat A ready for draft', `document.querySelector('.chat-history')?.textContent.includes('A baseline')`);
    await fillTextarea(draftSelector, 'x');
    await waitUntil('draft x save', () => state.pendingDraftUpdates.length === 1);
    await fillTextarea(draftSelector, 'y');
    await waitUntil('draft y save', () => state.pendingDraftUpdates.length === 2);
    await fillTextarea(draftSelector, 'x');
    await waitUntil('second draft x save', () => state.pendingDraftUpdates.length === 3);
    const firstDraftSave = state.pendingDraftUpdates[0];
    firstDraftSave.resolve(updateSummary(firstDraftSave.id, firstDraftSave.patch));
    const middleDraftSave = state.pendingDraftUpdates[1];
    middleDraftSave.resolve(updateSummary(middleDraftSave.id, middleDraftSave.patch));
    assert.equal(state.details.get('chat-a').draft, 'y', 'the latest successful middle write should be reflected before the final save fails');
    await clickChat('Chat B');
    await waitDom('B during draft ABA retention', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    await clickChat('Chat A');
    await waitDom('A restored from retained draft buffer', `document.querySelector('.chat-header-title')?.textContent === 'Chat A' && document.querySelector('.chat-history')?.textContent.includes('A baseline')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.value`), 'x', 'x→y→x buffer must survive the earlier x save after navigating away and back');
    const latestDraftSave = state.pendingDraftUpdates[2];
    latestDraftSave.reject(new Error('Synthetic latest draft write failure'));
    await waitDom('latest draft save error', `document.querySelector('.chat-view [role="alert"] strong')?.textContent.includes('Черновик не сохранён')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.value`), 'x');
    await capture('chat-draft-save-error');
    state.deferDraftUpdates = false;
    await clickText('.chat-view [role="alert"] button', 'Повторить сохранение');
    await waitDom('draft retry clears error', `!document.querySelector('.chat-view [role="alert"] strong')?.textContent.includes('Черновик не сохранён')`);
    assert.equal(state.details.get('chat-a').draft, 'x', 'retry must persist the newest x after the preceding y save and failed x save');
    passed('Rendered x→y→x draft failure retains the latest text for retry');

    state.deferImports = true;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('A file import', () => state.pendingImports.length === 1);
    await clickChat('Chat B');
    await waitDom('chat B after navigation', `document.querySelector('.chat-header-title')?.textContent === 'Chat B' && document.querySelector('.chat-history')?.textContent.includes('B baseline')`);
    const importedA = clone(makeDetail(chats.find((item) => item.id === 'chat-a'), 'Imported only into A'));
    state.details.set('chat-a', importedA);
    state.pendingImports[0].request.resolve(importedA);
    await sleep(140);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat B');
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('Imported only into A')`), false);
    state.deferImports = false;
    passed('Rendered late import updates its source chat without replacing the active chat');

    await clickChat('Chat A');
    await waitDom('chat A ready for accepted Skill test', `document.querySelector('.chat-header-title')?.textContent === 'Chat A' && !document.querySelector('.composer textarea')?.disabled`);
    state.details.get('chat-b').nextTurnSkillId = 'global/other';
    state.deferSkillUpdates = true;
    await fillTextarea(draftSelector, '$audit');
    await clickText('.composer-suggestions .composer-suggestion', 'Audit');
    await waitUntil('A Skill save pending before submit', () => state.pendingSkillUpdates.length === 1 && state.pendingSkillUpdates[0].id === 'chat-a');
    assert.equal(state.pendingSkillUpdates[0].patch.nextTurnSkillId, 'global/audit');
    await fillTextarea(draftSelector, 'message accepted by chat A');
    await click('.send-button-wrap .send-button');
    await waitDom('A submit waits for its captured Skill save', `document.querySelector('.composer textarea')?.disabled`);
    await clickChat('Chat B');
    await waitDom('B is active while A submit awaits its Skill save', `document.querySelector('.chat-header-title')?.textContent === 'Chat B' && document.querySelector('.composer-skill-selection strong')?.textContent === 'Other'`);
    await click('button[aria-label="Снять выбор Skill"]');
    const acceptedASkillSave = state.pendingSkillUpdates[0];
    resolveSkillUpdate(acceptedASkillSave);
    await waitUntil('B Skill update queued after A save', () => state.pendingSkillUpdates.length === 2 && state.pendingSkillUpdates[1].id === 'chat-b');
    await waitUntil('A accepted message records its own Skill', () => state.appendCalls.some((item) => item.id === 'chat-a' && item.text === 'message accepted by chat A'));
    const acceptedAAppend = state.appendCalls.find((item) => item.id === 'chat-a' && item.text === 'message accepted by chat A');
    assert.equal(acceptedAAppend.nextTurnSkillId, 'global/audit', 'B’s later Skill change must not be applied to A’s accepted message');
    assert.equal(state.pendingSkillUpdates[1].patch.nextTurnSkillId, null, 'the deferred second operation must belong only to B');
    resolveSkillUpdate(state.pendingSkillUpdates[1]);
    await waitUntil('B Skill removal completes', () => state.details.get('chat-b').nextTurnSkillId === null);
    assert.equal(state.details.get('chat-a').nextTurnSkillId, 'global/audit');
    assert.equal(state.updateCalls.some((item) => item.id === 'chat-a' && Object.hasOwn(item.patch, 'nextTurnSkillId') && item.patch.nextTurnSkillId === null), false);
    state.deferSkillUpdates = false;
    await waitDom('B remains active after A submit completes', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    passed('Rendered submit keeps A accepted Skill when B changes its own Skill during the wait');

    await clickText('.sidebar-actions button', 'Новый чат');
    await click('.composer-permission-menu > button');
    await clickText('.action-menu-content:popover-open .permission-picker-option', 'Подтверждать за меня');
    await click('button[aria-label="Действия проекта Project A"]');
    await clickText('.action-menu-content:popover-open button', 'Новый чат в проекте');
    await waitDom('new project chat after home profile choice', `document.querySelector('.chat-header-title')?.textContent.startsWith('New chat')`);
    await waitDom('new project chat ready for profile selection', `!document.querySelector('.composer textarea')?.disabled && !document.querySelector('.composer-permission-menu > button')?.disabled`);
    const profileChatId = state.createCalls.at(-1) ? `chat-new-${state.createCalls.at(-1).index}` : '';
    assert.ok(profileChatId, 'project chat should have a stable synthetic id');
    state.deferPermissionUpdates = true;
    await click('.composer-permission-menu > button');
    await clickText('.action-menu-content:popover-open .permission-picker-option', 'Полный доступ');
    await waitUntil('A current profile save is pending', () => state.pendingPermissionUpdates.length === 1
      && state.pendingPermissionUpdates[0].id === profileChatId
      && state.pendingPermissionUpdates[0].patch.nextTurnPermissionProfile === 'full');
    await fillTextarea(draftSelector, 'accepted profile remains stable');
    await click('.send-button-wrap .send-button');
    await waitDom('profile-bound submit waits for its current profile save', `document.querySelector('.composer textarea')?.disabled`);
    await click('.composer-permission-menu > button');
    await clickText('.action-menu-content:popover-open .permission-picker-option', 'Спросить');
    assert.match(await evaluate(`document.querySelector('.composer-permission-menu > button')?.textContent ?? ''`), /Спросить/,
      'the latest same-chat profile choice should update the visible composer immediately');
    resolvePermissionUpdate(state.pendingPermissionUpdates[0]);
    await waitUntil('only the newer profile save follows the accepted save', () => state.pendingPermissionUpdates.length >= 2);
    assert.equal(state.pendingPermissionUpdates.length, 2, 'submit must not replay the captured old profile after the newer selection');
    assert.equal(state.pendingPermissionUpdates[1].id, profileChatId);
    assert.equal(state.pendingPermissionUpdates[1].patch.nextTurnPermissionProfile, null,
      'the newer default profile choice must remain the only next-turn write');
    await waitUntil('profile-bound local message accepted', () => state.appendCalls.some((item) => item.id === profileChatId && item.text === 'accepted profile remains stable'));
    resolvePermissionUpdate(state.pendingPermissionUpdates[1]);
    await waitUntil('latest same-chat profile persisted', () => state.details.get(profileChatId)?.nextTurnPermissionProfile === null);
    await waitDom('latest same-chat profile remains visible after append response', `document.querySelector('.composer-permission-menu > button')?.textContent.includes('Спросить')`);
    await capture('same-chat-profile-reselection');
    state.deferPermissionUpdates = false;
    passed('Rendered same-chat profile reselection survives a deferred submit and its late response');

    updateSummary(profileChatId, { nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/audit' });
    window.webContents.send('audit:runtime', {
      id: 'turn-unconsumed-cancelled', chatId: profileChatId, status: 'cancelled', createdAt: timestamp, activity: [],
    });
    await waitDom('cancelled turn keeps its unconsumed profile', `document.querySelector('.composer-permission-menu > button')?.textContent.includes('Полный доступ')`);
    await waitDom('cancelled turn keeps its unconsumed Skill', `document.querySelector('.composer-skill-selection strong')?.textContent === 'Audit'`);

    const staleTerminalDetail = clone(state.details.get(profileChatId));
    state.deferChatGets = true;
    window.webContents.send('audit:runtime', {
      id: 'turn-terminal-stale-read', chatId: profileChatId, status: 'cancelled', createdAt: timestamp, activity: [],
    });
    await waitUntil('terminal refresh waits for a detail read', () => (state.pendingGets.get(profileChatId)?.length ?? 0) === 1);
    await click('.composer-permission-menu > button');
    await clickText('.action-menu-content:popover-open .permission-picker-option', 'Спросить');
    await click('button[aria-label="Снять выбор Skill"]');
    state.deferChatGets = false;
    state.pendingGets.get(profileChatId)[0].resolve(staleTerminalDetail);
    await waitDom('late terminal read preserves the newer default profile', `document.querySelector('.composer-permission-menu > button')?.textContent.includes('Спросить')`);
    await waitDom('late terminal read preserves the newer cleared Skill', `!document.querySelector('.composer-skill-selection')`);
    await waitUntil('newer profile and Skill choices persist', () => state.details.get(profileChatId)?.nextTurnPermissionProfile === null
      && state.details.get(profileChatId)?.nextTurnSkillId === null);

    updateSummary(profileChatId, { nextTurnPermissionProfile: 'full', nextTurnSkillId: 'global/audit' });
    window.webContents.send('audit:runtime', {
      id: 'turn-terminal-before-consume', chatId: profileChatId, status: 'cancelled', createdAt: timestamp, activity: [],
    });
    await waitDom('latest unconsumed profile refreshed', `document.querySelector('.composer-permission-menu > button')?.textContent.includes('Полный доступ')`);
    await waitDom('latest unconsumed Skill refreshed', `document.querySelector('.composer-skill-selection strong')?.textContent === 'Audit'`);
    updateSummary(profileChatId, { nextTurnPermissionProfile: null, nextTurnSkillId: null });
    window.webContents.send('audit:runtime', {
      id: 'turn-terminal-after-consume', chatId: profileChatId, status: 'failed', createdAt: timestamp, activity: [],
    });
    await waitDom('failed terminal event refreshes consumed profile', `document.querySelector('.composer-permission-menu > button')?.textContent.includes('Спросить')`);
    await waitDom('failed terminal event refreshes consumed Skill', `!document.querySelector('.composer-skill-selection')`);
    await capture('terminal-consumed-profile-skill');
    passed('Rendered terminal refresh preserves unconsumed choices and applies newer same-chat selections');

    await clickChat('Chat A');
    await waitDom('A before move test', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
    state.deferProjectMoves = true;
    await click('button[aria-label="Действия чата Chat A"]');
    await clickText('.action-menu-content:popover-open .submenu-trigger', 'Переместить в проект');
    await clickText('.submenu-content:popover-open button', 'Project B');
    await waitUntil('deferred A project move', () => state.pendingProjectMoves.length === 1);
    await clickChat('Chat B');
    await waitDom('B active while A move pending', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    const pendingMove = state.pendingProjectMoves[0];
    pendingMove.resolve(updateSummary(pendingMove.id, pendingMove.patch));
    await waitUntil('A project move persisted', () => state.chats.find((item) => item.id === 'chat-a')?.projectId === 'project-b');
    await sleep(100);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat B');
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('B baseline')`), true);
    state.deferProjectMoves = false;
    const projectBExpanded = await evaluate(`(() => [...document.querySelectorAll('.project-section .project-tree > .list-row > .list-row-main')].find((button) => button.textContent.includes('Project B'))?.getAttribute('aria-expanded') === 'true')()`);
    if (!projectBExpanded) await clickText('.project-section .project-tree > .list-row > .list-row-main', 'Project B');
    await waitDom('moved chat appears in Project B tree', `document.querySelector('#project-chats-project-b .nested-chat-row')`);
    const nestedLine = JSON.parse(await evaluate(`JSON.stringify((() => {
      const tree = document.querySelector('#project-chats-project-b');
      const row = tree?.querySelector('.nested-chat-row');
      return { border: row ? getComputedStyle(tree).borderLeftWidth : null, margin: row ? getComputedStyle(tree).marginLeft : null, selectedRow: Boolean(row?.classList.contains('selected')) };
    })())`));
    assert.equal(nestedLine.border, '0px', 'expanded project chats must not show the old gray child line');
    await clickChat('Chat A');
    await waitDom('selected nested chat and project header marker', `document.querySelector('.chat-header-title')?.textContent === 'Chat A' && document.querySelector('.chat-header-folder') && document.querySelector('#project-chats-project-b .nested-chat-row.selected')`);
    const selectedNestedLine = await evaluate(`getComputedStyle(document.querySelector('#project-chats-project-b')).borderLeftWidth`);
    assert.equal(selectedNestedLine, '0px', 'selected nested chat must not restore the old gray child line');
    const projectHeader = JSON.parse(await evaluate(`JSON.stringify((() => {
      const title = document.querySelector('.chat-header-title');
      return { size: getComputedStyle(title).fontSize, weight: getComputedStyle(title).fontWeight, folder: Boolean(document.querySelector('.chat-header-folder')) };
    })())`));
    assert.equal(projectHeader.size, '18px', 'chat title should use the reviewed 18px size');
    assert.equal(projectHeader.weight, '700', 'chat title should use a bold weight');
    assert.equal(projectHeader.folder, true, 'project chat should show its decorative folder marker');
    await capture('project-chat-header');
    await clickChat('Chat B');
    await waitDom('standalone chat without project marker', `document.querySelector('.chat-header-title')?.textContent === 'Chat B' && !document.querySelector('.chat-header-folder')`);
    await capture('standalone-chat-header');
    passed('Rendered project nesting, square-free child list, and project-aware chat title');
    passed('Rendered late project move updates its own chat without replacing another active chat');

    const pendingNavigationCreateStart = state.pendingCreates.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    state.deferCreate = true;
    await click('.composer-project-menu > button');
    await clickText('.action-menu-content:popover-open .project-picker-option', 'Project A');
    await fillTextarea(draftSelector, 'draft 1');
    await waitUntil('pending home create', () => state.pendingCreates.length === pendingNavigationCreateStart + 1);
    await fillTextarea(draftSelector, 'draft 2');
    await fillTextarea(draftSelector, 'draft 3');
    await click('.composer-project-menu > button');
    await clickText('.action-menu-content:popover-open .project-picker-option', 'Project B');
    await clickChat('Chat B');
    await waitDom('navigation away from pending create', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    const pendingCreate = state.pendingCreates[pendingNavigationCreateStart];
    resolveCreate(pendingCreate);
    await waitUntil('home draft persisted after navigation', () => {
      const chat = state.chats.find((item) => item.id === `chat-new-${pendingCreate.index}`);
      return chat && state.details.get(chat.id)?.draft === 'draft 3' && chat.projectId === 'project-b'
        && state.updateCalls.some((item) => item.id === chat.id && item.patch.projectId === 'project-b');
    });
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat B');
    state.deferCreate = false;
    passed('Rendered pending home draft keeps text/project and does not take over a newer route');

    await clickText('.sidebar-actions button', 'Новый чат');
    state.rejectNextCreate = true;
    await fillTextarea(draftSelector, 'keep this draft');
    await waitDom('failed home draft with retry', `document.querySelector('.home-view') && document.querySelector('.composer-stack [role="alert"] button')?.textContent.includes('Повторить сохранение')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.value`), 'keep this draft');
    await capture('home-draft-create-error');
    await clickText('.composer-stack [role="alert"] button', 'Повторить сохранение');
    await waitDom('home draft retry opens created chat', `document.querySelector('.chat-header-title')?.textContent.startsWith('New chat')`);
    passed('Rendered failed home create preserves the draft and retry succeeds');

    await clickText('.sidebar-actions button', 'Новый чат');
    state.deferCreate = true;
    await click('.composer-permission-menu > button');
    await clickText('.action-menu-content:popover-open .permission-picker-option', 'Подтверждать за меня');
    await waitDom('home permission choice applied', `document.querySelector('.composer-permission-menu > button')?.textContent.includes('Подтверждать за меня')`);
    const pendingCreateStart = state.pendingCreates.length;
    await fillTextarea(draftSelector, '$audit');
    await waitUntil('home session with a Skill pending', () => state.pendingCreates.length === pendingCreateStart + 1);
    await clickText('.composer-suggestions .composer-suggestion', 'Audit');
    await fillTextarea(draftSelector, 'old session owns this draft');
    await waitDom('home session owns selected Skill', `document.querySelector('.composer-skill-selection')?.textContent.includes('Audit')`);
    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('new home uses default profile', `document.querySelector('.home-view') && document.querySelector('.composer-permission-menu > button')?.textContent.includes('Спросить')`);
    assert.equal(await evaluate(`document.querySelector('.composer-skill-selection')`), null, 'new home must not inherit the prior session Skill');
    const oldSessionCreate = state.pendingCreates[pendingCreateStart];
    const oldSessionChatId = `chat-new-${oldSessionCreate.index}`;
    resolveCreate(oldSessionCreate);
    await waitUntil('detached session retains its own profile and Skill', () => {
      const detail = state.details.get(oldSessionChatId);
      return detail?.draft === 'old session owns this draft'
        && detail.nextTurnPermissionProfile === 'approve'
        && detail.nextTurnSkillId === 'global/audit';
    });
    await fillTextarea(draftSelector, 'fresh default session');
    await waitUntil('new default home session pending', () => state.pendingCreates.length === pendingCreateStart + 2);
    const newSessionCreate = state.pendingCreates[pendingCreateStart + 1];
    resolveCreate(newSessionCreate);
    const newSessionChatId = `chat-new-${newSessionCreate.index}`;
    await waitUntil('new session saved without stale choices', () => {
      const detail = state.details.get(newSessionChatId);
      return detail?.draft === 'fresh default session'
        && detail.nextTurnPermissionProfile === null
        && detail.nextTurnSkillId === null;
    });
    state.deferCreate = false;
    passed('Rendered new home session starts with defaults while a detached draft keeps its own choices');

    await clickText('.sidebar-actions button', 'Новый чат');
    state.deferCreate = true;
    const failedDetachedCreateStart = state.pendingCreates.length;
    await fillTextarea(draftSelector, 'retry after navigating away');
    await waitUntil('detached create pending before navigation', () => state.pendingCreates.length === failedDetachedCreateStart + 1);
    await clickChat('Chat B');
    await waitDom('different chat active before detached create fails', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    state.pendingCreates[failedDetachedCreateStart].reject(new Error('Synthetic create failed after navigation'));
    await sleep(100);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat B');
    state.deferCreate = false;
    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('failed detached draft remains recoverable', `[...document.querySelectorAll('.project-folder-choice button')].some((button) => button.textContent.includes('Восстановить черновик'))`);
    assert.equal(await evaluate(`document.querySelector('.project-folder-choice')?.textContent.includes('retry after navigating away')`), true);
    await clickText('.project-folder-choice button', 'Восстановить черновик');
    await waitDom('recovered detached draft opens its chat', `document.querySelector('.chat-header-title')?.textContent.startsWith('New chat')`);
    await waitUntil('recovered detached text persisted', () => [...state.details.values()].some((detail) => detail.draft === 'retry after navigating away'));
    passed('Rendered failed create after navigation remains reachable and retryable');

    state.rejectProjectRead = 'project-a';
    await click('button[aria-label="Действия проекта Project A"]');
    await clickText('.action-menu-content:popover-open button', 'Настройки проекта');
    await waitDom('project instruction load error', `document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.disabled && document.querySelector('.project-settings-dialog [role="alert"] button')?.textContent.includes('Повторить')`);
    await clickText('.project-settings-dialog [role="alert"] button', 'Повторить чтение');
    await waitDom('project instruction retry enabled', `document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project-a')`);
    await click('.project-settings-dialog .dialog-close');
    await waitDom('failed-load dialog closed', `!document.querySelector('dialog[open]')`);
    passed('Rendered instruction load error stays disabled until a successful retry');

    state.deferProjectReads = true;
    await click('button[aria-label="Действия проекта Project A"]');
    await clickText('.action-menu-content:popover-open button', 'Настройки проекта');
    await waitUntil('late project A read', () => (state.pendingProjectReads.get('project-a')?.length ?? 0) === 1);
    await click('.project-settings-dialog .dialog-close');
    await waitDom('project A dialog closed while read pending', `!document.querySelector('dialog[open]')`);
    await click('button[aria-label="Действия проекта Project B"]');
    await clickText('.action-menu-content:popover-open button', 'Настройки проекта');
    await waitUntil('late project B read', () => (state.pendingProjectReads.get('project-b')?.length ?? 0) === 1);
    state.pendingProjectReads.get('project-b')[0].resolve({ text: '# project B current', revision: 'project-b-current' });
    await waitDom('project B content', `document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project B current')`);
    state.pendingProjectReads.get('project-a')[0].resolve({ text: '# project A stale', revision: 'project-a-stale' });
    await sleep(100);
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project B current')`), true);
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project A stale')`), false);
    assert.equal(await evaluate(`document.querySelector('.project-settings-dialog')?.open`), true, 'late close event from project A must not close the reopened project B dialog');
    assert.match(await evaluate(`document.querySelector('.project-settings-dialog h2')?.textContent ?? ''`), /Project B/);
    state.deferProjectReads = false;
    state.conflictNextProjectSave = true;
    await fillTextarea('textarea[aria-label="Инструкции проекта AGENTS.md"]', '# local conflict draft');
    try {
      await waitDom('project instruction conflict controls', `[...document.querySelectorAll('.project-settings-dialog button')].some((button) => button.textContent.includes('Перечитать файл'))`, 8000);
    } catch (error) {
      const dialogState = await evaluate(`JSON.stringify({ open: document.querySelector('.project-settings-dialog')?.open, title: document.querySelector('.project-settings-dialog h2')?.textContent, text: document.querySelector('.project-settings-dialog')?.innerText?.slice(0, 1800), editorValue: document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value, editorDisabled: document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.disabled, buttons: [...(document.querySelector('.project-settings-dialog')?.querySelectorAll('button') ?? [])].map((button) => ({ text: button.textContent, disabled: button.disabled })), alerts: [...(document.querySelector('.project-settings-dialog')?.querySelectorAll('[role="alert"]') ?? [])].map((item) => item.innerText) })`);
      console.error(`Project conflict dialog diagnostic: ${dialogState}`);
      console.error(`Project save calls: ${JSON.stringify(state.projectSaveCalls.map(({ id, expectedRevision }) => ({ id, expectedRevision })))}`);
      await capture('project-instruction-conflict-timeout');
      throw error;
    }
    await capture('project-instruction-conflict');
    await evaluate(`(() => { const dialog = document.querySelector('.project-settings-dialog'); if (dialog) dialog.scrollTop = dialog.scrollHeight; })()`);
    await capture('project-instruction-conflict-bottom');
    const conflictSaveCount = state.projectSaveCalls.length;
    const copiesBeforeConflict = state.projectInstructionCopies.length;
    await focusProjectEditorThenAction('Сохранить черновик отдельно');
    assert.equal(state.projectSaveCalls.length, conflictSaveCount, 'blur after conflict must not retry the write');
    await waitUntil('project conflict draft copy requested', () => state.projectInstructionCopies.length === copiesBeforeConflict + 1);
    assert.deepEqual(state.projectInstructionCopies.at(-1), { id: 'project-b', text: '# local conflict draft' });
    await waitDom('project conflict recovery buttons remain after copy', `
      document.querySelector('.project-settings-dialog [role="alert"] strong')?.textContent.includes('AGENTS.md изменён')
      && [...document.querySelectorAll('.project-settings-dialog button')].some((button) => button.textContent.includes('Перечитать файл'))
      && [...document.querySelectorAll('.project-settings-dialog button')].some((button) => button.textContent.includes('Сохранить черновик отдельно'))
    `);
    await focusProjectEditorThenAction('Перечитать файл');
    assert.equal(state.projectSaveCalls.length, conflictSaveCount, 'repeated conflict blur must not retry the write');
    await waitDom('explicit reload clears stale conflict and dialog error', `
      document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value === '# instructions project-b'
      && !document.querySelector('.project-settings-dialog [role="alert"] strong')?.textContent.includes('AGENTS.md изменён')
      && !document.querySelector('.dialog-error')
    `);
    state.conflictNextProjectSave = true;
    await fillTextarea('textarea[aria-label="Инструкции проекта AGENTS.md"]', '# local conflict draft');
    await waitDom('second project conflict controls', `[...document.querySelectorAll('.project-settings-dialog button')].some((button) => button.textContent.includes('Перечитать файл'))`);
    const doneConflictSaveCount = state.projectSaveCalls.length;
    await focusProjectEditorThenAction('Готово');
    assert.equal(state.projectSaveCalls.length, doneConflictSaveCount, 'Done blur must not retry the conflicting write');
    await waitDom('Done keeps project conflict recoverable', `
      document.querySelector('.project-settings-dialog')?.open
      && document.querySelector('.project-settings-dialog [role="alert"] strong')?.textContent.includes('AGENTS.md изменён')
      && document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value === '# local conflict draft'
      && [...document.querySelectorAll('.project-settings-dialog button')].some((button) => button.textContent.includes('Перечитать файл'))
    `);
    await clickText('.project-settings-dialog button', 'Перечитать файл');
    await waitDom('Done conflict explicitly reloaded', `
      document.querySelector('textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value === '# instructions project-b'
      && !document.querySelector('.project-settings-dialog [role="alert"] strong')?.textContent.includes('AGENTS.md изменён')
      && !document.querySelector('.dialog-error')
    `);
    await click('.project-settings-dialog .dialog-close');
    await waitDom('project B dialog closed', `!document.querySelector('dialog[open]')`);
    passed('Rendered project conflict survives editor blur, copy, and Done until explicit reload');

    state.deferChooseFolder = true;
    await click('button[aria-label="Действия проекта Project A"]');
    await clickText('.action-menu-content:popover-open button', 'Настройки проекта');
    await waitDom('project A settings open for folder test', `document.querySelector('.project-settings-dialog textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project-a')`);
    await clickText('.project-settings-dialog button', 'Изменить папку');
    await waitUntil('deferred project folder change', () => state.pendingFolderChanges.length === 1);
    await click('.project-settings-dialog .dialog-close');
    await waitDom('folder editor closed', `!document.querySelector('dialog[open]')`);
    const folderChange = state.pendingFolderChanges[0];
    const projectA = state.projects.find((item) => item.id === folderChange.id);
    Object.assign(projectA, { workingFolder: 'C:\\audit\\folder-after-navigation', updatedAt: timestamp });
    await click('button[aria-label="Действия проекта Project B"]');
    await clickText('.action-menu-content:popover-open button', 'Настройки проекта');
    await waitDom('project B settings open while A folder request pending', `document.querySelector('.project-settings-dialog textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project-b')`);
    folderChange.request.resolve({ project: clone(projectA), warning: null });
    await waitUntil('A folder update applied to its project row', () => state.projects.find((item) => item.id === 'project-a')?.workingFolder.includes('folder-after-navigation'));
    assert.equal(await evaluate(`document.querySelector('.project-settings-dialog textarea[aria-label="Инструкции проекта AGENTS.md"]')?.value.includes('project-b')`), true);
    await click('.project-settings-dialog .dialog-close');
    await waitDom('project B folder dialog closed', `!document.querySelector('dialog[open]')`);
    await click('button[aria-label="Действия проекта Project A"]');
    await clickText('.action-menu-content:popover-open button', 'Настройки проекта');
    await waitDom('correct project folder remains assigned', `document.querySelector('.project-settings-dialog .project-folder-choice p')?.textContent.includes('folder-after-navigation')`);
    await click('.project-settings-dialog .dialog-close');
    await waitDom('folder readback dialog closed', `!document.querySelector('dialog[open]')`);
    state.deferChooseFolder = false;
    passed('Rendered late folder result remains bound to the original project');

    await clickText('.sidebar-actions button', 'Новый чат');
    state.deferImports = true;
    const staleHomeImportIndex = state.pendingImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('home file import before creating another draft', () => state.pendingImports.length === staleHomeImportIndex + 1);
    const staleHomeImport = state.pendingImports[staleHomeImportIndex];
    assert.equal(staleHomeImport.id, null, 'a fresh home import belongs to the not-yet-created home chat');
    await clickText('.sidebar-actions button', 'Новый чат');
    const pendingNewHomeStart = state.pendingCreates.length;
    state.deferCreate = true;
    await fillTextarea(draftSelector, 'new home draft survives old import');
    await waitUntil('new home draft create starts', () => state.pendingCreates.length === pendingNewHomeStart + 1);
    const newHomeCreate = state.pendingCreates[pendingNewHomeStart];
    const staleImportedSummary = makeChat('chat-import-old-home', 'Imported old home');
    const staleImportedDetail = makeDetail(staleImportedSummary, 'Old home file import');
    state.chats.unshift(staleImportedSummary);
    state.details.set(staleImportedSummary.id, staleImportedDetail);
    staleHomeImport.request.resolve(clone(staleImportedDetail));
    await waitDom('new home remains on its own draft after late import', `document.querySelector('.home-view') && document.querySelector('.composer textarea')?.value === 'new home draft survives old import'`);
    resolveCreate(newHomeCreate);
    await waitDom('new home creation completes independently of the late import', `document.querySelector('.chat-header-title')?.textContent === 'New chat ${newHomeCreate.index}'`);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent.includes('Imported old home')`), false);
    state.deferCreate = false;
    state.deferImports = false;
    passed('Rendered late import from an old home cannot replace a newer home draft');

    state.deferImports = true;
    const closeImportIndex = state.pendingImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('accepted import before close', () => state.pendingImports.length === closeImportIndex + 1);
    const acceptedImport = state.pendingImports[closeImportIndex];
    state.deferSettingUpdates = true;
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Оформление');
    await clickText('.theme-option', 'Тёплая');
    await waitUntil('accepted settings write before close', () => state.pendingSettingUpdates.length === 1);
    await clickText('.settings-nav-item', 'Разрешения');
    await waitDom('config editor before close', `document.querySelector('.config-editor')`);
    state.deferConfigSaves = true;
    await fillTextarea('.config-editor', 'allow = []\n');
    await click('.config-actions .primary-button');
    await waitUntil('accepted config save before close', () => state.pendingConfigSaves.length === 1);
    const closeCallsBeforeMixedDrain = state.closeReadyCalls;
    console.log(`MIXED_CLOSE before request ${JSON.stringify({ visible: window.isVisible(), state: await evaluate(`JSON.stringify({ visibility: document.visibilityState, pending: document.querySelector('.close-pending-dialog')?.open ?? false })`) })}`);
    const mixedClose = evaluate('window.gigaChat.auditRequestClose()');
    console.log(`MIXED_CLOSE after request ${JSON.stringify({ visible: window.isVisible(), state: await evaluate(`JSON.stringify({ visibility: document.visibilityState, pending: document.querySelector('.close-pending-dialog')?.open ?? false })`) })}`);
    await waitDom('mixed operations close pending', `document.querySelector('.close-pending-dialog')?.open === true`);
    console.log(`MIXED_CLOSE after pending dialog ${JSON.stringify({ visible: window.isVisible(), state: await evaluate(`JSON.stringify({ visibility: document.visibilityState, pending: document.querySelector('.close-pending-dialog')?.open ?? false })`) })}`);
    await capture('close-pending-import-settings-config');
    console.log(`MIXED_CLOSE after capture ${JSON.stringify({ visible: window.isVisible(), state: await evaluate(`JSON.stringify({ visibility: document.visibilityState, pending: document.querySelector('.close-pending-dialog')?.open ?? false })`) })}`);
    await sleep(100);
    assert.equal(state.closeReadyCalls, closeCallsBeforeMixedDrain, 'main close-ready must wait for accepted import, settings, and config writes');
    const activeSettingsSection = await evaluate(`document.querySelector('.settings-nav-item.active')?.textContent.trim()`);
    await clickText('.settings-nav-item', 'Общие');
    assert.equal(await evaluate(`document.querySelector('.settings-nav-item.active')?.textContent.trim()`), activeSettingsSection,
      'close freeze must block new settings navigation');
    resolveSettingUpdate(state.pendingSettingUpdates[0]);
    resolveConfigSave(state.pendingConfigSaves[0]);
    await sleep(100);
    assert.equal(state.closeReadyCalls, closeCallsBeforeMixedDrain, 'the remaining import must still hold the close barrier');
    const importedForClose = clone(state.details.get(acceptedImport.id));
    acceptedImport.request.resolve(importedForClose);
    await waitUntil('main close-ready after imported settings and config settle', () => state.closeReadyCalls === closeCallsBeforeMixedDrain + 1);
    assert.equal((await mixedClose).status, 'failed');
    assert.equal(state.appSettings.theme, 'warm');
    assert.equal(state.configContents, 'allow = []\n');
    await waitDom('mixed operations close error', `document.querySelector('.close-error-dialog')?.open === true`);
    await capture('close-error-import-settings-config');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after mixed operations close error', async () => state.closeReturnCalls === 2
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    state.deferImports = false;
    state.deferSettingUpdates = false;
    state.deferConfigSaves = false;
    passed('Rendered close waits for accepted import, settings, and config writes');

    await click('button.window-action[aria-label="Назад"]');
    await waitDom('chat route before connection settings', `document.querySelector('.chat-header-title')`);
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Подключение API');
    await waitDom('connection setup key input', `document.querySelector('#connection-key')`);
    state.deferKeySaves = true;
    await fillInput('#connection-key', 'synthetic-audit-key');
    await click('.connection-key-form button[type="submit"]');
    await waitUntil('accepted synthetic key save', () => state.pendingKeySaves.length === 1);
    const closeCallsBeforeKeyFailure = state.closeReadyCalls;
    const keySaveClose = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('key save close pending', `document.querySelector('.close-pending-dialog')?.open === true`);
    await capture('close-pending-key-save');
    await sleep(100);
    assert.equal(state.closeReadyCalls, closeCallsBeforeKeyFailure, 'close-ready waits for the accepted key save');
    state.pendingKeySaves[0].reject(new Error('Synthetic secure-store write failure'));
    await waitDom('key save close failure', `document.querySelector('.close-error-dialog')?.open === true`);
    assert.equal((await keySaveClose).status, 'failed');
    assert.equal(await evaluate(`document.querySelector('#connection-key')?.value`), 'synthetic-audit-key', 'failed key save must retain the local input');
    assert.equal(state.closeReadyCalls, closeCallsBeforeKeyFailure);
    await capture('close-error-key-save');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after key save failure', async () => state.closeReturnCalls === 3
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));

    const blockedKeyRetry = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('unresolved key failure blocks another close', `document.querySelector('.close-error-dialog')?.open === true`);
    assert.equal((await blockedKeyRetry).status, 'failed');
    assert.equal(state.closeReadyCalls, closeCallsBeforeKeyFailure, 'retry must not discard the retained failed key input');
    assert.equal(await evaluate(`document.querySelector('#connection-key')?.value`), 'synthetic-audit-key');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after unresolved key retry', async () => state.closeReturnCalls === 4
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));

    await clickText('.settings-nav-item', 'Общие');
    await waitDom('key editor unmounted after leaving its settings section', `!document.querySelector('#connection-key')`);
    await clickText('.settings-nav-item', 'Подключение API');
    await waitDom('key editor remounted without stale failed draft', `document.querySelector('#connection-key')?.value === ''`);
    const closeAfterKeyRemount = evaluate('window.gigaChat.auditRequestClose()');
    await waitUntil('close after key editor remount reaches main', () => state.closeReadyCalls === closeCallsBeforeKeyFailure + 1);
    assert.equal((await closeAfterKeyRemount).status, 'failed');
    await waitDom('main close failure after key editor remount', `document.querySelector('.close-error-dialog')?.open === true`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after key editor remount close', async () => state.closeReturnCalls === 5
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));

    state.deferKeySaves = false;
    await fillInput('#connection-key', 'synthetic-recovery-key');
    await click('.connection-key-form button[type="submit"]');
    await waitDom('successful explicit key save clears input', `document.querySelector('#connection-key')?.value === ''`);
    assert.equal(state.keySaveCalls, 2, 'only explicit synthetic save attempts should reach the fake secure store');
    const closeAfterKeySave = evaluate('window.gigaChat.auditRequestClose()');
    await waitUntil('close reaches main after successful key save', () => state.closeReadyCalls === closeCallsBeforeKeyFailure + 2);
    assert.equal((await closeAfterKeySave).status, 'failed');
    await waitDom('synthetic main close failure after successful key save', `document.querySelector('.close-error-dialog')?.open === true`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after successful key save close attempt', async () => state.closeReturnCalls === 6
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    passed('Rendered key-save failure keeps its input and blocks close until explicit recovery');

    await click('button.window-action[aria-label="Назад"]');
    await waitDom('chat composer for synthetic dictation checks', `document.querySelector('.composer textarea') && !document.querySelector('#connection-key')`);
    assert.equal(await installSyntheticMedia(), true, 'synthetic media host should install without a real microphone');

    await click('.mic-button');
    await waitUntil('synthetic recording before close', async () => (await evaluate('window.__auditVoiceMedia.recorders.length')) === 1
      && await evaluate(`document.querySelector('.voice-capture')?.classList.contains('is-recording')`));
    const closeReturnBeforeVoice = state.closeReturnCalls;
    const recordingClose = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('close error while synthetic recording is active', `document.querySelector('.close-error-dialog')?.open === true`);
    assert.equal((await recordingClose).status, 'failed');
    const stoppedDuringClose = await evaluate(`window.__auditVoiceMedia.trackStopCalls`);
    assert.ok(stoppedDuringClose >= 1, 'close failure must still stop the owned microphone stream');
    await capture('voice-close-error-recording');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('return after stopping synthetic recording', async () => state.closeReturnCalls === closeReturnBeforeVoice + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    assert.equal(await evaluate(`window.__auditVoiceMedia.streams.every(({track}) => track.stopped)`), true,
      'Return must not leave a synthetic media track active');

    state.deferVoiceAccess = true;
    const accessBeforeCancel = state.pendingVoiceAccess.length;
    const mediaBeforeCancel = await evaluate('window.__auditVoiceMedia.getUserMediaCalls');
    await click('.mic-button');
    await waitUntil('deferred permission before explicit capture cancel', () => state.pendingVoiceAccess.length === accessBeforeCancel + 1);
    await click('[aria-label="Отменить запись"]');
    state.pendingVoiceAccess[accessBeforeCancel].resolve(true);
    await waitUntil('cancelled permission settles without a media request', async () =>
      await evaluate('window.__auditVoiceMedia.getUserMediaCalls') === mediaBeforeCancel
      && await evaluate(`document.querySelector('.voice-capture-status')?.textContent === ''`));
    state.deferVoiceAccess = false;
    passed('Rendered explicit cancel during permission prevents a late getUserMedia call');

    await click('.mic-button');
    await waitUntil('second synthetic recording starts', async () => (await evaluate('window.__auditVoiceMedia.recorders.length')) === 2
      && await evaluate(`document.querySelector('.voice-capture')?.classList.contains('is-recording')`));
    await evaluate('window.__auditVoiceMedia.emitLateData(0, 7)');
    await click('.mic-button');
    await waitUntil('synthetic audio reaches local transcription bridge', () => state.voiceTranscribeCalls.length === 1);
    assert.equal(state.voiceTranscribeCalls[0].audioLength, 6, 'late data from the stopped recorder must not enter the next recording');
    await waitDom('synthetic transcript is inserted after an active recording', `document.querySelector('.composer textarea')?.value.includes('Synthetic dictation ready.')`);
    passed('Rendered close stops the active track and stale recorder data cannot contaminate the next recording');

    await evaluate('window.__auditVoiceMedia.makeArrayBufferHold()');
    await click('.mic-button');
    await waitUntil('third synthetic recording starts', async () => (await evaluate('window.__auditVoiceMedia.recorders.length')) === 3
      && await evaluate(`document.querySelector('.voice-capture')?.classList.contains('is-recording')`));
    await click('.mic-button');
    await waitUntil('synthetic Blob conversion pauses before IPC', () => evaluate('window.__auditVoiceMedia.lastArrayBuffer?.called === true'));
    const transcribesBeforeHomeChange = state.voiceTranscribeCalls.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('new home composer after recording route change', `document.querySelector('.home-view') && document.querySelector('.composer textarea')`);
    await evaluate('window.__auditVoiceMedia.releaseArrayBuffer()');
    await sleep(120);
    assert.equal(state.voiceTranscribeCalls.length, transcribesBeforeHomeChange,
      'a Blob conversion resolved after recorder unmount must not send voice:transcribe');
    assert.equal(await evaluate(`document.querySelector('.home-view') && document.querySelector('.composer textarea')?.value.includes('Synthetic dictation ready.')`), false);
    passed('Rendered late Blob conversion after navigation cannot start transcription or alter the new draft');

    state.deferVoiceAccess = true;
    const getUserMediaBeforeClose = await evaluate('window.__auditVoiceMedia.getUserMediaCalls');
    const deferredPermissionIndex = state.pendingVoiceAccess.length;
    await click('.mic-button');
    await waitUntil('deferred synthetic microphone permission', () => state.pendingVoiceAccess.length === deferredPermissionIndex + 1);
    const permissionCloseReturnBefore = state.closeReturnCalls;
    const permissionClose = evaluate('window.gigaChat.auditRequestClose()');
    state.pendingVoiceAccess[deferredPermissionIndex].resolve(true);
    await waitDom('close failure after permission resolves during freeze', `document.querySelector('.close-error-dialog')?.open === true`);
    assert.equal((await permissionClose).status, 'failed');
    assert.equal(await evaluate('window.__auditVoiceMedia.getUserMediaCalls'), getUserMediaBeforeClose,
      'permission resolving after the close freeze must not request an OS media stream');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('return after deferred permission close', async () => state.closeReturnCalls === permissionCloseReturnBefore + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    state.deferVoiceAccess = false;
    passed('Rendered close freeze blocks getUserMedia after a pending permission response');

    state.deferVoiceTranscribe = true;
    await click('.mic-button');
    await waitUntil('synthetic recording before deferred transcription cleanup', async () => (await evaluate('window.__auditVoiceMedia.recorders.length')) === 4
      && await evaluate(`document.querySelector('.voice-capture')?.classList.contains('is-recording')`));
    await click('.mic-button');
    await waitUntil('deferred synthetic transcription before cleanup failure', () => state.pendingVoiceTranscribes.length === 1);
    state.voiceCancelFailuresRemaining = 1;
    const cancelCallsBeforeClose = state.voiceCancelCalls;
    const cleanupReturnBefore = state.closeReturnCalls;
    const cleanupClose = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('close error after synthetic voice cleanup failure', `document.querySelector('.close-error-dialog')?.open === true`);
    assert.equal((await cleanupClose).status, 'failed');
    await waitUntil('one owned voice cleanup attempt', () => state.voiceCancelCalls === cancelCallsBeforeClose + 1);
    await sleep(120);
    assert.equal(state.voiceCancelCalls, cancelCallsBeforeClose + 1,
      'a rerender during one close suspension must not automatically retry failed voice cleanup');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('return after owned voice cleanup failure', async () => state.closeReturnCalls === cleanupReturnBefore + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    await waitDom('voice cleanup failure remains available for explicit retry', `document.querySelector('.voice-capture-status')?.textContent.includes('Очистка не подтверждена')`);
    await capture('voice-cleanup-failure-retained');
    await click('.voice-cancel-button');
    await waitUntil('explicit voice cleanup retry succeeds', () => state.voiceCancelCalls === cancelCallsBeforeClose + 2);
    state.pendingVoiceTranscribes[0].resolve('Cancelled synthetic transcript must stay absent.');
    await sleep(120);
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value.includes('Cancelled synthetic transcript must stay absent.')`), false);
    state.deferVoiceTranscribe = false;
    passed('Rendered voice cleanup failure remains retryable without an automatic retry or late transcript');

    const closeCallsBeforeBrowserFailure = state.closeReadyCalls;
    state.closeReadyResults.push({
      status: 'failed', reason: 'browser-metadata', message: 'Synthetic browser metadata failure.',
    });
    const browserClose = await evaluate('window.gigaChat.auditRequestClose()');
    assert.equal(browserClose.reason, 'browser-metadata');
    await waitDom('browser metadata close error and actions', `document.querySelector('.close-error-dialog')?.open === true
      && document.querySelector('.close-error-dialog')?.textContent.includes('Вкладки браузера останутся открытыми')
      && [...document.querySelectorAll('.close-error-dialog button')].some((button) => button.textContent.includes('Вернуться к работе'))
      && [...document.querySelectorAll('.close-error-dialog button')].some((button) => button.textContent.includes('Повторить'))
      && [...document.querySelectorAll('.close-error-dialog button')].some((button) => button.textContent.includes('Закрыть без сохранения вкладок'))`);
    assert.equal(state.closeReadyCalls, closeCallsBeforeBrowserFailure + 1);
    await capture('close-browser-metadata-error');

    state.closeReadyResults.push({
      status: 'failed', reason: 'browser-metadata', message: 'Synthetic browser metadata still unavailable.',
    });
    await clickText('.close-error-dialog button', 'Повторить');
    await waitUntil('browser metadata retry reaches main', () => state.closeReadyCalls === closeCallsBeforeBrowserFailure + 2);
    assert.equal(state.closeReadyArgs.at(-1), false, 'Retry must keep the explicit no-discard choice');
    await waitDom('browser metadata retry keeps discard choice visible', `document.querySelector('.close-error-dialog')?.open === true
      && [...document.querySelectorAll('.close-error-dialog button')].some((button) => button.textContent.includes('Закрыть без сохранения вкладок'))`);

    state.closeReadyResults.push({
      status: 'failed', reason: 'close', message: 'Synthetic close remains blocked after the explicit choice.',
    });
    const closeReturnBeforeDiscardResult = state.closeReturnCalls;
    await clickText('.close-error-dialog button', 'Закрыть без сохранения вкладок');
    await waitUntil('explicit browser metadata discard reaches main', () => state.closeReadyCalls === closeCallsBeforeBrowserFailure + 3);
    assert.equal(state.closeReadyArgs.at(-1), true, 'Discard action must be the only UI path passing true');
    await waitDom('ordinary close failure no longer offers browser metadata discard', `document.querySelector('.close-error-dialog')?.open === true
      && document.querySelector('.close-error-dialog')?.textContent.includes('Synthetic close remains blocked')
      && ![...document.querySelectorAll('.close-error-dialog button')].some((button) => button.textContent.includes('Закрыть без сохранения вкладок'))`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('return after rendered discard routing check', () => state.closeReturnCalls === closeReturnBeforeDiscardResult + 1);
    passed('Rendered browser metadata failure offers retry, return, and explicit discard only for that reason');

    await clickChat('Chat B');
    await waitDom('Chat B before menu overlay check', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    const originalChoiceWindowSize = window.getSize();
    const originalChoiceZoom = window.webContents.getZoomFactor();
    window.setSize(560, 480);
    window.webContents.setZoomFactor(0.8);
    await sleep(350);
    await click('.profile-settings-button');
    await waitDom('Settings navigation before opener choice test', `document.querySelector('.settings-nav-item')`);
    await clickText('.settings-nav-item', 'Общие');
    await waitDom('General settings before opener choice test', `document.querySelector('.settings-nav-item.active')?.textContent.includes('Общие') && document.querySelector('.choice-menu > button')`);
    const transparencySelector = `(() => [...document.querySelectorAll('.setting-row')].find((row) => row.querySelector('.setting-row-copy strong')?.textContent.trim() === 'Прозрачная боковая панель')?.querySelector('.switch-control input'))()`;
    const generalSettingsRows = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.setting-row')].map((row) => ({ title: row.querySelector('.setting-row-copy strong')?.textContent.trim() ?? null, switches: row.querySelectorAll('.switch-control input').length })))`));
    console.log(`General settings rows before switch probe ${JSON.stringify(generalSettingsRows)}`);
    const readSwitchGeometry = async (selectorExpression) => JSON.parse(await evaluate(`JSON.stringify((() => {
      const input = ${selectorExpression};
      if (!input) return null;
      const track = input.nextElementSibling;
      const thumb = getComputedStyle(track, '::after');
      const transform = thumb.transform === 'none' ? 0 : new DOMMatrixReadOnly(thumb.transform).m41;
      return { checked: input.checked, disabled: input.disabled, trackWidth: track.getBoundingClientRect().width, trackHeight: track.getBoundingClientRect().height, top: Number.parseFloat(thumb.top), left: Number.parseFloat(thumb.left), width: Number.parseFloat(thumb.width), height: Number.parseFloat(thumb.height), travel: transform };
    })())`));
    const assertSwitchGeometry = (geometry, expected, label) => {
      assert.ok(geometry, `${label}: switch input must exist`);
      for (const [property, value] of Object.entries(expected)) {
        assert.ok(Math.abs(geometry[property] - value) <= 0.1, `${label}: ${property} should be within 0.1px of ${value}; actual ${geometry[property]}`);
      }
    };
    const autostartOff = await readSwitchGeometry(`(() => [...document.querySelectorAll('.setting-row')].find((row) => row.querySelector('.setting-row-copy strong')?.textContent.trim() === 'Запускать вместе с Windows')?.querySelector('.switch-control input'))()`);
    assert.equal(autostartOff.disabled, true, 'synthetic portable profile keeps autostart switch disabled');
    assertSwitchGeometry(autostartOff, { top: 5, left: 4, width: 18, height: 18, travel: 0 }, 'disabled common switch retains the same off geometry');
    await clickText('.settings-nav-item', 'Оформление');
    await waitDom('Appearance settings before transparency switch test', `document.querySelector('.settings-nav-item.active')?.textContent.includes('Оформление') && ${transparencySelector} !== null`);
    const transparencyOff = await readSwitchGeometry(transparencySelector);
    assertSwitchGeometry(transparencyOff, { trackWidth: 48, trackHeight: 28, top: 5, left: 4, width: 18, height: 18, travel: 0 }, 'unchecked common switch thumb must be centered and start with a 4px inset');
    await evaluate(`${transparencySelector}.click()`);
    await waitDom('transparency switch becomes checked', `${transparencySelector}?.checked === true`);
    await waitUntil('transparency switch thumb settles at checked endpoint', async () => Math.abs((await readSwitchGeometry(transparencySelector))?.travel - 22) <= 0.1, 1000);
    const transparencyOn = await readSwitchGeometry(transparencySelector);
    assertSwitchGeometry(transparencyOn, { travel: 22 }, 'checked common switch thumb must reach the checked endpoint');
    await evaluate(`${transparencySelector}.click()`);
    await waitDom('transparency switch restored off', `${transparencySelector}?.checked === false`);
    await waitUntil('transparency switch thumb settles at unchecked endpoint', async () => (await readSwitchGeometry(transparencySelector))?.travel === 0, 1000);
    await clickText('.settings-nav-item', 'Общие');
    await waitDom('General settings restored before opener choice test', `document.querySelector('.settings-nav-item.active')?.textContent.includes('Общие') && document.querySelector('.choice-menu > button')`);

    await sendMouseClick('.choice-menu > button');
    await waitDom('General opener listbox opens', `document.querySelector('.choice-menu .action-menu-content[role="listbox"]:popover-open')`);
    await waitDom('General opener trigger reports expanded state', `document.querySelector('.choice-menu > button')?.getAttribute('aria-expanded') === 'true'`);
    const openerPopup = JSON.parse(await evaluate(`JSON.stringify((() => {
      const popup = document.querySelector('.choice-menu .action-menu-content[role="listbox"]');
      const trigger = document.querySelector('.choice-menu > button');
      const options = [...(popup?.querySelectorAll('[role="option"]') ?? [])];
      const popupBounds = popup?.getBoundingClientRect();
      const triggerBounds = trigger?.getBoundingClientRect();
      return {
        label: popup?.getAttribute('aria-label'), triggerHasPopup: trigger?.getAttribute('aria-haspopup'),
        controlsTarget: trigger?.getAttribute('aria-controls') === popup?.id, expanded: trigger?.getAttribute('aria-expanded'),
        popupLeft: popupBounds?.left, popupTop: popupBounds?.top, popupBottom: popupBounds?.bottom,
        triggerLeft: triggerBounds?.left, triggerTop: triggerBounds?.top, triggerBottom: triggerBounds?.bottom,
        options: options.map((option) => ({ text: option.textContent.trim(), disabled: option.disabled, selected: option.getAttribute('aria-selected') })),
        popupBackground: popup ? getComputedStyle(popup).backgroundColor : null,
      };
    })())`));
    assert.equal(openerPopup.label, 'Открывать папки в', 'listbox has an accessible name');
    assert.equal(openerPopup.triggerHasPopup, 'listbox');
    assert.equal(openerPopup.controlsTarget, true, 'choice trigger controls its popup');
    assert.equal(openerPopup.expanded, 'true');
    assert.ok(Math.abs(openerPopup.popupLeft - openerPopup.triggerLeft) <= 1, 'choice list aligns with the start edge of its trigger');
    assert.ok(openerPopup.popupTop >= openerPopup.triggerBottom - 1 || openerPopup.popupBottom <= openerPopup.triggerTop + 1, 'choice list opens vertically below its trigger or flips above it');
    assert.deepEqual(openerPopup.options.map((option) => option.text), ['По умолчанию (Windows)', 'Проводник Windows', 'Приложение не найдено']);
    assert.deepEqual(openerPopup.options[2], { text: 'Приложение не найдено', disabled: true, selected: 'true' }, 'unavailable VSCode opener remains selected and visibly disabled');
    await capture('choice-menu-general-open');
    await sendKey('END');
    assert.match(await evaluate(`document.activeElement?.textContent ?? ''`), /Проводник Windows/, 'End skips the disabled last option');
    await sendKey('SPACE');
    await waitUntil('folder opener selection is applied', () => state.appSettings.preferredOpener === 'explorer');
    await waitDom('folder choice closes and returns focus', `!document.querySelector('.choice-menu .action-menu-content:popover-open') && document.activeElement === document.querySelector('.choice-menu > button')`);
    assert.match(await evaluate(`document.querySelector('.choice-menu > button')?.textContent ?? ''`), /Проводник Windows/);
    await sendMouseClick('.choice-menu > button');
    await waitDom('folder choice reopens with current value', `document.querySelector('.choice-menu .action-menu-content:popover-open')`);
    await sendKey('ESC');
    await waitDom('Escape closes folder choice and returns focus', `!document.querySelector('.choice-menu .action-menu-content:popover-open') && document.activeElement === document.querySelector('.choice-menu > button')`);
    assert.equal(await evaluate(`document.querySelector('.settings-nav-item.active')?.textContent.includes('Общие')`), true, 'Escape must not leave Settings');
    assert.equal(state.appSettings.preferredOpener, 'explorer', 'Escape must not change the selected opener');

    await clickText('.settings-nav-item', 'Skills и интеграции');
    await waitDom('Project Skills selector is ready', `document.querySelector('.skill-locations .inline-actions .choice-menu > button')`);
    const skillChoiceTrigger = '.skill-locations .inline-actions .choice-menu > button';
    assert.equal(await evaluate(`document.querySelector('.skill-locations .inline-actions .secondary-button')?.disabled`), true, 'empty Project Skills selection keeps Open disabled');
    await sendMouseClick(skillChoiceTrigger);
    await waitDom('Project Skills long list opens', `document.querySelector('.skill-locations .choice-menu .action-menu-content:popover-open')`);
    await waitDom('Project Skills trigger reports expanded state', `document.querySelector('.skill-locations .choice-menu > button')?.getAttribute('aria-expanded') === 'true'`);
    const skillPopup = JSON.parse(await evaluate(`JSON.stringify((() => {
      const popup = document.querySelector('.skill-locations .choice-menu .action-menu-content');
      const list = popup?.querySelector('.choice-menu-content');
      const bounds = popup?.getBoundingClientRect();
      const trigger = document.querySelector('.skill-locations .choice-menu > button')?.getBoundingClientRect();
      return {
        optionCount: popup?.querySelectorAll('[role="option"]').length,
        scrollHeight: popup?.scrollHeight, clientHeight: popup?.clientHeight, scrollTop: popup?.scrollTop,
        top: bounds?.top, right: bounds?.right, bottom: bounds?.bottom, left: bounds?.left,
        triggerLeft: trigger?.left, triggerTop: trigger?.top, triggerBottom: trigger?.bottom, viewWidth: innerWidth, viewHeight: innerHeight,
        label: popup?.getAttribute('aria-label'), listRole: popup?.getAttribute('role'),
        background: popup ? getComputedStyle(popup).backgroundColor : null,
        selectedPlaceholder: popup?.querySelector('[role="option"][aria-selected="true"]')?.textContent.trim(),
        wrapperRole: list?.getAttribute('role') ?? null,
      };
    })())`));
    console.log(`Project Skills popup geometry ${JSON.stringify(skillPopup)}`);
    await capture('choice-menu-skills-open');
    assert.equal(skillPopup.optionCount, 15, 'synthetic project list must include a placeholder and 14 projects');
    assert.equal(skillPopup.label, 'Проект для локальных Skills');
    assert.equal(skillPopup.listRole, 'listbox');
    assert.equal(skillPopup.selectedPlaceholder, 'Выберите проект');
    assert.ok(skillPopup.scrollHeight > skillPopup.clientHeight, 'long project choices must scroll inside the popup');
    assert.ok(Math.abs(skillPopup.left - skillPopup.triggerLeft) <= 1, 'Project Skills list aligns with the start edge of its trigger');
    assert.ok(skillPopup.left >= 7 && skillPopup.right <= skillPopup.viewWidth - 7, 'choice popup must stay within horizontal viewport edges (1px rounding tolerance)');
    assert.ok(skillPopup.top >= 7 && skillPopup.bottom <= skillPopup.viewHeight - 7, `choice popup must stay within vertical viewport edges (1px rounding tolerance); ${JSON.stringify({ top: skillPopup.top, bottom: skillPopup.bottom, viewHeight: skillPopup.viewHeight, triggerTop: skillPopup.triggerTop, triggerBottom: skillPopup.triggerBottom })}`);
    const skillPopupFitsAbove = skillPopup.triggerTop >= (skillPopup.bottom - skillPopup.top) + 13;
    const skillPopupFitsBelow = skillPopup.viewHeight - skillPopup.triggerBottom >= (skillPopup.bottom - skillPopup.top) + 13;
    if (skillPopupFitsAbove || skillPopupFitsBelow) {
      assert.ok(skillPopup.top >= skillPopup.triggerBottom - 1 || skillPopup.bottom <= skillPopup.triggerTop + 1, 'Project Skills list opens vertically below its trigger or flips above it when there is room');
    }
    await sendKey('END');
    assert.match(await evaluate(`document.activeElement?.textContent ?? ''`), /Long Project 12/, 'End reaches the last project choice');
    await waitUntil('end navigation scrolls the project list', async () => (await evaluate(`document.querySelector('.skill-locations .choice-menu .action-menu-content')?.scrollTop ?? 0`) > 0));
    await sendKey('SPACE');
    await waitDom('last Project Skills choice becomes selected', `document.querySelector('.skill-locations .choice-menu > button')?.textContent.includes('Long Project 12')`);
    assert.equal(await evaluate(`document.querySelector('.skill-locations .inline-actions .secondary-button')?.disabled`), false, 'selecting a project enables Open');
    await sendKey('HOME');
    await waitDom('Project Skills Home focuses placeholder', `document.activeElement?.textContent.includes('Выберите проект')`);
    await sendKey('ENTER');
    await waitDom('Project Skills placeholder restores empty selection', `document.querySelector('.skill-locations .choice-menu > button')?.textContent.includes('Выберите проект') && document.querySelector('.skill-locations .inline-actions .secondary-button')?.disabled`);
    await sendMouseClick(skillChoiceTrigger);
    await waitDom('Project Skills popup before outside click', `document.querySelector('.skill-locations .choice-menu .action-menu-content:popover-open')`);
    const skillSwitchOn = await readSwitchGeometry(`document.querySelector('.skill-enabled-toggle .switch-control input')`);
    assert.equal(skillSwitchOn.checked, true, 'synthetic Skill consumer starts checked');
    assertSwitchGeometry(skillSwitchOn, { top: 5, left: 4, width: 18, height: 18, travel: 22 }, 'checked Skill switch uses the common geometry');
    const outsideButton = await evaluate(`(() => {
      const button = document.querySelector('.skill-registry-actions .quiet-button');
      if (!button || button.disabled) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, right: rect.right };
    })()`);
    assert.ok(outsideButton && outsideButton.left > skillPopup.right, 'visible Skill refresh action must be an unoccluded outside-click target');
    const outsideZoom = window.webContents.getZoomFactor();
    const outsideX = Math.round(outsideButton.x * outsideZoom);
    const outsideY = Math.round(outsideButton.y * outsideZoom);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: outsideX, y: outsideY });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: outsideX, y: outsideY, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: outsideX, y: outsideY, button: 'left', clickCount: 1 });
    await waitDom('outside click on visible Skills action dismisses popup', `!document.querySelector('.skill-locations .choice-menu .action-menu-content:popover-open') && document.querySelector('.settings-nav-item.active')?.textContent.includes('Skills и интеграции')`);
    await clickText('.settings-nav-item', 'Hooks');
    await waitDom('Hooks navigation follows outside dismissal', `document.querySelector('.settings-nav-item.active')?.textContent.includes('Hooks')`);
    await click('button.window-action[aria-label="Назад"]');
    await waitDom('Chat B restored after Settings choice test', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    window.webContents.setZoomFactor(originalChoiceZoom);
    window.setSize(originalChoiceWindowSize[0], originalChoiceWindowSize[1]);
    await sleep(350);
    passed('Rendered settings choices preserve disabled/empty values, keyboard/focus, themed viewport-clamped popovers, and switch symmetry');
    await click('button[aria-label="Показать браузер"]');
    await waitDom('browser pane with its synthetic page', `document.querySelector('.browser-pane .browser-tab button[title="Synthetic page"]')`);
    await waitUntil('browser has native bounds before opening menus', () => state.browserBoundsCalls.some((bounds) => bounds && bounds.width > 0 && bounds.height > 0));
    const boundsBeforeMenus = state.browserBoundsCalls.length;

    await click('button[aria-label="Действия чата Chat B"]');
    await waitDom('chat action menu open over browser', `document.querySelector('.action-menu-content:popover-open')`);
    await waitUntil('chat menu suspends browser bounds', () => state.browserBoundsCalls.length > boundsBeforeMenus && state.browserBoundsCalls.at(-1) === null);
    await clickText('.action-menu-content:popover-open .submenu-trigger', 'Переместить в проект');
    await waitDom('nested project submenu open over browser', `document.querySelector('.submenu-content:popover-open')`);
    assert.equal(state.browserBoundsCalls.at(-1), null, 'opening the nested menu must keep the native view detached');

    window.showInactive();
    window.webContents.focus();
    const pressEscape = async () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
      await sleep(100);
    };
    await pressEscape();
    await waitDom('Escape closes only the nested submenu', `!document.querySelector('.submenu-content:popover-open') && document.querySelector('.action-menu-content:popover-open')`);
    assert.equal(state.browserBoundsCalls.at(-1), null, 'closing only the nested menu must retain the parent suspension');
    await pressEscape();
    await waitUntil('Escape closes all menus and restores browser bounds', async () => state.browserBoundsCalls.at(-1)?.width > 0
      && !(await evaluate(`document.querySelector('.action-menu-content:popover-open')`)));
    assert.equal(await evaluate(`document.querySelector('.browser-pane .browser-tab button[title="Synthetic page"]')?.getAttribute('aria-current')`), 'page',
      'the browser tab must remain mounted and active after menus close');
    await click('button[aria-label="Закрыть браузерную панель"]');
    await waitDom('browser pane unmounted after explicit close', `!document.querySelector('.browser-pane')`);
    assert.equal(state.browserBoundsCalls.at(-1), null, 'unmount must leave no native bounds token behind');

    const originalTheme = state.appSettings.theme;
    const themeCases = [
      { value: 'dark', label: 'Тёмная' },
      { value: 'emerald', label: 'Изумрудная' },
      { value: 'light', label: 'Светлая' },
      { value: 'warm', label: 'Тёплая' },
      { value: 'system', label: 'Как в Windows' },
    ];
    const themeSamples = [];
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Оформление');
    for (let index = 0; index < themeCases.length; index += 1) {
      const themeCase = themeCases[index];
      if (themeCase.value === 'system') await click('.system-theme');
      else await clickText('.theme-option', themeCase.label);
      await waitUntil(`${themeCase.label} theme setting is stored`, () => state.appSettings.theme === themeCase.value);
      const resolvedTheme = themeCase.value === 'system'
        ? await evaluate(`matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`)
        : themeCase.value;
      await waitDom(`${themeCase.label} theme class is applied`, `document.querySelector('.app-frame')?.classList.contains(${JSON.stringify(`theme-${resolvedTheme}`)})`);
      await clickText('.settings-nav-item', 'Общие');
      await waitDom(`${themeCase.label} choice control is ready`, `document.querySelector('.settings-nav-item.active')?.textContent.includes('Общие') && document.querySelector('.choice-menu > button')`);
      await sendMouseClick('.choice-menu > button');
      await waitDom(`${themeCase.label} choice popup opens`, `document.querySelector('.choice-menu .action-menu-content[role="listbox"]:popover-open')`);
      const sample = JSON.parse(await evaluate(`JSON.stringify((() => {
        const frame = document.querySelector('.app-frame');
        const popup = document.querySelector('.choice-menu .action-menu-content[role="listbox"]');
        const selected = popup?.querySelector('.choice-menu-content button[aria-selected="true"]');
        const frameStyle = getComputedStyle(frame);
        const popupStyle = getComputedStyle(popup);
        const selectedStyle = selected ? getComputedStyle(selected) : null;
        return {
          themeClasses: [...frame.classList].filter((name) => name.startsWith('theme-')),
          popupToken: frameStyle.getPropertyValue('--popup').trim(),
          textToken: frameStyle.getPropertyValue('--text').trim(),
          popupBackground: popupStyle.backgroundColor,
          popupText: popupStyle.color,
          selectedBackground: selectedStyle?.backgroundColor ?? null,
          selectedText: selectedStyle?.color ?? null,
          selectedOption: selected?.textContent.trim() ?? null,
        };
      })())`));
      assert.deepEqual(sample.themeClasses, [`theme-${resolvedTheme}`], `${themeCase.label}: exactly one resolved theme class should be active`);
      assert.ok(sample.popupToken && sample.textToken, `${themeCase.label}: theme tokens must resolve`);
      assert.notEqual(sample.popupBackground, 'rgba(0, 0, 0, 0)', `${themeCase.label}: choice popup must have a themed surface`);
      assert.notEqual(sample.popupText, 'rgba(0, 0, 0, 0)', `${themeCase.label}: choice popup text must be visible`);
      assert.ok(sample.selectedOption, `${themeCase.label}: selected choice remains visible`);
      assert.notEqual(sample.selectedBackground, 'rgba(0, 0, 0, 0)', `${themeCase.label}: selected choice has a themed highlight`);
      assert.notEqual(sample.selectedText, 'rgba(0, 0, 0, 0)', `${themeCase.label}: selected choice text remains visible`);
      themeSamples.push({ requested: themeCase.value, resolved: resolvedTheme, ...sample });
      await capture(`theme-${themeCase.value}-choice-popup`);
      await sendKey('ESC');
      await waitDom(`${themeCase.label} choice popup closes`, `!document.querySelector('.choice-menu .action-menu-content:popover-open')`);
      if (index < themeCases.length - 1) await clickText('.settings-nav-item', 'Оформление');
    }
    assert.ok(new Set(themeSamples.map((sample) => sample.popupBackground)).size >= 4,
      `Dark/Emerald/Light/Warm/System should render at least four resolved popup palettes: ${JSON.stringify(themeSamples.map((sample) => [sample.requested, sample.resolved, sample.popupBackground]))}`);
    await clickText('.settings-nav-item', 'Оформление');
    const originalThemeCase = themeCases.find((themeCase) => themeCase.value === originalTheme);
    assert.ok(originalThemeCase, `synthetic fixture original theme must be known: ${originalTheme}`);
    if (originalTheme === 'system') await click('.system-theme');
    else await clickText('.theme-option', originalThemeCase.label);
    await waitUntil('original fixture theme is restored', () => state.appSettings.theme === originalTheme);
    const originalResolvedTheme = originalTheme === 'system'
      ? await evaluate(`matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`)
      : originalTheme;
    await waitDom('original fixture theme class is restored', `document.querySelector('.app-frame')?.classList.contains(${JSON.stringify(`theme-${originalResolvedTheme}`)})`);
    await click('button.window-action[aria-label="Назад"]');
    await waitDom('Chat B restored after theme matrix', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    console.log(`Rendered theme palette evidence ${JSON.stringify(themeSamples.map(({ requested, resolved, popupBackground, popupText, selectedBackground, selectedText }) => ({ requested, resolved, popupBackground, popupText, selectedBackground, selectedText })))}`);
    passed('Rendered Dark/Emerald/Light/Warm/System palettes style the shared choice popup and restore the original theme');

    const titleOriginalSize = window.getSize();
    const titleOriginalZoom = window.webContents.getZoomFactor();
    window.setSize(560, 480);
    window.webContents.setZoomFactor(1);
    window.show();
    window.focus();
    window.webContents.focus();
    await sleep(350);
    const renameSyntheticChat = async (currentTitle, nextTitle) => {
      await click(`button[aria-label="Действия чата ${currentTitle}"]`);
      await waitDom(`chat actions for ${currentTitle} open`, `document.querySelector('.action-menu-content:popover-open')`);
      await clickText('.action-menu-content:popover-open button', 'Переименовать');
      await waitDom(`rename dialog for ${currentTitle} opens`, `document.querySelector('dialog[open] .dialog-label input')`);
      await fillInput('dialog[open] .dialog-label input', nextTitle);
      await click('dialog[open] .dialog-actions button[type="submit"]');
      await waitUntil(`synthetic chat renamed to ${nextTitle}`, () => state.chats.find((chat) => chat.id === 'chat-b')?.title === nextTitle);
      await waitDom(`chat header shows ${nextTitle}`, `document.querySelector('.chat-header-title')?.textContent === ${JSON.stringify(nextTitle)}`);
    };
    await renameSyntheticChat('Chat B', '2');
    const shortTitleGeometry = JSON.parse(await evaluate(`JSON.stringify((() => {
      const title = document.querySelector('.chat-header-title');
      const style = getComputedStyle(title);
      return { text: title.textContent, title: title.title, fontSize: style.fontSize, fontWeight: style.fontWeight, clientWidth: title.clientWidth, scrollWidth: title.scrollWidth };
    })())`));
    assert.equal(shortTitleGeometry.text, '2');
    assert.equal(shortTitleGeometry.title, '2');
    assert.equal(shortTitleGeometry.fontSize, '18px');
    assert.equal(shortTitleGeometry.fontWeight, '700');
    assert.ok(shortTitleGeometry.clientWidth > 0 && shortTitleGeometry.scrollWidth <= shortTitleGeometry.clientWidth,
      `short title remains fully visible: ${JSON.stringify(shortTitleGeometry)}`);
    await capture('chat-header-title-2');
    const longTitle = 'Long synthetic chat title '.repeat(5).trim();
    await renameSyntheticChat('2', longTitle);
    const longTitleGeometry = JSON.parse(await evaluate(`JSON.stringify((() => {
      const title = document.querySelector('.chat-header-title');
      const style = getComputedStyle(title);
      return { text: title.textContent, title: title.title, clientWidth: title.clientWidth, scrollWidth: title.scrollWidth, overflow: style.overflow, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow };
    })())`));
    assert.equal(longTitleGeometry.text, longTitle);
    assert.equal(longTitleGeometry.title, longTitle);
    assert.ok(longTitleGeometry.scrollWidth > longTitleGeometry.clientWidth, `long title should overflow its measured header box: ${JSON.stringify(longTitleGeometry)}`);
    assert.equal(longTitleGeometry.overflow, 'hidden');
    assert.equal(longTitleGeometry.whiteSpace, 'nowrap');
    assert.equal(longTitleGeometry.textOverflow, 'ellipsis');
    await capture('chat-header-long-title-ellipsis-560x480');
    await renameSyntheticChat(longTitle, 'Chat B');
    window.webContents.setZoomFactor(titleOriginalZoom);
    window.setSize(titleOriginalSize[0], titleOriginalSize[1]);
    await sleep(350);
    console.log(`Rendered title evidence ${JSON.stringify({ shortTitleGeometry, longTitleGeometry })}`);
    passed('Rendered chat header keeps title 2 readable and ellipsizes a long title at 560x480');

    window.hide();
    passed('Rendered nested chat menus suspend native browser bounds until the last overlay closes');

    await new Promise((resolveClosed) => {
      window.once('closed', resolveClosed);
      window.close();
    });
    state.appSettings.onboardingCompleted = false;
    state.deferOnboardingBounds = true;
    state.openStudioCalls = 0;
    const onboardingWindow = new BrowserWindow({
      show: false,
      width: 1120,
      height: 760,
      webPreferences: {
        preload: join(fixturePath, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window = onboardingWindow;
    onboardingWindow.webContents.setBackgroundThrottling(false);
    await onboardingWindow.loadFile(join(bundleDirectory, 'index.html'));
    await waitDom('first-run screen after deferred onboarding bounds', `!document.querySelector('.loading-state')
      && document.querySelector('.connection-setup')`);
    await waitUntil('deferred first-run bounds request', () => state.pendingOnboardingBounds.length === 1);
    await clickText('.connection-finish button', 'Продолжить локально');
    await waitDom('onboarding view unmounted while bounds are pending', `!document.querySelector('.connection-setup')
      && document.querySelector('.composer textarea')`);
    state.pendingOnboardingBounds[0].resolve();
    await sleep(120);
    assert.equal(state.openStudioCalls, 0, 'a late bounds acknowledgement must not reopen Studio after the first-run view unmounts');
    passed('Unmounted first-run browser ignores a late bounds acknowledgement');

    console.log(`Rendered React deferred-bridge checks: ${passCount} PASS`);
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? String(error));
    app.exit(1);
  }
}

const fakePreloadSource = String.raw`
const { contextBridge, ipcRenderer } = require('electron');
const methods = {
  projects: ['list','create','pickFolder','instructionsBackupPath','update','remove','chooseFolder','openFolder','readInstructions','saveInstructions','saveInstructionsCopy'],
  chats: ['list','get','create','update','appendLocalMessage','importFile','openArtifact','openFolder','remove'],
  runtime: ['getStatus','list','cancel'],
  permissions: ['readConfig','saveConfig','respond'],
  skills: ['list','readSource','setEnabled','openFolder'],
  hooks: ['list'],
  onboarding: ['getKeyStatus','saveKey','getBrowserStatus','openStudio','closeBrowser','setBrowserBounds','back','reload'],
  browser: ['getStatus','newTab','closeTab','activateTab','navigate','back','forward','reload','setBounds'],
  voice: ['getStatus','requestAccess','transcribe','cancel'],
  settings: ['get','update','chooseProjectsFolder','openProjectsFolder','listOpeners','getAppInfo','getAutoStart','setAutoStart','readInstructions','saveInstructions','saveInstructionsCopy','deleteAppData'],
  usage: ['getLocalStats'],
};
const api = {};
for (const [group, names] of Object.entries(methods)) {
  api[group] = Object.fromEntries(names.map((name) => [name, (...args) => ipcRenderer.invoke('audit:api', group, name, args)]));
}
for (const [group, channel] of [['runtime','audit:runtime'],['permissions','audit:permission'],['onboarding','audit:onboarding'],['browser','audit:browser']]) {
  const method = group === 'runtime' ? 'onUpdate' : group === 'permissions' ? 'onRequest' : group === 'onboarding' ? 'onBrowserStatus' : 'onStatus';
  api[group][method] = (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}
let closeFlush = null;
let closeFailureHandler = null;
api.onCloseRequested = (flush, onFailure) => {
  closeFlush = flush;
  closeFailureHandler = onFailure;
  return () => { closeFlush = null; closeFailureHandler = null; };
};
const runCloseAttempt = async (discardBrowserMetadata = false) => {
  if (!closeFlush) throw new Error('Renderer close flush has not registered.');
  try {
    await closeFlush();
    const result = await ipcRenderer.invoke('audit:close-ready', discardBrowserMetadata);
    if (result?.status === 'failed') closeFailureHandler?.(result);
    return result;
  } catch (error) {
    const result = { status: 'failed', reason: 'close', message: error instanceof Error ? error.message : String(error) };
    closeFailureHandler?.(result);
    return result;
  }
};
api.auditRequestClose = () => runCloseAttempt(false);
api.retryClose = runCloseAttempt;
api.returnFromClose = () => ipcRenderer.invoke('audit:close-return');
contextBridge.exposeInMainWorld('gigaChat', api);
`;

if (process.versions.electron) {
  void runElectronHost().catch((error) => {
    console.error(error?.stack ?? String(error));
    require('electron').app.exit(1);
  });
} else await runNodeDriver();
