import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { createRecordingLimitTimer, VOICE_MAX_AUDIO_BYTES } from '../voice';

interface VoiceCaptureControlProps {
  available: boolean;
  reason: string | null;
  onTranscript(text: string): void;
  onError(message: string): void;
  onSuccess(message: string): void;
}

type CapturePhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling';

export function getCaptureError(reason: unknown): string {
  if (reason instanceof DOMException) {
    if (reason.name === 'NotAllowedError' || reason.name === 'SecurityError') return 'Доступ к микрофону отклонён при проверке записи.';
    if (reason.name === 'NotFoundError') return 'Микрофон не найден.';
    if (reason.name === 'NotReadableError') return 'Микрофон занят или недоступен.';
  }
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Не удалось начать запись. Проверьте микрофон и повторите попытку.';
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.min(600, Math.max(0, Math.floor(milliseconds / 1000)));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function VoiceCaptureControl({ available, reason, onTranscript, onError, onSuccess }: VoiceCaptureControlProps) {
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [statusText, setStatusText] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const chunkBytes = useRef(0);
  const requestId = useRef<string | null>(null);
  const cancelledRequestId = useRef<string | null>(null);
  const cancelledCapture = useRef(false);
  const mounted = useRef(true);
  const starting = useRef(false);
  const startedAt = useRef(0);
  const timerCancel = useRef<() => void>(() => undefined);
  const elapsedInterval = useRef<number | null>(null);

  function stopStream(): void {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }

  function clearRecordingTimers(): void {
    timerCancel.current();
    timerCancel.current = () => undefined;
    if (elapsedInterval.current !== null) window.clearInterval(elapsedInterval.current);
    elapsedInterval.current = null;
  }

  useEffect(() => () => {
    mounted.current = false;
    clearRecordingTimers();
    cancelledCapture.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stopStream();
    const activeRequest = requestId.current;
    requestId.current = null;
    if (activeRequest) void window.gigaChat.voice.cancel(activeRequest).catch(() => undefined);
  }, []);

  function stopRecording(): void {
    const current = recorder.current;
    if (!current || current.state !== 'recording') return;
    clearRecordingTimers();
    current.stop();
  }

  async function finishRecording(current: MediaRecorder): Promise<void> {
    if (recorder.current !== current) return;
    stopStream();
    recorder.current = null;
    if (cancelledCapture.current || !mounted.current) {
      chunks.current = [];
      chunkBytes.current = 0;
      if (mounted.current) {
        setPhase('idle');
        setStatusText('');
      }
      return;
    }

    const audio = new Blob(chunks.current, { type: current.mimeType || 'audio/webm' });
    chunks.current = [];
    chunkBytes.current = 0;
    if (audio.size === 0 || audio.size > VOICE_MAX_AUDIO_BYTES) {
      setPhase('idle');
      onError(audio.size === 0 ? 'В записи нет аудио. Запишите сообщение ещё раз.' : 'Запись слишком велика. Запишите её короче.');
      return;
    }

    const activeRequestId = window.crypto.randomUUID();
    requestId.current = activeRequestId;
    setStatusText('Распознаём локально…');
    setPhase('transcribing');
    try {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const transcript = await window.gigaChat.voice.transcribe(activeRequestId, bytes, audio.type || current.mimeType);
      if (requestId.current !== activeRequestId || !mounted.current) return;
      requestId.current = null;
      if (cancelledRequestId.current === activeRequestId) {
        setPhase('idle');
        setStatusText('');
        return;
      }
      setPhase('idle');
      setStatusText('');
      onTranscript(transcript);
      onSuccess('Текст добавлен в черновик. Проверьте его перед отправкой.');
    } catch (error) {
      if (requestId.current !== activeRequestId || !mounted.current) return;
      requestId.current = null;
      setPhase('idle');
      setStatusText('');
      if (cancelledRequestId.current === activeRequestId) return;
      onError(error instanceof Error ? error.message : 'Не удалось распознать запись локально.');
    }
  }

  async function startRecording(): Promise<void> {
    if (starting.current || phase !== 'idle' || !available) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError('Запись аудио не поддерживается этой версией Windows или приложения.');
      return;
    }
    starting.current = true;
    setPhase('starting');
    setStatusText('Подключаем микрофон…');
    cancelledCapture.current = false;
    try {
      if (!await window.gigaChat.voice.requestAccess()) {
        setPhase('idle');
        setStatusText('');
        return;
      }
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || cancelledCapture.current) {
        acquired.getTracks().forEach((track) => track.stop());
        if (mounted.current) {
          setPhase('idle');
          setStatusText('');
        }
        return;
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) {
        acquired.getTracks().forEach((track) => track.stop());
        throw new Error('Запись WebM/Opus недоступна в этой версии приложения.');
      }
      stream.current = acquired;
      chunks.current = [];
      chunkBytes.current = 0;
      const current = new MediaRecorder(acquired, { mimeType });
      recorder.current = current;
      current.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        chunkBytes.current += event.data.size;
        if (chunkBytes.current > VOICE_MAX_AUDIO_BYTES) {
          cancelledCapture.current = true;
          clearRecordingTimers();
          if (mounted.current) onError('Запись слишком велика. Запишите её короче.');
          stopRecording();
          return;
        }
        chunks.current.push(event.data);
      };
      current.onerror = () => {
        if (recorder.current !== current) return;
        cancelledCapture.current = true;
        clearRecordingTimers();
        stopStream();
        chunks.current = [];
        chunkBytes.current = 0;
        recorder.current = null;
        if (current.state === 'recording') {
          try { current.stop(); } catch { /* the recorder may already be shutting down */ }
        }
        if (mounted.current) {
          setPhase('idle');
          setStatusText('');
          onError('Запись прервалась. Проверьте микрофон и попробуйте ещё раз.');
        }
      };
      current.onstop = () => { void finishRecording(current); };
      startedAt.current = Date.now();
      current.start(1000);
      setElapsed(0);
      setStatusText('Запись 00:00 / 10:00');
      setPhase('recording');
      elapsedInterval.current = window.setInterval(() => {
        const value = Date.now() - startedAt.current;
        setElapsed(value);
        setStatusText(`Запись ${formatElapsed(value)} / 10:00`);
      }, 250);
      timerCancel.current = createRecordingLimitTimer(stopRecording);
    } catch (error) {
      stopStream();
      recorder.current = null;
      setPhase('idle');
      setStatusText('');
      onError(error instanceof Error && error.message.startsWith('Запись WebM') ? error.message : getCaptureError(error));
    } finally {
      starting.current = false;
    }
  }

  function cancelRecording(): void {
    if (phase === 'recording' || phase === 'starting') {
      cancelledCapture.current = true;
      clearRecordingTimers();
      stopStream();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      else if (phase === 'starting') {
        setPhase('idle');
        setStatusText('');
      }
      return;
    }
    const activeRequestId = requestId.current;
    if (!activeRequestId) return;
    cancelledRequestId.current = activeRequestId;
    setPhase('cancelling');
    setStatusText('Останавливаем распознавание…');
    void window.gigaChat.voice.cancel(activeRequestId).then(() => {
      if (mounted.current && requestId.current === activeRequestId) {
        requestId.current = null;
        setPhase('idle');
        setStatusText('');
      }
    }).catch(() => {
      if (mounted.current && requestId.current === activeRequestId) {
        onError('Не удалось подтвердить остановку. Закройте приложение, если распознавание не завершится.');
        setPhase('transcribing');
        setStatusText('Остановка не подтверждена — ждём завершения…');
      }
    });
  }

  const isBusy = phase !== 'idle';
  const micLabel = !available ? 'Диктовка недоступна'
    : phase === 'recording' ? 'Остановить запись и распознать'
      : phase === 'starting' ? 'Подключаем микрофон'
        : phase === 'transcribing' || phase === 'cancelling' ? 'Распознавание речи'
          : 'Начать диктовку';
  const micTitle = available ? micLabel : reason ?? micLabel;

  return (
    <div className={`voice-capture${phase === 'recording' ? ' is-recording' : ''}`}>
      <div className="voice-capture-feedback">
        <span
          className={`voice-capture-status${!available ? ' is-unavailable' : ''}`}
          role="status"
          aria-live="polite"
          title={!available ? reason ?? 'Диктовка недоступна' : undefined}
        >
          {phase === 'recording' ? `Запись ${formatElapsed(elapsed)} / 10:00` : statusText || (!available ? reason ?? 'Диктовка недоступна' : '')}
        </span>
        {isBusy && <button
          type="button"
          className="voice-cancel-button"
          disabled={phase === 'cancelling'}
          aria-label={phase === 'recording' || phase === 'starting' ? 'Отменить запись' : 'Отменить распознавание'}
          title={phase === 'recording' || phase === 'starting' ? 'Отменить запись' : 'Отменить распознавание'}
          onClick={cancelRecording}
        ><X aria-hidden="true" /></button>}
      </div>
      <button
        type="button"
        className={`mic-button${phase === 'recording' ? ' is-recording' : ''}`}
        disabled={!available || phase === 'starting' || phase === 'cancelling' || phase === 'transcribing'}
        aria-label={micLabel}
        aria-pressed={phase === 'recording'}
        title={micTitle}
        onClick={() => { if (phase === 'recording') stopRecording(); else void startRecording(); }}
      >
        {phase === 'recording' ? <Square aria-hidden="true" />
          : phase === 'transcribing' || phase === 'cancelling' ? <LoaderCircle className="voice-spinner" aria-hidden="true" />
            : <Mic aria-hidden="true" />}
      </button>
    </div>
  );
}
