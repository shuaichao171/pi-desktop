import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiSessionSearchResult, WorkspaceEntry } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { SegmentedIndicator } from './SegmentedIndicator';
import './searchDialog.css';

export interface SearchCommand {
	id: string;
	label: string;
	keywords?: string;
	icon?: ComponentProps<typeof Icon>['name'];
	shortcut?: string;
	run(): void | Promise<void>;
}

interface SearchDialogProps {
	commands: SearchCommand[];
	onClose(): void;
	onSelectSession(result: UiSessionSearchResult): Promise<void>;
	onSelectFile(entry: WorkspaceEntry): void;
}

type Scope = 'all' | 'commands' | 'sessions' | 'files';
type ResultScope = Exclude<Scope, 'all'>;
type SearchState<T> = { key: string; items: T[]; loading: boolean; truncated: boolean; error: string | null };
type SearchRow =
	| { id: string; kind: 'command'; command: SearchCommand }
	| { id: string; kind: 'session'; session: UiSessionSearchResult }
	| { id: string; kind: 'file'; file: WorkspaceEntry }
	| { id: string; kind: 'more'; scope: ResultScope };
type ResultGroup = { scope: ResultScope; rows: SearchRow[] };

const SCOPES: Scope[] = ['all', 'commands', 'sessions', 'files'];
const PREFIXES: Record<ResultScope, string> = { commands: '>', sessions: '#', files: '@' };
const SECTION_LIMIT = 3;

function parseQuery(raw: string, selectedScope: Scope): { query: string; scope: Scope } {
	const trimmed = raw.trimStart();
	const scope = (Object.keys(PREFIXES) as ResultScope[]).find((value) => PREFIXES[value] === trimmed[0]);
	return scope ? { query: trimmed.slice(1).trim(), scope } : { query: raw.trim(), scope: selectedScope };
}

function pathLeaf(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Literal matching avoids treating user input as a regular expression or HTML. */
function Highlight({ text, query }: { text: string; query: string }) {
	const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return <>{text}</>;
	const normalized = text.toLocaleLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const term of terms) {
		let offset = 0;
		while (offset < normalized.length) {
			const index = normalized.indexOf(term, offset);
			if (index < 0) break;
			ranges.push([index, index + term.length]);
			offset = index + term.length;
		}
	}
	const merged: Array<[number, number]> = [];
	for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	const parts: ReactNode[] = [];
	let offset = 0;
	for (const [start, end] of merged) {
		parts.push(text.slice(offset, start), <mark key={start}>{text.slice(start, end)}</mark>);
		offset = end;
	}
	parts.push(text.slice(offset));
	return <>{parts}</>;
}

export function SearchDialog({ commands, onClose, onSelectSession, onSelectFile }: SearchDialogProps) {
	const { t, locale } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const [rawQuery, setRawQuery] = useState('');
	const [selectedScope, setSelectedScope] = useState<Scope>('all');
	const { query, scope } = parseQuery(rawQuery, selectedScope);
	const requestKey = JSON.stringify([query, scope, cwd]);
	const [sessions, setSessions] = useState<SearchState<UiSessionSearchResult>>({ key: '', items: [], loading: false, truncated: false, error: null });
	const [files, setFiles] = useState<SearchState<WorkspaceEntry>>({ key: '', items: [], loading: false, truncated: false, error: null });
	const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	const busyRef = useRef(false);
	const mountedRef = useRef(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const composingRef = useRef(false);
	const id = useId();
	const wantSessions = scope === 'all' || scope === 'sessions';
	const wantFiles = Boolean(cwd && query && (scope === 'all' || scope === 'files'));
	const currentSessions = sessions.key === requestKey ? sessions.items : [];
	const currentFiles = files.key === requestKey ? files.items : [];
	const sessionLoading = Boolean(bridge && wantSessions && (sessions.key !== requestKey || sessions.loading));
	const fileLoading = Boolean(bridge && wantFiles && (files.key !== requestKey || files.loading));
	const sessionError = sessions.key === requestKey && wantSessions ? sessions.error : null;
	const fileError = files.key === requestKey && wantFiles ? files.error : null;
	const loading = sessionLoading || fileLoading;
	const sessionTruncated = sessions.key === requestKey && sessions.truncated;
	const fileTruncated = files.key === requestKey && files.truncated;

	useLayoutEffect(() => {
		mountedRef.current = true;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		window.dispatchEvent(new CustomEvent('pd:hover-tooltip-open', { detail: id }));
		inputRef.current?.focus();
		const containFocus = (event: FocusEvent) => {
			if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) inputRef.current?.focus();
		};
		document.addEventListener('focusin', containFocus);
		return () => {
			mountedRef.current = false;
			document.removeEventListener('focusin', containFocus);
			const active = document.activeElement;
			const focusStillInside = active === document.body || (active instanceof Node && dialogRef.current?.contains(active));
			const nextDialog = Array.from(document.querySelectorAll('[role="dialog"]')).some((element) => element !== dialogRef.current);
			// A command may open Settings. Let its focus effect take ownership.
			if (focusStillInside && !nextDialog && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		setSessions({ key: requestKey, items: [], loading: Boolean(bridge && wantSessions), truncated: false, error: null });
		setFiles({ key: requestKey, items: [], loading: Boolean(bridge && wantFiles), truncated: false, error: null });
		if (!bridge) return;
		const timer = setTimeout(() => {
			if (wantSessions) void bridge.searchSessions(query).then((result) => {
				if (!cancelled) setSessions({ key: requestKey, items: result.sessions, loading: false, truncated: result.truncated, error: null });
			}, (error: unknown) => {
				if (!cancelled) setSessions({ key: requestKey, items: [], loading: false, truncated: false, error: errorMessage(error) });
			});
			if (wantFiles) void bridge.searchWorkspaceFiles(query).then((result) => {
				if (!cancelled) setFiles({ key: requestKey, items: result.files, loading: false, truncated: result.truncated, error: null });
			}, (error: unknown) => {
				if (!cancelled) setFiles({ key: requestKey, items: [], loading: false, truncated: false, error: errorMessage(error) });
			});
		}, query ? 150 : 0);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [bridge, requestKey, query, wantSessions, wantFiles, retry]);

	const filteredCommands = useMemo(() => {
		const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
		return commands.filter((command) => {
			const haystack = `${command.label} ${command.keywords ?? ''}`.toLocaleLowerCase();
			return terms.every((term) => haystack.includes(term));
		});
	}, [commands, query]);
	const groups: ResultGroup[] = [];
	const addGroup = (groupScope: ResultScope, rows: SearchRow[], truncated = false) => {
		if (scope !== 'all' && scope !== groupScope) return;
		const visible = scope === 'all' ? rows.slice(0, SECTION_LIMIT) : rows;
		if (!visible.length) return;
		if (scope === 'all' && (rows.length > SECTION_LIMIT || truncated)) visible.push({ id: `more:${groupScope}`, kind: 'more', scope: groupScope });
		groups.push({ scope: groupScope, rows: visible });
	};
	addGroup('commands', filteredCommands.map((command) => ({ id: `command:${command.id}`, kind: 'command', command })));
	addGroup('sessions', currentSessions.map((session) => ({ id: `session:${session.path}`, kind: 'session', session })), sessionTruncated);
	addGroup('files', currentFiles.map((file) => ({ id: `file:${file.path}`, kind: 'file', file })), fileTruncated);
	const rows = groups.flatMap((group) => group.rows);
	// Session and file results arrive independently. Keep the chosen result even
	// when another section inserts rows above it while the user is navigating.
	const selectedIndex = Math.max(0, selection?.key === requestKey ? rows.findIndex((row) => row.id === selection.id) : 0);
	const activeId = rows[selectedIndex]?.id;
	const rowDomId = (rowId: string) => `${id}-result-${encodeURIComponent(rowId)}`;

	useEffect(() => { setSelection(null); setActionError(null); if (listRef.current) listRef.current.scrollTop = 0; }, [requestKey]);
	useEffect(() => {
		if (activeId) document.getElementById(rowDomId(activeId))?.scrollIntoView({ block: 'nearest' });
	}, [activeId]);

	const chooseScope = (next: Scope) => {
		if (busyRef.current) return;
		setSelectedScope(next);
		setRawQuery(query);
		inputRef.current?.focus();
	};
	const activate = async (row: SearchRow) => {
		if (busyRef.current) return;
		if (row.kind === 'more') { chooseScope(row.scope); return; }
		busyRef.current = true;
		setPending(true);
		setActionError(null);
		try {
			if (row.kind === 'command') await row.command.run();
			else if (row.kind === 'session') await onSelectSession(row.session);
			else onSelectFile(row.file);
			if (mountedRef.current) onClose();
		} catch (error) {
			if (mountedRef.current) setActionError(errorMessage(error));
		} finally {
			busyRef.current = false;
			if (mountedRef.current) setPending(false);
		}
	};
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// Stop application shortcuts behind the modal, including the global Escape handler.
		event.stopPropagation();
		if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
		if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
		if (event.key === 'Tab') {
			const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
			return;
		}
		if (pending) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (rows.length) {
				const next = rows[(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]!;
				setSelection({ key: requestKey, id: next.id });
			}
			inputRef.current?.focus();
		} else if (event.key === 'Enter' && document.activeElement === inputRef.current && rows[selectedIndex]) {
			event.preventDefault();
			void activate(rows[selectedIndex]);
		}
	};
	const resultLabel = (groupScope: ResultScope) => !query && groupScope !== 'files' ? t(`search.recent.${groupScope}`) : t(`search.scope.${groupScope}`);
	const formatDate = (value: string) => {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
	};
	const renderRow = (row: SearchRow) => {
		const selected = activeId === row.id;
		let body: ReactNode;
		if (row.kind === 'more') body = <><Icon name="more" /><span className="pd-search-result-copy">{t('search.showAll', { scope: t(`search.scope.${row.scope}`) })}</span><Icon name="chevronRight" /></>;
		else if (row.kind === 'command') body = <><Icon name={row.command.icon ?? 'spark'} /><span className="pd-search-result-copy"><span className="pd-search-result-title"><Highlight text={row.command.label} query={query} /></span></span>{row.command.shortcut && <kbd>{row.command.shortcut}</kbd>}</>;
		else if (row.kind === 'file') body = <><Icon name="file" /><span className="pd-search-result-copy"><span className="pd-search-result-title"><Highlight text={row.file.name} query={query} /></span><span className="pd-search-result-meta"><span><Highlight text={row.file.path} query={query} /></span></span></span></>;
		else {
			const session = row.session;
			const title = session.name?.trim() || session.firstMessage.trim().split(/\r?\n/)[0] || t('sidebar.unnamed');
			body = <><Icon name="message" /><span className="pd-search-result-copy"><span className="pd-search-result-title"><Highlight text={title} query={query} /></span>{session.snippet && <span className="pd-search-result-snippet"><Highlight text={session.snippet} query={query} /></span>}<span className="pd-search-result-meta"><span>{pathLeaf(session.cwd)}</span>{session.archived && <span className="pd-search-archive-label">{t('sidebar.archived')}</span>}<time dateTime={session.modified}>{formatDate(session.modified)}</time></span></span></>;
		}
		return <div key={row.id} id={rowDomId(row.id)} role="option" aria-selected={selected} aria-disabled={pending || undefined} className={`pd-search-result${selected ? ' is-selected' : ''}${row.kind === 'more' ? ' is-more' : ''}`} onPointerMove={() => { if (!pending) setSelection({ key: requestKey, id: row.id }); }} onPointerDown={(event) => event.preventDefault()} onClick={() => { void activate(row); }}>{body}</div>;
	};

	return createPortal(
		<div className="pd-search-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div ref={dialogRef} className="pd-search-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={handleKeyDown}>
				<h2 id={`${id}-title`} className="pd-search-sr-only">{t('search.title')}</h2>
				<div className="pd-search-input-row">
					<Icon name="search" />
					<input ref={inputRef} className="pd-search-input" role="combobox" aria-label={t('search.title')} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={activeId ? rowDomId(activeId) : undefined} placeholder={t(`search.placeholder.${scope}`)} value={rawQuery} readOnly={pending} maxLength={500} autoComplete="off" spellCheck={false} onChange={(event) => setRawQuery(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} />
					<button type="button" className="pd-search-close" aria-label={t('search.close')} onClick={onClose}><Icon name="close" /></button>
				</div>
				<SegmentedIndicator activeKey={scope} className="pd-search-scopes" label={t('search.scopeLabel')}>
					{SCOPES.map((value) => <button key={value} data-segment-key={value} type="button" className={`pd-search-scope${scope === value ? ' is-active' : ''}`} aria-pressed={scope === value} disabled={pending} onClick={() => chooseScope(value)}>{t(`search.scope.${value}`)}{value !== 'all' && <kbd aria-hidden="true">{PREFIXES[value]}</kbd>}</button>)}
				</SegmentedIndicator>
				<div className="pd-search-body">
					<div ref={listRef} id={`${id}-list`} className="pd-search-results" role="listbox" aria-label={t('search.results')} aria-busy={loading || pending}>
						{groups.map((group) => <div key={group.scope} role="group" aria-labelledby={`${id}-group-${group.scope}`}><div className="pd-search-group-title" id={`${id}-group-${group.scope}`} role="presentation">{resultLabel(group.scope)}{group.scope === 'files' && <span>{pathLeaf(cwd)}</span>}</div>{group.rows.map(renderRow)}</div>)}
					</div>
					{loading && <div className="pd-search-status" role="status">{t('search.loading')}</div>}
					{!loading && !rows.length && !sessionError && !fileError && <div className="pd-search-empty"><Icon name="search" /><p>{scope === 'files' && !cwd ? t('search.noWorkspace') : scope === 'files' && !query ? t('search.filePrompt') : query ? t('search.noResults') : t('search.noRecent')}</p>{query && <span>{t('search.tryAnother')}</span>}</div>}
					{(sessionError || fileError) && <div className="pd-search-error" role="alert"><span>{sessionError && `${t('search.sessionsError')} ${sessionError}`}{sessionError && fileError && <br />}{fileError && `${t('search.filesError')} ${fileError}`}</span><button type="button" disabled={pending} onClick={() => setRetry((value) => value + 1)}>{t('search.retry')}</button></div>}
					{actionError && <div className="pd-search-error" role="alert">{t('search.actionError')} {actionError}</div>}
					{!loading && ((scope === 'sessions' && sessionTruncated) || (scope === 'files' && fileTruncated)) && <p className="pd-search-truncated">{t('search.truncated')}</p>}
				</div>
				<div className="pd-search-footer"><span>{pending ? t('search.opening') : <><kbd>↑</kbd><kbd>↓</kbd> {t('search.navigate')} <kbd>↵</kbd> {t('search.open')}</>}</span><span><kbd>Esc</kbd> {t('search.dismiss')}</span></div>
			</div>
		</div>, document.body,
	);
}
