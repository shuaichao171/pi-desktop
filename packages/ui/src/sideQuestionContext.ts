import type { UiMessage } from '@pidesktop/shared';

/**
 * 侧问上下文切片：把锚点轮次附近的可见转录拼成一段带预算的文本。
 *
 * 规则（详见 docs/specs/SIDE_QUESTION.md）：
 * - 轮次 = 一条用户消息及其后的助手回复，直到下一条用户消息；开头的孤儿
 *   助手文本自成一轮；
 * - 只取 user/assistant 文本（系统通知、插件通知不进侧问上下文）；
 * - 优先保留锚点轮次，其次向前（btw_history 语义）、再向后各 1 轮；
 * - 预算从内向外分配：放不下的整轮丢弃；锚点轮自身超预算时按消息截断
 *   （保留每条消息的结尾，与对话引用 readSessionContext 的取尾规则一致）；
 * - 未加载的更早历史（分页窗口之外）天然不在切片里。
 */

/** 整段切片的字符预算（不含提示词模板与问题本身）。 */
export const SIDE_QUESTION_CONTEXT_LIMIT = 24_000;
/** 单条消息进入切片前的字符上限。 */
export const SIDE_QUESTION_MESSAGE_LIMIT = 10_000;
/** 锚点轮之前/之后各取几轮可见正文。 */
export const SIDE_QUESTION_TURNS_BEFORE = 1;
export const SIDE_QUESTION_TURNS_AFTER = 1;

export interface SideQuestionContextSlice {
	/** 拼好的上下文文本；锚点不在已加载转录里时为 null。 */
	text: string;
	/** 任一位置发生丢弃或截断即为 true。 */
	truncated: boolean;
}

interface SliceMessage { id: string; role: 'user' | 'assistant'; text: string }
interface FittedTurn { blocks: string[]; size: number; complete: boolean; clipped: boolean }

const OMITTED_HEAD = '[beginning omitted]';

function eligible(message: UiMessage): SliceMessage | null {
	if ((message.role !== 'user' && message.role !== 'assistant') || message.systemKind) return null;
	const text = message.text.trim();
	return text ? { id: message.id, role: message.role, text } : null;
}

/** 预算内的正文：保留结尾（用户提问的问句、助手结论都在末尾；与对话引用 readSessionContext 的 latestText 取尾一致）。 */
function clipText(message: SliceMessage, limit: number): string {
	if (message.text.length <= limit) return message.text;
	const body = Math.max(0, limit - OMITTED_HEAD.length - 2);
	return `…${message.text.slice(-body)} ${OMITTED_HEAD}`;
}

/** Fits one turn's messages into `budget` characters of [Role]-labelled blocks. */
function fitTurn(turn: readonly SliceMessage[], budget: number, messageLimit: number): FittedTurn {
	const blocks: string[] = [];
	let size = 0;
	let clipped = false;
	for (const raw of turn) {
		const message: SliceMessage = { ...raw, text: clipText(raw, messageLimit) };
		clipped ||= message.text !== raw.text;
		const label = message.role === 'user' ? '[User]\n' : '[Assistant]\n';
		const gap = blocks.length ? 2 : 0;
		const remaining = budget - size - gap - label.length;
		if (remaining <= 0) return { blocks, size, complete: false, clipped };
		if (remaining < message.text.length) {
			blocks.push(`${label}${clipText(raw, remaining)}`);
			return { blocks, size: budget, complete: false, clipped: true };
		}
		blocks.push(`${label}${message.text}`);
		size += gap + label.length + message.text.length;
	}
	return { blocks, size, complete: true, clipped };
}

/**
 * 锚点解析：消息所属轮次的用户消息 entry id（用户消息即自身；助手消息回溯到
 * 最近的前置用户消息）。找不到（或前面没有用户消息）返回 null。
 */
export function sideQuestionAnchorFor(messages: readonly UiMessage[], messageId: string): string | null {
	let lastUser: string | null = null;
	for (const message of messages) {
		if (message.role === 'user') lastUser = message.id;
		if (message.id === messageId) return message.role === 'user' ? message.id : lastUser;
	}
	return null;
}

/** Builds the quoted context slice for an aside anchored on `anchorId` (a user message id). */
export function buildSideQuestionContext(messages: readonly UiMessage[], anchorId: string, options: { limit?: number; messageLimit?: number; turnsBefore?: number; turnsAfter?: number } = {}): SideQuestionContextSlice | null {
	if (!anchorId) return null;
	const limit = options.limit ?? SIDE_QUESTION_CONTEXT_LIMIT;
	if (limit <= 0) return null;
	const turnsBefore = options.turnsBefore ?? SIDE_QUESTION_TURNS_BEFORE;
	const turnsAfter = options.turnsAfter ?? SIDE_QUESTION_TURNS_AFTER;
	const messageLimit = options.messageLimit ?? SIDE_QUESTION_MESSAGE_LIMIT;
	const turns: SliceMessage[][] = [];
	for (const raw of messages) {
		const message = eligible(raw);
		if (!message) continue;
		// A turn opens at each user message; leading assistant text forms its own turn.
		if (message.role === 'user' || turns.length === 0) turns.push([message]);
		else turns[turns.length - 1]!.push(message);
	}
	const anchorTurn = turns.findIndex((turn) => turn.some((message) => message.id === anchorId));
	if (anchorTurn < 0) return null;
	const anchor = fitTurn(turns[anchorTurn]!, limit, messageLimit);
	if (anchor.blocks.length === 0) return null;
	let truncated = !anchor.complete || anchor.clipped;
	let used = anchor.size;
	// Nearest turns first; before-turns (btw_history semantics) outrank after-turns.
	const order: number[] = [];
	for (let distance = 1; distance <= Math.max(turnsBefore, turnsAfter); distance += 1) {
		if (distance <= turnsBefore) order.push(anchorTurn - distance);
		if (distance <= turnsAfter) order.push(anchorTurn + distance);
	}
	const chosen: Array<{ index: number; blocks: string[] }> = [{ index: anchorTurn, blocks: anchor.blocks }];
	for (const index of order) {
		if (index < 0 || index >= turns.length) continue;
		const fitted = fitTurn(turns[index]!, limit - used - 2, messageLimit);
		if (!fitted.complete || fitted.size === 0) { truncated = true; break; }
		used += 2 + fitted.size;
		chosen.push({ index, blocks: fitted.blocks });
	}
	const text = chosen.sort((left, right) => left.index - right.index).map((piece) => piece.blocks.join('\n\n')).join('\n\n');
	return { text, truncated };
}
