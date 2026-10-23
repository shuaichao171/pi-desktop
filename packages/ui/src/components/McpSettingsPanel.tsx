import { useEffect, useRef, useState } from 'react';
import type { McpFeaturesBridge, McpScope, UiMcpCliServer, UiMcpServer, UiMcpServerConfig, UiMcpSnapshot } from '../../../shared/src/mcpFeatures';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { technicalInputAttributes } from '../technicalInputAttributes';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './mcpSettingsPanel.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const emptySnapshot: UiMcpSnapshot = { cwd: '', sessionId: '', projectTrusted: false, servers: [], cliServers: [] };
function refsFromText(value: string): Record<string, string> {
	const output: Record<string, string> = {};
	for (const line of value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
		const position = line.indexOf('=');
		if (position <= 0 || !line.slice(position + 1).trim()) throw new Error('每行使用 目标名称=环境变量名称 / Use DESTINATION=ENV_VARIABLE on each line');
		output[line.slice(0, position).trim()] = line.slice(position + 1).trim();
	}
	return output;
}
const refsText = (value?: Record<string, string>) => Object.entries(value ?? {}).map(([key, reference]) => `${key}=${reference}`).join('\n');
const commandLine = (server: UiMcpServer) => server.transport === 'stdio' ? [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ') : server.url ?? '';
const cliCommandLine = (server: UiMcpCliServer) => server.transport === 'stdio' ? [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ') : server.url ?? '';

export function McpSettingsPanel() {
	const bridge = useChatStore((state) => state.bridge) as McpFeaturesBridge | null;
	const activeSession = useChatStore((state) => state.sessionId), cwd = useChatStore((state) => state.cwd);
	const { t } = useT();
	const [snapshot, setSnapshot] = useState(emptySnapshot), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [editing, setEditing] = useState<UiMcpServerConfig | null>(null), [scope, setScope] = useState<McpScope>('user');
	const [args, setArgs] = useState(''), [references, setReferences] = useState(''), [removing, setRemoving] = useState<UiMcpServer | null>(null);
	const generation = useRef(0), busyRef = useRef(false), removeDialog = useRef<HTMLDialogElement>(null), editorDialog = useRef<HTMLDialogElement>(null);
	const supported = typeof bridge?.getMcpSnapshot === 'function';
	useEffect(() => {
		const version = ++generation.current; setEditing(null); setRemoving(null); setError(null); setLoading(true);
		if (!supported) { setLoading(false); return; }
		void bridge!.getMcpSnapshot().then((value) => { if (generation.current === version) setSnapshot(value); }, (failure) => { if (generation.current === version) setError(errorText(failure)); }).finally(() => { if (generation.current === version) setLoading(false); });
		return () => { generation.current++; };
	}, [bridge, cwd, activeSession]);
	useEffect(() => { if (removing) removeDialog.current?.showModal(); else removeDialog.current?.close(); }, [removing]);
	const editorOpen = editing !== null;
	useEffect(() => { const node = editorDialog.current; if (editorOpen) { if (!node?.open) node?.showModal(); } else node?.close(); }, [editorOpen]);
	async function run(action: () => Promise<UiMcpSnapshot | string | void>) {
		if (busyRef.current || !bridge) return;
		const version = generation.current; busyRef.current = true; setBusy(true); setError(null); setNotice(null);
		try {
			const result = await action();
			if (version !== generation.current) return;
			if (typeof result === 'string') setNotice(result); else if (result) setSnapshot(result);
		} catch (failure) {
			if (version !== generation.current) return;
			setError(errorText(failure));
			try { const value = await bridge.getMcpSnapshot(); if (version === generation.current) setSnapshot(value); } catch { /* Keep the actionable first error. */ }
		} finally { busyRef.current = false; setBusy(false); }
	}
	function edit(server?: UiMcpServer) {
		const config = server ?? { id: crypto.randomUUID(), name: '', enabled: true, transport: 'stdio', command: '', args: [], requestTimeoutMs: 30_000 } as UiMcpServerConfig;
		setEditing(config); setScope(server?.scope ?? 'user'); setArgs((config.args ?? []).join('\n')); setReferences(refsText(config.transport === 'stdio' ? config.environment : config.headers)); setError(null);
	}
	const target = (server: UiMcpServer) => ({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope: server.scope, id: server.id });
	async function toggleConnection(server: UiMcpServer) {
		if (!bridge) return;
		if (server.status === 'connecting') {
			const version = generation.current;
			try { const result = await bridge.disconnectMcpServer(target(server)); if (generation.current === version) setSnapshot(result); }
			catch (failure) { if (generation.current === version) setError(errorText(failure)); }
			return;
		}
		await run(async () => {
			if (server.status === 'connected') return bridge.disconnectMcpServer(target(server));
			setSnapshot((value) => ({ ...value, servers: value.servers.map((item) => item.id === server.id && item.scope === server.scope ? { ...item, status: 'connecting' } : item) }));
			return bridge.connectMcpServer(target(server));
		});
	}
	const status = (server: UiMcpServer) => ({ disconnected: t('mcp.statusDisconnected'), connecting: t('mcp.statusConnecting'), connected: t('mcp.statusConnected'), error: t('mcp.statusError') })[server.status];
	const isNew = editing !== null && !snapshot.servers.some((server) => server.id === editing.id);
	const canAdd = supported && !busy && !loading && Boolean(snapshot.sessionId);
	const addButton = <button type="button" className="pd-mcp-button is-primary" disabled={!canAdd} onClick={() => edit()}><Icon name="plus" width="15" height="15" />{t('mcp.addServer')}</button>;

	return <div className="pd-mcp-panel" data-settings-page="mcp">
		<header className="pd-mcp-head">
			<div>
				<h2>MCP</h2>
				<p>{t('mcp.description')}</p>
			</div>
			<div className="pd-mcp-toolbar">
				<HoverTooltip title={t('mcp.refresh')} align="end">
					<button type="button" className="pd-mcp-icon-button" disabled={!supported || busy || loading} aria-label={t('mcp.refresh')} onClick={() => void run(() => bridge!.getMcpSnapshot())}><Icon name="refresh" width="15" height="15" /></button>
				</HoverTooltip>
				{addButton}
			</div>
		</header>

		{snapshot.cwd && <div className="pd-mcp-context">
			<Icon name="folder" width="15" height="15" />
			<span className="pd-mcp-owner" title={snapshot.cwd}>{snapshot.cwd}</span>
			{snapshot.sessionId && <span className="pd-mcp-chip" title={snapshot.sessionId}>{t('mcp.conversation')}<code className="pd-mcp-chip-id">{snapshot.sessionId.slice(0, 8)}</code></span>}
			<span className={`pd-mcp-chip ${snapshot.projectTrusted ? 'is-success' : 'is-warning'}`}>{snapshot.projectTrusted ? t('mcp.projectTrusted') : t('mcp.projectUntrusted')}</span>
		</div>}
		{!loading && supported && !snapshot.projectTrusted && <p className="pd-mcp-callout is-warning">{t('mcp.untrustedNotice')}</p>}

		{error && !editorOpen && <p className="pd-mcp-callout pd-mcp-error" role="alert">{error}</p>}
		{notice && <p className="pd-mcp-callout pd-mcp-notice" role="status"><Icon name="check" width="14" height="14" />{notice}</p>}
		{loading && <p className="pd-mcp-loading" role="status">{t('mcp.loading')}</p>}
		{!supported && <p className="pd-mcp-callout">{t('mcp.unsupported')}</p>}

		{supported && !loading && !snapshot.servers.length && <div className="pd-mcp-empty">
			<Icon name="plugins" width="24" height="24" />
			<strong>{t('mcp.emptyTitle')}</strong>
			<p>{t('mcp.emptyDescription')}</p>
			{addButton}
		</div>}

		<div className="pd-mcp-servers">{snapshot.servers.map((server) => {
			const live = server.status === 'connected' || server.status === 'connecting';
			return <article key={`${server.scope}:${server.id}`} className={`pd-mcp-server is-${server.status}${server.enabled ? '' : ' is-disabled'}`}>
				<header>
					<span className="pd-mcp-server-icon"><Icon name={server.transport === 'stdio' ? 'terminal' : 'globe'} width="17" height="17" /></span>
					<div className="pd-mcp-server-title">
						<h3>{server.name}</h3>
						<p>
							<span className="pd-mcp-chip">{server.scope === 'user' ? t('mcp.scopeUser') : t('mcp.scopeProject')}</span>
							<span className="pd-mcp-chip">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
							{!server.enabled && <span className="pd-mcp-chip">{t('mcp.disabled')}</span>}
						</p>
					</div>
					<span className={`pd-mcp-status is-${server.status}`}>{status(server)}</span>
					<HoverTooltip title={server.enabled ? t('mcp.disable') : t('mcp.enable')} align="end">
						<button type="button" role="switch" aria-checked={server.enabled} className="pd-mcp-switch" disabled={busy} onClick={() => void run(() => bridge!.saveMcpServer({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope: server.scope, config: { ...server, enabled: !server.enabled } }))}>
							<span className="pd-mcp-sr-only">{server.enabled ? t('mcp.disable') : t('mcp.enable')}</span>
						</button>
					</HoverTooltip>
				</header>
				<code className="pd-mcp-command" title={commandLine(server)}>{commandLine(server)}</code>
				{server.error && <p className="pd-mcp-callout pd-mcp-error" role="alert">{server.error}</p>}
				<footer>
					<button type="button" className={`pd-mcp-button${live ? '' : ' is-primary'}`} disabled={busy && server.status !== 'connecting' || !server.enabled} onClick={() => void toggleConnection(server)}>{live ? t('mcp.disconnect') : t('mcp.connect')}</button>
					<button type="button" className="pd-mcp-button" disabled={busy || !server.enabled} onClick={() => void run(async () => { const result = await bridge!.testMcpServer(target(server)); return t('mcp.testPassed', { count: result.tools.length, elapsed: result.elapsedMs }); })}>{t('mcp.test')}</button>
					<span className="pd-mcp-footer-spacer" />
					<HoverTooltip title={t('mcp.edit')} align="end">
						<button type="button" className="pd-mcp-icon-button is-ghost" disabled={busy} onClick={() => edit(server)}><Icon name="pencil" width="15" height="15" /><span className="pd-mcp-sr-only">{t('mcp.edit')}</span></button>
					</HoverTooltip>
					<HoverTooltip title={t('mcp.remove')} align="end">
						<button type="button" className="pd-mcp-icon-button is-ghost is-danger" disabled={busy} onClick={() => setRemoving(server)}><Icon name="trash" width="15" height="15" /><span className="pd-mcp-sr-only">{t('mcp.remove')}</span></button>
					</HoverTooltip>
				</footer>
				{server.tools.length > 0 && <details className="pd-mcp-tools">
					<summary><Icon name="chevronRight" width="14" height="14" />{t('mcp.toolCount', { count: server.tools.length })}</summary>
					<ul>{server.tools.map((tool) => <li key={tool.registeredName}><div><strong>{tool.name}</strong><code>{tool.registeredName}</code></div>{tool.description && <p>{tool.description}</p>}</li>)}</ul>
				</details>}
			</article>;
		})}</div>

		{(snapshot.cliServers ?? []).length > 0 && !loading && <section className="pd-mcp-cli" aria-labelledby="pd-mcp-cli-title">
			<header className="pd-mcp-cli-head">
				<div>
					<h3 id="pd-mcp-cli-title">{t('mcp.cliTitle')}</h3>
					<p>{t('mcp.cliDescription')}</p>
				</div>
				<span className="pd-mcp-chip">{t('mcp.readOnly')}</span>
			</header>
			<div className="pd-mcp-servers">{(snapshot.cliServers ?? []).map((server) =>
				<article key={`${server.scope}:${server.name}`} className={`pd-mcp-server pd-mcp-cli-server${server.enabled ? '' : ' is-disabled'}`} title={server.sourcePath}>
					<header>
						<span className="pd-mcp-server-icon"><Icon name={server.transport === 'stdio' ? 'terminal' : 'globe'} width="17" height="17" /></span>
						<div className="pd-mcp-server-title">
							<h3>{server.name}</h3>
							<p>
								<span className="pd-mcp-chip">{server.scope === 'user' ? t('mcp.scopeUser') : t('mcp.scopeProject')}</span>
								<span className="pd-mcp-chip">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
								{!server.enabled && <span className="pd-mcp-chip">{t('mcp.disabled')}</span>}
								{server.timeoutSeconds !== undefined && <span className="pd-mcp-chip">{t('mcp.timeoutChip', { seconds: server.timeoutSeconds })}</span>}
							</p>
						</div>
					</header>
					<code className="pd-mcp-command" title={cliCommandLine(server)}>{cliCommandLine(server)}</code>
				</article>)}
			</div>
		</section>}

		<dialog ref={editorDialog} className="pd-mcp-editor" aria-labelledby="pd-mcp-editor-title" onCancel={(event) => { event.preventDefault(); if (!busy) setEditing(null); }}>
			{editing && <form className="pd-mcp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
				const values = refsFromText(references), config: UiMcpServerConfig = { ...editing, ...(editing.transport === 'stdio' ? { args: args.split(/\r?\n/u).filter((value) => value.length), environment: values } : { headers: values }) };
				const result = await bridge!.saveMcpServer({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope, config }); setEditing(null); return result;
			}); }}>
				<header>
					<h3 id="pd-mcp-editor-title">{isNew ? t('mcp.addServer') : t('mcp.editServer')}</h3>
					<button type="button" className="pd-mcp-icon-button is-ghost" disabled={busy} aria-label={t('mcp.close')} onClick={() => setEditing(null)}><Icon name="close" width="15" height="15" /></button>
				</header>
				<fieldset disabled={busy}>
					<label>{t('mcp.name')}<input required maxLength={80} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder={t('mcp.namePlaceholder')} /></label>
					<div className="pd-mcp-field">
						<span>{t('mcp.transport')}</span>
						<div className="pd-mcp-segmented" role="radiogroup" aria-label={t('mcp.transport')}>
							{(['stdio', 'http'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={editing.transport === value} className={editing.transport === value ? 'is-active' : ''} onClick={() => { if (editing.transport !== value) { setEditing({ ...editing, transport: value }); setReferences(''); } }}>
								<Icon name={value === 'stdio' ? 'terminal' : 'globe'} width="14" height="14" />{value === 'stdio' ? t('mcp.transportStdio') : 'Streamable HTTP'}
							</button>)}
						</div>
					</div>
					<div className="pd-mcp-form-row">
						<label>{t('mcp.scope')}<select value={scope} disabled={!isNew} onChange={(event) => setScope(event.target.value as McpScope)}><option value="user">{t('mcp.scopeUser')}</option><option value="project" disabled={!snapshot.projectTrusted}>{t('mcp.scopeTrustedProject')}</option></select></label>
						<label>{t('mcp.timeout')}<input type="number" min="1" max="120" value={editing.requestTimeoutMs / 1000} onChange={(event) => setEditing({ ...editing, requestTimeoutMs: Number(event.target.value) * 1000 })} /></label>
					</div>
					{editing.transport === 'stdio' ? <>
						<label>{t('mcp.command')}<input required value={editing.command ?? ''} onChange={(event) => setEditing({ ...editing, command: event.target.value })} placeholder="C:\Tools\node.exe" {...technicalInputAttributes} /></label>
						<label>{t('mcp.args')}<small>{t('mcp.argsHint')}</small><textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} placeholder="server.mjs" {...technicalInputAttributes} /></label>
					</> : <label>{t('mcp.url')}<input required type="url" value={editing.url ?? ''} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="http://127.0.0.1:3000/mcp" {...technicalInputAttributes} /></label>}
					<label>{editing.transport === 'stdio' ? t('mcp.envRefs') : t('mcp.headerRefs')}
						<small>{t('mcp.refsHint')}</small>
						<textarea rows={3} value={references} onChange={(event) => setReferences(event.target.value)} placeholder={editing.transport === 'stdio' ? 'API_KEY=MY_MCP_API_KEY' : 'Authorization=MY_MCP_AUTH_HEADER'} {...technicalInputAttributes} />
					</label>
					{error && <p className="pd-mcp-callout pd-mcp-error" role="alert">{error}</p>}
				</fieldset>
				<footer>
					<label className="pd-mcp-checkbox"><input type="checkbox" checked={editing.enabled} disabled={busy} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />{t('mcp.enableConfig')}</label>
					<button type="button" className="pd-mcp-button" disabled={busy} onClick={() => setEditing(null)}>{t('mcp.cancel')}</button>
					<button type="submit" className="pd-mcp-button is-primary" disabled={busy}>{t('mcp.save')}</button>
				</footer>
			</form>}
		</dialog>

		<dialog ref={removeDialog} className="pd-mcp-remove" aria-labelledby="pd-mcp-remove-title" onCancel={(event) => { event.preventDefault(); if (!busy) setRemoving(null); }}>
			<h3 id="pd-mcp-remove-title">{t('mcp.removeTitle')}</h3>
			<strong>{removing?.name}</strong>
			<p>{t('mcp.removeDescription')}</p>
			<footer>
				<button type="button" className="pd-mcp-button" disabled={busy} onClick={() => setRemoving(null)}>{t('mcp.cancel')}</button>
				<button type="button" className="pd-mcp-button is-danger" disabled={busy || !removing} onClick={() => void run(async () => { const result = await bridge!.removeMcpServer(target(removing!)); setRemoving(null); return result; })}>{t('mcp.confirmRemove')}</button>
			</footer>
		</dialog>
	</div>;
}
