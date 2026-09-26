import { createContext } from 'react';
export const TranscriptSearchContext = createContext('');

/** DOM ranges leave React, Markdown source, clipboard text and syntax tokens untouched. */
export function textRanges(root: HTMLElement, query: string): Range[] {
	if (!query.trim()) return [];
	const nodes: { node: Text; start: number }[] = [];
	let text = '';
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
		return node.parentElement?.closest('button, summary, .pd-code-block-header, .pd-code-block-toggle') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
	} });
	for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push({ node: node as Text, start: text.length }); text += node.textContent ?? ''; }
	const expression = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
	return Array.from(text.matchAll(expression)).flatMap((hit) => {
		const start = hit.index!, end = start + hit[0].length;
		const first = nodes.find((entry) => entry.start + entry.node.length > start);
		const last = [...nodes].reverse().find((entry) => entry.start < end);
		if (!first || !last) return [];
		const range = document.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start); return [range];
	});
}

export function paintTranscriptMatches(root: HTMLElement, query: string, messageId: string | null, ordinal: number): Range | undefined {
	const api = globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown; CSS: typeof CSS & { highlights?: Map<string, unknown> } };
	if (!api.Highlight || !api.CSS?.highlights) return;
	const all: Range[] = []; let active: Range | undefined;
	for (const body of Array.from(root.querySelectorAll<HTMLElement>('[data-message-body]'))) {
		const ranges = textRanges(body, query); all.push(...ranges);
		if (body.closest('[data-message-id]')?.getAttribute('data-message-id') === messageId) active = ranges[ordinal];
	}
	api.CSS.highlights.set('pd-find-all', new api.Highlight(...all));
	api.CSS.highlights.set('pd-find-current', new api.Highlight(...(active ? [active] : [])));
	return active;
}

/** Code blocks can scroll independently; reveal the word in every containing viewport. */
export function revealTranscriptRange(range: Range, transcript: HTMLElement): void {
	for (let node = range.startContainer.parentElement; node; node = node.parentElement) {
		const style = getComputedStyle(node);
		const rect = range.getBoundingClientRect(), box = node.getBoundingClientRect();
		if (node === transcript || /auto|scroll/.test(style.overflowY)) {
			if (node.scrollHeight > node.clientHeight) node.scrollTop += rect.top - box.top - node.clientHeight / 2 + rect.height / 2;
		}
		if (/auto|scroll/.test(style.overflowX) && (rect.left < box.left || rect.right > box.right)) node.scrollLeft += rect.left - box.left - node.clientWidth / 2 + Math.min(rect.width, node.clientWidth) / 2;
		if (node === transcript) break;
	}
}
