import { useCallback, useEffect, useState } from 'react';
import type { UiSubagentFleetNode, UiSubagentInspectReply } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { operationFeedback } from '../operationFeedback';
import { Icon } from './Icons';
import './fleetCard.css';

/**
 * Native desktop replacement for the pi-subagents TUI FleetView / async widget.
 * The plugin (rpc mode) streams a bounded JSON fleet snapshot through the
 * `subagent-async` widget key; the agent service projects it into
 * `subagentFleet` state. The card is completely invisible when the plugin is
 * absent or has no runs, and its action buttons only appear while the plugin's
 * slash commands (subagents-stop / subagents-steer / subagents-inspect-rpc)
 * are registered.
 */

const SUBAGENT_COMMAND_NAMES = ['subagents-stop', 'subagents-steer', 'subagents-inspect-rpc'] as const;
type SubagentCommandName = (typeof SUBAGENT_COMMAND_NAMES)[number];

function formatElapsed(startedAt: number | undefined, endedAt: number | undefined, updatedAt: number | undefined): string {
	if (startedAt === undefined) return '';
	const end = endedAt ?? updatedAt ?? startedAt;
	const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function isLive(node: UiSubagentFleetNode): boolean {
	return node.state === 'running' || node.state === 'queued';
}

function liveCount(nodes: UiSubagentFleetNode[]): number {
	let count = 0;
	for (const node of nodes) {
		if (node.state === 'running') count++;
		if (node.children) count += liveCount(node.children);
	}
	return count;
}

function StatePill({ state }: { state: UiSubagentFleetNode['state'] }) {
	const { t } = useT();
	return <span className="pd-fleet-pill" data-fleet-state={state}>{t(`fleet.state.${state}`)}</span>;
}

function FleetNodeRow({ node, depth, actions }: { node: UiSubagentFleetNode; depth: number; actions: FleetActions }) {
	const { t } = useT();
	const elapsed = formatElapsed(node.startedAt, node.endedAt, node.updatedAt);
	const tool = node.activity?.currentTool;
	const counts: string[] = [];
	if (node.activity?.turnCount !== undefined) counts.push(t('fleet.turns', { count: String(node.activity.turnCount) }));
	if (node.activity?.toolCount !== undefined) counts.push(t('fleet.tools', { count: String(node.activity.toolCount) }));
	return (
		<li className="pd-fleet-node" data-fleet-state={node.state} style={{ paddingInlineStart: depth * 16 }}>
			<span className="pd-fleet-node-line">
				<StatePill state={node.state} />
				<span className="pd-fleet-node-label" title={node.label}>{node.label}</span>
				{elapsed && <span className="pd-fleet-node-elapsed">{elapsed}</span>}
			</span>
			{(tool || counts.length > 0 || node.hostStep) && (
				<span className="pd-fleet-node-detail">
					{tool && <code>{tool}</code>}
					{counts.map((count) => <span key={count}>{count}</span>)}
					{node.hostStep && <span className="pd-fleet-host-step" title={node.hostStep.detail ?? node.hostStep.reasonCode}>{t('fleet.hostStep')}{node.hostStep.verdict ? `: ${node.hostStep.verdict}` : ''}</span>}
				</span>
			)}
			{depth === 0 && actions.available && (isLive(node) || node.kind === 'subagent' || node.kind === 'workflow') && (
				<span className="pd-fleet-node-actions">
					{isLive(node) && <button type="button" disabled={!actions.enabled || actions.pending !== null} onClick={() => void actions.run('subagents-stop', node.id)}>{t('fleet.stop')}</button>}
					{node.state === 'running' && <button type="button" disabled={!actions.enabled || actions.pending !== null} onClick={() => actions.beginSteer(node.id)}>{t('fleet.steer')}</button>}
					<button type="button" disabled={!actions.enabled || actions.pending !== null} onClick={() => void actions.inspect(node)}>{t('fleet.inspect')}</button>
				</span>
			)}
			{node.children && node.children.length > 0 && (
				<ul className="pd-fleet-children">
					{node.children.map((child) => <FleetNodeRow key={`${child.kind}:${child.id}`} node={child} depth={depth + 1} actions={actions} />)}
				</ul>
			)}
		</li>
	);
}

interface FleetActions {
	available: boolean;
	enabled: boolean;
	pending: string | null;
	run(name: SubagentCommandName, args: string): Promise<void>;
	beginSteer(runId: string): void;
	inspect(node: UiSubagentFleetNode, childId?: string): Promise<void>;
}

function InspectDetail({ reply, onClose }: { reply: UiSubagentInspectReply; onClose: () => void }) {
	const { t } = useT();
	const messages = (reply.messages ?? []).slice(-20);
	return (
		<section className="pd-fleet-inspect">
			<header>
				<h4>{reply.label ?? reply.asyncId ?? t('fleet.title')}{reply.status ? ` · ${reply.status}` : ''}</h4>
				<button type="button" onClick={onClose} aria-label={t('fleet.close')}>✕</button>
			</header>
			{reply.error && <p className="pd-fleet-inspect-error">{t('fleet.inspectFailed')}: {reply.error.message} <code>({reply.error.code})</code></p>}
			{reply.task && <p className="pd-fleet-inspect-task"><strong>{t('fleet.inspectTask')}</strong>{reply.task}</p>}
			{reply.finalOutput && (
				<div className="pd-fleet-inspect-block">
					<h5>{t('fleet.inspectOutput')}</h5>
					<pre>{reply.finalOutput}</pre>
				</div>
			)}
			{messages.length > 0 && (
				<div className="pd-fleet-inspect-block">
					<h5>{t('fleet.inspectTranscript')}</h5>
					<ul>
						{messages.map((message, index) => (
							<li key={index} data-message-role={message.role ?? 'unknown'}><span>{message.role ?? ''}</span><p>{message.text}</p></li>
						))}
					</ul>
				</div>
			)}
			{reply.truncated && <p className="pd-fleet-inspect-truncated">{t('fleet.truncated')}</p>}
		</section>
	);
}

export function FleetCard() {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const sessionId = useChatStore((s) => s.sessionId);
	const fleet = useChatStore((s) => s.subagentFleet);
	const inspectReply = useChatStore((s) => s.subagentInspect);
	const [expanded, setExpanded] = useState(false);
	const [availableCommands, setAvailableCommands] = useState<Set<string>>(new Set());
	const [actionPending, setActionPending] = useState<string | null>(null);
	const [steerTarget, setSteerTarget] = useState<string | null>(null);
	const [steerMessage, setSteerMessage] = useState('');
	const [inspectRequest, setInspectRequest] = useState<string | null>(null);

	useEffect(() => {
		if (!bridge || typeof bridge.listSlashCommands !== 'function') { setAvailableCommands(new Set()); return; }
		let active = true;
		bridge.listSlashCommands()
			.then((commands) => { if (active) setAvailableCommands(new Set(commands.map((command) => command.name))); })
			.catch(() => { if (active) setAvailableCommands(new Set()); });
		return () => { active = false; };
	}, [bridge, sessionId]);

	const runCommand = useCallback(async (name: SubagentCommandName, args: string) => {
		const state = useChatStore.getState();
		const currentBridge = state.bridge;
		if (!currentBridge || !state.cwd || !state.sessionId || actionPending) return;
		setActionPending(name);
		try {
			await currentBridge.executeSlashCommand({ cwd: state.cwd, sessionId: state.sessionId, name, args });
		} catch (error) {
			operationFeedback.show({ id: `subagent-command:${name}`, kind: 'error', title: t('fleet.actionFailed'), detail: error instanceof Error ? error.message : String(error) });
		} finally {
			setActionPending(null);
		}
	}, [actionPending, t]);

	const actions: FleetActions = {
		available: SUBAGENT_COMMAND_NAMES.some((name) => availableCommands.has(name)),
		enabled: Boolean(sessionId),
		pending: actionPending,
		run: runCommand,
		beginSteer: (runId) => { setSteerTarget(runId); setSteerMessage(''); },
		inspect: async (node, childId) => {
			const requestId = Math.random().toString(36).slice(2, 10);
			setInspectRequest(requestId);
			await runCommand('subagents-inspect-rpc', `${requestId} ${node.id}${childId ? ` ${childId}` : ''} --lines 60`);
		},
	};

	if (!fleet || fleet.runs.length === 0) return null;

	const running = liveCount(fleet.runs);
	const headline = fleet.runs.find(isLive) ?? fleet.runs[0];
	const matchedInspect = inspectRequest && inspectReply?.requestId === inspectRequest ? inspectReply : null;

	return (
		<div className={`pd-fleet-card${expanded ? ' is-expanded' : ''}`} data-fleet-count={fleet.runs.length}>
			<button type="button" className="pd-fleet-strip" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={t(expanded ? 'fleet.collapse' : 'fleet.expand')}>
				<Icon name="plugins" width="13" height="13" />
				<span className="pd-fleet-strip-title">{t('fleet.title')}</span>
				{running > 0 && <span className="pd-fleet-badge">{t('fleet.running', { count: String(running) })}</span>}
				<StatePill state={headline.state} />
				<span className="pd-fleet-strip-label">{headline.label}</span>
				{headline.activity?.currentTool && <code className="pd-fleet-strip-tool">{headline.activity.currentTool}</code>}
				<Icon name={expanded ? 'chevronDown' : 'chevronUp'} width="13" height="13" className="pd-fleet-chevron" />
			</button>
			{expanded && (
				<div className="pd-fleet-panel">
					<ul className="pd-fleet-runs">
						{fleet.runs.map((run) => <FleetNodeRow key={`${run.kind}:${run.id}`} node={run} depth={0} actions={actions} />)}
					</ul>
					{(fleet.omittedRuns > 0 || fleet.omittedChildren > 0) && (
						<p className="pd-fleet-omitted">{t('fleet.omitted', { count: String(fleet.omittedRuns + fleet.omittedChildren) })}</p>
					)}
					{steerTarget && (
						<form className="pd-fleet-steer" onSubmit={(event) => { event.preventDefault(); if (steerMessage.trim()) { void runCommand('subagents-steer', `${steerTarget} ${steerMessage.trim()}`); setSteerTarget(null); setSteerMessage(''); } }}>
							<input autoFocus value={steerMessage} onChange={(event) => setSteerMessage(event.target.value)} placeholder={t('fleet.steerPlaceholder')} aria-label={t('fleet.steer')} />
							<button type="submit" disabled={!steerMessage.trim() || actionPending !== null}>{t('fleet.steerSend')}</button>
							<button type="button" onClick={() => setSteerTarget(null)}>{t('fleet.cancel')}</button>
						</form>
					)}
					{matchedInspect && <InspectDetail reply={matchedInspect} onClose={() => setInspectRequest(null)} />}
				</div>
			)}
		</div>
	);
}
