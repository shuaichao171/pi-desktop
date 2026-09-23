import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export class CorruptStateFileError extends Error {}

/** Preserve the exact unreadable bytes before an application writes new defaults. */
export function backupCorruptStateFile(path: string): string {
	const backup = `${path}.corrupt-${Date.now()}-${randomUUID()}.bak`;
	renameSync(path, backup);
	return backup;
}

export async function backupCorruptStateFileAsync(path: string): Promise<string> {
	const backup = `${path}.corrupt-${Date.now()}-${randomUUID()}.bak`;
	await rename(path, backup);
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

export async function readStateFileAsync<T>(path: string, empty: () => T, isValid: (value: unknown) => value is T): Promise<T> {
	let contents: string;
	try {
		contents = await readFile(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			try { await lstat(path); }
			catch (statError) {
				if (statError instanceof Error && 'code' in statError && statError.code === 'ENOENT') return empty();
			}
		}
		throw error;
	}
	let value: unknown;
	try { value = JSON.parse(contents); }
	catch (error) { throw new CorruptStateFileError(`状态文件损坏：${path}`, { cause: error }); }
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

export async function writeStateFileAsync(path: string, value: unknown): Promise<void> {
	const contents = JSON.stringify(value);
	if (contents === undefined) throw new Error(`无法序列化状态文件：${path}`);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, 'wx', 0o600);
		try {
			await file.writeFile(contents, 'utf8');
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
