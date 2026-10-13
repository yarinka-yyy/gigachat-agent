import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentConnectionBlocker, attachmentSendBlocker, evaluateAttachmentPolicy, inspectLocalAttachmentContent, LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES } from './attachment-policy';

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

test('checks file signatures and text encoding without treating an extension as proof of content', () => {
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(inspectLocalAttachmentContent('image.png', tinyPng), { kind: 'image', contentType: 'image/png' });
  assert.deepEqual(inspectLocalAttachmentContent('photo.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), { kind: 'image', contentType: 'image/jpeg' });
  assert.deepEqual(inspectLocalAttachmentContent('report.pdf', Buffer.from('%PDF-1.7\n')), { kind: 'document', contentType: 'application/pdf' });
  assert.deepEqual(inspectLocalAttachmentContent('notes.md', Buffer.from('plain UTF-8 text\n')), { kind: 'document', contentType: 'text/plain' });
  assert.equal(inspectLocalAttachmentContent('unsupported.xlsx', Buffer.from('not sent yet')), null);
  assert.throws(() => inspectLocalAttachmentContent('renamed.exe.png', Buffer.from('MZ\0binary')),
    /PNG.*проверку содержимого/i);
  assert.throws(() => inspectLocalAttachmentContent('misnamed.txt', Uint8Array.from([0xff, 0xfe, 0xfd])), /UTF-8/i);
});

test('main send gate requires per-model evidence and keeps unsupported attachments staged', () => {
  const hash = 'a'.repeat(64);
  const file = (name: string, size = 10) => ({ name, size, sha256: hash });
  assert.equal(attachmentSendBlocker('GigaChat-2-Max', 'Прочитай', [file('notes.txt')]), null);
  assert.match(attachmentSendBlocker('GigaChat-2-Max', 'Прочитай', [file('report.pdf')]) ?? '', /ещё не прошёл проверку/i);
  assert.match(attachmentSendBlocker('GigaChat-3-Lightning', 'Опиши', [file('image.png')]) ?? '', /не поддерживает/i);
  assert.equal(attachmentSendBlocker('GigaChat-3-Ultra', 'Прочитай', [file('notes.md')]), null,
    'Ultra has an independent real Markdown text/plain proof');
  assert.equal(attachmentSendBlocker('GigaChat-3-Ultra', 'Опиши', [file('photo.jpeg')]), null,
    'Ultra has an independent real JPEG proof');
  assert.match(attachmentSendBlocker('GigaChat-2-Max', 'Прочитай', [file('notes.md')]) ?? '', /ещё не прошёл проверку/i);
  assert.match(attachmentSendBlocker('GigaChat-2-Max', 'Опиши', [file('photo.jpeg')]) ?? '', /ещё не прошёл проверку/i);
  assert.match(attachmentSendBlocker(null, 'Прочитай', [file('notes.txt')]) ?? '', /выберите модель/i);
});

test('empty files remain staged instead of being accepted before upload rejects them', () => {
  const empty = { name: 'empty.txt', size: 0, sha256: 'c'.repeat(64) };
  assert.match(attachmentSendBlocker('GigaChat-2-Max', '', [empty]) ?? '', /пуст/i);
});

test('attachment acceptance requires a live connection and the selected model to remain available', () => {
  const registry = { state: 'ready' as const, modelIds: ['GigaChat-2-Max'], errorCategory: null };
  assert.equal(attachmentConnectionBlocker({ state: 'connected' }, registry, 'GigaChat-2-Max'), null);
  assert.match(attachmentConnectionBlocker({ state: 'error' }, registry, 'GigaChat-2-Max') ?? '', /Подключите GigaChat/i);
  assert.match(attachmentConnectionBlocker({ state: 'connected' }, { ...registry, exhaustedModelIds: ['GigaChat-2-Max'] }, 'GigaChat-2-Max') ?? '', /исчерпан/i);
  assert.match(attachmentConnectionBlocker({ state: 'connected' }, registry, 'GigaChat-3-Pro') ?? '', /отсутствует/i);
});

test('main send gate enforces image count and conservative media bytes while document bytes use their own bounds', () => {
  const hash = 'b'.repeat(64);
  const image = (index: number, size = 1) => ({ name: `image-${index}.png`, size, sha256: hash });
  assert.match(attachmentSendBlocker('GigaChat-3-Ultra', '', Array.from({ length: 11 }, (_, index) => image(index))) ?? '', /не более 10 изображений/i);
  assert.match(attachmentSendBlocker('GigaChat-3-Ultra', '', [image(1, 15_000_001)]) ?? '', /15 МБ/i);
  assert.equal(attachmentSendBlocker('GigaChat-3-Ultra', '', Array.from({ length: 5 }, (_, index) => image(index, 15_000_000))), null);
  assert.match(attachmentSendBlocker('GigaChat-3-Ultra', '', Array.from({ length: 6 }, (_, index) => image(index, 13_000_000))) ?? '', /общий лимит/i);
  const documents = Array.from({ length: 4 }, (_, index) => ({
    name: `document-${index}.txt`, size: LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES, sha256: hash,
  }));
  assert.equal(attachmentSendBlocker('GigaChat-3-Ultra', '', documents), null, 'document bytes do not count toward the image media limit');
});
