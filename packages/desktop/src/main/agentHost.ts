import { UsageService } from './usageService';
/**
 * Pi runs in an Electron utility process so SDK work cannot block the window's
 * main process. Only plain data crosses this internal RPC boundary.
 */
import { AgentService, configureProviderNetwork } from '@pidesktop/agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { readSessionContext, searchSessions, searchWorkspaceFiles, searchSessionsPage, searchProjectFiles, rebuildSearchIndex, cancelDataSearch, getProjectSearchRules, setProjectSearchRules } from './searchService';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProjectTrustDecision } from '@pidesktop/agent';
import type { UiExtensionDialogRequest } from '@pidesktop/shared';
import { createAgentHostMethods, invokeAgentHostMethod, type AgentHostToMain, type MainToAgentHost } from './agentHostProtocol';

const parent = process.parentPort;
if (!parent) throw new Error('Pi agent host requires an Electron parent port');

let nextUiRequestId = 0;
const callContext = new AsyncLocalStorage<number>();
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
		post({ kind: 'ui-request', id, callId: callContext.getStore(), request });
	});
}

configureProviderNetwork(async (url) => {
	const proxy = await askMain<string | null>({ kind: 'resolve-proxy', url }, AbortSignal.timeout(10000));
	if (proxy === null) throw new Error('系统代理解析超时，请检查本机代理设置');
	return proxy;
});

const agent = new AgentService(
	(cwd): Promise<ProjectTrustDecision> => askMain({ kind: 'project-trust', cwd }),
	(dialog: UiExtensionDialogRequest, signal?: AbortSignal): Promise<string | boolean | null> =>
		askMain({ kind: 'extension', dialog }, signal),
);
agent.onEvent((envelope) => post({ kind: 'event', envelope }));
agent.onBackgroundActivity((cwd, path) => post({ kind: 'background-activity', cwd, path }));

const usage = new UsageService(join(getAgentDir(), 'sessions'), join(getAgentDir(), 'desktop-usage-index.json'));
const methods = createAgentHostMethods(agent, {
 getUsageReport: (query, workspaces, automatedPaths) => usage.report(query, workspaces, automatedPaths),
 cancelUsageReport: id => usage.cancel(id),
 searchSessionsPage: (workspaces, request, metadata, excludedPaths) => searchSessionsPage(join(getAgentDir(), 'sessions'), workspaces, request, metadata, agent.getSessionBranchHeads(), excludedPaths),
 searchProjectFiles, cancelDataSearch, getProjectSearchRules, setProjectSearchRules,
 rebuildSearchIndex: workspaces => rebuildSearchIndex(join(getAgentDir(), 'sessions'), workspaces),
	searchSessions: (workspaces, query) => searchSessions(join(getAgentDir(), 'sessions'), workspaces, query),
	searchWorkspaceFiles,
	readSessionContext: (cwd, path) => readSessionContext(join(getAgentDir(), 'sessions'), cwd, path),
});
parent.on('message', (event) => {
	const message = event.data as MainToAgentHost;
	if (!message || typeof message !== 'object') return;
	if (message.kind === 'ui-reply' || message.kind === 'ui-error') {
		const pending = pendingUi.get(message.id);
		if (!pending) return;
		pendingUi.delete(message.id);
		if (message.kind === 'ui-reply') pending.resolve(message.value);
		else pending.reject(new Error(message.message));
		return;
	}
	if (message.kind !== 'call') return;
	void callContext.run(message.id, async () => {
		try {
			const value = await invokeAgentHostMethod(methods, message);
			post({ kind: 'reply', id: message.id, value });
		} catch (error) {
			post({ kind: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
		}
	});
});

post({ kind: 'ready' });
