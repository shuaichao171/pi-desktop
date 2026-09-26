/** Read-only search runs in the agent utility process, never in Electron's UI host. */
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { UiAttachment, UiSessionSearchResult, WorkspaceEntry } from '@pidesktop/shared';

const RESULT_LIMIT = 80;
const SCAN_LIMIT = 20_000;
const SESSION_LIMIT = 5_000;
const SESSION_BYTES_LIMIT = 64 * 1024 * 1024;
const TOTAL_BYTES_LIMIT = 256 * 1024 * 1024;
const SEARCH_TIME_LIMIT = 8_000;
const TEXT_LIMIT = 512_000;
const SESSION_TEXT_LIMIT = 4 * 1024 * 1024;
const SESSION_CONTEXT_LIMIT = 100_000;
const TEXT_ATTACHMENT_MARKER = '\n\n<!-- pi-desktop:attachments-v1 -->\n';
const IGNORED_DIRECTORIES = new Set([
	'.git', '.hg', '.svn', 'node_modules', '.pnpm', '.yarn', '.next', '.nuxt',
	'.cache', '__pycache__', '.venv',
]);

function termsFor(query: string): string[] {
	if (typeof query !== 'string' || query.length > 500 || query.includes('\0')) throw new Error('搜索内容无效或过长');
	return [...new Set(query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean))];
}

function within(root: string, path: string): boolean {
	const value = relative(root, path);
	return !value || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function missing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function sessionDirectory(root: string, cwd: string): string {
	// Matches Pi's default session storage; no workspace contents are scanned.
	return join(root, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

export type SearchMessage = { id?: string; text: string; role: 'user' | 'assistant'; truncated?: boolean; branchLeafId?: string };
export type BranchEntry = { parentId: string | null; message?: SearchMessage };
export type ParsedSession = { summary: UiSessionSearchResult; messages: SearchMessage[]; otherMessages: SearchMessage[]; branchLeafId?: string; nodes: Array<[string, BranchEntry]>; truncated: boolean; incomplete: boolean };

class SearchLimitError extends Error {
	constructor() { super('会话超过搜索大小或时间限制'); }
}

function latestText(text: string, limit: number): string {
	if (limit <= 0) return '';
	// Do not split a surrogate pair at the truncation boundary.
	return text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, '');
}

function visibleText(message: Record<string, unknown>): string {
	const content = message.content;
	const text = typeof content === 'string' ? content
		: Array.isArray(content) ? content
			.filter((part): part is { type: 'text'; text: string } => !!part && part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text).join(message.role === 'user' ? '\n' : '') : '';
	return message.role === 'user' ? text.split(TEXT_ATTACHMENT_MARKER, 1)[0] ?? '' : text;
}

export async function readSessionForIndex(path: string, cwd: string, cancelled: () => boolean, context = false): Promise<ParsedSession | null> {
	const file = await open(path, 'r');
	try {
		const details = await file.stat();
		if (!details.isFile()) return null;
		if (details.size > SESSION_BYTES_LIMIT) throw new SearchLimitError();
		const input = file.createReadStream({ autoClose: false, end: SESSION_BYTES_LIMIT });
		const lines = createInterface({ input, crlfDelay: Infinity });
		let header: Record<string, unknown> | undefined;
		let name: string | undefined;
		let leaf: string | null = null;
		let modified = 0;
		let messageCount = 0;
		let truncated = false;
		let incomplete = false;
		let textLength = 0;
		const entries = new Map<string, BranchEntry>();
		try {
			for await (const line of lines) {
				if (cancelled() || entries.size > 100_000) throw new SearchLimitError();
				let entry: Record<string, unknown>;
				try { entry = JSON.parse(line); } catch { incomplete = true; continue; }
				if (!entry || typeof entry !== 'object') continue;
				if (!header) {
					if (entry.type !== 'session' || typeof entry.id !== 'string') return null;
					if (typeof entry.cwd !== 'string' || relative(resolve(entry.cwd), resolve(cwd)) !== '') return null;
					header = entry;
					continue;
				}
				if (entry.type === 'session') continue;
				if (entry.type === 'session_info') name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 500) || undefined : undefined;
				const legacy = typeof header.version !== 'number' || header.version < 2;
				const id = typeof entry.id === 'string' ? entry.id : legacy ? `legacy-${entries.size}` : undefined;
				if (!id) continue;
				const node: BranchEntry = { parentId: legacy ? leaf : typeof entry.parentId === 'string' ? entry.parentId : null };
				if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
					messageCount += 1;
					const message = entry.message as Record<string, unknown>;
					if (message.role === 'user' || message.role === 'assistant') {
						const time = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(String(entry.timestamp));
						if (Number.isFinite(time)) modified = Math.max(modified, time);
						const fullText = visibleText(message);
						// A context export retains the end of each message; applying the search
						// budget here would discard newer turns before choosing the visible branch.
						const text = context ? latestText(fullText, SESSION_CONTEXT_LIMIT)
							: fullText.slice(0, Math.max(0, Math.min(TEXT_LIMIT, SESSION_TEXT_LIMIT - textLength)));
						textLength += text.length;
						if (!context && fullText.length > text.length) truncated = true;
						node.message = { id: legacy ? undefined : id, role: message.role, text,
							...(context && fullText.length > text.length ? { truncated: true } : {}) };
					}
				}
				entries.set(id, node);
				leaf = id;
			}
		} finally {
			lines.close();
			input.destroy();
		}
		if (!header) return null;
		const branchLeafId = leaf ?? undefined;
		const messages: SearchMessage[] = [];
		const visited = new Set<string>();
		while (leaf) {
			if (visited.has(leaf)) { incomplete = true; break; }
			visited.add(leaf);
			const node = entries.get(leaf);
			if (!node) break;
			if (node.message) {
				messages.push(node.message);
				if (node.message.truncated) truncated = true;
			}
			leaf = node.parentId;
		}
		messages.reverse();
		const otherMessages: SearchMessage[] = [];
		if (!context) {
			const parents = new Set([...entries.values()].map((entry) => entry.parentId).filter(Boolean));
			const assigned = new Set(visited);
			for (const candidate of entries.keys()) {
				if (parents.has(candidate)) continue;
				let next: string | null = candidate;
				while (next && !assigned.has(next)) {
					assigned.add(next);
					const node = entries.get(next);
					if (!node) break;
					if (node.message) otherMessages.push({ ...node.message, branchLeafId: candidate });
					next = node.parentId;
				}
			}
		}
		const timestamp = modified || Date.parse(String(header.timestamp)) || details.mtimeMs;
		return {
			summary: { path, cwd, id: header.id as string, name, firstMessage: messages.find((message) => message.role === 'user')?.text.slice(0, 500) ?? '', modified: new Date(timestamp).toISOString(), messageCount },
			messages,
			otherMessages, branchLeafId, nodes: context ? [] : [...entries],
			truncated,
			incomplete,
		};
	} finally { await file.close(); }
}

/** Export only visible user/assistant text. Never open through SessionManager,
 * which can migrate a legacy history file as a side effect. */
export async function readSessionContext(sessionsRoot: string, cwd: string, path: string): Promise<UiAttachment> {
	if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('会话路径无效');
	const root = await realpath(sessionsRoot);
	const directory = sessionDirectory(resolve(sessionsRoot), cwd);
	const realDirectory = await realpath(directory);
	if ((await lstat(directory)).isSymbolicLink() || !within(root, realDirectory)
		|| !within(resolve(directory), resolve(path)) || (await lstat(path)).isSymbolicLink()
		|| !within(realDirectory, await realpath(path))) throw new Error('会话不属于此工作区');
	const started = Date.now();
	const parsed = await readSessionForIndex(path, cwd, () => Date.now() - started > SEARCH_TIME_LIMIT, true);
	if (!parsed) throw new Error('无法读取会话正文，历史文件无效、过大或读取超时');
	const title = (parsed.summary.name || parsed.summary.firstMessage.split(/\r?\n/u)[0] || 'Conversation').slice(0, 180).replace(/[\uD800-\uDBFF]$/u, '');
	const header = `Referenced conversation: ${JSON.stringify(title)}\nWorkspace: ${JSON.stringify(cwd)}\nSession: ${JSON.stringify(path)}\nThe following is quoted user/assistant conversation context.\n\n`;
	const notice = '[Conversation truncated: only the most recent visible text is included.]\n\n';
	// Build backwards within the limit instead of joining a potentially large tree.
	let body = '';
	let truncated = parsed.truncated || parsed.incomplete;
	const bodyLimit = Math.max(0, SESSION_CONTEXT_LIMIT - header.length - notice.length);
	for (let index = parsed.messages.length - 1; index >= 0; index -= 1) {
		const message = parsed.messages[index]!;
		if (!message.text.trim()) continue;
		const block = `[${message.role === 'user' ? 'User' : 'Assistant'}]\n${message.text}\n\n`;
		if (body.length + block.length > bodyLimit) {
			const remaining = Math.max(0, bodyLimit - body.length);
			const label = `[${message.role === 'user' ? 'User' : 'Assistant'}; earlier text omitted]\n`;
			if (remaining > label.length) body = `${label}${latestText(block, remaining - label.length)}${body}`;
			truncated = true;
			break;
		}
		body = block + body;
	}
	return {
		kind: 'text', name: `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.txt`, mimeType: 'text/x-pi-session-context',
		text: header + (truncated ? notice : '') + body,
		source: { kind: 'session', workspace: cwd, path, ...(truncated ? { truncated: true } : {}) },
	};
}

function snippet(text: string, terms: string[]): string {
	const normalized = text.replace(/\s+/gu, ' ').trim();
	const lower = normalized.toLocaleLowerCase();
	const matches = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
	const start = Math.max(0, (matches.length ? Math.min(...matches) : 0) - 65);
	return `${start ? '…' : ''}${normalized.slice(start, start + 220)}${normalized.length > start + 220 ? '…' : ''}`;
}

let sessionSearchGeneration = 0;

export async function searchSessionsUncached(sessionsRoot: string, workspaces: string[], query: string): Promise<{ sessions: UiSessionSearchResult[]; truncated: boolean; skipped?: number }> {
	const terms = termsFor(query);
	if (!Array.isArray(workspaces) || workspaces.some((cwd) => typeof cwd !== 'string' || !isAbsolute(cwd))) throw new Error('工作区路径无效');
	const generation = ++sessionSearchGeneration;
	const started = Date.now();
	const cancelled = (): boolean => generation !== sessionSearchGeneration || Date.now() - started > SEARCH_TIME_LIMIT;
	let root: string;
	try { root = await realpath(sessionsRoot); } catch (error) { if (missing(error)) return { sessions: [], truncated: false }; throw error; }
	const candidates: { path: string; cwd: string; modified: number; size: number }[] = [];
	let truncated = false;
	let skipped = 0;
	for (const cwd of [...new Set(workspaces)]) {
		if (cancelled() || candidates.length >= SESSION_LIMIT) { truncated = true; break; }
		// Preserve Pi's configured path spelling in results: switchSession checks
		// membership against SessionManager.list(), which may use a symlinked root.
		const directoryPath = sessionDirectory(resolve(sessionsRoot), cwd);
		let realDirectory: string;
		let directory: Awaited<ReturnType<typeof opendir>>;
		try {
			realDirectory = await realpath(directoryPath);
			if ((await lstat(directoryPath)).isSymbolicLink() || !within(root, realDirectory)) continue;
			directory = await opendir(directoryPath);
		} catch (error) { if (!missing(error)) skipped += 1; continue; }
		for await (const entry of directory) {
			if (cancelled() || candidates.length >= SESSION_LIMIT) { truncated = true; break; }
			if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
			const path = join(directoryPath, entry.name);
			try {
				const details = await lstat(path);
				if (!details.isFile() || !within(realDirectory, await realpath(path))) continue;
				candidates.push({ path, cwd, modified: details.mtimeMs, size: details.size });
			} catch { skipped += 1; }
		}
	}
	// Most recently changed files are scanned first when a large collection reaches a budget.
	candidates.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
	const sessions: UiSessionSearchResult[] = [];
	let bytes = 0;
	for (const candidate of candidates) {
		if (candidate.size > SESSION_BYTES_LIMIT) { truncated = true; continue; }
		if (cancelled() || bytes + candidate.size > TOTAL_BYTES_LIMIT) { truncated = true; break; }
		bytes += candidate.size;
		let parsed: ParsedSession | null;
		try { parsed = await readSessionForIndex(candidate.path, candidate.cwd, cancelled); }
		catch (error) { if (error instanceof SearchLimitError) truncated = true; else skipped += 1; continue; }
		if (!parsed) { skipped += 1; continue; }
		if (parsed.incomplete) skipped += 1;
		truncated ||= parsed.truncated;
		const title = `${parsed.summary.name ?? ''}\n${parsed.summary.firstMessage}`.toLocaleLowerCase();
		const body = parsed.messages.map((message) => ({ message, lower: message.text.toLocaleLowerCase() }));
		if (terms.some((term) => !title.includes(term) && !body.some(({ lower }) => lower.includes(term)))) continue;
		const match = terms.length ? body.find(({ lower }) => terms.every((term) => lower.includes(term)))
			?? body.find(({ lower }) => terms.some((term) => lower.includes(term))) : undefined;
		sessions.push({ ...parsed.summary, ...(match ? { snippet: snippet(match.message.text, terms), messageId: match.message.id } : {}) });
	}
	sessions.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified) || a.path.localeCompare(b.path));
	return { sessions: sessions.slice(0, RESULT_LIMIT), truncated: truncated || sessions.length > RESULT_LIMIT, ...(skipped ? { skipped } : {}) };
}

let fileSearchGeneration = 0;

export async function searchWorkspaceFilesUncached(cwd: string, query: string, options?: { includeDirectories?: boolean }): Promise<{ files: WorkspaceEntry[]; truncated: boolean; skipped?: number; ignoredDirectories: string[] }> {
	const terms = termsFor(query);
	if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
		|| Object.keys(options).some((key) => key !== 'includeDirectories')
		|| (options.includeDirectories !== undefined && typeof options.includeDirectories !== 'boolean'))) throw new Error('文件搜索选项无效');
	const includeDirectories = options?.includeDirectories === true;
	if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) throw new Error('请先打开工作区');
	const generation = ++fileSearchGeneration;
	const started = Date.now();
	const root = await realpath(cwd);
	if (!(await stat(root)).isDirectory()) throw new Error('工作区不是文件夹');
	const pending = [root];
	const visited = new Set<string>();
	const files: WorkspaceEntry[] = [];
	let scanned = 0;
	let truncated = false;
	let skipped = 0;
	while (pending.length) {
		if (generation !== fileSearchGeneration || Date.now() - started > SEARCH_TIME_LIMIT) { truncated = true; break; }
		const path = pending.shift()!;
		let directory: Awaited<ReturnType<typeof opendir>>;
		try {
			const resolved = await realpath(path);
			if (!within(root, resolved) || visited.has(resolved) || (await lstat(path)).isSymbolicLink()) continue;
			visited.add(resolved);
			directory = await opendir(path);
		} catch { skipped += 1; continue; }
		for await (const entry of directory) {
			if (++scanned > SCAN_LIMIT || generation !== fileSearchGeneration || Date.now() - started > SEARCH_TIME_LIMIT) { truncated = true; break; }
			if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				if (IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) continue;
				pending.push(child);
				if (!includeDirectories) continue;
			}
			const relativePath = relative(root, child).split(sep).join('/');
			const normalized = relativePath.toLocaleLowerCase();
			if (!terms.every((term) => normalized.includes(term.replace(/\\/g, '/')))) continue;
			try {
				const details = await lstat(child);
				if (details.isSymbolicLink() || (entry.isDirectory() ? !details.isDirectory() : !details.isFile()) || !within(root, await realpath(child))) continue;
				files.push({ name: entry.name, path: relativePath, kind: entry.isDirectory() ? 'directory' : 'file', ...(details.isFile() ? { size: details.size } : {}) });
			} catch { skipped += 1; }
			if (files.length > RESULT_LIMIT) { truncated = true; break; }
		}
		if (scanned > SCAN_LIMIT || files.length > RESULT_LIMIT) break;
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files: files.slice(0, RESULT_LIMIT), truncated, ...(skipped ? { skipped } : {}), ignoredDirectories: [...IGNORED_DIRECTORIES] };
}

// Compatibility entrypoints share the same cache/rules as the richer search UI.
export { searchSessions, searchWorkspaceFiles, searchSessionsPage, searchProjectFiles, rebuildSearchIndex, cancelDataSearch, setProjectSearchRules, getProjectSearchRules } from './indexedSearch.ts';
