import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { bindProviderNetwork, configureProviderNetwork, runWithProviderNetwork } from '../packages/agent/src/providerNetwork.ts';

const inheritedFetch = globalThis.fetch;

async function fixture(t, respond = (_request, response) => response.end('ok')) {
  const requests = [];
  const sockets = new Set();
  const proxiedPorts = new Set();
  const connections = [];
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const target = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, headers: request.headers, body, port: request.socket.remotePort });
    respond(request, response);
  });
  target.on('connection', track);
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;
  const proxy = createServer((_request, response) => { response.writeHead(405); response.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (request, client, head) => {
    connections.push(request.url);
    // This fixture must never open a socket outside its own loopback server.
    if (request.url !== `127.0.0.1:${targetPort}`) { client.destroy(); return; }
    const upstream = connect(targetPort, '127.0.0.1', () => {
      proxiedPorts.add(upstream.localPort);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    globalThis.fetch = inheritedFetch;
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  return {
    url: `http://127.0.0.1:${targetPort}`,
    proxy: `PROXY 127.0.0.1:${proxy.address().port}`,
    requests, connections,
    isProxied: request => proxiedPorts.has(request.port),
  };
}

test('provider routing isolates concurrent proxy/direct requests and leaves unscoped fetch untouched', async t => {
  const f = await fixture(t);
  const inheritedCalls = [];
  globalThis.fetch = (input, init) => { inheritedCalls.push(String(input)); return inheritedFetch(input, init); };
  const resolutions = [];
  configureProviderNetwork(async url => { resolutions.push(url); await Promise.resolve(); return f.proxy; });
  await Promise.all([
    runWithProviderNetwork(true, async () => { await Promise.resolve(); return (await fetch(f.url + '/proxy')).text(); }),
    runWithProviderNetwork(false, async () => {
      await Promise.resolve();
      return (await fetch(new Request(f.url + '/direct', { method: 'POST', headers: { 'x-fixture': 'literal' }, body: 'request body' }))).text();
    }),
    fetch(f.url + '/inherited').then(response => response.text()),
  ]);
  assert.deepEqual(resolutions, [f.url + '/proxy']);
  assert.deepEqual(inheritedCalls, [f.url + '/inherited']);
  assert.ok(f.isProxied(f.requests.find(request => request.url === '/proxy')));
  const direct = f.requests.find(request => request.url === '/direct');
  assert.equal(f.isProxied(direct), false);
  assert.equal(direct.method, 'POST');
  assert.equal(direct.body, 'request body');
  assert.equal(direct.headers['x-fixture'], 'literal');
  assert.equal(f.isProxied(f.requests.find(request => request.url === '/inherited')), false);
});

test('system DIRECT works while SOCKS, invalid resolutions and cancelled resolution never silently connect directly', async t => {
  const f = await fixture(t);
  configureProviderNetwork(async () => 'DIRECT');
  assert.equal(await runWithProviderNetwork(true, async () => (await fetch(f.url + '/direct')).text()), 'ok');
  assert.equal(f.requests.length, 1);
  for (const [result, message] of [['SOCKS5 127.0.0.1:9999; DIRECT', /SOCKS/], ['', /有效连接方式/], ['PROXY invalid/endpoint', /地址无效/]]) {
    configureProviderNetwork(async () => result);
    await assert.rejects(runWithProviderNetwork(true, () => fetch(f.url + '/must-not-connect')), message);
  }
  let started;
  const resolving = new Promise(resolve => { started = resolve; });
  let finish;
  configureProviderNetwork(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const controller = new AbortController();
  const request = runWithProviderNetwork(true, () => fetch(f.url + '/cancelled', { signal: controller.signal }));
  const rejected = assert.rejects(request, error => error.name === 'AbortError');
  await resolving;
  controller.abort();
  await rejected;
  finish('DIRECT');
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  assert.equal(f.connections.length, 0);
});

test('binding preserves synchronous stream return values and propagates policy into deferred/cancel async work', async t => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'pi-provider-network-'));
  const modelsPath = join(root, 'models.json');
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { desktopUseSystemProxy: true } } }));
  configureProviderNetwork(async () => f.proxy);
  const result = {};
  const calls = [];
  const runtime = Object.fromEntries(['stream', 'streamSimple', 'streamDeferred', 'cancelDeferred'].map(method => [method, function (model) {
    assert.equal(this, runtime);
    calls.push(Promise.resolve().then(() => fetch(f.url + '/' + method)).then(response => response.text()));
    return result;
  }]));
  bindProviderNetwork(runtime, modelsPath);
  bindProviderNetwork(runtime, modelsPath);
  for (const method of Object.keys(runtime)) assert.equal(runtime[method]({ provider: 'fixture' }), result);
  await Promise.all(calls);
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every(f.isProxied));
});

test('all four real SDK adapters honor proxy changes on the next request without recreating their runtime', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Local fixture response; no model is called' } }));
  });
  const root = await mkdtemp(join(tmpdir(), 'pi-provider-sdk-network-'));
  const modelsPath = join(root, 'models.json');
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const protocols = [
    ['openai-completions', '/v1', '/v1/chat/completions'],
    ['openai-responses', '/v1', '/v1/responses'],
    ['anthropic-messages', '', '/v1/messages?beta=true'],
    ['google-generative-ai', '/v1beta', '/v1beta/models/fixture-model:streamGenerateContent?alt=sse'],
  ];
  const document = { providers: Object.fromEntries(protocols.map(([api, suffix]) => [api, {
    api, baseUrl: f.url + suffix, apiKey: 'local-fixture-key', desktopUseSystemProxy: false,
    headers: { 'x-test-protocol': api },
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 100 }],
  }])) };
  await writeFile(modelsPath, JSON.stringify(document));
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
  const runtime = await ModelRuntime.create({ modelsPath, credentials, refreshOnCreate: false, allowModelNetwork: false });
  assert.equal(runtime.getError(), undefined);
  let inheritedCalls = 0;
  globalThis.fetch = (input, init) => { inheritedCalls += 1; return inheritedFetch(input, init); };
  configureProviderNetwork(async () => f.proxy);
  bindProviderNetwork(runtime, modelsPath);
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'local routing test' }], timestamp: Date.now() }] };
  const send = async (method, api) => {
    const model = runtime.getModel(api, 'fixture-model');
    assert.ok(model);
    const stream = runtime[method](model, context, { maxRetries: 0, timeoutMs: 3000 });
    assert.equal(typeof stream.result, 'function', 'binding must not turn a synchronous SDK stream into a Promise');
    const result = await stream.result();
    assert.equal(result.stopReason, 'error', 'the local server deliberately returns 401 after recording the request');
  };
  await Promise.all(protocols.map(([api]) => send('stream', api)));
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every(request => !f.isProxied(request)));
  assert.equal(f.connections.length, 0);
  assert.equal(inheritedCalls, 0, 'explicit direct must bypass inherited global transport');
  for (const [api, , path] of protocols) {
    assert.equal(f.requests.find(request => request.headers['x-test-protocol'] === api)?.url, path);
    document.providers[api].desktopUseSystemProxy = true;
  }
  await writeFile(modelsPath, JSON.stringify(document));
  await Promise.all(protocols.map(([api]) => send('streamSimple', api)));
  assert.equal(f.requests.length, 8);
  assert.ok(f.requests.slice(4).every(f.isProxied), 'including the Google adapter, which rejects an options.fetch override');
  assert.equal(inheritedCalls, 0);
  delete document.providers['openai-completions'].desktopUseSystemProxy;
  await writeFile(modelsPath, JSON.stringify(document));
  await send('streamSimple', 'openai-completions');
  assert.equal(inheritedCalls, 1, 'existing providers without an explicit boolean keep their inherited network behavior');
  assert.equal(f.requests.length, 9);
  assert.equal(f.isProxied(f.requests[8]), false);
});
