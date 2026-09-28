import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import type { EmbeddedBrowserStatus } from '../contracts';

const EMPTY_STATUS: EmbeddedBrowserStatus = { tabs: [], activeTabId: null, error: null };

export default function BrowserPanel({ onClose, suspended }: { onClose(): void; suspended: boolean }) {
  const [status, setStatus] = useState<EmbeddedBrowserStatus>(EMPTY_STATUS);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const active = status.tabs.find((tab) => tab.id === status.activeTabId);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.gigaChat.browser.onStatus((next) => { if (mounted) setStatus(next); });
    void window.gigaChat.browser.getStatus().then(async (initial) => {
      if (!mounted) return;
      setStatus(initial.tabs.length ? initial : await window.gigaChat.browser.newTab());
    }).catch((reason: unknown) => { if (mounted) setError(reason instanceof Error ? reason.message : 'Не удалось открыть браузер.'); });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setAddress(active?.url ?? '');
  }, [active?.id, active?.url]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const rect = viewport.getBoundingClientRect();
      const bounds = !suspended && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null;
      void window.gigaChat.browser.setBounds(bounds).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Не удалось разместить браузер.'));
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    const panel = viewport.closest('.main-panel');
    if (panel) observer.observe(panel);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      void window.gigaChat.browser.setBounds(null);
    };
  }, [suspended]);

  async function perform(action: () => Promise<EmbeddedBrowserStatus>, focusAddress = false): Promise<void> {
    try {
      const next = await action();
      setError('');
      setStatus(next);
      if (focusAddress) requestAnimationFrame(() => inputRef.current?.focus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Действие браузера не выполнено.');
    }
  }

  function navigate(): void {
    if (!address.trim()) return;
    void perform(() => window.gigaChat.browser.navigate(address));
    inputRef.current?.blur();
  }

  return <aside className="browser-pane" aria-label="Встроенный браузер">
    <div className="browser-tabs" role="group" aria-label="Вкладки браузера">
      {status.tabs.map((tab) => <div className={tab.id === status.activeTabId ? 'browser-tab active' : 'browser-tab'} key={tab.id}>
        <button type="button" aria-current={tab.id === status.activeTabId ? 'page' : undefined} title={tab.title} onClick={() => void perform(() => window.gigaChat.browser.activateTab(tab.id))}>
          <Globe aria-hidden="true" /><span>{tab.title}</span>
        </button>
        <button type="button" className="browser-tab-close" aria-label={`Закрыть вкладку ${tab.title}`} title="Закрыть вкладку" onClick={() => void perform(() => window.gigaChat.browser.closeTab(tab.id))}><X aria-hidden="true" /></button>
      </div>)}
      <button type="button" className="browser-tool browser-new-tab" aria-label="Новая вкладка" title="Новая вкладка" onClick={() => void perform(() => window.gigaChat.browser.newTab(), true)}><Plus aria-hidden="true" /></button>
    </div>
    <div className="browser-toolbar">
      <button type="button" className="browser-tool" disabled={!active?.canGoBack} aria-label="Назад в браузере" title="Назад" onClick={() => void window.gigaChat.browser.back()}><ArrowLeft aria-hidden="true" /></button>
      <button type="button" className="browser-tool" disabled={!active?.canGoForward} aria-label="Вперёд в браузере" title="Вперёд" onClick={() => void window.gigaChat.browser.forward()}><ArrowRight aria-hidden="true" /></button>
      <button type="button" className="browser-tool" disabled={!active?.url} aria-label="Обновить страницу" title="Обновить" onClick={() => void window.gigaChat.browser.reload()}><RotateCw aria-hidden="true" className={active?.loading ? 'browser-loading' : ''} /></button>
      <form className="browser-address" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
        <input ref={inputRef} type="text" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => {
          if (event.key === 'Escape') { setAddress(active?.url ?? ''); event.currentTarget.blur(); }
        }} aria-label="Поиск или ввод URL" placeholder="Поиск или ввод URL" spellCheck={false} />
      </form>
      <button type="button" className="browser-tool browser-close" aria-label="Закрыть браузерную панель" title="Закрыть браузер" onClick={onClose}><X aria-hidden="true" /></button>
    </div>
    <div ref={viewportRef} className="browser-viewport">
      {(error || status.error || active?.error) ? <p className="browser-message" role="alert">{error || status.error || active?.error}</p>
        : !active?.url ? <p className="browser-message">Введите адрес сайта или поисковый запрос.</p> : null}
    </div>
  </aside>;
}
