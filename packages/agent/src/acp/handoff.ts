/**
 * Context handoff: when a conversation continues in another agent, the new
 * conversation starts with a deterministic rendering of the old one (no model
 * call), newest items kept within a character budget — the same approach as
 * t3code's ContextHandoffService.renderHistory.
 */

export const HANDOFF_CUSTOM_TYPE = 'pi-desktop-handoff';
export const AGENT_BINDING_CUSTOM_TYPE = 'pi-desktop-agent';
/** Written once the receiving agent has accepted a prompt that carried the handoff context. */
export const HANDOFF_DELIVERED_CUSTOM_TYPE = 'pi-desktop-handoff-delivered';
export const HANDOFF_CONTEXT_BUDGET = 32_000;
const TEXT_ITEM_MAX = 2_000;
const TOOL_ITEM_MAX = 240;

export interface HandoffRecord {
	direction: 'from' | 'to';
	sessionPath: string;
	fromAgent: string;
	toAgent: string;
	/** Rendered context (direction 'from' only). */
	context?: string;
}

export interface AgentBindingRecord {
	agentId: string;
	/** The agent's own session id, for `session/load` when supported. */
	nativeSessionId?: string | null;
}

type EntryLike = { type: string; customType?: string; data?: unknown; message?: unknown };

function compact(text: string, max: number): string {
	const value = text.replace(/\s+/g, ' ').trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function textOf(content: unknown, kind: 'text'): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.filter((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === kind)
		.map((part) => String((part as { text?: unknown }).text ?? '')).join('\n');
}

const TEXT_ATTACHMENT_MARKER = '\n\n<!-- pi-desktop:attachments-v1 -->\n';

/** One line per visible item, oldest first. */
export function handoffItems(entries: readonly EntryLike[]): string[] {
	const items: string[] = [];
	for (const entry of entries) {
		if (entry.type === 'custom' && entry.customType === HANDOFF_CUSTOM_TYPE) {
			const data = entry.data as Partial<HandoffRecord> | undefined;
			if (data?.direction === 'from' && data.context) items.push(`- 更早的交接（${data.fromAgent ?? '?'} → ${data.toAgent ?? '?'}）已包含在本会话开头`);
			continue;
		}
		if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
		const message = entry.message as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
		if (message.role === 'user') {
			const raw = textOf(message.content, 'text');
			const text = raw.split(TEXT_ATTACHMENT_MARKER)[0] ?? raw;
			if (text.trim()) items.push(`- 用户：${compact(text, TEXT_ITEM_MAX)}`);
		} else if (message.role === 'assistant') {
			const text = textOf(message.content, 'text');
			if (text.trim()) items.push(`- 助手：${compact(text, TEXT_ITEM_MAX)}`);
			if (Array.isArray(message.content)) for (const part of message.content) {
				if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'toolCall') continue;
				const call = part as { name?: unknown; arguments?: Record<string, unknown> };
				const args = call.arguments ?? {};
				if (typeof args.command === 'string' && args.command.trim()) items.push(`- 命令：${compact(args.command, TOOL_ITEM_MAX)}`);
				else if (typeof args.path === 'string' && ['edit', 'write', 'delete', 'move'].includes(String(call.name))) items.push(`- 改动文件：${compact(args.path, TOOL_ITEM_MAX)}`);
			}
		}
	}
	return items;
}

/** Render the context block sent to the receiving agent. */
export function renderHandoffContext(entries: readonly EntryLike[], fromAgent: string, budget = HANDOFF_CONTEXT_BUDGET): string {
	const header = `以下是此前在「${fromAgent}」中进行的对话上下文（自动整理，非逐字记录）：`;
	const footer = '请基于以上上下文继续工作。';
	const omitted = '- （较早内容已省略）';
	const items = handoffItems(entries);
	let remaining = budget - header.length - footer.length - omitted.length - 8;
	const kept: string[] = [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index]!;
		if (item.length + 1 > remaining) break;
		kept.unshift(item);
		remaining -= item.length + 1;
	}
	const truncated = kept.length < items.length;
	return [header, '', ...(truncated ? [omitted] : []), ...(kept.length ? kept : ['- （没有可交接的内容）']), '', footer].join('\n');
}

/** Latest agent binding recorded in a session's entries; null means Pi. */
export function readAgentBinding(entries: readonly EntryLike[]): AgentBindingRecord | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== 'custom' || entry.customType !== AGENT_BINDING_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<AgentBindingRecord> | undefined;
		if (!data || typeof data.agentId !== 'string') return null;
		return { agentId: data.agentId, nativeSessionId: typeof data.nativeSessionId === 'string' ? data.nativeSessionId : null };
	}
	return null;
}

/** Model and session settings the user chose for an external agent's conversation. */
export interface AgentSettingsRecord {
	model?: string;
	/** Config option id → chosen value. */
	options: Record<string, string>;
}

export const AGENT_SETTINGS_CUSTOM_TYPE = 'pi-desktop-agent-settings';
const SETTINGS_MAX_OPTIONS = 20;
const SETTINGS_MAX_TEXT = 500;

/** A stored settings record with anything malformed or oversized dropped. */
export function parseAgentSettings(value: unknown): AgentSettingsRecord {
	const data = value && typeof value === 'object' && !Array.isArray(value) ? value as { model?: unknown; options?: unknown } : undefined;
	const valid = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= SETTINGS_MAX_TEXT;
	const options: Record<string, string> = {};
	if (data?.options && typeof data.options === 'object' && !Array.isArray(data.options)) {
		for (const [id, option] of Object.entries(data.options).slice(0, SETTINGS_MAX_OPTIONS)) if (valid(id) && valid(option)) options[id] = option;
	}
	return { ...(valid(data?.model) ? { model: data.model } : {}), options };
}

/** Latest settings record; agents reset to their defaults when a session is loaded again. */
export function readAgentSettings(entries: readonly EntryLike[]): AgentSettingsRecord | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== 'custom' || entry.customType !== AGENT_SETTINGS_CUSTOM_TYPE) continue;
		return parseAgentSettings(entry.data);
	}
	return null;
}

/** The incoming handoff of a conversation, if it started from another one. */
export function readIncomingHandoff(entries: readonly EntryLike[]): HandoffRecord | null {
	for (const entry of entries) {
		if (entry.type !== 'custom' || entry.customType !== HANDOFF_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<HandoffRecord> | undefined;
		if (data?.direction === 'from' && typeof data.sessionPath === 'string') return data as HandoffRecord;
	}
	return null;
}

/**
 * The incoming handoff whose context the agent has not received yet. A first
 * prompt that failed before reaching the agent keeps it pending, so the retry
 * still carries the context.
 */
export function pendingIncomingHandoff(entries: readonly EntryLike[]): HandoffRecord | null {
	if (entries.some((entry) => entry.type === 'custom' && entry.customType === HANDOFF_DELIVERED_CUSTOM_TYPE)) return null;
	return readIncomingHandoff(entries);
}

export function hasConversation(entries: readonly EntryLike[]): boolean {
	return entries.some((entry) => entry.type === 'message' && !!entry.message && typeof entry.message === 'object'
		&& ['user', 'assistant'].includes(String((entry.message as { role?: unknown }).role)));
}
