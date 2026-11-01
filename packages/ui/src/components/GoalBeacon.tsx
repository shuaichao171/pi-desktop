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

/** `task_completed` → `task completed`: ledger types are raw plugin strings, shown as words. */
function humanizeEventType(type: string): string {
	return type.replace(/[_-]+/g, ' ').trim();
}

function taskTotal(goal: UiGoalRecord): number {
	return goal.pendingTasks + goal.completedTasks + goal.skippedTasks;
}

/** Status-coloured ring that fills with completed tasks; a goal without tasks shows its core dot only. */
function GoalRing({ goal }: { goal: UiGoalRecord }) {
	const total = taskTotal(goal);
	const fraction = total > 0 ? goal.completedTasks / total : goal.status === 'complete' ? 1 : 0;
	const radius = 6.25;
	const circumference = 2 * Math.PI * radius;
	return (
		<svg className="pd-goal-ring" data-goal-status={goal.status} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle className="pd-goal-ring-track" cx="8" cy="8" r={radius} />
			{fraction > 0 && <circle className="pd-goal-ring-fill" cx="8" cy="8" r={radius} strokeDasharray={`${fraction * circumference} ${circumference}`} transform="rotate(-90 8 8)" />}
			<circle className="pd-goal-ring-core" cx="8" cy="8" r="2.25" />
		</svg>
	);
}

function GoalStatusPill({ status }: { status: UiGoalRecord['status'] }) {
	const { t } = useT();
	return <span className="pd-goal-pill" data-goal-status={status}>{t(`goal.status.${status}`)}</span>;
}

function TaskProgress({ goal }: { goal: UiGoalRecord }) {
	const { t } = useT();
	const total = taskTotal(goal);
	if (total === 0) return null;
	const label = t('goal.tasksProgress', { done: String(goal.completedTasks), total: String(total) });
	const share = (count: number) => `${(count / total) * 100}%`;
	return (
		<div className="pd-goal-progress">
			<span className="pd-goal-progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={goal.completedTasks}>
				<span className="is-complete" style={{ width: share(goal.completedTasks) }} />
				<span className="is-skipped" style={{ width: share(goal.skippedTasks) }} />
			</span>
			<span className="pd-goal-progress-label">{label}</span>
		</div>
	);
}

function GoalTaskRow({ task, current }: { task: UiGoalTask; current: boolean }) {
	const { t } = useT();
	return (
		<li data-task-status={task.status} data-current={current || undefined}>
			<span className="pd-goal-task-check" aria-hidden="true">{task.status === 'complete' && <Icon name="check" width="10" height="10" />}</span>
			<span className="pd-goal-task-title">{task.title}</span>
			{current && <span className="pd-goal-task-current">{t('goal.currentTask')}</span>}
			{task.evidence && <span className="pd-goal-task-evidence" title={task.evidence}><Icon name="eye" width="11" height="11" />{t('goal.evidence')}</span>}
		</li>
	);
}

function GoalCard({ goal, actions }: { goal: UiGoalRecord; actions: GoalActions }) {
	const { t } = useT();
	const budgetShare = goal.tokenBudget ? goal.tokensUsed / goal.tokenBudget : 0;
	return (
		<section className="pd-goal-card" data-goal-status={goal.status}>
			<header className="pd-goal-card-head">
				<GoalRing goal={goal} />
				<p className="pd-goal-objective">{goal.objective}</p>
				<GoalStatusPill status={goal.status} />
			</header>
			<TaskProgress goal={goal} />
			<div className="pd-goal-meta">
				<span className={budgetShare >= 0.8 ? 'is-warning' : undefined} title={t('goal.tokens')}><Icon name="cpu" width="12" height="12" />{formatTokens(goal.tokensUsed)}{goal.tokenBudget ? ` / ${formatTokens(goal.tokenBudget)}` : ''} {t('goal.tokens')}</span>
				<span title={t('goal.timeSpent')}><Icon name="clock" width="12" height="12" />{formatDuration(goal.activeSeconds)}</span>
				{goal.autoContinue && <span className="pd-goal-tag"><Icon name="refresh" width="11" height="11" />{t('goal.autoContinue')}</span>}
				{goal.sisyphus && <span className="pd-goal-tag">{t('goal.sisyphus')}</span>}
			</div>
			{goal.pauseReason && (
				<div className="pd-goal-pause-note">
					<Icon name="alert" width="13" height="13" />
					<p><strong>{t('goal.pauseReason')}</strong>{goal.pauseReason}{goal.pauseSuggestedAction && <><br /><strong>{t('goal.suggestedAction')}</strong>{goal.pauseSuggestedAction}</>}</p>
				</div>
			)}
			{goal.tasks.length > 0 && (
				<ul className="pd-goal-tasks">
					{goal.tasks.map((task) => <GoalTaskRow key={task.id} task={task} current={task.id === goal.currentTaskId && task.status === 'pending'} />)}
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
	const totalTasks = taskTotal(headline);
	const actions: GoalActions = {
		available: GOAL_COMMAND_NAMES.some((name) => availableCommands.has(name)),
		enabled: Boolean(sessionId) && agentStatus === 'idle',
		pending: actionPending,
		run: runCommand,
	};

	return (
		<div className={`pd-goal-beacon${expanded ? ' is-expanded' : ''}`} data-goal-count={snapshot.goals.length}>
			<button type="button" className="pd-goal-strip" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={t(expanded ? 'goal.collapse' : 'goal.expand')}>
				<GoalRing goal={headline} />
				<span className="pd-goal-strip-title">{t('goal.title')}</span>
				{openGoals.length > 1 && <span className="pd-goal-count">{openGoals.length}</span>}
				<span className="pd-goal-strip-objective" title={headline.objective}>{headline.objective}</span>
				{activeCount > 1 && <span className="pd-goal-strip-meta">{t('goal.activeCount', { count: String(activeCount) })}</span>}
				{headline.autoContinue && <span className="pd-goal-strip-meta"><Icon name="refresh" width="11" height="11" />{t('goal.autoContinue')}</span>}
				{totalTasks > 0 && <span className="pd-goal-strip-tasks">{t('goal.tasksProgress', { done: String(headline.completedTasks), total: String(totalTasks) })}</span>}
				<GoalStatusPill status={headline.status} />
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
									<li key={`${event.type}-${event.at ?? index}-${index}`}><span className="pd-goal-activity-type" title={event.type}>{humanizeEventType(event.type)}</span>{event.at ? <time>{formatEventTime(event.at)}</time> : null}</li>
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
												<GoalRing goal={goal} />
												<span className="pd-goal-strip-objective" title={goal.objective}>{goal.objective}</span>
												<GoalStatusPill status={goal.status} />
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
