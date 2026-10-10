import { useEffect, useRef, useState } from 'react';
import type { McpFeaturesBridge, McpScope, UiMcpServer, UiMcpServerConfig, UiMcpSnapshot } from '../../../shared/src/mcpFeatures';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { technicalInputAttributes } from '../technicalInputAttributes';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './mcpSettingsPanel.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const emptySnapshot: UiMcpSnapshot = { cwd: '', sessionId: '', projectTrusted: false, servers: [] };
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

export function McpSettingsPanel() {
	const bridge = useChatStore((state) => state.bridge) as McpFeaturesBridge | null;
	const activeSession = useChatStore((state) => state.sessionId), cwd = useChatStore((state) => state.cwd);
	const { locale } = useT(), label = (zh: string, en: string) => locale === 'en-US' ? en : zh;
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
	const status = (server: UiMcpServer) => ({ disconnected: label('未连接', 'Disconnected'), connecting: label('连接中', 'Connecting'), connected: label('已连接', 'Connected'), error: label('连接错误', 'Connection error') })[server.status];
	const isNew = editing !== null && !snapshot.servers.some((server) => server.id === editing.id);
	const canAdd = supported && !busy && !loading && Boolean(snapshot.sessionId);
	const addButton = <button type="button" className="pd-mcp-button is-primary" disabled={!canAdd} onClick={() => edit()}><Icon name="plus" width="15" height="15" />{label('添加服务器', 'Add server')}</button>;

	return <div className="pd-mcp-panel" data-settings-page="mcp">
		<header className="pd-mcp-head">
			<div>
				<h2>MCP</h2>
				<p>{label('把外部工具连接到当前会话。每个会话都需要手动连接；保存配置不会启动程序。', 'Connect external tools to this conversation. Each conversation requires a manual connection; saving does not start a program.')}</p>
			</div>
			<div className="pd-mcp-toolbar">
				<HoverTooltip title={label('刷新状态', 'Refresh status')} align="end">
					<button type="button" className="pd-mcp-icon-button" disabled={!supported || busy || loading} aria-label={label('刷新状态', 'Refresh status')} onClick={() => void run(() => bridge!.getMcpSnapshot())}><Icon name="refresh" width="15" height="15" /></button>
				</HoverTooltip>
				{addButton}
			</div>
		</header>

		{snapshot.cwd && <div className="pd-mcp-context">
			<Icon name="folder" width="15" height="15" />
			<span className="pd-mcp-owner" title={snapshot.cwd}>{snapshot.cwd}</span>
			{snapshot.sessionId && <span className="pd-mcp-chip" title={snapshot.sessionId}>{label('会话', 'Conversation')}<code className="pd-mcp-chip-id">{snapshot.sessionId.slice(0, 8)}</code></span>}
			<span className={`pd-mcp-chip ${snapshot.projectTrusted ? 'is-success' : 'is-warning'}`}>{snapshot.projectTrusted ? label('项目已受信任', 'Trusted project') : label('项目未受信任', 'Untrusted project')}</span>
		</div>}
		{!loading && supported && !snapshot.projectTrusted && <p className="pd-mcp-callout is-warning">{label('项目尚未受信任，项目级 MCP 配置与连接不可用。用户级服务器仍需手动连接。', 'Project MCP configuration is unavailable until the project is trusted. User servers still require manual connection.')}</p>}

		{error && !editorOpen && <p className="pd-mcp-callout pd-mcp-error" role="alert">{error}</p>}
		{notice && <p className="pd-mcp-callout pd-mcp-notice" role="status"><Icon name="check" width="14" height="14" />{notice}</p>}
		{loading && <p className="pd-mcp-loading" role="status">{label('正在读取服务器…', 'Loading servers…')}</p>}
		{!supported && <p className="pd-mcp-callout">{label('当前连接不支持 MCP。', 'MCP is unavailable on this connection.')}</p>}

		{supported && !loading && !snapshot.servers.length && <div className="pd-mcp-empty">
			<Icon name="plugins" width="24" height="24" />
			<strong>{label('尚未配置服务器', 'No servers configured')}</strong>
			<p>{label('支持 stdio 与 Streamable HTTP；OAuth 尚未支持。', 'stdio and Streamable HTTP are supported; OAuth is not yet supported.')}</p>
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
							<span className="pd-mcp-chip">{server.scope === 'user' ? label('用户', 'User') : label('项目', 'Project')}</span>
							<span className="pd-mcp-chip">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
							{!server.enabled && <span className="pd-mcp-chip">{label('已禁用', 'Disabled')}</span>}
						</p>
					</div>
					<span className={`pd-mcp-status is-${server.status}`}>{status(server)}</span>
					<HoverTooltip title={server.enabled ? label('禁用', 'Disable') : label('启用', 'Enable')} align="end">
						<button type="button" role="switch" aria-checked={server.enabled} className="pd-mcp-switch" disabled={busy} onClick={() => void run(() => bridge!.saveMcpServer({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope: server.scope, config: { ...server, enabled: !server.enabled } }))}>
							<span className="pd-mcp-sr-only">{server.enabled ? label('禁用', 'Disable') : label('启用', 'Enable')}</span>
						</button>
					</HoverTooltip>
				</header>
				<code className="pd-mcp-command" title={commandLine(server)}>{commandLine(server)}</code>
				{server.error && <p className="pd-mcp-callout pd-mcp-error" role="alert">{server.error}</p>}
				<footer>
					<button type="button" className={`pd-mcp-button${live ? '' : ' is-primary'}`} disabled={busy && server.status !== 'connecting' || !server.enabled} onClick={() => void toggleConnection(server)}>{live ? label('断开', 'Disconnect') : label('连接到当前会话', 'Connect to this conversation')}</button>
					<button type="button" className="pd-mcp-button" disabled={busy || !server.enabled} onClick={() => void run(async () => { const result = await bridge!.testMcpServer(target(server)); return label(`连接测试成功：发现 ${result.tools.length} 个工具，耗时 ${result.elapsedMs} ms。测试连接已关闭。`, `Connection test passed: ${result.tools.length} tools in ${result.elapsedMs} ms. The test connection is closed.`); })}>{label('测试连接', 'Test connection')}</button>
					<span className="pd-mcp-footer-spacer" />
					<HoverTooltip title={label('编辑', 'Edit')} align="end">
						<button type="button" className="pd-mcp-icon-button is-ghost" disabled={busy} onClick={() => edit(server)}><Icon name="pencil" width="15" height="15" /><span className="pd-mcp-sr-only">{label('编辑', 'Edit')}</span></button>
					</HoverTooltip>
					<HoverTooltip title={label('移除', 'Remove')} align="end">
						<button type="button" className="pd-mcp-icon-button is-ghost is-danger" disabled={busy} onClick={() => setRemoving(server)}><Icon name="trash" width="15" height="15" /><span className="pd-mcp-sr-only">{label('移除', 'Remove')}</span></button>
					</HoverTooltip>
				</footer>
				{server.tools.length > 0 && <details className="pd-mcp-tools">
					<summary><Icon name="chevronRight" width="14" height="14" />{label(`已注册 ${server.tools.length} 个工具`, `${server.tools.length} registered tools`)}</summary>
					<ul>{server.tools.map((tool) => <li key={tool.registeredName}><div><strong>{tool.name}</strong><code>{tool.registeredName}</code></div>{tool.description && <p>{tool.description}</p>}</li>)}</ul>
				</details>}
			</article>;
		})}</div>

		<dialog ref={editorDialog} className="pd-mcp-editor" aria-labelledby="pd-mcp-editor-title" onCancel={(event) => { event.preventDefault(); if (!busy) setEditing(null); }}>
			{editing && <form className="pd-mcp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
				const values = refsFromText(references), config: UiMcpServerConfig = { ...editing, ...(editing.transport === 'stdio' ? { args: args.split(/\r?\n/u).filter((value) => value.length), environment: values } : { headers: values }) };
				const result = await bridge!.saveMcpServer({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope, config }); setEditing(null); return result;
			}); }}>
				<header>
					<h3 id="pd-mcp-editor-title">{isNew ? label('添加服务器', 'Add server') : label('编辑服务器', 'Edit server')}</h3>
					<button type="button" className="pd-mcp-icon-button is-ghost" disabled={busy} aria-label={label('关闭', 'Close')} onClick={() => setEditing(null)}><Icon name="close" width="15" height="15" /></button>
				</header>
				<fieldset disabled={busy}>
					<label>{label('名称', 'Name')}<input required maxLength={80} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder={label('例如：文件系统工具', 'e.g. Filesystem tools')} /></label>
					<div className="pd-mcp-field">
						<span>{label('传输协议', 'Transport')}</span>
						<div className="pd-mcp-segmented" role="radiogroup" aria-label={label('传输协议', 'Transport')}>
							{(['stdio', 'http'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={editing.transport === value} className={editing.transport === value ? 'is-active' : ''} onClick={() => { if (editing.transport !== value) { setEditing({ ...editing, transport: value }); setReferences(''); } }}>
								<Icon name={value === 'stdio' ? 'terminal' : 'globe'} width="14" height="14" />{value === 'stdio' ? label('本地程序 (stdio)', 'Local program (stdio)') : 'Streamable HTTP'}
							</button>)}
						</div>
					</div>
					<div className="pd-mcp-form-row">
						<label>{label('作用域', 'Scope')}<select value={scope} disabled={!isNew} onChange={(event) => setScope(event.target.value as McpScope)}><option value="user">{label('用户', 'User')}</option><option value="project" disabled={!snapshot.projectTrusted}>{label('当前可信项目', 'Current trusted project')}</option></select></label>
						<label>{label('超时（秒）', 'Timeout (seconds)')}<input type="number" min="1" max="120" value={editing.requestTimeoutMs / 1000} onChange={(event) => setEditing({ ...editing, requestTimeoutMs: Number(event.target.value) * 1000 })} /></label>
					</div>
					{editing.transport === 'stdio' ? <>
						<label>{label('可执行程序', 'Executable')}<input required value={editing.command ?? ''} onChange={(event) => setEditing({ ...editing, command: event.target.value })} placeholder="C:\Tools\node.exe" {...technicalInputAttributes} /></label>
						<label>{label('启动参数', 'Arguments')}<small>{label('每行一个，不经过 shell', 'One per line, no shell')}</small><textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} placeholder="server.mjs" {...technicalInputAttributes} /></label>
					</> : <label>{label('HTTP 地址', 'HTTP URL')}<input required type="url" value={editing.url ?? ''} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="http://127.0.0.1:3000/mcp" {...technicalInputAttributes} /></label>}
					<label>{editing.transport === 'stdio' ? label('环境变量凭据引用', 'Environment credential references') : label('请求头凭据引用', 'Header credential references')}
						<small>{label('每行使用 目标名称=已存在的环境变量名称。此处填写变量名，不填写密钥；变量值只在连接时解析，HTTP Authorization 的源变量应包含完整 Bearer 前缀。', 'Use DESTINATION=EXISTING_ENV_VARIABLE on each line. Enter variable names, not keys. Values are resolved only on connection; an Authorization reference should contain the complete Bearer header value.')}</small>
						<textarea rows={3} value={references} onChange={(event) => setReferences(event.target.value)} placeholder={editing.transport === 'stdio' ? 'API_KEY=MY_MCP_API_KEY' : 'Authorization=MY_MCP_AUTH_HEADER'} {...technicalInputAttributes} />
					</label>
					{error && <p className="pd-mcp-callout pd-mcp-error" role="alert">{error}</p>}
				</fieldset>
				<footer>
					<label className="pd-mcp-checkbox"><input type="checkbox" checked={editing.enabled} disabled={busy} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />{label('启用配置', 'Enable configuration')}</label>
					<button type="button" className="pd-mcp-button" disabled={busy} onClick={() => setEditing(null)}>{label('取消', 'Cancel')}</button>
					<button type="submit" className="pd-mcp-button is-primary" disabled={busy}>{label('保存配置', 'Save configuration')}</button>
				</footer>
			</form>}
		</dialog>

		<dialog ref={removeDialog} className="pd-mcp-remove" aria-labelledby="pd-mcp-remove-title" onCancel={(event) => { event.preventDefault(); if (!busy) setRemoving(null); }}>
			<h3 id="pd-mcp-remove-title">{label('移除服务器配置', 'Remove server configuration')}</h3>
			<strong>{removing?.name}</strong>
			<p>{label('将断开受影响会话中的此服务器连接并移除配置。', 'This disconnects this server in affected conversations and removes its configuration.')}</p>
			<footer>
				<button type="button" className="pd-mcp-button" disabled={busy} onClick={() => setRemoving(null)}>{label('取消', 'Cancel')}</button>
				<button type="button" className="pd-mcp-button is-danger" disabled={busy || !removing} onClick={() => void run(async () => { const result = await bridge!.removeMcpServer(target(removing!)); setRemoving(null); return result; })}>{label('确认移除', 'Confirm removal')}</button>
			</footer>
		</dialog>
	</div>;
}
