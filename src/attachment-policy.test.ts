import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAttachmentPolicy, LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES } from './attachment-policy';

test('attachment policy separates documented API format from unknown model capability and disabled sending', () => {
  for (const name of ['notes.txt', 'report.doc', 'report.docx', 'report.pdf', 'book.epub', 'slides.ppt', 'slides.pptx', 'table.xlsx']) {
    const policy = evaluateAttachmentPolicy(name, 1024);
    assert.equal(policy.format, 'documented', name);
    assert.deepEqual(policy.documentedDocumentLimit, { amount: 40, unit: 'MB', unitIsAmbiguous: true });
    assert.equal(policy.modelCapability, 'unknown');
    assert.equal(policy.sendAllowed, false);
    assert.equal(policy.localImportWithinLimit, true);
  }

  for (const name of ['instructions.md', 'archive.bin', 'without-extension']) {
    const policy = evaluateAttachmentPolicy(name, 1024);
    assert.equal(policy.format, 'unverified', name);
    assert.equal(policy.documentedDocumentLimit, null);
    assert.equal(policy.modelCapability, 'unknown');
    assert.equal(policy.sendAllowed, false);
  }
});

test('attachment policy keeps the existing 25 MiB local import boundary explicit', () => {
  assert.equal(evaluateAttachmentPolicy('notes.txt', LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES).localImportWithinLimit, true);
  assert.equal(evaluateAttachmentPolicy('notes.txt', LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES + 1).localImportWithinLimit, false);
  assert.equal(evaluateAttachmentPolicy('notes.txt', Number.NaN).localImportWithinLimit, false);
});
