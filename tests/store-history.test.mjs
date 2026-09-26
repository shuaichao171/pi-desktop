import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

const TOTAL = 100;
const WINDOW = 40;
const allMessages = Array.from({ length: TOTAL }, (_, index) => ({
  id: `m${index}`, order: index, role: index % 2 ? 'assistant' : 'user', text: `message ${index}`, status: 'done',
}));
const readyEvent = (messages, historyTotal = TOTAL, sessionId = 'session-1', sessionPath = 'C:\\sessions\\one.jsonl') => ({
  type: 'ready', model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'medium'], contextUsage: null, cwd: 'C:\\workspace',
  sessionId, sessionPath, messages, activities: [], fileChanges: [], historyTotal,
});

function createHost() {
  const listeners = new Set();
  const pageCalls = [];
  const snapshot = {
    sequence: 1, status: 'idle', statusMessage: undefined,
    model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'medium',
    availableThinkingLevels: ['off', 'medium'], contextUsage: null,
    cwd: 'C:\\workspace', sessionId: 'session-1', sessionPath: 'C:\\sessions\\one.jsonl',
    messages: allMessages.slice(TOTAL - WINDOW), activities: [], queuedCount: 0,
    historyTotal: TOTAL, fileChanges: [], error: null,
  };
  const bridge = {
    getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform }),
    getAgentSnapshot: async () => snapshot,
    onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listWorkspaces: async () => ['C:\\workspace'],
    listSessions: async () => [],
    getHistoryPage: async (offset, limit) => {
      pageCalls.push({ offset, limit });
      return { offset, limit, total: TOTAL, messages: allMessages.slice(offset, offset + limit), activities: [] };
    },
  };
  return {
    bridge, pageCalls,
    emit(event) { for (const listener of listeners) listener({ sequence: 10 + pageCalls.length + Math.random(), event }); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const state = () => useChatStore.getState();

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('history paging loads older slices oldest-first and stops at the start', async () => {
  const host = createHost();
  state().setBridge(host.bridge);
  await settle();
  assert.equal(state().historyTotal, TOTAL);
  assert.equal(state().messages.length, WINDOW);

  assert.equal(await state().loadOlderMessages(30), true);
  assert.equal(state().messages.length, WINDOW + 30);
  assert.equal(state().messages[0].id, `m${TOTAL - WINDOW - 30}`);
  assert.deepEqual(host.pageCalls[0], { offset: TOTAL - WINDOW - 30, limit: 30 });

  assert.equal(await state().loadOlderMessages(30), true);
  assert.equal(state().messages.length, TOTAL);
  assert.equal(state().messages[0].id, 'm0');

  const calls = host.pageCalls.length;
  assert.equal(await state().loadOlderMessages(30), false);
  assert.equal(host.pageCalls.length, calls);
});

test('a same-session resync restores previously opened pages, a new session does not', async () => {
  const host = createHost();
  state().setBridge(host.bridge);
  await settle();
  await state().loadOlderMessages(TOTAL - WINDOW);
  assert.equal(state().messages.length, TOTAL);

  // The agent_settled resync re-sends only the newest window for the same session.
  host.emit(readyEvent(allMessages.slice(TOTAL - WINDOW)));
  await settle();
  await settle();
  assert.equal(state().messages.length, TOTAL);
  assert.equal(state().messages[0].id, 'm0');
  assert.ok(host.pageCalls.length >= 2);

  // A different session clears older pages without fetching history.
  const calls = host.pageCalls.length;
  host.emit(readyEvent(allMessages.slice(0, WINDOW), WINDOW, 'session-2', 'C:\\sessions\\two.jsonl'));
  await settle();
  await settle();
  assert.equal(state().messages.length, WINDOW);
  assert.equal(state().sessionId, 'session-2');
  assert.equal(host.pageCalls.length, calls);
});

test('live growth keeps historyTotal in step with the timeline', async () => {
  const host = createHost();
  state().setBridge(host.bridge);
  await settle();
  await state().loadOlderMessages(TOTAL - WINDOW);
  assert.equal(state().historyTotal, TOTAL);
  host.emit({ type: 'user-message', id: 'm100', order: 100, text: 'next', status: 'done' });
  host.emit({ type: 'assistant-start', id: 'm101', order: 101 });
  assert.equal(state().historyTotal, TOTAL + 2);
  assert.equal(state().messages.length, TOTAL + 2);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('an old history response never enters another session with the same timeline size', async () => {
  const host = createHost();
  const pending = deferred();
  host.bridge.getHistoryPage = () => pending.promise;
  state().setBridge(host.bridge);
  await settle();
  const loading = state().loadOlderMessages(30);
  const otherMessages = allMessages.slice(TOTAL - WINDOW).map((message) => ({ ...message, id: `other-${message.id}` }));
  host.emit(readyEvent(otherMessages, TOTAL, 'other-session', 'other.jsonl'));
  pending.resolve({ offset: 30, limit: 30, total: TOTAL, messages: allMessages.slice(30, 60), activities: [] });
  assert.equal(await loading, false);
  assert.deepEqual(state().messages, otherMessages);
  assert.equal(state().loadingOlder, false);
});

test('a same-session branch replacement retries the page against the new branch', async () => {
  const host = createHost();
  const pending = deferred();
  const newBranch = allMessages.map((message) => ({ ...message, id: `branch-${message.id}` }));
  let requests = 0;
  host.bridge.getHistoryPage = async (offset, limit) => {
    requests += 1;
    return requests === 1 ? pending.promise : { offset, limit, total: TOTAL, messages: newBranch.slice(offset, offset + limit), activities: [] };
  };
  state().setBridge(host.bridge);
  await settle();
  const loading = state().loadOlderMessages(30);
  host.emit(readyEvent(newBranch.slice(TOTAL - WINDOW)));
  pending.resolve({ offset: 30, limit: 30, total: TOTAL, messages: allMessages.slice(30, 60), activities: [] });
  assert.equal(await loading, true);
  assert.equal(requests, 2);
  assert.equal(state().messages.length, 70);
  assert.ok(state().messages.every((message) => message.id.startsWith('branch-')));
});

test('live appends during history paging retain their count and do not trigger a retry', async () => {
  const host = createHost();
  const pending = deferred();
  host.bridge.getHistoryPage = () => pending.promise;
  state().setBridge(host.bridge);
  await settle();
  const loading = state().loadOlderMessages(30);
  host.emit({ type: 'user-message', id: 'live', order: TOTAL, text: 'new message' });
  pending.resolve({ offset: 30, limit: 30, total: TOTAL, messages: allMessages.slice(30, 60), activities: [] });
  assert.equal(await loading, true);
  assert.equal(state().historyTotal, TOTAL + 1);
  assert.equal(state().messages.length, 71);
  assert.equal(state().messages.at(-1).id, 'live');
});

test('an old history failure cannot overwrite a new session or clear its pending request', async () => {
  const host = createHost();
  const oldPage = deferred();
  const newPage = deferred();
  let calls = 0;
  host.bridge.getHistoryPage = () => ++calls === 1 ? oldPage.promise : newPage.promise;
  state().setBridge(host.bridge);
  await settle();
  const oldLoading = state().loadOlderMessages(30);
  host.emit(readyEvent(allMessages.slice(TOTAL - WINDOW), TOTAL, 'new-session', 'new.jsonl'));
  const newLoading = state().loadOlderMessages(30);
  oldPage.reject(new Error('stale failure'));
  assert.equal(await oldLoading, false);
  assert.equal(state().error, null);
  assert.equal(state().loadingOlder, true);
  newPage.resolve({ offset: 30, limit: 30, total: TOTAL, messages: allMessages.slice(30, 60), activities: [] });
  assert.equal(await newLoading, true);
  assert.equal(state().loadingOlder, false);
});

test('repeated resyncs stop after one retry and explain how to resume loading', async () => {
  const host = createHost();
  let calls = 0;
  host.bridge.getHistoryPage = async (offset, limit) => {
    calls += 1;
    host.emit(readyEvent(allMessages.slice(TOTAL - WINDOW)));
    return { offset, limit, total: TOTAL, messages: allMessages.slice(offset, offset + limit), activities: [] };
  };
  state().setBridge(host.bridge);
  await settle();
  assert.equal(await state().loadOlderMessages(30), false);
  assert.equal(calls, 2);
  assert.ok(state().error);
  assert.equal(state().loadingOlder, false);
});
