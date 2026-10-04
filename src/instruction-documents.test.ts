import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstructionDocument, instructionFileHash } from './instruction-documents';

test('instruction revisions distinguish missing from an empty file', () => {
  const missing = createInstructionDocument('C:\\profile\\GIGACHAT.md', null);
  const empty = createInstructionDocument('C:\\profile\\GIGACHAT.md', '');

  assert.equal(missing.text, '');
  assert.equal(empty.text, '');
  assert.notEqual(missing.revision, empty.revision);
  assert.equal(instructionFileHash(null), null);
  assert.notEqual(instructionFileHash(''), null);
});

test('instruction revisions are bound to their target file', () => {
  const first = createInstructionDocument('C:\\profile\\project-a\\AGENTS.md', 'rules');
  const second = createInstructionDocument('C:\\profile\\project-b\\AGENTS.md', 'rules');

  assert.notEqual(first.revision, second.revision);
});
