export type CommitScope = 'all' | 'stagedOnly';
export interface WorkspaceCommitPreview { id: string; cwd: string; scope: CommitScope; branch: string | null; head: string | null; files: { path: string; status: string }[]; context: string; truncated: boolean; createdAt: string }
export interface TaskWorktree { id: string; project: string; cwd: string; branch: string; ref: string; commit: string; createdAt: string; sessionPath?: string; sessionMissing?: boolean; missing?: boolean }
export interface GitDeliveryPreview { id: string; cwd: string; branch: string; head: string; upstream: string | null; remotes: { name: string; url: string; github: boolean }[]; ghAvailable: boolean; savedPr?: string }
export interface GitDeliveryResult { branch: string; head: string; remote: string; url?: string; existing?: boolean }
export interface WorkspaceTerminalSnapshot { id: string; cwd: string; shell: string; running: boolean; output: string; sequence: number; truncated: boolean; exitCode?: number }
export interface WorkspaceTerminalEvent { id: string; cwd: string; sequence: number; type: 'data' | 'exit'; data?: string; exitCode?: number }
export interface UiFileCheckpoint { id: string; version: string; cwd: string; sessionId: string; completedAt: string; restored: boolean; files: { path: string; status: 'ready' | 'conflict' | 'uncovered' | 'restored'; kind: 'added' | 'deleted' | 'modified'; reason?: string; diff?: string }[]; warning?: string; recovery?: string }
export interface WorkbenchFeaturesBridge {
  getWorkspaceCommitPreview(request: { cwd: string; scope: CommitScope }): Promise<WorkspaceCommitPreview>;
  commitWorkspacePreview(request: { id: string; message: string }): Promise<string>;
  createTaskWorktree(request: { cwd: string; ref: string; branch: string }): Promise<TaskWorktree>;
  listTaskWorktrees(): Promise<TaskWorktree[]>;
  bindTaskWorktree(request: { id: string; sessionPath: string }): Promise<TaskWorktree>;
  getGitDeliveryPreview(cwd: string): Promise<GitDeliveryPreview>;
  pushWorkspaceBranch(request: { id: string; remote: string }): Promise<GitDeliveryResult>;
  createWorkspaceDraftPr(request: { id: string; remote: string; base: string; title: string; body: string }): Promise<GitDeliveryResult>;
  openWorkspaceTerminal(request: { cwd: string; cols: number; rows: number }): Promise<WorkspaceTerminalSnapshot>;
  getWorkspaceTerminal(cwd: string): Promise<WorkspaceTerminalSnapshot | null>;
  writeWorkspaceTerminal(request: { id: string; data: string }): Promise<void>;
  resizeWorkspaceTerminal(request: { id: string; cols: number; rows: number }): Promise<void>;
  acknowledgeWorkspaceTerminal(request: { id: string; sequence: number }): Promise<void>;
  closeWorkspaceTerminal(id: string): Promise<void>;
  onWorkspaceTerminalEvent(listener: (event: WorkspaceTerminalEvent) => void): () => void;
  getFileCheckpoint(): Promise<UiFileCheckpoint | null>;
  rewindFileCheckpoint(request: { id: string; version: string }): Promise<UiFileCheckpoint>;
}
export const WORKBENCH_FEATURE_CHANNELS = {
  getWorkspaceCommitPreview: 'workbench:commit-preview', commitWorkspacePreview: 'workbench:commit-preview-apply',
  createTaskWorktree: 'workbench:task-worktree-create', listTaskWorktrees: 'workbench:task-worktree-list', bindTaskWorktree: 'workbench:task-worktree-bind',
  getGitDeliveryPreview: 'workbench:delivery-preview', pushWorkspaceBranch: 'workbench:push', createWorkspaceDraftPr: 'workbench:draft-pr',
  openWorkspaceTerminal: 'workbench:terminal-open', getWorkspaceTerminal: 'workbench:terminal-get', writeWorkspaceTerminal: 'workbench:terminal-write', resizeWorkspaceTerminal: 'workbench:terminal-resize', acknowledgeWorkspaceTerminal: 'workbench:terminal-ack', closeWorkspaceTerminal: 'workbench:terminal-close', onWorkspaceTerminalEvent: 'workbench:terminal-event',
  getFileCheckpoint: 'agent:file-checkpoint', rewindFileCheckpoint: 'agent:file-checkpoint-rewind',
} as const;
