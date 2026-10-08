import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

test('packaged sidebar QA accepts reduced-motion endpoint and observes normal animation', async () => {
  const text = readFileSync(join(__dirname, '../scripts/verify-packaged-audit.mjs'), 'utf8');
  const source = ts.createSourceFile('qa.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let predicate: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'waitUntil'
      && node.arguments[0]?.getText(source) === "'sidebar divider begins collapsing'") {
      const callback = node.arguments[1];
      if (ts.isArrowFunction(callback)) predicate = callback;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(predicate, 'exercise the actual packaged QA predicate');
  const evaluate = new Function('evaluate', 'initialSidebarToggle', `const sidebarToggleSelector = 'button'; return ${predicate.getText(source)};`) as
    (read: () => Promise<string>, state: { reducedMotion: boolean }) => () => Promise<boolean>;
  const observed = (frame: number, reducedMotion: boolean) =>
    evaluate(async () => JSON.stringify(frame), { reducedMotion })();
  assert.equal(await observed(-5, true), true);
  assert.equal(await observed(-4.95, true), true);
  assert.equal(await observed(-1, true), false);
  assert.equal(await observed(0, true), false);
  assert.equal(await observed(-1, false), true);
  assert.equal(await observed(0, false), false);
});
