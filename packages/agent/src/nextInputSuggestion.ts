/**
 * "Guess your next message": after a reply settles, one standalone, transcript-free model
 * call predicts what the user is likely to type next. Pure helpers live here so the
 * prompt shape and output cleanup are testable without a model.
 */

export const NEXT_INPUT_MAX_MESSAGES = 12;
export const NEXT_INPUT_MAX_MESSAGE_CHARS = 2_000;
export const NEXT_INPUT_MAX_CONTEXT_CHARS = 12_000;
export const NEXT_INPUT_MAX_CHARS = 200;
export const NEXT_INPUT_TIMEOUT_MS = 20_000;

export const NEXT_INPUT_SYSTEM_PROMPT = [
	'You predict the next message the USER will send in a conversation with an AI coding assistant.',
	'Rules:',
	'- Write it from the user\'s point of view, as the user would type it into the chat box.',
	'- Use the same language the user has been writing in.',
	'- One short sentence (ideally under 40 words). No greetings, no thanks-only replies.',
	'- Prefer a concrete next step that follows from the assistant\'s last reply (confirm a proposal, ask for the obvious follow-up, request verification).',
	'- Output only the message text: no quotes, no labels, no explanations, no code fences.',
	'- If no reasonable next message can be guessed, output nothing.',
].join('\n');

export interface SuggestionSourceMessage { role: string; text: string; status?: string; systemKind?: string }

/** Most recent user/assistant text, oldest first, within per-message and total budgets. */
export function buildNextInputContext(messages: readonly SuggestionSourceMessage[]): string {
	const picked: string[] = [];
	let total = 0;
	for (let index = messages.length - 1; index >= 0 && picked.length < NEXT_INPUT_MAX_MESSAGES; index -= 1) {
		const message = messages[index]!;
		if ((message.role !== 'user' && message.role !== 'assistant') || message.systemKind) continue;
		const text = message.text.trim();
		if (!text) continue;
		const clipped = text.length > NEXT_INPUT_MAX_MESSAGE_CHARS
			? `${message.role === 'assistant' ? '…' : ''}${message.role === 'assistant' ? text.slice(-NEXT_INPUT_MAX_MESSAGE_CHARS) : text.slice(0, NEXT_INPUT_MAX_MESSAGE_CHARS)}${message.role === 'user' ? '…' : ''}`
			: text;
		const block = `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${clipped}`;
		if (total + block.length > NEXT_INPUT_MAX_CONTEXT_CHARS && picked.length > 0) break;
		picked.push(block);
		total += block.length;
	}
	if (!picked.length) return '';
	return `${picked.reverse().join('\n\n')}\n\nPredict the USER's next message.`;
}

/** Normalizes a model answer into one suggestion line; empty when unusable. */
export function cleanNextInputSuggestion(raw: string): string {
	let text = raw.trim()
		.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '')
		.replace(/^(?:user|USER|用户)\s*[:：]\s*/, '')
		.trim();
	// Keep the first non-empty line only; the composer hint is a single line.
	text = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
	const quoted = /^(["'“‘「『])(.*)(["'”’」』])$/.exec(text);
	if (quoted) text = quoted[2]!.trim();
	if (text.length > NEXT_INPUT_MAX_CHARS) text = `${text.slice(0, NEXT_INPUT_MAX_CHARS - 1).trimEnd()}…`;
	return text;
}
