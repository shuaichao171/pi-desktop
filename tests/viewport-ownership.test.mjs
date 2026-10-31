import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createViewportOwnership } from '../packages/ui/src/viewportOwnership.ts';

test('an interrupted locate hands the viewport back', () => {
  const viewport = createViewportOwnership();
  assert.equal(viewport.restoring, false);
  viewport.own();
  assert.equal(viewport.restoring, true);
  // A session switch aborts the locate request, so its completion never runs and
  // interruption is the only place that can release the viewport.
  viewport.interrupt();
  assert.equal(viewport.restoring, false, 'an aborted locate must not keep the viewport');
});

test('an interrupted deferred restore hands the viewport back too', () => {
  const viewport = createViewportOwnership();
  viewport.own();
  viewport.interrupt();
  assert.equal(viewport.restoring, false);
  // The viewport is reusable: the next jump/restore takes it again and releases it.
  const token = viewport.own();
  assert.equal(viewport.restoring, true);
  viewport.release(token);
  assert.equal(viewport.restoring, false);
});

test('a stale completion cannot release a newer viewport owner', () => {
  const viewport = createViewportOwnership();
  const stale = viewport.own();
  const current = viewport.own();
  viewport.release(stale);
  assert.equal(viewport.restoring, true, 'the newer owner keeps the viewport');
  viewport.release(current);
  assert.equal(viewport.restoring, false);
});
