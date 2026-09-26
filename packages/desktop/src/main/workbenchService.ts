import type { App } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceBranches, WorkspaceCommandEvent, WorkspaceEntry, WorkspaceGitLogEntry, WorkspaceGitStatus, WorkspaceOpener } from '@pidesktop/shared';

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_GIT_STATUS_BYTES = 2 * 1024 * 1024;
const DIFF_TRUNCATED_NOTICE = '\n… 仅显示前 1 MB 的差异 / Diff preview limited to the first 1 MB.\n';
const SAFE_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };


/** Resolves Electron's app lazily so this module stays importable under plain Node (tests). */
function electronApp(): App {
	return (createRequire(import.meta.url)('electron') as { app: App }).app;
}

/** Extracts an executable's icon as a data URL for the open-with picker. */
async function editorIcon(executable: string): Promise<string | undefined> {
	try {
		const image = await electronApp().getFileIcon(executable, { size: 'normal' });
		if (image.isEmpty()) return undefined;
		return image.toDataURL();
	} catch {
		return undefined;
	}
}
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
	 * List the apps that can open the workspace (zcode-style open-with picker).
	 * Explorer is always available; VS Code only when an install is detected.
	 */
	async listWorkspaceOpeners(): Promise<WorkspaceOpener[]> {
		const openers: WorkspaceOpener[] = [{ id: 'explorer' }];
		const executable = await this.vsCodeExecutable();
		if (executable) openers.push({ id: 'vscode', icon: await editorIcon(executable) });
		else if (await this.vsCodeOnPath()) openers.push({ id: 'vscode' });
		return openers;
	}

	/** Resolves the installed VS Code executable, or null when only the CLI exists. */
	private async vsCodeExecutable(): Promise<string | null> {
		const candidates: string[] = [];
		if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
		candidates.push('C:\\Program Files\\Microsoft VS Code\\Code.exe', 'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe');
		for (const candidate of candidates) {
			try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* keep probing */ }
		}
		return null;
	}

	private async vsCodeOnPath(): Promise<boolean> {
		try {
			await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [process.platform === 'win32' ? 'code.cmd' : 'code'], { timeout: 5000, windowsHide: true });
			return true;
		} catch {
			return false;
		}
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
		let executable = await this.vsCodeExecutable();
		// Detached spawn so closing pi never kills the editor window. windowsHide
		// must stay OFF: Electron-based editors (VS Code) honor the hidden start
		// state and would open with an invisible window.
		if (executable) {
			const child = spawn(executable, [root], { detached: true, stdio: 'ignore' });
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

	/**
	 * Opens a specific file in VS Code, optionally at a line (4.7 file:line jumps
	 * from diffs and tool activity).
	 */
	async openPathInEditor(relativePath: string, line?: number, column?: number): Promise<void> {
		const { path } = await this.resolveEntry(relativePath);
		const target = typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? `${path}:${line}${column && Number.isSafeInteger(column) && column > 0 ? `:${column}` : ''}` : path;
		let executable = await this.vsCodeExecutable();
		if (executable) {
			const child = spawn(executable, ['-g', target], { detached: true, stdio: 'ignore' });
			child.on('error', () => { /* fall through to the CLI below */ });
			await new Promise<void>((resolve) => { child.once('spawn', () => resolve()); child.once('error', () => { executable = null; resolve(); }); });
			if (executable) return;
		}
		try {
			await execFileAsync(process.platform === 'win32' ? 'code.cmd' : 'code', ['-g', target], { timeout: 15000, windowsHide: true });
		} catch (error) {
			throw new Error(`未找到 VS Code，请安装后重试：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Reveals a workspace file in the OS file manager (4.7). */
	async revealPathInFolder(relativePath: string, reveal: (path: string) => void): Promise<void> {
		const { path } = await this.resolveEntry(relativePath);
		reveal(path);
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
		const candidates = children.filter((child) => !child.isSymbolicLink() && (child.isFile() || child.isDirectory()));
		for (let offset = 0; offset < candidates.length && entries.length < MAX_ENTRIES; offset += 16) {
			const batch = await Promise.all(candidates.slice(offset, offset + 16).map(async (child): Promise<WorkspaceEntry | null> => {
				const childPath = join(path, child.name);
				try {
					const details = await lstat(childPath);
					if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) return null;
					return { name: child.name, path: relative(root, childPath).split(sep).join('/'),
						kind: details.isDirectory() ? 'directory' : 'file', ...(details.isFile() ? { size: details.size } : {}) };
				} catch (error) {
					if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
					throw error;
				}
			}));
			entries.push(...batch.filter((entry): entry is WorkspaceEntry => entry !== null).slice(0, MAX_ENTRIES - entries.length));
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
			this.gitReadOutput([...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], MAX_GIT_STATUS_BYTES),
		]);
		const entries = this.parseGitStatus(statusResult.stdout, root, repositoryRoot);
		return { isRepository: true, branch: branchResult.stdout.trim() || null, entries, ...(statusResult.truncated ? { truncated: true } : {}) };
	}

	/** Parse only complete NUL-delimited entries, including the source record of renames. */
	private parseGitStatus(output: string, root: string, repositoryRoot: string): WorkspaceGitStatus['entries'] {
		const records = output.slice(0, output.lastIndexOf('\0') + 1).split('\0');
		const entries: WorkspaceGitStatus['entries'] = [];
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];
			if (!record || record.length < 4) continue;
			// Keep both porcelain columns: "M " (staged) and " M" (worktree) differ.
			const status = record.slice(0, 2);
			if (status.includes('R') || status.includes('C')) {
				if (!records[index + 1]) break;
				index += 1; // porcelain -z adds the source path.
			}
			// Porcelain paths are relative to the repository, even when -C selects a subdirectory.
			const candidate = resolve(repositoryRoot, record.slice(3));
			if (!isWithin(root, candidate)) continue;
			entries.push({ path: relative(root, candidate).split(sep).join('/'), status });
		}
		return entries;
	}

	/** Local branches plus the checked-out ref for the composer branch picker. */
	async gitBranches(): Promise<WorkspaceBranches> {
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		try {
			await execFileAsync('git', [...prefix, 'rev-parse', '--show-toplevel'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
		} catch {
			return { isRepository: false, current: null, detached: false, branches: [] };
		}
		const [currentResult, refsResult] = await Promise.all([
			execFileAsync('git', [...prefix, 'branch', '--show-current'], { timeout: 8000, maxBuffer: 64 * 1024, env: SAFE_GIT_ENV }),
			execFileAsync('git', [...prefix, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeout: 8000, maxBuffer: 256 * 1024, env: SAFE_GIT_ENV }),
		]);
		const current = currentResult.stdout.trim() || null;
		const branches = refsResult.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && line !== current).sort((a, b) => a.localeCompare(b));
		// Empty --show-current means detached HEAD; keep the branch list usable.
		return { isRepository: true, current, detached: current === null, branches: current ? [current, ...branches] : branches };
		}

	/** Check out an existing local branch. Branch names are matched against
		 * the real ref list, so odd-looking names can never become git flags. */
	async gitCheckout(branch: string): Promise<void> {
		if (typeof branch !== 'string' || branch.length === 0 || branch.length > 250 || branch.includes('\0')) throw new Error('无效的分支名');
		const listed = await this.gitBranches();
		if (!listed.isRepository) throw new Error('当前工作区不是 git 仓库');
		if (!listed.branches.includes(branch)) throw new Error('分支不存在');
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		if (resolve(root) !== resolve(await this.workspaceRoot())) throw new Error('工作区已切换，请重试');
		try {
			// `git switch` has no pathspec semantics; names are whitelisted against real refs.
			await execFileAsync('git', [...prefix, 'switch', branch], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
		} catch (error) {
			const raw = error instanceof Error ? (error as ExecFileException).stderr : undefined;
			const detail = (typeof raw === 'string' ? raw : undefined)?.trim() || (error instanceof Error ? error.message : String(error));
			throw new Error(`切换分支失败：${detail}`);
		}
	}

	/** Validates a git pathspec stays inside the workspace and returns a normalized relative path. */
	private validateGitPath(input: string, root: string): string {
		if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0') || isAbsolute(input)) throw new Error('文件路径无效');
		const candidate = resolve(root, input);
		if (!isWithin(root, candidate)) throw new Error('文件不属于当前工作区');
		return relative(root, candidate).split(sep).join('/');
	}

	private static execDetail(error: unknown): string {
		const raw = error instanceof Error ? (error as ExecFileException).stderr : undefined;
		return (typeof raw === 'string' ? raw : undefined)?.trim() || (error instanceof Error ? error.message : String(error));
	}

	/** Stage or unstage specific paths (4.5). */
	async gitSetStaged(paths: string[], staged: boolean): Promise<void> {
		if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200 || !paths.every((path) => typeof path === 'string')) throw new Error('文件列表无效');
		const root = await this.workspaceRoot();
		const relativePaths = paths.map((path) => this.validateGitPath(path, root));
		const prefix = this.gitPrefix(root);
		const args = staged ? [...prefix, 'add', '--', ...relativePaths] : [...prefix, 'restore', '--staged', '--', ...relativePaths];
		try {
			await execFileAsync('git', args, { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
		} catch (error) {
			throw new Error(`${staged ? '暂存' : '取消暂存'}失败：${WorkbenchService.execDetail(error)}`);
		}
	}

	/** Discard worktree changes (tracked restore / untracked clean) — destructive, caller confirms with the real diff (4.5). */
	async gitDiscard(paths: string[]): Promise<void> {
		if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200 || !paths.every((path) => typeof path === 'string')) throw new Error('文件列表无效');
		const generation = this.commandGeneration;
		const approvedCwd = this.getWorkspace();
		const root = await this.workspaceRoot();
		const relativePaths = paths.map((path) => this.validateGitPath(path, root));
		const prefix = this.gitPrefix(root);
		let changes: WorkspaceGitStatus['entries'];
		try {
			const repositoryRoot = (await execFileAsync('git', [...prefix, 'rev-parse', '--show-toplevel'], { timeout: 8000, env: SAFE_GIT_ENV })).stdout.replace(/\r?\n$/, '');
			// Mutations must never act on a truncated status preview.
			const status = await this.gitReadOutput([...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relativePaths], 32 * 1024 * 1024, false, 30000);
			changes = this.parseGitStatus(status.stdout, root, repositoryRoot);
		} catch (error) {
			throw new Error(`丢弃更改失败：${WorkbenchService.execDetail(error)}`);
		}
		const tracked: string[] = [];
		const untracked: string[] = [];
		for (const { status, path } of changes) {
			if (status.includes('?')) untracked.push(path);
			else tracked.push(path);
		}
		if (generation !== this.commandGeneration || approvedCwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		try {
			for (const [args, changedPaths] of [[['restore', '--worktree'], tracked], [['clean', '-f'], untracked]] as const) {
				// Keep expanded directory selections below Windows' command-line limit.
				let batch: string[] = [];
				let length = 0;
				const run = async () => { if (batch.length) await execFileAsync('git', [...prefix, ...args, '--', ...batch], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV }); };
				for (const path of changedPaths) {
					if (length + path.length + 3 > 6000) { await run(); batch = []; length = 0; }
					batch.push(path); length += path.length + 3;
				}
				await run();
			}
		} catch (error) {
			throw new Error(`丢弃更改失败：${WorkbenchService.execDetail(error)}`);
		}
	}

	/** Recent commit history for the git pane (4.5). */
	async gitLog(limit = 30): Promise<WorkspaceGitLogEntry[]> {
		const capped = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		try {
			// Git bounds individual fields before emitting them, so oversized commit
			// subjects cannot overflow the complete (at most 100 entry) history.
			const output = (await execFileAsync('git', [...prefix, 'log', `-n${capped}`, '--pretty=format:%H%x1f%h%x1f%<(200,trunc)%an%x1f%aI%x1f%<(1000,trunc)%s'], { timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: SAFE_GIT_ENV })).stdout;
			return output.split('\n').filter((line) => line.trim()).map((line) => {
				const [hash, shortHash, author, date, ...subject] = line.split('\x1f');
				return { hash: hash ?? '', shortHash: shortHash ?? '', author: author?.trimEnd() ?? '', date: date ?? '', subject: subject.join('\x1f').trimEnd() };
			});
		} catch {
			return []; // not a repository or no commits yet
		}
	}

	/** Create a local branch, optionally switching to it (4.5). */
	async gitCreateBranch(name: string, checkout: boolean): Promise<void> {
		if (typeof name !== 'string' || name.length === 0 || name.length > 250 || name.includes('\0') || name.startsWith('-')) throw new Error('无效的分支名');
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		try {
			await execFileAsync('git', [...prefix, 'check-ref-format', '--branch', name], { timeout: 8000, maxBuffer: 64 * 1024, env: SAFE_GIT_ENV });
		} catch {
			throw new Error('无效的分支名');
		}
		try {
			// Names are validated (no leading '-', check-ref-format) so they cannot become flags; `switch -c` takes no `--` separator.
			await execFileAsync('git', checkout ? [...prefix, 'switch', '-c', name] : [...prefix, 'branch', '--', name], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
		} catch (error) {
			throw new Error(`创建分支失败：${WorkbenchService.execDetail(error)}`);
		}
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
			this.gitTextPreview([...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', '.'], 64 * 1024),
			this.gitTextPreview([...prefix, 'diff', 'HEAD', '--stat', '--no-color', '--no-ext-diff', '--no-textconv', '--', '.'], 32 * 1024).catch(() => ({ stdout: '' })),
			this.gitTextPreview([...prefix, 'log', '--oneline', '-n', '8', '--no-color', '--', '.'], 16 * 1024).catch(() => ({ stdout: '' })),
		]);
		if (!statusResult.stdout.trim()) throw new Error('没有可提交的更改');
		// diff vs HEAD covers staged and unstaged tracked changes; a missing HEAD
		// (unborn branch) degrades to the file list only.
		const diff = await this.gitDiffPreview([...prefix, 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--', '.'], 24 * 1024).catch(() => '');
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
			const repositoryRoot = (await execFileAsync('git', [...prefix, 'rev-parse', '--show-toplevel'], { timeout: 8000, env: SAFE_GIT_ENV })).stdout.replace(/\r?\n$/, '');
			if (this.commandGeneration !== generation || this.getWorkspace() !== approvedCwd) throw new Error('工作区已切换，请重新提交');
			await execFileAsync('git', [...prefix, 'add', '-A', '--', '.'], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
			// A nested workspace must not commit or unstage changes elsewhere in the
			// repository. --only preserves those index entries for a later commit.
			// Keep full-repository commits compatible with merge/cherry-pick commits.
			const scope = relative(root, resolve(repositoryRoot)) ? ['--only', '--', '.'] : [];
			const commit = await execFileAsync('git', [...prefix, 'commit', '--quiet', '-m', trimmed, ...scope], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
			const hash = await execFileAsync('git', [...prefix, 'rev-parse', '--short', 'HEAD'], { timeout: 8000, maxBuffer: 256, env: SAFE_GIT_ENV });
			return hash.stdout.trim() || commit.stdout.trim().slice(0, 200);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// Re-wrap so stderr from git stays actionable (identity missing, hooks, ...).
			throw new Error(`提交失败：${detail}`);
		}
	}

	async gitDiff(relativePath: string, source: 'staged' | 'unstaged' | 'all' = 'all'): Promise<string> {
		if (!['staged', 'unstaged', 'all'].includes(source)) throw new Error('差异来源无效');
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
			if (source === 'staged') return '';
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
		if (source !== 'unstaged' && status.stdout[0] !== ' ') sections.push({ title: '已暂存 / Staged', args: [...diffArgs, '--cached', base, '--', safePath] });
		if (source !== 'staged' && status.stdout[1] !== ' ') sections.push({ title: '未暂存 / Unstaged', args: [...diffArgs, '--', safePath] });
		const maximumBytes = Math.floor(MAX_PREVIEW_BYTES / Math.max(1, sections.length));
		const previews = await Promise.all(sections.map(async ({ title, args }) => {
			const preview = await this.gitDiffPreview(args, maximumBytes);
			return preview ? `${title}\n${preview}` : '';
		}));
		return previews.filter(Boolean).join('\n');
	}

	private async gitTextPreview(args: string[], maximumBytes: number): Promise<{ stdout: string }> {
		const result = await this.gitReadOutput(args, maximumBytes);
		return { stdout: result.stdout + (result.truncated ? '\n… 输出已截断 / Output truncated.\n' : '') };
	}

	private async gitDiffPreview(args: string[], maximumBytes = MAX_PREVIEW_BYTES): Promise<string> {
		const result = await this.gitReadOutput(args, maximumBytes);
		const notice = maximumBytes === MAX_PREVIEW_BYTES ? DIFF_TRUNCATED_NOTICE
			: DIFF_TRUNCATED_NOTICE.replaceAll('1 MB', `${maximumBytes / 1024} KB`);
		return result.stdout + (result.truncated ? notice : '');
	}

	private gitReadOutput(args: string[], maximumBytes: number, allowTruncation = true, timeout = 8000): Promise<{ stdout: string; truncated: boolean }> {
		return new Promise((resolve, reject) => {
			const child = spawn('git', args, { env: SAFE_GIT_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			const chunks: Buffer[] = [];
			let size = 0;
			let stderr = '';
			let truncated = false;
			let timedOut = false;
			let settled = false;
			const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
			const finish = (error?: Error, text?: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve({ stdout: text ?? '', truncated });
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
				if (timedOut) return finish(new Error('Git 输出读取超时'));
				if (truncated && !allowTruncation) return finish(new Error('Git 状态超出安全读取限制，请缩小文件选择范围后重试 / Git status exceeds the safe limit; select fewer files.'));
				if (!truncated && code !== 0) return finish(new Error(stderr.trim() || `Git exited with code ${code}`));
				const output = new TextDecoder().decode(Buffer.concat(chunks, size), { stream: truncated });
				finish(undefined, output);
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
