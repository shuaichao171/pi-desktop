import type { App } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { detectEditors, launchEditor, type DetectedEditor } from './editorCatalog.ts';
import type { WorkspaceBranches, WorkspaceCommandEvent, WorkspaceEntry, WorkspaceGitCheckoutIssue, WorkspaceGitCheckoutResult, WorkspaceGitGraphCommit, WorkspaceGitLogEntry, WorkspaceGitStatus, WorkspaceOpener } from '@pidesktop/shared';

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
/**
 * Runs the VS Code CLI from PATH. On Windows it is `code.cmd`, and Node refuses
 * to spawn batch files without a shell (CVE-2024-27980, EINVAL). Route it
 * through cmd.exe with every argument quoted; Windows paths cannot contain '"'.
 */
function runVsCodeCli(args: string[]): Promise<unknown> {
	if (process.platform !== 'win32') return execFileAsync('code', args, { timeout: 15000, windowsHide: true });
	if (args.some((arg) => arg.includes('"'))) return Promise.reject(new Error('路径包含无效字符'));
	const commandLine = ['code.cmd', ...args].map((arg) => `"${arg}"`).join(' ');
	return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { timeout: 15000, windowsHide: true, windowsVerbatimArguments: true });
}

/** Convert Git's branch-switch stderr into a bounded, structured blocker. */
export function parseCheckoutFailure(stderr: string): WorkspaceGitCheckoutIssue {
	const text = stderr.trim() || 'Git 未返回错误详情';
	const lines = text.split(/\r?\n/);
	const dirty = /would be overwritten by (?:checkout|switch)|untracked working tree files would be (?:overwritten|removed)/i.test(text);
	const inUse = /already checked out at|is already used by worktree/i.test(text);
	const conflict = /resolve your current index first|you need to resolve your current index/i.test(text);
	let paths: string[] = [];
	if (dirty) {
		const marker = lines.findIndex((line) => /would be overwritten by (?:checkout|switch)|untracked working tree files would be (?:overwritten|removed)/i.test(line));
		paths = lines.slice(marker + 1).map((line) => line.trim()).filter((line) => Boolean(line) && !/^(?:Please|Aborting|error:)/i.test(line)).slice(0, 200);
	}
	const code = dirty ? 'dirty' : inUse ? 'branch-in-use' : conflict ? 'conflict' : 'unknown';
	const message = dirty
		? `${paths.length ? `以下文件有未提交的修改，切换会覆盖它们：${paths.slice(0, 8).join('、')}${paths.length > 8 ? ` 等 ${paths.length} 个文件` : ''}。` : '有未提交的修改会被覆盖。'}请先提交后重试，或在终端中用 git stash 暂存。`
		: inUse ? '目标分支已被另一个 Git 工作树使用，请先关闭或移除对应工作树。'
			: conflict ? '仓库仍有未解决的合并冲突，请先解决冲突后再切换分支。'
				: text;
	return { code, message, paths };
}

/** Backwards-compatible display helper used by diagnostics and tests. */
export function describeCheckoutFailure(stderr: string): string {
	return `切换分支失败：${parseCheckoutFailure(stderr).message}`;
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

	/** Detection walks install roots and PATH; cache it briefly so menus open instantly. */
	private openerCache: { at: number; editors: Promise<DetectedEditor[]>; openers?: Promise<WorkspaceOpener[]> } | null = null;
	private detectedEditors(): Promise<DetectedEditor[]> {
		if (!this.openerCache || Date.now() - this.openerCache.at > 60_000) this.openerCache = { at: Date.now(), editors: detectEditors() };
		return this.openerCache.editors;
	}

	/**
	 * Apps that can open the workspace (ZCode open-with picker): the file manager
	 * first, then every detected editor and terminal.
	 */
	async listWorkspaceOpeners(): Promise<WorkspaceOpener[]> {
		const editors = this.detectedEditors();
		const cache = this.openerCache!;
		cache.openers ??= (async () => {
			const detected = await editors;
			const openers: WorkspaceOpener[] = [{ id: 'explorer', kind: 'file-manager' }];
			for (const editor of detected) {
				openers.push({ id: editor.definition.id, name: editor.definition.name, kind: editor.definition.kind, icon: editor.iconPath ? await editorIcon(editor.iconPath) : undefined });
			}
			// VS Code reachable only through its CLI shim keeps its entry.
			if (!detected.some((editor) => editor.definition.id === 'vscode') && await this.vsCodeOnPath()) openers.splice(1, 0, { id: 'vscode', name: 'VS Code', kind: 'editor' });
			return openers;
		})();
		return cache.openers;
	}

	private async vsCodeOnPath(): Promise<boolean> {
		try {
			await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [process.platform === 'win32' ? 'code.cmd' : 'code'], { timeout: 5000, windowsHide: true });
			return true;
		} catch {
			return false;
		}
	}

	/** Opens the workspace root with a detected editor or terminal (ZCode editor launch). */
	async openWorkspaceWith(cwd: string, openerId: string): Promise<void> {
		if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !isAbsolute(cwd)) throw new Error('工作区路径无效');
		if (typeof openerId !== 'string' || !openerId || openerId === 'explorer') throw new Error('打开方式无效');
		if (cwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		const generation = this.commandGeneration;
		const root = await this.workspaceRoot(cwd);
		if (generation !== this.commandGeneration || cwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		const editor = (await this.detectedEditors()).find((item) => item.definition.id === openerId);
		if (editor) { await launchEditor(editor, root); return; }
		if (openerId !== 'vscode') throw new Error('未找到该应用，可能已被卸载，请刷新后重试');
		// Fallback: the `code` CLI must live on PATH.
		try {
			await runVsCodeCli([root]);
		} catch (error) {
			throw new Error(`未找到 VS Code，请安装后重试：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async openWorkspaceInVsCode(cwd: string): Promise<void> {
		await this.openWorkspaceWith(cwd, 'vscode');
	}

	/**
	 * Opens a file at an optional line (4.7 file:line jumps) in the preferred
	 * editor, falling back to VS Code. Terminals and the file manager never
	 * receive file jumps.
	 */
	async openPathInEditor(relativePath: string, line?: number, column?: number, editorId = 'vscode'): Promise<void> {
		const { path } = await this.resolveEntry(relativePath);
		const validLine = typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : undefined;
		const validColumn = validLine && typeof column === 'number' && Number.isSafeInteger(column) && column > 0 ? column : undefined;
		const editors = (await this.detectedEditors()).filter((item) => item.definition.kind === 'editor');
		const editor = editors.find((item) => item.definition.id === editorId) ?? editors.find((item) => item.definition.id === 'vscode');
		if (editor) { await launchEditor(editor, path, validLine, validColumn); return; }
		const target = validLine ? `${path}:${validLine}${validColumn ? `:${validColumn}` : ''}` : path;
		try {
			await runVsCodeCli(['-g', target]);
		} catch (error) {
			throw new Error(`未找到可用的代码编辑器，请安装 VS Code 等编辑器后重试：${error instanceof Error ? error.message : String(error)}`);
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

	/**
	 * Validate a single path segment for create/rename (4.6). Pure so tests can
	 * cover it directly: separators, forbidden characters, Windows reserved device
	 * names, control characters and trailing dots/spaces are all rejected.
	 */
	static validateEntryName(name: string): string {
		if (typeof name !== 'string' || name.length === 0) throw new Error('名称不能为空');
		if (name.length > 255) throw new Error('名称过长（最多 255 个字符）');
		if (name === '.' || name === '..') throw new Error('名称无效');
		if (/[\\/]/.test(name)) throw new Error('名称不能包含路径分隔符');
		if (/[<>:"|?*]/.test(name)) throw new Error('名称包含无效字符 <>:"|?*');
		if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('名称包含控制字符');
		if (/[. ]$/.test(name)) throw new Error('名称不能以点或空格结尾');
		const stem = name.replace(/\.[^.]*$/, '').toUpperCase();
		if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw new Error('名称与 Windows 保留设备名冲突');
		return name;
	}

	private async mutateGuard(generation: number, approvedCwd: string, root: string): Promise<void> {
		if (this.commandGeneration !== generation || this.getWorkspace() !== approvedCwd) throw new Error('工作区已切换，请重试');
		if (resolve(await this.workspaceRoot()) !== resolve(root)) throw new Error('工作区已切换，请重试');
	}

	/** Creates an empty file or folder inside a workspace directory (4.6). */
	async createEntry(parentRelativePath: string, name: string, kind: 'file' | 'directory'): Promise<void> {
		if (kind !== 'file' && kind !== 'directory') throw new Error('类型无效');
		WorkbenchService.validateEntryName(name);
		const generation = this.commandGeneration;
		const approvedCwd = this.getWorkspace();
		const { root, path: parent } = await this.resolveEntry(parentRelativePath);
		if (!(await stat(parent)).isDirectory()) throw new Error('目标不是文件夹');
		const target = resolve(parent, name);
		if (!isWithin(root, target)) throw new Error('目标不属于当前工作区');
		await this.mutateGuard(generation, approvedCwd, root);
		if (kind === 'directory') {
			try { await mkdir(target); }
			catch (error) { throw new Error(`创建文件夹失败：${error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST' ? '同名项目已存在' : error instanceof Error ? error.message : String(error)}`); }
		} else {
			let handle;
			try { handle = await open(target, 'wx'); }
			catch (error) { throw new Error(`创建文件失败：${error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST' ? '同名文件已存在' : error instanceof Error ? error.message : String(error)}`); }
			await handle.close();
		}
	}

	/** Renames a file or folder inside its directory (4.6). */
	async renameEntry(relativePath: string, newName: string): Promise<void> {
		WorkbenchService.validateEntryName(newName);
		const generation = this.commandGeneration;
		const approvedCwd = this.getWorkspace();
		const { root, path } = await this.resolveEntry(relativePath);
		const parent = resolve(path, '..');
		if (!isWithin(root, parent) || resolve(root) === resolve(path)) throw new Error('不能重命名工作区根目录');
		const target = resolve(parent, newName);
		if (!isWithin(root, target)) throw new Error('目标不属于当前工作区');
		if (resolve(target) === resolve(path)) return;
		// On case-insensitive file systems "readme.md" → "README.md" stats the
		// source itself; only a different file (another inode) is a conflict.
		const existing = await stat(target, { bigint: true }).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		});
		if (existing) {
			const source = await stat(path, { bigint: true });
			if (existing.ino !== source.ino || existing.dev !== source.dev) throw new Error('同名项目已存在');
		}
		await this.mutateGuard(generation, approvedCwd, root);
		try { await rename(path, target); }
			catch (error) { throw new Error(`重命名失败：${error instanceof Error ? error.message : String(error)}`); }
	}

	/** Moves a file or folder to the OS trash; the renderer confirms first (4.6). */
	async deleteEntry(relativePath: string, trash: (path: string) => Promise<void>): Promise<void> {
		const generation = this.commandGeneration;
		const approvedCwd = this.getWorkspace();
		const { root, path } = await this.resolveEntry(relativePath);
		if (resolve(root) === resolve(path)) throw new Error('不能删除工作区根目录');
		await this.mutateGuard(generation, approvedCwd, root);
		try { await trash(path); }
		catch (error) { throw new Error(`移入回收站失败：${error instanceof Error ? error.message : String(error)}`); }
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
		const [branchResult, statusResult, tracking] = await Promise.all([
			execFileAsync('git', [...prefix, 'branch', '--show-current'], { timeout: 8000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV }),
			this.gitReadOutput([...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], MAX_GIT_STATUS_BYTES),
			this.gitTracking(prefix),
		]);
		const entries = this.parseGitStatus(statusResult.stdout, root, repositoryRoot);
		return { isRepository: true, branch: branchResult.stdout.trim() || null, entries, ...tracking, ...(statusResult.truncated ? { truncated: true } : {}) };
	}

	/** Upstream and ahead/behind from local refs only (no network); failures degrade to "no upstream". */
	private async gitTracking(prefix: string[]): Promise<Pick<WorkspaceGitStatus, 'upstream' | 'ahead' | 'behind' | 'hasRemote'>> {
		const options = { timeout: 8000, maxBuffer: 64 * 1024, env: SAFE_GIT_ENV };
		const [upstream, remotes] = await Promise.all([
			execFileAsync('git', [...prefix, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], options).then((result) => result.stdout.trim() || null, () => null),
			execFileAsync('git', [...prefix, 'remote'], options).then((result) => result.stdout.split('\n').map((line) => line.trim()).filter(Boolean), () => [] as string[]),
		]);
		if (!upstream) return { upstream: null, ahead: 0, behind: 0, hasRemote: remotes.length > 0 };
		const counts = await execFileAsync('git', [...prefix, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], options).then((result) => result.stdout.trim().split(/\s+/).map(Number), () => [0, 0]);
		return { upstream, ahead: Number.isFinite(counts[0]) ? counts[0]! : 0, behind: Number.isFinite(counts[1]) ? counts[1]! : 0, hasRemote: true };
	}

	/**
	 * Network sync for the current branch (ZCode git action menu). Pull is
	 * fast-forward only so it never creates merge commits or conflicts; the first
	 * push of a branch without an upstream sets it on origin (or the only remote).
	 * Credential prompts cannot block: the terminal prompt is disabled, while
	 * GUI credential helpers (Git Credential Manager) still work.
	 */
	async gitSync(action: 'fetch' | 'pull' | 'push'): Promise<void> {
		if (action !== 'fetch' && action !== 'pull' && action !== 'push') throw new Error('Git 同步操作无效');
		const generation = this.commandGeneration;
		const approvedCwd = this.getWorkspace();
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		const tracking = await this.gitTracking(prefix);
		let args: string[];
		if (action === 'fetch') args = ['fetch', '--prune'];
		else if (action === 'pull') {
			if (!tracking.upstream) throw new Error('当前分支没有上游分支，无法拉取');
			args = ['pull', '--ff-only', '--no-rebase'];
		} else if (tracking.upstream) args = ['push'];
		else {
			const branch = (await execFileAsync('git', [...prefix, 'branch', '--show-current'], { timeout: 8000, env: SAFE_GIT_ENV })).stdout.trim();
			if (!branch) throw new Error('分离 HEAD 状态无法推送，请先切换到分支');
			const remotes = (await execFileAsync('git', [...prefix, 'remote'], { timeout: 8000, env: SAFE_GIT_ENV })).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
			const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null;
			if (!remote) throw new Error(remotes.length ? '有多个远程仓库，请在终端中指定推送目标' : '没有配置远程仓库，无法推送');
			args = ['push', '--set-upstream', remote, 'HEAD'];
		}
		if (generation !== this.commandGeneration || approvedCwd !== this.getWorkspace()) throw new Error('工作区已切换，请重试');
		try {
			await execFileAsync('git', [...prefix, ...args], { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...SAFE_GIT_ENV, GIT_TERMINAL_PROMPT: '0' } });
		} catch (error) {
			const detail = WorkbenchService.execDetail(error);
			const label = action === 'fetch' ? '获取' : action === 'pull' ? '拉取' : '推送';
			if (/Not possible to fast-forward|diverging branches|not possible because you have unmerged/i.test(detail)) throw new Error(`${label}失败：本地与远程分支已分叉，无法快进合并。请在终端中合并或变基后再试。`);
			if (/rejected|non-fast-forward|fetch first/i.test(detail)) throw new Error(`${label}失败：远程有本地没有的提交，请先拉取。\n${detail}`);
			if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey\)/i.test(detail)) throw new Error(`${label}失败：需要身份验证。请先在终端中完成一次 Git 登录或配置凭据管理器。\n${detail}`);
			throw new Error(`${label}失败：${detail}`);
		}
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
	async gitCheckout(branch: string): Promise<WorkspaceGitCheckoutResult> {
		if (typeof branch !== 'string' || branch.length === 0 || branch.length > 250 || branch.includes('\0')) throw new Error('无效的分支名');
		const listed = await this.gitBranches();
		if (!listed.isRepository) throw new Error('当前工作区不是 git 仓库');
		if (!listed.branches.includes(branch)) throw new Error('分支不存在');
		if (listed.current === branch) return { ok: true, branch, previous: listed.current, didChange: false };
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		if (resolve(root) !== resolve(await this.workspaceRoot())) throw new Error('工作区已切换，请重试');
		try {
			// `git switch` has no pathspec semantics; names are whitelisted against real refs.
			await execFileAsync('git', [...prefix, 'switch', branch], { timeout: 30000, maxBuffer: 1024 * 1024, env: SAFE_GIT_ENV });
			return { ok: true, branch, previous: listed.current, didChange: true };
		} catch (error) {
			const raw = error instanceof Error ? (error as ExecFileException).stderr : undefined;
			const detail = (typeof raw === 'string' ? raw : undefined)?.trim() || (error instanceof Error ? error.message : String(error));
			return { ok: false, branch, previous: listed.current, issue: parseCheckoutFailure(detail) };
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

	/**
	 * Commit history with parent topology and local refs for the git graph.
	 * Runs one bounded log plus for-each-ref; both fail soft to an empty graph.
	 */
	async gitGraph(limit = 60): Promise<WorkspaceGitGraphCommit[]> {
		const capped = Math.min(Math.max(Math.trunc(limit) || 60, 1), 200);
		const root = await this.workspaceRoot();
		const prefix = this.gitPrefix(root);
		try {
			const output = (await execFileAsync('git', [...prefix, 'log', `-n${capped}`, '--pretty=format:%H%x1f%h%x1f%<(200,trunc)%an%x1f%aI%x1f%P%x1f%<(1000,trunc)%s'], { timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: SAFE_GIT_ENV })).stdout;
			const commits: WorkspaceGitGraphCommit[] = output.split('\n').filter((line) => line.trim()).map((line) => {
				const [hash, shortHash, author, date, parents, ...subject] = line.split('\x1f');
				return { hash: hash ?? '', shortHash: shortHash ?? '', author: author?.trimEnd() ?? '', date: date ?? '',
					parents: parents ? parents.trim().split(' ').filter(Boolean) : [], subject: subject.join('\x1f').trimEnd(), refs: [] };
			});
			// Local branch tips and HEAD decorate the matching hashes.
			const refs = new Map<string, string[]>();
			const addRef = (hash: string, label: string): void => { const list = refs.get(hash) ?? []; list.push(label); refs.set(hash, list); };
			for (const line of (await execFileAsync('git', [...prefix, 'for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads'], { timeout: 8000, maxBuffer: 256 * 1024, env: SAFE_GIT_ENV })).stdout.split('\n')) {
				const [hash, ...name] = line.trim().split(' ');
				if (hash && name.length) addRef(hash, name.join(' '));
			}
			try {
				const head = (await execFileAsync('git', [...prefix, 'rev-parse', 'HEAD'], { timeout: 8000, maxBuffer: 256, env: SAFE_GIT_ENV })).stdout.trim();
				// HEAD leads its commit's labels, ahead of the branch names.
				if (head) refs.set(head, ['HEAD', ...(refs.get(head) ?? [])]);
			} catch { /* unborn HEAD keeps plain refs */ }
			for (const commit of commits) commit.refs = (refs.get(commit.hash) ?? []).slice(0, 8);
			return commits;
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
