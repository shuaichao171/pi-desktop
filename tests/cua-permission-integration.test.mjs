// Real SDK/desktop confirmation pipeline with an offline loopback model.
// The only CUA primitive called is cua_wait; no screenshot or input is performed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { seedTestModel, TEST_MODEL_ID, TEST_MODEL_PROVIDER } from './helpers/testModel.mjs';
import { CUA_PERMISSION_TITLE } from '../packages/agent/src/cua/permissions.ts';

test('real model CUA calls wait for conversation consent and reuse it after reopening', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'pi-cua-confirm-'));
	const workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
	const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map(key => [key, process.env[key]]));
	const requests = [], modelRequests = [];
	let service, reply;
	const waitFor = async predicate => {
		const deadline = Date.now() + 8000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`CUA integration timed out: ${JSON.stringify({ requests: modelRequests.length, status: service.getSnapshot().status, error: service.getSnapshot().error })}`);
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};
	const promptAndSettle = async text => {
		const before = modelRequests.length;
		await service.prompt(text);
		await waitFor(() => modelRequests.length > before && service.getSnapshot().status === 'idle');
		assert.equal(service.getSnapshot().error, null);
		await new Promise(resolve => setTimeout(resolve, 20));
	};
	const server = createServer(async (request, response) => {
		let raw = ''; for await (const part of request) raw += part;
		const body = JSON.parse(raw); modelRequests.push(body);
		const toolCall = body.messages.at(-1).role === 'user';
		const delta = toolCall
			? { role: 'assistant', tool_calls: [{ index: 0, id: `wait-${modelRequests.length}`, type: 'function', function: { name: 'cua_wait', arguments: '{"ms":50}' } }] }
			: { role: 'assistant', content: 'Finished.' };
		const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'local-cua', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(chunk(delta, null) + chunk({}, toolCall ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
	});
	try {
		await mkdir(workspace);
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		seedTestModel(agentDir);
		const modelPath = join(agentDir, 'models.json');
		const models = JSON.parse(await readFile(modelPath, 'utf8'));
		models.providers[TEST_MODEL_PROVIDER].baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
		await writeFile(modelPath, JSON.stringify(models));
		process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
		const { AgentService } = await import('../packages/agent/src/index.ts');
		const requestConfirmation = async (request, signal) => {
			requests.push(request);
			return requests.length === 1 ? new Promise(resolve => { reply = resolve; signal?.addEventListener('abort', () => resolve(false), { once: true }); }) : false;
		};
		const open = () => new AgentService(async () => ({ trusted: true, remember: false }), requestConfirmation);
		service = open();
		await service.init({ cwd: workspace, fresh: true });
		await service.setModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
		const scope = service.getSnapshot();
		await service.prompt('Run cua_wait once.');
		await waitFor(() => requests.length === 1);
		assert.equal(requests[0].title, CUA_PERMISSION_TITLE);
		assert.equal(requests[0].kind, 'confirm');
		assert.equal(requests[0].scope.sessionId, scope.sessionId);
		assert.equal(modelRequests.length, 1, 'the model cannot proceed to a tool result before consent');
		reply(true);
		await waitFor(() => service.getSnapshot().status === 'idle');
		assert.match(modelRequests.at(-1).messages.at(-1).content, /已等待/);
		await promptAndSettle('Run cua_wait again.');
		assert.equal(requests.length, 1, 'later calls in the conversation do not prompt');
		await service.dispose();
		service = open();
		await service.init({ cwd: workspace, sessionPath: scope.sessionPath });
		await service.setModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
		await promptAndSettle('Run cua_wait after reopening.');
		assert.equal(requests.length, 1, 'the same conversation retains local consent after its runtime is recreated');
		await service.executeSlashCommand({ cwd: workspace, sessionId: scope.sessionId, name: 'cua', args: 'off' });
		await promptAndSettle('Try cua_wait after revocation.');
		assert.equal(requests.length, 1);
		assert.match(modelRequests.at(-1).messages.at(-1).content, /拒绝或关闭/);
		await service.newSession();
		await service.setModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
		assert.notEqual(service.getSnapshot().sessionId, scope.sessionId);
		await promptAndSettle('Run cua_wait in this new conversation.');
		assert.equal(requests.length, 2, 'a new conversation asks separately');
		assert.match(modelRequests.at(-1).messages.at(-1).content, /拒绝或关闭/);
		await promptAndSettle('Try again after declining.');
		assert.equal(requests.length, 2, 'a declined conversation does not repeatedly prompt');
	} finally {
		await service?.dispose();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		const safe = relative(resolve(tmpdir()), resolve(root));
		assert(!safe.startsWith('..') && !isAbsolute(safe));
		await rm(root, { recursive: true, force: true });
	}
});
