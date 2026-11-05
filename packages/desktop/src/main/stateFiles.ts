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
		renameSyncWithRetry(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * Async writes to the same destination are serialized in call order, so overlapping
 * saves replace each other instead of racing their final renames.
 */
const stateFileWriteQueues = new Map<string, Promise<void>>();

export async function writeStateFileAsync(path: string, value: unknown): Promise<void> {
	const contents = JSON.stringify(value);
	if (contents === undefined) throw new Error(`无法序列化状态文件：${path}`);
	const previous = stateFileWriteQueues.get(path) ?? Promise.resolve();
	const write = previous.then(async () => {
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
			await renameWithRetry(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	});
	const tail = write.then(() => undefined, () => undefined);
	stateFileWriteQueues.set(path, tail);
	// Drop the queue entry once idle so settled promises do not accumulate.
	void tail.then(() => {
		if (stateFileWriteQueues.get(path) === tail) stateFileWriteQueues.delete(path);
	});
	return write;
}

/**
 * Windows can transiently deny a rename that replaces the destination while another
 * writer or a scanner holds it (EPERM/EACCES); a short bounded retry keeps concurrent
 * saves from failing spuriously without hiding real, persistent errors.
 */
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 10;

function isTransientRenameError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES');
}

const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));

function renameSyncWithRetry(from: string, to: string): void {
	for (let attempt = 0; ; attempt += 1) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_RETRIES || !isTransientRenameError(error)) throw error;
			Atomics.wait(syncSleepCell, 0, 0, RENAME_RETRY_DELAY_MS);
		}
	}
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_RETRIES || !isTransientRenameError(error)) throw error;
			await new Promise((resolve) => { setTimeout(resolve, RENAME_RETRY_DELAY_MS); });
		}
	}
}
