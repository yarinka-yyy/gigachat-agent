import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, LoaderCircle, RotateCw, ShieldCheck } from 'lucide-react';
import type { OnboardingBrowserStatus, ProviderConnectionSnapshot, ProviderErrorCategory, SecureStoreStatus } from '../contracts';

interface ConnectionSetupProps {
  firstRun: boolean;
  suspended?: boolean;
  onContinue?: () => Promise<void>;
  runAcceptedOperation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  reportOperationFailure?: (error: unknown) => void;
  onKeySaveFailureChange?: (failed: boolean) => void;
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

function connectionErrorText(category: ProviderErrorCategory | null): string {
  switch (category) {
    case 'auth': return 'Ключ отклонён или доступ не разрешён.';
    case 'tls': return 'Не удалось подтвердить TLS-сертификат сервера.';
    case 'network': return 'Сетевая ошибка или превышено время ожидания.';
    case 'rate-limit': return 'Сервис временно ограничил запросы.';
    case 'quota': return 'У аккаунта нет доступной квоты.';
    case 'model': return 'Список моделей недоступен или пуст.';
    case 'context': return 'Запрос превышает ограничение контекста.';
    case 'protocol': return 'Сервер вернул ответ в неподдерживаемом формате.';
    case 'storage': return 'Не удалось прочитать ключ из защищённого хранилища.';
    case 'cancel': return 'Подключение отменено.';
    case 'tool': return 'Локальный инструмент завершился с ошибкой.';
    default: return 'Проверьте ключ и подключение к сети.';
  }
}

function connectionStatusText(status: ProviderConnectionSnapshot | null): string {
  if (!status) return 'Проверяем состояние подключения…';
  if (status.state === 'connecting') return 'Проверяем ключ и список моделей…';
  if (status.state === 'connected') return 'OAuth и список моделей проверены.';
  if (status.state === 'error') return connectionErrorText(status.errorCategory);
  return 'GigaChat API не подключён.';
}

const EMPTY_BROWSER_STATUS: OnboardingBrowserStatus = {
  open: false,
  loading: false,
  canGoBack: false,
  atStudio: false,
  hostname: null,
  error: null,
};

export default function ConnectionSetup({
  firstRun,
  suspended = false,
  onContinue,
  runAcceptedOperation,
  reportOperationFailure,
  onKeySaveFailureChange,
}: ConnectionSetupProps) {
  const [keyValue, setKeyValue] = useState('');
  const [keyStatus, setKeyStatus] = useState<SecureStoreStatus | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ProviderConnectionSnapshot | null>(null);
  const [browserStatus, setBrowserStatus] = useState(EMPTY_BROWSER_STATUS);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [busyBrowser, setBusyBrowser] = useState(false);
  const [error, setError] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const suspendedRef = useRef(suspended);
  const syncBrowserBoundsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const keySaveFailed = useRef(false);
  const keyValueRef = useRef('');
  const keySaveGeneration = useRef(0);
  const connectGeneration = useRef(0);
  const connectingRef = useRef(false);
  const mounted = useRef(false);
  const reportOperationFailureRef = useRef(reportOperationFailure);
  const keySaveFailureChangeRef = useRef(onKeySaveFailureChange);
  suspendedRef.current = suspended;
  reportOperationFailureRef.current = reportOperationFailure;
  keySaveFailureChangeRef.current = onKeySaveFailureChange;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      keySaveGeneration.current += 1;
      connectGeneration.current += 1;
      if (connectingRef.current) void window.gigaChat.onboarding.cancelConnect().catch(() => undefined);
      keySaveFailureChangeRef.current?.(false);
    };
  }, []);

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
    void window.gigaChat.onboarding.getConnectionStatus().then((status) => {
      if (alive) setConnectionStatus(status);
    }).catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });
    void window.gigaChat.onboarding.getBrowserStatus().then((status) => {
      if (alive) setBrowserStatus(status);
    }).catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });

    const sendBounds = (): Promise<void> => {
      if (suspendedRef.current) {
        if (lastBounds === 'hidden') return Promise.resolve();
        lastBounds = 'hidden';
        return window.gigaChat.onboarding.setBrowserBounds(null);
      }
      const viewport = viewportRef.current;
      if (!viewport) return Promise.resolve();
      const rect = viewport.getBoundingClientRect();
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const signature = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (signature === lastBounds) return Promise.resolve();
      lastBounds = signature;
      return window.gigaChat.onboarding.setBrowserBounds(bounds);
    };
    syncBrowserBoundsRef.current = sendBounds;
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
      void sendBounds().then(() => alive ? window.gigaChat.onboarding.openStudio() : null).then((status) => {
        if (alive && status) setBrowserStatus(status);
      }).catch((reason: unknown) => {
        if (alive) setError(errorText(reason));
      });
    }

    return () => {
      alive = false;
      if (syncBrowserBoundsRef.current === sendBounds) syncBrowserBoundsRef.current = () => Promise.resolve();
      unsubscribe();
      observer.disconnect();
      window.removeEventListener('resize', scheduleBounds);
      window.removeEventListener('scroll', scheduleBounds, true);
      if (frame) cancelAnimationFrame(frame);
      void window.gigaChat.onboarding.closeBrowser().catch(() => undefined);
    };
  }, [firstRun]);

  useEffect(() => {
    let alive = true;
    void syncBrowserBoundsRef.current().catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });
    return () => { alive = false; };
  }, [suspended]);

  async function saveKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setSaving(true);
    connectGeneration.current += 1;
    if (connectingRef.current) {
      connectingRef.current = false;
      void window.gigaChat.onboarding.cancelConnect().catch(() => undefined);
    }
    setConnecting(false);
    setConnectionStatus({ state: 'not-configured', errorCategory: null });
    const value = keyValueRef.current;
    const generation = ++keySaveGeneration.current;
    try {
      const save = () => window.gigaChat.onboarding.saveKey(value);
      const status = await (runAcceptedOperation ? runAcceptedOperation(save) : save());
      if (!mounted.current || generation !== keySaveGeneration.current) return;
      setKeyStatus(status);
      setConnectionStatus({ state: 'not-configured', errorCategory: null });
      if (keyValueRef.current === value) {
        keyValueRef.current = '';
        setKeyValue('');
        keySaveFailed.current = false;
        keySaveFailureChangeRef.current?.(false);
      } else if (!keyValueRef.current && keySaveFailed.current) {
        keySaveFailed.current = false;
        keySaveFailureChangeRef.current?.(false);
      }
    } catch (reason) {
      if (!mounted.current || generation !== keySaveGeneration.current) return;
      keySaveFailed.current = Boolean(keyValueRef.current);
      keySaveFailureChangeRef.current?.(keySaveFailed.current);
      reportOperationFailureRef.current?.(reason);
      setError(errorText(reason));
    } finally {
      if (mounted.current && generation === keySaveGeneration.current) setSaving(false);
    }
  }

  async function connect(): Promise<void> {
    setError('');
    const generation = ++connectGeneration.current;
    connectingRef.current = true;
    setConnecting(true);
    setConnectionStatus({ state: 'connecting', errorCategory: null });
    try {
      const status = await window.gigaChat.onboarding.connect();
      if (mounted.current && generation === connectGeneration.current) setConnectionStatus(status);
    } catch (reason) {
      if (mounted.current && generation === connectGeneration.current) setError(errorText(reason));
    } finally {
      if (generation === connectGeneration.current) {
        connectingRef.current = false;
        if (mounted.current) setConnecting(false);
      }
    }
  }

  async function cancelConnect(): Promise<void> {
    setError('');
    const generation = ++connectGeneration.current;
    connectingRef.current = false;
    setConnecting(false);
    try {
      const status = await window.gigaChat.onboarding.cancelConnect();
      if (mounted.current && generation === connectGeneration.current) setConnectionStatus(status);
    } catch (reason) {
      if (mounted.current && generation === connectGeneration.current) setError(errorText(reason));
    }
  }

  async function disconnect(): Promise<void> {
    setError('');
    const generation = ++connectGeneration.current;
    connectingRef.current = false;
    setConnecting(false);
    try {
      const status = await window.gigaChat.onboarding.disconnect();
      if (mounted.current && generation === connectGeneration.current) setConnectionStatus(status);
    } catch (reason) {
      if (mounted.current && generation === connectGeneration.current) setError(errorText(reason));
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
        <p>Сохранение ключа выполняется отдельно от проверки подключения. Connect проверяет OAuth и доступность списка моделей.</p>
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
            <p className="connection-caution">Ключ шифруется средствами ОС и остаётся в main process. Connect отправляет его только в OAuth GigaChat; access token хранится только в памяти.</p>
            <form className="connection-key-form" onSubmit={(event) => void saveKey(event)}>
              <label htmlFor="connection-key">Authorization Key</label>
              <div className="connection-key-control">
                <KeyRound aria-hidden="true" />
                <input
                  id="connection-key"
                  type="password"
                  value={keyValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    keyValueRef.current = value;
                    setKeyValue(value);
                    if (!value && keySaveFailed.current) {
                      keySaveFailed.current = false;
                      keySaveFailureChangeRef.current?.(false);
                    }
                  }}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={16384}
                  placeholder="Вставьте Authorization Key из Studio"
                  aria-describedby="connection-key-status"
                />
                <button type="submit" className="secondary-button" disabled={saving || !keyValue.trim()}>{saving ? 'Сохраняем…' : 'Сохранить защищённо'}</button>
              </div>
              <p id="connection-key-status" className="connection-key-status" role="status">{keyStatusText(keyStatus)}</p>
            </form>
            <p className="connection-key-status" role="status">{connectionStatusText(connectionStatus)}</p>
            <p className="connection-key-status">OAuth и список моделей не подтверждают поддержку вложений или понимание документов выбранной моделью.</p>
            {connectionStatus?.state === 'connecting' || connecting
              ? <button type="button" className="secondary-button" onClick={() => void cancelConnect()}>Отменить Connect</button>
              : connectionStatus?.state === 'connected'
                ? <button type="button" className="secondary-button" onClick={() => void disconnect()}>Отключить</button>
                : <button
                  type="button"
                  className="primary-button"
                  onClick={() => void connect()}
                  disabled={saving || connecting || !keyStatus?.saved || !keyStatus.usable || Boolean(keyValue.trim())}
                >Проверить подключение</button>}
          </section>

          <section className="setup-card connection-finish">
            <div className="setup-card-title"><span className="connection-step-number">3</span><h2>Выберите, как продолжить</h2></div>
            <p>Локальные чаты и проекты доступны без API. После проверки подключения можно продолжить локально.</p>
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
