import { useEffect, useMemo, useState } from 'react';
import { DIFF_PARSE_CHAR_LIMIT, requestDiffParse } from './diffWorkerPool.ts';
import { parsePiEditDiff, parseUnifiedDiff, type DiffLine, type EditDiffLine } from './unifiedDiff.ts';

/**
 * Diff rows for the changes dialog and edit tool cards. Small diffs parse
 * synchronously (no loading flash); above DIFF_PARSE_CHAR_LIMIT the parse runs
 * in the diff worker and this returns null until the answer arrives — callers
 * keep their loading state then. Answers for an older text are dropped by the
 * identity check, and worker failures answer on the main thread, so callers
 * only ever see their own diff's rows.
 */
export function useDiffParse(kind: 'unified', text: string): DiffLine[] | null;
export function useDiffParse(kind: 'pi-edit', text: string): EditDiffLine[] | null;
export function useDiffParse(kind: 'unified' | 'pi-edit', text: string): DiffLine[] | EditDiffLine[] | null {
	// Without workers (tests, SSR) the fallback parses inline, as before.
	const immediate = useMemo(
		() => typeof Worker === 'undefined' || text.length <= DIFF_PARSE_CHAR_LIMIT
			? (kind === 'unified' ? parseUnifiedDiff(text) : parsePiEditDiff(text))
			: null,
		[kind, text],
	);
	const [deferred, setDeferred] = useState<{ kind: string; text: string; lines: DiffLine[] | EditDiffLine[] } | null>(null);
	useEffect(() => {
		if (immediate) return;
		let active = true;
		const cancel = requestDiffParse({ type: kind, text }, (response) => {
			if (active && response.type === kind) setDeferred({ kind, text, lines: response.lines });
		});
		return () => { active = false; cancel(); };
	}, [kind, text, immediate]);
	return immediate ?? (deferred?.kind === kind && deferred.text === text ? deferred.lines : null);
}
