import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { selectStartupReady, useChatStore } from '../packages/ui/src/store.ts';

const baseSnapshot = {
  sequence: 1,
  status: 'idle',
  statusMessage: undefined,
  model: 'test-model',
  modelProvider: 'test-provider',
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'low', 'medium', 'high'],
  contextUsage: { tokens: 1200, contextWindow: 100000, percent: 1.2 },
  cwd: 'C:\\workspace',
  sessionId: 'session-1',
  sessionPath: 'C:\\sessions\\one.jsonl',
  messages: [],
  activities: [],
  queuedCount: 0,
  error: null,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createBridge({ snapshot = baseSnapshot, onSnapshot, onInitAgent, onPrompt, onListSessions, workspaces = ['C:\\workspace'], sessionsByCwd = {} } = {}) {
  const listeners = new Set();
  const prompts = [];
  const settingsCalls = [];
  const workspaceSwitches = [];
  const initCalls = [];
  let snapshotCalls = 0;
  const sessionListCalls = [];
  const models = [{ provider: 'test-provider', id: 'next-model', name: 'Next Model', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 4096 }];
  const bridge = {
    getAppInfo: async () => ({
      appVersion: 'test',
      nodeVersion: process.version,
      electronVersion: 'test',
      platform: process.platform,
    }),
    pickWorkspace: async () => null,
    initAgent: async (cwd) => { initCalls.push(cwd); await onInitAgent?.(cwd); },
    listWorkspaces: async () => workspaces,
    switchWorkspace: async (cwd) => {
      workspaceSwitches.push(cwd);
      for (const listener of listeners) listener({ sequence: 20, event: { type: 'reset', cwd } });
      for (const listener of listeners) listener({ sequence: 21, event: { type: 'ready', model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'medium', availableThinkingLevels: ['off', 'low', 'medium', 'high'], cwd, sessionId: 'other-session', sessionPath: `${cwd}\\session.jsonl`, messages: [], activities: [] } });
      for (const listener of listeners) listener({ sequence: 22, event: { type: 'status', status: 'idle' } });
    },
    getAgentSnapshot: () => { snapshotCalls += 1; return onSnapshot ? onSnapshot() : Promise.resolve(snapshot); },
    listSessions: async (cwd) => {
      sessionListCalls.push(cwd);
      return onListSessions ? onListSessions(cwd) : sessionsByCwd[cwd ?? baseSnapshot.cwd] ?? [];
    },
    switchSession: async () => {},
    listModels: async () => models,
    listModelProviders: async () => [{ provider: 'test-provider', name: 'Test Provider', custom: false, editable: false, configured: false, baseUrl: null, api: null, models }],
    setModel: async (provider, id) => {
      settingsCalls.push(['model', provider, id]);
      for (const listener of listeners) listener({ sequence: 2, event: { type: 'model', model: id, modelProvider: provider, thinkingLevel: 'medium', availableThinkingLevels: ['off', 'low', 'medium', 'high'] } });
    },
    setThinkingLevel: async (level) => {
      settingsCalls.push(['thinking', level]);
      for (const listener of listeners) listener({ sequence: 3, event: { type: 'thinking-level', level } });
    },
    listProviderAuth: async () => [{ provider: 'test-provider', configured: false }],
    setProviderApiKey: async (provider, key) => { settingsCalls.push(['api-key', provider, key]); },
    removeProviderCredential: async (provider) => { settingsCalls.push(['remove-key', provider]); },
    async prompt(text, behavior, attachments) {
      prompts.push(attachments ? [text, behavior, attachments] : [text, behavior]);
      await onPrompt?.(text, behavior, attachments);
    },
    abort: async () => {},
    newSession: async () => {},
    onAgentEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    bridge,
    prompts,
    settingsCalls,
    workspaceSwitches,
    initCalls,
    sessionListCalls,
    get snapshotCalls() { return snapshotCalls; },
    get listenerCount() { return listeners.size; },
    emit(sequence, event) {
      for (const listener of listeners) listener({ sequence, event });
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('conversation file changes hydrate, replay newer events, and reset across sessions and bridges', async () => {
  const first = { path: 'src/app.ts', kind: 'modified', additions: 2, deletions: 1, diff: '@@ -1 +1,2 @@\n-before\n+after\n+new\n' };
  const latest = { ...first, additions: 3, diff: 'updated diff' };
  const pending = deferred();
  const host = createBridge({ snapshot: pending.promise });
  useChatStore.getState().setBridge(host.bridge);
  host.emit(2, { type: 'file-changes', items: [latest] });
  pending.resolve({ ...baseSnapshot, fileChanges: [first] });
  await settle();
  assert.deepEqual(useChatStore.getState().fileChanges, [latest]);
  host.emit(3, { type: 'status', status: 'idle' });
  assert.deepEqual(useChatStore.getState().fileChanges, [latest]);
  host.emit(4, { ...baseSnapshot, type: 'ready', fileChanges: [first], sessionId: 'restored' });
  assert.deepEqual(useChatStore.getState().fileChanges, [first]);
  host.emit(5, { type: 'file-changes', items: [] });
  assert.deepEqual(useChatStore.getState().fileChanges, []);
  host.emit(6, { type: 'file-changes', items: [latest] });
  host.emit(7, { type: 'reset', cwd: 'C:\\second-project' });
  assert.deepEqual(useChatStore.getState().fileChanges, []);
  host.emit(8, { ...baseSnapshot, type: 'ready', fileChanges: [first] });
  const replacement = createBridge();
  useChatStore.getState().setBridge(replacement.bridge);
  assert.deepEqual(useChatStore.getState().fileChanges, []);
  host.emit(9, { type: 'file-changes', items: [latest] });
  await settle();
  assert.deepEqual(useChatStore.getState().fileChanges, []);
});

test('thinking projections survive bootstrap and finalization without leaking across sessions or hosts', async () => {
  const snapshot = deferred();
  const host = createBridge({ snapshot: snapshot.promise });
  useChatStore.getState().setBridge(host.bridge);
  host.emit(2, { type: 'assistant-start', id: 'thinking-1', order: 1 });
  host.emit(3, { type: 'assistant-thinking', id: 'thinking-1', thinking: 'Checking files', thinkingStatus: 'streaming', thinkingTruncated: false });
  snapshot.resolve(baseSnapshot);
  await settle();
  assert.equal(useChatStore.getState().messages.at(-1).thinking, 'Checking files');
  assert.equal(useChatStore.getState().messages.at(-1).thinkingStatus, 'streaming');
  host.emit(4, { type: 'assistant-thinking', id: 'thinking-1', thinking: 'Checking files and tests', thinkingStatus: 'done', thinkingTruncated: false });
  host.emit(5, { type: 'assistant-end', id: 'thinking-1', text: 'Finished', thinking: 'Final public summary', thinkingStatus: 'done', thinkingTruncated: true });
  host.emit(6, { type: 'assistant-thinking', id: 'thinking-1', thinking: 'Late stale partial', thinkingStatus: 'streaming', thinkingTruncated: false });
  assert.equal(useChatStore.getState().messages.at(-1).thinking, 'Final public summary');
  assert.equal(useChatStore.getState().messages.at(-1).thinkingStatus, 'done');
  assert.equal(useChatStore.getState().messages.at(-1).thinkingTruncated, true);
  host.emit(7, { ...baseSnapshot, type: 'ready', sessionId: 'second-session' });
  host.emit(8, { type: 'assistant-thinking', id: 'thinking-1', thinking: 'Old session', thinkingStatus: 'streaming', thinkingTruncated: false });
  assert.deepEqual(useChatStore.getState().messages, []);

  const restored = { id: 'restored-thinking', role: 'assistant', order: 1, text: '', status: 'done', thinking: 'Restored summary', thinkingStatus: 'done', thinkingTruncated: false };
  const replacement = createBridge({ snapshot: { ...baseSnapshot, messages: [restored] } });
  useChatStore.getState().setBridge(replacement.bridge);
  await settle();
  host.emit(9, { type: 'assistant-thinking', id: restored.id, thinking: 'Old host', thinkingStatus: 'streaming', thinkingTruncated: false });
  assert.equal(useChatStore.getState().messages.at(-1).thinking, 'Restored summary');
});

test('thinking completion falls back safely for aborted and failed streams without final projection', () => {
  const emit = useChatStore.getState().handleEvent;
  for (const [id, ending, expected] of [
    ['aborted', { aborted: true }, 'interrupted'],
    ['failed', { errorMessage: 'Provider disconnected' }, 'error'],
    ['completed', {}, 'done'],
  ]) {
    emit({ type: 'assistant-start', id, order: 1 });
    emit({ type: 'assistant-thinking', id, thinking: 'Exposed partial', thinkingStatus: 'streaming', thinkingTruncated: false });
    emit({ type: 'assistant-end', id, text: '', ...ending });
    assert.equal(useChatStore.getState().messages.at(-1).thinkingStatus, expected);
    assert.equal(useChatStore.getState().messages.at(-1).thinking, 'Exposed partial');
  }
  emit({ type: 'assistant-start', id: 'ordinary', order: 2 });
  emit({ type: 'assistant-end', id: 'ordinary', text: 'Answer' });
  assert.equal(useChatStore.getState().messages.at(-1).thinkingStatus, undefined, 'ordinary models must not get invented thinking');
});

test('a fatal host status settles active thinking and tools while nonfatal errors preserve streaming', () => {
  const emit = useChatStore.getState().handleEvent;
  emit({ type: 'assistant-start', id: 'thinking-at-crash', order: 1 });
  emit({ type: 'assistant-thinking', id: 'thinking-at-crash', thinking: 'Exposed before crash', thinkingStatus: 'streaming', thinkingTruncated: false });
  emit({ type: 'tool', activity: { id: 'tool-at-crash', order: 2, tool: 'bash', title: 'Run tests', status: 'running', detail: 'Partial result' } });
  emit({ type: 'error', message: 'A queued prompt was rejected' });
  assert.equal(useChatStore.getState().messages[0].status, 'streaming');
  assert.equal(useChatStore.getState().messages[0].thinkingStatus, 'streaming');
  assert.equal(useChatStore.getState().activities[0].status, 'running');
  emit({ type: 'status', status: 'error', message: 'Pi host exited' });
  emit({ type: 'error', message: 'Pi host exited' });
  const state = useChatStore.getState();
  assert.equal(state.messages[0].status, 'error');
  assert.equal(state.messages[0].thinkingStatus, 'error');
  assert.equal(state.messages[0].thinking, 'Exposed before crash');
  assert.equal(state.messages[0].errorMessage, 'Pi host exited');
  assert.equal(state.activities[0].status, 'interrupted');
  assert.equal(state.activities[0].detail, 'Partial result');
  emit({ type: 'assistant-thinking', id: 'thinking-at-crash', thinking: 'Delayed update', thinkingStatus: 'streaming', thinkingTruncated: false });
  assert.equal(useChatStore.getState().messages[0].thinkingStatus, 'error', 'a stale partial cannot resume a failed message');
});

test('the selected model display name is present before catalog loading and follows model/session changes', async () => {
  const host = createBridge({ snapshot: { ...baseSnapshot, modelName: 'Friendly Model Name' } });
  useChatStore.getState().setBridge(host.bridge); await settle();
  assert.equal(useChatStore.getState().modelName, 'Friendly Model Name');
  assert.deepEqual(useChatStore.getState().models, []);
  await useChatStore.getState().refreshModels();
  assert.equal(useChatStore.getState().modelName, 'Friendly Model Name', 'opening the catalog must not change the selected display name');
  host.emit(2, { ...baseSnapshot, type: 'model', model: 'next-model', modelName: 'Next Friendly Name' });
  assert.equal(useChatStore.getState().modelName, 'Next Friendly Name');
  host.emit(3, { type: 'reset', cwd: 'D:\\other-project' });
  assert.equal(useChatStore.getState().modelName, null);
  host.emit(4, { ...baseSnapshot, type: 'ready', modelName: 'Restored Model Name' });
  assert.equal(useChatStore.getState().modelName, 'Restored Model Name');
  host.emit(5, { ...baseSnapshot, type: 'model', model: 'legacy-model-without-name' });
  assert.equal(useChatStore.getState().modelName, null, 'older events without the field must not retain another model name');
});

test('model display names respect bootstrap event order and replacement bridge isolation', async () => {
  const pending = deferred(); const host = createBridge({ snapshot: pending.promise });
  useChatStore.getState().setBridge(host.bridge);
  host.emit(2, { ...baseSnapshot, type: 'model', model: 'newer-model', modelName: 'Newer Model' });
  pending.resolve({ ...baseSnapshot, modelName: 'Older Snapshot Model' }); await settle();
  assert.equal(useChatStore.getState().modelName, 'Newer Model');
  const replacementSnapshot = deferred(); const replacement = createBridge({ snapshot: replacementSnapshot.promise });
  useChatStore.getState().setBridge(replacement.bridge);
  assert.equal(useChatStore.getState().modelName, null);
  host.emit(3, { ...baseSnapshot, type: 'model', modelName: 'Old Host Name' });
  assert.equal(useChatStore.getState().modelName, null);
  replacementSnapshot.resolve({ ...baseSnapshot, modelName: 'Replacement Model' }); await settle();
  assert.equal(useChatStore.getState().modelName, 'Replacement Model');
});

test('context usage follows snapshots, newer events, model changes and session resets without shared references', async () => {
  const pending = deferred();
  const host = createBridge({ snapshot: pending.promise });
  useChatStore.getState().setBridge(host.bridge);
  const next = { tokens: 2200, contextWindow: 100000, percent: 2.2 };
  host.emit(2, { type: 'context-usage', contextUsage: next });
  pending.resolve(baseSnapshot);
  await settle();
  assert.deepEqual(useChatStore.getState().contextUsage, next);
  next.tokens = 999;
  assert.equal(useChatStore.getState().contextUsage.tokens, 2200);

  host.emit(3, { ...baseSnapshot, type: 'model', contextUsage: { tokens: 2200, contextWindow: 200000, percent: 1.1 } });
  assert.equal(useChatStore.getState().contextUsage.contextWindow, 200000);
  host.emit(4, { type: 'context-usage', contextUsage: { tokens: null, contextWindow: 200000, percent: null } });
  assert.equal(useChatStore.getState().contextUsage.tokens, null, 'post-compaction usage must stay unknown, not zero');
  host.emit(5, { type: 'reset', cwd: baseSnapshot.cwd });
  assert.equal(useChatStore.getState().contextUsage, null);
  const restored = { tokens: 4000, contextWindow: 500000, percent: 0.8 };
  host.emit(6, { ...baseSnapshot, type: 'ready', contextUsage: restored });
  restored.tokens = 999;
  assert.equal(useChatStore.getState().contextUsage.tokens, 4000);

  const fresh = createBridge({ snapshot: { ...baseSnapshot, contextUsage: null } });
  useChatStore.getState().setBridge(fresh.bridge);
  await settle();
  host.emit(7, { type: 'context-usage', contextUsage: next });
  assert.equal(useChatStore.getState().contextUsage, null, 'old host usage cannot leak into the replacement bridge');
});

test('the store owns a copy of context usage from the startup snapshot', async () => {
  const snapshot = { ...baseSnapshot, contextUsage: { ...baseSnapshot.contextUsage } };
  const host = createBridge({ snapshot });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  snapshot.contextUsage.tokens = 0;
  assert.equal(useChatStore.getState().contextUsage.tokens, 1200);
});

test('replacing the bridge unsubscribes old events and ignores its late snapshot', async () => {
  const oldSnapshot = deferred();
  const oldHost = createBridge({ snapshot: oldSnapshot.promise });
  const newHost = createBridge({ snapshot: { ...baseSnapshot, cwd: 'D:\\new-workspace', sessionId: 'new-session' } });
  useChatStore.getState().setBridge(oldHost.bridge);
  assert.equal(oldHost.listenerCount, 1);
  useChatStore.getState().setBridge(newHost.bridge);
  assert.equal(oldHost.listenerCount, 0);
  await settle();

  oldHost.emit(50, { type: 'status', status: 'error', message: 'stale event' });
  oldSnapshot.resolve({ ...baseSnapshot, status: 'error', cwd: 'C:\\old-workspace' });
  await settle();

  assert.equal(useChatStore.getState().cwd, 'D:\\new-workspace');
  assert.equal(useChatStore.getState().status, 'idle');
  assert.equal(useChatStore.getState().sessionId, 'new-session');
});

test('idle refresh runs on state transitions but not repeated idle events', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  assert.deepEqual(host.sessionListCalls, [baseSnapshot.cwd]);

  host.emit(2, { type: 'status', status: 'idle' });
  assert.equal(host.sessionListCalls.length, 1);
  host.emit(3, { type: 'status', status: 'busy' });
  host.emit(4, { type: 'status', status: 'idle' });
  host.emit(5, { type: 'status', status: 'idle' });
  await settle();
  assert.equal(host.sessionListCalls.length, 2);
});

test('startup initialization loads existing sessions after the first idle event', async () => {
  const savedSession = { path: 'saved.jsonl', id: 'saved', firstMessage: 'Earlier conversation', modified: new Date().toISOString(), messageCount: 1 };
  const host = createBridge({
    snapshot: { ...baseSnapshot, status: 'uninitialized', cwd: '', sessionId: null, sessionPath: null },
    sessionsByCwd: { [baseSnapshot.cwd]: [savedSession] },
  });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  assert.deepEqual(host.sessionListCalls, []);

  host.emit(2, { type: 'reset', cwd: baseSnapshot.cwd });
  host.emit(3, { type: 'status', status: 'starting' });
  host.emit(4, {
    type: 'ready', cwd: baseSnapshot.cwd, sessionId: baseSnapshot.sessionId, sessionPath: baseSnapshot.sessionPath,
    model: baseSnapshot.model, modelProvider: baseSnapshot.modelProvider,
    thinkingLevel: baseSnapshot.thinkingLevel, availableThinkingLevels: baseSnapshot.availableThinkingLevels,
    messages: [], activities: [],
  });
  host.emit(5, { type: 'status', status: 'idle' });
  await settle();
  assert.deepEqual(host.sessionListCalls, [baseSnapshot.cwd]);
  assert.deepEqual(useChatStore.getState().sessions, [savedSession]);
});

test('startup stays hidden until restored history and a usable session are both available', async () => {
  const host = createBridge({
    snapshot: { ...baseSnapshot, status: 'uninitialized', sessionId: null, sessionPath: null },
  });
  useChatStore.getState().setBridge(host.bridge);
  assert.equal(selectStartupReady(useChatStore.getState()), false);
  await settle();
  assert.equal(selectStartupReady(useChatStore.getState()), false);

  // An idle status alone does not prove that the previous conversation was loaded.
  host.emit(2, { type: 'status', status: 'idle' });
  assert.equal(selectStartupReady(useChatStore.getState()), false);
  host.emit(3, { type: 'status', status: 'starting' });
  const history = [{ id: 'restored', order: 1, role: 'user', text: 'Earlier conversation', status: 'done' }];
  host.emit(4, { ...baseSnapshot, type: 'ready', messages: history });
  assert.equal(selectStartupReady(useChatStore.getState()), false);
  host.emit(5, { type: 'status', status: 'idle' });
  assert.equal(selectStartupReady(useChatStore.getState()), true);
  assert.deepEqual(useChatStore.getState().messages, history);
});

test('startup readiness uses the synchronized snapshot and replays a newer reset before showing', async () => {
  const snapshot = deferred();
  const host = createBridge({ snapshot: snapshot.promise });
  useChatStore.getState().setBridge(host.bridge);
  host.emit(2, { type: 'reset', cwd: baseSnapshot.cwd });
  host.emit(3, { type: 'status', status: 'starting' });
  snapshot.resolve(baseSnapshot);
  await settle();
  assert.equal(selectStartupReady(useChatStore.getState()), false);
  assert.equal(useChatStore.getState().sessionId, null);

  const history = [{ id: 'restored', order: 1, role: 'assistant', text: 'Restored answer', status: 'done' }];
  host.emit(4, { ...baseSnapshot, type: 'ready', messages: history });
  host.emit(5, { type: 'status', status: 'busy' });
  assert.equal(selectStartupReady(useChatStore.getState()), true);
  assert.deepEqual(useChatStore.getState().messages, history);
});

test('startup reveals a synchronized existing session and recoverable initialization errors', async () => {
  const history = [{ id: 'restored', order: 1, role: 'user', text: 'Earlier conversation', status: 'done' }];
  const host = createBridge({ snapshot: { ...baseSnapshot, messages: history } });
  useChatStore.getState().setBridge(host.bridge);
  assert.equal(selectStartupReady(useChatStore.getState()), false);
  await settle();
  assert.equal(selectStartupReady(useChatStore.getState()), true);
  assert.deepEqual(useChatStore.getState().messages, history);

  const failedHost = createBridge({ onSnapshot: async () => { throw new Error('snapshot unavailable'); } });
  useChatStore.getState().setBridge(failedHost.bridge);
  assert.equal(selectStartupReady(useChatStore.getState()), false);
  await settle();
  assert.equal(selectStartupReady(useChatStore.getState()), true);
  assert.equal(useChatStore.getState().error, 'snapshot unavailable');
  assert.equal(useChatStore.getState().sessionId, null);
});

test('late session lists from an old bridge do not replace new data', async () => {
  const oldList = deferred();
  const oldHost = createBridge({ onListSessions: () => oldList.promise });
  useChatStore.getState().setBridge(oldHost.bridge);
  await settle();
  assert.equal(oldHost.sessionListCalls.length, 1);

  const currentSession = { path: 'new.jsonl', id: 'new', firstMessage: 'new', modified: new Date().toISOString(), messageCount: 1 };
  const newHost = createBridge({ sessionsByCwd: { [baseSnapshot.cwd]: [currentSession] } });
  useChatStore.getState().setBridge(newHost.bridge);
  await settle();
  oldList.resolve([{ ...currentSession, path: 'old.jsonl', id: 'old' }]);
  await settle();

  assert.deepEqual(useChatStore.getState().sessions, [currentSession]);
});

test('snapshot and push events converge when they interleave during startup', async () => {
  const pending = deferred();
  const snapshot = {
    ...baseSnapshot,
    sequence: 11,
    messages: [
      { id: 'user-1', role: 'user', text: 'hi', status: 'done' },
      { id: 'assistant-1', role: 'assistant', text: 'Hello', status: 'streaming' },
    ],
  };
  const host = createBridge({ snapshot: pending.promise });
  useChatStore.getState().setBridge(host.bridge);

  // A replayed event is already in the snapshot. A newer delta must survive.
  host.emit(10, { type: 'user-message', id: 'user-1', text: 'hi' });
  host.emit(12, { type: 'assistant-delta', id: 'assistant-1', delta: ' world' });
  host.emit(13, { type: 'status', status: 'busy' });
  pending.resolve(snapshot);
  await settle();

  const state = useChatStore.getState();
  assert.equal(state.status, 'busy');
  assert.equal(state.model, 'test-model');
  assert.equal(state.cwd, 'C:\\workspace');
  assert.equal(state.sessionId, 'session-1');
  assert.deepEqual(state.messages.map(({ id, text }) => ({ id, text })), [
    { id: 'user-1', text: 'hi' },
    { id: 'assistant-1', text: 'Hello world' },
  ]);

  host.emit(14, { type: 'assistant-end', id: 'assistant-1', text: 'Hello world' });
  host.emit(15, { type: 'status', status: 'idle' });
  assert.equal(useChatStore.getState().status, 'idle');
  assert.equal(useChatStore.getState().messages[1].status, 'done');
});

test('bootstrap resynchronizes after its bounded event buffer overflows', async () => {
  const firstSnapshot = deferred();
  const freshMessage = { id: 'fresh-user', order: 1, role: 'user', text: 'current state', status: 'done' };
  let calls = 0;
  const host = createBridge({
    onSnapshot: () => ++calls === 1
      ? firstSnapshot.promise
      : Promise.resolve({ ...baseSnapshot, sequence: 400, messages: [freshMessage] }),
  });
  useChatStore.getState().setBridge(host.bridge);
  for (let sequence = 2; sequence <= 300; sequence += 1) {
    host.emit(sequence, { type: 'status', status: 'busy' });
  }
  firstSnapshot.resolve(baseSnapshot);
  await settle();
  await settle();

  assert.equal(host.snapshotCalls, 2);
  assert.deepEqual(useChatStore.getState().messages, [freshMessage]);
  assert.equal(useChatStore.getState().status, 'idle');
});

test('streaming deltas keep timeline structure stable while new rows advance it', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  host.emit(2, { type: 'assistant-start', id: 'assistant-2', order: 1 });
  const startedRevision = useChatStore.getState().timelineRevision;
  host.emit(3, { type: 'assistant-delta', id: 'assistant-2', delta: 'one' });
  host.emit(4, { type: 'assistant-delta', id: 'assistant-2', delta: ' two' });
  assert.equal(useChatStore.getState().timelineRevision, startedRevision);
  host.emit(5, { type: 'tool', activity: { id: 'tool-1', order: 2, tool: 'read', title: 'file', status: 'running' } });
  assert.equal(useChatStore.getState().timelineRevision, startedRevision + 1);
  host.emit(6, { type: 'tool', activity: { id: 'tool-1', order: 2, tool: 'read', title: 'file', status: 'done' } });
  assert.equal(useChatStore.getState().timelineRevision, startedRevision + 1);
});

test('agent retry uses the current workspace and returns to idle on ready events', async () => {
  let host;
  host = createBridge({
    snapshot: { ...baseSnapshot, status: 'error', error: 'startup failed' },
    onInitAgent: async (cwd) => {
      host.emit(2, { type: 'reset', cwd });
      host.emit(3, { type: 'ready', model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'medium', availableThinkingLevels: ['off', 'low', 'medium', 'high'], cwd, sessionId: 'recovered', sessionPath: 'recovered.jsonl', messages: [], activities: [] });
      host.emit(4, { type: 'status', status: 'idle' });
    },
  });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await useChatStore.getState().retryAgent();
  assert.deepEqual(host.initCalls, [baseSnapshot.cwd]);
  assert.equal(useChatStore.getState().status, 'idle');
  assert.equal(useChatStore.getState().sessionId, 'recovered');
});

test('busy send queues a Pi follow-up, while explicit steer and idle prompt keep their semantics', async () => {
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'busy' } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  await useChatStore.getState().send('  next task  ');
  await useChatStore.getState().send('change direction', 'steer');
  host.emit(2, { type: 'status', status: 'idle' });
  await useChatStore.getState().send('ordinary task');

  assert.deepEqual(host.prompts, [
    ['next task', 'followUp'],
    ['change direction', 'steer'],
    ['ordinary task', undefined],
  ]);
});

test('queued instructions hydrate from the host snapshot and disappear only when the SDK consumes them', async () => {
  const queued = [
    { id: 'steer-1', text: '先检查错误处理', behavior: 'steer' },
    { id: 'follow-1', text: '然后补充文档', behavior: 'followUp', attachments: [{ kind: 'image', name: 'screen.png', mimeType: 'image/png' }] },
  ];
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'busy', queuedCount: 2, queuedMessages: queued } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  assert.deepEqual(useChatStore.getState().queuedMessages, queued);
  host.emit(2, { type: 'queue', count: 1, items: [queued[1]] });
  assert.deepEqual(useChatStore.getState().queuedMessages, [queued[1]]);
  assert.equal(useChatStore.getState().queuedCount, 1);
  host.emit(3, { type: 'status', status: 'idle' });
  assert.deepEqual(useChatStore.getState().queuedMessages, [queued[1]], 'stopping a task does not pretend the SDK queue was cleared');
  host.emit(4, { type: 'queue', count: 0, items: [] });
  assert.deepEqual(useChatStore.getState().queuedMessages, []);
  assert.equal(useChatStore.getState().queuedCount, 0);
});

test('pending instructions do not leak across session or bridge replacement', async () => {
  const oldItem = { id: 'old-queue', text: 'only for the old session', behavior: 'followUp' };
  const newItem = { id: 'new-queue', text: 'only for the new session', behavior: 'steer' };
  const oldHost = createBridge({ snapshot: { ...baseSnapshot, queuedCount: 1, queuedMessages: [oldItem] } });
  useChatStore.getState().setBridge(oldHost.bridge);
  await settle();
  oldHost.emit(2, { type: 'ready', model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'off', availableThinkingLevels: ['off'], cwd: baseSnapshot.cwd, sessionId: 'session-2', sessionPath: 'two.jsonl', messages: [], activities: [] });
  assert.deepEqual(useChatStore.getState().queuedMessages, []);
  oldHost.emit(3, { type: 'queue', count: 1, items: [newItem] });
  assert.deepEqual(useChatStore.getState().queuedMessages, [newItem]);
  oldHost.emit(4, { type: 'reset', cwd: 'C:\\other-project' });
  assert.deepEqual(useChatStore.getState().queuedMessages, []);
  const replacement = createBridge();
  useChatStore.getState().setBridge(replacement.bridge);
  await settle();
  oldHost.emit(5, { type: 'queue', count: 1, items: [oldItem] });
  assert.deepEqual(useChatStore.getState().queuedMessages, []);
});

test('a rejected queued send leaves both the real queue and the user timeline unchanged', async () => {
  const queued = { id: 'existing', text: 'already queued', behavior: 'followUp' };
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'busy', queuedCount: 1, queuedMessages: [queued] }, onPrompt: async () => { throw new Error('queue rejected'); } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await assert.rejects(useChatStore.getState().send('new instruction'), /queue rejected/);
  assert.deepEqual(useChatStore.getState().queuedMessages, [queued]);
  assert.equal(useChatStore.getState().queuedCount, 1);
  assert.deepEqual(useChatStore.getState().messages, []);
});

test('prompt rejection reaches the caller and remains visible in store state', async () => {
  const host = createBridge({
    onPrompt: async () => {
      throw new Error('provider unavailable');
    },
  });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  await assert.rejects(useChatStore.getState().send('help'), /provider unavailable/);
  assert.equal(useChatStore.getState().error, 'provider unavailable');
  assert.deepEqual(host.prompts, [['help', undefined]]);
});

test('slash commands use the command dispatcher with session identity and delivery mode, while paths remain prompts', async () => {
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'busy' } });
  const commands = [];
  host.bridge.executeSlashCommand = async (request) => { commands.push(request); };
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const attachments = [{ kind: 'text', name: 'notes', mimeType: 'text/plain', text: 'context' }];
  await useChatStore.getState().send('/skill:review src/a.ts\n检查错误处理', undefined, attachments);
  await useChatStore.getState().send('/review urgent', 'steer');
  await useChatStore.getState().send('/src/file.ts');
  assert.deepEqual(commands, [
    { cwd: baseSnapshot.cwd, sessionId: baseSnapshot.sessionId, name: 'skill:review', args: 'src/a.ts\n检查错误处理', behavior: 'followUp', attachments },
    { cwd: baseSnapshot.cwd, sessionId: baseSnapshot.sessionId, name: 'review', args: 'urgent', behavior: 'steer', attachments: undefined },
  ]);
  assert.deepEqual(host.prompts, [['/src/file.ts', 'followUp']]);
});

test('a rejected slash command preserves the error without sending to the model or affecting a replacement session', async () => {
  const pending = deferred();
  const host = createBridge();
  host.bridge.executeSlashCommand = async () => { throw new Error('未知指令'); };
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await assert.rejects(useChatStore.getState().send('/unknown'), /未知指令/);
  assert.equal(useChatStore.getState().error, '未知指令');
  assert.deepEqual(host.prompts, []);
  host.bridge.executeSlashCommand = () => pending.promise;
  const sent = useChatStore.getState().send('/name changed');
  const replacement = createBridge({ snapshot: { ...baseSnapshot, sessionId: 'new-session' } });
  useChatStore.getState().setBridge(replacement.bridge);
  await settle();
  pending.reject(new Error('old session error'));
  await assert.rejects(sent, /old session error/);
  assert.equal(useChatStore.getState().error, null);
});

test('assistant message failure is marked as an error with its cause', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  host.emit(2, { type: 'assistant-start', id: 'assistant-2' });
  host.emit(3, {
    type: 'assistant-end',
    id: 'assistant-2',
    text: '',
    errorMessage: 'model returned an error',
  });

  const state = useChatStore.getState();
  assert.equal(state.messages[0].status, 'error');
  assert.equal(state.messages[0].errorMessage, 'model returned an error');
  assert.equal(state.error, 'model returned an error');
});

test('model and credential settings use the bridge without retaining the API key in state', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  await useChatStore.getState().refreshModels();
  await useChatStore.getState().refreshProviderAuth();
  await useChatStore.getState().setModel('test-provider', 'next-model');
  await useChatStore.getState().setThinkingLevel('high');
  await useChatStore.getState().setProviderApiKey('test-provider', '  sample-secret  ');
  await useChatStore.getState().removeProviderCredential('test-provider');

  const state = useChatStore.getState();
  assert.equal(state.models[0].id, 'next-model');
  assert.equal(state.model, 'next-model');
  assert.equal(state.thinkingLevel, 'high');
  assert.equal(state.settingsLoading, false);
  assert.deepEqual(host.settingsCalls, [
    ['model', 'test-provider', 'next-model'],
    ['thinking', 'high'],
    ['api-key', 'test-provider', 'sample-secret'],
    ['remove-key', 'test-provider'],
  ]);
  assert.equal(JSON.stringify(state).includes('sample-secret'), false);
});

test('workspace reset ignores late settings reads and preserves the new loading state', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const oldModels = deferred();
  const oldAuth = deferred();
  host.bridge.listModels = () => oldModels.promise;
  host.bridge.listProviderAuth = () => oldAuth.promise;
  const oldReads = [useChatStore.getState().refreshModels(), useChatStore.getState().refreshProviderAuth()];

  host.emit(2, { type: 'reset', cwd: 'D:\\new-project' });
  assert.equal(useChatStore.getState().settingsLoading, false);
  const newModels = deferred();
  host.bridge.listModels = () => newModels.promise;
  const newRead = useChatStore.getState().refreshModels();
  oldModels.resolve([{ id: 'old-model' }]);
  oldAuth.resolve([{ provider: 'old-provider', configured: true }]);
  await Promise.all(oldReads);
  assert.deepEqual(useChatStore.getState().models, []);
  assert.deepEqual(useChatStore.getState().providerAuth, []);
  assert.equal(useChatStore.getState().settingsLoading, true);

  newModels.resolve([{ id: 'current-model' }]);
  await newRead;
  assert.deepEqual(useChatStore.getState().models, [{ id: 'current-model' }]);
  assert.equal(useChatStore.getState().settingsLoading, false);
});

test('custom provider mutations refresh both settings and composer catalogs without retaining the submitted key', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const customModel = { provider: 'custom', id: 'chat', name: 'Custom Chat', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 };
  const custom = { provider: 'custom', name: 'Custom', custom: true, editable: true, configured: true, baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [customModel] };
  let saved = false;
  let payload;
  host.bridge.saveCustomProvider = async (request) => { payload = request; saved = true; };
  host.bridge.removeCustomProvider = async (provider) => { assert.equal(provider, 'custom'); saved = false; };
  host.bridge.listModelProviders = async () => saved ? [custom] : [];
  host.bridge.listModels = async () => saved ? [customModel] : [];
  host.bridge.listProviderAuth = async () => saved ? [{ provider: 'custom', configured: true, source: 'stored', supportsApiKey: true }] : [];
  const request = { provider: 'custom', name: 'Custom', api: 'openai-completions', baseUrl: custom.baseUrl, apiKey: 'test-only-private-key', models: [{ id: 'chat' }], mode: 'create' };
  await useChatStore.getState().saveCustomProvider(request);
  assert.deepEqual(payload, request);
  assert.deepEqual(useChatStore.getState().models, [customModel]);
  assert.deepEqual(useChatStore.getState().modelProviders, [custom]);
  assert.equal(useChatStore.getState().providerAuth[0].configured, true);
  assert.equal(JSON.stringify(useChatStore.getState()).includes(request.apiKey), false);
  await useChatStore.getState().removeCustomProvider('custom');
  assert.deepEqual(useChatStore.getState().models, []);
  assert.deepEqual(useChatStore.getState().modelProviders, []);
  assert.deepEqual(useChatStore.getState().providerAuth, []);
  assert.equal(useChatStore.getState().settingsLoading, false);
});

test('obsolete provider reads and mutation completions cannot overwrite a replacement bridge', async () => {
  const oldHost = createBridge();
  useChatStore.getState().setBridge(oldHost.bridge);
  await settle();
  const oldRead = deferred();
  const oldWrite = deferred();
  oldHost.bridge.listModelProviders = () => oldRead.promise;
  oldHost.bridge.saveCustomProvider = () => oldWrite.promise;
  const reading = useChatStore.getState().refreshModelProviders();
  const saving = useChatStore.getState().saveCustomProvider({ provider: 'old' });
  const newHost = createBridge();
  useChatStore.getState().setBridge(newHost.bridge);
  await settle();
  await useChatStore.getState().refreshModelProviders();
  const fresh = useChatStore.getState().modelProviders;
  let extraReads = 0;
  newHost.bridge.listModelProviders = async () => { extraReads += 1; return []; };
  oldRead.resolve([{ provider: 'obsolete' }]);
  oldWrite.resolve();
  await Promise.all([reading, saving]);
  assert.equal(extraReads, 0, 'old mutation must not start reads against the new host');
  assert.deepEqual(useChatStore.getState().modelProviders, fresh);
  assert.equal(useChatStore.getState().settingsLoading, false);
  assert.equal(useChatStore.getState().settingsError, null);
});

test('failed custom provider save retains the previous catalog and reports the failure', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await useChatStore.getState().refreshModelProviders();
  const previous = useChatStore.getState().modelProviders;
  host.bridge.saveCustomProvider = async () => { throw new Error('Provider already exists'); };
  await assert.rejects(useChatStore.getState().saveCustomProvider({ provider: 'duplicate' }), /already exists/);
  assert.deepEqual(useChatStore.getState().modelProviders, previous);
  assert.equal(useChatStore.getState().settingsLoading, false);
  assert.equal(useChatStore.getState().settingsError, 'Provider already exists');
});

test('replacing a bridge immediately disables sending and ignores old settings failures', async () => {
  const oldHost = createBridge();
  useChatStore.getState().setBridge(oldHost.bridge);
  await settle();
  const oldModels = deferred();
  oldHost.bridge.listModels = () => oldModels.promise;
  const oldRead = useChatStore.getState().refreshModels();
  const rejection = assert.rejects(oldRead, /old host unavailable/);
  const newSnapshot = deferred();
  const newHost = createBridge({ snapshot: newSnapshot.promise });
  useChatStore.getState().setBridge(newHost.bridge);
  assert.equal(useChatStore.getState().status, 'uninitialized');
  assert.equal(useChatStore.getState().cwd, '');
  assert.equal(useChatStore.getState().settingsLoading, false);
  await assert.rejects(useChatStore.getState().send('wait for the new host'));
  assert.deepEqual(newHost.prompts, []);

  oldModels.reject(new Error('old host unavailable'));
  await rejection;
  assert.equal(useChatStore.getState().settingsError, null);
  newSnapshot.resolve(baseSnapshot);
  await settle();
  assert.equal(useChatStore.getState().status, 'idle');
});

test('overlapping settings refreshes retain the newest model and credential lists', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const oldModels = deferred();
  const oldAuth = deferred();
  host.bridge.listModels = () => oldModels.promise;
  host.bridge.listProviderAuth = () => oldAuth.promise;
  const oldReads = [useChatStore.getState().refreshModels(), useChatStore.getState().refreshProviderAuth()];
  host.bridge.listModels = async () => [{ id: 'fresh-model' }];
  host.bridge.listProviderAuth = async () => [{ provider: 'fresh-provider', configured: true }];
  await Promise.all([useChatStore.getState().refreshModels(), useChatStore.getState().refreshProviderAuth()]);
  oldModels.resolve([{ id: 'stale-model' }]);
  oldAuth.resolve([{ provider: 'fresh-provider', configured: false }]);
  await Promise.all(oldReads);
  assert.deepEqual(useChatStore.getState().models, [{ id: 'fresh-model' }]);
  assert.deepEqual(useChatStore.getState().providerAuth, [{ provider: 'fresh-provider', configured: true }]);
  assert.equal(useChatStore.getState().settingsLoading, false);
});

test('failed obsolete session refresh does not overwrite a newer successful refresh', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const oldList = deferred();
  host.bridge.listSessions = () => oldList.promise;
  const oldRead = useChatStore.getState().refreshSessions();
  host.bridge.listSessions = async () => [{ id: 'fresh-session' }];
  await useChatStore.getState().refreshSessions();
  oldList.reject(new Error('obsolete read failed'));
  await oldRead;
  assert.deepEqual(useChatStore.getState().sessions, [{ id: 'fresh-session' }]);
  assert.equal(useChatStore.getState().error, null);
});

test('workspace session caches stay separate and attachments reach the prompt bridge', async () => {
  const otherCwd = 'D:\\other-project';
  const originalSession = { path: 'C:\\sessions\\one.jsonl', id: 'one', firstMessage: 'original', modified: new Date().toISOString(), messageCount: 2 };
  const otherSession = { path: 'D:\\sessions\\two.jsonl', id: 'two', firstMessage: 'other', modified: new Date().toISOString(), messageCount: 3 };
  const host = createBridge({
    workspaces: [baseSnapshot.cwd, otherCwd],
    sessionsByCwd: { [baseSnapshot.cwd]: [originalSession], [otherCwd]: [otherSession] },
  });
  useChatStore.getState().setBridge(host.bridge);
  await settle();

  await useChatStore.getState().refreshWorkspaceSessions(otherCwd);
  assert.deepEqual(useChatStore.getState().sessions, [originalSession]);
  assert.deepEqual(useChatStore.getState().sessionsByWorkspace[otherCwd], [otherSession]);

  await useChatStore.getState().switchWorkspace(otherCwd);
  assert.deepEqual(host.workspaceSwitches, [otherCwd]);
  assert.equal(useChatStore.getState().cwd, otherCwd);
  assert.deepEqual(useChatStore.getState().sessions, [otherSession]);
  assert.deepEqual(useChatStore.getState().sessionsByWorkspace[baseSnapshot.cwd], [originalSession]);

  const attachment = { kind: 'text', name: 'notes.md', mimeType: 'text/markdown', text: '# Notes' };
  await useChatStore.getState().send('review this', undefined, [attachment]);
  assert.deepEqual(host.prompts.at(-1), ['review this', undefined, [attachment]]);
});

test('obsolete navigation failures cannot overwrite a newer request or clear its pending flag', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const oldSwitch = deferred(); const newSwitch = deferred();
  host.bridge.switchSession = (path) => path === 'old' ? oldSwitch.promise : newSwitch.promise;
  const old = useChatStore.getState().switchSession('old');
  const failed = assert.rejects(old, /old switch failed/);
  const newer = useChatStore.getState().switchSession('new');
  oldSwitch.reject(new Error('old switch failed'));
  await failed;
  assert.equal(useChatStore.getState().error, null);
  assert.equal(useChatStore.getState().navigationPending, true);
  newSwitch.resolve(); await newer;
  assert.equal(useChatStore.getState().navigationPending, false);
  assert.equal(useChatStore.getState().navigationRequestId, 2);
});

test('a late workspace picker result cannot replace a newer user session selection', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const picker = deferred(); host.bridge.pickWorkspace = () => picker.promise;
  const picking = useChatStore.getState().pickWorkspace();
  await useChatStore.getState().switchSession('newer');
  picker.resolve('D:\\obsolete-workspace'); await picking;
  assert.deepEqual(host.workspaceSwitches, []);
  assert.equal(useChatStore.getState().navigationPending, false);
});

test('the new slash command supersedes older navigation and clears its own pending state on failure', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const oldSwitch = deferred(); host.bridge.switchSession = () => oldSwitch.promise;
  const older = useChatStore.getState().switchSession('older');
  const command = deferred(); host.bridge.executeSlashCommand = () => command.promise;
  const sending = useChatStore.getState().send('/new');
  const rejection = assert.rejects(sending, /new session failed/);
  assert.equal(useChatStore.getState().navigationRequestId, 2);
  assert.equal(useChatStore.getState().navigationPending, true);
  oldSwitch.resolve(); await older;
  assert.equal(useChatStore.getState().navigationPending, true, 'the older switch cannot finish the slash command intent');
  command.reject(new Error('new session failed')); await rejection;
  assert.equal(useChatStore.getState().navigationPending, false);
  assert.equal(useChatStore.getState().error, 'new session failed');
});

test('late workspace list and session refresh failures do not leak into a newer navigation', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const workspaces = deferred(); const sessions = deferred();
  host.bridge.listWorkspaces = () => workspaces.promise;
  host.bridge.listSessions = () => sessions.promise;
  const oldReads = [useChatStore.getState().refreshWorkspaces(), useChatStore.getState().refreshWorkspaceSessions('D:\\old-workspace')];
  host.bridge.listSessions = async () => [];
  await useChatStore.getState().switchSession('newer');
  workspaces.reject(new Error('old workspace list failed')); sessions.reject(new Error('old session list failed'));
  await Promise.all(oldReads);
  assert.equal(useChatStore.getState().error, null);
});

test('session metadata refresh keeps its original workspace when a draft was not yet in the session cache', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const mutation = deferred(); host.bridge.updateSessionMeta = () => mutation.promise;
  const editing = useChatStore.getState().updateSessionMeta(baseSnapshot.sessionPath, { name: 'Original draft' });
  await useChatStore.getState().switchWorkspace('D:\\other-project');
  const refreshed = [];
  host.bridge.listSessions = async (cwd) => { refreshed.push(cwd); throw new Error('old workspace refresh failed'); };
  mutation.resolve(); await editing;
  assert.deepEqual(refreshed, [baseSnapshot.cwd], 'the owner is captured before switching away from an uncached draft');
  assert.equal(useChatStore.getState().cwd, 'D:\\other-project');
  assert.equal(useChatStore.getState().error, null);
});

test('session metadata failures remain local and obsolete bridge edits cannot refresh the replacement host', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  host.bridge.updateSessionMeta = async () => { throw new Error('rename failed'); };
  await assert.rejects(useChatStore.getState().updateSessionMeta(baseSnapshot.sessionPath, { name: 'Draft' }), /rename failed/);
  assert.equal(useChatStore.getState().error, null);
  const mutation = deferred(); host.bridge.updateSessionMeta = () => mutation.promise;
  const editing = useChatStore.getState().updateSessionMeta(baseSnapshot.sessionPath, { name: 'Old host' });
  const replacement = createBridge();
  useChatStore.getState().setBridge(replacement.bridge); await settle();
  const calls = replacement.sessionListCalls.length;
  mutation.resolve(); await editing;
  assert.equal(replacement.sessionListCalls.length, calls);
  assert.equal(useChatStore.getState().error, null);
});

test('a retry waiting for workspace discovery cannot initialize after a newer navigation', async () => {
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'error', cwd: '', sessionId: null, sessionPath: null }, workspaces: [] });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const workspaces = deferred();
  host.bridge.listWorkspaces = () => workspaces.promise;
  const retry = useChatStore.getState().retryAgent();
  assert.equal(useChatStore.getState().status, 'starting');
  assert.equal(useChatStore.getState().navigationPending, true);
  await useChatStore.getState().retryAgent();
  host.bridge.listWorkspaces = async () => ['D:\\selected'];
  await useChatStore.getState().switchWorkspace('D:\\selected');
  workspaces.resolve(['C:\\obsolete']);
  await retry;
  assert.deepEqual(host.initCalls, []);
  assert.equal(useChatStore.getState().cwd, 'D:\\selected');
  assert.equal(useChatStore.getState().status, 'idle');
  assert.equal(useChatStore.getState().navigationPending, false);
});

test('obsolete retry failures cannot turn a replacement bridge into an error', async () => {
  const pending = deferred();
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'error' }, onInitAgent: () => pending.promise });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const retry = useChatStore.getState().retryAgent();
  const replacement = createBridge();
  useChatStore.getState().setBridge(replacement.bridge);
  await settle();
  pending.reject(new Error('obsolete retry failure'));
  await retry;
  assert.equal(useChatStore.getState().status, 'idle');
  assert.equal(useChatStore.getState().error, null);
});

test('a current retry failure remains actionable and releases navigation state', async () => {
  const host = createBridge({ snapshot: { ...baseSnapshot, status: 'error' }, onInitAgent: async () => { throw new Error('retry failed'); } });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await assert.rejects(useChatStore.getState().retryAgent(), /retry failed/);
  assert.equal(useChatStore.getState().status, 'error');
  assert.equal(useChatStore.getState().error, 'retry failed');
  assert.equal(useChatStore.getState().navigationPending, false);
});

test('an abort failure cannot overwrite a newer session while current abort failures stay visible', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const pending = deferred();
  host.bridge.abort = () => pending.promise;
  const aborting = useChatStore.getState().abort();
  await useChatStore.getState().switchSession('newer');
  pending.reject(new Error('obsolete abort failure'));
  await aborting;
  assert.equal(useChatStore.getState().error, null);
  host.bridge.abort = async () => { throw new Error('current abort failure'); };
  await useChatStore.getState().abort();
  assert.equal(useChatStore.getState().error, 'current abort failure');
});

test('out-of-order workspace refreshes retain the latest list and ignore obsolete failures', async () => {
  for (const outcome of ['success', 'failure']) {
    const host = createBridge();
    useChatStore.getState().setBridge(host.bridge);
    await settle();
    const pending = deferred();
    host.bridge.listWorkspaces = () => pending.promise;
    const older = useChatStore.getState().refreshWorkspaces();
    host.bridge.listWorkspaces = async () => [baseSnapshot.cwd, 'D:\\new-project'];
    await useChatStore.getState().refreshWorkspaces();
    if (outcome === 'success') pending.resolve([baseSnapshot.cwd]);
    else pending.reject(new Error('obsolete workspace list failure'));
    await older;
    assert.deepEqual(useChatStore.getState().workspaces, [baseSnapshot.cwd, 'D:\\new-project'], outcome);
    assert.equal(useChatStore.getState().error, null, outcome);
  }
});

test('selecting the current workspace supersedes an in-flight switch to another workspace', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const first = deferred();
  const second = deferred();
  const calls = [];
  host.bridge.switchWorkspace = (cwd) => { calls.push(cwd); return calls.length === 1 ? first.promise : second.promise; };
  const leaving = useChatStore.getState().switchWorkspace('D:\\other-project');
  const staying = useChatStore.getState().switchWorkspace(baseSnapshot.cwd);
  assert.deepEqual(calls, ['D:\\other-project', baseSnapshot.cwd]);
  first.resolve();
  await leaving;
  assert.equal(useChatStore.getState().navigationPending, true, 'the superseded switch must not finish the newer request');
  second.resolve();
  await staying;
  assert.equal(useChatStore.getState().navigationPending, false);
  await useChatStore.getState().switchWorkspace(baseSnapshot.cwd);
  assert.equal(calls.length, 2, 'selecting the settled current workspace remains a no-op');
});
