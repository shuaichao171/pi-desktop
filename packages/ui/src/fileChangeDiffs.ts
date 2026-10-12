import { useEffect, useState } from 'react';
import type { UiFileDiff, UiFileDiffScope } from '@pidesktop/shared';
import { useChatStore } from './store';

export type FileDiffMap = Map<string, UiFileDiff>;

/**
 * Lazily loads one scope's diffs from the agent (turn or whole conversation).
 * Diffs are computed on demand and never travel with change events; the
 * fileChanges array identity changes on every update, which invalidates the
 * cache and refetches while the scope stays open (live edits stay fresh).
 */
export function useFileChangeDiffs(scope: UiFileDiffScope | null): FileDiffMap | null {
	const bridge = useChatStore((s) => s.bridge);
	const changes = useChatStore((s) => s.fileChanges);
	const [diffs, setDiffs] = useState<FileDiffMap | null>(null);
	const kind = scope?.kind;
	const runId = scope?.kind === 'turn' ? scope.runId : undefined;
	useEffect(() => {
		if (!scope || !bridge) return;
		let cancelled = false;
		setDiffs(null);
		bridge.getFileChangeDiffs(scope)
			.then((list) => { if (!cancelled) setDiffs(new Map(list.map((item) => [item.path, item]))); })
			.catch(() => { if (!cancelled) setDiffs(new Map()); });
		return () => { cancelled = true; };
		// The scope object is rebuilt per render; depend on its identity fields only.
	}, [kind, runId, bridge, changes]);
	return scope ? diffs : null;
}
