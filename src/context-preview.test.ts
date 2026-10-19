import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatDetail, ChatMessage, ChatToolReceipt, CompactSnapshot, HomeDraftRecord, Project, RuntimeTurnSnapshot, Settings } from './contracts';
import { buildNextTurnContext, hashCompactionPrefix, type NextTurnContext, type NextTurnContextInput } from './context';
import { createContextPreview, type ContextPreviewDependencies } from './context-preview';
import { openStore, type LocalStore, type ProviderStateOwnershipView } from './store';
import { HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE } from './provider-state';
import { createSkillRegistry, type SkillRegistry } from './skills';
import { createBalanceScopeGuard } from './usage-view';

const at = '2026-10-14T09:00:00.000Z';
const project: Project = {
  id: 'project-1', name: 'Private project title', pinned: false, archived: false,
  createdAt: at, updatedAt: at, workingFolder: 'C:\\work\\private',
};
const settings: Settings = {
  theme: 'emerald', sidebarTransparent: false, sidebarVisible: true, sidebarWidthPx: null,
  browserPaneOpen: false, browserWidthPx: null, browserTabs: [], browserActiveTabId: null,
  defaultProjectsFolder: null, preferredOpener: 'system', defaultPermissionProfile: 'approve',
  defaultModelId: 'GigaChat-3-Ultra', onboardingCompleted: true, microphoneConsent: 'unasked',
  notifications: { taskStarted: false, taskCompleted: true, failures: true },
};
const skill = {
  id: 'project/project-1/review', name: 'Private selected Skill', description: '', command: '',
  scope: 'project' as const, projectId: project.id, projectName: project.name,
  source: 'fixture', enabled: true, instructions: 'Private Skill instructions.',
};
const oldUser: ChatMessage = {
  id: 'user-old', role: 'user', text: 'Covered old request.', createdAt: at, attachmentIds: ['historic-file-id'],
};
const oldAssistant: ChatMessage = { id: 'assistant-old', role: 'assistant', text: 'Covered old answer.', createdAt: at, source: 'runtime' };
const lastUser: ChatMessage = { id: 'user-last', role: 'user', text: 'Last accepted request.', createdAt: at };
const lastAssistant: ChatMessage = {
  id: 'assistant-last', role: 'assistant', text: 'Last answer.', createdAt: at, source: 'runtime', functionsStateId: 'opaque-state-id',
};
const protocolReceipt: ChatToolReceipt = {
  receiptId: 'c'.repeat(64), anchorMessageId: lastUser.id, name: 'read', arguments: { path: 'private/path.txt' },
  content: null, functionsStateId: 'opaque-protocol-state', status: 'completed',
  result: JSON.stringify({ result: 'Private local tool result.' }), createdAt: at,
};
const compactPrefix = [oldUser, oldAssistant];
const compactSnapshot: CompactSnapshot = {
  id: 'compact-1', version: 1, boundaryMessageId: oldUser.id, coveredThroughMessageId: oldAssistant.id,
  coveredPrefixHash: hashCompactionPrefix(compactPrefix, []), text: 'Private saved summary.',
  modelId: 'GigaChat-3-Ultra', provenance: 'fixture', createdAt: at,
};
const detail: ChatDetail = {
  id: 'chat-private-id', title: 'Private chat title', projectId: project.id, pinned: false, archived: false,
  createdAt: at, updatedAt: at, kind: 'text', draft: 'Persisted stale draft.', nextTurnPermissionProfile: 'full',
  modelId: null, nextTurnSkillId: skill.id, messages: [...compactPrefix, lastUser, lastAssistant], turns: [],
  toolReceipts: [protocolReceipt], artifacts: [{
    id: 'historic-file-id', name: 'private-document.pdf', storedName: 'local-secret-name.pdf', size: 512,
    sha256: 'a'.repeat(64), createdAt: at, messageId: oldUser.id,
  }],
  draftAttachments: [{
    id: 'pending-file-id', name: 'pending-private.txt', storedName: 'pending-secret.txt', size: 1024,
    sha256: 'b'.repeat(64), createdAt: at,
  }],
  compactSnapshot,
};

function homeDraft(overrides: Partial<HomeDraftRecord> = {}): HomeDraftRecord {
  return {
    revision: 3, text: 'Persisted stale home text.', projectId: project.id, permissionProfile: null,
    skillId: skill.id, modelId: null, attachments: [], lastAcceptance: null, ...overrides,
  };
}

function createFixture(options: {
  home?: HomeDraftRecord;
  chat?: ChatDetail;
  settings?: Settings;
  projects?: Project[];
  enabledSkill?: typeof skill | null;
  active?: boolean;
  onGetChat?: (call: number) => ChatDetail;
  onGetHomeDraft?: (call: number) => HomeDraftRecord;
  onListProjects?: (call: number) => Project[];
  onGetEnabledSkill?: (call: number) => typeof skill | null;
  ownership?: ProviderStateOwnershipView | null;
  onGetOwnership?: (chatId: string | null, call: number) => ProviderStateOwnershipView | null;
} = {}): { dependencies: ContextPreviewDependencies; calls: Record<string, number>; ownershipChatIds: Array<string | null>; assemblies: NextTurnContextInput[]; builtContexts: NextTurnContext[] } {
  const calls: Record<string, number> = {};
  const ownershipChatIds: Array<string | null> = [];
  const assemblies: NextTurnContextInput[] = [];
  const builtContexts: NextTurnContext[] = [];
  const count = (key: string): number => { calls[key] = (calls[key] ?? 0) + 1; return calls[key]!; };
  const sourceHome = options.home ?? homeDraft();
  const sourceChat = options.chat ?? detail;
  const sourceSettings = options.settings ?? settings;
  const sourceProjects = options.projects ?? [project];
  const sourceSkill = options.enabledSkill === undefined ? skill : options.enabledSkill;
  const defaultOwnership: ProviderStateOwnershipView = {
    messages: sourceChat.messages
      .filter((message) => message.role === 'assistant' && typeof message.functionsStateId === 'string')
      .map((message) => ({ messageId: message.id, owned: true })),
    receipts: sourceChat.toolReceipts
      .filter((receipt) => typeof receipt.functionsStateId === 'string')
      .map((receipt) => ({ receiptId: receipt.receiptId, anchorMessageId: receipt.anchorMessageId, owned: true, wireOwned: false })),
    compact: null,
  };
  const fakeStore = {
    getSettings: async () => { count('getSettings'); return structuredClone(sourceSettings); },
    getHomeDraft: async () => {
      const call = count('getHomeDraft');
      return structuredClone(options.onGetHomeDraft?.(call) ?? sourceHome);
    },
    getChat: async () => {
      const call = count('getChat');
      return structuredClone(options.onGetChat?.(call) ?? sourceChat);
    },
    listProjects: async () => {
      const call = count('listProjects');
      return structuredClone(options.onListProjects?.(call) ?? sourceProjects);
    },
    readGlobalInstructions: async () => { count('readGlobalInstructions'); return 'Private global instructions.'; },
    readProjectInstructions: async (id: string) => { count('readProjectInstructions'); assert.equal(id, project.id); return 'Private project instructions.'; },
    getToolProtocolThrough: async (chatId: string, messageId: string) => {
      count('getToolProtocolThrough');
      assert.equal(chatId, sourceChat.id);
      assert.equal(messageId, lastUser.id);
      return sourceChat.toolReceipts
        .filter((receipt) => receipt.anchorMessageId === messageId && receipt.status === 'completed')
        .map((receipt) => ({
          anchorMessageId: receipt.anchorMessageId,
          name: receipt.name,
          arguments: structuredClone(receipt.arguments),
          content: receipt.content,
          functionsStateId: receipt.functionsStateId,
          result: receipt.result ?? '',
        }));
    },
    createChat: async () => { throw new Error('Preview must never create a chat.'); },
    acceptLocalMessage: async () => { throw new Error('Preview must never accept a message.'); },
    acceptHomeDraft: async () => { throw new Error('Preview must never accept a home draft.'); },
    saveHomeDraft: async () => { throw new Error('Preview must never mutate a draft.'); },
  } as unknown as LocalStore;
  const fakeSkills = {
    getEnabledReadOnly: async (id: unknown) => {
      const call = count('getEnabledSkill');
      assert.equal(id, skill.id);
      const resolved = options.onGetEnabledSkill ? options.onGetEnabledSkill(call) : sourceSkill;
      return resolved === null ? null : structuredClone(resolved);
    },
    setEnabled: async () => { throw new Error('Preview must not change Skills.'); },
  } as unknown as SkillRegistry;
  const dependencies: ContextPreviewDependencies = {
    store: fakeStore,
    skills: fakeSkills,
    hasActiveTurn: () => Boolean(options.active),
    getProviderStateOwnership: async (chatId) => {
      const call = count('getProviderStateOwnership');
      ownershipChatIds.push(chatId);
      const ownership = options.onGetOwnership
        ? options.onGetOwnership(chatId, call)
        : options.ownership === undefined ? defaultOwnership : options.ownership;
      return ownership === null ? null : structuredClone(ownership);
    },
    buildContext: (input, buildOptions) => {
      assemblies.push(structuredClone(input));
      const built = buildNextTurnContext(input, buildOptions);
      builtContexts.push(built);
      return built;
    },
  };
  return { dependencies, calls, ownershipChatIds, assemblies, builtContexts };
}

test('home preview uses visible text and main defaults without creating or consuming anything', async () => {
  const fixture = createFixture({ home: homeDraft({ projectId: null, skillId: null }) });
  const preview = await createContextPreview({ source: 'home', visibleText: '  current visible home text  ' }, fixture.dependencies);

  assert.equal(fixture.assemblies.length, 1);
  const homeMessages = fixture.assemblies[0]?.messages ?? [];
  assert.equal(homeMessages[homeMessages.length - 1]?.text, 'current visible home text');
  assert.equal(fixture.assemblies[0]?.modelId, settings.defaultModelId);
  assert.equal(fixture.assemblies[0]?.permissionProfile, settings.defaultPermissionProfile);
  assert.deepEqual(fixture.assemblies[0]?.projectInstructions, []);
  assert.equal(preview.modelId, settings.defaultModelId);
  assert.equal(preview.contextLimit.tokens, 128_000);
  assert.equal(preview.estimatedTokens, null);
  assert.equal(preview.tokenEstimateProvenance, 'unknown');
  assert.equal(preview.pendingAttachments.count, 0);
  assert.equal(fixture.calls.createChat ?? 0, 0);
  assert.equal(fixture.calls.acceptHomeDraft ?? 0, 0);
  assert.equal(fixture.calls.saveHomeDraft ?? 0, 0);
  assert.deepEqual(fixture.ownershipChatIds, [null, null], 'home preview uses the home marker and never a synthetic Store chat ID');

  const keyedHome = createFixture({
    home: homeDraft({ projectId: null, skillId: null }),
    ownership: { messages: [], receipts: [], compact: null },
  });
  const keyedPreview = await createContextPreview({ source: 'home', visibleText: 'visible home text' }, keyedHome.dependencies);
  assert.ok(Number.isSafeInteger(keyedPreview.preparationWireBytes));
  assert.deepEqual(keyedHome.ownershipChatIds, [null, null]);
  assert.equal(keyedHome.calls.getChat ?? 0, 0);
  assert.equal(keyedHome.calls.createChat ?? 0, 0);
  assert.equal(keyedHome.calls.acceptHomeDraft ?? 0, 0);

  const noKeyHome = createFixture({
    home: homeDraft({ projectId: null, skillId: null }),
    ownership: null,
  });
  const neutralPreview = await createContextPreview({ source: 'home', visibleText: 'visible home text' }, noKeyHome.dependencies);
  assert.equal(neutralPreview.preparationWireBytes, null);
  assert.equal(neutralPreview.estimatedTokens, null);
  assert.equal(neutralPreview.tokenEstimateProvenance, 'unknown');
  assert.deepEqual(noKeyHome.ownershipChatIds, [null, null]);
  assert.equal(noKeyHome.calls.getChat ?? 0, 0);
  assert.equal(noKeyHome.calls.createChat ?? 0, 0);
  assert.equal(noKeyHome.calls.acceptHomeDraft ?? 0, 0);
});

test('chat preview assembles the same persisted sources plus current text and returns only bounded aggregates', async () => {
  const fixture = createFixture();
  const preview = await createContextPreview({ source: 'chat', chatId: detail.id, visibleText: ' Current visible prompt ' }, fixture.dependencies);
  const assembled = fixture.assemblies[0]!;

  assert.equal(assembled.modelId, settings.defaultModelId, 'a null chat model resolves to the Send default');
  assert.equal(assembled.permissionProfile, 'full', 'the explicit chat profile takes precedence over the default');
  assert.deepEqual(assembled.projectInstructions, [{ scope: project.name, text: 'Private project instructions.' }]);
  assert.deepEqual(assembled.selectedSkill, { name: skill.name, scope: `Project · ${project.name}`, text: skill.instructions });
  assert.deepEqual(assembled.compactSnapshot, detail.compactSnapshot);
  assert.deepEqual(assembled.compactionToolReceipts, detail.toolReceipts);
  assert.deepEqual(assembled.compactionArtifacts, detail.artifacts);
  assert.deepEqual(assembled.messages.slice(-3).map((message) => message.text), [
    lastUser.text, lastAssistant.text, 'Current visible prompt',
  ]);
  assert.deepEqual(assembled.protocolHistory?.map((exchange) => exchange.anchorMessageId), [lastUser.id]);
  assert.equal(assembled.protocolHistory?.[0]?.functionsStateId, protocolReceipt.functionsStateId,
    'an owned protocol state stays in the exact shared Send assembly');
  assert.equal(preview.blocks.length <= 8, true);
  assert.deepEqual(preview.blocks.map((block) => block.source), [
    'runtime', 'global', 'project', 'skill', 'summary', 'message', 'protocol', 'function-schema',
  ]);
  assert.ok((preview.blocks.find((block) => block.source === 'function-schema')?.utf8Bytes ?? 0) > 0);
  assert.equal(preview.blocks.find((block) => block.source === 'message')?.count, 3);
  assert.equal(preview.preparationWireBytesIncludeAttachments, false);
  assert.ok(Number.isSafeInteger(preview.preparationWireBytes));
  assert.equal(preview.pendingAttachments.count, 1);
  assert.equal(preview.pendingAttachments.sizeBytes, 1024);
  assert.equal(preview.historicalAttachments.count, 1);
  assert.equal(preview.historicalAttachments.sizeBytes, 512);
  assert.deepEqual(preview.unknownReasons, [
    'token-estimate-unavailable', 'pending-attachment-content', 'historical-attachment-content', 'opaque-function-state',
  ]);
  const safeDto = JSON.stringify(preview);
  for (const privateValue of [
    detail.id, lastUser.id, 'Current visible prompt', 'Private global instructions', 'Private project instructions',
    skill.instructions, skill.id, 'historic-file-id', 'pending-file-id', 'private-document.pdf', 'private/path.txt',
    protocolReceipt.receiptId, protocolReceipt.functionsStateId!,
  ]) assert.equal(safeDto.includes(privateValue), false, `${privateValue} must not cross the IPC result`);

  const missingArtifactFixture = createFixture({ chat: { ...detail, artifacts: [] } });
  const missingArtifactPreview = await createContextPreview(
    { source: 'chat', chatId: detail.id, visibleText: 'x' }, missingArtifactFixture.dependencies,
  );
  assert.equal(missingArtifactPreview.historicalAttachments.count, 1);
  assert.equal(missingArtifactPreview.historicalAttachments.sizeBytes, null);
  assert.ok(missingArtifactPreview.unknownReasons.includes('historical-attachment-metadata'));
});

test('empty text still previews runtime/schema context; null/future models stay unknown without fake byte totals', async () => {
  const noModelSettings = { ...settings, defaultModelId: null };
  const fixture = createFixture({ settings: noModelSettings, home: homeDraft({ projectId: null, skillId: null }) });
  const preview = await createContextPreview({ source: 'home', visibleText: '' }, fixture.dependencies);

  assert.equal(fixture.assemblies[0]?.modelId, null);
  const homeMessages = fixture.assemblies[0]?.messages ?? [];
  assert.equal(homeMessages[homeMessages.length - 1]?.text, '');
  assert.equal(preview.modelId, null);
  assert.equal(preview.contextLimit.tokens, null);
  assert.equal(preview.preparationWireBytes, null);
  assert.equal(preview.estimatedTokens, null);
  assert.ok(preview.blocks.some((block) => block.source === 'runtime' && block.utf8Bytes > 0));
  assert.ok(preview.blocks.some((block) => block.source === 'function-schema' && block.utf8Bytes > 0));
  assert.ok(preview.unknownReasons.includes('model-limit-undocumented'));

  const futureFixture = createFixture({
    settings: { ...settings, defaultModelId: 'future/model-v5' },
    home: homeDraft({ projectId: null, skillId: null }),
  });
  const future = await createContextPreview({ source: 'home', visibleText: 'x' }, futureFixture.dependencies);
  assert.equal(future.contextLimit.tokens, null);
  assert.equal(future.contextLimit.provenance, 'unknown');
  assert.ok(Number.isSafeInteger(future.preparationWireBytes));
});

test('rejects extra renderer-supplied instructions/history/paths and oversized or malformed requests', async () => {
  const fixture = createFixture();
  await assert.rejects(createContextPreview({ source: 'home', visibleText: 'x', globalText: 'override' }, fixture.dependencies), /дополнительные поля/);
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x', messages: [] }, fixture.dependencies), /дополнительные поля/);
  await assert.rejects(createContextPreview({ source: 'home', visibleText: 'x'.repeat(100_001) }, fixture.dependencies), /100 000 символов/);
  await assert.rejects(createContextPreview({ source: 'chat', chatId: '../outside', visibleText: 'x' }, fixture.dependencies), /идентификатор/);
  await assert.rejects(createContextPreview({ source: 'home', chatId: detail.id, visibleText: 'x' }, fixture.dependencies), /дополнительные поля/);
  await assert.rejects(createContextPreview({ source: 'other', visibleText: 'x' }, fixture.dependencies), /Неизвестный источник/);
});

test('fails closed for missing projects, disabled or cross-project Skills, active turns and late binding changes', async () => {
  const missingProject = createFixture({ projects: [] });
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, missingProject.dependencies), /проект недоступен/);

  const disabledSkill = createFixture({ onGetEnabledSkill: () => null });
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, disabledSkill.dependencies), /Skill отсутствует или выключен/);

  const wrongProjectSkill = createFixture({ onGetEnabledSkill: () => ({ ...skill, projectId: 'project-elsewhere' }) });
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, wrongProjectSkill.dependencies), /другому проекту/);

  const activeTurn = createFixture({ active: true });
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, activeTurn.dependencies), /выполняется или ожидает ход/);

  const changedBinding = createFixture({ onGetChat: (call) => call === 1 ? detail : { ...detail, modelId: 'GigaChat-2-Max' } });
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, changedBinding.dependencies), /изменился во время предпросмотра/);

  const changedProjectInstructions = createFixture({ onListProjects: (call) => call === 1 ? [project] : [{ ...project, workingFolder: 'C:\\work\\changed' }] });
  await assert.rejects(createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, changedProjectInstructions.dependencies), /изменился во время предпросмотра/);
});

test('a draft-only file selection gains the same files-only task but remains unknown and local', async () => {
  const file = { id: 'home-file-id', name: 'private-name.txt', storedName: 'private-stored-name.txt', size: 2048, sha256: 'c'.repeat(64), createdAt: at };
  const fixture = createFixture({ home: homeDraft({ projectId: null, skillId: null, attachments: [file] }) });
  const preview = await createContextPreview({ source: 'home', visibleText: '' }, fixture.dependencies);
  const assembled = fixture.assemblies[0]!;

  const lastMessage = assembled.messages[assembled.messages.length - 1];
  assert.equal(lastMessage?.text, '');
  assert.deepEqual(lastMessage?.attachmentIds, [file.id]);
  assert.ok(fixture.builtContexts[0]?.request.system.some((layer) => layer.text.includes('Проанализируй приложенные файлы')),
    'the accepted request builder adds the common files-only task layer');
  assert.equal(preview.pendingAttachments.count, 1);
  assert.equal(preview.pendingAttachments.sizeBytes, file.size);
  assert.ok(preview.unknownReasons.includes('pending-attachment-content'));
  assert.equal(JSON.stringify(preview).includes(file.id), false);
  assert.equal(JSON.stringify(preview).includes(file.name), false);
});

test('preview reads an enabled Skill without provisioning missing Skill folders or changing its files', async (t) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'gigachat-context-preview-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const sourcePath = join(userDataPath, 'skills', 'global', 'review', 'SKILL.md');
  const enabledPath = join(userDataPath, 'skills', 'enabled.json');
  const unrelatedProjectRoot = join(userDataPath, 'skills', 'projects', project.id);
  const sourceContents = `---\nname: Review\ndescription: Проверка\n---\nПрименяй только локально сохранённые правила.`;
  const enabledContents = `${JSON.stringify({ schemaVersion: 1, enabled: ['global/review'] }, null, 2)}\n`;
  await mkdir(join(userDataPath, 'skills', 'global', 'review'), { recursive: true });
  await writeFile(sourcePath, sourceContents, 'utf8');
  await writeFile(enabledPath, enabledContents, 'utf8');
  const skills = createSkillRegistry({ userDataPath, listProjects: async () => [project] });
  const fixture = createFixture({ home: homeDraft({ projectId: null, skillId: 'global/review' }) });

  const preview = await createContextPreview({ source: 'home', visibleText: 'visible' }, {
    ...fixture.dependencies,
    skills,
  });

  assert.ok(preview.blocks.some((block) => block.source === 'skill' && block.count === 1));
  assert.equal(await readFile(sourcePath, 'utf8'), sourceContents);
  assert.equal(await readFile(enabledPath, 'utf8'), enabledContents);
  assert.equal(await lstat(unrelatedProjectRoot).catch(() => null), null,
    'preview lookup must not provision an unrelated project Skill root');
});

test('authenticated preview applies current ownership, while no-key preview stays neutral and reports unknown wire size', async () => {
  const emptyOwnership: ProviderStateOwnershipView = { messages: [], receipts: [], compact: null };
  const stateOnlyChat: ChatDetail = {
    ...detail,
    projectId: null,
    messages: [{ ...lastAssistant, functionsStateId: 'private-state-sentinel' }],
    toolReceipts: [],
    artifacts: [],
    draftAttachments: [],
    compactSnapshot: null,
    nextTurnSkillId: null,
  };
  const unownedFixture = createFixture({ chat: stateOnlyChat, ownership: emptyOwnership });
  const unowned = await createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'private-preview-text' }, unownedFixture.dependencies);
  const unownedContext = unownedFixture.builtContexts[0]!;
  assert.equal(unownedContext.request.messages.find((message) => message.id === lastAssistant.id)?.functionsStateId, undefined);
  assert.equal(unowned.unknownReasons.includes('opaque-function-state'), false,
    'the unknown marker follows the filtered request rather than private raw history');

  const noKeyFixture = createFixture({ chat: stateOnlyChat, ownership: null });
  const noKey = await createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'private-preview-text' }, noKeyFixture.dependencies);
  assert.equal(noKeyFixture.builtContexts[0]?.request.messages.find((message) => message.id === lastAssistant.id)?.functionsStateId,
    'private-state-sentinel', 'without a configured key the preview does not invent ownership or rewrite history');
  assert.equal(noKey.preparationWireBytes, null);
  assert.ok(noKey.unknownReasons.includes('opaque-function-state'));
  assert.deepEqual(noKeyFixture.ownershipChatIds, [detail.id, detail.id]);
  assert.equal(JSON.stringify(noKey).includes('private-state-sentinel'), false);
  assert.equal(JSON.stringify(noKey).includes('private-preview-text'), false);
});

test('unowned historical file state is rejected, but a file attached to the current preview stays staged', async () => {
  const emptyOwnership: ProviderStateOwnershipView = { messages: [], receipts: [], compact: null };
  const historical = createFixture({ ownership: emptyOwnership });
  await assert.rejects(
    createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, historical.dependencies),
    (error: unknown) => error instanceof Error && error.message === HISTORICAL_PROVIDER_STATE_ATTACHMENTS_MESSAGE,
  );

  const currentFile = {
    id: 'current-only-file', name: 'current.txt', storedName: 'local-current.txt', size: 17,
    sha256: 'd'.repeat(64), createdAt: at,
  };
  const currentOnlyChat: ChatDetail = {
    ...detail,
    projectId: null,
    messages: [],
    toolReceipts: [],
    artifacts: [],
    draftAttachments: [currentFile],
    compactSnapshot: null,
    nextTurnSkillId: null,
  };
  const current = createFixture({ chat: currentOnlyChat, ownership: emptyOwnership });
  const preview = await createContextPreview({ source: 'chat', chatId: detail.id, visibleText: '' }, current.dependencies);
  const currentRequest = current.builtContexts[0]?.request;
  assert.deepEqual(currentRequest?.messages[currentRequest.messages.length - 1]?.attachmentIds, [currentFile.id]);
  assert.equal(preview.pendingAttachments.count, 1);
  assert.ok(preview.unknownReasons.includes('pending-attachment-content'));
  assert.equal(preview.historicalAttachments.count, 0);
  assert.equal(JSON.stringify(preview).includes(currentFile.id), false);
});

test('ownership changes are detected before publishing and the compact raw prefix is validated first', async () => {
  const emptyOwnership: ProviderStateOwnershipView = { messages: [], receipts: [], compact: null };
  const ownershipRace = createFixture({
    onGetOwnership: (_chatId, call) => call === 1
      ? {
        messages: [{ messageId: lastAssistant.id, owned: true }],
        receipts: [{ receiptId: protocolReceipt.receiptId, anchorMessageId: protocolReceipt.anchorMessageId, owned: true, wireOwned: false }],
        compact: null,
      }
      : emptyOwnership,
  });
  await assert.rejects(
    createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, ownershipRace.dependencies),
    /изменился во время предпросмотра/,
  );

  const corruptedChat: ChatDetail = {
    ...detail,
    compactSnapshot: { ...compactSnapshot, coveredPrefixHash: 'f'.repeat(64) },
  };
  const corrupted = createFixture({ chat: corruptedChat, ownership: emptyOwnership });
  await assert.rejects(
    createContextPreview({ source: 'chat', chatId: detail.id, visibleText: 'x' }, corrupted.dependencies),
    /История под сводкой изменилась/,
  );
});

test('Store-backed ownership survives A to B to A previews and remains private across reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-context-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await store.createChat(null, 'text');
  const accepted = await store.acceptLocalMessage(chat.id, 'Private accepted anchor.', 'preview-owner-turn');
  const protocolStateId = 'b1e2d3c4-5566-7a88-8b99-aabbccddeeff';
  const receiptInput = {
    receiptId: 'd'.repeat(64), name: 'read', arguments: { path: 'private/read-fixture.txt' },
    content: null, functionsStateId: protocolStateId,
  };
  const protocolWire = {
    content: [{ function_call: { name: 'read', arguments: { path: 'private/read-fixture.txt' } } }],
    messageId: 'private-protocol-message-A', toolStateId: protocolStateId,
  };
  assert.equal((await store.beginToolReceipt(chat.id, accepted.turn.messageId, receiptInput,
    createHash('sha256').update('synthetic-key-A').digest('hex'), protocolWire)).shouldExecute, true);
  await store.completeToolReceipt(chat.id, accepted.turn.messageId, receiptInput.receiptId, 'completed',
    JSON.stringify({ ok: true, result: 'Private read result.' }));
  const acceptedRecord = accepted.detail.turns.find((turn) => turn.turnId === accepted.turn.turnId);
  assert.ok(acceptedRecord);
  const terminal: RuntimeTurnSnapshot = {
    id: accepted.turn.turnId,
    chatId: chat.id,
    anchorMessageId: accepted.turn.messageId,
    assistantMessageId: accepted.turn.assistantMessageId,
    modelId: accepted.turn.modelId,
    status: 'completed',
    createdAt: acceptedRecord.createdAt,
    endedAt: at,
    activity: [],
  };
  await store.appendAssistantMessageFromRuntime(accepted.turn, 'Private accepted answer.', terminal, undefined, 'private-state-A',
    createHash('sha256').update('synthetic-key-A').digest('hex'));
  const storedDetail = await store.getChat(chat.id);
  const stateMessage = storedDetail.messages.find((message) => message.functionsStateId === 'private-state-A');
  assert.ok(stateMessage);
  assert.deepEqual(storedDetail.toolReceipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    anchorMessageId: receipt.anchorMessageId,
    functionsStateId: receipt.functionsStateId,
    status: receipt.status,
  })), [{
    receiptId: receiptInput.receiptId,
    anchorMessageId: accepted.turn.messageId,
    functionsStateId: receiptInput.functionsStateId,
    status: 'completed',
  }]);
  const chatPath = join(await store.getChatFolder(chat.id), 'chat.json');
  const rawBefore = await readFile(chatPath);
  const scopeA = createHash('sha256').update('synthetic-key-A').digest('hex');
  const scopeB = createHash('sha256').update('synthetic-key-B').digest('hex');
  const fixture = createFixture({ chat: storedDetail });
  fixture.dependencies.store.getToolProtocolThrough = store.getToolProtocolThrough.bind(store);
  const activeStore: LocalStore = store;
  const dependencies: ContextPreviewDependencies = {
    ...fixture.dependencies,
    store,
    getProviderStateOwnership: async (chatId) => {
      assert.equal(chatId, chat.id);
      return activeStore.getProviderStateOwnership(chatId, activeScope);
    },
  };
  let activeScope = scopeA;
  const preview = async (): Promise<void> => {
    await createContextPreview({ source: 'chat', chatId: chat.id, visibleText: 'private visible text' }, dependencies);
  };

  await preview();
  assert.equal(fixture.builtContexts[0]?.request.messages.find((message) => message.id === stateMessage.id)?.functionsStateId,
    'private-state-A');
  assert.equal(fixture.builtContexts[0]?.request.protocolHistory?.[0]?.functionsStateId, protocolStateId);
  assert.deepEqual(fixture.builtContexts[0]?.request.protocolHistory?.[0]?.wire, protocolWire);
  activeScope = scopeB;
  await preview();
  assert.equal(fixture.builtContexts[1]?.request.messages.find((message) => message.id === stateMessage.id)?.functionsStateId, undefined);
  assert.equal(fixture.builtContexts[1]?.request.protocolHistory?.[0]?.functionsStateId, null,
    'a foreign account loses only the outbound state pointer while keeping the raw receipt');
  assert.equal(fixture.builtContexts[1]?.request.protocolHistory?.[0]?.wire, undefined,
    'the foreign account cannot receive the private V2 wire');
  activeScope = scopeA;
  await preview();
  assert.equal(fixture.builtContexts[2]?.request.messages.find((message) => message.id === stateMessage.id)?.functionsStateId,
    'private-state-A');
  assert.equal(fixture.builtContexts[2]?.request.protocolHistory?.[0]?.functionsStateId, protocolStateId);
  assert.deepEqual(fixture.builtContexts[2]?.request.protocolHistory?.[0]?.wire, protocolWire);
  assert.deepEqual(await store.getChat(chat.id), storedDetail, 'previews do not mutate raw messages or tool receipts');

  const reopened = await openStore(directory);
  const reopenedDetail = await reopened.getChat(chat.id);
  assert.equal(reopenedDetail.messages.find((message) => message.id === stateMessage.id)?.functionsStateId, 'private-state-A');
  assert.equal((await reopened.getProviderStateOwnership(chat.id, scopeA)).messages.find((entry) => entry.messageId === stateMessage.id)?.owned, true);
  assert.equal((await reopened.getProviderStateOwnership(chat.id, scopeB)).messages.find((entry) => entry.messageId === stateMessage.id)?.owned, false);
  const reopenedReceipt = reopenedDetail.toolReceipts.find((receipt) => receipt.receiptId === receiptInput.receiptId);
  assert.equal(reopenedReceipt?.functionsStateId, protocolStateId);
  assert.equal(reopenedReceipt?.status, 'completed');
  assert.equal((await reopened.getProviderStateOwnership(chat.id, scopeA)).receipts.find((entry) => entry.receiptId === receiptInput.receiptId)?.owned, true);
  assert.equal((await reopened.getProviderStateOwnership(chat.id, scopeB)).receipts.find((entry) => entry.receiptId === receiptInput.receiptId)?.owned, false);
  assert.deepEqual(await readFile(chatPath), rawBefore, 'preview and ownership reads must not rewrite public history or private bindings');

  const reopenedFixture = createFixture({ chat: reopenedDetail });
  reopenedFixture.dependencies.store.getToolProtocolThrough = reopened.getToolProtocolThrough.bind(reopened);
  const publicPreview = await createContextPreview(
    { source: 'chat', chatId: chat.id, visibleText: 'private visible text' },
    {
      ...reopenedFixture.dependencies,
      store: reopened,
      getProviderStateOwnership: async (chatId) => {
        assert.equal(chatId, chat.id);
        return reopened.getProviderStateOwnership(chatId, scopeA);
      },
    },
  );
  assert.equal(reopenedFixture.builtContexts[0]?.request.messages.find((message) => message.id === stateMessage.id)?.functionsStateId,
    'private-state-A');
  assert.equal(reopenedFixture.builtContexts[0]?.request.protocolHistory?.[0]?.functionsStateId, protocolStateId);
  assert.deepEqual(reopenedFixture.builtContexts[0]?.request.protocolHistory?.[0]?.wire, protocolWire);
  const serialized = JSON.stringify(publicPreview);
  for (const secret of [scopeA, scopeB, 'synthetic-key-A', 'synthetic-key-B', 'private-state-A', protocolStateId,
    'private-protocol-message-A', receiptInput.receiptId, 'private/read-fixture.txt', 'private visible text']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(await reopened.getChat(chat.id), reopenedDetail);
  assert.deepEqual(await readFile(chatPath), rawBefore, 'reopened preview also leaves persisted public history and private bindings byte-identical');
});

test('the shared key-generation guard rejects A to B to A and a transition during an ownership read', async () => {
  const fixture = createFixture({ home: homeDraft({ projectId: null, skillId: null }) });
  const guard = createBalanceScopeGuard();
  const transitionTwice = async (): Promise<void> => {
    await guard.runStable(async () => {
      const dependencies = {
        ...fixture.dependencies,
        getProviderStateOwnership: async (chatId: string | null) => {
          const ownership = await fixture.dependencies.getProviderStateOwnership(chatId);
          const changeToB = guard.beginTransition();
          changeToB();
          const changeBackToA = guard.beginTransition();
          changeBackToA();
          return ownership;
        },
      };
      await createContextPreview({ source: 'home', visibleText: 'x' }, dependencies);
    });
  };
  await assert.rejects(transitionTwice(), /Ключ аккаунта изменился/);

  let entered!: () => void;
  let release!: () => void;
  const ownershipEntered = new Promise<void>((resolve) => { entered = resolve; });
  const ownershipRelease = new Promise<void>((resolve) => { release = resolve; });
  const secondGuard = createBalanceScopeGuard();
  const inFlight = secondGuard.runStable(() => createContextPreview({ source: 'home', visibleText: 'x' }, {
    ...fixture.dependencies,
    getProviderStateOwnership: async (chatId) => {
      const ownership = await fixture.dependencies.getProviderStateOwnership(chatId);
      entered();
      await ownershipRelease;
      return ownership;
    },
  }));
  await ownershipEntered;
  const changedKey = secondGuard.beginTransition();
  changedKey();
  release();
  await assert.rejects(inFlight, /Ключ аккаунта изменился/);

  const sourceGuard = createBalanceScopeGuard();
  const sourceFixture = createFixture({
    home: homeDraft({ projectId: null, skillId: null }),
    onGetHomeDraft: (call) => {
      if (call === 2) {
        const changed = sourceGuard.beginTransition();
        changed();
      }
      return homeDraft({ projectId: null, skillId: null });
    },
  });
  await assert.rejects(
    sourceGuard.runStable(() => createContextPreview({ source: 'home', visibleText: 'x' }, sourceFixture.dependencies)),
    /Ключ аккаунта изменился/,
    'the same main guard covers latest source reads as well as ownership reads',
  );
});
