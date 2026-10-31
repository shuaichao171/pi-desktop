import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiMemoryAvailability, UiMemoryStats, UiMemoryPage, UiProjectMemory, UiProjectMemoryUpdate, UiUserMemory, UiUserMemoryPage } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import './memoryPanel.css';

const PAGE_SIZE = 50;

/** 插件 v2 五分类 + 晋升分类的白名单；未知分类原样显示。 */
const CATEGORY_OPTIONS = ['PROJECT_RULES', 'ARCHITECTURE', 'CONSTRAINTS', 'CONFIG_VALUES', 'NAMING'] as const;
const STATUS_OPTIONS = ['active', 'archived'] as const;
const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5] as const;

type Scope = 'project' | 'user';

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function formatDate(epochMs: number, locale: string): string {
	if (!epochMs) return '—';
	try {
		return new Date(epochMs).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
	} catch {
		return '—';
	}
}

/**
 * 项目 / 用户记忆管理面板（snow-app 项目记忆页同款交互），入口在聊天头部菜单。
 * 数据来自 Magic Context 插件的 SQLite 记忆库；插件未安装或未启用时入口灰色锁定。
 */
export function MemoryPanel({ returnFocus, onClose }: { returnFocus: HTMLElement | null; onClose(): void }) {
	const { t, locale } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const cwd = useChatStore((s) => s.cwd);
	const [scope, setScope] = useState<Scope>('project');
	const [availability, setAvailability] = useState<UiMemoryAvailability | null>(null);
	const [availabilityError, setAvailabilityError] = useState<string | null>(null);
	const [stats, setStats] = useState<UiMemoryStats | null>(null);
	const [project, setProject] = useState<UiProjectMemory[]>([]);
	const [projectTotal, setProjectTotal] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [user, setUser] = useState<UiUserMemory[]>([]);
	const [userTotal, setUserTotal] = useState(0);
	const [userHasMore, setUserHasMore] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [searchInput, setSearchInput] = useState('');
	const [activeQuery, setActiveQuery] = useState('');
	const [category, setCategory] = useState<string>('');
	const [status, setStatus] = useState<string>('');
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const [editing, setEditing] = useState<UiProjectMemory | null>(null);
	const [editContent, setEditContent] = useState('');
	const [editImportance, setEditImportance] = useState<number | null>(null);
	const [editStatus, setEditStatus] = useState('active');
	const [isSaving, setIsSaving] = useState(false);
	const [editError, setEditError] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<UiProjectMemory | null>(null);
	const [clearConfirm, setClearConfirm] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const ref = useRef<HTMLDialogElement>(null);
	// [喵喵喵]: 单调递增请求号 + 最新者胜 — 过期响应（更快的搜索/切页抢占）一律丢弃；
	// more 的 offset 走 ref 快照，避免列表长度进依赖造成 effect 循环
	const latestRequest = useRef(0);
	const offsetRef = useRef(0);
	const titleId = useId();

	const load = useCallback((mode: 'reload' | 'more') => {
		if (!bridge || !cwd) return;
		const requestId = ++latestRequest.current;
		const offset = mode === 'more' ? offsetRef.current : 0;
		(mode === 'more' ? setIsLoadingMore : setIsLoading)(true);
		const query = { query: activeQuery, category: category || null, status: status || null, limit: PAGE_SIZE, offset };
		const call = scope === 'project'
			? bridge.listProjectMemories(cwd, query)
			: bridge.listUserMemories(query);
		void call.then((page) => {
			if (requestId !== latestRequest.current) return;
			if (scope === 'project') {
				const result = page as UiMemoryPage;
				setProject((current) => mode === 'more' ? [...current, ...result.items] : result.items);
				setProjectTotal(result.total);
				setHasMore(result.hasMore);
			} else {
				const result = page as UiUserMemoryPage;
				setUser((current) => mode === 'more' ? [...current, ...result.items] : result.items);
				setUserTotal(result.total);
				setUserHasMore(result.hasMore);
			}
			offsetRef.current = offset + page.items.length;
			setError(null);
		}).catch((cause: unknown) => {
			if (requestId !== latestRequest.current) return;
			if (mode === 'reload') setError(errorText(cause));
		}).finally(() => {
			if (requestId !== latestRequest.current) return;
			(mode === 'more' ? setIsLoadingMore : setIsLoading)(false);
		});
	}, [bridge, cwd, scope, activeQuery, category, status]);

	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
			const anotherDialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((element) => element !== dialog);
			if (!anotherDialog && returnFocus?.isConnected && returnFocus.getClientRects().length > 0 && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
		};
	}, [returnFocus]);

	// 可用性与统计：面板打开 + 插件状态可能变化时重查
	useEffect(() => {
		if (!bridge || !cwd) return;
		let active = true;
		setAvailability(null);
		setAvailabilityError(null);
		void bridge.getMemoryAvailability(cwd)
			.then((value) => { if (active) setAvailability(value); })
			.catch((cause: unknown) => { if (active) setAvailabilityError(errorText(cause)); });
		return () => { active = false; };
	}, [bridge, cwd]);

	const databaseReady = availability?.databaseReady === true;

	useEffect(() => {
		if (!bridge || !cwd || !databaseReady) return;
		let active = true;
		void bridge.getMemoryStats(cwd)
			.then((value) => { if (active) setStats(value); })
			.catch(() => { /* 统计失败不阻塞列表 */ });
		return () => { active = false; };
	}, [bridge, cwd, databaseReady]);

	useEffect(() => {
		if (!bridge || !cwd || !databaseReady) return;
		setIsLoading(true);
		load('reload');
	}, [bridge, cwd, databaseReady, scope, activeQuery, category, status, load]);

	const submitSearch = useCallback(() => {
		setActiveQuery(searchInput.trim());
	}, [searchInput]);

	const beginEdit = useCallback((memory: UiProjectMemory) => {
		setEditing(memory);
		setEditContent(memory.content);
		setEditImportance(memory.importance);
		setEditStatus(memory.status);
		setEditError(null);
	}, []);

	const saveEdit = useCallback(async () => {
		if (!bridge || !cwd || !editing || isSaving) return;
		setIsSaving(true);
		setEditError(null);
		try {
			const update: UiProjectMemoryUpdate = { id: editing.id };
			if (editContent.trim() !== editing.content) update.content = editContent.trim();
			if (editImportance !== editing.importance) update.importance = editImportance;
			if (editStatus !== editing.status) update.status = editStatus;
			await bridge.updateProjectMemory(cwd, update);
			setEditing(null);
			setNotice(t('memory.updated'));
			load('reload');
			void bridge.getMemoryStats(cwd).then(setStats).catch(() => {});
		} catch (cause: unknown) {
			setEditError(errorText(cause));
		} finally {
			setIsSaving(false);
		}
	}, [bridge, cwd, editing, isSaving, editContent, editImportance, editStatus, t, load]);

	const confirmDelete = useCallback(async () => {
		if (!bridge || !cwd || !deleteTarget) return;
		const target = deleteTarget;
		setDeleteTarget(null);
		try {
			await bridge.deleteProjectMemory(cwd, target.id);
			setProject((current) => current.filter((item) => item.id !== target.id));
			setProjectTotal((current) => Math.max(0, current - 1));
			setExpanded((current) => { const next = new Set(current); next.delete(target.id); return next; });
			setNotice(t('memory.deleted'));
			void bridge.getMemoryStats(cwd).then(setStats).catch(() => {});
		} catch (cause: unknown) {
			setError(errorText(cause));
		}
	}, [bridge, cwd, deleteTarget, t]);

	const confirmClear = useCallback(async () => {
		if (!bridge || !cwd) return;
		setClearConfirm(false);
		try {
			const count = await bridge.clearProjectMemories(cwd);
			setProject([]);
			setProjectTotal(0);
			setHasMore(false);
			setNotice(t('memory.cleared', { count }));
			void bridge.getMemoryStats(cwd).then(setStats).catch(() => {});
		} catch (cause: unknown) {
			setError(errorText(cause));
		}
	}, [bridge, cwd, t]);

	const dismissUser = useCallback(async (memory: UiUserMemory) => {
		if (!bridge) return;
		try {
			await bridge.dismissUserMemory(memory.id);
			setUser((current) => current.filter((item) => item.id !== memory.id));
			setUserTotal((current) => Math.max(0, current - 1));
			setNotice(t('memory.dismissed'));
			void bridge.getMemoryStats(cwd).then(setStats).catch(() => {});
		} catch (cause: unknown) {
			setError(errorText(cause));
		}
	}, [bridge, cwd, t]);

	// translate 缺 key 返回键名本身：以键前缀开头即视为未收录，原样显示分类
	const categoryLabel = (value: string): string => {
		const label = t(`memory.category.${value}`);
		return label.startsWith('memory.category.') ? value : label;
	};

	const renderProjectRow = (memory: UiProjectMemory) => {
		const isOpen = expanded.has(memory.id);
		return (
			<li className="pd-memory-row" key={memory.id}>
				<button type="button" className="pd-memory-row-main" aria-expanded={isOpen} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(memory.id)) next.delete(memory.id); else next.add(memory.id); return next; })}>
					<span className="pd-memory-chevron" aria-hidden="true"><Icon name={isOpen ? 'chevronDown' : 'chevronRight'} width="13" height="13" /></span>
					<span className={`pd-memory-badge${CATEGORY_OPTIONS.includes(memory.category as (typeof CATEGORY_OPTIONS)[number]) ? ` is-${memory.category.toLowerCase()}` : ''}`}>{categoryLabel(memory.category)}</span>
					<span className="pd-memory-content-preview" title={memory.content}>{memory.content}</span>
					{memory.importance !== null && <span className="pd-memory-importance" aria-label={t('memory.importanceLabel', { count: memory.importance })}>{'★'.repeat(memory.importance)}</span>}
					{memory.status !== 'active' && <span className="pd-memory-status">{memory.status}</span>}
					<span className="pd-memory-date">{formatDate(memory.updatedAt, locale)}</span>
				</button>
				{isOpen && <div className="pd-memory-row-detail">
					<p className="pd-memory-content">{memory.content}</p>
					<div className="pd-memory-meta">
						{memory.sourceType && <span>{memory.sourceType}</span>}
						{memory.verificationStatus && <span>{memory.verificationStatus}</span>}
						{memory.seenCount !== null && <span>{t('memory.seenCount', { count: memory.seenCount })}</span>}
						{memory.retrievalCount !== null && <span>{t('memory.retrievalCount', { count: memory.retrievalCount })}</span>}
					</div>
					<div className="pd-memory-actions">
						<button type="button" onClick={() => beginEdit(memory)}>{t('memory.edit')}</button>
						<button type="button" className="is-danger" onClick={() => setDeleteTarget(memory)}>{t('memory.delete')}</button>
					</div>
				</div>}
			</li>
		);
	};

	const renderUserRow = (memory: UiUserMemory) => (
		<li className="pd-memory-row" key={memory.id}>
			<div className="pd-memory-row-main">
				<span className="pd-memory-badge is-user">{t('memory.userScope')}</span>
				<span className="pd-memory-content-preview" title={memory.content}>{memory.content}</span>
				{memory.status !== 'active' && <span className="pd-memory-status">{memory.status}</span>}
				<span className="pd-memory-date">{formatDate(memory.promotedAt || memory.updatedAt, locale)}</span>
			</div>
			<div className="pd-memory-row-detail">
				<p className="pd-memory-content">{memory.content}</p>
				<div className="pd-memory-actions">
					<button type="button" className="is-danger" onClick={() => void dismissUser(memory)}>{t('memory.dismiss')}</button>
				</div>
			</div>
		</li>
	);

	const unavailableReason = availabilityError
		? t('memory.unavailable.error', { message: availabilityError })
		: availability?.reason === 'pluginMissing' ? t('memory.unavailable.pluginMissing')
			: availability?.reason === 'pluginDisabled' ? t('memory.unavailable.pluginDisabled')
				: availability?.reason === 'dbMissing' ? t('memory.unavailable.dbMissing')
					: availability?.reason === 'dbSchema' ? t('memory.unavailable.dbSchema')
						: availability?.reason === 'dbUnreadable' ? t('memory.unavailable.dbUnreadable')
							: t('memory.unavailable.unknown');

	return createPortal(
		<dialog ref={ref} className="pd-memory-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
			<header className="pd-memory-header">
				<h2 id={titleId}>{t('memory.title')}</h2>
				<div className="pd-memory-scope-tabs" role="tablist" aria-label={t('memory.title')}>
					<button type="button" role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'is-active' : ''} onClick={() => setScope('project')}>{t('memory.scope.project')}</button>
					<button type="button" role="tab" aria-selected={scope === 'user'} className={scope === 'user' ? 'is-active' : ''} onClick={() => setScope('user')}>{t('memory.scope.user')}</button>
				</div>
				<button type="button" className="pd-icon-button" aria-label={t('settings.close')} onClick={onClose} autoFocus><Icon name="close" width="18" height="18" /></button>
			</header>
			{availability === null && availabilityError === null
				? <div className="pd-memory-state"><p role="status">{t('memory.checking')}</p></div>
				: !databaseReady
					? <div className="pd-memory-state">
						<p className="pd-memory-state-title">{unavailableReason}</p>
						<p className="pd-memory-state-hint">{t('memory.unavailable.hint')}</p>
					</div>
					: <>
						<div className="pd-memory-toolbar">
							<form className="pd-memory-search" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
								<input type="text" placeholder={t('memory.searchPlaceholder')} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} aria-label={t('memory.searchPlaceholder')} />
								<button type="submit">{t('memory.search')}</button>
							</form>
							{scope === 'project' && <>
								<select aria-label={t('memory.filterCategory')} value={category} onChange={(event) => setCategory(event.target.value)}>
									<option value="">{t('memory.filterAllCategories')}</option>
									{CATEGORY_OPTIONS.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}
									{[...new Set(stats?.byCategory.map((item) => item.category) ?? [])]
										.filter((value) => !CATEGORY_OPTIONS.includes(value as (typeof CATEGORY_OPTIONS)[number]))
										.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}
								</select>
								<select aria-label={t('memory.filterStatus')} value={status} onChange={(event) => setStatus(event.target.value)}>
									<option value="">{t('memory.filterAllStatuses')}</option>
									{STATUS_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
								</select>
							</>}
								<button type="button" onClick={() => load('reload')} disabled={isLoading}>{t('memory.refresh')}</button>
							{scope === 'project' && <button type="button" className="is-danger" onClick={() => setClearConfirm(true)} disabled={projectTotal === 0 || isLoading}>{t('memory.clearAll')}</button>}
						</div>
						{stats && <div className="pd-memory-stats">
							<span>{t('memory.statsTotal', { count: stats.total })}</span>
							<span>{t('memory.statsActive', { count: stats.active })}</span>
							<span>{t('memory.statsArchived', { count: stats.archived })}</span>
							{stats.byCategory.slice(0, 5).map((item) => <span key={item.category} className="pd-memory-stats-category">{categoryLabel(item.category)} {item.count}</span>)}
						</div>}
						{notice && <p className="pd-memory-notice" role="status">{notice}</p>}
						{error && <p className="pd-memory-error" role="alert">{error}</p>}
						<div className="pd-memory-list" role="tabpanel">
							{isLoading
								? <p className="pd-memory-state" role="status">{t('memory.loading')}</p>
								: scope === 'project'
									? project.length === 0
										? <div className="pd-memory-state"><p className="pd-memory-state-title">{t('memory.empty.project')}</p><p className="pd-memory-state-hint">{t('memory.empty.hint')}</p></div>
										: <ul className="pd-memory-rows">{project.map(renderProjectRow)}</ul>
									: user.length === 0
										? <div className="pd-memory-state"><p className="pd-memory-state-title">{t('memory.empty.user')}</p><p className="pd-memory-state-hint">{t('memory.empty.userHint')}</p></div>
										: <ul className="pd-memory-rows">{user.map(renderUserRow)}</ul>}
						</div>
						<footer className="pd-memory-footer">
							<span>{scope === 'project' ? t('memory.count', { count: projectTotal }) : t('memory.userCount', { count: userTotal })}</span>
							{(scope === 'project' ? hasMore : userHasMore) && <button type="button" onClick={() => load('more')} disabled={isLoadingMore}>{t(isLoadingMore ? 'memory.loadingMore' : 'memory.loadMore')}</button>}
						</footer>
					</>}
			{editing && <div className="pd-memory-dialog-layer" role="dialog" aria-modal="true" aria-label={t('memory.edit')}>
				<div className="pd-memory-dialog">
					<h3>{t('memory.edit')}</h3>
					<textarea rows={6} value={editContent} onChange={(event) => setEditContent(event.target.value)} aria-label={t('memory.content')} />
					<label className="pd-memory-edit-row">
						<span>{t('memory.importance')}</span>
						<select value={editImportance === null ? '' : String(editImportance)} onChange={(event) => setEditImportance(event.target.value === '' ? null : Number(event.target.value))}>
							<option value="">{t('memory.importanceNone')}</option>
							{IMPORTANCE_LEVELS.map((level) => <option key={level} value={level}>{'★'.repeat(level)}</option>)}
						</select>
					</label>
					<label className="pd-memory-edit-row">
						<span>{t('memory.status')}</span>
						<select value={editStatus} onChange={(event) => setEditStatus(event.target.value)}>
							{['active', 'archived'].map((value) => <option key={value} value={value}>{value}</option>)}
						</select>
					</label>
					{editError && <p className="pd-memory-error" role="alert">{editError}</p>}
					<div className="pd-memory-actions">
						<button type="button" onClick={() => setEditing(null)} disabled={isSaving}>{t('common.close')}</button>
						<button type="button" className="is-primary" onClick={() => void saveEdit()} disabled={isSaving || !editContent.trim()}>{t(isSaving ? 'memory.saving' : 'memory.save')}</button>
					</div>
				</div>
			</div>}
			{deleteTarget && <div className="pd-memory-dialog-layer" role="dialog" aria-modal="true" aria-label={t('memory.delete')}>
				<div className="pd-memory-dialog">
					<h3>{t('memory.delete')}</h3>
					<p>{t('memory.deleteConfirm')}</p>
					<p className="pd-memory-dialog-preview">{deleteTarget.content}</p>
					<div className="pd-memory-actions">
						<button type="button" onClick={() => setDeleteTarget(null)}>{t('common.close')}</button>
						<button type="button" className="is-danger" onClick={() => void confirmDelete()}>{t('memory.delete')}</button>
					</div>
				</div>
			</div>}
			{clearConfirm && <div className="pd-memory-dialog-layer" role="dialog" aria-modal="true" aria-label={t('memory.clearAll')}>
				<div className="pd-memory-dialog">
					<h3>{t('memory.clearAll')}</h3>
					<p>{t('memory.clearConfirm', { count: projectTotal })}</p>
					<div className="pd-memory-actions">
						<button type="button" onClick={() => setClearConfirm(false)}>{t('common.close')}</button>
						<button type="button" className="is-danger" onClick={() => void confirmClear()}>{t('memory.clearAll')}</button>
					</div>
				</div>
			</div>}
		</dialog>,
		document.body,
	);
}

