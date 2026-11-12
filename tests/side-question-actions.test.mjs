import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { useChatStore } from '../packages/ui/src/store.ts';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

const baseSnapshot = {
	sequence: 1,
	status: 'idle',
	statusMessage: undefined,
	model: 'chat-model',
	modelProvider: 'test-provider',
 modelName: 'Chat Model',
	thinkingLevel: 'medium',
	availableThinkingLevels: ['off', 'medium', 'high'],
	contextUsage: null,
	cwd: 'C:\\workspace',
	sessionId: 'session-1',
	sessionPath: 'C:\\sessions\\one.jsonl',
	messages: [
		{ id: 'u1', role: 'user', text: '第一轮问题', order: 0, status: 'done' },
		{ id: 'a1', role: 'assistant', text: '第一轮回答', order: 1, status: 'done' },
		{ id: 'u2', role: 'user', text: '第二轮问题', order: 2, status: 'done' },
		{ id: 'a2', role: 'assistant', text: '第二轮回答', order: 3, status: 'done' },
	],
	activities: [],
	queuedCount: 0,
	error: null,
};

function createBridge({ ask, snapshot = Promise.resolve(baseSnapshot), stored = [] } = {}) {
	const agentListeners = new Set();
	const sideListeners = new Set();
	const asks = [];
	const deletes = [];
	const bridge = {
		getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform }),
		getAgentSnapshot: () => snapshot,
		onAgentEvent(listener) { agentListeners.add(listener); return () => agentListeners.delete(listener); },
		listWorkspaces: async () => ['C:\\workspace'],
		listSessions: async () => [],
		refreshSessions: async () => {},
		listModels: async () => [],
		listModelProviders: async () => [],
		listProviderAuth: async () => [],
		listSideQuestions: async () => stored,
		askSideQuestion: async (request) => { asks.push(request); return ask ? ask(request) : { ...storedRecord(request), answer: '答案', status: 'done', finishedAt: 2 }; },
		deleteSideQuestion: async (sessionPath, id) => { deletes.push([sessionPath, id]); },
		onSideQuestionsChanged(listener) { sideListeners.add(listener); return () => sideListeners.delete(listener); },
	};
	return { bridge, asks, deletes, emitAgent: (event) => { for (const listener of agentListeners) listener({ sequence: 10, event }); }, emitSide: (path, records) => { for (const listener of sideListeners) listener(path, records); } };
}

const storedRecord = (request, over = {}) => ({
	id: request.id,
	sessionPath: request.sessionPath,
	anchorEntryId: request.anchorEntryId,
	question: request.question,
	answer: null,
	status: 'running',
	modelProvider: 'test-provider',
	modelId: 'chat-model',
	modelName: 'Chat Model',
	contextTruncated: false,
	createdAt: 1,
	finishedAt: null,
	...over,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
	useChatStore.setState(useChatStore.getInitialState(), true);
});

test('an aside ask builds the anchored slice, runs optimistically, and settles by id', async () => {
	const host = createBridge();
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	assert.deepEqual(useChatStore.getState().sideQuestions.map((item) => item.id), []);
	await useChatStore.getState().askSideQuestion('u2', '第二轮里的拦截器是什么？');
	const state = useChatStore.getState();
	assert.equal(state.sideQuestions.length, 1);
	const record = state.sideQuestions[0];
	assert.equal(record.status, 'done');
	assert.equal(record.answer, '答案');
	const request = host.asks[0];
	assert.equal(request.anchorEntryId, 'u2');
	assert.equal(request.sessionPath, 'C:\\sessions\\one.jsonl');
	// The context slice quotes the anchor turn and its ±1 neighbours from the loaded transcript.
	assert.ok(request.context.includes('第二轮问题'));
	assert.ok(request.context.includes('第二轮回答'));
	assert.ok(request.context.includes('第一轮问题'));
	assert.ok(!request.context.includes('[User]\n第二轮问题\n\n[User]'), 'roles stay labelled');
});

test('a failed ask keeps the record with the error and stays visible', async () => {
	const host = createBridge({ ask: () => { throw new Error('供应商超时'); } });
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	await useChatStore.getState().askSideQuestion('u2', '再问一次');
	const record = useChatStore.getState().sideQuestions.at(0);
	assert.equal(record.status, 'error');
	assert.equal(record.error, '供应商超时');
	assert.equal(record.answer, null);
});

test('pushes from other windows replace the record set of the shown session only', async () => {
	const host = createBridge();
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	await useChatStore.getState().askSideQuestion('u1', '第一轮说了什么');
	assert.equal(useChatStore.getState().sideQuestions.length, 1);
	const foreign = [storedRecord({ id: 'foreign', sessionPath: 'C:\\sessions\\other.jsonl', anchorEntryId: 'u1', question: 'x' })];
	host.emitSide('C:\\sessions\\other.jsonl', foreign);
	assert.equal(useChatStore.getState().sideQuestions.length, 1, 'a foreign session push is ignored');
	const mine = storedRecord({ id: 'pushed', sessionPath: 'C:\\sessions\\one.jsonl', anchorEntryId: 'u1', question: '推送' }, { status: 'done', answer: '推送答案' });
	host.emitSide('C:\\sessions\\one.jsonl', [mine]);
	assert.deepEqual(useChatStore.getState().sideQuestions.map((item) => item.id), ['pushed']);
});

test('a re-ask reuses the record id and delete removes it everywhere', async () => {
	const host = createBridge();
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	await useChatStore.getState().askSideQuestion('u2', '第一次问');
	const first = useChatStore.getState().sideQuestions.at(0);
	await useChatStore.getState().askSideQuestion('u2', '换个问法', { id: first.id });
	assert.equal(useChatStore.getState().sideQuestions.length, 1, 'a re-ask replaces its own card');
	assert.equal(useChatStore.getState().sideQuestions.at(0).question, '换个问法');
	await useChatStore.getState().deleteSideQuestion(first.id);
	assert.equal(useChatStore.getState().sideQuestions.length, 0);
	assert.deepEqual(host.deletes, [['C:\\sessions\\one.jsonl', first.id]]);
});

test('an ask submitted while a switch is in flight is rejected without any record (P2-1)', async () => {
	const host = createBridge();
	// Real host ordering: the switch RPC settles only after the renderer is already navigating.
	let finishSwitch;
	host.bridge.switchSession = () => new Promise((resolve) => { finishSwitch = resolve; });
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	useChatStore.getState().openSideQuestion('u2');
	assert.ok(useChatStore.getState().sideQuestionTarget, 'the composer is open on the conversation being left');
	const switching = useChatStore.getState().switchSession('C:\\sessions\\two.jsonl');
	assert.equal(useChatStore.getState().navigationPending, true);
	assert.equal(useChatStore.getState().sessionLoading, true);
	await useChatStore.getState().askSideQuestion('u2', '切换在途时的提问');
	assert.equal(useChatStore.getState().sideQuestions.length, 0, 'a mid-switch ask never creates a record');
	assert.deepEqual(host.asks, [], 'the host never receives the ask');
	finishSwitch();
	await switching;
	for (let i = 0; i < 10; i += 1) await settle();
	assert.equal(useChatStore.getState().navigationPending, false);
});

test('a session switch drops the open aside composer at switch start and on a foreign ready (P2-2)', async () => {
	const host = createBridge();
	host.bridge.switchSession = async () => {};
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	useChatStore.getState().openSideQuestion('u1');
	assert.ok(useChatStore.getState().sideQuestionTarget);
	// The optimistic switch commits the target identity before the host loads it.
	const switching = useChatStore.getState().switchSession('C:\\sessions\\two.jsonl');
	assert.equal(useChatStore.getState().sideQuestionTarget, null, 'switching identity closes the stale composer immediately');
	await switching;
	for (let i = 0; i < 10; i += 1) await settle();
	assert.equal(useChatStore.getState().navigationPending, false);
	assert.equal(useChatStore.getState().sessionPath, 'C:\\sessions\\two.jsonl', 'the keep-over view already carries the target identity');
	// A host-side switch (extension navigation, no optimistic commit) lands as a foreign ready.
	useChatStore.getState().openSideQuestion('u1');
	assert.ok(useChatStore.getState().sideQuestionTarget);
	host.emitAgent({
		type: 'ready', cwd: 'C:\\workspace', sessionId: 'session-2', sessionPath: 'C:\\sessions\\two.jsonl',
		messages: [], activities: [], fileChanges: [], model: 'chat-model', modelProvider: 'test-provider',
		thinkingLevel: 'medium', availableThinkingLevels: [], contextUsage: null,
	});
	assert.equal(useChatStore.getState().sideQuestionTarget, null, 'a foreign session ready retires the composer');
});
