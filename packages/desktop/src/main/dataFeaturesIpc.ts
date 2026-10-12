import { DATA_FEATURE_CHANNELS, type ProjectSearchRequest, type SessionSearchRequest } from '@pidesktop/shared';
import { handleRendererInvoke } from './rendererIpc.ts';
import type * as Search from './indexedSearch.ts';

export interface DataFeaturesIpcContext {
	getWorkspace(): string;
	getWorkspaces(): Promise<string[]>;
	/** These execute in the agent utility process; metadata filtering is done there before paging. */
	searchSessions(request: SessionSearchRequest): ReturnType<typeof Search.searchSessionsPage>;
	searchFiles(cwd: string, request: ProjectSearchRequest): ReturnType<typeof Search.searchProjectFiles>;
	cancelSearch(id: string): Promise<void>;
}
/** Search wiring for the renderer search dialog. Session management lives in ipc.ts. */
export function registerDataFeaturesIpc(context: DataFeaturesIpcContext): void {
	async function ensureWorkspace(cwd: unknown): Promise<string> {
		if (typeof cwd !== 'string' || !(await context.getWorkspaces()).includes(cwd)) throw new Error('请选择已打开的目标工作区');
		return cwd;
	}
	handleRendererInvoke(DATA_FEATURE_CHANNELS.searchSessionsPage, (_event, request: SessionSearchRequest) => context.searchSessions(request));
	handleRendererInvoke(DATA_FEATURE_CHANNELS.searchProjectFiles, async (_event, request: ProjectSearchRequest) => {
		const cwd = await ensureWorkspace(context.getWorkspace());
		return context.searchFiles(cwd, request);
	});
	handleRendererInvoke(DATA_FEATURE_CHANNELS.cancelDataSearch, (_event, id: string) => context.cancelSearch(id));
}
