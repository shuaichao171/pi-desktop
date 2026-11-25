// Fake agents for plan-limit reads. With `cli app-server` it answers like the Codex
// app-server; otherwise it is an ACP agent whose `/usage` prints claude-agent-acp's Markdown.
// FAKE_QUOTA_FAIL=1 makes the read fail; FAKE_QUOTA_HANG=1 never answers it.
import { createInterface } from 'node:readline';

const codex = process.argv.includes('app-server');
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

const CODEX_LIMITS = {
	rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1_800_400_000 }, planType: 'plus' },
	rateLimitsByLimitId: {
		codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1_800_400_000 }, planType: 'plus' },
		codex_spark: { limitId: 'codex_spark', limitName: 'Spark', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null },
	},
};

const USAGE_TEXT = process.env.FAKE_QUOTA_USAGE_TEXT ?? [
	'## Usage', '', '> Claude max subscription usage', '', '### Limits', '',
	'**5-hour limit** — **37%** · Resets Jan 2, 3:00 PM GMT+8', '', '`████████░░░░░░░░░░░░`', '',
	'**Weekly · all models** — **100%** · Resets Jan 5, 9:30 AM GMT+8', '', '`████████████████████`', '',
	'**Weekly · Opus** — **8%**', '', '---', '', '### This session',
].join('\n');

// `agy -p /usage --output-format json`: one JSON object, no turn. FAKE_QUOTA_AGY_EXIT=2 is an API-key login.
if (process.argv.includes('-p')) {
	if (process.argv[process.argv.indexOf('-p') + 1] !== '/usage' || !process.argv.includes('json')) { process.stderr.write('unexpected arguments'); process.exit(1); }
	if (process.env.FAKE_QUOTA_AGY_EXIT) { process.stderr.write('no account quota'); process.exit(Number(process.env.FAKE_QUOTA_AGY_EXIT)); }
	const bucket = (id, window, remaining_fraction, reset_time) => ({ id, name: id, window, remaining_fraction, reset_time });
	process.stdout.write(`${JSON.stringify({ conversation_id: '', status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
		{ name: 'Gemini Models', buckets: [bucket('gemini-weekly', 'weekly', 0.75, '2026-12-02T11:02:02Z'), bucket('gemini-5h', '5h', 0.9, '2026-11-25T23:00:50Z')] },
		{ name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 'weekly', 1, '1970-01-01T00:00:00Z'), bucket('3p-5h', '5h', 0.4, '2026-11-26T01:00:00Z')] },
	] } } })}\n`);
	process.exit(0);
}

createInterface({ input: process.stdin }).on('line', (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	const { id, method, params } = message;
	if (id === undefined) return;
	if (codex) {
		if (method === 'initialize') return respond(id, { userAgent: 'fake-codex' });
		if (method === 'account/rateLimits/read') {
			if (process.env.FAKE_QUOTA_HANG === '1') return;
			if (process.env.FAKE_QUOTA_FAIL === '1') return fail(id, 'not signed in');
			return respond(id, CODEX_LIMITS);
		}
		return fail(id, `unknown ${method}`);
	}
	if (method === 'initialize') return respond(id, { protocolVersion: 1, agentCapabilities: {} });
	if (method === 'session/new') {
		const options = params?._meta?.claudeCode?.options;
		// The read must neither save the session nor load the user's settings (hooks, plugins).
		if (options?.persistSession !== false || !Array.isArray(options?.settingSources) || options.settingSources.length) return fail(id, 'unsafe session options');
		return respond(id, { sessionId: 'quota-session' });
	}
	if (method === 'session/prompt') {
		if (process.env.FAKE_QUOTA_HANG === '1') return;
		const text = params?.prompt?.[0]?.text;
		const reply = text === '/usage' && process.env.FAKE_QUOTA_FAIL !== '1' ? USAGE_TEXT : 'Unknown command';
		for (let index = 0; index < reply.length; index += 40) {
			send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(index, index + 40) } } } });
		}
		return respond(id, { stopReason: 'end_turn' });
	}
	fail(id, `unknown ${method}`);
});
