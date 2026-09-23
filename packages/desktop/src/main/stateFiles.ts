import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export class CorruptStateFileError extends Error {}

/** Preserve the exact unreadable bytes before an application writes new defaults. */
export function backupCorruptStateFile(path: string): string {
	const backup = `${path}.corrupt-${Date.now()}-${randomUUID()}.bak`;
	renameSync(path, backup);
	return backup;
}

/** A missing file means first launch; a malformed or unreadable file must be preserved. */
export function readStateFile<T>(path: string, empty: () => T, isValid: (value: unknown) => value is T): T {
	let contents: string;
	try {
		contents = readFileSync(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			try { lstatSync(path); }
			catch (statError) {
				if (statError instanceof Error && 'code' in statError && statError.code === 'ENOENT') return empty();
			}
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new CorruptStateFileError(`状态文件损坏：${path}`, { cause: error });
	}
	if (isValid(value)) return value;
	throw new CorruptStateFileError(`状态文件损坏：${path}`);
}

/** Write beside the destination, flush the contents, then replace it in one rename. */
export function writeStateFile(path: string, value: unknown): void {
	const contents = JSON.stringify(value);
	if (contents === undefined) throw new Error(`无法序列化状态文件：${path}`);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temporary, 'wx', 0o600);
		try {
			writeFileSync(fd, contents, 'utf8');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
