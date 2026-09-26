import { useEffect, useRef, useState } from 'react';
import type { DataFeaturesBridge, ProjectSearchRules, SessionTrashEntry } from '../../../shared/src/dataFeatures';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import './dataRecoveryPage.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const leaf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const splitRules = (value: string) => value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);

export function DataRecoveryPage() {
	const bridge = useChatStore((state) => state.bridge) as (DataFeaturesBridge | null);
	const cwd = useChatStore((state) => state.cwd), workspaces = useChatStore((state) => state.workspaces);
	const { locale } = useT();
	const label = (zh: string, en: string) => locale === 'en-US' ? en : zh;
	const [entries, setEntries] = useState<SessionTrashEntry[]>([]), [days, setDays] = useState(0);
	const [selected, setSelected] = useState<string[]>([]), [target, setTarget] = useState(''), [importTarget, setImportTarget] = useState(cwd);
	const [rules, setRules] = useState<ProjectSearchRules | null>(null), [ignored, setIgnored] = useState(''), [include, setInclude] = useState(''), [exclude, setExclude] = useState('');
	const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
	const [confirmCleanup, setConfirmCleanup] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null), busyRef = useRef(false), mounted = useRef(true);
	const ready = typeof bridge?.listSessionTrash === 'function';
	async function reload() {
		if (!bridge || !ready) return;
		const trash = await bridge.listSessionTrash();
		if (!mounted.current) return;
		setEntries(trash.entries); setDays(trash.retentionDays); setSelected((ids) => ids.filter((id) => trash.entries.some((item) => item.id === id)));
	}
	useEffect(() => {
		mounted.current = true;
		let current = true;
		if (!bridge || !ready) { setLoading(false); return; }
		setLoading(true);
		void reload().then(async () => {
			if (!cwd) return;
			const value = await bridge.getProjectSearchRules();
			if (!current) return;
			setRules(value); setIgnored(value.ignoredDirectories.join('\n')); setInclude(value.include.join('\n')); setExclude(value.exclude.join('\n'));
		}).catch((failure) => { if (current) setError(errorText(failure)); }).finally(() => { if (current) setLoading(false); });
		return () => { current = false; mounted.current = false; };
	}, [bridge, cwd]);
	useEffect(() => { if (confirmCleanup) dialog.current?.showModal(); else dialog.current?.close(); }, [confirmCleanup]);
	useEffect(() => { if (!workspaces.includes(importTarget)) setImportTarget(cwd); }, [cwd, workspaces]);
	async function run(action: () => Promise<string | void>) {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(true); setError(null); setNotice(null);
		try { const message = await action(); if (mounted.current) { if (message) setNotice(message); await reload(); } }
		catch (failure) { if (mounted.current) setError(errorText(failure)); }
		finally { busyRef.current = false; if (mounted.current) setBusy(false); }
	}
	const selectedEntries = entries.filter((entry) => selected.includes(entry.id));
	const expired = entries.filter((entry) => entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now());
	async function restore(entry: SessionTrashEntry) {
		if (!bridge) return;
		await run(async () => {
			const result = await bridge.restoreSessionTrash({ id: entry.id, cwd: target || undefined });
			await useChatStore.getState().refreshWorkspaceSessions(result.cwd);
			return [label('会话和分支已恢复。', 'Conversation and branches restored.'), ...result.warnings].join(' ');
		});
	}
	async function importFile(format: 'native' | 'backup') {
		if (!bridge) return;
		await run(async () => {
			const result = await bridge.importSessions(format, importTarget);
			if (!result) return;
			await useChatStore.getState().refreshWorkspaceSessions(result.cwd);
			return [result.duplicate ? label('这份文件已导入，没有创建重复会话。', 'Already imported; no duplicate conversations created.') : label(`已导入 ${result.paths.length} 个会话，可在侧边栏打开并继续。`, `Imported ${result.paths.length} conversations. Open them in the sidebar to continue.`), ...result.warnings].join(' ');
		});
	}
	return <div className="pd-data-page" data-settings-page="data">
		<header><h2>{label('数据与恢复', 'Data & recovery')}</h2><p>{label('找回已删除会话，管理搜索范围，并迁移完整会话历史。', 'Recover deleted conversations, configure search, and move complete conversation history.')}</p></header>
		{error && <p className="pd-data-error" role="alert">{error}</p>}{notice && <p className="pd-data-notice" role="status">{notice}</p>}
		{!ready && <p>{label('当前连接不支持数据管理。', 'Data management is unavailable on this connection.')}</p>}
		{loading && <p role="status">{label('正在读取…', 'Loading…')}</p>}
		<fieldset disabled={busy || !ready || loading}><legend>{label('会话回收站', 'Conversation recycle bin')}</legend>
			<div className="pd-data-toolbar"><label>{label('保留天数（0 为永久）', 'Retention days (0 = forever)')}<input type="number" min="0" max="3650" value={days} onChange={(event) => setDays(Number(event.target.value))} /></label><button type="button" onClick={() => void run(async () => { await bridge!.setSessionTrashRetention(days); return label('已保存保留规则。只有手动确认清理才会永久删除。', 'Retention saved. Permanent deletion requires explicit cleanup confirmation.'); })}>{label('保存规则', 'Save retention')}</button><button type="button" onClick={() => void run(reload)}>{label('刷新', 'Refresh')}</button></div>
			<p>{label('保留规则只标记可清理项目；不会自动删除。旧版回收文件缺少已丢弃的分组信息。', 'Retention marks cleanup candidates; it does not delete automatically. Legacy trash files cannot recover discarded group metadata.')}</p>
			<label>{label('恢复位置', 'Restore destination')}<select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">{label('原工作区', 'Original workspace')}</option>{workspaces.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
			{!entries.length && <p>{label('回收站为空。', 'The recycle bin is empty.')}</p>}
			<ul className="pd-data-trash-list">{entries.map((entry) => <li key={entry.id}><label className="pd-data-trash-select"><input type="checkbox" checked={selected.includes(entry.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id))} /><span><strong>{entry.name || leaf(entry.originalPath || entry.id)}</strong><small>{entry.cwd || label('旧版项目 · 请指定恢复工作区', 'Legacy item · choose a destination')}</small><small>{new Date(entry.deletedAt).toLocaleString(locale)} · {(entry.bytes / 1024).toFixed(1)} KiB {entry.legacy ? `· ${label('旧版元数据缺失', 'Legacy metadata unavailable')}` : ''}</small></span></label><button type="button" onClick={() => void restore(entry)}>{label('恢复', 'Restore')}</button></li>)}</ul>
			<div className="pd-data-toolbar"><button type="button" disabled={!expired.length} onClick={() => setSelected(expired.map((entry) => entry.id))}>{label(`选择过期项目 (${expired.length})`, `Select expired (${expired.length})`)}</button><button type="button" disabled={!selected.length} onClick={() => setConfirmCleanup(true)}>{label(`永久清理所选 (${selected.length})`, `Permanently remove selected (${selected.length})`)}</button></div>
		</fieldset>
		<fieldset disabled={busy || !ready || loading}><legend>{label('导入与完整备份', 'Import & complete backup')}</legend><p>{label('原生 JSONL 导入保留文件中的所有分支。完整备份额外保存桌面标记、分组与已嵌入附件及其历史来源引用。Markdown、HTML 和当前分支 JSONL 导出不等于完整备份。', 'Native JSONL imports every branch contained in the file. Complete backups also preserve desktop flags, groups, embedded attachments and their historical source references. Markdown, HTML and current-branch JSONL exports are separate formats.')}</p><label>{label('导入目标工作区', 'Import destination')}<select value={importTarget} onChange={(event) => setImportTarget(event.target.value)}><option value="">{label('请选择工作区', 'Select a workspace')}</option>{workspaces.map((path) => <option key={path} value={path}>{path}</option>)}</select></label><div className="pd-data-toolbar"><button type="button" disabled={!importTarget} onClick={() => void importFile('native')}>{label('导入 Pi JSONL', 'Import Pi JSONL')}</button><button type="button" disabled={!importTarget} onClick={() => void importFile('backup')}>{label('恢复完整备份', 'Restore complete backup')}</button><button type="button" onClick={() => void run(async () => { const path = await bridge!.exportSessionsBackup(); if (path) return `${label('完整备份已保存：', 'Complete backup saved: ')}${path}`; })}>{label('导出全部会话完整备份', 'Back up all conversations')}</button></div><p>{label('导入会创建新的会话身份，不覆盖已有会话，也不会执行历史工具。重复导入相同文件会返回原导入结果。', 'Imports create new conversation identities without overwriting existing sessions or executing historical tools. Retrying the same import returns its existing result.')}</p></fieldset>
		<fieldset disabled={busy || !ready || loading}><legend>{label('搜索索引', 'Search index')}</legend><p>{label('索引可以从原始会话重建。搜索结果优先展示当前分支；选择“包括其他分支”可查看其他历史分支。', 'The search index can be rebuilt from original conversations. Current branches appear first; enable other branches in search to include them.')}</p><button type="button" onClick={() => void run(async () => { const result = await bridge!.rebuildSearchIndex(); return label(`索引重建完成，包含 ${result.indexed} 个会话。`, `Index rebuilt for ${result.indexed} conversations.`); })}>{label('重建会话搜索索引', 'Rebuild conversation index')}</button></fieldset>
		{cwd && rules && <fieldset disabled={busy || !ready || loading}><legend>{label('当前项目搜索规则', 'Current project search rules')}</legend><p>{cwd}</p><p>{label('每行一条。包含/排除使用相对路径通配符：* 匹配文件名，** 匹配多级目录。空的包含列表表示全部；符号链接不会被遍历。', 'One rule per line. Include/exclude use relative path globs: * matches within a directory, ** spans directories. Empty includes mean all files. Symbolic links are not traversed.')}</p><div className="pd-data-rules"><label>{label('忽略的目录名', 'Ignored directory names')}<textarea rows={5} value={ignored} onChange={(event) => setIgnored(event.target.value)} /></label><label>{label('包含路径', 'Include paths')}<textarea rows={5} value={include} onChange={(event) => setInclude(event.target.value)} placeholder="src/**" /></label><label>{label('排除路径', 'Exclude paths')}<textarea rows={5} value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="**/*.generated.ts" /></label></div><label>{label('正文搜索单文件上限 (KiB)', 'Content search file limit (KiB)')}<input type="number" min="1" max="16384" value={rules.maxFileBytes / 1024} onChange={(event) => setRules({ ...rules, maxFileBytes: Number(event.target.value) * 1024 })} /></label><button type="button" onClick={() => void run(async () => { await bridge!.setProjectSearchRules({ ...rules, ignoredDirectories: splitRules(ignored), include: splitRules(include), exclude: splitRules(exclude) }); return label('项目搜索规则已保存，路径索引将在下次搜索时更新。', 'Project search rules saved. The path index refreshes on the next search.'); })}>{label('保存搜索规则', 'Save search rules')}</button></fieldset>}
		<dialog ref={dialog} className="pd-data-confirm" aria-labelledby="pd-data-cleanup-title" onCancel={(event) => { event.preventDefault(); if (!busy) setConfirmCleanup(false); }}><h3 id="pd-data-cleanup-title">{label(`永久删除 ${selectedEntries.length} 个回收项目？`, `Permanently delete ${selectedEntries.length} recycled conversations?`)}</h3><p>{label('此操作无法撤销，只会处理下面明确选中的项目。运行中的会话会跳过。', 'This cannot be undone. Only the explicitly selected items below will be removed. Running sessions are skipped.')}</p><ul>{selectedEntries.map((entry) => <li key={entry.id}>{entry.name || leaf(entry.originalPath || entry.id)}</li>)}</ul><div className="pd-data-toolbar"><button type="button" disabled={busy} onClick={() => setConfirmCleanup(false)}>{label('取消', 'Cancel')}</button><button type="button" disabled={busy} onClick={() => void run(async () => { const result = await bridge!.cleanupSessionTrash({ entries: selectedEntries.map(({ id, deletedAt }) => ({ id, deletedAt })) }); setConfirmCleanup(false); return label(`已永久清理 ${result.removed.length} 项，跳过 ${result.skipped.length} 项。`, `Removed ${result.removed.length} items; skipped ${result.skipped.length}.`); })}>{label('确认永久删除', 'Confirm permanent deletion')}</button></div></dialog>
	</div>;
}
