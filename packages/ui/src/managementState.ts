import type { UiAutomationRun, UiPluginResource, UiPluginResourceKind, UiSessionRuntimeState, UiSessionSummary } from '@pidesktop/shared';

export interface WorkspaceSessionRequest {
	phase: 'idle' | 'loading' | 'refreshing' | 'error';
	requestId: number;
	error?: string;
}

export const sessionRuntimeKey = (cwd: string, path: string) => JSON.stringify([cwd, path]);

export function summarizeSessionStates(sessions: UiSessionSummary[]): { running: number; waiting: number; failed: number; unread: number } {
	return sessions.reduce((result, session) => {
		if (session.runtime?.phase === 'running') result.running += 1;
		if (session.runtime?.phase === 'waiting-input' || session.runtime?.phase === 'waiting-approval') result.waiting += 1;
		if (session.runtime?.phase === 'failed') result.failed += 1;
		if (session.unread) result.unread += 1;
		return result;
	}, { running: 0, waiting: 0, failed: 0, unread: 0 });
}

export function mergeRuntimeStates(cwd: string, sessions: UiSessionSummary[], live: Record<string, UiSessionRuntimeState>): UiSessionSummary[] {
	return sessions.map((session) => {
		const runtime = live[sessionRuntimeKey(cwd, session.path)];
		// An absent live entry adds no information. Preserve the host's summary
		// shape (and any host-supplied runtime); idle is an explicit valid update.
		return runtime ? { ...session, runtime } : session;
	});
}

export function automationRuns(runs: UiAutomationRun[], automationId: string | 'all', status: UiAutomationRun['status'] | 'all' = 'all'): UiAutomationRun[] {
	return runs.filter((run) => (automationId === 'all' || run.automationId === automationId) && (status === 'all' || run.status === status))
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

export function pluginResourceGroups(resources: UiPluginResource[]): { kind: UiPluginResourceKind; resources: UiPluginResource[]; hasError: boolean }[] {
	return (['extensions', 'skills', 'prompts', 'themes'] as const).map((kind) => {
		const entries = resources.filter((resource) => resource.kind === kind);
		return { kind, resources: entries, hasError: entries.some((resource) => Boolean(resource.error)) };
	}).filter((group) => group.resources.length > 0);
}
