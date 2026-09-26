import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiSessionTreeNode } from '@pidesktop/shared';
import { useT } from '../i18n';
import { selectBusy, useChatStore } from '../store';
import { Icon } from './Icons';
import { useConversationCopy } from '../conversationCopy';
import { currentTreeLeaf, flattenTree } from '../sessionTree';

const KIND_ICON: Record<UiSessionTreeNode['kind'], Parameters<typeof Icon>[0]['name']> = { user: 'message', assistant: 'file', tool: 'terminal', compaction: 'archive', 'branch-summary': 'gitBranch', custom: 'hash', other: 'more' };
const KIND_LABEL = { user: 'treeUser', assistant: 'treeAssistant', tool: 'treeTool', compaction: 'treeCompaction', 'branch-summary': 'treeBranchSummary', custom: 'treeCustom', other: 'treeOther' } as const;
type TreeError = { kind: 'load'; message: string } | { kind: 'switch'; message: string; targetId: string };

/** Selecting is read-only. Branch mutation is confined to explicit confirmation. */
export function SessionTreePanel({ returnFocus, onClose }: { returnFocus: HTMLElement | null; onClose(): void }) {
	const { t, locale } = useT(); const c = useConversationCopy();
	const bridge = useChatStore((s) => s.bridge), sessionId = useChatStore((s) => s.sessionId), busy = useChatStore(selectBusy);
	const [nodes, setNodes] = useState<UiSessionTreeNode[] | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [error, setError] = useState<TreeError | null>(null), [switchingId, setSwitchingId] = useState<string | null>(null);
	const selectedRef = useRef<string | null>(null);
	const ref = useRef<HTMLDialogElement>(null), request = useRef(0), pending = useRef(false); const titleId = useId();
	const all = useMemo(() => flattenTree(nodes ?? []), [nodes]);
	const visible = useMemo(() => flattenTree(nodes ?? [], expanded), [nodes, expanded]);
	const leaf = currentTreeLeaf(nodes ?? []), selected = all.find(({ node }) => node.id === selectedId)?.node;
	const select = useCallback((id: string | null) => { selectedRef.current = id; setSelectedId(id); setError((current) => current?.kind === 'switch' && current.targetId !== id ? null : current); }, []);
	const load = useCallback(async () => {
		if (!bridge) return; const token = ++request.current; setError(null);
		try { const value = await bridge.getSessionTree(); if (token !== request.current) return; setNodes(value); setExpanded((old) => new Set([...old, ...flattenTree(value).filter(({ node }) => node.active).map(({ node }) => node.id)])); select(currentTreeLeaf(value)?.id ?? value[0]?.id ?? null); }
		catch (cause) { if (token === request.current) setError({ kind: 'load', message: cause instanceof Error ? cause.message : String(cause) }); }
	}, [bridge, select]);
	useEffect(() => {
		const dialog = ref.current; dialog?.showModal();
		return () => { request.current++; dialog?.close(); if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true }); };
	}, [returnFocus]);
	useEffect(() => { setNodes(null); setExpanded(new Set()); void load(); return () => { request.current++; }; }, [load, sessionId]);
	const focus = (id: string | undefined) => { if (!id) return; select(id); requestAnimationFrame(() => { const row = ref.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`); row?.focus(); row?.scrollIntoView({ block: 'nearest' }); }); };
	const toggle = (id: string, open: boolean) => setExpanded((old) => { const next = new Set(old); if (open) next.add(id); else next.delete(id); return next; });
	const locate = () => { setExpanded((old) => new Set([...old, ...all.filter(({ node }) => node.active).map(({ node }) => node.id)])); focus(leaf?.id); };
	async function switchTo(targetId = selectedId) {
		if (!bridge || busy || !targetId || targetId !== selectedRef.current || targetId === leaf?.id || !all.some(({ node }) => node.id === targetId) || pending.current) return;
		const token = request.current; pending.current = true; setSwitchingId(targetId); setError(null);
		try { await bridge.switchSessionBranch(targetId); if (token === request.current) { await load(); focus(targetId); } }
		catch (cause) { if (token === request.current && selectedRef.current === targetId) setError({ kind: 'switch', targetId, message: cause instanceof Error ? cause.message : String(cause) }); }
		finally { pending.current = false; setSwitchingId(null); }
	}
	return createPortal(<dialog ref={ref} className="pd-session-tree" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!pending.current) onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
		<header className="pd-session-tree-header"><h2 id={titleId}>{t('chat.tree.title')}</h2><button type="button" className="pd-icon-button" aria-label={t('settings.close')} onClick={onClose} disabled={Boolean(switchingId)} autoFocus><Icon name="close" width="18" height="18" /></button></header>
		<p className="pd-session-tree-hint">{c('treeHint')}</p><button type="button" className="pd-tree-locate" onClick={locate} disabled={!leaf}>{c('locateLeaf')}</button>
		{busy && <p className="pd-session-tree-error" role="status">{t('chat.tree.busy')}</p>}{error && <p className="pd-session-tree-error" role="alert">{t('chat.tree.failed', { message: error.message })}<button type="button" disabled={Boolean(switchingId) || (error.kind === 'switch' && (busy || selectedId !== error.targetId))} onClick={() => void (error.kind === 'switch' ? switchTo(error.targetId) : load())}>{c('retry')}</button></p>}
		<div className="pd-session-tree-body">{nodes === null ? (!error && <p className="pd-session-tree-empty" role="status">{t('chat.tree.loading')}</p>) : !nodes.length ? <p className="pd-session-tree-empty">{t('chat.tree.empty')}</p> : <ul role="tree" aria-label={t('chat.tree.title')}>{visible.map(({ node, depth, parentId, position, siblings }, index) => <li role="none" key={node.id}><button type="button" role="treeitem" data-tree-id={node.id} tabIndex={selectedId === node.id || (!selectedId && index === 0) ? 0 : -1} aria-level={depth + 1} aria-posinset={position} aria-setsize={siblings} aria-selected={selectedId === node.id} aria-current={node.id === leaf?.id ? 'true' : undefined} aria-expanded={node.children.length ? expanded.has(node.id) : undefined} className={`pd-session-tree-row${node.active ? ' is-active' : ''}${selectedId === node.id ? ' is-selected' : ''}`} style={{ paddingInlineStart: 10 + Math.min(depth, 12) * 12 }} onClick={() => select(node.id)} onFocus={() => select(node.id)} onKeyDown={(event) => {
			if (event.nativeEvent.isComposing) return;
			if (event.key === 'ArrowDown') { event.preventDefault(); focus(visible[Math.min(index + 1, visible.length - 1)]?.node.id); }
			if (event.key === 'ArrowUp') { event.preventDefault(); focus(visible[Math.max(index - 1, 0)]?.node.id); }
			if (event.key === 'Home') { event.preventDefault(); focus(visible[0]?.node.id); }
			if (event.key === 'End') { event.preventDefault(); focus(visible.at(-1)?.node.id); }
			if (event.key === 'ArrowRight') { event.preventDefault(); if (!expanded.has(node.id)) toggle(node.id, true); else focus(node.children[0]?.id); }
			if (event.key === 'ArrowLeft') { event.preventDefault(); if (node.children.length && expanded.has(node.id)) toggle(node.id, false); else focus(parentId ?? undefined); }
		}}><span className="pd-tree-disclosure" onClick={(event) => { if (node.children.length) { event.stopPropagation(); select(node.id); toggle(node.id, !expanded.has(node.id)); } }}>{node.children.length ? <Icon name={expanded.has(node.id) ? 'chevronDown' : 'chevronRight'} width="13" height="13" /> : null}</span><Icon name={KIND_ICON[node.kind]} width="13" height="13" /><span className="pd-session-tree-label">{node.label || '…'}</span>{node.active && <span className="pd-session-tree-current">{c(node.id === leaf?.id ? 'currentNode' : 'currentPath')}</span>}</button></li>)}</ul>}</div>
		<section className="pd-tree-inspector" aria-live="polite">{selected ? <><strong>{c(KIND_LABEL[selected.kind])}</strong>{selected.timestamp && <time>{new Date(selected.timestamp).toLocaleString(locale)}</time>}<p>{selected.label}</p><small>{c('summaryOnly')}</small><button type="button" disabled={busy || Boolean(switchingId) || selected.id === leaf?.id} onClick={() => void switchTo()}>{switchingId ? t('chat.tree.switching') : c('switchNode')}</button></> : <p>{c('noSelection')}</p>}</section>
	</dialog>, document.body);
}
