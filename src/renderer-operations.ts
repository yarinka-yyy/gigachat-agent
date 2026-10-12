import type { ModelRegistrySnapshot, RuntimeTurnSnapshot } from './contracts';
import { chatModelUnavailableReason, isChatModelAvailable } from './model-catalog';

export function retryUnavailableReason(
  turn: Pick<RuntimeTurnSnapshot, 'retryEligible' | 'modelId'>,
  registry: ModelRegistrySnapshot,
): string | null {
  if (turn.retryEligible !== true) return 'Повтор этого хода недоступен.';
  if (registry.state === 'unavailable') return 'Подключите API и загрузите список моделей перед повтором.';
  if (registry.state === 'error') return 'Не удалось обновить список моделей; проверьте подключение API.';
  if (!turn.modelId) return 'Для исходного хода не указана модель; повтор недоступен.';
  if (!isChatModelAvailable(registry, turn.modelId)) {
    return `Исходная модель сейчас недоступна для повтора: ${chatModelUnavailableReason(registry, turn.modelId) ?? 'проверка не пройдена'}`;
  }
  return null;
}

export function createRendererOperationTracker() {
  let frozen = false;
  const active = new Set<Promise<unknown>>();
  const failures: unknown[] = [];

  return {
    get frozen(): boolean { return frozen; },
    track<T>(operation: () => T | Promise<T>): Promise<T> {
      let task: Promise<T>;
      try { task = Promise.resolve(operation()); }
      catch (error) { task = Promise.reject(error); }
      active.add(task);
      void task.then(
        () => { active.delete(task); },
        (error: unknown) => {
          active.delete(task);
          if (frozen) failures.push(error);
        },
      );
      return task;
    },
    reportFailure(error: unknown): void {
      if (frozen) failures.push(error);
    },
    async freezeAndDrain(): Promise<void> {
      failures.length = 0;
      frozen = true;
      while (active.size > 0) await Promise.allSettled([...active]);
      if (failures.length > 0) throw failures[0];
    },
    resume(): void {
      frozen = false;
      failures.length = 0;
    },
  };
}
