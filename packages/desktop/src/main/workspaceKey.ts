import { resolve } from 'node:path';

/**
 * Canonical comparison key for a workspace path. The same directory reaches the
 * main process spelled in several ways — a trailing separator, a short path, a
 * differently cased drive letter — so registration, lookup and ownership
 * comparisons share this key instead of comparing raw path strings.
 */
export function workspaceKey(cwd: string): string {
	const key = resolve(cwd);
	return process.platform === 'win32' ? key.toLowerCase() : key;
}
