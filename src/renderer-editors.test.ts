import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import * as ts from 'typescript';
import { completeComposerSuggestion, getComposerCompletion } from './commands';
import { createRendererOperationTracker } from './renderer-operations';

// Execute current renderer handlers with deferred IPC, without an Electron window.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(path.join(__dirname, 'app.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (result) return;
    if (predicate(node)) result = node;
    else ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, 'Renderer handler must remain reachable');
  return result;
}
function functionText(name: string): string {
  return find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
function compile(text: string): string {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type ConfigRead = { contents: string; error: string | null };
function configHarness() {
  const pending = new Set<Promise<unknown>>();
  const operations = createRendererOperationTracker();
  const state = vm.createContext({
    configDraft: '', configSaved: '', configBusy: false, configLoading: false, configReady: false, configError: '',
    configEditRevision: { current: 0 },
    route: { page: 'settings' }, settingsSection: 'permissions',
    closeUiState: { current: { configDraft: '', configSaved: '', configBusy: false } },
    rendererOperations: { current: operations }, showSuccess() {}, getErrorMessage: (error: Error) => error.message,
    window: { gigaChat: { permissions: { readConfig: async (): Promise<ConfigRead> => ({ contents: 'disk', error: null }), saveConfig: async (draft: string) => draft } } },
    trackRendererOperation(operation: () => unknown) {
      const promise = operations.track(operation);
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => undefined);
      return promise;
    },
  });
  for (const key of ['configDraft', 'configSaved', 'configBusy', 'configLoading', 'configReady', 'configError']) {
    state[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value: unknown) => { state[key] = value; };
  }
  const effect = find((node) => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes("settingsSection !== 'permissions'")) as ts.CallExpression;
  const editor = find((node) => ts.isJsxSelfClosingElement(node) && node.getText(source).includes('aria-label="Редактор config.toml"')) as ts.JsxSelfClosingElement;
  const change = editor.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onChange') as ts.JsxAttribute;
  assert.ok(change.initializer && ts.isJsxExpression(change.initializer) && change.initializer.expression);
  let functions = functionText('saveCustomConfigOperation') + functionText('reloadCustomConfig');
  if (source.text.includes('function loadCustomConfig(')) functions += functionText('loadCustomConfig');
  vm.runInContext(compile(`${functions}\nglobalThis.enter = ${effect.arguments[0].getText(source)};\nglobalThis.edit = ${change.initializer.expression.getText(source)};`), state);
  return { state, enter: () => { state.enter(); }, edit: (value: string) => { state.edit({ target: { value } }); }, settle: async () => { while (pending.size) await Promise.allSettled([...pending]); } };
}

test('Permissions reentry preserves unsaved config and dirty close state', async () => {
  const h = configHarness(); h.enter(); await h.settle(); h.edit('unsaved rules'); h.enter(); await h.settle();
  assert.equal(h.state.configDraft, 'unsaved rules');
  assert.notEqual(h.state.closeUiState.current.configDraft, h.state.closeUiState.current.configSaved);
});
test('late initial config read cannot erase newer input or mark it clean', async () => {
  const h = configHarness(); const read = deferred<ConfigRead>();
  h.state.window.gigaChat.permissions.readConfig = () => read.promise;
  h.enter(); await Promise.resolve(); h.edit('newer than read');
  read.resolve({ contents: 'old disk', error: null }); await h.settle();
  assert.equal(h.state.configDraft, 'newer than read');
  assert.notEqual(h.state.closeUiState.current.configDraft, h.state.closeUiState.current.configSaved);
});
test('explicit Reload replaces accepted draft but preserves post-click input', async () => {
  const h = configHarness(); h.enter(); await h.settle(); h.edit('discard explicitly');
  await h.state.reloadCustomConfig(); assert.equal(h.state.configDraft, 'disk');
  const read = deferred<ConfigRead>(); h.state.window.gigaChat.permissions.readConfig = () => read.promise;
  const reload = h.state.reloadCustomConfig(); await Promise.resolve(); h.edit('typed after Reload');
  read.resolve({ contents: 'new disk', error: null }); await reload;
  assert.equal(h.state.configDraft, 'typed after Reload');
  assert.notEqual(h.state.closeUiState.current.configDraft, h.state.closeUiState.current.configSaved);
});
test('async Save records accepted snapshot while newer text remains dirty', async () => {
  const h = configHarness(); h.enter(); await h.settle(); h.edit('accepted save');
  const save = deferred<string>(); h.state.window.gigaChat.permissions.saveConfig = () => save.promise;
  const operation = h.state.saveCustomConfigOperation(); h.edit('newer edit'); save.resolve('accepted save'); await operation;
  assert.equal(h.state.configDraft, 'newer edit'); assert.equal(h.state.configSaved, 'accepted save');
  assert.notEqual(h.state.closeUiState.current.configDraft, h.state.closeUiState.current.configSaved);
});
test('Reload and Save cannot race to mark an older disk version clean', async () => {
  const h = configHarness(); h.enter(); await h.settle(); h.edit('save me');
  const save = deferred<string>(); h.state.window.gigaChat.permissions.saveConfig = () => save.promise;
  const operation = h.state.saveCustomConfigOperation(); await h.state.reloadCustomConfig();
  assert.equal(h.state.configDraft, 'save me'); save.resolve('save me'); await operation;
  assert.equal(h.state.closeUiState.current.configDraft, 'save me'); assert.equal(h.state.configSaved, 'save me');
});
test('failed initial read keeps Save unavailable and permits a successful retry', async () => {
  const h = configHarness(); h.state.window.gigaChat.permissions.readConfig = async () => { throw new Error('Read failed'); };
  h.enter(); await h.settle();
  assert.equal(h.state.configReady, false); assert.equal(h.state.configLoading, false);
  assert.equal(h.state.closeUiState.current.configBusy, false); assert.equal(h.state.configError, 'Read failed');
  let saves = 0; h.state.window.gigaChat.permissions.saveConfig = async () => { saves += 1; return ''; };
  await h.state.saveCustomConfigOperation(); assert.equal(saves, 0);
  h.state.window.gigaChat.permissions.readConfig = async () => ({ contents: 'retry disk', error: null });
  await h.state.reloadCustomConfig(); assert.equal(h.state.configReady, true); assert.equal(h.state.configDraft, 'retry disk');
});
test('Save conflict preserves dirty text and releases the operation guard', async () => {
  const h = configHarness(); h.enter(); await h.settle(); h.edit('unsaved rules');
  h.state.window.gigaChat.permissions.saveConfig = async () => { throw new Error('Config changed on disk'); };
  await h.state.saveCustomConfigOperation();
  assert.equal(h.state.configDraft, 'unsaved rules'); assert.equal(h.state.configSaved, 'disk');
  assert.equal(h.state.closeUiState.current.configBusy, false); assert.equal(h.state.configError, 'Config changed on disk');
});
test('IME keeps Enter/arrows/Escape available; ordinary Skill Enter still works', () => {
  for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
    let prevented = false; let changed = false;
    const context = vm.createContext({ completionDismissed: false, draft: '$テ', composerSkills: [{ id: 'global/test', name: 'テスト', enabled: true, scope: 'global' }], composerProjectId: null, completionIndex: 0,
      getComposerCompletion, setCompletionDismissed() { changed = true; }, setCompletionIndex() { changed = true; }, insertComposerSuggestion() { changed = true; }, submitMessage() { changed = true; } });
    vm.runInContext(compile(functionText('handleComposerKeyDown')), context);
    context.handleComposerKeyDown({ key, shiftKey: false, currentTarget: { selectionStart: 2 }, nativeEvent: { isComposing: true }, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, key); assert.equal(changed, false, key);
  }
  let selection = ''; let draft = '$テ';
  const context = vm.createContext({ completionDismissed: false, draft, composerSkills: [{ id: 'global/test', name: 'テスト', enabled: true, scope: 'global' }], composerProjectId: null, completionIndex: 0,
    getComposerCompletion, insertComposerSuggestion(suggestion: Parameters<typeof completeComposerSuggestion>[2], caret: number) { selection = suggestion.skillId ?? ''; draft = completeComposerSuggestion(draft, caret, suggestion).value; } });
  vm.runInContext(compile(functionText('handleComposerKeyDown')), context);
  context.handleComposerKeyDown({ key: 'Enter', shiftKey: false, currentTarget: { selectionStart: 2 }, nativeEvent: { isComposing: false }, preventDefault() {} });
  assert.equal(selection, 'global/test'); assert.equal(draft, '');
});
