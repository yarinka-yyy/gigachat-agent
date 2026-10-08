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
  const active = new Map<string, {
    controller: AbortController;
    task: Promise<string> | null;
    retryCleanup: (() => Promise<void>) | null;
    cleanupAttempt: Promise<void> | null;
    cleanupFailed: boolean;
    cleanupError: unknown;
  }>();

  async function transcribe(requestIdInput: string, audio: Uint8Array, mediaType: string): Promise<string> {
    const requestId = requireRequestId(requestIdInput);
    if ([...active.values()].some((entry) => entry.cleanupFailed)) {
      throw new Error('Не удалось очистить временную запись. Повторите отмену перед новой записью.');
    }
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

    const entry = {
      controller: new AbortController(),
      task: null as Promise<string> | null,
      retryCleanup: null as (() => Promise<void>) | null,
      cleanupAttempt: null as Promise<void> | null,
      cleanupFailed: false,
      cleanupError: undefined as unknown,
    };
    active.set(requestId, entry);
    const task = (async () => {
      let prepared: VoicePreparedAudio | null = null;
      let result: string | undefined;
      let failed = false;
      let failure: unknown;
      try {
        prepared = await host.prepareAudio(audio);
        entry.retryCleanup = prepared.cleanup.bind(prepared);
        if (entry.controller.signal.aborted) throw new Error('Распознавание отменено.');
        const stdout = await host.run(
          paths.executable,
          buildTranscriptionArgs(prepared.filePath, paths),
          {},
          entry.controller.signal,
        );
        if (entry.controller.signal.aborted) throw new Error('Распознавание отменено.');
        result = parseVoiceTranscript(stdout);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await entry.retryCleanup?.();
      } catch (error) {
        entry.cleanupFailed = true;
        entry.cleanupError = error;
        throw error;
      }
      entry.retryCleanup = null;
      entry.cleanupError = undefined;
      entry.cleanupFailed = false;
      if (active.get(requestId) === entry) active.delete(requestId);
      if (failed) throw failure;
      if (result === undefined) throw new Error('Не удалось получить текст локального распознавания.');
      return result;
    })();
    entry.task = task;
    return task;
  }

  async function cancel(requestIdInput: string): Promise<boolean> {
    const requestId = requireRequestId(requestIdInput);
    const entry = active.get(requestId);
    if (!entry) return false;
    entry.controller.abort();
    if (entry.cleanupFailed) {
      await retryFailedCleanup(requestId, entry);
      return true;
    }
    await entry.task?.catch(() => undefined);
    if (entry.cleanupFailed) throw entry.cleanupError;
    return true;
  }

  async function retryFailedCleanup(requestId: string, entry: NonNullable<ReturnType<typeof active.get>>): Promise<void> {
    if (entry.cleanupAttempt) return entry.cleanupAttempt;
    const retryCleanup = entry.retryCleanup;
    if (!retryCleanup) throw entry.cleanupError ?? new Error('Не удалось подтвердить очистку временной записи.');
    const attempt = (async () => {
      try {
        await retryCleanup();
      } catch (error) {
        entry.cleanupError = error;
        entry.cleanupFailed = true;
        throw error;
      }
      entry.retryCleanup = null;
      entry.cleanupError = undefined;
      entry.cleanupFailed = false;
      if (active.get(requestId) === entry) active.delete(requestId);
    })();
    entry.cleanupAttempt = attempt;
    void attempt.then(
      () => { if (entry.cleanupAttempt === attempt) entry.cleanupAttempt = null; },
      () => { if (entry.cleanupAttempt === attempt) entry.cleanupAttempt = null; },
    );
    return attempt;
  }

  async function cancelAll(): Promise<void> {
    const entries = [...active.entries()];
    for (const [, entry] of entries) entry.controller.abort();
    const results = await Promise.allSettled(entries.map(async ([requestId, entry]) => {
      if (entry.cleanupFailed) {
        await retryFailedCleanup(requestId, entry);
        return;
      }
      await entry.task?.catch(() => undefined);
      if (entry.cleanupFailed) throw entry.cleanupError;
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  return { transcribe, cancel, cancelAll };
}
