import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createVoiceRuntime, VOICE_MAX_AUDIO_BYTES } from '../voice';

type Element = { props: { className?: string; children?: unknown; disabled?: boolean; onClick: () => void } };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function control(tree: unknown, className: string): Element {
  if (tree && typeof tree === 'object') {
    const element = tree as Element;
    if (element.props?.className?.split(' ').includes(className)) return element;
    for (const child of [element.props?.children].flat()) {
      try { return control(child, className); } catch { /* continue searching siblings */ }
    }
  }
  throw new Error(`Control missing: ${className}`);
}

function voiceFixture(cleanupFailures: number, pendingInference = false, noSpeech = false) {
  let cleanupCalls = 0;
  let inferenceCalls = 0;
  let trackStops = 0;
  const transcripts: string[] = [];
  const errors: string[] = [];
  const cancellations: string[] = [];
  const runtime = createVoiceRuntime({ executable: 'synthetic', modelDirectory: 'synthetic' }, {
    prepareAudio: async () => ({ filePath: 'synthetic.webm', cleanup: async () => {
      cleanupCalls += 1;
      if (cleanupCalls <= cleanupFailures) throw new Error('synthetic cleanup failure');
    } }),
    run: async (_executable, _args, _environment, signal) => {
      inferenceCalls += 1;
      if (pendingInference && inferenceCalls === 1) return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic cancelled')), { once: true });
      });
      return JSON.stringify({ text: noSpeech ? '' : 'synthetic transcript' });
    },
  });
  let slots: unknown[] = [];
  let cursor = 0;
  const effectCleanups: (() => void)[] = [];
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect: () => unknown) {
      const index = cursor++;
      if (index in slots) return;
      slots[index] = true;
      const cleanup = effect();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup as () => void);
    },
    useCallback: (callback: unknown) => callback,
  };
  class Recorder {
    static isTypeSupported() { return true; }
    mimeType = 'audio/webm';
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])]) });
      this.onstop?.();
    }
  }
  const jsx = (_type: unknown, props: unknown) => ({ props });
  const sandbox = {
    exports: {} as { default: (props: unknown) => unknown },
    require: (name: string) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'lucide-react') return {};
      if (name === '../voice') return { VOICE_MAX_AUDIO_BYTES, createRecordingLimitTimer: () => () => undefined };
      throw new Error(`Unexpected import: ${name}`);
    },
    Blob, Uint8Array, DOMException, Error, Date, MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { trackStops += 1; } }] }) } },
    window: {
      crypto: { randomUUID }, setInterval: () => 1, clearInterval: () => undefined,
      gigaChat: { voice: {
        requestAccess: async () => true,
        transcribe: runtime.transcribe,
        cancel: (id: string) => { cancellations.push(id); return runtime.cancel(id); },
      } },
    },
  };
  // Exercise the actual TSX component with synthetic hooks/media; no DOM or physical microphone is needed.
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, 'VoiceCaptureControl.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  const render = () => {
    cursor = 0;
    return sandbox.exports.default({ available: true, reason: null, suspended: false, canContinue: () => true,
      onTranscript: (text: string) => transcripts.push(text), onError: (text: string) => errors.push(text), onSuccess: () => undefined });
  };
  return {
    render, errors, transcripts, cancellations,
    cleanupCalls: () => cleanupCalls, inferenceCalls: () => inferenceCalls, trackStops: () => trackStops,
    async capture() {
      const mic = control(render(), 'mic-button');
      assert.equal(mic.props.disabled, false);
      mic.props.onClick();
      await settle();
      control(render(), 'mic-button').props.onClick();
      await settle();
    },
    unmount() { effectCleanups.splice(0).forEach((cleanup) => cleanup()); },
    remount() { slots = []; return render(); },
  };
}

test('failed transcription cleanup retains retry cancel until confirmed, then next dictation works', async () => {
  const fixture = voiceFixture(3);
  await fixture.capture();
  assert.equal(fixture.cleanupCalls(), 2, 'failed transcription cleanup is retried without dropping its ID');
  assert.equal(control(fixture.render(), 'mic-button').props.disabled, true);
  control(fixture.render(), 'voice-cancel-button').props.onClick();
  await settle();
  assert.equal(fixture.cleanupCalls(), 3);
  assert.equal(control(fixture.render(), 'mic-button').props.disabled, true);
  control(fixture.render(), 'voice-cancel-button').props.onClick();
  await settle();
  assert.equal(fixture.cleanupCalls(), 4);
  assert.deepEqual(new Set(fixture.cancellations).size, 1, 'retry must retain the original request ID');
  await fixture.capture();
  assert.equal(fixture.inferenceCalls(), 2);
  assert.deepEqual(fixture.transcripts, ['synthetic transcript']);
  assert.equal(fixture.trackStops(), 2);
  fixture.unmount();
});

test('remount recovers original request after failed unmount cancellation before another capture', async () => {
  const fixture = voiceFixture(1, true);
  await fixture.capture();
  assert.equal(fixture.inferenceCalls(), 1);
  fixture.unmount();
  await settle();
  assert.equal(fixture.cleanupCalls(), 1);
  const replacement = fixture.remount();
  assert.equal(control(replacement, 'mic-button').props.disabled, true);
  control(replacement, 'voice-cancel-button').props.onClick();
  await settle();
  assert.equal(fixture.cleanupCalls(), 2);
  assert.equal(fixture.cancellations[0], fixture.cancellations[1]);
  await fixture.capture();
  assert.equal(fixture.inferenceCalls(), 2);
  assert.deepEqual(fixture.transcripts, ['synthetic transcript']);
  fixture.unmount();
});

test('ordinary no-speech error with confirmed cleanup returns to idle without manual cancel', async () => {
  const fixture = voiceFixture(0, false, true);
  await fixture.capture();
  assert.equal(fixture.cleanupCalls(), 1);
  assert.equal(control(fixture.render(), 'mic-button').props.disabled, false);
  assert.throws(() => control(fixture.render(), 'voice-cancel-button'), /Control missing/);
  assert.match(fixture.errors[0], /Речь не распознана/);
  assert.deepEqual(fixture.transcripts, []);
  fixture.unmount();
});
