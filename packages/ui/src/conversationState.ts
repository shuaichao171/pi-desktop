import type { UiMessage } from '@pidesktop/shared';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';

export interface FindOccurrence { messageId: string; start: number; end: number; ordinal: number; key: string }
export function searchableMessageText(message: Pick<UiMessage, 'text'> & Partial<Pick<UiMessage, 'role'>>): string {
	if (message.role !== 'assistant') return message.text;
	type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
	const read = (node: Node): string => {
		if (node.type === 'text' || node.type === 'raw') return node.value ?? '';
		const children = node.children?.map(read).join('') ?? '';
		// CodeBlock removes the generated trailing newline; inline code keeps its exact text.
		return node.tagName === 'pre' ? children.replace(/\n$/, '') : children;
	};
	// Match react-markdown's GFM → HAST path, including the actual block separators.
	const tree = fromMarkdown(message.text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	return read(toHast(tree, { allowDangerousHtml: true }));
}
export function findOccurrences(messages: (Pick<UiMessage, 'id' | 'text'> & Partial<Pick<UiMessage, 'role'>>)[], query: string): FindOccurrence[] {
	const needle = query.trim();
	if (!needle) return [];
	// RegExp's Unicode case folding preserves source offsets (lowercasing İ does not).
	const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
	return messages.flatMap((message) => Array.from(searchableMessageText(message).matchAll(expression), (hit, ordinal) => ({ messageId: message.id, start: hit.index!, end: hit.index! + hit[0].length, ordinal, key: `${message.id}:${hit.index}` })));
}

export interface ReadingPosition { messageId: string | null; offset: number; followsBottom: boolean }
const readings = new Map<string, ReadingPosition>();
export const READING_CAPACITY = 100;
export function readingKey(cwd: string, path: string | null, tailId: string): string { return JSON.stringify([cwd, path, tailId]); }
export function saveReading(key: string, position: ReadingPosition): void {
	readings.delete(key); readings.set(key, position);
	while (readings.size > READING_CAPACITY) readings.delete(readings.keys().next().value!);
}
export function readReading(key: string): ReadingPosition | undefined { return readings.get(key); }
/** A newer branch tip may extend a cached branch. Its old tip must be verified first. */
export function recentReading(cwd: string, path: string | null): { tailId: string; position: ReadingPosition } | undefined {
	for (const [key, position] of [...readings].reverse()) {
		try { const identity = JSON.parse(key); if (Array.isArray(identity) && identity[0] === cwd && identity[1] === path && typeof identity[2] === 'string') return { tailId: identity[2], position }; } catch { /* Other cache namespaces are ignored. */ }
	}
	return undefined;
}

/** Plain text draft quoting preserves newlines and explicit source identity. */
export function appendQuote(draft: string, text: string, source: string): { text: string; block: string } {
	const block = `[${source}]\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n`;
	return { text: `${draft}${draft && !draft.endsWith('\n') ? '\n\n' : draft ? '\n' : ''}${block}`, block };
}
