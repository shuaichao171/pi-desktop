import { createHash, randomUUID } from 'node:crypto';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IndexedSessionResult, ProjectSearchMatch, ProjectSearchPage, ProjectSearchRequest, ProjectSearchRules, RecoverableSessionMetadata, SessionSearchPage, SessionSearchRequest } from '../../../shared/src/dataFeatures';
import { readSessionForIndex, type ParsedSession, type SearchMessage } from './searchService.ts';
import { writeStateFileAsync } from './stateFiles.ts';

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_TIME = 8000;
const DEFAULT_RULES: ProjectSearchRules = {
	ignoredDirectories: ['.git', '.hg', '.svn', 'node_modules', '.pnpm', '.yarn', '.next', '.nuxt', '.cache', '__pycache__', '.venv'],
	include: [], exclude: [], maxFileBytes: 2 * 1024 * 1024,
};
const rulesByWorkspace = new Map<string, ProjectSearchRules>();
const generations = { sessions: 0, files: 0 };
const cancelledIds = new Set<string>();
export function cancelDataSearch(id: string): void {
	if (typeof id !== 'string' || id.length > 200) throw new Error('搜索请求编号无效');
	cancelledIds.add(id);
	if (cancelledIds.size > 1000) cancelledIds.delete(cancelledIds.values().next().value!);
}
function begin(kind: keyof typeof generations, requestId?: string) {
	if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 200)) throw new Error('搜索请求编号无效');
	const generation = ++generations[kind], started = Date.now();
	return { started, cancelled: () => generations[kind] !== generation || !!requestId && cancelledIds.has(requestId) || Date.now() - started > MAX_TIME };
}
function queryTerms(query: unknown, sensitive = false): string[] {
	if (typeof query !== 'string' || query.length > 500 || query.includes('\0')) throw new Error('搜索内容无效或过长');
	return [...new Set((sensitive ? query : query.toLocaleLowerCase()).trim().split(/\s+/u).filter(Boolean))];
}
function within(root: string, path: string): boolean { const value = relative(root, path); return !value || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); }
export function piSessionDirectory(root: string, cwd: string): string { return join(root, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function snippet(text: string, terms: string[]): string {
	const normalized = text.replace(/\s+/gu, ' ').trim(), lower = normalized.toLocaleLowerCase();
	const offsets = terms.map((term) => lower.indexOf(term.toLocaleLowerCase())).filter((index) => index >= 0);
	const start = Math.max(0, (offsets.length ? Math.min(...offsets) : 0) - 65);
	return `${start ? '…' : ''}${normalized.slice(start, start + 220)}${normalized.length > start + 220 ? '…' : ''}`;
}
type Snapshot = { key: string; created: number; results: unknown[]; extra: Record<string, unknown> };
const snapshots = new Map<string, Snapshot>();
function page<T>(key: string, results: T[], extra: Record<string, unknown>, cursor?: string, limit = 80): { results: T[]; nextCursor?: string; total: number; extra: Record<string, unknown> } {
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('分页大小须为 1–200');
	let id = randomUUID(), offset = 0;
	if (cursor) {
		try {
			const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
			id = decoded.id; offset = decoded.offset;
			if (typeof id !== 'string' || !Number.isSafeInteger(offset) || offset < 0) throw new Error();
		} catch { throw new Error('分页游标无效，请重新搜索'); }
		const saved = snapshots.get(id);
		if (!saved || saved.key !== key || Date.now() - saved.created > 300_000) throw new Error('搜索结果已过期，请重新搜索');
		results = saved.results as T[]; extra = saved.extra;
	} else {
		for (const [oldId, saved] of snapshots) if (Date.now() - saved.created > 300_000) snapshots.delete(oldId);
		while (snapshots.size >= 20) snapshots.delete(snapshots.keys().next().value!);
		snapshots.set(id, { key, results, extra, created: Date.now() });
	}
	const next = offset + limit;
	return { results: results.slice(offset, next), total: results.length, extra,
		...(next < results.length ? { nextCursor: Buffer.from(JSON.stringify({ id, offset: next })).toString('base64url') } : {}) };
}

type CachedSession = { fingerprint: string; parsed: ParsedSession | null; oversized?: boolean };
type SessionCache = { entries: Map<string, CachedSession>; loaded: boolean; revision: number; save: Promise<void> };
const sessionCaches = new Map<string, SessionCache>();
function validParsed(value: unknown): value is ParsedSession {
	if (!value || typeof value !== 'object') return false;
	const parsed = value as ParsedSession;
	return !!parsed.summary && typeof parsed.summary.path === 'string' && typeof parsed.summary.cwd === 'string'
		&& typeof parsed.summary.id === 'string' && typeof parsed.summary.firstMessage === 'string' && typeof parsed.summary.modified === 'string'
		&& Array.isArray(parsed.nodes) && parsed.nodes.every((node) => Array.isArray(node) && typeof node[0] === 'string' && !!node[1] && (typeof node[1].parentId === 'string' || node[1].parentId === null) && (!node[1].message || typeof node[1].message.text === 'string'))
		&& [parsed.messages, parsed.otherMessages].every((list) => Array.isArray(list) && list.every((item) => !!item && typeof item.text === 'string' && ['user', 'assistant'].includes(item.role)));
}
async function cacheFor(root: string): Promise<SessionCache> {
	let cache = sessionCaches.get(root);
	if (!cache) { cache = { entries: new Map(), loaded: false, revision: 0, save: Promise.resolve() }; sessionCaches.set(root, cache); }
	if (!cache.loaded) {
		cache.loaded = true;
		try {
			const path = join(root, '.desktop-search-v1.json');
			if ((await stat(path)).size > MAX_SCAN_BYTES) throw new Error('oversized index');
			const value = JSON.parse(await readFile(path, 'utf8'));
			if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1].fingerprint === 'string' && (entry[1].parsed === null || validParsed(entry[1].parsed)))) throw new Error('invalid index');
			cache.entries = new Map(value.entries);
		} catch { cache.entries.clear(); /* Index is disposable; original sessions are untouched. */ }
	}
	return cache;
}
export async function rebuildSearchIndex(root: string, workspaces: string[]): Promise<{ indexed: number }> {
	sessionCaches.delete(resolve(root));
	const cache: SessionCache = { entries: new Map(), loaded: true, revision: 0, save: Promise.resolve() };
	sessionCaches.set(resolve(root), cache);
	const result = await searchSessionsPage(root, workspaces, { query: '', limit: 1 });
	return { indexed: result.diagnostics.indexed };
}
export async function searchSessionsPage(sessionsRoot: string, workspaces: string[], request: SessionSearchRequest, metadata: Record<string, RecoverableSessionMetadata> = {}, currentBranchHeads: Record<string, string | null> = {}, excludedPaths: string[] = []): Promise<SessionSearchPage> {
	if (!request || typeof request !== 'object') throw new Error('搜索参数无效');
	const terms = queryTerms(request.query), token = begin('sessions', request.requestId);
	if (!Array.isArray(workspaces) || workspaces.some((cwd) => typeof cwd !== 'string' || !isAbsolute(cwd))) throw new Error('工作区路径无效');
	if (request.workspace !== undefined && !workspaces.includes(request.workspace)) throw new Error('未知搜索工作区');
	if (request.archived !== undefined && !['all', 'exclude', 'only'].includes(request.archived)) throw new Error('归档筛选无效');
	for (const value of [request.after, request.before]) if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new Error('搜索日期无效');
	if (!Array.isArray(excludedPaths) || excludedPaths.some((path) => typeof path !== 'string')) throw new Error('搜索排除路径无效');
	const excluded = new Set(excludedPaths);
	const key = digest([resolve(sessionsRoot), workspaces, { ...request, requestId: undefined, cursor: undefined, limit: undefined }, [...excluded].sort()]);
	const diagnostics = { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 };
	if (request.cursor) {
		const result = page<IndexedSessionResult>(key, [], {}, request.cursor, request.limit);
		return { sessions: result.results, total: result.total, nextCursor: result.nextCursor, truncated: !!result.nextCursor || !!result.extra.truncated, skipped: result.extra.skipped as number | undefined, diagnostics };
	}
	let realRoot: string;
	try { realRoot = await realpath(sessionsRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], total: 0, truncated: false, diagnostics }; throw error; }
	const cache = await cacheFor(resolve(sessionsRoot)), live = new Set<string>();
	let dirty = false, truncated = false, skipped = 0;
	const results: IndexedSessionResult[] = [];
	for (const cwd of [...new Set(workspaces)]) {
		if (request.workspace && request.workspace !== cwd) continue;
		const directoryPath = piSessionDirectory(resolve(sessionsRoot), cwd);
		let directory: Awaited<ReturnType<typeof opendir>>;
		try { if ((await lstat(directoryPath)).isSymbolicLink() || !within(realRoot, await realpath(directoryPath))) continue; directory = await opendir(directoryPath); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped++; continue; }
		for await (const entry of directory) {
			if (token.cancelled() || live.size >= 5000) { truncated = true; break; }
			if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
			const path = join(directoryPath, entry.name); live.add(path);
			if (excluded.has(path)) continue;
			let cached: CachedSession | undefined;
			try {
				const details = await lstat(path);
				if (!details.isFile() || details.isSymbolicLink() || !within(realRoot, await realpath(path))) continue;
				const fingerprint = `${cwd}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
				cached = cache.entries.get(path);
				if (cached?.fingerprint !== fingerprint) {
					if (details.size > MAX_SESSION_BYTES) cached = { fingerprint, parsed: null, oversized: true };
					else {
						if (diagnostics.bytesRead + details.size > MAX_SCAN_BYTES) { truncated = true; break; }
						diagnostics.filesRead++; diagnostics.bytesRead += details.size;
						cached = { fingerprint, parsed: await readSessionForIndex(path, cwd, token.cancelled) };
					}
					cache.entries.set(path, cached); dirty = true;
				}
			} catch { skipped++; continue; }
			if (cached.oversized) { truncated = true; continue; }
			let parsed = cached.parsed;
			if (!parsed || parsed.summary.cwd !== cwd || parsed.summary.path !== path) { skipped++; continue; }
			if (Object.hasOwn(currentBranchHeads, path) && currentBranchHeads[path] !== parsed.branchLeafId) {
				const nodes = new Map(parsed.nodes), seen = new Set<string>(), messages: SearchMessage[] = [];
				let cursor = currentBranchHeads[path];
				while (cursor && !seen.has(cursor)) { seen.add(cursor); const node = nodes.get(cursor); if (!node) break; if (node.message) messages.unshift(node.message); cursor = node.parentId; }
				const parents = new Set([...nodes.values()].map((node) => node.parentId)), otherMessages: SearchMessage[] = [];
				for (const candidate of nodes.keys()) {
					if (parents.has(candidate)) continue;
					let next: string | null = candidate;
					while (next && !seen.has(next)) { seen.add(next); const node = nodes.get(next); if (!node) break; if (node.message) otherMessages.push({ ...node.message, branchLeafId: candidate }); next = node.parentId; }
				}
				parsed = { ...parsed, messages, otherMessages, branchLeafId: currentBranchHeads[path] ?? undefined,
					summary: { ...parsed.summary, firstMessage: messages.find((message) => message.role === 'user')?.text.slice(0, 500) ?? '' } };
			}
			diagnostics.indexed++; truncated ||= parsed.truncated; if (parsed.incomplete) skipped++;
			const meta = metadata[path] ?? {}, date = Date.parse(parsed.summary.modified);
			if (request.after && date < Date.parse(request.after) || request.before && date > Date.parse(request.before)
				|| request.archived === 'only' && !meta.archived || request.archived === 'exclude' && meta.archived) continue;
			const title = `${parsed.summary.name ?? ''}\n${parsed.summary.firstMessage}`.toLocaleLowerCase();
			const body = parsed.messages.map((message) => ({ message, lower: message.text.toLocaleLowerCase() }));
			if (terms.every((term) => title.includes(term) || body.some(({ lower }) => lower.includes(term)))) {
				const match = terms.length ? body.find(({ lower }) => terms.every((term) => lower.includes(term))) ?? body.find(({ lower }) => terms.some((term) => lower.includes(term))) : undefined;
				results.push({ ...parsed.summary, ...meta, resultId: `${path}:current`, branchLeafId: parsed.branchLeafId,
					...(match ? { messageId: match.message.id, snippet: snippet(match.message.text, terms) } : {}) });
			}
			if (request.otherBranches && terms.length) for (const message of parsed.otherMessages) {
				if (!terms.every((term) => message.text.toLocaleLowerCase().includes(term))) continue;
				results.push({ ...parsed.summary, ...meta, resultId: `${path}:${message.id}`, otherBranch: true, branchLeafId: message.branchLeafId,
					messageId: message.id, snippet: snippet(message.text, terms) });
			}
		}
	}
	if (token.cancelled()) return { sessions: [], total: 0, truncated: true, cancelled: true, diagnostics: { ...diagnostics, elapsedMs: Date.now() - token.started } };
	if (!truncated && !request.workspace) for (const path of cache.entries.keys()) if (!live.has(path)) { cache.entries.delete(path); dirty = true; }
	if (dirty) {
		const payload = { version: 1, entries: [...cache.entries] }; cache.revision++;
		cache.save = cache.save.catch(() => {}).then(() => writeStateFileAsync(join(resolve(sessionsRoot), '.desktop-search-v1.json'), payload));
		await cache.save.catch(() => { /* Read-only histories remain searchable if cache persistence fails. */ });
	}
	results.sort((a, b) => Number(!!a.otherBranch) - Number(!!b.otherBranch) || Date.parse(b.modified) - Date.parse(a.modified) || a.resultId.localeCompare(b.resultId));
	const result = page(key, results, { truncated, skipped }, undefined, request.limit);
	return { sessions: result.results, total: result.total, nextCursor: result.nextCursor, truncated: truncated || !!result.nextCursor,
		...(skipped ? { skipped } : {}), diagnostics: { ...diagnostics, elapsedMs: Date.now() - token.started } };
}

export function validateProjectSearchRules(value: unknown): ProjectSearchRules {
	const rules = value as ProjectSearchRules;
	if (!rules || typeof rules !== 'object' || !['ignoredDirectories', 'include', 'exclude'].every((key) => {
		const items = rules[key as 'include']; return Array.isArray(items) && items.length <= 100 && items.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 300 && !/[\u0000-\u001f]/u.test(item));
	}) || !Number.isInteger(rules.maxFileBytes) || rules.maxFileBytes < 1024 || rules.maxFileBytes > 16 * 1024 * 1024) throw new Error('搜索规则无效，文件上限须为 1 KiB–16 MiB');
	return { ignoredDirectories: [...new Set(rules.ignoredDirectories)], include: [...new Set(rules.include)], exclude: [...new Set(rules.exclude)], maxFileBytes: rules.maxFileBytes };
}
export function getProjectSearchRules(cwd: string): ProjectSearchRules { return structuredClone(rulesByWorkspace.get(resolve(cwd)) ?? DEFAULT_RULES); }
export function setProjectSearchRules(cwd: string, rules: ProjectSearchRules): void {
	const next = validateProjectSearchRules(rules), key = resolve(cwd);
	if (JSON.stringify(rulesByWorkspace.get(key) ?? DEFAULT_RULES) === JSON.stringify(next)) return;
	rulesByWorkspace.set(key, next); projectCaches.delete(key);
}
function glob(pattern: string, path: string, sensitive: boolean): boolean {
	let expression = '';
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === '*' && pattern[index + 1] === '*') { index++; if (pattern[index + 1] === '/') { index++; expression += '(?:.*/)?'; } else expression += '.*'; }
		else if (char === '*') expression += '[^/]*'; else if (char === '?') expression += '[^/]'; else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${expression}$`, sensitive ? '' : 'i').test(path);
}
type ProjectCache = { key: string; dirs: Map<string, number>; files: ProjectSearchMatch[]; ignored: number; unreadable: number; truncated: boolean };
const projectCaches = new Map<string, ProjectCache>();
async function enumerateProject(root: string, rules: ProjectSearchRules, refresh: boolean, cancelled: () => boolean): Promise<ProjectCache> {
	const key = digest(rules), previous = projectCaches.get(root);
	if (!refresh && previous?.key === key) {
		let changed = false;
		for (const [path, modified] of previous.dirs) { if (cancelled()) break; try { if ((await lstat(path)).mtimeMs !== modified) { changed = true; break; } } catch { changed = true; break; } }
		if (!changed && !cancelled()) return previous;
	}
	const cache: ProjectCache = { key, dirs: new Map(), files: [], ignored: 0, unreadable: 0, truncated: false }, pending = [root];
	let count = 0;
	while (pending.length) {
		if (cancelled() || count >= MAX_ENTRIES) { cache.truncated = true; break; }
		const path = pending.shift()!;
		try {
			const details = await lstat(path);
			if (!details.isDirectory() || details.isSymbolicLink() || !within(root, await realpath(path))) continue;
			cache.dirs.set(path, details.mtimeMs);
			for await (const entry of await opendir(path)) {
				if (++count > MAX_ENTRIES || cancelled()) { cache.truncated = true; break; }
				if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) continue;
				if (entry.isDirectory() && rules.ignoredDirectories.some((name) => name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) { cache.ignored++; continue; }
				const child = join(path, entry.name), relativePath = relative(root, child).split(sep).join('/');
				if (rules.exclude.some((pattern) => glob(pattern, relativePath, false) || entry.isDirectory() && glob(pattern, `${relativePath}/`, false))) { cache.ignored++; continue; }
				if (entry.isDirectory()) pending.push(child);
				cache.files.push({ name: entry.name, path: relativePath, kind: entry.isDirectory() ? 'directory' : 'file', resultId: relativePath });
			}
		} catch { cache.unreadable++; }
	}
	cache.files.sort((a, b) => a.path.localeCompare(b.path));
	if (!cancelled()) projectCaches.set(root, cache);
	return cache;
}
export async function searchProjectFiles(cwd: string, request: ProjectSearchRequest): Promise<ProjectSearchPage> {
	if (!request || typeof request !== 'object') throw new Error('搜索参数无效');
	const terms = queryTerms(request.query, request.caseSensitive), token = begin('files', request.requestId);
	if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) throw new Error('请先打开工作区');
	if (request.mode !== undefined && !['path', 'content'].includes(request.mode)) throw new Error('文件搜索模式无效');
	if (request.caseSensitive !== undefined && typeof request.caseSensitive !== 'boolean') throw new Error('大小写选项无效');
	const rules = request.rules ? validateProjectSearchRules(request.rules) : getProjectSearchRules(cwd);
	const root = await realpath(cwd), key = digest([root, { ...request, cursor: undefined, requestId: undefined, limit: undefined, refresh: undefined }, rules]);
	if (!(await stat(root)).isDirectory()) throw new Error('工作区不是文件夹');
	const diagnostics = { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 };
	if (request.cursor) {
		const result = page<ProjectSearchMatch>(key, [], {}, request.cursor, request.limit);
		return { ...result.extra, files: result.results, nextCursor: result.nextCursor, total: result.total, truncated: !!result.nextCursor || !!result.extra.truncated, diagnostics } as ProjectSearchPage;
	}
	const cache = await enumerateProject(root, rules, !!request.refresh, token.cancelled);
	const skipReasons = { binary: 0, large: 0, unreadable: cache.unreadable, ignored: cache.ignored }, results: ProjectSearchMatch[] = [];
	let truncated = cache.truncated;
	for (const entry of cache.files) {
		if (token.cancelled() || diagnostics.bytesRead >= MAX_SCAN_BYTES) { truncated = true; break; }
		if (entry.kind === 'directory' && (!request.includeDirectories || request.mode === 'content')) continue;
		if (rules.include.length && !rules.include.some((pattern) => glob(pattern, entry.path, false))) { skipReasons.ignored++; continue; }
		diagnostics.indexed++;
		if (request.mode !== 'content') {
			const haystack = request.caseSensitive ? entry.path : entry.path.toLocaleLowerCase();
			if (!terms.every((term) => haystack.includes(term.replace(/\\/g, '/')))) continue;
		}
		try {
			const path = join(root, entry.path), details = await lstat(path);
			if (details.isSymbolicLink() || !within(root, await realpath(path)) || entry.kind === 'file' && !details.isFile()) continue;
			if (request.mode !== 'content') { results.push({ ...entry, ...(details.isFile() ? { size: details.size } : {}) }); continue; }
			if (!request.query.trim()) continue;
			if (details.size > rules.maxFileBytes) { skipReasons.large++; continue; }
			const bytes = await readFile(path); diagnostics.filesRead++; diagnostics.bytesRead += bytes.length;
			if (bytes.includes(0)) { skipReasons.binary++; continue; }
			let text: string;
			try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { skipReasons.binary++; continue; }
			const literal = request.caseSensitive ? request.query : request.query.toLocaleLowerCase();
			let line = 0;
			for (const source of text.split(/\r?\n/u)) {
				line++; const column = (request.caseSensitive ? source : source.toLocaleLowerCase()).indexOf(literal);
				if (column >= 0) results.push({ ...entry, size: details.size, resultId: `${entry.path}:${line}:${column + 1}`, line, column: column + 1, snippet: source.slice(Math.max(0, column - 65), column + literal.length + 155) });
				if (results.length >= 20_000 || token.cancelled()) { truncated = true; break; }
			}
		} catch { skipReasons.unreadable++; }
		if (results.length >= 20_000) { truncated = true; break; }
	}
	if (token.cancelled()) return { files: [], total: 0, truncated: true, cancelled: true, ignoredDirectories: rules.ignoredDirectories, rules, skipReasons, diagnostics };
	const skipped = skipReasons.binary + skipReasons.large + skipReasons.unreadable;
	const extra = { truncated, skipped, ignoredDirectories: rules.ignoredDirectories, rules, skipReasons };
	const result = page(key, results, extra, undefined, request.limit);
	return { ...extra, files: result.results, total: result.total, nextCursor: result.nextCursor, truncated: truncated || !!result.nextCursor, diagnostics: { ...diagnostics, elapsedMs: Date.now() - token.started } };
}

export async function searchSessions(root: string, workspaces: string[], query: string) {
	const result = await searchSessionsPage(root, workspaces, { query });
	return { sessions: result.sessions.map(({ resultId: _id, branchLeafId: _branch, ...item }) => item), truncated: result.truncated, ...(result.skipped ? { skipped: result.skipped } : {}) };
}
export async function searchWorkspaceFiles(cwd: string, query: string, options?: { includeDirectories?: boolean }) {
	if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'includeDirectories') || options.includeDirectories !== undefined && typeof options.includeDirectories !== 'boolean')) throw new Error('文件搜索选项无效');
	const result = await searchProjectFiles(cwd, { query, ...options });
	return { files: result.files.map(({ resultId: _id, ...item }) => item), truncated: result.truncated, ...(result.skipped ? { skipped: result.skipped } : {}), ignoredDirectories: result.ignoredDirectories };
}
