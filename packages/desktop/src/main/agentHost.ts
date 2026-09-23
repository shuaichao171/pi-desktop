/**
 * Pi runs in an Electron utility process so SDK work cannot block the window's
 * main process. Only plain data crosses this internal RPC boundary.
 */
import { AgentService } from '@pidesktop/agent';
import type { ProjectTrustDecision } from '@pidesktop/agent';
import type { UiExtensionDialogRequest } from '@pidesktop/shared';
import { AGENT_HOST_METHODS, type AgentHostToMain, type MainToAgentHost } from './agentHostProtocol';

const parent = process.parentPort;
if (!parent) throw new Error('Pi agent host requires an Electron parent port');

let nextUiRequestId = 0;
const pendingUi = new Map<number, {
	resolve(value: unknown): void;
	reject(error: Error): void;
}>();

function post(message: AgentHostToMain): void {
	parent.postMessage(message);
}

function askMain<T>(
	request: Extract<AgentHostToMain, { kind: 'ui-request' }>['request'],
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) return Promise.resolve(null as T);
	const id = ++nextUiRequestId;
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			pendingUi.delete(id);
			post({ kind: 'ui-cancel', id });
			resolve(null as T);
		};
		pendingUi.set(id, {
			resolve: (value) => {
				signal?.removeEventListener('abort', abort);
				resolve(value as T);
			},
			reject: (error) => {
				signal?.removeEventListener('abort', abort);
				reject(error);
			},
		});
		signal?.addEventListener('abort', abort, { once: true });
		post({ kind: 'ui-request', id, request });
	});
}

const agent = new AgentService(
	(cwd): Promise<ProjectTrustDecision> => askMain({ kind: 'project-trust', cwd }),
	(dialog: UiExtensionDialogRequest, signal?: AbortSignal): Promise<string | boolean | null> =>
		askMain({ kind: 'extension', dialog }, signal),
);
agent.onEvent((envelope) => post({ kind: 'event', envelope }));
agent.onBackgroundActivity((cwd, path) => post({ kind: 'background-activity', cwd, path }));

const allowedMethods = new Set<string>(AGENT_HOST_METHODS);
parent.on('message', (event) => {
	const message = event.data as MainToAgentHost;
	if (message.kind === 'ui-reply' || message.kind === 'ui-error') {
		const pending = pendingUi.get(message.id);
		if (!pending) return;
		pendingUi.delete(message.id);
		if (message.kind === 'ui-reply') pending.resolve(message.value);
		else pending.reject(new Error(message.message));
		return;
	}
	if (message.kind !== 'call') return;
	void (async () => {
		try {
			if (!allowedMethods.has(message.method)) throw new Error(`Unknown Pi agent method: ${message.method}`);
			const method = (agent as unknown as Record<string, (...args: unknown[]) => unknown>)[message.method];
			if (typeof method !== 'function') throw new Error(`Pi agent method unavailable: ${message.method}`);
			const value = await method.apply(agent, message.args);
			post({ kind: 'reply', id: message.id, value });
		} catch (error) {
			post({ kind: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
		}
	})();
});

post({ kind: 'ready' });
