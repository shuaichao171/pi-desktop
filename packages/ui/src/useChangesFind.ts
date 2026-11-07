import { useEffect, useMemo, useState } from 'react';
import type { UiFileChange, UiFileDiff } from '@pidesktop/shared';
import { findChangeMatches, type ChangeFindResult } from './changesFind.ts';
import { CHANGES_FIND_CHAR_LIMIT, requestChangesFind } from './diffWorkerPool.ts';

function totalDiffChars(changes: readonly UiFileChange[], diffs: ReadonlyMap<string, UiFileDiff>): number {
	let total = 0;
	for (const change of changes) total += diffs.get(change.path)?.diff?.length ?? 0;
	return total;
}

/**
 * Changes-scope find for the transcript find bar. Below CHANGES_FIND_CHAR_LIMIT
 * it stays the old synchronous memo, so counts update while typing. Above it
 * the scan runs in the diff worker; while that answer is pending the path-only
 * result shows — the same interim state the bar already had while lazy diffs
 * were loading — and answers computed for an older query/change set/diff map
 * are dropped instead of written back.
 */
export function useChangesFind(active: boolean, changes: readonly UiFileChange[], query: string, diffs: ReadonlyMap<string, UiFileDiff> | null): ChangeFindResult | null {
	const trimmed = query.trim();
	const heavy = active && Boolean(trimmed) && diffs !== null && typeof Worker !== 'undefined' && totalDiffChars(changes, diffs) > CHANGES_FIND_CHAR_LIMIT;
	const immediate = useMemo(
		() => (active ? findChangeMatches(changes, query, heavy ? null : diffs) : null),
		[active, changes, query, heavy, diffs],
	);
	const [full, setFull] = useState<{ changes: readonly UiFileChange[]; query: string; diffs: ReadonlyMap<string, UiFileDiff> | null; result: ChangeFindResult } | null>(null);
	useEffect(() => {
		if (!heavy) return;
		let current = true;
		const request = {
			type: 'changes-find' as const,
			paths: changes.map((change) => change.path),
			query: trimmed,
			diffTexts: changes.flatMap((change): Array<[path: string, diff: string]> => {
				const diff = diffs?.get(change.path)?.diff;
				return diff ? [[change.path, diff]] : [];
			}),
		};
		const cancel = requestChangesFind(request, (result) => { if (current) setFull({ changes, query: trimmed, diffs, result }); });
		return () => { current = false; cancel(); };
	}, [heavy, changes, trimmed, diffs]);
	return heavy && full?.changes === changes && full.query === trimmed && full.diffs === diffs ? full.result : immediate;
}
