import { randomUUID } from 'node:crypto';
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserStatus {
  open: boolean;
  loading: boolean;
  canGoBack: boolean;
  atStudio: boolean;
  hostname: string | null;
  error: string | null;
}

export interface OnboardingBrowserDependencies {
  createSession(partition: string): Session;
  createView(options: Electron.WebContentsViewConstructorOptions): WebContentsView;
}

export function isAllowedOnboardingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function getOnboardingPopupTitle(value: string): string {
  if (!isAllowedOnboardingUrl(value)) return 'Страница входа';
  return `Страница входа · ${new URL(value).hostname}`;
}

export function clampBrowserBounds(
  value: BrowserBounds,
  contentWidth: number,
  contentHeight: number,
  zoomFactor: number,
): BrowserBounds | null {
  if (![value.x, value.y, value.width, value.height, contentWidth, contentHeight, zoomFactor].every(Number.isFinite)
    || contentWidth <= 0 || contentHeight <= 0 || zoomFactor <= 0 || value.width <= 0 || value.height <= 0) return null;
  const x = Math.max(0, Math.min(contentWidth, value.x * zoomFactor));
  const y = Math.max(0, Math.min(contentHeight, value.y * zoomFactor));
  const width = Math.min(value.width * zoomFactor, contentWidth - x);
  const height = Math.min(value.height * zoomFactor, contentHeight - y);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

const STUDIO_URL = 'https://developers.sber.ru/studio/';

export function isStudioLandingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://developers.sber.ru' && url.pathname.replace(/\/$/, '') === '/studio';
  } catch {
    return false;
  }
}

export function createOnboardingBrowser(
  getHostWindow: () => BrowserWindow | null,
  dependencies: OnboardingBrowserDependencies,
) {
  let browserSession: Session | null = null;
  let view: WebContentsView | null = null;
  let currentBounds: BrowserBounds | null = null;
  let currentUrl = '';
  let loading = false;
  let error: string | null = null;
  const popups = new Set<BrowserWindow>();
  const listeners = new Set<(status: BrowserStatus) => void>();

  const getStatus = (): BrowserStatus => ({
    open: Boolean(view && !view.webContents.isDestroyed()),
    loading,
    canGoBack: Boolean(view && !view.webContents.isDestroyed() && view.webContents.canGoBack()),
    atStudio: isStudioLandingUrl(currentUrl),
    hostname: (() => {
      try { return currentUrl ? new URL(currentUrl).hostname : null; }
      catch { return null; }
    })(),
    error,
  });

  const publish = (): void => {
    const status = getStatus();
    for (const listener of listeners) listener(status);
  };

  const securityPreferences = (): Electron.WebPreferences => ({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: false,
    disableDialogs: true,
    session: browserSession ?? undefined,
  });

  const applyBounds = (target: WebContentsView, bounds: BrowserBounds | null): void => {
    const host = getHostWindow();
    if (!host || host.isDestroyed() || !bounds) {
      target.setVisible(false);
      return;
    }
    const content = host.getContentBounds();
    const safeBounds = clampBrowserBounds(bounds, content.width, content.height, host.webContents.getZoomFactor());
    target.setVisible(Boolean(safeBounds));
    if (safeBounds) target.setBounds(safeBounds);
  };

  const secureContents = (contents: WebContents): void => {
    contents.on('will-frame-navigate', (details) => {
      if (!isAllowedOnboardingUrl(details.url)) details.preventDefault();
    });
    contents.on('will-navigate', (details) => {
      if (details.isMainFrame && !isAllowedOnboardingUrl(details.url)) details.preventDefault();
    });
    contents.on('will-redirect', (details) => {
      if (details.isMainFrame && !isAllowedOnboardingUrl(details.url)) details.preventDefault();
    });
    contents.setWindowOpenHandler(({ url, features }) => {
      if (!isAllowedOnboardingUrl(url) || !browserSession || /(?:preload|nodeintegration|contextisolation|sandbox|websecurity|session|webpreferences|webviewtag)/i.test(features)) {
        return { action: 'deny' };
      }
      const popupHost = new URL(url).hostname;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          height: 680,
          parent: getHostWindow() ?? undefined,
          show: true,
          title: `Страница входа · ${popupHost}`,
          webPreferences: securityPreferences(),
          width: 760,
        },
      };
    });
    contents.on('did-create-window', (popup) => {
      popups.add(popup);
      secureContents(popup.webContents);
      const refreshTitle = (): void => {
        const url = popup.webContents.getURL();
        popup.setTitle(getOnboardingPopupTitle(url));
      };
      popup.webContents.on('did-navigate', refreshTitle);
      popup.webContents.on('did-navigate-in-page', refreshTitle);
      popup.webContents.on('page-title-updated', (event) => {
        event.preventDefault();
        refreshTitle();
      });
      popup.once('closed', () => popups.delete(popup));
    });
  };

  const ensureView = (): WebContentsView => {
    if (view && !view.webContents.isDestroyed()) return view;
    if (view) {
      const previousHost = getHostWindow();
      if (previousHost && !previousHost.isDestroyed()) previousHost.contentView.removeChildView(view);
      view = null;
      currentUrl = '';
      loading = false;
    }
    const host = getHostWindow();
    if (!host || host.isDestroyed()) throw new Error('Окно приложения недоступно.');
    const partition = `gigachat-onboarding-${randomUUID()}`;
    browserSession = dependencies.createSession(partition);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', (event) => event.preventDefault());
    browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (_details, callback) => callback({ cancel: true }));

    view = dependencies.createView({
      webPreferences: securityPreferences(),
    });
    secureContents(view.webContents);
    view.webContents.on('did-start-loading', () => {
      loading = true;
      error = null;
      publish();
    });
    view.webContents.on('did-stop-loading', () => {
      loading = false;
      publish();
    });
    view.webContents.on('did-navigate', (_event, url) => {
      currentUrl = isAllowedOnboardingUrl(url) ? url : '';
      publish();
    });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      currentUrl = isAllowedOnboardingUrl(url) ? url : '';
      publish();
    });
    view.webContents.on('did-fail-load', (_event, code, _description, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      loading = false;
      error = 'Страница не загрузилась. Проверьте подключение и повторите попытку.';
      publish();
    });
    host.contentView.addChildView(view);
    applyBounds(view, currentBounds);
    return view;
  };

  const close = async (): Promise<void> => {
    for (const popup of popups) if (!popup.isDestroyed()) popup.close();
    popups.clear();
    if (view) {
      const host = getHostWindow();
      if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      view = null;
    }
    const oldSession = browserSession;
    browserSession = null;
    currentUrl = '';
    loading = false;
    error = null;
    publish();
    if (oldSession) {
      await oldSession.clearStorageData();
      await oldSession.clearCache();
      await oldSession.clearAuthCache();
    }
  };

  const openStudio = async (): Promise<BrowserStatus> => {
    const target = ensureView();
    if (!isStudioLandingUrl(currentUrl)) {
      error = null;
      loading = true;
      publish();
      try {
        await target.webContents.loadURL(STUDIO_URL);
      } catch {
        loading = false;
        error = 'Страница не загрузилась. Проверьте подключение и повторите попытку.';
        publish();
      }
    }
    return getStatus();
  };

  return {
    back(): void {
      if (view && !view.webContents.isDestroyed() && view.webContents.canGoBack()) view.webContents.goBack();
    },
    close,
    getStatus,
    onStatus(listener: (status: BrowserStatus) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openStudio,
    reload(): void {
      if (view && !view.webContents.isDestroyed()) view.webContents.reload();
    },
    setBounds(bounds: BrowserBounds | null): void {
      currentBounds = bounds;
      if (!view || view.webContents.isDestroyed()) return;
      applyBounds(view, currentBounds);
    },
  };
}
