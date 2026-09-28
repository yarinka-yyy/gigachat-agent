import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import type { EmbeddedBrowserStatus } from '../contracts';
import { browserMaximumWidth, browserReleaseWidth, browserVisibleWidth } from '../browser-layout';

const EMPTY_STATUS: EmbeddedBrowserStatus = { tabs: [], activeTabId: null, error: null };

export default function BrowserPanel({ onClose, onWidthChange, preferredWidth, suspended }: { onClose(): void; onWidthChange(width: number): void; preferredWidth: number | null; suspended: boolean }) {
  const [status, setStatus] = useState<EmbeddedBrowserStatus>(EMPTY_STATUS);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [areaWidth, setAreaWidth] = useState(0);
  const areaWidthRef = useRef(0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const active = status.tabs.find((tab) => tab.id === status.activeTabId);
  const maximum = browserMaximumWidth(areaWidth);
  const overlay = areaWidth < 880;
  const visibleWidth = overlay ? browserVisibleWidth(areaWidth, preferredWidth) : dragWidth ?? browserVisibleWidth(areaWidth, preferredWidth);

  useLayoutEffect(() => {
    const area = panelRef.current?.parentElement;
    if (!area) return;
    const update = () => { areaWidthRef.current = area.clientWidth; setAreaWidth(area.clientWidth); };
    const observer = new ResizeObserver(update);
    observer.observe(area);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);

  function collapse(): void {
    if (closing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 220);
  }

  function resizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || closing || overlay) return;
    const divider = event.currentTarget;
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? visibleWidth;
    divider.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      setDragWidth(Math.max(320, Math.min(maximum, startWidth + startX - next.clientX)));
    };
    const stop = (next: PointerEvent) => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', stop);
      divider.removeEventListener('pointercancel', stop);
      if (divider.hasPointerCapture(next.pointerId)) divider.releasePointerCapture(next.pointerId);
      setDragWidth(null);
      if (next.type === 'pointercancel' || areaWidthRef.current < 880) return;
      const width = browserReleaseWidth(startWidth + startX - next.clientX, areaWidthRef.current);
      if (width === null) collapse();
      else onWidthChange(width);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }

  function resizeKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (overlay) return;
    let width: number | null = null;
    if (event.key === 'ArrowLeft') width = Math.min(maximum, visibleWidth + (event.shiftKey ? 32 : 16));
    if (event.key === 'ArrowRight') width = Math.max(320, visibleWidth - (event.shiftKey ? 32 : 16));
    if (event.key === 'Home') width = maximum;
    if (event.key === 'End') { event.preventDefault(); collapse(); return; }
    if (width !== null) { event.preventDefault(); onWidthChange(Math.round(width)); }
  }

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

  return <aside ref={panelRef} className={`browser-pane${overlay ? ' is-overlay' : ''}${dragWidth !== null ? ' is-dragging' : ''}${closing ? ' is-closing' : ''}`} style={{ width: closing ? 0 : visibleWidth }} aria-label="Встроенный браузер">
    {!overlay && <div className="browser-resizer" role="separator" tabIndex={0} aria-label="Ширина встроенного браузера" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maximum} aria-valuenow={Math.round(visibleWidth)} onPointerDown={resizeStart} onKeyDown={resizeKey} />}
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
