// Minimal ACP agent for tests: newline-delimited JSON-RPC on stdio.
// Behavior is driven by the prompt text:
//   "slow"   waits for session/cancel and ends the turn as cancelled
//   "auth"   fails with the ACP auth-required error
//   "crash"  exits the process mid-turn
//   "question" asks an ACP form question ("withdraw question" cancels the request)
//   other    thinks, replies, runs one tool behind a permission request
//            ("always-only": the request offers no allow_once option)
// FAKE_ACP_STEER=1: a prompt sent while "slow" runs ends that turn (end_turn) and is
// handled next, like Antigravity.
import { createInterface } from 'node:readline';

const loadSupported = process.env.FAKE_ACP_LOAD === '1';
const steerSupported = process.env.FAKE_ACP_STEER === '1';
const codexVersion = process.env.FAKE_ACP_CODEX_VERSION;
// FAKE_ACP_ACCEPT_EDITS=1: the mode lists also offer an "accept edits" mode.
const acceptEdits = process.env.FAKE_ACP_ACCEPT_EDITS === '1' ? [{ value: 'acceptEdits', name: 'Accept edits' }] : [];
// FAKE_ACP_SETTINGS=options: config options (grouped model values, reasoning effort, mode);
// FAKE_ACP_SETTINGS=modes: only the older `modes` list.
const settings = process.env.FAKE_ACP_SETTINGS ?? '';
const option = { model: 'fake-large', effort: 'medium', mode: 'ask' };
const configOptions = () => [
	{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: option.model, options: [
		{ group: 'current', name: 'Current', options: [{ value: 'fake-large', name: 'Fake Large', description: 'Most capable' }, { value: 'fake-small', name: 'Fake Small' }] },
		{ group: 'legacy', name: 'Legacy', options: [{ value: 'fake-old', name: 'Fake Old' }] },
	] },
	{ id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: option.effort, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High', description: 'Deeper reasoning' }] },
	{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: option.mode, options: [{ value: 'ask', name: 'Ask' }, ...acceptEdits, { value: 'auto', name: 'Auto' }] },
	{ id: 'toggle', name: 'Unsupported toggle', type: 'boolean', currentValue: true },
];
const sessionSettings = () => ({
	models: { currentModelId: option.model, availableModels: [{ modelId: 'fake-large', name: 'Fake Large' }, { modelId: 'fake-small', name: 'Fake Small' }] },
	...(settings === 'options' ? { configOptions: configOptions() } : {}),
	...(settings === 'modes' ? { modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, ...acceptEdits.map((mode) => ({ id: mode.value, name: mode.name })), { id: 'auto', name: 'Auto', description: 'No questions' }] } } : {}),
});
let nextId = 1000;
const waiting = new Map();
let cancelled = null;
let formSupported = false;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const ask = (method, params, withdraw = false) => new Promise((resolve) => {
	const id = nextId++;
	waiting.set(id, resolve);
	send({ id, method, params });
	if (withdraw) send({ method: '$/cancel_request', params: { requestId: id } });
});

async function prompt(id, params) {
	const { sessionId, prompt: blocks } = params;
	// Keywords come from the user's own text (the last block); earlier blocks carry context.
	const text = blocks.filter((block) => block.type === 'text').at(-1)?.text ?? '';
	if (text.includes('auth')) { send({ id, error: { code: -32000, message: 'Authentication required' } }); return; }
	if (text.includes('crash')) { process.exit(3); }
	if (text.endsWith('question')) {
		if (!formSupported) { send({ id, error: { code: -32601, message: 'Form capability missing' } }); return; }
		const async = text === 'async question';
		const answer = ask('elicitation/create', {
			sessionId, mode: 'form', message: 'Choose a release target.',
			requestedSchema: { type: 'object', title: 'Release options', properties: {
				target: { type: 'string', title: 'Environment', oneOf: [{ const: 'stage', title: 'Staging', description: 'Test first' }, { const: 'prod', title: 'Production' }] },
				checks: { type: 'array', items: { anyOf: [{ const: 'unit', title: 'Unit tests' }, { const: 'build', title: 'Build' }] } },
				note: { type: 'string', title: 'Additional answer or note' },
			}, ...(async ? {} : { required: ['target'] }) },
			...(async ? { _meta: { codex: { delivery: 'async' } } } : {}),
		}, text === 'withdraw question');
		if (async) send({ id, result: { stopReason: 'end_turn' } });
		const reply = await answer;
		if (async) {
			update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: reply?.content?.target ?? 'cancelled', description: 'Async answer received' }] });
		} else {
			update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(reply) } });
			send({ id, result: { stopReason: 'end_turn' } });
		}
		return;
	}
	if (text.includes('slow')) {
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
		const stopReason = await new Promise((resolve) => { cancelled = resolve; });
		send({ id, result: { stopReason } });
		return;
	}
	update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering ' } });
	update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the request' } });
	update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `blocks=${blocks.length} ` } });
	update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
	update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Run tests', status: 'in_progress', priority: 'high' }] });
	update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Run tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
	const answer = await ask('session/request_permission', {
		sessionId,
		toolCall: { toolCallId: 'call-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } },
		options: [
			...(text.includes('always-only') ? [] : [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]),
			{ optionId: 'always', name: 'Always allow', kind: 'allow_always' },
			{ optionId: 'no', name: 'Reject', kind: 'reject_once' },
		],
	});
	const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId !== 'no';
	update(sessionId, allowed
		? { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'all tests passed' } }] }
		: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected by user' } }] });
	update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Done.' : 'Skipped.' } });
	send({ id, result: { stopReason: 'end_turn' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id !== undefined && !message.method) { waiting.get(message.id)?.(message.result); waiting.delete(message.id); return; }
	switch (message.method) {
		case 'initialize':
			formSupported = message.params.clientCapabilities?.elicitation?.form != null;
			send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: loadSupported, promptCapabilities: { image: false } }, authMethods: [{ id: 'login', name: 'fake login' }],
				...(codexVersion ? { agentInfo: { name: '@agentclientprotocol/codex-acp', version: codexVersion }, _meta: { steering: { supported: true } } } : {}),
			} });
			return;
		case 'session/new':
			send({ id: message.id, result: { sessionId: 'fake-session', ...sessionSettings() } });
			update('fake-session', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'scope' } }] });
			return;
		case 'session/load':
			update(message.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } });
			update(message.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' } });
			// Like real agents, a loaded session starts again from the default settings.
			send({ id: message.id, result: settings ? sessionSettings() : {} });
			return;
		case 'session/set_model':
			send({ id: message.id, result: {} });
			return;
		case 'session/set_config_option': {
			const { configId, value } = message.params;
			if (!(configId in option)) { send({ id: message.id, error: { code: -32602, message: `Unknown option ${configId}` } }); return; }
			option[configId] = value;
			// Choosing the large model raises the effort, announced as an update.
			if (configId === 'model' && value === 'fake-large') {
				option.effort = 'high';
				update(message.params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions() });
			}
			send({ id: message.id, result: { configOptions: configOptions() } });
			return;
		}
		case 'session/set_mode':
			send({ id: message.id, result: {} });
			update(message.params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: message.params.modeId });
			return;
		case 'session/prompt':
			if (steerSupported && cancelled) { const running = cancelled; cancelled = null; running('end_turn'); }
			void prompt(message.id, message.params);
			return;
		case '_session/steering': {
			const { params, id } = message;
			if (!codexVersion || params._meta?.steering?.idleBehavior !== 'promptRequired') {
				send({ id, error: { code: -32602, message: 'Expected the Codex steering request' } });
				return;
			}
			const text = params.prompt.at(-1).text;
			if (text === 'reject steer') { send({ id, result: { outcome: 'failed' } }); return; }
			if (!cancelled) {
				send({ id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
				update(params.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'steer-waiting' }] });
				return;
			}
			send({ id, result: { outcome: 'injected' } });
			update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Steered: ${text}` } });
			const running = cancelled;
			cancelled = null;
			running('end_turn');
			return;
		}
		case 'session/cancel':
			cancelled?.('cancelled');
			cancelled = null;
			return;
		default:
			if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
});
