import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextLiteOperationalProfileView, ContextPreviewRequest, ContextPreviewView, ContextPromptEstimate, ContextWorkingBudgetView } from '../contracts';
import ContextRing from './ContextRing';
import { createContextPreviewController, getContextIndicatorPresentation } from './ContextIndicator';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';

type FixtureOptions = {
  promptStatus?: ContextPromptEstimate['status'];
  promptProvenance?: ContextPromptEstimate['provenance'];
  promptUnknownReasons?: ContextPromptEstimate['unknownReasons'];
  budgetStatus?: ContextWorkingBudgetView['status'];
  budgetProvenance?: ContextWorkingBudgetView['provenance'];
  calibrationDomainStatus?: ContextLiteOperationalProfileView['calibrationDomainStatus'];
};

function preview(tokens: number | null, budgetTokens: number | null = 100, options: FixtureOptions = {}): ContextPreviewView {
  return {
    modelId: 'GigaChat-3-Lightning',
    contextLimit: { tokens: null, provenance: 'unknown', source: null, verifiedAt: null },
    estimatedTokens: tokens,
    tokenEstimateProvenance: tokens === null ? 'unknown' : 'estimated',
    tokenEstimateScope: tokens === null ? null : 'text-blocks',
    promptEstimate: {
      status: options.promptStatus ?? 'complete',
      tokens,
      knownTokens: tokens,
      provenance: options.promptProvenance ?? (tokens === null ? 'unknown' : 'estimated'),
      wireMessageCount: 1,
      functionCallCount: 0,
      unknownReasons: options.promptUnknownReasons ?? [],
    },
    workingBudget: {
      status: options.budgetStatus ?? 'available',
      budgetTokens,
      provenance: options.budgetProvenance ?? (budgetTokens === null ? 'unknown' : 'estimated'),
      compactionStatus: 'available',
      compactionOverheadTokens: 0,
      operationalProfile: options.calibrationDomainStatus
        ? { calibrationDomainStatus: options.calibrationDomainStatus } as ContextLiteOperationalProfileView
        : null,
    },
    preparationWireBytes: null,
    maximumWireBytes: 100_000,
    preparationWireBytesIncludeAttachments: false,
    blocks: [],
    pendingAttachments: { count: 0, sizeBytes: 0 },
    historicalAttachments: { count: 0, sizeBytes: null },
    unknownReasons: [],
  };
}

function request(visibleText: string): ContextPreviewRequest {
  return { source: 'home', visibleText };
}

function wait(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

type MockElement = { type: unknown; props: { [key: string]: unknown; children?: unknown } };

function mountedContextIndicator() {
  type StateHook = { kind: 'state'; value: unknown };
  type RefHook = { kind: 'ref'; value: { current: unknown } };
  type EffectHook = { kind: 'effect'; dependencies: unknown[]; cleanup?: () => void };
  type Hook = StateHook | RefHook | EffectHook;
  type EffectWork = { index: number; effect: () => void | (() => void); previous?: EffectHook; dependencies: unknown[] };

  const hooks: Hook[] = [];
  const pendingEffects: EffectWork[] = [];
  const calls: Array<{ request: ContextPreviewRequest; pending: ReturnType<typeof deferred<ContextPreviewView>> }> = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let cursor = 0;
  let stateRevision = 0;
  let unmounted = false;
  let stateUpdatesAfterUnmount = 0;
  let props: { request: ContextPreviewRequest | null; scopeKey: object; unavailableReason?: string } = { request: null, scopeKey: {} };

  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      const state = hooks[index] as StateHook;
      return [state.value, (next: unknown) => {
        if (unmounted) {
          stateUpdatesAfterUnmount += 1;
          return;
        }
        state.value = typeof next === 'function' ? (next as (current: unknown) => unknown)(state.value) : next;
        stateRevision += 1;
      }] as const;
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { kind: 'ref', value: { current: initial } };
      return (hooks[index] as RefHook).value;
    },
    useLayoutEffect(effect: () => void | (() => void), dependencies: unknown[]) {
      const index = cursor++;
      const previous = hooks[index] as EffectHook | undefined;
      if (!previous || dependencies.length !== previous.dependencies.length
        || dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies[dependencyIndex]))) {
        pendingEffects.push({ index, effect, previous, dependencies: [...dependencies] });
      }
    },
  };
  const contextRing = (ringProps: unknown) => ({ type: 'ContextRing', props: ringProps });
  const jsx = (type: unknown, elementProps: MockElement['props']) => type === contextRing
    ? contextRing(elementProps)
    : ({ type, props: elementProps });
  const sandbox = {
    exports: {} as { default: (componentProps: typeof props) => unknown },
    require: (name: string) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './ContextRing') return { __esModule: true, default: contextRing };
      throw new Error(`Unexpected import: ${name}`);
    },
    window: { gigaChat: { context: { preview: (input: ContextPreviewRequest) => {
      const pending = deferred<ContextPreviewView>();
      calls.push({ request: input, pending });
      return pending.promise;
    } } } },
    setTimeout(callback: () => void) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    Promise,
  };
  const source = readFileSync(join(__dirname, 'ContextIndicator.tsx'), 'utf8');
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, sandbox);

  function render(nextProps?: typeof props): unknown {
    if (nextProps) props = nextProps;
    let tree: unknown;
    for (let pass = 0; pass < 5; pass += 1) {
      const revisionBeforeRender = stateRevision;
      cursor = 0;
      pendingEffects.length = 0;
      tree = sandbox.exports.default(props);
      for (const work of pendingEffects.splice(0)) {
        work.previous?.cleanup?.();
        const cleanup = work.effect();
        hooks[work.index] = {
          kind: 'effect',
          dependencies: work.dependencies,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      }
      if (stateRevision === revisionBeforeRender) return tree;
    }
    throw new Error('Mock React layout effects did not settle after five renders');
  }

  return {
    calls,
    render,
    fireDebounce() {
      const next = timers.entries().next().value;
      assert.ok(next, 'a debounce timer is scheduled');
      const [id, callback] = next;
      timers.delete(id);
      callback();
    },
    unmount() {
      unmounted = true;
      for (const hook of hooks) if (hook.kind === 'effect') hook.cleanup?.();
    },
    stateUpdatesAfterUnmount: () => stateUpdatesAfterUnmount,
  };
}

function findTreeElement(tree: unknown, predicate: (element: MockElement) => boolean): MockElement {
  if (tree && typeof tree === 'object') {
    const element = tree as MockElement;
    if (predicate(element)) return element;
    for (const child of [element.props?.children].flat()) {
      try { return findTreeElement(child, predicate); } catch { /* continue through siblings */ }
    }
  }
  throw new Error('Expected component element was not rendered');
}

async function flushComponentAsyncWork(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

test('complete estimated prompt uses rounded percentage and keeps over-budget detail while the ring clamps', () => {
  const cases = [[0, 0], [99, 99], [100, 100], [130, 130]] as const;
  for (const [tokens, expectedPercent] of cases) {
    const result = getContextIndicatorPresentation(preview(tokens), false);
    assert.equal(result.percent, expectedPercent);
    assert.match(result.details, new RegExp(`${tokens.toLocaleString('ru-RU')} из 100 токенов`));
    assert.match(result.details, /рабочего бюджета/i);
    assert.match(result.details, /не подтверждённый размер окна модели/);
    const ring = renderToStaticMarkup(createElement(ContextRing, { percent: result.percent ?? undefined }));
    assert.match(ring, new RegExp(`stroke-dashoffset="${100 - Math.min(100, expectedPercent)}"`));
  }
  assert.match(getContextIndicatorPresentation(preview(130), false).details, /примерно 130%/);
  assert.match(getContextIndicatorPresentation(preview(130), false).details, /заполнено до 100%/);
  const compactRing = renderToStaticMarkup(createElement(ContextRing, { compact: true }));
  assert.match(compactRing, /context-ring-graphic is-compact/);
  assert.doesNotMatch(compactRing, /context-ring-fill/);
});

test('partial, malformed, unsupported, and exhausted inputs remain neutral without a subtotal', () => {
  const partial = preview(null, null, {
    promptStatus: 'partial', promptUnknownReasons: ['attachment-content'],
  });
  partial.promptEstimate.knownTokens = 52;
  assert.equal(getContextIndicatorPresentation(partial, false).percent, null);
  assert.doesNotMatch(getContextIndicatorPresentation(partial, false).details, /52/);

  for (const tokens of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, null]) {
    const invalid = preview(10);
    invalid.promptEstimate.tokens = tokens;
    assert.equal(getContextIndicatorPresentation(invalid, false).percent, null);
  }
  for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 0, null]) {
    const invalid = preview(10);
    invalid.workingBudget.budgetTokens = budget;
    assert.equal(getContextIndicatorPresentation(invalid, false).percent, null);
  }
  const malformedPrompt = preview(10);
  (malformedPrompt as unknown as { promptEstimate: unknown }).promptEstimate = { status: 'complete', tokens: 10, provenance: 'estimated' };
  assert.equal(getContextIndicatorPresentation(malformedPrompt, false).percent, null);
  const malformedBudget = preview(10);
  (malformedBudget as unknown as { workingBudget: unknown }).workingBudget = null;
  assert.equal(getContextIndicatorPresentation(malformedBudget, false).percent, null);

  const unsupported = preview(null, null, {
    promptStatus: 'unknown', promptUnknownReasons: ['unsupported-model'], budgetStatus: 'unknown',
  });
  assert.equal(getContextIndicatorPresentation(unsupported, false).percent, null);
  assert.match(getContextIndicatorPresentation(unsupported, false).details, /нет проверенного локального профиля/);

  const unknown = preview(null, null, { promptStatus: 'unknown', budgetStatus: 'unknown' });
  assert.equal(getContextIndicatorPresentation(unknown, false).percent, null);
  assert.equal(getContextIndicatorPresentation(preview(10, 100, { budgetProvenance: 'unknown' }), false).percent, null);

  const exhausted = preview(10, 0, { budgetStatus: 'exhausted' });
  assert.equal(getContextIndicatorPresentation(exhausted, false).percent, null);
  assert.match(getContextIndicatorPresentation(exhausted, false).details, /исчерпан/);
  assert.equal(getContextIndicatorPresentation(null, true).percent, null);
  assert.match(getContextIndicatorPresentation(null, true).details, /обновляется/);
});

test('extrapolated working budgets state the wider uncertainty plainly', () => {
  const result = getContextIndicatorPresentation(preview(45, 20, { calibrationDomainStatus: 'extrapolated' }), false);
  assert.equal(result.percent, 225);
  assert.match(result.details, /экстраполяцией/);
  assert.match(result.details, /неопределённость выше/);
  assert.match(result.details, /45 из 20 токенов/);
});

test('preview controller debounces, permits one request, and runs only the latest pending source', async () => {
  const calls: string[] = [];
  const requests: ReturnType<typeof deferred<ContextPreviewView>>[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const states: Array<{ view: ContextPreviewView | null; loading: boolean }> = [];
  const controller = createContextPreviewController((input) => {
    calls.push(input.visibleText);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const pending = deferred<ContextPreviewView>();
    requests.push(pending);
    return pending.promise.finally(() => { inFlight -= 1; });
  }, (state) => states.push(state), 15);

  controller.schedule(request('first'));
  await wait(5);
  assert.deepEqual(calls, [], 'preview waits for the debounce interval');
  controller.schedule(request('first-ready'));
  await wait(20);
  assert.deepEqual(calls, ['first-ready']);
  controller.schedule(request('middle'));
  controller.schedule(request('latest'));
  await wait(20);
  assert.deepEqual(calls, ['first-ready'], 'a burst while a preview is active keeps only one latest pending source');
  assert.equal(maxInFlight, 1);
  requests[0].resolve(preview(1));
  await wait();
  assert.ok(!states.some((state) => state.view?.promptEstimate.tokens === 1), 'old scope response is ignored');
  assert.ok(states.some((state) => state.view === null && state.loading), 'new source is neutral immediately while pending');
  assert.deepEqual(calls, ['first-ready', 'latest']);
  assert.equal(maxInFlight, 1);
  requests[1].resolve(preview(75));
  await wait();
  assert.equal(states[states.length - 1]?.view?.promptEstimate.tokens, 75);
  assert.equal(maxInFlight, 1);
  controller.close();
});

test('preview controller ignores work after close and retries on a later input after failure', async () => {
  const states: Array<{ view: ContextPreviewView | null; loading: boolean }> = [];
  let calls = 0;
  const active = deferred<ContextPreviewView>();
  const controller = createContextPreviewController(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('offline'));
    return active.promise;
  }, (state) => states.push(state), 0);

  controller.schedule(request('failure'));
  await wait();
  assert.deepEqual(states[states.length - 1], { view: null, loading: false });
  controller.schedule(request('retry'));
  await wait();
  assert.equal(calls, 2);
  controller.close();
  active.resolve(preview(30));
  await wait();
  assert.ok(!states.some((state) => state.view?.promptEstimate.tokens === 30), 'late response after close is ignored');

  controller.schedule(request('cancel-before-start'));
  controller.close();
  await wait();
  assert.equal(calls, 2, 'close clears a debounced request');
});

test('actual ContextIndicator clears stale draft estimates and ignores late responses after source change and unmount', async () => {
  const mounted = mountedContextIndicator();
  const ringPercent = (tree: unknown) => findTreeElement(tree, (element) => element.type === 'ContextRing').props.percent;

  let tree = mounted.render({ request: request('initial draft'), scopeKey: {} });
  assert.equal(ringPercent(tree), undefined);
  mounted.fireDebounce();
  await flushComponentAsyncWork();
  assert.equal(mounted.calls.length, 1);
  mounted.calls[0].pending.resolve(preview(70));
  await flushComponentAsyncWork();
  tree = mounted.render();
  assert.equal(ringPercent(tree), 70);

  tree = mounted.render({ request: request('old request in flight'), scopeKey: {} });
  assert.equal(ringPercent(tree), undefined, 'a changed visible draft clears the previous percentage in the same layout-effect render');
  mounted.fireDebounce();
  await flushComponentAsyncWork();
  assert.equal(mounted.calls[1].request.visibleText, 'old request in flight');

  tree = mounted.render({ request: request('latest draft'), scopeKey: {} });
  assert.equal(ringPercent(tree), undefined, 'the latest draft remains neutral while its preview is pending');
  mounted.calls[1].pending.resolve(preview(94));
  await flushComponentAsyncWork();
  tree = mounted.render();
  assert.equal(ringPercent(tree), undefined, 'a late response from the previous draft cannot restore its percentage');

  mounted.fireDebounce();
  await flushComponentAsyncWork();
  assert.equal(mounted.calls[2].request.visibleText, 'latest draft');
  mounted.calls[2].pending.resolve(preview(25));
  await flushComponentAsyncWork();
  tree = mounted.render();
  assert.equal(ringPercent(tree), 25, 'only the latest draft estimate is published');

  tree = mounted.render({ request: request('request pending at unmount'), scopeKey: {} });
  assert.equal(ringPercent(tree), undefined);
  mounted.fireDebounce();
  await flushComponentAsyncWork();
  assert.equal(mounted.calls[3].request.visibleText, 'request pending at unmount');
  mounted.unmount();
  mounted.calls[3].pending.resolve(preview(88));
  await flushComponentAsyncWork();
  assert.equal(mounted.stateUpdatesAfterUnmount(), 0, 'unmount cleanup prevents late component state publication');
});
