import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { UiBackgroundTask, UiBackgroundTaskStatus } from '@pidesktop/shared';
import {
	backgroundTaskCommandPreview,
	backgroundTaskDisplayName,
	classifyBackgroundTaskStatus,
	dismissSettledBackgroundTasks,
	EMPTY_BACKGROUND_TASK_VISIBILITY,
	formatBackgroundTaskDuration,
	reconcileVisibleBackgroundTasks,
	sameStringSet,
	summarizeBackgroundTasks,
	type BackgroundTaskVisibilityState,
} from '../backgroundTasksState';
import { useT, type Translate } from '../i18n';
import { operationNoticeTimeoutMs, useOperationNoticeTimeoutSeconds } from '../operationNoticeTimeout';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import './backgroundTasksBar.css';

interface ScopedVisibility extends Pick<BackgroundTaskVisibilityState, 'trackedIds' | 'dismissedIds'> {
	scope: string;
}

function StatusGlyph({ status }: { status: UiBackgroundTaskStatus }) {
	const icon = status === 'running' ? 'loader' : status === 'failed' ? 'close' : 'check';
	return (
		<span className="pd-bg-task-glyph" data-bg-state={status} aria-hidden="true">
			<Icon name={icon} width="13" height="13" />
		</span>
	);
}

function formatTaskStatus(task: UiBackgroundTask, t: Translate): string {
	const label = classifyBackgroundTaskStatus(task);
	switch (label.kind) {
		case 'running':
			return t('bgTasks.status.running');
		case 'completed':
			return t('bgTasks.status.completed');
		case 'completedOffline':
			return t('bgTasks.status.completedOffline');
		case 'failedSignal':
			return t('bgTasks.status.failedSignal', { signal: label.signal });
		case 'failedExitCode':
			return t('bgTasks.status.failedExitCode', { code: String(label.exitCode) });
		case 'failed':
			return t('bgTasks.status.failed');
	}
}

/**
 * Surfaces this conversation's still-running background tasks right above the
 * composer (especially after a reply ends) and updates their status in place
 * when each task finishes.
 */
export function BackgroundTasksBar() {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const cwd = useChatStore((s) => s.cwd);
	const sessionId = useChatStore((s) => s.sessionId);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const agentStatus = useChatStore((s) => s.status);
	const backgroundTasks = useChatStore((s) => s.backgroundTasks);
	const stopBackgroundTask = useChatStore((s) => s.stopBackgroundTask);

	const scope = `${cwd}\0${sessionPath ?? ''}\0${sessionId ?? ''}`;
	const panelId = useId();
	const [visibility, setVisibility] = useState<ScopedVisibility>(() => ({
		scope,
		trackedIds: EMPTY_BACKGROUND_TASK_VISIBILITY.trackedIds,
		dismissedIds: EMPTY_BACKGROUND_TASK_VISIBILITY.dismissedIds,
	}));
	const [expandedChoice, setExpandedChoice] = useState<{ scope: string; mode: 'single' | 'multi'; value: boolean } | null>(null);
	const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [timeoutSeconds] = useOperationNoticeTimeoutSeconds();
	const remainingRef = useRef<number | null>(null);
	const countdownKeyRef = useRef<string>('');

	const effectivePrev = visibility.scope === scope ? visibility : EMPTY_BACKGROUND_TASK_VISIBILITY;
	const reconciled = useMemo(
		() => reconcileVisibleBackgroundTasks(effectivePrev, backgroundTasks),
		[effectivePrev, backgroundTasks],
	);
	const visible = reconciled.visible;
	const summary = useMemo(() => summarizeBackgroundTasks(visible), [visible]);

	// Persist newly observed running/undelivered task IDs for this session visit so
	// settled tasks remain visible after delivery until dismissed or auto-cleared.
	useEffect(() => {
		setVisibility((current) => {
			const base = current.scope === scope ? current : EMPTY_BACKGROUND_TASK_VISIBILITY;
			const next = reconcileVisibleBackgroundTasks(base, backgroundTasks);
			if (
				current.scope === scope
				&& sameStringSet(current.trackedIds, next.trackedIds)
				&& sameStringSet(current.dismissedIds, next.dismissedIds)
			) {
				return current;
			}
			return { scope, trackedIds: next.trackedIds, dismissedIds: next.dismissedIds };
		});
	}, [scope, backgroundTasks]);

	// Clear per-task stopping flags once tasks leave the running state or scope changes.
	useEffect(() => {
		setStoppingIds((current) => {
			if (current.size === 0) return current;
			const runningIds = new Set(backgroundTasks.filter((task) => task.status === 'running').map((task) => task.taskId));
			const next = new Set([...current].filter((id) => runningIds.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [scope, backgroundTasks]);

	// Live elapsed-time ticker while at least one visible task is still running.
	useEffect(() => {
		if (summary.running === 0) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [summary.running]);

	const dismissSettled = useCallback(() => {
		setVisibility((current) => {
			const base = current.scope === scope ? current : EMPTY_BACKGROUND_TASK_VISIBILITY;
			const next = dismissSettledBackgroundTasks(base, backgroundTasks);
			return { scope, trackedIds: next.trackedIds, dismissedIds: next.dismissedIds };
		});
	}, [scope, backgroundTasks]);

	const listMode: 'single' | 'multi' = visible.length > 1 ? 'multi' : 'single';
	useEffect(() => {
		if (visible.length === 0) setExpandedChoice(null);
	}, [visible.length]);
	const userExpanded = expandedChoice?.scope === scope && expandedChoice.mode === listMode ? expandedChoice.value : null;
	// Multiple tasks expand by default so every task name and status is visible immediately.
	const expanded = userExpanded ?? visible.length > 1;
	const manualDetailOpen = visible.length === 1 && expanded;
	const holdCountdown = hovered || focused || manualDetailOpen;

	// Once every visible task has settled and been delivered, clear the completion
	// notice automatically following the user's notice timeout (pauses on hover/focus).
	const autoDismissMs = summary.allSettledAndDelivered
		? operationNoticeTimeoutMs(summary.failed > 0 ? 'error' : 'success', timeoutSeconds)
		: null;
	const countdownKey = summary.allSettledAndDelivered
		? `${scope}:${autoDismissMs}:${visible.map((task) => `${task.taskId}:${task.status}:${task.endedAt ?? ''}`).join(',')}`
		: '';

	useEffect(() => {
		if (!countdownKey || autoDismissMs === null) {
			countdownKeyRef.current = '';
			remainingRef.current = null;
			return;
		}
		if (countdownKeyRef.current !== countdownKey) {
			countdownKeyRef.current = countdownKey;
			remainingRef.current = autoDismissMs;
		}
		if (holdCountdown) return;
		const delay = remainingRef.current ?? autoDismissMs;
		const started = performance.now();
		const timer = window.setTimeout(() => {
			remainingRef.current = 0;
			dismissSettled();
		}, delay);
		return () => {
			window.clearTimeout(timer);
			remainingRef.current = Math.max(0, delay - (performance.now() - started));
		};
	}, [countdownKey, autoDismissMs, holdCountdown, dismissSettled]);

	if (visible.length === 0) return null;

	const canStop = typeof bridge?.stopBackgroundTask === 'function';
	const handleStop = async (taskId: string) => {
		if (!canStop || stoppingIds.has(taskId)) return;
		setStoppingIds((current) => new Set([...current, taskId]));
		try {
			const ok = await stopBackgroundTask(taskId);
			if (!ok) {
				setStoppingIds((current) => {
					const next = new Set(current);
					next.delete(taskId);
					return next;
				});
			}
		} catch {
			setStoppingIds((current) => {
				const next = new Set(current);
				next.delete(taskId);
				return next;
			});
		}
	};

	const single = visible.length === 1 ? visible[0]! : null;
	const showAutoResumeHint = agentStatus === 'idle' && summary.running > 0;
	const collapsedNames = (summary.running > 0 ? visible.filter((task) => task.status === 'running') : visible)
		.map(backgroundTaskDisplayName)
		.join('、');

	const multiSummaryText = summary.running > 0
		? summary.completed + summary.failed > 0
			? t('bgTasks.summaryMixed', { running: String(summary.running), finished: String(summary.completed + summary.failed) })
			: t('bgTasks.summaryRunning', { count: String(summary.running) })
		: summary.failed > 0 && summary.completed > 0
			? t('bgTasks.summaryCompletedFailed', { completed: String(summary.completed), failed: String(summary.failed) })
			: summary.failed > 0
				? t('bgTasks.summaryFailed', { count: String(summary.failed) })
				: t('bgTasks.summaryCompleted', { count: String(summary.completed) });

	return (
		<section
			className={`pd-bg-tasks${expanded ? ' is-expanded' : ''}`}
			data-bg-state={summary.overallStatus}
			data-bg-count={visible.length}
			role="status"
			aria-live="polite"
			aria-label={t('bgTasks.label')}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
		>
			<div className="pd-bg-tasks-head">
				<button
					type="button"
					className="pd-bg-tasks-strip"
					aria-expanded={expanded}
					aria-controls={panelId}
					aria-label={t(expanded ? 'bgTasks.collapse' : 'bgTasks.expand')}
					onClick={() => setExpandedChoice({ scope, mode: listMode, value: !expanded })}
				>
					<StatusGlyph status={summary.overallStatus} />
					<span className="pd-bg-tasks-title">{t('bgTasks.title')}</span>
					{single ? (
						<>
							<span className="pd-bg-tasks-name" title={single.note ? `${single.note}\n${single.command}` : single.command}>
								{backgroundTaskDisplayName(single)}
							</span>
							{showAutoResumeHint && <span className="pd-bg-tasks-hint">{t('bgTasks.autoResumeHint')}</span>}
							{single.status !== 'running' && !single.delivered && (
								<span className="pd-bg-task-pending-tag">{t('bgTasks.pendingDelivery')}</span>
							)}
							<span className="pd-bg-task-pill" data-bg-state={single.status}>{formatTaskStatus(single, t)}</span>
							<time className="pd-bg-task-duration">
								{formatBackgroundTaskDuration(single.startedAt, single.endedAt, now)}
							</time>
						</>
					) : (
						<>
							<span className="pd-bg-tasks-name is-muted" title={!expanded ? collapsedNames : undefined}>
								{!expanded ? collapsedNames : ''}
							</span>
							{showAutoResumeHint && <span className="pd-bg-tasks-hint">{t('bgTasks.autoResumeHint')}</span>}
							<span className="pd-bg-task-pill" data-bg-state={summary.overallStatus}>{multiSummaryText}</span>
						</>
					)}
					<Icon name={expanded ? 'chevronDown' : 'chevronUp'} width="13" height="13" className="pd-bg-tasks-chevron" />
				</button>
				<div className="pd-bg-tasks-head-actions">
					{single && single.status === 'running' && canStop && (
						<button
							type="button"
							className="pd-bg-task-stop"
							disabled={stoppingIds.has(single.taskId)}
							onClick={() => void handleStop(single.taskId)}
						>
							<Icon name="square" width="10" height="10" />
							<span>{t(stoppingIds.has(single.taskId) ? 'bgTasks.stopping' : 'bgTasks.stop')}</span>
						</button>
					)}
					{summary.running === 0 && (
						<button
							type="button"
							className="pd-bg-tasks-dismiss"
							aria-label={t('bgTasks.dismiss')}
							title={t('bgTasks.dismiss')}
							onClick={dismissSettled}
						>
							<Icon name="close" width="14" height="14" />
						</button>
					)}
				</div>
			</div>

			{expanded && single && (
				<div id={panelId} className="pd-bg-task-detail">
					<pre className="pd-bg-task-detail-cmd">{single.command}</pre>
					<div className="pd-bg-task-detail-meta">
						<span>{t('bgTasks.taskId')} <code>{single.taskId}</code></span>
						{single.status === 'running' && single.pid > 0 && <span>PID <code>{single.pid}</code></span>}
						{single.logFile && <span>{t('bgTasks.logFile')} <code>{single.logFile}</code></span>}
					</div>
				</div>
			)}

			{expanded && !single && (
				<ul id={panelId} className="pd-bg-tasks-list">
					{visible.map((task) => {
						const name = backgroundTaskDisplayName(task);
						const cmdPreview = backgroundTaskCommandPreview(task);
						const stopping = stoppingIds.has(task.taskId);
						return (
							<li key={task.taskId} className="pd-bg-task-row" data-bg-state={task.status} data-task-id={task.taskId}>
								<StatusGlyph status={task.status} />
								<span className="pd-bg-task-copy" title={task.note ? `${task.note}\n${task.command}` : task.command}>
									<span className="pd-bg-task-row-name">{name}</span>
									{cmdPreview && <code className="pd-bg-task-row-cmd">{cmdPreview}</code>}
								</span>
								{task.status !== 'running' && !task.delivered && (
									<span className="pd-bg-task-pending-tag">{t('bgTasks.pendingDelivery')}</span>
								)}
								<span className="pd-bg-task-pill" data-bg-state={task.status}>{formatTaskStatus(task, t)}</span>
								<time className="pd-bg-task-duration">
									{formatBackgroundTaskDuration(task.startedAt, task.endedAt, now)}
								</time>
								{task.status === 'running' && canStop && (
									<button
										type="button"
										className="pd-bg-task-stop"
										disabled={stopping}
										onClick={() => void handleStop(task.taskId)}
									>
										<Icon name="square" width="10" height="10" />
										<span>{t(stopping ? 'bgTasks.stopping' : 'bgTasks.stop')}</span>
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
