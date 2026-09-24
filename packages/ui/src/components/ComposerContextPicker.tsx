import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiContextRequest, UiSessionSummary, WorkspaceEntry } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './composerContextPicker.css';

interface ComposerContextPickerProps {
	anchor: HTMLElement;
	trigger: HTMLElement | null;
	mode: 'menu' | 'mention';
	query: string;
	workspace: string;
	sessionPath: string | null;
	onSelect(request: UiContextRequest): void;
	onUpload(): void;
	onClose(restoreFocus?: boolean): void;
}

export interface ComposerContextPickerHandle {
	handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean;
}

type Row =
	| { id: string; kind: 'upload' }
	| { id: string; kind: 'entry'; entry: WorkspaceEntry }
	| { id: string; kind: 'session'; session: UiSessionSummary }
	| { id: string; kind: 'more'; section: 'files' | 'sessions' };
type FileState = { key: string; entries: WorkspaceEntry[]; loading: boolean; error: string | null; truncated: boolean };
const PREVIEW_LIMIT = 8;
const EXPANDED_LIMIT = 80;
const EMPTY_SESSIONS: UiSessionSummary[] = [];

function leaf(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
function title(session: UiSessionSummary, unnamed: string): string {
	return session.name?.trim() || session.firstMessage.trim().split(/\r?\n/)[0] || unnamed;
}
function matches(text: string, query: string): boolean {
	const normalized = text.toLocaleLowerCase();
	return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((part) => normalized.includes(part));
}

/** The + menu and @ suggestions use the same context sources and selection behavior. */
export const ComposerContextPicker = forwardRef<ComposerContextPickerHandle, ComposerContextPickerProps>(function ComposerContextPicker({ anchor, trigger, mode, query, workspace, sessionPath, onSelect, onUpload, onClose }, ref) {
	const { t, locale } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const sessions = useChatStore((state) => state.sessionsByWorkspace[workspace] ?? EMPTY_SESSIONS);
	const [menuQuery, setMenuQuery] = useState('');
	const [directory, setDirectory] = useState('');
	const [mentionBrowseQuery, setMentionBrowseQuery] = useState<string | null>(null);
	const [expandedFiles, setExpandedFiles] = useState(false);
	const [expandedSessions, setExpandedSessions] = useState(false);
	const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
	const [retry, setRetry] = useState(0);
	const [position, setPosition] = useState<CSSProperties | null>(null);
	const [files, setFiles] = useState<FileState>({ key: '', entries: [], loading: false, error: null, truncated: false });
	const panelRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const composingRef = useRef(false);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const id = useId();
	const browsingMention = mode === 'mention' && mentionBrowseQuery === query;
	const search = (mode === 'menu' ? menuQuery : browsingMention ? '' : query).trim();
	const activeDirectory = mode === 'menu' || browsingMention ? directory : '';
	const requestKey = JSON.stringify([workspace, activeDirectory, search]);
	const selectionKey = JSON.stringify([mode, requestKey]);
	const currentFiles = files.key === requestKey ? files.entries : [];
	const loading = Boolean(bridge && workspace && (files.key !== requestKey || files.loading));
	const error = files.key === requestKey ? files.error : null;
	const availableSessions = useMemo(() => sessions
		.filter((session) => !session.archived && session.path !== sessionPath && matches(`${session.name ?? ''}\n${session.firstMessage}`, search))
		.slice().sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)), [sessions, sessionPath, search]);
	const visibleFiles = currentFiles.slice(0, expandedFiles ? EXPANDED_LIMIT : PREVIEW_LIMIT);
	const visibleSessions = availableSessions.slice(0, expandedSessions ? EXPANDED_LIMIT : PREVIEW_LIMIT);
	const fileRows: Row[] = visibleFiles.map((entry) => ({ id: `entry:${entry.path}`, kind: 'entry', entry }));
	const sessionRows: Row[] = visibleSessions.map((session) => ({ id: `session:${session.path}`, kind: 'session', session }));
	if (!expandedFiles && currentFiles.length > PREVIEW_LIMIT) fileRows.push({ id: 'more:files', kind: 'more', section: 'files' });
	if (!expandedSessions && availableSessions.length > PREVIEW_LIMIT) sessionRows.push({ id: 'more:sessions', kind: 'more', section: 'sessions' });
	const showUpload = mode === 'menu' && (!search || matches(t('composer.contextUpload'), search));
	const rows: Row[] = [...(showUpload ? [{ id: 'upload', kind: 'upload' } as const] : []), ...fileRows, ...sessionRows];
	// Keep a user-selected conversation stable when asynchronous file rows appear above it.
	const selectedIndex = Math.max(0, selection?.key === selectionKey ? rows.findIndex((row) => row.id === selection.id) : 0);
	const activeId = rows[selectedIndex]?.id;
	const rowId = (key: string) => `${id}-${encodeURIComponent(key)}`;

	useEffect(() => {
		let cancelled = false;
		setFiles({ key: requestKey, entries: [], loading: Boolean(bridge && workspace), error: null, truncated: false });
		if (!bridge || !workspace) return;
		const timer = setTimeout(() => {
			const request = search ? bridge.searchWorkspaceFiles(search, { includeDirectories: true })
				: bridge.listWorkspaceEntries(activeDirectory).then((entries) => ({ files: entries, truncated: false }));
			void request.then((result) => {
				if (cancelled) return;
				const entries = [...result.files].sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1);
				setFiles({ key: requestKey, entries, loading: false, error: null, truncated: result.truncated });
			}, (reason: unknown) => {
				if (!cancelled) setFiles({ key: requestKey, entries: [], loading: false, error: reason instanceof Error ? reason.message : String(reason), truncated: false });
			});
		}, search ? 120 : 0);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [bridge, workspace, activeDirectory, search, requestKey, retry]);

	useEffect(() => {
		// Browsing may temporarily ignore an @ query, but the next edit returns to search.
		setMentionBrowseQuery(null);
		setDirectory('');
	}, [query, workspace, mode]);

	useEffect(() => {
		setExpandedFiles(false);
		setExpandedSessions(false);
		setSelection(null);
		if (listRef.current) listRef.current.scrollTop = 0;
	}, [requestKey, mode]);

	useEffect(() => {
		if (activeId) document.getElementById(rowId(activeId))?.scrollIntoView({ block: 'nearest' });
	}, [activeId]);

	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const place = () => {
			const rect = anchor.getBoundingClientRect();
			const viewportWidth = document.documentElement.clientWidth;
			const viewportHeight = document.documentElement.clientHeight;
			const chrome = document.querySelector<HTMLElement>('.pd-window-controls')?.getBoundingClientRect();
			const topPadding = chrome?.width && chrome.height ? Math.max(8, chrome.bottom + 8) : 8;
			const above = Math.max(0, rect.top - topPadding - 6);
			const below = Math.max(0, viewportHeight - rect.bottom - 8 - 6);
			// Prefer the space above the composer; a short window can use the lower gap.
			const side = above >= 200 || above >= below ? 'top' : 'bottom';
			const maxHeight = Math.max(0, Math.min(420, side === 'top' ? above : below));
			const width = Math.min(rect.width, Math.max(0, viewportWidth - 16));
			const next: CSSProperties = {
				width,
				maxHeight,
				left: Math.max(8, Math.min(rect.left, viewportWidth - width - 8)),
				...(side === 'top' ? { bottom: viewportHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
			};
			setPosition((current) => current && Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([key, value]) => current[key as keyof CSSProperties] === value) ? current : next);
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(anchor);
		const chrome = document.querySelector<HTMLElement>('.pd-window-controls');
		if (chrome) observer.observe(chrome);
		window.addEventListener('resize', place);
		window.addEventListener('scroll', place, true);
		return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
	}, [anchor]);

	const positioned = position !== null;
	useLayoutEffect(() => {
		if (mode === 'menu' && positioned) inputRef.current?.focus({ preventScroll: true });
	}, [mode, positioned]);

	useEffect(() => {
		window.dispatchEvent(new CustomEvent('pd:hover-tooltip-open', { detail: id }));
		const outside = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Node) || panelRef.current?.contains(target) || trigger?.contains(target)) return;
			// Keep only the mention editor active; choosing another composer control
			// (for example Model) should dismiss this popup instead of stacking menus.
			if (mode === 'mention' && target instanceof HTMLTextAreaElement && anchor.contains(target)) return;
			onCloseRef.current(false);
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('focusin', outside);
		return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
	}, [anchor, trigger, mode, id]);

	// Mention suggestions leave focus in the editor while exposing the active option to AT.
	useLayoutEffect(() => {
		if (mode !== 'mention') return;
		const editor = anchor.querySelector<HTMLTextAreaElement>('textarea');
		if (!editor) return;
		const values: Record<string, string | null> = {};
		for (const [name, value] of Object.entries({ 'aria-controls': `${id}-list`, 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-activedescendant': activeId ? rowId(activeId) : '' })) {
			values[name] = editor.getAttribute(name);
			if (value) editor.setAttribute(name, value);
			else editor.removeAttribute(name);
		}
		return () => {
			for (const [name, value] of Object.entries(values)) {
				if (value === null) editor.removeAttribute(name);
				else editor.setAttribute(name, value);
			}
		};
	}, [anchor, mode, id, activeId]);

	function browse(path: string) {
		setDirectory(path);
		setSelection(null);
		if (mode === 'menu') {
			setMenuQuery('');
			inputRef.current?.focus({ preventScroll: true });
		} else setMentionBrowseQuery(query);
	}
	function goBack() { browse(activeDirectory.split('/').slice(0, -1).join('/')); }
	function select(row: Row) {
		if (row.kind === 'more') {
			if (row.section === 'files') setExpandedFiles(true);
			else setExpandedSessions(true);
			return;
		}
		if (row.kind === 'upload') { onUpload(); return; }
		if (row.kind === 'session') onSelect({ kind: 'session', workspace, path: row.session.path });
		else onSelect({ kind: row.entry.kind, workspace, path: row.entry.path });
	}
	function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): boolean {
		if (event.key === 'Enter' && event.shiftKey) return false;
		if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) {
			// IME confirmation must never reach the composer's send handler.
			if (event.key !== 'Enter' && event.key !== 'Tab') return false;
			event.stopPropagation();
			return true;
		}
		const row = rows[selectedIndex];
		const navigating = event.key === 'ArrowDown' || event.key === 'ArrowUp';
		const selecting = event.key === 'Enter' || event.key === 'Tab';
		const enterDirectory = event.key === 'ArrowRight' && row?.kind === 'entry' && row.entry.kind === 'directory';
		const leaveDirectory = event.key === 'ArrowLeft' && !search && Boolean(activeDirectory);
		if (!navigating && !selecting && !enterDirectory && !leaveDirectory && event.key !== 'Escape') return false;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === 'Escape') onClose(true);
		else if (navigating && rows.length) setSelection({ key: selectionKey, id: rows[(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]!.id });
		else if (enterDirectory) browse(row.entry.path);
		else if (leaveDirectory) goBack();
		else if (selecting && row) select(row);
		return true;
	}
	useImperativeHandle(ref, () => ({ handleKeyDown }));

	function renderRow(row: Row) {
		const active = row.id === activeId;
		const entry = row.kind === 'entry' ? row.entry : null;
		const label = row.kind === 'upload' ? t('composer.contextUpload') : row.kind === 'more' ? t('composer.contextMore') : entry ? entry.name : row.kind === 'session' ? title(row.session, t('sidebar.unnamed')) : '';
		const detail = entry && search ? entry.path : row.kind === 'session' && Number.isFinite(Date.parse(row.session.modified)) ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(row.session.modified)) : '';
		const separator = workspace.includes('\\') ? '\\' : '/';
		const fullPath = entry ? `${workspace.replace(/[\\/]+$/, '')}${separator}${entry.path.replace(/[\\/]/g, separator)}` : undefined;
		// Pointer movement selects a row; layout-driven pointerenter events after a
		// file fetch must not replace a conversation the user already selected.
		return <div className={`pd-context-option-wrap${active ? ' is-active' : ''}`} key={row.id} onPointerMove={() => setSelection({ key: selectionKey, id: row.id })}>
			<HoverTooltip title={label} description={fullPath} align="start" disabled={!entry && row.kind !== 'session'}><button type="button" role="option" id={rowId(row.id)} aria-selected={active} className={`pd-context-option${row.kind === 'more' ? ' is-more' : ''}`} tabIndex={-1} onPointerDown={(event) => event.preventDefault()} onClick={() => select(row)}>
				<Icon name={row.kind === 'upload' ? 'plus' : row.kind === 'more' ? 'chevronRight' : row.kind === 'session' ? 'message' : entry?.kind === 'directory' ? 'folder' : 'file'} width="16" height="16" />
				<span className="pd-context-option-title">{label}</span>
				{detail && <span className="pd-context-option-detail">{detail}</span>}
			</button></HoverTooltip>
			{entry?.kind === 'directory' && <HoverTooltip title={t('composer.contextBrowse')} description={entry.path} align="end"><button type="button" className="pd-context-browse" aria-label={`${t('composer.contextBrowse')} ${entry.name}`} tabIndex={-1} onPointerDown={(event) => event.preventDefault()} onClick={() => browse(entry.path)}><Icon name="chevronRight" width="15" height="15" /></button></HoverTooltip>}
		</div>;
	}

	return createPortal(<div ref={panelRef} className={`pd-context-picker${mode === 'mention' ? ' is-mention' : ''}`} role="dialog" aria-label={t('composer.contextAddTitle')} style={{ ...position, visibility: positioned ? 'visible' : 'hidden' }} onKeyDown={(event) => {
		if (event.target === inputRef.current || event.target === panelRef.current) handleKeyDown(event);
		else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
	}}>
		<div className="pd-context-header">
			{mode === 'menu' ? <><Icon name="search" width="16" height="16" /><input ref={inputRef} className="pd-context-search" value={menuQuery} onChange={(event) => setMenuQuery(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} placeholder={t('composer.contextSearch')} aria-label={t('composer.contextSearch')} role="combobox" aria-controls={`${id}-list`} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeId ? rowId(activeId) : undefined} /></> : <><span className="pd-context-at" aria-hidden="true">@</span><span className="pd-context-heading">{search || t('composer.contextAddTitle')}</span></>}
			<HoverTooltip title={t('window.closeShort')} shortcut="Esc"><button type="button" className="pd-context-close" aria-label={t('window.closeShort')} onPointerDown={(event) => event.preventDefault()} onClick={() => onClose(true)}><Icon name="close" width="15" height="15" /></button></HoverTooltip>
		</div>
		<div ref={listRef} id={`${id}-list`} className="pd-context-list" role="listbox" aria-label={t('composer.contextAddTitle')}>
			{showUpload && renderRow(rows[0]!)}
			<div className="pd-context-section" role="group" aria-labelledby={`${id}-files`}>
				<div className="pd-context-section-title" id={`${id}-files`}><span>{t('composer.contextFiles')}</span><span className="pd-context-workspace">{leaf(workspace)}</span></div>
				{activeDirectory && !search && <button type="button" className="pd-context-back" onPointerDown={(event) => event.preventDefault()} onClick={goBack}><Icon name="chevronRight" width="13" height="13" /><span>{t('composer.contextBack')}</span><span>{activeDirectory}</span></button>}
				{fileRows.map(renderRow)}
				{files.key === requestKey && (files.truncated || expandedFiles && currentFiles.length > EXPANDED_LIMIT) && <div className="pd-context-status">{t('search.truncated')}</div>}
				{loading && <div className="pd-context-status" role="status">{t('composer.contextLoading')}</div>}
				{error && <div className="pd-context-error" role="status"><span>{error}</span><button type="button" onClick={() => setRetry((value) => value + 1)}>{t('composer.contextRetry')}</button></div>}
				{!loading && !error && !fileRows.length && <div className="pd-context-status">{t('composer.contextEmpty')}</div>}
			</div>
			<div className="pd-context-section" role="group" aria-labelledby={`${id}-sessions`}>
				<div className="pd-context-section-title" id={`${id}-sessions`}><span>{t('composer.contextSessions')}</span><span>{t('composer.contextCurrentProject')}</span></div>
				{sessionRows.map(renderRow)}
				{expandedSessions && availableSessions.length > EXPANDED_LIMIT && <div className="pd-context-status">{t('search.truncated')}</div>}
				{!sessionRows.length && <div className="pd-context-status">{t('composer.contextEmpty')}</div>}
			</div>
		</div>
		<div className="pd-context-footer"><span>{t('composer.contextKeyboard')}</span><kbd>↵</kbd><kbd>Tab</kbd></div>
	</div>, document.body);
});
