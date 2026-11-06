import { realpathSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { UiAppearanceState } from '@pidesktop/shared';
import { readStateFile, readStateFileAsync, writeStateFile, writeStateFileAsync } from './stateFiles';

/**
* Appearance lives in the base user data directory so pai chat windows, which
* run in separate processes with their own Chromium profiles, follow the same
* colors and theme preference as the main desktop window.
*/
export function appearanceStatePath(baseUserData: string): string {
	return join(baseUserData, 'appearance.json');
}

export function isValidAppearanceState(value: unknown): value is UiAppearanceState {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<UiAppearanceState>;
	return (candidate.theme === 'system' || candidate.theme === 'dark' || candidate.theme === 'light')
		&& typeof candidate.colors === 'object' && candidate.colors !== null
		&& typeof candidate.colors.light === 'object' && candidate.colors.light !== null
		&& typeof candidate.colors.dark === 'object' && candidate.colors.dark !== null;
}

/** Missing means nothing shared yet; a corrupt file falls back to local defaults. */
export function readAppearanceState(path: string): UiAppearanceState | null {
	try {
		return readStateFile(path, () => null, isValidAppearanceState);
	} catch {
		// A damaged appearance file is cosmetic: keep local preferences instead of
		// blocking startup or erasing the unreadable bytes until the next save.
		return null;
	}
}

/** Async twin of readAppearanceState for the cold-start prefetch (same fallbacks). */
export async function readAppearanceStateAsync(path: string): Promise<UiAppearanceState | null> {
	try {
		return await readStateFileAsync(path, () => null, isValidAppearanceState);
	} catch {
		return null;
	}
}

export function writeAppearanceState(path: string, state: UiAppearanceState): void {
	writeStateFile(path, state);
}

/** Runtime saves from IPC handlers go through the async writer to keep the main thread free. */
export function writeAppearanceStateAsync(path: string, state: UiAppearanceState): Promise<void> {
	return writeStateFileAsync(path, state);
}

/**
* Follow appearance changes saved by another process (for example the main
* desktop window while a pai window is open). The directory is watched because
* atomic writes replace the file; echoes of our own last observed content are
* ignored.
*/
export function watchAppearanceState(path: string, onExternalChange: (state: UiAppearanceState | null) => void): () => void {
	let last = JSON.stringify(readAppearanceState(path));
	let watcher: FSWatcher;
	// Windows: 8.3 short paths (for example a TEMP dir like C:\Users\RUNNE~1)
	// must be expanded to the real name, or libuv's change events carry a long
	// path that fails its own directory prefix assertion and aborts the process.
	let watchedDirectory = dirname(path);
	try { watchedDirectory = realpathSync.native(watchedDirectory); } catch { /* Watch the given form when native resolution is unavailable. */ }
	try {
		watcher = watch(watchedDirectory, { persistent: false }, (_event, filename) => {
			if (typeof filename === 'string' && basename(path) !== filename) return;
			const next = JSON.stringify(readAppearanceState(path));
			if (next === last) return;
			last = next;
			onExternalChange(readAppearanceState(path));
		});
	} catch {
		return () => {};
	}
	watcher.on('error', () => { /* Reading on the next change reports the loss. */ });
	return () => watcher.close();
}
