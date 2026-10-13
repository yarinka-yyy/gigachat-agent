import type { ModelRegistrySnapshot } from './contracts';
import { basicAgentWorkflowStatus, getModelCapabilities, type ModelCapabilities, type ModelCapabilityStatus } from './model-capabilities';
import { isModelAvailable } from './models';

export const CHAT_MODEL_FAMILIES = [
  {
    family: 'ultra', displayName: 'GigaChat Ultra', currentId: 'GigaChat-3-Ultra',
    legacyIds: [], billingAliases: ['GigaChat-Ultra'], poolEvidence: {
      kind: 'account-observed', source: 'official Freemium tariff + app/.qa/capability-spike/summary.md',
      verifiedAt: '2026-10-12', details: 'Бесплатный пул сопоставлен по официальному тарифу и реальной проверке установленного приложения.',
    },
  },
  {
    family: 'max', displayName: 'GigaChat Max', currentId: 'GigaChat-2-Max',
    legacyIds: ['GigaChat-Max'], poolEvidence: {
      kind: 'official-and-account-listed', source: 'official tariff + account pool card + current raw /models',
      verifiedAt: '2026-10-12', details: 'Пул Max указан официально и в карточке аккаунта; семантическая проверка текущего ID ещё не выполнена.',
    },
  },
  {
    family: 'pro', displayName: 'GigaChat Pro', currentId: 'GigaChat-3-Pro',
    legacyIds: ['GigaChat-Pro', 'GigaChat-2-Pro'], poolEvidence: {
      kind: 'account-observed', source: 'plans/011-model-evidence.md (Studio balance delta matched usage receipt)',
      verifiedAt: '2026-10-12', details: 'Соответствие бесплатному пулу Pro подтверждено изменением баланса аккаунта на сумму usage receipt.',
    },
  },
  {
    family: 'lite', displayName: 'GigaChat Lite', currentId: 'GigaChat-3-Lightning',
    legacyIds: ['GigaChat', 'GigaChat-2'], poolEvidence: {
      kind: 'account-observed', source: 'plans/011-model-evidence.md (Studio balance delta matched usage receipt)',
      verifiedAt: '2026-10-12', details: 'Соответствие бесплатному пулу Lite подтверждено изменением баланса аккаунта на сумму usage receipt.',
    },
  },
] as const;

export type ChatModelFamilyId = typeof CHAT_MODEL_FAMILIES[number]['family'];
export type ChatModelId = typeof CHAT_MODEL_FAMILIES[number]['currentId'];
export type ModelPoolEvidence = typeof CHAT_MODEL_FAMILIES[number]['poolEvidence'];

export interface ChatModelOption {
  family: ChatModelFamilyId;
  displayName: string;
  currentId: ChatModelId;
  poolEvidence: ModelPoolEvidence;
  capabilities: ModelCapabilities;
  basicWorkflow: ModelCapabilityStatus;
  registryStatus: 'available' | 'not-listed' | 'unavailable' | 'error';
  quotaExhausted: boolean;
  selectable: boolean;
}

export function chatModelOptions(registry: ModelRegistrySnapshot): ChatModelOption[] {
  return CHAT_MODEL_FAMILIES.map((family) => {
    const capabilities = getModelCapabilities(family.currentId);
    const basicWorkflow = basicAgentWorkflowStatus(capabilities);
    const listed = isModelAvailable(registry, family.currentId);
    const quotaExhausted = registry.exhaustedModelIds?.includes(family.currentId) ?? false;
    const registryStatus = registry.state === 'unavailable' ? 'unavailable'
      : registry.state === 'error' ? 'error'
        : listed ? 'available' : 'not-listed';
    return {
      family: family.family,
      displayName: family.displayName,
      currentId: family.currentId,
      poolEvidence: { ...family.poolEvidence },
      capabilities,
      basicWorkflow,
      registryStatus,
      quotaExhausted,
      selectable: listed && !quotaExhausted && basicWorkflow === 'verified',
    };
  });
}

export function isCurrentChatModelId(modelId: unknown): modelId is ChatModelId {
  return typeof modelId === 'string' && CHAT_MODEL_FAMILIES.some((family) => family.currentId === modelId);
}

export function isChatModelAvailable(registry: ModelRegistrySnapshot, modelId: string | null | undefined): modelId is ChatModelId {
  return chatModelUnavailableReason(registry, modelId) === null;
}

export function chatModelUnavailableReason(registry: ModelRegistrySnapshot, modelId: string | null | undefined): string | null {
  if (!isCurrentChatModelId(modelId)) return 'Модель не входит в актуальный каталог GigaChat для чата.';
  if (registry.state === 'unavailable') return 'Подключите API и обновите список моделей.';
  if (registry.state === 'error') return 'Не удалось подтвердить актуальный список моделей.';
  if (!isModelAvailable(registry, modelId)) return 'Эта модель отсутствует в актуальном списке API.';
  if (registry.exhaustedModelIds?.includes(modelId)) return 'Пул этой модели исчерпан; автоматическая замена не выполняется.';
  const workflow = basicAgentWorkflowStatus(getModelCapabilities(modelId));
  if (workflow === 'unavailable') return 'Основные возможности этой модели недоступны.';
  if (workflow !== 'verified') return 'Основные возможности этой модели ещё не проверены.';
  return null;
}

export function modelFamilyForId(modelId: string | null | undefined) {
  if (!modelId) return null;
  return CHAT_MODEL_FAMILIES.find((family) => family.currentId === modelId || (family.legacyIds as readonly string[]).includes(modelId)) ?? null;
}

export function billingFamilyForUsageLabel(label: string | null | undefined) {
  if (!label) return null;
  return CHAT_MODEL_FAMILIES.find((family) => family.currentId === label || family.displayName === label
    || (family.legacyIds as readonly string[]).includes(label)
    || ('billingAliases' in family && (family.billingAliases as readonly string[]).includes(label))) ?? null;
}

export function legacyModelUpgrade(modelId: string | null | undefined) {
  const family = modelFamilyForId(modelId);
  if (!family || family.currentId === modelId) return null;
  return { family: family.family, displayName: family.displayName, currentId: family.currentId };
}
