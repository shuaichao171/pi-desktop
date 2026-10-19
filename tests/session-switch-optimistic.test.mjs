import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

const baseSnapshot = {
  sequence: 1,
  status: 'idle',
  statusMessage: undefined,
  model: 'test-model',
  modelProvider: 'test-provider',
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'low', 'medium', 'high'],
  contextUsage: null,
  cwd: 'C:\\workspace',
  sessionId: 'session-a',
  sessionPath: 'C:\\sessions\\a.jsonl',
  messages: [],
  activities: [],
  queuedCount: 0,
  error: null,
};

const userMessage = (id, text) => ({ id, order: Number(id), runId: null, role: 'user', text, status: 'done' });

function createHost({ snapshot = baseSnapshot } = {}) {
  const listeners = new Set();
  const replies = new Map();
  const bridge = {
    getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform }),
    pickWorkspace: async () => null,
    initAgent: async () => {},
    listWorkspaces: async () => ['C:\\workspace'],
    listSessions: async () => [],
    getAgentSnapshot: async () => snapshot,
    switchSession: (path) => new Promise((resolve) => replies.set(path, resolve)),
    onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {
    bridge, replies,
    emit(sequence, event) { for (const listener of listeners) listener({ sequence, event }); },
  };
}

const ready = (cwd, sessionPath, messages, sessionId) => ({
  ...baseSnapshot, type: 'ready', cwd, sessionId: sessionId ?? `id:${sessionPath}`, sessionPath, messages, activities: [],
});

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a cold switch commits the selection instantly and clears the transcript for the loading placeholder', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'old conversation')] } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  const switching = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  const optimistic = useChatStore.getState();
  assert.equal(optimistic.sessionPath, 'C:\\sessions\\b.jsonl', 'the sidebar selection moves the moment the click lands');
  assert.equal(optimistic.cwd, 'C:\\workspace');
  assert.deepEqual(optimistic.messages, [], 'no cached preview exists, so the transcript clears for the loading placeholder');
  assert.equal(optimistic.activities.length, 0);
  assert.equal(optimistic.sessionLoading, true);
  assert.equal(optimistic.navigationPending, true);

  host.emit(2, { type: 'reset', cwd: 'C:\\workspace' });
  assert.equal(useChatStore.getState().sessionPath, 'C:\\sessions\\b.jsonl', 'the reset that belongs to the pending switch keeps the optimistic selection');

  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', [userMessage('2', 'new conversation')]));
  host.replies.get('C:\\sessions\\b.jsonl')();
  await switching;
  const settled = useChatStore.getState();
  assert.equal(settled.sessionPath, 'C:\\sessions\\b.jsonl');
  assert.deepEqual(settled.messages, [userMessage('2', 'new conversation')]);
  assert.equal(settled.navigationPending, false);
  assert.equal(settled.sessionLoading, false);
});

test('a cross-workspace selection commits both workspaces immediately', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, cwd: 'C:\\workspace', sessionPath: 'C:\\sessions\\a.jsonl' } });
  host.bridge.switchWorkspace = async () => {};
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  const selecting = useChatStore.getState().selectSession('D:\\other', 'D:\\other\\chat.jsonl');
  await settle();
  const optimistic = useChatStore.getState();
  assert.equal(optimistic.cwd, 'D:\\other', 'the workspace commits before the host finishes switching');
  assert.equal(optimistic.sessionPath, 'D:\\other\\chat.jsonl');
  assert.deepEqual(optimistic.messages, []);

  host.emit(2, { type: 'reset', cwd: 'D:\\other' });
  assert.equal(useChatStore.getState().sessionPath, 'D:\\other\\chat.jsonl');
  host.emit(3, ready('D:\\other', 'D:\\other\\chat.jsonl', [userMessage('3', 'other workspace')]));
  host.replies.get('D:\\other\\chat.jsonl')();
  assert.equal(await selecting, true);
  assert.equal(useChatStore.getState().cwd, 'D:\\other');
});

test('an unrelated workspace reset still clears the selection', async () => {
  const host = createHost();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const switching = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  host.emit(2, { type: 'reset', cwd: 'E:\\unrelated' });
  assert.equal(useChatStore.getState().sessionPath, null, 'a reset for a different workspace is not the pending switch');
  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', []));
  host.replies.get('C:\\sessions\\b.jsonl')();
  await switching;
  assert.equal(useChatStore.getState().sessionPath, 'C:\\sessions\\b.jsonl');
});

test('a failed switch rolls the view back to the last settled conversation', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'settled conversation')] } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  host.emit(2, ready('C:\\workspace', 'C:\\sessions\\a.jsonl', [userMessage('1', 'settled conversation')]));
  await settle();

  host.bridge.switchSession = async () => { throw new Error('load failed'); };
  await assert.rejects(useChatStore.getState().switchSession('C:\\sessions\\broken.jsonl'), /load failed/);
  const restored = useChatStore.getState();
  assert.equal(restored.sessionPath, 'C:\\sessions\\a.jsonl', 'the renderer lands back on the session the host still shows');
  assert.equal(restored.cwd, 'C:\\workspace');
  assert.deepEqual(restored.messages, [userMessage('1', 'settled conversation')]);
  assert.equal(restored.navigationPending, false);
  assert.equal(restored.sessionLoading, false);
  assert.equal(restored.error, 'load failed');
});

test('reselecting the current session does not blank its transcript', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'visible conversation')] } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  host.emit(2, ready('C:\\workspace', 'C:\\sessions\\a.jsonl', [userMessage('1', 'visible conversation')]));
  await settle();

  const switching = useChatStore.getState().switchSession('C:\\sessions\\a.jsonl');
  await settle();
  assert.deepEqual(useChatStore.getState().messages, [userMessage('1', 'visible conversation')], 'a redundant switch keeps the displayed snapshot');
  host.replies.get('C:\\sessions\\a.jsonl')();
  await switching;
});
