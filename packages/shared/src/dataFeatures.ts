import type { UiSessionSearchResult, WorkspaceEntry } from './index';

export interface RecoverableSessionMetadata {
	pinned?: boolean; archived?: boolean; unread?: boolean; order?: number;
	group?: { id: string; name: string; index: number };
}
export interface SessionTrashEntry {
	id: string; deletedAt: string; bytes: number; originalPath?: string; cwd?: string;
	sessionId?: string; name?: string; metadata?: RecoverableSessionMetadata;
	legacy: boolean; expiresAt?: string;
}
export interface TrashRestoreRequest { id: string; cwd?: string }
export interface TrashCleanupRequest { entries: Array<{ id: string; deletedAt: string }> }
export interface SessionSearchRequest {
	query: string; workspace?: string; after?: string; before?: string;
	archived?: 'all' | 'exclude' | 'only'; otherBranches?: boolean;
	cursor?: string; limit?: number; requestId?: string;
}
export interface IndexedSessionResult extends UiSessionSearchResult {
	resultId: string; branchLeafId?: string; otherBranch?: boolean;
}
export interface SearchDiagnostics { elapsedMs: number; filesRead: number; bytesRead: number; indexed: number }
export interface SessionSearchPage {
	sessions: IndexedSessionResult[]; nextCursor?: string; total: number; truncated: boolean;
	skipped?: number; cancelled?: boolean; diagnostics: SearchDiagnostics;
}
export interface ProjectSearchRules {
	ignoredDirectories: string[]; include: string[]; exclude: string[]; maxFileBytes: number;
}
export interface ProjectSearchRequest {
	query: string; mode?: 'path' | 'content'; caseSensitive?: boolean;
	includeDirectories?: boolean; rules?: ProjectSearchRules; refresh?: boolean;
	cursor?: string; limit?: number; requestId?: string;
}
export interface ProjectSearchMatch extends WorkspaceEntry { line?: number; column?: number; snippet?: string; resultId: string }
export interface ProjectSearchPage {
	files: ProjectSearchMatch[]; nextCursor?: string; total: number; truncated: boolean;
	skipped?: number; cancelled?: boolean; ignoredDirectories: string[];
	skipReasons: { binary: number; large: number; unreadable: number; ignored: number };
	rules: ProjectSearchRules; diagnostics: SearchDiagnostics;
}
export interface SessionImportResult { paths: string[]; cwd: string; duplicate: boolean; warnings: string[] }
export interface DataFeaturesBridge {
	listSessionTrash(): Promise<{ entries: SessionTrashEntry[]; retentionDays: number }>;
	restoreSessionTrash(request: TrashRestoreRequest): Promise<{ path: string; cwd: string; warnings: string[] }>;
	cleanupSessionTrash(request: TrashCleanupRequest): Promise<{ removed: string[]; skipped: string[] }>;
	setSessionTrashRetention(days: number): Promise<void>;
	searchSessionsPage(request: SessionSearchRequest): Promise<SessionSearchPage>;
	searchProjectFiles(request: ProjectSearchRequest): Promise<ProjectSearchPage>;
	rebuildSearchIndex(): Promise<{ indexed: number }>;
	cancelDataSearch(requestId: string): Promise<void>;
	getProjectSearchRules(): Promise<ProjectSearchRules>;
	setProjectSearchRules(rules: ProjectSearchRules): Promise<void>;
	importSessions(format: 'native' | 'backup', cwd: string): Promise<SessionImportResult | null>;
	exportSessionsBackup(): Promise<string | null>;
}
export const DATA_FEATURE_CHANNELS = {
	listSessionTrash: 'data:trash:list', restoreSessionTrash: 'data:trash:restore', cleanupSessionTrash: 'data:trash:cleanup',
	setSessionTrashRetention: 'data:trash:retention', searchSessionsPage: 'data:search:sessions', searchProjectFiles: 'data:search:project',
	rebuildSearchIndex: 'data:search:rebuild', cancelDataSearch: 'data:search:cancel', getProjectSearchRules: 'data:search:rules:get',
	setProjectSearchRules: 'data:search:rules:set', importSessions: 'data:sessions:import', exportSessionsBackup: 'data:sessions:backup',
} as const;
