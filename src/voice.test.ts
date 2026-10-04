import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRecordingLimitTimer,
  createVoiceRuntime,
  parseVoiceTranscript,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_OUTPUT_BYTES,
  VOICE_MAX_RECORDING_MS,
  type VoiceRuntimeHost,
} from './voice';

const requestId = 'bf83023d-ef8d-44d3-992a-8bd235fd2a67';
const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const paths = { executable: 'voice/gigastt.exe', modelDirectory: 'voice', cacheDirectory: 'cache' };

function fakeHost(overrides: Partial<VoiceRuntimeHost> = {}): VoiceRuntimeHost {
  return {
    prepareAudio: async () => ({ filePath: 'temp/recording.webm', cleanup: async () => undefined }),
    run: async () => '{"duration":1,"text":"Проверка local runtime."}',
    ...overrides,
  };
}

test('recording limit fires once at exactly ten minutes', () => {
  let scheduledDelay = 0;
  const callbacks: Array<() => void> = [];
  let cancelledHandle: unknown;
  const handle = { timer: true };
  const scheduler = {
    schedule(next: () => void, delayMs: number): unknown { callbacks.push(next); scheduledDelay = delayMs; return handle; },
    cancel(value: unknown): void { cancelledHandle = value; },
  };
  let stopCount = 0;
  const cancelTimer = createRecordingLimitTimer(() => { stopCount += 1; }, scheduler);
  assert.equal(scheduledDelay, 600_000);
  assert.equal(scheduledDelay, VOICE_MAX_RECORDING_MS);
  callbacks[0]?.();
  assert.equal(stopCount, 1);
  cancelTimer();
  cancelTimer();
  assert.equal(cancelledHandle, undefined);
});

test('manual cancellation clears the ten-minute timer without auto-stop', () => {
  const callbacks: Array<() => void> = [];
  let stopCount = 0;
  let cancelCount = 0;
  const cancelTimer = createRecordingLimitTimer(() => { stopCount += 1; }, {
    schedule(next) { callbacks.push(next); return 7; },
    cancel() { cancelCount += 1; },
  });
  cancelTimer();
  callbacks[0]?.();
  assert.equal(cancelCount, 1);
  assert.equal(stopCount, 0);
});

test('transcription uses the fixed offline e2e/VAD command and cleans the temporary audio', async () => {
  let receivedExecutable = '';
  let receivedArgs: string[] = [];
  let receivedEnvironment: Record<string, string> = {};
  let cleanupCount = 0;
  const runtime = createVoiceRuntime(paths, fakeHost({
    prepareAudio: async () => ({ filePath: 'temp/recording.webm', cleanup: async () => { cleanupCount += 1; } }),
    async run(executable, args, environment, signal) {
      assert.equal(signal.aborted, false);
      receivedExecutable = executable;
      receivedArgs = args;
      receivedEnvironment = environment;
      return 'regions=2\n{"duration":1,"text":"Проверь локальный GigaAM API."}';
    },
  }));
  const text = await runtime.transcribe(requestId, audio, 'audio/webm;codecs=opus');
  assert.equal(text, 'Проверь локальный GigaAM API.');
  assert.equal(receivedExecutable, paths.executable);
  assert.deepEqual(receivedArgs, [
    'transcribe', 'temp/recording.webm', '--model-dir', 'voice', '--model-variant', 'e2e_rnnt',
    '--offline', '--vad', '--vad-model-dir', 'voice', '--format', 'json',
  ]);
  assert.deepEqual(receivedEnvironment, { GIGASTT_OPTIMIZED_CACHE_DIR: 'cache' });
  assert.equal(cleanupCount, 1);
});

test('unsupported requests are rejected before temporary audio or child process creation', async () => {
  let calls = 0;
  const runtime = createVoiceRuntime(paths, fakeHost({
    async prepareAudio() { calls += 1; throw new Error('unexpected'); },
    async run() { calls += 1; return ''; },
  }));
  await assert.rejects(runtime.transcribe('invalid', audio, 'audio/webm'), /идентификатор/i);
  await assert.rejects(runtime.transcribe(requestId, audio, 'audio/ogg'), /формат/i);
  await assert.rejects(runtime.transcribe(requestId, new Uint8Array(VOICE_MAX_AUDIO_BYTES + 1), 'audio/webm'), /размер/i);
  await assert.rejects(runtime.transcribe(requestId, new Uint8Array([1, 2, 3, 4]), 'audio/webm'), /WebM/i);
  assert.equal(calls, 0);
});

test('cancel aborts active inference, waits for its cleanup and blocks a late transcript', async () => {
  let signal: AbortSignal | null = null;
  let cleanupCount = 0;
  const runtime = createVoiceRuntime(paths, fakeHost({
    prepareAudio: async () => ({ filePath: 'temp/recording.webm', cleanup: async () => { cleanupCount += 1; } }),
    run(_executable, _args, _environment, activeSignal) {
      signal = activeSignal;
      return new Promise((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  }));
  const pending = runtime.transcribe(requestId, audio, 'audio/webm');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signal);
  assert.equal(await runtime.cancel(requestId), true);
  await assert.rejects(pending, /aborted|отменено/i);
  assert.equal(cleanupCount, 1);
  assert.equal(await runtime.cancel(requestId), false);
});

test('close cleanup failures stay owned until a later cleanup succeeds', async () => {
  let signal: AbortSignal | null = null;
  let cleanupCalls = 0;
  let runCalls = 0;
  const runtime = createVoiceRuntime(paths, fakeHost({
    prepareAudio: async () => ({
      filePath: 'temp/recording.webm',
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls < 3) throw new Error('synthetic cleanup failure');
      },
    }),
    run(_executable, _args, _environment, activeSignal) {
      runCalls += 1;
      if (runCalls > 1) return Promise.resolve('{"duration":1,"text":"Диктовка готова."}');
      signal = activeSignal;
      return new Promise((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  }));
  const pending = runtime.transcribe(requestId, audio, 'audio/webm');
  void pending.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signal);

  await assert.rejects(runtime.cancelAll(), /synthetic cleanup failure/);
  await assert.rejects(pending, /synthetic cleanup failure/);
  await assert.rejects(runtime.transcribe('9b648033-f066-41d7-870d-a93d4b6aa002', audio, 'audio/webm'), /очистить временную запись/i);

  await assert.rejects(runtime.cancelAll(), /synthetic cleanup failure/);
  assert.equal(cleanupCalls, 2);
  await runtime.cancelAll();
  assert.equal(cleanupCalls, 3);

  assert.equal(await runtime.transcribe('9b648033-f066-41d7-870d-a93d4b6aa002', audio, 'audio/webm'), 'Диктовка готова.');
  assert.equal(runCalls, 2);
});

test('voice cancel and close share one cleanup retry for the same recording', async () => {
  let signal: AbortSignal | null = null;
  let cleanupCalls = 0;
  let resolveRetryStarted: (() => void) | null = null;
  const retryControl: { resolve: (() => void) | null } = { resolve: null };
  const retryStarted = new Promise<void>((resolve) => { resolveRetryStarted = resolve; });
  const runtime = createVoiceRuntime(paths, fakeHost({
    prepareAudio: async () => ({
      filePath: 'temp/recording.webm',
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error('first cleanup failure');
        if (cleanupCalls === 2) {
          resolveRetryStarted?.();
          await new Promise<void>((resolve) => { retryControl.resolve = resolve; });
          return;
        }
        throw new Error('duplicate cleanup attempt');
      },
    }),
    run(_executable, _args, _environment, activeSignal) {
      signal = activeSignal;
      return new Promise((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  }));
  const pending = runtime.transcribe(requestId, audio, 'audio/webm');
  void pending.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signal);
  await assert.rejects(runtime.cancelAll(), /first cleanup failure/);
  await assert.rejects(pending, /first cleanup failure/);

  const cancellation = runtime.cancel(requestId);
  const close = runtime.cancelAll();
  const outcomes = Promise.allSettled([cancellation, close]);
  await retryStarted;
  const callsWhileRetryPending = cleanupCalls;
  assert.ok(retryControl.resolve);
  retryControl.resolve();
  const results = await outcomes;

  assert.equal(callsWhileRetryPending, 2);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
});

test('transcript parser rejects malformed, empty and oversized output', () => {
  assert.throws(() => parseVoiceTranscript('not json'), /текст локального распознавания/i);
  assert.throws(() => parseVoiceTranscript('{"duration":1,"text":"  "}'), /речь не распознана/i);
  assert.throws(() => parseVoiceTranscript('x'.repeat(VOICE_MAX_OUTPUT_BYTES + 1)), /слишком велик/i);
});
