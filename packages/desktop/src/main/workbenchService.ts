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
	private readonly stoppingCommands = new Map<string, Promise<void>>();
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

	private async workspaceRoot(cwd = this.getWorkspace()): Promise<string> {
		if (!cwd) throw new Error('请先打开工作区');
		const root = await realpath(cwd);
		if (!(await stat(root)).isDirectory()) throw new Error('工作区不是文件夹');
		return root;
	}

	async openWorkspaceFolder(cwd: string, openPath: (path: string) => Promise<string>): Promise<void> {
		if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !isAbsolute(cwd)) throw new Error('工作区路径无效');
		if (cwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		const generation = this.commandGeneration;
		const root = await this.workspaceRoot(cwd);
		if (generation !== this.commandGeneration || cwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		const error = await openPath(root);
		if (error) throw new Error(`无法打开工作区文件夹：${error}`);
	}

	/**
	 * Open the workspace root in VS Code (zcode-style editor launch).
	 * Probes common Code.exe install locations first, then falls back to the
	 * `code` CLI on PATH.
	 */
	async openWorkspaceInVsCode(cwd: string): Promise<void> {
		if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !isAbsolute(cwd)) throw new Error('工作区路径无效');
		if (cwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		const generation = this.commandGeneration;
		const root = await this.workspaceRoot(cwd);
		if (generation !== this.commandGeneration || cwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		const candidates: string[] = [];
		if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
		candidates.push('C:\\Program Files\\Microsoft VS Code\\Code.exe', 'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe');
		let executable: string | null = null;
		for (const candidate of candidates) {
			try { if ((await stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* keep probing */ }
		}
		// Detached spawn so closing pi never kills the editor window.
		if (executable) {
			const child = spawn(executable, [root], { detached: true, stdio: 'ignore', windowsHide: true });
			child.on('error', () => { /* launch errors surface below via exit check */ });
			await new Promise<void>((resolve) => { child.once('spawn', () => resolve()); child.once('error', () => { executable = null; resolve(); }); });
			if (executable) return;
		}
		// Fallback: the `code` CLI must live on PATH.
		try {
			await execFileAsync(process.platform === 'win32' ? 'code.cmd' : 'code', [root], { timeout: 15000, windowsHide: true });
		} catch (error) {
			throw new Error(`未找到 VS Code，请安装后重试：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async resolveEntry(relativePath: string, root?: string): Promise<{ root: string; path: string; relativePath: string }> {
		if (typeof relativePath !== 'string' || relativePath.includes('\0') || isAbsolute(relativePath)) {
			throw new Error('文件路径无效');
		}
		root ??= await this.workspaceRoot();
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
		let repositoryRoot: string;
		try {
			const result = await execFileAsync('git', [...prefix, 'rev-parse', '--show-toplevel'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
			repositoryRoot = result.stdout.replace(/\r?\n$/, '');
		} catch {
			return { isRepository: false, branch: null, entries: [] };
		}
		const [branchResult, statusResult] = await Promise.all([
			execFileAsync('git', [...prefix, 'branch', '--show-current'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV }),
			execFileAsync('git', [...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { timeout: 8000, maxBuffer: 2 * 1024 * 1024, env: SAFE_GIT_ENV }),
		]);
		const records = statusResult.stdout.split('\0');
		const entries: WorkspaceGitStatus['entries'] = [];
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];
			if (!record || record.length < 4) continue;
			// Keep both porcelain columns: "M " (staged) and " M" (worktree) differ.
			const status = record.slice(0, 2);
			if (status.includes('R') || status.includes('C')) index += 1; // porcelain -z adds the source path.
			// Porcelain paths are relative to the repository, even when -C selects a subdirectory.
			const candidate = resolve(repositoryRoot, record.slice(3));
			if (!isWithin(root, candidate)) continue;
			entries.push({ path: relative(root, candidate).split(sep).join('/'), status });
		}
		return { isRepository: true, branch: branchResult.stdout.trim() || null, entries };
	}

	/**
	 * Assemble the textual context the LLM sees when generating a commit
	 * message: porcelain status, a diffstat plus a capped full diff versus HEAD,
	 * untracked file names, and recent commit subjects for style matching.
	 */
	async gitCommitContext(): Promise<string> {
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		try {
			await execFileAsync('git', [...prefix, 'rev-parse', '--show-toplevel'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
		} catch {
			throw new Error('当前工作区不是 git 仓库');
		}
		const [statusResult, statResult, logResult] = await Promise.all([
			execFileAsync('git', [...prefix, 'status', '--porcelain=v1', '--untracked-files=all'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV }),
			execFileAsync('git', [...prefix, 'diff', 'HEAD', '--stat', '--no-color'], { timeout: 8000, maxBuffer: 512 * 1024, env: SAFE_GIT_ENV }).catch(() => ({ stdout: '' })),
			execFileAsync('git', [...prefix, 'log', '--oneline', '-n', '8', '--no-color'], { timeout: 8000, maxBuffer: 64 * 1024, env: SAFE_GIT_ENV }).catch(() => ({ stdout: '' })),
		]);
		if (!statusResult.stdout.trim()) throw new Error('没有可提交的更改');
		// diff vs HEAD covers staged and unstaged tracked changes; a missing HEAD
		// (unborn branch) degrades to the file list only.
		const diff = await this.gitDiffPreview([...prefix, 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv'], 24 * 1024).catch(() => '');
		const sections = [
			`# git status --porcelain\n${statusResult.stdout.trim()}`,
			statResult.stdout.trim() ? `# git diff HEAD --stat\n${statResult.stdout.trim()}` : '',
			diff ? `# git diff HEAD\n${diff}` : '',
			logResult.stdout.trim() ? `# recent commits (style reference)\n${logResult.stdout.trim()}` : '',
		];
		return sections.filter(Boolean).join('\n\n');
	}

	/**
	 * Stage everything and create one commit for the current workspace state.
	 */
	async gitCommit(message: string, approvedCwd = this.getWorkspace()): Promise<string> {
		if (typeof message !== 'string') throw new Error('提交消息无效');
		const trimmed = message.trim();
		if (!trimmed) throw new Error('提交消息不能为空');
		if (trimmed.length > 4000) throw new Error('提交消息过长');
		if (message.includes('\0')) throw new Error('提交消息包含无效字符');
		const generation = this.commandGeneration;
		const root = await this.workspaceRoot();
		if (this.commandGeneration !== generation || this.getWorkspace() !== approvedCwd) {
			throw new Error('工作区已切换，请重新提交');
		}
		const prefix = this.gitPrefix(root);
		try {
			await execFileAsync('git', [...prefix, 'add', '-A'], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
			const commit = await execFileAsync('git', [...prefix, 'commit', '-m', trimmed], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
			const hash = await execFileAsync('git', [...prefix, 'rev-parse', '--short', 'HEAD'], { timeout: 8000, maxBuffer: 256, env: SAFE_GIT_ENV });
			return hash.stdout.trim() || commit.stdout.trim().slice(0, 200);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// Re-wrap so stderr from git stays actionable (identity missing, hooks, ...).
			throw new Error(`提交失败：${detail}`);
		}
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
		if (!status.stdout) return '';
		if (status.stdout.startsWith('?? ')) {
			// The selection may change while Git runs. Resolve against the root
			// captured for this diff, including the same symlink boundary checks.
			const { path } = await this.resolveEntry(safePath, root);
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
			let content: string;
			try {
				// A capped sample may end inside a character. Only defer that final
				// incomplete sequence; invalid bytes and incomplete full files fail.
				content = new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: details.size > bytesRead });
			} catch { throw new Error('文件不是有效的 UTF-8 文本'); }
			const lines = content ? content.replace(/\n$/, '').split('\n') : [];
			const diff = `--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
			const preview = Buffer.from(diff, 'utf8');
			return details.size > bytesRead || preview.length > MAX_PREVIEW_BYTES
				? new TextDecoder().decode(preview.subarray(0, MAX_PREVIEW_BYTES), { stream: true }) + DIFF_TRUNCATED_NOTICE
				: diff;
		}
		let base: string;
		try {
			const result = await execFileAsync('git', [...prefix, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
				timeout: 8000, maxBuffer: 1024, env: SAFE_GIT_ENV,
			});
			base = result.stdout.trim();
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 1)) throw error;
			// An unborn branch has no HEAD. Git recognizes its empty-tree hash without writing an object.
			// Ask Git for the hash so SHA-256 repositories work as well as SHA-1 repositories.
			const emptyTree = execFileAsync('git', [...prefix, 'hash-object', '-t', 'tree', '--stdin'], {
				timeout: 8000, maxBuffer: 1024, env: SAFE_GIT_ENV,
			});
			emptyTree.child.stdin?.end();
			base = (await emptyTree).stdout.trim();
		}
		const sections: { title: string; args: string[] }[] = [];
		const diffArgs = [...prefix, 'diff', '--no-ext-diff', '--no-textconv'];
		if (status.stdout[0] !== ' ') sections.push({ title: '已暂存 / Staged', args: [...diffArgs, '--cached', base, '--', safePath] });
		if (status.stdout[1] !== ' ') sections.push({ title: '未暂存 / Unstaged', args: [...diffArgs, '--', safePath] });
		const maximumBytes = Math.floor(MAX_PREVIEW_BYTES / Math.max(1, sections.length));
		const previews = await Promise.all(sections.map(async ({ title, args }) => {
			const preview = await this.gitDiffPreview(args, maximumBytes);
			return preview ? `${title}\n${preview}` : '';
		}));
		return previews.filter(Boolean).join('\n');
	}

	private gitDiffPreview(args: string[], maximumBytes = MAX_PREVIEW_BYTES): Promise<string> {
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
				const remaining = maximumBytes - size;
				if (value.length > remaining) {
					if (remaining > 0) chunks.push(value.subarray(0, remaining));
					size = maximumBytes;
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
				const output = new TextDecoder().decode(Buffer.concat(chunks, size), { stream: truncated });
				const notice = maximumBytes === MAX_PREVIEW_BYTES ? DIFF_TRUNCATED_NOTICE
					: DIFF_TRUNCATED_NOTICE.replaceAll('1 MB', `${maximumBytes / 1024} KB`);
				finish(undefined, truncated ? output + notice : output);
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
			? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${command}`], { cwd, windowsHide: true, stdio: 'pipe' })
			: spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'pipe' });
		this.commands.set(id, child);
		let bytes = 0;
		let outputExceeded = false;
		const forward = (type: 'stdout' | 'stderr', value: string): void => {
			if (outputExceeded) return;
			bytes += Buffer.byteLength(value);
			if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
				outputExceeded = true;
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
		// "exit" can precede the last stdout/stderr chunks; close ends the output stream.
		child.on('close', (code) => { this.commands.delete(id); this.emit({ id, type: 'exit', code }); });
		return id;
	}

	async stopCommand(id: string): Promise<void> {
		const stopping = this.stoppingCommands.get(id);
		if (stopping) return stopping;
		const child = this.commands.get(id);
		if (!child) return;
		// Keep the command tracked while termination runs, so reset can await an in-flight stop.
		const pending = (async () => {
			if (process.platform === 'win32' && child.pid) {
				try { await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }); }
				catch { child.kill(); }
			} else if (process.platform !== 'win32' && child.pid) {
				// A detached Unix shell owns its process group, including spawned commands.
				try { process.kill(-child.pid, 'SIGTERM'); }
				catch { child.kill('SIGTERM'); }
			} else child.kill('SIGTERM');
		})().finally(() => { this.stoppingCommands.delete(id); });
		this.stoppingCommands.set(id, pending);
		return pending;
	}

	async reset(): Promise<void> {
		this.commandGeneration += 1;
		const stops = [...this.commands.keys()].map((id) => this.stopCommand(id));
		await Promise.allSettled([...stops, ...this.stoppingCommands.values()]);
		if (this.safeHooksPath) {
			const target = resolve(this.safeHooksPath);
			if (isWithin(resolve(tmpdir()), target) && basename(target).startsWith('pi-desktop-no-git-hooks-')) {
				try { rmSync(target, { recursive: true, force: true }); }
				catch { /* A stale empty temporary directory does not affect the workspace. */ }
			}
			this.safeHooksPath = null;
		}
	}

	async dispose(): Promise<void> {
		await this.reset();
	}
}
