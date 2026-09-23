import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

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
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    await service.init({ cwd: workspace });

    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, false);
    assert.ok(service.listModels().every(({ provider }) => provider !== 'anthropic'));
    await assert.rejects(service.setModel('anthropic', 'missing-model'), /模型不可用/);
    await assert.rejects(service.setThinkingLevel('invalid'), /思考级别无效/);

    const dummyKey = 'test-key-never-send-to-renderer';
    await service.setProviderApiKey('anthropic', dummyKey);
    assert.equal(service.listProviderAuth().find(({ provider }) => provider === 'anthropic')?.configured, true);

    const model = service.listModels().find(({ provider, reasoning }) => provider === 'anthropic' && reasoning);
    assert.ok(model, 'Anthropic reasoning model should be available after login');
    await service.setModel(model.provider, model.id);
    const selected = service.getSnapshot();
    assert.equal(selected.modelProvider, model.provider);
    assert.equal(selected.model, model.id);
    assert.ok(selected.availableThinkingLevels.includes(selected.thinkingLevel));
    assert.ok(events.some((event) => event.type === 'model' && event.modelProvider === model.provider && event.model === model.id));

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
