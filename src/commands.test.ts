import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeComposerSuggestion, getComposerCompletion, isUnavailableCompactCommand } from './commands';

test('suggests the unavailable compact command without enabling it', () => {
  const completion = getComposerCompletion('/comp');
  assert.equal(completion?.kind, 'command');
  const suggestion = completion?.items[0];
  assert.ok(suggestion);
  assert.equal(suggestion.label, '/compact');
  assert.equal(suggestion.available, false);
  assert.match(suggestion.description, /проверки качества сводки/);
  assert.equal(isUnavailableCompactCommand('  /COMPACT  '), true);
  assert.equal(isUnavailableCompactCommand('/compact now'), true);
  assert.throws(() => completeComposerSuggestion('/comp', 5, suggestion));
});

test('offers only enabled installed skills and stores selection separately from message text', () => {
  const skills = [
    { id: 'review', name: 'Review', enabled: true },
    { id: 'draft', name: 'Draft', enabled: false },
  ];
  const completion = getComposerCompletion('Проверь $rev', 12, skills);
  assert.deepEqual(completion?.items.map((item) => item.label), ['$Review']);
  const suggestion = completion?.items[0];
  assert.ok(suggestion);
  const inserted = completeComposerSuggestion('Проверь $rev', 12, suggestion);
  assert.deepEqual(inserted, { value: 'Проверь ', caret: 8 });
  const repeated = '$review раньше, потом $rev';
  assert.deepEqual(completeComposerSuggestion(repeated, repeated.length, suggestion), {
    value: '$review раньше, потом ', caret: '$review раньше, потом '.length,
  });
  const caretInside = '$review раньше, потом $review';
  const insideCaret = '$review раньше, потом $rev'.length;
  assert.deepEqual(completeComposerSuggestion(caretInside, insideCaret, suggestion), {
    value: '$review раньше, потом ', caret: '$review раньше, потом '.length,
  });
});

test('keeps ordinary text out of command suggestions and explains an empty skill registry', () => {
  assert.equal(getComposerCompletion('обычный текст'), null);
  const completion = getComposerCompletion('$');
  assert.deepEqual(completion?.items, []);
  assert.equal(completion?.emptyMessage, 'Локальные Skills пока не обнаружены.');
  assert.equal(isUnavailableCompactCommand('покажи /compact'), false);
});

test('shows Global Skills and only the selected project scope in autocomplete', () => {
  const skills = [
    { id: 'global/review', name: 'Review', command: 'review', enabled: true, scope: 'global' as const, projectId: null, scopeLabel: 'Global' },
    { id: 'project/one/review', name: 'Review', command: 'review', enabled: true, scope: 'project' as const, projectId: 'one', scopeLabel: 'Project One' },
    { id: 'project/two/review', name: 'Review', command: 'review', enabled: true, scope: 'project' as const, projectId: 'two', scopeLabel: 'Project Two' },
  ];
  const completion = getComposerCompletion('$rev', 4, skills, 'one');
  assert.deepEqual(completion?.items.map(({ skillId }) => skillId), ['global/review', 'project/one/review']);
  assert.equal(completion?.items[1]?.insertText, '$review');
});
