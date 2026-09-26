import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { buildConversationTimeline, entryContainsMessage, turnAnswer } from '../packages/ui/src/conversationTimeline.ts';
import { formatRunDuration, mergeConversationRuns } from '../packages/ui/src/conversationRuns.ts';
import { useChatStore } from '../packages/ui/src/store.ts';

const run = (id, status = 'completed') => ({ id, startedAt: 1000, finishedAt: status === 'running' ? null : 65000, status });
const message = (id, order, role, text, runId) => ({ id, order, role, text, runId, status: 'done' });
beforeEach(() => useChatStore.setState(useChatStore.getInitialState(), true));

test('one run keeps commentary and tools together, with only its last response as the answer', () => {
  const messages = [message('u', 0, 'user', 'Review', 'run1'), message('plan', 1, 'assistant', 'I will inspect', 'run1'),
    message('answer', 4, 'assistant', 'Fixed', 'run1')];
  const tools = [{ id: 'read', order: 2, runId: 'run1', status: 'done' }, { id: 'edit', order: 3, runId: 'run1', status: 'done' }];
  const entries = buildConversationTimeline(messages, tools, [run('run1')]);
  assert.equal(entries.length, 2); assert.equal(entries[0].id, 'u');
  assert.deepEqual(entries[1].entries.map(entry => entry.id), ['plan', 'read', 'answer']);
  assert.equal(turnAnswer(entries[1], messages).id, 'answer');
  assert(entryContainsMessage(entries[1], 'plan'));
  assert.equal(turnAnswer(buildConversationTimeline(messages.slice(0, 2), tools, [run('run1')])[1], messages), undefined);
});

test('steering stays visible in place and a queued next run has independent grouping and timing', () => {
  const messages = [message('u', 0, 'user', 'Review', 'a'), message('plan', 1, 'assistant', 'Inspect', 'a'),
    message('steer', 3, 'user', 'Also check tests', 'a'), message('answer', 4, 'assistant', 'Done', 'a'),
    message('next', 5, 'user', 'Next request', 'b'), message('answer2', 6, 'assistant', 'Second result', 'b')];
  const entries = buildConversationTimeline(messages, [{ id: 't', order: 2, runId: 'a' }], [run('a'), run('b')]);
  assert.deepEqual(entries.map(entry => entry.kind), ['message', 'turn', 'message', 'turn', 'message', 'turn']);
  assert.equal(entries[2].id, 'steer'); assert.equal(entries[1].lastForRun, false);
  assert.equal(turnAnswer(entries[1], messages), undefined);
  assert.equal(turnAnswer(entries[3], messages).id, 'answer');
  assert.equal(entries[5].runId, 'b');
});

test('preflight renders an active run before first token; legacy history has no invented clock', () => {
  const waiting = buildConversationTimeline([], [], [run('pending', 'running')]);
  assert.equal(waiting.length, 1); assert.equal(waiting[0].runId, 'pending'); assert.deepEqual(waiting[0].entries, []);
  const legacy = buildConversationTimeline([message('u', 0, 'user', 'Old'), message('a', 1, 'assistant', 'Old reply')], [], []);
  assert.equal(legacy[1].runId, undefined); assert.equal(turnAnswer(legacy[1], [message('u', 0, 'user', 'Old'), message('a', 1, 'assistant', 'Old reply')]).id, 'a');
  assert.equal(formatRunDuration(59999, 'en-US'), '59s'); assert.equal(formatRunDuration(60000, 'en-US'), '1m 0s');
  assert.equal(formatRunDuration(3601000, 'zh-CN'), '1小时 0分 1秒'); assert.equal(formatRunDuration(-5, 'zh-CN'), '0秒');
});

test('a stop before the first assistant token retains its summary in the correct user turn', () => {
  const messages = [message('u1', 0, 'user', 'First', 'a'), message('u2', 1, 'user', 'Next', 'b'), message('b1', 2, 'assistant', 'Done', 'b')];
  const entries = buildConversationTimeline(messages, [], [run('a', 'cancelled'), run('b')]);
  assert.deepEqual(entries.map(entry => entry.kind === 'message' ? entry.id : entry.runId), ['u1', 'a', 'u2', 'b']);
  assert.deepEqual(entries[1].entries, []);
  const orphan = buildConversationTimeline(messages, [], [run('a', 'cancelled'), run('b'), run('c', 'failed')]);
  assert.equal(orphan.at(-1).runId, 'c');
});

test('store preserves run identity across live events, never settles on a single assistant end, and clears on navigation', () => {
  const store = useChatStore.getState;
  store().handleEvent({ type: 'run', run: run('a', 'running') });
  store().handleEvent({ type: 'user-message', id: 'u', order: 0, runId: 'a', text: 'Check' });
  store().handleEvent({ type: 'assistant-start', id: 'a1', order: 1, runId: 'a' });
  store().handleEvent({ type: 'assistant-end', id: 'a1', text: 'Checking files' });
  assert.equal(store().runs[0].status, 'running'); assert.equal(store().messages[1].runId, 'a');
  store().handleEvent({ type: 'run', run: run('a') });
  store().handleEvent({ type: 'run', run: run('a', 'running') });
  assert.equal(store().runs[0].finishedAt, 65000);
  assert.equal(mergeConversationRuns(store().runs, [run('a', 'running')])[0].status, 'completed');
  store().handleEvent({ type: 'reset', cwd: 'other' }); assert.deepEqual(store().runs, []);
});

test('host failure stops a clock without claiming an unobserved finish time', () => {
  const store = useChatStore.getState;
  store().handleEvent({ type: 'run', run: run('a', 'running') });
  store().handleEvent({ type: 'status', status: 'error', message: 'Worker exited' });
  assert.equal(store().runs[0].status, 'interrupted'); assert.equal(store().runs[0].finishedAt, null);
});
