export const GIGACHAT_MODELS = [
  { id: 'GigaChat-2-Lite', name: 'GigaChat 2 Lite', description: 'Быстрая модель для повседневных задач' },
  { id: 'GigaChat-2-Pro', name: 'GigaChat 2 Pro', description: 'Для более сложных задач' },
  { id: 'GigaChat-2-Max', name: 'GigaChat 2 Max', description: 'Для наиболее сложных задач' },
  { id: 'GigaChat-3-Ultra', name: 'GigaChat 3 Ultra', description: 'Доступность зависит от учётной записи' },
] as const;

export type GigaChatModelId = typeof GIGACHAT_MODELS[number]['id'];

export function requireModelId(value: unknown): GigaChatModelId {
  if (typeof value !== 'string' || !GIGACHAT_MODELS.some((model) => model.id === value)) {
    throw new Error('Неизвестная модель GigaChat.');
  }
  return value as GigaChatModelId;
}
