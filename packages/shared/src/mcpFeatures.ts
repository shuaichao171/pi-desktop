export type McpScope = 'user' | 'project';
export interface UiMcpServerConfig {
	id: string; name: string; enabled: boolean; transport: 'stdio' | 'http';
	command?: string; args?: string[]; url?: string;
	/** Destination environment/header name -> source environment-variable credential reference. */
	environment?: Record<string, string>; headers?: Record<string, string>;
	requestTimeoutMs: number;
}
export interface UiMcpTool { name: string; registeredName: string; description: string }
export interface UiMcpServer extends UiMcpServerConfig {
	scope: McpScope; status: 'disconnected' | 'connecting' | 'connected' | 'error';
	error?: string; tools: UiMcpTool[];
}
export interface UiMcpSnapshot { cwd: string; sessionId: string; projectTrusted: boolean; servers: UiMcpServer[] }
export interface UiMcpTarget { cwd: string; sessionId: string; scope: McpScope; id: string }
export interface UiMcpSaveRequest { cwd: string; sessionId: string; scope: McpScope; config: UiMcpServerConfig }
export interface McpFeaturesBridge {
	getMcpSnapshot(): Promise<UiMcpSnapshot>;
	saveMcpServer(request: UiMcpSaveRequest): Promise<UiMcpSnapshot>;
	removeMcpServer(request: UiMcpTarget): Promise<UiMcpSnapshot>;
	connectMcpServer(request: UiMcpTarget): Promise<UiMcpSnapshot>;
	disconnectMcpServer(request: UiMcpTarget): Promise<UiMcpSnapshot>;
	testMcpServer(request: UiMcpTarget): Promise<{ tools: UiMcpTool[]; elapsedMs: number }>;
}
export const MCP_FEATURE_CHANNELS = {
	getMcpSnapshot: 'mcp:snapshot', saveMcpServer: 'mcp:save', removeMcpServer: 'mcp:remove',
	connectMcpServer: 'mcp:connect', disconnectMcpServer: 'mcp:disconnect', testMcpServer: 'mcp:test',
} as const;
