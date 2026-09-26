import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Session recycle bin (3.3): deleting a conversation moves its .jsonl file into
 * a trash directory under the app's userData instead of destroying it. Files
 * keep a timestamp prefix and can be restored by hand at any time.
 */
export function createSessionTrash(baseDirectory: () => string) {
	return {
		/** Moves one session file into the trash directory; returns its new path. */
		trashSession(sessionPath: string): string {
			if (typeof sessionPath !== 'string' || !sessionPath.trim()) throw new Error('会话路径无效');
			const resolved = resolve(sessionPath);
			if (!resolved.endsWith('.jsonl')) throw new Error('仅支持删除 .jsonl 会话文件');
			if (!existsSync(resolved)) throw new Error('会话文件不存在');
			const trashDir = baseDirectory();
			mkdirSync(trashDir, { recursive: true });
			let target = join(trashDir, `${Date.now()}-${basename(resolved)}`);
			for (let attempt = 1; existsSync(target); attempt += 1) {
				target = join(trashDir, `${Date.now()}-${attempt}-${basename(resolved)}`);
			}
			renameSync(resolved, target);
			return target;
		},
	};
}
