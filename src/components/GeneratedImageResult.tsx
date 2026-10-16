import { useEffect, useState } from 'react';
import type { ChatArtifact } from '../contracts';

type RunRendererOperation = <T>(operation: () => T | Promise<T>) => Promise<T>;

interface GeneratedImageResultProps {
  chatId: string;
  artifact: ChatArtifact;
  runOperation: RunRendererOperation;
  disabled: boolean;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'cancelled' | 'error';

export default function GeneratedImageResult({ chatId, artifact, runOperation, disabled }: GeneratedImageResultProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [openError, setOpenError] = useState(false);

  useEffect(() => {
    let current = true;
    setPreview(null);
    setPreviewStatus('loading');
    setSaveStatus('idle');
    setOpenError(false);
    void window.gigaChat.chats.getGeneratedImagePreview(chatId, artifact.id)
      .then((value) => {
        if (!current) return;
        setPreview(value);
        setPreviewStatus(value ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!current) return;
        setPreviewStatus('missing');
      });
    return () => { current = false; };
  }, [chatId, artifact.id]);

  async function saveImage(): Promise<void> {
    setSaveStatus('saving');
    try {
      const result = await runOperation(() => window.gigaChat.chats.saveGeneratedImage(chatId, artifact.id));
      setSaveStatus(result === 'saved' ? 'saved' : 'cancelled');
    } catch {
      setSaveStatus('error');
    }
  }

  async function openImage(): Promise<void> {
    setOpenError(false);
    try {
      await runOperation(() => window.gigaChat.chats.openArtifact(chatId, artifact.id));
    } catch {
      setOpenError(true);
    }
  }

  return <figure className="generated-image-result" aria-label="Созданное изображение">
    {previewStatus === 'ready' && preview
      ? <img className="generated-image-result-preview" src={preview} alt="Изображение, созданное GigaChat"
        onError={() => { setPreview(null); setPreviewStatus('missing'); }} />
      : <div className="generated-image-result-placeholder" role="status">
        {previewStatus === 'loading' ? 'Загружаем изображение…' : 'Предпросмотр недоступен. Можно сохранить оригинал или открыть файл.'}
      </div>}
    <figcaption className="generated-image-result-actions">
      <button type="button" className="quiet-button" disabled={disabled || saveStatus === 'saving'} onClick={() => void saveImage()}>
        {saveStatus === 'saving' ? 'Сохранение…' : saveStatus === 'saved' ? 'Сохранено' : 'Сохранить'}
      </button>
      <button type="button" className="quiet-button" disabled={disabled || saveStatus === 'saving'} onClick={() => void openImage()}>Открыть</button>
      {saveStatus === 'cancelled' && <span className="generated-image-result-status" role="status">Сохранение отменено.</span>}
      {saveStatus === 'error' && <span className="generated-image-result-status is-error" role="alert">Не удалось сохранить. Попробуйте ещё раз.</span>}
      {openError && <span className="generated-image-result-status is-error" role="alert">Не удалось открыть изображение.</span>}
    </figcaption>
  </figure>;
}
