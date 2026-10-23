import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { DataFeaturesBridge, UiMachineSessionSummary } from '../../../shared/src/dataFeatures';
import { useT, type Translate } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon, type IconName } from './Icons';
import { SessionBulkDeleteDialog, type SessionDeleteTarget } from './SessionBulkDeleteDialog';
import { SessionDeleteDialog } from './SessionDeleteDialog';
import './sessionManagement.css';
import { formatDate } from '../dateFormat';

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

function formatWhen(modified: string, locale: string, t: Translate): string {
  const date = new Date(modified);
  if (Number.isNaN(date.getTime())) return modified;
  const days = Math.floor((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (days <= 0) return t('sessions.today', { clock });
  if (days === 1) return t('sessions.yesterday', { clock });
  if (days < 7) return t('sessions.daysAgo', { days });
  return formatDate(date, locale);
}

/** Group “select all” checkbox that renders the partial state natively. */
function GroupCheckbox({ checked, indeterminate, disabled, label, onChange }: { checked: boolean; indeterminate: boolean; disabled: boolean; label: string; onChange(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />;
}

/** Compact icon action whose label stays in the accessible name and text content. */
function RowAction({ icon, label, danger, disabled, hint, onClick }: { icon: IconName; label: string; danger?: boolean; disabled?: boolean; hint?: string; onClick(): void }): ReactElement {
  return <HoverTooltip title={label} description={hint} align="end">
    <button type="button" className={danger ? 'is-danger' : undefined} disabled={disabled} onClick={onClick}>
      <Icon name={icon} width="15" height="15" />
      <span className="pd-session-management-sr-only">{label}</span>
    </button>
  </HoverTooltip>;
}

function RenameDialog({ initial, onSave, onClose }: { initial: string; onSave(name: string): void; onClose(): void }) {
  const { t } = useT();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  const submit = () => { if (draft.trim()) onSave(draft.trim()); };
  return createPortal(<dialog ref={dialog} className="pd-session-management-rename" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h3 id={id}>{t('sessions.renameTitle')}</h3>
    <input autoFocus value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') submit(); }} placeholder={t('sessions.namePlaceholder')} aria-label={t('sessions.nameLabel')} />
    <footer>
      <button type="button" onClick={onClose}>{t('sessions.cancel')}</button>
      <button type="button" className="is-primary" disabled={!draft.trim()} onClick={submit}>{t('sessions.save')}</button>
    </footer>
  </dialog>, document.body);
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
  const { t, locale } = useT();
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
  const [deleteTarget, setDeleteTarget] = useState<UiMachineSessionSummary | null>(null);
  const [bulkTarget, setBulkTarget] = useState<SessionDeleteTarget[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (typeof dataBridge?.listMachineSessions !== 'function') { setError(t('sessions.unsupported')); return; }
    setLoading(true); setError(null);
    try { const next = await dataBridge.listMachineSessions(); if (alive.current) setRows(next); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setLoading(false); }
  }, [dataBridge, locale]);

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

  async function applyRename(target: UiMachineSessionSummary, name: string) {
    setRenameTarget(null);
    await run(() => useChatStore.getState().updateSessionMeta(target.path, { name }), t('sessions.renamed'));
    await reload();
  }

  async function applyArchive(row: UiMachineSessionSummary) {
    await run(() => useChatStore.getState().updateSessionMeta(row.path, { archived: !row.archived }),
      row.archived ? (t('sessions.unarchived')) : (t('sessions.archived')));
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
    { key: 'all', text: t('sessions.filterAll') },
    { key: 'active', text: t('sessions.filterActive') },
    { key: 'archived', text: t('sessions.filterArchived') },
  ];

  const totalBytes = (rows ?? []).reduce((total, row) => total + row.bytes, 0);
  const workspaceCount = new Set((rows ?? []).map(row => row.cwd)).size;
  const narrowed = searching || filter !== 'all';

  return <section className="pd-session-management" data-setting="sessions">
    <header className="pd-session-management-head">
      <div>
        <h2>{t('sessions.title')}</h2>
        <p>{t('sessions.description')}</p>
      </div>
      <HoverTooltip title={t('sessions.refreshTitle')} align="end">
        <button type="button" className="pd-session-management-refresh" disabled={loading} aria-label={t('sessions.refresh')} onClick={() => void reload()}>
          <Icon name="refresh" width="15" height="15" className={loading ? 'is-spinning' : undefined} />
        </button>
      </HoverTooltip>
    </header>

    <p className="pd-session-management-warning">
      <Icon name="trash" width="14" height="14" />
      <span>{t('sessions.deleteNotice')}</span>
    </p>

    <div className="pd-session-management-toolbar">
      <label className="pd-session-management-search">
        <Icon name="search" width="15" height="15" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchLabel')} />
      </label>
      <div className="pd-session-management-segmented" role="group" aria-label={t('sessions.filter')}>
        {filters.map(item => <button key={item.key} type="button" className={filter === item.key ? 'is-active' : ''} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.text}</button>)}
      </div>
    </div>

    {selectedRows.length > 0
      ? <div className="pd-session-management-selection" role="region" aria-label={t('sessions.bulkActions')}>
        <span>{t('sessions.selectedCount', { count: selectedRows.length })}</span>
        <button type="button" onClick={() => setSelection(new Set())}>{t('sessions.clearSelection')}</button>
        <button type="button" className="is-danger" onClick={() => setBulkTarget(selectedRows.map(row => ({ path: row.path, title: label(row) })))}>
          <Icon name="trash" width="14" height="14" />{t('sessions.deleteSelected', { count: selectedRows.length })}
        </button>
      </div>
      : rows !== null && <div className="pd-session-management-summary">
        <p className="pd-session-management-count">{t(narrowed ? 'sessions.summaryNarrowed' : 'sessions.summary', { count: rows.length, workspaces: workspaceCount, size: formatBytes(totalBytes), visible: visible.length })}</p>
        {notice && <span role="status">{notice}</span>}
      </div>}

    {error && <p role="alert" className="pd-session-management-error">{error}</p>}
    {rows === null && !error && <p className="pd-session-management-loading">{t('sessions.loading')}</p>}
    {visible.length === 0 && rows !== null && <div className="pd-session-management-empty">
      <Icon name="message" width="22" height="22" />
      <p>{narrowed ? (t('sessions.noMatches')) : (t('sessions.empty'))}</p>
    </div>}

    <div className="pd-session-management-groups">
      {groups.map((group) => {
        const expanded = searching || !collapsed.has(group.cwd);
        const page = groupPages[group.cwd] ?? 1;
        const shown = group.sessions.slice(0, page * GROUP_PAGE_SIZE);
        const eligible = group.sessions.filter(row => row.path !== currentSessionPath && !row.running);
        const selectedCount = eligible.filter(row => selection.has(row.path)).length;
        const name = workspaceName(group.cwd);
        return <div className="pd-session-management-group" key={group.cwd} data-cwd={group.cwd}>
          <div className="pd-session-management-group-head">
            <GroupCheckbox checked={eligible.length > 0 && selectedCount === eligible.length} indeterminate={selectedCount > 0 && selectedCount < eligible.length} disabled={eligible.length === 0}
              label={t('sessions.selectWorkspace', { name })} onChange={() => toggleGroupSelection(group)} />
            <button type="button" className="pd-session-management-group-toggle" aria-expanded={expanded} onClick={() => toggleGroup(group.cwd)}>
              <Icon name="chevronRight" width="14" height="14" className="pd-session-management-chevron" />
              <Icon name="folder" width="16" height="16" className="pd-session-management-folder" />
              <span className="pd-session-management-group-title">
                <span className="pd-session-management-group-name">
                  <span>{name}</span>
                  {group.cwd === currentWorkspace && <span className="pd-session-management-flag is-current">{t('sessions.currentWorkspace')}</span>}
                  {group.running && <span className="pd-session-management-flag is-running">{t('sessions.running')}</span>}
                  {!group.registered && <span className="pd-session-management-flag">{t('sessions.unopenedWorkspace')}</span>}
                </span>
                <span className="pd-session-management-cwd" title={group.cwd}>{group.cwd}</span>
              </span>
              <span className="pd-session-management-group-stats">
                <span>{t('sessions.workspaceCount', { count: group.sessions.length })}</span>
                <span>{formatBytes(group.bytes)}</span>
              </span>
            </button>
          </div>
          {expanded && <div className="pd-session-management-group-rows">
            {shown.map((row) => {
              const current = row.path === currentSessionPath;
              const locked = current || row.running;
              return <div className={`pd-session-management-row${current ? ' is-current' : ''}${selection.has(row.path) ? ' is-selected' : ''}`} key={row.path} data-session-path={row.path}>
                <input type="checkbox" disabled={locked} checked={selection.has(row.path)} onChange={() => toggleRow(row.path)} aria-label={t('sessions.selectRow', { name: label(row) })} />
                <div className="pd-session-management-main">
                  <div className="pd-session-management-title">
                    <span className={`pd-session-management-name${row.archived ? ' is-archived' : ''}`} title={label(row)}>{label(row)}</span>
                    {current && <span className="pd-session-management-flag is-current">{t('sessions.currentSession')}</span>}
                    {row.running && <span className="pd-session-management-flag is-running">{t('sessions.running')}</span>}
                    {row.pinned && <span className="pd-session-management-flag">{t('sessions.pinned')}</span>}
                    {row.archived && <span className="pd-session-management-flag">{t('sessions.filterArchived')}</span>}
                  </div>
                  <span className="pd-session-management-meta">
                    <span title={formatDate(row.modified, locale, { time: true, year: 'always' })}>{formatWhen(row.modified, locale, t)}</span>
                    <span>{t('sessions.messageCount', { count: row.messageCount })}</span>
                    <span>{formatBytes(row.bytes)}</span>
                  </span>
                </div>
                <span className="pd-session-management-actions">
                  <RowAction icon="pencil" label={t('sessions.rename')} onClick={() => setRenameTarget(row)} />
                  <RowAction icon="archive" label={row.archived ? (t('sessions.unarchive')) : (t('sessions.archive'))} onClick={() => void applyArchive(row)} />
                  <RowAction icon="trash" danger label={t('sessions.delete')} disabled={locked}
                    hint={current ? (t('sessions.cannotDeleteCurrent')) : row.running ? (t('sessions.cannotDeleteRunning')) : undefined}
                    onClick={() => setDeleteTarget(row)} />
                </span>
              </div>;
            })}
            {group.sessions.length > shown.length && <button type="button" className="pd-session-management-more" onClick={() => setGroupPages(current => ({ ...current, [group.cwd]: page + 1 }))}>
              {t('sessions.showMore', { count: group.sessions.length - shown.length })}
            </button>}
          </div>}
        </div>;
      })}
    </div>

    {renameTarget && <RenameDialog initial={renameTarget.name ?? ''} onClose={() => setRenameTarget(null)} onSave={name => void applyRename(renameTarget, name)} />}
    {deleteTarget && <SessionDeleteDialog title={label(deleteTarget)} workspace={deleteTarget.cwd}
      onDelete={() => applyDelete([deleteTarget.path])}
      onClose={deleted => { const row = deleteTarget; setDeleteTarget(null); if (deleted) setNotice(t('sessions.deleted', { name: label(row) })); }} />}
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
      onClose={() => { setBulkTarget(null); setNotice(t('sessions.bulkDeleted')); }} />}
  </section>;
}

