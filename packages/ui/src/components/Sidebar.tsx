import { useMemo, useRef, useState } from 'react';
import type { UiSessionSummary } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { Icon } from './Icons';

interface SidebarProps {
	open: boolean;
	narrow: boolean;
	onToggle(): void;
	onNavigate(): void;
	onOpenSettings(): void;
}

type SessionGroup = '今天' | '昨天' | '最近 7 天' | '更早';
const GROUP_ORDER: SessionGroup[] = ['今天', '昨天', '最近 7 天', '更早'];

function workspaceName(cwd: string): string {
	if (!cwd) return '选择工作区';
	return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function sessionTitle(name: string | undefined, firstMessage: string): string {
	return name?.trim() || firstMessage.trim().split(/\r?\n/)[0] || '未命名会话';
}

function sessionDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const today = new Date();
	if (date.toDateString() === today.toDateString()) {
		return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
	}
	return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function sessionGroup(value: string): SessionGroup {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '更早';
	const now = new Date();
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = 24 * 60 * 60 * 1000;
	if (date.getTime() >= midnight) return '今天';
	if (date.getTime() >= midnight - day) return '昨天';
	if (date.getTime() >= midnight - 6 * day) return '最近 7 天';
	return '更早';
}

function groupedSessions(sessions: UiSessionSummary[], query: string, oldestFirst: boolean) {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const filtered = sessions.filter((session) => {
		const haystack = `${sessionTitle(session.name, session.firstMessage)}\n${session.firstMessage}\n${session.path}`.toLocaleLowerCase();
		return haystack.includes(normalizedQuery);
	});
	filtered.sort((a, b) => {
		const difference = new Date(b.modified).getTime() - new Date(a.modified).getTime();
		return oldestFirst ? -difference : difference;
	});
	const groups = new Map<SessionGroup, UiSessionSummary[]>();
	for (const session of filtered) {
		const group = sessionGroup(session.modified);
		groups.set(group, [...(groups.get(group) ?? []), session]);
	}
	const order = oldestFirst ? [...GROUP_ORDER].reverse() : GROUP_ORDER;
	return { count: filtered.length, groups: order.filter((group) => groups.has(group)).map((group) => ({ label: group, sessions: groups.get(group)! })) };
}

export function Sidebar({ open, narrow, onToggle, onNavigate, onOpenSettings }: SidebarProps) {
	const cwd = useChatStore((s) => s.cwd);
	const model = useChatStore((s) => s.model);
	const status = useChatStore((s) => s.status);
	const sessions = useChatStore((s) => s.sessions);
	const sessionId = useChatStore((s) => s.sessionId);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const pickWorkspace = useChatStore((s) => s.pickWorkspace);
	const newSession = useChatStore((s) => s.newSession);
	const switchSession = useChatStore((s) => s.switchSession);
	const refreshSessions = useChatStore((s) => s.refreshSessions);
	const [actionError, setActionError] = useState<string | null>(null);
	const [search, setSearch] = useState('');
	const [oldestFirst, setOldestFirst] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);
	const grouped = useMemo(() => groupedSessions(sessions, search, oldestFirst), [sessions, search, oldestFirst]);
	const blocked = status === 'starting' || status === 'busy';
	const sessionBlocked = status !== 'idle';
	const collapsed = !open && !narrow;
	const showUnsaved = Boolean(sessionId && !sessions.some((session) => session.path === sessionPath) && (!search || '新会话'.includes(search.trim())));

	async function perform(action: () => Promise<void>, navigate = false) {
		setActionError(null);
		try {
			await action();
			if (navigate) onNavigate();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}

	async function refresh() {
		setRefreshing(true);
		try {
			await perform(refreshSessions);
		} finally {
			setRefreshing(false);
		}
	}

	return (
		<aside className={`pd-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`} aria-label="主侧栏" aria-hidden={narrow && !open} inert={narrow && !open}>
			<div className="pd-sidebar-brand">
				<div className="pd-brand-mark" aria-hidden="true">π</div>
				<div className="pd-brand-label pd-sidebar-detail">
					<strong>Pi Desktop</strong>
					<span>桌面工作台</span>
				</div>
				<button type="button" className="pd-icon-button pd-sidebar-collapse" onClick={onToggle} aria-label={open ? '收起侧栏' : '展开侧栏'} title={open ? '收起侧栏' : '展开侧栏'}>
					<Icon name="panel" />
				</button>
			</div>

			<div className="pd-sidebar-top">
				<button type="button" className="pd-workspace-button" onClick={() => void perform(pickWorkspace)} disabled={blocked} title={cwd || '打开工作区'}>
					<Icon name="folder" />
					<span className="pd-sidebar-detail pd-workspace-name">{workspaceName(cwd)}</span>
					<span className="pd-sidebar-detail pd-workspace-hint">切换</span>
				</button>
				<button type="button" className="pd-new-session" onClick={() => void perform(newSession, true)} disabled={sessionBlocked} title="新会话">
					<Icon name="plus" />
					<span className="pd-sidebar-detail">新会话</span>
				</button>
			</div>

			<div className="pd-sidebar-detail pd-session-section">
				<div className="pd-section-heading">
					<span>会话 <small>{search.trim() ? `${grouped.count}/${sessions.length}` : sessions.length}</small></span>
					<div className="pd-section-actions">
						<button type="button" className="pd-icon-button" onClick={() => setOldestFirst((value) => !value)} aria-label={oldestFirst ? '按最近时间排序' : '按最早时间排序'} title={oldestFirst ? '当前：最早优先，点击切换' : '当前：最近优先，点击切换'}><Icon name="sort" width="15" height="15" /></button>
						<button type="button" className="pd-icon-button" onClick={() => void refresh()} disabled={refreshing} aria-label="刷新会话列表" title="刷新会话列表"><Icon name="refresh" width="15" height="15" className={refreshing ? 'pd-spinning' : undefined} /></button>
					</div>
				</div>
				<div className="pd-session-search">
					<Icon name="search" width="15" height="15" />
					<input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearch(''); searchRef.current?.blur(); } }} type="search" aria-label="搜索会话" placeholder="搜索会话" />
					{search && <button type="button" className="pd-search-clear" onClick={() => { setSearch(''); searchRef.current?.focus(); }} aria-label="清除搜索"><Icon name="close" width="13" height="13" /></button>}
				</div>
				<div className="pd-session-list" aria-live="polite">
					{showUnsaved && (
						<div className="pd-session-row is-active" aria-current="page">
							<Icon name="message" />
							<span className="pd-session-copy"><strong>新会话</strong><small>当前会话</small></span>
						</div>
					)}
					{grouped.groups.map((group) => (
						<div className="pd-session-group" key={group.label}>
							<div className="pd-session-group-label">{group.label}</div>
							{group.sessions.map((session) => {
								const active = session.path === sessionPath;
								const title = sessionTitle(session.name, session.firstMessage);
								return (
									<button key={session.path} type="button" className={`pd-session-row${active ? ' is-active' : ''}`} onClick={() => void perform(() => switchSession(session.path), true)} disabled={sessionBlocked} aria-current={active ? 'page' : undefined} title={title}>
										<Icon name="message" />
										<span className="pd-session-copy"><strong>{title}</strong><small>{session.messageCount} 条消息</small></span>
										<time dateTime={session.modified}>{sessionDate(session.modified)}</time>
									</button>
								);
							})}
						</div>
					))}
					{grouped.count === 0 && !showUnsaved && <div className="pd-session-empty">{search ? '没有找到匹配的会话。' : refreshing ? '正在加载会话…' : '会话将在这里显示。'}</div>}
				</div>
			</div>

			<div className="pd-sidebar-footer pd-sidebar-detail">
				{actionError && <div className="pd-sidebar-error" role="alert">{actionError}</div>}
				<button type="button" className="pd-settings-entry" onClick={onOpenSettings}><Icon name="settings" width="17" height="17" /><span>设置</span><Icon name="chevronRight" width="15" height="15" /></button>
				<div className="pd-footer-status"><span className={`pd-status-dot is-${status}`} /><span>{status === 'busy' ? 'Pi 正在工作' : status === 'idle' ? 'Pi 已就绪' : status === 'starting' ? '正在启动' : status === 'error' ? '连接出错' : '正在连接'}</span></div>
				{model && <div className="pd-footer-model" title={model}>{model}</div>}
			</div>
		</aside>
	);
}
