import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { bindProviderNetwork } from '../packages/agent/src/providerNetwork.ts';
import { applyCanonicalThinkingLevel, normalizeThinkingLevel, sanitizeReasoningRequest } from '../packages/agent/src/thinkingLevels.ts';
import { seedTestModel } from './helpers/testModel.mjs';

test('normalizeThinkingLevel folds off aliases and drops unknown values', () => {
  for (const alias of ['off', 'none', 'disabled']) assert.equal(normalizeThinkingLevel(alias), 'off');
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(normalizeThinkingLevel(level), level);
  for (const invalid of ['ultra', '', 'OFF', 'none ', 42, null, undefined, {}]) assert.equal(normalizeThinkingLevel(invalid), undefined);
});

test('sanitizeReasoningRequest never forwards an illegal reasoning effort', () => {
  // 未知档位与 off 别名都不下发 reasoning：宁可不传，也不透传非法 effort。
  for (const reasoning of ['none', 'disabled', 'off', 'ultra']) {
    const { model, options } = sanitizeReasoningRequest({ id: 'm' }, { reasoning, maxRetries: 0 });
    assert.equal('reasoning' in options, false);
    assert.equal(model.id, 'm');
  }
  const kept = sanitizeReasoningRequest({ id: 'm' }, { reasoning: 'low', maxRetries: 0 });
  assert.equal(kept.options.reasoning, 'low');
  assert.equal(kept.options.maxRetries, 0);
  // 缺失或本就没有 reasoning 的 options 原样返回。
  const untouched = { maxRetries: 1 };
  assert.equal(sanitizeReasoningRequest({ id: 'm' }, untouched).options, untouched);
  assert.equal(sanitizeReasoningRequest({ id: 'm' }, undefined).options, undefined);
});

test('sanitizeReasoningRequest strips none/disabled thinkingLevelMap values', () => {
  const model = { id: 'gpt-6.1-sol', reasoning: true, thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'disabled' } };
  const { model: sanitized } = sanitizeReasoningRequest(model, { reasoning: 'low' });
  assert.notEqual(sanitized, model, 'poisoned models are cloned, never mutated');
  // OpenAI 兼容适配器只在 off 映射是字符串时才下发 reasoning_effort；清掉后不再产生非法 effort。
  assert.equal(typeof sanitized.thinkingLevelMap.off, 'undefined');
  assert.equal(sanitized.thinkingLevelMap.low, 'low');
  assert.equal(sanitized.thinkingLevelMap.minimal, null, 'null（不支持）语义保持不变');
  assert.equal('medium' in sanitized.thinkingLevelMap, false);
  assert.equal(model.thinkingLevelMap.off, 'none', 'the catalog entry itself stays untouched');
  // 映射干净的模型不克隆，保持原对象。
  const clean = { id: 'm', thinkingLevelMap: { off: null, low: 'low' } };
  assert.equal(sanitizeReasoningRequest(clean, {}).model, clean);
  assert.equal(sanitizeReasoningRequest({ id: 'm' }, {}).model.thinkingLevelMap, undefined);
});

test('applyCanonicalThinkingLevel pulls a stray session level back to the canonical set', () => {
  const applied = [];
  const session = {
    thinkingLevel: 'none',
    setThinkingLevel(level) { this.thinkingLevel = level; applied.push(level); },
  };
  assert.equal(applyCanonicalThinkingLevel(session), 'off');
  assert.deepEqual(applied, ['off']);
  const canonical = { thinkingLevel: 'high', setThinkingLevel: (level) => applied.push(level) };
  assert.equal(applyCanonicalThinkingLevel(canonical), 'high');
  assert.equal(applyCanonicalThinkingLevel({ thinkingLevel: 42, setThinkingLevel: (level) => applied.push(level) }), 'off');
  assert.deepEqual(applied, ['off', 'off']);
});

test('bindProviderNetwork normalizes reasoning before every SDK request', () => {
  const seen = [];
  const runtime = Object.fromEntries(['stream', 'streamSimple', 'streamDeferred', 'cancelDeferred'].map((method) => [method, function (model, _context, options) {
    seen.push({ method, model, options });
    return 'result';
  }]));
  bindProviderNetwork(runtime, '/dev/null-models.json');
  const poisoned = { provider: 'p', api: 'openai-completions', reasoning: true, thinkingLevelMap: { off: 'none', low: 'low' } };
  for (const method of Object.keys(runtime)) {
    runtime[method](poisoned, {}, { reasoning: 'none', maxRetries: 0 });
    const call = seen.at(-1);
    assert.equal(call.method, method);
    assert.equal('reasoning' in call.options, false, `${method} drops illegal reasoning`);
    assert.equal(call.model.thinkingLevelMap.off, undefined, `${method} strips the none off mapping`);
    assert.equal(call.model, call.model, 'bound identity preserved');
  }
  runtime.streamSimple(poisoned, {}, { reasoning: 'high' });
  assert.equal(seen.at(-1).options.reasoning, 'high', 'canonical levels still pass through');
});

test('compaction summarization on a low…max model no longer sends reasoning_effort none', async (t) => {
  const bodies = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'gpt-6.1-sol does not support reasoning effort "none"' }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const root = await mkdtemp(join(tmpdir(), 'pi-thinking-levels-'));
  const modelsPath = join(root, 'models.json');
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
    await new Promise((done) => server.close(done));
  });
  // 模型设置页历史把 off 档位写成线上值 none：只接受 low…max 的服务会因此 400。
  await writeFile(modelsPath, JSON.stringify({ providers: { 'sol-relay': {
    api: 'openai-completions', baseUrl, apiKey: 'local-fixture-key',
    models: [{ id: 'gpt-6.1-sol', name: 'sol', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 8192,
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high' } }],
  } } }));
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
  const runtime = await ModelRuntime.create({ modelsPath, credentials, refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModel('sol-relay', 'gpt-6.1-sol');
  assert.equal(model.thinkingLevelMap.off, 'none');
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }], timestamp: Date.now() }] };

  // 基线：未绑定归一化层时，会话档位为 off 的总结请求会原样发出 reasoning_effort none（事故现场）。
  const raw = await runtime.streamSimple(model, context, { maxRetries: 0, timeoutMs: 3000 }).result();
  assert.equal(raw.stopReason, 'error');
  assert.match(raw.errorMessage, /does not support reasoning effort/);
  assert.equal(bodies[0].reasoning_effort, 'none');

  bindProviderNetwork(runtime, modelsPath);
  // 归一化后：off 档位（总结请求对 off 不下发 reasoning）与透传的非法档位都不再产生 effort。
  await runtime.streamSimple(model, context, { maxRetries: 0, timeoutMs: 3000 }).result();
  await runtime.streamSimple(model, context, { maxRetries: 0, timeoutMs: 3000, reasoning: 'none' }).result();
  await runtime.streamSimple(model, context, { maxRetries: 0, timeoutMs: 3000, reasoning: 'medium' }).result();
  assert.equal('reasoning_effort' in bodies[1], false, 'level off must not transmit an effort');
  assert.equal('reasoning_effort' in bodies[2], false, 'a stray none level is dropped, not forwarded');
  assert.equal(bodies[3].reasoning_effort, 'medium', 'canonical levels keep their mapping');
});

test('host thinking-level entry normalizes aliases before the SDK persists them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-thinking-agent-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  seedTestModel(join(root, 'agent'));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService();
  await service.init({ cwd: workspace });
  try {
    // none/disabled 折叠为 off，而不是把非法档位交给 SDK 持久化。
    for (const alias of ['none', 'disabled']) {
      await service.setThinkingLevel(alias, false);
      assert.equal(service.getSnapshot().thinkingLevel, 'off');
    }
    await service.setThinkingLevel('medium', false);
    assert.equal(service.getSnapshot().thinkingLevel === 'medium' || service.getSnapshot().thinkingLevel === 'off', true);
    await assert.rejects(service.setThinkingLevel('ultra', false), /思考级别无效/);

    // /compact 入口与会话档位共用同一归一化：历史遗留的非规范档位先拉回规范集再压缩。
    const session = service.active.runtime.session;
    const requested = [];
    const originalCompact = session.compact;
    session.compact = async () => { requested.push(session.thinkingLevel); return {}; };
    try {
      session.agent.state.thinkingLevel = 'none';
      await service.executeSlashCommand({ cwd: service.getSnapshot().cwd, sessionId: service.getSnapshot().sessionId, name: 'compact', args: '' });
      assert.deepEqual(requested, ['off'], 'compaction runs with the canonical level');
      assert.equal(session.thinkingLevel, 'off');
    } finally {
      session.compact = originalCompact;
    }
  } finally {
    await service?.dispose();
  }
});
