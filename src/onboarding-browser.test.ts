import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow, WebContentsView } from 'electron';
import { clampBrowserBounds, createOnboardingBrowser, getOnboardingPopupTitle, isAllowedOnboardingUrl, isStudioLandingUrl } from './onboarding-browser';

function pendingStudioFixture() {
  let rejectLoad: (error: Error) => void = () => { throw new Error('load did not start'); };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, canGoBack: () => false, setWindowOpenHandler: () => undefined, close: () => undefined,
    loadURL: () => {
      contents.emit('did-start-loading');
      return new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    },
    reload: () => {
      contents.emit('did-start-loading');
      rejectLoad(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 }));
    },
  });
  const browser = createOnboardingBrowser(() => ({
    isDestroyed: () => false, contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  }) as unknown as BrowserWindow, {
    createSession: () => Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined,
      webRequest: { onBeforeRequest: () => undefined },
      clearStorageData: async () => undefined, clearCache: async () => undefined, clearAuthCache: async () => undefined,
    }) as never,
    createView: () => ({ webContents: contents, setVisible: () => undefined, setBounds: () => undefined }) as unknown as WebContentsView,
  });
  return { browser, contents, reject: (error: Error) => rejectLoad(error) };
}

test('successful Studio reload does not retain the aborted initial load error', async () => {
  const { browser, contents } = pendingStudioFixture();
  const opening = browser.openStudio();
  browser.reload();
  await opening;
  assert.equal(browser.getStatus().loading, true, 'old promise must not stop the replacement load');
  contents.emit('did-navigate', {}, 'https://developers.sber.ru/studio/');
  contents.emit('did-stop-loading');
  assert.equal(browser.getStatus().atStudio, true);
  assert.equal(browser.getStatus().error, null);
  await browser.close();
});

test('closed Studio load cannot republish an error, while current genuine failures remain visible', async () => {
  const { browser, reject } = pendingStudioFixture();
  const opening = browser.openStudio();
  await browser.close();
  reject(new Error('connection failed after close'));
  await opening;
  assert.equal(browser.getStatus().open, false);
  assert.equal(browser.getStatus().error, null);
  const current = browser.openStudio();
  reject(new Error('current connection failed'));
  await current;
  assert.match(browser.getStatus().error ?? '', /Страница не загрузилась/);
  await browser.close();
});

test('onboarding browser accepts only HTTPS URLs without embedded credentials', () => {
  assert.equal(isAllowedOnboardingUrl('https://developers.sber.ru/studio/'), true);
  assert.equal(isAllowedOnboardingUrl('https://login.example.test/continue'), true);
  assert.equal(isAllowedOnboardingUrl('http://developers.sber.ru/'), false);
  assert.equal(isAllowedOnboardingUrl('file:///C:/private.txt'), false);
  assert.equal(isAllowedOnboardingUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedOnboardingUrl('https://user:password@example.test/'), false);
  assert.equal(isAllowedOnboardingUrl('not a url'), false);
});

test('popup title exposes only the current HTTPS host, not page-controlled title or URL details', () => {
  const title = getOnboardingPopupTitle('https://login.example.test/path?code=synthetic#fragment');
  assert.equal(title, 'Страница входа · login.example.test');
  assert.equal(title.includes('synthetic'), false);
});

test('Studio return control recognizes only the official landing origin and path', () => {
  assert.equal(isStudioLandingUrl('https://developers.sber.ru/studio/'), true);
  assert.equal(isStudioLandingUrl('https://developers.sber.ru/studio/?state=synthetic'), true);
  assert.equal(isStudioLandingUrl('https://developers.sber.ru/docs/'), false);
  assert.equal(isStudioLandingUrl('https://developers.example.test/studio/'), false);
});

test('in-page navigation updates Studio status and keeps the return control usable', async () => {
  let currentUrl = '';
  let loadCount = 0;
  let viewCount = 0;
  let sessionCount = 0;
  let visible = false;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    canGoBack: () => false,
    getURL: () => currentUrl,
    setWindowOpenHandler: () => undefined,
    loadURL: async (url: string) => {
      currentUrl = url;
      loadCount += 1;
      contents.emit('did-start-loading');
      contents.emit('did-navigate', {}, url);
      contents.emit('did-stop-loading');
    },
    close: () => undefined,
  });
  const view = {
    webContents: contents,
    setVisible: (value: boolean) => { visible = value; },
    setBounds: () => undefined,
  } as unknown as WebContentsView;
  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    webRequest: { onBeforeRequest: () => undefined },
  });
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
    getContentBounds: () => ({ x: 0, y: 0, width: 960, height: 720 }),
    webContents: { getZoomFactor: () => 1 },
  } as unknown as BrowserWindow;
  const browser = createOnboardingBrowser(() => window, {
    createSession: () => { sessionCount += 1; return session as never; },
    createView: () => { viewCount += 1; return view; },
  });

  await browser.openStudio();
  assert.equal(browser.getStatus().atStudio, true);
  contents.emit('did-navigate-in-page', {}, 'https://developers.sber.ru/studio/register', false);
  assert.equal(browser.getStatus().atStudio, true);
  contents.emit('did-navigate-in-page', {}, 'https://developers.sber.ru/studio/register', true);
  assert.equal(browser.getStatus().atStudio, false);

  const returned = await browser.openStudio();
  assert.equal(returned.atStudio, true);
  assert.equal(loadCount, 2);

  const retainedUrl = currentUrl;
  browser.setBounds({ x: 100, y: 50, width: 600, height: 500 });
  assert.equal(visible, true);
  browser.setBounds(null);
  assert.equal(visible, false);
  assert.equal(browser.getStatus().open, true);
  assert.equal(currentUrl, retainedUrl);
  browser.setBounds({ x: 100, y: 50, width: 600, height: 500 });
  assert.equal(visible, true);
  assert.equal(currentUrl, retainedUrl);
  assert.equal(loadCount, 2);
  assert.equal(viewCount, 1);
  assert.equal(sessionCount, 1);
});

test('onboarding browser bounds are zoomed and clipped to the app content area', () => {
  assert.deepEqual(
    clampBrowserBounds({ x: 100, y: 50, width: 600, height: 500 }, 800, 600, 0.8),
    { x: 80, y: 40, width: 480, height: 400 },
  );
  assert.deepEqual(
    clampBrowserBounds({ x: 900, y: 700, width: 200, height: 200 }, 800, 600, 1),
    null,
  );
  assert.equal(clampBrowserBounds({ x: Number.NaN, y: 0, width: 20, height: 20 }, 800, 600, 1), null);
});
