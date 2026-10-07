import type { AgentBridge } from '@pidesktop/shared';

/** The conversation identity a result-file link belongs to. */
export interface ResultFileSessionSnapshot {
	bridge: AgentBridge | null;
	cwd: string | null;
	sessionId: string | null;
	sessionPath: string | null;
	navigationRequestId: number;
}

export function resultFileSessionSnapshot(state: {
	bridge: AgentBridge | null;
	cwd: string | null;
	sessionId: string | null;
	sessionPath: string | null;
	navigationRequestId: number;
}): ResultFileSessionSnapshot {
	return { bridge: state.bridge, cwd: state.cwd, sessionId: state.sessionId, sessionPath: state.sessionPath, navigationRequestId: state.navigationRequestId };
}

/**
 * True while the renderer still shows the conversation the link was opened in.
 * A brand-new conversation receives its session file path only when its first
 * reply settles (the resync that follows agent_settled). That null → path
 * upgrade is the same session gaining persistence, not a context switch:
 * previews and file actions opened from the reply must survive it, otherwise
 * clicks near the completion moment appear to do nothing.
 */
export function sameResultFileSession(initial: ResultFileSessionSnapshot, current: ResultFileSessionSnapshot): boolean {
	if (initial.bridge !== current.bridge || initial.cwd !== current.cwd ||
		initial.sessionId !== current.sessionId || initial.navigationRequestId !== current.navigationRequestId) return false;
	if (initial.sessionPath === current.sessionPath) return true;
	return initial.sessionPath === null && typeof current.sessionPath === 'string';
}
