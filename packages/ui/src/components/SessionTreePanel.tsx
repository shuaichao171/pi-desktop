import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiSessionTreeNode } from '@pidesktop/shared';
import { useT } from '../i18n';
import { selectBusy, useChatStore } from '../store';
import { Icon } from './Icons';

const KIND_ICON: Record<UiSessionTreeNode['kind'], Parameters<typeof Icon>[0]['name']> = {
	user: 'message', assistant: 'file', tool: 'terminal', compaction: 'archive', 'branch-summary': 'gitBranch', custom: 'hash', other: 'more',
};

function TreeRow({ node, depth, busy, switchingId, onSwitch }: { node: UiSessionTreeNode; depth: number; busy: boolean; switchingId: string | null; onSwitch(node: UiSessionTreeNode): void }) {
	const { t } = useT();
	return (
		<li role="none">
			<button
				type="button"
				role="treeitem"
				aria-selected={node.active}
				aria-expanded={node.children.length > 0 || undefined}
				className={'pd-session-tree-row' + (node.active ? ' is-active' : '')}
				style={{ paddingInlineStart: 10 + depth * 18 }}
				disabled={busy || node.active}
				title={node.label}
				onClick={() => onSwitch(node)}
			>
				<Icon name={KIND_ICON[node.kind]} width="13" height="13" />
				<span className="pd-session-tree-label">{node.label || '…'}</span>
				{node.childCount > 1 && <span className="pd-session-tree-branches" aria-label={t('chat.tree.branches', { count: node.childCount })}>{node.childCount}</span>}
				{node.active && <span className="pd-session-tree-current">{t('chat.tree.current')}</span>}
				{switchingId === node.id && <span className="pd-session-tree-switching" role="status">{t('chat.tree.switching')}</span>}
			</button>
			{node.children.length > 0 && (
				<ul role="group">
					{node.children.map((child) => <TreeRow key={child.id} node={child} depth={depth + 1} busy={busy} switchingId={switchingId} onSwitch={onSwitch} />)}
				</ul>
			)}
		</li>
	);
}

/** Session entry tree: inspect branches and move the visible leaf onto another entry. */
export function SessionTreePanel({ returnFocus, onClose }: { returnFocus: HTMLElement | null; onClose(): void }) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const sessionId = useChatStore((s) => s.sessionId);
	const busy = useChatStore(selectBusy);
	const [nodes, setNodes] = useState<UiSessionTreeNode[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [switchingId, setSwitchingId] = useState<string | null>(null);
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const load = useCallback(() => {
		if (!bridge) return;
		setError(null);
		void bridge.getSessionTree()
			.then((value) => setNodes(value))
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, [bridge]);
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
			const anotherDialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((element) => element !== dialog);
			if (!anotherDialog && returnFocus?.isConnected && returnFocus.getClientRects().length > 0 && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
		};
	}, [returnFocus]);
	useEffect(() => { setNodes(null); load(); }, [load, sessionId]);
	async function switchTo(node: UiSessionTreeNode) {
		if (!bridge || busy || node.active || switchingId) return;
		setSwitchingId(node.id);
		setError(null);
		try {
			await bridge.switchSessionBranch(node.id);
			load();
		} catch (cause: unknown) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSwitchingId(null);
		}
	}
	return createPortal(<dialog ref={ref} className="pd-session-tree" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
		<header className="pd-session-tree-header">
			<h2 id={titleId}>{t('chat.tree.title')}</h2>
			<button type="button" className="pd-icon-button" aria-label={t('settings.close')} onClick={onClose} autoFocus><Icon name="close" width="18" height="18" /></button>
		</header>
		<p className="pd-session-tree-hint">{t('chat.tree.hint')}</p>
		{busy && <p className="pd-session-tree-error" role="status">{t('chat.tree.busy')}</p>}
		{error && <p className="pd-session-tree-error" role="alert">{t('chat.tree.failed', { message: error })}</p>}
		<div className="pd-session-tree-body">
			{nodes === null
				? (!error && <p className="pd-session-tree-empty" role="status">{t('chat.tree.loading')}</p>)
				: nodes.length > 0
					? <ul role="tree">
						{nodes.map((node) => <TreeRow key={node.id} node={node} depth={0} busy={busy} switchingId={switchingId} onSwitch={switchTo} />)}
					</ul>
					: <p className="pd-session-tree-empty">{t('chat.tree.empty')}</p>}
		</div>
	</dialog>, document.body);
}
