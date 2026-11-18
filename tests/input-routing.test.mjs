// 输入按所属会话投递：首条消息在用户切走后仍送达它自己的（已转入后台的）新会话。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function stubContext(sessionId) {
	const received = [];
	return {
		received,
		context: {
			cwd: 'C:/workspace',
			get canEvict() { return true; },
			ownsSession: (id) => id === sessionId,
			getSnapshot: () => ({ modelProvider: 'provider', model: 'model', sessionId }),
			async submitInput(request) { received.push(request.id); return { id: request.id, state: 'accepted' }; },
			async dispose() { },
		},
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'pi-input-routing-'));
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const service = new AgentService();
	const background = stubContext('created'), active = stubContext('elsewhere');
	service.contexts.set('background', background.context);
	service.contexts.set('active', active.context);
	service.active = active.context;
	return {
		service, background, active,
		async cleanup() {
			await service.dispose();
			for (const [name, value] of [['PI_CODING_AGENT_DIR', saved.dir], ['PI_OFFLINE', saved.offline]]) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test('input reaches the loaded conversation it names even when another one is active', async () => {
	const f = await fixture();
	try {
		await f.service.submitInput({ id: 'first-input', sessionId: 'created', text: 'hello' });
		assert.deepEqual(f.background.received, ['first-input']);
		assert.deepEqual(f.active.received, []);
		await f.service.submitInput({ id: 'active-input', sessionId: 'elsewhere', text: 'here' });
		assert.deepEqual(f.active.received, ['active-input']);
	} finally { await f.cleanup(); }
});

test('input naming no loaded conversation keeps the active context ownership check', async () => {
	const f = await fixture();
	try {
		await f.service.submitInput({ id: 'unknown-input', sessionId: 'unloaded', text: 'lost?' });
		assert.deepEqual(f.active.received, ['unknown-input'], 'the active context decides (and rejects a foreign session itself)');
		assert.deepEqual(f.background.received, []);
	} finally { await f.cleanup(); }
});
