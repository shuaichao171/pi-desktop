import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CUA_PERMISSION_TITLE = '允许 AI 在本对话中使用电脑控制？';
export const CUA_PERMISSION_MESSAGE = 'AI 需要读取屏幕和剪贴板，并操作鼠标、键盘来完成当前任务。\n\n确认后，仅本对话获得授权，后续使用不再逐次询问；重新打开本对话也会保留授权。新对话需单独授权。\n\n你可以随时发送 /cua off 撤销授权；取消后不会执行本次操作，也不会在本对话反复询问。';

export interface CuaPermissionStorage {
	/** null means this conversation has not made a decision yet. */
	read(): boolean | null;
	write(allowed: boolean): void;
}

function readDecision(path: string): boolean | null {
	let raw: string;
	try { raw = readFileSync(path, 'utf8'); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
	let record: unknown;
	try { record = JSON.parse(raw); } catch { throw new Error('电脑控制授权记录损坏'); }
	if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 1 || !('allowed' in record) || typeof record.allowed !== 'boolean') {
		throw new Error('电脑控制授权记录无效');
	}
	return record.allowed;
}

function writeDecision(root: string, path: string, allowed: boolean): void {
	mkdirSync(root, { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temporary, 'wx', 0o600);
		try { writeFileSync(fd, JSON.stringify({ version: 1, allowed })); fsyncSync(fd); }
		finally { closeSync(fd); }
		renameSync(temporary, path);
	} finally { rmSync(temporary, { force: true }); }
}

/** Local consent is separate from conversation content, so forks/imports cannot carry it. */
export class CuaPermissionStore implements CuaPermissionStorage {
	private readonly path: string;
	private readonly root: string;
	constructor(root: string, scope: { cwd: string; sessionId: string; sessionFile?: string }) {
		this.root = root;
		const key = createHash('sha256').update(JSON.stringify([
			resolve(scope.cwd), scope.sessionId, scope.sessionFile ? resolve(scope.sessionFile) : null,
		])).digest('hex');
		this.path = join(root, `${key}.json`);
	}

	read(): boolean | null {
		return readDecision(this.path);
	}

	write(allowed: boolean): void {
		writeDecision(this.root, this.path, allowed);
	}
}

export interface CuaScopeStorage {
	isAllowed(key: string): boolean;
	allow(key: string): void;
	clear(): void;
}

/** Scope keys never come from conversation text. Each file is independently atomic. */
export class CuaScopeStore implements CuaScopeStorage {
	private readonly root: string;
	constructor(root: string) {
		this.root = root;
	}

	private path(key: string): string {
		return join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`);
	}

	isAllowed(key: string): boolean { return readDecision(this.path(key)) === true; }
	allow(key: string): void { writeDecision(this.root, this.path(key), true); }
	clear(): void {
		let files: string[];
		try { files = readdirSync(this.root); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
		for (const file of files) if (/^[a-f0-9]{64}\.json$/.test(file)) rmSync(join(this.root, file), { force: true });
	}
}
