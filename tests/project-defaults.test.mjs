import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectDefaultsService } from '../packages/agent/src/projectDefaults.ts';

test('project defaults preserve unrelated settings, enforce trust/CAS, and restore inheritance independently per project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-project-defaults-')), agent = join(root, 'agent'), a = join(root, 'A'), b = join(root, 'B');
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(agent), mkdir(join(a, '.pi'), { recursive: true }), mkdir(b)]);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'global', defaultModel: 'one', defaultThinkingLevel: 'low' }));
  await writeFile(join(a, '.pi', 'settings.json'), JSON.stringify({ unrelated: { keep: true }, defaultModel: 'project' }));
  const service = new ProjectDefaultsService(), blocked = await service.snapshot(a, agent, false);
  assert.equal(blocked.project.defaultModel, 'project'); assert.equal(blocked.effective.defaultModel, 'one'); assert.ok(blocked.reason);
  await assert.rejects(service.save(a, agent, false, { cwd: a, expectedVersion: blocked.version, values: {} }), /信任/);
  const saved = await service.save(a, agent, true, { cwd: a, expectedVersion: blocked.version, values: { defaultProvider: 'custom', defaultModel: 'two', defaultThinkingLevel: 'high' } });
  assert.deepEqual(saved.effective, { defaultProvider: 'custom', defaultModel: 'two', defaultThinkingLevel: 'high' });
  assert.deepEqual(JSON.parse(await readFile(saved.path, 'utf8')).unrelated, { keep: true });
  assert.equal((await service.snapshot(b, agent, true)).effective.defaultModel, 'one');
  await assert.rejects(service.save(a, agent, true, { cwd: b, expectedVersion: saved.version, values: {} }), /项目已改变/);
  await writeFile(saved.path, JSON.stringify({ external: true, defaultModel: 'external' }));
  await assert.rejects(service.save(a, agent, true, { cwd: a, expectedVersion: saved.version, values: {} }), /外部修改/);
  const latest = await service.snapshot(a, agent, true);
  const inherited = await service.save(a, agent, true, { cwd: a, expectedVersion: latest.version, values: {} });
  assert.equal(inherited.effective.defaultModel, 'one'); assert.deepEqual(inherited.project, {});
  assert.equal(JSON.parse(await readFile(saved.path, 'utf8')).external, true);
  await assert.rejects(service.save(a, agent, true, { cwd: a, expectedVersion: inherited.version, values: { arbitrary: true } }), /仅支持/);
});

test('real SDK reads saved project defaults for a new session without mutating the current session or its transcript', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-defaults-sdk-')), workspace = join(root, 'workspace'), agent = join(root, 'agent');
  const prior = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  await Promise.all([mkdir(workspace), mkdir(agent)]); process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_OFFLINE = '1';
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService(async () => ({ trusted: true, remember: false }));
  t.after(async () => { await service.dispose(); if (prior.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior.dir; if (prior.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = prior.offline; await rm(root, { recursive: true, force: true }); });
  const models = ['first', 'second'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 100 }));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only', models } } }));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'first' }));
  await service.init({ cwd: workspace }); assert.equal(service.getSnapshot().model, 'first');
  const before = service.getSnapshot(), defaults = await service.getProjectDefaults();
  await service.saveProjectDefaults({ cwd: workspace, expectedVersion: defaults.version, values: { defaultProvider: 'fixture', defaultModel: 'second' } });
  assert.equal(service.getSnapshot().model, 'first'); assert.deepEqual(service.getSnapshot().messages, before.messages);
  const testResult = await service.testProviderModel({ requestId: 'isolated-missing-model', provider: 'fixture', model: 'not-present' });
  assert.equal(testResult.ok, false); assert.equal(service.getSnapshot().model, 'first'); assert.deepEqual(service.getSnapshot().messages, before.messages);
  await service.newSession(); assert.equal(service.getSnapshot().model, 'second');
  assert.deepEqual(service.getSnapshot().messages, []);
});
