import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectAttachmentFile, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from '../packages/ui/src/attachmentPolicy.ts';
import { buildTimelineLayout } from '../packages/ui/src/timeline.ts';
import { translate } from '../packages/ui/src/i18n.ts';

test('timeline keeps tools between the messages that produced them', () => {
  const messages = [
    { id: 'user', order: 1, role: 'user', text: 'read a file', status: 'done' },
    { id: 'assistant', order: 5, role: 'assistant', text: 'done', status: 'done' },
  ];
  const activities = [
    { id: 'read', order: 2, tool: 'read', title: 'a.txt', status: 'done' },
    { id: 'grep', order: 3, tool: 'grep', title: 'search', status: 'interrupted' },
  ];
  assert.deepEqual(buildTimelineLayout(messages, activities), [
    { kind: 'message', id: 'user', order: 1, index: 0 },
    { kind: 'tools', id: 'read', order: 2, indices: [0, 1] },
    { kind: 'message', id: 'assistant', order: 5, index: 1 },
  ]);
  assert.equal(translate('chat.tool.interrupted', undefined, 'zh-CN'), '已中断');
  assert.equal(translate('chat.tool.interrupted', undefined, 'en-US'), 'Interrupted');
});

test('attachment policy matches Pi fallback limits and rejects empty images', () => {
  assert.equal(MAX_ATTACHMENTS, 12);
  assert.equal(MAX_TEXT_BYTES, 200_000);
  assert.deepEqual(inspectAttachmentFile({ name: 'empty.png', type: 'image/png', size: 0 }), { errorKey: 'composer.imageEmpty' });
  assert.deepEqual(inspectAttachmentFile({ name: 'picture.webp', type: 'image/webp', size: MAX_IMAGE_BYTES }), { kind: 'image', mimeType: 'image/webp' });
  assert.deepEqual(inspectAttachmentFile({ name: 'picture.webp', type: 'image/webp', size: MAX_IMAGE_BYTES + 1 }), { errorKey: 'composer.imageSize' });
  assert.deepEqual(inspectAttachmentFile({ name: 'notes.md', type: '', size: MAX_TEXT_BYTES }), { kind: 'text', mimeType: 'text/plain' });
  assert.deepEqual(inspectAttachmentFile({ name: 'notes.md', type: '', size: MAX_TEXT_BYTES + 1 }), { errorKey: 'composer.textSize' });
  assert.deepEqual(inspectAttachmentFile({ name: 'old.gif', type: 'image/gif', size: 100 }), { errorKey: 'composer.imageTypes' });
});
