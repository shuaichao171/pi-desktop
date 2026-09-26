import { constants, existsSync, mkdirSync } from 'node:fs';
import { copyFile, rename, unlink, readFile, readdir, lstat, mkdir, link, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecoverableSessionMetadata, SessionTrashEntry, TrashCleanupRequest } from '../../../shared/src/dataFeatures';
import { writeStateFileAsync } from './stateFiles';

type TrashCapture = { cwd: string; sessionId?: string; name?: string; metadata?: RecoverableSessionMetadata };
type TrashRecord = Omit<SessionTrashEntry, 'bytes' | 'legacy' | 'expiresAt'> & { version: 1 };

/**
 * Session recycle bin (3.3): deleting a conversation moves its .jsonl file into
 * a trash directory under the app's userData instead of destroying it. Files
 * keep a timestamp prefix and can be restored by hand at any time.
 */
export function createSessionTrash(baseDirectory: () => string, operations = { rename, copyFile, unlink }) {
	let queue: Promise<void> = Promise.resolve();
	function enqueue<T>(action: () => Promise<T>): Promise<T> {
		const result = queue.then(action);
		queue = result.then(() => undefined, () => undefined);
		return result;
	}
	function entryPath(id: string): string {
		if (typeof id !== 'string' || id !== basename(id) || !id.endsWith('.jsonl') || /[\u0000-\u001f]/u.test(id)) throw new Error('回收项目编号无效');
		return join(baseDirectory(), id);
	}
	async function retention(): Promise<number> {
		try {
			const value: unknown = JSON.parse(await readFile(join(baseDirectory(), 'retention.json'), 'utf8'));
			return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3650 ? value : 0;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return 0; throw error; }
	}
	async function listEntries(): Promise<{ entries: SessionTrashEntry[]; retentionDays: number }> {
		const retentionDays = await retention();
		let names: string[];
		try { names = await readdir(baseDirectory()); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], retentionDays }; throw error; }
		const entries: SessionTrashEntry[] = [];
		for (const id of names.filter((name) => name.endsWith('.jsonl'))) {
			const path = entryPath(id);
			const details = await lstat(path).catch(() => null);
			if (!details?.isFile() || details.isSymbolicLink()) continue;
			let record: TrashRecord | undefined;
			try {
				const value = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as TrashRecord;
				if (value.version === 1 && value.id === id && typeof value.deletedAt === 'string' && Number.isFinite(Date.parse(value.deletedAt))
					&& typeof value.originalPath === 'string' && isAbsolute(value.originalPath)) record = value;
			} catch { /* Legacy/damaged sidecars never hide a recoverable body. */ }
			const deletedAt = record?.deletedAt ?? new Date(Number(id.match(/^(\d{10,})-/)?.[1]) || details.mtimeMs).toISOString();
			entries.push({ ...record, id, deletedAt, bytes: details.size, legacy: !record,
				...(retentionDays ? { expiresAt: new Date(Date.parse(deletedAt) + retentionDays * 86400000).toISOString() } : {}) });
		}
		return { entries: entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id)), retentionDays };
	}
	return {
		/** Moves one session file into the trash directory; returns its new path. */
		trashSession(sessionPath: string, capture?: TrashCapture): Promise<string> {
			return enqueue(async () => {
				if (typeof sessionPath !== 'string' || !sessionPath.trim()) throw new Error('会话路径无效');
				const resolved = resolve(sessionPath);
				if (!resolved.endsWith('.jsonl')) throw new Error('仅支持删除 .jsonl 会话文件');
				if (!existsSync(resolved)) throw new Error('会话文件不存在');
				const trashDir = baseDirectory();
				mkdirSync(trashDir, { recursive: true });
				const timestamp = Date.now();
				let target = join(trashDir, `${timestamp}-${basename(resolved)}`);
				for (let attempt = 1; existsSync(target); attempt += 1) {
					target = join(trashDir, `${timestamp}-${attempt}-${basename(resolved)}`);
				}
				if (!(await lstat(resolved)).isFile()) throw new Error('会话文件无效');
				const record: TrashRecord = { version: 1, id: basename(target), originalPath: resolved,
					deletedAt: new Date(timestamp).toISOString(), ...capture };
				await writeStateFileAsync(`${target}.meta.json`, record);
				try {
					try { await operations.rename(resolved, target); }
					catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
					// Native async copy keeps large transcripts off the main event loop.
					// Never remove the original until the entire copy has succeeded.
					await operations.copyFile(resolved, target, constants.COPYFILE_EXCL);
					await operations.unlink(resolved);
					}
				} catch (error) {
					// A successful cross-volume copy remains useful even if source unlink failed.
					if (!existsSync(target)) await rm(`${target}.meta.json`, { force: true });
					throw error;
				}
				return target;
			});
		},
		list: () => enqueue(listEntries),
		setRetention(days: number): Promise<void> {
			return enqueue(async () => {
				if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('保留天数须为 0–3650；0 表示永久保留');
				await writeStateFileAsync(join(baseDirectory(), 'retention.json'), days);
			});
		},
		restoreSession(id: string, destination: string, applyMetadata: (entry: SessionTrashEntry, path: string) => Promise<void> = async () => {}, replacementBody?: string): Promise<SessionTrashEntry> {
			return enqueue(async () => {
				const source = entryPath(id);
				const entry = (await listEntries()).entries.find((item) => item.id === id);
				if (!entry) throw new Error('回收项目不存在或已经恢复');
				if (!isAbsolute(destination) || !destination.endsWith('.jsonl')) throw new Error('恢复路径无效');
				await mkdir(dirname(destination), { recursive: true });
				const temporary = join(dirname(destination), `.restore-${randomUUID()}.tmp`);
				let committed = false;
				try {
					if (replacementBody === undefined) await operations.copyFile(source, temporary, constants.COPYFILE_EXCL);
					else await writeFile(temporary, replacementBody, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
					// link is an exclusive, atomic commit; rename would overwrite on POSIX.
					await link(temporary, destination);
					committed = true;
					await applyMetadata(entry, destination);
				} catch (error) {
					if (committed) await rm(destination, { force: true });
					if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('原路径已有文件；请选择其他工作区或先处理冲突，未覆盖现有会话');
					throw error;
				} finally { await rm(temporary, { force: true }); }
				await operations.unlink(source);
				await rm(`${source}.meta.json`, { force: true });
				return entry;
			});
		},
		cleanup(request: TrashCleanupRequest, isRunning: (entry: SessionTrashEntry) => Promise<boolean> = async () => false,
			releaseInputs: (entry: SessionTrashEntry) => Promise<void> = async () => {}): Promise<{ removed: string[]; skipped: string[] }> {
			return enqueue(async () => {
				if (!request || !Array.isArray(request.entries) || request.entries.length > 5000
					|| request.entries.some((item) => !item || typeof item.id !== 'string' || typeof item.deletedAt !== 'string')) throw new Error('清理确认列表无效');
				const entries = new Map((await listEntries()).entries.map((item) => [item.id, item]));
				const removed: string[] = [], skipped: string[] = [];
				for (const selected of request.entries) {
					const entry = entries.get(selected.id);
					if (!entry || entry.deletedAt !== selected.deletedAt || await isRunning(entry)) { skipped.push(selected.id); continue; }
					// Only explicitly confirmed, eligible records reach input release. If
					// that operation fails, the JSONL and metadata remain for a safe retry.
					await releaseInputs(entry);
					await operations.unlink(entryPath(entry.id));
					await rm(`${entryPath(entry.id)}.meta.json`, { force: true });
					entries.delete(entry.id);
					removed.push(entry.id);
				}
				return { removed, skipped };
			});
		},
	};
}
