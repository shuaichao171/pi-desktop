import type { UiSessionSummary, UiSessionSearchResult, WorkspaceEntry } from './index';

/** Desktop metadata flags the search layer filters on (pinned/archived/unread plus manual order). */
export interface SessionSearchMetadata {
	pinned?: boolean; archived?: boolean; unread?: boolean; order?: number;
}
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
/** A conversation discovered anywhere under the local pi sessions root, including workspaces the app has not opened. */
export interface UiMachineSessionSummary extends UiSessionSummary {
	cwd: string;
	/** False when the session belongs to a workspace that is not registered in this app. */
	registered: boolean;
	/** True while the conversation has a live background runtime; deletion must wait. */
	running: boolean;
	/** Transcript file size in bytes. */
	bytes: number;
}
export interface DataFeaturesBridge {
	listMachineSessions(): Promise<UiMachineSessionSummary[]>;
	searchSessionsPage(request: SessionSearchRequest): Promise<SessionSearchPage>;
	searchProjectFiles(request: ProjectSearchRequest): Promise<ProjectSearchPage>;
	cancelDataSearch(requestId: string): Promise<void>;
}
export const DATA_FEATURE_CHANNELS = {
	listMachineSessions: 'data:sessions:list-all',
	searchSessionsPage: 'data:search:sessions', searchProjectFiles: 'data:search:project',
	cancelDataSearch: 'data:search:cancel',
} as const;
