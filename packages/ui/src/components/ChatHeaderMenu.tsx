import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExitPresence } from './ExitPresence';
import type { UiMessage, UiSessionMetaPatch, WorkspaceOpener } from '@pidesktop/shared';
import { agentCapabilities } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon, type IconName } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import { SidebarSubmenu } from './SidebarSubmenu';
import { HoverTooltip } from './HoverTooltip';
import { SessionInfoPanel } from './SessionInfoPanel';
import { SessionTreePanel } from './SessionTreePanel';
import { SessionDeleteDialog } from './SessionDeleteDialog';
import { runWithFeedback } from '../operationFeedback';
import { isConversationWorkspace } from '../sidebarOrganization';
import { managementCopy } from '../managementCopy';
import { SPLIT_PANE_OPENED_EVENT } from './splitPaneRegions';

type HeaderSubmenuKey = 'open' | 'export';

function openerIcon(opener: WorkspaceOpener) {
	if (opener.icon) return <img src={opener.icon} alt="" className="pd-menu-app-icon" width="15" height="15" />;
	return <Icon name={opener.kind === 'terminal' ? 'terminal' : 'code'} width="15" height="15" />;
}

/**
 * Claude-style chevron menu beside the conversation title: open-in flyout,
 * inline rename, fork, pin/unread/archive toggles, stats/tree/export, commit
 * and delete.
 */
export function ChatHeaderMenu({ title, sessionPath, cwd, paneMode = false, onRename, onOpenCommit }: {
	title: string;
	sessionPath: string | null;
	cwd: string;
	paneMode?: boolean;
	onRename?: () => void;
	onOpenCommit?: () => void;
}) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const bridge = useChatStore((s) => s.bridge);
	const session = useChatStore((s) => (sessionPath ? s.sessions.find((item) => item.path === sessionPath) : undefined));
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const selectSession = useChatStore((s) => s.selectSession);
	const newSession = useChatStore((s) => s.newSession);
	const conversationWorkspaces = useChatStore((s) => s.conversationWorkspaces);
	const status = useChatStore((s) => s.status);
	const navigationPending = useChatStore((s) => s.navigationPending);
	const sessionId = useChatStore((s) => s.sessionId);
	const folderLabel = t(isConversationWorkspace(cwd, conversationWorkspaces) ? 'chat.openConversationFolder' : 'chat.menuOpenWorkspace');
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	const [submenu, setSubmenu] = useState<{ key: HeaderSubmenuKey; anchor: HTMLElement; keyboard: boolean } | null>(null);
	const [openers, setOpeners] = useState<WorkspaceOpener[] | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [panel, setPanel] = useState<'stats' | 'tree' | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	// External agents keep a linear history: no session tree to browse.
	const canBranch = useChatStore((s) => agentCapabilities(s.agent).session.branch);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const panelTrigger = useRef<HTMLElement | null>(null);
	const submenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const saved = Boolean(sessionPath);
	const busy = status !== 'idle';
	const canRename = Boolean(bridge && sessionId && !navigationPending && (status === 'idle' || status === 'busy') && sessionPath && onRename);

	function clearSubmenuTimer() {
		if (!submenuTimer.current) return;
		clearTimeout(submenuTimer.current);
		submenuTimer.current = null;
	}

	useEffect(() => () => clearSubmenuTimer(), []);

	useEffect(() => {
		if (!anchor || !bridge?.listWorkspaceOpeners) return;
		let cancelled = false;
		void bridge.listWorkspaceOpeners()
			.then((list) => { if (!cancelled) setOpeners(list.filter((opener) => opener.kind !== 'file-manager' && opener.id !== 'explorer')); })
			.catch(() => { if (!cancelled) setOpeners([]); });
		return () => { cancelled = true; };
	}, [anchor, bridge]);

	function close() {
		clearSubmenuTimer();
		setSubmenu(null);
		setAnchor(null);
		setNotice(null);
	}

	function openSubmenu(key: HeaderSubmenuKey, row: HTMLElement, keyboard: boolean) {
		clearSubmenuTimer();
		setSubmenu((current) => current?.key === key && current.anchor === row && current.keyboard === keyboard ? current : { key, anchor: row, keyboard });
	}

	function scheduleSubmenuClose() {
		clearSubmenuTimer();
		submenuTimer.current = setTimeout(() => setSubmenu(null), 220);
	}

	function perform(patch: UiSessionMetaPatch) {
		if (!sessionPath) return;
		const target = sessionPath;
		close();
		void runWithFeedback({ id: `session-meta:${target}`, title, run: () => updateSessionMeta(target, patch) });
	}

	async function copyText(text: string) {
		await runWithFeedback({ id: `copy:${sessionPath ?? cwd}`, title: t('chat.menuCopyTitle'), run: () => navigator.clipboard.writeText(text), success: t('chat.menuCopied') });
	}

	function openFolder() {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge || !cwd) return;
		const target = cwd;
		close();
		void runWithFeedback({ id: `open-folder:${target}`, title: folderLabel, run: () => activeBridge.openWorkspaceFolder(target) });
	}

	function openInVsCode() {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge || !cwd) return;
		const target = cwd;
		close();
		void runWithFeedback({ id: `open-editor:${target}`, title: t('chat.menuOpenInVsCode'), run: () => activeBridge.openWorkspaceInVsCode(target) });
	}

	function openWith(opener: WorkspaceOpener) {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge || !cwd) return;
		const target = cwd;
		close();
		void runWithFeedback({
			id: `open-editor:${target}:${opener.id}`,
			title: opener.name ?? (opener.id === 'vscode' ? 'VS Code' : opener.id),
			run: () => activeBridge.openWorkspaceWith(target, opener.id),
		});
	}

	function openInNewWindow() {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge?.openSessionInNewWindow || !sessionPath || !cwd) return;
		const targetPath = sessionPath;
		const targetCwd = cwd;
		close();
		void runWithFeedback({
			id: `open-window:${targetPath}`,
			title: t('sidebar.openInNewWindow'),
			run: async () => {
				await activeBridge.openSessionInNewWindow!(targetPath);
				const current = useChatStore.getState();
				if (current.cwd === targetCwd && current.sessionPath === targetPath) await newSession({ cwd: targetCwd });
			},
		});
	}

	function openInSplitPane() {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge?.openSplitPane || !sessionPath || !cwd) return;
		const targetPath = sessionPath;
		const targetCwd = cwd;
		close();
		void runWithFeedback({
			id: `open-split:${targetPath}`,
			title: t('sidebar.openInSplitPane'),
			run: async () => {
				if (await activeBridge.focusHostedSession?.(targetPath).catch(() => false)) return;
				const current = useChatStore.getState();
				if (current.cwd === targetCwd && current.sessionPath === targetPath) await newSession({ cwd: targetCwd });
				const paneId = await activeBridge.openSplitPane!(targetCwd, targetPath);
				window.dispatchEvent(new CustomEvent(SPLIT_PANE_OPENED_EVENT, { detail: paneId }));
			},
		});
	}

	function forkConversation() {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge?.forkSession || !sessionPath || !cwd) return;
		const targetPath = sessionPath;
		const targetCwd = cwd;
		const nextName = `${title}${t('sidebar.forkSuffix')}`.slice(0, 200);
		close();
		void runWithFeedback({
			id: `fork:${targetPath}`,
			title: t('sidebar.fork'),
			run: async () => {
				const forked = await activeBridge.forkSession!(targetPath, nextName);
				await selectSession(targetCwd, forked);
			},
		});
	}

	function revealSessionFile() {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge?.revealSessionFile || !sessionPath) return;
		const targetPath = sessionPath;
		close();
		void runWithFeedback({ id: `reveal-session:${targetPath}`, title: t('sidebar.revealSessionFile'), run: () => activeBridge.revealSessionFile!(targetPath) });
	}

	function openPanel(kind: 'stats' | 'tree') {
		panelTrigger.current = anchor ?? buttonRef.current;
		close();
		setPanel(kind);
	}

	async function exportAs(format: 'html' | 'jsonl') {
		const activeBridge = useChatStore.getState().bridge;
		if (!activeBridge) return;
		const origin = { cwd, sessionPath, sessionId: useChatStore.getState().sessionId };
		await runWithFeedback({
			id: `export:${origin.cwd}:${origin.sessionPath ?? origin.sessionId}:${format}`,
			title: t(format === 'html' ? 'chat.menuExportHtml' : 'chat.menuExportJsonl'),
			run: async () => {
				const current = useChatStore.getState();
				if (current.cwd !== origin.cwd || current.sessionPath !== origin.sessionPath || current.sessionId !== origin.sessionId) throw new Error(t('chat.exportReturnToSession'));
				return activeBridge.exportSession(format);
			},
			success: (result) => typeof result === 'string' && result ? t('chat.export.done', { path: result }) : null,
		});
	}

	function copyConversationMarkdown() {
		const messages = useChatStore.getState().messages as UiMessage[];
		if (messages.length === 0) { setNotice(t('chat.export.empty')); return; }
		const body = messages.map((message) => {
			if (message.role === 'system') return `> **${message.systemKind ?? 'system'}**\n>\n${message.text.split(/\r?\n/).map((line) => `> ${line}`).join('\n')}`;
			const heading = message.role === 'user' ? t('chat.export.userHeading') : t('chat.export.assistantHeading');
			return `## ${heading}\n\n${message.text}`;
		}).join('\n\n---\n\n');
		close();
		void copyText(body);
	}

	function menuItem(options: { icon: IconName; label: string; shortcut?: string; onSelect?(): void; disabled?: boolean; danger?: boolean; submenu?: HeaderSubmenuKey }) {
		const flyout = options.submenu;
		return (
			<button
				type="button"
				role="menuitem"
				className={`pd-menu-item${options.danger ? ' pd-sidebar-menu-danger' : ''}`}
				data-shortcut={options.shortcut}
				data-shortcut-label={flyout || !options.shortcut ? undefined : options.shortcut === 'Delete' ? 'Del' : options.shortcut}
				disabled={options.disabled}
				aria-haspopup={flyout ? 'menu' : undefined}
				aria-expanded={flyout ? submenu?.key === flyout : undefined}
				onMouseEnter={(event) => {
					if (flyout && !options.disabled) openSubmenu(flyout, event.currentTarget, false);
					else if (submenu) scheduleSubmenuClose();
				}}
				onKeyDown={flyout ? (event) => {
					if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openSubmenu(flyout, event.currentTarget, true); }
				} : undefined}
				onClick={(event) => {
					if (options.disabled) return;
					if (flyout) openSubmenu(flyout, event.currentTarget, true);
					else options.onSelect?.();
				}}
			>
				<Icon name={options.icon} width="15" height="15" />
				<span>{options.label}</span>
				{flyout && <Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />}
			</button>
		);
	}

	function submenuItem(options: { key: string; label: string; icon?: IconName; customIcon?: ReactNode; index?: number; disabled?: boolean; onSelect(): void }) {
		const digit = options.index !== undefined && options.index <= 9 ? String(options.index) : undefined;
		return (
			<button
				key={options.key}
				type="button"
				role="menuitem"
				className="pd-menu-item"
				disabled={options.disabled}
				data-shortcut={digit}
				data-shortcut-label={digit}
				onClick={() => { if (!options.disabled) options.onSelect(); }}
			>
				{options.customIcon ?? (options.icon && <Icon name={options.icon} width="15" height="15" />)}
				<span>{options.label}</span>
			</button>
		);
	}

	const editorOpeners = openers ?? [];
	const hasVsCodeOpener = editorOpeners.some((opener) => opener.id === 'vscode');

	return <>
		<HoverTooltip title={t('chat.menuLabel')}>
			<button
				ref={buttonRef}
				type="button"
				className="pd-icon-button pd-chat-header-more pd-conversation-header-menu"
				aria-label={t('chat.menuLabel')}
				aria-haspopup="menu"
				aria-expanded={Boolean(anchor)}
				onClick={(event) => {
					if (anchor) { close(); return; }
					setNotice(null);
					setAnchor(event.currentTarget);
				}}
			>
				<Icon name="chevronDown" width="14" height="14" />
			</button>
		</HoverTooltip>
		<ExitPresence show={Boolean(anchor)} surface="pd-sidebar-popover">{anchor && <SidebarPopover anchor={anchor} align="start" className="pd-context-menu" label={t('chat.menuLabel')} onClose={close}>
			{menuItem({ icon: 'panelRight', label: t('sidebar.openIn'), shortcut: 'O', submenu: 'open', disabled: !cwd && !saved })}
			<hr />
			{onRename && menuItem({ icon: 'pencil', label: t('sidebar.rename'), shortcut: 'R', disabled: !canRename, onSelect: () => { close(); onRename(); } })}
			{!paneMode && menuItem({ icon: 'gitBranch', label: t('sidebar.fork'), shortcut: 'F', disabled: !saved || !bridge?.forkSession || navigationPending || busy, onSelect: forkConversation })}
			{menuItem({ icon: 'pin', label: t(session?.pinned ? 'sidebar.unpin' : 'sidebar.pin'), shortcut: 'P', disabled: !saved, onSelect: () => perform({ pinned: !session?.pinned }) })}
			{menuItem({ icon: 'messageDot', label: t(session?.unread ? 'sidebar.markRead' : 'sidebar.markUnread'), shortcut: 'U', disabled: !saved, onSelect: () => perform(session?.unread ? { unread: false, expectedUnreadAt: session.unreadAt } : { unread: true }) })}
			<hr />
			{menuItem({ icon: 'clock', label: t('chat.stats.menuEntry'), onSelect: () => openPanel('stats') })}
			{canBranch && menuItem({ icon: 'gitBranch', label: t('chat.tree.menuEntry'), onSelect: () => openPanel('tree') })}
			{menuItem({ icon: 'copy', label: t('chat.menuExportGroup'), submenu: 'export' })}
			{onOpenCommit && menuItem({ icon: 'gitCommit', label: t('chat.menuCommit'), disabled: !cwd, onSelect: () => { close(); onOpenCommit(); } })}
			<hr />
			{menuItem({ icon: 'archive', label: t(session?.archived ? 'sidebar.unarchive' : 'sidebar.archive'), shortcut: 'A', disabled: !saved, onSelect: () => perform({ archived: !session?.archived }) })}
			{menuItem({ icon: 'trash', label: t('sidebar.deleteSession'), shortcut: 'Delete', danger: true, disabled: !saved, onSelect: () => { close(); setDeleteOpen(true); } })}
			{notice && <p className="pd-sidebar-menu-note">{notice}</p>}
			{submenu && <SidebarSubmenu
				anchor={submenu.anchor}
				label={t(submenu.key === 'open' ? 'sidebar.openIn' : 'chat.menuExportGroup')}
				autoFocus={submenu.keyboard}
				onPointerEnter={clearSubmenuTimer}
				onClose={(restore) => { const row = submenu.anchor; setSubmenu(null); if (restore) row.focus(); }}
			>
				{submenu.key === 'open' && <>
					{!paneMode && <>
						{submenuItem({ key: 'new-window', label: t('sidebar.openInNewWindow'), icon: 'maximize', index: 1, disabled: !saved || !bridge?.openSessionInNewWindow || busy, onSelect: openInNewWindow })}
						{submenuItem({ key: 'split-pane', label: t('sidebar.openInSplitPane'), icon: 'panelRight', index: 2, disabled: !saved || !bridge?.openSplitPane || busy, onSelect: openInSplitPane })}
						<hr />
					</>}
					{editorOpeners.map((opener, idx) => submenuItem({
						key: `opener:${opener.id}`,
						label: opener.name ?? (opener.id === 'vscode' ? 'VS Code' : opener.id),
						customIcon: openerIcon(opener),
						index: (paneMode ? 1 : 3) + idx,
						disabled: !cwd,
						onSelect: () => openWith(opener),
					}))}
					{!hasVsCodeOpener && submenuItem({
						key: 'vscode',
						label: t('chat.menuOpenInVsCode'),
						icon: 'code',
						index: (paneMode ? 1 : 3) + editorOpeners.length,
						disabled: !cwd,
						onSelect: openInVsCode,
					})}
					{submenuItem({
						key: 'explorer',
						label: folderLabel,
						icon: 'folder',
						index: (paneMode ? 1 : 3) + editorOpeners.length + (hasVsCodeOpener ? 0 : 1),
						disabled: !cwd,
						onSelect: openFolder,
					})}
					<hr />
					{submenuItem({ key: 'reveal-file', label: t('sidebar.revealSessionFile'), icon: 'file', disabled: !saved || !bridge?.revealSessionFile, onSelect: revealSessionFile })}
					{submenuItem({ key: 'copy-path', label: t('chat.menuCopyPath'), icon: 'copy', disabled: !saved, onSelect: () => { if (sessionPath) { close(); void copyText(sessionPath); } } })}
				</>}
				{submenu.key === 'export' && <>
					{submenuItem({ key: 'copy-title', label: t('chat.menuCopyTitle'), icon: 'copy', index: 1, onSelect: () => { close(); void copyText(title); } })}
					{submenuItem({ key: 'copy-markdown', label: t('chat.menuCopyMarkdown'), icon: 'file', index: 2, onSelect: copyConversationMarkdown })}
					<hr />
					{submenuItem({ key: 'export-html', label: t('chat.menuExportHtml'), icon: 'update', index: 3, onSelect: () => { close(); void exportAs('html'); } })}
					{submenuItem({ key: 'export-jsonl', label: t('chat.menuExportJsonl'), icon: 'update', index: 4, onSelect: () => { close(); void exportAs('jsonl'); } })}
				</>}
			</SidebarSubmenu>}
		</SidebarPopover>}</ExitPresence>
		{panel === 'stats' && <SessionInfoPanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
		{panel === 'tree' && <SessionTreePanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
		{deleteOpen && sessionPath && <SessionDeleteDialog
			title={title}
			workspace={cwd}
			onDelete={async () => {
				const target = sessionPath;
				void runWithFeedback({ id: `session-delete:${target}`, title: t('sidebar.deleteSession'), success: copy.deleted, run: () => useChatStore.getState().deleteSession(target) });
			}}
			onClose={(deleted) => {
				setDeleteOpen(false);
				if (!deleted) requestAnimationFrame(() => buttonRef.current?.focus());
			}}
		/>}
	</>;
}
