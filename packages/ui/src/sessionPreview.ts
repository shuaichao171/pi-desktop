import type { UiSessionPreview } from '@pidesktop/shared';

/**
 * Sidebar hover-card summaries (hover_card probe pattern): content is loaded
 * on the first hover of a row, cached per session revision, and every failure
 * degrades silently to a title-only hint — no error surfaces, no retry storm.
 */

/** Cached rows are small; the cap keeps the map bounded in long sessions. */
export const SESSION_PREVIEW_CACHE_LIMIT = 200;

export interface PreviewSummaryMessage {
	role: 'user' | 'assistant';
	text: string;
}

/** One collapsed line for the card; never splits a surrogate pair at the cut. */
export function firstSummaryLine(text: string): string {
	return text.trim().split(/\r?\n/u)[0]!.replace(/\s+/gu, ' ').slice(0, 240).replace(/[\uD800-\uDBFF]$/u, '');
}

/** Summary straight from messages already in memory (the active conversation): no IPC. */
export function previewFromMessages(messages: PreviewSummaryMessage[]): UiSessionPreview | null {
	const preview: UiSessionPreview = {};
	let seenUser = false, seenAssistant = false;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (!seenUser && message.role === 'user') { const line = firstSummaryLine(message.text); if (line) { preview.lastUser = line; seenUser = true; } }
		else if (!seenAssistant && message.role === 'assistant') { const line = firstSummaryLine(message.text); if (line) { preview.lastAssistant = line; seenAssistant = true; } }
		if (seenUser && seenAssistant) break;
	}
	return preview.lastUser || preview.lastAssistant ? preview : null;
}

/** Cache key: a changed revision (modified stamp) is a new conversation state worth one fresh load. */
export function sessionPreviewCacheKey(path: string, modified: string): string {
	return `${path}\u0000${modified}`;
}

export interface SessionPreviewCache {
	/** Deduped lookup; fetch failures settle as null so later hovers stay title-only. */
	get(key: string, fetch: () => Promise<UiSessionPreview | null>): Promise<UiSessionPreview | null>;
	/** Synchronous value once settled (undefined while in flight or uncached). */
	peek(key: string): UiSessionPreview | null | undefined;
}

/** Promise cache with in-flight dedupe, silent failure and bounded size. */
export function createSessionPreviewCache(limit = SESSION_PREVIEW_CACHE_LIMIT): SessionPreviewCache {
	const pending = new Map<string, Promise<UiSessionPreview | null>>();
	const settled = new Map<string, UiSessionPreview | null>();
	return {
		get(key, fetch) {
			// pending 已被容量淘汰但 settled 仍有值时直接命中，避免跨重挂载多读一次。
			const cached = settled.get(key);
			if (cached !== undefined) return Promise.resolve(cached);
			const existing = pending.get(key);
			if (existing) return existing;
			// A failed probe degrades quietly: the resolved null caches like a value,
			// and the next hover of the same revision never re-fires the request.
			const promise = Promise.resolve().then(fetch).catch(() => null);
			pending.set(key, promise);
			if (pending.size > limit) pending.delete(pending.keys().next().value!);
			void promise.then((value) => { settled.set(key, value); if (settled.size > limit) settled.delete(settled.keys().next().value!); });
			return promise;
		},
		peek(key) {
			return settled.has(key) ? settled.get(key) : undefined;
		},
	};
}

/** Window-wide instance shared by every sidebar row. */
export const sessionPreviewCache = createSessionPreviewCache();

/** Lazy load for one row through the shared cache (call on first hover, not on render). */
export function loadSessionPreview(
	bridge: { sessionPreview(workspace: string, path: string): Promise<UiSessionPreview | null> } | null | undefined,
	workspace: string,
	path: string,
	modified: string,
): Promise<UiSessionPreview | null> {
	if (!bridge?.sessionPreview) return Promise.resolve(null);
	return sessionPreviewCache.get(sessionPreviewCacheKey(path, modified), () => bridge.sessionPreview(workspace, path));
}
