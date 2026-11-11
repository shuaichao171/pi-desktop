import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const MAX_CANDIDATES = 16;

function pathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function within(path: string, root: string): boolean {
	const child = pathKey(path), parent = pathKey(root).replace(/[\\/]+$/, '');
	return child === parent || child.startsWith(parent + sep);
}

/**
 * A path mentioned in a conversation's first message, resolved to the folder that
 * could become a project: the first candidate naming an existing directory (a file
 * resolves to its folder). Drive / filesystem roots and folders inside the
 * temporary conversation storage are never offered.
 */
export async function resolveProjectCandidate(value: unknown, excludedRoots: readonly string[]): Promise<string | null> {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATES) return null;
	for (const candidate of value) {
		if (typeof candidate !== 'string' || !candidate || candidate.length > 4096 || candidate.includes('\0') || !isAbsolute(candidate)) continue;
		let directory: string;
		try {
			const canonical = await realpath(candidate);
			const info = await stat(canonical);
			directory = info.isDirectory() ? canonical : info.isFile() ? dirname(canonical) : '';
		} catch { continue; }
		if (!directory || dirname(directory) === directory) continue;
		if (excludedRoots.some((root) => root && within(directory, root))) continue;
		return directory;
	}
	return null;
}
