import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import type { EmbeddedBrowserStatus } from '../contracts';
import { browserMaximumWidth, browserReleaseWidth, browserVisibleWidth, shouldSnapBrowserToFullOnLeftEdge } from '../browser-layout';

const EMPTY_STATUS: EmbeddedBrowserStatus = { tabs: [], activeTabId: null, error: null };
type Surface = 'chat' | 'browser';

export default function BrowserPanel({
  chatHeading,
  chatContent,
  paneOpen,
  onPaneOpenChange,
  paneIcon,
  onWidthChange,
  preferredWidth,
  suspended,
}: {
  chatHeading: ReactNode;
  chatContent: ReactNode;
  paneOpen: boolean;
  onPaneOpenChange(open: boolean): void;
  paneIcon: ReactNode;
  onWidthChange(width: number): void;
  preferredWidth: number | null;
  suspended: boolean;
}) {
  const [status, setStatus] = useState<EmbeddedBrowserStatus>(EMPTY_STATUS);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [areaWidth, setAreaWidth] = useState(0);
  const areaWidthRef = useRef(0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeSurface, setActiveSurface] = useState<Surface>(paneOpen ? 'browser' : 'chat');
  const workspaceRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const presentationGeneration = useRef(0);
  const presentationSnapshot = useRef({ paneOpen, activeSurface, suspended });
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusTab = useRef<string | null>(null);
  const pendingAddressFocus = useRef<{ generation: number; surface: Surface } | null>(null);
  const cancelActiveGesture = useRef<(() => void) | null>(null);
  const active = status.tabs.find((tab) => tab.id === status.activeTabId);
  const maximum = browserMaximumWidth(areaWidth);
  const narrow = areaWidth < 880;
  const fullView = paneOpen && (expanded || narrow);
  const visibleWidth = fullView ? areaWidth : browserVisibleWidth(areaWidth, preferredWidth);
  const layoutWidth = dragWidth ?? visibleWidth;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    presentationGeneration.current += 1;
    presentationSnapshot.current = { paneOpen, activeSurface, suspended };
  }, [paneOpen, fullView, activeSurface, suspended]);

  function isCurrentPresentation(generation: number): boolean {
    return mountedRef.current && presentationGeneration.current === generation;
  }

  function focusPendingAddress(): void {
    const pending = pendingAddressFocus.current;
    if (!pending || !mountedRef.current) return;
    const generation = presentationGeneration.current;
    if (generation < pending.generation || generation > pending.generation + 1) {
      pendingAddressFocus.current = null;
      return;
    }
    const current = presentationSnapshot.current;
    if (!current.paneOpen || current.suspended || current.activeSurface !== pending.surface) {
      if (generation > pending.generation) pendingAddressFocus.current = null;
      return;
    }
    pendingAddressFocus.current = null;
    inputRef.current?.focus();
  }

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => {
      const width = workspace.getBoundingClientRect().width;
      areaWidthRef.current = width;
      setAreaWidth(width);
    };
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let listening = true;
    const unsubscribe = window.gigaChat.browser.onStatus((next) => {
      if (listening && mountedRef.current) setStatus(next);
    });
    return () => { listening = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!paneOpen) return;
    let mounted = true;
    void window.gigaChat.browser.getStatus().then(async (initial) => {
      if (!mounted) return;
      setStatus(initial);
      if (!initial.tabs.length) {
        const created = await window.gigaChat.browser.newTab();
        if (mounted) setStatus(created);
      }
    }).catch((reason: unknown) => { if (mounted) setError(reason instanceof Error ? reason.message : 'Не удалось открыть браузер.'); });
    return () => { mounted = false; };
  }, [paneOpen]);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setAddress(active?.url ?? '');
  }, [active?.id, active?.url]);

  useEffect(() => {
    const id = pendingFocusTab.current;
    if (!id) return;
    pendingFocusTab.current = null;
    const generation = presentationGeneration.current;
    requestAnimationFrame(() => {
      if (isCurrentPresentation(generation)) tabButtons.current.get(id)?.focus();
    });
  }, [status]);

  useEffect(() => {
    if (!pendingAddressFocus.current) return;
    const frame = requestAnimationFrame(focusPendingAddress);
    return () => cancelAnimationFrame(frame);
  }, [paneOpen, fullView, activeSurface, suspended]);

  useLayoutEffect(() => {
    let activeEffect = true;
    const update = () => {
      const viewport = viewportRef.current;
      const rect = viewport?.getBoundingClientRect();
      const bounds = paneOpen && !closing && !suspended && !(fullView && activeSurface === 'chat')
        && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null;
      void window.gigaChat.browser.setBounds(bounds).catch((reason: unknown) => {
        if (activeEffect && mountedRef.current) setError(reason instanceof Error ? reason.message : 'Не удалось разместить браузер.');
      });
    };
    const workspace = workspaceRef.current;
    const viewport = viewportRef.current;
    const panel = workspace?.closest('.main-panel');
    const observer = new ResizeObserver(update);
    if (workspace) observer.observe(workspace);
    if (viewport) observer.observe(viewport);
    if (panel) observer.observe(panel);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();
    return () => {
      activeEffect = false;
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      void window.gigaChat.browser.setBounds(null).catch(() => undefined);
    };
  }, [paneOpen, closing, fullView, activeSurface, suspended, visibleWidth, areaWidth]);

  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);

  useEffect(() => {
    if (!paneOpen || fullView || suspended) cancelActiveGesture.current?.();
  }, [paneOpen, fullView, suspended]);

  useEffect(() => () => cancelActiveGesture.current?.(), []);

  function closePane(): void {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
    setExpanded(false);
    setActiveSurface('chat');
    onPaneOpenChange(false);
  }

  function togglePane(): void {
    if (paneOpen) { closePane(); return; }
    if (areaWidthRef.current < 880) setActiveSurface('browser');
    setClosing(false);
    onPaneOpenChange(true);
  }

  function collapse(): void {
    if (closing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { closePane(); return; }
    setClosing(true);
    closeTimer.current = window.setTimeout(closePane, 220);
  }

  function resizeStart(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.pointerType !== 'mouse' || !event.isPrimary || closing || narrow || fullView) return;
    event.preventDefault();
    const divider = event.currentTarget;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const targetWorkspace = workspace;
    const startRect = targetWorkspace.getBoundingClientRect();
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? visibleWidth;
    const pointerId = event.pointerId;
    let previousX = startX;
    let activeGesture = true;
    let observer: ResizeObserver | null = null;
    function clearListeners(): void {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', cancelGesture);
      window.removeEventListener('resize', cancelGesture);
      window.visualViewport?.removeEventListener('resize', cancelGesture);
      divider.removeEventListener('lostpointercapture', lostCapture);
      observer?.disconnect();
    }
    function finish(commit: boolean, finalX = previousX): void {
      if (!activeGesture) return;
      activeGesture = false;
      clearListeners();
      if (cancelActiveGesture.current === cancelGesture) cancelActiveGesture.current = null;
      if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
      setDragWidth(null);
      if (!commit) return;
      const rect = targetWorkspace.getBoundingClientRect();
      if (rect.width < 880) return;
      const width = browserReleaseWidth(startWidth + startX - finalX, rect.width);
      if (width === null) collapse();
      else onWidthChange(width);
    }
    function move(next: PointerEvent): void {
      if (!activeGesture || next.pointerId !== pointerId) return;
      next.preventDefault();
      const rect = targetWorkspace.getBoundingClientRect();
      setDragWidth(Math.max(320, Math.min(browserMaximumWidth(rect.width), startWidth + startX - next.clientX)));
      const snap = shouldSnapBrowserToFullOnLeftEdge(next.clientX, previousX, rect.left, rect.width, true);
      previousX = next.clientX;
      if (!snap) return;
      finish(false);
      setActiveSurface('browser');
      setExpanded(true);
    }
    function end(next: PointerEvent): void {
      if (next.pointerId === pointerId) finish(true, next.clientX);
    }
    function pointerCancel(next: PointerEvent): void {
      if (next.pointerId === pointerId) finish(false);
    }
    function cancelGesture(): void { finish(false); }
    function lostCapture(next: PointerEvent): void {
      if (next.pointerId === pointerId) finish(false);
    }
    function keydown(next: KeyboardEvent): void {
      if (next.key !== 'Escape') return;
      next.preventDefault();
      finish(false);
    }
    cancelActiveGesture.current = cancelGesture;
    divider.addEventListener('lostpointercapture', lostCapture);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', cancelGesture);
    window.addEventListener('resize', cancelGesture);
    window.visualViewport?.addEventListener('resize', cancelGesture);
    observer = new ResizeObserver(() => {
      const rect = targetWorkspace.getBoundingClientRect();
      if (Math.abs(rect.left - startRect.left) > 0.25 || Math.abs(rect.width - startRect.width) > 0.25 || Math.abs(rect.height - startRect.height) > 0.25) cancelGesture();
    });
    observer.observe(workspace);
    setDragWidth(startWidth);
    try { divider.setPointerCapture(pointerId); }
    catch { finish(false); }
  }

  function resizeKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (narrow || fullView) return;
    let width: number | null = null;
    if (event.key === 'ArrowLeft') width = Math.min(maximum, visibleWidth + (event.shiftKey ? 32 : 16));
    if (event.key === 'ArrowRight') width = Math.max(320, visibleWidth - (event.shiftKey ? 32 : 16));
    if (event.key === 'Home') width = maximum;
    if (event.key === 'End') { event.preventDefault(); collapse(); return; }
    if (width !== null) { event.preventDefault(); onWidthChange(Math.round(width)); }
  }

  function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...(tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    if (!tabs.length) return;
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = index;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else if (index >= 0) nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    else nextIndex = 0;
    event.preventDefault();
    tabs[nextIndex]?.focus();
  }

  async function perform(action: () => Promise<EmbeddedBrowserStatus>, focusAddress = false, onSuccess?: () => void): Promise<void> {
    const generation = presentationGeneration.current;
    try {
      const next = await action();
      if (!mountedRef.current) return;
      setStatus(next);
      if (isCurrentPresentation(generation)) {
        setError('');
        if (focusAddress) pendingAddressFocus.current = { generation, surface: fullView ? 'browser' : activeSurface };
        onSuccess?.();
        if (focusAddress) requestAnimationFrame(focusPendingAddress);
      }
    } catch (reason) {
      if (isCurrentPresentation(generation)) setError(reason instanceof Error ? reason.message : 'Действие браузера не выполнено.');
    }
  }

  function selectBrowserTab(id: string): void {
    void perform(() => window.gigaChat.browser.activateTab(id), false, () => { if (fullView) setActiveSurface('browser'); });
  }

  async function closeBrowserTab(id: string): Promise<void> {
    const generation = presentationGeneration.current;
    try {
      const focusedTab = tabButtons.current.get(id)?.closest('.browser-tab')?.contains(document.activeElement) ?? false;
      const next = await window.gigaChat.browser.closeTab(id);
      if (!mountedRef.current) return;
      setStatus(next);
      if (isCurrentPresentation(generation)) {
        setError('');
        if (focusedTab && next.activeTabId) {
          pendingFocusTab.current = next.activeTabId;
          if (fullView) setActiveSurface('browser');
        }
      }
    } catch (reason) {
      if (isCurrentPresentation(generation)) setError(reason instanceof Error ? reason.message : 'Не удалось закрыть вкладку браузера.');
    }
  }

  function navigate(): void {
    if (!address.trim()) return;
    void perform(() => window.gigaChat.browser.navigate(address), false, () => { if (fullView) setActiveSurface('browser'); });
    inputRef.current?.blur();
  }

  const chatTab = fullView ? <button
    id="workspace-chat-tab"
    type="button"
    role="tab"
    className={`chat-surface-tab${activeSurface === 'chat' ? ' active' : ''}`}
    aria-selected={activeSurface === 'chat'}
    aria-controls="workspace-chat-panel"
    tabIndex={activeSurface === 'chat' || !status.activeTabId ? 0 : -1}
    onClick={() => setActiveSurface('chat')}
  ><span className="chat-header-title-group">{chatHeading}</span></button> : <div className="chat-header-title-group">{chatHeading}</div>;

  const headerTabs = paneOpen && <div className="browser-header-cell">
    <div className="browser-tabs">
      <div ref={tabListRef} className="browser-tablist" role="tablist" aria-label={fullView ? 'Вкладки рабочего пространства' : 'Вкладки браузера'} onKeyDown={handleTabListKeyDown}>
        {fullView && chatTab}
        {status.tabs.map((tab) => <div className={tab.id === status.activeTabId && (!fullView || activeSurface === 'browser') ? 'browser-tab active' : 'browser-tab'} key={tab.id} role="presentation">
          <button
            ref={(node) => { if (node) tabButtons.current.set(tab.id, node); else tabButtons.current.delete(tab.id); }}
            id={`browser-tab-${tab.id}`}
            data-browser-tab-id={tab.id}
            type="button"
            role="tab"
            aria-controls="browser-workspace-panel"
            aria-current={!fullView && tab.id === status.activeTabId ? 'page' : undefined}
            aria-selected={fullView ? activeSurface === 'browser' && tab.id === status.activeTabId : tab.id === status.activeTabId}
            tabIndex={fullView ? activeSurface === 'browser' && tab.id === status.activeTabId ? 0 : -1 : tab.id === status.activeTabId ? 0 : -1}
            title={tab.title}
            onClick={() => selectBrowserTab(tab.id)}
          ><Globe aria-hidden="true" /><span>{tab.title}</span></button>
          <button type="button" className="browser-tab-close" aria-label={`Закрыть вкладку ${tab.title}`} title="Закрыть вкладку" onClick={() => void closeBrowserTab(tab.id)}><X aria-hidden="true" /></button>
        </div>)}
      </div>
      <button type="button" className="browser-tool browser-new-tab" aria-label="Новая вкладка" title="Новая вкладка" onClick={() => void perform(() => window.gigaChat.browser.newTab(), true, () => { if (fullView) setActiveSurface('browser'); })}><Plus aria-hidden="true" /></button>
    </div>
  </div>;

  return <div
    ref={workspaceRef}
    className={`browser-workspace${paneOpen ? ' browser-open' : ''}${fullView ? ` is-full surface-${activeSurface}` : ''}${dragWidth !== null ? ' is-dragging' : ''}`}
    style={{ '--browser-pane-width': `${layoutWidth}px` } as CSSProperties}
  >
    <header className="chat-header">
      <div className="chat-heading-cell" hidden={fullView}>{!fullView && <div className="chat-header-title-group">{chatHeading}</div>}</div>
      {headerTabs}
      <div className="workspace-header-actions">
        {paneOpen && <button
          type="button"
          className="workspace-expand-toggle"
          aria-label={expanded ? 'Выйти из режима полного просмотра' : 'Развернуть на всю рабочую область'}
          aria-pressed={expanded}
          title={expanded ? 'Выйти из режима полного просмотра' : 'Развернуть на всю рабочую область'}
          onClick={() => { setExpanded((value) => !value); setActiveSurface('browser'); }}
        ><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {expanded ? <path d="M14 6v4h4M6 14h4v4" /> : <path d="M14 6h4v4M10 18H6v-4" />}
        </svg></button>}
        <button type="button" className="chat-browser-toggle" aria-label={paneOpen ? 'Скрыть браузер' : 'Показать браузер'} aria-expanded={paneOpen} title={paneOpen ? 'Скрыть браузер' : 'Показать браузер'} onClick={togglePane}>{paneIcon}</button>
      </div>
    </header>
    <div className={`chat-workspace${paneOpen ? ' browser-open' : ''}`}>
      <div
        className="chat-column"
        id="workspace-chat-panel"
        role={fullView ? 'tabpanel' : undefined}
        aria-labelledby={fullView ? 'workspace-chat-tab' : undefined}
        aria-hidden={fullView && activeSurface === 'browser' ? true : undefined}
        hidden={fullView && activeSurface === 'browser'}
        inert={fullView && activeSurface === 'browser'}
      >{fullView && activeSurface === 'chat' && error && <p className="runtime-error browser-surface-error" role="alert">{error}</p>}{chatContent}</div>
      {paneOpen && <aside
        ref={panelRef}
        className={`browser-pane${closing ? ' is-closing' : ''}`}
        id="browser-workspace-panel"
        role="tabpanel"
        aria-labelledby={status.activeTabId ? `browser-tab-${status.activeTabId}` : undefined}
        aria-label={status.activeTabId ? undefined : 'Встроенный браузер'}
        aria-hidden={fullView && activeSurface === 'chat' ? true : undefined}
        hidden={fullView && activeSurface === 'chat'}
        inert={fullView && activeSurface === 'chat'}
        style={{ width: closing ? 0 : layoutWidth }}
      >
        {!narrow && !fullView && <div className="browser-resizer" role="separator" tabIndex={0} aria-label="Ширина встроенного браузера" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maximum} aria-valuenow={Math.round(dragWidth ?? visibleWidth)} onPointerDown={resizeStart} onKeyDown={resizeKey} />}
        <div className="browser-toolbar">
          <button type="button" className="browser-tool" disabled={!active?.canGoBack} aria-label="Назад в браузере" title="Назад" onClick={() => void window.gigaChat.browser.back()}><ArrowLeft aria-hidden="true" /></button>
          <button type="button" className="browser-tool" disabled={!active?.canGoForward} aria-label="Вперёд в браузере" title="Вперёд" onClick={() => void window.gigaChat.browser.forward()}><ArrowRight aria-hidden="true" /></button>
          <button type="button" className="browser-tool" disabled={!active?.url} aria-label="Обновить страницу" title="Обновить" onClick={() => void window.gigaChat.browser.reload()}><RotateCw aria-hidden="true" className={active?.loading ? 'browser-loading' : ''} /></button>
          <form className="browser-address" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
            <input ref={inputRef} type="text" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => {
              if (event.key === 'Escape') { setAddress(active?.url ?? ''); event.currentTarget.blur(); }
            }} aria-label="Поиск или ввод URL" placeholder="Поиск или ввод URL" spellCheck={false} />
          </form>
        </div>
        <div ref={viewportRef} className="browser-viewport">
          {(error || status.error || active?.error) ? <p className="browser-message" role="alert">{error || status.error || active?.error}</p>
            : !active?.url ? <p className="browser-message">Введите адрес сайта или поисковый запрос.</p> : null}
        </div>
      </aside>}
    </div>
  </div>;
}
