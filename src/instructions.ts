import type { ChatMessage, CompactSnapshot, InstructionLayer, ProviderProtocolExchange, ProviderTurnRequest, UsageRequestKind } from './contracts';
import { requirePermissionProfile, type PermissionProfile } from './permissions';
import { requireModelId, type GigaChatModelId } from './models';

export interface ProjectInstructionSource {
  scope: string;
  text: string;
}

export interface InstructionInput {
  globalText: string;
  projectInstructions?: readonly ProjectInstructionSource[];
  selectedSkill?: { name: string; scope: string; text: string } | null;
  messages: readonly ChatMessage[];
  protocolHistory?: readonly ProviderProtocolExchange[];
  compactSnapshot?: Pick<CompactSnapshot, 'text'> | null;
  taskInstruction?: string;
  permissionProfile: PermissionProfile;
  modelId?: GigaChatModelId | null;
  maxOutputTokens?: number;
  compactionFormat?: 'semantic';
  usageKind?: UsageRequestKind;
  functionCallMode?: 'auto' | 'none';
}

export const APP_RUNTIME_RULES = [
  'Follow the application permission decision for every local action.',
  'Use only tools available to the current runtime and report their measured outcomes.',
  'Do not claim that a local message was sent to GigaChat unless a provider confirms completion.',
].join('\n');

function addLayer(
  layers: InstructionLayer[],
  source: InstructionLayer['source'],
  label: string,
  text: string,
  scope?: string,
): void {
  const normalized = text.trim();
  if (!normalized) return;
  layers.push({ source, label, ...(scope ? { scope } : {}), text: normalized });
}

function requestOnlyCompactionMessageId(messages: readonly ChatMessage[]): string {
  const base = `request-compaction-${messages[messages.length - 1]?.id ?? 'empty'}`;
  const messageIds = new Set(messages.map((message) => message.id));
  if (!messageIds.has(base)) return base;
  let suffix = 1;
  while (messageIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function buildInstructionRequest(input: InstructionInput): ProviderTurnRequest {
  if (!Array.isArray(input.messages) || !Array.isArray(input.projectInstructions ?? [])) {
    throw new Error('Некорректные слои инструкций.');
  }
  if (input.compactionFormat !== undefined && (input.compactionFormat !== 'semantic' || input.usageKind !== 'compaction')) {
    throw new Error('Семантический формат разрешён только для запроса сжатия.');
  }
  const permissionProfile = requirePermissionProfile(input.permissionProfile);
  const modelId = input.modelId === null || input.modelId === undefined ? null : requireModelId(input.modelId);
  const layers: InstructionLayer[] = [];
  addLayer(layers, 'runtime', 'Правила приложения', APP_RUNTIME_RULES);
  addLayer(layers, 'global', 'GIGACHAT.md', input.globalText);
  for (const project of input.projectInstructions ?? []) {
    if (!project || typeof project.scope !== 'string' || !project.scope.trim() || typeof project.text !== 'string') {
      throw new Error('Некорректный источник инструкций проекта.');
    }
    addLayer(layers, 'project', 'AGENTS.md', project.text, project.scope.trim());
  }
  const messages = input.messages.map((message) => ({ ...message }));
  if (input.selectedSkill) {
    if (!input.selectedSkill.name.trim() || !input.selectedSkill.scope.trim()) {
      throw new Error('Некорректный источник Skill.');
    }
    addLayer(layers, 'skill', input.selectedSkill.name.trim(), input.selectedSkill.text, input.selectedSkill.scope.trim());
  }
  if (input.compactSnapshot) {
    addLayer(layers, 'summary', 'Сводка предыдущей истории', input.compactSnapshot.text);
  }
  if (input.taskInstruction !== undefined) {
    if (typeof input.taskInstruction !== 'string') throw new Error('Некорректная задача контекста.');
    if (input.usageKind === 'compaction') {
      if (input.taskInstruction.trim()) {
        messages.push({
          id: requestOnlyCompactionMessageId(messages),
          role: 'user',
          text: input.taskInstruction,
          createdAt: messages[messages.length - 1]?.createdAt ?? '1970-01-01T00:00:00.000Z',
        });
      }
    } else addLayer(layers, 'runtime', 'Задача текущего запроса', input.taskInstruction);
  }

  return {
    system: layers,
    messages,
    protocolHistory: (input.protocolHistory ?? []).map((exchange) => structuredClone(exchange)),
    permissionProfile,
    modelId,
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.compactionFormat ? { compactionFormat: input.compactionFormat } : {}),
    ...(input.usageKind ? { usageKind: input.usageKind } : {}),
    ...(input.compactionFormat === 'semantic' ? { functionCallMode: 'none' as const }
      : input.functionCallMode ? { functionCallMode: input.functionCallMode } : {}),
  };
}
