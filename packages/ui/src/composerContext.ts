import type { UiAttachment, UiContextSource } from '@pidesktop/shared';

export interface ContextMention { start: number; end: number; query: string }

/** Match the token at the caret without treating an email address as a mention. */
export function contextMentionAt(text: string, start: number, end = start): ContextMention | null {
	if (start !== end || start <= 0 || start > text.length) return null;
	const trigger = text.lastIndexOf('@', start - 1);
	if (trigger < 0) return null;
	const previous = text[trigger - 1] ?? '';
	if (/[\w.%+\-@/\\]/u.test(previous)) return null;
	const query = text.slice(trigger + 1, start);
	if (query.length > 200 || /[\r\n@]/u.test(query)) return null;
	// An escaped @ and code spans are ordinary prompt text.
	const line = text.slice(text.lastIndexOf('\n', trigger) + 1, trigger);
	if ((line.match(/`/g)?.length ?? 0) % 2) return null;
	return { start: trigger, end: start, query };
}

export function consumeContextMention(text: string, mention: ContextMention): { text: string; caret: number } | null {
	if (text.slice(mention.start, mention.end) !== `@${mention.query}`) return null;
	return { text: text.slice(0, mention.start) + text.slice(mention.end), caret: mention.start };
}

export function contextSourceKey(source: Pick<UiContextSource, 'kind' | 'workspace' | 'path'>): string {
	const windows = /^[a-z]:[\\/]/i.test(source.workspace) || source.workspace.startsWith('\\\\');
	const normalize = (value: string) => {
		const path = value.replace(/\\/g, '/');
		return windows ? path.toLowerCase() : path;
	};
	return JSON.stringify([source.kind, normalize(source.workspace), normalize(source.path)]);
}

export function hasContextSource(attachments: UiAttachment[], source: Pick<UiContextSource, 'kind' | 'workspace' | 'path'>): boolean {
	const key = contextSourceKey(source);
	return attachments.some((item) => item.kind === 'text' && item.source && contextSourceKey(item.source) === key);
}
