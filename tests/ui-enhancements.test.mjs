import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsLeaveGuard } from '../packages/ui/src/settingsLeaveGuard.ts';
import { operationFeedback, runWithFeedback } from '../packages/ui/src/operationFeedback.ts';
import { imageCapability } from '../packages/ui/src/modelCapabilities.ts';
import { normalizeContentFontSize, readContentFontSize, saveContentFontSize } from '../packages/ui/src/contentFontSize.ts';

test('saving before leaving preserves the original destination, blocks duplicate writes and retains failed drafts', async () => {
  const guard = createSettingsLeaveGuard();
  let finish;
  let writes = 0;
  const target = { page: 'model', focus: 'api-key', action() {} };
  guard.report({ dirty: true, saving: false, save: () => { writes++; return new Promise(resolve => { finish = resolve; }); } });
  guard.request(target);
  const first = guard.takeSaved();
  assert.equal(await guard.takeSaved(), null);
  assert.equal(guard.takeDiscard(), null);
  assert.equal(guard.keepEditing(), null);
  assert.equal(writes, 1);
  finish(false);
  assert.equal(await first, null);
  assert.equal(guard.pending, target);
  const retry = guard.takeSaved();
  finish(true);
  assert.equal(await retry, target);
  assert.equal(guard.pending, null);
});

test('operation errors outlive their menu and retry the captured target with deduplication', async () => {
  const calls = [];
  let target = 'workspace-A';
  const captured = target;
  let fail = true;
  const operation = { id: 'editor:workspace-A', title: 'Open editor', run: async () => { calls.push(captured); if (fail) throw new Error('Editor missing'); }, success: 'Opened' };
  await runWithFeedback(operation);
  target = 'workspace-B';
  assert.equal(operationFeedback.getSnapshot().filter(item => item.id === operation.id).length, 1);
  const notice = operationFeedback.getSnapshot().find(item => item.id === operation.id);
  assert.equal(notice.kind, 'error');
  assert.equal(notice.detail, 'Editor missing');
  fail = false;
  await notice.retry();
  assert.deepEqual(calls, ['workspace-A', 'workspace-A']);
  assert.equal(operationFeedback.getSnapshot().find(item => item.id === operation.id).kind, 'success');
  operationFeedback.dismiss(operation.id);
  let complete;
  const slow = { id: 'slow', title: 'Working', run: () => new Promise(resolve => { complete = resolve; }) };
  const pending = runWithFeedback(slow);
  assert.equal(await runWithFeedback(slow), false);
  complete();
  assert.equal(await pending, true);
  assert.equal(operationFeedback.getSnapshot().some(item => item.id === 'slow'), false);
});

test('model image compatibility reflects catalog metadata and preserves unknown capability', () => {
  assert.equal(imageCapability({ input: ['text', 'image'] }), 'supported');
  assert.equal(imageCapability({ input: ['text'] }), 'unsupported');
  assert.equal(imageCapability({ input: [] }), 'unknown');
  assert.equal(imageCapability(), 'unknown');
});

test('content font preferences are independent, bounded, and tolerate denied storage', () => {
  const originalStorage = globalThis.localStorage;
  const originalDocument = globalThis.document;
  const values = new Map();
  const properties = new Map();
  try {
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    globalThis.document = { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } };
    saveContentFontSize('code', 18);
    saveContentFontSize('command', 22);
    assert.equal(readContentFontSize('code'), 18);
    assert.equal(readContentFontSize('command'), 22);
    assert.equal(properties.get('--pd-code-font-size'), '18px');
    assert.equal(properties.has('--pd-ui-font-size'), false);
    assert.equal(normalizeContentFontSize(99), 24);
    assert.equal(normalizeContentFontSize('invalid'), 12);
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(readContentFontSize('code'), 12);
    assert.doesNotThrow(() => saveContentFontSize('command', 20));
    assert.equal(properties.get('--pd-command-font-size'), '20px');
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});
