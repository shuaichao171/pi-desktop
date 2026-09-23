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
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createBridge({ snapshot = baseSnapshot, onPrompt, onListSessions, workspaces = ['C:\\workspace'], sessionsByCwd = {} } = {}) {
  const listeners = new Set();
  const prompts = [];
  const settingsCalls = [];
  const workspaceSwitches = [];
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
    initAgent: async () => {},
    listWorkspaces: async () => workspaces,
    switchWorkspace: async (cwd) => {
      workspaceSwitches.push(cwd);
      for (const listener of listeners) listener({ sequence: 20, event: { type: 'reset', cwd } });
      for (const listener of listeners) listener({ sequence: 21, event: { type: 'ready', model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'medium', availableThinkingLevels: ['off', 'low', 'medium', 'high'], cwd, sessionId: 'other-session', sessionPath: `${cwd}\\session.jsonl`, messages: [], activities: [] } });
      for (const listener of listeners) listener({ sequence: 22, event: { type: 'status', status: 'idle' } });
    },
    getAgentSnapshot: () => Promise.resolve(snapshot),
    listSessions: async (cwd) => {
      sessionListCalls.push(cwd);
      return onListSessions ? onListSessions(cwd) : sessionsByCwd[cwd ?? baseSnapshot.cwd] ?? [];
    },
    switchSession: async () => {},
    listModels: async () => models,
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
    sessionListCalls,
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
