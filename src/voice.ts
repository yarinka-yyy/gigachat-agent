export const VOICE_MAX_RECORDING_MS = 10 * 60 * 1000;
export const VOICE_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const VOICE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface VoicePreparedAudio {
  filePath: string;
  cleanup(): Promise<void>;
}

export interface VoiceRuntimePaths {
  executable: string;
  modelDirectory: string;
  cacheDirectory: string;
}

export interface VoiceRuntimeHost {
  prepareAudio(audio: Uint8Array): Promise<VoicePreparedAudio>;
  run(executable: string, args: string[], environment: Record<string, string>, signal: AbortSignal): Promise<string>;
}

export interface VoiceRuntime {
  transcribe(requestId: string, audio: Uint8Array, mediaType: string): Promise<string>;
  cancel(requestId: string): Promise<boolean>;
  cancelAll(): Promise<void>;
}

export interface VoiceTimerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const WEBM_EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3] as const;

const defaultTimerScheduler: VoiceTimerScheduler = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function createRecordingLimitTimer(
  onLimit: () => void,
  scheduler: VoiceTimerScheduler = defaultTimerScheduler,
): () => void {
  let active = true;
  const handle = scheduler.schedule(() => {
    if (!active) return;
    active = false;
    onLimit();
  }, VOICE_MAX_RECORDING_MS);
  return () => {
    if (!active) return;
    active = false;
    scheduler.cancel(handle);
  };
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Идентификатор диктовки некорректен.');
  }
  return value;
}

export function parseVoiceTranscript(stdout: string): string {
  if (typeof stdout !== 'string' || new TextEncoder().encode(stdout).byteLength > VOICE_MAX_OUTPUT_BYTES) {
    throw new Error('Ответ локального распознавания слишком велик.');
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trimStart().startsWith('{'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value: unknown = JSON.parse(lines[index] ?? '');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const text = (value as Record<string, unknown>).text;
      if (typeof text !== 'string' || text.length > VOICE_MAX_OUTPUT_BYTES) continue;
      const transcript = text.trim();
      if (!transcript) throw new Error('Речь не распознана. Запишите сообщение ещё раз.');
      return transcript;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Речь не распознана')) throw error;
    }
  }
  throw new Error('Не удалось получить текст локального распознавания.');
}

function buildTranscriptionArgs(filePath: string, paths: VoiceRuntimePaths): string[] {
  return [
    'transcribe', filePath,
    '--model-dir', paths.modelDirectory,
    '--model-variant', 'e2e_rnnt',
    '--offline',
    '--vad',
    '--vad-model-dir', paths.modelDirectory,
    '--format', 'json',
  ];
}

export function createVoiceRuntime(paths: VoiceRuntimePaths, host: VoiceRuntimeHost): VoiceRuntime {
  const active = new Map<string, { controller: AbortController; task: Promise<string> | null }>();

  async function transcribe(requestIdInput: string, audio: Uint8Array, mediaType: string): Promise<string> {
    const requestId = requireRequestId(requestIdInput);
    if (active.has(requestId)) throw new Error('Диктовка с таким идентификатором уже выполняется.');
    if (active.size > 0) throw new Error('Другая запись уже распознаётся.');
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > VOICE_MAX_AUDIO_BYTES) {
      throw new Error('Запись имеет неподдерживаемый размер. Запишите её короче.');
    }
    if (audio.byteLength < WEBM_EBML_HEADER.length || !WEBM_EBML_HEADER.every((byte, index) => audio[index] === byte)) {
      throw new Error('Запись не похожа на WebM-аудио. Запишите сообщение ещё раз.');
    }
    if (typeof mediaType !== 'string' || mediaType.split(';', 1)[0]?.trim().toLowerCase() !== 'audio/webm') {
      throw new Error('Браузер создал неподдерживаемый формат записи.');
    }

    const entry = { controller: new AbortController(), task: null as Promise<string> | null };
    active.set(requestId, entry);
    const task = (async () => {
      let prepared: VoicePreparedAudio | null = null;
      try {
        prepared = await host.prepareAudio(audio);
        if (entry.controller.signal.aborted) throw new Error('Распознавание отменено.');
        const stdout = await host.run(
          paths.executable,
          buildTranscriptionArgs(prepared.filePath, paths),
          { GIGASTT_OPTIMIZED_CACHE_DIR: paths.cacheDirectory },
          entry.controller.signal,
        );
        if (entry.controller.signal.aborted) throw new Error('Распознавание отменено.');
        return parseVoiceTranscript(stdout);
      } finally {
        try {
          await prepared?.cleanup();
        } finally {
          active.delete(requestId);
        }
      }
    })();
    entry.task = task;
    return task;
  }

  async function cancel(requestIdInput: string): Promise<boolean> {
    const requestId = requireRequestId(requestIdInput);
    const entry = active.get(requestId);
    if (!entry) return false;
    entry.controller.abort();
    await entry.task?.catch(() => undefined);
    return true;
  }

  async function cancelAll(): Promise<void> {
    const entries = [...active.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map((entry) => entry.task?.catch(() => undefined)));
  }

  return { transcribe, cancel, cancelAll };
}
