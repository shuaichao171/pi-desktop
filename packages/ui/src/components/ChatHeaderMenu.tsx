import { useRef, useState } from 'react';
import type { UiMessage, UiSessionMetaPatch } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import { SessionInfoPanel } from './SessionInfoPanel';
import { SessionTreePanel } from './SessionTreePanel';

/**
 * zcode-style ellipsis menu behind the chat title: rename plus the same
 * session toggles the sidebar offers, copy actions, and folder access.
 */
export function ChatHeaderMenu({ title, sessionPath, cwd, onRename, onOpenCommit }: { title: string; sessionPath: string | null; cwd: string; onRename(): void; onOpenCommit(): void }) {
	const { t } = useT();
	const session = useChatStore((s) => (sessionPath ? s.sessions.find((item) => item.path === sessionPath) : undefined));
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [panel, setPanel] = useState<'stats' | 'tree' | null>(null);
	const panelTrigger = useRef<HTMLElement | null>(null);
	const saved = Boolean(sessionPath);

	function close() {
		setAnchor(null);
		setNotice(null);
	}

	function perform(patch: UiSessionMetaPatch) {
		if (!sessionPath) return;
		setNotice(null);
		void updateSessionMeta(sessionPath, patch).catch((cause: unknown) => {
			setNotice(t('chat.menuActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }));
		});
	}

	async function copyText(text: string) {
		setNotice(null);
		try {
			await navigator.clipboard.writeText(text);
			setNotice(t('chat.menuCopied'));
		} catch {
			setNotice(t('chat.menuCopyFailed'));
		}
	}

	function openFolder() {
		const bridge = useChatStore.getState().bridge;
		if (!bridge || !cwd) return;
		setNotice(null);
		void bridge.openWorkspaceFolder(cwd).catch((cause: unknown) => {
			setNotice(t('chat.openWorkspaceFolderError', { message: cause instanceof Error ? cause.message : String(cause) }));
		});
	}

	function openInVsCode() {
		const bridge = useChatStore.getState().bridge;
		if (!bridge || !cwd) return;
		setNotice(null);
		void bridge.openWorkspaceInVsCode(cwd).catch((cause: unknown) => {
			setNotice(t('chat.openInVsCodeError', { message: cause instanceof Error ? cause.message : String(cause) }));
		});
	}

	const item = (label: string, action: () => void, disabled = false) => (
		<button type="button" role="menuitem" disabled={disabled} onClick={() => { if (disabled) return; action(); }}>{label}</button>
	);


	function openPanel(kind: 'stats' | 'tree') {
		panelTrigger.current = anchor;
		close();
		setPanel(kind);
	}

	async function exportAs(format: 'html' | 'jsonl') {
		const bridge = useChatStore.getState().bridge;
		if (!bridge) return;
		setNotice(null);
		try {
			const exported = await bridge.exportSession(format);
			setNotice(exported ? t('chat.export.done', { path: exported }) : null);
		} catch (cause: unknown) {
			setNotice(t('chat.export.failed', { message: cause instanceof Error ? cause.message : String(cause) }));
		}
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
		<button type="button" className="pd-icon-button pd-chat-header-more" aria-label={t('chat.menuLabel')} aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={(event) => { setNotice(null); setAnchor(event.currentTarget); }}><Icon name="more" width="15" height="15" /></button>
		{anchor && <SidebarPopover anchor={anchor} label={t('chat.menuLabel')} onClose={close}>
			{item(t('sidebar.rename'), () => { close(); onRename(); }, !saved)}
			{item(t(session?.pinned ? 'sidebar.unpin' : 'sidebar.pin'), () => perform({ pinned: !session?.pinned }), !saved)}
			{item(t(session?.unread ? 'sidebar.markRead' : 'sidebar.markUnread'), () => perform({ unread: !session?.unread }), !saved)}
			{item(t(session?.archived ? 'sidebar.unarchive' : 'sidebar.archive'), () => perform({ archived: !session?.archived }), !saved)}
			<hr />
			{item(t('chat.menuCopyTitle'), () => { void copyText(title); })}
			{item(t('chat.menuCopyPath'), () => { if (sessionPath) void copyText(sessionPath); }, !saved)}
			<hr />
			{item(t('chat.stats.menuEntry'), () => openPanel('stats'))}
			{item(t('chat.tree.menuEntry'), () => openPanel('tree'))}
			{item(t('chat.menuCopyMarkdown'), () => copyConversationMarkdown())}
			{item(t('chat.menuExportHtml'), () => void exportAs('html'))}
			{item(t('chat.menuExportJsonl'), () => void exportAs('jsonl'))}
			<hr />
			{item(t('chat.menuOpenWorkspace'), () => { close(); openFolder(); }, !cwd)}
			{item(t('chat.menuOpenInVsCode'), () => { close(); openInVsCode(); }, !cwd)}
			{item(t('chat.menuCommit'), () => { close(); onOpenCommit(); }, !cwd)}
			{notice && <p className="pd-sidebar-menu-note">{notice}</p>}
		</SidebarPopover>}
		{panel === 'stats' && <SessionInfoPanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
		{panel === 'tree' && <SessionTreePanel returnFocus={panelTrigger.current} onClose={() => setPanel(null)} />}
	</>;
}
