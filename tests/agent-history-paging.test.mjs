import assert from 'node:assert/strict';
import { test } from 'node:test';

test('history trimming keeps the newest window and pages load oldest-first', async (t) => {
  const { trimRecentTimeline, historyPageSlice } = await import('../packages/agent/src/index.ts');
  const timeline = {
    messages: [{ id: 'a', order: 0, role: 'user', text: 'one', status: 'done' }, { id: 'c', order: 4, role: 'assistant', text: 'three', status: 'done' }],
    activities: [{ id: 'b', order: 2, tool: 'read', title: 'x', status: 'done' }, { id: 'd', order: 6, tool: 'edit', title: 'y', status: 'done' }],
  };

  await t.test('short timelines pass through with the exact total', () => {
    const kept = trimRecentTimeline(timeline, 10);
    assert.equal(kept.messages.length, 2);
    assert.equal(kept.activities.length, 2);
    assert.equal(kept.historyTotal, 4);
  });

  await t.test('the newest N entries survive trimming, ordered by timeline position', () => {
    const kept = trimRecentTimeline(timeline, 2);
    assert.deepEqual(kept.messages.map((message) => message.id), ['c']);
    assert.deepEqual(kept.activities.map((activity) => activity.id), ['d']);
    assert.equal(kept.historyTotal, 4);
    const one = trimRecentTimeline(timeline, 1);
    // The single newest entry is activity d, so no message survives.
    assert.deepEqual(one.messages.map((message) => message.id), []);
    assert.deepEqual(one.activities.map((activity) => activity.id), ['d']);
  });

  await t.test('page slices interleave messages and activities by order', () => {
    const first = historyPageSlice(timeline, 0, 2);
    assert.deepEqual(first.messages.map((message) => message.id), ['a']);
    assert.deepEqual(first.activities.map((activity) => activity.id), ['b']);
    assert.equal(first.offset, 0);
    assert.equal(first.total, 4);
    const second = historyPageSlice(timeline, 2, 10);
    assert.deepEqual(second.messages.map((message) => message.id), ['c']);
    assert.deepEqual(second.activities.map((activity) => activity.id), ['d']);
    assert.equal(second.offset, 2);
    assert.equal(second.total, 4);
    const past = historyPageSlice(timeline, 9, 5);
    assert.equal(past.messages.length, 0);
    assert.equal(past.total, 4);
  });
});
