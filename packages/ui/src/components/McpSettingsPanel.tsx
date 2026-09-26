import { useEffect, useRef, useState } from 'react';
import type { McpFeaturesBridge, McpScope, UiMcpServer, UiMcpServerConfig, UiMcpSnapshot } from '../../../shared/src/mcpFeatures';
import { useChatStore } from '../store';
import { useT } from '../i18n';
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

export function McpSettingsPanel() {
	const bridge = useChatStore((state) => state.bridge) as McpFeaturesBridge | null;
	const activeSession = useChatStore((state) => state.sessionId), cwd = useChatStore((state) => state.cwd);
	const { locale } = useT(), label = (zh: string, en: string) => locale === 'en-US' ? en : zh;
	const [snapshot, setSnapshot] = useState(emptySnapshot), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [editing, setEditing] = useState<UiMcpServerConfig | null>(null), [scope, setScope] = useState<McpScope>('user');
	const [args, setArgs] = useState(''), [references, setReferences] = useState(''), [removing, setRemoving] = useState<UiMcpServer | null>(null);
	const generation = useRef(0), busyRef = useRef(false), removeDialog = useRef<HTMLDialogElement>(null);
	const supported = typeof bridge?.getMcpSnapshot === 'function';
	useEffect(() => {
		const version = ++generation.current; setEditing(null); setRemoving(null); setError(null); setLoading(true);
		if (!supported) { setLoading(false); return; }
		void bridge!.getMcpSnapshot().then((value) => { if (generation.current === version) setSnapshot(value); }, (failure) => { if (generation.current === version) setError(errorText(failure)); }).finally(() => { if (generation.current === version) setLoading(false); });
		return () => { generation.current++; };
	}, [bridge, cwd, activeSession]);
	useEffect(() => { if (removing) removeDialog.current?.showModal(); else removeDialog.current?.close(); }, [removing]);
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
	return <div className="pd-mcp-panel" data-settings-page="mcp">
		<header><h2>MCP</h2><p>{label('把外部工具连接到当前会话。每个会话都需要手动连接；保存配置不会启动程序。', 'Connect external tools to this conversation. Each conversation requires a manual connection; saving does not start a program.')}</p></header>
		{error && <p className="pd-mcp-error" role="alert">{error}</p>}{notice && <p className="pd-mcp-notice" role="status">{notice}</p>}
		{loading && <p role="status">{label('正在读取服务器…', 'Loading servers…')}</p>}
		{!supported && <p>{label('当前连接不支持 MCP。', 'MCP is unavailable on this connection.')}</p>}
		<div className="pd-mcp-toolbar"><button type="button" disabled={!supported || busy || loading || !snapshot.sessionId} onClick={() => edit()}>{label('添加服务器', 'Add server')}</button><button type="button" disabled={!supported || busy || loading} onClick={() => void run(() => bridge!.getMcpSnapshot())}>{label('刷新状态', 'Refresh status')}</button></div>
		<p className="pd-mcp-owner">{snapshot.cwd} · {label('会话', 'Conversation')} {snapshot.sessionId.slice(0, 8)}</p>
		{!snapshot.projectTrusted && <p>{label('项目尚未受信任，项目级 MCP 配置与连接不可用。用户级服务器仍需手动连接。', 'Project MCP configuration is unavailable until the project is trusted. User servers still require manual connection.')}</p>}
		{editing && <form className="pd-mcp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
			const values = refsFromText(references), config: UiMcpServerConfig = { ...editing, ...(editing.transport === 'stdio' ? { args: args.split(/\r?\n/u).filter((value) => value.length), environment: values } : { headers: values }) };
			const result = await bridge!.saveMcpServer({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope, config }); setEditing(null); return result;
		}); }}>
			<h3>{label('服务器配置', 'Server configuration')}</h3><fieldset disabled={busy}>
				<label>{label('名称', 'Name')}<input required maxLength={80} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
				<div className="pd-mcp-form-row"><label>{label('作用域', 'Scope')}<select value={scope} disabled={snapshot.servers.some((server) => server.id === editing.id)} onChange={(event) => setScope(event.target.value as McpScope)}><option value="user">{label('用户', 'User')}</option><option value="project" disabled={!snapshot.projectTrusted}>{label('当前可信项目', 'Current trusted project')}</option></select></label><label>{label('传输协议', 'Transport')}<select value={editing.transport} onChange={(event) => { setEditing({ ...editing, transport: event.target.value as 'stdio' | 'http' }); setReferences(''); }}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option></select></label><label>{label('超时（秒）', 'Timeout (seconds)')}<input type="number" min="1" max="120" value={editing.requestTimeoutMs / 1000} onChange={(event) => setEditing({ ...editing, requestTimeoutMs: Number(event.target.value) * 1000 })} /></label></div>
				{editing.transport === 'stdio' ? <><label>{label('可执行程序', 'Executable')}<input required value={editing.command ?? ''} onChange={(event) => setEditing({ ...editing, command: event.target.value })} placeholder="C:\\Tools\\node.exe" /></label><label>{label('启动参数（每行一个，不使用 shell）', 'Arguments (one per line, no shell)')}<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label></> : <label>{label('HTTP 地址', 'HTTP URL')}<input required type="url" value={editing.url ?? ''} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="http://127.0.0.1:3000/mcp" /></label>}
				<label>{editing.transport === 'stdio' ? label('环境变量凭据引用', 'Environment credential references') : label('请求头凭据引用', 'Header credential references')}<textarea rows={3} value={references} onChange={(event) => setReferences(event.target.value)} placeholder={editing.transport === 'stdio' ? 'API_KEY=MY_MCP_API_KEY' : 'Authorization=MY_MCP_AUTH_HEADER'} /></label><p>{label('每行使用 目标名称=已存在的环境变量名称。此处填写变量名，不填写密钥；变量值只在连接时解析，HTTP Authorization 的源变量应包含完整 Bearer 前缀。', 'Use DESTINATION=EXISTING_ENV_VARIABLE on each line. Enter variable names, not keys. Values are resolved only on connection; an Authorization reference should contain the complete Bearer header value.')}</p>
				<label className="pd-mcp-checkbox"><input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />{label('启用配置', 'Enable configuration')}</label><div className="pd-mcp-toolbar"><button type="submit">{label('保存配置', 'Save configuration')}</button><button type="button" onClick={() => setEditing(null)}>{label('取消', 'Cancel')}</button></div>
			</fieldset></form>}
		{!loading && !snapshot.servers.length && <p>{label('尚未配置服务器。支持 stdio 与 Streamable HTTP；OAuth 尚未支持。', 'No servers configured. stdio and Streamable HTTP are supported; OAuth is not yet supported.')}</p>}
		<div className="pd-mcp-servers">{snapshot.servers.map((server) => <article key={`${server.scope}:${server.id}`} className="pd-mcp-server"><header><h3>{server.name}</h3><span className={`pd-mcp-status is-${server.status}`}>{status(server)}</span></header><p>{server.scope === 'user' ? label('用户', 'User') : label('项目', 'Project')} · {server.transport} · {server.enabled ? label('已启用', 'Enabled') : label('已禁用', 'Disabled')}</p><code>{server.transport === 'stdio' ? server.command : server.url}</code>{server.error && <p className="pd-mcp-error" role="alert">{server.error}</p>}<div className="pd-mcp-toolbar">
			<button type="button" disabled={busy && server.status !== 'connecting' || !server.enabled} onClick={() => void toggleConnection(server)}>{server.status === 'connected' || server.status === 'connecting' ? label('断开', 'Disconnect') : label('连接到当前会话', 'Connect to this conversation')}</button>
			<button type="button" disabled={busy || !server.enabled} onClick={() => void run(async () => { const result = await bridge!.testMcpServer(target(server)); return label(`连接测试成功：发现 ${result.tools.length} 个工具，耗时 ${result.elapsedMs} ms。测试连接已关闭。`, `Connection test passed: ${result.tools.length} tools in ${result.elapsedMs} ms. The test connection is closed.`); })}>{label('测试连接', 'Test connection')}</button>
			<button type="button" disabled={busy} onClick={() => edit(server)}>{label('编辑', 'Edit')}</button><button type="button" disabled={busy} onClick={() => void run(() => bridge!.saveMcpServer({ cwd: snapshot.cwd, sessionId: snapshot.sessionId, scope: server.scope, config: { ...server, enabled: !server.enabled } }))}>{server.enabled ? label('禁用', 'Disable') : label('启用', 'Enable')}</button><button type="button" disabled={busy} onClick={() => setRemoving(server)}>{label('移除', 'Remove')}</button></div>
			{server.tools.length > 0 && <details><summary>{label(`已注册 ${server.tools.length} 个工具`, `${server.tools.length} registered tools`)}</summary><ul>{server.tools.map((tool) => <li key={tool.registeredName}><strong>{tool.name}</strong><code>{tool.registeredName}</code><p>{tool.description}</p></li>)}</ul></details>}
		</article>)}</div>
		<dialog ref={removeDialog} className="pd-mcp-remove" aria-labelledby="pd-mcp-remove-title" onCancel={(event) => { event.preventDefault(); if (!busy) setRemoving(null); }}><h3 id="pd-mcp-remove-title">{label('移除服务器配置', 'Remove server configuration')}</h3><p>{removing?.name}</p><p>{label('将断开受影响会话中的此服务器连接并移除配置。', 'This disconnects this server in affected conversations and removes its configuration.')}</p><div className="pd-mcp-toolbar"><button type="button" disabled={busy} onClick={() => setRemoving(null)}>{label('取消', 'Cancel')}</button><button type="button" disabled={busy || !removing} onClick={() => void run(async () => { const result = await bridge!.removeMcpServer(target(removing!)); setRemoving(null); return result; })}>{label('确认移除', 'Confirm removal')}</button></div></dialog>
	</div>;
}
