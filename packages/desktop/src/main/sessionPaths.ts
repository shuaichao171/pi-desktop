import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export function normalizeSessionPath(value: unknown): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value) || !isAbsolute(value)) {
		throw new Error('会话路径无效');
	}
	return resolve(value);
}

/** An incomplete list or an inaccessible directory is never proof of deletion. */
export async function pruneMissingSessionMeta<T>(meta: Record<string, T>, livePaths: ReadonlySet<string>, inspect = stat): Promise<boolean> {
	let changed = false;
	const paths = Object.keys(meta).filter((path) => !livePaths.has(path));
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => {
		while (next < paths.length) {
			const path = paths[next++]!;
			try { await inspect(path); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
				try {
					if (!(await inspect(dirname(path))).isDirectory()) continue;
				} catch { continue; }
				delete meta[path];
				changed = true;
			}
		}
	}));
	return changed;
}
