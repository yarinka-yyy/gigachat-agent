import type { ChatMessage, InstructionLayer, ProviderTurnRequest } from './contracts';
import { requirePermissionProfile, type PermissionProfile } from './permissions';

export interface ProjectInstructionSource {
  scope: string;
  text: string;
}

export interface InstructionInput {
  globalText: string;
  projectInstructions?: readonly ProjectInstructionSource[];
  selectedSkill?: { name: string; scope: string; text: string } | null;
  messages: readonly ChatMessage[];
  permissionProfile: PermissionProfile;
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

export function buildInstructionRequest(input: InstructionInput): ProviderTurnRequest {
  if (!Array.isArray(input.messages) || !Array.isArray(input.projectInstructions ?? [])) {
    throw new Error('Некорректные слои инструкций.');
  }
  const permissionProfile = requirePermissionProfile(input.permissionProfile);
  const layers: InstructionLayer[] = [];
  addLayer(layers, 'runtime', 'Правила приложения', APP_RUNTIME_RULES);
  addLayer(layers, 'global', 'GIGACHAT.md', input.globalText);
  for (const project of input.projectInstructions ?? []) {
    if (!project || typeof project.scope !== 'string' || !project.scope.trim() || typeof project.text !== 'string') {
      throw new Error('Некорректный источник инструкций проекта.');
    }
    addLayer(layers, 'project', 'AGENTS.md', project.text, project.scope.trim());
  }
  if (input.selectedSkill) {
    if (!input.selectedSkill.name.trim() || !input.selectedSkill.scope.trim()) {
      throw new Error('Некорректный источник Skill.');
    }
    addLayer(layers, 'skill', input.selectedSkill.name.trim(), input.selectedSkill.text, input.selectedSkill.scope.trim());
  }

  return {
    system: layers,
    messages: input.messages.map((message) => ({ ...message })),
    permissionProfile,
  };
}
