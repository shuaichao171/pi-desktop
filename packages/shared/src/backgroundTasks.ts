/**
 * Per-session background task state surfaced to the conversation UI.
 *
 * Mirrors `BackgroundTaskRecord` from `@pidesktop/agent` as plain IPC-safe data
 * so the renderer can display still-running background tasks after a reply ends
 * and update the indicator as soon as each task finishes.
 */

export type UiBackgroundTaskStatus = 'running' | 'completed' | 'failed';

export interface UiBackgroundTask {
  taskId: string;
  command: string;
  note?: string;
  pid: number;
  logFile: string;
  startedAt: number;
  endedAt?: number;
  /** Null when unknown (killed by signal or exited while the agent host was offline). */
  exitCode?: number | null;
  /** Terminating POSIX signal when killed by one. */
  signal?: string;
  /** True when exit was detected via PID polling after a host restart. */
  exitedOffline?: boolean;
  status: UiBackgroundTaskStatus;
  /** True once the completion notification has been delivered back into the conversation. */
  delivered?: boolean;
}
