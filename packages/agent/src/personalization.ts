import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { UiInstructionDocument, UiSaveInstructionRequest, UiSaveInstructionResult } from '@pidesktop/shared';

const MAX_BYTES = 128 * 1024;
const PI_FILENAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD'];
type InstructionId = UiInstructionDocument['id'];
type LoadedDocument = { document: UiInstructionDocument; mode?: number; bom?: boolean; crlf?: boolean; parent?: string };

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Windows can report ENOENT rather than ENOTDIR for a file used as a parent. */
async function verifyMissingParent(path: string): Promise<void> {
	let parent = dirname(path);
	for (;;) {
		try {
			if (!(await stat(parent)).isDirectory()) throw new Error('指令目录不是文件夹');
			return;
		} catch (error) {
			if (!absent(error)) throw error;
			const next = dirname(parent);
			if (next === parent) throw error;
			parent = next;
		}
	}
}

function validateRequest(request: UiSaveInstructionRequest): UiSaveInstructionRequest {
	if (!request || typeof request !== 'object' || Array.isArray(request) ||
		Object.keys(request).some((key) => !['id', 'content', 'revision'].includes(key)) ||
		(request.id !== 'user' && request.id !== 'pi') || typeof request.content !== 'string' ||
		(request.revision !== null && (typeof request.revision !== 'string' || request.revision.length > 256))) throw new Error('指令保存参数无效');
	if (Buffer.byteLength(request.content, 'utf8') > MAX_BYTES) throw new Error('指令文件不能超过 128 KiB');
	return { id: request.id, content: request.content, revision: request.revision };
}

/** Read and edit only the two instruction locations configured by the desktop host. */
export function createPersonalizationService(options: { userDirectory: string; agentDirectory: string }): {
	list(): Promise<UiInstructionDocument[]>;
	save(request: UiSaveInstructionRequest): Promise<UiSaveInstructionResult>;
} {
	const userPath = join(resolve(options.userDirectory), 'AGENTS.md');
	const agentDirectory = resolve(options.agentDirectory);
	let lastPiPath = join(agentDirectory, 'AGENTS.md');
	let saves: Promise<unknown> = Promise.resolve();

	async function selectPiPath(): Promise<string | null> {
		let nonFile: string | null = null;
		for (const filename of PI_FILENAMES) {
			const path = join(agentDirectory, filename);
			try {
				const info = await lstat(path);
				// A symbolic link must remain visible as an error, never silently
				// redirect an editor to a lower-priority file or an external target.
				if (info.isFile() || info.isSymbolicLink()) return path;
				nonFile ??= path;
			} catch (error) {
				if (!absent(error)) return path;
				try { await verifyMissingParent(path); } catch { return path; }
			}
		}
		return nonFile;
	}

	async function readDocument(id: InstructionId, path: string): Promise<LoadedDocument> {
		const document: UiInstructionDocument = { id, path, exists: true, content: '', revision: null };
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink()) throw new Error('指令文件是符号链接，无法在此编辑；请改为普通文件');
			if (!info.isFile()) throw new Error('指令路径不是普通文件');
			if (info.size > MAX_BYTES) throw new Error('指令文件超过 128 KiB，无法在此编辑');
			const parent = await realpath(dirname(path));
			file = await open(path, 'r');
			const opened = await file.stat();
			const current = await lstat(path);
			if (current.isSymbolicLink()) throw new Error('指令文件是符号链接，无法在此编辑；请改为普通文件');
			if (!opened.isFile() || !current.isFile() || opened.ino !== current.ino || opened.dev !== current.dev || parent !== await realpath(dirname(path))) throw new Error('指令文件在读取时发生变化，请刷新后重试');
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > MAX_BYTES) throw new Error('指令文件超过 128 KiB，无法在此编辑');
			const after = await file.stat();
			if (after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('指令文件在读取时发生变化，请刷新后重试');
			const bytes = buffer.subarray(0, length);
			try { document.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
			catch { throw new Error('指令文件不是有效的 UTF-8 文本'); }
			document.revision = createHash('sha256').update(path).update('\0').update(parent).update('\0').update(bytes).digest('hex');
			return { document, parent, mode: opened.mode & 0o777,
				bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
				crlf: document.content.includes('\r\n') && !/(^|[^\r])\n/.test(document.content) };
		} catch (error) {
			if (absent(error)) {
				try { await verifyMissingParent(path); return { document: { ...document, exists: false } }; }
				catch (parentError) { return { document: { ...document, content: '', revision: null, error: message(parentError) } }; }
			}
			return { document: { ...document, content: '', revision: null, error: message(error) } };
		} finally { await file?.close().catch(() => {}); }
	}

	async function currentDocument(id: InstructionId): Promise<LoadedDocument> {
		if (id === 'user') return readDocument('user', userPath);
		const selected = await selectPiPath();
		if (selected) {
			lastPiPath = selected;
			return readDocument('pi', selected);
		}
		return { document: { id: 'pi', path: lastPiPath, exists: false, content: '', revision: null, error: 'Pi 指令文件已不存在，请刷新后重试' } };
	}

	async function saveOnce(request: UiSaveInstructionRequest): Promise<UiSaveInstructionResult> {
		const loaded = await currentDocument(request.id);
		const current = loaded.document;
		if ((request.id === 'pi' && !current.exists) || current.revision !== request.revision) return { status: 'conflict', document: current };
		if (current.error) throw new Error(current.error);
		let text = request.content;
		const withBom = loaded.bom || text.startsWith('\ufeff');
		if (text.startsWith('\ufeff')) text = text.slice(1);
		if (loaded.crlf) text = text.replace(/\r?\n/g, '\r\n');
		const bytes = Buffer.from(`${withBom ? '\ufeff' : ''}${text}`, 'utf8');
		if (bytes.length > MAX_BYTES) throw new Error('指令文件不能超过 128 KiB');
		if (request.id === 'user' && !current.exists) await mkdir(dirname(current.path), { recursive: true });
		const parent = await realpath(dirname(current.path));
		const temporary = join(parent, `.${basename(current.path)}.pi-${randomUUID()}.tmp`);
		let temporaryExists = false;
		try {
			const file = await open(temporary, 'wx', loaded.mode ?? 0o600);
			temporaryExists = true;
			try {
				await file.writeFile(bytes);
				if (loaded.mode !== undefined) await file.chmod(loaded.mode);
				await file.sync();
			} finally { await file.close(); }
			// Resolve priority and revision again after writing the temporary file,
			// so external edits or a new override never get replaced by stale text.
			const latest = await currentDocument(request.id);
			if (latest.document.error || latest.document.path !== current.path || latest.document.exists !== current.exists ||
				latest.document.revision !== current.revision || parent !== await realpath(dirname(current.path))) {
				return { status: 'conflict', document: latest.document };
			}
			if (latest.mode !== undefined && latest.mode !== loaded.mode) await chmod(temporary, latest.mode);
			await rename(temporary, current.path);
			temporaryExists = false;
			return { status: 'saved', document: (await readDocument(request.id, current.path)).document };
		} finally {
			if (temporaryExists) await unlink(temporary).catch(() => {});
		}
	}

	return {
		async list() {
			const [user, selected] = await Promise.all([readDocument('user', userPath), selectPiPath()]);
			if (!selected) return [user.document];
			lastPiPath = selected;
			const pi = await readDocument('pi', selected);
			return [user.document, pi.document];
		},
		async save(request) {
			const input = validateRequest(request);
			const pending = saves.then(() => saveOnce(input));
			saves = pending.catch(() => {});
			return pending;
		},
	};
}
