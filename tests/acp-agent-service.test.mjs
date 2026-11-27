import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp/fake-agent.mjs', import.meta.url));
const { AGENT_APPROVAL_OPTION } = await import('../packages/shared/src/agentRuntimes.ts');

async function until(check, message, timeout = 15000) {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeout) throw new Error(`timed out: ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function entriesOf(path) {
	return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('Antigravity command approvals survive restart and stay scoped to the exact command and workspace', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-command-approval-'));
	const workspace = join(root, 'workspace');
	const otherWorkspace = join(root, 'other');
	mkdirSync(join(workspace, 'subdirectory'), { recursive: true });
	mkdirSync(otherWorkspace);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	let service;
	t.after(async () => {
		await service?.dispose();
		for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		// Windows releases a killed process's working directory slightly after exit.
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
	});
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const cards = [];
	let decision = { approved: true, scope: 'workspace' };
	const respond = async (card) => { cards.push(card); return decision; };
	service = new AgentService(undefined, respond);
	await service.saveAgent({ id: 'antigravity', displayName: 'Antigravity', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_AGY_COMMANDS: '1' }, enabled: true });
	async function open(cwd) {
		await service.init({ cwd, fresh: true });
		await service.setSessionAgent('antigravity');
		// Approval cards only appear in the agent's own mode; conversations start in bypass.
		await service.setAgentOption(AGENT_APPROVAL_OPTION, 'agent');
	}
	async function run(prompt, selected) {
		const count = service.getSnapshot().messages.filter((message) => message.text === `Selected: ${selected}`).length;
		await service.prompt(prompt);
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.filter((message) => message.text === `Selected: ${selected}`).length === count + 1, `permission ${selected} for ${prompt}`);
	}
	await open(workspace);
	await run('run', 'yes');
	assert.equal(cards[0].approval.command, 'npm test');
	assert.ok(cards[0].approval.scopes.includes('workspace'));
	assert.deepEqual(cards[0].approval.agentOptions.map(({ id, label }) => [id, label]), [['yes', 'Allow'], ['always', 'Always allow'], ['persist', 'Persist to settings'], ['no', 'Reject']]);
	// The card preselects allow once and declines with the reject option, so it needs the kinds.
	assert.deepEqual(cards[0].approval.agentOptions.map(({ kind }) => kind), ['allow_once', 'allow_always', 'allow_always', 'reject_once']);

	await service.dispose();
	service = new AgentService(undefined, respond);
	await open(workspace);
	await run('run again', 'yes');
	assert.equal(cards.length, 1, 'new desktop process loads the exact grant');
	decision = { optionId: 'yes' };
	await run('different-command', 'yes');
	await run('different-directory', 'yes');
	await run('outside-directory', 'yes');
	assert.equal(cards.length, 4);
	assert.ok(!cards.at(-1).approval.scopes.includes('workspace'));
	decision = { optionId: 'persist' };
	await run('always-only', 'persist');
	assert.ok(!cards.at(-1).approval.scopes.includes('workspace'), 'a native durable grant cannot substitute for allow once');

	await open(otherWorkspace);
	decision = { optionId: 'yes' };
	await run('run there', 'yes');
	assert.equal(cards.length, 6);
	await open(workspace);
	service.clearAntigravityCommandApprovals();
	await run('run after clearing', 'yes');
	assert.equal(cards.length, 7, 'revocation takes effect without an agent restart');
});

test('an external agent question uses the scoped desktop dialog and receives the structured reply', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-elicitation-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	let service;
	t.after(async () => {
		await service?.dispose();
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDir;
		rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
	});
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const answer = { action: 'accept', content: { target: 'stage', checks: ['unit', 'build'], note: 'Smoke test first' } };
	const requests = [];
	service = new AgentService(undefined, async (request) => { requests.push(request); return answer; });
	await service.saveAgent({ displayName: 'Question Agent', command: process.execPath, args: [FAKE_AGENT], enabled: true });
	await service.init({ cwd: workspace, fresh: true });
	await service.setSessionAgent('question-agent');
	await service.prompt('question');
	await until(() => service.getSnapshot().status === 'idle', 'question and answer round trip');
	const snapshot = service.getSnapshot();
	const [request] = requests;
	assert.equal(request.kind, 'form');
	assert.equal(request.title, 'Question Agent · Release options');
	assert.equal(request.scope.sessionPath, snapshot.sessionPath);
	assert.deepEqual(request.form.fields.map((field) => field.kind), ['select', 'multi-select', 'text']);
	assert.deepEqual(JSON.parse(snapshot.messages.filter((message) => message.role === 'assistant').at(-1).text), answer);
});

test('an ACP conversation runs through AgentService: binding, transcript, lock, approval, handoff and resume', async () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-service-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	const dialogs = [];
	const services = [];
	try {
		const { AgentService } = await import('../packages/agent/src/index.ts');
		const approve = async (request) => {
			dialogs.push(request);
			if (request.approval?.agentOptions?.some((option) => option.id === 'persist')) return { optionId: 'persist' };
			return request.approval ? { approved: true, scope: 'session' } : true;
		};
		const service = new AgentService(undefined, approve);
		services.push(service);
		const events = [];
		service.onEvent((envelope) => events.push(envelope.event));

		const agents = await service.saveAgent({ displayName: 'Fake Agent', command: process.execPath, args: [FAKE_AGENT], enabled: true, accentColor: '#112233' });
		assert.equal(agents.find((agent) => agent.id === 'fake-agent').readiness, 'ready');

		await service.init({ cwd: workspace, fresh: true });
		assert.equal(service.getSnapshot().agent.kind, 'pi');
		// A first input whose agent choice cannot be applied is not sent to Pi instead.
		await assert.rejects(service.submitInput({ id: 'first-input', sessionId: service.getSnapshot().sessionId, text: 'hello', agentId: 'missing-agent' }), /未能切换到所选 Agent/);
		assert.equal(service.getSnapshot().messages.filter((message) => message.role === 'user').length, 0);
		assert.equal(service.getSnapshot().agent.kind, 'pi');
		await service.setSessionAgent('fake-agent');
		await service.setAgentOption(AGENT_APPROVAL_OPTION, 'agent');
		let snapshot = service.getSnapshot();
		assert.equal(snapshot.agent.kind, 'acp');
		assert.equal(snapshot.agent.capabilities.thinkingLevels, false);
		await until(() => service.getSnapshot().agent.models?.length === 2, 'warmup reports the agent models');
		assert.equal(service.getSnapshot().model, 'fake-large');
		assert.equal(service.getSnapshot().modelProvider, 'acp:fake-agent');
		// The command list is a notification that follows the session reply, so it may land a moment later.
		await until(() => service.listSlashCommands().some((command) => command.name === 'review' && command.source === 'agent'), 'agent commands arrive');

		await service.prompt('please run');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'turn settles');
		snapshot = service.getSnapshot();
		const path = snapshot.sessionPath;
		assert.ok(path && existsSync(path), 'the conversation is a regular session file');
		assert.deepEqual(snapshot.messages.filter((message) => message.role === 'user').map((message) => message.text), ['please run']);
		assert.ok(snapshot.messages.some((message) => message.role === 'assistant' && message.text === 'blocks=1 Hello' && message.thinking === 'Considering the request'));
		const tool = snapshot.activities.find((activity) => activity.id === 'call-1');
		assert.equal(tool.tool, 'bash');
		assert.equal(tool.command, 'npm test');
		assert.equal(tool.status, 'done');
		assert.ok(snapshot.messages.some((message) => message.systemKind === 'extension-notice' && /Run tests/.test(message.text)), 'the plan is kept as a notice');
		assert.equal(snapshot.runs.at(-1).status, 'completed');
		assert.equal(dialogs.length, 1);
		assert.equal(dialogs[0].approval.command, 'npm test');
		assert.deepEqual(dialogs[0].approval.scopes, ['once', 'session']);
		assert.deepEqual(dialogs[0].scope?.sessionPath, path, 'approval cards are scoped to their conversation');
		const binding = entriesOf(path).filter((entry) => entry.type === 'custom' && entry.customType === 'pi-desktop-agent').at(-1);
		assert.deepEqual(binding.data, { agentId: 'fake-agent', nativeSessionId: 'fake-session' });

		await assert.rejects(service.setSessionAgent('pi'), /已锁定/);
		await assert.rejects(service.setThinkingLevel('high'), /不支持/);
		await assert.rejects(service.setModel('openai', 'gpt'), /已锁定/);
		await service.setModel('acp:fake-agent', 'fake-small');
		assert.equal(service.getSnapshot().model, 'fake-small');

		await service.prompt('slow');
		await until(() => service.getSnapshot().messages.some((message) => message.text === 'working'), 'slow turn streams');
		// No mid-turn input: a second message is refused at once instead of waiting for the reply.
		await assert.rejects(service.prompt('please run'), /不支持运行中追加消息/);
		await service.abort();
		await until(() => service.getSnapshot().status === 'idle', 'cancelled turn settles');
		assert.equal(service.getSnapshot().runs.at(-1).status, 'cancelled');

		// Editing the agent's configuration restarts its process with the new settings.
		const saved = (await service.listAgents()).find((agent) => agent.id === 'fake-agent');
		const config = (enabled) => ({ id: 'fake-agent', displayName: saved.displayName, command: saved.command, args: saved.args, enabled, accentColor: saved.accentColor });
		await service.saveAgent(config(false));
		await assert.rejects(service.prompt('please run'), /已停用/);
		await service.saveAgent(config(true));
		await until(() => service.getSnapshot().model === 'fake-small' && service.getSnapshot().agent.models?.length === 2, 'restarted agent gets the chosen model back');

		// Handoff to Pi: a new conversation carries the context. Until it is written to disk
		// (first message) the source holds no link, so an abandoned handoff leaves nothing dangling.
		const handoffLinks = () => entriesOf(path).filter((entry) => entry.type === 'custom' && entry.customType === 'pi-desktop-handoff');
		await service.handoffToAgent('pi');
		snapshot = service.getSnapshot();
		assert.notEqual(snapshot.sessionPath, path);
		assert.equal(snapshot.agent.kind, 'pi');
		const incoming = snapshot.messages.find((message) => message.systemKind === 'handoff');
		assert.deepEqual(incoming.handoff, { direction: 'from', sessionPath: path, fromAgent: 'Fake Agent', toAgent: 'Pi' });
		assert.equal(handoffLinks().length, 0, 'no link to a conversation that is not on disk yet');
		await assert.rejects(service.handoffToAgent('fake-agent'), /还没有内容/, 'an empty conversation switches agents directly instead');

		// Handoff to another external agent: its first prompt carries the context, and the
		// source gets its link once the continuation exists.
		await service.saveAgent({ displayName: 'Fake Two', command: process.execPath, args: [FAKE_AGENT], enabled: true });
		await service.switchSession(path);
		// The abandoned Pi continuation never got a message: work in the source writes no link to it.
		await service.prompt('please run');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.filter((message) => message.text === 'Done.').length === 2, 'source turn after an abandoned handoff');
		assert.equal(handoffLinks().length, 0, 'an abandoned handoff leaves no link');
		await service.handoffToAgent('fake-two');
		const continuation = service.getSnapshot().sessionPath;
		assert.equal(service.getSnapshot().agent.id, 'fake-two');
		await service.setAgentOption(AGENT_APPROVAL_OPTION, 'agent');
		// A first prompt that fails at the agent keeps the context pending for the retry.
		await service.prompt('auth');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().runs.at(-1)?.status === 'failed', 'failed first prompt settles');
		// Two choices share allow_always, but the selected native option ID must survive.
		const before = dialogs.length;
		await service.prompt('please run always-only');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'continuation turn settles');
		assert.ok(service.getSnapshot().messages.some((message) => message.text === 'blocks=2 Hello'), 'the handoff context travels with the first prompt the agent accepts');
		assert.equal(dialogs.length, before + 1);
		assert.deepEqual(dialogs.at(-1).approval.scopes, ['session']);
		assert.deepEqual(dialogs.at(-1).approval.agentOptions.map(option => option.id), ['always', 'persist', 'no']);
		assert.ok(entriesOf(continuation).some((entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.content.some(part => part.text === 'Selected: persist')));
		assert.ok(entriesOf(continuation).some((entry) => entry.type === 'custom' && entry.customType === 'pi-desktop-handoff-delivered'));
		await service.prompt('please run');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.filter((message) => message.text === 'Done.').length === 2, 'second continuation turn settles');
		assert.equal(service.getSnapshot().messages.filter((message) => message.role === 'assistant' && /^blocks=/.test(message.text)).at(-1).text, 'blocks=1 Hello', 'the context is sent once');
		await until(() => handoffLinks().length === 1, 'source links to the continuation');
		assert.deepEqual(handoffLinks()[0].data, { direction: 'to', sessionPath: continuation, fromAgent: 'Fake Agent', toAgent: 'Fake Two' });

		await service.switchSession(path);
		assert.ok(service.getSnapshot().messages.some((message) => message.systemKind === 'handoff' && message.handoff.direction === 'to'));

		// A fresh desktop process resumes the conversation from its session file.
		await service.dispose();
		const reopened = new AgentService(undefined, approve);
		services.push(reopened);
		await reopened.init({ cwd: workspace, fresh: true });
		await reopened.switchSession(path);
		assert.equal(reopened.getSnapshot().agent.id, 'fake-agent');
		assert.ok(reopened.getSnapshot().messages.some((message) => message.text === 'Done.'));
		await until(() => reopened.getSnapshot().agent.models?.length === 2 && reopened.getSnapshot().model === 'fake-small', 'cold switch restores models before another prompt');
		await reopened.prompt('continue');
		await until(() => reopened.getSnapshot().status === 'idle' && reopened.getSnapshot().messages.filter((message) => message.role === 'user').length === 4, 'resumed turn settles');
		const last = reopened.getSnapshot().messages.filter((message) => message.role === 'assistant').at(-1);
		assert.match(last.text, /^Done\.$/);
		const reply = reopened.getSnapshot().messages.filter((message) => message.role === 'assistant' && /^blocks=/.test(message.text)).at(-1);
		assert.equal(reply.text, 'blocks=2 Hello', 'without session/load support the transcript travels ahead of the prompt');
	} finally {
		for (const service of services) await service.dispose().catch(() => {});
		// Windows releases a killed process's working directory slightly after exit.
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
		for (const [name, value] of environment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test('agent session settings reach the renderer descriptor and change through AgentService', async () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-options-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	let service;
	let reopened;
	try {
		const { AgentService } = await import('../packages/agent/src/index.ts');
		const asked = [];
		service = new AgentService(undefined, async (request) => { asked.push(request); return true; });
		await service.saveAgent({ displayName: 'Option Agent', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_SETTINGS: 'options', FAKE_ACP_LOAD: '1' }, enabled: true });
		await service.init({ cwd: workspace, fresh: true });
		await service.setSessionAgent('option-agent');
		// The desktop's approval setting is listed (in bypass) before the agent reports its own options.
		const approvalOf = (snapshot) => snapshot.agent.options?.find((option) => option.id === AGENT_APPROVAL_OPTION)?.currentValue;
		assert.equal(approvalOf(service.getSnapshot()), 'bypass');
		await until(() => service.getSnapshot().agent.options?.length === 3, 'options reach the descriptor');
		const agent = service.getSnapshot().agent;
		assert.equal(agent.options[0].id, AGENT_APPROVAL_OPTION, 'the approval setting leads the menu');
		assert.deepEqual(agent.options[0].values.map((item) => item.value), ['bypass', 'agent']);
		assert.deepEqual(agent.models.map((model) => model.id), ['fake-large', 'fake-small', 'fake-old'], 'one entry per model, not per model and effort');
		assert.equal(service.getSnapshot().model, 'fake-large');
		await service.setAgentOption('effort', 'low');
		assert.equal(service.getSnapshot().agent.options.find((option) => option.id === 'effort').currentValue, 'low');
		await assert.rejects(service.setAgentOption('effort', 'extreme'), /选项值不可用/);
		await assert.rejects(service.setAgentOption('missing', 'x'), /选项不存在/);
		await service.setModel('acp:option-agent', 'fake-small');
		assert.equal(service.getSnapshot().model, 'fake-small');
		await service.setAgentOption('mode', 'auto');
		await service.prompt('please run');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'turn settles');
		assert.equal(asked.length, 0, 'bypass approves the tool without a card');
		await assert.rejects(service.setAgentOption(AGENT_APPROVAL_OPTION, 'always'), /选项值不可用/);
		await service.setAgentOption(AGENT_APPROVAL_OPTION, 'agent');
		assert.equal(approvalOf(service.getSnapshot()), 'agent');
		await service.prompt('please run');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.filter((message) => message.text === 'Done.').length === 2, 'second turn settles');
		assert.equal(asked.length, 1, 'the agent\'s own mode shows the approval card');
		const path = service.getSnapshot().sessionPath;

		// The agent loads its session with default settings; the user's choices come back.
		await service.dispose();
		reopened = new AgentService(undefined, async () => true);
		const events = [];
		reopened.onEvent(({ event }) => events.push(event));
		await reopened.init({ cwd: workspace, sessionPath: path });
		assert.equal(events.find((event) => event.type === 'ready' && event.sessionPath === path).model, 'fake-small', 'saved model is available on the first ready event');
		await until(() => {
			const snapshot = reopened.getSnapshot();
			return snapshot.model === 'fake-small' && snapshot.agent.models?.length === 3
				&& snapshot.agent.options?.some((option) => option.id === 'mode' && option.currentValue === 'auto');
		}, 'model catalog and saved settings are restored without a prompt');
		const resumed = reopened.getSnapshot();
		assert.equal(resumed.modelName, 'Fake Small');
		assert.deepEqual(resumed.agent.options.map((option) => [option.id, option.currentValue]), [[AGENT_APPROVAL_OPTION, 'agent'], ['effort', 'low'], ['mode', 'auto']]);
		assert.deepEqual(resumed.messages.filter((message) => message.role === 'user').map((message) => message.text), ['please run', 'please run']);

		// A new conversation with the same agent starts from the model and effort chosen last
		// time, but never inherits a permission mode from another conversation.
		const remembered = JSON.parse(readFileSync(join(root, 'agent', 'desktop-agent-preferences.json'), 'utf8'));
		assert.deepEqual(remembered.agents['option-agent'], { model: 'fake-small', options: { effort: 'low' } });
		await reopened.init({ cwd: workspace, fresh: true });
		await reopened.setSessionAgent('option-agent');
		const fresh = reopened.getSnapshot().sessionPath;
		assert.notEqual(fresh, path);
		assert.equal(reopened.getSnapshot().model, 'fake-small', 'the remembered model shows before the agent has started');
		await until(() => {
			const snapshot = reopened.getSnapshot();
			return snapshot.model === 'fake-small' && snapshot.agent.options?.some((option) => option.id === 'effort' && option.currentValue === 'low');
		}, 'a new conversation starts with the agent\'s last model and effort');
		assert.notEqual(reopened.getSnapshot().agent.options.find((option) => option.id === 'mode').currentValue, 'auto');
		assert.equal(approvalOf(reopened.getSnapshot()), 'bypass', 'a new conversation starts in bypass again');
	} finally {
		await service?.dispose().catch(() => {});
		await reopened?.dispose().catch(() => {});
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
		for (const [name, value] of environment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test('steering through AgentService: Antigravity takes a message while it replies, in the same run', async () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-steer-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	let service;
	try {
		const { AgentService } = await import('../packages/agent/src/index.ts');
		service = new AgentService(undefined, async () => true);
		// The built-in entry (marked steer) pointed at the fake agent.
		const builtin = (await service.listAgents()).find((agent) => agent.id === 'antigravity');
		await service.saveAgent({ id: 'antigravity', displayName: builtin.displayName, command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_STEER: '1', FAKE_ACP_LOAD: '1', FAKE_ACP_SETTINGS: 'modes' }, enabled: true, accentColor: builtin.accentColor });
		await service.init({ cwd: workspace, fresh: true });
		await service.setSessionAgent('antigravity');
		assert.equal(service.getSnapshot().agent.capabilities.steer, true);
		await service.prompt('slow please');
		await until(() => service.getSnapshot().messages.some((message) => message.text === 'working'), 'first reply streams');
		await service.prompt('please run');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'steered turn settles');
		const snapshot = service.getSnapshot();
		assert.deepEqual(snapshot.messages.filter((message) => message.role === 'user').map((message) => message.text), ['slow please', 'please run']);
		const order = snapshot.messages.filter((message) => message.role !== 'system').map((message) => message.text);
		assert.ok(order.indexOf('working') < order.indexOf('please run') && order.indexOf('please run') < order.indexOf('Done.'), 'the reply so far comes before the steered message');
		assert.equal(snapshot.runs.length, 1, 'the steered message joins the running run');
		assert.equal(snapshot.runs[0].status, 'completed');

		await service.dispose();
		service = new AgentService();
		await service.init({ cwd: workspace, fresh: true });
		await service.loadSession(workspace, snapshot.sessionPath);
		const preloaded = service.getResidentSessionSnapshot({ cwd: workspace, sessionId: snapshot.sessionId, sessionPath: snapshot.sessionPath });
		assert.equal(preloaded.model, 'fake-large', 'legacy sessions recover the last ACP reply model');
		assert.equal(preloaded.agent.models, undefined, 'background preload does not start Antigravity');
		await service.switchSession(snapshot.sessionPath);
		await until(() => service.getSnapshot().agent.models?.length === 2, 'activating the old Antigravity session loads its models');
		assert.equal(service.getSnapshot().modelName, 'Fake Large');
		assert.deepEqual(service.getSnapshot().messages.filter((message) => message.role === 'user').map((message) => message.text), ['slow please', 'please run']);
	} finally {
		await service?.dispose().catch(() => {});
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
		for (const [name, value] of environment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test('Codex takes an additional message during its turn and waits for the original prompt when blocked', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-codex-steer-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	let service, answerForm;
	t.after(async () => {
		await service?.dispose();
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDir;
		// Windows releases a killed process's working directory slightly after exit.
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
	});
	const { AgentService } = await import('../packages/agent/src/index.ts');
	service = new AgentService(undefined, async (request, signal) => {
		if (request.kind !== 'form') return true;
		return new Promise((resolve) => {
			answerForm = resolve;
			signal.addEventListener('abort', () => resolve(null), { once: true });
		});
	});
	await service.saveAgent({ id: 'codex', displayName: 'Codex', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_CODEX_VERSION: '2.11.0' }, enabled: true });
	await service.init({ cwd: workspace, fresh: true });
	await service.setSessionAgent('codex');
	await until(() => service.getSnapshot().agent.capabilities.steer, 'the runtime advertises steering to the composer');
	const submit = (id, text) => service.submitInput({ id: `codex-input-${id}`, text, behavior: 'steer', sessionId: service.getSnapshot().sessionId });
	const transcript = () => service.getSnapshot().messages.filter((message) => message.role !== 'system');

	await service.prompt('slow please');
	await until(() => transcript().some((message) => message.text === 'working'), 'original Codex prompt is running');
	await assert.rejects(submit('reject', 'reject steer'), /未能追加消息/);
	assert.equal(service.getSnapshot().status, 'busy');
	assert.ok(!transcript().some((message) => message.text === 'reject steer'));
	assert.equal((await submit('inject', 'one more question')).state, 'consumed');
	await until(() => service.getSnapshot().status === 'idle', 'original prompt finishes');
	assert.deepEqual(transcript().map((message) => message.text), ['slow please', 'working', 'one more question', 'Steered: one more question']);
	assert.deepEqual(service.getSnapshot().runs.map((run) => run.status), ['completed']);

	await service.prompt('question');
	await until(() => answerForm, 'the agent waits for a form reply');
	const fallback = submit('fallback', 'normal follow-up');
	await until(() => service.listSlashCommands().some((item) => item.name === 'steer-waiting'), 'the adapter declined to inject into the blocked prompt');
	assert.equal(service.getSnapshot().status, 'busy');
	assert.ok(!transcript().some((message) => message.text === 'normal follow-up'));
	answerForm({ action: 'accept', content: { target: 'stage' } });
	await fallback;
	await until(() => service.getSnapshot().status === 'idle', 'the follow-up completes in a normal prompt');
	assert.deepEqual(transcript().filter((message) => message.role === 'user').map((message) => message.text), ['slow please', 'one more question', 'question', 'normal follow-up']);
	assert.deepEqual(service.getSnapshot().runs.map((run) => run.status), ['completed', 'completed', 'completed']);
});

test('stopIdleAgents stops idle external ACP processes without disrupting busy turns or waiting dialogs, and resumes on demand', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-stop-idle-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	let service, answerForm;
	t.after(async () => {
		await service?.dispose();
		for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
	});
	const { AgentService } = await import('../packages/agent/src/index.ts');
	service = new AgentService(undefined, async (request, signal) => {
		if (request.kind === 'form') {
			return new Promise((resolve) => {
				answerForm = resolve;
				signal.addEventListener('abort', () => resolve(null), { once: true });
			});
		}
		return { optionId: 'yes' };
	});
	await service.saveAgent({ displayName: 'Idle Agent', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_LOAD: '1' }, enabled: true });

	// Session 1: warmed up and idle after a turn.
	await service.init({ cwd: workspace, fresh: true });
	await service.setSessionAgent('idle-agent');
	await until(() => service.getSnapshot().agent.models?.length === 2, 'first session warms up');
	await service.prompt('hello');
	await until(() => service.getSnapshot().status === 'idle', 'first turn finishes');
	const firstPath = service.getSnapshot().sessionPath;

	// Session 2: running a slow turn in the background.
	await service.newSession();
	await service.setSessionAgent('idle-agent');
	await until(() => service.getSnapshot().agent.models?.length === 2, 'second session warms up');
	await service.prompt('slow please');
	await until(() => service.getSnapshot().messages.some((message) => message.text === 'working'), 'second session is busy');
	const busyPath = service.getSnapshot().sessionPath;

	// Switch back to idle Session 1; stopping idle agents should stop Session 1 only, leaving Session 2 running.
	await service.switchSession(firstPath);
	const stopped = await service.stopIdleAgents();
	assert.equal(stopped, 1, 'only the idle ACP process is stopped');
	assert.equal(await service.stopIdleAgents(), 0, 'calling again while still stopped is a no-op');
	assert.equal(service.getSnapshot().agent.id, 'idle-agent', 'agent binding remains intact');
	assert.equal(service.getSnapshot().agent.models?.length, 2, 'cached model list stays intact');

	// Verify Session 2 kept running undisturbed, then abort it and verify it can now be stopped.
	await service.switchSession(busyPath);
	assert.equal(service.getSnapshot().status, 'busy', 'busy background ACP session kept running');
	await service.abort();
	await until(() => service.getSnapshot().status === 'idle', 'busy session aborts to idle');
	assert.equal(await service.stopIdleAgents(), 1, 'aborted session is now idle and stopped');

	// Verify Session 1 transparently restarts and resumes via session/load on the next prompt.
	await service.switchSession(firstPath);
	const assistantBeforeResume = service.getSnapshot().messages.filter((message) => message.role === 'assistant').length;
	await service.prompt('follow up');
	await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.filter((message) => message.role === 'user').length === 2, 'resumed session completes turn');
	const resumedAssistantText = service.getSnapshot().messages.filter((message) => message.role === 'assistant').slice(assistantBeforeResume).map((message) => message.text).join('\n');
	assert.match(resumedAssistantText, /blocks=1/, 'native session resumed via session/load');

	// Verify a session with an async elicitation form waiting after prompt end is NOT killed.
	answerForm = null;
	await service.prompt('async question');
	await until(() => answerForm && service.getSnapshot().status === 'idle', 'async question is waiting while prompt is idle');
	assert.equal(await service.stopIdleAgents(), 0, 'waiting dialog protects its ACP process');
	answerForm({ action: 'accept', content: { target: 'prod' } });
	await until(() => service.listSlashCommands().some((command) => command.name === 'prod'), 'async answer delivered');
	assert.equal(await service.stopIdleAgents(), 1, 'once answered, idle ACP process stops');
});

test('new conversations start with the last used agent and fall back to Pi when unavailable', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-acp-last-agent-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	const services = [];
	t.after(async () => {
		for (const item of services) await item.dispose().catch(() => {});
		for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		try { rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
		catch (error) { console.warn('temp cleanup skipped:', error.message); }
	});
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const service = new AgentService(undefined, async () => true);
	services.push(service);
	await service.saveAgent({ displayName: 'Fake One', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_LOAD: '1' }, enabled: true });
	await service.saveAgent({ displayName: 'Fake Two', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_LOAD: '1' }, enabled: true });

	// Brand-new profile starts on Pi.
	await service.init({ cwd: workspace, fresh: true });
	assert.equal(service.getSnapshot().agent.id, 'pi');
	assert.equal(service.getSnapshot().defaultAgentId, 'pi');

	// Picking Fake One remembers it (along with its chosen model) for subsequent new conversations.
	await service.setSessionAgent('fake-one');
	await until(() => service.getSnapshot().agent.models?.length === 2, 'fake-one models load');
	await service.setModel('acp:fake-one', 'fake-small');
	await service.prompt('hello one');
	await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'fake-one turn settles');
	const onePath = service.getSnapshot().sessionPath;
	assert.equal(service.getSnapshot().defaultAgentId, 'fake-one');

	await service.newSession();
	assert.equal(service.getSnapshot().agent.id, 'fake-one', 'newSession inherits the last used agent');
	assert.equal(service.getSnapshot().model, 'fake-small', 'remembered model still applies immediately');

	// /new slash command inherits the last used agent too.
	await service.executeSlashCommand({ cwd: workspace, sessionId: service.getSnapshot().sessionId, name: 'new' });
	assert.equal(service.getSnapshot().agent.id, 'fake-one', '/new inherits the last used agent');

	// Switching to Fake Two and chatting updates the remembered agent.
	await service.setSessionAgent('fake-two');
	await service.prompt('hello two');
	await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'fake-two turn settles');
	await service.init({ cwd: workspace, fresh: true });
	assert.equal(service.getSnapshot().agent.id, 'fake-two', 'init({ fresh: true }) inherits the last used agent');

	// Merely viewing an older Fake One conversation without sending keeps Fake Two as default.
	await service.switchSession(onePath);
	assert.equal(service.getSnapshot().agent.id, 'fake-one');
	assert.equal(service.getSnapshot().defaultAgentId, 'fake-two');
	await service.newSession();
	assert.equal(service.getSnapshot().agent.id, 'fake-two', 'reading an older conversation does not change the default agent');

	// Sending a prompt in the older Fake One conversation makes Fake One the last used agent again.
	await service.switchSession(onePath);
	await service.prompt('follow up one');
	await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.filter((message) => message.role === 'user').length === 2, 'follow-up on fake-one settles');
	await service.newSession();
	assert.equal(service.getSnapshot().agent.id, 'fake-one', 'sending in an existing conversation updates the last used agent');

	// Survives restart across a fresh AgentService instance.
	await service.dispose();
	const reopened = new AgentService(undefined, async () => true);
	services.push(reopened);
	await reopened.init({ cwd: workspace, fresh: true });
	assert.equal(reopened.getSnapshot().agent.id, 'fake-one', 'remembered agent survives restart');
	assert.equal(reopened.getSnapshot().defaultAgentId, 'fake-one');

	// An unattended Pi run (automation) never inherits Fake One and never overwrites it.
	await reopened.init({ cwd: workspace, fresh: true, agentId: 'pi', persistAgentPreference: false });
	assert.equal(reopened.getSnapshot().agent.id, 'pi');
	assert.equal(reopened.getSnapshot().defaultAgentId, 'fake-one');
	await reopened.newSession();
	assert.equal(reopened.getSnapshot().agent.id, 'fake-one');

	// Disabling or removing the remembered agent gracefully falls back to Pi instead of failing.
	const fakeOne = (await reopened.listAgents()).find((agent) => agent.id === 'fake-one');
	await reopened.saveAgent({ id: 'fake-one', displayName: fakeOne.displayName, command: fakeOne.command, args: fakeOne.args, env: fakeOne.env, enabled: false });
	await reopened.newSession();
	assert.equal(reopened.getSnapshot().agent.id, 'pi', 'disabled remembered agent falls back to Pi');
	assert.equal(reopened.getSnapshot().defaultAgentId, 'pi');

	// Handoff to an enabled agent makes it the remembered agent, and switching back to Pi restores Pi.
	await reopened.switchSession(onePath);
	await reopened.handoffToAgent('fake-two');
	assert.equal(reopened.getSnapshot().agent.id, 'fake-two');
	assert.equal(reopened.getSnapshot().defaultAgentId, 'fake-two');
	await reopened.newSession();
	assert.equal(reopened.getSnapshot().agent.id, 'fake-two', 'handoff target becomes the last used agent');
	await reopened.setSessionAgent('pi');
	await reopened.newSession();
	assert.equal(reopened.getSnapshot().agent.id, 'pi', 'switching back to Pi makes Pi the last used agent');
});
