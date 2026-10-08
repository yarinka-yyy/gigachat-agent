import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { createRecordingLimitTimer, VOICE_MAX_AUDIO_BYTES } from '../voice';

interface VoiceCaptureControlProps {
  available: boolean;
  reason: string | null;
  canContinue(): boolean;
  suspended: boolean;
  onTranscript(text: string): void;
  onError(message: string): void;
  onSuccess(message: string): void;
}

type CapturePhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling';

// A failed unmount cleanup remains owned across composer instances until cancel confirms release.
const pendingCleanupRequests = new Set<string>();

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

export default function VoiceCaptureControl({ available, reason, canContinue, suspended, onTranscript, onError, onSuccess }: VoiceCaptureControlProps) {
  const [phase, setPhase] = useState<CapturePhase>(pendingCleanupRequests.size > 0 ? 'transcribing' : 'idle');
  const phaseRef = useRef<CapturePhase>(phase);
  phaseRef.current = phase;
  const [elapsed, setElapsed] = useState(0);
  const [statusText, setStatusText] = useState(pendingCleanupRequests.size > 0 ? 'Очистка не подтверждена — повторите отмену.' : '');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const chunkBytes = useRef(0);
  const requestId = useRef<string | null>(pendingCleanupRequests.values().next().value ?? null);
  const cancelledRequestId = useRef<string | null>(null);
  const cancelledCapture = useRef(false);
  const captureGeneration = useRef(0);
  const suspensionHandled = useRef(false);
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      captureGeneration.current += 1;
      clearRecordingTimers();
      cancelledCapture.current = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stopStream();
      const activeRequest = requestId.current;
      if (activeRequest) {
        pendingCleanupRequests.add(activeRequest);
        void window.gigaChat.voice.cancel(activeRequest).then(() => {
          pendingCleanupRequests.delete(activeRequest);
          if (requestId.current === activeRequest) requestId.current = null;
        }).catch(() => undefined);
      }
    };
  }, []);

  function stopRecording(): void {
    const current = recorder.current;
    if (!current || current.state !== 'recording') return;
    clearRecordingTimers();
    current.stop();
  }

  async function finishRecording(current: MediaRecorder, generation: number): Promise<void> {
    if (recorder.current !== current || generation !== captureGeneration.current) return;
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
      if (requestId.current !== activeRequestId || !mounted.current
        || generation !== captureGeneration.current || cancelledRequestId.current === activeRequestId || !canContinue()) {
        if (requestId.current === activeRequestId && mounted.current && generation === captureGeneration.current) {
          requestId.current = null;
          setPhase('idle');
          setStatusText('');
        }
        return;
      }
      const transcript = await window.gigaChat.voice.transcribe(activeRequestId, bytes, audio.type || current.mimeType);
      if (requestId.current !== activeRequestId || !mounted.current || generation !== captureGeneration.current) return;
      requestId.current = null;
      if (cancelledRequestId.current === activeRequestId || !canContinue()) {
        setPhase('idle');
        setStatusText('');
        return;
      }
      setPhase('idle');
      setStatusText('');
      onTranscript(transcript);
      onSuccess('Текст добавлен в черновик. Проверьте его перед отправкой.');
    } catch (error) {
      if (requestId.current !== activeRequestId || !mounted.current || generation !== captureGeneration.current) return;
      setPhase('cancelling');
      setStatusText('Очищаем временную запись…');
      try {
        await window.gigaChat.voice.cancel(activeRequestId);
        if (requestId.current !== activeRequestId || !mounted.current || generation !== captureGeneration.current) return;
        requestId.current = null;
        setPhase('idle');
        setStatusText('');
      } catch {
        if (requestId.current !== activeRequestId || !mounted.current || generation !== captureGeneration.current) return;
        setPhase('transcribing');
        setStatusText('Очистка не подтверждена — повторите отмену.');
      }
      if (cancelledRequestId.current === activeRequestId || !canContinue()) return;
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
    const generation = ++captureGeneration.current;
    setPhase('starting');
    setStatusText('Подключаем микрофон…');
    cancelledCapture.current = false;
    cancelledRequestId.current = null;
    try {
      const granted = await window.gigaChat.voice.requestAccess();
      if (!mounted.current || generation !== captureGeneration.current || cancelledCapture.current) return;
      if (!canContinue()) {
        setPhase('idle');
        setStatusText('');
        return;
      }
      if (!granted) {
        setPhase('idle');
        setStatusText('');
        return;
      }
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || generation !== captureGeneration.current || cancelledCapture.current || !canContinue()) {
        acquired.getTracks().forEach((track) => track.stop());
        if (mounted.current && generation === captureGeneration.current) {
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
        if (!mounted.current || recorder.current !== current || generation !== captureGeneration.current
          || cancelledCapture.current || event.data.size === 0) return;
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
      current.onstop = () => { void finishRecording(current, generation); };
      startedAt.current = Date.now();
      current.start(1000);
      setElapsed(0);
      setStatusText('Запись 00:00 / 10:00');
      setPhase('recording');
      elapsedInterval.current = window.setInterval(() => {
        if (!mounted.current || recorder.current !== current || generation !== captureGeneration.current || cancelledCapture.current) return;
        const value = Date.now() - startedAt.current;
        setElapsed(value);
        setStatusText(`Запись ${formatElapsed(value)} / 10:00`);
      }, 250);
      timerCancel.current = createRecordingLimitTimer(stopRecording);
    } catch (error) {
      if (!mounted.current || generation !== captureGeneration.current || cancelledCapture.current) return;
      if (!canContinue()) {
        setPhase('idle');
        setStatusText('');
        return;
      }
      stopStream();
      recorder.current = null;
      setPhase('idle');
      setStatusText('');
      onError(error instanceof Error && error.message.startsWith('Запись WebM') ? error.message : getCaptureError(error));
    } finally {
      if (generation === captureGeneration.current) starting.current = false;
    }
  }

  const cancelRecording = useCallback(() => {
    const currentPhase = phaseRef.current;
    if (currentPhase === 'recording' || currentPhase === 'starting') {
      cancelledCapture.current = true;
      if (currentPhase === 'starting') {
        captureGeneration.current += 1;
        starting.current = false;
      }
      clearRecordingTimers();
      stopStream();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      else if (currentPhase === 'starting') {
        setPhase('idle');
        setStatusText('');
      }
      return;
    }
    const activeRequestId = requestId.current;
    if (!activeRequestId) return;
    cancelledRequestId.current = activeRequestId;
    captureGeneration.current += 1;
    setPhase('cancelling');
    setStatusText('Останавливаем распознавание…');
    void window.gigaChat.voice.cancel(activeRequestId).then(() => {
      pendingCleanupRequests.delete(activeRequestId);
      if (mounted.current && requestId.current === activeRequestId) {
        requestId.current = null;
        setPhase('idle');
        setStatusText('');
      }
    }).catch(() => {
      if (mounted.current && requestId.current === activeRequestId) {
        onError('Не удалось очистить временную запись. Повторите отмену, чтобы попробовать ещё раз.');
        setPhase('transcribing');
        setStatusText('Очистка не подтверждена — повторите отмену.');
      }
    });
  }, [onError]);

  useEffect(() => {
    if (!suspended) {
      suspensionHandled.current = false;
      return;
    }
    if (suspensionHandled.current) return;
    suspensionHandled.current = true;
    cancelRecording();
  }, [cancelRecording, suspended]);

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
