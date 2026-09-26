import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

function createBridge() {
  const editCalls = [];
  const listeners = new Set();
  const snapshot = {
    sequence: 1, status: 'idle', statusMessage: undefined,
    model: 'test-model', modelProvider: 'test-provider', thinkingLevel: 'medium',
    availableThinkingLevels: ['off', 'medium'], contextUsage: null,
    cwd: 'C:\\workspace', sessionId: 'session-1', sessionPath: 'C:\\sessions\\one.jsonl',
    messages: [
      { id: 'u1', order: 0, role: 'user', text: 'first question', status: 'done' },
      { id: 'a1', order: 1, role: 'assistant', text: 'first answer', status: 'done' },
      { id: 'u2', order: 2, role: 'user', text: 'second question', status: 'done' },
      { id: 'a2', order: 3, role: 'assistant', text: 'second answer', status: 'done' },
    ],
    activities: [], queuedCount: 0, historyTotal: 4, fileChanges: [], error: null,
  };
  return {
    editCalls,
    bridge: {
      getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform }),
      getAgentSnapshot: async () => snapshot,
      onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      listWorkspaces: async () => ['C:\\workspace'],
      listSessions: async () => [],
      editMessage: async (entryId, text) => { editCalls.push([entryId, text]); },
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('regenerate rewinds to the latest user message and resends it verbatim', async () => {
  const host = createBridge();
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await useChatStore.getState().regenerate();
  assert.deepEqual(host.editCalls, [['u2', 'second question']]);
});

test('regenerate rejects when the transcript has no user turn', async () => {
  const host = createBridge();
  host.bridge.getAgentSnapshot = async () => ({ ...createBridge().bridge.getAgentSnapshot(), messages: [
    { id: 'a1', order: 1, role: 'assistant', text: 'only reply', status: 'done' },
  ] });
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  await assert.rejects(() => useChatStore.getState().regenerate());
  assert.deepEqual(host.editCalls, []);
  assert.ok(useChatStore.getState().error.length > 0);
});

test('editing and regenerating incomplete history previews request persisted attachments', async () => {
  const host = createBridge();
  const calls = [];
  host.bridge.editMessage = async (...args) => { calls.push(args); };
  useChatStore.getState().setBridge(host.bridge);
  await settle();
  const preview = { kind: 'image', name: 'preview.png', mimeType: 'image/png', data: 'aaaa' };
  useChatStore.setState((state) => ({ messages: state.messages.map((message) => message.id === 'u2' ? { ...message, attachments: [preview], attachmentsOmitted: 1 } : message) }));
  await useChatStore.getState().regenerate();
  await useChatStore.getState().editMessage('u2', 'edited', [preview]);
  assert.deepEqual(calls, [['u2', 'second question', undefined], ['u2', 'edited', undefined]]);
});

test('regeneration preserves image-only turns and refuses stale reply ids or busy sessions', async () => {
  const host = createBridge();
  const calls = []; host.bridge.editMessage = async (...args) => { calls.push(args); };
  useChatStore.getState().setBridge(host.bridge); await settle();
  const attachment = { kind: 'image', name: 'image.png', mimeType: 'image/png', data: 'aaaa' };
  useChatStore.setState(state => ({ messages: state.messages.map(message => message.id === 'u2' ? { ...message, text: '', attachments: [attachment] } : message) }));
  await assert.rejects(() => useChatStore.getState().regenerate('a1'));
  assert.equal(calls.length, 0);
  await useChatStore.getState().regenerate('a2');
  assert.deepEqual(calls, [['u2', '', [attachment]]]);
  useChatStore.setState({ status: 'busy' });
  await assert.rejects(() => useChatStore.getState().regenerate('a2'));
  assert.equal(calls.length, 1);
});
