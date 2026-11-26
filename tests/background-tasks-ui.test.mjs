import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	backgroundTaskCommandPreview,
	backgroundTaskDisplayName,
	classifyBackgroundTaskStatus,
	dismissSettledBackgroundTasks,
	EMPTY_BACKGROUND_TASK_VISIBILITY,
	formatBackgroundTaskDuration,
	reconcileVisibleBackgroundTasks,
	summarizeBackgroundTasks,
} from '../packages/ui/src/backgroundTasksState.ts';
import { useChatStore } from '../packages/ui/src/store.ts';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

function makeTask(overrides = {}) {
	return {
		taskId: 'bg-1',
		command: 'pnpm build',
		pid: 1234,
		logFile: 'C:\\logs\\bg-1.log',
		startedAt: 1000,
		status: 'running',
		...overrides,
	};
}

test('background task naming, duration and status classification helpers', () => {
	assert.equal(backgroundTaskDisplayName(makeTask({ note: '  构建\n桌面端  ', command: 'pnpm build' })), '构建 桌面端');
	assert.equal(backgroundTaskDisplayName(makeTask({ note: '   ', command: '\n  pnpm   test --watch \n echo done' })), 'pnpm test --watch');
	assert.equal(backgroundTaskDisplayName(makeTask({ command: '   ' })), 'bg-1');

	assert.equal(backgroundTaskCommandPreview(makeTask({ note: '构建', command: 'pnpm build' })), 'pnpm build');
	assert.equal(backgroundTaskCommandPreview(makeTask({ note: 'pnpm build', command: 'pnpm build' })), null);
	assert.equal(backgroundTaskCommandPreview(makeTask({ command: 'pnpm build' })), null);

	assert.equal(formatBackgroundTaskDuration(10_000, undefined, 15_400), '5s');
	assert.equal(formatBackgroundTaskDuration(10_000, 75_000, 999_000), '1m 05s');
	assert.equal(formatBackgroundTaskDuration(0, 3_720_000, 9_000_000), '1h 02m');

	assert.deepEqual(classifyBackgroundTaskStatus(makeTask({ status: 'running' })), { kind: 'running' });
	assert.deepEqual(classifyBackgroundTaskStatus(makeTask({ status: 'completed', exitCode: 0 })), { kind: 'completed' });
	assert.deepEqual(classifyBackgroundTaskStatus(makeTask({ status: 'completed', exitCode: null, exitedOffline: true })), { kind: 'completedOffline' });
	assert.deepEqual(classifyBackgroundTaskStatus(makeTask({ status: 'failed', signal: 'SIGKILL', exitCode: null })), { kind: 'failedSignal', signal: 'SIGKILL' });
	assert.deepEqual(classifyBackgroundTaskStatus(makeTask({ status: 'failed', exitCode: 2 })), { kind: 'failedExitCode', exitCode: 2 });
	assert.deepEqual(classifyBackgroundTaskStatus(makeTask({ status: 'failed', exitCode: null })), { kind: 'failed' });
});

test('visibility reconciliation: hides historical delivered tasks, keeps observed completions until dismissed', () => {
	// Historical task already completed and delivered before opening the session stays hidden.
	const historical = makeTask({ taskId: 'bg-old', status: 'completed', exitCode: 0, endedAt: 5000, delivered: true });
	const initial = reconcileVisibleBackgroundTasks(EMPTY_BACKGROUND_TASK_VISIBILITY, [historical]);
	assert.equal(initial.visible.length, 0);

	// New task starts running -> appears immediately while old task remains hidden.
	const runningA = makeTask({ taskId: 'bg-a', note: '构建前端', status: 'running' });
	const runningB = makeTask({ taskId: 'bg-b', note: '运行测试', status: 'running', startedAt: 2000 });
	const step1 = reconcileVisibleBackgroundTasks(initial, [historical, runningA, runningB]);
	assert.deepEqual(step1.visible.map((t) => t.taskId), ['bg-a', 'bg-b']);
	assert.deepEqual(summarizeBackgroundTasks(step1.visible), {
		running: 2, completed: 0, failed: 0, overallStatus: 'running', allSettledAndDelivered: false,
	});

	// Task A settles and is delivered while task B keeps running: both remain visible so A's update shows.
	const doneA = makeTask({ taskId: 'bg-a', note: '构建前端', status: 'completed', exitCode: 0, endedAt: 9000, delivered: true });
	const step2 = reconcileVisibleBackgroundTasks(step1, [historical, doneA, runningB]);
	assert.deepEqual(step2.visible.map((t) => [t.taskId, t.status]), [['bg-a', 'completed'], ['bg-b', 'running']]);
	assert.equal(summarizeBackgroundTasks(step2.visible).allSettledAndDelivered, false);

	// Task B fails (undelivered yet): allSettledAndDelivered stays false until delivery finishes.
	const failedBUndelivered = makeTask({ taskId: 'bg-b', note: '运行测试', status: 'failed', exitCode: 1, endedAt: 12000, delivered: false });
	const step3 = reconcileVisibleBackgroundTasks(step2, [historical, doneA, failedBUndelivered]);
	assert.equal(summarizeBackgroundTasks(step3.visible).overallStatus, 'failed');
	assert.equal(summarizeBackgroundTasks(step3.visible).allSettledAndDelivered, false);

	// Task B delivered: both stay visible with failed overall tone and now eligible for auto-dismiss.
	const failedB = { ...failedBUndelivered, delivered: true };
	const step4 = reconcileVisibleBackgroundTasks(step3, [historical, doneA, failedB]);
	assert.equal(step4.visible.length, 2);
	assert.equal(summarizeBackgroundTasks(step4.visible).allSettledAndDelivered, true);

	// Dismissing clears settled tasks; a brand-new task later starts cleanly on its own.
	const dismissed = dismissSettledBackgroundTasks(step4, [historical, doneA, failedB]);
	assert.equal(dismissed.visible.length, 0);
	const runningC = makeTask({ taskId: 'bg-c', note: '打包', status: 'running', startedAt: 20000 });
	const step5 = reconcileVisibleBackgroundTasks(dismissed, [historical, doneA, failedB, runningC]);
	assert.deepEqual(step5.visible.map((t) => t.taskId), ['bg-c']);

	// A task settled while away (undelivered) surfaces when opening the session.
	const parked = makeTask({ taskId: 'bg-parked', status: 'completed', exitCode: 0, endedAt: 8000, delivered: false });
	const onOpen = reconcileVisibleBackgroundTasks(EMPTY_BACKGROUND_TASK_VISIBILITY, [historical, parked]);
	assert.deepEqual(onOpen.visible.map((t) => t.taskId), ['bg-parked']);
});

test('AgentService.activate replays session background tasks after ready', async () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-bg-switch-'));
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	const { AgentService } = await import('../packages/agent/src/index.ts');
	const service = new AgentService();
	const events = [];
	service.onEvent(({ event }) => events.push(event));
	const stubContext = (sessionPath, backgroundTasks) => ({
		cwd: 'C:/workspace',
		get canEvict() { return true; },
		getSnapshot: () => ({
			cwd: 'C:/workspace', sessionId: `id:${sessionPath}`, sessionPath, subagentFleet: null, backgroundTasks,
			model: 'model', modelName: null, modelProvider: 'provider', thinkingLevel: 'off', availableThinkingLevels: ['off'],
			contextUsage: null, messages: [], activities: [], runs: [], fileChanges: [], fileChangeTurns: [], fileChangeActiveRunId: null,
			historyTotal: 0, status: 'idle', statusMessage: undefined, queuedCount: 0, queuedMessages: [], error: null,
		}),
		async dispose() {},
	});
	try {
		const tasks = [makeTask({ taskId: 'bg-warm', note: '持续构建' })];
		const a = stubContext('C:/sessions/a.jsonl', tasks);
		const b = stubContext('C:/sessions/b.jsonl', []);
		service.contexts.set('a', a);
		service.contexts.set('b', b);

		service.activate('a', a);
		const types = events.map((event) => event.type);
		assert.ok(types.indexOf('background-tasks') > types.indexOf('ready'), 'replay follows ready');
		assert.deepEqual(events.find((event) => event.type === 'background-tasks'), {
			type: 'background-tasks',
			tasks,
			sessionId: 'id:C:/sessions/a.jsonl',
			sessionPath: 'C:/sessions/a.jsonl',
		});

		events.length = 0;
		service.activate('b', b);
		assert.deepEqual(events.find((event) => event.type === 'background-tasks'), {
			type: 'background-tasks',
			tasks: [],
			sessionId: 'id:C:/sessions/b.jsonl',
			sessionPath: 'C:/sessions/b.jsonl',
		});
	} finally {
		await service.dispose();
		for (const [name, value] of [['PI_CODING_AGENT_DIR', saved.dir], ['PI_OFFLINE', saved.offline]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test('chat store hydrates, scopes, clears and stops background tasks safely', async () => {
	const listeners = new Set();
	const stopCalls = [];
	const initialTask = makeTask({ taskId: 'bg-init', note: '初始构建' });
	const snapshot = {
		sequence: 1,
		status: 'idle',
		model: 'm',
		modelProvider: 'p',
		thinkingLevel: 'off',
		availableThinkingLevels: ['off'],
		contextUsage: null,
		cwd: 'C:\\ws',
		sessionId: 'sess-1',
		sessionPath: 'C:\\sessions\\1.jsonl',
		messages: [],
		activities: [],
		runs: [],
		queuedCount: 0,
		queuedMessages: [],
		fileChanges: [],
		fileChangeTurns: [],
		fileChangeActiveRunId: null,
		backgroundTasks: [initialTask],
		error: null,
	};
	const bridge = {
		getAppInfo: async () => ({ appVersion: 'test', nodeVersion: process.version, electronVersion: 'test', platform: process.platform }),
		getAgentSnapshot: async () => snapshot,
		listWorkspaces: async () => ['C:\\ws'],
		listSessions: async () => [],
		stopBackgroundTask: async (taskId) => { stopCalls.push(taskId); return true; },
		onAgentEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
	};
	const emit = (sequence, event) => { for (const fn of listeners) fn({ sequence, event }); };

	useChatStore.getState().setBridge(bridge);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(useChatStore.getState().backgroundTasks, [initialTask]);

	// Foreign session event is ignored.
	emit(2, { type: 'background-tasks', tasks: [makeTask({ taskId: 'bg-foreign' })], sessionId: 'sess-2', sessionPath: 'C:\\sessions\\2.jsonl' });
	assert.deepEqual(useChatStore.getState().backgroundTasks, [initialTask]);

	// Matching session update applies live.
	const updated = { ...initialTask, status: 'completed', exitCode: 0, endedAt: 5000, delivered: true };
	emit(3, { type: 'background-tasks', tasks: [updated], sessionId: 'sess-1', sessionPath: 'C:\\sessions\\1.jsonl' });
	assert.deepEqual(useChatStore.getState().backgroundTasks, [updated]);

	// Same-session resync keeps background tasks intact.
	emit(4, { ...snapshot, type: 'ready', resync: true });
	assert.deepEqual(useChatStore.getState().backgroundTasks, [updated]);

	// Stop forwards to the bridge.
	assert.equal(await useChatStore.getState().stopBackgroundTask('bg-init'), true);
	assert.deepEqual(stopCalls, ['bg-init']);

	// Ready for a different session retires the old session's background tasks.
	emit(5, { ...snapshot, type: 'ready', sessionId: 'sess-2', sessionPath: 'C:\\sessions\\2.jsonl' });
	assert.deepEqual(useChatStore.getState().backgroundTasks, []);
});

test('BackgroundTasksBar SSR renders single running task, multi-task list, and hides historical tasks', async () => {
	const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
	const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
	const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
	const server = await createServer({
		root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
		configFile: false, server: { middlewareMode: true, hmr: false },
		optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
	});
	try {
		const { createChatStore, ChatStoreProvider } = await server.ssrLoadModule('/src/store.ts');
		const { BackgroundTasksBar } = await server.ssrLoadModule('/src/components/BackgroundTasksBar.tsx');
		const { translate } = await server.ssrLoadModule('/src/i18n.ts');
		const renderWithState = (patch) => {
			const store = createChatStore();
			store.setState(patch);
			const ssrStore = { ...store, getInitialState: () => store.getState() };
			return renderToStaticMarkup(createElement(ChatStoreProvider, { value: ssrStore }, createElement(BackgroundTasksBar)));
		};

		// 1. Historical delivered task only -> hidden.
		assert.equal(renderWithState({
			bridge: { stopBackgroundTask: async () => true },
			cwd: 'C:\\ws', sessionId: 's1', sessionPath: 'C:\\ws\\s1.jsonl', status: 'idle',
			backgroundTasks: [makeTask({ taskId: 'bg-old', status: 'completed', exitCode: 0, endedAt: 4000, delivered: true })],
		}), '');

		// 2. Reply ended (idle) with one running task -> shows task name, running pill, auto-resume hint, stop action.
		const singleHtml = renderWithState({
			bridge: { stopBackgroundTask: async () => true },
			cwd: 'C:\\ws', sessionId: 's1', sessionPath: 'C:\\ws\\s1.jsonl', status: 'idle',
			backgroundTasks: [makeTask({ taskId: 'bg-run', note: '构建桌面端', command: 'pnpm build', status: 'running' })],
		});
		assert.ok(singleHtml.includes('构建桌面端'));
		assert.ok(singleHtml.includes(translate('bgTasks.status.running')));
		assert.ok(singleHtml.includes(translate('bgTasks.autoResumeHint')));
		assert.ok(singleHtml.includes(translate('bgTasks.stop')));
		assert.match(singleHtml, /data-bg-state="running"/);

		// 3. Two tasks (one running, one failed undelivered) -> expanded list shows both names & statuses.
		const multiHtml = renderWithState({
			bridge: { stopBackgroundTask: async () => true },
			cwd: 'C:\\ws', sessionId: 's1', sessionPath: 'C:\\ws\\s1.jsonl', status: 'idle',
			backgroundTasks: [
				makeTask({ taskId: 'bg-1', note: '构建桌面端', command: 'pnpm build', status: 'running' }),
				makeTask({ taskId: 'bg-2', note: '运行单元测试', command: 'pnpm test', status: 'failed', exitCode: 1, endedAt: 8000, delivered: false }),
			],
		});
		assert.ok(multiHtml.includes('构建桌面端'));
		assert.ok(multiHtml.includes('运行单元测试'));
		assert.ok(multiHtml.includes(translate('bgTasks.status.failedExitCode', { code: '1' })));
		assert.ok(multiHtml.includes(translate('bgTasks.pendingDelivery')));
		assert.match(multiHtml, /class="pd-bg-tasks-list"/);
	} finally {
		await server.close();
	}
});
