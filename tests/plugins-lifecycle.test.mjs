import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

async function fixture(run, extension = 'export default function (pi) { pi.registerCommand("plugin-marker", { description: "Fixture", handler: async () => {} }); }') {
  const root = mkdtempSync(join(tmpdir(), 'pi-plugin-lifecycle-'));
  const cwd = join(root, 'workspace');
  const other = join(root, 'other');
  const agentDir = join(root, 'agent');
  const path = join(agentDir, 'extensions', 'fixture.ts');
  mkdirSync(cwd); mkdirSync(other); mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(path, extension);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    await service.init({ cwd });
    await run({ service, cwd, other, agentDir, path, root });
  } finally {
    await service?.dispose();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!resolve(root).startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
}

test('global extension mutations reload every cached session sequentially and preserve unsaved identities', async () => {
  await fixture(async ({ service, cwd, other, path }) => {
    const firstId = service.getSnapshot().sessionId;
    await service.newSession();
    const secondId = service.getSnapshot().sessionId;
    await service.switchWorkspace(other);
    const thirdId = service.getSnapshot().sessionId;
    const contexts = [...service.contexts.values()];
    const ids = contexts.map((context) => context.getSnapshot().sessionId);
    assert.deepEqual(ids, [firstId, secondId, thirdId]);
    let reloading = false;
    let count = 0;
    for (const context of contexts) {
      assert.ok(context.listSlashCommands().some((command) => command.name === 'plugin-marker'));
      const reload = context.runtime.session.reload.bind(context.runtime.session);
      context.runtime.session.reload = async (...args) => {
        assert.equal(reloading, false, 'shared SDK registry reloads must not overlap');
        reloading = true;
        try { await reload(...args); count += 1; }
        finally { reloading = false; }
      };
    }
    const catalog = await service.mutatePlugin({ cwd: other, action: 'set-enabled', path, kind: 'extensions', scope: 'user', enabled: false });
    assert.equal(count, 3);
    assert.equal(catalog.resources.find((item) => item.path === path).loaded, false);
    assert.deepEqual(contexts.map((context) => context.getSnapshot().sessionId), ids);
    for (const context of contexts) assert.equal(context.listSlashCommands().some((command) => command.name === 'plugin-marker'), false);
    await service.switchWorkspace(cwd);
    assert.equal(service.getSnapshot().sessionId, secondId);
  });
});

test('plugin mutation reserves all sessions synchronously and shutdown waits for it', async () => {
  await fixture(async ({ service, cwd, other }) => {
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    const context = service.active;
    const apply = context.applyPluginMutation.bind(context);
    context.applyPluginMutation = async (input) => { await gate; await apply(input); };
    const mutation = service.mutatePlugin({ cwd, action: 'reload' });
    const refusals = [
      service.prompt('must not contact a model'),
      service.newSession(),
      service.switchWorkspace(other),
      service.setModel('unused', 'unused'),
      service.setThinkingLevel('off'),
      service.setProviderApiKey('unused', 'unused'),
      service.removeCustomProvider('unused'),
      service.mutatePlugin({ cwd, action: 'reload' }),
    ];
    let shutdown;
    try {
      await Promise.all(refusals.map((promise) => assert.rejects(promise, /插件.*更新/)));
      let disposed = false;
      shutdown = service.dispose().then(() => { disposed = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(disposed, false);
      assert.ok(context.runtime, 'shutdown must not destroy the runtime used by mutation');
    } finally { finish(); await mutation; await shutdown; }
    assert.equal(service.contexts.size, 0);
  });
});

test('inactive busy sessions and stale workspace requests reject plugin changes before settings writes', async () => {
  await fixture(async ({ service, cwd, other, path }) => {
    const first = service.active;
    await service.switchWorkspace(other);
    first.activePromptCalls += 1;
    try {
      await assert.rejects(service.mutatePlugin({ cwd: other, action: 'set-enabled', path, kind: 'extensions', scope: 'user', enabled: false }), /全部会话空闲/);
      await assert.rejects(service.setExtensionEnabled(path, false), /全部会话空闲/);
      await assert.rejects(service.mutatePlugin({ cwd, action: 'reload' }), /工作区已变化/);
    } finally { first.activePromptCalls -= 1; }
    assert.equal((await service.getPluginCatalog(other)).resources.find((item) => item.path === path).enabled, true);
  });
});

test('missing configured packages defer reload without installing or invalidating the existing runtime', async () => {
  await fixture(async ({ service, cwd, root, agentDir }) => {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [join(root, 'missing-local-package')] }));
    service.active.runtime.session.reload = async () => { throw new Error('unsafe reload should not run'); };
    const catalog = await service.mutatePlugin({ cwd, action: 'reload' });
    assert.ok(catalog.warnings.some((warning) => /未重载任何会话/.test(warning)));
    assert.ok(catalog.packages.some((item) => !item.installed));
    assert.ok(service.listSlashCommands().some((command) => command.name === 'plugin-marker'));
  });
});

test('a failed runtime reload blocks stale extension execution until a successful reload recovers it', async () => {
  await fixture(async ({ service, cwd }) => {
    const context = service.active;
    const reload = context.runtime.session.reload.bind(context.runtime.session);
    context.runtime.session.reload = async () => { throw new Error('reload-fixture-failure'); };
    const failed = await service.mutatePlugin({ cwd, action: 'reload' });
    assert.ok(failed.warnings.some((warning) => warning.includes('reload-fixture-failure')));
    await assert.rejects(service.prompt('/plugin-marker'), /插件重载失败/);
    context.runtime.session.reload = reload;
    const recovered = await service.mutatePlugin({ cwd, action: 'reload' });
    assert.equal(recovered.warnings.some((warning) => warning.includes('reload-fixture-failure')), false);
    await service.prompt('/plugin-marker');
    assert.equal(service.getSnapshot().status, 'idle');
  });
});

test('reload reports extension load failures and removes stale extension model providers', async () => {
  await fixture(async ({ service, cwd, path, agentDir }) => {
    assert.ok(service.active.runtime.session.modelRuntime.getRegisteredProviderIds().includes('fixture-provider'));
    await service.setModel('fixture-provider', 'fixture-model', false);
    const before = service.getSnapshot();
    const disabled = await service.mutatePlugin({ cwd, action: 'set-enabled', path, kind: 'extensions', scope: 'user', enabled: false });
    assert.equal(service.active.runtime.session.modelRuntime.getRegisteredProviderIds().includes('fixture-provider'), false);
    assert.equal(service.getSnapshot().sessionId, before.sessionId);
    assert.ok(disabled.warnings.some((warning) => /模型所属插件已停用/.test(warning)));
    await assert.rejects(service.prompt('must not use the stale model'), /选择其他可用模型/);
    assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultModel, undefined);
    writeFileSync(path, 'export default function () { throw new Error("broken-fixture-extension"); }');
    const broken = await service.mutatePlugin({ cwd, action: 'set-enabled', path, kind: 'extensions', scope: 'user', enabled: true });
    assert.ok(broken.warnings.some((warning) => warning.includes('broken-fixture-extension')));
    assert.equal(broken.resources.find((item) => item.path === path).loaded, false);
  }, `export default function (pi) {
    pi.registerProvider('fixture-provider', {
      baseUrl: 'https://example.invalid', api: 'openai-completions', apiKey: 'offline-fixture',
      models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 }]
    });
  }`);
});
