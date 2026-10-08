import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow, WebContentsView } from 'electron';
import { createEmbeddedBrowser, isAllowedPageUrl, resolveBrowserAddress } from './embedded-browser';

function navigationFixture() {
  const pending: { url: string; reject: (error: Error) => void }[] = [];
  const attached = new Set<WebContentsView>();
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    setWindowOpenHandler: () => undefined,
    loadURL: (url: string) => new Promise<void>((_resolve, reject) => { pending.push({ url, reject }); }),
    close: () => undefined,
  });
  const view = { webContents: contents, setVisible: () => undefined, setBounds: () => undefined } as unknown as WebContentsView;
  const host = {
    isDestroyed: () => false,
    contentView: { addChildView: (value: WebContentsView) => attached.add(value), removeChildView: (value: WebContentsView) => attached.delete(value) },
    getContentBounds: () => ({ width: 1200, height: 800 }),
    webContents: { getZoomFactor: () => 1 },
  } as unknown as BrowserWindow;
  const browser = createEmbeddedBrowser(() => host, {
    createSession: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined,
    }) as never,
    createView: () => view,
    persist: async () => undefined,
  }, [], null);
  browser.navigate('https://loaded.example/');
  browser.setBounds({ x: 400, y: 90, width: 420, height: 600 });
  contents.emit('did-start-navigation', { url: 'https://loaded.example/', isMainFrame: true });
  contents.emit('did-navigate', {}, 'https://loaded.example/');
  contents.emit('did-finish-load');
  return { browser, contents, pending, attached };
}

test('current native link and redirect failure is visible while stale and subframe failures are ignored', () => {
  const { browser, contents, attached } = navigationFixture();
  contents.emit('did-start-loading');
  contents.emit('did-start-navigation', { url: 'https://linked.example/', isMainFrame: true });
  contents.emit('did-fail-load', {}, -102, 'stale', 'https://loaded.example/', true);
  contents.emit('did-fail-load', {}, -102, 'subframe', 'https://linked.example/', false);
  assert.equal(browser.getStatus().tabs[0]?.error, null);
  contents.emit('did-redirect-navigation', { url: 'https://redirected.example/', isMainFrame: true });
  contents.emit('did-fail-load', {}, -102, 'stale redirect source', 'https://linked.example/', true);
  assert.equal(browser.getStatus().tabs[0]?.error, null);
  contents.emit('did-fail-load', {}, -102, 'connection refused', 'https://redirected.example/', true);
  contents.emit('did-stop-loading');
  assert.match(browser.getStatus().tabs[0]?.error ?? '', /Страница не загрузилась/);
  assert.equal(browser.getStatus().tabs[0]?.loading, false);
  assert.equal(browser.getStatus().tabs[0]?.url, 'https://redirected.example/', 'reload must retry the failed target');
  assert.equal(attached.size, 0, 'failed native page must expose the app error view');
  browser.destroy();
});

test('superseded same-address load and aborted native navigation do not replace a successful page', async () => {
  const { browser, contents, pending } = navigationFixture();
  browser.navigate('https://same.example/');
  browser.navigate('https://same.example/');
  contents.emit('did-start-navigation', { url: 'https://same.example/', isMainFrame: true });
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://same.example/', true);
  contents.emit('did-navigate', {}, 'https://same.example/');
  contents.emit('did-finish-load');
  pending[1].reject(new Error('older request failed'));
  await Promise.resolve();
  assert.equal(browser.getStatus().tabs[0]?.error, null);
  browser.destroy();
});

test('browser address accepts sites, searches with Google, and rejects local or script URLs', () => {
  assert.equal(resolveBrowserAddress('example.com/path'), 'https://example.com/path');
  assert.equal(resolveBrowserAddress('http://localhost:3000/'), 'http://localhost:3000/');
  assert.equal(resolveBrowserAddress('проверка поиска'), 'https://www.google.com/search?q=%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0%20%D0%BF%D0%BE%D0%B8%D1%81%D0%BA%D0%B0');
  assert.equal(isAllowedPageUrl('https://user:password@example.com/'), false);
  assert.throws(() => resolveBrowserAddress('file:///C:/private.txt'));
  assert.throws(() => resolveBrowserAddress('javascript:alert(1)'));
});

test('embedded browser restores tabs, keeps a separate session, and persists tab changes', async () => {
  const partitions: string[] = [];
  const saved: { tabs: { id: string; title: string; url: string }[]; activeTabId: string | null }[] = [];
  const views: WebContentsView[] = [];
  const staleLoad: { reject: ((reason: Error) => void) | null } = { reject: null };
  const host = {
    isDestroyed: () => false,
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    webContents: { getZoomFactor: () => 1 },
  } as unknown as BrowserWindow;
  const browser = createEmbeddedBrowser(() => host, {
    createSession: (partition) => {
      partitions.push(partition);
      return Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
      }) as never;
    },
    createView: () => {
      const contents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        canGoBack: () => false,
        canGoForward: () => false,
        setWindowOpenHandler: () => undefined,
        loadURL: (url: string) => {
          if (url === 'https://stale.example/') return new Promise<void>((_resolve, reject) => { staleLoad.reject = reject; });
          contents.emit('did-navigate', {}, url);
          return Promise.resolve();
        },
        close: () => undefined,
      });
      const view = { webContents: contents, setVisible: () => undefined, setBounds: () => undefined } as unknown as WebContentsView;
      views.push(view);
      return view;
    },
    persist: async (tabs, activeTabId) => { saved.push({ tabs, activeTabId }); },
  }, [
    { id: 'first', title: 'Первый', url: 'https://example.com/' },
    { id: 'second', title: 'Второй', url: 'https://example.org/' },
  ], 'second');

  assert.deepEqual(partitions, ['persist:gigachat-browser']);
  assert.deepEqual(browser.getStatus().tabs.map((tab) => tab.title), ['Первый', 'Второй']);
  assert.equal(browser.getStatus().activeTabId, 'second');
  browser.setBounds({ x: 400, y: 90, width: 420, height: 600 });
  assert.equal(views.length, 1);
  (views[0].webContents as unknown as EventEmitter).emit('did-fail-load', {}, -7, 'stale', 'https://old.example/', true);
  assert.equal(browser.getStatus().tabs[1].error, null);
  browser.navigate('https://stale.example/');
  browser.navigate('https://example.net/');
  if (!staleLoad.reject) throw new Error('Stale load did not start');
  staleLoad.reject(new Error('aborted'));
  await Promise.resolve();
  assert.equal(browser.getStatus().tabs[1].error, null);
  browser.activateTab('first');
  assert.equal(views.length, 2);
  browser.closeTab('first');
  await browser.flush();
  assert.equal(browser.getStatus().activeTabId, 'second');
  assert.deepEqual(saved[saved.length - 1]?.tabs.map((tab) => tab.id), ['second']);
  browser.destroy();
});

test('browser flush retries the latest snapshot after a temporary persistence failure', async () => {
  let attempts = 0;
  const controls: { rejectFirst: ((reason: Error) => void) | null } = { rejectFirst: null };
  let resolveStarted: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const saved: { tabs: { id: string; title: string; url: string }[]; activeTabId: string | null }[] = [];
  const browser = createEmbeddedBrowser(() => null, {
    createSession: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    }) as never,
    createView: () => { throw new Error('No browser view should be required for persistence'); },
    persist: (tabs, activeTabId) => {
      attempts += 1;
      if (attempts === 1) {
        resolveStarted?.();
        return new Promise<void>((_resolve, reject) => { controls.rejectFirst = reject; });
      }
      saved.push({ tabs, activeTabId });
      return Promise.resolve();
    },
  }, [], null);
  let resolveError: (() => void) | null = null;
  const errorPublished = new Promise<void>((resolve) => { resolveError = resolve; });
  browser.onStatus((status) => { if (status.error) resolveError?.(); });

  browser.newTab();
  await firstStarted;
  const rejectFirst = controls.rejectFirst;
  if (!rejectFirst) throw new Error('First persistence attempt did not expose its failure handle');
  rejectFirst(new Error('Temporary storage failure'));
  await errorPublished;
  await browser.flush();

  assert.equal(attempts, 2, 'flush must retry a failed save even when the browser state did not change');
  assert.deepEqual(saved[0]?.tabs.map((tab) => tab.id), [browser.getStatus().tabs[0]?.id]);
  assert.equal(saved[0]?.activeTabId, browser.getStatus().activeTabId);
  assert.equal(browser.getStatus().error, null);
  browser.destroy();
});

test('browser flush waits for native metadata updates queued during the flush', async () => {
  type Saved = { tabs: { id: string; title: string; url: string }[]; activeTabId: string | null };
  const saves: { snapshot: Saved; resolve: () => void }[] = [];
  const waiters = new Map<number, () => void>();
  const waitForSave = (count: number): Promise<void> => saves.length >= count
    ? Promise.resolve()
    : new Promise((resolve) => waiters.set(count, resolve));
  type BrowserContents = EventEmitter & { loadURL: () => Promise<void>; isDestroyed: () => boolean; canGoBack: () => boolean; canGoForward: () => boolean; setWindowOpenHandler: () => void; close: () => void };
  const native: { contents: BrowserContents | null } = { contents: null };
  const browser = createEmbeddedBrowser(() => null, {
    createSession: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    }) as never,
    createView: () => {
      native.contents = Object.assign(new EventEmitter(), {
        loadURL: () => Promise.resolve(),
        isDestroyed: () => false,
        canGoBack: () => false,
        canGoForward: () => false,
        setWindowOpenHandler: () => undefined,
        close: () => undefined,
      });
      return { webContents: native.contents, setVisible: () => undefined, setBounds: () => undefined } as unknown as WebContentsView;
    },
    persist: (tabs, activeTabId) => new Promise<void>((resolve) => {
      const index = saves.length + 1;
      saves.push({ snapshot: { tabs, activeTabId }, resolve });
      waiters.get(index)?.();
      waiters.delete(index);
    }),
  }, [{ id: 'active', title: 'example.com', url: 'https://example.com/' }], 'active');

  browser.setBounds({ x: 400, y: 90, width: 420, height: 600 });
  await waitForSave(1);
  const flush = browser.flush();
  let flushSettled = false;
  void flush.then(() => { flushSettled = true; }, () => { flushSettled = true; });
  const contents = native.contents;
  if (!contents) throw new Error('Browser contents were not created');
  contents.emit('page-title-updated', {}, 'Latest title during flush');

  const firstSave = saves[0];
  assert.ok(firstSave);
  firstSave.resolve();
  await waitForSave(2);
  const secondSave = saves[1];
  assert.ok(secondSave);
  secondSave.resolve();
  await waitForSave(3);
  assert.equal(flushSettled, false, 'flush must still wait for the native title snapshot queued behind its first save');
  assert.equal(saves[2]?.snapshot.tabs[0]?.title, 'Latest title during flush');
  const latestSave = saves[2];
  assert.ok(latestSave);
  latestSave.resolve();
  await flush;
  assert.equal(browser.getStatus().tabs[0]?.title, 'Latest title during flush');
  browser.destroy();
});

test('browser metadata pause blocks native writes and popups, then resumes without waiting for storage', async () => {
  const saves: { tabs: { id: string; title: string; url: string }[]; activeTabId: string | null; resolve: () => void; reject: (error: Error) => void }[] = [];
  const waiters = new Map<number, () => void>();
  const waitForSave = (count: number): Promise<void> => saves.length >= count
    ? Promise.resolve()
    : new Promise((resolve) => waiters.set(count, resolve));
  let currentUrl = 'https://example.com/';
  let currentTitle = 'example.com';
  const native: { openHandler: ((details: { url: string }) => unknown) | null; contents: EventEmitter | null } = { openHandler: null, contents: null };
  const browser = createEmbeddedBrowser(() => null, {
    createSession: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    }) as never,
    createView: () => {
      const viewContents = Object.assign(new EventEmitter(), {
        loadURL: () => Promise.resolve(),
        isDestroyed: () => false,
        canGoBack: () => false,
        canGoForward: () => false,
        getURL: () => currentUrl,
        getTitle: () => currentTitle,
        setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => { native.openHandler = handler; },
        close: () => undefined,
      });
      native.contents = viewContents;
      return { webContents: viewContents, setVisible: () => undefined, setBounds: () => undefined } as unknown as WebContentsView;
    },
    persist: (tabs, activeTabId) => new Promise<void>((resolve, reject) => {
      const index = saves.length + 1;
      saves.push({ tabs, activeTabId, resolve, reject });
      waiters.get(index)?.();
      waiters.delete(index);
    }),
  }, [], null);
  let resolveError: (() => void) | null = null;
  const errorPublished = new Promise<void>((resolve) => { resolveError = resolve; });
  browser.onStatus((status) => { if (status.error) resolveError?.(); });

  browser.navigate('https://example.com/');
  await waitForSave(1);
  const initialSave = saves[0];
  assert.ok(initialSave);
  initialSave.resolve();
  const initialFlush = browser.flush();
  await waitForSave(2);
  const flushedSave = saves[1];
  assert.ok(flushedSave);
  flushedSave.resolve();
  await initialFlush;

  browser.pauseMetadata();
  currentUrl = 'https://updated.example/path';
  currentTitle = 'Updated title';
  const { contents, openHandler } = native;
  if (!contents || !openHandler) throw new Error('Native browser handlers were not registered');
  contents.emit('did-navigate', {}, currentUrl);
  contents.emit('page-title-updated', {}, currentTitle);
  const popup = openHandler({ url: 'https://popup.example/' }) as { action?: string };
  assert.equal(popup.action, 'deny');
  assert.equal(saves.length, 2, 'native metadata changes during close must not enqueue writes');
  assert.equal(browser.getStatus().tabs[0]?.title, 'example.com');

  const resumed = browser.resumeMetadata();
  assert.equal(resumed, undefined, 'returning to the app must not wait for browser storage');
  await waitForSave(3);
  assert.equal(saves[2]?.tabs[0]?.url, currentUrl);
  assert.equal(saves[2]?.tabs[0]?.title, currentTitle);
  const resumedSave = saves[2];
  assert.ok(resumedSave);
  resumedSave.reject(new Error('Storage remains unavailable'));
  await errorPublished;
  assert.equal(browser.getStatus().tabs.length, 1);
  assert.equal(browser.getStatus().tabs[0]?.url, currentUrl);
  assert.equal(browser.getStatus().error, 'Не удалось сохранить вкладки браузера.');
  browser.destroy();
});

test('browser bounds during close do not start an unloaded tab until metadata resumes', () => {
  let views = 0;
  let loads = 0;
  let saves = 0;
  const browser = createEmbeddedBrowser(() => null, {
    createSession: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    }) as never,
    createView: () => {
      views += 1;
      return { webContents: Object.assign(new EventEmitter(), {
        loadURL: () => { loads += 1; return Promise.resolve(); },
        isDestroyed: () => false,
        canGoBack: () => false,
        canGoForward: () => false,
        setWindowOpenHandler: () => undefined,
        close: () => undefined,
      }), setVisible: () => undefined, setBounds: () => undefined } as unknown as WebContentsView;
    },
    persist: () => { saves += 1; return Promise.resolve(); },
  }, [{ id: 'restored', title: 'example.com', url: 'https://example.com/' }], 'restored');

  browser.pauseMetadata();
  browser.setBounds({ x: 400, y: 90, width: 420, height: 600 });
  assert.deepEqual({ views, loads, saves }, { views: 0, loads: 0, saves: 0 });
  browser.resumeMetadata();
  browser.setBounds({ x: 400, y: 90, width: 420, height: 600 });
  assert.deepEqual({ views, loads }, { views: 1, loads: 1 });
  browser.destroy();
});
