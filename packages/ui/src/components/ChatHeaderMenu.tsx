import { useEffect, useRef, useState } from 'react';
import type { UiMessage, UiSessionMetaPatch } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import { HoverTooltip } from './HoverTooltip';
import { SessionInfoPanel } from './SessionInfoPanel';
import { SessionTreePanel } from './SessionTreePanel';
import { MemoryPanel } from './MemoryPanel';
import { runWithFeedback } from '../operationFeedback';
import { isConversationWorkspace } from '../sidebarOrganization';

/**
 * zcode-style ellipsis menu behind the chat title: rename plus the same
 * session toggles the sidebar offers, copy actions, and folder access.
 */
export function ChatHeaderMenu({ title, sessionPath, cwd, onRename, onOpenCommit }: { title: string; sessionPath: string | null; cwd: string; onRename(): void; onOpenCommit(): void }) {
	const { t } = useT();
	const session = useChatStore((s) => (sessionPath ? s.sessions.find((item) => item.path === sessionPath) : undefined));
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const conversationWorkspaces = useChatStore((s) => s.conversationWorkspaces);
	const folderLabel = t(isConversationWorkspace(cwd, conversationWorkspaces) ? 'chat.openConversationFolder' : 'chat.menuOpenWorkspace');
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [panel, setPanel] = useState<'stats' | 'tree' | 'memory' | null>(null);
	const panelTrigger = useRef<HTMLElement | null>(null);
	const saved = Boolean(sessionPath);

	// [喵喵喵]: 记忆入口的锁定判定 — Magic Context 插件未安装/未启用/库未就绪时灰色
	// 锁定，tooltip 说明原因（插件安装本身走设置面板，不在此处发起）。
	// 挂载初查 + 每次打开菜单重查（插件装好后无需重启即解锁）；重查期间保留
	// 上次状态而非强制归零，避免打开菜单时条目先灰后亮的闪烁。
	const bridge = useChatStore((s) => s.bridge);
	const [memoryReady, setMemoryReady] = useState(false);
	const [memoryLockReason, setMemoryLockReason] = useState('');
	useEffect(() => {
		if (!bridge || !cwd) return;
		let active = true;
		void bridge.getMemoryAvailability(cwd)
			.then((value) => {
				if (!active) return;
				if (value.pluginReady && value.databaseReady) {
					setMemoryReady(true);
					setMemoryLockReason('');
				} else {
					setMemoryReady(false);
					setMemoryLockReason(value.reason === 'pluginMissing' ? t('memory.lock.pluginMissing')
						: value.reason === 'pluginDisabled' ? t('memory.lock.pluginDisabled')
							: value.reason === 'dbMissing' ? t('memory.lock.dbMissing')
								: t('memory.unavailable.dbSchema'));
				}
			})
			.catch(() => { if (active) setMemoryLockReason(t('memory.lock.dbMissing')); });
		return () => { active = false; };
	}, [bridge, cwd, t, anchor]);

	function close() {
		setAnchor(null);
		setNotice(null);
	}

	function perform(patch: UiSessionMetaPatch) {
		if (!sessionPath) return;
		const target = sessionPath;
		void runWithFeedback({ id: `session-meta:${target}`, title: title, run: () => updateSessionMeta(target, patch) });
	}

	async function copyText(text: string) {
		await runWithFeedback({ id: `copy:${sessionPath ?? cwd}`, title: t('chat.menuCopyTitle'), run: () => navigator.clipboard.writeText(text), success: t('chat.menuCopied') });
	}

	function openFolder() {
		const bridge = useChatStore.getState().bridge;
		if (!bridge || !cwd) return;
		const target = cwd;
		void runWithFeedback({ id: `open-folder:${target}`, title: folderLabel, run: () => bridge.openWorkspaceFolder(target) });
	}

	function openInVsCode() {
		const bridge = useChatStore.getState().bridge;
		if (!bridge || !cwd) return;
		const target = cwd;
		void runWithFeedback({ id: `open-editor:${target}`, title: t('chat.menuOpenInVsCode'), run: () => bridge.openWorkspaceInVsCode(target) });
	}

	const item = (label: string, action: () => void, disabled = false) => (
		<button type="button" role="menuitem" disabled={disabled} onClick={() => { if (disabled) return; action(); }}>{label}</button>
	);


	function openPanel(kind: 'stats' | 'tree' | 'memory') {
		panelTrigger.current = anchor;
		close();
		setPanel(kind);
	}

	async function exportAs(format: 'html' | 'jsonl') {
		const bridge = useChatStore.getState().bridge;
		if (!bridge) return;
		const origin = { cwd, sessionPath, sessionId: useChatStore.getState().sessionId };
		await runWithFeedback({ id: `export:${origin.cwd}:${origin.sessionPath ?? origin.sessionId}:${format}`, title: t(format === 'html' ? 'chat.menuExportHtml' : 'chat.menuExportJsonl'), run: async () => {
			const current = useChatStore.getState();
			if (current.cwd !== origin.cwd || current.sessionPath !== origin.sessionPath || current.sessionId !== origin.sessionId) throw new Error(t('chat.exportReturnToSession'));
			return bridge.exportSession(format);
		}, success: result => typeof result === 'string' && result ? t('chat.export.done', { path: result }) : null });
	}

	function copyConversationMarkdown() {
		const messages = useChatStore.getState().messages as UiMessage[];
		if (messages.length === 0) { setNotice(t('chat.export.empty')); return; }
		const body = messages.map((message) => {
			if (message.role === 'system') return `> **${message.systemKind ?? 'system'}**\n>\n${message.text.split(/\r?\n/).map((line) => `> ${line}`).join('\n')}`;
			const heading = message.role === 'user' ? t('chat.export.userHeading') : t('chat.export.assistantHeading');
			return `## ${heading}\n\n${message.text}`;
		}).join('\n\n---\n\n');
		void copyText(body);
	}

	return <>
		<HoverTooltip title={t('chat.menuLabel')}><button type="button" className="pd-icon-button pd-chat-header-more pd-top-bar-menu" aria-label={t('chat.menuLabel')} aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={(event) => { setNotice(null); setAnchor(event.currentTarget); }}><Icon name="more" width="16" height="16" /></button></HoverTooltip>
		{anchor && <SidebarPopover anchor={anchor} label={t('chat.menuLabel')} onClose={close}>
			{item(t('sidebar.rename'), () => { close(); onRename(); }, !saved)}
			{item(t(session?.pinned ? 'sidebar.unpin' : 'sidebar.pin'), () => perform({ pinned: !session?.pinned }), !saved)}
			{item(t(session?.unread ? 'sidebar.markRead' : 'sidebar.markUnread'), () => perform(session?.unread ? { unread: false, expectedUnreadAt: session.unreadAt } : { unread: true }), !saved)}
			{item(t(session?.archived ? 'sidebar.unarchive' : 'sidebar.archive'), () => perform({ archived: !session?.archived }), !saved)}
			<hr />
			{item(t('chat.menuCopyTitle'), () => { void copyText(title); })}
			{item(t('chat.menuCopyPath'), () => { if (sessionPath) void copyText(sessionPath); }, !saved)}
			<hr />
			{item(t('chat.stats.menuEntry'), () => openPanel('stats'))}
			{item(t('chat.tree.menuEntry'), () => openPanel('tree'))}
			{item(t('memory.menuEntry'), () => openPanel('memory'), !memoryReady)}
			{!memoryReady && memoryLockReason && <p className="pd-sidebar-menu-note">{memoryLockReason}</p>}
			{item(t('chat.menuCopyMarkdown'), () => copyConversationMarkdown())}
			{item(t('chat.menuExportHtml'), () => void exportAs('html'))}
			{item(t('chat.menuExportJsonl'), () => void exportAs('jsonl'))}
			<hr />
			{item(folderLabel, () => { close(); openFolder(); }, !cwd)}
			{item(t('chat.menuOpenInVsCode'), () => { close(); openInVsCode(); }, !cwd)}
			{item(t('chat.menuCommit'), () => { close(); onOpenCommit(); }, !cwd)}
			{notice && <p className="pd-sidebar-menu-note">{notice}</p>}
		</SidebarPopover>}
		{panel === 'stats' && <SessionInfoPanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
		{panel === 'tree' && <SessionTreePanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
		{panel === 'memory' && <MemoryPanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
	</>;
}
