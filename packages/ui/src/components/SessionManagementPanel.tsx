import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataFeaturesBridge, UiMachineSessionSummary } from '../../../shared/src/dataFeatures';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { SessionBulkDeleteDialog, type SessionDeleteTarget } from './SessionBulkDeleteDialog';
import { SessionDeleteDialog } from './SessionDeleteDialog';

type Filter = 'all' | 'active' | 'archived';

/** Sessions revealed per workspace group before the “show more” affordance. */
const GROUP_PAGE_SIZE = 20;
/** Workspace groups expanded by default (most recently used first). */
const EXPANDED_GROUPS = 3;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const segment = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return segment || cwd;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatWhen(modified: string, locale: string, zh: boolean): string {
  const date = new Date(modified);
  if (Number.isNaN(date.getTime())) return modified;
  const days = Math.floor((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (days <= 0) return zh ? `今天 ${clock}` : `Today ${clock}`;
  if (days === 1) return zh ? `昨天 ${clock}` : `Yesterday ${clock}`;
  if (days < 7) return zh ? `${days} 天前` : `${days} days ago`;
  return date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

type WorkspaceGroup = {
  cwd: string;
  sessions: UiMachineSessionSummary[];
  latest: number;
  bytes: number;
  registered: boolean;
  running: boolean;
};

/**
 * Session management: every pi conversation stored on this machine, including
 * workspaces the app has never opened, grouped by workspace. Deletion matches
 * the native pi CLI — the transcript file is unlinked directly with no trash.
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupPages, setGroupPages] = useState<Record<string, number>>({});
  const collapseInitialized = useRef(false);
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

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const byCwd = new Map<string, UiMachineSessionSummary[]>();
    for (const row of visible) {
      const bucket = byCwd.get(row.cwd);
      if (bucket) bucket.push(row); else byCwd.set(row.cwd, [row]);
    }
    const list = [...byCwd.entries()].map(([cwd, sessions]) => ({
      cwd,
      sessions,
      latest: Math.max(...sessions.map(session => new Date(session.modified).getTime() || 0)),
      bytes: sessions.reduce((total, session) => total + session.bytes, 0),
      registered: sessions.some(session => session.registered),
      running: sessions.some(session => session.running),
    }));
    list.sort((a, b) => b.latest - a.latest);
    return list;
  }, [visible]);

  const currentWorkspace = useMemo(() => rows?.find(row => row.path === currentSessionPath)?.cwd ?? null, [rows, currentSessionPath]);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (collapseInitialized.current || groups.length === 0) return;
    collapseInitialized.current = true;
    setCollapsed(new Set(groups.slice(EXPANDED_GROUPS).map(group => group.cwd)));
  }, [groups]);

  useEffect(() => { setGroupPages({}); }, [query, filter]);

  const selectedRows = useMemo(() => visible.filter(row => selection.has(row.path) && row.path !== currentSessionPath && !row.running), [visible, selection, currentSessionPath]);

  async function run(action: () => Promise<void>, done: string) {
    setNotice(null);
    try { await action(); if (alive.current) setNotice(done); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function toggleRow(path: string) {
    setSelection(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }

  function toggleGroup(cwd: string) {
    setCollapsed(current => { const next = new Set(current); if (next.has(cwd)) next.delete(cwd); else next.add(cwd); return next; });
  }

  function toggleGroupSelection(group: WorkspaceGroup) {
    const eligible = group.sessions.filter(row => row.path !== currentSessionPath && !row.running).map(row => row.path);
    const allSelected = eligible.every(path => selection.has(path));
    setSelection(current => {
      const next = new Set(current);
      for (const path of eligible) { if (allSelected) next.delete(path); else next.add(path); }
      return next;
    });
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

  const filters: Array<{ key: Filter; text: string }> = [
    { key: 'all', text: zh ? '全部' : 'All' },
    { key: 'active', text: zh ? '未归档' : 'Unarchived' },
    { key: 'archived', text: zh ? '已归档' : 'Archived' },
  ];

  return <section className="pd-session-management" data-setting="sessions">
    <header>
      <h2>{zh ? '会话管理' : 'Conversations'}</h2>
      <p>{zh
        ? '按工作区查看本机 pi 的全部会话（包括未在应用中打开的工作区）。删除与原生 pi CLI 一致：直接删除会话文件，无法撤销，也没有应用回收站。'
        : 'Every pi conversation on this machine grouped by workspace, including workspaces the app has not opened. Deleting matches the native pi CLI: the transcript file is removed directly and cannot be undone.'}</p>
    </header>
    <div className="pd-session-management-toolbar">
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索会话、标题或工作区…' : 'Search conversations or workspaces…'} aria-label={zh ? '搜索会话' : 'Search conversations'} />
      <div className="pd-session-management-segmented" role="group" aria-label={zh ? '筛选' : 'Filter'}>
        {filters.map(item => <button key={item.key} type="button" className={filter === item.key ? 'is-active' : ''} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.text}</button>)}
      </div>
      <button type="button" className="pd-session-management-refresh" disabled={loading} onClick={() => void reload()}>{loading ? (zh ? '加载中…' : 'Loading…') : (zh ? '刷新' : 'Refresh')}</button>
      {selectedRows.length > 0 && <button type="button" className="is-danger" onClick={() => setBulkTarget(selectedRows.map(row => ({ path: row.path, title: label(row) })))}>{zh ? `永久删除所选 (${selectedRows.length})` : `Delete selected (${selectedRows.length})`}</button>}
      {notice && <span role="status">{notice}</span>}
    </div>
    {error && <p role="alert" className="pd-session-management-error">{error}</p>}
    {rows !== null && <p className="pd-session-management-count">{zh
      ? `共 ${groups.length} 个工作区 · ${rows.length} 个会话${searching || filter !== 'all' ? `，显示 ${visible.length} 个` : ''}`
      : `${groups.length} workspaces · ${visible.length} of ${rows.length} conversations`}</p>}
    {rows === null && !error && <p className="pd-session-management-empty">{zh ? '正在读取本机会话…' : 'Reading conversations…'}</p>}
    {visible.length === 0 && rows !== null && <p className="pd-session-management-empty">{zh ? '没有符合条件的会话。' : 'No conversations match.'}</p>}
    {groups.map((group) => {
      const expanded = searching || !collapsed.has(group.cwd);
      const page = groupPages[group.cwd] ?? 1;
      const shown = group.sessions.slice(0, page * GROUP_PAGE_SIZE);
      const eligible = group.sessions.filter(row => row.path !== currentSessionPath && !row.running);
      const allSelected = eligible.length > 0 && eligible.every(row => selection.has(row.path));
      return <div className="pd-session-management-group" key={group.cwd} data-cwd={group.cwd}>
        <div className="pd-session-management-group-head">
          <label className="pd-session-management-group-check">
            <input type="checkbox" checked={allSelected} onChange={() => toggleGroupSelection(group)} aria-label={zh ? `选择 ${workspaceName(group.cwd)} 的全部会话` : `Select all in ${workspaceName(group.cwd)}`} />
          </label>
          <button type="button" className="pd-session-management-group-toggle" aria-expanded={expanded} onClick={() => toggleGroup(group.cwd)}>
            <span className="pd-session-management-chevron" aria-hidden />
            <span className="pd-session-management-group-title">
              <span className="pd-session-management-group-name">{workspaceName(group.cwd)}</span>
              <span className="pd-session-management-cwd" title={group.cwd}>{group.cwd}</span>
            </span>
            <span className="pd-session-management-group-flags">
              {group.cwd === currentWorkspace && <span className="pd-session-management-flag is-current">{zh ? '当前工作区' : 'Current'}</span>}
              {group.running && <span className="pd-session-management-flag is-running">{zh ? '运行中' : 'Running'}</span>}
              {!group.registered && <span className="pd-session-management-flag">{zh ? '未打开的工作区' : 'Unopened workspace'}</span>}
            </span>
            <span className="pd-session-management-group-stats">{zh ? `${group.sessions.length} 个会话 · ${formatBytes(group.bytes)}` : `${group.sessions.length} · ${formatBytes(group.bytes)}`}</span>
          </button>
        </div>
        {expanded && <div className="pd-session-management-group-rows">
          {shown.map((row) => {
            const current = row.path === currentSessionPath;
            return <div className="pd-session-management-row" key={row.path} data-session-path={row.path}>
              <label><input type="checkbox" disabled={current || row.running} checked={selection.has(row.path)} onChange={() => toggleRow(row.path)} aria-label={zh ? `选择 ${label(row)}` : `Select ${label(row)}`} /></label>
              <div className="pd-session-management-main">
                <div className="pd-session-management-title">
                  <span className="pd-session-management-name">{label(row)}</span>
                  {current && <span className="pd-session-management-flag is-current">{zh ? '当前会话' : 'Current'}</span>}
                  {row.running && <span className="pd-session-management-flag is-running">{zh ? '运行中' : 'Running'}</span>}
                  {row.archived && <span className="pd-session-management-flag">{zh ? '已归档' : 'Archived'}</span>}
                  {row.pinned && <span className="pd-session-management-flag">{zh ? '已置顶' : 'Pinned'}</span>}
                </div>
                <span className="pd-session-management-meta">
                  <span title={new Date(row.modified).toLocaleString(locale)}>{formatWhen(row.modified, locale, zh)}</span>
                  <span aria-hidden>·</span>
                  <span>{zh ? `${row.messageCount} 条消息` : `${row.messageCount} messages`}</span>
                  <span aria-hidden>·</span>
                  <span>{formatBytes(row.bytes)}</span>
                </span>
              </div>
              <span className="pd-session-management-actions">
                <button type="button" onClick={() => { setRenameTarget(row); setRenameDraft(row.name ?? ''); }}>{zh ? '重命名' : 'Rename'}</button>
                <button type="button" onClick={() => void applyArchive(row)}>{row.archived ? (zh ? '取消归档' : 'Unarchive') : (zh ? '归档' : 'Archive')}</button>
                <button type="button" className="is-danger" disabled={current || row.running} title={current ? (zh ? '不能删除当前打开的会话' : 'The open conversation cannot be deleted') : row.running ? (zh ? '会话运行中' : 'Conversation is running') : undefined} onClick={() => setDeleteTarget(row)}>{zh ? '删除' : 'Delete'}</button>
              </span>
            </div>;
          })}
          {group.sessions.length > shown.length && <button type="button" className="pd-session-management-more" onClick={() => setGroupPages(current => ({ ...current, [group.cwd]: page + 1 }))}>
            {zh ? `显示更多（还有 ${group.sessions.length - shown.length} 个）` : `Show more (${group.sessions.length - shown.length} remaining)`}
          </button>}
        </div>}
      </div>;
    })}
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
