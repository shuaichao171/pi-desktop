import { useRef, useState } from 'react';
import type { UiMessage, UiSessionMetaPatch } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import { SessionInfoPanel } from './SessionInfoPanel';
import { SessionTreePanel } from './SessionTreePanel';
import { runWithFeedback } from '../operationFeedback';

/**
 * zcode-style ellipsis menu behind the chat title: rename plus the same
 * session toggles the sidebar offers, copy actions, and folder access.
 */
export function ChatHeaderMenu({ title, sessionPath, cwd, onRename, onOpenCommit }: { title: string; sessionPath: string | null; cwd: string; onRename(): void; onOpenCommit(): void }) {
	const { t, locale } = useT();
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
		void runWithFeedback({ id: `open-folder:${target}`, title: t('chat.menuOpenWorkspace'), run: () => bridge.openWorkspaceFolder(target) });
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


	function openPanel(kind: 'stats' | 'tree') {
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
			if (current.cwd !== origin.cwd || current.sessionPath !== origin.sessionPath || current.sessionId !== origin.sessionId) throw new Error(locale === 'zh-CN' ? '请返回原会话后重试导出。' : 'Return to the original session before retrying the export.');
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
