import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

test('credential synchronization waits for all runtimes before shutdown after a refresh failure', async () => {
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService();
  let releaseRefresh;
  let refreshStarted;
  const started = new Promise((resolve) => { refreshStarted = resolve; });
  const disposed = [];
  const source = { setProviderApiKey: async () => {}, dispose: async () => { disposed.push('source'); } };
  const failed = {
    refreshProviderAuth: async () => { throw new Error('catalog refresh failed'); },
    dispose: async () => { disposed.push('failed'); },
  };
  const pending = {
    refreshProviderAuth: async () => {
      await new Promise((resolve) => { releaseRefresh = resolve; refreshStarted(); });
    },
    dispose: async () => { disposed.push('pending'); },
  };
  service.active = source;
  service.contexts.set('source', source);
  service.contexts.set('failed', failed);
  service.contexts.set('pending', pending);
  const updating = service.setProviderApiKey('test', 'placeholder');
  const rejectedUpdate = assert.rejects(updating, /catalog refresh failed/);
  await started;
  await assert.rejects(service.removeProviderCredential('test'), /登录信息正在更新/);
  const shutdown = service.dispose();
  try {
    assert.throws(() => service.prompt('after shutdown'), /应用正在退出/);
    await Promise.resolve();
    assert.deepEqual(disposed, [], 'no runtime may be disposed while its catalog refresh is pending');
  } finally {
    releaseRefresh();
    await rejectedUpdate;
    await shutdown;
  }
  assert.deepEqual(disposed.sort(), ['failed', 'pending', 'source']);
});

test('model settings use pi catalog and credential store without exposing secrets', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-models-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const environment = new Map(
    ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN']
      .map((name) => [name, process.env[name]]),
  );
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;

  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    assert.equal(service.getSnapshot().modelName, null);
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    await service.init({ cwd: workspace });
    const initialModelName = service.active.runtime.session.model?.name?.trim() || null;
    assert.equal(service.getSnapshot().modelName, initialModelName);
    assert.equal(events.findLast((event) => event.type === 'ready').modelName, initialModelName);

    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, false);
    assert.ok(service.listModels().every(({ provider }) => provider !== 'anthropic'));
    await assert.rejects(service.setModel('anthropic', 'missing-model'), /模型不可用/);
    await assert.rejects(service.setThinkingLevel('invalid'), /思考级别无效/);

    const otherWorkspace = join(tempRoot, 'other-workspace');
    mkdirSync(otherWorkspace);
    await service.switchWorkspace(otherWorkspace);
    await service.switchWorkspace(workspace);

    const dummyKey = 'test-key-never-send-to-renderer';
    await service.setProviderApiKey('anthropic', dummyKey);
    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, true);
    await service.switchWorkspace(otherWorkspace);
    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, true,
      'saving a shared credential must refresh already loaded workspace runtimes');
    assert.ok(service.listModels().some(({ provider }) => provider === 'anthropic'));
    await service.removeProviderCredential('anthropic');
    await service.switchWorkspace(workspace);
    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, false,
      'removing a shared credential must refresh already loaded workspace runtimes');
    assert.ok(service.listModels().every(({ provider }) => provider !== 'anthropic'));
    await service.setProviderApiKey('anthropic', dummyKey);

    const model = service.listModels().find(({ provider, reasoning }) => provider === 'anthropic' && reasoning);
    assert.ok(model, 'Anthropic reasoning model should be available after login');
    await service.setModel(model.provider, model.id);
    const selected = service.getSnapshot();
    assert.equal(selected.modelProvider, model.provider);
    assert.equal(selected.model, model.id);
    assert.equal(selected.modelName, model.name.trim());
    assert.equal(events.findLast((event) => event.type === 'model').modelName, model.name.trim());
    assert.ok(selected.availableThinkingLevels.includes(selected.thinkingLevel));
    assert.equal(selected.contextUsage.contextWindow, model.contextWindow);
    assert.deepEqual(events.findLast((event) => event.type === 'model').contextUsage, selected.contextUsage);
    assert.ok(events.some((event) => event.type === 'model' && event.modelProvider === model.provider && event.model === model.id));

    await service.switchWorkspace(otherWorkspace);
    await service.switchWorkspace(workspace);
    assert.equal(service.getSnapshot().modelName, model.name.trim());
    assert.equal(events.findLast((event) => event.type === 'ready').modelName, model.name.trim(), 'activating a cached runtime restores its selected model name');

    const desired = selected.availableThinkingLevels.includes('medium') ? 'medium' : 'off';
    await service.setThinkingLevel(desired);
    assert.equal(service.getSnapshot().thinkingLevel, desired);
    if (selected.thinkingLevel !== desired) {
      assert.ok(events.some((event) => event.type === 'thinking-level' && event.level === desired));
    }
    assert.ok(!JSON.stringify(service.getSnapshot()).includes(dummyKey));
    assert.ok(!JSON.stringify(events).includes(dummyKey));
    assert.ok(!JSON.stringify(service.listModels()).includes(dummyKey));
    assert.ok(!JSON.stringify(service.listProviderAuth()).includes(dummyKey));

    await service.dispose();
    service = new AgentService();
    await service.init({ cwd: workspace });
    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, true);
    assert.equal(service.getSnapshot().modelProvider, model.provider);
    assert.equal(service.getSnapshot().model, model.id);
    assert.equal(service.getSnapshot().modelName, model.name.trim());
    await service.removeProviderCredential('anthropic');
    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, false);
    assert.ok(service.listModels().every(({ provider }) => provider !== 'anthropic'));
  } finally {
    await service?.dispose();
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const resolvedTemp = resolve(tempRoot);
    const resolvedParent = realpathSync(tmpdir());
    if (!resolvedTemp.startsWith(resolvedParent + sep)) {
      throw new Error('Refusing to remove a test directory outside the temporary folder');
    }
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
