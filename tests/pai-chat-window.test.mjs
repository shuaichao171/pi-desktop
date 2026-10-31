import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

// A hosted pai chat window loads the same renderer as the main window; every
// main-window-only channel would be refused by the main process. The store must
// therefore never ask for the workspace and session lists there, or the
// conversation area shows "该功能仅在 Pi Desktop 主窗口中可用" with status idle.
const MAIN_ONLY = '该功能仅在 Pi Desktop 主窗口中可用';
const settle = () => new Promise((resolve) => setImmediate(resolve));

const baseSnapshot = {
  sequence: 1,
  status: 'idle',
  statusMessage: undefined,
  model: 'test-model',
  modelProvider: 'test-provider',
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'low', 'medium', 'high'],
  contextUsage: null,
  cwd: 'C:\\pai-project',
  sessionId: 'session-1',
  sessionPath: 'C:\\pai-project\\one.jsonl',
  messages: [],
  activities: [],
  queuedCount: 0,
  error: null,
};

function createHostedBridge() {
  const calls = [];
  const listeners = new Set();
  let session = { id: 'session-1', path: 'C:\\pai-project\\one.jsonl' };
  // Every channel the main process refuses for a hosted pai window.
  const blocked = (name) => async () => { calls.push(name); throw new Error(MAIN_ONLY); };
  const bridge = {
    getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform, windowMode: 'pai' }),
    getAgentSnapshot: async () => ({ ...baseSnapshot, sessionId: session.id, sessionPath: session.path }),
    listWorkspaces: blocked('listWorkspaces'),
    listConversationWorkspaces: blocked('listConversationWorkspaces'),
    getDefaultWorkspace: blocked('getDefaultWorkspace'),
    listSessions: blocked('listSessions'),
    newSession: async () => { session = { id: 'session-2', path: 'C:\\pai-project\\two.jsonl' }; return { cwd: baseSnapshot.cwd, sessionPath: session.path }; },
    onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { bridge, calls };
}

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('a hosted pai window bootstraps and starts conversations without touching main-window-only lists', async () => {
  const host = createHostedBridge();
  useChatStore.getState().setBridge(host.bridge, { hostedChatWindow: true });
  await settle();
  await settle();

  let state = useChatStore.getState();
  assert.equal(state.error, null, 'opening the window must not surface the main-window-only banner');
  assert.equal(state.status, 'idle');
  assert.equal(state.cwd, 'C:\\pai-project');
  assert.equal(state.sessionPath, 'C:\\pai-project\\one.jsonl');
  assert.deepEqual(host.calls, [], 'the workspace and session lists stay unrequested');

  // The window's own "new conversation" button.
  await useChatStore.getState().newSession();
  await settle();
  state = useChatStore.getState();
  assert.equal(state.error, null, 'starting a conversation must not surface the banner either');
  assert.equal(state.sessionPath, 'C:\\pai-project\\two.jsonl');
  assert.deepEqual(host.calls, []);
});

test('the main window still refreshes the workspace and session lists', async () => {
  const host = createHostedBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await settle();

  // Control for the guard above: without the hosted flag the same bridge is asked
  // for both lists (and their refusal is reported, as in the original report).
  assert.deepEqual([...host.calls].sort(), ['getDefaultWorkspace', 'listConversationWorkspaces', 'listSessions', 'listWorkspaces']);
  assert.equal(useChatStore.getState().error, MAIN_ONLY);
});
