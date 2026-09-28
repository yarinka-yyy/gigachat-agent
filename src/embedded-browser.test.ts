import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow, WebContentsView } from 'electron';
import { createEmbeddedBrowser, isAllowedPageUrl, resolveBrowserAddress } from './embedded-browser';

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
