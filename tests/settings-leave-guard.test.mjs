import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsLeaveGuard } from '../packages/ui/src/settingsLeaveGuard.ts';

test('unsaved settings keep the first navigation, original page and editor selection until resolved', () => {
  const guard = createSettingsLeaveGuard();
  const calls = [];
  const originalFocus = { element: 'base-url', selection: { start: 8, end: 15 } };
  const target = { action: () => calls.push('appearance'), page: 'model', focus: originalFocus };
  guard.report({ dirty: true, saving: false });
  assert.equal(guard.request(target), target);
  assert.equal(guard.request({ action: () => calls.push('close'), page: 'model', focus: 'close-button' }), null);
  assert.deepEqual(calls, [], 'neither leaving action runs before a decision');
  assert.equal(guard.keepEditing(), target, 'continue editing returns the original page and focus, not the later close target');
  assert.equal(guard.pending, null);
  assert.equal(guard.takeDiscard(), null, 'a cancelled confirmation cannot run later');
  assert.equal(guard.request(target), target, 'continuing editing preserves dirty state');
  const accepted = guard.takeDiscard();
  accepted.action();
  assert.equal(guard.takeDiscard(), null, 'a repeated confirmation cannot execute the target twice');
  assert.deepEqual(calls, ['appearance']);
  guard.request({ action: () => calls.push('close'), page: 'appearance', focus: null });
  assert.deepEqual(calls, ['appearance', 'close'], 'discard clears the old page guard before navigation');
});

test('saving blocks navigation and a late save cannot be discarded while in flight', () => {
  const guard = createSettingsLeaveGuard();
  let left = false;
  const request = { action: () => { left = true; }, page: 'model', focus: 'base-url' };
  guard.report({ dirty: true, saving: true });
  assert.equal(guard.request(request), null);
  assert.equal(guard.pending, null);
  assert.equal(left, false);
  guard.report({ dirty: true, saving: false });
  assert.equal(guard.request(request), request, 'failed saving retains unsaved protection');
  guard.report({ dirty: true, saving: true });
  assert.equal(guard.takeDiscard(), null);
  assert.equal(guard.pending, request, 'in-flight saving does not lose the original leave request');
  guard.keepEditing();
  guard.report({ dirty: false, saving: false });
  assert.equal(guard.request(request), null);
  assert.equal(left, true, 'successful saving allows leaving without another confirmation');
});

test('discarding one settings page does not bypass unsaved protection on the next page', () => {
  const guard = createSettingsLeaveGuard();
  let page = 'personalization';
  guard.report({ dirty: true, saving: false });
  guard.request({ action: () => { page = 'model'; }, page, focus: 'instructions' });
  const discarded = guard.takeDiscard();
  discarded.action();
  assert.equal(page, 'model');
  guard.report({ dirty: true, saving: false });
  guard.request({ action: () => { page = 'general'; }, page, focus: 'model-id' });
  const kept = guard.keepEditing();
  assert.equal(kept.page, 'model');
  assert.equal(kept.focus, 'model-id');
  assert.equal(page, 'model');
});
