import type { ModelRegistrySnapshot, ProviderErrorCategory } from './contracts';

export type GigaChatModelId = string;

export function requireModelId(value: unknown): GigaChatModelId {
  if (typeof value !== 'string' || !value.trim() || value.length > 200
    // eslint-disable-next-line no-control-regex -- Reject C0/C1 controls in untrusted model IDs without imposing a namespace whitelist.
    || /[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw new Error('Некорректный идентификатор модели GigaChat.');
  }
  return value;
}

export function unavailableModelRegistry(errorCategory: ProviderErrorCategory | null = null): ModelRegistrySnapshot {
  return { state: 'unavailable', modelIds: [], errorCategory };
}

export function failedModelRegistry(errorCategory: ProviderErrorCategory): ModelRegistrySnapshot {
  return { state: 'error', modelIds: [], errorCategory };
}

export function discoveredModelRegistry(ids: readonly unknown[]): ModelRegistrySnapshot {
  const modelIds = [...new Set(ids.map(requireModelId))];
  return modelIds.length
    ? { state: 'ready', modelIds, errorCategory: null }
    : failedModelRegistry('model');
}

export function isModelAvailable(registry: ModelRegistrySnapshot, modelId: GigaChatModelId | null): boolean {
  return modelId !== null && registry.state === 'ready' && registry.modelIds.includes(modelId);
}

export function modelIdsForSelection(
  registry: ModelRegistrySnapshot,
  selectedModelId: GigaChatModelId | null,
): GigaChatModelId[] {
  const ids = registry.state === 'ready' ? [...registry.modelIds] : [];
  if (selectedModelId !== null && !ids.includes(selectedModelId)) ids.push(selectedModelId);
  return ids;
}
