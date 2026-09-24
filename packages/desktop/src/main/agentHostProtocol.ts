import type { AgentEventEnvelope, UiExtensionDialogRequest } from '@pidesktop/shared';
import type { ProjectTrustDecision } from '@pidesktop/agent';

export const AGENT_HOST_METHODS = [
	'init',
	'switchWorkspace',
	'getSnapshot',
	'listSessions',
	'searchSessions',
	'searchWorkspaceFiles',
	'readSessionContext',
	'listSlashCommands',
	'executeSlashCommand',
	'switchSession',
	'renameSession',
	'listModels',
	'listModelProviders',
	'saveCustomProvider',
	'removeCustomProvider',
	'setModel',
	'setThinkingLevel',
	'listProviderAuth',
	'setProviderApiKey',
	'removeProviderCredential',
	'listExtensions',
	'setExtensionEnabled',
	'getPluginCatalog',
	'mutatePlugin',
	'previewPluginResource',
	'prompt',
	'abort',
	'newSession',
	'dispose',
] as const;

export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];

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
	| { kind: 'ui-request'; id: number; callId?: number; request: { kind: 'project-trust'; cwd: string } | { kind: 'extension'; dialog: UiExtensionDialogRequest } };
