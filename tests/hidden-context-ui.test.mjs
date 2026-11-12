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

const ONE = 'C:\\sessions\\one.jsonl';
const TWO = 'C:\\sessions\\two.jsonl';

const snapshot = {
	sequence: 1, status: 'idle', statusMessage: undefined, model: 'chat-model', modelProvider: 'test-provider', modelName: 'Chat Model',
	thinkingLevel: 'medium', availableThinkingLevels: ['off', 'medium'], contextUsage: null,
	cwd: 'C:\\workspace', sessionId: 'session-1', sessionPath: ONE,
	messages: [{ id: 'u1', role: 'user', text: '问题', order: 0, status: 'done' }, { id: 'a1', role: 'assistant', text: '回答', order: 1, status: 'done' }],
	activities: [], queuedCount: 0, error: null,
};

function createBridge(getHiddenContext) {
	const agentListeners = new Set();
	const bridge = {
		getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform }),
		getAgentSnapshot: async () => snapshot,
		onAgentEvent(listener) { agentListeners.add(listener); return () => agentListeners.delete(listener); },
		listWorkspaces: async () => ['C:\\workspace'],
		listSessions: async () => [],
		refreshSessions: async () => {},
		listModels: async () => [],
		listModelProviders: async () => [],
		listProviderAuth: async () => [],
		listSideQuestions: async () => [],
		getHiddenContext,
		setHiddenContext: async () => {},
		switchSession: async () => {},
	};
	return { bridge, emitAgent: (event) => { for (const listener of agentListeners) listener({ sequence: 10, event }); } };
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const readyFor = (sessionId, sessionPath) => ({
	type: 'ready', cwd: 'C:\\workspace', sessionId, sessionPath, messages: [], activities: [], fileChanges: [],
	model: 'chat-model', modelProvider: 'test-provider', thinkingLevel: 'medium', availableThinkingLevels: [], contextUsage: null,
});

beforeEach(() => {
	useChatStore.setState(useChatStore.getInitialState(), true);
});

test('a session switch never shows the previous conversation\'s hidden instruction, even when the fetch fails', async () => {
	const host = createBridge(async (path) => {
		if (path === ONE) return '只属于会话一';
		throw new Error('fetch failed');
	});
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	assert.equal(useChatStore.getState().sessionPath, ONE);
	assert.equal(useChatStore.getState().hiddenContext, '只属于会话一');

	// Optimistic switch: the identity changes before the host loads the target.
	const switching = useChatStore.getState().switchSession(TWO);
	assert.equal(useChatStore.getState().hiddenContext, null, 'the identity change drops the old value at once');
	await switching;
	await settle();
	assert.equal(useChatStore.getState().sessionPath, TWO);
	assert.equal(useChatStore.getState().hiddenContext, null, 'a failed fetch for the new session never resurrects the old value');
});

test('a foreign ready drops the previous instruction until the new conversation\'s value lands', async () => {
	let releaseTwo;
	const host = createBridge((path) => path === ONE ? Promise.resolve('指令一') : new Promise((resolve) => { releaseTwo = resolve; }));
	useChatStore.getState().setBridge(host.bridge);
	await settle();
	assert.equal(useChatStore.getState().hiddenContext, '指令一');

	host.emitAgent(readyFor('session-2', TWO));
	assert.equal(useChatStore.getState().sessionPath, TWO);
	assert.equal(useChatStore.getState().hiddenContext, null, 'pending fetch: nothing from session one is shown');
	releaseTwo('');
	await settle();
	assert.equal(useChatStore.getState().hiddenContext, '', 'the new conversation\'s own (empty) value lands');

	// A same-session resync keeps the value (no flicker of the indicator).
	useChatStore.setState({ hiddenContext: '指令二' });
	host.emitAgent(readyFor('session-2', TWO));
	assert.equal(useChatStore.getState().hiddenContext, '指令二');
});
