import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

function request(provider = 'desktop-custom-test', overrides = {}) {
  return {
    provider, name: 'Desktop Custom Test', baseUrl: 'https://models.example.invalid/v1',
    api: 'openai-completions', mode: 'create',
    models: [{ id: 'custom-one', name: 'Custom One', reasoning: true, input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096 }],
    ...overrides,
  };
}

function contents(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-desktop-custom-providers-'));
  const cwd = join(root, 'workspace');
  const otherCwd = join(root, 'other-workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(otherCwd); mkdirSync(agentDir);
  const modelsPath = join(agentDir, 'models.json');
  const authPath = join(agentDir, 'auth.json');
  if (options.models) writeFileSync(modelsPath, JSON.stringify(options.models, null, 2));
  if (options.busyCommand) {
    const extensionDir = join(cwd, '.pi', 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, 'hold-provider-test.ts'), `
      export default function (pi) {
        pi.registerCommand('hold-provider-test', {
          description: 'Keep a real SDK command active for a configuration race test',
          handler: async (_args, ctx) => { await ctx.ui.input('hold-provider-test'); },
        });
      }
    `);
  }
  if (options.extraExtension) {
    const extensionDir = join(cwd, '.pi', 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, 'extra-provider-test.ts'), options.extraExtension);
  }
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_CUSTOM_PROVIDER_LITERAL_SECRET']
    .map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  process.env.PI_CUSTOM_PROVIDER_LITERAL_SECRET = 'must-not-interpolate-this-value';
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('Network is forbidden in custom-provider configuration tests');
  };
  let service;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await service?.dispose(); } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of environment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const resolvedRoot = resolve(root);
      if (!resolvedRoot.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
  };
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    const open = async () => {
      service = new AgentService(async () => ({ trusted: true, remember: false }), options.dialog ?? (async () => null));
      await service.init({ cwd });
    };
    await open();
    return {
      get service() { return service; }, cwd, otherCwd, modelsPath, authPath,
      assertOffline() { assert.equal(networkCalls, 0, 'configuration and catalog refresh must not contact a provider'); },
      disk() { return { models: contents(modelsPath), auth: contents(authPath) }; },
      async reopen() { await service.dispose(); await open(); },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test('all four custom-provider protocols persist and unauthenticated models remain visible in settings', async () => {
  const f = await fixture();
  try {
    await f.service.switchWorkspace(f.otherCwd);
    await f.service.switchWorkspace(f.cwd);
    for (const [index, api] of APIS.entries()) {
      const provider = `desktop-protocol-${index}`;
      await f.service.saveCustomProvider(request(provider, { api }));
      const summary = (await f.service.listModelProviders()).find((item) => item.provider === provider);
      assert.ok(summary, `${api} must be listed without a credential`);
      assert.equal(summary.name, 'Desktop Custom Test');
      assert.equal(summary.custom, true);
      assert.equal(summary.editable, true);
      assert.equal(summary.configured, false);
      assert.equal(summary.api, api);
      assert.equal(summary.baseUrl, 'https://models.example.invalid/v1');
      assert.equal(summary.models[0].id, 'custom-one');
      assert.equal(summary.models[0].provider, provider);
      assert.equal(summary.models[0].contextWindow, 32768);
      assert.ok(f.service.listModels().every((model) => model.provider !== provider), 'the usable-model picker still requires authentication');
    }
    const persisted = JSON.parse(contents(f.modelsPath));
    for (const [index, api] of APIS.entries()) assert.equal(persisted.providers[`desktop-protocol-${index}`].api, api);
    await f.service.switchWorkspace(f.otherCwd);
    for (let index = 0; index < APIS.length; index += 1) {
      assert.ok((await f.service.listModelProviders()).some((item) => item.provider === `desktop-protocol-${index}`),
        'already cached runtime catalogs must receive the new provider');
    }
    await f.reopen();
    for (let index = 0; index < APIS.length; index += 1) {
      assert.ok((await f.service.listModelProviders()).some((item) => item.provider === `desktop-protocol-${index}`));
    }
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('custom-provider keys are literal secrets and omitted keys survive update and restart', async () => {
  const f = await fixture();
  try {
    const key = '!echo $PI_CUSTOM_PROVIDER_LITERAL_SECRET-${PI_CUSTOM_PROVIDER_LITERAL_SECRET}-$$';
    const provider = 'desktop-literal-secret';
    await f.service.saveCustomProvider(request(provider, { apiKey: key }));
    const stored = JSON.parse(contents(f.authPath));
    assert.equal(stored[provider].type, 'api_key');
    assert.ok(typeof stored[provider].key === 'string' && stored[provider].key.length > 0);
    assert.equal(JSON.parse(contents(f.modelsPath)).providers[provider].apiKey, undefined, 'secrets belong in auth.json');
    const checkKey = async () => {
      const auth = await f.service.active.runtime.session.modelRuntime.getAuth(provider);
      assert.equal(auth?.auth.apiKey, key, 'leading ! and dollar references must remain literal');
      const summaries = await f.service.listModelProviders();
      const summary = summaries.find((item) => item.provider === provider);
      assert.equal(summary.configured, true);
      assert.ok(!JSON.stringify(summaries).includes(key));
      assert.ok(!JSON.stringify(summaries).includes('must-not-interpolate-this-value'));
      assert.ok(!JSON.stringify(summaries).includes('"apiKey"'));
    };
    await checkKey();
    const authBefore = contents(f.authPath);
    await f.service.saveCustomProvider(request(provider, { mode: 'update', name: 'Renamed Provider', baseUrl: 'http://127.0.0.1:12345/v1' }));
    assert.equal(contents(f.authPath), authBefore, 'omitting apiKey must leave the existing credential untouched');
    await checkKey();
    await f.reopen();
    await checkKey();
    assert.equal((await f.service.listModelProviders()).find((item) => item.provider === provider).name, 'Renamed Provider');
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('provider updates and deletion preserve unrelated and unrecognized models.json fields', async () => {
  const untouched = {
    name: 'Other Provider', baseUrl: 'https://other.example.invalid/v1', api: 'openai-responses',
    models: [{ id: 'other-model', desktopModelExtra: { keep: true } }], desktopExtra: ['leave', 'intact'],
  };
  const edited = {
    name: 'Existing Provider', baseUrl: 'https://old.example.invalid/v1', api: 'openai-completions',
    headers: { 'x-project': 'keep-header' }, desktopExtra: { untouched: 42 },
    models: [{ id: 'custom-one', desktopModelExtra: 'keep-model-extra', compat: { supportsStore: false } }],
  };
  const f = await fixture({ models: { desktopTopLevelExtra: { revision: 7 }, providers: { 'desktop-preserve': edited, 'desktop-untouched': untouched } } });
  try {
    await f.service.saveCustomProvider(request('desktop-preserve', { mode: 'update', name: 'Updated Provider' }));
    let saved = JSON.parse(contents(f.modelsPath));
    assert.deepEqual(saved.desktopTopLevelExtra, { revision: 7 });
    assert.deepEqual(saved.providers['desktop-untouched'], untouched);
    assert.deepEqual(saved.providers['desktop-preserve'].desktopExtra, edited.desktopExtra);
    assert.deepEqual(saved.providers['desktop-preserve'].headers, edited.headers);
    assert.equal(saved.providers['desktop-preserve'].models[0].desktopModelExtra, 'keep-model-extra');
    assert.deepEqual(saved.providers['desktop-preserve'].models[0].compat, { supportsStore: false });
    await f.service.removeCustomProvider('desktop-preserve');
    saved = JSON.parse(contents(f.modelsPath));
    assert.equal(saved.providers['desktop-preserve'], undefined);
    assert.deepEqual(saved.providers['desktop-untouched'], untouched);
    assert.deepEqual(saved.desktopTopLevelExtra, { revision: 7 });
    assert.ok((await f.service.listModelProviders()).every((item) => item.provider !== 'desktop-preserve'));
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('invalid custom-provider input and built-in mutations never change either configuration file', async () => {
  const f = await fixture();
  try {
    await f.service.saveCustomProvider(request('desktop-existing'));
    const invalid = [
      ['duplicate create', request('desktop-existing')],
      ['missing update', request('desktop-missing', { mode: 'update' })],
      ['built-in create', request('anthropic')],
      ['built-in update', request('anthropic', { mode: 'update' })],
      ['empty models', request('desktop-invalid', { models: [] })],
      ['duplicate model IDs', request('desktop-invalid', { models: [{ id: 'same' }, { id: 'same' }] })],
      ['empty model ID', request('desktop-invalid', { models: [{ id: '' }] })],
      ['unsupported protocol', request('desktop-invalid', { api: 'openai-websocket' })],
      ['non-HTTP URL', request('desktop-invalid', { baseUrl: 'file:///C:/secret' })],
      ['URL username', request('desktop-invalid', { baseUrl: 'https://username@example.invalid/v1' })],
      ['URL password', request('desktop-invalid', { baseUrl: 'https://user:password@example.invalid/v1' })],
      ['URL query', request('desktop-invalid', { baseUrl: 'https://example.invalid/v1?key=secret' })],
      ['URL hash', request('desktop-invalid', { baseUrl: 'https://example.invalid/v1#fragment' })],
      ['negative context', request('desktop-invalid', { models: [{ id: 'one', contextWindow: -1 }] })],
      ['invalid input modality', request('desktop-invalid', { models: [{ id: 'one', input: ['audio'] }] })],
      ['header name injection', request('desktop-invalid', { headers: { 'x-name\r\ninjected': 'value' } })],
      ['header value injection', request('desktop-invalid', { headers: { 'x-name': 'value\r\ninjected' } })],
      ['reserved transport header', request('desktop-invalid', { headers: { Host: 'other.example.invalid' } })],
      ['case-insensitive duplicate headers', request('desktop-invalid', { headers: { Authorization: 'first', authorization: 'second' } })],
      ['oversized header value', request('desktop-invalid', { headers: { 'x-value': 'x'.repeat(16385) } })],
      ['too many headers', request('desktop-invalid', { headers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-${index}`, 'v'])) })],
      ['oversized total headers', request('desktop-invalid', { headers: { 'x-one': 'x'.repeat(12000), 'x-two': 'x'.repeat(12000), 'x-three': 'x'.repeat(12000) } })],
      ['missing preserved header', request('desktop-existing', { mode: 'update', headers: { 'x-missing': null } })],
      ['proxy string', request('desktop-invalid', { useSystemProxy: 'true' })],
      ['proxy null', request('desktop-invalid', { useSystemProxy: null })],
      ['unknown thinking level', request('desktop-invalid', { models: [{ id: 'one', thinkingLevelMap: { ultra: 'high' } }] })],
      ['invalid thinking value', request('desktop-invalid', { models: [{ id: 'one', thinkingLevelMap: { low: 3 } }] })],
      ['blank thinking value', request('desktop-invalid', { models: [{ id: 'one', thinkingLevelMap: { low: ' ' } }] })],
      ['thinking value injection', request('desktop-invalid', { models: [{ id: 'one', thinkingLevelMap: { low: 'low\nhigh' } }] })],
      ['oversized thinking value', request('desktop-invalid', { models: [{ id: 'one', thinkingLevelMap: { low: 'x'.repeat(81) } }] })],
      ['thinking map array', request('desktop-invalid', { models: [{ id: 'one', thinkingLevelMap: ['low'] }] })],
    ];
    for (const [label, value] of invalid) {
      const before = f.disk();
      await assert.rejects(f.service.saveCustomProvider({ ...value, apiKey: 'must-not-be-written' }), undefined, label);
      assert.deepEqual(f.disk(), before, label);
    }
    const before = f.disk();
    await assert.rejects(f.service.removeCustomProvider('anthropic'));
    assert.deepEqual(f.disk(), before, 'built-in deletion must be rejected before file changes');
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('malformed or invalid existing models.json is rejected without overwriting user data', async () => {
  const f = await fixture();
  try {
    await f.service.saveCustomProvider(request('desktop-existing'));
    const original = contents(f.modelsPath);
    for (const broken of ['{"providers":', '{"providers":[]}', '{"providers":{"bad":{"models":"invalid"}}}']) {
      writeFileSync(f.modelsPath, broken);
      const before = f.disk();
      await assert.rejects(f.service.saveCustomProvider(request('desktop-new', { apiKey: 'not-written' })));
      assert.deepEqual(f.disk(), before);
      await assert.rejects(f.service.removeCustomProvider('desktop-existing'));
      assert.deepEqual(f.disk(), before);
    }
    writeFileSync(f.modelsPath, original);
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('cached sessions protect their selected provider and model, while same-model edits refresh their metadata', async () => {
  const f = await fixture();
  try {
    const provider = 'desktop-selected';
    await f.service.saveCustomProvider(request(provider, { apiKey: 'local-test-key' }));
    await f.service.setModel(provider, 'custom-one');
    const selectedSession = f.service.getSnapshot().sessionId;
    await f.service.switchWorkspace(f.otherCwd);
    await f.service.setProviderApiKey('anthropic', 'local-anthropic-key');
    const alternate = f.service.listModels().find((model) => model.provider === 'anthropic');
    assert.ok(alternate);
    await f.service.setModel(alternate.provider, alternate.id);
    assert.notEqual(f.service.getSnapshot().modelProvider, provider);
    const before = f.disk();
    await assert.rejects(f.service.removeCustomProvider(provider));
    assert.deepEqual(f.disk(), before, 'an inactive loaded session still owns its current provider');
    await assert.rejects(f.service.saveCustomProvider(request(provider, { mode: 'update', models: [{ id: 'replacement-only' }] })));
    assert.deepEqual(f.disk(), before, 'updating must not remove an inactive session\'s selected model');
    await f.service.saveCustomProvider(request(provider, { mode: 'update', models: [{ id: 'custom-one', name: 'Updated Selected Model', contextWindow: 65536, maxTokens: 8192 }] }));
    await f.service.switchWorkspace(f.cwd);
    assert.equal(f.service.getSnapshot().sessionId, selectedSession);
    assert.equal(f.service.getSnapshot().modelName, 'Updated Selected Model');
    assert.equal(f.service.getSnapshot().contextUsage.contextWindow, 65536);
    assert.equal(f.service.active.runtime.session.model.maxTokens, 8192);
    await f.service.setModel(alternate.provider, alternate.id);
    await f.service.removeCustomProvider(provider);
    assert.ok((await f.service.listModelProviders()).every((item) => item.provider !== provider));
    await f.service.switchWorkspace(f.otherCwd);
    assert.ok((await f.service.listModelProviders()).every((item) => item.provider !== provider), 'deletion refreshes all cached catalogs');
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('a busy background SDK session blocks provider writes until its command has finished', async () => {
  let release;
  let started;
  const commandStarted = new Promise((resolveStarted) => { started = resolveStarted; });
  const f = await fixture({
    busyCommand: true,
    dialog: async (value) => {
      if (value.kind !== 'input' || value.title !== 'hold-provider-test') return null;
      return new Promise((resolveDialog) => { release = () => resolveDialog('done'); started(); });
    },
  });
  let command;
  try {
    await f.service.saveCustomProvider(request('desktop-busy-delete'));
    command = f.service.prompt('/hold-provider-test');
    await commandStarted;
    await f.service.switchWorkspace(f.otherCwd);
    const before = f.disk();
    await assert.rejects(f.service.saveCustomProvider(request('desktop-busy-create', { apiKey: 'not-written' })));
    assert.deepEqual(f.disk(), before);
    await assert.rejects(f.service.removeCustomProvider('desktop-busy-delete'));
    assert.deepEqual(f.disk(), before);
    release();
    await command;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    await f.service.saveCustomProvider(request('desktop-after-idle'));
    await f.service.removeCustomProvider('desktop-busy-delete');
    f.assertOffline();
  } finally {
    release?.();
    await command?.catch(() => {});
    await f.cleanup();
  }
});

test('advanced external providers are read-only and sensitive endpoint URLs never reach the settings catalog', async () => {
  const external = {
    'desktop-url-user': { ...request(), baseUrl: 'https://private-user@example.invalid/v1' },
    'desktop-url-password': { ...request(), baseUrl: 'https://private-user:private-password@example.invalid/v1' },
    'desktop-url-query': { ...request(), baseUrl: 'https://example.invalid/v1?key=private-query-secret' },
    'desktop-unknown-api': { ...request(), api: 'external-future-protocol' },
    'desktop-model-api': { ...request(), models: [{ id: 'model-override', api: 'openai-responses' }] },
  };
  for (const config of Object.values(external)) {
    delete config.provider;
    delete config.mode;
  }
  const f = await fixture({ models: { providers: external } });
  try {
    const summaries = await f.service.listModelProviders();
    const serialized = JSON.stringify(summaries);
    for (const secret of ['private-user', 'private-password', 'private-query-secret']) {
      assert.ok(!serialized.includes(secret), 'credentials embedded in external URLs must not be returned to the renderer');
    }
    for (const provider of Object.keys(external)) {
      const summary = summaries.find((item) => item.provider === provider);
      assert.ok(summary, 'externally managed providers must remain discoverable');
      assert.equal(summary.custom, true);
      assert.equal(summary.editable, false, provider);
      if (provider.startsWith('desktop-url-')) assert.equal(summary.baseUrl, null, provider);
      const before = f.disk();
      await assert.rejects(f.service.saveCustomProvider(request(provider, { mode: 'update' })));
      await assert.rejects(f.service.removeCustomProvider(provider));
      assert.deepEqual(f.disk(), before, 'read-only external configuration must survive attempted mutations');
    }
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('credential failures redact secrets, restore provider data, and release configuration locks', async () => {
  const f = await fixture();
  let releaseCredential;
  let saving;
  let source;
  let originalWrite;
  try {
    await f.service.saveCustomProvider(request('desktop-rollback-other'));
    await f.service.saveCustomProvider(request('desktop-rollback', { apiKey: 'previous-local-key' }));
    await f.service.switchWorkspace(f.otherCwd);
    await f.service.switchWorkspace(f.cwd);
    source = f.service.active;
    originalWrite = source.writeProviderCredential;
    const before = f.disk();
    const previousProviders = JSON.parse(before.models).providers;
    const beforeAuth = JSON.parse(before.auth);
    const events = [];
    f.service.onEvent(({ event }) => events.push(event));
    const secret = 'private-credential-failure-must-never-reach-renderer';
    let started;
    const credentialStarted = new Promise((resolveStarted) => { started = resolveStarted; });
    let attempts = 0;
    source.writeProviderCredential = async function (provider, key) {
      attempts += 1;
      if (attempts === 1) {
        await new Promise((resolveCredential) => { releaseCredential = resolveCredential; started(); });
        throw new Error(`Simulated SDK storage error containing ${secret}`);
      }
      return originalWrite.call(this, provider, key);
    };
    saving = f.service.saveCustomProvider(request('desktop-rollback', {
      mode: 'update', apiKey: secret, name: 'Must Roll Back', baseUrl: 'https://changed.example.invalid/v1',
    }));
    const rejected = assert.rejects(saving, (error) => {
      assert.ok(!String(error).includes(secret), 'errors returned by the host must not contain raw credential failures');
      assert.ok(!error.cause, 'the original secret-bearing error must not be attached as a cause');
      return true;
    });
    await credentialStarted;
    assert.throws(() => f.service.prompt('blocked while changing credentials'), /更新|updat/i);
    await assert.rejects(f.service.newSession(), /更新|updat/i);
    releaseCredential();
    await rejected;
    assert.ok(attempts >= 2, 'the saved credential must be restored after a partial transaction');
    assert.equal(contents(f.modelsPath), before.models, 'restore exact original models.json content');
    assert.deepEqual(JSON.parse(contents(f.authPath)), beforeAuth);
    assert.deepEqual(JSON.parse(contents(f.modelsPath)).providers['desktop-rollback-other'], previousProviders['desktop-rollback-other']);
    assert.ok(!JSON.stringify(events).includes(secret));
    for (const context of f.service.contexts.values()) assert.equal(context.canEvict, true, 'all context locks must be released');
    source.writeProviderCredential = originalWrite;
    await f.service.saveCustomProvider(request('desktop-rollback', { mode: 'update', name: 'Save After Recovery' }));
    assert.equal((await f.service.listModelProviders()).find((item) => item.provider === 'desktop-rollback').name, 'Save After Recovery');
    f.assertOffline();
  } finally {
    releaseCredential?.();
    await saving?.catch(() => {});
    if (source && originalWrite) source.writeProviderCredential = originalWrite;
    await f.cleanup();
  }
});

test('providers registered by a cached workspace extension cannot be overwritten from another workspace', async () => {
  const provider = 'desktop-cached-extension';
  const f = await fixture({
    extraExtension: `
      export default function (pi) {
        pi.registerProvider('${provider}', {
          baseUrl: 'https://extension.example.invalid/v1',
          api: 'openai-completions',
          models: [{
            id: 'extension-owned-model', name: 'Extension Owned Model', reasoning: false,
            input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16384, maxTokens: 2048,
          }],
        });
      }
    `,
  });
  try {
    const originalContext = f.service.active;
    const originalSession = f.service.getSnapshot().sessionId;
    const originalModels = structuredClone(originalContext.runtime.session.modelRuntime.getModels(provider));
    assert.equal(originalModels[0]?.id, 'extension-owned-model', 'the provider must come from a real loaded Pi extension');
    const initial = (await f.service.listModelProviders()).find((item) => item.provider === provider);
    assert.ok(initial);
    assert.equal(initial.editable, false);
    await f.service.switchWorkspace(f.otherCwd);
    assert.ok((await f.service.listModelProviders()).every((item) => item.provider !== provider),
      'the active workspace does not know the other workspace\'s extension');
    assert.ok([...f.service.contexts.values()].includes(originalContext), 'the original runtime remains cached');
    const before = f.disk();
    await assert.rejects(f.service.saveCustomProvider(request(provider, { apiKey: 'must-not-overwrite-extension' })), /扩展|extension/i);
    assert.deepEqual(f.disk(), before, 'neither shared models.json nor auth.json may be changed');
    assert.deepEqual(originalContext.runtime.session.modelRuntime.getModels(provider), originalModels);
    await f.service.switchWorkspace(f.cwd);
    assert.equal(f.service.getSnapshot().sessionId, originalSession);
    assert.deepEqual(f.service.active.runtime.session.modelRuntime.getModels(provider), originalModels);
    assert.equal((await f.service.listModelProviders()).find((item) => item.provider === provider).models[0]?.id, 'extension-owned-model');
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('custom headers stay literal, remain private, and support preserve, replace, delete, and restart', async () => {
  const f = await fixture();
  const provider = 'desktop-header-persistence';
  const authorization = 'Bearer literal-${PI_CUSTOM_PROVIDER_LITERAL_SECRET}-$$';
  const commandLiteral = '!echo $PI_CUSTOM_PROVIDER_LITERAL_SECRET';
  try {
    await f.service.saveCustomProvider(request(provider, {
      apiKey: 'fixture-api-key', headers: { Authorization: authorization, 'X-Literal': commandLiteral }, useSystemProxy: false,
    }));
    async function check(expectedHeaders, expectedProxy) {
      const runtime = f.service.active.runtime.session.modelRuntime;
      const model = runtime.getModels(provider).find((item) => item.id === 'custom-one');
      assert.ok(model);
      const auth = await runtime.getAuth(model);
      for (const [name, value] of Object.entries(expectedHeaders)) {
        const actual = Object.entries(auth.auth.headers ?? {}).find(([header]) => header.toLowerCase() === name.toLowerCase());
        assert.equal(actual?.[1], value, 'configured headers must remain literal in the real SDK request');
      }
      const summary = (await f.service.listModelProviders()).find((item) => item.provider === provider);
      assert.deepEqual(summary.headerNames.map((name) => name.toLowerCase()).sort(), Object.keys(expectedHeaders).map((name) => name.toLowerCase()).sort());
      assert.equal(summary.useSystemProxy, expectedProxy);
      const serialized = JSON.stringify(summary);
      for (const secret of [authorization, commandLiteral, 'must-not-interpolate-this-value', 'fixture-api-key']) assert.ok(!serialized.includes(secret));
      return auth.auth.headers;
    }
    await check({ Authorization: authorization, 'X-Literal': commandLiteral }, false);
    const originalHeaders = JSON.parse(contents(f.modelsPath)).providers[provider].headers;
    assert.equal(JSON.parse(contents(f.modelsPath)).providers[provider].desktopUseSystemProxy, false);

    await f.service.saveCustomProvider(request(provider, { mode: 'update', name: 'Omitted options stay intact' }));
    assert.deepEqual(JSON.parse(contents(f.modelsPath)).providers[provider].headers, originalHeaders);
    await check({ Authorization: authorization, 'X-Literal': commandLiteral }, false);

    await f.service.saveCustomProvider(request(provider, { mode: 'update', headers: { authorization: null, 'X-New': 'new-literal-value' }, useSystemProxy: true }));
    const headers = await check({ authorization, 'X-New': 'new-literal-value' }, true);
    assert.ok(!Object.keys(headers).some((name) => name.toLowerCase() === 'x-literal'), 'omitted rows in an explicit header object are removed');
    assert.equal(JSON.parse(contents(f.modelsPath)).providers[provider].headers.authorization, originalHeaders.Authorization, 'null preserves the exact stored expression without exposing it');
    await f.reopen();
    await check({ authorization, 'X-New': 'new-literal-value' }, true);

    await f.service.saveCustomProvider(request(provider, { mode: 'update', headers: {} }));
    assert.deepEqual(JSON.parse(contents(f.modelsPath)).providers[provider].headers, {});
    await check({}, true);
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('thinking-level maps persist into the SDK and update selected-session choices across restart', async () => {
  const f = await fixture();
  const provider = 'desktop-thinking-mapping';
  const thinkingLevelMap = { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
  try {
    const configuredModel = { ...request().models[0], thinkingLevelMap };
    await f.service.saveCustomProvider(request(provider, { api: 'openai-responses', apiKey: 'fixture-thinking-key', models: [configuredModel] }));
    await f.service.setModel(provider, configuredModel.id);
    assert.deepEqual(f.service.getSnapshot().availableThinkingLevels, ['off', 'low', 'high', 'max']);
    assert.deepEqual(f.service.active.runtime.session.model.thinkingLevelMap, thinkingLevelMap);
    const summary = (await f.service.listModelProviders()).find((item) => item.provider === provider).models[0];
    assert.deepEqual(summary.thinkingLevelMap, thinkingLevelMap);
    assert.deepEqual(summary.thinkingLevels, ['off', 'low', 'high', 'max']);
    await f.service.setThinkingLevel('max');
    assert.equal(f.service.getSnapshot().thinkingLevel, 'max');

    await f.service.saveCustomProvider(request(provider, { mode: 'update', api: 'openai-responses' }));
    assert.deepEqual(JSON.parse(contents(f.modelsPath)).providers[provider].models[0].thinkingLevelMap, thinkingLevelMap, 'omitting a map preserves the existing explicit model mapping');
    await f.reopen();
    await f.service.setModel(provider, configuredModel.id);
    assert.deepEqual(f.service.getSnapshot().availableThinkingLevels, ['off', 'low', 'high', 'max']);

    const mediumOnly = { off: null, minimal: null, low: null, medium: 'medium', high: null, xhigh: null, max: null };
    await f.service.saveCustomProvider(request(provider, { mode: 'update', api: 'openai-responses', models: [{ ...configuredModel, thinkingLevelMap: mediumOnly }] }));
    assert.deepEqual(f.service.getSnapshot().availableThinkingLevels, ['medium']);
    assert.equal(f.service.getSnapshot().thinkingLevel, 'medium', 'the SDK clamps a selected level that the new map disables');
    assert.deepEqual(f.service.listModels().find((model) => model.provider === provider).thinkingLevels, ['medium']);
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('Gemini preserves independent input/output limits while total-context protocols reject an oversized output', async () => {
  const f = await fixture();
  const limits = { id: 'independent-limits', contextWindow: 8192, maxTokens: 32768 };
  try {
    await f.service.saveCustomProvider(request('desktop-gemini-limits', { api: 'google-generative-ai', models: [limits] }));
    const model = (await f.service.listModelProviders()).find((item) => item.provider === 'desktop-gemini-limits').models[0];
    assert.equal(model.contextWindow, 8192);
    assert.equal(model.maxTokens, 32768);
    const before = f.disk();
    await assert.rejects(f.service.saveCustomProvider(request('desktop-openai-limits', { models: [limits] })));
    assert.deepEqual(f.disk(), before);
    f.assertOffline();
  } finally { await f.cleanup(); }
});

test('model discovery resolves saved credentials and draft overrides without persisting a model response', async () => {
  const f = await fixture();
  const provider = 'desktop-discovery-auth';
  const savedKey = 'saved-fixture-key-${PI_CUSTOM_PROVIDER_LITERAL_SECRET}';
  const savedHeader = '!echo $PI_CUSTOM_PROVIDER_LITERAL_SECRET';
  const calls = [];
  let responseStatus = 200;
  let fixtureFetch;
  try {
    await f.service.saveCustomProvider(request(provider, { apiKey: savedKey, headers: { 'X-Private-Tenant': savedHeader } }));
    const before = f.disk();
    fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect });
      return new Response(JSON.stringify(responseStatus === 200
        ? { data: [{ id: 'discovered-only-model', name: 'Discovered Only', context_length: 65536, max_output_tokens: 8192, reasoning: true }] }
        : { error: `private response containing ${savedKey}` }), { status: responseStatus, headers: { 'content-type': 'application/json' } });
    };
    let result = await f.service.discoverProviderModels({ provider });
    assert.equal(result.models[0].id, 'discovered-only-model');
    assert.equal(calls[0].url, 'https://models.example.invalid/v1/models');
    assert.equal(calls[0].headers.authorization, `Bearer ${savedKey}`);
    assert.equal(calls[0].headers['x-private-tenant'], savedHeader);
    assert.equal(calls[0].redirect, 'manual');
    assert.deepEqual(f.disk(), before, 'discovery must not save its catalog or resolved credentials');
    assert.ok(!f.service.listModels().some((model) => model.id === 'discovered-only-model'));
    assert.ok(!JSON.stringify(result).includes(savedKey));
    assert.ok(!JSON.stringify(result).includes(savedHeader));

    await f.service.discoverProviderModels({ provider, apiKey: 'draft-replacement-key', headers: { 'X-Private-Tenant': null, 'X-New-Draft': 'draft-value' } });
    assert.equal(calls.at(-1).headers.authorization, 'Bearer draft-replacement-key');
    assert.equal(calls.at(-1).headers['x-private-tenant'], savedHeader);
    assert.equal(calls.at(-1).headers['x-new-draft'], 'draft-value');
    await f.service.discoverProviderModels({ provider, headers: {} });
    assert.equal(calls.at(-1).headers['x-private-tenant'], undefined, 'an explicit empty header map applies the pending deletion');
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${savedKey}`);

    result = await f.service.discoverProviderModels({ baseUrl: 'http://localhost:12345/v1', api: 'openai-responses', apiKey: 'unsaved-provider-key', headers: { 'X-Draft': 'unsaved-header' } });
    assert.equal(calls.at(-1).url, 'http://localhost:12345/v1/models');
    assert.equal(calls.at(-1).headers.authorization, 'Bearer unsaved-provider-key');
    assert.equal(calls.at(-1).headers['x-draft'], 'unsaved-header');
    assert.equal(result.models.length, 1);
    assert.deepEqual(f.disk(), before);

    const beforeRejected = calls.length;
    for (const changed of [
      { provider, baseUrl: 'https://other.example.invalid/v1', api: 'openai-completions' },
      { provider, baseUrl: 'https://other.example.invalid/v1', api: 'openai-completions', apiKey: 'new-origin-key', headers: { 'X-Private-Tenant': null } },
      { provider, headers: { 'X-No-Such-Header': null } },
    ]) await assert.rejects(f.service.discoverProviderModels(changed));
    assert.equal(calls.length, beforeRejected, 'changing origin cannot reuse stored secrets or preserved header placeholders');
    await f.service.discoverProviderModels({ provider, baseUrl: 'https://other.example.invalid/v1', api: 'openai-completions', apiKey: 'new-origin-key' });
    assert.equal(calls.at(-1).headers.authorization, 'Bearer new-origin-key');
    assert.equal(calls.at(-1).headers['x-private-tenant'], undefined);

    responseStatus = 401;
    await assert.rejects(f.service.discoverProviderModels({ provider }), (error) => error.status === 401 && !String(error).includes(savedKey));
    assert.deepEqual(f.disk(), before, 'failed discovery must also leave both files untouched');
    f.assertOffline();
  } finally {
    if (fixtureFetch) globalThis.fetch = fixtureFetch;
    await f.cleanup();
  }
});

test('model preferences persist per-provider disabled ids and survive reloads', async () => {
  const { loadModelPrefs, setModelDisabled, getCachedDisabledModels } = await import('../packages/agent/src/customProviders.ts');
  const root = mkdtempSync(join(tmpdir(), 'pi-desktop-model-prefs-'));
  try {
    assert.deepEqual(await loadModelPrefs(root), {}, 'missing prefs start empty');
    await setModelDisabled(root, 'deepseek', 'deepseek-chat', true);
    await setModelDisabled(root, 'deepseek', 'deepseek-reasoner', true);
    await setModelDisabled(root, 'kimi', 'moonshot-v1', true);
    await setModelDisabled(root, 'deepseek', 'deepseek-chat', false);
    assert.deepEqual(getCachedDisabledModels(), { deepseek: ['deepseek-reasoner'], kimi: ['moonshot-v1'] }, 'cache reflects the last write');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'model-prefs.json'), 'utf8')), { disabled: { deepseek: ['deepseek-reasoner'], kimi: ['moonshot-v1'] } }, 'prefs persist to disk');
    await loadModelPrefs(join(root, 'uncached'));
    assert.deepEqual(await loadModelPrefs(root), { deepseek: ['deepseek-reasoner'], kimi: ['moonshot-v1'] }, 'a fresh cache reloads the same prefs from disk');
    writeFileSync(join(root, 'model-prefs.json'), '{ not json');
    await loadModelPrefs(join(root, 'uncached'));
    assert.deepEqual(await loadModelPrefs(root), {}, 'corrupt prefs fall back to empty');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('model visibility changes lock every runtime and never hide an in-use model', async () => {
  const f = await fixture();
  try {
    const current = f.service.getSnapshot();
    assert.ok(current.modelProvider && current.model, 'fixture must select a current model');
    await assert.rejects(f.service.setModelEnabled(current.modelProvider, current.model, false), /正在使用/);
    const providers = await f.service.listModelProviders();
    const candidate = providers.flatMap((provider) => provider.models).find((model) => model.provider !== current.modelProvider || model.id !== current.model);
    assert.ok(candidate, 'fixture must expose another model for visibility preferences');
    await f.service.setModelEnabled(candidate.provider, candidate.id, false);
    let provider = (await f.service.listModelProviders()).find((item) => item.provider === candidate.provider);
    assert.ok(provider.disabledModels?.includes(candidate.id));
    assert.ok(!f.service.listModels().some((model) => model.provider === candidate.provider && model.id === candidate.id));
    await f.service.setModelEnabled(candidate.provider, candidate.id, true);
    provider = (await f.service.listModelProviders()).find((item) => item.provider === candidate.provider);
    assert.ok(!provider.disabledModels?.includes(candidate.id));
    f.assertOffline();
  } finally {
    await f.cleanup();
  }
});
