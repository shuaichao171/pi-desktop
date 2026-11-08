// 供应商保存的后台延迟重载回归：
//   - 保存不等待扩展重载（毫秒级返回，文件已落盘）
//   - 连续修改合并为「本轮一次 + 期间改动后再一次」，不会丢最后一次改动
//   - 受影响供应商的 prompt / submitInput / setModel 等重载完成；其它供应商不受影响
//   - 没被扩展镜像的供应商仍然同步刷新（旧行为不变）
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个条件成立（事件是异步 fire 的，不能用固定 sleep 顶）。 */
async function until(predicate, timeout = 3000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(10);
	}
	assert.fail('condition was not reached in time');
}

function model(id = 'm1') {
	return { id, name: id.toUpperCase(), contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ['text'] };
}

function request(provider, overrides = {}) {
	return {
		provider, name: 'Mirrored', baseUrl: 'https://mirrored.example.invalid/v1', api: 'openai-completions',
		mode: 'update', models: [model()], ...overrides,
	};
}

/** 一个上下文替身：只实现 AgentService 供应商保存/发送路径真正用到的表面。 */
function stubContext(options) {
	const state = {
		calls: { reloadPlugins: 0, refreshModelProvider: [], prompts: [], setModels: [] },
		mirrors: new Set(options.mirrors ?? []),
		/// 测试闸门：reloadPlugins 挂在这里，验证保存不等待它。
		blockReload: null,
		concurrentReloads: 0,
		maxConcurrentReloads: 0,
	};
	const context = {
		cwd: options.cwd,
		// SingleAgentService exposes the agent directory; the save path reads models.json from it.
		agentDirectory: options.agentDirectory,
		modelProvider: options.modelProvider ?? '',
		model: options.model ?? '',
		closing: false,
		get canEvict() { return true; },
		usesExtensionProvider: (provider) => state.mirrors.has(provider),
		async reloadPlugins() {
			state.calls.reloadPlugins += 1;
			state.concurrentReloads += 1;
			state.maxConcurrentReloads = Math.max(state.maxConcurrentReloads, state.concurrentReloads);
			try {
				if (state.blockReload) await state.blockReload;
				return [];
			} finally { state.concurrentReloads -= 1; }
		},
		async refreshModelProvider(provider, rebind) { state.calls.refreshModelProvider.push([provider, rebind]); },
		lockProviderConfiguration: () => () => {},
		getSnapshot: () => ({ modelProvider: context.modelProvider, model: context.model }),
		listModelProviders: (document) => Object.keys(document.data.providers).map((id) => ({
			provider: id, custom: true, editable: true, modelsEditable: true, models: [model()],
		})),
		async writeProviderCredential(provider, key) { state.writtenCredentials = [...(state.writtenCredentials ?? []), [provider, key]]; },
		async prompt(text) { state.calls.prompts.push(text); },
		async submitInput(input) { state.calls.prompts.push(input.text); return { id: input.id }; },
		async setModel(provider, id) { state.calls.setModels.push([provider, id]); },
		async dispose() { },
	};
	return { context, state, calls: state.calls };
}

async function fixture(options = {}) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-provider-resync-')));
	const cwd = join(root, 'workspace');
	const agentDir = join(root, 'agent');
	mkdirSync(cwd); mkdirSync(agentDir);
	const writeModels = (providers) => writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2));
	writeModels(options.providers ?? {
		mirrored: { name: 'Mirrored', api: 'openai-completions', baseUrl: 'https://mirrored.example.invalid/v1', models: [model()] },
		plain: { name: 'Plain', api: 'openai-completions', baseUrl: 'https://plain.example.invalid/v1', models: [model()] },
	});
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = '1';
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const service = new AgentService();
	const events = [];
	service.onEvent(({ event }) => events.push(event));
	const active = stubContext({ cwd, agentDirectory: agentDir, modelProvider: options.modelProvider ?? 'mirrored', model: 'm1', mirrors: options.mirrors ?? ['mirrored'] });
	service.active = active.context;
	service.contexts.set('main', active.context);
	return {
		service, active, events, agentDir, cwd,
		disk: () => JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')),
		resyncEvents: () => events.filter((event) => event.type === 'provider-resync'),
		async cleanup() {
			await service.dispose();
			for (const [name, value] of environment) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			const resolved = realpathSync.native(root);
			if (!resolved.startsWith(realpathSync.native(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
			rmSync(resolved, { recursive: true, force: true });
		},
	};
}

test('saving a mirrored provider returns without waiting for the extension rebuild', async () => {
	const f = await fixture();
	let release;
	f.active.state.blockReload = new Promise((resolve) => { release = resolve; });
	const started = Date.now();
	try {
		await f.service.saveCustomProvider(request('mirrored', { baseUrl: 'https://mirrored.example.invalid/v2' }));
		// The save itself must not wait for the reload; only the background pass is still running.
		assert.ok(Date.now() - started < 2000, 'the save must return without waiting for the rebuild');
		assert.equal(f.disk().providers.mirrored.baseUrl, 'https://mirrored.example.invalid/v2', 'the file is already written');
		assert.deepEqual(f.active.calls.refreshModelProvider, [['mirrored', false]], 'the cheap runtime refresh still runs inside the save');
		await until(() => f.active.state.calls.reloadPlugins === 1);
		assert.equal(f.active.state.calls.reloadPlugins, 1);
		assert.deepEqual(f.resyncEvents().map((event) => event.status), ['pending'], 'a pending notice is published before the pass finishes');
		assert.deepEqual(f.resyncEvents()[0].providers, ['mirrored']);
		release();
		await until(() => f.resyncEvents().some((event) => event.status === 'done'));
		assert.deepEqual(f.resyncEvents().map((event) => event.status), ['pending', 'done']);
		assert.deepEqual(f.resyncEvents()[1].providers, ['mirrored']);
		assert.deepEqual(f.resyncEvents()[1].warnings, []);
	} finally {
		release?.();
		await f.cleanup();
	}
});

test('edits that land during a rebuild queue exactly one follow-up rebuild', async () => {
	const f = await fixture({ mirrors: ['mirrored', 'mirrored2'], providers: {
		mirrored: { name: 'Mirrored', api: 'openai-completions', baseUrl: 'https://mirrored.example.invalid/v1', models: [model()] },
		mirrored2: { name: 'Mirrored Two', api: 'openai-completions', baseUrl: 'https://mirrored2.example.invalid/v1', models: [model()] },
		plain: { name: 'Plain', api: 'openai-completions', baseUrl: 'https://plain.example.invalid/v1', models: [model()] },
	} });
	let release;
	f.active.state.blockReload = new Promise((resolve) => { release = resolve; });
	try {
		await f.service.saveCustomProvider(request('mirrored', { baseUrl: 'https://mirrored.example.invalid/v2' }));
		await until(() => f.active.state.calls.reloadPlugins === 1);
		// Two more edits while the first pass is still blocked: both return immediately.
		await f.service.saveCustomProvider(request('mirrored', { baseUrl: 'https://mirrored.example.invalid/v3' }));
		await f.service.saveCustomProvider(request('mirrored2', { baseUrl: 'https://mirrored2.example.invalid/v2' }));
		assert.equal(f.active.state.calls.reloadPlugins, 1, 'the edits coalesce instead of reloading per save');
		assert.equal(f.disk().providers.mirrored.baseUrl, 'https://mirrored.example.invalid/v3');
		assert.equal(f.disk().providers.mirrored2.baseUrl, 'https://mirrored2.example.invalid/v2');
		assert.equal(f.resyncEvents().at(-1).providers.sort().join(','), 'mirrored,mirrored2', 'the pending notice covers every queued provider');
		f.active.state.blockReload = null;
		release();
		await until(() => f.resyncEvents().filter((event) => event.status === 'done').length === 2);
		assert.equal(f.active.state.calls.reloadPlugins, 2, 'the mid-pass edits get their own pass so the newest file wins');
		// Nothing keeps reloading once the burst settled.
		await delay(50);
		assert.equal(f.active.state.calls.reloadPlugins, 2);
		assert.equal(f.active.state.maxConcurrentReloads, 1, 'passes never overlap');
		assert.deepEqual(f.resyncEvents().at(-1).providers.sort(), ['mirrored', 'mirrored2']);
	} finally {
		release?.();
		await f.cleanup();
	}
});

test('a request on a stale provider waits for the rebuild while other providers keep working', async () => {
	const f = await fixture({ mirrors: ['mirrored'] });
	let release;
	f.active.state.blockReload = new Promise((resolve) => { release = resolve; });
	try {
		await f.service.saveCustomProvider(request('mirrored', { baseUrl: 'https://mirrored.example.invalid/v2' }));
		await until(() => f.active.state.calls.reloadPlugins === 1);
		// The active session uses the stale provider: the send must wait for the pass.
		const pendingPrompt = f.service.prompt('uses stale provider');
		const unrelated = f.service.prompt('uses another provider');
		await delay(30);
		assert.deepEqual(f.active.calls.prompts, [], 'a send on the stale provider waits for the rebuild');
		assert.equal(f.active.state.calls.prompts.length, 0);
		// The other context's provider is not in the pending set, so it may send at once.
		f.active.context.modelProvider = 'plain';
		const fast = f.service.prompt('unrelated provider');
		await fast;
		assert.deepEqual(f.active.state.calls.prompts, ['unrelated provider']);
		assert.equal(f.active.state.calls.prompts.includes('uses stale provider'), false);
		f.active.state.blockReload = null;
		release();
		await pendingPrompt;
		assert.ok(f.active.state.calls.prompts.includes('uses stale provider'), 'the waiting send resumes after the rebuild');
		await unrelated;
	} finally {
		release?.();
		await f.cleanup();
	}
});

test('model selection waits for the rebuild and unmapped providers never trigger one', async () => {
	const f = await fixture();
	let release;
	f.active.state.blockReload = new Promise((resolve) => { release = resolve; });
	try {
		await f.service.saveCustomProvider(request('mirrored', { baseUrl: 'https://mirrored.example.invalid/v2' }));
		await until(() => f.active.state.calls.reloadPlugins === 1);
		const selecting = f.service.setModel('mirrored', 'm1');
		await delay(30);
		assert.deepEqual(f.active.calls.setModels, [], 'selecting a model of the stale provider waits');
		f.active.state.blockReload = null;
		release();
		await selecting;
		assert.deepEqual(f.active.calls.setModels, [['mirrored', 'm1']]);

		// A provider no extension mirrors keeps the synchronous path: no pending notice, no reload.
		const before = f.resyncEvents().length;
		await f.service.saveCustomProvider(request('plain', { baseUrl: 'https://plain.example.invalid/v2' }));
		assert.equal(f.active.state.calls.reloadPlugins, 1, 'a provider without a mirror never reloads extensions');
		assert.deepEqual(f.active.calls.refreshModelProvider.at(-1), ['plain', true]);
		assert.equal(f.resyncEvents().length, before);
		assert.equal(f.disk().providers.plain.baseUrl, 'https://plain.example.invalid/v2');
	} finally {
		release?.();
		await f.cleanup();
	}
});
