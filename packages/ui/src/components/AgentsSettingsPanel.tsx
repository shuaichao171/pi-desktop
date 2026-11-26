import { useEffect, useRef, useState } from 'react';
import type { UiAgentInstallState, UiAgentQuota, UiAgentSaveRequest, UiAgentStatus } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { technicalInputAttributes } from '../technicalInputAttributes';
import { agentQuotaLevel, agentQuotaWindowLabel, formatAgentQuotaPercent, formatAgentQuotaReset } from '../agentQuotaDisplay';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './mcpSettingsPanel.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const commandLine = (agent: UiAgentStatus) => [agent.command, ...agent.args].filter(Boolean).join(' ');
/** Where an install comes from: the npm package, or the host serving the script. */
const installSource = (agent: UiAgentStatus): string => agent.installer?.kind === 'npm'
	? agent.installer.package
	: /https:\/\/([^/\s]+)/.exec(agent.installHint ?? '')?.[1] ?? '';

/** Live output of one install run; follows the tail unless the user scrolled up. */
function InstallOutput({ text }: { text: string }) {
	const ref = useRef<HTMLPreElement>(null), pinned = useRef(true);
	useEffect(() => { const node = ref.current; if (node && pinned.current) node.scrollTop = node.scrollHeight; }, [text]);
	return <pre ref={ref} className="pd-agent-install-output" tabIndex={0} onScroll={(event) => {
		const node = event.currentTarget;
		pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
	}}>{text}</pre>;
}

function envFromText(value: string): Record<string, string> {
	const output: Record<string, string> = {};
	for (const line of value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
		const position = line.indexOf('=');
		if (position <= 0) throw new Error('每行使用 名称=值 / Use NAME=value on each line');
		output[line.slice(0, position).trim()] = line.slice(position + 1);
	}
	return output;
}
const envText = (value?: Record<string, string>) => Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join('\n');

/** The account's plan limits (5-hour and weekly windows), read when the card shows. */
function AgentQuotaSection({ agentId }: { agentId: string }) {
	const bridge = useChatStore((state) => state.bridge);
	const { t, locale } = useT();
	const [quota, setQuota] = useState<UiAgentQuota | null>(null);
	const [loading, setLoading] = useState(true);
	const [request, setRequest] = useState({ tick: 0, refresh: false });
	useEffect(() => {
		let active = true;
		setLoading(true);
		bridge!.readAgentQuota(agentId, request.refresh)
			.then((next) => { if (active) setQuota(next); })
			.catch((failure) => { if (active) setQuota({ agentId, ok: false, queriedAt: Date.now(), windows: [], error: errorText(failure) }); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [bridge, agentId, request]);
	return <section className="pd-agent-quota" aria-busy={loading || undefined} data-agent-quota={agentId}>
		<header>
			<strong>{t('agentQuota.title')}</strong>
			{quota?.plan && <span className="pd-mcp-chip">{quota.plan}</span>}
			<span className="pd-mcp-footer-spacer" />
			<HoverTooltip title={t('agentQuota.refresh')} align="end">
				<button type="button" className="pd-mcp-icon-button is-ghost" disabled={loading} aria-label={t('agentQuota.refresh')} onClick={() => setRequest((current) => ({ tick: current.tick + 1, refresh: true }))}><Icon name="refresh" width="14" height="14" className={loading ? 'is-spinning' : undefined} /></button>
			</HoverTooltip>
		</header>
		{!quota && loading && <p className="pd-agent-quota-muted" role="status">{t('agentQuota.loading')}</p>}
		{quota && quota.windows.length > 0 && <ul>{quota.windows.map((window, index) => <li key={`${window.kind}-${window.label ?? ''}-${index}`} className={`is-${agentQuotaLevel(window)}`}>
			<span className="pd-agent-quota-label">{agentQuotaWindowLabel(window, t)}</span>
			<span className="pd-agent-quota-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.usedPercent)} aria-label={agentQuotaWindowLabel(window, t)}><span style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} /></span>
			<span className="pd-agent-quota-value">{t('agentQuota.used', { percent: formatAgentQuotaPercent(window.usedPercent) })}</span>
			<span className="pd-agent-quota-reset">{window.resetsAt ? t('agentQuota.resets', { time: formatAgentQuotaReset(window.resetsAt, locale) }) : ''}</span>
		</li>)}</ul>}
		{quota?.ok && !quota.windows.length && <p className="pd-agent-quota-muted">{t('agentQuota.none')}</p>}
		{quota && !quota.ok && <p className="pd-agent-quota-error" role="alert">{t('agentQuota.failed', { error: quota.error ?? '' })}{quota.windows.length ? ` ${t('agentQuota.stale')}` : ''}</p>}
		<p className="pd-agent-quota-muted">{t('agentQuota.hint')}</p>
	</section>;
}

type Draft = { id?: string; displayName: string; command: string; args: string; env: string; enabled: boolean; accentColor: string | null; builtin: boolean };

/** External coding agents driven over ACP: readiness, enable switch and custom commands. */
export function AgentsSettingsPanel() {
	const bridge = useChatStore((state) => state.bridge);
	const agents = useChatStore((state) => state.agents);
	const refreshAgents = useChatStore((state) => state.refreshAgents);
	const saveAgent = useChatStore((state) => state.saveAgent);
	const removeAgent = useChatStore((state) => state.removeAgent);
	const { t } = useT();
	const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<Draft | null>(null), [removing, setRemoving] = useState<UiAgentStatus | null>(null);
	const [confirmInstall, setConfirmInstall] = useState<UiAgentStatus | null>(null);
	const [installs, setInstalls] = useState<Record<string, UiAgentInstallState>>({});
	const [dismissed, setDismissed] = useState<Record<string, number>>({});
	const [loginError, setLoginError] = useState<Record<string, string>>({});
	const [approvalsCleared, setApprovalsCleared] = useState(false);
	const editorDialog = useRef<HTMLDialogElement>(null), removeDialog = useRef<HTMLDialogElement>(null), installDialog = useRef<HTMLDialogElement>(null), busyRef = useRef(false);
	const supported = typeof bridge?.listAgents === 'function';
	const installSupported = typeof bridge?.installAgent === 'function';

	// Installs run in the main process and outlive this page: pick up runs in
	// progress, then follow their events. A finished install re-checks readiness.
	useEffect(() => {
		if (!installSupported || !bridge) return;
		let active = true;
		const apply = (state: UiAgentInstallState) => {
			if (!active) return;
			if (state.phase === 'succeeded') void refreshAgents(true).catch((failure) => { if (active) setError(errorText(failure)); });
			setInstalls((current) => ({ ...current, [state.agentId]: state }));
		};
		const unsubscribe = bridge.onAgentInstallEvent(apply);
		void bridge.listAgentInstalls()
			.then((states) => { if (active) setInstalls((current) => ({ ...Object.fromEntries(states.map((state) => [state.agentId, state])), ...current })); })
			.catch(() => {});
		return () => { active = false; unsubscribe(); };
	}, [installSupported, bridge, refreshAgents]);

	useEffect(() => {
		if (!supported) { setLoading(false); return; }
		let active = true;
		setLoading(true);
		void refreshAgents(true).catch((failure) => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [supported, refreshAgents]);
	const editorOpen = editing !== null;
	useEffect(() => { const node = editorDialog.current; if (editorOpen) { if (!node?.open) node?.showModal(); } else node?.close(); }, [editorOpen]);
	useEffect(() => { if (removing) removeDialog.current?.showModal(); else removeDialog.current?.close(); }, [removing]);
	useEffect(() => { if (confirmInstall) installDialog.current?.showModal(); else installDialog.current?.close(); }, [confirmInstall]);

	async function startInstall(agent: UiAgentStatus) {
		setConfirmInstall(null);
		setError(null);
		try {
			const state = await bridge!.installAgent(agent.id);
			// An event may already have reported a later state of this run.
			setInstalls((current) => current[agent.id]?.startedAt === state.startedAt ? current : { ...current, [agent.id]: state });
		} catch (failure) { setError(errorText(failure)); }
	}
	async function openLogin(agent: UiAgentStatus) {
		setLoginError((current) => { const next = { ...current }; delete next[agent.id]; return next; });
		try { await bridge!.openAgentLogin(agent.id); }
		catch (failure) { setLoginError((current) => ({ ...current, [agent.id]: errorText(failure) })); }
	}
	const installRunning = Object.values(installs).some((state) => state.phase === 'running');
	function installPanel(agent: UiAgentStatus) {
		const state = installs[agent.id];
		if (!state || dismissed[agent.id] === state.startedAt) return null;
		const running = state.phase === 'running';
		const title = running ? t('agents.installRunning') : state.phase === 'succeeded' ? t('agents.installSucceeded') : state.phase === 'cancelled' ? t('agents.installCancelled') : t('agents.installFailed');
		return <section className={`pd-agent-install is-${state.phase}`} aria-live="polite">
			<header>
				<Icon name={running ? 'loader' : state.phase === 'succeeded' ? 'check' : 'alert'} width="14" height="14" className={running ? 'is-spinning' : undefined} />
				<strong>{title}</strong>
				<span className="pd-mcp-footer-spacer" />
				{running
					? <button type="button" className="pd-btn pd-mcp-button" onClick={() => void bridge!.cancelAgentInstall(agent.id).catch((failure) => setError(errorText(failure)))}>{t('agents.installCancel')}</button>
					: <button type="button" className="pd-mcp-icon-button is-ghost" aria-label={t('agents.close')} onClick={() => setDismissed((current) => ({ ...current, [agent.id]: state.startedAt }))}><Icon name="close" width="14" height="14" /></button>}
			</header>
			{state.error && <p className="pd-agent-install-error" role="alert">{state.error}</p>}
			<InstallOutput text={state.output} />
			{state.phase === 'succeeded' && agent.readiness === 'install' && <p className="pd-mcp-callout is-warning">{t('agents.installNotDetected')}</p>}
			{state.phase === 'succeeded' && agent.readiness === 'ready' && agent.login && <p className="pd-mcp-callout">{t('agents.installNextLogin')}</p>}
		</section>;
	}

	async function run(action: () => Promise<void>): Promise<boolean> {
		if (busyRef.current) return false;
		busyRef.current = true; setBusy(true); setError(null);
		try { await action(); return true; }
		catch (failure) { setError(errorText(failure)); return false; }
		finally { busyRef.current = false; setBusy(false); }
	}
	const request = (agent: UiAgentStatus, patch: Partial<UiAgentSaveRequest> = {}): UiAgentSaveRequest => ({
		id: agent.id, displayName: agent.displayName, command: agent.command, args: agent.args, env: agent.env ?? {}, enabled: agent.enabled, accentColor: agent.accentColor ?? null, ...patch,
	});
	function edit(agent?: UiAgentStatus) {
		setError(null);
		setEditing(agent
			? { id: agent.id, displayName: agent.displayName, command: agent.command, args: agent.args.join('\n'), env: envText(agent.env), enabled: agent.enabled, accentColor: agent.accentColor ?? null, builtin: agent.builtin }
			: { displayName: '', command: '', args: '', env: '', enabled: true, accentColor: null, builtin: false });
	}
	const status = (agent: UiAgentStatus) => ({ ready: t('agents.statusReady'), install: t('agents.statusInstall'), attention: t('agents.statusAttention'), disabled: t('agents.statusDisabled') })[agent.readiness];
	const statusClass = (agent: UiAgentStatus) => agent.readiness === 'ready' ? 'connected' : agent.readiness === 'disabled' ? 'disconnected' : 'error';
	const addButton = <button type="button" className="pd-btn pd-mcp-button is-primary" disabled={!supported || busy} onClick={() => edit()}><Icon name="plus" width="15" height="15" />{t('agents.add')}</button>;

	return <div className="pd-mcp-panel" data-settings-page="agents">
		<header className="pd-mcp-head">
			<div>
				<h2>{t('agents.title')}</h2>
				<p>{t('agents.description')}</p>
			</div>
			<div className="pd-mcp-toolbar">
				<HoverTooltip title={t('agents.probe')} align="end">
					<button type="button" className="pd-mcp-icon-button" disabled={!supported || busy || loading} aria-label={t('agents.probe')} onClick={() => void run(() => refreshAgents(true))}><Icon name="refresh" width="15" height="15" /></button>
				</HoverTooltip>
				{addButton}
			</div>
		</header>
		<p className="pd-mcp-callout"><Icon name="alert" width="14" height="14" />{t('agents.lockNotice')}</p>
		{error && !editorOpen && <p className="pd-mcp-callout pd-mcp-error" role="alert">{error}</p>}
		{loading && !agents.length && <p className="pd-mcp-loading" role="status">{t('agents.loading')}</p>}
		{!supported && <p className="pd-mcp-callout">{t('agents.unsupported')}</p>}

		<div className="pd-mcp-servers">{agents.map((agent) => <article key={agent.id} className={`pd-mcp-server is-${statusClass(agent)}${agent.enabled ? '' : ' is-disabled'}`}>
			<header>
				<span className="pd-mcp-server-icon"><span className="pd-agent-mark" style={agent.accentColor ? { background: agent.accentColor } : undefined} aria-hidden="true">{agent.displayName.slice(0, 1).toUpperCase()}</span></span>
				<div className="pd-mcp-server-title">
					<h3>{agent.displayName}</h3>
					<p>
						<span className="pd-mcp-chip">{agent.builtin ? t('agents.builtin') : t('agents.custom')}</span>
						<span className="pd-mcp-chip">{agent.community ? t('agents.communityAcp') : 'ACP'}</span>
						{agent.version && <span className="pd-mcp-chip" title={agent.resolvedCommand ?? undefined}>{agent.version}</span>}
					</p>
				</div>
				<span className={`pd-mcp-status is-${statusClass(agent)}`}>{status(agent)}</span>
				<HoverTooltip title={agent.enabled ? t('agents.disable') : t('agents.enable')} align="end">
					<button type="button" role="switch" aria-checked={agent.enabled} className="pd-mcp-switch" disabled={busy} onClick={() => void run(() => saveAgent(request(agent, { enabled: !agent.enabled })))}>
						<span className="pd-mcp-sr-only">{agent.enabled ? t('agents.disable') : t('agents.enable')}</span>
					</button>
				</HoverTooltip>
			</header>
			<code className="pd-mcp-command" title={agent.resolvedCommand ?? commandLine(agent)}>{commandLine(agent)}</code>
			{(agent.community || agent.note) && <p className="pd-mcp-callout pd-agent-note">{[agent.community ? t('agents.communityNote') : '', agent.note ?? ''].filter(Boolean).join(' ')}</p>}
			{agent.readiness === 'install' && agent.installHint && <p className="pd-mcp-callout is-warning">{t('agents.installHint')}<code>{agent.installHint}</code></p>}
			{installPanel(agent)}
			{loginError[agent.id] && <p className="pd-mcp-callout pd-mcp-error" role="alert">{loginError[agent.id]}</p>}
			{agent.quota && agent.readiness === 'ready' && typeof bridge?.readAgentQuota === 'function' && <AgentQuotaSection key={`${agent.id}:${agent.command}`} agentId={agent.id} />}
			{agent.id === 'antigravity' && approvalsCleared && <p className="pd-mcp-callout" role="status">{t('agents.commandApprovalsCleared')}</p>}
			<footer>
				{agent.readiness === 'install' && agent.installer && installSupported && installs[agent.id]?.phase !== 'running'
					&& <button type="button" className="pd-btn pd-mcp-button is-primary" disabled={busy || installRunning} onClick={() => setConfirmInstall(agent)}><Icon name="update" width="14" height="14" />{t('agents.install')}</button>}
				{agent.readiness === 'ready' && agent.login && installSupported
					&& <HoverTooltip title={t('agents.loginTooltip', { command: [agent.login.command, ...agent.login.args].join(' ') })}><button type="button" className="pd-btn pd-mcp-button" onClick={() => void openLogin(agent)}><Icon name="terminal" width="14" height="14" />{t('agents.loginInTerminal')}</button></HoverTooltip>}
				{agent.homepage && <a className="pd-btn pd-mcp-button" href={agent.homepage} target="_blank" rel="noreferrer">{t('agents.homepage')}</a>}
				{agent.id === 'antigravity' && typeof bridge?.clearAntigravityCommandApprovals === 'function' && <button type="button" className="pd-btn pd-mcp-button" disabled={busy} onClick={() => void run(async () => {
					setApprovalsCleared(false);
					await bridge.clearAntigravityCommandApprovals();
					setApprovalsCleared(true);
				})}>{t('agents.clearCommandApprovals')}</button>}
				<span className="pd-mcp-footer-spacer" />
				<HoverTooltip title={t('agents.edit')} align="end">
					<button type="button" className="pd-mcp-icon-button is-ghost" disabled={busy} onClick={() => edit(agent)}><Icon name="pencil" width="15" height="15" /><span className="pd-mcp-sr-only">{t('agents.edit')}</span></button>
				</HoverTooltip>
				<HoverTooltip title={agent.builtin ? t('agents.reset') : t('agents.remove')} align="end">
					<button type="button" className="pd-mcp-icon-button is-ghost is-danger" disabled={busy} onClick={() => setRemoving(agent)}><Icon name={agent.builtin ? 'rotateCcw' : 'trash'} width="15" height="15" /><span className="pd-mcp-sr-only">{agent.builtin ? t('agents.reset') : t('agents.remove')}</span></button>
				</HoverTooltip>
			</footer>
		</article>)}</div>

		<dialog ref={editorDialog} className="pd-mcp-editor" aria-labelledby="pd-agent-editor-title" onCancel={(event) => { event.preventDefault(); if (!busy) setEditing(null); }}>
			{editing && <form className="pd-mcp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
				await saveAgent({ ...(editing.id ? { id: editing.id } : {}), displayName: editing.displayName.trim(), command: editing.command.trim(),
					args: editing.args.split(/\r?\n/u).filter((value) => value.length), env: envFromText(editing.env), enabled: editing.enabled, accentColor: editing.accentColor });
				setEditing(null);
			}); }}>
				<header>
					<h3 id="pd-agent-editor-title">{editing.id ? t('agents.editTitle') : t('agents.add')}</h3>
					<button type="button" className="pd-mcp-icon-button is-ghost" disabled={busy} aria-label={t('agents.close')} onClick={() => setEditing(null)}><Icon name="close" width="15" height="15" /></button>
				</header>
				<fieldset disabled={busy}>
					<label>{t('agents.name')}<input required maxLength={80} value={editing.displayName} onChange={(event) => setEditing({ ...editing, displayName: event.target.value })} placeholder="My Agent" /></label>
					<label>{t('agents.command')}<small>{t('agents.commandHint')}</small><input required value={editing.command} onChange={(event) => setEditing({ ...editing, command: event.target.value })} placeholder="my-agent-acp" {...technicalInputAttributes} /></label>
					<label>{t('agents.args')}<small>{t('agents.argsHint')}</small><textarea rows={3} value={editing.args} onChange={(event) => setEditing({ ...editing, args: event.target.value })} placeholder="--acp" {...technicalInputAttributes} /></label>
					<label>{t('agents.env')}<small>{t('agents.envHint')}</small><textarea rows={3} value={editing.env} onChange={(event) => setEditing({ ...editing, env: event.target.value })} placeholder="NAME=value" {...technicalInputAttributes} /></label>
					{error && <p className="pd-mcp-callout pd-mcp-error" role="alert">{error}</p>}
				</fieldset>
				<footer>
					<label className="pd-mcp-checkbox"><input type="checkbox" checked={editing.enabled} disabled={busy} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />{t('agents.enable')}</label>
					<button type="button" className="pd-btn pd-mcp-button" disabled={busy} onClick={() => setEditing(null)}>{t('agents.cancel')}</button>
					<button type="submit" className="pd-btn pd-mcp-button is-primary" disabled={busy}>{t('agents.save')}</button>
				</footer>
			</form>}
		</dialog>

		<dialog ref={installDialog} className="pd-mcp-remove pd-agent-install-confirm" aria-labelledby="pd-agent-install-title" onCancel={(event) => { event.preventDefault(); setConfirmInstall(null); }}>
			<h3 id="pd-agent-install-title">{t('agents.installTitle', { name: confirmInstall?.displayName ?? '' })}</h3>
			<code className="pd-mcp-command">{confirmInstall?.installHint}</code>
			<p>{t(confirmInstall?.installer?.kind === 'script' ? 'agents.installScriptWarning' : 'agents.installNpmWarning', { source: confirmInstall ? installSource(confirmInstall) : '' })}</p>
			<footer>
				<button type="button" className="pd-btn pd-mcp-button" onClick={() => setConfirmInstall(null)}>{t('agents.cancel')}</button>
				<button type="button" className="pd-btn pd-mcp-button is-primary" disabled={!confirmInstall} onClick={() => { if (confirmInstall) void startInstall(confirmInstall); }}>{t('agents.installConfirm')}</button>
			</footer>
		</dialog>

		<dialog ref={removeDialog} className="pd-mcp-remove" aria-labelledby="pd-agent-remove-title" onCancel={(event) => { event.preventDefault(); if (!busy) setRemoving(null); }}>
			<h3 id="pd-agent-remove-title">{removing?.builtin ? t('agents.resetTitle') : t('agents.removeTitle')}</h3>
			<strong>{removing?.displayName}</strong>
			<p>{removing?.builtin ? t('agents.resetDescription') : t('agents.removeDescription')}</p>
			<footer>
				<button type="button" className="pd-btn pd-mcp-button" disabled={busy} onClick={() => setRemoving(null)}>{t('agents.cancel')}</button>
				<button type="button" className="pd-btn pd-mcp-button is-danger" disabled={busy || !removing} onClick={() => void run(async () => { await removeAgent(removing!.id); setRemoving(null); })}>{removing?.builtin ? t('agents.reset') : t('agents.remove')}</button>
			</footer>
		</dialog>
	</div>;
}
