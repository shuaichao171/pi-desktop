import { useEffect, useState } from 'react';
import { createWorkerTaskPool, type WorkerTaskPool } from './workerTaskPool.ts';

/**
 * Code blocks longer than CodeBlock's synchronous limit highlight here
 * (roughly 100 ms per 2,000 lines on the main thread). Past this line count
 * even the worker is skipped: highlighting such a block takes seconds and the
 * DOM cost dwarfs it, so plain text stays — the previous over-limit behaviour.
 */
export const WORKER_HIGHLIGHT_LINE_LIMIT = 20_000;

/** Generous on purpose: long blocks legitimately take seconds; only a wedged worker gives up. */
const WORKER_HIGHLIGHT_TIMEOUT_MS = 20_000;

interface HighlightRequest { source: string; language: string }
interface HighlightResponse { html: string }

const pool: WorkerTaskPool<HighlightRequest, HighlightResponse> = createWorkerTaskPool({
	create: () => new Worker(new URL('./codeHighlight.worker.ts', import.meta.url), { type: 'module' }),
	// Failure/timeout answers with '' so the already-rendered plain text stays.
	fallback: () => ({ html: '' }),
	timeoutMs: WORKER_HIGHLIGHT_TIMEOUT_MS,
});

/** Highlights one block in the worker; every failure path answers with '' so plain text stays. */
export function requestHighlight(source: string, language: string, done: (response: HighlightResponse) => void): () => void {
	if (typeof Worker === 'undefined') { done({ html: '' }); return () => {}; }
	return pool.request({ source, language }, done);
}

/**
 * Highlighted HTML for one stable (non-streaming) code block. Returns '' until
 * the worker answers and for every fallback case; answers for another source
 * or language are dropped by the identity check. The markup only wraps the
 * same text in spans, so swapping it in never changes line heights or reflows.
 */
export function useWorkerHighlight(source: string, language: string, enabled: boolean): string {
	const [result, setResult] = useState<{ source: string; language: string; html: string } | null>(null);
	useEffect(() => {
		if (!enabled || !language) return;
		let active = true;
		const cancel = requestHighlight(source, language, (response) => { if (active) setResult({ source, language, html: response.html }); });
		return () => { active = false; cancel(); };
	}, [enabled, source, language]);
	return result?.source === source && result.language === language ? result.html : '';
}
