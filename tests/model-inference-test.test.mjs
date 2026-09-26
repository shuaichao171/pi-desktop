import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelTestService } from '../packages/agent/src/modelTest.ts';

test('real SDK model tests reject auth, missing endpoint, malformed and prematurely ended streams; cancellation stays isolated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-model-test-'));
  const sockets = new Set(), received = []; let mode = 'success';
  let notifyRequest;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text); received.push({ body, headers: request.headers }); notifyRequest?.();
    if (mode === 'wait') return;
    if (mode === '401' || mode === '404') { response.writeHead(Number(mode), { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'never-return-secret-api-key ' + mode } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'malformed') { response.end('data: {broken\n\n'); return; }
    response.write('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }) + '\n\n');
    if (mode === 'disconnect') { response.flushHeaders(); setImmediate(() => response.destroy()); return; }
    if (mode === 'missing-finish') { response.end('data: [DONE]\n\n'); return; }
    response.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new ModelTestService();
  t.after(async () => { service.dispose(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const modelsPath = join(root, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-key', models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 100 }] } } }));
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
  const runtime = await ModelRuntime.create({ modelsPath, credentials, refreshOnCreate: false, allowModelNetwork: false });
  const request = id => ({ requestId: id, provider: 'fixture', model: 'fixture-model' });
  const first = await service.test(runtime, request('test-success'));
  assert.equal(first.ok, true); assert.equal(first.error, null);
  assert.equal(received[0].headers.authorization, 'Bearer local-fixture-key');
  assert.equal(received[0].body.messages.at(-1).content, 'Reply with OK.');
  assert.equal(received[0].body.max_tokens ?? received[0].body.max_completion_tokens, 16);
  for (const failure of ['401', '404', 'malformed', 'missing-finish', 'disconnect']) {
    mode = failure; const result = await service.test(runtime, request('test-' + failure));
    assert.equal(result.ok, false, failure); assert.ok(result.error); assert.doesNotMatch(JSON.stringify(result), /never-return-secret|local-fixture-key/);
    if (/^\d+$/.test(failure)) assert.match(result.error, new RegExp(failure));
  }
  mode = 'wait'; let count = 0;
  const allStarted = new Promise(resolve => { notifyRequest = () => { if (++count === 3) resolve(); }; });
  const requests = ['parallel-a', 'parallel-b', 'parallel-c'].map(id => service.test(runtime, request(id)));
  await allStarted;
  await assert.rejects(service.test(runtime, request('parallel-a')), /仍在运行/);
  await assert.rejects(service.test(runtime, request('parallel-d')), /三个/);
  service.cancel('parallel-b');
  assert.match((await requests[1]).error, /取消/);
  service.dispose();
  const results = await Promise.all(requests); assert.deepEqual(results.map(result => result.requestId), ['parallel-a', 'parallel-b', 'parallel-c']); assert.ok(results.every(result => !result.ok));
  mode = 'success'; assert.equal((await service.test(runtime, request('parallel-b'))).ok, true, 'cancelled request can be tested again');
});
