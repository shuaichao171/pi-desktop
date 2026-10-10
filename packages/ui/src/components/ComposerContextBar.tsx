import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceBranches, WorkspaceGitCheckoutResult } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { isConversationWorkspace, sidebarProjectPaths } from '../sidebarOrganization';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function workspaceName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Project and branch controls for an empty conversation, with a direct action
 * to return to a conversation outside any project.
 */
export function ComposerContextBar() {
	const cwd = useChatStore((state) => state.cwd);
	const workspaces = useChatStore((state) => state.workspaces);
	const conversationWorkspaces = useChatStore((state) => state.conversationWorkspaces);
	const isHome = !workspaces.includes(cwd) || isConversationWorkspace(cwd, conversationWorkspaces);
	return (
		<div className="pd-composer-context">
			<ProjectChip isHome={isHome} />
			{!isHome && <BranchChip />}
		</div>
	);
}

function ProjectChip({ isHome }: { isHome: boolean }) {
	const { t } = useT();
	const cwd = useChatStore((state) => state.cwd);
	const workspaces = useChatStore((state) => state.workspaces);
	const conversationWorkspaces = useChatStore((state) => state.conversationWorkspaces);
	const detachProject = useChatStore((state) => state.detachProject);
	const switchWorkspace = useChatStore((state) => state.switchWorkspace);
	const pickWorkspace = useChatStore((state) => state.pickWorkspace);
	const navigationPending = useChatStore((state) => state.navigationPending);
	const preparingSession = useChatStore((state) => state.sessionPreparation !== null);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canDetach = Boolean(cwd) && !isHome;
	const projects = sidebarProjectPaths(workspaces, null, conversationWorkspaces);
	function clearProject() {
		if (!canDetach || navigationPending) return;
		setOpen(false);
		setError(null);
		void detachProject().catch((cause) => setError(errorText(cause)));
	}

	if (!cwd && !preparingSession) {
		return (
			<div className="pd-context-chip-wrap" onKeyDown={(event) => { if (event.key === 'Escape' && error) { event.stopPropagation(); setError(null); } }}>
				<button type="button" className="pd-context-chip" disabled={navigationPending} aria-label={t('composer.projectChoose')} onClick={() => { setError(null); void pickWorkspace({ fresh: true }).catch((cause) => setError(errorText(cause))); }}>
					<Icon name="folder" width="15" height="15" />
					<span className="pd-context-chip-label">{t('composer.projectChoose')}</span>
					<Icon name="chevronDown" width="13" height="13" />
				</button>
				{error && <div className="pd-chat-title-error pd-context-chip-error" role="alert">{t('chat.menuActionFailed', { message: error })}</div>}
			</div>
		);
	}

	return (
		<div className="pd-context-chip-wrap pd-context-project" onKeyDown={(event) => { if (event.key === 'Escape' && error) { event.stopPropagation(); setError(null); } }}>
			<div className={`pd-context-project-control${canDetach ? ' is-attached' : ''}`} role="group" aria-label={t('composer.projectMenuLabel')}>
				{canDetach && <button type="button" className="pd-context-project-clear" disabled={navigationPending} aria-label={t('composer.projectClear')} title={t('composer.projectClear')} onClick={clearProject}>
					<Icon name="close" width="13" height="13" />
				</button>}
				<button ref={anchorRef} type="button" className="pd-context-chip" disabled={navigationPending} aria-haspopup="menu" aria-expanded={open} aria-label={t('composer.projectMenuLabel')} onClick={() => { setError(null); setOpen((value) => !value); }}>
					<Icon name="folder" width="15" height="15" />
					<span className="pd-context-chip-label">{isHome ? t('composer.projectChoose') : workspaceName(cwd)}</span>
					<Icon name="chevronDown" width="13" height="13" />
				</button>
			</div>
			{open && anchorRef.current && <SidebarPopover anchor={anchorRef.current} label={t('composer.projectMenuLabel')} placement="top" align="start" className="pd-project-picker" onClose={() => setOpen(false)}>
				<div className="pd-project-picker-head" aria-hidden="true"><span>{t('composer.projectPickerTitle')}</span>{projects.length > 0 && <small>{projects.length}</small>}</div>
				{projects.length > 0 ? <div className="pd-project-picker-list">
					{projects.map((workspace) => (
						<button type="button" key={workspace} role="menuitemradio" aria-checked={workspace === cwd} className="pd-context-menu-row is-wide pd-project-option" title={workspace} disabled={navigationPending || workspace === cwd} onClick={() => { setOpen(false); void switchWorkspace(workspace, { fresh: true }).catch((cause) => setError(errorText(cause))); }}>
							<span className="pd-project-option-icon" aria-hidden="true"><Icon name="folder" width="15" height="15" /></span>
							<span className="pd-project-option-copy"><span className="pd-context-menu-main">{workspaceName(workspace)}</span><small className="pd-context-menu-sub">{workspace}</small></span>
							{workspace === cwd ? <Icon name="check" className="pd-project-option-check" width="15" height="15" /> : null}
						</button>
					))}
				</div> : <p className="pd-project-picker-empty">{t('composer.projectPickerEmpty')}</p>}
				<div className="pd-project-picker-actions">
					<button type="button" role="menuitem" className="pd-context-menu-row is-wide pd-project-action" disabled={navigationPending} onClick={() => { setOpen(false); void pickWorkspace({ fresh: true }).catch((cause) => setError(errorText(cause))); }}>
						<span className="pd-project-option-icon is-action" aria-hidden="true"><Icon name="plus" width="15" height="15" /></span><span className="pd-context-menu-main">{t('composer.projectOpen')}</span>
					</button>
					{canDetach && <button type="button" role="menuitem" className="pd-context-menu-row is-wide pd-project-action" disabled={navigationPending} onClick={clearProject}>
						<span className="pd-project-option-icon is-action" aria-hidden="true"><Icon name="home" width="15" height="15" /></span><span className="pd-context-menu-main">{t('composer.projectClear')}</span>
					</button>}
				</div>
			</SidebarPopover>}
			{error && <div className="pd-chat-title-error pd-context-chip-error" role="alert">{t('chat.menuActionFailed', { message: error })}</div>}
		</div>
	);
}

interface BranchState {
	loading: boolean;
	error: string | null;
	branches: WorkspaceBranches | null;
	dirtyCount: number;
}

const BRANCH_IDLE: BranchState = { loading: true, error: null, branches: null, dirtyCount: 0 };

type BranchSwitchFailure = Extract<WorkspaceGitCheckoutResult, { ok: false }>;

function BranchSwitchAssist({ initial, onClose, onSwitched }: { initial: BranchSwitchFailure; onClose(): void; onSwitched(): void }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const lock = useRef(false);
	const [failure, setFailure] = useState(initial);
	const [message, setMessage] = useState(() => t('composer.branchCommitDefault', { branch: initial.branch }));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
	const issueText = failure.issue.code === 'dirty' ? t('composer.branchBlockedDirty')
		: failure.issue.code === 'branch-in-use' ? t('composer.branchBlockedInUse')
			: failure.issue.code === 'conflict' ? t('composer.branchBlockedConflict') : t('composer.branchBlockedUnknown', { message: failure.issue.message });
	async function retry(commit: boolean) {
		if (!bridge || lock.current) return;
		lock.current = true; setBusy(true); setError(null);
		try {
			if (commit) await bridge.commitWorkspace(message);
			const result = await bridge.checkoutWorkspaceBranch(failure.branch);
			const current = useChatStore.getState();
			if (current.bridge !== bridge || current.cwd !== cwd) throw new Error(t('composer.branchWorkspaceChanged'));
			if (!result.ok) { setFailure(result); return; }
			dialog.current?.close(); onSwitched();
		} catch (cause) { setError(errorText(cause)); }
		finally { lock.current = false; setBusy(false); }
	}
	return createPortal(<dialog ref={dialog} className="pd-branch-switch-dialog" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
		<header><h2 id={id}>{t('composer.branchSwitchBlockedTitle')}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={t('composer.branchClose')}><Icon name="close" width="15" height="15" /></button></header>
		<p>{t('composer.branchSwitchTarget', { branch: failure.branch })}</p>
		<p className="pd-branch-switch-issue" role="alert">{issueText}</p>
		{failure.issue.paths.length > 0 && <ul className="pd-branch-switch-files">{failure.issue.paths.slice(0, 12).map((path) => <li key={path}><code>{path}</code></li>)}{failure.issue.paths.length > 12 && <li>{t('composer.branchMoreFiles', { count: failure.issue.paths.length - 12 })}</li>}</ul>}
		{failure.issue.code === 'dirty' && <label>{t('composer.branchCommitMessage')}<input value={message} maxLength={4000} disabled={busy} onChange={(event) => setMessage(event.target.value)} /></label>}
		{error && <p className="pd-branch-switch-error" role="alert">{error}</p>}
		<footer><button autoFocus type="button" disabled={busy} onClick={onClose}>{t('sidebar.cancel')}</button>{failure.issue.code === 'dirty' ? <button type="button" className="is-primary" disabled={busy || !message.trim()} onClick={() => void retry(true)}>{t(busy ? 'composer.branchCommitting' : 'composer.branchCommitAndSwitch')}</button> : <button type="button" className="is-primary" disabled={busy} onClick={() => void retry(false)}>{t(busy ? 'composer.branchSwitching' : 'composer.branchRetrySwitch')}</button>}</footer>
	</dialog>, document.body);
}

function BranchChip() {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [switching, setSwitching] = useState<string | null>(null);
	const [blocked, setBlocked] = useState<BranchSwitchFailure | null>(null);
	const [state, setState] = useState<BranchState>(BRANCH_IDLE);
	const aliveRef = useRef(true);
	useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

	async function refresh() {
		if (!bridge || !cwd) return;
		setState((current) => ({ ...current, loading: true, error: null }));
		try {
			const [branches, status] = await Promise.all([bridge.getWorkspaceBranches(), bridge.getWorkspaceGitStatus()]);
			const latest = useChatStore.getState();
			if (!aliveRef.current || latest.bridge !== bridge || latest.cwd !== cwd) return;
			setState({ loading: false, error: null, branches, dirtyCount: status.entries.length });
		} catch (cause) {
			const latest = useChatStore.getState();
			if (!aliveRef.current || latest.bridge !== bridge || latest.cwd !== cwd) return;
			setState((current) => ({ ...current, loading: false, error: errorText(cause) }));
		}
	}

	async function switchBranch(name: string) {
		if (!bridge || switching) return;
		setSwitching(name); setState((value) => ({ ...value, error: null }));
		try {
			const result = await bridge.checkoutWorkspaceBranch(name);
			const latest = useChatStore.getState();
			if (!aliveRef.current || latest.bridge !== bridge || latest.cwd !== cwd) return;
			if (!result.ok) { setOpen(false); setBlocked(result); return; }
			setOpen(false); await refresh();
		} catch (cause) {
			if (aliveRef.current) setState((value) => ({ ...value, error: errorText(cause) }));
		} finally { if (aliveRef.current) setSwitching(null); }
	}

	useEffect(() => {
		setState(BRANCH_IDLE); setSwitching(null); setBlocked(null);
		if (bridge && cwd) void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bridge, cwd]);
	useEffect(() => bridge?.onWorkspaceChanged((event) => { if (event.cwd === cwd && event.git && !switching) void refresh(); }), [bridge, cwd, switching]);

	const branches = state.branches;
	if (!bridge || !cwd || !branches || !branches.isRepository) return null;
	const label = branches.current ?? t('composer.branchDetached');
	const visible = branches.branches.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));
	return <div className="pd-context-chip-wrap">
		<button ref={anchorRef} type="button" className="pd-context-chip" aria-haspopup="menu" aria-expanded={open} aria-label={`${t('composer.branchLabel')}: ${label}`} onClick={() => { const next = !open; setOpen(next); setQuery(''); if (next) void refresh(); }}>
			<Icon name="gitBranch" width="15" height="15" /><span className="pd-context-chip-label">{label}</span><Icon name="chevronDown" width="13" height="13" />
		</button>
		{open && anchorRef.current && <SidebarPopover anchor={anchorRef.current} label={t('composer.branchLabel')} placement="top" dialog onClose={() => { setOpen(false); setSwitching(null); }}>
			<input className="pd-context-branch-search" type="text" value={query} placeholder={t('composer.branchSearchPlaceholder')} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); anchorRef.current?.focus(); } }} />
			<div className="pd-context-branch-list">{state.loading ? <p className="pd-context-branch-note" role="status">{t('composer.branchLoading')}</p> : visible.length === 0 ? <p className="pd-context-branch-note">{t('composer.branchEmpty')}</p> : visible.map((name) => {
				const current = name === branches.current;
				return <button type="button" key={name} role="menuitemradio" aria-checked={current} className="pd-context-menu-row" disabled={switching !== null} onClick={() => { if (!current) void switchBranch(name); }}>
					<span className="pd-context-menu-main"><Icon name="gitBranch" width="15" height="15" />{name}{switching === name ? <span className="pd-context-branch-switching" role="status">{t('composer.branchSwitching')}</span> : null}</span>{current ? <Icon name="check" width="15" height="15" /> : null}{current && state.dirtyCount > 0 ? <small className="pd-context-menu-sub">{t('composer.branchDirty', { count: state.dirtyCount })}</small> : null}
				</button>;
			})}</div>
			{state.error && <div className="pd-sidebar-error pd-context-branch-error" role="alert">{state.error}</div>}
		</SidebarPopover>}
		{blocked && <BranchSwitchAssist initial={blocked} onClose={() => { setBlocked(null); requestAnimationFrame(() => anchorRef.current?.focus()); }} onSwitched={() => { setBlocked(null); void refresh(); requestAnimationFrame(() => anchorRef.current?.focus()); }} />}
	</div>;
}
