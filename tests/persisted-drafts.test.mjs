import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistedComposerDrafts } from '../packages/ui/src/persistedDrafts.ts';

test('draft hydration reports missing attachments and retries read errors without silently committing a shortened draft', async () => {
  const scope = { cwd: 'project', sessionPath: 'session' }, picture = { kind: 'image', name: 'one.png', mimeType: 'image/png', data: 'YQ==' };
  let fail = true, reads = 0; const writes = [];
  const bridge = {
    getInputDraft: async () => { if (fail) throw new Error('Disk unavailable'); return { version: 7, text: 'saved', attachments: [{ id: 'one', ...picture }, { id: 'missing', name: 'lost.png', kind: 'image', mimeType: 'image/png' }], missing: ['missing'] }; },
    readInputAttachment: async (_scope, id) => { reads++; if (id === 'missing') throw new Error('Missing'); return picture; },
    saveInputDraft: async request => { writes.push(request); return { version: request.expectedVersion + 1 }; },
    putInputAttachment: async () => { throw new Error('Hydrated attachment should reuse its ID'); },
  };
  const drafts = new PersistedComposerDrafts(bridge);
  await assert.rejects(drafts.load(scope), /Disk unavailable/); fail = false;
  const loaded = await drafts.load(scope); assert.equal(loaded.draft.text, 'saved'); assert.deepEqual(loaded.draft.attachments, [picture]); assert.equal(loaded.missing[0].id, 'missing');
  assert.deepEqual(writes, [], 'hydration alone never removes missing refs');
  await drafts.save(scope, loaded.draft); assert.deepEqual(writes[0].attachmentIds, ['one']); assert.equal(writes[0].expectedVersion, 7); assert.equal(reads, 2);
});

test('draft saves coalesce pending edits, reuse immutable attachment identities, and preserve scope/version isolation', async () => {
  const scope = { cwd: 'A', sessionPath: 'one' }, other = { cwd: 'B', sessionPath: 'two' }, picture = { kind: 'image', name: 'same.png', mimeType: 'image/png', data: 'YQ==' };
  const writes = [], puts = []; let unlock; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const drafts = new PersistedComposerDrafts({
    getInputDraft: async () => ({ version: 0, text: '', attachments: [], missing: [] }),
    putInputAttachment: async (_scope, attachment) => { puts.push(attachment); return { id: 'image-' + puts.length }; },
    saveInputDraft: async request => { writes.push(request); if (writes.length === 1) await new Promise(resolve => { unlock = resolve; started(); }); return { version: request.expectedVersion + 1 }; },
  });
  const first = drafts.save(scope, { text: 'first', attachments: [picture] }); await ready;
  const middle = drafts.save(scope, { text: 'middle', attachments: [picture] });
  const last = drafts.save(scope, { text: 'last', attachments: [picture] });
  await drafts.save(other, { text: 'separate', attachments: [] }); unlock(); await Promise.all([first, middle, last]);
  assert.deepEqual(writes.filter(write => write.cwd === 'A').map(write => [write.text, write.expectedVersion]), [['first', 0], ['last', 1]]);
  assert.equal(puts.length, 1); assert.equal(writes.find(write => write.cwd === 'B').expectedVersion, 0);
});
