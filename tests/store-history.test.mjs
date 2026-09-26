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
