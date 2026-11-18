// 切回已加载的会话时，后端补发该会话自己的子代理面板（含"没有"），且事件带会话归属。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function stubContext(sessionPath, subagentFleet) {
	return {
		cwd: 'C:/workspace',
		get canEvict() { return true; },
		getSnapshot: () => ({
			cwd: 'C:/workspace', sessionId: `id:${sessionPath}`, sessionPath, subagentFleet,
			model: 'model', modelName: null, modelProvider: 'provider', thinkingLevel: 'off', availableThinkingLevels: ['off'],
			contextUsage: null, messages: [], activities: [], runs: [], fileChanges: [], fileChangeTurns: [], fileChangeActiveRunId: null,
			historyTotal: 0, status: 'idle', statusMessage: undefined, queuedCount: 0, queuedMessages: [], error: null,
		}),
		async dispose() { },
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'pi-fleet-switch-'));
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const service = new AgentService();
	const events = [];
	service.onEvent(({ event }) => events.push(event));
	return {
		service, events,
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

test('activating a warm conversation replays its fleet after its ready', async () => {
	const f = await fixture();
	try {
		const fleet = { owner: 'a' };
		const a = stubContext('C:/sessions/a.jsonl', fleet), b = stubContext('C:/sessions/b.jsonl', null);
		f.service.contexts.set('a', a);
		f.service.contexts.set('b', b);
		f.service.activate('a', a);
		const types = f.events.map((event) => event.type);
		assert.ok(types.indexOf('subagent-fleet') > types.indexOf('ready'), 'the replay follows the ready that re-scopes the view');
		assert.deepEqual(f.events.find((event) => event.type === 'subagent-fleet'), { type: 'subagent-fleet', fleet, sessionPath: 'C:/sessions/a.jsonl' });
		f.events.length = 0;
		f.service.activate('b', b);
		assert.deepEqual(f.events.find((event) => event.type === 'subagent-fleet'), { type: 'subagent-fleet', fleet: null, sessionPath: 'C:/sessions/b.jsonl' },
			'a conversation without a fleet replays its absence');
	} finally { await f.cleanup(); }
});
