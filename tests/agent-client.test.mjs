import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const electronStub = `
  export const app = { getAppPath: () => 'test-app' };
  export const utilityProcess = { fork: () => globalThis.__piTestHost };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent(electronStub)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { AgentHostClient } = await import('../packages/desktop/src/main/agentClient.ts');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function createHost() {
  const host = new EventEmitter();
  host.messages = [];
  host.kills = 0;
  host.postMessage = (message) => {
    host.messages.push(message);
    if (message.kind === 'call' && message.method === 'dispose') {
      queueMicrotask(() => host.emit('message', { kind: 'reply', id: message.id, value: undefined }));
    }
  };
  host.kill = () => { host.kills += 1; host.emit('exit', 0); };
  globalThis.__piTestHost = host;
  return host;
}

async function startCall(client, host, method) {
  const result = client.call(method);
  host.emit('message', { kind: 'ready' });
  await settle();
  return { result };
}

test('unanswered RPC rejects while the Pi host remains alive for later calls', async () => {
  const host = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  }, () => 20);

  const { result: snapshot } = await startCall(client, host, 'getSnapshot');
  await assert.rejects(snapshot, /响应超时/);
  assert.equal(host.kills, 0, 'a timeout must not kill a running Pi tool');

  const abort = client.call('abort');
  await settle();
  const request = host.messages.find((message) => message.kind === 'call' && message.method === 'abort');
  host.emit('message', { kind: 'reply', id: request.id, value: undefined });
  await abort;
  assert.equal(host.kills, 0);
  await client.dispose();
});

test('RPC timeout waits while an extension dialog needs user input', async () => {
  const host = createHost();
  let finishDialog;
  const dialog = new Promise((resolve) => { finishDialog = resolve; });
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => dialog,
  }, () => 15);

  const { result: init } = await startCall(client, host, 'init');
  const initError = assert.rejects(init, /响应超时/);
  const initCallId = host.messages.at(-1).id;
  host.emit('message', { kind: 'ui-request', id: 1, callId: initCallId, request: { kind: 'extension', dialog: { kind: 'confirm', title: 'Continue?' } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.pending.size, 1);

  finishDialog(true);
  await settle();
  await initError;
  assert.equal(host.kills, 0);
  await client.dispose();
});

test('an unrelated dialog does not extend another RPC timeout', async () => {
  const host = createHost();
  let finishDialog;
  const dialog = new Promise((resolve) => { finishDialog = resolve; });
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => dialog,
  }, () => 15);
  const { result: snapshot } = await startCall(client, host, 'getSnapshot');
  host.emit('message', { kind: 'ui-request', id: 1, callId: 999, request: { kind: 'extension', dialog: { kind: 'confirm', title: 'Other session?' } } });
  await assert.rejects(snapshot, /响应超时/);
  assert.equal(client.activeDialogs.size, 1);
  finishDialog(true);
  await settle();
  await client.dispose();
});

test('events and snapshots keep increasing sequence numbers after a host crash', async () => {
  const firstHost = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  });
  const sequences = [];
  client.onEvent((envelope) => sequences.push(envelope.sequence));

  const { result: firstSnapshot } = await startCall(client, firstHost, 'getSnapshot');
  firstHost.emit('message', { kind: 'event', envelope: { sequence: 1, event: { type: 'status', status: 'idle' } } });
  firstHost.emit('message', { kind: 'reply', id: firstHost.messages.at(-1).id, value: { sequence: 1 } });
  assert.equal((await firstSnapshot).sequence, 1);
  firstHost.emit('exit', 1);
  assert.deepEqual(sequences, [1, 2, 3]);

  const secondHost = createHost();
  const { result: secondSnapshot } = await startCall(client, secondHost, 'getSnapshot');
  secondHost.emit('message', { kind: 'reply', id: secondHost.messages.at(-1).id, value: { sequence: 0 } });
  assert.equal((await secondSnapshot).sequence, 3);
  secondHost.emit('message', { kind: 'event', envelope: { sequence: 1, event: { type: 'status', status: 'idle' } } });
  assert.deepEqual(sequences, [1, 2, 3, 4]);
  await client.dispose();
});

test('an old host dialog cannot remove a new host dialog with the same request id', async () => {
  let finishOld;
  let finishNew;
  const oldDialog = new Promise((resolve) => { finishOld = resolve; });
  const newDialog = new Promise((resolve) => { finishNew = resolve; });
  const firstHost = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: (cwd) => cwd === 'old' ? oldDialog : newDialog,
    requestExtensionDialog: async () => null,
  });
  const { result: firstSnapshot } = await startCall(client, firstHost, 'getSnapshot');
  firstHost.emit('message', { kind: 'reply', id: firstHost.messages.at(-1).id, value: { sequence: 0 } });
  await firstSnapshot;
  firstHost.emit('message', { kind: 'ui-request', id: 1, request: { kind: 'project-trust', cwd: 'old' } });
  await settle();
  firstHost.emit('exit', 1);

  const secondHost = createHost();
  const { result: secondSnapshot } = await startCall(client, secondHost, 'getSnapshot');
  secondHost.emit('message', { kind: 'reply', id: secondHost.messages.at(-1).id, value: { sequence: 0 } });
  await secondSnapshot;
  secondHost.emit('message', { kind: 'ui-request', id: 1, request: { kind: 'project-trust', cwd: 'new' } });
  await settle();
  const active = client.activeDialogs.get(1);
  finishOld({ trusted: false, remember: false });
  await settle();
  assert.equal(client.activeDialogs.get(1), active);
  finishNew({ trusted: true, remember: false });
  await settle();
  assert.equal(client.activeDialogs.size, 0);
  await client.dispose();
});
