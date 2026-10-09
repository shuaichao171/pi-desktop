import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataFeaturesBridge, UiMachineSessionSummary } from '../../../shared/src/dataFeatures';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { SessionBulkDeleteDialog, type SessionDeleteTarget } from './SessionBulkDeleteDialog';
import { SessionDeleteDialog } from './SessionDeleteDialog';

type Filter = 'all' | 'active' | 'archived';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Session management: every pi conversation stored on this machine, including
 * workspaces the app has never opened. Deletion matches the native pi CLI —
 * the transcript file is unlinked directly with no app trash.
 */
export function SessionManagementPanel() {
  const { locale } = useT();
  const zh = locale === 'zh-CN';
  const bridge = useChatStore(state => state.bridge);
  const currentSessionPath = useChatStore(state => state.sessionPath);
  const dataBridge = bridge as (typeof bridge & Partial<DataFeaturesBridge>);
  const alive = useRef(true);
  const [rows, setRows] = useState<UiMachineSessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<UiMachineSessionSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<UiMachineSessionSummary | null>(null);
  const [bulkTarget, setBulkTarget] = useState<SessionDeleteTarget[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (typeof dataBridge?.listMachineSessions !== 'function') { setError(zh ? '当前环境不支持会话管理。' : 'Session management is unavailable here.'); return; }
    setLoading(true); setError(null);
    try { const next = await dataBridge.listMachineSessions(); if (alive.current) setRows(next); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setLoading(false); }
  }, [dataBridge, zh]);

  useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, [reload]);

  const visible = useMemo(() => {
    const list = rows ?? [];
    const needle = query.trim().toLowerCase();
    return list.filter((row) => {
      if (filter === 'active' && row.archived) return false;
      if (filter === 'archived' && !row.archived) return false;
      if (!needle) return true;
      return `${row.name ?? ''} ${row.firstMessage} ${row.cwd}`.toLowerCase().includes(needle);
    });
  }, [rows, query, filter]);

  const selectedRows = useMemo(() => visible.filter(row => selection.has(row.path) && row.path !== currentSessionPath && !row.running), [visible, selection, currentSessionPath]);
  const allVisibleSelected = visible.length > 0 && visible.every(row => selection.has(row.path) || row.path === currentSessionPath || row.running);

  async function run(action: () => Promise<void>, done: string) {
    setNotice(null);
    try { await action(); if (alive.current) setNotice(done); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function toggleRow(path: string) {
    setSelection(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }

  async function applyRename() {
    const target = renameTarget;
    const draft = renameDraft.trim();
    if (!target || !draft) return;
    setRenameTarget(null);
    await run(() => useChatStore.getState().updateSessionMeta(target.path, { name: draft }), zh ? '会话已重命名。' : 'Conversation renamed.');
    await reload();
  }

  async function applyArchive(row: UiMachineSessionSummary) {
    await run(() => useChatStore.getState().updateSessionMeta(row.path, { archived: !row.archived }),
      row.archived ? (zh ? '已取消归档。' : 'Unarchived.') : (zh ? '已归档。' : 'Archived.'));
    await reload();
  }

  async function applyDelete(paths: string[]) {
    if (paths.length === 1) await useChatStore.getState().deleteSession(paths[0]);
    else await useChatStore.getState().deleteSessions(paths);
    setSelection(current => { const next = new Set(current); for (const path of paths) next.delete(path); return next; });
    await reload();
  }

  const label = (row: UiMachineSessionSummary) => row.name?.trim() || row.firstMessage || row.id;

  return <section className="pd-session-management" data-setting="sessions">
    <header>
      <h2>{zh ? '会话管理' : 'Conversations'}</h2>
      <p>{zh
        ? '显示本机 pi 的全部会话（包括未在应用中打开的工作区）。删除与原生 pi CLI 一致：直接删除会话文件，无法撤销，也没有应用回收站。'
        : 'Every pi conversation stored on this machine, including workspaces the app has not opened. Deleting matches the native pi CLI: the transcript file is removed directly and cannot be undone.'}</p>
    </header>
    <div className="pd-session-management-toolbar">
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索会话、标题或工作区…' : 'Search conversations or workspaces…'} aria-label={zh ? '搜索会话' : 'Search conversations'} />
      <select value={filter} onChange={event => setFilter(event.target.value as Filter)} aria-label={zh ? '筛选' : 'Filter'}>
        <option value="all">{zh ? '全部' : 'All'}</option>
        <option value="active">{zh ? '未归档' : 'Unarchived'}</option>
        <option value="archived">{zh ? '已归档' : 'Archived'}</option>
      </select>
      <button type="button" disabled={loading} onClick={() => void reload()}>{loading ? (zh ? '加载中…' : 'Loading…') : (zh ? '刷新' : 'Refresh')}</button>
      {selectedRows.length > 0 && <button type="button" className="is-danger" onClick={() => setBulkTarget(selectedRows.map(row => ({ path: row.path, title: label(row) })))}>{zh ? `永久删除所选 (${selectedRows.length})` : `Delete selected (${selectedRows.length})`}</button>}
      {notice && <span role="status">{notice}</span>}
    </div>
    {error && <p role="alert" className="pd-session-management-error">{error}</p>}
    {rows !== null && <p className="pd-session-management-count">{zh ? `共 ${rows.length} 个会话，显示 ${visible.length} 个` : `${visible.length} of ${rows.length} conversations`}</p>}
    {rows === null && !error && <p>{zh ? '正在读取本机会话…' : 'Reading conversations…'}</p>}
    {visible.length === 0 && rows !== null && <p>{zh ? '没有符合条件的会话。' : 'No conversations match.'}</p>}
    {visible.length > 0 && <div className="pd-session-management-table" role="grid">
      <div className="pd-session-management-row pd-session-management-head" role="row">
        <label><input type="checkbox" checked={allVisibleSelected} onChange={event => setSelection(event.target.checked ? new Set(visible.filter(row => row.path !== currentSessionPath && !row.running).map(row => row.path)) : new Set())} aria-label={zh ? '全选' : 'Select all'} /></label>
        <span>{zh ? '会话' : 'Conversation'}</span>
        <span>{zh ? '最近修改' : 'Modified'}</span>
        <span>{zh ? '消息' : 'Messages'}</span>
        <span>{zh ? '大小' : 'Size'}</span>
        <span>{zh ? '操作' : 'Actions'}</span>
      </div>
      {visible.map((row) => {
        const current = row.path === currentSessionPath;
        return <div className="pd-session-management-row" role="row" key={row.path} data-session-path={row.path}>
          <label><input type="checkbox" disabled={current || row.running} checked={selection.has(row.path)} onChange={() => toggleRow(row.path)} aria-label={zh ? `选择 ${label(row)}` : `Select ${label(row)}`} /></label>
          <div className="pd-session-management-title">
            <span className="pd-session-management-name">{label(row)}</span>
            <span className="pd-session-management-meta">
              <span className="pd-session-management-cwd" title={row.cwd}>{row.cwd}</span>
              {!row.registered && <span className="pd-session-management-flag">{zh ? '未打开的工作区' : 'Unopened workspace'}</span>}
              {current && <span className="pd-session-management-flag">{zh ? '当前会话' : 'Current'}</span>}
              {row.running && <span className="pd-session-management-flag">{zh ? '运行中' : 'Running'}</span>}
              {row.archived && <span className="pd-session-management-flag">{zh ? '已归档' : 'Archived'}</span>}
              {row.pinned && <span className="pd-session-management-flag">{zh ? '已置顶' : 'Pinned'}</span>}
            </span>
          </div>
          <span>{new Date(row.modified).toLocaleString(locale)}</span>
          <span>{row.messageCount}</span>
          <span>{formatBytes(row.bytes)}</span>
          <span className="pd-session-management-actions">
            <button type="button" onClick={() => { setRenameTarget(row); setRenameDraft(row.name ?? ''); }}>{zh ? '重命名' : 'Rename'}</button>
            <button type="button" onClick={() => void applyArchive(row)}>{row.archived ? (zh ? '取消归档' : 'Unarchive') : (zh ? '归档' : 'Archive')}</button>
            <button type="button" className="is-danger" disabled={current || row.running} title={current ? (zh ? '不能删除当前打开的会话' : 'The open conversation cannot be deleted') : row.running ? (zh ? '会话运行中' : 'Conversation is running') : undefined} onClick={() => setDeleteTarget(row)}>{zh ? '删除' : 'Delete'}</button>
          </span>
        </div>;
      })}
    </div>}
    {renameTarget && <dialog open className="pd-session-management-rename" aria-labelledby="pd-session-rename-title" onCancel={() => setRenameTarget(null)}>
      <h3 id="pd-session-rename-title">{zh ? '重命名会话' : 'Rename conversation'}</h3>
      <input autoFocus value={renameDraft} maxLength={200} onChange={event => setRenameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void applyRename(); if (event.key === 'Escape') setRenameTarget(null); }} aria-label={zh ? '会话名称' : 'Conversation name'} />
      <footer>
        <button type="button" onClick={() => setRenameTarget(null)}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" disabled={!renameDraft.trim()} onClick={() => void applyRename()}>{zh ? '保存' : 'Save'}</button>
      </footer>
    </dialog>}
    {deleteTarget && <SessionDeleteDialog title={label(deleteTarget)} workspace={deleteTarget.cwd}
      onDelete={() => applyDelete([deleteTarget.path])}
      onClose={deleted => { const row = deleteTarget; setDeleteTarget(null); if (deleted) setNotice(zh ? `已删除 ${label(row)}` : `Deleted ${label(row)}`); }} />}
    {bulkTarget && <SessionBulkDeleteDialog sessions={bulkTarget}
      onDelete={async paths => {
        const result = paths.length === 1
          ? await useChatStore.getState().deleteSession(paths[0]).then(
            () => ({ deleted: [paths[0]], failed: {} as Record<string, string>, skipped: {} as Record<string, string> }),
            (cause: unknown) => ({ deleted: [] as string[], failed: { [paths[0]]: cause instanceof Error ? cause.message : String(cause) }, skipped: {} as Record<string, string> }))
          : await useChatStore.getState().deleteSessions(paths);
        setSelection(current => { const next = new Set(current); for (const path of result.deleted) next.delete(path); return next; });
        await reload();
        return result;
      }}
      onClose={() => { setBulkTarget(null); setNotice(zh ? '批量删除完成。' : 'Batch deletion finished.'); }} />}
  </section>;
}
