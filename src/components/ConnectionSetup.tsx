import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, LoaderCircle, RotateCw, ShieldCheck } from 'lucide-react';
import type { OnboardingBrowserStatus, SecureStoreStatus } from '../contracts';

interface ConnectionSetupProps {
  firstRun: boolean;
  onContinue?: () => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
}

function keyStatusText(status: SecureStoreStatus | null): string {
  if (!status) return 'Проверяем защищённое хранилище…';
  if (!status.available) return 'Шифрование средствами ОС сейчас недоступно.';
  if (!status.saved) return 'Значение ещё не сохранено.';
  if (!status.usable) return 'Сохранённое значение нельзя расшифровать.';
  return 'Значение сохранено с шифрованием средствами ОС.';
}

const EMPTY_BROWSER_STATUS: OnboardingBrowserStatus = {
  open: false,
  loading: false,
  canGoBack: false,
  atStudio: false,
  hostname: null,
  error: null,
};

export default function ConnectionSetup({ firstRun, onContinue }: ConnectionSetupProps) {
  const [keyValue, setKeyValue] = useState('');
  const [keyStatus, setKeyStatus] = useState<SecureStoreStatus | null>(null);
  const [browserStatus, setBrowserStatus] = useState(EMPTY_BROWSER_STATUS);
  const [saving, setSaving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [busyBrowser, setBusyBrowser] = useState(false);
  const [error, setError] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let frame = 0;
    let lastBounds = '';
    const unsubscribe = window.gigaChat.onboarding.onBrowserStatus((status) => {
      if (alive) setBrowserStatus(status);
    });
    void window.gigaChat.onboarding.getKeyStatus().then((status) => {
      if (alive) setKeyStatus(status);
    }).catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });
    void window.gigaChat.onboarding.getBrowserStatus().then((status) => {
      if (alive) setBrowserStatus(status);
    }).catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });

    const sendBounds = (): Promise<void> => {
      const viewport = viewportRef.current;
      if (!viewport) return Promise.resolve();
      const rect = viewport.getBoundingClientRect();
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const signature = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (signature === lastBounds) return Promise.resolve();
      lastBounds = signature;
      return window.gigaChat.onboarding.setBrowserBounds(bounds);
    };
    const scheduleBounds = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        void sendBounds().catch((reason: unknown) => {
          if (alive) setError(errorText(reason));
        });
      });
    };
    const observer = new ResizeObserver(scheduleBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener('resize', scheduleBounds);
    window.addEventListener('scroll', scheduleBounds, true);
    scheduleBounds();

    if (firstRun) {
      void sendBounds().then(() => window.gigaChat.onboarding.openStudio()).then((status) => {
        if (alive) setBrowserStatus(status);
      }).catch((reason: unknown) => {
        if (alive) setError(errorText(reason));
      });
    }

    return () => {
      alive = false;
      unsubscribe();
      observer.disconnect();
      window.removeEventListener('resize', scheduleBounds);
      window.removeEventListener('scroll', scheduleBounds, true);
      if (frame) cancelAnimationFrame(frame);
      void window.gigaChat.onboarding.closeBrowser().catch(() => undefined);
    };
  }, [firstRun]);

  async function saveKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const status = await window.gigaChat.onboarding.saveKey(keyValue);
      setKeyStatus(status);
      setKeyValue('');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }

  async function openStudio(): Promise<void> {
    setError('');
    setBusyBrowser(true);
    try {
      const status = await window.gigaChat.onboarding.openStudio();
      setBrowserStatus(status);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusyBrowser(false);
    }
  }

  async function finishLocally(): Promise<void> {
    if (!onContinue) return;
    setError('');
    setContinuing(true);
    try {
      await onContinue();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setContinuing(false);
    }
  }

  return (
    <section className="connection-setup" aria-label="Подключение GigaChat API">
      <header className="connection-heading">
        {firstRun && <span className="eyebrow">Первый запуск</span>}
        <h1>{firstRun ? 'Настройте GigaChat Agents' : 'Подключение GigaChat API'}</h1>
        <p>API пока не подключён. Эти шаги не проверяют ключ и не отправляют данные в GigaChat.</p>
      </header>

      <div className="connection-layout">
        <div className="connection-steps">
          <section className="setup-card connection-guide">
            <div className="setup-card-title"><span className="connection-step-number">1</span><h2>Откройте GigaChat Studio</h2></div>
            <p>Войдите в Studio в изолированном окне приложения. Приложение не считывает поля и cookies страницы.</p>
            <div className="connection-browser-state" role="status">
              {browserStatus.loading ? <LoaderCircle className="connection-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
              <span>{browserStatus.loading ? 'Загружаем страницу…' : browserStatus.hostname ? `Открыт сайт ${browserStatus.hostname}` : 'Браузер ещё не открыт'}</span>
            </div>
          </section>

          <section className="setup-card">
            <div className="setup-card-title"><span className="connection-step-number">2</span><h2>Authorization Key</h2></div>
            <p className="connection-caution">Не вводите настоящий ключ на этом этапе. Проверка API появится отдельно; сейчас можно проверить только локальное шифрованное хранение.</p>
            <form className="connection-key-form" onSubmit={(event) => void saveKey(event)}>
              <label htmlFor="connection-key">Значение для защищённого хранения</label>
              <div className="connection-key-control">
                <KeyRound aria-hidden="true" />
                <input
                  id="connection-key"
                  type="password"
                  value={keyValue}
                  onChange={(event) => setKeyValue(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={16384}
                  placeholder="Не вставляйте действующий ключ"
                  aria-describedby="connection-key-status"
                />
                <button type="submit" className="secondary-button" disabled={saving || !keyValue.trim()}>{saving ? 'Сохраняем…' : 'Сохранить локально'}</button>
              </div>
              <p id="connection-key-status" className="connection-key-status" role="status">{keyStatusText(keyStatus)}</p>
            </form>
          </section>

          <section className="setup-card connection-finish">
            <div className="setup-card-title"><span className="connection-step-number">3</span><h2>Выберите, как продолжить</h2></div>
            <p>Локальные чаты и проекты доступны без API. Подключение и проверка ключа станут доступны после отдельного API-этапа.</p>
            {firstRun && <button type="button" className="primary-button" onClick={() => void finishLocally()} disabled={continuing}>
              {continuing ? 'Сохраняем…' : 'Продолжить локально'}
            </button>}
          </section>
          {error && <p className="connection-error" role="alert">{error}</p>}
        </div>

        <section className="connection-browser-card" aria-label="Встроенный браузер GigaChat Studio">
          <div className="connection-browser-toolbar">
            <div className="connection-browser-controls">
              <button type="button" className="icon-button" aria-label="Назад" title="Назад" disabled={!browserStatus.canGoBack} onClick={() => void window.gigaChat.onboarding.back()}><ArrowLeft className="icon" /></button>
              <button type="button" className="icon-button" aria-label="Обновить страницу" title="Обновить страницу" disabled={!browserStatus.open} onClick={() => void window.gigaChat.onboarding.reload()}><RotateCw className="icon" /></button>
            </div>
            <span className="connection-browser-origin" title={browserStatus.hostname ?? 'Только защищённые HTTPS-страницы'}>{browserStatus.hostname ?? 'HTTPS · изолированная сессия'}</span>
            <button type="button" className="connection-browser-open" onClick={() => void openStudio()} disabled={busyBrowser || browserStatus.loading || browserStatus.atStudio}>
              {browserStatus.atStudio ? 'Studio открыта' : browserStatus.open ? 'Перейти в Studio' : 'Открыть Studio'}<ArrowRight aria-hidden="true" />
            </button>
          </div>
          <div ref={viewportRef} className="connection-browser-viewport" aria-label="Содержимое страницы Studio">
            {!browserStatus.open && <div className="connection-browser-placeholder">
              <ShieldCheck aria-hidden="true" />
              <strong>Изолированный браузер</strong>
              <span>Содержимое страницы не передаётся приложению.</span>
            </div>}
          </div>
          <p className="connection-browser-footnote">Сессия удаляется при закрытии этого экрана. Загрузка файлов и доступ к возможностям приложения отключены.</p>
          {browserStatus.error && <p className="connection-browser-error" role="status">{browserStatus.error}</p>}
        </section>
      </div>
    </section>
  );
}
