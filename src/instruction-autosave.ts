export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';

type Entry = {
  value: string;
  saved: string;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
};

export function createInstructionAutosave(
  save: (key: string, value: string) => Promise<void>,
  onStatus: (key: string, status: SaveStatus, error?: unknown) => void,
  delay = 400,
) {
  const entries = new Map<string, Entry>();

  function load(key: string, value: string): string {
    const entry = entries.get(key);
    if (!entry) {
      entries.set(key, { value, saved: value });
      onStatus(key, 'saved');
      return value;
    }
    if (entry.value === entry.saved && !entry.pending) entry.value = entry.saved = value;
    onStatus(key, entry.value === entry.saved ? 'saved' : 'pending');
    return entry.value;
  }

  async function flush(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.pending) {
      entry.pending = (async () => {
        while (entry.value !== entry.saved) {
          const snapshot = entry.value;
          onStatus(key, 'saving');
          try {
            await save(key, snapshot);
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
    if (entry.value !== entry.saved) await flush(key);
    else if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  function edit(key: string, value: string): void {
    const entry = entries.get(key) ?? { value: '', saved: '' };
    entries.set(key, entry);
    entry.value = value;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.value === entry.saved && !entry.pending) {
      onStatus(key, 'saved');
      return;
    }
    onStatus(key, 'pending');
    entry.timer = setTimeout(() => { void flush(key).catch(() => undefined); }, delay);
  }

  return {
    load,
    edit,
    flushAll: () => Promise.all([...entries.keys()].map(flush)).then(() => undefined),
  };
}
