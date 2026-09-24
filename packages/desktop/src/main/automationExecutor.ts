import type { AgentSnapshot, UiAutomation } from '@pidesktop/shared';
import { createIsolatedAgentService } from './agentClient';

export interface AutomationExecutionResult {
	sessionId: string | null;
	sessionPath: string | null;
	summary: string;
}

export class AutomationExecutionError extends Error implements AutomationExecutionResult {
	sessionId: string | null;
	sessionPath: string | null;
	summary: string;
	constructor(message: string, result: AutomationExecutionResult) {
		super(message);
		Object.assign(this, result);
		this.sessionId = result.sessionId;
		this.sessionPath = result.sessionPath;
		this.summary = result.summary;
	}
}

/** Each run owns a worker and a fresh session. It never emits foreground chat events. */
export function createAutomationExecutor(options: {
	createAgent?: typeof createIsolatedAgentService;
	withSessionSetup?: (action: () => Promise<void>) => Promise<void>;
	executionTimeoutMs?: number;
} = {}) {
	const sessions = new Map<string, string>();
	const workers = new Set<symbol>();
	const unreleasedWorkers = new Set<symbol>();
	const createAgent = options.createAgent ?? createIsolatedAgentService;
	return {
		hasActiveWorkers: () => workers.size > 0,
		/** A failed shutdown is different from a healthy in-flight concurrent run. */
		hasUnreleasedWorkers: () => unreleasedWorkers.size > 0,
		isSessionRunning: (path: string) => sessions.has(path),
		sessionPaths: (cwd: string) => [...sessions].filter(([, owner]) => owner === cwd).map(([path]) => path),
		async execute(task: UiAutomation, signal: AbortSignal): Promise<AutomationExecutionResult> {
			const result: AutomationExecutionResult = { sessionId: null, sessionPath: null, summary: '' };
			const ownedPaths = new Set<string>();
			let started = false;
			let failure: string | null = null;
			let stopReason: Error | null = null;
			let finish!: () => void;
			let stop!: () => void;
			const finished = new Promise<void>((resolve) => { finish = resolve; });
			const stopped = new Promise<void>((resolve) => { stop = resolve; });
			const requestStop = (error: Error) => { stopReason ??= error; stop(); };
			const agent = createAgent({
				// Previously persisted trust still applies inside Pi. Unattended runs
				// cannot grant fresh project trust or approve an extension dialog.
				requestProjectTrust: async () => ({ trusted: false, remember: false }),
				requestExtensionDialog: async (request) => {
					if (request.kind === 'notify') return null;
					const error = new Error(`自动化需要交互，已停止：${request.title}`);
					requestStop(error);
					throw error;
				},
				onHostCrash: () => requestStop(new Error('自动化执行进程意外退出')),
			});
			const worker = Symbol(task.id);
			workers.add(worker);
			const remember = (snapshot: Pick<AgentSnapshot, 'sessionId' | 'sessionPath'>) => {
				result.sessionId = snapshot.sessionId;
				result.sessionPath = snapshot.sessionPath;
				if (snapshot.sessionPath) {
					sessions.set(snapshot.sessionPath, task.cwd);
					ownedPaths.add(snapshot.sessionPath);
				}
			};
			agent.onEvent(({ event }) => {
				if (event.type === 'ready') remember(event);
				// A provider can fail once and then complete successfully via Pi's
				// automatic retry. Only the final attempt determines the outcome.
				if (event.type === 'assistant-start') failure = null;
				if (event.type === 'assistant-end') {
					result.summary = event.text.slice(0, 4000);
					if (event.errorMessage) failure = event.errorMessage;
					if (event.aborted && !signal.aborted) failure ??= '自动化执行被中断';
				}
				if (event.type === 'error') failure = event.message;
				if (started && event.type === 'status' && (event.status === 'idle' || event.status === 'error')) {
					if (event.status === 'error') failure ??= event.message ?? '自动化执行失败';
					finish();
				}
			});
			const onAbort = () => requestStop(new Error('自动化已停止'));
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
			const timer = setTimeout(() => requestStop(new Error('自动化执行超过 30 分钟，已停止')), options.executionTimeoutMs ?? 30 * 60_000);
			const step = async <T>(action: () => Promise<T>): Promise<T> => {
				if (stopReason) throw stopReason;
				return Promise.race([action(), stopped.then(() => { throw stopReason; })]);
			};
			try {
				const setup = async () => {
					await step(() => agent.init({ cwd: task.cwd, fresh: true }));
					remember(await step(() => agent.getSnapshot()));
				};
				await step(() => options.withSessionSetup ? options.withSessionSetup(setup) : setup());
				if (task.model) await step(() => agent.setModel(task.model!.provider, task.model!.id, false));
				if (task.thinkingLevel) await step(() => agent.setThinkingLevel(task.thinkingLevel, false));
				if (failure) throw new Error(failure);
				started = true;
				await step(() => agent.prompt(task.prompt));
				// prompt() only acknowledges preflight acceptance. Idle/error events
				// represent the actual run finishing, even if they preceded the RPC reply.
				await step(() => finished);
				const snapshot = await step(() => agent.getSnapshot());
				remember(snapshot);
				const last = snapshot.messages.filter((message) => message.role === 'assistant').at(-1);
				if (last) result.summary = last.text.slice(0, 4000);
				if (failure || snapshot.error || last?.status === 'error') throw new Error(failure ?? snapshot.error ?? last?.errorMessage ?? '自动化执行失败');
				if (result.sessionPath) await step(() => agent.renameSession(result.sessionPath!, task.name, task.cwd));
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				// dispose aborts active work itself and never starts a replacement
				// worker after a crash or a cancellation before initialization.
				let workerStillRunning = false;
				try { await agent.dispose(); }
				catch (error) {
					failure ??= error instanceof Error ? error.message : String(error);
					workerStillRunning = error instanceof Error && 'workerStillRunning' in error && error.workerStillRunning === true;
				}
				// Keep paths locked until the worker has exited, including shutdown errors.
				if (workerStillRunning) {
					unreleasedWorkers.add(worker);
					result.sessionPath = null;
				}
				else {
					workers.delete(worker);
					for (const path of ownedPaths) sessions.delete(path);
				}
			}
			if (failure) throw new AutomationExecutionError(failure, result);
			return result;
		},
	};
}
