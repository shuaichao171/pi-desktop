import { useEffect, useMemo, useState } from 'react';
import { READING_FIND_CHAR_LIMIT, requestReadingFind } from './diffWorkerPool.ts';
import { expandMatchRanges, literalMatches } from './workbenchReading.ts';

export type ReadingMatch = { start: number; end: number };

const none: ReadingMatch[] = [];

/**
 * Find-in-preview for the workbench text reader. Up to READING_FIND_CHAR_LIMIT
 * it is the old synchronous memo, so counts update with every keystroke. Past
 * it the regex scan runs in the diff worker and comes back as packed ranges;
 * while an answer is pending the previous query's matches for the same text
 * stay up (no flash to 0/0 while typing), and answers for an older text or
 * query are dropped instead of written back.
 */
export function useReadingFind(text: string, query: string): ReadingMatch[] {
	const heavy = Boolean(query) && text.length > READING_FIND_CHAR_LIMIT && typeof Worker !== 'undefined';
	const immediate = useMemo(() => (heavy ? none : literalMatches(text, query)), [heavy, text, query]);
	const [found, setFound] = useState<{ text: string; query: string; matches: ReadingMatch[] } | null>(null);
	useEffect(() => {
		if (!heavy) return;
		let current = true;
		const cancel = requestReadingFind({ type: 'reading-find', text, query }, (ranges) => {
			if (current) setFound({ text, query, matches: expandMatchRanges(ranges) });
		});
		return () => { current = false; cancel(); };
	}, [heavy, text, query]);
	if (!heavy) return immediate;
	return found?.text === text ? found.matches : none;
}
