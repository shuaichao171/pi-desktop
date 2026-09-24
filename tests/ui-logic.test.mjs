import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectAttachmentFile, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from '../packages/ui/src/attachmentPolicy.ts';
import { buildTimelineLayout } from '../packages/ui/src/timeline.ts';
import { translate } from '../packages/ui/src/i18n.ts';
import { appendFileAttachments, clearSubmittedDraft } from '../packages/ui/src/composerDrafts.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const attachment = (name) => ({ kind: 'text', name, mimeType: 'text/plain', text: name });
const limitError = () => new Error('too many attachments');

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

test('concurrent file drops retain both attachments even when reads finish out of order', async () => {
  let attachments = [];
  const firstFile = deferred();
  const secondFile = deferred();
  const get = () => attachments;
  const set = (next) => { attachments = next; };
  const firstDrop = appendFileAttachments([{ name: 'first.txt' }], () => firstFile.promise, get, set, limitError);
  const secondDrop = appendFileAttachments([{ name: 'second.txt' }], () => secondFile.promise, get, set, limitError);
  secondFile.resolve(attachment('second.txt'));
  await secondDrop;
  firstFile.resolve(attachment('first.txt'));
  await firstDrop;
  assert.deepEqual(attachments.map(({ name }) => name), ['second.txt', 'first.txt']);
});

test('pending file reads preserve removals and recheck the shared attachment limit', async () => {
  let attachments = [attachment('removed.txt')];
  const pendingFile = deferred();
  const read = appendFileAttachments([{ name: 'new.txt' }], () => pendingFile.promise,
    () => attachments, (next) => { attachments = next; }, limitError);
  attachments = [];
  pendingFile.resolve(attachment('new.txt'));
  await read;
  assert.deepEqual(attachments.map(({ name }) => name), ['new.txt']);

  const lastFile = deferred();
  const lastRead = appendFileAttachments([{ name: 'overflow.txt' }], () => lastFile.promise,
    () => attachments, (next) => { attachments = next; }, limitError);
  attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => attachment(`${index}.txt`));
  lastFile.resolve(attachment('overflow.txt'));
  await assert.rejects(lastRead, /too many attachments/);
  assert.equal(attachments.length, MAX_ATTACHMENTS);
});

test('send completion clears only the unchanged submitted draft after switching sessions', () => {
  const sent = { text: 'original message', attachments: [attachment('sent.txt')] };
  const edited = { text: 'new draft typed while sending', attachments: sent.attachments };
  const other = { text: 'another conversation', attachments: [] };
  const drafts = new Map([['first-session', edited], ['other-session', other]]);
  assert.equal(clearSubmittedDraft(drafts, 'first-session', sent), false);
  assert.equal(drafts.get('first-session'), edited);
  assert.equal(drafts.get('other-session'), other);

  drafts.set('first-session', { ...sent, attachments: [...sent.attachments, attachment('new.txt')] });
  assert.equal(clearSubmittedDraft(drafts, 'first-session', sent), false);
  drafts.set('first-session', sent);
  assert.equal(clearSubmittedDraft(drafts, 'first-session', sent), true);
  assert.deepEqual(drafts.get('first-session'), { text: '', attachments: [] });
  assert.equal(drafts.get('other-session'), other);
});
