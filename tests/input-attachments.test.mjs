import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from '../packages/agent/src/attachmentStore.ts';

test('large draft attachments survive a store restart; ownership, versions and changed content remain distinct', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-attachments-'));
  try {
    const scope = { cwd: root, sessionPath: 'session-a' }; const store = new AttachmentStore(root);
    const image = { kind: 'image', name: 'design.png', mimeType: 'image/png', data: Buffer.alloc(7 * 1024 * 1024, 1).toString('base64') };
    const ref = store.put(scope, image); assert.ok(ref.size > 8 * 1024 * 1024);
    store.saveDraft({ ...scope, text: 'draft', attachmentIds: [ref.id], expectedVersion: 0 });
    const restarted = new AttachmentStore(root), draft = restarted.getDraft(scope);
    assert.equal(draft.text, 'draft'); assert.equal(restarted.read(scope, ref.id).data, image.data);
    assert.throws(() => restarted.read({ ...scope, sessionPath: 'session-b' }, ref.id), /不属于/);
    const changed = restarted.put(scope, { ...image, data: 'Yg==' }); assert.notEqual(changed.id, ref.id);
    assert.throws(() => restarted.saveDraft({ ...scope, text: 'stale', attachmentIds: [], expectedVersion: 0 }), /其他窗口/);
    unlinkSync(join(root, 'blobs', ref.id + '.json'));
    assert.deepEqual(restarted.getDraft(scope).missing, [ref.id]);
    assert.throws(() => restarted.read(scope, ref.id), /缺失/);
    restarted.saveDraft({ ...scope, text: '', attachmentIds: [], expectedVersion: 1 });
    const old = Date.now() - 3 * 86400000; utimesSync(join(root, 'blobs', changed.id + '.json'), old / 1000, old / 1000);
    assert.equal(restarted.collect(Date.now() + 2 * 86400000).removed, 1, 'expired staging references release otherwise unused blobs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('permanent session deletion releases only its attachment owners and shared content survives other scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-scope-'));
  try {
    const store = new AttachmentStore(root), scope = { cwd: root, sessionPath: 'one' }, other = { cwd: root, sessionPath: 'two' };
    const image = { kind: 'image', name: 'shared.png', mimeType: 'image/png', data: 'YQ==' };
    const ref = store.put(scope, image); store.saveDraft({ ...scope, text: 'one', attachmentIds: [ref.id], expectedVersion: 0 });
    const shared = store.put(other, image); store.saveDraft({ ...other, text: 'two', attachmentIds: [shared.id], expectedVersion: 0 });
    assert.equal(ref.id, shared.id); store.releaseScope(scope);
    assert.throws(() => store.read(scope, ref.id), /不属于/); assert.equal(store.read(other, shared.id).data, 'YQ==');
    const old = Date.now() - 3 * 86400000; utimesSync(join(root, 'blobs', ref.id + '.json'), old / 1000, old / 1000);
    assert.equal(store.collect(Date.now() + 2 * 86400000).removed, 0);
    store.releaseScope(other); assert.equal(store.collect(Date.now() + 2 * 86400000).removed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
