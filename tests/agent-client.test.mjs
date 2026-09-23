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
  host.emit('message', { kind: 'ui-request', id: 1, request: { kind: 'extension', dialog: { kind: 'confirm', title: 'Continue?' } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.pending.size, 1);

  finishDialog(true);
  await settle();
  await initError;
  assert.equal(host.kills, 0);
  await client.dispose();
});
