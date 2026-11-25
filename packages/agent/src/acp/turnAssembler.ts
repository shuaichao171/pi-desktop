/**
 * Turns an ACP `session/update` stream into the same message/tool events the
 * Pi SDK emits, plus the transcript messages to persist. Downstream (timeline,
 * run tracking, history, sidebar, search) then treats an ACP conversation
 * exactly like a Pi one. Pure: no I/O, so replayed update sequences test it.
 */
import { isAbsolute, relative } from 'node:path';
import type { AcpContentBlock, AcpPlanEntry, AcpSessionUpdate, AcpStopReason, AcpToolCall, AcpToolCallContent, AcpToolKind, AcpAvailableCommand } from './protocol.ts';

export interface PiTextContent { type: 'text'; text: string }
export interface PiThinkingContent { type: 'thinking'; thinking: string }
export interface PiToolCallContent { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
export interface PiImageContent { type: 'image'; data: string; mimeType: string }

export interface PiUsage {
	input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiUserMessage { role: 'user'; content: string | (PiTextContent | PiImageContent)[]; timestamp: number }
export interface PiAssistantMessage {
	role: 'assistant';
	content: (PiTextContent | PiThinkingContent | PiToolCallContent)[];
	api: string;
	provider: string;
	model: string;
	usage: PiUsage;
	stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
	errorMessage?: string;
	timestamp: number;
}
export interface PiToolResultMessage {
	role: 'toolResult';
	toolCallId: string;
	toolName: string;
	content: PiTextContent[];
	isError: boolean;
	timestamp: number;
}
export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

type AssistantEvent =
	| { type: 'text_delta'; contentIndex: number; delta: string; partial: PiAssistantMessage }
	| { type: 'thinking_delta'; contentIndex: number; delta: string; partial: PiAssistantMessage };

export type PiShapedEvent =
	| { type: 'message_start'; message: PiMessage }
	| { type: 'message_update'; message: PiAssistantMessage; assistantMessageEvent: AssistantEvent }
	| { type: 'message_end'; message: PiMessage }
	| { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: { content: PiTextContent[] } }
	| { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: { content: PiTextContent[] }; isError: boolean };

export interface AssemblerOutput {
	events: PiShapedEvent[];
	/** Transcript messages in append order. */
	persist: PiMessage[];
	plan?: AcpPlanEntry[];
	commands?: AcpAvailableCommand[];
	modeId?: string;
}

const EMPTY_USAGE: PiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const MAX_TOOL_TEXT = 48_000;

/** Pi tool names keep the desktop's icons, titles and file-change tracking. */
export function piToolName(kind: AcpToolKind | undefined): string {
	switch (kind) {
		case 'read': return 'read';
		case 'edit': return 'edit';
		case 'delete': return 'delete';
		case 'move': return 'move';
		case 'search': return 'grep';
		case 'execute': return 'bash';
		case 'fetch': return 'fetch';
		case 'think': return 'think';
		default: return 'tool';
	}
}

function contentText(block: AcpContentBlock | undefined): string {
	if (!block || typeof block !== 'object') return '';
	if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') return (block as { text: string }).text;
	if (block.type === 'resource_link') return `[${String((block as { name?: unknown }).name ?? '')}](${String((block as { uri?: unknown }).uri ?? '')})`;
	if (block.type === 'resource') {
		const resource = (block as { resource?: { text?: unknown; uri?: unknown } }).resource;
		return typeof resource?.text === 'string' ? resource.text : String(resource?.uri ?? '');
	}
	return '';
}

function toolContentText(content: AcpToolCallContent[] | null | undefined): string {
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== 'object') continue;
		if (item.type === 'content') parts.push(contentText(item.content));
		else if (item.type === 'diff') {
			const added = item.newText.split('\n').length;
			const removed = item.oldText ? item.oldText.split('\n').length : 0;
			parts.push(`${item.path}: +${added} -${removed}`);
		} else if (item.type === 'terminal') parts.push(`[terminal ${item.terminalId}]`);
	}
	return parts.filter(Boolean).join('\n');
}

function rawOutputText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!value || typeof value !== 'object') return '';
	const record = value as Record<string, unknown>;
	for (const key of ['output', 'stdout', 'formatted_output', 'aggregated_output', 'content', 'result']) {
		if (typeof record[key] === 'string' && record[key]) return record[key] as string;
	}
	return '';
}

function capped(text: string): string {
	return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n…` : text;
}

function displayPath(cwd: string, path: string): string {
	if (!isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : path;
}

interface OpenTool { name: string; args: Record<string, unknown> }

export class AcpTurnAssembler {
	private readonly cwd: string;
	private readonly provider: string;
	model: string;
	private assistant: PiAssistantMessage | null = null;
	private readonly tools = new Map<string, OpenTool>();

	constructor(options: { cwd: string; provider: string; model: string }) {
		this.cwd = options.cwd;
		this.provider = options.provider;
		this.model = options.model;
	}

	get hasOpenTools(): boolean { return this.tools.size > 0; }

	userMessage(text: string, images: PiImageContent[] = []): AssemblerOutput {
		const message: PiUserMessage = {
			role: 'user',
			content: images.length ? [{ type: 'text', text }, ...images] : text,
			timestamp: Date.now(),
		};
		return { events: [{ type: 'message_start', message }, { type: 'message_end', message }], persist: [message] };
	}

	update(update: AcpSessionUpdate): AssemblerOutput {
		const out: AssemblerOutput = { events: [], persist: [] };
		switch (update.sessionUpdate) {
			case 'agent_message_chunk': this.appendText(out, contentText((update as { content: AcpContentBlock }).content), 'text'); break;
			case 'agent_thought_chunk': this.appendText(out, contentText((update as { content: AcpContentBlock }).content), 'thinking'); break;
			case 'tool_call': this.startTool(out, update as AcpToolCall); break;
			case 'tool_call_update': this.updateTool(out, update as AcpToolCall); break;
			case 'plan': {
				const entries = (update as { entries?: unknown }).entries;
				if (Array.isArray(entries)) out.plan = entries.filter((entry): entry is AcpPlanEntry => !!entry && typeof (entry as AcpPlanEntry).content === 'string');
				break;
			}
			case 'available_commands_update': {
				const commands = (update as { availableCommands?: unknown }).availableCommands;
				if (Array.isArray(commands)) out.commands = commands.filter((item): item is AcpAvailableCommand => !!item && typeof (item as AcpAvailableCommand).name === 'string');
				break;
			}
			case 'current_mode_update': {
				const mode = (update as { currentModeId?: unknown }).currentModeId;
				if (typeof mode === 'string') out.modeId = mode;
				break;
			}
			default: break;
		}
		return out;
	}

	/** Close the turn: the open reply ends with the prompt's stop reason; unfinished tools end as cancelled. */
	finish(stopReason: AcpStopReason | 'error', errorMessage?: string): AssemblerOutput {
		const out: AssemblerOutput = { events: [], persist: [] };
		const reason: PiAssistantMessage['stopReason'] = stopReason === 'cancelled' ? 'aborted'
			: stopReason === 'max_tokens' ? 'length'
			: stopReason === 'refusal' || stopReason === 'error' ? 'error' : 'stop';
		const message = stopReason === 'refusal' ? (errorMessage ?? 'Agent 拒绝了此请求') : errorMessage;
		for (const [id, tool] of this.tools) this.endTool(out, id, tool, stopReason === 'cancelled' ? '已取消' : '未完成', true);
		this.tools.clear();
		if (this.assistant || reason === 'error') {
			this.ensureAssistant(out);
			this.closeAssistant(out, reason, reason === 'error' ? (message || 'Agent 调用失败') : undefined);
		}
		return out;
	}

	private ensureAssistant(out: AssemblerOutput): PiAssistantMessage {
		if (this.assistant) return this.assistant;
		const message: PiAssistantMessage = {
			role: 'assistant', content: [], api: 'acp', provider: this.provider, model: this.model,
			usage: structuredClone(EMPTY_USAGE), stopReason: 'stop', timestamp: Date.now(),
		};
		this.assistant = message;
		out.events.push({ type: 'message_start', message });
		return message;
	}

	private closeAssistant(out: AssemblerOutput, stopReason: PiAssistantMessage['stopReason'], errorMessage?: string): void {
		const message = this.assistant;
		if (!message) return;
		this.assistant = null;
		message.stopReason = stopReason;
		if (errorMessage) message.errorMessage = errorMessage;
		out.events.push({ type: 'message_end', message });
		out.persist.push(message);
	}

	private appendText(out: AssemblerOutput, delta: string, kind: 'text' | 'thinking'): void {
		if (!delta) return;
		const message = this.ensureAssistant(out);
		const last = message.content.at(-1);
		let index = message.content.length - 1;
		if (kind === 'text') {
			if (last?.type === 'text') last.text += delta;
			else { message.content.push({ type: 'text', text: delta }); index = message.content.length - 1; }
			out.events.push({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta, partial: message } });
		} else {
			if (last?.type === 'thinking') last.thinking += delta;
			else { message.content.push({ type: 'thinking', thinking: delta }); index = message.content.length - 1; }
			out.events.push({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', contentIndex: index, delta, partial: message } });
		}
	}

	private toolArgs(call: AcpToolCall): Record<string, unknown> {
		const args: Record<string, unknown> = {};
		const location = Array.isArray(call.locations) ? call.locations.find((item) => item && typeof item.path === 'string') : undefined;
		const diff = Array.isArray(call.content) ? call.content.find((item) => item?.type === 'diff') as Extract<AcpToolCallContent, { type: 'diff' }> | undefined : undefined;
		const path = location?.path ?? diff?.path;
		if (path) args.path = displayPath(this.cwd, path);
		const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput as Record<string, unknown> : null;
		const command = raw?.command;
		if (typeof command === 'string' && command.trim()) args.command = command;
		else if (Array.isArray(command) && command.every((part) => typeof part === 'string')) args.command = (command as string[]).join(' ');
		if (!args.path && !args.command && call.title) args.prompt = call.title;
		return args;
	}

	private startTool(out: AssemblerOutput, call: AcpToolCall): void {
		if (typeof call.toolCallId !== 'string' || !call.toolCallId) return;
		if (this.tools.has(call.toolCallId)) { this.updateTool(out, call); return; }
		const name = piToolName(call.kind);
		const args = this.toolArgs(call);
		// Same shape as a Pi turn: the reply that requests a tool ends with the call,
		// the result follows, and later text opens a new reply.
		const message = this.ensureAssistant(out);
		message.content.push({ type: 'toolCall', id: call.toolCallId, name, arguments: args });
		this.closeAssistant(out, 'toolUse');
		this.tools.set(call.toolCallId, { name, args });
		out.events.push({ type: 'tool_execution_start', toolCallId: call.toolCallId, toolName: name, args });
		if (call.status === 'completed' || call.status === 'failed') this.updateTool(out, call);
	}

	private updateTool(out: AssemblerOutput, call: AcpToolCall): void {
		if (typeof call.toolCallId !== 'string' || !call.toolCallId) return;
		let tool = this.tools.get(call.toolCallId);
		if (!tool) {
			// Some agents send an update for a call they never announced.
			this.startTool(out, { ...call, status: 'in_progress' });
			tool = this.tools.get(call.toolCallId);
			if (!tool) return;
		}
		const text = capped(toolContentText(call.content) || rawOutputText(call.rawOutput));
		if (call.status === 'completed' || call.status === 'failed') {
			this.endTool(out, call.toolCallId, tool, text || (call.status === 'failed' ? '执行失败' : ''), call.status === 'failed');
			this.tools.delete(call.toolCallId);
			return;
		}
		if (text) out.events.push({ type: 'tool_execution_update', toolCallId: call.toolCallId, toolName: tool.name, args: tool.args, partialResult: { content: [{ type: 'text', text }] } });
	}

	private endTool(out: AssemblerOutput, id: string, tool: OpenTool, text: string, isError: boolean): void {
		const result = { content: [{ type: 'text' as const, text }] };
		out.events.push({ type: 'tool_execution_end', toolCallId: id, toolName: tool.name, result, isError });
		out.persist.push({ role: 'toolResult', toolCallId: id, toolName: tool.name, content: result.content, isError, timestamp: Date.now() });
	}
}

export function planText(entries: AcpPlanEntry[]): string {
	const mark = (status: AcpPlanEntry['status']) => status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
	return entries.map((entry) => `- ${mark(entry.status)} ${entry.content}`).join('\n');
}
