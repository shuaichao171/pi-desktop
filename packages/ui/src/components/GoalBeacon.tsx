import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiGoalRecord, UiGoalSnapshot, UiGoalTask } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { operationFeedback } from '../operationFeedback';
import { Icon } from './Icons';
import './goalBeacon.css';

/**
 * Native desktop replacement for the pi-goal-x TUI "Goal Beacon" widget
 * (ctx.ui.setWidget / onTerminalInput are no-ops outside the terminal UI).
 * Reads the plugin's durable `.pi/goals/` state through the main-process
 * watcher and renders a compact status strip above the composer; it stays
 * completely invisible when the plugin is absent or has no open goals, and
 * its action buttons only appear when the plugin's slash commands exist.
 */

const GOAL_COMMAND_NAMES = ['goal-pause', 'goal-resume', 'goal-focus', 'goal-status'] as const;
type GoalCommandName = (typeof GOAL_COMMAND_NAMES)[number];

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatEventTime(iso: string | undefined): string {
	if (!iso) return '';
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return '';
	return new Date(time).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function taskGlyph(task: UiGoalTask): string {
	return task.status === 'complete' ? '✓' : task.status === 'skipped' ? '⊘' : '○';
}

function GoalStatusPill({ status }: { status: UiGoalRecord['status'] }) {
	const { t } = useT();
	return <span className="pd-goal-pill" data-goal-status={status}>{t(`goal.status.${status}`)}</span>;
}

function GoalCard({ goal, actions }: { goal: UiGoalRecord; actions: GoalActions }) {
	const { t } = useT();
	const totalTasks = goal.pendingTasks + goal.completedTasks + goal.skippedTasks;
	const currentTask = goal.currentTaskId ? goal.tasks.find((task) => task.id === goal.currentTaskId) : undefined;
	return (
		<section className="pd-goal-card" data-goal-status={goal.status}>
			<header className="pd-goal-card-head">
				<GoalStatusPill status={goal.status} />
				<p className="pd-goal-objective">{goal.objective}</p>
				{goal.sisyphus && <span className="pd-goal-badge">{t('goal.sisyphus')}</span>}
				{goal.autoContinue && <span className="pd-goal-badge">{t('goal.autoContinue')}</span>}
			</header>
			<div className="pd-goal-meta">
				{totalTasks > 0 && <span>{t('goal.tasksProgress', { done: String(goal.completedTasks), total: String(totalTasks) })}</span>}
				<span>{formatTokens(goal.tokensUsed)}{goal.tokenBudget ? ` / ${formatTokens(goal.tokenBudget)}` : ''} {t('goal.tokens')}</span>
				<span>{t('goal.timeSpent')} {formatDuration(goal.activeSeconds)}</span>
				{currentTask && <span className="pd-goal-current">{t('goal.currentTask')}: {currentTask.title}</span>}
			</div>
			{goal.pauseReason && <p className="pd-goal-pause-note"><Icon name="alert" width="12" height="12" />{t('goal.pauseReason')}: {goal.pauseReason}{goal.pauseSuggestedAction ? ` — ${t('goal.suggestedAction')}: ${goal.pauseSuggestedAction}` : ''}</p>}
			{goal.tasks.length > 0 && (
				<ul className="pd-goal-tasks">
					{goal.tasks.map((task) => (
						<li key={task.id} data-task-status={task.status}>
							<span className="pd-goal-task-glyph" aria-hidden="true">{taskGlyph(task)}</span>
							<span className="pd-goal-task-title">{task.title}</span>
							{task.evidence && <span className="pd-goal-task-evidence" title={task.evidence}>{t('goal.evidence')}</span>}
						</li>
					))}
				</ul>
			)}
			{actions.available && (
				<div className="pd-goal-actions">
					{goal.status === 'active' && goal.autoContinue && <button type="button" onClick={() => void actions.run('goal-pause')} disabled={!actions.enabled || actions.pending === 'goal-pause'}>{t('goal.pause')}</button>}
					{(goal.status === 'paused' || goal.status === 'blocked') && <button type="button" onClick={() => void actions.run('goal-resume')} disabled={!actions.enabled || actions.pending === 'goal-resume'}>{t('goal.resume')}</button>}
					<button type="button" onClick={() => void actions.run('goal-focus')} disabled={!actions.enabled || actions.pending === 'goal-focus'}>{t('goal.focus')}</button>
					<button type="button" onClick={() => void actions.run('goal-status')} disabled={!actions.enabled || actions.pending === 'goal-status'}>{t('goal.statusCommand')}</button>
				</div>
			)}
		</section>
	);
}

interface GoalActions {
	available: boolean;
	enabled: boolean;
	pending: string | null;
	run(name: GoalCommandName): Promise<void>;
}

interface OtherWorkspaceGoals {
	cwd: string;
	name: string;
	goals: UiGoalRecord[];
}

export function GoalBeacon() {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const cwd = useChatStore((s) => s.cwd);
	const sessionId = useChatStore((s) => s.sessionId);
	const agentStatus = useChatStore((s) => s.status);
	const workspaces = useChatStore((s) => s.workspaces);
	const [snapshot, setSnapshot] = useState<UiGoalSnapshot | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [availableCommands, setAvailableCommands] = useState<Set<string>>(new Set());
	const [actionPending, setActionPending] = useState<string | null>(null);
	const [otherWorkspaces, setOtherWorkspaces] = useState<OtherWorkspaceGoals[]>([]);
	const refreshTimer = useRef<number | undefined>(undefined);

	// Load the current workspace snapshot and follow watcher broadcasts.
	useEffect(() => {
		if (!bridge || typeof bridge.getGoalSnapshot !== 'function' || !cwd) { setSnapshot(null); return; }
		let active = true;
		let reload = 0;
		const load = async () => {
			const ticket = ++reload;
			try {
				const next = await bridge.getGoalSnapshot(cwd);
				if (active && ticket === reload && useChatStore.getState().cwd === cwd) setSnapshot(next);
			} catch {
				if (active && ticket === reload) setSnapshot(null); // unknown workspace or transient failure — stay silent
			}
		};
		void load();
		const unsubscribe = typeof bridge.onGoalChanged === 'function'
			? bridge.onGoalChanged((changed) => { if (changed === cwd) void load(); })
			: undefined;
		return () => { active = false; unsubscribe?.(); };
	}, [bridge, cwd]);

	// Phase 2: the action buttons only exist while the plugin's slash commands
	// are registered; re-check when the session or bridge changes (plugin reload).
	useEffect(() => {
		if (!bridge || typeof bridge.listSlashCommands !== 'function') { setAvailableCommands(new Set()); return; }
		let active = true;
		bridge.listSlashCommands()
			.then((commands) => { if (active) setAvailableCommands(new Set(commands.map((command) => command.name))); })
			.catch(() => { if (active) setAvailableCommands(new Set()); });
		return () => { active = false; };
	}, [bridge, sessionId, cwd]);

	// Phase 3: cross-workspace overview, loaded only while expanded.
	useEffect(() => {
		if (!expanded || !bridge || typeof bridge.getGoalSnapshot !== 'function') { setOtherWorkspaces([]); return; }
		let active = true;
		void (async () => {
			const results: OtherWorkspaceGoals[] = [];
			for (const workspace of workspaces) {
				if (workspace === cwd) continue;
				try {
					const other = await bridge.getGoalSnapshot(workspace);
					if (other.available && other.goals.length > 0) results.push({ cwd: workspace, name: workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace, goals: other.goals });
				} catch {
					// workspace not registered or transient — skip silently
				}
			}
			if (active) setOtherWorkspaces(results);
		})();
		return () => { active = false; };
	}, [expanded, bridge, cwd, workspaces, snapshot]);

	useEffect(() => () => { if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current); }, []);

	const runCommand = useCallback(async (name: GoalCommandName) => {
		const currentBridge = useChatStore.getState().bridge;
		const currentCwd = useChatStore.getState().cwd;
		const currentSessionId = useChatStore.getState().sessionId;
		if (!currentBridge || !currentCwd || !currentSessionId || actionPending) return;
		setActionPending(name);
		try {
			await currentBridge.executeSlashCommand({ cwd: currentCwd, sessionId: currentSessionId, name });
			// The command mutates goal state asynchronously; the watcher broadcast
			// refreshes the snapshot, with a slow fallback in case files did not change.
			if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
			refreshTimer.current = window.setTimeout(() => { refreshTimer.current = undefined; window.dispatchEvent(new CustomEvent('pd:goal-refresh')); }, 1200);
		} catch (error) {
			operationFeedback.show({ id: `goal-command:${name}`, kind: 'error', title: t('goal.actionFailed'), detail: error instanceof Error ? error.message : String(error) });
		} finally {
			setActionPending(null);
		}
	}, [actionPending, t]);

	// Watcher broadcasts are the primary refresh path; the fallback event covers
	// commands whose file writes land before the broadcast debounce.
	useEffect(() => {
		const handler = () => { if (bridge && cwd && typeof bridge.getGoalSnapshot === 'function') void bridge.getGoalSnapshot(cwd).then((next) => { if (useChatStore.getState().cwd === cwd) setSnapshot(next); }).catch(() => {}); };
		window.addEventListener('pd:goal-refresh', handler);
		return () => window.removeEventListener('pd:goal-refresh', handler);
	}, [bridge, cwd]);

	if (!snapshot?.available || snapshot.goals.length === 0) return null;

	const openGoals = snapshot.goals.filter((goal) => goal.status !== 'complete');
	const activeCount = openGoals.filter((goal) => goal.status === 'active').length;
	const headline = openGoals[0] ?? snapshot.goals[0];
	const totalTasks = headline.pendingTasks + headline.completedTasks + headline.skippedTasks;
	const actions: GoalActions = {
		available: GOAL_COMMAND_NAMES.some((name) => availableCommands.has(name)),
		enabled: Boolean(sessionId) && agentStatus === 'idle',
		pending: actionPending,
		run: runCommand,
	};

	return (
		<div className={`pd-goal-beacon${expanded ? ' is-expanded' : ''}`} data-goal-count={snapshot.goals.length}>
			<button type="button" className="pd-goal-strip" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={t(expanded ? 'goal.collapse' : 'goal.expand')}>
				<span className="pd-goal-light" data-goal-status={headline.status} aria-hidden="true" />
				<span className="pd-goal-strip-title">{openGoals.length > 1 ? `${t('goal.title')} ${openGoals.length}` : t('goal.title')}</span>
				<GoalStatusPill status={headline.status} />
				<span className="pd-goal-strip-objective">{headline.objective}</span>
				{totalTasks > 0 && <span className="pd-goal-strip-tasks">{t('goal.tasksProgress', { done: String(headline.completedTasks), total: String(totalTasks) })}</span>}
				{activeCount > 1 && <span className="pd-goal-badge">{t('goal.activeCount', { count: String(activeCount) })}</span>}
				{headline.autoContinue && <span className="pd-goal-badge">{t('goal.autoContinue')}</span>}
				<Icon name={expanded ? 'chevronDown' : 'chevronUp'} width="13" height="13" className="pd-goal-chevron" />
			</button>
			{expanded && (
				<div className="pd-goal-panel">
					{snapshot.goals.map((goal) => <GoalCard key={goal.id} goal={goal} actions={actions} />)}
					{snapshot.recentEvents.length > 0 && (
						<section className="pd-goal-activity">
							<h4>{t('goal.recentActivity')}</h4>
							<ul>
								{snapshot.recentEvents.slice(0, 8).map((event, index) => (
									<li key={`${event.type}-${event.at ?? index}-${index}`}><code>{event.type}</code>{event.at ? <time>{formatEventTime(event.at)}</time> : null}</li>
								))}
							</ul>
						</section>
					)}
					{otherWorkspaces.length > 0 && (
						<section className="pd-goal-other-workspaces">
							<h4>{t('goal.otherProjects')}</h4>
							{otherWorkspaces.map((workspace) => (
								<div key={workspace.cwd} className="pd-goal-other-workspace">
									<span className="pd-goal-other-name" title={workspace.cwd}>{workspace.name}</span>
									<ul>
										{workspace.goals.slice(0, 5).map((goal) => (
											<li key={goal.id} data-goal-status={goal.status}>
												<span className="pd-goal-light" data-goal-status={goal.status} aria-hidden="true" />
												<span className="pd-goal-strip-objective">{goal.objective}</span>
												<span className="pd-goal-pill" data-goal-status={goal.status}>{t(`goal.status.${goal.status}`)}</span>
											</li>
										))}
									</ul>
								</div>
							))}
						</section>
					)}
				</div>
			)}
		</div>
	);
}
