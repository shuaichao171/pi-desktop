import { useCallback, useEffect, useState } from 'react';
import { readShortcutOverrides, writeShortcutOverrides, SHORTCUT_BINDINGS } from './bindings';
import { findShortcutConflicts } from './conflicts';

/**
 * React accessor for user shortcut overrides (4.3): reads localStorage once,
 * keeps other tabs in sync via storage events, and persists updates so
 * rebound keys apply immediately across every handler.
 */
export function useShortcutBindings() {
	const [overrides, setOverrides] = useState<Record<string, string>>(readShortcutOverrides);

	useEffect(() => {
		const onStorage = (event: StorageEvent): void => {
			if (event.key === null || event.key === 'pi-desktop.shortcuts.v1') setOverrides(readShortcutOverrides());
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, []);

	const setOverride = useCallback((id: string, keys: string | null) => {
		setOverrides((current) => {
			const next = { ...current };
			if (keys === null) delete next[id];
			else next[id] = keys;
			writeShortcutOverrides(next);
			return next;
		});
	}, []);

	const resetAll = useCallback(() => {
		setOverrides({});
		writeShortcutOverrides({});
	}, []);

	return {
		overrides,
		setOverride,
		resetAll,
		conflicts: findShortcutConflicts(overrides),
		bindings: SHORTCUT_BINDINGS,
	};
}
