import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RENDERER_HOST_LOG_BYTES = 512 * 1024;
const SYNTHETIC_IMAGE_PREVIEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=';

function captureBounded(state, chunk) {
  if (state.bytes >= MAX_RENDERER_HOST_LOG_BYTES) {
    state.truncated = true;
    return;
  }
  const data = Buffer.from(chunk, 'utf8');
  let end = Math.min(data.length, MAX_RENDERER_HOST_LOG_BYTES - state.bytes);
  if (end < data.length) {
    while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
    state.truncated = true;
  }
  if (end > 0) {
    state.parts.push(data.subarray(0, end).toString('utf8'));
    state.bytes += end;
  }
}

function capturedText(state) {
  return `${state.parts.join('')}${state.truncated ? '\n[child log truncated at 512 KiB]\n' : ''}`;
}

async function runNodeDriver() {
  const nativeWorkspaceMode = process.argv.includes('--native-browser-workspace');
  const holdForReview = process.argv.includes('--hold-for-review');
  const imageGenerationSmoke = process.argv.includes('--image-generation-smoke');
  assert.equal(imageGenerationSmoke && nativeWorkspaceMode, false, 'image-generation smoke is an isolated renderer fixture');
  assert.equal(imageGenerationSmoke && holdForReview, false, 'image-generation smoke must remain hidden and unattended');
  const { register } = await import('tsx/esm/api');
  register();
  require('tsx/cjs/api').register();
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
  const fixturePrefix = imageGenerationSmoke ? 'plan011-image-generation-smoke-'
    : nativeWorkspaceMode ? 'plan009-browser-workspace-native-' : 'plan009-browser-workspace-renderer-';
  const fixture = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(qaDirectory, fixturePrefix)));
  assert.equal(dirname(fixture), qaDirectory, 'fixture must be a direct child of ignored app/.qa');
  console.log(`Renderer QA fixture: ${fixture}`);
  const bundleDirectory = join(fixture, 'renderer');
  const userDataDirectory = join(fixture, 'user-data');
  const sessionDataDirectory = join(fixture, 'session-data');
  await mkdir(bundleDirectory, { recursive: true });
  await mkdir(userDataDirectory, { recursive: true });
  await mkdir(sessionDataDirectory, { recursive: true });

  const { buildUsageProfileView } = await import('../src/usage-view.ts');
  const { summarizeUsage } = await import('../src/usage.ts');
  const generatedAt = '2024-03-02T12:00:00.000Z';
  const profileChatId = 'profile-archived-chat';
  const profileReceipts = [
    ['00000000-0000-4000-8000-000000000001', '2024-02-26T12:00:00.000Z', 'GigaChat-3-Lightning', 1_234_567, 'chat'],
    ['00000000-0000-4000-8000-000000000002', '2024-02-27T12:00:00.000Z', 'GigaChat-3-Ultra', 0, 'compaction'],
    ['00000000-0000-4000-8000-000000000003', '2024-02-28T12:00:00.000Z', 'GigaChat-3-Pro', null, 'tool-continuation'],
    ['00000000-0000-4000-8000-000000000004', '2024-03-01T20:00:00.000Z', 'GigaChat-2-Max', 5_200, 'chat'],
    ['00000000-0000-4000-8000-000000000005', '2024-03-01T22:00:00.000Z', 'Synthetic-Unmapped-Model', 765_432, 'chat'],
  ].map(([localRequestId, createdAt, modelId, totalTokens, requestKind]) => ({
    localRequestId, chatId: profileChatId, requestKind, modelId, providerRequestId: null, providerModel: null,
    createdAt, status: 'completed', promptTokens: totalTokens, completionTokens: totalTokens === null ? null : 0,
    totalTokens, precachedPromptTokens: 0, conflictedFields: [],
  }));
  const profileChats = [{
    id: profileChatId, title: 'Сохранённый учебный чат', archived: true,
    messages: [
      { id: 'profile-user-feb26', role: 'user', text: 'Первый вопрос', createdAt: '2024-02-26T12:00:00.000Z', source: 'runtime' },
      { id: 'profile-user-feb27', role: 'user', text: 'Второй вопрос', createdAt: '2024-02-27T12:00:00.000Z', source: 'runtime' },
      { id: 'profile-example', role: 'user', text: 'Пример', createdAt: generatedAt, source: 'example' },
      { id: 'profile-assistant', role: 'assistant', text: 'Ответ', createdAt: generatedAt, source: 'runtime' },
    ],
    turns: [{ invokedSkillId: 'global/profile-review', pendingSkillId: null, status: 'completed', startedAt: '2024-02-26T12:01:00.000Z' }],
    toolReceipts: [{ name: 'read', status: 'completed' }, { name: 'write', status: 'unknown' }],
  }];
  const profileProjects = [{ id: 'profile-project' }, { id: 'profile-archived-project' }];
  const apiAnchor = {
    source: 'api', observedAt: '2024-03-01T23:59:00.000Z', expiresAt: null, unknownUsageCount: 0,
    families: [
      { family: 'ultra', state: 'known', value: 9_100_000 },
      { family: 'max', state: 'known', value: 8_200_000 },
      { family: 'pro', state: 'known', value: 7_300_000 },
      { family: 'lite', state: 'known', value: 6_400_000 },
    ],
    baselineReceiptCount: profileReceipts.length, baselineMatches: true,
  };
  const studioInput = { remainingTokens: { ultra: 1_100_000, max: 2_200_000, pro: 3_300_000, lite: 4_400_000 }, expiresAt: '2027-10-12' };
  const studioAnchor = { ...apiAnchor, source: 'studio', expiresAt: '2027-10-12', families: apiAnchor.families.map((family) => ({
    ...family, value: studioInput.remainingTokens[family.family],
  })) };
  const profileView = (receipts, balanceAnchor = null) => buildUsageProfileView({
    generatedAt, timeZone: 'Europe/Moscow', receipts, chats: profileChats, projects: profileProjects,
    installedSkillCount: 3, balanceAnchor,
  });
  const emptyProfile = profileView([], null);
  const richProfile = profileView(profileReceipts, apiAnchor);
  const studioProfile = profileView(profileReceipts, studioAnchor);
  const expiredProfile = profileView(profileReceipts, {
    ...studioAnchor, observedAt: '2024-02-01T12:00:00.000Z', expiresAt: '2024-03-01',
  });
  const partialLiteReceipt = {
    ...profileReceipts[0], localRequestId: '00000000-0000-4000-8000-000000000006',
    createdAt: '2024-03-02T01:00:00.000Z', totalTokens: null, promptTokens: null, completionTokens: null,
  };
  const unknownFamilyReceipt = {
    ...profileReceipts[4], localRequestId: '00000000-0000-4000-8000-000000000007',
    createdAt: '2024-03-02T02:00:00.000Z', totalTokens: 12_345, promptTokens: 12_345,
  };
  const largeReceipt = {
    ...profileReceipts[0], localRequestId: '00000000-0000-4000-8000-000000000008',
    createdAt: '2024-03-01T18:00:00.000Z', modelId: 'GigaChat-3-Pro', totalTokens: 2_100_000_000, promptTokens: 2_100_000_000,
  };
  const allUnknownReceipt = {
    ...profileReceipts[2], localRequestId: '00000000-0000-4000-8000-000000000009',
    createdAt: '2024-03-01T11:00:00.000Z', totalTokens: null, promptTokens: null, completionTokens: null,
  };
  const postAnchorLiteReceipt = {
    ...profileReceipts[0], localRequestId: '00000000-0000-4000-8000-000000000010',
    createdAt: '2024-03-02T01:00:00.000Z', modelId: 'GigaChat-3-Lightning', totalTokens: 631, promptTokens: 631, completionTokens: 0,
  };
  const postAnchorLiteProfile = profileView([...profileReceipts, postAnchorLiteReceipt], apiAnchor);
  const ordinaryYearProfile = buildUsageProfileView({
    generatedAt: '2025-03-02T12:00:00.000Z', timeZone: 'Europe/Moscow', receipts: [], chats: [], projects: [],
    installedSkillCount: 0, balanceAnchor: null,
  });
  const profileFixtures = {
    empty: emptyProfile,
    rich: richProfile,
    studio: studioProfile,
    expired: expiredProfile,
    partialLite: profileView([...profileReceipts, partialLiteReceipt], apiAnchor),
    unknownFamilyTail: profileView([...profileReceipts, unknownFamilyReceipt], apiAnchor),
    large: profileView([...profileReceipts, largeReceipt], apiAnchor),
    allUnknown: profileView([allUnknownReceipt], null),
    postAnchorLite: postAnchorLiteProfile,
    ordinaryYear: ordinaryYearProfile,
    richLedger: summarizeUsage(profileReceipts),
    emptyLedger: summarizeUsage([]),
    studioInput,
  };
  assert.equal(richProfile.localActivity.rollingYear.days.length, 366, 'synthetic profile must cover a leap-year window');
  assert.equal(ordinaryYearProfile.localActivity.rollingYear.days.length, 365, 'synthetic profile must also cover an ordinary-year window');
  assert.equal(richProfile.total.totalTokens.knownTokens, 2_005_199, 'synthetic profile totals are independently fixed');
  const postAnchorLite = postAnchorLiteProfile.balance.families.find((family) => family.family === 'lite');
  assert.equal(postAnchorLite?.usedSinceSnapshot, 631, 'only Lite usage after the snapshot is deducted');
  assert.equal(postAnchorLite?.estimatedRemainingTokens, 6_399_369, 'baseline receipts are not deducted again from the observed Lite remainder');
  assert.ok(profileFixtures.unknownFamilyTail.balance.families.every((family) => family.estimatedRemainingTokens === null),
    'an unknown-family expense makes each family estimate unknown instead of treating it as zero');
  assert.equal(profileFixtures.partialLite.balance.families.find((family) => family.family === 'lite')?.estimatedRemainingTokens, null,
    'an incomplete Lite receipt does not produce a partial numeric estimate');
  await writeFile(join(fixture, 'usage-profile-fixtures.json'), JSON.stringify(profileFixtures), 'utf8');

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

  if (nativeWorkspaceMode) {
    const nativeDirectory = join(fixture, 'native');
    await mkdir(nativeDirectory, { recursive: true });
    const nativeCompiler = webpack({
      module: { rules },
      resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'] },
      mode: 'development',
      devtool: false,
      entry: resolve(repo, 'src/embedded-browser.ts'),
      target: 'electron-main',
      output: { path: nativeDirectory, filename: 'embedded-browser.cjs', library: { type: 'commonjs2' } },
      plugins: [new AssetRelocatorPatch(false, false)],
      optimization: { minimize: false },
    });
    await new Promise((resolveStats, reject) => nativeCompiler.run((error, result) => {
      if (error) reject(error);
      else if (!result || result.hasErrors()) reject(new Error(result?.toString({ all: false, errors: true }) ?? 'Native controller webpack returned no stats'));
      else resolveStats(result);
    }));
    await new Promise((resolveClose, reject) => nativeCompiler.close((error) => error ? reject(error) : resolveClose()));
    console.log('Actual embedded-browser main bundle compiled');
  }

  const html = (await readFile(join(repo, 'src/index.html'), 'utf8'))
    .replace('</body>', '  <script defer src="./renderer.js"></script>\n  </body>');
  await writeFile(join(bundleDirectory, 'index.html'), html, 'utf8');
  await writeFile(join(fixture, 'preload.cjs'), fakePreloadSource, 'utf8');

  const electronPath = require('electron');
  const child = spawn(electronPath, [`--user-data-dir=${userDataDirectory}`, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: repo,
    env: { ...process.env, GIGACHAT_AUDIT_ROOT: fixture },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`Electron host spawned: ${child.pid}`);
  const stdout = { parts: [], bytes: 0, truncated: false };
  const stderr = { parts: [], bytes: 0, truncated: false };
  const stdoutPath = join(fixture, 'renderer-host.stdout.log');
  const stderrPath = join(fixture, 'renderer-host.stderr.log');
  let logsSaved = false;
  const saveChildLogs = async () => {
    if (logsSaved) return;
    logsSaved = true;
    await Promise.all([
      writeFile(stdoutPath, capturedText(stdout), 'utf8'),
      writeFile(stderrPath, capturedText(stderr), 'utf8'),
    ]);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk) => { captureBounded(stdout, chunk); process.stdout.write(chunk); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { captureBounded(stderr, chunk); process.stderr.write(chunk); });
  const exitCode = await new Promise((resolveExit, reject) => {
    let timedOut = false;
    let killFallback;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      killFallback = setTimeout(async () => {
        await saveChildLogs().catch(() => undefined);
        reject(new Error(`Electron renderer host timed out; child logs: ${stdoutPath}, ${stderrPath}; fixture: ${fixture}`));
      }, 5_000);
    }, holdForReview ? 10 * 60_000 : 120_000);
    child.once('error', async (error) => {
      clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      await saveChildLogs().catch(() => undefined);
      reject(new Error(`Electron renderer host error; child logs: ${stdoutPath}, ${stderrPath}; ${error.message}`));
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      await saveChildLogs();
      if (timedOut) reject(new Error(`Electron renderer host timed out; child logs: ${stdoutPath}, ${stderrPath}; fixture: ${fixture}`));
      else if (signal) reject(new Error(`Electron renderer host stopped by ${signal}; child logs: ${stdoutPath}, ${stderrPath}; fixture: ${fixture}`));
      else resolveExit(code ?? 1);
    });
  });
  assert.equal(exitCode, 0, `Electron renderer host failed.\n${capturedText(stderr)}\n${capturedText(stdout)}\nChild logs: ${stdoutPath}, ${stderrPath}\nFixture: ${fixture}`);
  process.stdout.write(`Renderer fixture retained for review: ${fixture}\n`);
}

async function runElectronHost() {
  console.log('Electron host entry reached');
  const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage, screen, session } = require('electron');
  console.log('Electron API loaded');
  const nativeWorkspaceMode = process.argv.includes('--native-browser-workspace');
  const holdForReview = process.argv.includes('--hold-for-review');
  const imageGenerationSmoke = process.argv.includes('--image-generation-smoke');
  assert.equal(imageGenerationSmoke && nativeWorkspaceMode, false, 'image-generation smoke cannot load the native browser fixture');
  assert.equal(imageGenerationSmoke && holdForReview, false, 'image-generation smoke must remain hidden and unattended');
  let generatedImagePreview = null;
  if (imageGenerationSmoke) {
    const width = 16;
    const height = 9;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const upper = y < 5;
        bitmap[offset] = upper ? 184 : 38;
        bitmap[offset + 1] = upper ? 129 : 92;
        bitmap[offset + 2] = upper ? 62 : 148;
        bitmap[offset + 3] = 255;
      }
    }
    generatedImagePreview = nativeImage.createFromBitmap(bitmap, { width, height })
      .resize({ width: 1024, height: 576 }).toDataURL();
  }
  const skipSidebarPointerCapture = process.argv.includes('--skip-sidebar-pointer-capture');
  const fixture = process.env.GIGACHAT_AUDIT_ROOT;
  assert.ok(fixture, 'synthetic GIGACHAT_AUDIT_ROOT is required');
  const fixturePath = await realpath(fixture);
  assert.equal(dirname(fixturePath), await realpath(join(repo, '.qa')));
  const profile = join(fixturePath, 'user-data');
  const sessionData = join(fixturePath, 'session-data');
  const bundleDirectory = join(fixturePath, 'renderer');
  const profileFixtures = JSON.parse(await readFile(join(fixturePath, 'usage-profile-fixtures.json'), 'utf8'));
  app.setPath('userData', profile);
  app.setPath('sessionData', sessionData);
  assert.equal(await realpath(app.getPath('userData')), await realpath(profile), 'Electron userData must be the owned synthetic fixture before readiness');
  assert.equal(await realpath(app.getPath('sessionData')), await realpath(sessionData), 'Electron sessionData must be the owned synthetic fixture before readiness');

  const timestamp = '2026-10-03T00:00:00.000Z';
  const makeProject = (id, name, workingFolder = null) => ({ id, name, pinned: false, archived: false, createdAt: timestamp, updatedAt: timestamp, workingFolder });
  const makeChat = (id, title, projectId = null, kind = 'text') => ({ id, title, projectId, pinned: false, archived: false, createdAt: timestamp, updatedAt: timestamp, kind });
  const makeDetail = (summary, text, draft = '') => ({
    ...summary, draft, nextTurnPermissionProfile: null, modelId: summary.kind === 'image' ? 'GigaChat-3-Ultra' : null, nextTurnSkillId: null,
    messages: imageGenerationSmoke && summary.kind === 'image' ? [] : [{ id: `${summary.id}-message`, role: 'assistant', text, createdAt: timestamp }],
    turns: [], toolReceipts: [], artifacts: [], draftAttachments: [], compactSnapshot: null,
  });
  const makeBrowserTab = (id, title, url) => ({ id, title, url, canGoBack: false, canGoForward: false, loading: false, error: null });
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
  const imageLegacy = makeChat('image-legacy', 'Legacy image chat', null, 'image');
  const imageHistory = makeChat('image-history', 'Image chat with old file', null, 'image');
  const chats = [
    chatA,
    chatB,
    ...(imageGenerationSmoke ? [imageLegacy, imageHistory] : []),
    ...Array.from({ length: 24 }, (_, index) => makeChat(`history-${index + 1}`, `History chat ${String(index + 1).padStart(2, '0')}`)),
  ];
  const details = new Map(chats.map((chat, index) => [chat.id, makeDetail(chat, index === 0 ? 'A baseline' : index === 1 ? 'B baseline' : 'History baseline')]));
  if (imageGenerationSmoke) {
    const legacy = details.get(imageLegacy.id);
    legacy.modelId = 'GigaChat-3-Pro';
    legacy.messages = [
      { id: 'image-legacy-user', role: 'user', text: 'Старое описание.', createdAt: timestamp },
      { id: 'image-legacy-assistant', role: 'assistant', source: 'runtime', text: '', createdAt: timestamp, attachmentIds: ['image-legacy-artifact'] },
    ];
    legacy.turns = [{
      turnId: 'image-legacy-turn', anchorMessageId: 'image-legacy-user', assistantMessageId: 'image-legacy-assistant',
      modelId: 'GigaChat-3-Pro', status: 'completed', createdAt: timestamp, startedAt: timestamp, endedAt: timestamp,
      activity: [{ kind: 'provider', at: timestamp, activity: 'receiving' }],
    }];
    legacy.artifacts = [{ id: 'image-legacy-artifact', name: 'Изображение.png', storedName: 'image-legacy-artifact.png', size: 2048,
      sha256: 'c'.repeat(64), createdAt: timestamp, messageId: 'image-legacy-assistant' }];
    legacy.draftAttachments = [{ id: 'image-legacy-draft', name: 'pending.txt', storedName: 'image-legacy-draft.txt', size: 24,
      sha256: 'd'.repeat(64), createdAt: timestamp }];
    const history = details.get(imageHistory.id);
    history.messages = [{ id: 'image-history-user', role: 'user', text: 'См. приложенный файл.', createdAt: timestamp, attachmentIds: ['image-history-file'] }];
    history.artifacts = [{ id: 'image-history-file', name: 'old-notes.txt', storedName: 'old-notes.txt', size: 128,
      sha256: 'e'.repeat(64), createdAt: timestamp, messageId: 'image-history-user' }];
    const textDetail = details.get(chatA.id);
    textDetail.modelId = 'GigaChat-3-Lightning';
    textDetail.messages = [];
    textDetail.draftAttachments = [{ id: 'text-chat-draft', name: 'notes.txt', storedName: 'text-chat-draft.txt', size: 32,
      sha256: 'f'.repeat(64), createdAt: timestamp }];
  }
  const smokeModelIds = ['GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro', 'GigaChat-3-Lightning'];
  const state = {
    projects, chats, details,
    homeDraft: { revision: 1, text: '', projectId: null, permissionProfile: null, skillId: null, modelId: null, attachments: [], lastAcceptance: null },
    deferHomeDraftGet: true, pendingHomeDraftGets: [],
    deferHomeDraftSaves: false, pendingHomeDraftSaves: [], homeDraftSaveCalls: [], rejectNextHomeDraftSave: false,
    deferHomeDraftImports: false, pendingHomeDraftImports: [], homeDraftImportCalls: 0,
    homeDraftStageCalls: [], chatDraftStageCalls: [], attachmentPreviewCalls: [], chatDraftAttachmentSequence: 0,
    chatDraftPickCalls: 0, imageGenerationCalls: 0, imageGeneratedArtifacts: 0, generatedImagePreviewCalls: [],
    deferGeneratedImagePreview: false, pendingGeneratedImagePreviews: [],
    generatedImageSaveCalls: [], generatedImageSaveResults: ['saved', 'cancelled', 'error', 'saved'], generatedImageOpenCalls: [],
    nextHomePickedFile: null, nextChatPickedFile: null,
    deferChatDraftImports: false, pendingChatDraftImports: [],
    deferChatDraftRemovals: false, pendingChatDraftRemovals: [],
    deferHomeDraftSendResponse: false, pendingHomeDraftSends: [], homeDraftSendCalls: [], rejectNextHomeDraftSend: false,
    homeDraftAttachmentSequence: 0, homeDraftAcceptanceSequence: 0,
    runtimeTurns: new Map(), retryCalls: [], runtimeCancelCalls: [], copyMessageCalls: [], rejectNextCopyMessage: false,
    modelRegistry: imageGenerationSmoke
      ? { state: 'ready', modelIds: smokeModelIds, errorCategory: null, exhaustedModelIds: [] }
      : { state: 'unavailable', modelIds: [], errorCategory: null }, modelRegistryCalls: [],
    connectionStatus: imageGenerationSmoke ? { state: 'connected', errorCategory: null } : { state: 'not-configured', errorCategory: null },
    connectionCalls: [], nextConnectionFailure: null,
    keyStatus: { available: true, saved: imageGenerationSmoke, usable: imageGenerationSmoke },
    hookRegistry: { hooks: [], issues: [] }, hookCalls: [],
    profileFixtures,
    profileView: profileFixtures.empty, profileViewCalls: 0, profileRefreshCalls: 0, profileAnchorSaveCalls: [],
    deferProfileGets: false, pendingProfileGets: [], rejectNextProfileRefresh: false,
    nextProfileRefreshView: null, rejectNextProfileAnchorSave: false,
    deferProfileAnchorSave: false, pendingProfileAnchorSaves: [],
    usageLedger: {
      key: 'all', requestCount: 0, completedRequestCount: 0, pendingRequestCount: 0, failedRequestCount: 0, cancelledRequestCount: 0,
      promptTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
      completionTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
      totalTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
      precachedPromptTokens: { knownTokens: 0, unknownRequests: 0, conflictedRequests: 0 },
      byChat: [], byModel: [], byDay: [],
    },
    deferChatGets: false, pendingGets: new Map(), rejectNextGet: null,
    createCalls: [],
    deferDraftUpdates: false, pendingDraftUpdates: [], deferProjectMoves: false, pendingProjectMoves: [], updateCalls: [],
    deferSkillUpdates: false, pendingSkillUpdates: [], deferPermissionUpdates: false, pendingPermissionUpdates: [], appendCalls: [],
    deferImports: false, pendingImports: [], importCalls: [],
    deferSettingUpdates: false, pendingSettingUpdates: [], deferConfigSaves: false, pendingConfigSaves: [], configContents: '',
    deferKeySaves: false, pendingKeySaves: [], keySaveCalls: 0,
    deferOnboardingBounds: false, pendingOnboardingBounds: [], onboardingBoundsCalls: [], openStudioCalls: 0,
    browserBoundsCalls: [],
    browserStatus: nativeWorkspaceMode ? { tabs: [], activeTabId: null, error: null } : {
      tabs: [makeBrowserTab('audit-browser-tab', 'Synthetic page', 'https://example.test/'), makeBrowserTab('audit-browser-tab-2', 'Second page', 'https://second.example.test/')],
      activeTabId: 'audit-browser-tab', error: null,
    },
    deferBrowserMethod: null, pendingBrowserActions: [],
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
  const applyHomeDraftSave = (input) => {
    if (input.revision === state.homeDraft.revision
      && input.text === state.homeDraft.text && input.projectId === state.homeDraft.projectId
      && input.permissionProfile === state.homeDraft.permissionProfile && input.skillId === state.homeDraft.skillId
      && input.modelId === state.homeDraft.modelId) return clone(state.homeDraft);
    if (input.revision !== state.homeDraft.revision + 1) throw new Error('Synthetic home draft revision conflict');
    state.homeDraft = {
      ...clone(input), attachments: clone(state.homeDraft.attachments), lastAcceptance: clone(state.homeDraft.lastAcceptance),
    };
    return clone(state.homeDraft);
  };
  const resolveHomeDraftSave = (record) => {
    try { record.resolve(applyHomeDraftSave(record.input)); }
    catch (error) { record.reject(error); }
  };
  const stageHomeDraftAttachment = (name, size = 24) => {
    const index = ++state.homeDraftAttachmentSequence;
    const attachment = {
      id: `home-file-${index}`, name: name || `prepared-${index}.txt`, storedName: `home-file-${index}.txt`,
      size, sha256: 'a'.repeat(64), createdAt: timestamp,
    };
    state.homeDraft = {
      ...state.homeDraft, revision: state.homeDraft.revision + 1,
      attachments: [...state.homeDraft.attachments, attachment],
    };
    return clone(state.homeDraft);
  };
  const stageChatDraftAttachment = (chatId, name, size = 24) => {
    const detail = state.details.get(chatId);
    if (!detail) throw new Error(`Synthetic chat not found: ${chatId}`);
    const index = ++state.chatDraftAttachmentSequence;
    detail.draftAttachments.push({
      id: `chat-file-${index}`, name: name || `prepared-chat-${index}.txt`, storedName: `chat-file-${index}.txt`,
      size, sha256: 'b'.repeat(64), createdAt: timestamp,
    });
    return clone(detail);
  };
  const acceptHomeDraft = (revision) => {
    state.homeDraftSendCalls.push(revision);
    if (state.homeDraft.lastAcceptance?.sourceRevision === revision) {
      const accepted = state.homeDraft.lastAcceptance;
      return {
        detail: clone(state.details.get(accepted.chatId)), turn: clone(accepted.turn),
        newlyAccepted: false, homeDraft: clone(state.homeDraft), queued: false,
      };
    }
    if (revision !== state.homeDraft.revision) throw new Error('Synthetic home draft changed before Send');
    const text = state.homeDraft.text.trim();
    if (!text && state.homeDraft.attachments.length === 0) throw new Error('Synthetic empty home draft');
    const index = ++state.homeDraftAcceptanceSequence;
    const id = `home-chat-${index}`;
    const message = { id: `home-message-${index}`, role: 'user', text, createdAt: timestamp,
      ...(state.homeDraft.attachments.length ? { attachmentIds: state.homeDraft.attachments.map((attachment) => attachment.id) } : {}) };
    const summary = makeChat(id, text ? text.split(/\r?\n/, 1)[0].slice(0, 60) : 'Прикреплённые файлы', state.homeDraft.projectId);
    const permissionProfile = state.homeDraft.permissionProfile ?? state.appSettings.defaultPermissionProfile;
    const detail = {
      ...summary, draft: '', nextTurnPermissionProfile: permissionProfile === state.appSettings.defaultPermissionProfile ? null : permissionProfile,
      modelId: state.homeDraft.modelId ?? state.appSettings.defaultModelId, nextTurnSkillId: state.homeDraft.skillId,
      messages: [message], turns: [], toolReceipts: [], draftAttachments: [], artifacts: state.homeDraft.attachments.map((attachment) => ({
        id: attachment.id, name: attachment.name, storedName: attachment.storedName, size: attachment.size,
        sha256: attachment.sha256, createdAt: attachment.createdAt, messageId: message.id,
      })), compactSnapshot: null,
    };
    const turn = {
      turnId: `home-turn-${index}`, chatId: id, projectId: state.homeDraft.projectId,
      projectWorkingFolder: state.projects.find((project) => project.id === state.homeDraft.projectId)?.workingFolder ?? null,
      messageId: message.id, assistantMessageId: `home-assistant-${index}`, historyBoundary: 1, messages: [message],
      ...(message.attachmentIds?.length ? { attachmentIds: [...message.attachmentIds] } : {}),
      permissionProfile, modelId: detail.modelId,
      skillId: state.homeDraft.skillId, reservation: { permissionProfileRevision: null, skillRevision: null },
    };
    detail.turns = [{
      turnId: turn.turnId, anchorMessageId: message.id, assistantMessageId: turn.assistantMessageId,
      modelId: turn.modelId, status: 'failed', createdAt: timestamp, endedAt: timestamp,
      error: 'Сообщение сохранено локально, но не поставлено в очередь.', activity: [],
    }];
    assert.equal(turn.historyBoundary, turn.messages.length, 'home acceptance freezes the complete first-message history');
    assert.equal(detail.turns[0].anchorMessageId, turn.messageId, 'durable home turn points at its accepted user message');
    assert.equal(detail.turns[0].assistantMessageId, turn.assistantMessageId, 'durable home turn reserves the assistant message ID');
    assert.equal(detail.turns[0].status, 'failed', 'home acceptance returning queued:false is not represented as queued');
    assert.equal(detail.turns[0].startedAt, undefined, 'a home turn that never started has no startedAt');
    state.chats.unshift(summary);
    state.details.set(id, detail);
    state.homeDraft = {
      ...state.homeDraft, revision: state.homeDraft.revision + 1, text: '', attachments: [],
      lastAcceptance: { sourceRevision: revision, chatId: id, turn: clone(turn) },
    };
    return { detail: clone(detail), turn: clone(turn), newlyAccepted: true, homeDraft: clone(state.homeDraft), queued: false };
  };
  const resolveHomeDraftImport = (record) => record.resolve({ record: stageHomeDraftAttachment(record.name ?? 'picked-home.txt', record.size ?? 24), failures: [] });
  const resolveHomeDraftFilePicker = (record, name = 'picked-home.txt') => record.resolve({
    record: stageHomeDraftAttachment(name), failures: [],
  });
  const resolveChatDraftFilePicker = (record, chatId, name = record.name ?? 'picked-chat.txt') => record.request.resolve({
    record: stageChatDraftAttachment(chatId, name, record.size ?? 24), failures: [],
  });
  const resolveHomeDraftSend = (record) => record.resolve(clone(record.accepted));
  const updateSummary = (id, patch) => {
    const summary = state.chats.find((item) => item.id === id);
    const detail = state.details.get(id);
    if (!summary || !detail) throw new Error(`Unknown synthetic chat: ${id}`);
    Object.assign(summary, patch, { updatedAt: timestamp });
    Object.assign(detail, patch, { updatedAt: timestamp });
    state.updateCalls.push({ id, patch: clone(patch) });
    return clone(summary);
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
  const resolveBrowserAction = (record, next) => {
    state.browserStatus = clone(next);
    record.resolve(clone(next));
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

  let nativeBrowser = null;
  let nativeServer = null;
  const nativeViewsCreated = [];
  const nativeLoadCounts = new Map();
  const nativeRequests = new Map();

  ipcMain.handle('audit:api', async (_event, group, method, args) => {
    console.log(`Synthetic bridge call: ${group}.${method}`);
    if (nativeWorkspaceMode && group === 'browser') {
      if (!nativeBrowser) throw new Error('Native browser controller is not ready.');
      if (method === 'getStatus') return nativeBrowser.getStatus();
      if (method === 'newTab') return nativeBrowser.newTab();
      if (method === 'closeTab') return nativeBrowser.closeTab(args[0]);
      if (method === 'activateTab') return nativeBrowser.activateTab(args[0]);
      if (method === 'navigate') return nativeBrowser.navigate(args[0]);
      if (method === 'back') { nativeBrowser.back(); return true; }
      if (method === 'forward') { nativeBrowser.forward(); return true; }
      if (method === 'reload') { nativeBrowser.reload(); return true; }
      if (method === 'setBounds') {
        state.browserBoundsCalls.push(clone(args[0]));
        nativeBrowser.setBounds(args[0]);
        return true;
      }
    }
    if (group === 'homeDraft' && method === 'get') {
      if (!state.deferHomeDraftGet) return clone(state.homeDraft);
      const request = deferred();
      state.pendingHomeDraftGets.push(request);
      return request.promise;
    }
    if (group === 'homeDraft' && method === 'save') {
      const input = clone(args[0]);
      state.homeDraftSaveCalls.push(input);
      if (state.rejectNextHomeDraftSave) {
        state.rejectNextHomeDraftSave = false;
        throw new Error('Synthetic home draft save failure');
      }
      if (state.deferHomeDraftSaves) {
        const request = deferred();
        state.pendingHomeDraftSaves.push({ input, resolve: request.resolve, reject: request.reject });
        return request.promise;
      }
      return applyHomeDraftSave(input);
    }
    if (group === 'homeDraft' && method === 'importFile') {
      state.homeDraftImportCalls += 1;
      if (!state.deferHomeDraftImports) return stageHomeDraftAttachment();
      const request = deferred();
      state.pendingHomeDraftImports.push(request);
      return request.promise;
    }
    if (group === 'homeDraft' && method === 'pickFiles') {
      state.homeDraftImportCalls += 1;
      const nextFile = state.nextHomePickedFile ?? { name: 'picked-home.txt', size: 24 };
      state.nextHomePickedFile = null;
      if (!state.deferHomeDraftImports) return { record: stageHomeDraftAttachment(nextFile.name, nextFile.size), failures: [] };
      const request = deferred();
      state.pendingHomeDraftImports.push({ ...request, name: nextFile.name, size: nextFile.size });
      return request.promise;
    }
    if (group === 'homeDraft' && method === 'stageFiles') {
      const inputs = Array.isArray(args[0]) ? args[0] : [];
      state.homeDraftStageCalls.push(inputs.map((input) => ({ name: input?.name ?? '', size: input?.size ?? 24 })));
      let record = clone(state.homeDraft);
      for (const input of inputs) record = stageHomeDraftAttachment(typeof input?.name === 'string' ? input.name : 'dropped-home.txt', Number.isSafeInteger(input?.size) ? input.size : 24);
      return { record, failures: [] };
    }
    if (group === 'homeDraft' && method === 'getAttachmentPreview') {
      state.attachmentPreviewCalls.push({ group, id: args[0] });
      return state.homeDraft.attachments.some((attachment) => attachment.id === args[0]) ? SYNTHETIC_IMAGE_PREVIEW : null;
    }
    if (group === 'homeDraft' && method === 'removeFile') {
      const id = args[0];
      if (!state.homeDraft.attachments.some((attachment) => attachment.id === id)) throw new Error('Synthetic home file not found');
      state.homeDraft = {
        ...state.homeDraft, revision: state.homeDraft.revision + 1,
        attachments: state.homeDraft.attachments.filter((attachment) => attachment.id !== id),
      };
      return clone(state.homeDraft);
    }
    if (group === 'homeDraft' && method === 'send') {
      if (state.rejectNextHomeDraftSend) {
        state.rejectNextHomeDraftSend = false;
        state.homeDraftSendCalls.push(args[0]);
        throw new Error('Synthetic home draft Send failure');
      }
      const accepted = acceptHomeDraft(args[0]);
      if (!state.deferHomeDraftSendResponse) return accepted;
      const request = deferred();
      state.pendingHomeDraftSends.push({ accepted, resolve: request.resolve, reject: request.reject });
      return request.promise;
    }
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
    if (group === 'chats' && method === 'copyMessage') {
      const [id, messageId] = args;
      state.copyMessageCalls.push({ id, messageId });
      if (state.rejectNextCopyMessage) {
        state.rejectNextCopyMessage = false;
        throw new Error('Synthetic clipboard write failed');
      }
      const message = state.details.get(id)?.messages.find((item) => item.id === messageId && item.role === 'user');
      if (!message) throw new Error('Synthetic copy accepts exact stored user messages only.');
      return undefined;
    }
    if (group === 'chats' && method === 'create') {
      const [projectId, kind = 'text'] = args;
      const record = { projectId, kind, index: state.createCalls.length + 1 };
      state.createCalls.push(clone(record));
      const summary = makeChat(`chat-new-${record.index}`, kind === 'image' ? 'New image chat' : `New chat ${record.index}`, projectId, kind);
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
    if (group === 'chats' && method === 'pickDraftFiles') {
      const [chatId] = args;
      state.chatDraftPickCalls += 1;
      const nextFile = state.nextChatPickedFile ?? { name: 'picked-chat.txt', size: 24 };
      state.nextChatPickedFile = null;
      if (!state.deferChatDraftImports) return { record: stageChatDraftAttachment(chatId, nextFile.name, nextFile.size), failures: [] };
      const request = deferred();
      state.pendingChatDraftImports.push({ chatId, request, name: nextFile.name, size: nextFile.size });
      return request.promise;
    }
    if (group === 'chats' && method === 'stageDraftFiles') {
      const [chatId, inputs] = args;
      const files = Array.isArray(inputs) ? inputs : [];
      state.chatDraftStageCalls.push({ chatId, files: files.map((input) => ({ name: input?.name ?? '', size: input?.size ?? 24 })) });
      let detail = clone(state.details.get(chatId));
      for (const input of files) detail = stageChatDraftAttachment(chatId, typeof input?.name === 'string' ? input.name : 'dropped-chat.txt', Number.isSafeInteger(input?.size) ? input.size : 24);
      return { record: detail, failures: [] };
    }
    if (group === 'chats' && method === 'getDraftAttachmentPreview') {
      const [chatId, attachmentId] = args;
      state.attachmentPreviewCalls.push({ group, chatId, attachmentId });
      return state.details.get(chatId)?.draftAttachments.some((attachment) => attachment.id === attachmentId) ? SYNTHETIC_IMAGE_PREVIEW : null;
    }
    if (group === 'chats' && method === 'getArtifactPreview') {
      const [chatId, artifactId] = args;
      state.attachmentPreviewCalls.push({ group, chatId, artifactId });
      return state.details.get(chatId)?.artifacts.some((artifact) => artifact.id === artifactId) ? SYNTHETIC_IMAGE_PREVIEW : null;
    }
    if (group === 'chats' && method === 'getGeneratedImagePreview') {
      const [chatId, artifactId] = args;
      state.generatedImagePreviewCalls.push({ chatId, artifactId });
      const artifact = state.details.get(chatId)?.artifacts.find((item) => item.id === artifactId && item.messageId);
      if (!artifact) return null;
      if (artifactId === 'image-legacy-artifact') return 'data:image/png;base64,not-a-png';
      if (state.deferGeneratedImagePreview) {
        const request = deferred();
        state.pendingGeneratedImagePreviews.push(request);
        return request.promise;
      }
      return generatedImagePreview;
    }
    if (group === 'chats' && method === 'saveGeneratedImage') {
      const [chatId, artifactId] = args;
      state.generatedImageSaveCalls.push({ chatId, artifactId });
      const outcome = state.generatedImageSaveResults.shift() ?? 'saved';
      if (outcome === 'error') throw new Error('Synthetic image save failure');
      return outcome;
    }
    if (group === 'chats' && method === 'openArtifact') {
      state.generatedImageOpenCalls.push({ chatId: args[0], artifactId: args[1] });
      return true;
    }
    if (group === 'chats' && method === 'removeDraftFile') {
      const [chatId, attachmentId] = args;
      const remove = () => {
        const detail = state.details.get(chatId);
        if (!detail?.draftAttachments.some((attachment) => attachment.id === attachmentId)) throw new Error('Synthetic chat draft file not found');
        detail.draftAttachments = detail.draftAttachments.filter((attachment) => attachment.id !== attachmentId);
        return clone(detail);
      };
      if (!state.deferChatDraftRemovals) return remove();
      const request = deferred();
      state.pendingChatDraftRemovals.push({ chatId, attachmentId, resolve: () => {
        try { request.resolve(remove()); }
        catch (error) { request.reject(error); }
      } });
      return request.promise;
    }
    if (group === 'chats' && method === 'appendLocalMessage') {
      const [id, text, attachmentIds = []] = args;
      const detail = state.details.get(id);
      const selectedAttachments = detail.draftAttachments.filter((attachment) => attachmentIds.includes(attachment.id));
      state.appendCalls.push({ id, text, attachmentIds: clone(attachmentIds), nextTurnSkillId: detail.nextTurnSkillId, nextTurnPermissionProfile: detail.nextTurnPermissionProfile });
      const messageId = `${id}-${detail.messages.length}`;
      detail.messages.push({ id: messageId, role: 'user', text, createdAt: timestamp,
        ...(attachmentIds.length ? { attachmentIds: clone(attachmentIds) } : {}) });
      detail.artifacts.push(...selectedAttachments.map((attachment) => ({ ...clone(attachment), messageId })));
      detail.draftAttachments = detail.draftAttachments.filter((attachment) => !attachmentIds.includes(attachment.id));
      detail.draft = '';
      updateSummary(id, { draft: '' });
      if (imageGenerationSmoke && detail.kind === 'image') {
        state.imageGenerationCalls += 1;
        if (state.imageGenerationCalls === 1) {
          const assistantId = `${id}-generated-assistant`;
          const artifactId = `${id}-generated-image`;
          detail.messages.push({ id: assistantId, role: 'assistant', source: 'runtime', text: 'Готово — изображение создано по описанию.', createdAt: timestamp, attachmentIds: [artifactId] });
          detail.turns.push({
            turnId: `${id}-generation-turn-1`, anchorMessageId: messageId, assistantMessageId: assistantId,
            modelId: 'GigaChat-3-Ultra', status: 'completed', createdAt: timestamp, startedAt: timestamp, endedAt: timestamp,
            activity: [{ kind: 'provider', at: timestamp, activity: 'receiving' }],
          });
          detail.artifacts.push({ id: artifactId, name: 'Изображение.png', storedName: `${artifactId}.png`, size: 24_000,
            sha256: '9'.repeat(64), createdAt: timestamp, messageId: assistantId });
          state.imageGeneratedArtifacts += 1;
        } else {
          const turn = {
            id: `${id}-pending-image-turn`, chatId: id, anchorMessageId: messageId, assistantMessageId: `${id}-pending-assistant`,
            status: 'running', createdAt: timestamp, startedAt: timestamp, activity: [], draft: 'Создаю изображение…',
          };
          state.runtimeTurns.set(id, [...(state.runtimeTurns.get(id) ?? []), turn]);
          setTimeout(() => {
            if (!window?.isDestroyed()) window.webContents.send('audit:runtime', turn);
          }, 80);
        }
      }
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
      state.keyStatus = { available: true, saved: true, usable: true };
      return clone(state.keyStatus);
    }
    if (group === 'onboarding' && method === 'getKeyStatus') return clone(state.keyStatus);
    if (group === 'onboarding' && method === 'getConnectionStatus') return clone(state.connectionStatus);
    if (group === 'onboarding' && method === 'connect') {
      state.connectionCalls.push(method);
      state.connectionStatus = state.nextConnectionFailure ?? { state: 'connected', errorCategory: null };
      state.nextConnectionFailure = null;
      if (state.connectionStatus.state === 'connected') {
        state.modelRegistry = { ...state.modelRegistry, exhaustedModelIds: [] };
      }
      return clone(state.connectionStatus);
    }
    if (group === 'onboarding' && (method === 'cancelConnect' || method === 'disconnect')) {
      state.connectionCalls.push(method);
      state.connectionStatus = { state: 'not-configured', errorCategory: null };
      return clone(state.connectionStatus);
    }
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
    if (group === 'hooks' && method === 'list') return clone(state.hookRegistry);
    if (group === 'hooks' && method === 'inspect') {
      state.hookCalls.push({ method, id: args[0] });
      const hook = state.hookRegistry.hooks.find((item) => item.id === args[0]);
      if (!hook) throw new Error('Synthetic hook does not exist.');
      return {
        id: hook.id, contentHash: hook.contentHash, name: hook.name, event: hook.event, source: hook.source,
        manifestContents: '{"name":"review-check","event":"session-start"}',
        actionContents: 'Write-Output "Synthetic renderer fixture"',
      };
    }
    if (group === 'hooks' && method === 'trust') {
      state.hookCalls.push({ method, id: args[0] });
      const hook = state.hookRegistry.hooks.find((item) => item.id === args[0]);
      if (hook && hook.contentHash === args[1]) hook.trusted = true;
      return clone(state.hookRegistry);
    }
    if (group === 'hooks' && method === 'setEnabled') {
      state.hookCalls.push({ method, id: args[0], enabled: args[1] });
      const hook = state.hookRegistry.hooks.find((item) => item.id === args[0]);
      if (hook) hook.enabled = args[1];
      return clone(state.hookRegistry);
    }
    if (group === 'models' && (method === 'getRegistry' || method === 'refresh')) {
      state.modelRegistryCalls.push(method);
      return clone(state.modelRegistry);
    }
    if (group === 'runtime' && method === 'list') return clone(state.runtimeTurns.get(args[0]) ?? []);
    if (group === 'runtime' && method === 'getStatus') return {
      providerConfigured: false, helperRecovered: false, rendererToolApi: false,
      helperUnavailableReason: 'Synthetic renderer fixture.', compactionAvailable: false,
      compactionUnavailableReason: 'Команда /compact выключена до проверки качества сводки. История чата не изменена.',
    };
    if (group === 'runtime' && method === 'cancel') {
      state.runtimeCancelCalls.push({ chatId: args[0], turnId: args[1] });
      return true;
    }
    if (group === 'runtime' && method === 'retry') {
      state.retryCalls.push({ chatId: args[0], turnId: args[1] });
      return `synthetic-retry-${state.retryCalls.length}`;
    }
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
    if (group === 'browser' && method === 'getStatus') return clone(state.browserStatus);
    if (group === 'browser' && ['newTab', 'activateTab', 'closeTab', 'navigate'].includes(method)) {
      if (state.deferBrowserMethod === method) {
        state.deferBrowserMethod = null;
        const request = deferred();
        const record = { method, args: clone(args), resolve: (next) => request.resolve(clone(next)), reject: request.reject };
        state.pendingBrowserActions.push(record);
        return request.promise;
      }
      if (method === 'activateTab') state.browserStatus.activeTabId = args[0];
      if (method === 'newTab') {
        const id = `audit-browser-tab-${state.browserStatus.tabs.length + 1}`;
        state.browserStatus.tabs.push(makeBrowserTab(id, 'New synthetic page', ''));
        state.browserStatus.activeTabId = id;
      }
      if (method === 'closeTab') {
        state.browserStatus.tabs = state.browserStatus.tabs.filter((tab) => tab.id !== args[0]);
        state.browserStatus.activeTabId = state.browserStatus.tabs[0]?.id ?? null;
      }
      if (method === 'navigate') {
        const activeTab = state.browserStatus.tabs.find((tab) => tab.id === state.browserStatus.activeTabId);
        if (activeTab) activeTab.url = args[0];
      }
      return clone(state.browserStatus);
    }
    if (group === 'browser' && method === 'setBounds') {
      state.browserBoundsCalls.push(clone(args[0]));
      return true;
    }
    if (group === 'usage' && method === 'getLocalStats') return { chatCount: state.chats.length, projectCount: state.projects.length, activityDayCount: 0 };
    if (group === 'usage' && method === 'getLedger') return clone(state.usageLedger);
    if (group === 'usage' && method === 'getProfileView') {
      state.profileViewCalls += 1;
      if (state.deferProfileGets) {
        const request = deferred();
        state.pendingProfileGets.push(request);
        return request.promise;
      }
      return clone(state.profileView);
    }
    if (group === 'usage' && method === 'refreshBalance') {
      state.profileRefreshCalls += 1;
      if (state.rejectNextProfileRefresh) {
        state.rejectNextProfileRefresh = false;
        const error = new Error('network');
        error.name = 'GigaChatProviderError';
        throw error;
      }
      state.profileView = clone(state.nextProfileRefreshView ?? state.profileFixtures.rich);
      state.nextProfileRefreshView = null;
      state.usageLedger = clone(state.profileFixtures.richLedger);
      return clone(state.profileView);
    }
    if (group === 'usage' && method === 'saveStudioBalanceAnchor') {
      const input = clone(args[0]);
      state.profileAnchorSaveCalls.push(input);
      if (state.rejectNextProfileAnchorSave) {
        state.rejectNextProfileAnchorSave = false;
        const error = new Error('storage');
        error.name = 'GigaChatProviderError';
        throw error;
      }
      assert.deepEqual(input, state.profileFixtures.studioInput, 'renderer sends only the values explicitly entered in the manual Studio check');
      if (state.deferProfileAnchorSave) {
        const request = deferred();
        state.pendingProfileAnchorSaves.push({ request, view: clone(state.profileFixtures.studio) });
        return request.promise;
      }
      state.profileView = clone(state.profileFixtures.studio);
      state.usageLedger = clone(state.profileFixtures.richLedger);
      return clone(state.profileView);
    }
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
  const waitDom = (name, expression, timeout) => waitUntil(name, () => evaluate(`Boolean(${expression})`), timeout);
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
  const actionTargetExpression = (selector, value) => `(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = matches.find((item) => ${value == null ? 'true' : `item.textContent.includes(${JSON.stringify(value)})`}
      && item.isConnected && !item.disabled && item.getAttribute('aria-disabled') !== 'true'
      && item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden'
      && getComputedStyle(item).display !== 'none'
      && item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0);
    return target ?? null;
  })()`;
  const clickAction = async (selector, value, description) => {
    const targetExpression = actionTargetExpression(selector, value);
    await waitUntil(`visible enabled action: ${description}`, () => evaluate(`(() => {
      const element = ${targetExpression};
      if (!element) return false;
      element.click();
      return true;
    })()`));
  };
  const click = async (selector) => clickAction(selector, null, selector);
  const clickText = async (selector, value) => clickAction(selector, value, value);
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
  const sendVisibleMouseClick = async (selector) => {
    const rect = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled || !element.isConnected || element.getClientRects().length === 0) return null;
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= innerHeight) return null;
      const list = element.closest('.chat-navigation-list');
      if (list) {
        const listBounds = list.getBoundingClientRect();
        if (bounds.top < listBounds.top || bounds.bottom > listBounds.bottom) return null;
      }
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      if (hit !== element && !element.contains(hit)) return null;
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    assert.ok(rect, `visible click target not found without scrolling: ${selector}`);
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
  const sendNativeButtonKey = async (keyCode, character) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'char', keyCode: character });
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
    if (!imageGenerationSmoke && !window.isVisible()) window.showInactive();
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
    if (image.isEmpty() && !imageGenerationSmoke) {
      window.showInactive();
      await sleep(120);
      image = await window.webContents.capturePage();
    }
    assert.equal(image.isEmpty(), false, `screenshot is empty while the fixture window stays hidden: ${name}`);
    const screenshotPath = join(fixturePath, `${name}.png`);
    await writeFile(screenshotPath, image.toPNG());
    console.log(`SCREENSHOT ${screenshotPath}`);
  };

  const runImageGenerationSmoke = async () => {
    const chatTitle = (value) => waitDom(`image smoke opens ${value}`, `document.querySelector('.chat-header-title')?.textContent === ${JSON.stringify(value)}`);
    const appendCount = () => state.appendCalls.length;
    const setPrompt = (value) => fillTextarea('.composer textarea', value);
    const send = () => click('.send-button');
    const clickDisabledSend = async () => evaluate(`(() => {
      const button = document.querySelector('.send-button');
      if (!button?.disabled) return false;
      button.click();
      return true;
    })()`);
    const assertImageBounds = async (label) => {
      const geometry = JSON.parse(await evaluate(`JSON.stringify((() => {
        const image = document.querySelector('.generated-image-result-preview');
        const frame = document.querySelector('.generated-image-result');
        const actions = document.querySelector('.generated-image-result-actions');
        const composer = document.querySelector('.composer');
        const box = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const imageBox = box(image);
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, image: imageBox, frame: box(frame), actions: box(actions), composer: box(composer),
          naturalWidth: image?.naturalWidth ?? 0, naturalHeight: image?.naturalHeight ?? 0,
          renderedRatio: imageBox && imageBox.height > 0 ? imageBox.width / imageBox.height : 0 };
      })())`));
      assert.ok(geometry.image && geometry.frame && geometry.actions, `${label}: image result/actions must remain visible`);
      for (const [name, rect] of [['image', geometry.image], ['frame', geometry.frame], ['actions', geometry.actions]]) {
        assert.ok(rect.width > 0 && rect.height > 0, `${label}: ${name} has a positive rendered box`);
      }
      assert.equal(geometry.naturalWidth, 1024, `${label}: synthetic preview decodes at its natural width`);
      assert.equal(geometry.naturalHeight, 576, `${label}: synthetic preview keeps its aspect ratio`);
      assert.ok(Math.abs(geometry.renderedRatio - (geometry.naturalWidth / geometry.naturalHeight)) < 0.02,
        `${label}: rendered image keeps its source aspect ratio`);
      assert.ok(geometry.image.left >= geometry.frame.left - 1 && geometry.image.right <= geometry.frame.right + 1
        && geometry.image.top >= geometry.frame.top - 1 && geometry.image.bottom <= geometry.frame.bottom + 1,
      `${label}: image remains inside its result frame`);
      assert.ok(geometry.image.left >= 0 && geometry.image.right <= geometry.viewport + 1
        && geometry.actions.left >= 0 && geometry.actions.right <= geometry.viewport + 1,
      `${label}: image and actions remain inside the visible viewport`);
      if (label === 'narrow' || label === 'browser-split') {
        assert.ok(geometry.image.width < geometry.naturalWidth, `${label}: preview shrinks within the available chat width`);
      }
      assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${label}: image chat has no horizontal page overflow: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.actions.right <= geometry.viewport + 1, `${label}: image actions remain inside the viewport: ${JSON.stringify(geometry)}`);
      console.log(`IMAGE_LAYOUT ${label} ${JSON.stringify(geometry)}`);
      return geometry;
    };

    assert.equal(window.isVisible(), false, 'image renderer smoke starts in a hidden BrowserWindow');
    assert.equal(window.webContents.isOffscreen(), true, 'image renderer smoke uses offscreen web contents');
    await clickChat('Legacy image chat');
    await chatTitle('Legacy image chat');
    await waitDom('legacy generated preview failure uses a readable fallback', `document.querySelector('.generated-image-result-placeholder')?.textContent.includes('Предпросмотр недоступен')`);
    assert.deepEqual(state.generatedImagePreviewCalls, [{ chatId: 'image-legacy', artifactId: 'image-legacy-artifact' }],
      'legacy generated result is loaded through the preview API exactly once');
    await capture('image-chat-preview-fallback');
    assert.equal(await evaluate(`document.querySelectorAll('.transcript-message p:empty').length`), 0,
      'empty generated-image assistant text does not render a blank paragraph');
    await setPrompt('Старый ход должен остаться в редакторе.');
    const beforeBlockedSend = appendCount();
    assert.equal(await evaluate(`document.querySelector('.send-button')?.disabled`), true,
      'legacy image chat with a staged file cannot submit');
    const generationsBeforeBlockedSend = state.imageGenerationCalls;
    assert.equal(await clickDisabledSend(), true, 'the disabled Send control is exercised without waiting for an enabled-action helper');
    assert.equal(appendCount(), beforeBlockedSend, 'blocked image submission does not append a message');
    assert.equal(state.imageGenerationCalls, generationsBeforeBlockedSend, 'blocked image submission does not start generation');
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), 'Старый ход должен остаться в редакторе.');
    const stageCallsBeforeDrop = state.chatDraftStageCalls.length;
    const dropResult = await evaluate(`(() => {
      const target = document.querySelector('.main-panel');
      const transfer = new DataTransfer();
      transfer.items.add(new File(['synthetic'], 'blocked.txt', { type: 'text/plain' }));
      const enter = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer });
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(enter); target.dispatchEvent(over); target.dispatchEvent(drop);
      return JSON.stringify({ enter: enter.defaultPrevented, over: over.defaultPrevented, drop: drop.defaultPrevented,
        dropEffect: transfer.dropEffect, overlay: Boolean(document.querySelector('.attachment-drop-overlay')) });
    })()`);
    const rejectedDrop = JSON.parse(dropResult);
    assert.equal(rejectedDrop.enter, true);
    assert.equal(rejectedDrop.over, true);
    assert.equal(rejectedDrop.drop, true);
    assert.equal(rejectedDrop.dropEffect, 'none');
    assert.equal(rejectedDrop.overlay, false, 'image mode does not show the release-to-attach overlay');
    assert.equal(state.chatDraftStageCalls.length, stageCallsBeforeDrop, 'rejected file drop never reaches the stage-files API');
    assert.equal(await evaluate(`document.querySelector('.attach-button')?.disabled`), true, 'image mode disables the file picker affordance');
    await clickText('.attachment-card-copy + button', 'Убрать');
    await waitUntil('legacy image draft file removed locally', () => state.details.get('image-legacy').draftAttachments.length === 0);
    await clickText('.image-model-upgrade button', 'Использовать GigaChat Ultra');
    await waitUntil('legacy image chat explicitly upgrades only its next-turn model', () => state.details.get('image-legacy').modelId === 'GigaChat-3-Ultra');
    assert.equal(state.appSettings.defaultModelId, null, 'upgrading an image chat does not change the text default model');

    await clickChat('Image chat with old file');
    await chatTitle('Image chat with old file');
    await setPrompt('Не использовать прежнее вложение.');
    const beforeHistorySend = appendCount();
    assert.equal(await evaluate(`document.querySelector('.image-composer-guidance')?.textContent.includes('Создайте новый чат изображений')`), true,
      'historical user files explain why a new image chat is required');
    const historyGenerationsBeforeSend = state.imageGenerationCalls;
    assert.equal(await clickDisabledSend(), true, 'historical-file Send remains disabled');
    const historyEnter = await evaluate(`(() => {
      const textarea = document.querySelector('.composer textarea');
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      textarea?.dispatchEvent(event);
      return { prevented: event.defaultPrevented, value: textarea?.value ?? null };
    })()`);
    assert.equal(historyEnter.prevented, true, 'Enter uses the shared guarded submit path');
    assert.equal(historyEnter.value, 'Не использовать прежнее вложение.');
    assert.equal(appendCount(), beforeHistorySend, 'historical user file blocker stops before append');
    assert.equal(state.imageGenerationCalls, historyGenerationsBeforeSend, 'historical-file Send does not start generation');
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), 'Не использовать прежнее вложение.',
      'the rejected historical-file prompt stays in the composer');
    await clickText('.nav-action', 'Сгенерировать изображение');
    await chatTitle('New image chat');
    await waitUntil('new image chat is created with the verified Ultra model', () => state.details.get('chat-new-1')?.modelId === 'GigaChat-3-Ultra');
    assert.equal(state.createCalls.at(-1)?.kind, 'image', 'image action creates a dedicated image chat');
    assert.equal(state.appSettings.defaultModelId, null, 'creating an image chat does not change the text default');
    assert.equal(await evaluate(`document.querySelector('.attach-button')?.disabled`), true);
    await setPrompt('Небольшой маяк у моря на закате.');
    state.deferGeneratedImagePreview = true;
    const previewCallsBeforeResult = state.generatedImagePreviewCalls.length;
    await send();
    await waitUntil('one synthetic image turn is accepted', () => state.imageGenerationCalls === 1 && state.imageGeneratedArtifacts === 1);
    await waitUntil('the new result starts one deferred preview request', () => state.generatedImagePreviewCalls.length === previewCallsBeforeResult + 1
      && state.pendingGeneratedImagePreviews.length === 1);
    assert.deepEqual(state.generatedImagePreviewCalls.at(-1), { chatId: 'chat-new-1', artifactId: 'chat-new-1-generated-image' },
      'new assistant result requests its own preview exactly once');
    await waitDom('generated-image loading state is visible', `document.querySelector('.generated-image-result-placeholder')?.textContent.includes('Загружаем изображение')`);
    await capture('image-chat-preview-loading');
    const pendingPreview = state.pendingGeneratedImagePreviews.shift();
    state.deferGeneratedImagePreview = false;
    pendingPreview.resolve(generatedImagePreview);
    await waitDom('generated image preview decodes', `document.querySelector('.generated-image-result-preview')?.naturalWidth === 1024`);
    assert.equal(state.generatedImagePreviewCalls.length, previewCallsBeforeResult + 1, 'assistant image result uses one preview request');
    const orderedResult = await evaluate(`(() => {
      const activity = document.querySelector('[data-turn-id="chat-new-1-generation-turn-1"]');
      const answer = document.querySelector('[data-message-id="chat-new-1-generated-assistant"]');
      return Boolean(activity && answer && (activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`);
    assert.equal(orderedResult, true, 'the completed activity appears before its linked generated result');
    const resultArtifactId = 'chat-new-1-generated-image';
    const acceptedAppendCount = appendCount();
    const previewCallsBeforeResultActions = state.generatedImagePreviewCalls.length;
    await capture('image-chat-dark-wide');
    await assertImageBounds('wide');

    const focusResult = await evaluate(`(() => { const action = document.querySelector('.generated-image-result-actions button'); action?.focus(); return document.activeElement === action; })()`);
    assert.equal(focusResult, true, 'result actions can receive keyboard focus');
    await capture('image-chat-result-focused');
    for (const [expected, status] of [['saved', 'Сохранено'], ['cancelled', 'Сохранение отменено'], ['error', 'Не удалось сохранить'], ['saved', 'Сохранено']]) {
      await click('.generated-image-result-actions button');
      if (expected === 'saved') await waitDom(`save result ${status}`, `document.querySelector('.generated-image-result-actions button')?.textContent.includes(${JSON.stringify(status)})`);
      else await waitDom(`save outcome ${status}`, `document.querySelector('.generated-image-result-actions')?.textContent.includes(${JSON.stringify(status)})`);
      if (expected === 'error') await capture('image-chat-save-error');
    }
    await clickText('.generated-image-result-actions button', 'Открыть');
    assert.equal(state.generatedImageSaveCalls.length, 4, 'save success, cancellation, error and retry use only the save API');
    assert.equal(state.generatedImageOpenCalls.length, 1, 'Open uses the existing artifact API');
    assert.ok(state.generatedImageSaveCalls.every((call) => call.chatId === 'chat-new-1' && call.artifactId === resultArtifactId));
    assert.equal(state.generatedImageOpenCalls[0].artifactId, resultArtifactId);
    assert.equal(state.generatedImagePreviewCalls.length, previewCallsBeforeResultActions, 'save and open do not refetch the result preview');
    assert.equal(appendCount(), acceptedAppendCount, 'save/open never append a chat message');
    assert.equal(state.imageGenerationCalls, 1, 'save/open never start another image generation');
    await waitDom('save and open leave the rendered result in history', `document.querySelector('.generated-image-result-preview')?.naturalWidth === 1024`);

    window.setSize(620, 740);
    await sleep(180);
    await assertImageBounds('narrow');
    await capture('image-chat-narrow');
    window.setSize(1260, 760);
    await sleep(180);
    await click('button[aria-label="Показать браузер"]');
    await waitDom('synthetic browser split opens without a native workspace', `document.querySelector('.browser-workspace.browser-open')`);
    await assertImageBounds('browser-split');
    await capture('image-chat-browser-split');
    await click('button[aria-label="Скрыть браузер"]');

    await click('button[aria-label="Настройки"]');
    await waitDom('appearance settings open from image chat', `document.querySelector('.settings-panel')`);
    await clickText('.settings-nav-item', 'Оформление');
    await clickText('.theme-option', 'Светлая');
    await waitDom('light theme applies to the image workspace', `document.querySelector('.app-frame')?.classList.contains('theme-light')`);
    await click('button[aria-label="Назад"]');
    await chatTitle('New image chat');
    await capture('image-chat-light');
    await assertImageBounds('light');

    await click('button[aria-label="Настройки"]');
    await waitDom('appearance settings reopen from image chat', `document.querySelector('.settings-panel')`);
    await clickText('.settings-nav-item', 'Оформление');
    await clickText('.theme-option', 'Тёплая');
    await waitDom('warm theme applies to the image workspace', `document.querySelector('.app-frame')?.classList.contains('theme-warm')`);
    await click('button[aria-label="Назад"]');
    await chatTitle('New image chat');
    await capture('image-chat-warm');
    await assertImageBounds('warm');
    window.webContents.setZoomFactor(1.25);
    await sleep(180);
    await assertImageBounds('zoom-125');
    await capture('image-chat-zoom-125');
    window.webContents.setZoomFactor(1);
    await sleep(180);

    await setPrompt('Проверь сохранённое изображение во время следующего хода.');
    await send();
    await waitUntil('next image turn remains pending beside the saved result', () => state.imageGenerationCalls === 2
      && (state.runtimeTurns.get('chat-new-1') ?? []).length === 1);
    await waitDom('previous image remains visible while a later image turn is running', `document.querySelector('.generated-image-result-preview')?.naturalWidth === 1024
      && document.querySelector('.transcript-draft')?.textContent.includes('Создаю изображение')`);
    await capture('image-chat-next-turn-running');
    await assertImageBounds('running-next-turn');

    await clickChat('Chat A');
    await chatTitle('Chat A');
    await waitDom('ordinary text attachment chip remains visible', `document.querySelector('.attachment-card-copy strong')?.textContent === 'notes.txt'`);
    assert.equal(await evaluate(`document.querySelector('.attach-button')?.disabled`), false, 'ordinary text chat keeps its attachment picker');
    await setPrompt('Обычный текстовый вопрос.');
    assert.equal(await evaluate(`document.querySelector('.send-button-wrap')?.title`), 'Отправить текст и подготовленные вложения',
      'text chat retains its original send guidance');
    const pickCallsBefore = state.chatDraftPickCalls;
    await click('.attach-button');
    await waitUntil('ordinary text chat can still pick a file', () => state.chatDraftPickCalls === pickCallsBefore + 1);
    await waitDom('picked text file appears in ordinary chat draft', `document.querySelectorAll('.attachment-card').length === 2`);
    assert.equal(state.imageGenerationCalls, 2, 'ordinary text UI tests do not create image requests');
    assert.equal(state.appendCalls.length, acceptedAppendCount + 1, 'only the two valid image prompts append; the final +1 is the pending second turn already recorded');
    assert.equal(state.generatedImageSaveCalls.length, 4);
    await clickText('.nav-action', 'Новый чат');
    await waitDom('ordinary Home composer stays available', `document.querySelector('.empty-state h1')?.textContent === 'Что будем создавать?'`);
    assert.equal(state.appSettings.defaultModelId, null, 'ordinary Home model default remains unchanged');
    assert.equal(window.isVisible(), false, 'image-generation smoke never reveals or focuses the BrowserWindow');
    console.log(`IMAGE_SMOKE_COUNTS ${JSON.stringify({ passCount, imageGenerationCalls: state.imageGenerationCalls, generatedImageArtifacts: state.imageGeneratedArtifacts,
      appends: state.appendCalls.length, saves: state.generatedImageSaveCalls.length, opens: state.generatedImageOpenCalls.length,
      previews: state.generatedImagePreviewCalls.length, stagedDrops: state.chatDraftStageCalls.length, pickerCalls: state.chatDraftPickCalls })}`);
    process.stdout.write('Plan011 image-generation renderer smoke: PASS\n', () => app.exit(0));
  };

  const runNativeBrowserWorkspace = async () => {
    const pageHtml = (title, path) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:18px sans-serif;margin:24px}main{min-height:2200px}input{font-size:18px}section{margin-top:900px}</style></head><body><main data-fixture-page="${path}"><h1 id="fixture-title">${title}</h1><label>Saved input <input id="saved-input" value="initial"></label><form id="fixture-form"><label>Form value <input id="form-input" value=""></label><button type="submit">Apply</button><output id="form-result"></output></form><a id="history-link" href="/one?step=2">History entry</a><section id="deep-section">Scroll state</section><script>document.querySelector('#fixture-form').addEventListener('submit',(event)=>{event.preventDefault();document.querySelector('#form-result').value=document.querySelector('#form-input').value})</script></main></body></html>`;
    nativeServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const key = `${url.pathname}${url.search}`;
      nativeRequests.set(key, (nativeRequests.get(key) ?? 0) + 1);
      const one = url.pathname === '/one';
      if (!one && url.pathname !== '/two') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(pageHtml(one ? 'Workspace fixture one' : 'Workspace fixture two', url.pathname));
    });
    await new Promise((resolveListen, rejectListen) => {
      nativeServer.once('error', rejectListen);
      nativeServer.listen(0, '127.0.0.1', resolveListen);
    });
    const address = nativeServer.address();
    assert.ok(address && typeof address === 'object', 'loopback fixture server must bind to an ephemeral port');
    const origin = `http://127.0.0.1:${address.port}`;
    const nativeTitle = `Plan009 Native Browser Workspace QA PID ${process.pid} ${fixturePath.split(/[\\/]/).at(-1)}`;
    window.setTitle(nativeTitle);
    window.setSize(1520, 940);
    window.show();
    window.focus();
    window.webContents.focus();
    await sleep(180);

    const status = () => nativeBrowser.getStatus();
    const activeStatus = () => {
      const current = status();
      return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
    };
    const waitUrl = (name, path) => waitUntil(name, () => activeStatus()?.url?.endsWith(path) ?? false, 10000);
    const waitNativePage = async (name, view, path) => waitUntil(name, async () => {
      if (view.webContents.isDestroyed() || !view.webContents.getURL().endsWith(path)) return false;
      const tabIndex = nativeViewsCreated.indexOf(view);
      const tab = status().tabs[tabIndex];
      return tab?.loading === false && await view.webContents.executeJavaScript("document.readyState === 'complete' && Boolean(document.querySelector('#fixture-title'))");
    }, 10000);
    const navigateAddress = async (url) => {
      await evaluate(`(() => { const input = document.querySelector('.browser-address input'); if (!input) return false; input.focus(); input.select(); return true; })()`);
      window.webContents.insertText(url);
      await waitUntil('address field receives fixture URL', () => evaluate(`document.querySelector('.browser-address input')?.value === ${JSON.stringify(url)}`));
      const submitted = await evaluate(`(() => { const form = document.querySelector('.browser-address'); if (!form) return false; form.requestSubmit(); return true; })()`);
      assert.equal(submitted, true, 'native address form must submit through the rendered UI handler');
    };
    const attached = (view) => window.contentView.children.includes(view);
    const assertViewportBounds = async (view, label) => {
      const css = JSON.parse(await evaluate(`JSON.stringify((() => {
        const viewport = document.querySelector('.browser-viewport')?.getBoundingClientRect();
        const header = document.querySelector('.chat-header')?.getBoundingClientRect();
        const toolbar = document.querySelector('.browser-toolbar')?.getBoundingClientRect();
        return viewport && header && toolbar ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height, headerBottom: header.bottom, toolbarTop: toolbar.top, toolbarBottom: toolbar.bottom } : null;
      })())`));
      assert.ok(css, `${label}: browser viewport, title row, and toolbar must exist`);
      assert.ok(css.headerBottom <= css.toolbarTop + 1, `${label}: workspace title row must be above the browser toolbar`);
      assert.ok(css.toolbarBottom <= css.y + 1, `${label}: native page must begin below the browser toolbar`);
      const zoom = window.webContents.getZoomFactor();
      const expected = { x: css.x * zoom, y: css.y * zoom, width: css.width * zoom, height: css.height * zoom };
      const actual = view.getBounds();
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(actual[key] - expected[key]) <= 2, `${label}: native ${key} ${actual[key]} should match rendered viewport ${expected[key]}`);
      }
      return { css, zoom, expected, actual };
    };
    const startDividerGesture = async (label) => {
      await evaluate(`(() => {
        window.__plan009PointerTrace = [];
        const record = (event) => {
          if (!event.target?.closest?.('.browser-resizer') && !document.querySelector('.browser-workspace.is-dragging')) return;
          const divider = document.querySelector('.browser-resizer');
          window.__plan009PointerTrace.push({ type: event.type, pointerId: event.pointerId, buttons: event.buttons, clientX: event.clientX, captured: Boolean(divider?.hasPointerCapture?.(event.pointerId)) });
        };
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(type, record, true);
        return true;
      })()`);
      const geometry = JSON.parse(await evaluate(`JSON.stringify((() => {
        const divider = document.querySelector('.browser-resizer')?.getBoundingClientRect();
        const workspace = document.querySelector('.browser-workspace')?.getBoundingClientRect();
        return divider && workspace ? { dividerX: divider.left + divider.width / 2, y: divider.top + Math.min(90, divider.height / 2), workspaceLeft: workspace.left, workspaceWidth: workspace.width, paneWidth: document.querySelector('.browser-pane')?.getBoundingClientRect().width } : null;
      })())`));
      assert.ok(geometry, `${label}: split view resizer and workspace must be visible`);
      const zoom = window.webContents.getZoomFactor();
      const x = Math.round(geometry.dividerX * zoom);
      const y = Math.round(geometry.y * zoom);
      window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await waitDom(`${label}: captured drag starts`, `document.querySelector('.browser-workspace.is-dragging')`);
      return { ...geometry, zoom, x, y };
    };
    const moveCapturedPointer = (xCss, yCss, zoom) => window.webContents.sendInputEvent({
      type: 'mouseMove', x: Math.round(xCss * zoom), y: Math.round(yCss * zoom), modifiers: ['leftButtonDown'],
    });
    const releaseCapturedPointer = (xCss, yCss, zoom) => window.webContents.sendInputEvent({
      type: 'mouseUp', x: Math.round(xCss * zoom), y: Math.round(yCss * zoom), button: 'left', clickCount: 1,
    });

    await clickChat('Chat B');
    await waitDom('native test selects Chat B', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    await evaluate(`window.__plan009Composer = document.querySelector('.composer textarea')`);
    await click('button[aria-label="Показать браузер"]');
    await waitDom('native browser pane opens', `document.querySelector('.browser-address input')`);
    await waitUntil('native controller creates the blank tab', () => status().tabs.length === 1);
    await navigateAddress(`${origin}/one`);
    await waitUrl('native first tab receives /one', '/one');
    await waitUntil('native first WebContentsView is created', () => nativeViewsCreated.length === 1);
    const firstTab = activeStatus();
    const firstView = nativeViewsCreated[0];
    await waitNativePage('native first page finishes', firstView, '/one');
    assert.equal(attached(firstView), true, 'active native browser view must attach in split mode');
    await sleep(120);
    const splitBrowserGeometry = await assertViewportBounds(firstView, 'split layout');
    passed('Native controller creates an isolated WebContentsView for loopback page one');

    await firstView.webContents.executeJavaScript(`(() => {
      document.querySelector('#saved-input').value = 'preserved-across-surface-switch';
      document.querySelector('#form-input').value = 'form-state-survives';
      document.querySelector('#form-input').dispatchEvent(new Event('input', { bubbles: true }));
      window.scrollTo(0, 680);
      return true;
    })()`);
    const pageOneBefore = await firstView.webContents.executeJavaScript(`JSON.stringify({ url: location.href, title: document.title, saved: document.querySelector('#saved-input').value, form: document.querySelector('#form-input').value, scrollY: window.scrollY })`);
    const pageOneState = JSON.parse(pageOneBefore);
    assert.equal(pageOneState.saved, 'preserved-across-surface-switch');
    assert.equal(pageOneState.form, 'form-state-survives');
    assert.ok(pageOneState.scrollY >= 600, `native page should scroll before detach: ${pageOneState.scrollY}`);

    await firstView.webContents.executeJavaScript("document.querySelector('#history-link').scrollIntoView({ block: 'center' })");
    const historyLinkRect = await firstView.webContents.executeJavaScript(`(() => { const rect = document.querySelector('#history-link').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    const childZoom = firstView.webContents.getZoomFactor();
    const historyLinkX = Math.round(historyLinkRect.x * childZoom);
    const historyLinkY = Math.round(historyLinkRect.y * childZoom);
    await sleep(60);
    window.show();
    window.focus();
    firstView.webContents.focus();
    const historyInputBefore = {
      url: firstView.webContents.getURL(), rect: historyLinkRect, zoom: childZoom, bounds: firstView.getBounds(), attached: attached(firstView), visible: firstView.getVisible(),
      hit: await firstView.webContents.executeJavaScript(`document.elementFromPoint(${historyLinkRect.x}, ${historyLinkRect.y})?.id ?? null`),
    };
    console.log(`NATIVE_HISTORY_INPUT_BEFORE ${JSON.stringify(historyInputBefore)}`);
    firstView.webContents.sendInputEvent({ type: 'mouseMove', x: historyLinkX, y: historyLinkY });
    firstView.webContents.sendInputEvent({ type: 'mouseDown', x: historyLinkX, y: historyLinkY, button: 'left', clickCount: 1 });
    firstView.webContents.sendInputEvent({ type: 'mouseUp', x: historyLinkX, y: historyLinkY, button: 'left', clickCount: 1 });
    try { await waitUrl('native history link adds an entry', '/one?step=2'); }
    catch (error) {
      const historyInputAfter = {
        url: firstView.webContents.getURL(), status: activeStatus(), pageUserActivation: await firstView.webContents.executeJavaScript('navigator.userActivation.hasBeenActive'),
        history: { activeIndex: firstView.webContents.navigationHistory.getActiveIndex(), entries: firstView.webContents.navigationHistory.getAllEntries().map((entry) => entry.url) },
      };
      console.log(`NATIVE_HISTORY_INPUT_AFTER ${JSON.stringify(historyInputAfter)}`);
      error.message += `; history input evidence: ${JSON.stringify({ before: historyInputBefore, after: historyInputAfter })}`;
      throw error;
    }
    await waitNativePage('native history entry finishes', firstView, '/one?step=2');
    let backHistoryAvailable = true;
    try { await waitUntil('native controller publishes committed back history', () => activeStatus()?.canGoBack === true, 1800); }
    catch { backHistoryAvailable = false; }
    const historyDiagnostic = {
      status: activeStatus(), url: firstView.webContents.getURL(), pageUserActivation: await firstView.webContents.executeJavaScript('navigator.userActivation.hasBeenActive'), legacyCanGoBack: firstView.webContents.canGoBack(),
      navigationHistory: {
        canGoBack: firstView.webContents.navigationHistory.canGoBack(),
        canGoForward: firstView.webContents.navigationHistory.canGoForward(),
        activeIndex: firstView.webContents.navigationHistory.getActiveIndex(),
        entries: firstView.webContents.navigationHistory.getAllEntries().map((entry) => ({ url: entry.url, title: entry.title })),
      },
    };
    console.log(`NATIVE_HISTORY_DIAGNOSTIC ${JSON.stringify(historyDiagnostic)}`);
    assert.equal(backHistoryAvailable, true, `the browser tab should expose committed back history after the fixture link: ${JSON.stringify(historyDiagnostic)}`);
    await click('button[aria-label="Назад в браузере"]');
    await waitUrl('native browser back restores the first fixture URL', '/one');
    await waitNativePage('native browser back finishes', firstView, '/one');
    await waitUntil('native forward history is available', () => activeStatus()?.canGoForward === true);
    await firstView.webContents.executeJavaScript(`(() => {
      document.querySelector('#saved-input').value = 'preserved-across-surface-switch';
      document.querySelector('#form-input').value = 'form-state-survives';
      window.scrollTo(0, 680);
      return true;
    })()`);
    const stateAfterHistory = JSON.parse(await firstView.webContents.executeJavaScript(`JSON.stringify({ url: location.href, saved: document.querySelector('#saved-input').value, form: document.querySelector('#form-input').value, scrollY: window.scrollY })`));
    const firstLoadCountAfterHistory = nativeLoadCounts.get(firstView.webContents.id) ?? 0;
    assert.ok(firstLoadCountAfterHistory >= 2, `native history should have loaded multiple entries: ${firstLoadCountAfterHistory}`);

    await click('.browser-new-tab');
    await waitUntil('native second tab appears', () => status().tabs.length === 2);
    await navigateAddress(`${origin}/two`);
    await waitUrl('native second tab receives /two', '/two');
    await waitUntil('native second WebContentsView is created', () => nativeViewsCreated.length === 2);
    const secondTab = activeStatus();
    const secondView = nativeViewsCreated[1];
    await waitNativePage('native second page finishes', secondView, '/two');
    assert.equal(attached(secondView), true, 'active second native view must attach in split mode');
    assert.notEqual(firstView.webContents.id, secondView.webContents.id, 'each real browser tab must keep its own WebContents');
    assert.equal(firstView.webContents.session, secondView.webContents.session, 'browser tabs must reuse the dedicated browser session');
    assert.equal(firstView.webContents.session, session.fromPartition('persist:gigachat-browser'), 'native browser pages must stay in the product browser partition');
    const nativePreferences = firstView.webContents.getLastWebPreferences();
    assert.deepEqual({ contextIsolation: nativePreferences.contextIsolation, nodeIntegration: nativePreferences.nodeIntegration, sandbox: nativePreferences.sandbox, webSecurity: nativePreferences.webSecurity },
      { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }, 'native browser views must retain their restricted web preferences');
    passed('Two browser tabs retain distinct WebContents in the same restricted browser session');

    await click(`[data-browser-tab-id="${firstTab.id}"]`);
    await waitUrl('activating first tab restores its native page', '/one');
    await waitUntil('first tab view reattaches', () => attached(firstView));
    const restoredPageOne = JSON.parse(await firstView.webContents.executeJavaScript(`JSON.stringify({ url: location.href, title: document.title, saved: document.querySelector('#saved-input').value, form: document.querySelector('#form-input').value, scrollY: window.scrollY })`));
    assert.equal(firstView.webContents.id, nativeViewsCreated[0].webContents.id);
    assert.equal(restoredPageOne.saved, pageOneState.saved);
    assert.equal(restoredPageOne.form, pageOneState.form);
    assert.equal(restoredPageOne.scrollY, pageOneState.scrollY);

    await click('button[aria-label="Развернуть на всю рабочую область"]');
    await waitDom('native browser surface enters full workspace mode', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
    await waitUntil('native full-browser view is attached', () => attached(firstView));
    const fullBrowserBounds = firstView.getBounds();
    assert.ok(fullBrowserBounds.width > 500 && fullBrowserBounds.height > 300, `full-browser bounds must cover its content area: ${JSON.stringify(fullBrowserBounds)}`);
    await sleep(120);
    const fullBrowserGeometry = await assertViewportBounds(firstView, 'full-browser layout');
    const pageOneBeforeDetach = JSON.parse(await firstView.webContents.executeJavaScript(`JSON.stringify({ url: location.href, title: document.title, saved: document.querySelector('#saved-input').value, form: document.querySelector('#form-input').value, scrollY: window.scrollY })`));
    await capture('native-browser-workspace-full-browser');

    await click('#workspace-chat-tab');
    await waitDom('native full workspace selects Chat B', `document.querySelector('.browser-workspace.is-full.surface-chat')`);
    await waitUntil('native view detaches for full-chat surface', () => !attached(firstView) && state.browserBoundsCalls.at(-1) === null);
    assert.equal(await evaluate(`document.querySelector('.composer textarea') === window.__plan009Composer`), true, 'switching surfaces must retain the same mounted chat composer');
    const detachedPageOne = JSON.parse(await firstView.webContents.executeJavaScript(`JSON.stringify({ url: location.href, saved: document.querySelector('#saved-input').value, form: document.querySelector('#form-input').value, scrollY: window.scrollY })`));
    assert.deepEqual(detachedPageOne, { url: pageOneBeforeDetach.url, saved: pageOneBeforeDetach.saved, form: pageOneBeforeDetach.form, scrollY: pageOneBeforeDetach.scrollY }, 'detaching the native view must preserve its live page state');
    await capture('native-browser-workspace-full-chat-detached');

    await click(`[data-browser-tab-id="${firstTab.id}"]`);
    await waitDom('native browser tab returns to the full workspace', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
    await waitUntil('same native view reattaches after full chat', () => attached(firstView));
    assert.equal(firstView.webContents.id, nativeViewsCreated[0].webContents.id, 'restoring the page must not create a replacement WebContents');
    await click('button[aria-label="Выйти из режима полного просмотра"]');
    await waitDom('native workspace returns to split mode', `!document.querySelector('.browser-workspace.is-full') && document.querySelector('.browser-pane')`);
    await waitUntil('native split view remains attached', () => attached(firstView));
    const restoredSplitBounds = firstView.getBounds();
    assert.ok(restoredSplitBounds.width > 250 && restoredSplitBounds.width < fullBrowserBounds.width, `split view bounds must be restored: ${JSON.stringify(restoredSplitBounds)}`);
    assert.equal(firstView.webContents.getURL(), restoredPageOne.url, 'restoring split mode must not reload or navigate the live tab');
    assert.equal(nativeLoadCounts.get(firstView.webContents.id), firstLoadCountAfterHistory, 'detaching/restoring a live tab must not reload it');
    assert.equal(nativeRequests.get('/two'), 1, 'the second fixture should be requested once despite tab switches');
    const requestsAfterTabLoads = Object.fromEntries(nativeRequests);
    passed('Full browser, full chat, and split restoration keep page IDs, form/scroll state, and live bounds');

    const beforeOverlayLoads = Object.fromEntries(nativeLoadCounts);
    const beforeOverlayRequests = Object.fromEntries(nativeRequests);
    await click('button[aria-label="Действия чата Chat B"]');
    await waitDom('native chat action overlay opens', `document.querySelector('.action-menu-content:popover-open')`);
    await waitUntil('native view detaches for the first overlay', () => !attached(firstView) && state.browserBoundsCalls.at(-1) === null);
    await clickText('.action-menu-content:popover-open .submenu-trigger', 'Переместить в проект');
    await waitDom('native nested project overlay opens', `document.querySelector('.submenu-content:popover-open')`);
    assert.equal(attached(firstView), false, 'nested overlays must keep the real browser view detached');
    const closeNativeOverlay = async () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
      await sleep(100);
    };
    await closeNativeOverlay();
    await waitDom('native nested overlay closes while parent stays open', `!document.querySelector('.submenu-content:popover-open') && document.querySelector('.action-menu-content:popover-open')`);
    assert.equal(state.browserBoundsCalls.at(-1), null, 'closing only the nested overlay must keep native bounds suspended');
    assert.equal(attached(firstView), false, 'closing only the nested overlay must not reattach the browser view');
    await closeNativeOverlay();
    await waitUntil('native view reattaches after the last overlay closes', () => attached(firstView) && state.browserBoundsCalls.at(-1)?.width > 0);
    await sleep(100);
    const boundsAfterLastOverlay = await assertViewportBounds(firstView, 'native view after last overlay closes');
    assert.deepEqual(Object.fromEntries(nativeLoadCounts), beforeOverlayLoads, 'overlays must not reload native pages');
    assert.deepEqual(Object.fromEntries(nativeRequests), beforeOverlayRequests, 'overlays must not request native pages again');
    passed('Nested native overlays detach the live view and restore it only after the last overlay closes');

    for (let index = 0; index < 3; index += 1) {
      await click('button[aria-label="Развернуть на всю рабочую область"]');
      await waitDom(`rapid full-browser presentation ${index + 1}`, `document.querySelector('.browser-workspace.is-full.surface-browser')`);
      await waitUntil(`rapid full-browser view ${index + 1} stays attached`, () => attached(firstView));
      await sleep(45);
      await assertViewportBounds(firstView, `rapid full-browser presentation ${index + 1}`);
      await click('button[aria-label="Выйти из режима полного просмотра"]');
      await waitDom(`rapid split presentation ${index + 1}`, `!document.querySelector('.browser-workspace.is-full') && document.querySelector('.browser-pane')`);
      await waitUntil(`rapid split view ${index + 1} stays attached`, () => attached(firstView));
      await sleep(45);
      await assertViewportBounds(firstView, `rapid split presentation ${index + 1}`);
    }
    assert.equal(firstView.webContents.id, nativeViewsCreated[0].webContents.id, 'rapid presentation changes must retain the same WebContents');
    assert.deepEqual(Object.fromEntries(nativeLoadCounts), beforeOverlayLoads, 'rapid presentation changes must not reload native pages');
    assert.deepEqual(Object.fromEntries(nativeRequests), beforeOverlayRequests, 'rapid presentation changes must not request native pages again');
    passed('Three rapid full/split transitions keep native IDs, bounds, and loaded pages stable');

    const beforeWindowResize = window.getSize();
    window.setSize(beforeWindowResize[0] - 120, beforeWindowResize[1] - 80);
    await sleep(320);
    const boundsAfterWindowResize = await assertViewportBounds(firstView, 'native view after host window resize');
    window.setSize(beforeWindowResize[0], beforeWindowResize[1]);
    await sleep(320);
    const boundsAfterWindowRestore = await assertViewportBounds(firstView, 'native view after host window restores');
    assert.equal(firstView.webContents.id, nativeViewsCreated[0].webContents.id, 'host resize must not replace native WebContents');
    assert.deepEqual(Object.fromEntries(nativeLoadCounts), beforeOverlayLoads, 'host resize must not reload native pages');
    assert.deepEqual(Object.fromEntries(nativeRequests), beforeOverlayRequests, 'host resize must not request native pages again');
    passed('Native viewport follows a host window resize and restores without reloading pages');

    const widthBeforeGesture = state.appSettings.browserWidthPx;
    const releaseDrag = await startDividerGesture('normal release');
    const releaseTargetX = releaseDrag.dividerX + 32;
    moveCapturedPointer(releaseTargetX, releaseDrag.y, releaseDrag.zoom);
    try {
      await waitUntil('captured drag changes transient browser width', async () => {
        const width = await evaluate(`Number(document.querySelector('.browser-resizer')?.getAttribute('aria-valuenow'))`);
        return width > 320 && width < releaseDrag.paneWidth;
      });
    } catch (error) {
      const dragDiagnostic = await evaluate(`JSON.stringify({ workspaceClass: document.querySelector('.browser-workspace')?.className, width: document.querySelector('.browser-resizer')?.getAttribute('aria-valuenow'), paneWidth: document.querySelector('.browser-pane')?.getBoundingClientRect().width, trace: window.__plan009PointerTrace })`);
      console.log(`NATIVE_DRAG_DIAGNOSTIC ${dragDiagnostic}`);
      error.message += `; native drag evidence: ${dragDiagnostic}`;
      throw error;
    }
    releaseCapturedPointer(releaseTargetX, releaseDrag.y, releaseDrag.zoom);
    await waitUntil('normal pointer release commits preferred width', () => state.appSettings.browserWidthPx !== widthBeforeGesture);
    await waitUntil('normal release settles native viewport bounds', async () => Math.abs(firstView.getBounds().width - state.appSettings.browserWidthPx) <= 2);
    const committedWidth = state.appSettings.browserWidthPx;
    const releaseTrace = JSON.parse(await evaluate('JSON.stringify(window.__plan009PointerTrace)'));
    assert.ok(releaseTrace.some((event) => event.type === 'pointermove' && event.buttons > 0 && event.captured), `normal drag must deliver captured held-button moves: ${JSON.stringify(releaseTrace)}`);
    assert.ok(releaseTrace.some((event) => event.type === 'pointerup'), `normal release must end with pointerup: ${JSON.stringify(releaseTrace)}`);
    passed('Native mouse input resizes the browser and pointerup commits its preferred width');

    const cancelDrag = await startDividerGesture('pointer cancel');
    moveCapturedPointer(cancelDrag.dividerX + 22, cancelDrag.y, cancelDrag.zoom);
    await waitUntil('cancel drag has an active captured pointer', async () => evaluate(`document.querySelector('.browser-workspace.is-dragging') && window.__plan009PointerTrace.some((event) => event.type === 'pointermove' && event.captured)`));
    const cancelPointerId = await evaluate(`window.__plan009PointerTrace.findLast((event) => event.type === 'pointerdown')?.pointerId ?? null`);
    assert.equal(typeof cancelPointerId, 'number', 'cancel test must capture the live pointer id');
    await evaluate(`(() => {
      const divider = document.querySelector('.browser-resizer');
      divider.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: ${cancelPointerId}, pointerType: 'mouse', isPrimary: true, buttons: 0, clientX: ${Math.round((cancelDrag.dividerX + 22) * cancelDrag.zoom)}, clientY: ${cancelDrag.y} }));
      return true;
    })()`);
    await waitDom('synthetic pointercancel clears the active browser resize', `!document.querySelector('.browser-workspace.is-dragging')`);
    releaseCapturedPointer(cancelDrag.dividerX + 22, cancelDrag.y, cancelDrag.zoom);
    await waitUntil('cancel restores native split bounds', async () => Math.abs(firstView.getBounds().width - committedWidth) <= 2);
    assert.equal(state.appSettings.browserWidthPx, committedWidth, 'pointercancel must not persist its transient width');
    const cancelTrace = JSON.parse(await evaluate('JSON.stringify(window.__plan009PointerTrace)'));
    assert.ok(cancelTrace.some((event) => event.type === 'pointercancel'), `cancel gesture must dispatch pointercancel: ${JSON.stringify(cancelTrace)}`);
    passed('Captured pointercancel restores the split width without committing transient state');

    const edgeDrag = await startDividerGesture('left-edge snap');
    const edgeX = edgeDrag.workspaceLeft + 5;
    moveCapturedPointer(edgeX, edgeDrag.y, edgeDrag.zoom);
    await waitDom('captured drag snaps to full browser at workspace edge', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
    releaseCapturedPointer(edgeX, edgeDrag.y, edgeDrag.zoom);
    assert.equal(state.appSettings.browserWidthPx, committedWidth, 'full-view edge snap must not persist a full-width pane');
    await sleep(120);
    const edgeFullGeometry = await assertViewportBounds(firstView, 'left-edge full browser');
    passed('Captured leftward pointer crossing the 12px edge zone opens full browser without width persistence');

    await click('button[aria-label="Выйти из режима полного просмотра"]');
    await waitDom('edge-snap returns to split browser', `!document.querySelector('.browser-workspace.is-full') && document.querySelector('.browser-pane')`);
    await waitUntil('edge-snap split restores same page view', () => attached(firstView));

    const originalZoom = window.webContents.getZoomFactor();
    const originalWindowBounds = window.getBounds();
    const display = screen.getDisplayMatching(window.getBounds());
    const zoomBounds = [];
    for (const zoom of [0.8, 1, 1.25]) {
      window.webContents.setZoomFactor(zoom);
      window.setSize(1520, 940);
      await sleep(280);
      const geometry = await assertViewportBounds(firstView, `native split zoom ${zoom}`);
      zoomBounds.push({ zoom, geometry, host: window.getBounds(), native: firstView.getBounds() });
    }
    window.webContents.setZoomFactor(originalZoom);
    window.setSize(originalWindowBounds.width, originalWindowBounds.height);
    await sleep(280);
    await assertViewportBounds(firstView, 'restored native split after zoom checks');
    assert.equal(firstView.webContents.getURL(), restoredPageOne.url, 'window zoom checks must preserve the active native page');
    assert.deepEqual(Object.fromEntries(nativeRequests), requestsAfterTabLoads, 'resize/zoom and workspace surface changes must not reload either native tab');
    passed(`Native view bounds follow viewport at host zoom 80/100/125 percent; display scale is ${display.scaleFactor}`);

    const evidence = {
      fixture: fixturePath,
      userData: await realpath(profile),
      host: { pid: process.pid, title: nativeTitle, bounds: window.getBounds(), contentBounds: window.getContentBounds(), scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor },
      pages: [
        { tabId: firstTab.id, webContentsId: firstView.webContents.id, loadCount: nativeLoadCounts.get(firstView.webContents.id), sessionPartition: 'persist:gigachat-browser', status: status().tabs.find((tab) => tab.id === firstTab.id), historyDiagnostic, beforeHistory: pageOneState, afterHistoryBack: stateAfterHistory, afterRestore: restoredPageOne, beforeDetach: pageOneBeforeDetach, detached: detachedPageOne },
        { tabId: secondTab.id, webContentsId: secondView.webContents.id, loadCount: nativeLoadCounts.get(secondView.webContents.id), status: status().tabs.find((tab) => tab.id === secondTab.id) },
      ],
      requests: Object.fromEntries(nativeRequests),
      boundsCalls: state.browserBoundsCalls,
      nativeLoadCounts: Object.fromEntries(nativeLoadCounts),
      fullBrowserBounds,
      splitBrowserGeometry,
      fullBrowserGeometry,
      restoredSplitBounds,
      boundsAfterLastOverlay,
      boundsAfterWindowResize,
      boundsAfterWindowRestore,
      edgeFullGeometry,
      zoomBounds,
      gesture: { widthBefore: widthBeforeGesture, widthCommitted: committedWidth, releaseTrace, cancelTrace },
      checks: ['split-view', 'two-loopback-tabs', 'restricted-browser-preferences', 'history-back-forward', 'native-header-and-toolbar-bounds', 'full-browser', 'full-chat-detach', 'persistent-composer', 'page-form-scroll-state', 'split-restore', 'native-overlay-detach-last-close-restore', 'three-rapid-full-split-transitions', 'host-window-resize-restore', 'captured-resize-release', 'captured-pointercancel', 'left-edge-full-snap', 'zoom-80-100-125'],
    };
    await writeFile(join(fixturePath, 'native-browser-workspace.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`NATIVE_BROWSER_WORKSPACE_EVIDENCE ${JSON.stringify(evidence)}`);

    if (holdForReview) {
      const workArea = display.workArea;
      const finalWindowWidth = Math.min(1800, workArea.width - 40);
      const finalWindowHeight = Math.min(1000, workArea.height - 40);
      window.webContents.setZoomFactor(1);
      window.setSize(finalWindowWidth, finalWindowHeight);
      window.setPosition(Math.round(workArea.x + (workArea.width - finalWindowWidth) / 2), Math.round(workArea.y + (workArea.height - finalWindowHeight) / 2));
      await sleep(350);
      const finalGeometry = await evaluate(`JSON.stringify((() => { const rect = document.querySelector('.browser-workspace')?.getBoundingClientRect(); const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect(); return { mainWidth: rect?.width ?? null, sidebarWidth: sidebar?.width ?? null }; })())`);
      const ready = { title: nativeTitle, pid: process.pid, fixture: fixturePath, bounds: window.getBounds(), contentBounds: window.getContentBounds(), scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor, layout: JSON.parse(finalGeometry) };
      console.log(`NATIVE_BROWSER_WORKSPACE_READY ${JSON.stringify(ready)}`);
      await new Promise((resolveClosed) => window.once('closed', resolveClosed));
    }

    nativeBrowser.destroy();
    if (nativeServer) await new Promise((resolveClose, rejectClose) => nativeServer.close((error) => error ? rejectClose(error) : resolveClose()));
    process.stdout.write('Plan009 native browser workspace: PASS\n', () => app.exit(0));
  };

  try {
    await app.whenReady();
    console.log('Electron app ready');
    assert.equal(await realpath(app.getPath('userData')), await realpath(profile), 'Electron userData must be the synthetic fixture');
    assert.equal(await realpath(app.getPath('sessionData')), await realpath(sessionData), 'Electron sessionData must remain the synthetic fixture');
    window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 760,
      webPreferences: {
        ...(imageGenerationSmoke ? { offscreen: true } : {}),
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
    if (nativeWorkspaceMode) {
      const { createEmbeddedBrowser } = require(join(fixturePath, 'native', 'embedded-browser.cjs'));
      nativeBrowser = createEmbeddedBrowser(() => window, {
        createSession: (partition) => session.fromPartition(partition),
        createView: (options) => {
          const view = new WebContentsView(options);
          nativeViewsCreated.push(view);
        nativeLoadCounts.set(view.webContents.id, 0);
        view.webContents.on('did-start-loading', () => nativeLoadCounts.set(view.webContents.id, (nativeLoadCounts.get(view.webContents.id) ?? 0) + 1));
          return view;
        },
        persist: async (tabs, activeTabId) => {
          state.appSettings.browserTabs = clone(tabs);
          state.appSettings.browserActiveTabId = activeTabId;
        },
      }, [], null);
      nativeBrowser.onStatus((status) => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('audit:browser', status);
      });
    }
    await window.loadFile(join(bundleDirectory, 'index.html'));
    console.log('Renderer document loaded');
    await waitUntil('initial home draft read is deferred', () => state.pendingHomeDraftGets.length === 1);
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.disabled`), true,
      'home composer stays disabled until its persistent draft is loaded');
    state.pendingHomeDraftGets[0].resolve(clone(state.homeDraft));
    state.deferHomeDraftGet = false;
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

    if (nativeWorkspaceMode) {
      try {
        await runNativeBrowserWorkspace();
      } catch (error) {
        if (holdForReview && window && !window.isDestroyed()) {
          const diagnosticTitle = `Plan009 Native Browser Workspace DIAGNOSTIC PID ${process.pid} ${fixturePath.split(/[\\/]/).at(-1)}`;
          window.setTitle(diagnosticTitle);
          window.show();
          window.focus();
          window.webContents.focus();
          console.error(`NATIVE_BROWSER_WORKSPACE_DIAGNOSTIC_READY ${JSON.stringify({ title: diagnosticTitle, pid: process.pid, fixture: fixturePath, message: error?.message ?? String(error), bounds: window.getBounds(), contentBounds: window.getContentBounds(), scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor, browser: nativeBrowser?.getStatus() ?? null })}`);
          await new Promise((resolveClosed) => window.once('closed', resolveClosed));
          nativeBrowser?.destroy();
          if (nativeServer?.listening) await new Promise((resolveClose) => nativeServer.close(() => resolveClose()));
        }
        throw error;
      }
      return;
    }

    if (imageGenerationSmoke) {
      await runImageGenerationSmoke();
      return;
    }

    if (process.argv.includes('--browser-workspace-async-smoke')) {
      await clickChat('Chat B');
      await waitDom('smoke starts on Chat B', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
      await click('button[aria-label="Показать браузер"]');
      await waitDom('smoke browser opened', `document.querySelector('.browser-header-cell .browser-tab button[title="Synthetic page"]')`);
      await click('button[aria-label="Развернуть на всю рабочую область"]');
      await waitDom('smoke full browser surface', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
      await click('#workspace-chat-tab');
      await waitDom('smoke full chat surface', `document.querySelector('.browser-workspace.is-full.surface-chat')`);

      state.deferBrowserMethod = 'newTab';
      await click('.browser-new-tab');
      await waitUntil('smoke deferred successful new tab', () => state.pendingBrowserActions.length === 1);
      const successfulNewTab = state.pendingBrowserActions[0];
      const firstTab = makeBrowserTab('smoke-success-tab', 'Smoke success', 'https://success.example.test/');
      resolveBrowserAction(successfulNewTab, { ...state.browserStatus, tabs: [...state.browserStatus.tabs, firstTab], activeTabId: firstTab.id });
      await waitDom('smoke successful new tab selects browser', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
      await waitUntil('smoke successful new tab focuses address', () => evaluate(`document.activeElement === document.querySelector('.browser-address input')`));

      await click('#workspace-chat-tab');
      await waitDom('smoke chat surface before pending request', `document.querySelector('.browser-workspace.is-full.surface-chat')`);
      state.deferBrowserMethod = 'newTab';
      await click('.browser-new-tab');
      await waitUntil('smoke deferred stale new tab', () => state.pendingBrowserActions.length === 2);
      const staleNewTab = state.pendingBrowserActions[1];
      await click('#browser-tab-audit-browser-tab');
      await waitDom('smoke switches to browser during pending response', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
      await click('#workspace-chat-tab');
      await waitDom('smoke returns to chat during pending response', `document.querySelector('.browser-workspace.is-full.surface-chat')`);
      assert.equal(await evaluate(`(() => { const tab = document.querySelector('#workspace-chat-tab'); tab?.focus(); return document.activeElement === tab; })()`), true);
      const staleTab = makeBrowserTab('smoke-stale-tab', 'Smoke stale', 'https://stale.example.test/');
      resolveBrowserAction(staleNewTab, { ...state.browserStatus, tabs: [...state.browserStatus.tabs, staleTab], activeTabId: staleTab.id });
      await waitDom('smoke stale success updates status', `document.querySelector('#browser-tab-smoke-stale-tab')`);
      await sleep(80);
      assert.equal(await evaluate(`document.querySelector('.browser-workspace')?.classList.contains('surface-chat')`), true);
      assert.equal(await evaluate(`document.activeElement?.id`), 'workspace-chat-tab');

      state.deferBrowserMethod = 'activateTab';
      await click('#browser-tab-audit-browser-tab-2');
      await waitUntil('smoke deferred activation failure', () => state.pendingBrowserActions.length === 3);
      state.pendingBrowserActions[2].reject(new Error('Synthetic deferred activation failure'));
      await waitDom('smoke failed activation remains accessible on chat', `document.querySelector('.browser-workspace.is-full.surface-chat') && document.querySelector('.browser-surface-error[role="alert"]')`);
      process.stdout.write('Plan009 async browser smoke: PASS\n', () => app.exit(0));
      return;
    }

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
      return initialSidebarToggle.reducedMotion
        ? Math.abs(frame + 5) <= 0.1
        : frame < -0.1 && frame > -5;
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

    if (skipSidebarPointerCapture) {
      console.log('SKIPPED (not counted): synthetic sidebar pointer-capture drag/pointercancel gate (--skip-sidebar-pointer-capture).');
    } else {
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
    }

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
    await clickText('.sidebar-actions button', 'Новый чат');
    const closeHomeSaveStart = state.pendingHomeDraftSaves.length;
    state.deferHomeDraftSaves = true;
    await fillTextarea(draftSelector, 'close waits for accepted home draft');
    await waitUntil('home draft save before close', () => state.pendingHomeDraftSaves.length === closeHomeSaveStart + 1);
    const closePendingDraftSave = state.pendingHomeDraftSaves[closeHomeSaveStart];
    const closeAttempt = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('pending close dialog', `document.querySelector('.close-pending-dialog')?.open === true`);
    await capture('close-pending-home-draft-save');
    window.webContents.send('audit:permission', {
      id: 'approval-during-close', resource: 'project-files', action: 'read', target: 'synthetic file',
      reason: 'Synthetic close-barrier approval request.', expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await sleep(120);
    assert.equal(await evaluate(`document.querySelector('.close-pending-dialog')?.open === true`), true,
      'a late permission approval must not cover the close-pending modal');
    assert.equal(await evaluate(`document.querySelector('.approval-dialog')?.open === true`), false);
    assert.equal(state.closeReadyCalls, 0, 'renderer must finish the home draft save before main close-ready');
    const createsBeforeBlockedInput = state.createCalls.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    assert.equal(state.createCalls.length, createsBeforeBlockedInput, 'frozen close must block new background actions');
    resolveHomeDraftSave(closePendingDraftSave);
    await waitUntil('close-ready after accepted home draft settles', () => state.closeReadyCalls === 1);
    assert.equal((await closeAttempt).status, 'failed');
    assert.equal(state.homeDraft.text, 'close waits for accepted home draft');
    await waitDom('close failure dialog after home draft save', `document.querySelector('.close-error-dialog')?.open === true`);
    await capture('close-error-home-draft-save');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('renderer resumes after close failure', async () => state.closeReturnCalls === 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    await waitDom('deferred approval becomes available after return', `document.querySelector('.approval-dialog')?.open === true`);
    await clickText('.approval-dialog button', 'Отклонить');
    await waitUntil('synthetic deferred approval is rejected', () => state.permissionResponses.some((response) => response.id === 'approval-during-close' && response.allowed === false));
    state.deferHomeDraftSaves = false;
    passed('Rendered close waits for the persistent home draft save without creating a chat');

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
      id: 'turn-a-completed', chatId: 'chat-a', status: 'completed', createdAt: timestamp,
      startedAt: timestamp, endedAt: new Date(Date.parse(timestamp) + 900).toISOString(), activity: [],
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

    const runtimeUserAnchor = { id: 'chat-a-runtime-user', role: 'user', text: '  Synthetic question\nkept exactly.  ', createdAt: timestamp };
    const otherChatUserAnchor = { id: 'chat-b-runtime-user', role: 'user', text: 'Запрос второго чата.', createdAt: timestamp };
    state.details.get('chat-a').messages.push({
      id: 'chat-a-pre-api-example', role: 'assistant', text: 'Исторический пример до появления источника ответа.', createdAt: timestamp,
    });
    state.details.get('chat-a').messages.push(runtimeUserAnchor);
    state.details.get('chat-b').messages.push(otherChatUserAnchor);

    state.details.get('chat-a').artifacts = [
      { id: 'local-pdf', name: 'local.pdf', storedName: 'local.pdf', size: 1024, createdAt: timestamp, messageId: null },
      { id: 'local-xlsx', name: 'local.xlsx', storedName: 'local.xlsx', size: 2048, createdAt: timestamp, messageId: null },
      { id: 'local-md', name: 'local.md', storedName: 'local.md', size: 512, createdAt: timestamp, messageId: null },
    ];
    await clickChat('Chat B');
    await waitDom('Chat B loads the accepted user anchor before runtime activity', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'
      && document.querySelector('[data-message-id="chat-b-runtime-user"]')?.textContent.includes('Запрос второго чата.')`);
    await clickChat('Chat A');
    await waitDom('Chat A reloads its accepted anchor and legacy attachments before runtime activity', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'
      && document.querySelector('[data-message-id="chat-a-runtime-user"]')?.textContent.includes('Synthetic question')
      && document.querySelector('.chat-files')?.textContent.includes('local.md')`);
    const importCountBeforeLocalAttachmentRender = state.importCalls.length;
    const queuedTurn = {
      id: 'turn-a-retryable', chatId: 'chat-a', status: 'queued', createdAt: timestamp, activity: [],
      anchorMessageId: runtimeUserAnchor.id, assistantMessageId: 'assistant-turn-a-retryable', queueDurationMs: 850,
    };
    state.runtimeTurns.set('chat-a', [queuedTurn]);
    window.webContents.send('audit:runtime', queuedTurn);
    await waitDom('queued runtime action stays beside its accepted user message', `document.querySelector('.turn-activity-summary')?.textContent.includes('В очереди')
      && document.querySelector('.runtime-cancel')?.textContent.includes('Убрать из очереди')`);
    const runningTurn = {
      ...queuedTurn, status: 'running', startedAt: timestamp, draft: 'Текст поступает частями.', activeDurationMs: 900,
    };
    state.runtimeTurns.set('chat-a', [runningTurn]);
    window.webContents.send('audit:runtime', runningTurn);
    await waitDom('running partial draft and stop action', `document.querySelector('.turn-activity-summary')?.textContent.includes('Выполняется')
      && document.querySelector('.transcript-draft')?.textContent.includes('Текст поступает частями')
      && document.querySelector('.runtime-cancel')?.textContent === 'Остановить'`);
    const otherChatQueuedTurn = { ...queuedTurn, id: 'turn-b-queued', chatId: 'chat-b', anchorMessageId: otherChatUserAnchor.id, assistantMessageId: 'assistant-turn-b-queued' };
    state.runtimeTurns.set('chat-b', [otherChatQueuedTurn]);
    await clickChat('Chat B');
    await waitDom('second chat shows its queued turn while the first chat is active', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'
      && document.querySelector('.turn-activity-summary')?.textContent.includes('В очереди')
      && document.querySelector('.runtime-cancel')?.textContent.includes('Убрать из очереди')`);
    await clickChat('Chat A');
    await waitDom('active chat retains its running turn after switching back', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'
      && document.querySelector('.turn-activity-summary')?.textContent.includes('Выполняется')`);
    await click('.runtime-cancel');
    await waitUntil('Stop invokes runtime cancel for the active chat turn', () => state.runtimeCancelCalls.length === 1);
    assert.deepEqual(state.runtimeCancelCalls[0], { chatId: 'chat-a', turnId: runningTurn.id });
    state.details.get('chat-a').messages.push({ id: 'chat-a-cancel-user', role: 'user', text: 'Остановить этот запрос.', createdAt: timestamp });
    const failedTurn = {
      ...runningTurn, status: 'failed', error: 'Synthetic network failure', errorCategory: 'network', retryEligible: true,
      modelId: 'GigaChat-3-Ultra',
      anchorMessageId: runtimeUserAnchor.id,
      draft: 'Частичный ответ остаётся незавершённым.', activeDurationMs: 4200,
      endedAt: new Date(Date.parse(timestamp) + 4200).toISOString(),
    };
    state.runtimeTurns.set('chat-a', [failedTurn]);
    window.webContents.send('audit:runtime', failedTurn);
    await waitDom('local attachment disclosure and collapsed failed activity', `
      document.querySelector('.chat-files')?.textContent.includes('старое вложение, не отправлялось модели')
      && document.querySelector('.chat-files')?.textContent.includes('local.md')
      && document.querySelector('.chat-files')?.textContent.includes('Формат указан в API')
      && document.querySelector('.chat-files')?.textContent.includes('не подтверждён API')
      && document.querySelector('.turn-activity-details')?.open === false
      && document.querySelector('.turn-activity-summary')?.textContent.includes('Сеть')
      && document.querySelector('.runtime-retry')?.disabled
      && document.querySelector('.runtime-retry-hint')?.textContent.includes('Подключите API')`);
    assert.equal(state.retryCalls.length, 0, 'known-unavailable model registry must block renderer retry IPC');
    await clickText('.turn-activity-summary', 'Не удалось завершить');
    await waitDom('expanded failed timeline draft', `document.querySelector('.turn-activity-details')?.open === true
      && document.querySelector('.turn-activity-error')?.textContent.includes('Synthetic network failure')
      && document.querySelectorAll('.transcript-draft').length === 1
      && document.querySelector('.transcript-draft')?.textContent.includes('Частичный ответ остаётся незавершённым.')
      && document.querySelector('.transcript-draft')?.textContent.includes('Ответ не сохранён как готовое сообщение.')`);
    await capture('plan010-runtime-timeline-attachments');
    const copyCallsBefore = state.copyMessageCalls.length;
    await evaluate(`document.querySelector('[data-message-id="chat-a-runtime-user"] .transcript-copy').click()`);
    await waitUntil('copy reaches the narrow stored-message IPC', () => state.copyMessageCalls.length === copyCallsBefore + 1);
    assert.deepEqual(state.copyMessageCalls.at(-1), { id: 'chat-a', messageId: runtimeUserAnchor.id });
    state.rejectNextCopyMessage = true;
    await evaluate(`document.querySelector('[data-message-id="chat-a-runtime-user"] .transcript-copy').click()`);
    await waitDom('clipboard failure stays visible beside its source message', `document.querySelector('[data-message-id="chat-a-runtime-user"] .transcript-copy-error')?.textContent.includes('Не удалось скопировать')`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    await evaluate(`document.activeElement?.blur()`);
    const copyFailureLayout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const message = document.querySelector('[data-message-id="chat-a-runtime-user"]');
      const meta = message?.querySelector('.transcript-message-meta');
      const time = meta?.querySelector('time');
      const copy = meta?.querySelector('.transcript-copy');
      const error = meta?.querySelector('.transcript-copy-error');
      const box = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect ? { top: rect.top, width: rect.width } : null;
      };
      return {
        hoverNone: matchMedia('(hover: none)').matches,
        timeOpacity: time ? getComputedStyle(time).opacity : null,
        copyOpacity: copy ? getComputedStyle(copy).opacity : null,
        errorVisible: Boolean(error && getComputedStyle(error).display !== 'none' && getComputedStyle(error).visibility === 'visible' && getComputedStyle(error).opacity === '1'),
        meta: box(meta), error: box(error), metaClientWidth: meta?.clientWidth, metaScrollWidth: meta?.scrollWidth,
      };
    })())`));
    assert.equal(copyFailureLayout.errorVisible, true, 'copy error remains visible after hover and focus leave the message');
    assert.ok(copyFailureLayout.error && copyFailureLayout.meta && copyFailureLayout.error.top >= copyFailureLayout.meta.top,
      'copy error occupies its own metadata row');
    assert.ok(copyFailureLayout.metaScrollWidth <= copyFailureLayout.metaClientWidth + 1,
      'copy failure does not overflow the short user-message metadata row');
    assert.equal(copyFailureLayout.timeOpacity, copyFailureLayout.hoverNone ? '1' : '0', 'timestamp visibility follows pointer/touch state');
    assert.equal(copyFailureLayout.copyOpacity, copyFailureLayout.hoverNone ? '1' : '0', 'copy visibility follows pointer/touch state');
    state.keyStatus = { available: true, saved: true, usable: true };
    await clickText('.runtime-reconnect', 'Проверить подключение');
    await waitDom('connection status before retry', `document.querySelector('.connection-result')?.textContent.includes('Не подключено — запросы к модели недоступны')`);
    state.nextConnectionFailure = { state: 'error', errorCategory: 'auth', failedStep: 'oauth', httpStatus: 400 };
    await clickText('.connection-setup button', 'Проверить подключение');
    await waitDom('OAuth rejection clearly says that chat is unavailable', `document.querySelector('.connection-result[data-state="error"]')?.textContent.includes('Не подключено — запросы к модели недоступны')
      && document.querySelector('.connection-result')?.textContent.includes('Авторизация (HTTP 400)')
      && !document.querySelector('.connection-result')?.textContent.includes('неподдерживаемом формате')`);
    await capture('connect-error-oauth-400');
    await clickText('.connection-setup button', 'Проверить подключение');
    await waitDom('synthetic API reconnect before retry', `document.querySelector('.connection-result[data-state="connected"]')?.textContent.includes('Подключено — можно перейти в чат')
      && !document.querySelector('.connection-result')?.textContent.includes('HTTP 400')`);
    await capture('connect-ready');
    assert.deepEqual(state.connectionCalls, ['connect', 'connect'], 'retry recovery uses the existing Connect flow');
    passed('Connection status separates saved key, rejected OAuth, and ready chat without stale HTTP errors');
    await clickText('.settings-nav-item', 'Модели и лимиты');
    const rawModels = [
      'GigaChat-3-Ultra', 'GigaChat-2-Max', 'GigaChat-3-Pro', 'GigaChat-3-Lightning',
      'GigaChat-2', 'GigaChat-2-Pro', 'Embeddings', 'Embeddings-2', 'EmbeddingsGigaR', 'GigaEmbeddings-3B-2025-09',
    ];
    state.modelRegistry = {
      state: 'ready',
      modelIds: rawModels,
      errorCategory: null,
    };
    await clickText('.connection-card button', 'Обновить список');
    await waitDom('connected model registry enables retry', `document.querySelector('.connection-card .status-pill')?.textContent.includes('Список загружен')`);
    assert.ok(state.modelRegistryCalls.includes('refresh'), 'renderer must refresh the actual model registry before retry');
    await clickText('.model-settings-list .permission-profile-selectable', 'GigaChat Ultra');
    await waitUntil('verified current model is saved for the next turn', () => state.appSettings.defaultModelId === 'GigaChat-3-Ultra');
    await capture('plan010-connected-model-registry');
    await click('button[aria-label="Назад"]');
    await waitDom('return to the original chat after registry refresh', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
    await waitDom('original failed turn retry after registry refresh', `document.querySelector('.runtime-retry') && !document.querySelector('.runtime-retry').disabled`);
    const appendCountBeforeRetry = state.appendCalls.length;
    await evaluate(`(() => { const button = document.querySelector('.runtime-retry'); button.click(); button.click(); })()`);
    await waitUntil('one retry IPC after a double click', () => state.retryCalls.length === 1);
    assert.deepEqual(state.retryCalls[0], { chatId: 'chat-a', turnId: failedTurn.id });
    assert.equal(state.appendCalls.length, appendCountBeforeRetry, 'retry must not append a second user record');
    assert.equal(state.details.get('chat-a').messages.filter((message) => message.id === runtimeUserAnchor.id).length, 1,
      'synthetic renderer retry keeps the original user message exactly once');
    assert.equal(state.importCalls.length, importCountBeforeLocalAttachmentRender, 'rendering stored files does not start a transfer or import');
    const settledFailure = { ...failedTurn, retryEligible: false };
    const completedRetry = {
      id: 'turn-a-retry-completed', chatId: 'chat-a', anchorMessageId: runtimeUserAnchor.id,
      assistantMessageId: failedTurn.assistantMessageId, status: 'completed', createdAt: new Date(Date.parse(timestamp) + 1000).toISOString(),
      startedAt: new Date(Date.parse(timestamp) + 1100).toISOString(), endedAt: new Date(Date.parse(timestamp) + 3900).toISOString(),
      activity: [], queueDurationMs: 100, activeDurationMs: 2800,
    };
    const cancelledTurn = {
      id: 'turn-a-cancelled', chatId: 'chat-a', anchorMessageId: 'chat-a-cancel-user',
      assistantMessageId: 'assistant-turn-a-cancelled', status: 'cancelled', createdAt: timestamp,
      startedAt: timestamp, endedAt: new Date(Date.parse(timestamp) + 700).toISOString(),
      activity: [], errorCategory: 'cancel', draft: 'Остановленный черновик.', activeDurationMs: 700,
    };
    state.details.get('chat-a').messages.push({
      id: failedTurn.assistantMessageId, role: 'assistant', source: 'runtime', text: 'Ответ после повторного запуска.', createdAt: timestamp,
    });
    state.runtimeTurns.set('chat-a', [settledFailure, completedRetry, cancelledTurn]);
    window.webContents.send('audit:runtime', settledFailure);
    window.webContents.send('audit:runtime', completedRetry);
    window.webContents.send('audit:runtime', cancelledTurn);
    await waitDom('completed and cancelled turns hide the old retry action', `document.querySelectorAll('.runtime-retry').length === 0
      && [...document.querySelectorAll('.turn-activity-summary')].some((summary) => summary.textContent.includes('Выполнено за'))
      && [...document.querySelectorAll('.turn-activity-summary')].some((summary) => summary.textContent.includes('Остановлено'))
      && [...document.querySelectorAll('.transcript-message')].filter((message) => message.textContent.includes('Ответ после повторного запуска.')).length === 1
      && document.querySelector('[data-message-id="chat-a-pre-api-example"] .transcript-example-label')?.textContent === 'Пример'
      && !document.querySelector('[data-message-id="${failedTurn.assistantMessageId}"] .transcript-example-label')`);
    assert.equal(await evaluate(`document.querySelector('[data-message-id="chat-a-pre-api-example"] .transcript-example-label')?.textContent`),
      'Пример', 'legacy assistant text with no source keeps its example marker');
    assert.equal(await evaluate(`document.querySelector('[data-message-id="${failedTurn.assistantMessageId}"] .transcript-example-label')`),
      null, 'runtime assistant answers are not labeled as examples');
    const retryActivityPosition = await evaluate(`(() => {
      const activity = document.querySelector('[data-turn-id="turn-a-retry-completed"]');
      const answer = document.querySelector('[data-message-id="${failedTurn.assistantMessageId}"]');
      return Boolean(activity && answer && (activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`);
    assert.equal(retryActivityPosition, true, 'the successful retry activity appears immediately before its reserved answer');
    await capture('stage4-linked-retry-transcript');

    const transcriptOriginalSize = window.getSize();
    const transcriptOriginalZoom = window.webContents.getZoomFactor();
    const transcriptViewportCases = [
      { width: 960, height: 720, zoom: 0.8, label: '960x720-80' },
      { width: 560, height: 480, zoom: 1, label: '560x480' },
      { width: 1520, height: 940, zoom: 1, label: 'wide' },
      { width: 960, height: 720, zoom: 1.25, label: '960x720-125' },
      { width: 960, height: 720, zoom: 1.5, label: '960x720-150' },
    ];
    const transcriptViewportMeasurements = [];
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    for (const viewport of transcriptViewportCases) {
      window.setSize(viewport.width, viewport.height);
      window.webContents.setZoomFactor(viewport.zoom);
      await sleep(320);
      const measured = JSON.parse(await evaluate(`JSON.stringify((() => {
        const chat = document.querySelector('.chat-view');
        const history = document.querySelector('.chat-history');
        const user = document.querySelector('[data-message-id="chat-a-runtime-user"]');
        const bubble = user?.querySelector('.transcript-bubble');
        const meta = user?.querySelector('.transcript-message-meta');
        const assistant = document.querySelector('.transcript-message.message-assistant');
        const box = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        };
        return {
          chat: box(chat), history: box(history), historyClientWidth: history?.clientWidth, historyScrollWidth: history?.scrollWidth,
          user: box(user), bubble: box(bubble), meta: box(meta), assistant: box(assistant),
          userTextSelection: bubble ? getComputedStyle(bubble.querySelector('p')).userSelect : null,
          hoverNone: matchMedia('(hover: none)').matches,
          timeOpacity: user?.querySelector('.transcript-message-meta time') ? getComputedStyle(user.querySelector('.transcript-message-meta time')).opacity : null,
          copyOpacity: user?.querySelector('.transcript-copy') ? getComputedStyle(user.querySelector('.transcript-copy')).opacity : null,
        };
      })())`));
      assert.ok(measured.chat && measured.history && measured.user && measured.bubble && measured.meta && measured.assistant,
        `${viewport.label}: all transcript regions are rendered`);
      assert.ok(measured.historyScrollWidth <= measured.historyClientWidth + 1,
        `${viewport.label}: transcript has no horizontal overflow`);
      assert.ok(measured.user.left >= measured.chat.left - 1 && measured.user.right <= measured.chat.right + 1,
        `${viewport.label}: user bubble stays inside the chat column`);
      assert.ok(Math.abs(measured.user.right - measured.bubble.right) <= 1,
        `${viewport.label}: short user bubble stays right-aligned inside its metadata row`);
      assert.ok(measured.meta.top >= measured.bubble.bottom - 1,
        `${viewport.label}: timestamp and copy controls stay below the user bubble`);
      assert.ok(measured.assistant.width >= measured.history.width - 2,
        `${viewport.label}: assistant answer uses the transcript width`);
      assert.equal(measured.userTextSelection, 'text', `${viewport.label}: message text remains selectable`);
      assert.equal(measured.timeOpacity, measured.hoverNone ? '1' : '0', `${viewport.label}: timestamp stays hidden at rest or remains available for touch`);
      assert.equal(measured.copyOpacity, measured.hoverNone ? '1' : '0', `${viewport.label}: copy stays hidden at rest or remains available for touch`);
      transcriptViewportMeasurements.push({ ...viewport, ...measured });
      if (viewport.label === '960x720-80' || viewport.label === '560x480' || viewport.label === 'wide') {
        await capture(`stage4-transcript-${viewport.label}`);
      }
    }
    console.log(`Transcript viewport matrix ${JSON.stringify(transcriptViewportMeasurements.map(({ label, zoom, chat, historyScrollWidth, historyClientWidth, user, bubble }) => ({ label, zoom, chatWidth: chat.width, historyScrollWidth, historyClientWidth, userWidth: user.width, bubbleWidth: bubble.width })))}`);
    await evaluate(`document.querySelector('[data-message-id="chat-a-runtime-user"] .transcript-copy').focus()`);
    await waitDom('keyboard focus reveals timestamp and copy together', `(() => {
      const message = document.querySelector('[data-message-id="chat-a-runtime-user"]');
      const time = message?.querySelector('.transcript-message-meta time');
      const copy = message?.querySelector('.transcript-copy');
      return message?.matches(':focus-within') && Number(getComputedStyle(time).opacity) > 0 && Number(getComputedStyle(copy).opacity) > 0;
    })()`);
    await evaluate(`document.activeElement?.blur()`);
    window.setSize(transcriptOriginalSize[0], transcriptOriginalSize[1]);
    window.webContents.setZoomFactor(transcriptOriginalZoom);
    await sleep(220);

    const registryReadsBeforePicker = state.modelRegistryCalls.filter((method) => method === 'getRegistry').length;
    await click('button[aria-label="Выбрать модель GigaChat"]');
    await waitDom('current model picker is open before background quota event', `document.querySelector('.model-picker-popup .model-picker-option[aria-current="true"]')`);
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.model-picker-option strong')].map((item) => item.textContent.trim()))`)),
      ['GigaChat Ultra', 'GigaChat Max', 'GigaChat Pro', 'GigaChat Lite'],
      'the rendered picker exposes exactly the four site names even when raw discovery includes legacy and embedding IDs');
    await capture('stage1-four-family-model-picker');
    await waitUntil('opening the model picker loads its current registry', () =>
      state.modelRegistryCalls.filter((method) => method === 'getRegistry').length > registryReadsBeforePicker);
    const registryReadsBeforeBackgroundQuota = state.modelRegistryCalls.filter((method) => method === 'getRegistry').length;
    const refreshesBeforeBackgroundQuota = state.modelRegistryCalls.filter((method) => method === 'refresh').length;
    state.modelRegistry = { ...state.modelRegistry, exhaustedModelIds: ['GigaChat-3-Ultra'] };
    state.details.get('chat-b').messages.push({ id: 'chat-b-quota-user', role: 'user', text: 'Запрос с исчерпанной квотой.', createdAt: timestamp });
    window.webContents.send('audit:runtime', {
      id: 'turn-b-quota', chatId: 'chat-b', anchorMessageId: 'chat-b-quota-user', assistantMessageId: 'assistant-turn-b-quota', status: 'failed', createdAt: timestamp,
      startedAt: timestamp, endedAt: new Date(Date.parse(timestamp) + 1000).toISOString(), activity: [],
      errorCategory: 'quota', error: 'Synthetic HTTP 402',
    });
    await waitUntil('background chat quota invalidates the shared model registry', () =>
      state.modelRegistryCalls.filter((method) => method === 'getRegistry').length === registryReadsBeforeBackgroundQuota + 1);
    await waitDom('background quota disables the exact selected model in the current picker', `
      document.querySelector('.model-picker-popup .model-picker-option[aria-current="true"]')?.disabled === true
      && document.querySelector('.model-picker-popup .model-picker-option[aria-current="true"]')?.textContent.includes('Пул этой модели исчерпан')`);
    assert.equal(state.appSettings.defaultModelId, 'GigaChat-3-Ultra', 'quota does not silently replace the saved current model');
    assert.equal(state.modelRegistryCalls.filter((method) => method === 'refresh').length, refreshesBeforeBackgroundQuota,
      'a runtime quota event reads the current registry without another /models generation request');
    assert.deepEqual(state.modelRegistry.modelIds, rawModels,
      'quota overlay leaves raw discovery intact');
    await capture('stage1-exhausted-model-pool');
    passed('Background-chat quota updates the current picker without fallback or another model request');
    await sendKey('ESC');
    state.details.get('chat-b').modelId = 'GigaChat-2-Pro';
    await clickChat('Chat B');
    await waitDom('legacy-model chat is loaded for next-selection migration', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    await click('button[aria-label="Выбрать модель GigaChat"]');
    await waitDom('legacy model warning is visible in the composer picker', `document.querySelector('.model-picker-popup .settings-card[role="status"]')?.textContent.includes('Для следующих ходов можно перейти на GigaChat Pro')`);
    assert.equal(state.details.get('chat-b').modelId, 'GigaChat-2-Pro', 'opening the picker does not rewrite the saved legacy chat model');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.model-picker-option strong')].map((item) => item.textContent.trim()))`)),
      ['GigaChat Ultra', 'GigaChat Max', 'GigaChat Pro', 'GigaChat Lite'],
      'legacy warning does not add the old ID as a picker option');
    await capture('stage1-legacy-model-warning');
    await sendKey('ESC');
    await clickChat('Chat A');
    await waitDom('return to Chat A after legacy model preview', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
    assert.equal(await evaluate(`document.querySelector('.context-indicator')?.getAttribute('aria-label')`), 'Размер контекста неизвестен');
    const historyBeforeCompact = state.details.get('chat-a').messages.length;
    const appendsBeforeCompact = state.appendCalls.length;
    await fillTextarea(draftSelector, '/compact');
    await click('.send-button-wrap .send-button');
    await waitDom('unverified compaction remains unavailable', `document.querySelector('.notice')?.textContent.includes('/compact выключена')`);
    assert.equal(state.details.get('chat-a').messages.length, historyBeforeCompact, 'unavailable compaction must leave visible history unchanged');
    assert.equal(state.appendCalls.length, appendsBeforeCompact, 'unavailable compaction must not save a new user turn');
    const draftUpdatesBeforeClear = state.updateCalls.length;
    await fillTextarea(draftSelector, '');
    await waitUntil('compact command text is cleared from the local draft', () => state.updateCalls.slice(draftUpdatesBeforeClear).some((item) => item.id === 'chat-a' && item.patch.draft === ''));
    await click('button[aria-label="Закрыть уведомление"]');
    await waitDom('compaction notice is dismissed before profile captures', `!document.querySelector('.notice')`);
    const profileOriginalSize = window.getSize();
    const profileOriginalZoom = window.webContents.getZoomFactor();
    window.setSize(1280, 900);
    window.webContents.setZoomFactor(1);
    await waitDom('wide profile viewport is ready', `innerWidth >= 1200 && innerHeight >= 800`);
    state.connectionStatus = { state: 'connected', errorCategory: null };
    state.profileView = clone(state.profileFixtures.empty);
    state.usageLedger = clone(state.profileFixtures.emptyLedger);

    state.deferProfileGets = true;
    const profileGetsBeforeLateRoute = state.profileViewCalls;
    const pendingProfileReadsBeforeLateRoute = state.pendingProfileGets.length;
    await click('.profile-button');
    await waitDom('profile reports its loading state', `document.querySelector('.profile-page[aria-busy="true"] .profile-loading')`);
    await waitUntil('profile read is pending before route change', () => state.pendingProfileGets.length === pendingProfileReadsBeforeLateRoute + 1);
    await click('button[aria-label="Назад"]');
    await waitDom('late profile read route returns to Chat A', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
    state.deferProfileGets = false;
    state.pendingProfileGets[pendingProfileReadsBeforeLateRoute].resolve(clone(state.profileFixtures.rich));
    await waitUntil('late profile read is ignored after route change', () => evaluate(`!document.querySelector('.profile-page')
      && document.querySelector('.chat-header-title')?.textContent === 'Chat A'`));
    assert.equal(state.profileViewCalls, profileGetsBeforeLateRoute + 1, 'late-route test performs exactly one profile read');

    await click('.profile-button');
    await waitDom('empty profile keeps missing usage and balances unknown', `document.querySelector('.profile-page h1')?.textContent === 'Профиль'
      && document.querySelector('.profile-balance-empty strong')?.textContent === 'Остаток неизвестен'
      && document.querySelector('.profile-chart-empty')?.textContent.includes('Пока нет измеренных вызовов API.')`);
    assert.equal(state.usageLedger.requestCount, 0, 'synthetic renderer fixture has no usage receipts');
    assert.equal(await evaluate(`document.querySelectorAll('.profile-balance-card').length`), 4,
      'empty profile still presents all four families without inventing an allocation');
    assert.equal(await evaluate(`document.querySelector('.profile-metric-primary strong')?.textContent.trim()`), '0',
      'known empty history is shown as zero rather than an unknown estimate');
    await capture('stage6-profile-empty');

    state.rejectNextProfileRefresh = true;
    const profileRefreshBeforeError = state.profileRefreshCalls;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('balance failure is translated to safe Russian copy', `document.querySelector('.profile-balance-section [role="alert"]')?.textContent.includes('Не удалось связаться с сервером')`);
    assert.equal(state.profileRefreshCalls, profileRefreshBeforeError + 1, 'refresh failure uses exactly one existing IPC request');
    const profileErrorText = await evaluate(`document.querySelector('.profile-balance-section [role="alert"]')?.textContent ?? ''`);
    assert.ok(!/GigaChatProviderError|network|auth|HTTP/i.test(profileErrorText), 'provider names and transport details are not shown in the UI');
    state.nextProfileRefreshView = state.profileFixtures.rich;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('profile refresh shows independently known usage', `document.querySelector('.profile-metric-primary strong')?.textContent.replace(/\\D/g, '') === '2005199'
      && document.querySelectorAll('.profile-balance-card').length === 4`);
    assert.equal(await evaluate(`document.querySelectorAll('.profile-heat-cell').length`), 366,
      'the leap-year profile renders every day in its rolling year');
    assert.equal(await evaluate(`document.querySelectorAll('.profile-balance-status').length`), 4,
      'the API snapshot is rendered separately from the four family estimates');
    assert.ok((await evaluate(`document.querySelector('.profile-balance-section')?.textContent ?? ''`)).includes('Срок API не сообщает'),
      'the UI does not invent an API expiry');
    const richProfileText = await evaluate(`document.querySelector('.profile-page')?.textContent ?? ''`);
    assert.ok(richProfileText.includes('Сохранённый учебный чат') && richProfileText.includes('Установлено Skills')
      && richProfileText.includes('Вызовы инструментов'), 'the profile includes archived-chat, Skill, and saved tool receipt measurements');
    assert.equal(await evaluate(`document.querySelectorAll('.profile-metric')[1]?.querySelector('strong')?.textContent.replace(/\\D/g, '')`), '5',
      'API request count includes the synthetic continuation and compaction receipts');
    await capture('stage6-profile-rich-api');

    state.nextProfileRefreshView = state.profileFixtures.ordinaryYear;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('ordinary-year profile updates without retaining leap-day count', `document.querySelectorAll('.profile-heat-cell').length === 365`);
    state.nextProfileRefreshView = state.profileFixtures.rich;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('rich profile returns to its leap-year days', `document.querySelectorAll('.profile-heat-cell').length === 366`);

    const moveProfilePointer = async (selector) => {
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      assert.ok(point, `profile pointer target exists: ${selector}`);
      const zoom = window.webContents.getZoomFactor();
      window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) });
    };
    const heatASelector = '.profile-heat-cell[aria-label^="27 февраля 2024"]';
    const heatBSelector = '.profile-heat-cell[aria-label^="28 февраля 2024"]';
    await evaluate(`(() => {
      const cell = document.querySelector(${JSON.stringify(heatASelector)});
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      cell?.focus();
    })()`);
    await waitDom('keyboard focus previews its own calendar day', `document.activeElement?.matches(${JSON.stringify(heatASelector)})
      && document.querySelector('.profile-heat-detail')?.textContent.includes('27 февраля 2024')`);
    const focusedHeatBeforeHover = JSON.parse(await evaluate(`JSON.stringify((() => {
      const a = document.querySelector(${JSON.stringify(heatASelector)});
      const b = document.querySelector(${JSON.stringify(heatBSelector)});
      return { active: document.activeElement === a, aTabIndex: a?.tabIndex, bTabIndex: b?.tabIndex,
        detail: document.querySelector('.profile-heat-detail')?.textContent ?? '' };
    })())`));
    assert.equal(focusedHeatBeforeHover.active, true, 'keyboard focus stays on the first calendar day');
    assert.equal(focusedHeatBeforeHover.aTabIndex, 0, 'focused calendar cell remains the roving tab stop');
    assert.equal(focusedHeatBeforeHover.bTabIndex, -1, 'the neighboring cell does not take the roving tab stop');
    assert.ok(focusedHeatBeforeHover.detail.includes('GigaChat Ultra 0'), 'the focused date exposes its confirmed zero separately');
    await moveProfilePointer(heatBSelector);
    await waitDom('pointer hover previews a different day without moving keyboard focus', `document.querySelector('.profile-heat-detail')?.textContent.includes('28 февраля 2024')
      && document.querySelector('.profile-heat-detail')?.textContent.includes('GigaChat Pro Неизвестно')`);
    const hoveredHeat = JSON.parse(await evaluate(`JSON.stringify((() => {
      const a = document.querySelector(${JSON.stringify(heatASelector)});
      const b = document.querySelector(${JSON.stringify(heatBSelector)});
      return { active: document.activeElement === a, aTabIndex: a?.tabIndex, bTabIndex: b?.tabIndex };
    })())`));
    assert.deepEqual(hoveredHeat, { active: true, aTabIndex: 0, bTabIndex: -1 },
      'hovering another day changes only the preview, not focus or keyboard navigation');
    await capture('stage6-profile-calendar-hover-priority');
    await moveProfilePointer('.profile-heading h1');
    await waitDom('pointer leaving the calendar restores the focused day preview', `document.querySelector('.profile-heat-detail')?.textContent.includes('27 февраля 2024')
      && document.activeElement?.matches(${JSON.stringify(heatASelector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(heatASelector)})?.blur()`);
    await waitDom('blur clears the calendar preview without leaving a ghost selection', `document.querySelector('.profile-heat-detail')?.getAttribute('aria-hidden') === 'true'
      && !document.querySelector('.profile-heat-detail')?.textContent.includes('27 февраля 2024')`);
    await capture('stage6-profile-rich-calendar-focus');

    state.nextProfileRefreshView = state.profileFixtures.unknownFamilyTail;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('unmapped usage makes all family estimates unknown', `document.querySelector('.profile-balance-grid')?.textContent.includes('Неизвестно')
      && document.querySelector('.profile-uncertainty')`);
    const unknownDaySelector = '.profile-heat-cell[aria-label^="2 марта 2024"]';
    await evaluate(`document.querySelector(${JSON.stringify(unknownDaySelector)})?.focus()`);
    await waitDom('calendar identifies unknown model spend without assigning it to a family', `document.querySelector('.profile-heat-detail')?.textContent.includes('GigaChat Lite Неизвестно')
      && document.querySelector('.profile-heat-detail span')?.textContent.replace(/\\D/g, '') === '777777'
      && document.querySelector(${JSON.stringify(unknownDaySelector)})?.getAttribute('aria-label').replace(/\\D/g, '').includes('777777')`);
    await capture('stage6-profile-calendar-unmapped-day');
    await evaluate(`document.activeElement?.blur()`);

    state.nextProfileRefreshView = state.profileFixtures.partialLite;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('partial Lite expense is not displayed as a numeric remaining estimate', `(() => {
      const lite = [...document.querySelectorAll('.profile-balance-card')].find((card) => card.textContent.includes('GigaChat Lite'));
      return lite?.querySelector('.profile-balance-value')?.textContent === 'Неизвестно'
        && [...document.querySelectorAll('.profile-balance-card')].filter((card) => !card.textContent.includes('GigaChat Lite'))
          .every((card) => card.querySelector('.profile-balance-value')?.textContent !== 'Неизвестно');
    })()`);
    state.nextProfileRefreshView = state.profileFixtures.allUnknown;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('all-unknown usage is never presented as measured zero', `document.querySelector('.profile-metric-primary strong')?.textContent === 'Неизвестно'`);
    state.nextProfileRefreshView = state.profileFixtures.large;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('large token values remain readable in the profile table', `document.querySelector('.profile-detail-grid')?.textContent.replace(/\\D/g, '').includes('2100000000')`);
    await clickText('.profile-chart-range button', '30 дней');
    await clickText('.profile-chart-switch button', 'По дням');
    await waitDom('daily chart shows the large March 1 total', `document.querySelector('g[data-chart-date="2024-03-01"] > title')?.textContent.replace(/\\D/g, '').includes('2100000000')`);
    await evaluate(`document.querySelector('.profile-chart-section')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })`);
    await waitDom('large chart is centered in the visible profile area', `(() => {
      const area = document.querySelector('.profile-page')?.closest('.view-area')?.getBoundingClientRect();
      const chart = document.querySelector('.profile-chart-section')?.getBoundingClientRect();
      return Boolean(area && chart && chart.top >= area.top - 1 && chart.bottom <= area.bottom + 1);
    })()`);
    const largeChartEvidence = JSON.parse(await evaluate(`JSON.stringify((() => {
      const svg = document.querySelector('.profile-usage-chart');
      const labels = [...(svg?.querySelectorAll('.profile-chart-axis') ?? [])].map((label) => {
        const box = label.getBBox();
        return { x: box.x, width: box.width, text: label.textContent ?? '' };
      });
      return { width: svg?.viewBox.baseVal.width ?? 0, labels,
        point: svg?.querySelector('g[data-chart-date="2024-03-01"] title')?.textContent ?? '' };
    })())`));
    assert.ok(largeChartEvidence.width > 0 && largeChartEvidence.labels.length > 0,
      'large totals retain a rendered chart and readable axis labels');
    assert.ok(largeChartEvidence.labels.every((label) => label.x >= 0 && label.x + label.width <= largeChartEvidence.width + 1),
      `large chart axis labels remain inside the SVG: ${JSON.stringify(largeChartEvidence.labels)}`);
    assert.ok(largeChartEvidence.point.replace(/\D/g, '').includes('2100000000'),
      'the chart point keeps the complete large count accessible even when axis labels are compact');
    await capture('stage6-profile-large-chart-axis');
    await evaluate(`(() => { const area = document.querySelector('.profile-page')?.closest('.view-area'); if (area) area.scrollTop = 0; })()`);
    await waitDom('profile returns to its top after the large-chart capture', `document.querySelector('.profile-page')?.closest('.view-area')?.scrollTop === 0`);
    state.nextProfileRefreshView = state.profileFixtures.expired;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('expired manual snapshot is marked expired rather than current', `document.querySelectorAll('.profile-balance-status').length === 4
      && [...document.querySelectorAll('.profile-balance-status')].every((item) => item.textContent.includes('истёк'))`);

    state.nextProfileRefreshView = state.profileFixtures.rich;
    await clickText('.profile-balance-actions button', 'Обновить остаток');
    await waitDom('rich chart fixture is restored before chart interaction', `document.querySelectorAll('.profile-heat-cell').length === 366`);
    for (const [label, key, expectedTokens] of [['Сегодня', 'today', 765_432], ['Неделя', 'week', 2_005_199], ['Месяц', 'month', 770_632]]) {
      await clickText('.profile-period-switch button', label);
      assert.equal(state.profileFixtures.rich.localActivity[key].totalTokens.knownTokens, expectedTokens,
        `${label} synthetic fixture matches its independently calculated expected total`);
      assert.equal(await evaluate(`document.querySelector('.profile-period-value')?.textContent.replace(/\\D/g, '')`), String(expectedTokens),
        `${label} summary renders its independently calculated total`);
    }
    await clickText('.profile-chart-range button', '30 дней');
    await clickText('.profile-chart-switch button', 'По дням');
    await waitDom('daily chart exposes one point for each selected day', `document.querySelectorAll('.profile-usage-chart [data-chart-date]').length === 30`);
    await clickText('.profile-chart-range button', '90 дней');
    await clickText('.profile-chart-switch button', 'По неделям');
    const expectedWeekCount = new Set(state.profileFixtures.rich.localActivity.rollingYear.days.slice(-90).map((day) => {
      const date = new Date(`${day.date}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      return date.toISOString().slice(0, 10);
    })).size;
    await waitDom('weekly chart groups the selected range by Monday', `document.querySelectorAll('.profile-usage-chart [data-chart-date]').length === ${expectedWeekCount}`);
    await clickText('.profile-chart-range button', '12 месяцев');
    await clickText('.profile-chart-switch button', 'Нарастающим итогом');
    await waitDom('cumulative chart spans the full rolling year', `document.querySelectorAll('.profile-usage-chart [data-chart-date]').length === 366`);
    await clickText('.profile-chart-range button', '30 дней');
    await clickText('.profile-chart-switch button', 'По дням');
    await waitDom('daily chart restores its thirty point slots', `document.querySelectorAll('.profile-usage-chart [data-chart-date]').length === 30`);
    await evaluate(`document.querySelector('.profile-usage-chart')?.scrollIntoView({ block: 'center', inline: 'nearest' })`);
    const expectedChartSlots = [
      ['2024-02-02', '2 февраля 2024 г.'], ['2024-02-17', '17 февраля 2024 г.'], ['2024-03-02', '2 марта 2024 г.'],
    ];
    const chartDates = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.profile-usage-chart [data-chart-date]')].map((point) => point.getAttribute('data-chart-date'))) `));
    assert.equal(chartDates.length, 30, 'the point interaction fixture uses all thirty daily slots');
    for (const [date, label] of expectedChartSlots) {
      await moveProfilePointer(`.profile-usage-chart g[data-chart-date="${date}"] .profile-chart-hit`);
      await waitDom(`chart hit target resolves to ${date}`, `document.querySelector('#profile-chart-tooltip strong')?.textContent === ${JSON.stringify(label)}`);
    }
    await moveProfilePointer('.profile-chart-heading h2');
    await waitDom('chart tooltip is hidden before measuring its resting layout', `!document.querySelector('#profile-chart-tooltip')`);
    const chartLayoutBeforeHover = JSON.parse(await evaluate(`JSON.stringify((() => {
      const svg = document.querySelector('.profile-usage-chart');
      const details = document.querySelector('.profile-detail-grid');
      const chart = document.querySelector('.profile-chart-section');
      const owner = document.querySelector('.profile-page')?.closest('.view-area');
      const rect = (element) => { const box = element?.getBoundingClientRect(); return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null; };
      const contentTop = (element) => { const box = element?.getBoundingClientRect(); const area = owner?.getBoundingClientRect(); return box && area && owner ? box.top - area.top + owner.scrollTop : null; };
      return { svg: rect(svg), details: rect(details), chart: rect(chart), scrollTop: owner?.scrollTop ?? null,
        chartContentTop: contentTop(chart), detailsContentTop: contentTop(details) };
    })())`));
    assert.ok(chartLayoutBeforeHover.svg && chartLayoutBeforeHover.details, 'profile chart and following details are present for the rendered interaction');
    await moveProfilePointer('.profile-usage-chart g[data-chart-date="2024-02-17"] .profile-chart-hit');
    await waitDom('pointer hover selects a chart point and reveals its tooltip', `document.querySelector('#profile-chart-tooltip')
      && document.querySelector('.profile-usage-chart')?.getAttribute('aria-describedby') === 'profile-chart-tooltip'`);
    const chartLayoutWithTooltip = JSON.parse(await evaluate(`JSON.stringify((() => {
      const owner = document.querySelector('.profile-page')?.closest('.view-area');
      const chart = document.querySelector('.profile-chart-section');
      const details = document.querySelector('.profile-detail-grid')?.getBoundingClientRect();
      const ownerRect = owner?.getBoundingClientRect();
      return { chartHeight: chart?.getBoundingClientRect().height ?? null,
        chartContentTop: chart && ownerRect && owner ? chart.getBoundingClientRect().top - ownerRect.top + owner.scrollTop : null,
        detailsContentTop: details && ownerRect && owner ? details.top - ownerRect.top + owner.scrollTop : null,
        scrollTop: owner?.scrollTop ?? null, tooltip: document.querySelector('#profile-chart-tooltip')?.textContent ?? '' };
    })())`));
    assert.ok(chartLayoutWithTooltip.tooltip.length > 0, 'chart tooltip has real point data');
    assert.ok(Math.abs(chartLayoutWithTooltip.chartHeight - chartLayoutBeforeHover.chart.height) <= 1
      && Math.abs(chartLayoutWithTooltip.chartContentTop - chartLayoutBeforeHover.chartContentTop) <= 1
      && Math.abs(chartLayoutWithTooltip.detailsContentTop - chartLayoutBeforeHover.detailsContentTop) <= 1,
    `chart tooltip reveal does not change content geometry (scroll ${chartLayoutBeforeHover.scrollTop} -> ${chartLayoutWithTooltip.scrollTop}): ${JSON.stringify({
      before: { chartHeight: chartLayoutBeforeHover.chart.height, chartTop: chartLayoutBeforeHover.chartContentTop, detailsTop: chartLayoutBeforeHover.detailsContentTop },
      after: { chartHeight: chartLayoutWithTooltip.chartHeight, chartTop: chartLayoutWithTooltip.chartContentTop, detailsTop: chartLayoutWithTooltip.detailsContentTop },
    })}`);
    await capture('stage6-profile-chart-tooltip');
    await moveProfilePointer('.profile-chart-heading h2');
    await waitDom('pointer leaving chart hides its tooltip', `!document.querySelector('#profile-chart-tooltip')`);
    const chartLayoutAfterTooltip = JSON.parse(await evaluate(`JSON.stringify((() => {
      const owner = document.querySelector('.profile-page')?.closest('.view-area');
      const ownerRect = owner?.getBoundingClientRect();
      const chart = document.querySelector('.profile-chart-section');
      const details = document.querySelector('.profile-detail-grid');
      return { chartHeight: chart?.getBoundingClientRect().height ?? null,
        chartContentTop: chart && ownerRect && owner ? chart.getBoundingClientRect().top - ownerRect.top + owner.scrollTop : null,
        detailsContentTop: details && ownerRect && owner ? details.getBoundingClientRect().top - ownerRect.top + owner.scrollTop : null,
        scrollTop: owner?.scrollTop ?? null };
    })())`));
    assert.ok(Math.abs(chartLayoutAfterTooltip.chartHeight - chartLayoutBeforeHover.chart.height) <= 1
      && Math.abs(chartLayoutAfterTooltip.chartContentTop - chartLayoutBeforeHover.chartContentTop) <= 1
      && Math.abs(chartLayoutAfterTooltip.detailsContentTop - chartLayoutBeforeHover.detailsContentTop) <= 1,
    `chart tooltip dismissal preserves content geometry (scroll ${chartLayoutBeforeHover.scrollTop} -> ${chartLayoutAfterTooltip.scrollTop}): ${JSON.stringify(chartLayoutAfterTooltip)}`);
    await evaluate(`document.querySelector('.profile-usage-chart')?.focus()`);
    await sendKey('HOME');
    await waitDom('keyboard Home selects the first chart point', `document.querySelector('.profile-usage-chart')?.getAttribute('aria-describedby') === 'profile-chart-tooltip'
      && document.querySelector('#profile-chart-tooltip strong')?.textContent === '2 февраля 2024 г.'
      && document.querySelector('.profile-usage-chart')?.getAttribute('aria-label')?.includes('2 февраля 2024 г.')`);
    await sendKey('END');
    assert.ok((await evaluate(`document.querySelector('.profile-usage-chart')?.getAttribute('aria-label') ?? ''`)).includes('2 марта 2024'),
      'keyboard End reaches the latest chart point');
    await evaluate(`document.activeElement?.blur()`);
    await capture('stage6-profile-rich-chart');

    const studioInputs = [
      ['Остаток GigaChat Ultra', '1100000'], ['Остаток GigaChat Max', '2200000'],
      ['Остаток GigaChat Pro', '3300000'], ['Остаток GigaChat Lite', '4400000'],
      ['Дата окончания остатка', '2027-10-12'],
    ];
    const profileAnchorCallsBeforeBlank = state.profileAnchorSaveCalls.length;
    await clickText('.profile-balance-actions button', 'Сверить с сайтом');
    await waitDom('manual Studio form opens with keyboard focus', `document.querySelector('.profile-anchor-form[aria-busy="false"]')
      && document.activeElement?.getAttribute('aria-label') === 'Остаток GigaChat Ultra'`);
    await clickText('.profile-anchor-footer button', 'Сохранить сверку');
    assert.equal(state.profileAnchorSaveCalls.length, profileAnchorCallsBeforeBlank, 'required manual values block blank input before IPC');
    assert.equal(await evaluate(`document.querySelector('.profile-anchor-form')?.checkValidity()`), false,
      'manual anchor form uses native required validation');
    await fillInput('input[aria-label="Остаток GigaChat Ultra"]', '-1');
    assert.equal(await evaluate(`document.querySelector('.profile-anchor-form')?.checkValidity()`), false,
      'negative manual balance is rejected by native validation');
    await clickText('.profile-anchor-footer button', 'Сохранить сверку');
    assert.equal(state.profileAnchorSaveCalls.length, profileAnchorCallsBeforeBlank,
      'invalid manual values are rejected before IPC');
    await fillInput('input[aria-label="Остаток GigaChat Ultra"]', '1100000');
    for (const [label, value] of studioInputs) await fillInput(`input[aria-label=${JSON.stringify(label)}]`, value);
    state.rejectNextProfileAnchorSave = true;
    await clickText('.profile-anchor-footer button', 'Сохранить сверку');
    await waitDom('manual anchor storage failure is safe and leaves the form open', `document.querySelector('.profile-anchor-form [role="alert"]')?.textContent.includes('Не удалось сохранить сверку на этом устройстве')`);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Остаток GigaChat Lite"]')?.value`), '4400000',
      'failed save retains the entered family values');
    assert.ok(!(await evaluate(`document.querySelector('.profile-anchor-form')?.textContent ?? ''`)).includes('storage'),
      'manual-save error does not expose storage/provider internals');
    state.deferProfileAnchorSave = true;
    const profileAnchorCallsBeforeBusy = state.profileAnchorSaveCalls.length;
    await clickText('.profile-anchor-footer button', 'Сохранить сверку');
    await waitUntil('manual anchor write is pending', () => state.pendingProfileAnchorSaves.length === 1
      && state.profileAnchorSaveCalls.length === profileAnchorCallsBeforeBusy + 1);
    await waitDom('manual anchor form blocks conflicting input while saving', `document.querySelector('.profile-anchor-form[aria-busy="true"]')
      && [...document.querySelectorAll('.profile-anchor-form input')].every((input) => input.disabled)
      && [...document.querySelectorAll('.profile-anchor-form button')].every((button) => button.disabled)`);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Остаток GigaChat Ultra"]')?.value`), '1100000',
      'busy save does not clear or rewrite the user-entered anchor');
    const pendingProfileAnchor = state.pendingProfileAnchorSaves[0];
    state.profileView = clone(pendingProfileAnchor.view);
    state.usageLedger = clone(state.profileFixtures.richLedger);
    state.deferProfileAnchorSave = false;
    pendingProfileAnchor.request.resolve(clone(pendingProfileAnchor.view));
    await waitDom('successful manual anchor closes with its measured provenance', `!document.querySelector('.profile-anchor-form')
      && document.querySelector('.profile-balance-section')?.textContent.includes('Бесплатный остаток')
      && document.querySelector('.profile-balance-section')?.textContent.includes('До 12 окт. 2027')
      && document.querySelector('.profile-balance-section [role="status"]')?.textContent.includes('Сверка сохранена')`);
    await capture('stage6-profile-studio-anchor');
    await clickText('.profile-balance-actions button', 'Сверить с сайтом');
    await waitDom('manual anchor cancellation form opens', `document.querySelector('.profile-anchor-form')`);
    await sendKey('ESC');
    await waitDom('Escape closes manual form and restores its trigger focus', `!document.querySelector('.profile-anchor-form')
      && document.activeElement?.textContent.includes('Сверить с сайтом')`);

    const profileOriginalTheme = state.appSettings.theme;
    const profileThemeCases = [
      { value: 'dark', label: 'Тёмная' }, { value: 'emerald', label: 'Изумрудная' },
      { value: 'light', label: 'Светлая' }, { value: 'warm', label: 'Тёплая' }, { value: 'system', label: 'Как в Windows' },
    ];
    for (const themeCase of profileThemeCases) {
      await click('.profile-settings-button');
      await clickText('.settings-nav-item', 'Оформление');
      if (themeCase.value === 'system') await click('.system-theme');
      else await clickText('.theme-option', themeCase.label);
      await waitUntil(`${themeCase.label} profile theme is saved`, () => state.appSettings.theme === themeCase.value);
      const resolvedTheme = themeCase.value === 'system'
        ? await evaluate(`matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`)
        : themeCase.value;
      await click('button.window-action[aria-label="Назад"]');
      await waitDom(`${themeCase.label} returns to the profile screen`, `document.querySelector('.profile-page h1')?.textContent === 'Профиль'
        && document.querySelector('.app-frame')?.classList.contains(${JSON.stringify(`theme-${resolvedTheme}`)})`);
      await evaluate(`document.querySelector('.profile-chart-section')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })`);
      await waitDom(`${themeCase.label} calendar and chart context is fully visible`, `(() => {
        const area = document.querySelector('.profile-page')?.closest('.view-area')?.getBoundingClientRect();
        const chart = document.querySelector('.profile-chart-section')?.getBoundingClientRect();
        return Boolean(area && chart && chart.top >= area.top - 1 && chart.bottom <= area.bottom + 1);
      })()`);
      await capture(`stage6-profile-theme-${themeCase.value}-calendar-chart`);
      await evaluate(`(() => { const area = document.querySelector('.profile-page')?.closest('.view-area'); if (area) area.scrollTop = 0; })()`);
      await waitDom(`${themeCase.label} profile returns to the top before its overview capture`, `document.querySelector('.profile-page')?.closest('.view-area')?.scrollTop === 0`);
      await capture(`stage6-profile-theme-${themeCase.value}`);
    }
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Оформление');
    const originalProfileThemeCase = profileThemeCases.find((themeCase) => themeCase.value === profileOriginalTheme);
    assert.ok(originalProfileThemeCase, 'fixture starts in one of the supported theme states');
    if (profileOriginalTheme === 'system') await click('.system-theme');
    else await clickText('.theme-option', originalProfileThemeCase.label);
    await waitUntil('profile fixture theme is restored', () => state.appSettings.theme === profileOriginalTheme);
    await click('button.window-action[aria-label="Назад"]');
    await waitDom('profile screen remains ready for responsive captures', `document.querySelector('.profile-page h1')?.textContent === 'Профиль'`);

    window.setSize(1520, 940);
    await waitDom('wide profile screen has a usable content region', `document.querySelector('.profile-page')?.getBoundingClientRect().width > 700`);
    await capture('stage6-profile-wide');
    window.setSize(560, 480);
    await waitDom('narrow profile screen reflows without page-level horizontal overflow', `innerWidth <= 600
      && document.querySelector('.profile-page')?.clientWidth > 0
      && document.querySelector('.profile-page')?.scrollWidth <= document.querySelector('.profile-page')?.clientWidth + 1`);
    const narrowProfileLayout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const page = document.querySelector('.profile-page')?.getBoundingClientRect();
      const chart = document.querySelector('.profile-chart-frame')?.getBoundingClientRect();
      const heatmap = document.querySelector('.profile-heatmap-scroll');
      return { pageWidth: page?.width ?? 0, chartWidth: chart?.width ?? 0,
        heatmapClientWidth: heatmap?.clientWidth ?? 0, heatmapScrollWidth: heatmap?.scrollWidth ?? 0,
        chartClientWidth: document.querySelector('.profile-chart-scroll')?.clientWidth ?? 0,
        chartScrollWidth: document.querySelector('.profile-chart-scroll')?.scrollWidth ?? 0 };
    })())`));
    assert.ok(narrowProfileLayout.pageWidth > 0 && narrowProfileLayout.chartWidth > 0,
      `narrow profile retains its own responsive content: ${JSON.stringify(narrowProfileLayout)}`);
    assert.ok(narrowProfileLayout.heatmapScrollWidth >= narrowProfileLayout.heatmapClientWidth
      && narrowProfileLayout.chartScrollWidth >= narrowProfileLayout.chartClientWidth,
    `annual calendar and chart own their narrow overflow: ${JSON.stringify(narrowProfileLayout)}`);
    await capture('stage6-profile-narrow');
    await evaluate(`document.querySelector('.profile-balance-grid')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })`);
    await waitDom('narrow balance cards are visible without page-level horizontal overflow', `(() => {
      const page = document.querySelector('.profile-page');
      const area = page?.closest('.view-area')?.getBoundingClientRect();
      const pageRect = page?.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.profile-balance-card')];
      return Boolean(page && area && page.scrollWidth <= page.clientWidth + 1 && cards.length === 4
        && cards.every((card) => {
          const rect = card.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= (pageRect?.left ?? 0) - 1
            && rect.right <= (pageRect?.right ?? 0) + 1 && rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1;
        }));
    })()`);
    await capture('stage6-profile-narrow-balance-cards');
    await evaluate(`document.querySelector('.profile-chart-legend')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })`);
    await waitDom('narrow chart legend and graph remain visible within their own scroll area', `(() => {
      const page = document.querySelector('.profile-page');
      const area = page?.closest('.view-area')?.getBoundingClientRect();
      const pageRect = page?.getBoundingClientRect();
      const legend = document.querySelector('.profile-chart-legend')?.getBoundingClientRect();
      const chart = document.querySelector('.profile-chart-scroll')?.getBoundingClientRect();
      return Boolean(page && area && legend && chart && page.scrollWidth <= page.clientWidth + 1
        && legend.width > 0 && legend.left >= (pageRect?.left ?? 0) - 1 && legend.right <= (pageRect?.right ?? 0) + 1
        && legend.top >= area.top - 1 && legend.bottom <= area.bottom + 1
        && chart.width > 0 && chart.left >= (pageRect?.left ?? 0) - 1 && chart.right <= (pageRect?.right ?? 0) + 1
        && chart.bottom > area.top && chart.top < area.bottom);
    })()`);
    await capture('stage6-profile-narrow-chart-legend');
    await evaluate(`(() => { const area = document.querySelector('.profile-page')?.closest('.view-area'); if (area) area.scrollTop = 0; })()`);
    await waitDom('narrow profile scroll is restored to the top before restoring the window', `document.querySelector('.profile-page')?.closest('.view-area')?.scrollTop === 0`);
    window.setSize(profileOriginalSize[0], profileOriginalSize[1]);
    window.webContents.setZoomFactor(profileOriginalZoom);
    await waitDom('profile viewport restores before returning to chat', `document.querySelector('.profile-page h1')?.textContent === 'Профиль'`);

    await click('button[aria-label="Назад"]');
    await waitDom('Chat A returns after Profile review', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
    state.profileView = clone(state.profileFixtures.empty);
    const unknownBalancePickerReads = state.profileViewCalls;
    await click('button[aria-label="Выбрать модель GigaChat"]');
    await waitUntil('model picker reads the unknown-balance profile DTO', () => state.profileViewCalls > unknownBalancePickerReads);
    const unknownBalanceRings = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.model-picker-balance')].map((ring) => ({
      label: ring.getAttribute('aria-label') ?? '', known: ring.classList.contains('is-known'), filled: Boolean(ring.querySelector('.context-ring-fill')),
    })))`));
    assert.equal(unknownBalanceRings.length, 4, 'all four model options have a balance ring');
    assert.ok(unknownBalanceRings.every((ring) => ring.label.includes('Остаток неизвестен') && !ring.known && !ring.filled),
      'unknown balances keep four neutral unfilled rings and do not imply a pool size');
    assert.equal(await evaluate(`document.querySelector('.model-picker-option[aria-current="true"]')?.getAttribute('aria-label').includes('Остаток неизвестен')`), true,
      'the selected model keeps its identity while its balance remains unknown');
    await capture('stage6-model-picker-unknown-rings');
    await sendKey('ESC');

    state.profileView = clone(state.profileFixtures.expired);
    const expiredBalancePickerReads = state.profileViewCalls;
    await click('button[aria-label="Выбрать модель GigaChat"]');
    await waitUntil('model picker reads the expired-balance profile DTO', () => state.profileViewCalls > expiredBalancePickerReads);
    await waitDom('expired labels reach all four model balance rings', `document.querySelectorAll('.model-picker-balance').length === 4
      && [...document.querySelectorAll('.model-picker-balance')].every((ring) => ring.getAttribute('aria-label')?.includes('Срок сверки истёк'))`);
    const expiredBalanceRings = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.model-picker-balance')].map((ring) => ({
      label: ring.getAttribute('aria-label') ?? '', known: ring.classList.contains('is-known'), filled: Boolean(ring.querySelector('.context-ring-fill')),
    })))`));
    assert.equal(expiredBalanceRings.length, 4, 'expired account observation still has one ring per current model family');
    assert.ok(expiredBalanceRings.every((ring) => ring.label.includes('Срок сверки истёк') && !ring.known && !ring.filled),
      'expired balances are labeled stale and do not retain a misleading numeric ring');
    await capture('stage6-model-picker-expired-rings');
    await sendKey('ESC');

    state.profileView = clone(state.profileFixtures.postAnchorLite);
    const modelPickerProfileReads = state.profileViewCalls;
    await click('button[aria-label="Выбрать модель GigaChat"]');
    await waitDom('picker shows the separately estimated Lite remainder', `document.querySelector('.model-picker-popup .model-picker-option[aria-label^="GigaChat Lite"]')?.getAttribute('aria-label').includes('Оценка: около')
      && document.querySelector('.model-picker-popup .model-picker-option[aria-label^="GigaChat Lite"]')?.getAttribute('aria-label').replace(/\\D/g, '').includes('6399369')
      && document.querySelector('.model-picker-popup .model-picker-option[aria-label^="GigaChat Lite"]')?.getAttribute('aria-label').includes('учтено 631 токенов последующего расхода')
      && document.querySelector('.model-picker-popup .model-picker-option[aria-label^="GigaChat Lite"]')?.getAttribute('aria-label').includes('Полный размер пула неизвестен')`);
    await waitUntil('model picker reads the same profile DTO', () => state.profileViewCalls > modelPickerProfileReads);
    const liteBalanceDescription = await evaluate(`document.querySelector('.model-picker-popup .model-picker-option[aria-label^="GigaChat Lite"]')?.getAttribute('aria-label') ?? ''`);
    assert.ok(liteBalanceDescription.includes('после сверки по API от'), 'model picker exposes the estimate provenance and observation time');
    const knownBalanceRings = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.model-picker-balance')].map((ring) => ({
      known: ring.classList.contains('is-known'), filled: Boolean(ring.querySelector('.context-ring-fill')),
    })))`));
    assert.equal(knownBalanceRings.length, 4, 'the known balance view retains a ring for every current family');
    assert.ok(knownBalanceRings.every((ring) => ring.known && !ring.filled),
      'known remaining balances do not imply a fabricated full-pool percentage');
    await capture('stage6-model-picker-post-anchor-estimate');
    await sendKey('ESC');
    passed('Profile renderer preserves unknowns, calendar focus/hover, balance estimates, manual anchors, and responsive themes');
    const toolTurnBase = {
      id: 'turn-a-approved-tool', chatId: 'chat-a', anchorMessageId: 'chat-a-tool-user', assistantMessageId: 'synthetic-tool-answer', createdAt: timestamp, activity: [
        { kind: 'provider', at: timestamp, activity: 'waiting-for-tool' },
        { kind: 'tool', at: timestamp, tool: 'read', phase: 'completed', durationMs: 28 },
      ],
    };
    state.details.get('chat-a').messages.push({ id: 'chat-a-tool-user', role: 'user', text: 'Проверь файл и сообщи результат.', createdAt: timestamp });
    await clickChat('Chat B');
    await waitDom('Chat B remains readable before loading the tool-turn anchor', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'
      && document.querySelector('.chat-history')?.textContent.includes('B baseline')`);
    await clickChat('Chat A');
    await waitDom('Chat A loads the accepted tool-turn anchor before its partial response', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'
      && document.querySelector('[data-message-id="chat-a-tool-user"]')?.textContent.includes('Проверь файл и сообщи результат.')`);
    const toolTurn = { ...toolTurnBase, status: 'running', startedAt: timestamp, draft: 'Файл проверен и обновлён.' };
    const turnsBeforeTool = state.runtimeTurns.get('chat-a') ?? [];
    state.runtimeTurns.set('chat-a', [...turnsBeforeTool, toolTurn]);
    window.webContents.send('audit:runtime', toolTurn);
    await waitDom('partial answer delta appears before completion or history append', `document.querySelector('[data-turn-id="turn-a-approved-tool"] .turn-activity-list')?.textContent.includes('Чтение файла: завершён')
      && [...document.querySelectorAll('.transcript-draft')].some((draft) => draft.textContent.includes('Файл проверен и обновлён'))
      && !document.querySelector('[data-message-id="synthetic-tool-answer"]')`);
    window.webContents.send('audit:permission', {
      id: 'synthetic-write-approval', resource: 'project-files', action: 'write',
      target: 'C:\\audit\\project-a\\report.txt', reason: 'Synthetic renderer fixture approval.',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await waitDom('write approval is shown for the local action', `document.querySelector('.approval-dialog')?.open === true
      && document.querySelector('.approval-target')?.textContent.includes('report.txt')`);
    await clickText('.approval-dialog .primary-button', 'Разрешить');
    await waitUntil('approval response reaches the existing IPC contract', () => state.permissionResponses.some((item) => item.id === 'synthetic-write-approval' && item.allowed));
    const completedToolTurn = {
      ...toolTurnBase, status: 'completed', startedAt: timestamp,
      endedAt: new Date(Date.parse(timestamp) + 3400).toISOString(), activeDurationMs: 3400,
      activity: [
        { kind: 'tool', at: timestamp, tool: 'read', phase: 'completed', durationMs: 28 },
        { kind: 'tool', at: timestamp, tool: 'write', phase: 'completed', durationMs: 47 },
        { kind: 'provider', at: timestamp, activity: 'receiving' },
      ],
    };
    state.details.get('chat-a').messages.push({ id: toolTurnBase.assistantMessageId, role: 'assistant', source: 'runtime', text: 'Файл проверен и обновлён.', createdAt: timestamp });
    state.runtimeTurns.set('chat-a', [...turnsBeforeTool, completedToolTurn]);
    window.webContents.send('audit:runtime', completedToolTurn);
    await waitDom('completed injected tool activity and reserved answer render once', `document.querySelector('[data-turn-id="turn-a-approved-tool"] .turn-activity-list')?.textContent.includes('Запись файла: завершён')
      && [...document.querySelectorAll('.transcript-message')].filter((message) => message.textContent.includes('Файл проверен и обновлён')).length === 1
      && ![...document.querySelectorAll('.transcript-draft')].some((draft) => draft.textContent.includes('Файл проверен и обновлён'))`);
    assert.equal(await evaluate(`(() => {
      const activity = document.querySelector('[data-turn-id="turn-a-approved-tool"]');
      const answer = document.querySelector('[data-message-id="synthetic-tool-answer"]');
      return Boolean(activity && answer && (activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`), true, 'activity is above the exact assistant message reserved for that turn');
    assert.equal(state.details.get('chat-a').messages.filter((message) => message.text === 'Файл проверен и обновлён.').length, 1,
      'completed synthetic response must be stored once after its partial draft');
    passed('Renderer shows a partial delta before one final answer for synthetic tool activity; execution is covered by runtime/tool fixtures');
    await clickText('.runtime-reconnect', 'Проверить подключение');
    await waitDom('network recovery opens connection settings', `document.querySelector('.connection-setup h1')?.textContent.includes('Подключение GigaChat API')`);
    await click('button[aria-label="Назад"]');
    await waitDom('return to the current chat before switching chats', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
    await clickChat('Chat B');
    await waitDom('timeline hidden after switching chats', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'
      && document.querySelector('.turn-activity') === null`);
    await clickChat('Chat A');
    const expectedChatATurnIds = [settledFailure.id, completedRetry.id, cancelledTurn.id, completedToolTurn.id].sort();
    await waitDom('timeline restores the exact accepted turns for original chat', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'
      && JSON.stringify([...document.querySelectorAll('.turn-activity')].map((activity) => activity.getAttribute('data-turn-id')).sort()) === ${JSON.stringify(JSON.stringify(expectedChatATurnIds))}`);
    const restoredTimeline = JSON.parse(await evaluate(`JSON.stringify(((expected) => {
      const activities = [...document.querySelectorAll('.turn-activity')];
      return {
        ids: activities.map((activity) => activity.getAttribute('data-turn-id')).sort(),
        bindings: expected.map((turn) => {
          const activity = document.querySelector('[data-turn-id="' + turn.turnId + '"]');
          const anchor = document.querySelector('[data-message-id="' + turn.anchorMessageId + '"]');
          const answer = turn.answerMessageId ? document.querySelector('[data-message-id="' + turn.answerMessageId + '"]') : null;
          return {
            turnId: turn.turnId,
            activityCount: activities.filter((item) => item.getAttribute('data-turn-id') === turn.turnId).length,
            anchorFound: Boolean(anchor),
            answerFound: turn.answerMessageId ? Boolean(answer) : null,
            answerAfterActivity: turn.answerMessageId && activity && answer
              ? Boolean(activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
          };
        }),
      };
    })(${JSON.stringify([
      { turnId: settledFailure.id, anchorMessageId: runtimeUserAnchor.id, answerMessageId: null },
      { turnId: completedRetry.id, anchorMessageId: runtimeUserAnchor.id, answerMessageId: completedRetry.assistantMessageId },
      { turnId: cancelledTurn.id, anchorMessageId: 'chat-a-cancel-user', answerMessageId: null },
      { turnId: completedToolTurn.id, anchorMessageId: toolTurnBase.anchorMessageId, answerMessageId: completedToolTurn.assistantMessageId },
    ])}))`));
    assert.deepEqual(restoredTimeline.ids, expectedChatATurnIds, `unexpected turn IDs after chat switch: ${JSON.stringify(restoredTimeline)}`);
    assert.deepEqual(restoredTimeline.bindings, [
      { turnId: settledFailure.id, activityCount: 1, anchorFound: true, answerFound: null, answerAfterActivity: null },
      { turnId: completedRetry.id, activityCount: 1, anchorFound: true, answerFound: true, answerAfterActivity: true },
      { turnId: cancelledTurn.id, activityCount: 1, anchorFound: true, answerFound: null, answerAfterActivity: null },
      { turnId: completedToolTurn.id, activityCount: 1, anchorFound: true, answerFound: true, answerAfterActivity: true },
    ], `orphaned or duplicated activity/answer binding: ${JSON.stringify(restoredTimeline)}`);
    passed('Rendered local attachments stay local; retry is explicit, collapsible, and adds no user message');

    const chatMessagesBeforeAttachmentPicker = state.details.get('chat-a').messages.length;
    const chatAppendsBeforeAttachmentPicker = state.appendCalls.length;
    await fillTextarea(draftSelector, 'Текст сохраняется во время выбора файла');
    await waitUntil('existing-chat text is saved before the picker test', () => state.details.get('chat-a')?.draft === 'Текст сохраняется во время выбора файла');
    state.deferChatDraftImports = true;
    state.nextChatPickedFile = { name: 'triangle.png', size: 96 };
    const chatPickerStart = state.pendingChatDraftImports.length;
    const pickerDoubleClick = await evaluate(`(() => { const button = document.querySelector('button[aria-label="Прикрепить файл"]'); if (!button) return false; button.click(); button.click(); return true; })()`);
    assert.equal(pickerDoubleClick, true);
    await waitUntil('one existing-chat file picker despite a same-tick double click', () => state.pendingChatDraftImports.length === chatPickerStart + 1);
    await fillTextarea(draftSelector, 'Текст изменён, пока picker открыт');
    await waitUntil('editing remains available while existing-chat picker waits', () => state.details.get('chat-a')?.draft === 'Текст изменён, пока picker открыт');
    await waitDom('Send waits until existing-chat import completes', `document.querySelector('.send-button-wrap .send-button')?.disabled`);
    assert.equal(state.appendCalls.length, chatAppendsBeforeAttachmentPicker, 'opening a picker never appends a message');
    const pendingChatPicker = state.pendingChatDraftImports[chatPickerStart];
    state.details.get('chat-a').messages.push({ id: 'chat-a-user-during-picker', role: 'user', text: 'Пока выбирался файл, пришёл новый запрос.', createdAt: timestamp });
    state.details.get('chat-a').messages.push({ id: 'chat-a-answer-during-picker', role: 'assistant', source: 'runtime', text: 'Ответ пришёл, пока выбирался файл.', createdAt: timestamp });
    const pickerRefreshTurn = {
      id: 'turn-answer-during-attachment-picker', chatId: 'chat-a', anchorMessageId: 'chat-a-user-during-picker',
      assistantMessageId: 'chat-a-answer-during-picker', status: 'completed', createdAt: timestamp,
      startedAt: timestamp, endedAt: new Date(Date.parse(timestamp) + 1000).toISOString(), activity: [],
    };
    state.runtimeTurns.set('chat-a', [...(state.runtimeTurns.get('chat-a') ?? []), pickerRefreshTurn]);
    window.webContents.send('audit:runtime', pickerRefreshTurn);
    await waitDom('new assistant message arrives while the picker is open', `document.querySelector('.chat-history')?.textContent.includes('Ответ пришёл, пока выбирался файл.')`);
    resolveChatDraftFilePicker(pendingChatPicker, 'chat-a', pendingChatPicker.name);
    await waitDom('late picker result merges only draft attachments into the current detail', `document.querySelector('.attachment-card strong')?.textContent === 'triangle.png'
      && document.querySelector('.chat-history')?.textContent.includes('Ответ пришёл, пока выбирался файл.')`);
    await waitDom('pending image thumbnail is rendered from the bounded preview bridge', `document.querySelector('.attachment-card .attachment-preview img')`);
    assert.equal(state.details.get('chat-a').messages.length, chatMessagesBeforeAttachmentPicker + 2,
      'the accepted user message and its assistant answer survive the attachment result');
    assert.deepEqual(state.details.get('chat-a').messages.slice(chatMessagesBeforeAttachmentPicker)
      .map(({ id, role, text }) => ({ id, role, text })), [
      { id: 'chat-a-user-during-picker', role: 'user', text: 'Пока выбирался файл, пришёл новый запрос.' },
      { id: 'chat-a-answer-during-picker', role: 'assistant', text: 'Ответ пришёл, пока выбирался файл.' },
    ], 'late attachment staging preserves both exact messages in their accepted order');
    assert.equal(state.appendCalls.length, chatAppendsBeforeAttachmentPicker, 'staging stays local and does not send');
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), 'Текст изменён, пока picker открыт',
      'late picker acknowledgement preserves text edited while it was open');
    await capture('stage3-existing-chat-pending-image');
    state.deferChatDraftImports = false;

    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Подключение API');
    await waitDom('synthetic session is connected before resetting the exhausted pool', `[...document.querySelectorAll('.connection-setup button')].some((button) => button.textContent.includes('Отключить'))`);
    await clickText('.connection-setup button', 'Отключить');
    await waitUntil('explicit disconnect clears the synthetic connection', () => state.connectionStatus.state === 'not-configured');
    await waitDom('Connect action is rendered after explicit disconnect', `[...document.querySelectorAll('.connection-setup button')].some((button) => button.textContent.includes('Проверить подключение') && !button.disabled)`);
    await clickText('.connection-setup button', 'Проверить подключение');
    await waitUntil('explicit reconnect starts a fresh allowance session', () => state.connectionStatus.state === 'connected'
      && !state.modelRegistry.exhaustedModelIds?.includes('GigaChat-3-Ultra'));
    await waitDom('connected state and disconnect action render before model navigation', `document.querySelector('.connection-result[data-state="connected"]')
      && [...document.querySelectorAll('.connection-setup button')].some((button) => button.textContent.includes('Отключить'))`);
    await clickText('.settings-nav-item', 'Модели и лимиты');
    await clickText('.connection-card button', 'Обновить список');
    await waitDom('fresh model registry is loaded after explicit reconnect', `document.querySelector('.connection-card .status-pill')?.textContent.includes('Список загружен')`);
    assert.deepEqual(state.modelRegistry.exhaustedModelIds, [], 'the selected Ultra pool is fresh only after explicit reconnect');
    await click('button.window-action[aria-label="Назад"]');
    await waitDom('chat A returns with its pending image after reconnect', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'
      && document.querySelector('.attachment-card strong')?.textContent === 'triangle.png'`);
    assert.equal(await evaluate(`document.querySelector('.send-button-wrap .send-button')?.disabled`), false,
      'verified Ultra image capability is usable only after the authoritative reconnect/registry refresh');

    await fillTextarea(draftSelector, '');
    await waitUntil('files-only Send begins with an empty user text', () => state.details.get('chat-a')?.draft === '');
    await click('.send-button-wrap .send-button');
    await waitUntil('files-only Send appends one user message with its local attachment ID', () => state.appendCalls.length === chatAppendsBeforeAttachmentPicker + 1);
    const acceptedChatAttachment = state.appendCalls.at(-1);
    assert.equal(acceptedChatAttachment.id, 'chat-a');
    assert.equal(acceptedChatAttachment.text, '', 'files-only Send keeps user-visible message text empty');
    assert.equal(acceptedChatAttachment.attachmentIds.length, 1, 'one exact staged local ID is accepted');
    await waitDom('sent image is shown on its linked user message', `document.querySelector('.message-attachments .attachment-preview img')
      && document.querySelector('.message-attachments')?.closest('.message-user')?.textContent.includes('triangle.png')`);
    assert.equal(state.details.get('chat-a').messages.filter((message) => message.role === 'user').at(-1)?.attachmentIds?.[0], acceptedChatAttachment.attachmentIds[0]);
    assert.equal(state.details.get('chat-a').artifacts.find((item) => item.id === acceptedChatAttachment.attachmentIds[0])?.messageId,
      state.details.get('chat-a').messages.filter((message) => message.role === 'user').at(-1)?.id,
      'the accepted file stays associated with this user message');
    await capture('stage3-existing-chat-sent-image');

    window.setSize(1520, 940);
    await waitDom('wide workspace is ready for chat-column drop proof', `document.querySelector('.browser-workspace')?.getBoundingClientRect().width >= 880`);
    await click('button[aria-label="Показать браузер"]');
    await waitDom('browser pane mounts before selecting split presentation', `document.querySelector('.browser-pane')`);
    await evaluate(`(() => {
      const toggle = document.querySelector('.workspace-expand-toggle');
      if (toggle?.getAttribute('aria-pressed') === 'true') toggle.click();
    })()`);
    await waitDom('browser opens beside the visible chat column', `document.querySelector('.browser-pane')
      && !document.querySelector('.browser-workspace')?.classList.contains('is-full')
      && document.querySelector('.chat-column')?.getBoundingClientRect().width > 0
      && document.querySelector('.chat-column')?.getBoundingClientRect().height > 0`);
    await evaluate(`(() => {
      const pane = document.querySelector('.browser-pane');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['image'], 'drop.png', { type: 'image/png' }));
      pane?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    })()`);
    await sleep(80);
    assert.equal(await evaluate(`Boolean(document.querySelector('.attachment-drop-overlay'))`), false,
      'dragging over the embedded browser never tints or targets it');
    const chatDropStart = state.chatDraftStageCalls.length;
    await evaluate(`(() => {
      const column = document.querySelector('.chat-column');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['image'], 'dropped.png', { type: 'image/png' }));
      column?.querySelector('.composer')?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    })()`);
    await waitDom('drop hint covers the complete chat column only', `document.querySelector('.attachment-drop-overlay')`);
    const dropBounds = JSON.parse(await evaluate(`JSON.stringify((() => {
      const column = document.querySelector('.chat-column')?.getBoundingClientRect();
      const overlay = document.querySelector('.attachment-drop-overlay')?.getBoundingClientRect();
      const pane = document.querySelector('.browser-pane')?.getBoundingClientRect();
      const overlayElement = document.querySelector('.attachment-drop-overlay');
      const style = overlayElement ? getComputedStyle(overlayElement) : null;
      return column && overlay && pane && overlayElement && style ? {
        left: Math.abs(column.left - overlay.left), top: Math.abs(column.top - overlay.top),
        width: Math.abs(column.width - overlay.width), height: Math.abs(column.height - overlay.height),
        chatWidth: column.width, chatHeight: column.height, paneWidth: pane.width, paneHeight: pane.height,
        overlayWidth: overlay.width, overlayHeight: overlay.height,
        display: style.display, visibility: style.visibility, opacity: Number(style.opacity),
        rendered: overlayElement.getClientRects().length > 0,
        overlapsBrowser: overlay.left < pane.right && overlay.right > pane.left && overlay.top < pane.bottom && overlay.bottom > pane.top,
      } : null;
    })())`));
    assert.ok(dropBounds && [dropBounds.left, dropBounds.top, dropBounds.width, dropBounds.height].every((value) => value <= 1),
      'drop tint covers the full chat column including its composer');
    assert.ok(dropBounds.chatWidth > 0 && dropBounds.chatHeight > 0 && dropBounds.paneWidth > 0 && dropBounds.paneHeight > 0,
      `chat and browser targets are both visible: ${JSON.stringify(dropBounds)}`);
    assert.ok(dropBounds.rendered && dropBounds.display !== 'none' && dropBounds.visibility === 'visible' && dropBounds.opacity > 0,
      `drop overlay is actually rendered: ${JSON.stringify(dropBounds)}`);
    assert.equal(dropBounds.overlapsBrowser, false, 'visible drop tint stays outside the visible browser pane');
    assert.equal(await evaluate(`document.querySelector('.browser-pane')?.contains(document.querySelector('.attachment-drop-overlay'))`), false,
      'drop overlay is not rendered inside the browser pane');
    await capture('stage3-chat-column-drop-overlay');
    await evaluate(`document.querySelector('.composer textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitDom('Escape dismisses the drop overlay', `!document.querySelector('.attachment-drop-overlay')`);
    await evaluate(`(() => {
      const column = document.querySelector('.chat-column');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['image'], 'dropped.png', { type: 'image/png' }));
      column?.querySelector('.composer')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    })()`);
    await waitUntil('OS-style drop reaches the same local chat staging bridge', () => state.chatDraftStageCalls.length === chatDropStart + 1);
    await waitDom('dropped file appears in the composer tray', `document.querySelector('.attachment-card strong')?.textContent === 'dropped.png'`);
    assert.equal(state.appendCalls.length, chatAppendsBeforeAttachmentPicker + 1, 'drag-and-drop does not send or create a second message');
    const droppedId = state.details.get('chat-a').draftAttachments.find((item) => item.name === 'dropped.png')?.id;
    assert.ok(droppedId);
    await fillTextarea(draftSelector, 'Черновик и история сохраняются при удалении файла');
    await waitUntil('existing-chat draft is saved before the close/removal race', () =>
      state.details.get('chat-a')?.draft === 'Черновик и история сохраняются при удалении файла');
    const messagesBeforeDeferredRemoval = clone(state.details.get('chat-a').messages);
    const removeCallsBeforeClose = state.pendingChatDraftRemovals.length;
    const closeReadyBeforeRemoval = state.closeReadyCalls;
    const closeReturnsBeforeRemoval = state.closeReturnCalls;
    state.deferChatDraftRemovals = true;
    await clickText('.attachment-card button', 'Убрать');
    await waitUntil('chat draft removal waits in the main boundary', () => state.pendingChatDraftRemovals.length === removeCallsBeforeClose + 1);
    const closeDuringAttachmentRemoval = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('close stays pending while a chat attachment removal is active', `document.querySelector('.close-pending-dialog')?.open === true`);
    await sleep(80);
    assert.equal(state.closeReadyCalls, closeReadyBeforeRemoval, 'close must drain the tracked removal before main close-ready');
    assert.deepEqual(state.details.get('chat-a').messages, messagesBeforeDeferredRemoval, 'history remains intact during removal');
    assert.equal(state.details.get('chat-a').draft, 'Черновик и история сохраняются при удалении файла', 'draft remains saved during removal');
    state.pendingChatDraftRemovals[removeCallsBeforeClose].resolve();
    await waitUntil('main close-ready follows the settled attachment removal', () => state.closeReadyCalls === closeReadyBeforeRemoval + 1);
    assert.equal((await closeDuringAttachmentRemoval).status, 'failed');
    await waitDom('close returns to work after the staged file is removed', `document.querySelector('.close-error-dialog')?.open === true`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('renderer resumes after tracked attachment removal close', async () => state.closeReturnCalls === closeReturnsBeforeRemoval + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    state.deferChatDraftRemovals = false;
    await waitDom('removing a staged drop keeps the sent attachment intact', `!document.querySelector('.attachment-card strong')
      && document.querySelector('.message-attachments')?.textContent.includes('triangle.png')`);
    assert.deepEqual(state.details.get('chat-a').messages, messagesBeforeDeferredRemoval, 'removing a pending file does not change saved history');
    assert.equal(state.details.get('chat-a').draft, 'Черновик и история сохраняются при удалении файла', 'removing a pending file preserves the saved chat draft');
    assert.equal(state.details.get('chat-a').artifacts.some((item) => item.id === acceptedChatAttachment.attachmentIds[0]), true,
      'removing a later pending file does not remove a sent artifact');
    await click('button[aria-label="Скрыть браузер"]');
    await waitDom('split browser closes after attachment drop proof', `!document.querySelector('.browser-pane')`);
    state.nextChatPickedFile = { name: 'empty-chat.txt', size: 0 };
    const emptyChatAppendCount = state.appendCalls.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitDom('empty existing-chat file remains staged and blocks Send', `document.querySelector('.attachment-blocker')?.textContent.includes('пуст')
      && document.querySelector('.send-button-wrap .send-button')?.disabled`);
    assert.equal(state.details.get('chat-a').draftAttachments.at(-1)?.size, 0);
    assert.equal(state.appendCalls.length, emptyChatAppendCount, 'empty existing-chat attachment is rejected before append');
    await clickText('.attachment-card button', 'Убрать');
    await waitDom('empty existing-chat file can be removed without a history write', `!document.querySelector('.attachment-card')`);
    passed('Existing-chat picker/drop stay local, preserve newer history, and link the sent image to one files-only message');

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

    const chatAHistoryBeforeLatePicker = clone(state.details.get('chat-a').messages);
    const chatAArtifactsBeforeLatePicker = clone(state.details.get('chat-a').artifacts);
    const chatAImportCallsBeforeLatePicker = state.importCalls.length;
    const chatAAppendCallsBeforeLatePicker = state.appendCalls.length;
    state.deferChatDraftImports = true;
    state.nextChatPickedFile = { name: 'late-picked-a.txt', size: 40 };
    const lateChatPickerStart = state.pendingChatDraftImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('A pending file picker', () => state.pendingChatDraftImports.length === lateChatPickerStart + 1);
    await clickChat('Chat B');
    await waitDom('chat B after navigation', `document.querySelector('.chat-header-title')?.textContent === 'Chat B' && document.querySelector('.chat-history')?.textContent.includes('B baseline')`);
    const lateChatPicker = state.pendingChatDraftImports[lateChatPickerStart];
    resolveChatDraftFilePicker(lateChatPicker, 'chat-a', lateChatPicker.name);
    await sleep(140);
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat B');
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('late-picked-a.txt')`), false);
    assert.deepEqual(state.details.get('chat-a').messages, chatAHistoryBeforeLatePicker, 'late picker result creates no message in its source chat');
    assert.deepEqual(state.details.get('chat-a').artifacts, chatAArtifactsBeforeLatePicker, 'late picker result does not create a legacy message artifact');
    assert.equal(state.details.get('chat-a').draftAttachments.some((item) => item.name === 'late-picked-a.txt'), true,
      'late picker result remains a local pending attachment on its source chat');
    assert.equal(state.importCalls.length, chatAImportCallsBeforeLatePicker, 'pending picker does not invoke legacy chat import');
    assert.equal(state.appendCalls.length, chatAAppendCallsBeforeLatePicker, 'pending picker does not append or send a message');
    state.deferChatDraftImports = false;
    await clickChat('Chat A');
    await waitDom('A late picker file restored with its draft', `document.querySelector('.chat-header-title')?.textContent === 'Chat A'
      && document.querySelector('.attachment-card strong')?.textContent === 'late-picked-a.txt'`);
    passed('Rendered late picker stages only a local A draft file without replacing B or creating a message');

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
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.disabled`), false,
      'Chat B composer must remain editable while a send from Chat A is waiting');
    await fillTextarea(draftSelector, 'draft edited in chat B while A waits');
    await waitUntil('B draft saves while A waits', () => state.details.get('chat-b').draft === 'draft edited in chat B while A waits');
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
    await waitDom('home draft for inherited-choice freeze', `document.querySelector('.home-view') && !document.querySelector('.composer textarea')?.disabled`);
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Подключение API');
    await waitDom('API connection is ready before explicit quota reset', `[...document.querySelectorAll('.connection-setup button')].some((button) => button.textContent.includes('Отключить'))`);
    await clickText('.connection-setup button', 'Отключить');
    await waitUntil('explicit disconnect clears the connected session', () => state.connectionStatus.state === 'not-configured');
    await waitDom('disconnect action rerenders before reconnect', `[...document.querySelectorAll('.connection-setup button')].some((button) => button.textContent.includes('Проверить подключение') && !button.disabled && button.getClientRects().length > 0)`);
    await clickText('.connection-setup button', 'Проверить подключение');
    await waitUntil('explicit reconnect starts a fresh model allowance session', () => state.connectionStatus.state === 'connected'
      && !state.modelRegistry.exhaustedModelIds?.includes('GigaChat-3-Ultra'));
    await clickText('.settings-nav-item', 'Модели и лимиты');
    await waitDom('refreshed registry makes Ultra selectable after reconnect', `[...document.querySelectorAll('.model-settings-list .permission-profile-selectable')].some((button) => button.textContent.includes('GigaChat Ultra') && !button.disabled)`);
    await clickText('.model-settings-list .permission-profile-selectable', 'GigaChat Ultra');
    await waitUntil('Ultra is the inherited default before Send', () => state.appSettings.defaultModelId === 'GigaChat-3-Ultra');
    await clickText('.settings-nav-item', 'Разрешения');
    await clickText('.permission-profile-list .permission-profile-selectable', 'Спросить');
    await waitUntil('Ask is the inherited profile before Send', () => state.appSettings.defaultPermissionProfile === 'ask');
    await click('button[aria-label="Назад"]');
    await waitDom('home draft ready before inherited-choice Send', `document.querySelector('.home-view') && !document.querySelector('.composer textarea')?.disabled`);
    await fillTextarea(draftSelector, 'Inherited choices stay frozen');
    await waitUntil('inherited-choice message is saved', () => state.homeDraft.text === 'Inherited choices stay frozen');
    state.deferHomeDraftSaves = true;
    const frozenSendCount = state.homeDraftSendCalls.length;
    const frozenSaveStart = state.pendingHomeDraftSaves.length;
    await click('.send-button-wrap .send-button');
    await waitUntil('Send materializes the inherited Ultra and Ask choices', () => state.pendingHomeDraftSaves.length === frozenSaveStart + 1
      && state.pendingHomeDraftSaves[frozenSaveStart].input.modelId === 'GigaChat-3-Ultra'
      && state.pendingHomeDraftSaves[frozenSaveStart].input.permissionProfile === 'ask');
    const frozenChoiceSave = state.pendingHomeDraftSaves[frozenSaveStart];
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Модели и лимиты');
    await clickText('.model-settings-list .permission-profile-selectable', 'GigaChat Pro');
    await waitUntil('default model changes while home Send waits', () => state.appSettings.defaultModelId === 'GigaChat-3-Pro');
    await clickText('.settings-nav-item', 'Разрешения');
    await clickText('.permission-profile-list .permission-profile-selectable', 'Полный доступ');
    await waitUntil('default profile changes while home Send waits', () => state.appSettings.defaultPermissionProfile === 'full');
    resolveHomeDraftSave(frozenChoiceSave);
    await waitUntil('home Send accepts the captured inherited choices', () => state.homeDraftSendCalls.length === frozenSendCount + 1
      && state.homeDraft.lastAcceptance?.turn.permissionProfile === 'ask');
    const frozenAcceptedChat = state.details.get(state.homeDraft.lastAcceptance.chatId);
    assert.equal(frozenAcceptedChat.modelId, 'GigaChat-3-Ultra', 'the accepted message keeps the model inherited at Send');
    assert.equal(frozenAcceptedChat.nextTurnPermissionProfile, 'ask', 'a later Full default cannot widen the accepted Ask choice');
    assert.equal(state.homeDraft.lastAcceptance.turn.permissionProfile, 'ask');
    state.deferHomeDraftSaves = false;
    await clickText('.settings-nav-item', 'Модели и лимиты');
    await clickText('.model-settings-list .permission-profile-selectable', 'GigaChat Ultra');
    await waitUntil('model default restored after inherited-choice test', () => state.appSettings.defaultModelId === 'GigaChat-3-Ultra');
    await clickText('.settings-nav-item', 'Разрешения');
    await clickText('.permission-profile-list .permission-profile-selectable', 'Спросить');
    await waitUntil('permission default restored after inherited-choice test', () => state.appSettings.defaultPermissionProfile === 'ask');
    await click('button[aria-label="Назад"]');
    await waitDom('return home after restoring inherited defaults', `document.querySelector('.home-view')`);
    passed('Home Send freezes inherited model and permission defaults before async storage waits');

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
      id: 'turn-terminal-after-consume', chatId: profileChatId, status: 'failed', createdAt: timestamp,
      startedAt: timestamp, endedAt: new Date(Date.parse(timestamp) + 1000).toISOString(), activity: [],
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
    await waitDom('standalone chat icon without project folder marker', `document.querySelector('.chat-header-title')?.textContent === 'Chat B' && document.querySelector('.chat-header-chat') && !document.querySelector('.chat-header-folder')`);
    await capture('standalone-chat-header');
    passed('Rendered project nesting, square-free child list, and project-aware chat title');
    passed('Rendered late project move updates its own chat without replacing another active chat');

    const homeChatCount = state.chats.length;
    const homeCreateCalls = state.createCalls.length;
    const homeSendCalls = state.homeDraftSendCalls.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('home draft editor ready', `document.querySelector('.home-view') && document.querySelector('.empty-state h1')?.textContent === 'Что будем создавать?' && !document.querySelector('.composer textarea')?.disabled`);
    await evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.focus()`);
    await fillTextarea(draftSelector, 'x');
    await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(draftSelector)}); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(element, 'x' + 'a'.repeat(100)); element.setSelectionRange(101, 101); element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'a'.repeat(100) })); })()`);
    await waitUntil('home text autosaved without a chat', () => state.homeDraft.text === `x${'a'.repeat(100)}`);
    assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(draftSelector)})`), true,
      'typing beyond the first character keeps focus in the same home composer');
    assert.equal(await evaluate(`document.querySelector('.empty-state h1')?.textContent`), 'Что будем создавать?',
      'typing does not replace the welcome screen');
    assert.equal(state.chats.length, homeChatCount, 'typing does not create a recent chat');
    assert.equal(state.createCalls.length, homeCreateCalls, 'typing does not call chats.create');
    assert.equal(state.homeDraftSendCalls.length, homeSendCalls, 'typing does not call homeDraft.send');
    await capture('stage2-home-draft-before-send');

    await click('.composer-project-menu > button');
    await clickText('.action-menu-content:popover-open .project-picker-option', 'Project A');
    await click('.composer-permission-menu > button');
    await clickText('.action-menu-content:popover-open .permission-picker-option', 'Подтверждать за меня');
    await waitUntil('home project and permission profile remain draft state', () =>
      state.homeDraft.projectId === 'project-a' && state.homeDraft.permissionProfile === 'approve');
    await click('button[aria-label="Выбрать модель GigaChat"]');
    await waitDom('home model options are refreshed before selection', `document.querySelector('.model-picker-popup .model-picker-option strong')?.textContent`);
    const proOptionDisabled = await evaluate(`([...document.querySelectorAll('.model-picker-option')].find((button) => button.querySelector('strong')?.textContent.trim() === 'GigaChat Pro'))?.disabled`);
    assert.equal(proOptionDisabled, false, 'the verified current Pro model remains selectable for a home draft');
    await clickText('.model-picker-popup .model-picker-option', 'GigaChat Pro');
    await waitUntil('home model choice is stored without a chat', () => state.homeDraft.modelId === 'GigaChat-3-Pro');
    await fillTextarea(draftSelector, '$audit');
    await clickText('.composer-suggestions .composer-suggestion', 'Audit');
    await waitUntil('home Skill is stored without a chat', () => state.homeDraft.skillId === 'global/audit');
    assert.equal(state.chats.length, homeChatCount, 'project, profile, and Skill selections stay out of Recents');

    state.deferHomeDraftImports = true;
    const importStart = state.pendingHomeDraftImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('home file import pending', () => state.pendingHomeDraftImports.length === importStart + 1);
    await fillTextarea(draftSelector, 'Home message with staged attachment');
    const draftGenerationBeforeImportResult = state.homeDraftSaveCalls.length;
    resolveHomeDraftImport(state.pendingHomeDraftImports[importStart]);
    await waitUntil('staged file and latest home text are preserved', () => state.homeDraft.attachments.length === 1
      && state.homeDraft.text === 'Home message with staged attachment'
      && state.homeDraftSaveCalls.length > draftGenerationBeforeImportResult);
    state.deferHomeDraftImports = false;
    assert.equal(state.chats.length, homeChatCount, 'choosing a file remains a local draft operation');

    state.rejectNextHomeDraftSend = true;
    const sendsBeforeFailure = state.homeDraftSendCalls.length;
    await click('.send-button-wrap .send-button');
    await waitDom('failed explicit home Send is reported', `document.querySelector('.notice')?.textContent.includes('Synthetic home draft Send failure')`);
    assert.equal(state.homeDraftSendCalls.length, sendsBeforeFailure + 1);
    assert.equal(state.chats.length, homeChatCount, 'failed atomic Send creates no visible chat');
    assert.equal(state.homeDraft.text, 'Home message with staged attachment', 'failed Send retains typed text');
    assert.equal(state.homeDraft.attachments.length, 1, 'failed Send retains staged files');

    state.deferHomeDraftSendResponse = true;
    const homeSendsBeforeAccept = state.homeDraftSendCalls.length;
    const appendsBeforeAccept = state.appendCalls.length;
    const retriesBeforeHomeAccept = state.retryCalls.length;
    const acceptedClicks = await evaluate(`(() => { const button = document.querySelector('.send-button-wrap .send-button'); if (!button || button.disabled) return false; button.click(); button.click(); return true; })()`);
    assert.equal(acceptedClicks, true);
    await waitUntil('one atomic home Send after a double click', () => state.pendingHomeDraftSends.length === 1);
    const pendingHomeSend = state.pendingHomeDraftSends[0];
    assert.equal(state.homeDraftSendCalls.length, homeSendsBeforeAccept + 1, 'double click produces one Send IPC');
    assert.equal(await evaluate(`document.querySelector('.home-view') !== null`), true,
      'renderer remains on the welcome route until durable Send returns');
    assert.equal(state.details.get(pendingHomeSend.accepted.detail.id)?.messages[0]?.text, 'Home message with staged attachment');
    assert.equal(state.details.get(pendingHomeSend.accepted.detail.id)?.nextTurnPermissionProfile, 'approve');
    assert.equal(state.details.get(pendingHomeSend.accepted.detail.id)?.nextTurnSkillId, 'global/audit');
    assert.equal(state.details.get(pendingHomeSend.accepted.detail.id)?.modelId, 'GigaChat-3-Pro');
    const acceptedMessageId = pendingHomeSend.accepted.detail.messages[0].id;
    assert.equal(state.details.get(pendingHomeSend.accepted.detail.id)?.artifacts[0]?.messageId, acceptedMessageId,
      'pending file is attached to the explicit first user message');
    resolveHomeDraftSend(pendingHomeSend);
    await waitDom('accepted home draft opens its new chat', `document.querySelector('.chat-header-title')?.textContent === 'Home message with staged attachment'`);
    const acceptedHomeTurn = pendingHomeSend.accepted.turn;
    const durableHomeTurn = state.details.get(pendingHomeSend.accepted.detail.id)?.turns.find((turn) => turn.turnId === acceptedHomeTurn.turnId);
    assert.equal(durableHomeTurn?.status, 'failed', 'queued:false home acceptance is durably terminal, not left queued');
    assert.equal(durableHomeTurn?.startedAt, undefined, 'a turn rejected before runtime start has no start timestamp');
    assert.ok(durableHomeTurn?.endedAt, 'the not-sent outcome is durably timestamped');
    await waitDom('accepted but not queued home turn is rendered as not sent', `document.querySelector('[data-turn-id="${acceptedHomeTurn.turnId}"] .turn-activity-status')?.textContent === 'Не отправлено'
      && document.querySelector('[data-turn-id="${acceptedHomeTurn.turnId}"] .turn-activity-error')?.textContent.includes('не поставлено в очередь')`);
    const homeNotSentBinding = JSON.parse(await evaluate(`JSON.stringify((() => {
      const anchor = document.querySelector('[data-message-id="${acceptedHomeTurn.messageId}"]');
      const activity = document.querySelector('[data-turn-id="${acceptedHomeTurn.turnId}"]');
      return { anchor: anchor?.textContent, activityAfterAnchor: Boolean(anchor && activity && (anchor.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING)) };
    })())`));
    assert.ok(homeNotSentBinding.anchor?.includes('Home message with staged attachment'));
    assert.equal(homeNotSentBinding.activityAfterAnchor, true, 'not-sent status remains attached to its accepted user message');
    assert.equal(state.chats.length, homeChatCount + 1, 'only explicit Send creates one chat');
    assert.equal(state.createCalls.length, homeCreateCalls, 'home Send uses the atomic homeDraft contract, not chats.create');
    assert.equal(state.homeDraftSendCalls.length, homeSendsBeforeAccept + 1);
    assert.equal(state.appendCalls.length, appendsBeforeAccept, 'accepted first message is not appended twice');
    assert.equal(state.retryCalls.length, retriesBeforeHomeAccept, 'a not-sent home turn is not automatically retried');
    assert.equal(state.runtimeTurns.has(pendingHomeSend.accepted.detail.id), false, 'queued:false creates no runtime work item');
    assert.equal(state.details.get(pendingHomeSend.accepted.detail.id)?.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(state.homeDraft.text, '', 'accepted text clears from the persistent home draft');
    assert.equal(state.homeDraft.attachments.length, 0, 'accepted attachments leave the pending home tray');
    assert.equal(await evaluate(`document.querySelector('.notice')?.textContent.includes('сохранено локально')`), true,
      'offline acceptance is shown as local, not queued or sent');
    state.deferHomeDraftSendResponse = false;
    passed('Home input stays local until explicit Send; queued:false is durably shown as not sent without runtime work');

    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('home route after accepted Send', `document.querySelector('.home-view')`);
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), '',
      'a new home draft shows its own saved text, not the previous chat composer');
    state.nextHomePickedFile = { name: 'empty.txt', size: 0 };
    const emptyHomeSendCount = state.homeDraftSendCalls.length;
    const emptyHomeChatCount = state.chats.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitDom('empty home file remains pending with a clear blocker', `document.querySelector('.attachment-blocker')?.textContent.includes('пуст')
      && document.querySelector('.send-button-wrap .send-button')?.disabled`);
    assert.equal(state.homeDraft.attachments.at(-1)?.size, 0);
    assert.equal(state.homeDraftSendCalls.length, emptyHomeSendCount, 'empty home attachment is rejected before acceptance');
    assert.equal(state.chats.length, emptyHomeChatCount, 'empty home attachment cannot create an empty chat');
    await clickText('.attachment-card button', 'Убрать');
    await waitDom('empty home file can be removed without changing the home route', `!document.querySelector('.attachment-card') && document.querySelector('.home-view')`);
    await fillTextarea(draftSelector, 'Accepted A before a late home edit');
    await waitUntil('source A persisted before Send', () => state.homeDraft.text === 'Accepted A before a late home edit');
    state.deferHomeDraftSendResponse = true;
    const racePendingStart = state.pendingHomeDraftSends.length;
    const raceSendStart = state.homeDraftSendCalls.length;
    await click('.send-button-wrap .send-button');
    await waitUntil('source A accepted while the renderer waits for the response', () => state.pendingHomeDraftSends.length === racePendingStart + 1);
    const acceptedA = state.pendingHomeDraftSends.at(-1);
    const clearedAcceptanceRevision = acceptedA.accepted.homeDraft.revision;
    const typedAfterSend = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(draftSelector)}); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(element, 'Typed B after Send'); element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Typed B after Send' })); return true; })()`);
    assert.equal(typedAfterSend, true);
    await waitUntil('late B edit is represented by the same revision as accepted clear', () =>
      state.homeDraftSaveCalls.some((input) => input.text === 'Typed B after Send' && input.revision === clearedAcceptanceRevision));
    resolveHomeDraftSend(acceptedA);
    await waitDom('accepted A route after latest B draft is rebased', `document.querySelector('.chat-header-title')?.textContent === 'Accepted A before a late home edit'`);
    assert.equal(state.homeDraftSendCalls.length, raceSendStart + 1, 'only captured A reaches Send');
    assert.equal(state.details.get(acceptedA.accepted.detail.id)?.messages[0]?.text, 'Accepted A before a late home edit');
    assert.equal(state.homeDraft.text, 'Typed B after Send', 'late B edit survives when its optimistic revision equals the accepted clear revision');
    assert.equal(await evaluate(`document.querySelector('.chat-history')?.textContent.includes('Typed B after Send')`), false,
      'newer B draft is not inserted into A accepted history');
    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('late B draft reappears on home', `document.querySelector('.home-view') && document.querySelector('.composer textarea')?.value === 'Typed B after Send'`);
    state.deferHomeDraftSendResponse = false;
    await fillTextarea(draftSelector, '');
    await waitUntil('late B draft cleanup saved', () => state.homeDraft.text === '');
    passed('Equal-revision home edits remain separate from the immutable accepted message');

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
    await fillTextarea(draftSelector, 'Home A before file import');
    await waitUntil('home A persisted before a deferred import', () => state.homeDraft.text === 'Home A before file import');
    state.deferHomeDraftImports = true;
    const staleHomeImportIndex = state.pendingHomeDraftImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('home file import is pending', () => state.pendingHomeDraftImports.length === staleHomeImportIndex + 1);
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.disabled`), false,
      'typing remains available while a home file picker/import is pending');
    await fillTextarea(draftSelector, 'Home B typed while import waits');
    await waitUntil('home B persisted while import waits', () => state.homeDraft.text === 'Home B typed while import waits');
    await clickChat('Chat B');
    await waitDom('Chat B is editable while the old home import waits', `document.querySelector('.chat-header-title')?.textContent === 'Chat B' && !document.querySelector('.composer textarea')?.disabled`);
    await fillTextarea(draftSelector, 'Chat B draft remains visible');
    await waitUntil('Chat B draft saved independently of the home draft', () => state.details.get('chat-b')?.draft === 'Chat B draft remains visible');
    resolveHomeDraftImport(state.pendingHomeDraftImports[staleHomeImportIndex]);
    await waitUntil('late import saves its file and preserves home B text', () => state.homeDraft.attachments.length === 1
      && state.homeDraft.text === 'Home B typed while import waits');
    assert.equal(await evaluate(`document.querySelector('.chat-header-title')?.textContent`), 'Chat B',
      'late home import does not navigate away from Chat B');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.value`), 'Chat B draft remains visible',
      'late home import does not replace Chat B’s draft');
    assert.equal(state.createCalls.length, homeCreateCalls, 'a late home import still creates no chat');
    state.deferHomeDraftImports = false;
    passed('Deferred home import preserves later home edits and cannot replace another chat draft');

    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('home draft before delayed import rebase', `document.querySelector('.home-view') && !document.querySelector('.composer textarea')?.disabled`);
    await fillTextarea(draftSelector, 'Home A before delayed rebase');
    await waitUntil('Home A persisted before delayed import rebase', () => state.homeDraft.text === 'Home A before delayed rebase');
    state.deferHomeDraftImports = true;
    const delayedRebaseImportIndex = state.pendingHomeDraftImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('delayed rebase import pending', () => state.pendingHomeDraftImports.length === delayedRebaseImportIndex + 1);
    await fillTextarea(draftSelector, 'Home B before delayed rebase');
    await waitUntil('Home B persisted before delayed rebase', () => state.homeDraft.text === 'Home B before delayed rebase');
    state.deferHomeDraftSaves = true;
    const delayedRebaseSaveIndex = state.pendingHomeDraftSaves.length;
    resolveHomeDraftImport(state.pendingHomeDraftImports[delayedRebaseImportIndex]);
    await waitUntil('main import result is rebased into a deferred home save', () => state.pendingHomeDraftSaves.length === delayedRebaseSaveIndex + 1
      && state.pendingHomeDraftSaves[delayedRebaseSaveIndex].input.text === 'Home B before delayed rebase'
      && state.pendingHomeDraftSaves[delayedRebaseSaveIndex].input.revision === state.homeDraft.revision + 1);
    const delayedRebaseSave = state.pendingHomeDraftSaves[delayedRebaseSaveIndex];
    const importedMetadata = clone(state.homeDraft);
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.disabled`), false,
      'the home composer stays editable while the final import rebase save is pending');
    await fillTextarea(draftSelector, 'Home C while rebase save waits');
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), 'Home C while rebase save waits');
    resolveHomeDraftSave(delayedRebaseSave);
    await waitUntil('Home C save queues after the delayed rebase acknowledgement', () => state.pendingHomeDraftSaves.length === delayedRebaseSaveIndex + 2
      && state.pendingHomeDraftSaves[delayedRebaseSaveIndex + 1].input.text === 'Home C while rebase save waits');
    const delayedHomeCSave = state.pendingHomeDraftSaves[delayedRebaseSaveIndex + 1];
    resolveHomeDraftSave(delayedHomeCSave);
    await waitUntil('Home C and imported main metadata persist together', () => state.homeDraft.text === 'Home C while rebase save waits'
      && state.homeDraft.attachments.length === importedMetadata.attachments.length);
    assert.deepEqual(state.homeDraft.attachments, importedMetadata.attachments, 'the rebase keeps main-owned file metadata');
    assert.deepEqual(state.homeDraft.lastAcceptance, importedMetadata.lastAcceptance, 'the rebase keeps the main-owned acceptance snapshot');
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), 'Home C while rebase save waits',
      'the rebase acknowledgement cannot replace the newer home edit');
    state.deferHomeDraftImports = false;
    state.deferHomeDraftSaves = false;
    passed('Deferred home rebase publishes its revision before saving and preserves newer input and main metadata');

    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('home draft before retrying a failed save', `document.querySelector('.home-view') && !document.querySelector('.composer textarea')?.disabled`);
    state.rejectNextHomeDraftSave = true;
    await fillTextarea(draftSelector, 'Home B restored after a failed save');
    await waitDom('failed home draft save offers a retry', `document.querySelector('.project-folder-choice[role="alert"] button')?.textContent.includes('Повторить сохранение')`);
    const retryLocalRevision = state.homeDraft.revision + 1;
    const retryMainMetadata = stageHomeDraftAttachment();
    assert.equal(retryMainMetadata.revision, retryLocalRevision,
      'the main import advances to the same revision as the local text whose save failed');
    const retryMainSnapshot = clone(state.homeDraft);
    state.deferHomeDraftSaves = true;
    const retrySaveIndex = state.pendingHomeDraftSaves.length;
    const closeCallsBeforeRetrySave = state.closeReadyCalls;
    await clickText('.project-folder-choice[role="alert"] button', 'Повторить сохранение');
    await waitUntil('home draft retry reaches its deferred durable save', () => state.pendingHomeDraftSaves.length === retrySaveIndex + 1);
    const deferredRetrySave = state.pendingHomeDraftSaves[retrySaveIndex];
    const retryCloseReturnBefore = state.closeReturnCalls;
    const closeDuringRetry = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('close waits for the active home draft retry', `document.querySelector('.close-pending-dialog')?.open === true`);
    assert.equal(state.closeReadyCalls, closeCallsBeforeRetrySave,
      'close must not reach main before the latest retry save is acknowledged');
    resolveHomeDraftSave(deferredRetrySave);
    await waitUntil('close reaches main after the home retry acknowledgement', () => state.closeReadyCalls === closeCallsBeforeRetrySave + 1);
    assert.equal((await closeDuringRetry).status, 'failed', 'the synthetic main close result keeps the renderer host open');
    await waitDom('successful retry is not blocked by its obsolete save error', `document.querySelector('.close-error-dialog')?.open === true
      && document.querySelector('.close-error-dialog')?.textContent.includes('Synthetic close keeps the renderer host open.')
      && !document.querySelector('.close-error-dialog')?.textContent.includes('Есть несохранённый текст')`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('return after close during successful home retry', async () => state.closeReturnCalls === retryCloseReturnBefore + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    state.deferHomeDraftSaves = false;
    await waitUntil('retry rebases local text over equal-revision main metadata', () => state.homeDraft.text === 'Home B restored after a failed save'
      && state.homeDraft.attachments.length === retryMainSnapshot.attachments.length);
    await waitDom('successful home draft retry clears its save error', `!document.querySelector('.project-folder-choice[role="alert"]')`);
    assert.deepEqual(state.homeDraft.attachments, retryMainSnapshot.attachments,
      'retry preserves the file committed by the main process');
    assert.deepEqual(state.homeDraft.lastAcceptance, retryMainSnapshot.lastAcceptance,
      'retry preserves the main-owned accepted-turn snapshot');
    assert.equal(await evaluate(`document.querySelector('.composer textarea')?.value`), 'Home B restored after a failed save',
      'retry restores the unsaved editable text without changing its visible value');
    passed('Home draft retry keeps local text and main-owned file/acceptance metadata at an equal revision');

    await clickText('.sidebar-actions button', 'Новый чат');
    state.deferHomeDraftImports = true;
    const closeImportIndex = state.pendingHomeDraftImports.length;
    await click('button[aria-label="Прикрепить файл"]');
    await waitUntil('home import accepted before close', () => state.pendingHomeDraftImports.length === closeImportIndex + 1);
    const acceptedImport = state.pendingHomeDraftImports[closeImportIndex];
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
    const closeReturnsBeforeMixedDrain = state.closeReturnCalls;
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
    resolveHomeDraftImport(acceptedImport);
    await waitUntil('main close result after home import, settings, and config settle', async () => state.closeReadyCalls === closeCallsBeforeMixedDrain + 1
      || await evaluate(`document.querySelector('.close-error-dialog')?.open === true`));
    assert.equal(state.closeReadyCalls, closeCallsBeforeMixedDrain + 1,
      `close should reach main after all accepted operations settle; visible error: ${await evaluate(`document.querySelector('.close-error-dialog')?.textContent ?? ''`)}`);
    assert.equal((await mixedClose).status, 'failed');
    assert.equal(state.appSettings.theme, 'warm');
    assert.equal(state.configContents, 'allow = []\n');
    await waitDom('mixed operations close error', `document.querySelector('.close-error-dialog')?.open === true`);
    await capture('close-error-import-settings-config');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after mixed operations close error', async () => state.closeReturnCalls === closeReturnsBeforeMixedDrain + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));
    state.deferHomeDraftImports = false;
    state.deferSettingUpdates = false;
    state.deferConfigSaves = false;
    passed('Rendered close waits for a staged home file, settings, and config writes');

    await click('button.window-action[aria-label="Назад"]');
    await waitDom('home route after connection settings', `document.querySelector('.home-view')`);
    await clickChat('Chat B');
    await waitDom('chat route before connection settings', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    await click('.profile-settings-button');
    await clickText('.settings-nav-item', 'Подключение API');
    await waitDom('connection setup key input', `document.querySelector('#connection-key')`);
    state.deferKeySaves = true;
    await fillInput('#connection-key', 'synthetic-audit-key');
    await click('.connection-key-form button[type="submit"]');
    await waitUntil('accepted synthetic key save', () => state.pendingKeySaves.length === 1);
    const closeCallsBeforeKeyFailure = state.closeReadyCalls;
    const closeReturnsBeforeKeyFailure = state.closeReturnCalls;
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
    await waitUntil('resume after key save failure', async () => state.closeReturnCalls === closeReturnsBeforeKeyFailure + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));

    const closeReturnsBeforeBlockedKeyRetry = state.closeReturnCalls;
    const blockedKeyRetry = evaluate('window.gigaChat.auditRequestClose()');
    await waitDom('unresolved key failure blocks another close', `document.querySelector('.close-error-dialog')?.open === true`);
    assert.equal((await blockedKeyRetry).status, 'failed');
    assert.equal(state.closeReadyCalls, closeCallsBeforeKeyFailure, 'retry must not discard the retained failed key input');
    assert.equal(await evaluate(`document.querySelector('#connection-key')?.value`), 'synthetic-audit-key');
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after unresolved key retry', async () => state.closeReturnCalls === closeReturnsBeforeBlockedKeyRetry + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));

    await clickText('.settings-nav-item', 'Общие');
    await waitDom('key editor unmounted after leaving its settings section', `!document.querySelector('#connection-key')`);
    await clickText('.settings-nav-item', 'Подключение API');
    await waitDom('key editor remounted without stale failed draft', `document.querySelector('#connection-key')?.value === ''`);
    const closeReturnsBeforeKeyRemount = state.closeReturnCalls;
    const closeAfterKeyRemount = evaluate('window.gigaChat.auditRequestClose()');
    await waitUntil('close after key editor remount reaches main', () => state.closeReadyCalls === closeCallsBeforeKeyFailure + 1);
    assert.equal((await closeAfterKeyRemount).status, 'failed');
    await waitDom('main close failure after key editor remount', `document.querySelector('.close-error-dialog')?.open === true`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after key editor remount close', async () => state.closeReturnCalls === closeReturnsBeforeKeyRemount + 1
      && !(await evaluate(`document.querySelector('.close-error-dialog')?.open`)));

    state.deferKeySaves = false;
    await fillInput('#connection-key', 'synthetic-recovery-key');
    await click('.connection-key-form button[type="submit"]');
    await waitDom('successful explicit key save clears input', `document.querySelector('#connection-key')?.value === ''`);
    assert.equal(state.keySaveCalls, 2, 'only explicit synthetic save attempts should reach the fake secure store');
    const closeReturnsBeforeKeySave = state.closeReturnCalls;
    const closeAfterKeySave = evaluate('window.gigaChat.auditRequestClose()');
    await waitUntil('close reaches main after successful key save', () => state.closeReadyCalls === closeCallsBeforeKeyFailure + 2);
    assert.equal((await closeAfterKeySave).status, 'failed');
    await waitDom('synthetic main close failure after successful key save', `document.querySelector('.close-error-dialog')?.open === true`);
    await clickText('.close-error-dialog button', 'Вернуться к работе');
    await waitUntil('resume after successful key save close attempt', async () => state.closeReturnCalls === closeReturnsBeforeKeySave + 1
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

    const homeVoiceChatsBefore = state.chats.length;
    const homeVoiceSendsBefore = state.homeDraftSendCalls.length;
    const homeVoiceRecordersBefore = await evaluate('window.__auditVoiceMedia.recorders.length');
    const homeVoiceTranscribesBefore = state.voiceTranscribeCalls.length;
    await clickText('.sidebar-actions button', 'Новый чат');
    await waitDom('home draft before synthetic voice insertion', `document.querySelector('.home-view') && !document.querySelector('.composer textarea')?.disabled`);
    await click('.mic-button');
    await waitUntil('synthetic home recording starts', async () => await evaluate('window.__auditVoiceMedia.recorders.length') === homeVoiceRecordersBefore + 1
      && await evaluate(`document.querySelector('.voice-capture')?.classList.contains('is-recording')`));
    await click('.mic-button');
    await waitUntil('home transcript reaches the local draft', () => state.voiceTranscribeCalls.length === homeVoiceTranscribesBefore + 1);
    await waitDom('synthetic home transcript is inserted without Send', `document.querySelector('.home-view')
      && document.querySelector('.composer textarea')?.value.includes('Synthetic dictation ready.')`);
    await waitUntil('synthetic voice transcript autosaves to home draft', () => state.homeDraft.text.includes('Synthetic dictation ready.'));
    assert.equal(state.chats.length, homeVoiceChatsBefore, 'voice transcription does not create a chat');
    assert.equal(state.homeDraftSendCalls.length, homeVoiceSendsBefore, 'voice transcription does not call Send');
    passed('Rendered voice transcript stays in the persistent home draft until explicit Send');

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
    const syntheticHook = {
      id: 'global/review-check', name: 'Review check', description: 'Synthetic renderer Hook record.',
      event: 'session-start', origin: 'global', scope: 'Global', owner: 'user', ownerId: null,
      source: 'synthetic', enabled: false, trusted: false, available: true,
      contentHash: 'e'.repeat(64), actionFile: 'action.ps1', unavailableReason: '',
    };
    state.hookRegistry = { hooks: [syntheticHook], issues: [] };
    await clickText('.settings-nav-item', 'Hooks');
    await waitDom('Hooks registry and trust action render', `document.querySelector('.settings-nav-item.active')?.textContent.includes('Hooks')
      && document.querySelector('.settings-list')?.textContent.includes('Review check')`);
    await clickText('.settings-list button', 'Просмотреть');
    await waitDom('Hook content and matching hash are reviewed', `document.querySelector('.skill-source[open]')?.textContent.includes('${syntheticHook.contentHash}')
      && document.querySelector('.settings-list')?.textContent.includes('Synthetic renderer fixture')`);
    await clickText('.settings-list button', 'Доверять этой версии');
    await waitUntil('reviewed Hook trust uses the inspected content hash', () => state.hookCalls.some((item) => item.method === 'trust' && item.id === syntheticHook.id)
      && state.hookRegistry.hooks[0]?.trusted === true);
    await waitDom('trusted Hook can be enabled separately', `document.querySelector('.settings-list')?.textContent.includes('Доверен, выключен')
      && document.querySelector('input[aria-label="Включить Hook Review check"]')`);
    await click('input[aria-label="Включить Hook Review check"]');
    await waitUntil('Hook enablement uses its separate settings operation', () => state.hookCalls.some((item) => item.method === 'setEnabled' && item.id === syntheticHook.id && item.enabled === true)
      && state.hookRegistry.hooks[0]?.enabled === true);
    await waitDom('Hook status reflects enabled state', `document.querySelector('.settings-list')?.textContent.includes('Включён')`);
    passed('Renderer presents synthetic Hook inspection, trust, and separate enablement; execution is covered by hook fixtures');
    await click('button.window-action[aria-label="Назад"]');
    await waitDom('Chat B restored after Settings choice test', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    window.webContents.setZoomFactor(originalChoiceZoom);
    window.setSize(originalChoiceWindowSize[0], originalChoiceWindowSize[1]);
    await sleep(350);
    passed('Rendered settings choices preserve disabled/empty values, keyboard/focus, themed viewport-clamped popovers, and switch symmetry');
    await click('button[aria-label="Показать браузер"]');
    await waitDom('browser pane with its synthetic page', `document.querySelector('.browser-header-cell .browser-tab button[title="Synthetic page"]')`);
    await click('button[aria-label="Развернуть на всю рабочую область"]');
    await waitDom('combined chat and browser workspace tabs', `document.querySelector('.browser-workspace.is-full.surface-browser #workspace-chat-tab')`);
    await click('#workspace-chat-tab');
    await waitDom('chat surface selected in full workspace', `document.querySelector('.browser-workspace.surface-chat')`);

    console.log('Plan009 browser check: resolve newTab from the chat surface');
    state.deferBrowserMethod = 'newTab';
    await click('.browser-new-tab');
    await waitUntil('new-tab request deferred from full chat surface', () => state.pendingBrowserActions.some((item) => item.method === 'newTab'));
    const focusAddressRequest = state.pendingBrowserActions.findLast((item) => item.method === 'newTab');
    const focusAddressTab = makeBrowserTab('deferred-focus-tab', 'Deferred focus page', 'https://focus.example.test/');
    resolveBrowserAction(focusAddressRequest, { ...state.browserStatus, tabs: [...state.browserStatus.tabs, focusAddressTab], activeTabId: focusAddressTab.id });
    await waitDom('successful new tab switches to browser surface', `document.querySelector('.browser-workspace.is-full.surface-browser') && document.querySelector('#browser-tab-deferred-focus-tab')`);
    await waitUntil('successful new tab focuses its address field', () => evaluate(`document.activeElement === document.querySelector('.browser-address input')`));
    passed('Full-view new tab changes to browser only after success and focuses its address field');

    console.log('Plan009 browser check: stale success after switching surfaces');
    await click('#workspace-chat-tab');
    await waitDom('chat surface selected before stale success', `document.querySelector('.browser-workspace.is-full.surface-chat')`);
    state.deferBrowserMethod = 'newTab';
    await click('.browser-new-tab');
    await waitUntil('second new-tab request deferred from chat surface', () => state.pendingBrowserActions.filter((item) => item.method === 'newTab').length === 2);
    const staleSuccessRequest = state.pendingBrowserActions.findLast((item) => item.method === 'newTab');
    await click('#browser-tab-audit-browser-tab');
    await waitDom('browser surface selected while new tab is pending', `document.querySelector('.browser-workspace.surface-browser')`);
    await click('#workspace-chat-tab');
    await waitDom('chat surface restored before new-tab success', `document.querySelector('.browser-workspace.surface-chat')`);
    assert.equal(await evaluate(`(() => { const tab = document.querySelector('#workspace-chat-tab'); tab?.focus(); return document.activeElement === tab; })()`), true, 'test must focus the selected chat tab before resolving a stale action');
    const staleSuccessTab = makeBrowserTab('deferred-stale-tab', 'Deferred stale page', 'https://stale.example.test/');
    resolveBrowserAction(staleSuccessRequest, { ...state.browserStatus, tabs: [...state.browserStatus.tabs, staleSuccessTab], activeTabId: staleSuccessTab.id });
    await waitDom('late successful status still updates the browser tab list', `document.querySelector('#browser-tab-deferred-stale-tab')`);
    await sleep(80);
    assert.equal(await evaluate(`Boolean(document.querySelector('.browser-workspace.is-full.surface-chat'))`), true, 'late new-tab success must not steal the selected chat surface');
    assert.equal(await evaluate(`document.activeElement?.id`), 'workspace-chat-tab', 'late new-tab success must not steal focus from the chat tab');
    passed('Late new-tab success updates browser status without stealing chat surface or focus');

    console.log('Plan009 browser check: failed activation remains visible on chat');
    state.deferBrowserMethod = 'activateTab';
    await click('#browser-tab-audit-browser-tab-2');
    await waitUntil('tab activation deferred while chat surface stays selected', () => state.pendingBrowserActions.some((item) => item.method === 'activateTab'));
    const failedActivation = state.pendingBrowserActions.findLast((item) => item.method === 'activateTab');
    failedActivation.reject(new Error('Synthetic deferred tab activation failure'));
    await waitDom('failed activation stays on chat and exposes an accessible error', `document.querySelector('.browser-workspace.is-full.surface-chat') && document.querySelector('.browser-surface-error[role="alert"]')?.textContent.includes('Synthetic deferred tab activation failure')`);
    passed('Failed activation preserves the chat surface and shows its error accessibly');

    console.log('Plan009 browser check: deferred failure after route unmount');
    await click('#browser-tab-audit-browser-tab');
    await waitDom('browser surface restored after failed activation', `document.querySelector('.browser-workspace.surface-browser')`);
    await click('#workspace-chat-tab');
    await waitDom('chat surface restored before route unmount', `document.querySelector('.browser-workspace.surface-chat')`);
    state.deferBrowserMethod = 'newTab';
    await click('.browser-new-tab');
    await waitUntil('new-tab request pending before route unmount', () => state.pendingBrowserActions.filter((item) => item.method === 'newTab').length === 3);
    const unmountedRequest = state.pendingBrowserActions.findLast((item) => item.method === 'newTab');
    await click('.profile-settings-button');
    await waitDom('settings route unmounts the browser workspace', `!document.querySelector('.browser-workspace') && document.querySelector('.settings-nav-item')`);
    unmountedRequest.reject(new Error('Synthetic failure after browser route unmount'));
    await click('button.window-action[aria-label="Назад"]');
    await waitDom('chat and browser workspace remount after route return', `document.querySelector('.browser-workspace') && document.querySelector('.browser-header-cell')`);
    assert.equal(await evaluate(`document.querySelector('.browser-surface-error')`), null, 'an error arriving after route unmount must not leak into the next browser presentation');
    passed('Browser async failure after route unmount does not leak into the next presentation');

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
    assert.equal(await evaluate(`document.querySelector('.browser-header-cell .browser-tab button[title="Synthetic page"]')?.getAttribute('aria-selected')`), 'true',
      'the browser tab must remain mounted and active after menus close');
    await click('button[aria-label="Скрыть браузер"]');
    await waitDom('browser pane unmounted after explicit close', `!document.querySelector('.browser-pane')`);
    assert.equal(state.browserBoundsCalls.at(-1), null, 'unmount must leave no native bounds token behind');

    console.log('Plan009 browser check: empty, one, several, and twenty tabs with keyboard selection');
    const browserStatusBeforeMatrix = clone(state.browserStatus);
    const browserMatrixWindowSize = window.getSize();
    const browserMatrixZoom = window.webContents.getZoomFactor();
    const publishBrowserStatus = async (next) => {
      state.browserStatus = clone(next);
      window.webContents.send('audit:browser', clone(state.browserStatus));
      await sleep(50);
    };
    const setMainWorkspaceWidth = async (targetWidth, zoom = 1) => {
      window.webContents.setZoomFactor(zoom);
      await sleep(350);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const currentWidth = Number(await evaluate(`document.querySelector('.browser-workspace')?.getBoundingClientRect().width ?? 0`));
        if (Math.abs(currentWidth - targetWidth) <= 0.5) break;
        const [outerWidth, outerHeight] = window.getSize();
        window.setSize(Math.max(400, outerWidth + Math.round((targetWidth - currentWidth) * zoom)), outerHeight);
        await sleep(350);
      }
      const metrics = JSON.parse(await evaluate(`JSON.stringify((() => {
        const workspace = document.querySelector('.browser-workspace')?.getBoundingClientRect();
        const header = document.querySelector('.chat-header')?.getBoundingClientRect();
        const actions = document.querySelector('.workspace-header-actions')?.getBoundingClientRect();
        const toggle = document.querySelector('.chat-browser-toggle')?.getBoundingClientRect();
        const expand = document.querySelector('.workspace-expand-toggle')?.getBoundingClientRect();
        const tabs = document.querySelector('.browser-tablist')?.getBoundingClientRect();
        const firstTab = document.querySelector('.browser-tab')?.getBoundingClientRect();
        const browserHeader = document.querySelector('.browser-header-cell')?.getBoundingClientRect();
        const chatHeading = document.querySelector('.chat-heading-cell')?.getBoundingClientRect();
        return {
          workspaceWidth: workspace?.width ?? null,
          innerWidth,
          full: document.querySelector('.browser-workspace')?.classList.contains('is-full') ?? false,
          headerCenter: header ? header.top + header.height / 2 : null,
          actionCenter: actions ? actions.top + actions.height / 2 : null,
          actionRightGap: header && actions ? header.right - actions.right : null,
          actionsLeft: actions?.left ?? null,
          toggle: toggle ? { left: toggle.left, right: toggle.right, top: toggle.top, width: toggle.width, height: toggle.height } : null,
          expand: expand ? { left: expand.left, right: expand.right, top: expand.top, width: expand.width, height: expand.height } : null,
          tablist: tabs ? { left: tabs.left, right: tabs.right, width: tabs.width } : null,
          firstTab: firstTab ? { top: firstTab.top, height: firstTab.height } : null,
          browserHeaderLeft: browserHeader?.left ?? null,
          chatHeadingRight: chatHeading?.right ?? null,
          chatTabCount: document.querySelectorAll('#workspace-chat-tab[role="tab"]').length,
          browserTabCount: document.querySelectorAll('.browser-tablist [data-browser-tab-id]').length,
          scrollWidth: document.querySelector('.browser-tablist')?.scrollWidth ?? null,
          clientWidth: document.querySelector('.browser-tablist')?.clientWidth ?? null,
        };
      })())`));
      assert.ok(Math.abs(metrics.workspaceWidth - targetWidth) <= 2, `main browser workspace should be ${targetWidth}px CSS; actual ${metrics.workspaceWidth}, metrics=${JSON.stringify(metrics)}`);
      assert.ok(Math.abs(metrics.actionCenter - metrics.headerCenter) <= 1, `header actions should be vertically centered within 1 CSS px: ${JSON.stringify(metrics)}`);
      assert.ok(Math.abs(metrics.actionRightGap - 12) <= 1, `header actions should remain 12px from the right edge: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.expand && metrics.toggle && metrics.expand.left < metrics.toggle.left, `expand action must precede the rightmost browser toggle: ${JSON.stringify(metrics)}`);
      assert.ok([metrics.expand, metrics.toggle].every((box) => Math.abs(box.width - 34) <= 0.2 && Math.abs(box.height - 34) <= 0.2), `header action hitboxes should remain 34px: ${JSON.stringify(metrics)}`);
      if (metrics.firstTab) assert.ok(Math.abs(metrics.firstTab.top + metrics.firstTab.height / 2 - metrics.headerCenter) <= 1, `tab frame should share the header center: ${JSON.stringify(metrics)}`);
      if (!metrics.full) assert.ok(Math.abs(metrics.browserHeaderLeft - metrics.chatHeadingRight) <= 1, `split header cells should meet at one divider: ${JSON.stringify(metrics)}`);
      if (metrics.tablist && metrics.actionsLeft !== null) assert.ok(metrics.tablist.right <= metrics.actionsLeft + 1, `scrolling tabs must stop before fixed header actions: ${JSON.stringify(metrics)}`);
      return metrics;
    };

    await click('button[aria-label="Показать браузер"]');
    await waitDom('browser pane reopens for tab matrix', `document.querySelector('.browser-workspace.browser-open')`);
    await setMainWorkspaceWidth(1408);
    const emptyStatus = { tabs: [], activeTabId: null, error: 'Синтетическая ошибка браузера' };
    await publishBrowserStatus(emptyStatus);
    await click('button[aria-label="Развернуть на всю рабочую область"]');
    await waitDom('empty browser status remains in full workspace', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
    await waitDom('empty browser error is visible', `document.querySelector('.browser-message[role="alert"]')?.textContent.includes('Синтетическая ошибка браузера')`);
    assert.equal(await evaluate(`document.querySelectorAll('.browser-tablist [role="tab"]').length`), 1, 'with zero browser tabs, the chat tab remains the one workspace tab');
    await click('#workspace-chat-tab');
    await waitDom('empty browser status keeps the chat surface selected', `document.querySelector('.browser-workspace.is-full.surface-chat') && document.querySelector('#workspace-chat-tab[aria-selected="true"]')`);
    await click('button[aria-label="Выйти из режима полного просмотра"]');
    await waitDom('empty status returns to split with its alert', `!document.querySelector('.browser-workspace.is-full') && document.querySelector('.browser-message[role="alert"]')`);
    await publishBrowserStatus({ tabs: [], activeTabId: null, error: null });
    await waitDom('empty browser status shows the address hint', `document.querySelector('.browser-message')?.textContent.includes('Введите адрес сайта') && !document.querySelector('.browser-message[role="alert"]')`);

    const longCyrillicTitle = 'Очень длинная вкладка браузера с русским названием и дополнительным пояснением для проверки многоточия';
    const longCyrillicUrl = `https://пример.рф/длинный-путь/${'проверка-длинного-адреса/'.repeat(8)}`;
    const oneTab = makeBrowserTab('matrix-01', longCyrillicTitle, longCyrillicUrl);
    await publishBrowserStatus({ tabs: [oneTab], activeTabId: oneTab.id, error: null });
    await waitDom('one browser tab renders its Cyrillic title and address', `document.querySelector('#browser-tab-matrix-01') && document.querySelector('.browser-address input')?.value === ${JSON.stringify(longCyrillicUrl)}`);
    const oneTabGeometry = JSON.parse(await evaluate(`JSON.stringify((() => {
      const button = document.querySelector('#browser-tab-matrix-01');
      const label = button?.querySelector('span');
      const address = document.querySelector('.browser-address input');
      return { title: button?.title, label: label?.textContent, labelClientWidth: label?.clientWidth, labelScrollWidth: label?.scrollWidth, address: address?.value, active: button?.getAttribute('aria-current') };
    })())`));
    assert.equal(oneTabGeometry.title, longCyrillicTitle);
    assert.equal(oneTabGeometry.label, longCyrillicTitle);
    assert.ok(oneTabGeometry.labelScrollWidth > oneTabGeometry.labelClientWidth, `long Cyrillic browser title should ellipsize inside its tab: ${JSON.stringify(oneTabGeometry)}`);
    assert.equal(oneTabGeometry.address, longCyrillicUrl, 'the long Cyrillic URL remains available in the address field');
    assert.equal(oneTabGeometry.active, 'page');

    const severalTabs = [oneTab, ...Array.from({ length: 2 }, (_, index) => makeBrowserTab(`matrix-0${index + 2}`, `Вкладка ${index + 2}`, `https://пример.рф/страница-${index + 2}`))];
    await publishBrowserStatus({ tabs: severalTabs, activeTabId: 'matrix-02', error: null });
    await waitDom('several browser tabs publish the selected tab', `document.querySelectorAll('.browser-tablist [data-browser-tab-id]').length === 3 && document.querySelector('#browser-tab-matrix-02[aria-selected="true"]')`);
    assert.equal(await evaluate(`document.querySelectorAll('.browser-tablist [aria-selected="true"]').length`), 1, 'a single browser tab remains selected among several tabs');

    await click('button[aria-label="Развернуть на всю рабочую область"]');
    await waitDom('one full browser surface before twenty-tab matrix', `document.querySelector('.browser-workspace.is-full.surface-browser')`);
    const twentyTabs = Array.from({ length: 20 }, (_, index) => makeBrowserTab(
      `matrix-${String(index + 1).padStart(2, '0')}`,
      index === 0 ? longCyrillicTitle : `Вкладка браузера ${index + 1}`,
      index === 19 ? longCyrillicUrl : `https://пример.рф/страница-${index + 1}`,
    ));
    await publishBrowserStatus({ tabs: twentyTabs, activeTabId: 'matrix-20', error: null });
    await waitDom('twenty browser tabs render beside the separate chat tab', `document.querySelectorAll('.browser-tablist [data-browser-tab-id]').length === 20 && document.querySelectorAll('.browser-tablist [role="tab"]').length === 21 && document.querySelector('#workspace-chat-tab[role="tab"]')`);
    const twentyTabGeometry = JSON.parse(await evaluate(`JSON.stringify((() => {
      const list = document.querySelector('.browser-tablist');
      const header = document.querySelector('.chat-header')?.getBoundingClientRect();
      const actions = document.querySelector('.workspace-header-actions')?.getBoundingClientRect();
      const selected = [...document.querySelectorAll('.browser-tablist [aria-selected="true"]')].map((tab) => tab.id);
      return { browserTabs: list?.querySelectorAll('[data-browser-tab-id]').length, allTabs: list?.querySelectorAll('[role="tab"]').length, scrollWidth: list?.scrollWidth, clientWidth: list?.clientWidth, selected, actionsCenter: actions ? actions.top + actions.height / 2 : null, headerCenter: header ? header.top + header.height / 2 : null, address: document.querySelector('.browser-address input')?.value };
    })())`));
    assert.equal(twentyTabGeometry.browserTabs, 20);
    assert.equal(twentyTabGeometry.allTabs, 21, 'the chat surface is outside the twenty-browser-tab limit');
    assert.ok(twentyTabGeometry.scrollWidth > twentyTabGeometry.clientWidth, `twenty tabs should scroll horizontally without covering the actions: ${JSON.stringify(twentyTabGeometry)}`);
    assert.deepEqual(twentyTabGeometry.selected, ['browser-tab-matrix-20']);
    assert.equal(twentyTabGeometry.address, longCyrillicUrl);
    assert.ok(Math.abs(twentyTabGeometry.actionsCenter - twentyTabGeometry.headerCenter) <= 1, 'the fixed actions stay centered beside the long tab strip');
    await capture('browser-workspace-twenty-tabs-cyrillic');

    await click('#workspace-chat-tab');
    await waitDom('keyboard matrix starts with selected chat tab', `document.querySelector('.browser-workspace.is-full.surface-chat') && document.querySelector('#workspace-chat-tab[aria-selected="true"]')`);
    await evaluate(`document.querySelector('#workspace-chat-tab')?.focus()`);
    await sendKey('RIGHT');
    await waitUntil('ArrowRight moves focus into browser tabs without selection', () => evaluate(`document.activeElement?.id === 'browser-tab-matrix-01'`));
    assert.equal(await evaluate(`document.querySelector('#workspace-chat-tab')?.getAttribute('aria-selected')`), 'true', 'arrow navigation must not activate a tab');
    await sendKey('LEFT');
    await waitUntil('ArrowLeft returns focus to the chat tab', () => evaluate(`document.activeElement?.id === 'workspace-chat-tab'`));
    await sendKey('END');
    await waitUntil('End moves focus to the final browser tab without selection', () => evaluate(`document.activeElement?.id === 'browser-tab-matrix-20'`));
    assert.equal(await evaluate(`document.querySelector('#browser-tab-matrix-20')?.getAttribute('aria-selected')`), 'false', 'End only moves focus under manual tab activation');
    window.show();
    window.focus();
    window.webContents.focus();
    await sleep(80);
    const enterStart = JSON.parse(await evaluate(`JSON.stringify((() => {
      const target = document.querySelector('#browser-tab-matrix-20');
      const trace = [];
      for (const type of ['keydown', 'keypress', 'keyup', 'click']) document.addEventListener(type, (event) => {
        const origin = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
        if (origin?.id === 'browser-tab-matrix-20') trace.push({ type, key: event.key, code: event.code, keyCode: event.keyCode, trusted: event.isTrusted });
      }, true);
      window.__auditBrowserEnterTrace = trace;
      target?.focus();
      return { activeId: document.activeElement?.id, selected: target?.getAttribute('aria-selected') };
    })())`));
    assert.equal(enterStart.activeId, 'browser-tab-matrix-20', `Enter probe must begin with the final tab focused: ${JSON.stringify(enterStart)}`);
    const enterWindowFocused = window.isFocused();
    await sendKey('ENTER');
    const enterWithoutChar = JSON.parse(await evaluate(`JSON.stringify({
      activeId: document.activeElement?.id,
      selected: document.querySelector('#browser-tab-matrix-20')?.getAttribute('aria-selected'),
      surface: document.querySelector('.browser-workspace')?.className,
      events: window.__auditBrowserEnterTrace,
    })`));
    console.log(`Plan009 native Enter input evidence ${JSON.stringify({ windowFocused: enterWindowFocused, ...enterWithoutChar })}`);
    if (enterWithoutChar.selected !== 'true') {
      await sendNativeButtonKey('ENTER', '\r');
      console.log(`Plan009 complete Enter input evidence ${JSON.stringify(await evaluate(`JSON.stringify({ activeId: document.activeElement?.id, selected: document.querySelector('#browser-tab-matrix-20')?.getAttribute('aria-selected'), events: window.__auditBrowserEnterTrace })`))}`);
    }
    await waitDom('Enter activates the focused final browser tab', `document.querySelector('.browser-workspace.is-full.surface-browser') && document.querySelector('#browser-tab-matrix-20[aria-selected="true"]')`);
    await sendKey('HOME');
    await waitUntil('Home returns focus to chat without changing selection', () => evaluate(`document.activeElement?.id === 'workspace-chat-tab'`));
    assert.equal(await evaluate(`document.querySelector('#browser-tab-matrix-20')?.getAttribute('aria-selected')`), 'true', 'Home only moves focus under manual tab activation');
    await sendNativeButtonKey('SPACE', ' ');
    await waitDom('Space activates the focused chat tab', `document.querySelector('.browser-workspace.is-full.surface-chat') && document.querySelector('#workspace-chat-tab[aria-selected="true"]')`);

    await evaluate(`document.querySelector('#browser-tab-matrix-20')?.closest('.browser-tab')?.querySelector('.browser-tab-close')?.focus()`);
    assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Закрыть вкладку Вкладка браузера 20'`), true, 'focused close action is inside the final tab');
    await sendNativeButtonKey('ENTER', '\r');
    await waitUntil('closing the focused tab restores focus to its selected neighbor', () => evaluate(`document.querySelectorAll('.browser-tablist [data-browser-tab-id]').length === 19 && document.activeElement?.id === 'browser-tab-matrix-01' && document.querySelector('#browser-tab-matrix-01[aria-selected="true"]') !== null`));
    await click('.browser-new-tab');
    await waitDom('new browser tab restores the twenty-tab count after close', `document.querySelectorAll('.browser-tablist [data-browser-tab-id]').length === 20`);
    passed('Renderer covers 0/1/3/20 browser tabs, Cyrillic title/URL, roving keyboard focus, manual activation, close focus, and new-tab recovery');

    await click('button[aria-label="Выйти из режима полного просмотра"]');
    await waitDom('width matrix returns to non-expanded split mode', `!document.querySelector('.browser-workspace.is-full') && document.querySelector('.browser-pane')`);
    const browserWidthMatrix = [];
    for (const { width, zoom } of [{ width: 1408, zoom: 1 }, { width: 1200, zoom: 0.8 }, { width: 880, zoom: 1 }, { width: 879, zoom: 1.25 }, { width: 560, zoom: 1 }]) {
      if (width === 560) {
        await click('button[aria-label="Скрыть боковую панель"]');
        await waitUntil('sidebar hides before the narrow 560px workspace measurement', () => state.appSettings.sidebarVisible === false && evaluate(`document.querySelector('.workspace.sidebar-hidden') !== null`));
        await sleep(300);
      }
      const metrics = await setMainWorkspaceWidth(width, zoom);
      const automaticFull = metrics.workspaceWidth < 880;
      await waitDom(`workspace width ${width} selects the expected split/full state`, automaticFull
        ? `document.querySelector('.browser-workspace.is-full')`
        : `!document.querySelector('.browser-workspace.is-full')`);
      assert.equal(await evaluate(`document.querySelector('.workspace-expand-toggle')?.getAttribute('aria-pressed')`), 'false', `automatic narrow full view at ${width}px must not claim explicit full mode`);
      assert.equal(metrics.chatTabCount, automaticFull ? 1 : 0, `chat tab role must follow effective full view at ${width}px`);
      assert.ok(metrics.browserTabCount === 20, `the browser tab strip retains all 20 entries at ${width}px`);
      browserWidthMatrix.push({ target: width, zoom, ...metrics });
      if (width === 879) await capture('browser-workspace-narrow-879');
    }

    await setMainWorkspaceWidth(1200, 1);
    await waitDom('wide browser layout restores after the compact-width sample', `!document.querySelector('.workspace.compact-workspace')`);
    await click('button[aria-label="Показать боковую панель"]');
    await waitUntil('sidebar returns to pinned mode after the 560px narrow sample', () => state.appSettings.sidebarVisible === true && evaluate(`!document.querySelector('.workspace')?.classList.contains('sidebar-hidden')`));
    const pinnedWidthMetrics = await setMainWorkspaceWidth(1200, 1);
    const pinnedWidth = pinnedWidthMetrics.workspaceWidth;
    await click('button[aria-label="Скрыть боковую панель"]');
    await waitUntil('sidebar hidden state widens the browser workspace', () => state.appSettings.sidebarVisible === false && evaluate(`document.querySelector('.workspace.sidebar-hidden') !== null`));
    await sleep(300);
    const hiddenWidth = Number(await evaluate(`document.querySelector('.browser-workspace')?.getBoundingClientRect().width ?? 0`));
    assert.ok(hiddenWidth >= pinnedWidth + 200, `hiding the pinned sidebar should expose its workspace width: pinned=${pinnedWidth}, hidden=${hiddenWidth}`);
    const movePointerTo = async (selector) => {
      const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
      assert.ok(point, `mouse target exists: ${selector}`);
      const zoom = window.webContents.getZoomFactor();
      window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) });
    };
    await movePointerTo('button[aria-label="Показать боковую панель"]');
    await waitDom('hidden desktop sidebar opens its hover preview', `document.querySelector('.workspace.sidebar-preview') && document.querySelector('#application-sidebar[aria-hidden="false"]')`);
    await waitUntil('native browser bounds suspend for sidebar preview', () => state.browserBoundsCalls.at(-1) === null);
    await movePointerTo('.browser-header-cell');
    await waitUntil('sidebar preview closes after pointer leaves', () => evaluate(`!document.querySelector('.workspace')?.classList.contains('sidebar-preview')`), 1200);
    await waitUntil('browser bounds restore after sidebar preview closes', () => state.browserBoundsCalls.at(-1)?.width > 0);
    await click('button[aria-label="Показать боковую панель"]');
    await waitUntil('sidebar returns to pinned mode', () => state.appSettings.sidebarVisible === true && evaluate(`!document.querySelector('.workspace')?.classList.contains('sidebar-hidden')`));
    await publishBrowserStatus(browserStatusBeforeMatrix);
    window.webContents.setZoomFactor(browserMatrixZoom);
    window.setSize(browserMatrixWindowSize[0], browserMatrixWindowSize[1]);
    await sleep(360);
    await click('button[aria-label="Скрыть браузер"]');
    await waitUntil('browser pane closes after workspace matrix', () => evaluate(`!document.querySelector('.browser-pane')`), 1500);
    assert.equal(state.appSettings.sidebarVisible, true, 'the matrix restores the pinned sidebar setting');
    assert.deepEqual(state.browserStatus, browserStatusBeforeMatrix, 'the matrix restores the synthetic browser status');
    console.log(`Rendered browser workspace matrix ${JSON.stringify({ widths: browserWidthMatrix.map(({ target, zoom, workspaceWidth, innerWidth, full, chatTabCount, browserTabCount, scrollWidth, clientWidth }) => ({ target, zoom, workspaceWidth, innerWidth, full, chatTabCount, browserTabCount, scrollWidth, clientWidth })), oneTabGeometry, twentyTabGeometry, pinnedWidth, hiddenWidth })}`);
    passed('Renderer verifies main widths 1408/1200/880/879/560 at paired zooms, header alignment, and pinned/hidden/preview sidebar states');

    const themeChat = state.details.get('chat-b');
    const themeAnchor = { id: 'stage4-theme-user', role: 'user', text: 'йоу', createdAt: timestamp };
    const themeAnswer = { id: 'stage4-theme-answer', role: 'assistant', source: 'runtime', text: 'Ответ остаётся на ширине чата.', createdAt: timestamp };
    themeChat.messages.push(themeAnchor, themeAnswer);
    const longUserTranscriptText = `Длинный русский запрос остаётся компактно выровненным справа и переносится по доступной ширине.\n\nURL: https://example.test/very/long/user/request?query=проверка&mode=responsive\n\nКод: const request = { chatId: "stage4-layout", includeHistory: true };`;
    const longTranscriptText = `Длинное сообщение на русском сохраняет строки и переносится по доступной ширине.\n\nURL: https://example.test/very/long/path/for/a/transcript-layout-check?query=проверка&mode=responsive\n\nКод: const result = await client.request({ chatId: "stage4-layout", retry: false });`;
    for (let index = 0; index < 28; index += 1) {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      themeChat.messages.push({
        id: `stage4-theme-history-${index + 1}`,
        role,
        ...(role === 'assistant' ? { source: 'runtime' } : {}),
        text: index === 26 ? longUserTranscriptText : index === 27 ? longTranscriptText : `Сообщение ${index + 1} из длинного synthetic диалога.`,
        createdAt: timestamp,
      });
    }
    const navigationUser = {
      id: 'stage5-navigation-user', role: 'user',
      text: 'Проверь, как навигация сохраняет положение при продолжении ответа.', createdAt: timestamp,
    };
    themeChat.messages.push(navigationUser);
    themeChat.turns.push({
      turnId: 'stage4-theme-turn', anchorMessageId: themeAnchor.id, assistantMessageId: themeAnswer.id,
      modelId: 'GigaChat-3-Ultra', status: 'completed', createdAt: timestamp, startedAt: timestamp, endedAt: timestamp,
      queueDurationMs: 140, activeDurationMs: 2000, activity: [{ kind: 'provider', at: timestamp, activity: 'receiving' }],
    });
    const verifyStage5Navigation = async (name) => {
      const expectedUserIds = themeChat.messages.filter((message) => message.role === 'user').map((message) => message.id);
      const inspectRail = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
        const area = document.querySelector('.view-area.chat-view-area');
        const nav = document.querySelector('.chat-navigation');
        const list = document.querySelector('.chat-navigation-list');
        const history = document.querySelector('.chat-history');
        const composer = document.querySelector('.composer-stack');
        const box = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const buttons = [...document.querySelectorAll('.chat-navigation-mark')];
        const preview = document.querySelector('.chat-navigation-preview');
        return {
          area: box(area), nav: box(nav), list: { ...box(list), scrollHeight: list?.scrollHeight ?? 0,
            clientHeight: list?.clientHeight ?? 0, maxHeight: Number.parseFloat(getComputedStyle(list).maxHeight) || 0,
            contentHeight: area?.scrollHeight ?? 0, viewportHeight: area?.clientHeight ?? 0 },
          history: box(history), composer: box(composer),
          userIds: [...document.querySelectorAll('.chat-history .transcript-message.message-user[data-message-id]')].map((message) => message.dataset.messageId),
          marks: buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            const bar = button.querySelector('.chat-navigation-mark-bar');
            return { id: button.dataset.navigationMessageId, top: rect.top, bottom: rect.bottom, height: rect.height,
              width: bar?.getBoundingClientRect().width ?? 0, tabIndex: button.tabIndex,
              color: bar ? getComputedStyle(bar).backgroundColor : null,
              expanded: button.classList.contains('expanded'), focused: button.classList.contains('focused') };
          }),
          previewText: preview?.textContent ?? null,
          preview: box(preview),
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          rightScrollbarButton: area ? getComputedStyle(area, '::-webkit-scrollbar-button').display : null,
        };
      })())`));
      const targetOffset = async (messageId) => {
        const value = await evaluate(`(() => {
          const area = document.querySelector('.view-area.chat-view-area');
          const target = [...document.querySelectorAll('.chat-history .transcript-message[data-message-id]')]
            .find((message) => message.dataset.messageId === ${JSON.stringify(messageId)});
          return area && target ? target.getBoundingClientRect().top - area.getBoundingClientRect().top : null;
        })()`);
        return value === null ? null : Number(value);
      };
      const inspectTargetGeometry = async (messageId) => JSON.parse(await evaluate(`JSON.stringify((() => {
        const area = document.querySelector('.view-area.chat-view-area');
        const target = [...document.querySelectorAll('.chat-history .transcript-message[data-message-id]')]
          .find((message) => message.dataset.messageId === ${JSON.stringify(messageId)});
        if (!area || !target) return null;
        const areaRect = area.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const currentOffset = targetRect.top - areaRect.top;
        const requestedScrollTop = area.scrollTop + currentOffset - 58;
        const maxScrollTop = Math.max(0, area.scrollHeight - area.clientHeight);
        const destinationScrollTop = Math.max(0, Math.min(requestedScrollTop, maxScrollTop));
        return {
          messageId: target.dataset.messageId, currentOffset, expectedOffset: currentOffset - (destinationScrollTop - area.scrollTop),
          scrollTop: area.scrollTop, requestedScrollTop, destinationScrollTop, maxScrollTop,
          ownerTop: areaRect.top, ownerBottom: areaRect.bottom, ownerHeight: area.clientHeight,
          targetTop: targetRect.top, targetBottom: targetRect.bottom,
          wasClamped: Math.abs(destinationScrollTop - requestedScrollTop) > 0.5,
        };
      })())`));
      const navigationExpectedOffset = async (messageId, label) => {
        const geometry = await inspectTargetGeometry(messageId);
        assert.equal(geometry?.messageId, messageId,
          `${label}: target is present before navigation: ${JSON.stringify(geometry)}`);
        assert.ok(!geometry.wasClamped || geometry.destinationScrollTop <= 1
          || Math.abs(geometry.destinationScrollTop - geometry.maxScrollTop) <= 1,
        `${label}: a bounded target offset is caused by an actual scroll boundary: ${JSON.stringify(geometry)}`);
        return geometry.expectedOffset;
      };
      const waitForTargetOffset = async (messageId, label, expectedOffset = 58) => {
        try {
          await waitUntil(label, async () => {
            const offset = await targetOffset(messageId);
            return offset !== null && Math.abs(offset - expectedOffset) <= 5;
          });
        } catch (error) {
          const geometry = await inspectTargetGeometry(messageId).catch(() => null);
          throw new Error(`${error instanceof Error ? error.message : String(error)}; expected target offset ${expectedOffset}; geometry ${JSON.stringify(geometry)}`);
        }
      };
      const moveMarkIntoRailView = async (messageId) => {
        await evaluate(`(() => {
          const list = document.querySelector('.chat-navigation-list');
          const button = [...document.querySelectorAll('.chat-navigation-mark')]
            .find((item) => item.dataset.navigationMessageId === ${JSON.stringify(messageId)});
          if (!list || !button) return false;
          const listRect = list.getBoundingClientRect();
          const buttonRect = button.getBoundingClientRect();
          if (buttonRect.top < listRect.top) list.scrollTop -= listRect.top - buttonRect.top;
          else if (buttonRect.bottom > listRect.bottom) list.scrollTop += buttonRect.bottom - listRect.bottom;
          return true;
        })()`);
        await waitUntil(`request ${messageId} is inside the rail viewport`, () => evaluate(`(() => {
          const list = document.querySelector('.chat-navigation-list');
          const button = [...document.querySelectorAll('.chat-navigation-mark')]
            .find((item) => item.dataset.navigationMessageId === ${JSON.stringify(messageId)});
          if (!list || !button) return false;
          const listRect = list.getBoundingClientRect();
          const buttonRect = button.getBoundingClientRect();
          return buttonRect.top >= listRect.top && buttonRect.bottom <= listRect.bottom;
        })()`));
      };

      const resting = await inspectRail();
      assert.deepEqual(resting.marks.map((mark) => mark.id), expectedUserIds,
        `${name}: request marks follow exactly the persisted user message IDs`);
      assert.deepEqual(resting.userIds, expectedUserIds,
        `${name}: the rendered transcript still has every accepted user target`);
      assert.ok(resting.area && resting.nav && resting.list && resting.history && resting.composer,
        `${name}: the rail, chat scroll owner, history and composer are present`);
      assert.ok(resting.nav.left >= resting.area.left - 1 && resting.nav.right < resting.history.left,
        `${name}: the rail sits inside the chat pane before its history column: ${JSON.stringify(resting)}`);
      assert.ok(resting.nav.top >= resting.area.top - 1 && resting.nav.bottom <= resting.area.bottom + 1,
        `${name}: the rail is bounded by the actual chat scroll owner: ${JSON.stringify(resting)}`);
      assert.ok(resting.list.maxHeight <= resting.area.height + 1,
        `${name}: the rail's own scroll limit uses the chat viewport height: ${JSON.stringify(resting.list)}`);
      assert.ok(resting.list.contentHeight > resting.list.viewportHeight,
        `${name}: the main view-area remains the actual long-history scroll owner: ${JSON.stringify(resting.list)}`);
      assert.equal(resting.previewText, null, `${name}: no preview or ghost-focused mark is open at rest`);
      assert.equal(resting.marks.filter((mark) => mark.expanded || mark.focused).length, 0,
        `${name}: marks do not expand before real hover or keyboard focus`);
      assert.ok(resting.marks.every((mark) => mark.height >= 28 && Math.abs(mark.width - 8) <= 1),
        `${name}: rail targets remain large enough and bars are horizontal at rest: ${JSON.stringify(resting.marks)}`);
      assert.notEqual(resting.marks[resting.marks.length - 1]?.color, resting.marks[0]?.color,
        `${name}: the latest request uses the foreground color while earlier requests stay muted`);
      for (let index = 1; index < resting.marks.length; index += 1) {
        assert.ok(resting.marks[index - 1].bottom <= resting.marks[index].top + 1,
          `${name}: adjacent rail targets do not overlap: ${JSON.stringify(resting.marks.slice(index - 1, index + 1))}`);
      }
      assert.equal(resting.marks[resting.marks.length - 1]?.tabIndex, 0, `${name}: latest request is the initial keyboard tab stop`);
      assert.ok(resting.marks.slice(0, -1).every((mark) => mark.tabIndex === -1), `${name}: only the latest request is tabbable initially`);
      assert.equal(resting.rightScrollbarButton, 'none', `${name}: the chat area hides only its decorative scrollbar button`);

      const navigationDebuggerWasAttached = window.webContents.debugger.isAttached();
      if (!navigationDebuggerWasAttached) window.webContents.debugger.attach('1.3');
      try {
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await waitDom(`${name} request rail sees reduced-motion preference`, `matchMedia('(prefers-reduced-motion: reduce)').matches`);
        const navigationMotion = JSON.parse(await evaluate(`JSON.stringify((() => {
          const bar = document.querySelector('.chat-navigation-mark-bar');
          const durations = getComputedStyle(bar).transitionDuration.split(',').map((value) => {
            const duration = value.trim();
            const amount = Number.parseFloat(duration);
            return duration.endsWith('ms') ? amount : amount * 1000;
          });
          return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, transitionMs: Math.max(...durations) };
        })())`));
        assert.equal(navigationMotion.reduced, true);
        assert.ok(navigationMotion.transitionMs <= 0.011,
          `${name}: request rail motion is disabled under reduced-motion preference: ${JSON.stringify(navigationMotion)}`);
        passed('Rendered request rail respects reduced-motion preference');
      } finally {
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
        if (!navigationDebuggerWasAttached && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      }

      const hoverId = expectedUserIds[expectedUserIds.length - 2];
      const hoverSelector = `.chat-navigation-mark[data-navigation-message-id="${hoverId}"]`;
      const clickId = expectedUserIds[expectedUserIds.length - 6];
      const clickSelector = `.chat-navigation-mark[data-navigation-message-id="${clickId}"]`;
      await moveMarkIntoRailView(hoverId);
      await movePointerTo(hoverSelector);
      const expectedExpandedBarWidth = Number(await evaluate(`matchMedia('(max-width: 620px)').matches ? 20 : 24`));
      await waitUntil(`${name} hover expands only its own request bar`, async () => {
        const state = await inspectRail();
        return state.marks.find((mark) => mark.id === hoverId)?.width >= expectedExpandedBarWidth - 1;
      });
      const hovered = await inspectRail();
      assert.deepEqual(hovered.marks.filter((mark) => mark.expanded).map((mark) => mark.id), [hoverId],
        `${name}: hovering expands only the pointed-to bar`);
      assert.ok(hovered.marks.find((mark) => mark.id === hoverId).width >= expectedExpandedBarWidth - 1
        && hovered.marks.find((mark) => mark.id === hoverId).width > resting.marks.find((mark) => mark.id === hoverId).width + 8,
        `${name}: the hovered horizontal bar expands measurably`);
      assert.ok(hovered.marks.filter((mark) => mark.id !== hoverId).every((mark) =>
        Math.abs(mark.width - resting.marks.find((before) => before.id === mark.id).width) <= 1),
      `${name}: neighboring bars keep their original widths`);
      const hoverMessage = themeChat.messages.find((message) => message.id === hoverId);
      assert.ok(hovered.previewText?.includes(hoverMessage.text), `${name}: preview contains the original user request`);
      assert.ok(hovered.previewText?.includes('2026') && /\b\d{2}:\d{2}\b/.test(hovered.previewText), `${name}: preview exposes local date and time`);
      assert.ok(hovered.previewText?.includes('Статус'), `${name}: preview exposes a truthful saved status`);
      assert.ok(hovered.preview.left >= hovered.area.left - 1 && hovered.preview.right <= hovered.area.right + 1
        && hovered.preview.top >= hovered.area.top - 1 && hovered.preview.bottom <= hovered.area.bottom + 1,
      `${name}: contextual preview stays within the chat pane: ${JSON.stringify(hovered)}`);
      assert.ok(Math.abs(hovered.composer.top - resting.composer.top) <= 1 && Math.abs(hovered.composer.bottom - resting.composer.bottom) <= 1,
        `${name}: opening a preview does not move the composer`);
      await capture('stage5-request-navigation-hover-preview');
      await movePointerTo('.chat-header-title');
      await waitDom(`${name} hover preview closes when the pointer leaves the rail`, `!document.querySelector('.chat-navigation-preview')`);

      const firstId = expectedUserIds[0];
      const latestId = expectedUserIds[expectedUserIds.length - 1];
      const latestSelector = `.chat-navigation-mark[data-navigation-message-id="${latestId}"]`;
      await evaluate(`document.querySelector(${JSON.stringify(latestSelector)})?.focus()`);
      await sendKey('HOME');
      await waitUntil(`${name} Home focuses the first request`, () => evaluate(`document.activeElement?.dataset.navigationMessageId === ${JSON.stringify(firstId)}`));
      await sendKey('DOWN');
      await waitUntil(`${name} ArrowDown advances one request`, () => evaluate(`document.activeElement?.dataset.navigationMessageId === ${JSON.stringify(expectedUserIds[1])}`));
      await sendKey('UP');
      await waitUntil(`${name} ArrowUp returns to the prior request`, () => evaluate(`document.activeElement?.dataset.navigationMessageId === ${JSON.stringify(firstId)}`));
      await sendKey('END');
      await waitUntil(`${name} End focuses the latest request`, () => evaluate(`document.activeElement?.dataset.navigationMessageId === ${JSON.stringify(latestId)}`));
      await sendKey('ESC');
      await waitDom(`${name} Escape closes the contextual preview`, `!document.querySelector('.chat-navigation-preview')`);

      await moveMarkIntoRailView(clickId);
      const pointerGeometry = await inspectTargetGeometry(clickId);
      assert.equal(pointerGeometry?.messageId, clickId, `${name}: pointer target exists before activation`);
      assert.equal(pointerGeometry.wasClamped, false,
        `${name}: older pointer target has enough later content for the requested offset: ${JSON.stringify(pointerGeometry)}`);
      assert.ok(Math.abs(pointerGeometry.expectedOffset - 58) <= 1,
        `${name}: older pointer target is geometrically reachable at the requested offset: ${JSON.stringify(pointerGeometry)}`);
      const scrollBeforeClick = Number(await evaluate(`document.querySelector('.view-area.chat-view-area')?.scrollTop ?? 0`));
      await sendVisibleMouseClick(clickSelector);
      await waitForTargetOffset(clickId, `${name} pointer activation aligns its actual user target`, pointerGeometry.expectedOffset);
      const scrollAfterClick = Number(await evaluate(`document.querySelector('.view-area.chat-view-area')?.scrollTop ?? 0`));
      assert.notEqual(scrollAfterClick, scrollBeforeClick, `${name}: request activation changes the actual chat scroll owner`);

      const previousRuntimeTurns = state.runtimeTurns.get('chat-b') ?? [];
      const stage5Turn = {
        id: 'stage5-navigation-turn', chatId: 'chat-b', status: 'running', createdAt: timestamp, startedAt: timestamp,
        anchorMessageId: latestId, assistantMessageId: 'stage5-navigation-assistant', modelId: 'GigaChat-3-Ultra',
        queueDurationMs: 0, activeDurationMs: 0, activity: [], draft: 'Ответ начал поступать.',
      };
      const publishStage5Turn = (turn) => {
        state.runtimeTurns.set('chat-b', [...(state.runtimeTurns.get('chat-b') ?? []).filter((item) => item.id !== turn.id), turn]);
        window.webContents.send('audit:runtime', turn);
      };
      publishStage5Turn(stage5Turn);
      await waitDom(`${name} latest mark reports the active runtime state`, `document.querySelector(${JSON.stringify(latestSelector)})?.getAttribute('aria-label').includes('Выполняется')`);
      await evaluate(`document.querySelector(${JSON.stringify(latestSelector)})?.focus()`);
      const latestGeometry = await inspectTargetGeometry(latestId);
      assert.equal(latestGeometry?.messageId, latestId, `${name}: latest target exists before Enter`);
      assert.equal(latestGeometry.wasClamped, true,
        `${name}: short active draft keeps latest target at the real scroll boundary: ${JSON.stringify(latestGeometry)}`);
      assert.ok(Math.abs(latestGeometry.destinationScrollTop - latestGeometry.maxScrollTop) <= 1,
        `${name}: latest target clamp is the actual end of the view-area: ${JSON.stringify(latestGeometry)}`);
      const latestExpectedOffset = latestGeometry.expectedOffset;
      await sendNativeButtonKey('ENTER', '\r');
      await waitForTargetOffset(latestId, `${name} Enter follows the latest active request to its actual user message`, latestExpectedOffset);

      const originalSize = window.getSize();
      const originalZoom = window.webContents.getZoomFactor();
      const widthBeforeResize = Number(await evaluate(`document.querySelector('.view-area.chat-view-area')?.clientWidth ?? 0`));
      try {
        window.setSize(originalSize[0] + 60, originalSize[1]);
        await waitUntil(`${name} resize changes the actual chat viewport`, async () =>
          Number(await evaluate(`document.querySelector('.view-area.chat-view-area')?.clientWidth ?? 0`)) > widthBeforeResize + 10);
        const resizedLatestOffset = await navigationExpectedOffset(latestId, `${name} latest target geometry after resize`);
        await waitForTargetOffset(latestId, `${name} ResizeObserver preserves the armed latest anchor before another delta`, resizedLatestOffset);
        window.setSize(originalSize[0], originalSize[1]);
        await waitUntil(`${name} viewport returns to its original width`, async () =>
          Math.abs(Number(await evaluate(`document.querySelector('.view-area.chat-view-area')?.clientWidth ?? 0`)) - widthBeforeResize) <= 2);
        const restoredLatestOffset = await navigationExpectedOffset(latestId, `${name} latest target geometry after restoring width`);
        await waitForTargetOffset(latestId, `${name} restored width keeps the latest anchor in place`, restoredLatestOffset);
      } finally {
        window.webContents.setZoomFactor(originalZoom);
        window.setSize(originalSize[0], originalSize[1]);
      }

      const firstStream = {
        ...stage5Turn, draft: `Первая часть потока. ${'Ответ продолжается без потери текущего хода. '.repeat(170)}STAGE5_STREAM_END_1`, activeDurationMs: 1200,
      };
      publishStage5Turn(firstStream);
      await waitDom(`${name} streaming text reaches its first long delta`, `document.querySelector('.transcript-draft')?.textContent.includes('STAGE5_STREAM_END_1')`);
      await waitUntil(`${name} a near-end reader follows the stream to the bottom`, () => evaluate(`(() => {
        const area = document.querySelector('.view-area.chat-view-area');
        return Boolean(area) && area.scrollHeight - area.clientHeight - area.scrollTop <= 120;
      })()`));

      await moveMarkIntoRailView(hoverId);
      const olderClickExpectedOffset = await navigationExpectedOffset(hoverId, `${name} older target geometry before pointer activation`);
      await sendVisibleMouseClick(hoverSelector);
      await waitForTargetOffset(hoverId, `${name} selecting an older request places its user message in view`, olderClickExpectedOffset);
      const oldOffsetBeforeDelta = await targetOffset(hoverId);
      await evaluate(`document.querySelector(${JSON.stringify(hoverSelector)})?.focus()`);
      const olderSpaceExpectedOffset = await navigationExpectedOffset(hoverId, `${name} older target geometry before Space`);
      await sendNativeButtonKey('SPACE', ' ');
      await waitForTargetOffset(hoverId, `${name} Space activates the focused older request`, olderSpaceExpectedOffset);
      const oldStream = {
        ...firstStream, draft: `${firstStream.draft}\n${'Ещё один пакет текста не должен уводить чтение вниз. '.repeat(150)}STAGE5_STREAM_END_2`, activeDurationMs: 2400,
      };
      publishStage5Turn(oldStream);
      await waitDom(`${name} older reader receives another stream delta`, `document.querySelector('.transcript-draft')?.textContent.includes('STAGE5_STREAM_END_2')`);
      await waitUntil(`${name} old user anchor remains at its saved viewport offset`, async () => {
        const offset = await targetOffset(hoverId);
        return offset !== null && Math.abs(offset - oldOffsetBeforeDelta) <= 3;
      });
      const readingGap = Number(await evaluate(`(() => {
        const area = document.querySelector('.view-area.chat-view-area');
        return area ? area.scrollHeight - area.clientHeight - area.scrollTop : 0;
      })()`));
      assert.ok(readingGap > 120, `${name}: reading an older request does not snap to the streaming end`);

      const oldOffsetBeforeSwitch = await targetOffset(hoverId);
      await clickChat('Chat A');
      await waitDom(`${name} navigation fixture switches to the other chat`, `document.querySelector('.chat-header-title')?.textContent === 'Chat A'`);
      await clickChat('Chat B');
      await waitDom(`${name} navigation fixture returns to the correct chat and loaded history`, `document.querySelector('.chat-header-title')?.textContent === 'Chat B'
        && document.querySelector('[data-message-id="${hoverId}"]')`);
      await waitUntil(`${name} switching chats restores the same user target and offset`, async () => {
        const offset = await targetOffset(hoverId);
        return offset !== null && Math.abs(offset - oldOffsetBeforeSwitch) <= 3;
      });
      await waitUntil(`${name} the stream remains attached to its own request after chat restore`, () =>
        evaluate(`document.querySelector('.transcript-draft')?.textContent.includes('STAGE5_STREAM_END_2')`));
      const areaBeforeWheel = JSON.parse(await evaluate(`JSON.stringify((() => {
        const area = document.querySelector('.view-area.chat-view-area');
        const rect = area?.getBoundingClientRect();
        return { scrollTop: area?.scrollTop ?? 0, x: rect ? rect.left + rect.width / 2 : 0, y: rect ? rect.top + rect.height / 2 : 0 };
      })())`));
      window.show();
      window.focus();
      window.webContents.focus();
      await waitUntil(`${name} native wheel target window has focus`, () => window.isFocused());
      const wheelZoom = window.webContents.getZoomFactor();
      await evaluate(`(() => {
        const area = document.querySelector('.view-area.chat-view-area');
        window.__auditNavigationWheel = null;
        area?.addEventListener('wheel', (event) => {
          window.__auditNavigationWheel = { deltaY: event.deltaY, targetInArea: area.contains(event.target) };
        }, { once: true, capture: true });
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(areaBeforeWheel.x * wheelZoom),
        y: Math.round(areaBeforeWheel.y * wheelZoom) });
      window.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(areaBeforeWheel.x * wheelZoom),
        y: Math.round(areaBeforeWheel.y * wheelZoom), deltaX: 0, deltaY: -420 });
      await waitUntil(`${name} native wheel still scrolls the chat view`, () =>
        evaluate(`document.querySelector('.view-area.chat-view-area')?.scrollTop > ${areaBeforeWheel.scrollTop + 20}
          && window.__auditNavigationWheel?.deltaY > 0 && window.__auditNavigationWheel?.targetInArea === true`));
      const cancelledStage5Turn = {
        ...stage5Turn, status: 'cancelled', endedAt: new Date(Date.parse(timestamp) + 3000).toISOString(),
        queueDurationMs: 0, activeDurationMs: 2400, activity: [], draft: '',
      };
      publishStage5Turn(cancelledStage5Turn);
      await waitDom(`${name} synthetic stream reaches a terminal state before the theme capture`, `document.querySelector(${JSON.stringify(latestSelector)})?.getAttribute('aria-label').includes('Остановлено')`);

      const originalWindowSize = window.getSize();
      const originalWindowZoom = window.webContents.getZoomFactor();
      try {
        window.webContents.setZoomFactor(1);
        window.setSize(600, originalWindowSize[1]);
        await waitUntil(`${name} narrow chat viewport is ready`, () => evaluate(`innerWidth <= 620
          && document.querySelector('.view-area.chat-view-area')?.clientWidth > 0`));
        const narrow = await inspectRail();
        assert.deepEqual(narrow.marks.map((mark) => mark.id), expectedUserIds,
          `${name}: all request targets remain available in a narrow chat pane`);
        assert.ok(narrow.area.width < 620 && narrow.nav.right < narrow.history.left
          && narrow.nav.bottom <= narrow.area.bottom + 1,
        `${name}: the narrow rail remains inside the measured scroll owner: ${JSON.stringify(narrow)}`);
        assert.ok(narrow.composer.height > 0 && narrow.composer.bottom <= narrow.viewportHeight + 2,
          `${name}: the composer remains visible and outside the rail in a narrow window: ${JSON.stringify(narrow)}`);
        await capture('stage5-request-navigation-narrow');
      } finally {
        window.webContents.setZoomFactor(originalWindowZoom);
        window.setSize(originalWindowSize[0], originalWindowSize[1]);
        await waitUntil(`${name} theme viewport is restored after the narrow rail check`, () => evaluate(`innerWidth > 620`));
      }
      await movePointerTo('.chat-header-title');
      await evaluate(`document.activeElement?.blur()`);
      await evaluate(`document.querySelector('[data-message-id="stage4-theme-user"]')?.scrollIntoView({ block: 'center' })`);
      await movePointerTo('.chat-header-title');
      assert.equal(previousRuntimeTurns.some((turn) => turn.id === stage5Turn.id), false,
        `${name}: the test-only turn ID does not collide with earlier runtime state`);
      passed('Rendered request rail maps user IDs, expands one mark, supports mouse/keyboard, and preserves scroll anchors through streaming, resize and chat switches');
    };
    const captureChatTranscriptTheme = async (name) => {
      await waitDom(`${name} linked transcript is visible`, `document.querySelector('[data-message-id="stage4-theme-user"]')
        && document.querySelector('[data-turn-id="stage4-theme-turn"]')
        && document.querySelector('[data-message-id="stage4-theme-answer"]')`);
      await evaluate(`document.activeElement?.blur()`);
      await evaluate(`document.querySelector('[data-message-id="stage4-theme-user"]')?.scrollIntoView({ block: 'center' })`);
      await movePointerTo('.chat-header-title');
      if (!stage5NavigationChecked) {
        await verifyStage5Navigation(name);
        stage5NavigationChecked = true;
      }
      const readShortBubbleState = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
        const history = document.querySelector('.chat-history');
        const anchor = document.querySelector('[data-message-id="stage4-theme-user"]');
        const bubble = anchor?.querySelector('.transcript-bubble');
        const meta = anchor?.querySelector('.transcript-message-meta');
        const time = meta?.querySelector('time');
        const copy = meta?.querySelector('.transcript-copy');
        const box = (element) => {
          if (!element) return null;
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
          return { left, right, top, bottom, width, height };
        };
        return {
          history: box(history), anchor: box(anchor), bubble: box(bubble), meta: box(meta), time: box(time), copy: box(copy),
          hoverNone: matchMedia('(hover: none)').matches,
          timeOpacity: time ? getComputedStyle(time).opacity : null,
          copyOpacity: copy ? getComputedStyle(copy).opacity : null,
        };
      })())`));
      const assertCompactBubble = (metrics, label) => {
        assert.ok(metrics.time && metrics.copy, `${name} ${label}: timestamp and copy controls are rendered`);
        assert.ok(metrics.history?.width > 600, `${name} ${label}: the short-bubble check uses a wide transcript: ${JSON.stringify(metrics.history)}`);
        assert.ok(metrics.bubble?.width < 120, `${name} ${label}: «йоу» stays an intrinsic bubble under 120px: ${JSON.stringify(metrics)}`);
        assert.ok(Math.abs(metrics.anchor.right - metrics.history.right) <= 1,
          `${name} ${label}: the compact user message is aligned to the transcript's right edge: ${JSON.stringify(metrics)}`);
        assert.ok(Math.abs(metrics.bubble.right - metrics.anchor.right) <= 1,
          `${name} ${label}: the bubble stays right-aligned within its message row: ${JSON.stringify(metrics)}`);
        assert.ok(Math.abs((metrics.time.top + metrics.time.bottom) / 2 - (metrics.copy.top + metrics.copy.bottom) / 2) <= 1,
          `${name} ${label}: time and copy share one centered control row: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.copy.left >= metrics.time.right - 1 && metrics.copy.left - metrics.time.right <= 12,
          `${name} ${label}: copy sits adjacent to the timestamp: ${JSON.stringify(metrics)}`);
      };
      const assertReservedGeometry = (before, after, label) => {
        for (const key of ['anchor', 'bubble', 'meta']) {
          for (const coordinate of ['left', 'right', 'top', 'bottom', 'width', 'height']) {
            assert.ok(Math.abs(before[key][coordinate] - after[key][coordinate]) <= 1,
              `${name} ${label}: revealing metadata does not move ${key}.${coordinate}: before=${JSON.stringify(before[key])}, after=${JSON.stringify(after[key])}`);
          }
        }
      };
      const resting = await readShortBubbleState();
      assertCompactBubble(resting, 'at rest');
      assert.equal(resting.timeOpacity, resting.hoverNone ? '1' : '0', `${name}: the timestamp is quiet at rest unless touch rules keep it available`);
      assert.equal(resting.copyOpacity, resting.hoverNone ? '1' : '0', `${name}: copy is quiet at rest unless touch rules keep it available`);
      await evaluate(`document.querySelector('[data-message-id="stage4-theme-user"] .transcript-copy')?.focus()`);
      await waitDom(`${name} keyboard focus reveals the compact message controls`, `(() => {
        const message = document.querySelector('[data-message-id="stage4-theme-user"]');
        const time = message?.querySelector('.transcript-message-meta time');
        const copy = message?.querySelector('.transcript-copy');
        return message?.matches(':focus-within') && Number(getComputedStyle(time).opacity) > 0 && Number(getComputedStyle(copy).opacity) > 0;
      })()`);
      const focused = await readShortBubbleState();
      assertCompactBubble(focused, 'with keyboard focus');
      assertReservedGeometry(resting, focused, 'keyboard focus');
      await capture(`stage4-chat-transcript-${name}-short-yo`);
      await evaluate(`document.activeElement?.blur()`);
      if (!resting.hoverNone) {
        await movePointerTo('[data-message-id="stage4-theme-user"] .transcript-bubble');
        await waitDom(`${name} pointer hover reveals both compact message controls`, `(() => {
          const message = document.querySelector('[data-message-id="stage4-theme-user"]');
          const time = message?.querySelector('.transcript-message-meta time');
          const copy = message?.querySelector('.transcript-copy');
          return message?.matches(':hover') && Number(getComputedStyle(time).opacity) > 0 && Number(getComputedStyle(copy).opacity) > 0;
        })()`);
        const hovered = await readShortBubbleState();
        assertCompactBubble(hovered, 'with pointer hover');
        assertReservedGeometry(resting, hovered, 'pointer hover');
      }
      await movePointerTo('.chat-header-title');
      await evaluate(`(() => { const area = document.querySelector('.view-area'); area.scrollTop = area.scrollHeight; })()`);
      const sample = JSON.parse(await evaluate(`JSON.stringify((() => {
        const history = document.querySelector('.chat-history');
        const anchor = document.querySelector('[data-message-id="stage4-theme-user"]');
        const bubble = anchor?.querySelector('.transcript-bubble');
        const longUser = document.querySelector('[data-message-id="stage4-theme-history-27"]');
        const longAssistant = document.querySelector('[data-message-id="stage4-theme-history-28"]');
        const activity = document.querySelector('[data-turn-id="stage4-theme-turn"]');
        const answer = document.querySelector('[data-message-id="stage4-theme-answer"]');
        return {
          messageCount: history?.querySelectorAll('.transcript-message').length ?? 0,
          scrollWidth: history?.scrollWidth ?? 0,
          clientWidth: history?.clientWidth ?? 0,
          bubbleRight: bubble?.getBoundingClientRect().right ?? 0,
          anchorRight: anchor?.getBoundingClientRect().right ?? 0,
          longUserRole: longUser?.classList.contains('message-user') ?? false,
          longUserText: longUser?.textContent ?? '',
          longAssistantRole: longAssistant?.classList.contains('message-assistant') ?? false,
          longAssistantText: longAssistant?.textContent ?? '',
          answerAfterActivity: Boolean(activity && answer && (activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)),
          textSelectable: bubble ? getComputedStyle(bubble.querySelector('p')).userSelect === 'text' : false,
        };
      })())`));
      assert.ok(sample.messageCount >= 30, `${name}: the transcript renders the full long history`);
      assert.ok(sample.scrollWidth <= sample.clientWidth + 1, `${name}: long messages do not create horizontal overflow`);
      assert.ok(Math.abs(sample.bubbleRight - sample.anchorRight) <= 1, `${name}: the short user bubble remains right-aligned`);
      assert.equal(sample.longUserRole, true, `${name}: the long Russian/URL/code prompt is a user message`);
      assert.ok(sample.longUserText.includes(longUserTranscriptText), `${name}: the long user prompt is preserved in full`);
      assert.equal(sample.longAssistantRole, true, `${name}: the following long answer remains an assistant message`);
      assert.ok(sample.longAssistantText.includes(longTranscriptText), `${name}: the long assistant answer is preserved in full`);
      assert.equal(sample.answerAfterActivity, true, `${name}: linked activity remains before its answer`);
      assert.equal(sample.textSelectable, true, `${name}: transcript text remains selectable`);
      await capture(`stage4-chat-transcript-${name}`);
    };

    const originalTheme = state.appSettings.theme;
    const themeCases = [
      { value: 'dark', label: 'Тёмная' },
      { value: 'emerald', label: 'Изумрудная' },
      { value: 'light', label: 'Светлая' },
      { value: 'warm', label: 'Тёплая' },
      { value: 'system', label: 'Как в Windows' },
    ];
    const themeSamples = [];
    const browserWorkspaceThemeSamples = [];
    let stage5NavigationChecked = false;
    await clickChat('Chat B');
    await waitDom('Chat B is active before setting the transcript theme viewport', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
    await click('button[aria-label="Показать браузер"]');
    await waitDom('browser opens to establish a measured wide theme viewport', `document.querySelector('.browser-workspace.browser-open')`);
    const themeWideViewport = await setMainWorkspaceWidth(1200, 1);
    assert.ok(themeWideViewport.workspaceWidth > 600, `the shared theme transcript uses the explicitly measured wide viewport: ${JSON.stringify(themeWideViewport)}`);
    await click('button[aria-label="Скрыть браузер"]');
    await waitDom('browser closes before the shared theme transcript matrix', `!document.querySelector('.browser-pane')`);
    const themeChatWidth = Number(await evaluate(`document.querySelector('.chat-view')?.getBoundingClientRect().width ?? 0`));
    assert.ok(themeChatWidth > 600, `the explicit wide workspace leaves Chat B over 600px for theme captures: ${themeChatWidth}`);
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
      if (index < 4) {
        await click('button.window-action[aria-label="Назад"]');
        await waitDom(`${themeCase.label} returns to Chat B for actual workspace theme proof`, `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
      await captureChatTranscriptTheme(themeCase.value);
        if (await evaluate(`Boolean(document.querySelector('.notice'))`)) await click('button[aria-label="Закрыть уведомление"]');
        await waitDom(`${themeCase.label} transient notice is dismissed`, `!document.querySelector('.notice')`);
        await click('button[aria-label="Показать браузер"]');
        await waitDom(`${themeCase.label} browser workspace is mounted`, `document.querySelector('.browser-workspace.browser-open') && document.querySelector('.workspace-expand-toggle')`);
        await setMainWorkspaceWidth(1200, 1);
        await waitDom(`${themeCase.label} workspace is wide enough for an explicit split state`, `!document.querySelector('.browser-workspace.is-full')`);
        for (const full of [false, true]) {
          if (full) {
            await click('button[aria-label="Развернуть на всю рабочую область"]');
            await waitDom(`${themeCase.label} full workspace theme state`, `document.querySelector('.browser-workspace.is-full.surface-browser')`);
          }
          const workspaceThemeSample = JSON.parse(await evaluate(`JSON.stringify((() => {
            const frame = document.querySelector('.app-frame');
            const workspace = document.querySelector('.browser-workspace');
            const header = workspace?.querySelector('.chat-header');
            const panel = workspace?.closest('.main-panel');
            const expand = workspace?.querySelector('.workspace-expand-toggle');
            const svg = expand?.querySelector('svg');
            const frameStyle = getComputedStyle(frame);
            const headerStyle = header ? getComputedStyle(header) : null;
            const panelStyle = panel ? getComputedStyle(panel) : null;
            const expandStyle = expand ? getComputedStyle(expand) : null;
            return {
              themeClasses: [...frame.classList].filter((name) => name.startsWith('theme-')),
              full: workspace?.classList.contains('is-full'),
              workspaceWidth: workspace?.getBoundingClientRect().width,
              panelBackgroundImage: panelStyle?.backgroundImage,
              panelMidToken: frameStyle.getPropertyValue('--panel-mid').trim(),
              headerDivider: headerStyle?.borderBottomColor,
              toggleColor: expandStyle?.color,
              toggleBackground: expandStyle?.backgroundColor,
              togglePressed: expand?.getAttribute('aria-pressed'),
              iconStroke: svg ? getComputedStyle(svg).stroke : null,
              iconPath: svg?.querySelector('path')?.getAttribute('d') ?? null,
            };
          })())`));
          assert.deepEqual(workspaceThemeSample.themeClasses, [`theme-${resolvedTheme}`], `${themeCase.label}: actual browser workspace uses its resolved theme`);
          assert.equal(workspaceThemeSample.full, full, `${themeCase.label}: workspace visual sample uses the requested split/full state`);
          assert.ok(workspaceThemeSample.workspaceWidth > 0, `${themeCase.label}: actual BrowserPanel is rendered`);
          assert.notEqual(workspaceThemeSample.panelBackgroundImage, 'none', `${themeCase.label}: actual workspace panel resolves its gradient surface`);
          assert.ok(workspaceThemeSample.panelMidToken, `${themeCase.label}: actual workspace panel theme token resolves`);
          assert.notEqual(workspaceThemeSample.headerDivider, 'rgba(0, 0, 0, 0)', `${themeCase.label}: actual workspace header has a visible divider`);
          assert.notEqual(workspaceThemeSample.toggleColor, 'rgba(0, 0, 0, 0)', `${themeCase.label}: actual workspace action icon has a resolved color`);
          assert.equal(workspaceThemeSample.togglePressed, String(full), `${themeCase.label}: actual workspace icon state matches split/full mode`);
          assert.ok(workspaceThemeSample.iconStroke && workspaceThemeSample.iconPath, `${themeCase.label}: actual workspace button renders its SVG icon`);
          if (!full && index === 0) {
            const splitRail = JSON.parse(await evaluate(`JSON.stringify((() => {
              const box = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
              };
              return { area: box('.view-area.chat-view-area'), nav: box('.chat-navigation'),
                history: box('.chat-history'), browser: box('.browser-pane'), composer: box('.composer-stack') };
            })())`));
            assert.ok(splitRail.area?.width > 0 && splitRail.nav?.width > 0 && splitRail.browser?.width > 0,
              `split layout shows both chat rail and browser pane: ${JSON.stringify(splitRail)}`);
            assert.ok(splitRail.nav.left >= splitRail.area.left - 1 && splitRail.nav.right < splitRail.history.left
              && splitRail.area.right <= splitRail.browser.left + 1,
            `split rail stays inside the chat pane without covering the browser: ${JSON.stringify(splitRail)}`);
            assert.ok(splitRail.composer.height > 0, `split layout keeps the composer available: ${JSON.stringify(splitRail)}`);
            await capture('stage5-request-navigation-split');
          }
          browserWorkspaceThemeSamples.push({ requested: themeCase.value, resolved: resolvedTheme, ...workspaceThemeSample });
          await capture(`browser-workspace-theme-${themeCase.value}-${full ? 'full' : 'split'}`);
          if (full) {
            await click('button[aria-label="Выйти из режима полного просмотра"]');
            await waitDom(`${themeCase.label} restores split workspace theme state`, `!document.querySelector('.browser-workspace.is-full')`);
          }
        }
        await click('button[aria-label="Скрыть браузер"]');
        await waitDom(`${themeCase.label} browser workspace closes after theme proof`, `!document.querySelector('.browser-pane')`);
        await click('.profile-settings-button');
        await waitDom(`${themeCase.label} returns to settings for the next palette`, `document.querySelector('.settings-nav-item')`);
        await clickText('.settings-nav-item', 'Оформление');
      } else if (index < themeCases.length - 1) await clickText('.settings-nav-item', 'Оформление');
      else {
        await click('button.window-action[aria-label="Назад"]');
        await waitDom('system theme returns to Chat B for transcript proof', `document.querySelector('.chat-header-title')?.textContent === 'Chat B'`);
        await captureChatTranscriptTheme(themeCase.value);
        await click('.profile-settings-button');
        await waitDom('system theme returns to settings after transcript proof', `document.querySelector('.settings-nav-item')`);
        await clickText('.settings-nav-item', 'Оформление');
      }
    }
    assert.ok(new Set(themeSamples.map((sample) => sample.popupBackground)).size >= 4,
      `Dark/Emerald/Light/Warm/System should render at least four resolved popup palettes: ${JSON.stringify(themeSamples.map((sample) => [sample.requested, sample.resolved, sample.popupBackground]))}`);
    assert.equal(browserWorkspaceThemeSamples.length, 8, 'Dark/Emerald/Light/Warm each render the actual BrowserPanel in split and full states');
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
    window.webContents.setZoomFactor(browserMatrixZoom);
    window.setSize(browserMatrixWindowSize[0], browserMatrixWindowSize[1]);
    await sleep(360);
    console.log(`Rendered theme palette evidence ${JSON.stringify(themeSamples.map(({ requested, resolved, popupBackground, popupText, selectedBackground, selectedText }) => ({ requested, resolved, popupBackground, popupText, selectedBackground, selectedText })))}`);
    console.log(`Rendered browser workspace theme evidence ${JSON.stringify(browserWorkspaceThemeSamples)}`);
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
    process.stderr.write(`${error?.stack ?? String(error)}\n`, () => app.exit(1));
  }
}

const fakePreloadSource = String.raw`
const { contextBridge, ipcRenderer } = require('electron');
const methods = {
  homeDraft: ['get','save','importFile','pickFiles','stageFiles','getAttachmentPreview','removeFile','send'],
  projects: ['list','create','pickFolder','instructionsBackupPath','update','remove','chooseFolder','openFolder','readInstructions','saveInstructions','saveInstructionsCopy'],
  chats: ['list','get','create','update','appendLocalMessage','importFile','pickDraftFiles','stageDraftFiles','getDraftAttachmentPreview','getArtifactPreview','getGeneratedImagePreview','saveGeneratedImage','removeDraftFile','copyMessage','openArtifact','openFolder','remove'],
  runtime: ['getStatus','list','cancel','retry'],
  permissions: ['readConfig','saveConfig','respond'],
  skills: ['list','readSource','setEnabled','openFolder'],
  hooks: ['list','inspect','trust','setEnabled'],
  models: ['getRegistry','refresh'],
  onboarding: ['getKeyStatus','saveKey','getConnectionStatus','connect','cancelConnect','disconnect','getBrowserStatus','openStudio','closeBrowser','setBrowserBounds','back','reload'],
  browser: ['getStatus','newTab','closeTab','activateTab','navigate','back','forward','reload','setBounds'],
  voice: ['getStatus','requestAccess','transcribe','cancel'],
  settings: ['get','update','chooseProjectsFolder','openProjectsFolder','listOpeners','getAppInfo','getAutoStart','setAutoStart','readInstructions','saveInstructions','saveInstructionsCopy','deleteAppData'],
  usage: ['getLocalStats','getLedger','getProfileView','refreshBalance','saveStudioBalanceAnchor'],
};
const api = {};
for (const [group, names] of Object.entries(methods)) {
  api[group] = Object.fromEntries(names.map((name) => [name, (...args) => ipcRenderer.invoke('audit:api', group, name, args)]));
}
api.homeDraft.stageFiles = (files) => ipcRenderer.invoke('audit:api', 'homeDraft', 'stageFiles', [Array.from(files, (file) => ({ name: file.name, size: file.size }))]);
api.chats.stageDraftFiles = (id, files) => ipcRenderer.invoke('audit:api', 'chats', 'stageDraftFiles', [id, Array.from(files, (file) => ({ name: file.name, size: file.size }))]);
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
    process.stderr.write(`${error?.stack ?? String(error)}\n`, () => require('electron').app.exit(1));
  });
} else await runNodeDriver();
