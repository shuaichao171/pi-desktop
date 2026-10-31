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

function createHost({ snapshot = baseSnapshot, peek } = {}) {
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
    ...(peek ? { peekSession: peek } : {}),
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

const peekPayload = (messages) => ({ messages, activities: [], runs: [], fileChanges: [], fileChangeTurns: [], fileChangeActiveRunId: null, historyTotal: messages.length });

test('a cold switch commits the selection instantly and keeps the previous transcript visible (keep-over)', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'old conversation')] } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  const switching = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  const optimistic = useChatStore.getState();
  assert.equal(optimistic.sessionPath, 'C:\\sessions\\b.jsonl', 'the sidebar selection moves the moment the click lands');
  assert.equal(optimistic.cwd, 'C:\\workspace');
  assert.deepEqual(optimistic.messages, [userMessage('1', 'old conversation')], 'no cached preview exists, so the previous transcript stays on screen while the target loads');
  assert.equal(optimistic.conversationPreviewPath, 'C:\\sessions\\a.jsonl', 'the painted transcript is attributed to the session being left, not the optimistically selected target');
  assert.equal(optimistic.activities.length, 0);
  assert.equal(optimistic.sessionLoading, true);
  assert.equal(optimistic.navigationPending, true);

  host.emit(2, { type: 'reset', cwd: 'C:\\workspace' });
  assert.equal(useChatStore.getState().sessionPath, 'C:\\sessions\\b.jsonl', 'the reset that belongs to the pending switch keeps the optimistic selection');
  assert.deepEqual(useChatStore.getState().messages, [userMessage('1', 'old conversation')], 'the switch reset keeps the previous conversation painted (no-blank-out)');
  assert.equal(useChatStore.getState().conversationPreviewPath, 'C:\\sessions\\a.jsonl');

  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', [userMessage('2', 'new conversation')]));
  host.replies.get('C:\\sessions\\b.jsonl')();
  await switching;
  const settled = useChatStore.getState();
  assert.equal(settled.sessionPath, 'C:\\sessions\\b.jsonl');
  assert.deepEqual(settled.messages, [userMessage('2', 'new conversation')]);
  assert.equal(settled.navigationPending, false);
  assert.equal(settled.sessionLoading, false);
  assert.equal(settled.conversationPreviewPath, null, 'the authoritative ready clears the keep-over attribution');
});

test('a cold switch paints the disk peek instantly and the matching ready repaints nothing', async () => {
  const peeked = peekPayload([userMessage('9', 'peeked from disk')]);
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'old conversation')] }, peek: async () => peeked });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  const switching = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  assert.equal(useChatStore.getState().sessionPath, 'C:\\sessions\\b.jsonl', 'the selection commits instantly');
  await settle(); await settle();
  const painted = useChatStore.getState();
  assert.equal(painted.conversationPreviewPath, 'C:\\sessions\\b.jsonl', 'the peeked content belongs to the incoming session: it paints lit, not keep-over dim');
  assert.ok(painted.messages === peeked.messages, 'the disk peek paints by reference while the real load runs');
  const revision = painted.timelineRevision;

  host.emit(2, { type: 'reset', cwd: 'C:\\workspace' });
  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', [userMessage('9', 'peeked from disk')]));
  host.replies.get('C:\\sessions\\b.jsonl')();
  await switching;
  const settled = useChatStore.getState();
  assert.ok(settled.messages === peeked.messages, 'a ready identical to the painted peek keeps the message objects — zero re-render');
  assert.equal(settled.timelineRevision, revision, 'the matching ready does not rebuild the timeline');
  assert.equal(settled.conversationPreviewPath, null);
  assert.equal(settled.sessionPath, 'C:\\sessions\\b.jsonl');
  assert.equal(settled.navigationPending, false);
});

test('a peek that resolves after its ready never paints over the settled conversation', async () => {
  let resolvePeek;
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'old')] }, peek: () => new Promise((resolve) => { resolvePeek = resolve; }) });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  const switching = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  await settle();
  host.emit(2, { type: 'reset', cwd: 'C:\\workspace' });
  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', [userMessage('2', 'authoritative')]));
  await settle();
  const settledByReady = useChatStore.getState().messages;

  resolvePeek(peekPayload([userMessage('9', 'stale peek')]));
  await settle(); await settle();
  const after = useChatStore.getState();
  assert.ok(after.messages === settledByReady, 'the late peek is discarded: the ready already settled the view');
  assert.equal(after.conversationPreviewPath, null);
  host.replies.get('C:\\sessions\\b.jsonl')();
  await switching;
});

test('a peek painted before a failed switch rolls back with the navigation', async () => {
  const peeked = peekPayload([userMessage('9', 'peeked')]);
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'settled conversation')] }, peek: async () => peeked });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  host.emit(2, ready('C:\\workspace', 'C:\\sessions\\a.jsonl', [userMessage('1', 'settled conversation')]));
  await settle();

  host.bridge.switchSession = () => new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('load failed')), 10); });
  await assert.rejects(useChatStore.getState().switchSession('C:\\sessions\\broken.jsonl'), /load failed/);
  const restored = useChatStore.getState();
  assert.equal(restored.sessionPath, 'C:\\sessions\\a.jsonl');
  assert.deepEqual(restored.messages, [userMessage('1', 'settled conversation')], 'the painted peek is rolled back with the failed navigation');
  assert.equal(restored.conversationPreviewPath, null);
  assert.equal(restored.error, 'load failed');
});

test('a warm switch-back whose ready matches the painted preview repaints nothing', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'question')] } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  // Leave A for an empty B, then switch back: the keep-warm preview paints A.
  const toB = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  await settle();
  host.emit(2, { type: 'reset', cwd: 'C:\\workspace' });
  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', []));
  host.replies.get('C:\\sessions\\b.jsonl')();
  await toB;
  assert.equal(useChatStore.getState().messages.length, 0, 'session B is empty; its ready replaced the retained A content');

  const backToA = useChatStore.getState().switchSession('C:\\sessions\\a.jsonl');
  await settle();
  const previewed = useChatStore.getState();
  assert.deepEqual(previewed.messages, [userMessage('1', 'question')], 'the keep-warm preview paints instantly');
  assert.equal(previewed.conversationPreviewPath, 'C:\\sessions\\a.jsonl');
  const paintedMessages = previewed.messages;
  const revision = previewed.timelineRevision;

  host.emit(4, { type: 'reset', cwd: 'C:\\workspace' });
  host.emit(5, ready('C:\\workspace', 'C:\\sessions\\a.jsonl', [userMessage('1', 'question')]));
  host.replies.get('C:\\sessions\\a.jsonl')();
  await backToA;
  const settled = useChatStore.getState();
  assert.ok(settled.messages === paintedMessages, 'an identical ready keeps the painted message objects — the transcript does not re-render');
  assert.equal(settled.timelineRevision, revision, 'an identical ready does not rebuild the timeline');
  assert.equal(settled.conversationPreviewPath, null);
  assert.equal(settled.sessionId, 'id:C:\\sessions\\a.jsonl', 'the ready still re-scopes the runtime session id');
  assert.equal(settled.navigationPending, false);
});

test('a drifted ready replaces the painted preview', async () => {
  const host = createHost({ snapshot: { ...baseSnapshot, messages: [userMessage('1', 'question')] } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  const toB = useChatStore.getState().switchSession('C:\\sessions\\b.jsonl');
  await settle();
  host.emit(2, { type: 'reset', cwd: 'C:\\workspace' });
  host.emit(3, ready('C:\\workspace', 'C:\\sessions\\b.jsonl', []));
  host.replies.get('C:\\sessions\\b.jsonl')();
  await toB;

  const backToA = useChatStore.getState().switchSession('C:\\sessions\\a.jsonl');
  await settle();
  const paintedMessages = useChatStore.getState().messages;
  assert.equal(paintedMessages.length, 1);

  // A settled while the reader was away: the ready window grew past the preview.
  host.emit(4, { type: 'reset', cwd: 'C:\\workspace' });
  host.emit(5, ready('C:\\workspace', 'C:\\sessions\\a.jsonl', [userMessage('1', 'question'), userMessage('2', 'background answer')]));
  host.replies.get('C:\\sessions\\a.jsonl')();
  await backToA;
  const settled = useChatStore.getState();
  assert.deepEqual(settled.messages, [userMessage('1', 'question'), userMessage('2', 'background answer')], 'a drifted ready replaces the painted preview wholesale');
  assert.notEqual(settled.messages, paintedMessages);
  assert.equal(settled.conversationPreviewPath, null);
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
