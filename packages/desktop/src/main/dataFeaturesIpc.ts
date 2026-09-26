import { dialog } from 'electron';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_FEATURE_CHANNELS, type ProjectSearchRequest, type ProjectSearchRules, type RecoverableSessionMetadata, type SessionSearchRequest, type SessionTrashEntry, type TrashCleanupRequest, type TrashRestoreRequest } from '../../../shared/src/dataFeatures.ts';
import { handleRendererInvoke, requireRendererSender } from './rendererIpc.ts';
import { createSessionTrash } from './sessionTrash.ts';
import { createCompleteBackup, createSessionImporter, readBoundedImport, validateNativeSession, type BackupSource } from './sessionImport.ts';
import { readStateFileAsync, writeStateFileAsync } from './stateFiles.ts';
import type * as Search from './indexedSearch.ts';

export interface DataFeaturesIpcContext {
	userData: string; sessionsRoot: string; trash: ReturnType<typeof createSessionTrash>;
	getWorkspace(): string;
	getWorkspaces(): Promise<string[]>;
	listSources(): Promise<BackupSource[]>;
	applyMetadata(items: Array<{ path: string; metadata?: RecoverableSessionMetadata }>): Promise<void>;
	removeMetadata(paths: string[]): Promise<void>;
	isSessionRunning(path: string): Promise<boolean>;
	/** Permanently releases only this confirmed deleted session's draft/queue owners. */
	releaseSessionInputs(entry: SessionTrashEntry): Promise<void>;
	/** These execute in the agent utility process; metadata filtering is done there before paging. */
	searchSessions(request: SessionSearchRequest): ReturnType<typeof Search.searchSessionsPage>;
	searchFiles(cwd: string, request: ProjectSearchRequest): ReturnType<typeof Search.searchProjectFiles>;
	rebuildIndex(): Promise<{ indexed: number }>;
	cancelSearch(id: string): Promise<void>;
	getSearchRules(cwd: string): Promise<ProjectSearchRules>;
	setSearchRules(cwd: string, rules: ProjectSearchRules): Promise<void>;
	onChanged?(): Promise<void>;
}
/** Attach once beside the existing trash/delete handler, sharing its queue. */
export function registerDataFeaturesIpc(context: DataFeaturesIpcContext): { applyProjectRules(cwd: string): Promise<void> } {
	const importer = createSessionImporter({ sessionsRoot: () => context.sessionsRoot, journalRoot: () => join(context.userData, 'session-import-journal'),
		applyMetadata: context.applyMetadata, rollbackMetadata: context.removeMetadata });
	const rulesPath = join(context.userData, 'project-search-rules.json');
	let rulesQueue: Promise<void> = Promise.resolve();
	async function ensureWorkspace(cwd: unknown): Promise<string> {
		if (typeof cwd !== 'string' || !(await context.getWorkspaces()).includes(cwd)) throw new Error('请选择已打开的目标工作区');
		return cwd;
	}
	async function storedRules(): Promise<Record<string, ProjectSearchRules>> {
		return readStateFileAsync(rulesPath, () => ({}), (value): value is Record<string, ProjectSearchRules> => !!value && typeof value === 'object' && !Array.isArray(value));
	}
	async function applyProjectRules(cwd: string): Promise<void> {
		const rules = (await storedRules())[cwd]; if (rules) await context.setSearchRules(cwd, rules);
	}
	handleRendererInvoke(DATA_FEATURE_CHANNELS.listSessionTrash, () => context.trash.list());
	handleRendererInvoke(DATA_FEATURE_CHANNELS.setSessionTrashRetention, (_event, days: number) => context.trash.setRetention(days));
	handleRendererInvoke(DATA_FEATURE_CHANNELS.cleanupSessionTrash, (_event, request: TrashCleanupRequest) => context.trash.cleanup(request,
		async (entry) => entry.originalPath ? context.isSessionRunning(entry.originalPath) : false, context.releaseSessionInputs));
	handleRendererInvoke(DATA_FEATURE_CHANNELS.restoreSessionTrash, async (_event, request: TrashRestoreRequest) => {
		if (!request || typeof request.id !== 'string') throw new Error('恢复参数无效');
		const entry = (await context.trash.list()).entries.find((item) => item.id === request.id);
		if (!entry) throw new Error('回收项目不存在或已经恢复');
		if (entry.originalPath && await context.isSessionRunning(entry.originalPath)) throw new Error('此会话仍在运行，暂时无法恢复');
		const raw = await readBoundedImport(join(context.userData, 'session-trash', entry.id), 'native');
		const parsed = validateNativeSession(raw);
		const cwd = await ensureWorkspace(request.cwd ?? entry.cwd ?? parsed.header.cwd);
		const directory = join(context.sessionsRoot, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
		const sameWorkspace = resolve(parsed.header.cwd) === resolve(cwd);
		const target = sameWorkspace && entry.originalPath && dirname(entry.originalPath) === directory ? entry.originalPath
			: join(directory, entry.originalPath ? basename(entry.originalPath) : `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`);
		const replacement = sameWorkspace ? undefined : [{ ...parsed.header, cwd }, ...parsed.records.slice(1)].map((item) => JSON.stringify(item)).join('\n') + '\n';
		await context.trash.restoreSession(entry.id, target, async (item, path) => {
			try { await context.applyMetadata([{ path, metadata: item.metadata }]); }
			catch (error) {
				try { await context.removeMetadata([path]); }
				catch (rollbackError) { throw new AggregateError([error, rollbackError], '恢复失败，部分桌面元数据未能回滚；回收站副本已保留，请修复存储权限后重试'); }
				throw error;
			}
		}, replacement);
		await context.onChanged?.();
		return { path: target, cwd, warnings: [...(entry.legacy ? ['旧版回收文件缺少已丢弃的分组及桌面标记；会话正文与分支已恢复。'] : []),
			...(!sameWorkspace ? ['已恢复到其他工作区。历史附件已保留；原工作区的输入草稿和未确认队列不会自动迁移。'] : [])] };
	});
	handleRendererInvoke(DATA_FEATURE_CHANNELS.searchSessionsPage, (_event, request: SessionSearchRequest) => context.searchSessions(request));
	handleRendererInvoke(DATA_FEATURE_CHANNELS.searchProjectFiles, async (_event, request: ProjectSearchRequest) => {
		const cwd = await ensureWorkspace(context.getWorkspace());
		await applyProjectRules(cwd);
		return context.searchFiles(cwd, request);
	});
	handleRendererInvoke(DATA_FEATURE_CHANNELS.rebuildSearchIndex, () => context.rebuildIndex());
	handleRendererInvoke(DATA_FEATURE_CHANNELS.cancelDataSearch, (_event, id: string) => context.cancelSearch(id));
	handleRendererInvoke(DATA_FEATURE_CHANNELS.getProjectSearchRules, async () => {
		const cwd = await ensureWorkspace(context.getWorkspace()), saved = (await storedRules())[cwd];
		if (saved) await context.setSearchRules(cwd, saved);
		return context.getSearchRules(cwd);
	});
	handleRendererInvoke(DATA_FEATURE_CHANNELS.setProjectSearchRules, (_event, rules: ProjectSearchRules) => {
		const result = rulesQueue.then(async () => {
			const cwd = await ensureWorkspace(context.getWorkspace());
			await context.setSearchRules(cwd, rules);
			const saved = await storedRules(); saved[cwd] = await context.getSearchRules(cwd); await writeStateFileAsync(rulesPath, saved);
		});
		rulesQueue = result.then(() => undefined, () => undefined); return result;
	});
	handleRendererInvoke(DATA_FEATURE_CHANNELS.importSessions, async (event, format: 'native' | 'backup', requestedCwd: string) => {
		if (format !== 'native' && format !== 'backup') throw new Error('导入格式无效');
		const cwd = await ensureWorkspace(requestedCwd);
		requireRendererSender(event);
		const chosen = await dialog.showOpenDialog({ title: format === 'native' ? '导入 Pi 原生会话' : '恢复完整备份', properties: ['openFile'],
			filters: [{ name: format === 'native' ? 'Pi JSONL' : 'Pi Desktop 完整备份', extensions: format === 'native' ? ['jsonl'] : ['pibackup', 'json'] }] });
		if (chosen.canceled || !chosen.filePaths[0]) return null;
		requireRendererSender(event);
		await ensureWorkspace(cwd);
		const result = await importer.import(await readBoundedImport(chosen.filePaths[0], format), format, cwd);
		await context.onChanged?.(); return result;
	});
	handleRendererInvoke(DATA_FEATURE_CHANNELS.exportSessionsBackup, async (event) => {
		if (!(await context.listSources()).length) throw new Error('没有可备份的会话');
		requireRendererSender(event);
		const chosen = await dialog.showSaveDialog({ title: '导出完整会话备份', defaultPath: `pi-desktop-${new Date().toISOString().slice(0, 10)}.pibackup`, filters: [{ name: 'Pi Desktop 完整备份', extensions: ['pibackup'] }] });
		if (chosen.canceled || !chosen.filePath) return null;
		requireRendererSender(event);
		// The native picker can remain open while another conversation starts.
		// Re-enumerate and revalidate the complete set immediately before reading.
		const sources = await context.listSources();
		if (!sources.length) throw new Error('没有可备份的会话');
		if (sources.some((item) => resolve(item.path) === resolve(chosen.filePath!))) throw new Error('备份目标不能覆盖原会话');
		await writeStateFileAsync(chosen.filePath, await createCompleteBackup(sources)); return chosen.filePath;
	});
	return { applyProjectRules };
}
