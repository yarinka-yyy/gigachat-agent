import type { InstructionDocument, InstructionSaveResult } from './contracts';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

type Entry = {
  value: string;
  saved: string;
  revision: string;
  conflict: InstructionSaveResult | null;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
};

export function createInstructionAutosave(
  save: (key: string, value: string, expectedRevision: string) => Promise<InstructionSaveResult>,
  onStatus: (key: string, status: SaveStatus, error?: unknown) => void,
  delay = 400,
) {
  const entries = new Map<string, Entry>();

  function load(key: string, document: InstructionDocument): string {
    const entry = entries.get(key);
    if (!entry) {
      entries.set(key, { value: document.text, saved: document.text, revision: document.revision, conflict: null });
      onStatus(key, 'saved');
      return document.text;
    }
    if (!entry.conflict && entry.value === entry.saved && !entry.pending) {
      entry.value = entry.saved = document.text;
      entry.revision = document.revision;
    }
    onStatus(key, entry.conflict ? 'conflict' : entry.value === entry.saved ? 'saved' : 'pending', entry.conflict ?? undefined);
    return entry.value;
  }

  function reload(key: string, document: InstructionDocument): string {
    const entry = entries.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    entries.set(key, { value: document.text, saved: document.text, revision: document.revision, conflict: null });
    onStatus(key, 'saved');
    return document.text;
  }

  async function flush(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.pending && entry.conflict) {
      throw new Error('Инструкция изменена в другом месте. Разрешите конфликт перед продолжением.');
    }
    if (!entry.pending) {
      entry.pending = (async () => {
        while (entry.value !== entry.saved && !entry.conflict) {
          const snapshot = entry.value;
          onStatus(key, 'saving');
          try {
            const result = await save(key, snapshot, entry.revision);
            if (result.kind === 'conflict') {
              entry.conflict = result;
              onStatus(key, 'conflict', result);
              return;
            }
            entry.revision = result.document.revision;
          } catch (error) {
            onStatus(key, 'error', error);
            throw error;
          }
          entry.saved = snapshot;
        }
        onStatus(key, 'saved');
      })().finally(() => { entry.pending = undefined; });
    }
    await entry.pending;
    if (entry.conflict) throw new Error('Инструкция изменена в другом месте. Разрешите конфликт перед продолжением.');
    if (entry.value !== entry.saved) await flush(key);
    else if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  function edit(key: string, value: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.set(key, entry);
    entry.value = value;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.conflict) {
      onStatus(key, 'conflict', entry.conflict);
      return;
    }
    if (entry.value === entry.saved && !entry.pending) {
      onStatus(key, 'saved');
      return;
    }
    onStatus(key, 'pending');
    entry.timer = setTimeout(() => { void flush(key).catch(() => undefined); }, delay);
  }

  return {
    load,
    reload,
    edit,
    flush,
    flushAll: () => Promise.all([...entries.keys()].map(flush)).then(() => undefined),
  };
}
