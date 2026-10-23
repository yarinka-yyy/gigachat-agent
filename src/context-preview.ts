import { createHash, randomUUID } from 'node:crypto';
import type {
  ChatDetail,
  ContextBlockSize,
  ContextPreviewBlockSummary,
  ContextPreviewRequest,
  ContextPreviewUnknownReason,
  ContextPreviewView,
  ContextPromptEstimate,
  ContextPromptEstimateReason,
  ContextWorkingBudgetView,
  HomeDraftRecord,
  Project,
  Settings,
} from './contracts';
import { buildNextTurnContext, estimateProviderPromptTokens, hashCompactionPrefix, type BuildNextTurnContextOptions, type NextTurnContext, type NextTurnContextInput } from './context';
import { calculateLiteWorkingBudget } from './context-budget';
import { getModelContextLimit } from './model-capabilities';
import { LOCAL_TOKENIZER_MODEL_ID } from './local-tokenizer';
import type { LocalStore, ProviderStateOwnershipView } from './store';
import type { SkillRegistry } from './skills';

const MAX_PREVIEW_TEXT_LENGTH = 100_000;
const PREVIEW_MESSAGE_ID_PREFIX = 'context-preview-';

type PreviewStore = Pick<LocalStore,
  | 'getSettings'
  | 'getHomeDraft'
  | 'getChat'
  | 'listProjects'
  | 'readGlobalInstructions'
  | 'readProjectInstructions'
  | 'getToolProtocolThrough'
>;

export interface ContextPreviewDependencies {
  store: PreviewStore;
  skills: Pick<SkillRegistry, 'getEnabledReadOnly'>;
  hasActiveTurn(chatId: string): boolean;
  getProviderStateOwnership(chatId: string | null): Promise<ProviderStateOwnershipView | null>;
  buildContext?: (input: NextTurnContextInput, options?: BuildNextTurnContextOptions) => ReturnType<typeof buildNextTurnContext>;
  estimateTextTokens?: (context: NextTurnContext) => Promise<number>;
  estimatePromptTokens?: (context: NextTurnContext) => Promise<ContextPromptEstimate>;
}

type PreviewSourceRecord = HomeDraftRecord | ChatDetail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Некорректный идентификатор источника предпросмотра.');
  }
  return value;
}

function parseInput(value: unknown): ContextPreviewRequest {
  if (!isRecord(value) || typeof value.visibleText !== 'string'
    || value.visibleText.length > MAX_PREVIEW_TEXT_LENGTH) {
    throw new Error('Предпросмотр принимает только видимый текст до 100 000 символов.');
  }
  if (value.source === 'home') {
    if (Object.keys(value).some((key) => key !== 'source' && key !== 'visibleText')) {
      throw new Error('В предпросмотр нельзя передавать инструкции, историю или дополнительные поля.');
    }
    return { source: 'home', visibleText: value.visibleText };
  }
  if (value.source === 'chat') {
    if (Object.keys(value).some((key) => !['source', 'chatId', 'visibleText'].includes(key))) {
      throw new Error('В предпросмотр нельзя передавать инструкции, историю или дополнительные поля.');
    }
    return { source: 'chat', chatId: requireId(value.chatId), visibleText: value.visibleText };
  }
  throw new Error('Неизвестный источник предпросмотра.');
}

function sourceSignature(source: PreviewSourceRecord): string {
  if ('revision' in source) {
    return JSON.stringify({
      revision: source.revision,
      projectId: source.projectId,
      permissionProfile: source.permissionProfile,
      skillId: source.skillId,
      modelId: source.modelId,
      attachments: source.attachments.map(({ id, size, sha256 }) => ({ id, size, sha256 })),
    });
  }
  const compactionMaterialSignature = createHash('sha256').update(JSON.stringify({
    toolReceipts: source.toolReceipts.map(({ anchorMessageId, name, arguments: callArguments, content, status, result }) => ({
      anchorMessageId, name, arguments: callArguments, content, status, result,
    })),
    artifacts: source.artifacts.map(({ id, name, size, sha256, messageId }) => ({ id, name, size, sha256, messageId })),
  })).digest('hex');
  return JSON.stringify({
    id: source.id,
    projectId: source.projectId,
    modelId: source.modelId,
    nextTurnPermissionProfile: source.nextTurnPermissionProfile,
    nextTurnSkillId: source.nextTurnSkillId,
    draft: source.draft,
    messageHistory: hashCompactionPrefix(source.messages, []),
    compactSnapshotId: source.compactSnapshot?.id ?? null,
    compactPrefixHash: source.compactSnapshot?.coveredPrefixHash ?? null,
    compactSummary: source.compactSnapshot?.text ?? null,
    compactionMaterialSignature,
    draftAttachments: source.draftAttachments.map(({ id, size, sha256 }) => ({ id, size, sha256 })),
    activeStoredTurn: source.turns.some((turn) => turn.status === 'queued' || turn.status === 'running'),
  });
}

function projectSignature(project: Project | null): string {
  return JSON.stringify(project ? {
    id: project.id, name: project.name, workingFolder: project.workingFolder, archived: project.archived,
  } : null);
}

function settingsSignature(settings: Settings): string {
  return JSON.stringify({
    defaultModelId: settings.defaultModelId,
    defaultPermissionProfile: settings.defaultPermissionProfile,
  });
}

function skillSignature(skill: Awaited<ReturnType<SkillRegistry['getEnabled']>>): string {
  return JSON.stringify(skill ? {
    id: skill.id,
    name: skill.name,
    scope: skill.scope,
    projectId: skill.projectId,
    instructions: skill.instructions,
  } : null);
}

function ownershipSignature(ownership: ProviderStateOwnershipView | null): string {
  return ownership === null ? 'null' : JSON.stringify(ownership);
}

function aggregateBlocks(blocks: readonly ContextBlockSize[]): ContextPreviewBlockSummary[] {
  const sourceOrder: ContextBlockSize['source'][] = [
    'runtime', 'global', 'project', 'skill', 'summary', 'message', 'protocol', 'function-schema',
  ];
  const totals = new Map<ContextBlockSize['source'], { count: number; utf8Bytes: number }>();
  for (const block of blocks) {
    const current = totals.get(block.source) ?? { count: 0, utf8Bytes: 0 };
    current.count += 1;
    current.utf8Bytes += block.utf8Bytes;
    totals.set(block.source, current);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => sourceOrder.indexOf(left) - sourceOrder.indexOf(right))
    .map(([source, total]) => ({ source, ...total }));
}

function sumAttachmentSizes(attachments: readonly { size: number }[]): number {
  return attachments.reduce((total, attachment) => total + attachment.size, 0);
}

function historicalAttachmentSummary(detail: ChatDetail | null): { count: number; sizeBytes: number | null; metadataMissing: boolean } {
  if (!detail) return { count: 0, sizeBytes: 0, metadataMissing: false };
  const referenced = new Set(detail.messages.flatMap((message) => message.role === 'user' ? message.attachmentIds ?? [] : []));
  if (!referenced.size) return { count: 0, sizeBytes: 0, metadataMissing: false };
  const linkedArtifacts = new Map(detail.artifacts
    .filter((artifact) => artifact.messageId !== null && referenced.has(artifact.id))
    .map((artifact) => [artifact.id, artifact]));
  let sizeBytes = 0;
  for (const artifact of linkedArtifacts.values()) sizeBytes += artifact.size;
  const metadataMissing = linkedArtifacts.size !== referenced.size;
  return { count: referenced.size, sizeBytes: metadataMissing ? null : sizeBytes, metadataMissing };
}

function activeTurnExists(detail: ChatDetail, hasActiveTurn: (chatId: string) => boolean): boolean {
  return detail.turns.some((turn) => turn.status === 'queued' || turn.status === 'running') || hasActiveTurn(detail.id);
}

function unknownPromptEstimate(reason: ContextPromptEstimateReason = 'tokenizer-unavailable'): ContextPromptEstimate {
  return {
    status: 'unknown', tokens: null, knownTokens: null, provenance: 'unknown',
    wireMessageCount: null, functionCallCount: null, unknownReasons: [reason],
  };
}

function isOptionalLocalTokenizerFailure(error: unknown): boolean {
  return error instanceof Error && ['LOCAL_TOKENIZER_UNAVAILABLE', 'LOCAL_TOKENIZER_RESOURCE_UNAVAILABLE',
    'LOCAL_TOKENIZER_RESOURCE_INVALID'].includes(error.message);
}

function withAttachmentContentUnknown(estimate: ContextPromptEstimate): ContextPromptEstimate {
  const unknownReasons = [...new Set([...estimate.unknownReasons, 'attachment-content' as const])];
  return {
    ...estimate,
    status: estimate.status === 'unknown' ? 'unknown' : 'partial',
    tokens: null,
    provenance: estimate.status === 'unknown' ? 'unknown' : 'estimated',
    unknownReasons,
  };
}

function unknownWorkingBudget(): ContextWorkingBudgetView {
  return {
    status: 'unknown', budgetTokens: null, provenance: 'unknown',
    compactionStatus: 'unknown', compactionOverheadTokens: null, operationalProfile: null,
  };
}

export async function createContextPreview(
  inputValue: unknown,
  dependencies: ContextPreviewDependencies,
): Promise<ContextPreviewView> {
  const input = parseInput(inputValue);
  const { store, skills, hasActiveTurn } = dependencies;
  const settings = await store.getSettings();
  const initialSource: PreviewSourceRecord = input.source === 'home'
    ? await store.getHomeDraft()
    : await store.getChat(input.chatId);
  const homeDraft = input.source === 'home' ? initialSource as HomeDraftRecord : null;
  const detail = input.source === 'chat' ? initialSource as ChatDetail : null;
  if (input.source === 'chat' && detail && detail.id !== input.chatId) {
    throw new Error('Чат предпросмотра не совпал с выбранным источником.');
  }
  if (detail && activeTurnExists(detail, hasActiveTurn)) {
    throw new Error('Предпросмотр временно недоступен, пока в чате выполняется или ожидает ход.');
  }

  const projectId = initialSource.projectId;
  const projects = await store.listProjects();
  const project = projectId ? projects.find((item) => item.id === projectId) ?? null : null;
  if (projectId && (!project || (input.source === 'home' && project.archived))) {
    throw new Error('Выбранный проект недоступен; предпросмотр не изменил черновик.');
  }

  const modelId = initialSource.modelId ?? settings.defaultModelId;
  const permissionProfile = homeDraft
    ? homeDraft.permissionProfile ?? settings.defaultPermissionProfile
    : detail!.nextTurnPermissionProfile ?? settings.defaultPermissionProfile;
  const skillId = homeDraft ? homeDraft.skillId : detail!.nextTurnSkillId;
  const selectedSkill = skillId === null ? null : await skills.getEnabledReadOnly(skillId);
  if (skillId !== null && !selectedSkill) throw new Error('Выбранный Skill отсутствует или выключен.');
  if (selectedSkill?.scope === 'project' && selectedSkill.projectId !== projectId) {
    throw new Error('Выбранный Skill относится к другому проекту.');
  }

  const projectInstructions = project
    ? await store.readProjectInstructions(project.id, project.workingFolder)
    : '';
  const globalText = await store.readGlobalInstructions();
  const latestUser = detail ? [...detail.messages].reverse().find((message) => message.role === 'user') : undefined;
  const protocolHistory = detail && latestUser
    ? await store.getToolProtocolThrough(detail.id, latestUser.id)
    : [];
  const protocolHistorySignature = hashCompactionPrefix([], protocolHistory);
  const ownershipChatId = detail?.id ?? null;
  const providerStateOwnership = await dependencies.getProviderStateOwnership(ownershipChatId);
  const pendingAttachments = homeDraft ? homeDraft.attachments : detail!.draftAttachments;
  const previewMessage = {
    id: `${PREVIEW_MESSAGE_ID_PREFIX}${randomUUID()}`,
    role: 'user' as const,
    text: input.visibleText.trim(),
    createdAt: new Date().toISOString(),
    ...(pendingAttachments.length ? { attachmentIds: pendingAttachments.map((attachment) => attachment.id) } : {}),
  };
  const messages = [...(detail?.messages ?? []), previewMessage];
  const context = (dependencies.buildContext ?? buildNextTurnContext)({
    globalText,
    projectInstructions: project ? [{ scope: project.name, text: projectInstructions }] : [],
    selectedSkill: selectedSkill ? {
      name: selectedSkill.name,
      scope: selectedSkill.scope === 'global' ? 'Global' : `Project · ${selectedSkill.projectName ?? project?.name ?? 'неизвестный проект'}`,
      text: selectedSkill.instructions,
    } : null,
    messages,
    protocolHistory,
    compactSnapshot: detail?.compactSnapshot ?? null,
    compactionToolReceipts: detail?.toolReceipts,
    compactionArtifacts: detail?.artifacts,
    permissionProfile,
    modelId,
  }, {
    allowMissingModelForPreview: true,
    ...(detail && providerStateOwnership ? {
      providerStateFilter: {
        detail,
        ownership: providerStateOwnership,
        currentAnchorMessageId: previewMessage.id,
      },
    } : {}),
  });

  let estimatedTokens: number | null = null;
  if (context.request.modelId === LOCAL_TOKENIZER_MODEL_ID && dependencies.estimateTextTokens) {
    try {
      const candidate = await dependencies.estimateTextTokens(context);
      if (Number.isSafeInteger(candidate) && candidate >= 0) estimatedTokens = candidate;
    } catch (error) {
      if (!isOptionalLocalTokenizerFailure(error)) throw error;
    }
  }

  const historyAttachments = historicalAttachmentSummary(detail);
  let promptEstimate = unknownPromptEstimate(modelId === LOCAL_TOKENIZER_MODEL_ID ? 'tokenizer-unavailable' : 'unsupported-model');
  let compactionOverheadTokens: number | null | undefined = null;
  if (modelId === LOCAL_TOKENIZER_MODEL_ID && dependencies.estimatePromptTokens) {
    try {
      promptEstimate = await dependencies.estimatePromptTokens(context);
    } catch (error) {
      if (!isOptionalLocalTokenizerFailure(error)) throw error;
      promptEstimate = unknownPromptEstimate();
    }
    if (detail && historyAttachments.count === 0 && !historyAttachments.metadataMissing) {
      let completedThrough = -1;
      for (let index = detail.messages.length - 1; index >= 0; index--) {
        if (detail.messages[index]?.role === 'assistant') { completedThrough = index; break; }
      }
      if (completedThrough >= 0) {
        try {
          const completedMessages = detail.messages.slice(0, completedThrough + 1);
          const completedUserIds = new Set(completedMessages.filter((message) => message.role === 'user').map((message) => message.id));
          const completedProtocol = protocolHistory.filter((exchange) => completedUserIds.has(exchange.anchorMessageId));
          const compactContext = buildNextTurnContext({
            globalText: '',
            projectInstructions: [],
            selectedSkill: null,
            messages: completedMessages,
            protocolHistory: completedProtocol,
            compactSnapshot: detail.compactSnapshot,
            compactionToolReceipts: detail.toolReceipts,
            compactionArtifacts: detail.artifacts,
            permissionProfile,
            modelId,
            usageKind: 'compaction',
            compactionFormat: 'semantic',
            functionCallMode: 'none',
          });
          const compactEstimate = await dependencies.estimatePromptTokens(compactContext);
          if (promptEstimate.status === 'complete' && Number.isSafeInteger(promptEstimate.tokens)
            && compactEstimate.status === 'complete' && Number.isSafeInteger(compactEstimate.tokens)) {
            compactionOverheadTokens = Math.max(0, compactEstimate.tokens! - promptEstimate.tokens!);
          } else compactionOverheadTokens = undefined;
        } catch (error) {
          if (!isOptionalLocalTokenizerFailure(error)) throw error;
          compactionOverheadTokens = undefined;
        }
      }
    } else if (detail) {
      compactionOverheadTokens = undefined;
    }
  }
  if (pendingAttachments.length > 0 || historyAttachments.count > 0 || historyAttachments.metadataMissing) {
    promptEstimate = withAttachmentContentUnknown(promptEstimate);
    if (historyAttachments.count > 0 || historyAttachments.metadataMissing) compactionOverheadTokens = undefined;
  }
  const promptShape = {
    wireMessageCount: promptEstimate.wireMessageCount,
    functionCallCount: promptEstimate.functionCallCount,
  };
  const workingBudget = modelId === LOCAL_TOKENIZER_MODEL_ID
    ? calculateLiteWorkingBudget(promptEstimate.status === 'complete' && promptEstimate.provenance === 'estimated'
      ? compactionOverheadTokens : undefined, promptShape)
    : unknownWorkingBudget();

  const [latestSettings, latestSource, latestProjects, latestGlobalText, latestProjectInstructions, latestSkill, latestProtocolHistory, latestOwnership] = await Promise.all([
    store.getSettings(),
    input.source === 'home' ? store.getHomeDraft() : store.getChat(input.chatId),
    store.listProjects(),
    store.readGlobalInstructions(),
    project ? store.readProjectInstructions(project.id, project.workingFolder) : Promise.resolve(''),
    skillId === null ? Promise.resolve(null) : skills.getEnabledReadOnly(skillId),
    detail && latestUser ? store.getToolProtocolThrough(detail.id, latestUser.id) : Promise.resolve([]),
    dependencies.getProviderStateOwnership(ownershipChatId),
  ]);
  const latestDetail = detail ? latestSource as ChatDetail : null;
  const latestUserMessage = latestDetail
    ? [...latestDetail.messages].reverse().find((message) => message.role === 'user')
    : undefined;
  const latestProject = projectId ? latestProjects.find((item) => item.id === projectId) ?? null : null;
  if (settingsSignature(settings) !== settingsSignature(latestSettings)
    || sourceSignature(initialSource) !== sourceSignature(latestSource)
    || projectSignature(project) !== projectSignature(latestProject)
    || globalText !== latestGlobalText || projectInstructions !== latestProjectInstructions
    || skillSignature(selectedSkill) !== skillSignature(latestSkill)
    || ownershipSignature(providerStateOwnership) !== ownershipSignature(latestOwnership)
    || protocolHistorySignature !== hashCompactionPrefix([], latestProtocolHistory)
    || (detail && latestUser?.id !== latestUserMessage?.id)
    || (latestDetail && activeTurnExists(latestDetail, hasActiveTurn))) {
    throw new Error('Выбор чата, проекта, Skill или инструкций изменился во время предпросмотра. Повторите проверку.');
  }

  const modelLimit = getModelContextLimit(modelId);
  const unknownReasons = new Set<ContextPreviewUnknownReason>();
  if (estimatedTokens === null) unknownReasons.add('token-estimate-unavailable');
  unknownReasons.add('prompt-framing-unmeasured');
  if (modelLimit.limitTokens === null) unknownReasons.add('model-limit-undocumented');
  if (pendingAttachments.length > 0) unknownReasons.add('pending-attachment-content');
  if (historyAttachments.count > 0) unknownReasons.add('historical-attachment-content');
  if (historyAttachments.metadataMissing) unknownReasons.add('historical-attachment-metadata');
  if (context.request.messages.some((message) => message.functionsStateId !== undefined && message.functionsStateId !== '')
    || (context.request.protocolHistory ?? []).some((exchange) => exchange.functionsStateId !== null)) {
    unknownReasons.add('opaque-function-state');
  }

  return {
    modelId,
    contextLimit: {
      tokens: modelLimit.limitTokens,
      provenance: modelLimit.provenance,
      source: modelLimit.source,
      verifiedAt: modelLimit.verifiedAt,
    },
    estimatedTokens,
    tokenEstimateProvenance: estimatedTokens === null ? 'unknown' : 'estimated',
    tokenEstimateScope: estimatedTokens === null ? null : 'text-blocks',
    promptEstimate,
    workingBudget,
    preparationWireBytes: providerStateOwnership === null ? null : context.wireBytes,
    maximumWireBytes: context.maxWireBytes,
    preparationWireBytesIncludeAttachments: false,
    blocks: aggregateBlocks(context.blocks),
    pendingAttachments: { count: pendingAttachments.length, sizeBytes: sumAttachmentSizes(pendingAttachments) },
    historicalAttachments: { count: historyAttachments.count, sizeBytes: historyAttachments.sizeBytes },
    unknownReasons: [...unknownReasons],
  };
}
