/** Slash commands are recognized only at the start of a draft, never in prose or paths. */
export interface SlashTrigger { start: number; end: number; query: string }

export function slashTriggerAt(text: string, start: number, end = start): SlashTrigger | null {
	if (start !== end || start < 1 || start > text.length) return null;
	const match = /^[ \t]*\/([^\s/]*)/.exec(text);
	if (!match) return null;
	const trigger = match[0].indexOf('/');
	const tokenEnd = match[0].length;
	if (text[tokenEnd] === '/' || start <= trigger || start > tokenEnd) return null;
	return { start: trigger, end: tokenEnd, query: text.slice(trigger + 1, start) };
}

/** Replace the entire command token while preserving arguments and the rest of the draft. */
export function completeSlashCommand(text: string, trigger: SlashTrigger, name: string): { text: string; caret: number } | null {
	if (!name || /[\s/]/u.test(name) || text[trigger.start] !== '/' || /\s/u.test(text.slice(trigger.start, trigger.end))) return null;
	const suffix = text.slice(trigger.end);
	const prefix = `${text.slice(0, trigger.start)}/${name}`;
	const space = suffix.startsWith(' ') || suffix.startsWith('\t') ? '' : ' ';
	return { text: prefix + space + suffix, caret: prefix.length + 1 };
}

/** Unknown command names still reach the command dispatcher for a useful error, not the model. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
	const match = /^\/([^\s/]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1]!, args: match[2] ?? '' } : null;
}
