import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IMAGE_GENERATION_MODEL_ID,
  imageChatAttachmentBlocker,
  imageChatHistoryBlocker,
  imageChatModelBlocker,
  imageChatPromptBlocker,
  imageChatRequestBlocker,
} from './image-mode';

test('image mode requires Ultra, a nonempty description, and no selected files', () => {
  assert.equal(IMAGE_GENERATION_MODEL_ID, 'GigaChat-3-Ultra');
  assert.equal(imageChatRequestBlocker('image', IMAGE_GENERATION_MODEL_ID, '  Нарисуй маяк  ', 0), null);
  assert.match(imageChatModelBlocker('image', 'GigaChat-3-Pro') ?? '', /GigaChat Ultra/);
  assert.match(imageChatRequestBlocker('image', null, 'Нарисуй маяк', 0) ?? '', /GigaChat Ultra/,
    'a missing image-chat model has explicit upgrade guidance');
  assert.match(imageChatPromptBlocker('image', ' \n') ?? '', /описание/);
  assert.match(imageChatAttachmentBlocker('image', 1) ?? '', /текстовое описание/);
});

test('image guards leave ordinary text chats unchanged', () => {
  assert.equal(imageChatRequestBlocker('text', 'GigaChat-3-Pro', '   ', 4), null);
  assert.equal(imageChatModelBlocker('text', null), null);
  assert.equal(imageChatAttachmentBlocker('text', 2), null);
  assert.equal(imageChatPromptBlocker('text', ''), null);
  assert.equal(imageChatHistoryBlocker('text', [{ id: 'user-file', role: 'user', text: 'see file', createdAt: '', attachmentIds: ['file'] }]), null);
});

test('only historical user attachments require a new image chat', () => {
  assert.match(imageChatHistoryBlocker('image', [
    { id: 'user-file', role: 'user', text: 'see file', createdAt: '', attachmentIds: ['file'] },
  ]) ?? '', /Создайте новый чат/);
  assert.equal(imageChatHistoryBlocker('image', [
    { id: 'assistant-image', role: 'assistant', text: '', createdAt: '', source: 'runtime', attachmentIds: ['generated'] },
  ]), null);
});
