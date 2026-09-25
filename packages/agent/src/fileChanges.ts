import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionFactory, SessionManager } from '@earendil-works/pi-coding-agent';
import type { UiFileChange } from '@pidesktop/shared';

const execFileAsync = promisify(execFile);
const ENTRY_TYPE = 'pi-desktop:file-changes-v1';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_CHARS = 96 * 1024;
const MAX_SCAN_FILES = 3000;
const MAX_SCAN_TEXT = 4 * 1024 * 1024;
const MAX_SAVED_FILES = 1000;
const MAX_SAVED_TEXT = 2 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.pnpm', 'out', 'dist', 'release', '.cache', '.next', 'coverage', '__pycache__']);

type FileState = { exists: boolean; fingerprint: string; text: string | null; preview?: UiFileChange['preview'] };
type SavedFile = { path: string; before: FileState; after: FileState };
type ToolBaseline = { sessionId: string; broad: boolean; complete: boolean; candidates: Set<string>; files: Map<string, FileState> };
const missing = (): FileState => ({ exists: false, fingerprint: 'missing', text: '' });

/** Paths are display-only and must never cause reads outside the workspace. */
function relativeFilePath(cwd: string, input: unknown): string | null {
	if (typeof input !== 'string' || !input || /[\u0000-\u001f\u007f]/.test(input)) return null;
	const path = relative(cwd, resolve(cwd, input));
	if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) || path.split(sep).includes('.git')) return null;
	return path.split(sep).join('/');
}

function validState(value: unknown): value is FileState {
	if (!value || typeof value !== 'object') return false;
	const state = value as FileState;
	return typeof state.exists === 'boolean' && typeof state.fingerprint === 'string' && state.fingerprint.length <= 200 &&
		(state.text === null || (typeof state.text === 'string' && state.text.length <= MAX_FILE_BYTES)) &&
		(state.preview === undefined || ['binary', 'too-large', 'unavailable'].includes(state.preview));
}

/** One tracker belongs to one SDK session manager and is recreated with its runtime. */
export class SessionFileChanges {
	private readonly cwd: string;
	private readonly manager: SessionManager;
	private readonly changed: (items: UiFileChange[]) => void;
	private readonly files = new Map<string, SavedFile>();
	private readonly pending = new Map<string, ToolBaseline>();
	private workspaceReal: string | null = null;
	private savedText = 0;
	private previews = new Map<string, UiFileChange>();

	constructor(cwd: string, manager: SessionManager, changed: (items: UiFileChange[]) => void) {
		this.cwd = cwd;
		this.manager = manager;
		this.changed = changed;
		this.restore();
	}

	readonly extension: ExtensionFactory = (pi) => {
		// Inline extensions follow user extensions. The awaited tool_call hook
		// sees validated arguments after their mutations, before actual execution.
		pi.on('tool_call', async (event) => { await this.beforeTool(event.toolCallId, event.toolName, event.input); });
		pi.on('tool_execution_end', async (event) => { await this.afterTool(event.toolCallId); });
	};

	restore(): UiFileChange[] {
		this.pending.clear();
		this.files.clear();
		this.previews.clear();
		this.savedText = 0;
		for (const entry of this.manager.getBranch()) {
			if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE || !entry.data || typeof entry.data !== 'object') continue;
			const data = entry.data as { files?: unknown };
			if (!Array.isArray(data.files) || data.files.length > MAX_SAVED_FILES) continue;
			for (const value of data.files) {
				if (!value || typeof value !== 'object') continue;
				const record = value as SavedFile;
				const path = relativeFilePath(this.cwd, record.path);
				if (!path || path !== record.path || !validState(record.before) || !validState(record.after)) continue;
				if (!this.files.has(path) && this.files.size >= MAX_SAVED_FILES) continue;
				this.saveRecord({ path, before: { ...record.before }, after: { ...record.after } });
			}
		}
		for (const record of this.files.values()) this.updatePreview(record);
		return this.snapshot();
	}

	snapshot(): UiFileChange[] {
		return [...this.previews.values()].map((item) => ({ ...item })).sort((a, b) => a.path.localeCompare(b.path));
	}

	async beforeTool(id: string, tool: string, args: unknown): Promise<void> {
		const sessionId = this.manager.getSessionId();
		try {
			if (this.pending.size >= 16) return;
			const broad = tool === 'bash' || tool === 'powershell';
			if (!broad && tool !== 'edit' && tool !== 'write') return;
			const path = !broad && args && typeof args === 'object' ? relativeFilePath(this.cwd, (args as { path?: unknown }).path) : null;
			if (!broad && !path) return;
			const listing = broad ? await this.listFiles() : { paths: [path!], complete: true };
			const files = await this.capture(listing.paths);
			if (sessionId !== this.manager.getSessionId()) return;
			this.pending.set(id, { sessionId, broad, complete: listing.complete, candidates: new Set(listing.paths), files });
		} catch { /* Change previews must never prevent a tool from running. */ }
	}

	async afterTool(id: string): Promise<void> {
		const baseline = this.pending.get(id);
		this.pending.delete(id);
		if (!baseline || baseline.sessionId !== this.manager.getSessionId()) return;
		try {
			const paths = baseline.broad ? [...new Set([...baseline.files.keys(), ...(await this.listFiles()).paths])] : [...baseline.files.keys()];
			const after = await this.capture(paths);
			if (baseline.sessionId !== this.manager.getSessionId()) return;
			const updates: SavedFile[] = [];
			for (const path of paths) {
				if (!baseline.files.has(path) && baseline.candidates.has(path)) continue;
				if (!baseline.files.has(path) && !baseline.complete) continue;
				const before = baseline.files.get(path) ?? missing();
				const current = after.get(path);
				// An inaccessible/symlink replacement does not authorize reading its target.
				if (!current || before.fingerprint === current.fingerprint) continue;
				const previous = this.files.get(path);
				if (!previous && this.files.size >= MAX_SAVED_FILES) continue;
				// Preserve the first baseline across contiguous tool edits. If another
				// actor changed the file between tools, rebase before attributing new edits.
				const initial = previous?.after.fingerprint === before.fingerprint ? previous.before : before;
				const record = this.saveRecord({ path, before: { ...initial }, after: current });
				this.updatePreview(record);
				updates.push(record);
			}
			if (!updates.length) return;
			this.manager.appendCustomEntry(ENTRY_TYPE, { files: updates });
			this.changed(this.snapshot());
		} catch { /* A failed preview must not replace the actual tool result. */ }
	}

	private updatePreview(record: SavedFile): void {
		if (record.before.fingerprint === record.after.fingerprint) this.previews.delete(record.path);
		else this.previews.set(record.path, toUiChange(record));
	}

	private saveRecord(record: SavedFile): SavedFile {
		const previous = this.files.get(record.path);
		this.savedText -= (previous?.before.text?.length ?? 0) + (previous?.after.text?.length ?? 0);
		for (const state of [record.before, record.after]) {
			if (state.text && this.savedText + state.text.length > MAX_SAVED_TEXT) { state.text = null; state.preview = 'too-large'; }
			this.savedText += state.text?.length ?? 0;
		}
		this.files.set(record.path, record);
		return record;
	}

	private async capture(paths: string[]): Promise<Map<string, FileState>> {
		const result = new Map<string, FileState>();
		let textBytes = 0;
		let cursor = 0;
		const budget = { bytes: 0 };
		const selected = paths.slice(0, MAX_SCAN_FILES);
		await Promise.all(Array.from({ length: 8 }, async () => {
			while (cursor < selected.length) {
				const path = selected[cursor++]!;
				const state = await this.readFile(path, textBytes < MAX_SCAN_TEXT, budget);
				if (!state) continue;
				textBytes += state.text?.length ?? 0;
				result.set(path, state);
			}
		}));
		return result;
	}

	private async readFile(path: string, includeText: boolean, budget: { bytes: number }): Promise<FileState | null> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			this.workspaceReal ??= await realpath(this.cwd);
			const absolute = resolve(this.cwd, path);
			let current = this.cwd;
			for (const part of path.split('/')) {
				current = resolve(current, part);
				try { if ((await lstat(current)).isSymbolicLink()) return null; }
				catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing(); throw error; }
			}
			const target = await realpath(absolute);
			const rel = relative(this.workspaceReal, target);
			if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
			handle = await open(absolute, 'r');
			const info = await handle.stat();
			if (!info.isFile()) return null;
			const openedTarget = await realpath(absolute);
			const openedRel = relative(this.workspaceReal, openedTarget);
			const currentInfo = await lstat(absolute);
			if (isAbsolute(openedRel) || openedRel === '..' || openedRel.startsWith(`..${sep}`) || currentInfo.isSymbolicLink() || currentInfo.ino !== info.ino || currentInfo.dev !== info.dev) return null;
			if (info.size > MAX_HASH_BYTES || budget.bytes + info.size > MAX_SCAN_BYTES) return null;
			budget.bytes += info.size;
			if (info.size > MAX_FILE_BYTES) {
				const hash = createHash('sha256');
				const chunk = Buffer.alloc(64 * 1024);
				let offset = 0;
				while (offset < info.size) {
					const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset);
					if (!bytesRead) break;
					hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
				}
				if (offset !== info.size || (await handle.stat()).size !== info.size) return null;
				return { exists: true, fingerprint: hash.digest('hex'), text: null, preview: 'too-large' };
			}
			const buffer = Buffer.alloc(info.size + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if ((await handle.stat()).size !== bytesRead) return null;
			const bytes = buffer.subarray(0, bytesRead);
			const fingerprint = createHash('sha256').update(bytes).digest('hex');
			if (bytesRead > MAX_FILE_BYTES || bytesRead > info.size) return { exists: true, fingerprint, text: null, preview: 'too-large' };
			if (bytes.includes(0)) return { exists: true, fingerprint, text: null, preview: 'binary' };
			try {
				const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
				return { exists: true, fingerprint, text: includeText ? text : null, ...(includeText ? {} : { preview: 'too-large' as const }) };
			} catch { return { exists: true, fingerprint, text: null, preview: 'binary' }; }
		} catch { return null; }
		finally { await handle?.close().catch(() => {}); }
	}

	private async listFiles(): Promise<{ paths: string[]; complete: boolean }> {
		try {
			const { stdout } = await execFileAsync('git', ['-C', this.cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { windowsHide: true, timeout: 2000, maxBuffer: 1024 * 1024 });
			return { paths: [...new Set(stdout.split('\0').map((path) => relativeFilePath(this.cwd, path)).filter((path): path is string => Boolean(path)))].sort(), complete: true };
		} catch {
			const paths: string[] = [];
			const directories = [''];
			let visited = 0;
			while (directories.length && visited++ < 1000 && paths.length < MAX_SCAN_FILES) {
				const directory = directories.shift()!;
				const entries = await readdir(resolve(this.cwd, directory), { withFileTypes: true }).catch(() => []);
				for (const entry of entries) {
					if (entry.isSymbolicLink()) continue;
					const path = directory ? `${directory}/${entry.name}` : entry.name;
					if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) directories.push(path);
					else if (entry.isFile() && paths.length < MAX_SCAN_FILES && relativeFilePath(this.cwd, path)) paths.push(path);
				}
			}
			return { paths: paths.sort(), complete: !directories.length && paths.length < MAX_SCAN_FILES };
		}
	}
}

function toUiChange({ path, before, after }: SavedFile): UiFileChange {
	const kind = !before.exists ? 'added' : !after.exists ? 'deleted' : 'modified';
	if (before.text === null || after.text === null) return { path, kind, additions: null, deletions: null, diff: null, preview: before.preview ?? after.preview ?? 'unavailable' };
	const patch = lineDiff(before.text, after.text);
	const diff = `--- ${before.exists ? `a/${path}` : '/dev/null'}\n+++ ${after.exists ? `b/${path}` : '/dev/null'}\n${patch.lines.join('\n')}\n`;
	if (diff.length > MAX_DIFF_CHARS) return { path, kind, additions: patch.additions, deletions: patch.deletions, diff: null, preview: 'too-large' };
	return { path, kind, additions: patch.additions, deletions: patch.deletions, diff };
}

/** A bounded LCS yields ordinary unified line diffs without subprocesses or temp files. */
function lineDiff(before: string, after: string): { lines: string[]; additions: number; deletions: number } {
	const lines = (text: string) => {
		if (!text) return [];
		const result = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
		if (!text.endsWith('\n')) result[result.length - 1] += '\0';
		return result;
	};
	const render = (line: string, prefix: string) => line.endsWith('\0') ? [`${prefix}${line.slice(0, -1)}`, '\\ No newline at end of file'] : [`${prefix}${line}`];
	const a = lines(before), b = lines(after);
	let prefix = 0, suffix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const old = a.slice(prefix, a.length - suffix), next = b.slice(prefix, b.length - suffix);
	const changes: string[] = [];
	let additions = 0, deletions = 0;
	if (old.length * next.length <= 500_000) {
		const width = next.length + 1;
		const table = new Uint32Array((old.length + 1) * width);
		for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) table[i * width + j] = old[i] === next[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
		let i = 0, j = 0;
		while (i < old.length || j < next.length) {
			if (i < old.length && j < next.length && old[i] === next[j]) { changes.push(...render(old[i++]!, ' ')); j++; }
			else if (j < next.length && (i === old.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!)) { changes.push(...render(next[j++]!, '+')); additions++; }
			else { changes.push(...render(old[i++]!, '-')); deletions++; }
		}
	} else {
		for (const line of old) changes.push(...render(line, '-'));
		for (const line of next) changes.push(...render(line, '+'));
		deletions = old.length; additions = next.length;
	}
	const start = Math.max(0, prefix - 3), end = Math.min(3, suffix);
	const contextBefore = a.slice(start, prefix).flatMap((line) => render(line, ' '));
	const contextAfter = suffix ? a.slice(a.length - suffix, a.length - suffix + end).flatMap((line) => render(line, ' ')) : [];
	if (!changes.length) return { additions: 0, deletions: 0, lines: before === after ? [] : ['\\ Line endings changed'] };
	const oldCount = prefix - start + old.length + end, newCount = prefix - start + next.length + end;
	const patch = [`@@ -${oldCount ? start + 1 : 0},${oldCount} +${newCount ? start + 1 : 0},${newCount} @@`, ...contextBefore, ...changes, ...contextAfter];
	return { additions, deletions, lines: patch };
}
