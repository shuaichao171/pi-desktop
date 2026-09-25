import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const electronStub = `
  export const app = { getAppPath: () => 'test-app' };
  export const utilityProcess = { fork: () => globalThis.__piTestHost };
  export const session = { defaultSession: { resolveProxy: (url) => globalThis.__piResolveProxy(url) } };
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

async function startCall(client, host, method, rejectionPattern) {
  const result = client.call(method);
  // Short RPC deadlines can elapse before setImmediate under parallel test load.
  const rejection = rejectionPattern ? assert.rejects(result, rejectionPattern) : undefined;
  host.emit('message', { kind: 'ready' });
  await settle();
  return { result, rejection };
}

test('model requests resolve the OS proxy in Electron without opening an extension dialog', async () => {
  const host = createHost();
  const urls = [];
  globalThis.__piResolveProxy = async (url) => { urls.push(url); return 'PROXY 127.0.0.1:7890'; };
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => { throw new Error('proxy resolution must not show a dialog'); },
  });
  try {
    const { result } = await startCall(client, host, 'discoverProviderModels');
    const call = host.messages.at(-1);
    host.emit('message', { kind: 'ui-request', id: 7, callId: call.id, request: { kind: 'resolve-proxy', url: 'https://models.example.invalid/v1/models' } });
    await settle();
    await settle();
    assert.deepEqual(urls, ['https://models.example.invalid/v1/models']);
    assert.deepEqual(host.messages.find((message) => message.kind === 'ui-reply'), { kind: 'ui-reply', id: 7, value: 'PROXY 127.0.0.1:7890' });
    host.emit('message', { kind: 'reply', id: call.id, value: { models: [], warnings: [] } });
    assert.deepEqual(await result, { models: [], warnings: [] });
  } finally {
    await client.dispose();
    delete globalThis.__piResolveProxy;
  }
});

test('unanswered RPC rejects while the Pi host remains alive for later calls', async () => {
  const host = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  }, () => 20);

  const { rejection: snapshotError } = await startCall(client, host, 'getSnapshot', /响应超时/);
  await snapshotError;
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

  const { rejection: initError } = await startCall(client, host, 'init', /响应超时/);
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
  const { rejection: snapshotError } = await startCall(client, host, 'getSnapshot', /响应超时/);
  host.emit('message', { kind: 'ui-request', id: 1, callId: 999, request: { kind: 'extension', dialog: { kind: 'confirm', title: 'Other session?' } } });
  await snapshotError;
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

test('shutdown rejects new calls and does not report an intentional host exit as a crash', async () => {
  const host = createHost();
  let crashes = 0;
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
    onHostCrash: () => { crashes += 1; },
  });
  const { result: snapshot } = await startCall(client, host, 'getSnapshot');
  host.emit('message', { kind: 'reply', id: host.messages.at(-1).id, value: { sequence: 0 } });
  await snapshot;
  host.postMessage = (message) => host.messages.push(message);

  const shutdown = client.dispose();
  const shutdownResult = assert.rejects(shutdown, /exited/);
  const lateCall = client.call('getSnapshot');
  const lateResult = assert.rejects(lateCall, /shutting down/);
  await settle();
  host.emit('exit', 0);
  await Promise.all([shutdownResult, lateResult]);
  assert.equal(crashes, 0);
  assert.equal(host.messages.filter((message) => message.method === 'getSnapshot').length, 1);
});

test('shutdown is idempotent and cancels calls still waiting for host startup', async () => {
  const host = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  });
  const starting = assert.rejects(client.call('init'), /shutting down/);
  const shutdown = client.dispose();
  assert.equal(client.dispose(), shutdown);
  host.emit('message', { kind: 'ready' });
  await Promise.all([starting, shutdown]);
  assert.deepEqual(host.messages.map((message) => message.method), ['dispose']);
  assert.equal(host.kills, 1);
});

test('a call awaiting a crashed host is never replayed against its replacement', async () => {
  const firstHost = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  });
  const oldPrompt = assert.rejects(client.call('prompt', 'belongs to the old session'), /unavailable/);
  // The ready promise has resolved, but its caller has not resumed yet.
  firstHost.emit('message', { kind: 'ready' });
  firstHost.emit('exit', 1);
  const replacement = createHost();
  const snapshot = client.call('getSnapshot');
  await settle();
  await oldPrompt;
  assert.deepEqual(replacement.messages, [], 'no old-session request may enter the starting replacement');
  replacement.emit('message', { kind: 'ready' });
  await settle();
  const request = replacement.messages.at(-1);
  assert.equal(request.method, 'getSnapshot');
  replacement.emit('message', { kind: 'reply', id: request.id, value: { sequence: 0 } });
  await snapshot;
  await client.dispose();
});

test('shutdown waits for the actual exit after kill acknowledges termination', async () => {
  const host = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  });
  const { result: snapshot } = await startCall(client, host, 'getSnapshot');
  host.emit('message', { kind: 'reply', id: host.messages.at(-1).id, value: { sequence: 0 } });
  await snapshot;
  host.kill = () => { host.kills += 1; return true; };
  let completed = false;
  const shutdown = client.dispose().then(() => { completed = true; });
  try {
    await settle();
    assert.equal(host.kills, 1);
    assert.equal(completed, false);
  } finally { host.emit('exit', 0); await shutdown; }
  assert.equal(completed, true);
});

test('shutdown reports a still-running worker when termination never produces an exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  });
  const { result: snapshot } = await startCall(client, host, 'getSnapshot');
  host.emit('message', { kind: 'reply', id: host.messages.at(-1).id, value: { sequence: 0 } });
  await snapshot;
  host.kill = () => { host.kills += 1; return false; };
  const shutdown = client.dispose();
  const failure = assert.rejects(shutdown, (error) => error.workerStillRunning === true && /did not exit/.test(error.message));
  await settle();
  assert.equal(host.kills, 1);
  t.mock.timers.tick(5_000);
  await failure;
  assert.equal(client.dispose(), shutdown, 'a failed shutdown cannot start another shutdown RPC');
  host.emit('exit', 0);
});

test('a failed disposal RPC retains its original error once the worker really exits', async () => {
  const host = createHost();
  const client = new AgentHostClient({
    requestProjectTrust: async () => ({ trusted: false, remember: false }),
    requestExtensionDialog: async () => null,
  });
  const { result: snapshot } = await startCall(client, host, 'getSnapshot');
  host.emit('message', { kind: 'reply', id: host.messages.at(-1).id, value: { sequence: 0 } });
  await snapshot;
  host.postMessage = (request) => {
    host.messages.push(request);
    if (request.method === 'dispose') queueMicrotask(() => host.emit('message', { kind: 'error', id: request.id, message: 'Could not save state' }));
  };
  await assert.rejects(client.dispose(), (error) => error.message === 'Could not save state' && error.workerStillRunning !== true);
  assert.equal(host.kills, 1);
});
