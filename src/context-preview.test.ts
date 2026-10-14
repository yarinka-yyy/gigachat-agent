import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatDetail, ChatMessage, CompactSnapshot, HomeDraftRecord, Project, Settings } from './contracts';
import { buildNextTurnContext, hashCompactionPrefix, type NextTurnContext, type NextTurnContextInput } from './context';
import { createContextPreview, type ContextPreviewDependencies } from './context-preview';
import type { LocalStore } from './store';
import { createSkillRegistry, type SkillRegistry } from './skills';

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
  toolReceipts: [], artifacts: [{
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
} = {}): { dependencies: ContextPreviewDependencies; calls: Record<string, number>; assemblies: NextTurnContextInput[]; builtContexts: NextTurnContext[] } {
  const calls: Record<string, number> = {};
  const assemblies: NextTurnContextInput[] = [];
  const builtContexts: NextTurnContext[] = [];
  const count = (key: string): number => { calls[key] = (calls[key] ?? 0) + 1; return calls[key]!; };
  const sourceHome = options.home ?? homeDraft();
  const sourceChat = options.chat ?? detail;
  const sourceSettings = options.settings ?? settings;
  const sourceProjects = options.projects ?? [project];
  const sourceSkill = options.enabledSkill === undefined ? skill : options.enabledSkill;
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
      return [{
        anchorMessageId: lastUser.id, name: 'read', arguments: { path: 'private/path.txt' }, content: null,
        functionsStateId: 'opaque-protocol-state', result: JSON.stringify({ result: 'Private local tool result.' }),
      }];
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
    buildContext: (input, buildOptions) => {
      assemblies.push(structuredClone(input));
      const built = buildNextTurnContext(input, buildOptions);
      builtContexts.push(built);
      return built;
    },
  };
  return { dependencies, calls, assemblies, builtContexts };
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
  assert.deepEqual(assembled.messages.slice(-3).map((message) => message.text), [
    lastUser.text, lastAssistant.text, 'Current visible prompt',
  ]);
  assert.deepEqual(assembled.protocolHistory?.map((exchange) => exchange.anchorMessageId), [lastUser.id]);
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
