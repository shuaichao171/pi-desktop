/**
 * The subset of ACP (Agent Client Protocol, https://agentclientprotocol.com)
 * that Pi Desktop speaks as a client. Wire format: JSON-RPC 2.0, one JSON
 * object per line on the agent's stdin/stdout.
 *
 * The desktop advertises no client filesystem or terminal capability, so agents
 * use their own tools for files and commands. The client handles permission
 * requests and session-scoped elicitation forms.
 */

export const ACP_PROTOCOL_VERSION = 1;

export type AcpContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string; uri?: string }
	| { type: 'resource_link'; uri: string; name: string; mimeType?: string }
	| { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
	| { type: string; [key: string]: unknown };

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpToolCallContent =
	| { type: 'content'; content: AcpContentBlock }
	| { type: 'diff'; path: string; oldText?: string | null; newText: string }
	| { type: 'terminal'; terminalId: string };

export interface AcpToolCallLocation { path: string; line?: number | null }

export interface AcpToolCall {
	toolCallId: string;
	title?: string;
	kind?: AcpToolKind;
	status?: AcpToolStatus;
	content?: AcpToolCallContent[] | null;
	locations?: AcpToolCallLocation[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface AcpAvailableCommand { name: string; description?: string; input?: { hint?: string } | null }
export interface AcpPlanEntry { content: string; priority?: string; status?: 'pending' | 'in_progress' | 'completed' }

export type AcpSessionUpdate =
	| { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
	| { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
	| { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
	| ({ sessionUpdate: 'tool_call' } & AcpToolCall)
	| ({ sessionUpdate: 'tool_call_update' } & AcpToolCall)
	| { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
	| { sessionUpdate: 'available_commands_update'; availableCommands: AcpAvailableCommand[] }
	| { sessionUpdate: 'current_mode_update'; currentModeId: string }
	| { sessionUpdate: string; [key: string]: unknown };

export interface AcpSessionNotification { sessionId: string; update: AcpSessionUpdate }

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpRequestPermissionParams {
	sessionId: string;
	toolCall: AcpToolCall;
	options: AcpPermissionOption[];
}

export type AcpRequestPermissionOutcome =
	| { outcome: 'selected'; optionId: string }
	| { outcome: 'cancelled' };

export interface AcpAuthMethod { id: string; name: string; description?: string | null }

export interface AcpInitializeResult {
	protocolVersion: number;
	_meta?: { steering?: { supported?: boolean } | null } | null;
	agentCapabilities?: {
		loadSession?: boolean;
		promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
	};
	authMethods?: AcpAuthMethod[];
	agentInfo?: { name?: string; title?: string; version?: string };
}

export interface AcpModelInfo { modelId: string; name: string; description?: string | null }

export interface AcpConfigOptionValue { value: string; name: string; description?: string | null }

/** Session config option (`select` type); `options` may be flat or grouped. */
export interface AcpConfigOption {
	id: string;
	name: string;
	description?: string | null;
	category?: string | null;
	type: string;
	currentValue: string;
	options: (AcpConfigOptionValue | { group: string; name: string; options: AcpConfigOptionValue[] })[];
}

export interface AcpNewSessionResult {
	sessionId: string;
	models?: { currentModelId: string; availableModels: AcpModelInfo[] } | null;
	modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string | null }[] } | null;
	configOptions?: AcpConfigOption[] | null;
}

export interface AcpPromptResult { stopReason: AcpStopReason }
export interface AcpSteeringResult { outcome: 'injected' | 'promptRequired' | 'startedNewTurn' | 'failed' }

export interface JsonRpcError { code: number; message: string; data?: unknown }

export type JsonRpcMessage =
	| { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown }
	| { jsonrpc: '2.0'; method: string; params?: unknown }
	| { jsonrpc: '2.0'; id: number | string; result?: unknown; error?: JsonRpcError };

export class AcpRequestError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(error: JsonRpcError) {
		super(error.message || `ACP 请求失败（${error.code}）`);
		this.name = 'AcpRequestError';
		this.code = error.code;
		this.data = error.data;
	}
}

/** JSON-RPC "auth required" code used by ACP agents that need a sign-in first. */
export const ACP_AUTH_REQUIRED = -32000;
