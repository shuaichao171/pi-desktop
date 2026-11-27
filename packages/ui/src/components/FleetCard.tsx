import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UiSubagentFleetNode, UiSubagentInspectReply } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { operationFeedback } from '../operationFeedback';
import { ConversationMarkdown } from './ConversationMarkdown';
import { Icon, type IconName } from './Icons';
import './fleetCard.css';

type Command = 'subagents-stop' | 'subagents-steer' | 'subagents-inspect-rpc';
type Selection = { rootId: string; nodeId: string };
const FleetContext = createContext<{ open: boolean; panelId: string; targets: Map<string, Selection>; toggle(): void; openRun(target: Selection): void } | null>(null);
const isLive = (node: UiSubagentFleetNode) => node.state === 'running' || node.state === 'queued';
const glyphs: Record<UiSubagentFleetNode['state'], IconName> = {
	queued: 'clock', running: 'loader', complete: 'check', failed: 'close', partial: 'alert', paused: 'square', stopped: 'square', rejected: 'minusCircle',
};

function StateGlyph({ state }: { state: UiSubagentFleetNode['state'] }) {
	const { t } = useT();
	return <span className="pd-fleet-glyph" data-fleet-state={state} role="img" aria-label={t(`fleet.state.${state}`)}><Icon name={glyphs[state]} width="12" height="12" /></span>;
}

function elapsed(node: UiSubagentFleetNode, now: number): string {
	if (node.startedAt == null) return '';
	const seconds = Math.max(0, Math.floor(((isLive(node) ? now : node.endedAt ?? node.updatedAt ?? node.startedAt) - node.startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function findNode(nodes: UiSubagentFleetNode[], id: string): UiSubagentFleetNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		const child = node.children && findNode(node.children, id);
		if (child) return child;
	}
}

function containsLive(node: UiSubagentFleetNode): boolean {
	return isLive(node) || Boolean(node.children?.some(containsLive));
}

/**
 * The plugin reports one dispatch (parallel, chain or workflow) as a run whose
 * `step` children are the agents doing the work, labelled with every agent name
 * joined ("analyst, analyst"). That run is a batch head, not one more agent.
 */
const isBatch = (node: UiSubagentFleetNode) => node.kind !== 'host-step' && Boolean(node.children?.some((child) => child.kind === 'step'));

/** The agents a node stands for: batch heads only through their lanes; host monitor rows never count. */
function agentsOf(node: UiSubagentFleetNode): UiSubagentFleetNode[] {
	if (node.kind === 'host-step') return [];
	const nested = (node.children ?? []).flatMap(agentsOf);
	return isBatch(node) ? nested : [node, ...nested];
}

/** A batch with a single lane is just that agent; its row shows the lane's own name. */
function soleLane(node: UiSubagentFleetNode): UiSubagentFleetNode | undefined {
	return isBatch(node) && node.children?.length === 1 ? node.children[0] : undefined;
}

/**
 * "analyst, analyst, reviewer" → "analyst ×2, reviewer"; keeps the plugin's "+N more" tail.
 * One repeated name stays bare ("analyst"): the agent count shown beside it already says how many.
 */
function batchTitle(label: string): string {
	const parts = label.split(', ');
	const tail = parts.length > 1 && /^\+\d+ more$/.test(parts.at(-1) ?? '') ? parts.pop() : undefined;
	const counts = new Map<string, number>();
	for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
	if (counts.size === 1 && !tail) return parts[0] ?? label;
	return [...[...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name), ...(tail ? [tail] : [])].join(', ');
}

function displayLabel(node: UiSubagentFleetNode): string {
	return soleLane(node)?.label ?? (isBatch(node) ? batchTitle(node.label) : node.label);
}

/** Link a transcript record only when its exact run ID is in this session's fleet. */
export function useSubagentLink(runId: string | null | undefined) {
	const context = useContext(FleetContext);
	const target = runId ? context?.targets.get(runId) : undefined;
	return context && target ? { panelId: context.panelId, open: () => context.openRun(target) } : null;
}

/** The composer keeps a small entry point; the agents and transcripts live in a side panel. */
export function FleetCard() {
	const { t } = useT();
	const fleet = useChatStore((s) => s.subagentFleet);
	const context = useContext(FleetContext);
	if (!context || !fleet?.runs.length) return null;
	const shown = fleet.runs.flatMap(agentsOf);
	const running = shown.filter(isLive).length;
	return <div className="pd-fleet-card">
		<button type="button" className="pd-fleet-strip" onClick={context.toggle} aria-expanded={context.open} aria-controls={context.panelId} aria-label={t(context.open ? 'fleet.collapse' : 'fleet.expand')}>
			<Icon name="plugins" width="15" height="15" />
			<span className="pd-fleet-strip-title">{t('fleet.title')}</span>
			<span className="pd-fleet-summary">{t(running ? 'fleet.activeCount' : 'fleet.total', { count: running || shown.length })}</span>
			<span className="pd-fleet-avatars" aria-hidden="true">{shown.slice(0, 3).map((node) => <span key={`${node.kind}:${node.id}`} data-fleet-state={node.state}>{node.label.slice(0, 1).toUpperCase()}</span>)}</span>
			<Icon name={context.open ? 'chevronRight' : 'panel'} width="14" height="14" />
		</button>
	</div>;
}

function InspectContent({ reply }: { reply: UiSubagentInspectReply }) {
	const { t } = useT();
	const messages = (reply.messages ?? []).slice(-20);
	return <>
		{reply.error && <p className="pd-fleet-inspect-error" role="alert">{t('fleet.inspectFailed')}: {reply.error.message} <code>({reply.error.code})</code></p>}
		{reply.task && <section className="pd-fleet-inspect-task"><h4>{t('fleet.inspectTask')}</h4><p>{reply.task}</p></section>}
		{messages.length > 0 && <section className="pd-fleet-inspect-block"><h4>{t('fleet.inspectTranscript')}</h4><ol>{messages.map((message, index) => <li key={index} data-message-role={message.role}>
			<span>{message.role === 'assistant' ? t('fleet.role.assistant') : message.role === 'user' ? t('fleet.role.user') : message.role ?? t('fleet.role.tool')}</span>
			<div className="pd-markdown"><ConversationMarkdown>{message.text}</ConversationMarkdown></div>
		</li>)}</ol></section>}
		{reply.finalOutput && <section className="pd-fleet-inspect-block"><h4>{t('fleet.inspectOutput')}</h4><div className="pd-markdown pd-fleet-final-output"><ConversationMarkdown>{reply.finalOutput}</ConversationMarkdown></div></section>}
		{!reply.error && !reply.task && !messages.length && !reply.finalOutput && <p className="pd-fleet-empty">{t('fleet.noTranscript')}</p>}
		{reply.truncated && <p className="pd-fleet-empty">{t('fleet.truncated')}</p>}
	</>;
}

/** Owns presentation and on-demand commands; plugin snapshots stay authoritative. */
export function SubagentWorkspace({ children }: { children: ReactNode }) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const sessionId = useChatStore((s) => s.sessionId);
	const cwd = useChatStore((s) => s.cwd);
	const fleet = useChatStore((s) => s.subagentFleet);
	const inspectReply = useChatStore((s) => s.subagentInspect);
	const activities = useChatStore((s) => s.activities);
	const panelId = useId();
	const panelRef = useRef<HTMLElement>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const actionRef = useRef<symbol | null>(null);
	const [open, setOpen] = useState(false);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [commands, setCommands] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState(false);
	const [request, setRequest] = useState<{ id: string; error?: string } | null>(null);
	const [acceptedReply, setAcceptedReply] = useState<UiSubagentInspectReply | null>(null);
	const [steering, setSteering] = useState(false);
	const [message, setMessage] = useState('');
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		setOpen(false); setSelection(null); setRequest(null); setAcceptedReply(null); setSteering(false); setMessage(''); setPending(false); setCommands(new Set());
		actionRef.current = null;
		let active = true;
		if (typeof bridge?.listSlashCommands === 'function') void bridge.listSlashCommands().then((items) => { if (active) setCommands(new Set(items.map((item) => item.name))); }).catch(() => {});
		return () => { active = false; actionRef.current = null; };
	}, [bridge, cwd, sessionId]);
	const runs = fleet?.runs ?? [];
	const hasRuns = runs.length > 0;
	useEffect(() => {
		if (!hasRuns) { setOpen(false); setSelection(null); setRequest(null); setAcceptedReply(null); setSteering(false); }
	}, [hasRuns]);
	const targets = useMemo(() => {
		const result = new Map<string, Selection>();
		const visit = (nodes: UiSubagentFleetNode[], rootId: string) => { for (const node of nodes) { if (node.kind !== 'host-step') result.set(node.id, { rootId, nodeId: node.id }); if (node.children) visit(node.children, rootId); } };
		for (const root of fleet?.runs ?? []) visit([root], root.id);
		return result;
	}, [fleet]);
	const activityByRun = useMemo(() => new Map(activities.flatMap((item) => item.subagent?.runId ? [[item.subagent.runId, item.subagent] as const] : [])), [activities]);
	const ticking = open && runs.some(containsLive);
	useEffect(() => {
		if (!ticking) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [ticking]);
	const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
	useEffect(() => { if (open) panelRef.current?.focus(); }, [open]);
	const root = selection ? runs.find((node) => node.id === selection.rootId) : undefined;
	const selected = root && selection ? findNode([root], selection.nodeId) : undefined;
	useEffect(() => { if (request && inspectReply?.requestId === request.id) setAcceptedReply(inspectReply); }, [request?.id, inspectReply]);
	const reply = request ? inspectReply?.requestId === request.id ? inspectReply : acceptedReply?.requestId === request.id ? acceptedReply : null : null;
	const timeoutMessage = t('fleet.inspectTimeout');
	useEffect(() => {
		if (!request || reply || request.error) return;
		const id = request.id;
		const timer = window.setTimeout(() => setRequest((current) => current?.id === id ? { id, error: timeoutMessage } : current), 15000);
		return () => window.clearTimeout(timer);
	}, [request, reply, timeoutMessage]);

	const runCommand = useCallback(async (name: Command, args: string): Promise<boolean> => {
		const state = useChatStore.getState();
		if (!state.bridge || !state.cwd || !state.sessionId || state.sessionId !== sessionId || state.cwd !== cwd || !commands.has(name) || actionRef.current) return false;
		const token = Symbol(name);
		actionRef.current = token;
		setPending(true);
		try {
			// Panel controls are not conversation turns: no "Worked 0s" row per inspect.
			await state.bridge.executeSlashCommand({ cwd: state.cwd, sessionId: state.sessionId, name, args, control: true });
			return actionRef.current === token;
		} catch (error) {
			if (actionRef.current === token) operationFeedback.show({ id: `subagent-command:${name}`, kind: 'error', title: t('fleet.actionFailed'), detail: error instanceof Error ? error.message : String(error) });
			return false;
		} finally {
			if (actionRef.current === token) { actionRef.current = null; setPending(false); }
		}
	}, [commands, cwd, sessionId, t]);
	const inspect = async (target: Selection) => {
		if (!commands.has('subagents-inspect-rpc') || actionRef.current) return;
		const id = Math.random().toString(36).slice(2, 12);
		setRequest({ id });
		const ok = await runCommand('subagents-inspect-rpc', `${id} ${target.rootId}${target.rootId !== target.nodeId ? ` ${target.nodeId}` : ''} --lines 60`);
		if (!ok) setRequest((current) => current?.id === id ? { id, error: t('fleet.inspectFailed') } : current);
	};
	const choose = (node: UiSubagentFleetNode, rootId: string) => {
		const target = { rootId, nodeId: node.id };
		setSelection(target); setRequest(null); setSteering(false); setMessage('');
		if (node.kind !== 'host-step') void inspect(target);
	};
	const batchCount = (node: UiSubagentFleetNode) => t(node.kind === 'workflow' ? 'fleet.batchSteps' : 'fleet.batchAgents', { count: agentsOf(node).length });
	const renderRow = (node: UiSubagentFleetNode, rootId: string, live: boolean): ReactNode => {
		const lane = soleLane(node);
		const children = lane ? lane.children : node.children;
		const rows = children?.map((child) => renderRow(child, rootId, live)).filter(Boolean);
		const nested = rows?.length ? <ul className="pd-fleet-children">{rows}</ul> : null;
		if (isBatch(node) && !lane) {
			if (!nested) return null;
			// A dispatch of several agents: a light heading over its lanes, never an agent row of its own.
			const title = batchTitle(node.label);
			const matchingCount = agentsOf(node).filter((agent) => isLive(agent) === live).length;
			const count = matchingCount > 0 ? t(node.kind === 'workflow' ? 'fleet.batchSteps' : 'fleet.batchAgents', { count: matchingCount }) : '';
			return <li className="pd-fleet-node pd-fleet-batch" key={`${node.kind}:${node.id}`} data-fleet-state={node.state}>
				<button type="button" className="pd-fleet-batch-row" onClick={() => choose(node, rootId)} disabled={pending} aria-label={[title, count, t(`fleet.state.${node.state}`)].filter(Boolean).join(' · ')}>
					<Icon name="layers" width="13" height="13" aria-hidden="true" />
					<span className="pd-fleet-batch-label">{title}</span>
					{count && <span className="pd-fleet-batch-count">{count}</span>}
					<time>{elapsed(node, now)}</time>
					<Icon name="chevronRight" width="12" height="12" />
				</button>
				{nested}
			</li>;
		}
		const agent = lane ?? node;
		if (isLive(agent) !== live) return rows?.length ? rows : null;
		const activity = node.activity ?? lane?.activity;
		const label = displayLabel(node);
		return <li className="pd-fleet-node" key={`${node.kind}:${node.id}`} data-fleet-state={agent.state}>
			<button type="button" className="pd-fleet-node-row" onClick={() => choose(node, rootId)} disabled={pending}>
				<span className="pd-fleet-avatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}<StateGlyph state={agent.state} /></span>
				<span className="pd-fleet-node-copy"><span className="pd-fleet-node-label">{label}</span><span className="pd-fleet-node-preview" title={activityByRun.get(node.id)?.task ?? undefined}>{activityByRun.get(node.id)?.task ?? node.hostStep?.detail ?? activity?.currentTool ?? t(`fleet.state.${agent.state}`)}</span></span>
				<span className="pd-fleet-node-meta"><span className="pd-fleet-node-state">{t(`fleet.state.${agent.state}`)}</span><time>{elapsed(agent, now)}</time></span>
				<Icon name="chevronRight" width="12" height="12" />
			</button>
			{nested}
		</li>;
	};
	// Counts are agents, not dispatches: one parallel call of two agents reads as 2.
	const agents = runs.flatMap(agentsOf);
	const activeCount = agents.filter(isLive).length;
	return <FleetContext.Provider value={{ open, panelId, targets, toggle: () => { if (!open) triggerRef.current = document.activeElement as HTMLElement; setOpen(!open); }, openRun: (target) => { triggerRef.current = document.activeElement as HTMLElement; setOpen(true); const rootNode = runs.find((run) => run.id === target.rootId); const node = rootNode && findNode([rootNode], target.nodeId); if (node) choose(node, target.rootId); } }}>
		<div className={`pd-fleet-workspace${open && runs.length ? ' has-subagents-panel' : ''}`}>
			{children}
			{open && runs.length > 0 && <aside id={panelId} className="pd-fleet-sidepanel" ref={panelRef} tabIndex={-1} aria-label={t('fleet.title')} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
				<header className="pd-fleet-panel-header"><Icon name="plugins" width="15" height="15" /><h3>{t('fleet.title')}</h3><span>{agents.length}</span><button type="button" onClick={close} aria-label={t('fleet.close')}><Icon name="close" width="15" height="15" /></button></header>
				{selection ? <>
					<div className="pd-fleet-detail-nav"><button type="button" onClick={() => { setSelection(null); setRequest(null); }}><Icon name="arrowLeft" width="13" height="13" />{t('fleet.back')}</button>{selected && selected.kind !== 'host-step' && commands.has('subagents-inspect-rpc') && <button type="button" disabled={pending} onClick={() => void inspect(selection)} aria-label={t('fleet.refresh')}><Icon name="refresh" width="14" height="14" /></button>}</div>
					{selected ? <>
						<div className="pd-fleet-detail-heading" data-fleet-state={selected.state}><StateGlyph state={selected.state} /><h4>{displayLabel(selected)}{isBatch(selected) && !soleLane(selected) ? ` · ${batchCount(selected)}` : ''}</h4><span>{t(`fleet.state.${selected.state}`)}</span></div>
						<div className="pd-fleet-detail-meta">{activityByRun.get(selected.id)?.model && <code>{activityByRun.get(selected.id)?.model}</code>}{selected.activity?.currentTool && <code>{selected.activity.currentTool}</code>}{selected.activity?.turnCount != null && <span>{t('fleet.turns', { count: selected.activity.turnCount })}</span>}{selected.activity?.toolCount != null && <span>{t('fleet.tools', { count: selected.activity.toolCount })}</span>}<time>{elapsed(selected, now)}</time></div>
						<div className="pd-fleet-detail-scroll" aria-busy={Boolean(request && !reply && !request.error)}>
							{reply ? <InspectContent reply={reply} /> : request?.error ? <p className="pd-fleet-inspect-error" role="alert">{request.error}</p> : <p className="pd-fleet-empty" role="status">{t(request ? 'fleet.loading' : selected.kind === 'host-step' ? 'fleet.hostStep' : 'fleet.inspectUnavailable')}</p>}
							{selected.hostStep && <p className="pd-fleet-host-detail">{selected.hostStep.detail ?? selected.hostStep.reasonCode ?? selected.hostStep.state}</p>}
						</div>
						{selection.rootId === selection.nodeId && isLive(selected) && (commands.has('subagents-steer') || commands.has('subagents-stop')) && <div className="pd-fleet-detail-actions">
							{steering ? <form className="pd-fleet-steer" onSubmit={(event) => { event.preventDefault(); if (message.trim()) void runCommand('subagents-steer', `${selected.id} ${message.trim()}`).then((ok) => { if (ok) { setMessage(''); setSteering(false); } }); }}>
								<label htmlFor={`${panelId}-steer`}>{t('fleet.steer')}</label><textarea id={`${panelId}-steer`} autoFocus value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('fleet.steerPlaceholder')} />
								<div><button type="button" onClick={() => setSteering(false)}>{t('fleet.cancel')}</button><button type="submit" disabled={!message.trim() || pending}>{t('fleet.steerSend')}</button></div>
							</form> : <>{commands.has('subagents-steer') && selected.state === 'running' && <button type="button" disabled={pending} onClick={() => setSteering(true)}><Icon name="steer" width="13" height="13" />{t('fleet.steer')}</button>}{commands.has('subagents-stop') && <button type="button" className="is-danger" disabled={pending} onClick={() => void runCommand('subagents-stop', selected.id)}><Icon name="square" width="11" height="11" />{t('fleet.stop')}</button>}</>}
						</div>}
					</> : <p className="pd-fleet-empty">{t('fleet.runRemoved')}</p>}
				</> : <div className="pd-fleet-panel-scroll">
					{[true, false].map((live) => {
						const rows = runs.map((node) => renderRow(node, node.id, live)).filter(Boolean);
						const title = live ? 'fleet.active' : 'fleet.done';
						return rows.length > 0 && <section className="pd-fleet-group" key={title}><h4>{t(title)}<span>{live ? activeCount : agents.length - activeCount}</span></h4><ul className="pd-fleet-runs">{rows}</ul></section>;
					})}
					{fleet && fleet.omittedRuns + fleet.omittedChildren > 0 && <p className="pd-fleet-empty">{t('fleet.omitted', { count: fleet.omittedRuns + fleet.omittedChildren })}</p>}
				</div>}
			</aside>}
		</div>
	</FleetContext.Provider>;
}
