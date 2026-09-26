import type { AgentEventEnvelope, UiExtensionDialogRequest } from '@pidesktop/shared';
import type { AgentService, ProjectTrustDecision } from '@pidesktop/agent';
import type { readSessionContext, searchSessions, searchWorkspaceFiles, searchSessionsPage, searchProjectFiles, rebuildSearchIndex, cancelDataSearch, getProjectSearchRules, setProjectSearchRules } from './searchService';

type AgentServiceMethod = { [Key in keyof AgentService]: AgentService[Key] extends (...args: never[]) => unknown ? Key : never }[keyof AgentService];
type SearchMethods = {
 getUsageReport: (query: import('@pidesktop/shared').UsageQuery, workspaces: string[], automatedPaths: string[]) => Promise<import('@pidesktop/shared').UsageReport>;
 cancelUsageReport: (id: string) => void;
 searchSessionsPage: (workspaces: string[], request: import('@pidesktop/shared').SessionSearchRequest, metadata: Record<string, import('@pidesktop/shared').RecoverableSessionMetadata>, excludedPaths: string[]) => ReturnType<typeof searchSessionsPage>;
 searchProjectFiles: typeof searchProjectFiles;
 rebuildSearchIndex: (workspaces: string[]) => ReturnType<typeof rebuildSearchIndex>;
 cancelDataSearch: typeof cancelDataSearch;
 getProjectSearchRules: typeof getProjectSearchRules;
 setProjectSearchRules: typeof setProjectSearchRules;
	searchSessions: (workspaces: string[], query: string) => ReturnType<typeof searchSessions>;
	searchWorkspaceFiles: typeof searchWorkspaceFiles;
	readSessionContext: (cwd: string, path: string) => ReturnType<typeof readSessionContext>;
};

export const AGENT_HOST_METHODS = [
 'checkPluginUpdate', 'getMcpSnapshot', 'saveMcpServer', 'removeMcpServer', 'connectMcpServer', 'disconnectMcpServer', 'testMcpServer',
 'getUsageReport', 'cancelUsageReport',
 'submitInput', 'getInputQueue', 'mutateInputQueue', 'getFileCheckpoint', 'rewindFileCheckpoint',
 'searchSessionsPage', 'searchProjectFiles', 'rebuildSearchIndex', 'cancelDataSearch', 'getProjectSearchRules', 'setProjectSearchRules',
 'testProviderModel', 'cancelProviderModelTest', 'getProjectDefaults', 'saveProjectDefaults',
	'getPersonalization',
	'saveInstruction',
	'init',
	'switchWorkspace',
	'forgetWorkspace',
	'getSnapshot',
	'getHistoryPage',
	'getMessageAttachment',
	'getSessionStats',
	'exportSession',
	'getSessionTree',
	'switchSessionBranch',
	'listSessions',
	'searchSessions',
	'searchWorkspaceFiles',
	'readSessionContext',
	'listSlashCommands',
	'executeSlashCommand',
	'switchSession',
	'renameSession',
	'prepareSessionDeletion',
	'releaseSessionDeletion',
	'listModels',
	'listModelProviders',
	'discoverProviderModels',
	'saveCustomProvider',
	'removeCustomProvider',
	'setModel',
	'setThinkingLevel',
	'listProviderAuth',
	'setProviderApiKey',
	'removeProviderCredential',
	'setModelEnabled',
	'listExtensions',
	'setExtensionEnabled',
	'getPluginCatalog',
	'mutatePlugin',
	'previewPluginResource',
	'prompt',
	'editUserMessage',
	'forkAssistantMessage',
	'updateQueuedMessage',
	'generateCommitMessage',
	'abort',
	'newSession',
	'dispose',
] as const satisfies readonly (AgentServiceMethod | keyof SearchMethods)[];

export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];
type AgentMethods = Pick<AgentService, Exclude<AgentHostMethod, keyof SearchMethods>>;
export type AgentHostImplementation = AgentMethods & SearchMethods;
export type AgentHostService = {
	[Method in AgentHostMethod]: (...args: Parameters<AgentHostImplementation[Method]>) => Promise<Awaited<ReturnType<AgentHostImplementation[Method]>>>;
};

/** The protocol list is the single source for both host dispatch and client forwarding. */
export function createAgentHostMethods(agent: AgentMethods, search: SearchMethods): AgentHostImplementation {
	const methods = Object.create(null) as AgentHostImplementation;
	for (const name of AGENT_HOST_METHODS) {
		const owner = Object.hasOwn(search, name) ? search : agent;
		const method = (owner as unknown as Record<string, unknown>)[name];
		if (typeof method !== 'function') throw new Error(`Pi agent method unavailable: ${name}`);
		Object.defineProperty(methods, name, { value: method.bind(owner), enumerable: true });
	}
	return methods;
}

export function createAgentHostProxy(call: (method: AgentHostMethod, ...args: unknown[]) => Promise<unknown>): AgentHostService {
	return Object.fromEntries(AGENT_HOST_METHODS.map((method) => [method, (...args: unknown[]) => call(method, ...args)])) as AgentHostService;
}

export async function invokeAgentHostMethod(methods: AgentHostImplementation, message: Extract<MainToAgentHost, { kind: 'call' }>): Promise<unknown> {
	if (!Number.isSafeInteger(message.id) || message.id < 1 || !Array.isArray(message.args)) throw new Error('Invalid Pi agent call');
	if (!Object.hasOwn(methods, message.method)) throw new Error(`Unknown Pi agent method: ${message.method}`);
	const method = methods[message.method] as (...args: unknown[]) => unknown;
	return method(...message.args);
}

export type MainToAgentHost =
	| { kind: 'call'; id: number; method: AgentHostMethod; args: unknown[] }
	| { kind: 'ui-reply'; id: number; value: ProjectTrustDecision | string | boolean | null }
	| { kind: 'ui-error'; id: number; message: string };

export type AgentHostToMain =
	| { kind: 'ready' }
	| { kind: 'reply'; id: number; value: unknown }
	| { kind: 'error'; id: number; message: string }
	| { kind: 'event'; envelope: AgentEventEnvelope }
	| { kind: 'background-activity'; cwd: string; path: string }
	| { kind: 'ui-cancel'; id: number }
	| { kind: 'ui-request'; id: number; callId?: number; request: { kind: 'project-trust'; cwd: string } | { kind: 'extension'; dialog: UiExtensionDialogRequest } | { kind: 'resolve-proxy'; url: string } };
