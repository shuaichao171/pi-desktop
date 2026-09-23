import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceCommandEvent, WorkspaceEntry, WorkspaceGitStatus } from '@pidesktop/shared';

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 400;
const DIFF_TRUNCATED_NOTICE = '\n… 仅显示前 1 MB 的差异 / Diff preview limited to the first 1 MB.\n';
const SAFE_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class WorkbenchService {
	private commandGeneration = 0;
	private readonly commands = new Map<string, ChildProcessWithoutNullStreams>();
	private readonly getWorkspace: () => string;
	private readonly emit: (event: WorkspaceCommandEvent) => void;
	private safeHooksPath: string | null = null;

	constructor(
		getWorkspace: () => string,
		emit: (event: WorkspaceCommandEvent) => void,
	) {
		this.getWorkspace = getWorkspace;
		this.emit = emit;
	}

	private async workspaceRoot(): Promise<string> {
		const cwd = this.getWorkspace();
		if (!cwd) throw new Error('请先打开工作区');
		const root = await realpath(cwd);
		if (!(await stat(root)).isDirectory()) throw new Error('工作区不是文件夹');
		return root;
	}

	private async resolveEntry(relativePath: string): Promise<{ root: string; path: string; relativePath: string }> {
		if (typeof relativePath !== 'string' || relativePath.includes('\0') || isAbsolute(relativePath)) {
			throw new Error('文件路径无效');
		}
		const root = await this.workspaceRoot();
		const candidate = resolve(root, relativePath);
		if (!isWithin(root, candidate)) throw new Error('文件不属于当前工作区');
		const path = await realpath(candidate);
		if (!isWithin(root, path)) throw new Error('文件不属于当前工作区');
		return { root, path, relativePath: relative(root, path).split(sep).join('/') };
	}

	private gitPrefix(root: string): string[] {
		this.safeHooksPath ??= mkdtempSync(join(tmpdir(), 'pi-desktop-no-git-hooks-'));
		return ['-C', root, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${this.safeHooksPath}`];
	}

	async listEntries(relativePath = ''): Promise<WorkspaceEntry[]> {
		const { root, path } = await this.resolveEntry(relativePath);
		if (!(await stat(path)).isDirectory()) throw new Error('不是文件夹');
		const children = await readdir(path, { withFileTypes: true });
		const entries: WorkspaceEntry[] = [];
		children.sort((a, b) => a.isDirectory() === b.isDirectory()
			? a.name.localeCompare(b.name)
			: a.isDirectory() ? -1 : 1);
		for (const child of children.slice(0, MAX_ENTRIES)) {
			if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) continue;
			const childPath = join(path, child.name);
			const details = await lstat(childPath);
			if (details.isSymbolicLink()) continue;
			entries.push({
				name: child.name,
				path: relative(root, childPath).split(sep).join('/'),
				kind: child.isDirectory() ? 'directory' : 'file',
				...(child.isFile() ? { size: details.size } : {}),
			});
		}
		return entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
	}

	async readFile(relativePath: string): Promise<string> {
		const { path } = await this.resolveEntry(relativePath);
		const details = await stat(path);
		if (!details.isFile()) throw new Error('不是文件');
		if (details.size > MAX_PREVIEW_BYTES) throw new Error('文件超过预览大小限制（1 MB）');
		const bytes = await readFile(path);
		if (bytes.includes(0)) throw new Error('无法预览二进制文件');
		try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
		catch { throw new Error('文件不是有效的 UTF-8 文本'); }
	}

	async gitStatus(): Promise<WorkspaceGitStatus> {
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		try {
			await execFileAsync('git', [...prefix, 'rev-parse', '--is-inside-work-tree'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
		} catch {
			return { isRepository: false, branch: null, entries: [] };
		}
		const [branchResult, statusResult] = await Promise.all([
			execFileAsync('git', [...prefix, 'branch', '--show-current'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV }),
			execFileAsync('git', [...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'], { timeout: 8000, maxBuffer: 2 * 1024 * 1024, env: SAFE_GIT_ENV }),
		]);
		const records = statusResult.stdout.split('\0');
		const entries: WorkspaceGitStatus['entries'] = [];
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];
			if (!record || record.length < 4) continue;
			// Keep both porcelain columns: "M " (staged) and " M" (worktree) differ.
			const status = record.slice(0, 2);
			const path = record.slice(3).replaceAll('\\', '/');
			entries.push({ path, status });
			if (status.includes('R') || status.includes('C')) index += 1; // porcelain -z adds the source path.
		}
		return { isRepository: true, branch: branchResult.stdout.trim() || null, entries };
	}

	async gitDiff(relativePath: string): Promise<string> {
		if (typeof relativePath !== 'string' || relativePath.includes('\0') || isAbsolute(relativePath)) throw new Error('文件路径无效');
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		const candidate = resolve(root, relativePath);
		if (!isWithin(root, candidate)) throw new Error('文件不属于当前工作区');
		const safePath = relative(root, candidate).split(sep).join('/');
		if (!safePath) throw new Error('请选择文件');
		const status = await execFileAsync('git', [...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', safePath], {
			timeout: 8000, maxBuffer: MAX_PREVIEW_BYTES, env: SAFE_GIT_ENV,
		});
		if (status.stdout.startsWith('?? ')) {
			const { path } = await this.resolveEntry(safePath);
			const details = await stat(path);
			if (!details.isFile()) throw new Error('不是文件');
			const file = await open(path, 'r');
			const bytes = Buffer.alloc(Math.min(details.size, MAX_PREVIEW_BYTES));
			let bytesRead = 0;
			try {
				while (bytesRead < bytes.length) {
					const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
					if (result.bytesRead === 0) break;
					bytesRead += result.bytesRead;
				}
			}
			finally { await file.close(); }
			const sample = bytes.subarray(0, bytesRead);
			if (sample.includes(0)) throw new Error('无法预览二进制文件');
			let content: string | null = null;
			for (let tail = 0; tail <= 3 && content === null; tail += 1) {
				try { content = new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, bytesRead - tail)); }
				catch { /* A capped preview may stop inside a multi-byte character. */ }
			}
			if (content === null) throw new Error('文件不是有效的 UTF-8 文本');
			const lines = content ? content.replace(/\n$/, '').split('\n') : [];
			const diff = `--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
			const preview = Buffer.from(diff, 'utf8');
			return details.size > bytesRead || preview.length > MAX_PREVIEW_BYTES
				? preview.subarray(0, MAX_PREVIEW_BYTES).toString('utf8') + DIFF_TRUNCATED_NOTICE
				: diff;
		}
		return this.gitDiffPreview([...prefix, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', safePath]);
	}

	private gitDiffPreview(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn('git', args, { env: SAFE_GIT_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			const chunks: Buffer[] = [];
			let size = 0;
			let stderr = '';
			let truncated = false;
			let timedOut = false;
			let settled = false;
			const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
			const finish = (error?: Error, text?: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(text ?? '');
			};
			child.stdout.on('data', (value: Buffer) => {
				if (truncated) return;
				const remaining = MAX_PREVIEW_BYTES - size;
				if (value.length > remaining) {
					if (remaining > 0) chunks.push(value.subarray(0, remaining));
					size = MAX_PREVIEW_BYTES;
					truncated = true;
					child.kill();
				} else {
					chunks.push(value);
					size += value.length;
				}
			});
			child.stderr.on('data', (value: Buffer) => { stderr = (stderr + value.toString('utf8')).slice(-4096); });
			child.on('error', (error) => finish(error));
			child.on('close', (code) => {
				if (timedOut) return finish(new Error('Git 差异读取超时'));
				if (!truncated && code !== 0) return finish(new Error(stderr.trim() || `Git diff exited with code ${code}`));
				const output = Buffer.concat(chunks, size).toString('utf8');
				finish(undefined, truncated ? output + DIFF_TRUNCATED_NOTICE : output);
			});
		});
	}

	async startCommand(command: string, approvedCwd = this.getWorkspace()): Promise<string> {
		if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw new Error('命令无效或过长');
		if (this.commands.size >= 4) throw new Error('同时最多运行 4 条命令');
		const generation = this.commandGeneration;
		const cwd = await this.workspaceRoot();
		if (this.commandGeneration !== generation || this.getWorkspace() !== approvedCwd) {
			throw new Error('工作区已切换，请重新运行命令');
		}
		if (this.commands.size >= 4) throw new Error('同时最多运行 4 条命令');
		const id = randomUUID();
		const child = process.platform === 'win32'
			? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { cwd, windowsHide: true, stdio: 'pipe' })
			: spawn('/bin/sh', ['-c', command], { cwd, stdio: 'pipe' });
		this.commands.set(id, child);
		let bytes = 0;
		const forward = (type: 'stdout' | 'stderr', value: string): void => {
			bytes += Buffer.byteLength(value);
			if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
				this.emit({ id, type: 'error', data: '输出超过 1 MB，命令已停止' });
				void this.stopCommand(id);
				return;
			}
			this.emit({ id, type, data: value });
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (value: string) => forward('stdout', value));
		child.stderr.on('data', (value: string) => forward('stderr', value));
		child.on('error', (error) => { this.commands.delete(id); this.emit({ id, type: 'error', data: error.message }); });
		child.on('exit', (code) => { this.commands.delete(id); this.emit({ id, type: 'exit', code }); });
		return id;
	}

	async stopCommand(id: string): Promise<void> {
		const child = this.commands.get(id);
		if (!child) return;
		this.commands.delete(id);
		if (process.platform === 'win32' && child.pid) {
			try { await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 }); }
			catch { child.kill(); }
		} else child.kill('SIGTERM');
	}

	async dispose(): Promise<void> {
		this.commandGeneration += 1;
		await Promise.allSettled([...this.commands.keys()].map((id) => this.stopCommand(id)));
		if (this.safeHooksPath) {
			const target = resolve(this.safeHooksPath);
			if (isWithin(resolve(tmpdir()), target) && basename(target).startsWith('pi-desktop-no-git-hooks-')) {
				try { rmSync(target, { recursive: true, force: true }); }
				catch { /* A stale empty temporary directory does not affect the workspace. */ }
			}
			this.safeHooksPath = null;
		}
	}
}
