import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp/fake-agent.mjs', import.meta.url));

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
		const approve = async (request) => { dialogs.push(request); return request.approval ? { approved: true, scope: 'session' } : true; };
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
		let snapshot = service.getSnapshot();
		assert.equal(snapshot.agent.kind, 'acp');
		assert.equal(snapshot.agent.capabilities.thinkingLevels, false);
		await until(() => service.getSnapshot().agent.models?.length === 2, 'warmup reports the agent models');
		assert.equal(service.getSnapshot().model, 'fake-large');
		assert.equal(service.getSnapshot().modelProvider, 'acp:fake-agent');
		assert.ok(service.listSlashCommands().some((command) => command.name === 'review' && command.source === 'agent'));

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
		// A first prompt that fails at the agent keeps the context pending for the retry.
		await service.prompt('auth');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().runs.at(-1)?.status === 'failed', 'failed first prompt settles');
		// The agent offers only a permanent grant: the card offers no "once" for it.
		const before = dialogs.length;
		await service.prompt('please run always-only');
		await until(() => service.getSnapshot().status === 'idle' && service.getSnapshot().messages.some((message) => message.text === 'Done.'), 'continuation turn settles');
		assert.ok(service.getSnapshot().messages.some((message) => message.text === 'blocks=2 Hello'), 'the handoff context travels with the first prompt the agent accepts');
		assert.equal(dialogs.length, before + 1);
		assert.deepEqual(dialogs.at(-1).approval.scopes, ['session']);
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
		await reopened.init({ cwd: workspace, sessionPath: path });
		assert.equal(reopened.getSnapshot().agent.id, 'fake-agent');
		assert.ok(reopened.getSnapshot().messages.some((message) => message.text === 'Done.'));
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
		service = new AgentService(undefined, async () => true);
		await service.saveAgent({ displayName: 'Option Agent', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_SETTINGS: 'options', FAKE_ACP_LOAD: '1' }, enabled: true });
		await service.init({ cwd: workspace, fresh: true });
		await service.setSessionAgent('option-agent');
		await until(() => service.getSnapshot().agent.options?.length === 2, 'options reach the descriptor');
		const agent = service.getSnapshot().agent;
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
		const path = service.getSnapshot().sessionPath;

		// The agent loads its session with default settings; the user's choices come back.
		await service.dispose();
		reopened = new AgentService(undefined, async () => true);
		await reopened.init({ cwd: workspace, sessionPath: path });
		await reopened.prompt('continue');
		await until(() => reopened.getSnapshot().status === 'idle' && reopened.getSnapshot().messages.filter((message) => message.text === 'Done.').length === 2, 'resumed turn settles');
		const resumed = reopened.getSnapshot();
		assert.equal(resumed.model, 'fake-small');
		assert.deepEqual(resumed.agent.options.map((option) => [option.id, option.currentValue]), [['effort', 'low'], ['mode', 'auto']]);
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
		await service.saveAgent({ id: 'antigravity', displayName: builtin.displayName, command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_STEER: '1' }, enabled: true, accentColor: builtin.accentColor });
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
