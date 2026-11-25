import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const { AgentQuotaService, antigravityQuotaWindows, codexQuotaWindows, parseClaudeResetTime, parseClaudeUsage, versionAtLeast } = await import('../packages/agent/src/acp/agentQuota.ts');
const { BUILTIN_AGENTS } = await import('../packages/agent/src/acp/agentRegistry.ts');
const FAKE = fileURLToPath(new URL('./fixtures/acp/fake-quota-agent.mjs', import.meta.url));
const fake = (id, quota, env = {}, extra = {}) => ({ id, displayName: id, command: process.execPath, args: [FAKE], env, enabled: true, builtin: true, quota, ...extra });

test('built-in Claude Code, Codex and Antigravity read their plan limits; other agents do not', () => {
	const sources = Object.fromEntries(BUILTIN_AGENTS.map((agent) => [agent.id, agent.quota]));
	assert.equal(sources['claude-code'], 'claude');
	assert.equal(sources.codex, 'codex');
	assert.equal(sources.antigravity, 'antigravity');
	for (const id of ['gemini', 'opencode', 'qwen', 'zcode']) assert.equal(sources[id], undefined, id);
});

test('Antigravity /usage JSON: every model group keeps its own 5-hour and weekly windows', () => {
	const bucket = (window, remaining_fraction, reset_time) => ({ id: window, window, remaining_fraction, reset_time });
	const windows = antigravityQuotaWindows({ command: { name: 'usage', data: { groups: [
		{ name: 'Gemini Models', buckets: [bucket('weekly', 0.9875, '2026-12-02T11:02:02Z'), bucket('5h', 0.25, '2026-11-25T23:00:50Z')] },
		{ name: 'Claude and GPT models', buckets: [bucket('weekly', 1, '1970-01-01T00:00:00Z'), bucket('daily', 0.5, null), { window: '5h' }] },
	] } } });
	assert.deepEqual(windows, [
		{ kind: 'weekly', group: 'Gemini Models', usedPercent: 1.25, resetsAt: Date.UTC(2026, 11, 2, 11, 2, 2) },
		{ kind: 'five_hour', group: 'Gemini Models', usedPercent: 75, resetsAt: Date.UTC(2026, 10, 25, 23, 0, 50) },
		// An untouched window reports the epoch: no reset time.
		{ kind: 'weekly', group: 'Claude and GPT models', usedPercent: 0, resetsAt: null },
		{ kind: 'other', label: 'daily', group: 'Claude and GPT models', usedPercent: 50, resetsAt: null },
	]);
	assert.equal(antigravityQuotaWindows({ command: { name: 'model', data: {} } }), null);
	assert.equal(antigravityQuotaWindows({ response: 'hello' }), null);
	assert.equal(versionAtLeast('1.5.17', [1, 1, 11]), true);
	assert.equal(versionAtLeast('1.1.11', [1, 1, 11]), true);
	assert.equal(versionAtLeast('1.1.9', [1, 1, 11]), false);
	assert.equal(versionAtLeast('0.9', [1, 1, 11]), false);
	assert.equal(versionAtLeast(null, [1, 1, 11]), false);
});

test('AgentQuotaService reads Antigravity in print mode, and only from a CLI that answers /usage without a turn', async () => {
	const workDir = await mkdtemp(join(tmpdir(), 'pi-quota-'));
	const service = new AgentQuotaService({ workDir, timeoutMs: 15_000 });
	// The configured `acp` subcommand is dropped for the print-mode call.
	const agy = (env = {}, version = '1.5.17') => fake('antigravity', 'antigravity', env, { args: [FAKE, 'acp'], version });
	try {
		const quota = await service.read(agy());
		assert.equal(quota.ok, true, quota.error);
		assert.deepEqual(quota.windows.map((window) => [window.group, window.kind, window.usedPercent]), [
			['Gemini Models', 'weekly', 25], ['Gemini Models', 'five_hour', 10], ['Claude and GPT models', 'weekly', 0], ['Claude and GPT models', 'five_hour', 60],
		]);
		// Exit code 2: an API-key login, which has no account quota.
		const apiKey = await service.read(agy({ FAKE_QUOTA_AGY_EXIT: '2' }), true);
		assert.deepEqual([apiKey.ok, apiKey.windows], [true, []]);
		const failed = await service.read(agy({ FAKE_QUOTA_AGY_EXIT: '1' }), true);
		assert.equal(failed.ok, false);
		assert.match(failed.error, /no account quota/);
		// Older CLIs would send `/usage` to the model as a prompt: never run them.
		for (const version of ['1.1.10', null]) {
			const old = await service.read(fake('agy-old', 'antigravity', {}, { args: [FAKE, 'acp'], version }));
			assert.equal(old.ok, false);
			assert.match(old.error, /1\.1\.11/);
		}
	} finally { await rm(workDir, { recursive: true, force: true }); }
});

test('Codex rate limits: the default limit gives the 5-hour and weekly windows, other limits are labelled', () => {
	const window = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });
	const result = codexQuotaWindows({
		rateLimitsByLimitId: {
			codex_spark: { limitId: 'codex_spark', limitName: 'Spark', primary: window(40, 300, 100), secondary: null },
			codex: { limitId: 'codex', limitName: null, primary: window(12, 300, 1_800_000_000), secondary: window(85, 10080, 1_800_400_000), planType: 'plus' },
		},
	});
	assert.equal(result.plan, 'plus');
	assert.deepEqual(result.windows, [
		{ kind: 'five_hour', usedPercent: 12, resetsAt: 1_800_000_000_000 },
		{ kind: 'weekly', usedPercent: 85, resetsAt: 1_800_400_000_000 },
		{ kind: 'other', label: 'Spark 5h', usedPercent: 40, resetsAt: 100_000 },
	]);
	// Older app-servers send only `rateLimits`; odd windows and bad values are handled.
	const legacy = codexQuotaWindows({ rateLimits: { primary: window(150, 60, null), secondary: { usedPercent: 'x' } } });
	assert.deepEqual(legacy, { plan: null, windows: [{ kind: 'other', label: '1h', usedPercent: 100, resetsAt: null }] });
	assert.deepEqual(codexQuotaWindows({}), { plan: null, windows: [] });
});

test('Claude /usage Markdown: limits, plan and reset times', () => {
	const now = Date.UTC(2026, 11, 30);
	const text = ['## Usage', '', '> Claude max subscription usage', '', '### Limits', '',
		'**5-hour limit** — **37%** · Resets Jan 2, 3:00 PM GMT+8', '', '`████░░`', '',
		'**Weekly · all models** — **100%** · Resets Dec 31, 9:30 AM GMT-5:30', '',
		'**Weekly · Claude Opus 4\\_5** — **8%**', '', '---', '### This session', '| $0.00 | 0s | 1s |'].join('\n');
	assert.deepEqual(parseClaudeUsage(text, now), {
		plan: 'max',
		windows: [
			{ kind: 'five_hour', usedPercent: 37, resetsAt: Date.UTC(2027, 0, 2, 7, 0) },
			{ kind: 'weekly', usedPercent: 100, resetsAt: Date.UTC(2026, 11, 31, 15, 0) },
			{ kind: 'other', label: 'Claude Opus 4_5', usedPercent: 8, resetsAt: null },
		],
	});
	// An account without plan limits (an API key) renders no Limits section.
	assert.deepEqual(parseClaudeUsage('## Usage\n\n---\n\n### This session', now), { plan: null, windows: [] });
	// Not the adapter's rendering: Claude Code's own output was forwarded.
	assert.equal(parseClaudeUsage('Unknown command', now), null);
});

test('Claude reset times: GMT offsets, the local zone, and the year rollover', () => {
	const now = new Date(2026, 5, 1, 12, 0).getTime();
	assert.equal(parseClaudeResetTime('Jun 1, 3:05 PM PDT', now), new Date(2026, 5, 1, 15, 5).getTime());
	assert.equal(parseClaudeResetTime('Jun 1, 12:00 AM GMT', now), Date.UTC(2026, 5, 1, 0, 0));
	assert.equal(parseClaudeResetTime('Jun 2, 12:30 PM UTC+1', now), Date.UTC(2026, 5, 2, 11, 30));
	assert.equal(parseClaudeResetTime('Jan 3, 1:00 AM', now), new Date(2027, 0, 3, 1, 0).getTime());
	assert.equal(parseClaudeResetTime('2026-06-03T10:00:00Z', now), Date.UTC(2026, 5, 3, 10));
	assert.equal(parseClaudeResetTime('soon', now), null);
});

test('AgentQuotaService reads Codex and Claude Code through their own processes, caches, and keeps the last reading', async () => {
	const workDir = await mkdtemp(join(tmpdir(), 'pi-quota-'));
	let clock = 1_000;
	const service = new AgentQuotaService({ workDir, now: () => clock, timeoutMs: 15_000 });
	try {
		const codex = await service.read(fake('codex', 'codex'));
		assert.equal(codex.ok, true, codex.error);
		assert.equal(codex.plan, 'plus');
		assert.deepEqual(codex.windows.map((window) => [window.kind, window.usedPercent]), [['five_hour', 12], ['weekly', 85], ['other', 40]]);

		const claude = await service.read(fake('claude-code', 'claude'));
		assert.equal(claude.ok, true, claude.error);
		assert.equal(claude.plan, 'max');
		assert.deepEqual(claude.windows.map((window) => [window.kind, window.usedPercent]), [['five_hour', 37], ['weekly', 100], ['other', 8]]);

		// Within the cache window the reading is reused; concurrent refreshes share one process.
		clock += 60_000;
		assert.equal(await service.read(fake('codex', 'codex')), codex);
		const first = service.read(fake('codex', 'codex'), true), second = service.read(fake('codex', 'codex'), true);
		assert.equal(first, second);
		assert.equal((await first).queriedAt, clock);

		// A failed refresh reports the error and keeps the last known windows.
		clock += 1;
		const failed = await service.read(fake('claude-code', 'claude', { FAKE_QUOTA_FAIL: '1' }), true);
		assert.equal(failed.ok, false);
		assert.match(failed.error, /没有返回额度/);
		assert.equal(failed.windows.length, 3);
		const codexFailed = await service.read(fake('codex-2', 'codex', { FAKE_QUOTA_FAIL: '1' }));
		assert.equal(codexFailed.ok, false);
		assert.match(codexFailed.error, /not signed in/);
		assert.deepEqual(codexFailed.windows, []);

		const unsupported = await service.read(fake('gemini', undefined));
		assert.equal(unsupported.ok, false);
	} finally { await rm(workDir, { recursive: true, force: true }); }
});

test('AgentQuotaService stops a read that does not answer', async () => {
	const workDir = await mkdtemp(join(tmpdir(), 'pi-quota-'));
	const service = new AgentQuotaService({ workDir, timeoutMs: 1_500 });
	try {
		const quota = await service.read(fake('claude-code', 'claude', { FAKE_QUOTA_HANG: '1' }));
		assert.equal(quota.ok, false);
		assert.match(quota.error, /超时/);
	} finally { await rm(workDir, { recursive: true, force: true }); }
});
