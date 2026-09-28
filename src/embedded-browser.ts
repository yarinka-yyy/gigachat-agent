import { randomUUID } from 'node:crypto';
import type { BrowserWindow, Session, WebContentsView } from 'electron';
import type { BrowserBounds, BrowserTabRecord, EmbeddedBrowserStatus } from './contracts';
import { clampBrowserBounds } from './onboarding-browser';

type Tab = BrowserTabRecord & { view: WebContentsView | null; loading: boolean; error: string | null };

export function isAllowedPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}

export function resolveBrowserAddress(input: string): string {
  const value = input.trim();
  if (!value || value.length > 4096) throw new Error('Введите адрес или поисковый запрос.');
  const looksLikeHost = /^(?:localhost(?::\d+)?|(?:[^\s./:]+\.)+[^\s./:]+(?::\d+)?)(?:[/?#][^\s]*)?$/i.test(value);
  const target = looksLikeHost ? `${value.startsWith('localhost') ? 'http' : 'https'}://${value}` : value;
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || looksLikeHost) {
    if (!isAllowedPageUrl(target)) throw new Error('Можно открывать только страницы HTTP и HTTPS без данных входа в адресе.');
    return new URL(target).href;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function createEmbeddedBrowser(
  getHostWindow: () => BrowserWindow | null,
  dependencies: {
    createSession(partition: string): Session;
    createView(options: Electron.WebContentsViewConstructorOptions): WebContentsView;
    persist(tabs: BrowserTabRecord[], activeTabId: string | null): Promise<unknown>;
  },
  savedTabs: BrowserTabRecord[],
  savedActiveTabId: string | null,
) {
  const browserSession = dependencies.createSession('persist:gigachat-browser');
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on('will-download', (event) => event.preventDefault());

  const tabs: Tab[] = savedTabs.map((tab) => ({ ...tab, view: null, loading: false, error: null }));
  let activeTabId = savedActiveTabId && tabs.some((tab) => tab.id === savedActiveTabId) ? savedActiveTabId : tabs[0]?.id ?? null;
  let bounds: BrowserBounds | null = null;
  let attachedView: WebContentsView | null = null;
  let saveChain: Promise<unknown> = Promise.resolve();
  let saveError: string | null = null;
  const listeners = new Set<(status: EmbeddedBrowserStatus) => void>();
  const activeTab = (): Tab | undefined => tabs.find((tab) => tab.id === activeTabId);
  const live = (tab: Tab): boolean => Boolean(tab.view && !tab.view.webContents.isDestroyed());

  const getStatus = (): EmbeddedBrowserStatus => ({
    tabs: tabs.map((tab) => ({
      id: tab.id, title: tab.title, url: tab.url, loading: tab.loading, error: tab.error,
      canGoBack: live(tab) ? Boolean(tab.view?.webContents.canGoBack()) : false,
      canGoForward: live(tab) ? Boolean(tab.view?.webContents.canGoForward()) : false,
    })),
    activeTabId,
    error: saveError,
  });
  const publish = (): void => { const status = getStatus(); for (const listener of listeners) listener(status); };
  const persist = (): void => {
    const records = tabs.map(({ id, title, url }) => ({ id, title, url }));
    const selected = activeTabId;
    saveChain = saveChain.catch(() => undefined).then(() => dependencies.persist(records, selected));
    void saveChain.then(() => { saveError = null; }, () => {
      saveError = 'Не удалось сохранить вкладки браузера.';
      publish();
    });
  };

  const showActive = (): void => {
    const host = getHostWindow();
    if (!host || host.isDestroyed()) return;
    const tab = activeTab();
    const next = bounds && tab && live(tab) && !tab.error ? tab.view : null;
    if (attachedView && attachedView !== next) {
      host.contentView.removeChildView(attachedView);
      attachedView = null;
    }
    if (!next || !bounds) return;
    if (attachedView !== next) {
      host.contentView.addChildView(next);
      attachedView = next;
    }
    const content = host.getContentBounds();
    const safe = clampBrowserBounds(bounds, content.width, content.height, host.webContents.getZoomFactor());
    next.setVisible(Boolean(safe));
    if (safe) next.setBounds(safe);
  };

  const ensureView = (tab: Tab): WebContentsView => {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    const view = dependencies.createView({ webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, devTools: false, session: browserSession,
    } });
    tab.view = view;
    const contents = view.webContents;
    contents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame && !isAllowedPageUrl(details.url)) details.preventDefault();
    });
    contents.on('will-navigate', (details) => {
      if (details.isMainFrame && !isAllowedPageUrl(details.url)) details.preventDefault();
    });
    contents.on('will-redirect', (details) => {
      if (details.isMainFrame && !isAllowedPageUrl(details.url)) details.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPageUrl(url)) {
        try { createTab(url); } catch { /* The existing 20-tab limit remains in force. */ }
      }
      return { action: 'deny' };
    });
    contents.on('did-start-loading', () => { tab.loading = true; tab.error = null; showActive(); publish(); });
    contents.on('did-stop-loading', () => { tab.loading = false; publish(); });
    contents.on('did-finish-load', () => { tab.loading = false; tab.error = null; showActive(); publish(); });
    const recordNavigation = (_event: unknown, url: string): void => {
      if (!isAllowedPageUrl(url)) return;
      tab.url = url;
      persist();
      publish();
    };
    contents.on('did-navigate', recordNavigation);
    contents.on('did-navigate-in-page', (event, url, isMainFrame) => { if (isMainFrame) recordNavigation(event, url); });
    contents.on('page-title-updated', (_event, title) => {
      tab.title = title.replace(/\p{Cc}/gu, '').slice(0, 160) || new URL(tab.url).hostname;
      persist();
      publish();
    });
    contents.on('did-fail-load', (_event, code, _description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || failedUrl !== tab.url) return;
      tab.loading = false;
      tab.error = 'Страница не загрузилась. Проверьте адрес и подключение.';
      showActive();
      publish();
    });
    return view;
  };

  const load = (tab: Tab, url: string): void => {
    tab.url = url;
    tab.title = new URL(url).hostname;
    tab.error = null;
    tab.loading = true;
    const view = ensureView(tab);
    showActive();
    persist();
    publish();
    void view.webContents.loadURL(url).catch(() => {
      if (tab.url !== url) return;
      tab.loading = false;
      tab.error = 'Страница не загрузилась. Проверьте адрес и подключение.';
      showActive();
      publish();
    });
  };

  const createTab = (url = ''): EmbeddedBrowserStatus => {
    if (tabs.length >= 20) throw new Error('Можно открыть не более 20 вкладок.');
    const tab: Tab = { id: randomUUID(), title: 'Новая вкладка', url: '', view: null, loading: false, error: null };
    tabs.push(tab);
    activeTabId = tab.id;
    if (url) load(tab, url);
    else { showActive(); persist(); publish(); }
    return getStatus();
  };

  return {
    getStatus,
    onStatus(listener: (status: EmbeddedBrowserStatus) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    newTab: () => createTab(),
    closeTab(id: string): EmbeddedBrowserStatus {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) throw new Error('Вкладка не найдена.');
      const [tab] = tabs.splice(index, 1);
      if (attachedView === tab.view) showActive();
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
      if (activeTabId === id) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      if (tabs.length === 0) return createTab();
      const next = activeTab();
      if (bounds && next?.url && !live(next)) load(next, next.url);
      else { showActive(); persist(); publish(); }
      return getStatus();
    },
    activateTab(id: string): EmbeddedBrowserStatus {
      const tab = tabs.find((item) => item.id === id);
      if (!tab) throw new Error('Вкладка не найдена.');
      activeTabId = id;
      if (bounds && tab.url && !live(tab)) load(tab, tab.url);
      else { showActive(); persist(); publish(); }
      return getStatus();
    },
    navigate(input: string): EmbeddedBrowserStatus {
      const url = resolveBrowserAddress(input);
      const tab = activeTab() ?? tabs[0];
      if (tab) { activeTabId = tab.id; load(tab, url); return getStatus(); }
      return createTab(url);
    },
    back(): void { const tab = activeTab(); if (tab && live(tab) && tab.view?.webContents.canGoBack()) tab.view.webContents.goBack(); },
    forward(): void { const tab = activeTab(); if (tab && live(tab) && tab.view?.webContents.canGoForward()) tab.view.webContents.goForward(); },
    reload(): void { const tab = activeTab(); if (tab?.url) { if (live(tab)) tab.view?.webContents.reload(); else load(tab, tab.url); } },
    setBounds(next: BrowserBounds | null): void {
      bounds = next;
      const tab = activeTab();
      if (bounds && tab?.url && !live(tab)) load(tab, tab.url);
      else showActive();
    },
    flush: () => saveChain,
    destroy(): void {
      const host = getHostWindow();
      if (attachedView && host && !host.isDestroyed()) host.contentView.removeChildView(attachedView);
      attachedView = null;
      for (const tab of tabs) {
        if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
        tab.view = null;
      }
    },
  };
}
