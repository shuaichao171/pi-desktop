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

function createBridge({ snapshot = baseSnapshot, onPrompt } = {}) {
  const listeners = new Set();
  const prompts = [];
  const settingsCalls = [];
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
    getAgentSnapshot: () => Promise.resolve(snapshot),
    listSessions: async () => [],
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
    async prompt(text, behavior) {
      prompts.push([text, behavior]);
      await onPrompt?.(text, behavior);
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
    emit(sequence, event) {
      for (const listener of listeners) listener({ sequence, event });
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
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
