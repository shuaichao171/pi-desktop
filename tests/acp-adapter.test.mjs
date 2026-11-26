import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const { AcpTurnAssembler, piToolName, planText, toolCommand } = await import('../packages/agent/src/acp/turnAssembler.ts');
const { AcpConversation, parseConfigOption, LEGACY_MODE_OPTION } = await import('../packages/agent/src/acp/conversation.ts');
const { renderHandoffContext, readAgentBinding, readAgentSettings, readIncomingHandoff, hasConversation, AGENT_BINDING_CUSTOM_TYPE, AGENT_SETTINGS_CUSTOM_TYPE, HANDOFF_CUSTOM_TYPE } = await import('../packages/agent/src/acp/handoff.ts');
const { AgentRegistry, BUILTIN_AGENTS } = await import('../packages/agent/src/acp/agentRegistry.ts');
const { resolveCommand, spawnResolved, withAgentSearchPath } = await import('../packages/agent/src/acp/command.ts');
const { claudeExecutableError, withClaudeCodeExecutable } = await import('../packages/agent/src/acp/claudeExecutable.ts');
const { AcpRequestError } = await import('../packages/agent/src/acp/protocol.ts');

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp/fake-agent.mjs', import.meta.url));
const fakeConfig = (env = {}) => ({ id: 'fake', displayName: 'Fake Agent', command: process.execPath, args: [FAKE_AGENT], env, enabled: true, builtin: false });

async function until(check, message, timeout = 10000) {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeout) throw new Error(`timed out: ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function recorder(overrides = {}) {
	const events = [];
	const persisted = [];
	const permissions = [];
	const state = { plan: null, commands: null, models: null, native: [], exits: [] };
	const hooks = {
		emit: (event) => events.push(event),
		persist: (message) => persisted.push(message),
		requestPermission: async (params) => { permissions.push(params); return { outcome: 'selected', optionId: params.options[0].optionId }; },
		requestElicitation: async () => ({ action: 'cancel' }),
		onPlan: (entries) => { state.plan = entries; },
		onCommands: (commands) => { state.commands = commands; },
		onModels: (models, current) => { state.models = { models, current }; },
		onConfigOptions: (options) => { state.options = options; },
		onNativeSession: (id) => state.native.push(id),
		onExit: (message) => state.exits.push(message),
		historyContext: () => 'HISTORY',
		...overrides,
	};
	return { events, persisted, permissions, state, hooks };
}

test('assembler maps ACP updates onto the Pi message/tool event shape', () => {
	const assembler = new AcpTurnAssembler({ cwd: process.cwd(), provider: 'acp:fake', model: 'Fake' });
	const user = assembler.userMessage('hi');
	assert.deepEqual(user.events.map((event) => event.type), ['message_start', 'message_end']);
	assert.equal(user.persist[0].role, 'user');

	const thought = assembler.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
	assert.deepEqual(thought.events.map((event) => event.type), ['message_start', 'message_update']);
	assert.equal(thought.events[1].assistantMessageEvent.type, 'thinking_delta');
	const text = assembler.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
	assert.equal(text.events[0].assistantMessageEvent.type, 'text_delta');
	assert.equal(text.events[0].assistantMessageEvent.partial.content.length, 2);

	const call = assembler.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit file', kind: 'edit', status: 'pending', locations: [{ path: join(process.cwd(), 'src', 'a.ts') }] });
	assert.deepEqual(call.events.map((event) => event.type), ['message_end', 'tool_execution_start']);
	const reply = call.persist[0];
	assert.equal(reply.stopReason, 'toolUse');
	assert.deepEqual(reply.content.map((part) => part.type), ['thinking', 'text', 'toolCall']);
	assert.equal(call.events[1].toolName, 'edit');
	assert.equal(call.events[1].args.path, 'src/a.ts');

	const progress = assembler.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'partial' } }] });
	assert.equal(progress.events[0].type, 'tool_execution_update');
	const done = assembler.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'a\nb' }] });
	assert.equal(done.events[0].type, 'tool_execution_end');
	assert.equal(done.events[0].isError, false);
	assert.equal(done.persist[0].role, 'toolResult');
	assert.match(done.persist[0].content[0].text, /src\/a\.ts: \+2 -1/);

	assembler.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'After' } });
	const plan = assembler.update({ sessionUpdate: 'plan', entries: [{ content: 'Step', status: 'completed' }] });
	assert.equal(planText(plan.plan), '- [x] Step');
	const end = assembler.finish('end_turn');
	assert.deepEqual(end.events.map((event) => event.type), ['message_end']);
	assert.equal(end.persist[0].stopReason, 'stop');
	assert.equal(end.persist[0].content[0].text, 'After');
});

test('assembler closes open tools on cancel and reports refusals as errors', () => {
	const assembler = new AcpTurnAssembler({ cwd: process.cwd(), provider: 'acp:fake', model: 'Fake' });
	assembler.update({ sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'execute', rawInput: { command: ['npm', 'test'] } });
	const cancelled = assembler.finish('cancelled');
	assert.equal(cancelled.events[0].type, 'tool_execution_end');
	assert.equal(cancelled.events[0].isError, true);
	assert.equal(assembler.hasOpenTools, false);
	const refused = new AcpTurnAssembler({ cwd: process.cwd(), provider: 'acp:fake', model: 'Fake' }).finish('refusal');
	assert.equal(refused.persist[0].stopReason, 'error');
	assert.match(refused.persist[0].errorMessage, /拒绝/);
	assert.equal(piToolName('search'), 'grep');
	assert.equal(piToolName(undefined), 'tool');
});

test('conversation runs a full turn against a real ACP process: stream, permission, tools, models, commands', async () => {
	const r = recorder();
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	try {
		let started = false;
		const result = await conversation.prompt({ text: 'please run', contextPrefix: 'CONTEXT', onStarted: () => { started = true; } });
		assert.equal(started, true);
		assert.equal(result.stopReason, 'end_turn');
		assert.deepEqual(r.state.native, ['fake-session']);
		assert.equal(r.state.models.current, 'fake-large');
		assert.deepEqual(r.state.models.models.map((model) => model.id), ['fake-large', 'fake-small']);
		assert.equal(r.permissions.length, 1);
		assert.equal(r.permissions[0].options.length, 3);
		assert.equal(r.state.plan[0].content, 'Run tests');
		const roles = r.persisted.map((message) => message.role);
		assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant']);
		assert.equal(r.persisted[0].content, 'please run', 'the context prefix never enters the transcript');
		const first = r.persisted[1];
		assert.equal(first.content.find((part) => part.type === 'text').text, 'blocks=2 Hello', 'the context prefix travels as its own block');
		assert.equal(first.content.find((part) => part.type === 'thinking').thinking, 'Considering the request');
		assert.equal(r.persisted[2].isError, false);
		assert.equal(r.persisted[3].content[0].text, 'Done.');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(r.state.commands?.[0]?.name, 'review');
		await conversation.setModel('fake-small');
	} finally {
		await conversation.dispose();
	}
});

test('conversation forwards a rejected permission and cancels a running turn', async () => {
	const r = recorder({ requestPermission: async () => ({ outcome: 'selected', optionId: 'no' }) });
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	try {
		await conversation.prompt({ text: 'go' });
		assert.equal(r.persisted.find((message) => message.role === 'toolResult').isError, true);
		const slow = conversation.prompt({ text: 'slow please' });
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(conversation.busy, true);
		conversation.cancel();
		const result = await slow;
		assert.equal(result.stopReason, 'cancelled');
		const last = r.persisted.at(-1);
		assert.equal(last.stopReason, 'aborted');
	} finally {
		await conversation.dispose();
	}
});

test('bypass answers permission requests with allow once (else allow always) and accepts Codex MCP tool approvals; plan exits still ask', async () => {
	let bypass = true;
	const forms = [];
	const r = recorder({ bypassApprovals: () => bypass, requestElicitation: async (request) => { forms.push(request); return { action: 'decline' }; } });
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	const lastText = (role) => r.persisted.filter((message) => message.role === role).at(-1).content.find((part) => part.type === 'text')?.text;
	try {
		await conversation.prompt({ text: 'please run' });
		assert.equal(r.permissions.length, 0, 'no question reaches the user');
		assert.equal(lastText('assistant'), 'Done.');
		await conversation.prompt({ text: 'please run always-only' });
		assert.equal(r.permissions.length, 0);
		assert.equal(lastText('toolResult'), 'Selected: always', 'allow always when the agent offers no allow once');
		await conversation.prompt({ text: 'mcp tool' });
		assert.equal(forms.length, 0);
		assert.equal(lastText('assistant'), 'MCP: {"action":"accept","content":{}}');
		await conversation.prompt({ text: 'exit plan' });
		assert.equal(r.permissions.length, 1, 'leaving plan mode is a plan review, not a permission');
		bypass = false;
		await conversation.prompt({ text: 'please run' });
		assert.equal(r.permissions.length, 2, 'the setting is read per request');
		await conversation.prompt({ text: 'mcp tool' });
		assert.equal(forms.length, 1);
		assert.equal(lastText('assistant'), 'MCP: {"action":"decline"}');
	} finally {
		await conversation.dispose();
	}
});

test('ACP form withdrawal closes the question, and an async form can be answered after its turn', async (t) => {
	const requests = [];
	const r = recorder({ requestElicitation: (request, signal) => new Promise((resolve) => {
		requests.push({ request, signal, resolve });
		signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
	}) });
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	t.after(() => conversation.dispose());
	assert.equal((await conversation.prompt({ text: 'withdraw question' })).stopReason, 'end_turn');
	assert.equal(requests[0].signal.aborted, true);
	assert.deepEqual(JSON.parse(r.persisted.at(-1).content[0].text), { action: 'cancel' });
	assert.equal((await conversation.prompt({ text: 'async question' })).stopReason, 'end_turn');
	assert.equal(requests[1].request.async, true);
	assert.equal(requests[1].signal.aborted, false, 'turn completion does not discard async questions');
	requests[1].resolve({ action: 'accept', content: { target: 'stage' } });
	await until(() => r.state.commands?.[0]?.name === 'stage', 'agent receives the async answer');
});

test('does not enable Codex steering on versions that can start a detached turn', async (t) => {
	const conversation = new AcpConversation(fakeConfig({ FAKE_ACP_CODEX_VERSION: '2.3.0' }), process.cwd(), null, recorder().hooks);
	t.after(() => conversation.dispose());
	await conversation.warmup();
	assert.equal(conversation.supportsSteering, false);
});

test('cancel also stops turns queued behind the running one; they never reach the agent', async () => {
	const r = recorder();
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	try {
		const delivered = [];
		const slow = conversation.prompt({ text: 'slow please', onDelivered: () => delivered.push('slow') });
		const queued = conversation.prompt({ text: 'go', onDelivered: () => delivered.push('go') });
		await new Promise((resolve) => setTimeout(resolve, 150));
		conversation.cancel();
		assert.equal((await slow).stopReason, 'cancelled');
		assert.equal((await queued).stopReason, 'cancelled');
		assert.equal(conversation.busy, false);
		assert.deepEqual(delivered, ['slow'], 'the queued turn was never sent');
		assert.equal(r.permissions.length, 0);
		assert.deepEqual(r.persisted.filter((message) => message.role === 'user').map((message) => (typeof message.content === 'string' ? message.content : message.content[0].text)), ['slow please', 'go'], 'queued text stays in the transcript');
		// The next turn after a cancel runs normally.
		assert.equal((await conversation.prompt({ text: 'go again' })).stopReason, 'end_turn');
	} finally {
		await conversation.dispose();
	}
});

test('conversation explains sign-in requirements and survives an agent crash', async () => {
	const r = recorder();
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	try {
		const auth = await conversation.prompt({ text: 'auth' });
		assert.equal(auth.stopReason, 'error');
		assert.match(auth.error.message, /需要登录.*fake login/);
		const crash = await conversation.prompt({ text: 'crash' });
		assert.equal(crash.stopReason, 'error');
		assert.match(crash.error.message, /退出/);
		const again = await conversation.prompt({ text: 'again' });
		assert.equal(again.stopReason, 'end_turn', 'a crashed agent restarts on the next turn');
	} finally {
		await conversation.dispose();
	}
});

test('a resumed conversation loads the native session when supported, otherwise resends the transcript', async () => {
	const loaded = recorder();
	const native = new AcpConversation(fakeConfig({ FAKE_ACP_LOAD: '1' }), process.cwd(), 'fake-session', loaded.hooks);
	try {
		await native.prompt({ text: 'next' });
		assert.deepEqual(loaded.state.native, [], 'no new native session when load succeeds');
		const reply = loaded.persisted.find((message) => message.role === 'assistant');
		assert.match(reply.content.find((part) => part.type === 'text').text, /^blocks=1 /, 'replayed history is not re-sent or re-rendered');
		assert.ok(!loaded.events.some((event) => event.type === 'message_update' && event.assistantMessageEvent.delta === 'replayed answer'));
	} finally { await native.dispose(); }

	const lost = recorder();
	const fresh = new AcpConversation(fakeConfig(), process.cwd(), 'old-session', lost.hooks);
	try {
		await fresh.warmup();
		assert.equal(lost.state.models.current, 'fake-large');
		assert.deepEqual(lost.state.native, [], 'warming up a replacement keeps the original binding');
		assert.equal((await fresh.prompt({ text: 'auth' })).stopReason, 'error');
		assert.deepEqual(lost.state.native, [], 'a failed prompt leaves the original binding intact');
		await fresh.prompt({ text: 'next' });
		assert.deepEqual(lost.state.native, ['fake-session']);
		const reply = lost.persisted.findLast((message) => message.role === 'assistant' && message.content.some((part) => part.type === 'text' && part.text.startsWith('blocks=')));
		assert.match(reply.content.find((part) => part.type === 'text').text, /^blocks=2 /, 'the transcript travels ahead of the prompt');
	} finally { await fresh.dispose(); }
});

test('handoff rendering keeps the newest items within budget and reads bindings', () => {
	const entries = [
		{ type: 'custom', customType: AGENT_BINDING_CUSTOM_TYPE, data: { agentId: 'codex' } },
		{ type: 'custom', customType: HANDOFF_CUSTOM_TYPE, data: { direction: 'from', sessionPath: '/a.jsonl', fromAgent: 'Pi', toAgent: 'Codex', context: 'x' } },
		...Array.from({ length: 40 }, (_, index) => ({ type: 'message', message: { role: 'user', content: `question ${index} ${'z'.repeat(100)}` } })),
		{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'toolCall', id: '1', name: 'bash', arguments: { command: 'npm   test' } }, { type: 'toolCall', id: '2', name: 'edit', arguments: { path: 'src/a.ts' } }] } },
		{ type: 'custom', customType: AGENT_BINDING_CUSTOM_TYPE, data: { agentId: 'codex', nativeSessionId: 'n1' } },
	];
	const text = renderHandoffContext(entries, 'Pi', 1200);
	assert.ok(text.length <= 1200);
	assert.match(text, /「Pi」/);
	assert.match(text, /较早内容已省略/);
	assert.match(text, /question 39/);
	assert.doesNotMatch(text, /question 0 /);
	assert.match(text, /- 命令：npm test/);
	assert.match(text, /- 改动文件：src\/a\.ts/);
	assert.deepEqual(readAgentBinding(entries), { agentId: 'codex', nativeSessionId: 'n1' });
	assert.equal(readIncomingHandoff(entries).fromAgent, 'Pi');
	assert.equal(hasConversation(entries), true);
	assert.equal(hasConversation(entries.slice(0, 2)), false);
	assert.equal(readAgentBinding([]), null);
	assert.match(renderHandoffContext([], 'Pi'), /没有可交接的内容/);
});

test('registry merges builtins with user edits, validates input and probes passively', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pi-agents-'));
	try {
		const file = join(root, 'desktop-agents.json');
		const registry = new AgentRegistry(file);
		assert.equal(registry.list().length, BUILTIN_AGENTS.length);
		assert.throws(() => registry.save({ displayName: 'x', command: '', args: [], enabled: true }), /字段无效/);
		assert.throws(() => registry.save({ id: 'pi', displayName: 'x', command: 'x', args: [], enabled: true }), /Pi/);
		const custom = registry.save({ displayName: 'My Agent', command: process.execPath, args: [FAKE_AGENT], enabled: true });
		assert.equal(custom.id, 'my-agent');
		registry.save({ id: 'codex', displayName: 'Codex', command: 'definitely-missing-acp-xyz', args: [], enabled: true });
		const reopened = new AgentRegistry(file);
		assert.equal(reopened.get('my-agent').command, process.execPath);
		const statuses = await reopened.statuses(true);
		assert.equal(statuses.find((agent) => agent.id === 'my-agent').readiness, 'ready');
		assert.equal(statuses.find((agent) => agent.id === 'codex').readiness, 'install');
		reopened.save({ id: 'my-agent', displayName: 'My Agent', command: process.execPath, args: [], enabled: false });
		assert.equal((await reopened.statuses()).find((agent) => agent.id === 'my-agent').readiness, 'disabled');
		reopened.remove('codex');
		assert.equal(reopened.get('codex').command, 'codex-acp', 'builtins reset to defaults');
		reopened.remove('my-agent');
		assert.equal(reopened.get('my-agent'), undefined);
		await writeFile(file, '{broken');
		assert.equal(new AgentRegistry(file).list().length, BUILTIN_AGENTS.length);
		assert.equal(resolveCommand(process.execPath), process.execPath);
		assert.equal(resolveCommand('definitely-missing-acp-xyz'), null);
	} finally {
		const path = resolve(root);
		assert.ok(path.startsWith(resolve(tmpdir()) + sep));
		await rm(path, { recursive: true, force: true });
	}
});

test('Windows npm shims receive cmd metacharacters intact, global and node_modules/.bin alike', { skip: process.platform !== 'win32' }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'pi-acp-shim-'));
	try {
		const printer = join(root, 'print.js');
		await writeFile(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
		// The body npm writes for global installs (%APPDATA%\npm\*.cmd).
		const body = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
			'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
			`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${printer}" %*`, ''].join('\r\n');
		const globalShim = join(root, 'npm', 'fake-agent.cmd');
		const binShim = join(root, 'project', 'node_modules', '.bin', 'fake-agent.cmd');
		for (const shim of [globalShim, binShim]) { await mkdir(join(shim, '..'), { recursive: true }); await writeFile(shim, body); }
		const args = ['plain', 'a&b', 'x|y', '100%', '%PATH%', 'caret^', 'quote"in', 'sp ace', '(paren)', '!bang!', '<lt>'];
		for (const shim of [globalShim, binShim]) {
			const output = await new Promise((resolve, reject) => {
				const child = spawnResolved(shim, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
				let out = '';
				child.stdout.on('data', (chunk) => { out += chunk; });
				child.once('error', reject);
				child.once('exit', () => resolve(out));
			});
			assert.deepEqual(JSON.parse(output || 'null'), args, shim);
		}
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test('a Windows Claude npm adapter falls back to the standalone executable after an update moves its own', { skip: process.platform !== 'win32' }, async (t) => {
	const temp = resolve(tmpdir());
	const root = await mkdtemp(join(temp, 'pi-claude-executable-'));
	t.after(async () => {
		assert.equal(dirname(root), temp);
		await rm(root, { recursive: true, force: true });
	});
	const shim = join(root, 'claude-agent-acp.cmd');
	const adapter = join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
	const sdk = join(adapter, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	const nativePackage = '@anthropic-ai/claude-agent-sdk-win32-' + process.arch;
	const bundled = join(adapter, 'node_modules', nativePackage, 'claude.exe');
	const standalone = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
	await mkdir(sdk, { recursive: true });
	await mkdir(dirname(bundled), { recursive: true });
	await mkdir(dirname(standalone), { recursive: true });
	await writeFile(shim, 'node "%~dp0\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*');
	await writeFile(join(adapter, 'package.json'), '{}');
	await writeFile(join(sdk, 'package.json'), JSON.stringify({ main: 'sdk.mjs', optionalDependencies: { [nativePackage]: '0.3.331' } }));
	await writeFile(join(sdk, 'sdk.mjs'), '');
	await writeFile(bundled, '');
	await writeFile(standalone, '');

	const env = { Path: root };
	assert.equal(withClaudeCodeExecutable(shim, env), env);
	await rm(bundled);
	assert.deepEqual(withClaudeCodeExecutable(shim, env), { ...env, CLAUDE_CODE_EXECUTABLE: standalone });
	const explicit = { ...env, claude_code_executable: 'chosen.exe' };
	assert.equal(withClaudeCodeExecutable(shim, explicit), explicit);
	await writeFile(bundled, '');
	assert.equal(withClaudeCodeExecutable(shim, env), env);
});

test('Claude ACP missing executable errors give recovery steps without leaking raw details', () => {
	const missing = new AcpRequestError({ code: -32603, message: 'Internal error', data: { details: 'Claude native binary not found for win32-x64. Private details.' } });
	assert.match(claudeExecutableError(missing)?.message, /安装独立的 Claude Code|重新安装 Claude ACP/);
	assert.doesNotMatch(claudeExecutableError(missing)?.message, /Private details/);
	assert.equal(claudeExecutableError(new AcpRequestError({ code: -32603, message: 'Internal error' })), null);
});

test('config options replace the flat model list: model menu, reasoning effort and other settings', async () => {
	const r = recorder();
	const conversation = new AcpConversation(fakeConfig({ FAKE_ACP_SETTINGS: 'options' }), process.cwd(), null, r.hooks);
	try {
		await conversation.warmup();
		// Grouped model values are flattened; the legacy `models` list is ignored.
		assert.deepEqual(r.state.models, { models: [{ id: 'fake-large', name: 'Fake Large', description: 'Most capable' }, { id: 'fake-small', name: 'Fake Small' }, { id: 'fake-old', name: 'Fake Old' }], current: 'fake-large' });
		assert.deepEqual(r.state.options.map((option) => [option.id, option.category, option.currentValue]), [['effort', 'thought_level', 'medium'], ['mode', 'mode', 'ask']], 'unsupported option types are skipped');
		await conversation.setConfigOption('effort', 'low');
		assert.equal(r.state.options.find((option) => option.id === 'effort').currentValue, 'low');
		// Model changes go through the model option; the agent's echo refreshes the rest.
		await conversation.setModel('fake-small');
		assert.equal(r.state.models.current, 'fake-small');
		await conversation.setModel('fake-large');
		assert.equal(r.state.models.current, 'fake-large');
		assert.equal(r.state.options.find((option) => option.id === 'effort').currentValue, 'high', 'a config_option_update from the agent is applied');
		await assert.rejects(conversation.setConfigOption('nope', 'x'), /Unknown option/);
	} finally {
		await conversation.dispose();
	}
});

test('an agent with only the older modes list gets a mode option backed by session/set_mode', async () => {
	const r = recorder();
	const conversation = new AcpConversation(fakeConfig({ FAKE_ACP_SETTINGS: 'modes' }), process.cwd(), null, r.hooks);
	try {
		await conversation.warmup();
		assert.equal(r.state.models.models.length, 2, 'the plain model list still works');
		assert.deepEqual(r.state.options, [{ id: LEGACY_MODE_OPTION, name: 'Mode', category: 'mode', currentValue: 'ask', values: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto', description: 'No questions' }] }]);
		await conversation.setConfigOption(LEGACY_MODE_OPTION, 'auto');
		assert.equal(r.state.options[0].currentValue, 'auto');
	} finally {
		await conversation.dispose();
	}
});

test('config option parsing is bounded and skips unusable entries', () => {
	assert.equal(parseConfigOption(null), null);
	assert.equal(parseConfigOption({ id: 'x', type: 'boolean', currentValue: true, options: [] }), null);
	assert.equal(parseConfigOption({ id: 'x', type: 'select', currentValue: 'a', options: [] }), null, 'an option without values is dropped');
	const parsed = parseConfigOption({ id: 'x', name: 'X', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'a', name: 'dup' }, { value: '' }, { group: 'g', name: 'G', options: [{ value: 'b' }] }] });
	assert.deepEqual(parsed, { id: 'x', name: 'X', category: null, currentValue: 'a', values: [{ value: 'a', name: 'A' }, { value: 'b', name: 'b' }] });
});

test('tool commands are read whatever the agent calls the field', () => {
	assert.equal(toolCommand({ command: 'npm test' }), 'npm test');
	assert.equal(toolCommand({ command: ['git', 'status'] }), 'git status');
	assert.equal(toolCommand({ CommandLine: 'node --version', WaitMsBeforeAsync: 5000 }), 'node --version', 'Antigravity');
	assert.equal(toolCommand({ command: 3 }), undefined);
	assert.equal(toolCommand(null), undefined);
	const assembler = new AcpTurnAssembler({ cwd: process.cwd(), provider: 'acp:x', model: 'x' });
	const out = assembler.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'node --version', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'node --version' } });
	assert.equal(out.events.find((event) => event.type === 'tool_execution_start').args.command, 'node --version');
});

test('agy is found in its install folder when the PATH predates the install', { skip: process.platform !== 'win32' }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'pi-agy-path-'));
	try {
		await mkdir(join(root, 'agy', 'bin'), { recursive: true });
		await writeFile(join(root, 'agy', 'bin', 'agy.exe'), '');
		const env = { LOCALAPPDATA: root, PATH: join(root, 'empty'), PATHEXT: '.EXE;.CMD' };
		assert.equal(resolveCommand('agy', env), null, 'not on the PATH this process started with');
		// Folders from the machine's stored PATH may come first (another real agy), so check the folder is searched.
		const searched = withAgentSearchPath(env).PATH.split(';');
		assert.ok(searched.includes(join(root, 'agy', 'bin')));
		assert.match(resolveCommand('agy', withAgentSearchPath(env)) ?? '', /[\\/]agy[\\/]bin[\\/]agy\.exe$/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('saved agent settings: the latest record wins and its content is bounded', () => {
	const entry = (data) => ({ type: 'custom', customType: AGENT_SETTINGS_CUSTOM_TYPE, data });
	assert.equal(readAgentSettings([]), null);
	assert.deepEqual(readAgentSettings([entry({ model: 'a', options: { effort: 'low' } }), entry({ model: 'b', options: { effort: 'high', mode: 'auto' } })]), { model: 'b', options: { effort: 'high', mode: 'auto' } });
	assert.deepEqual(readAgentSettings([entry({ model: 7, options: { ok: 'x', bad: 3, ['k'.repeat(600)]: 'y' } })]), { options: { ok: 'x' } });
	assert.deepEqual(readAgentSettings([entry({ options: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`o${index}`, 'v'])) })]).options.o19, 'v');
	assert.equal(Object.keys(readAgentSettings([entry({ options: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`o${index}`, 'v'])) })]).options).length, 20);
});

test('steering: input sent mid-turn splits the transcript and the newer turn reports the outcome', async () => {
	const r = recorder();
	const conversation = new AcpConversation({ ...fakeConfig({ FAKE_ACP_STEER: '1' }), steer: true }, process.cwd(), null, r.hooks);
	const text = (message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? part.thinking ?? '').join('');
	try {
		assert.equal(conversation.canSteer, false, 'nothing is running yet');
		const first = conversation.prompt({ text: 'slow please' });
		await until(() => conversation.canSteer, 'the first prompt is running');
		const started = [];
		const second = conversation.steer({ text: 'go instead', onStarted: () => started.push('go') });
		assert.deepEqual(started, ['go'], 'the steered message is in the transcript at once');
		assert.deepEqual(await first, { stopReason: 'end_turn', superseded: true });
		assert.equal((await second).stopReason, 'end_turn');
		assert.equal(conversation.busy, false);
		assert.deepEqual(r.persisted.filter((message) => message.role !== 'toolResult').map((message) => [message.role, text(message), message.stopReason ?? null]), [
			['user', 'slow please', null],
			['assistant', 'working', 'stop'],
			['user', 'go instead', null],
			['assistant', 'Considering the requestblocks=1 Hello', 'toolUse'],
			['assistant', 'Done.', 'stop'],
		]);

		// Cancelling a steered turn ends it like any other.
		const slow = conversation.prompt({ text: 'slow please' });
		await until(() => conversation.canSteer, 'slow turn running');
		const slowAgain = conversation.steer({ text: 'slow again' });
		await until(() => conversation.canSteer && r.persisted.at(-1)?.role === 'user', 'steered slow turn running');
		conversation.cancel();
		assert.equal((await slow).superseded, true);
		assert.equal((await slowAgain).stopReason, 'cancelled');
		assert.equal(r.persisted.at(-1).stopReason, 'aborted');
		assert.equal((await conversation.prompt({ text: 'go' })).stopReason, 'end_turn', 'the next turn runs normally');
	} finally {
		await conversation.dispose();
	}
});

test('agents without steer support never steer: input queues behind the running turn', async () => {
	const r = recorder();
	const conversation = new AcpConversation(fakeConfig(), process.cwd(), null, r.hooks);
	try {
		const slow = conversation.prompt({ text: 'slow please' });
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(conversation.canSteer, false);
		const queued = conversation.steer({ text: 'go' });
		conversation.cancel();
		assert.equal((await slow).stopReason, 'cancelled');
		assert.equal((await queued).stopReason, 'cancelled');
	} finally {
		await conversation.dispose();
	}
});

test('new sessions keep the agent\'s own default mode, even when it offers "accept edits"; a saved choice wins', async () => {
	for (const settings of ['options', 'modes']) {
		const modeOf = (r) => r.state.options.find((option) => option.category === 'mode')?.currentValue;
		for (const start of ['ask', 'auto']) {
			const fresh = recorder();
			const conversation = new AcpConversation(fakeConfig({ FAKE_ACP_SETTINGS: settings, FAKE_ACP_ACCEPT_EDITS: '1', FAKE_ACP_START_MODE: start }), process.cwd(), null, fresh.hooks);
			try {
				await conversation.warmup();
				assert.equal(modeOf(fresh), start, `${settings}: the agent's default ${start} is kept`);
			} finally {
				await conversation.dispose();
			}
		}
		const chosen = recorder({ savedSettings: () => ({ options: { [settings === 'options' ? 'mode' : LEGACY_MODE_OPTION]: 'acceptEdits' } }) });
		const again = new AcpConversation(fakeConfig({ FAKE_ACP_SETTINGS: settings, FAKE_ACP_ACCEPT_EDITS: '1' }), process.cwd(), null, chosen.hooks);
		try {
			await again.warmup();
			assert.equal(modeOf(chosen), 'acceptEdits', `${settings}: the user's choice is kept`);
		} finally {
			await again.dispose();
		}
	}
});
