import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedSidebarOrders, moveSidebarSession } from '../packages/ui/src/sidebarDrag.ts';

const orders = () => new Map([
  ['ungrouped', ['a', 'dragged', 'b']],
  ['first', ['c', 'd']],
  ['second', ['e']],
  ['empty', []],
]);
const frozenOrders = () => new Map([...orders()].map(([key, paths]) => [key, Object.freeze(paths)]));

test('continuous moves use the complete current snapshot and returning to the original position needs no writes', () => {
  const initial = frozenOrders();
  let current = moveSidebarSession(initial, 'dragged', 'first', 1);
  assert.deepEqual(current.get('first'), ['c', 'dragged', 'd']);
  current = moveSidebarSession(current, 'dragged', 'second', 0);
  assert.deepEqual(current.get('first'), ['c', 'd']);
  assert.deepEqual(current.get('second'), ['dragged', 'e']);
  current = moveSidebarSession(current, 'dragged', 'empty', 0);
  assert.deepEqual(current.get('second'), ['e']);
  assert.deepEqual(current.get('empty'), ['dragged']);
  current = moveSidebarSession(current, 'dragged', 'ungrouped', 1);
  assert.deepEqual(current, initial);
  assert.equal(changedSidebarOrders(initial, current).size, 0);
});

test('moving removes every existing dragged occurrence and deduplicates the destination', () => {
  const initial = new Map([
    ['a', ['dragged', 'keep', 'dragged']],
    ['b', ['first', 'first', 'dragged', 'last', 'last']],
    ['c', ['dragged']],
  ]);
  const current = moveSidebarSession(initial, 'dragged', 'b', 1);
  assert.deepEqual(current, new Map([['a', ['keep']], ['b', ['first', 'dragged', 'last']], ['c', []]]));
  assert.equal([...current.values()].flat().filter(path => path === 'dragged').length, 1);
  assert.deepEqual(initial.get('b'), ['first', 'first', 'dragged', 'last', 'last']);
});

test('same-container reordering uses the supplied post-removal index without an extra forward adjustment', () => {
  const initial = orders();
  const last = moveSidebarSession(initial, 'a', 'ungrouped', 2);
  assert.deepEqual(last.get('ungrouped'), ['dragged', 'b', 'a']);
  assert.deepEqual([...changedSidebarOrders(initial, last).keys()], ['ungrouped']);
  const first = moveSidebarSession(last, 'a', 'ungrouped', 0);
  assert.deepEqual(first.get('ungrouped'), initial.get('ungrouped'));
  assert.equal(changedSidebarOrders(initial, first).size, 0);
  assert.equal(changedSidebarOrders(initial, moveSidebarSession(initial, 'dragged', 'ungrouped', 1)).size, 0);
});

test('empty destinations accept a drop and out-of-range indices clamp to the list bounds', () => {
  assert.deepEqual(moveSidebarSession(orders(), 'dragged', 'empty', 100).get('empty'), ['dragged']);
  assert.deepEqual(moveSidebarSession(orders(), 'dragged', 'first', -100).get('first'), ['dragged', 'c', 'd']);
  assert.deepEqual(moveSidebarSession(orders(), 'dragged', 'first', 100).get('first'), ['c', 'd', 'dragged']);
  assert.deepEqual(moveSidebarSession(orders(), 'dragged', 'first', 1.8).get('first'), ['c', 'dragged', 'd']);
});

test('missing targets preserve every container and never remove the dragged path', () => {
  const initial = frozenOrders();
  const current = moveSidebarSession(initial, 'dragged', 'missing', 0);
  assert.deepEqual(current, initial);
  assert.equal(changedSidebarOrders(initial, current).size, 0);
  current.get('ungrouped').push('later');
  assert.deepEqual(initial.get('ungrouped'), ['a', 'dragged', 'b']);
  assert.deepEqual(moveSidebarSession(new Map(), 'dragged', 'missing', 0), new Map());
  assert.equal(changedSidebarOrders(new Map(), new Map()).size, 0);
});

test('only containers whose final ordered list changed are persisted after crossing multiple groups', () => {
  const initial = orders();
  const crossed = moveSidebarSession(initial, 'dragged', 'first', 1);
  const current = moveSidebarSession(crossed, 'dragged', 'second', 1);
  assert.deepEqual(changedSidebarOrders(initial, current), new Map([
    ['ungrouped', ['a', 'b']], ['second', ['e', 'dragged']],
  ]));
  assert.equal(changedSidebarOrders(initial, new Map([...initial].reverse())).size, 0, 'Map key iteration order is not a list change');
});

test('preview and change snapshots do not mutate or alias any input arrays', () => {
  const initial = frozenOrders();
  const current = moveSidebarSession(initial, 'dragged', 'first', 1);
  assert.deepEqual(initial, orders());
  for (const [key, paths] of initial) assert.notEqual(paths, current.get(key));
  const changed = changedSidebarOrders(initial, current);
  changed.get('first').push('external');
  changed.get('ungrouped').splice(0, 1);
  assert.deepEqual(current.get('first'), ['c', 'dragged', 'd']);
  assert.deepEqual(current.get('ungrouped'), ['a', 'b']);
  assert.deepEqual(initial, orders());
});
