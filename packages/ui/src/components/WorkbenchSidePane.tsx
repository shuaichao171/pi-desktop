import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import type { WorkspaceCommandEvent, WorkspaceEntry, WorkspaceGitLogEntry, WorkspaceGitStatus } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { SegmentedIndicator } from './SegmentedIndicator';
import { WorkbenchTextView } from './WorkbenchTextView';
import { appendCommandOutput, commandOutput, groupGitEntries, type DiffSource } from '../workbenchReading';
import { runWithFeedback } from '../operationFeedback';
import { WorkbenchGitFeatures } from './WorkbenchGitFeatures';
import { WorkspaceTerminalPane } from './WorkspaceTerminalPane';
import './workbenchReading.css';

type WorkbenchTab = 'files' | 'git' | 'command' | 'terminal';
type CommandRun = { id: string; command: string; cwd: string };
export interface WorkbenchOpenRequest { cwd: string; path: string; requestId: number }

function parentDirectory(path: string): string {
	return path.split('/').slice(0, -1).join('/');
}

function readableSize(size?: number): string {
	if (size === undefined) return '';
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function WorkbenchSidePane({ open, onClose, openRequest, modal = false, suspended = false, width = 420, onWidthChange, onResizing }: { open: boolean; onClose(): void; openRequest?: WorkbenchOpenRequest | null; modal?: boolean; suspended?: boolean; width?: number; onWidthChange?(width: number): void; onResizing?(resizing: boolean): void }) {
	const { t, locale } = useT();
	const label = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
	const pane = useRef<HTMLElement>(null);
	const fileList = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const widthDrag = useRef<{ x: number; width: number } | null>(null);
	const ratioDrag = useRef<{ y: number; ratio: number; height: number } | null>(null);
	const [previewExpanded, setPreviewExpanded] = useState(false);
	const [previewRatio, setPreviewRatio] = useState(() => { try { const ratio = Number(localStorage.getItem('pi-desktop.workbench-preview-ratio')); return ratio >= 25 && ratio <= 80 ? ratio : 54; } catch { return 54; } });
	const [focusedPath, setFocusedPath] = useState<string | null>(null);
	const [menuTarget, setMenuTarget] = useState<WorkspaceEntry | null>(null);
	const menuTrigger = useRef<HTMLElement | null>(null);
	const restoreListFocus = useRef(false);
	useEffect(() => { try { localStorage.setItem('pi-desktop.workbench-preview-ratio', String(previewRatio)); } catch {} }, [previewRatio]);
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const navigationPending = useChatStore((state) => state.navigationPending);
	const [tab, setTab] = useState<WorkbenchTab>('files');
	const [terminalVisited, setTerminalVisited] = useState(false);
	const [directory, setDirectory] = useState('');
	const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileText, setFileText] = useState('');
	const [fileLoading, setFileLoading] = useState(false);
	const [fileError, setFileError] = useState<string | null>(null);
	const [listingLoading, setListingLoading] = useState(false);
	const [listingError, setListingError] = useState<string | null>(null);
	const [listingRevision, setListingRevision] = useState(0);
	const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
	const [gitLoading, setGitLoading] = useState(false);
	const [gitError, setGitError] = useState<string | null>(null);
	const [gitRevision, setGitRevision] = useState(0);
	const [diffPath, setDiffPath] = useState<string | null>(null);
	const [diffSource, setDiffSource] = useState<DiffSource>('unstaged');
	const [diffText, setDiffText] = useState('');
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | null>(null);
	const [gitLog, setGitLog] = useState<WorkspaceGitLogEntry[]>([]);
	const [gitActionError, setGitActionError] = useState<string | null>(null);
	const [gitActionBusy, setGitActionBusy] = useState(false);
	const [discardTarget, setDiscardTarget] = useState<{ cwd: string; path: string } | null>(null);
	const gitOperation = useRef<symbol | null>(null);
	const [branchCreateOpen, setBranchCreateOpen] = useState(false);
	const [branchName, setBranchName] = useState('');
	const [branchCreating, setBranchCreating] = useState(false);
	const [command, setCommand] = useState('');
	const [commandRun, setCommandRun] = useState<CommandRun | null>(null);
	const [commandStarting, setCommandStarting] = useState(false);
	const [commandStopping, setCommandStopping] = useState(false);
	const [commandError, setCommandError] = useState<string | null>(null);
	const [, setEventRevision] = useState(0);
	const eventsRef = useRef(new Map<string, WorkspaceCommandEvent[]>());
	const eventLengthsRef = useRef(new Map<string, number>());
	const omittedOutput = useRef(new Set<string>());
	const ignoredCommandIdsRef = useRef(new Set<string>());
	const eventRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const currentCwdRef = useRef(cwd);
	const handledOpenRequest = useRef<number | null>(null);
	currentCwdRef.current = cwd;
	const listingRequest = useRef(0);
	const fileRequest = useRef(0);
	const gitRequest = useRef(0);
	const diffRequest = useRef(0);
	const commandEvents = commandRun ? eventsRef.current.get(commandRun.id) ?? [] : [];
	const finalEvent = [...commandEvents].reverse().find((event) => event.type === 'exit' || event.type === 'error');
	const outputEvents = commandEvents.filter((event) => event.type === 'stdout' || event.type === 'stderr' || event.type === 'error');
	const output = commandOutput(outputEvents);
	const commandFailed = commandEvents.some((event) => event.type === 'error');
	const commandRunning = Boolean(commandRun && !finalEvent);
	const breadcrumb = useMemo(() => directory.split('/').filter(Boolean), [directory]);
	const gitGroups = useMemo(() => groupGitEntries(gitStatus?.entries ?? []), [gitStatus]);
	const visibleFileEntries: WorkspaceEntry[] = directory ? [{ path: parentDirectory(directory), name: '..', kind: 'directory' }, ...entries] : entries;
	const activePath = visibleFileEntries.some(entry => entry.path === focusedPath) ? focusedPath : visibleFileEntries[0]?.path;

	useEffect(() => {
		if (!open || !modal || suspended) return;
		const focus = () => pane.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')?.focus();
		const higherDialog = () => [...document.querySelectorAll('[aria-modal="true"]')].some(element => element !== pane.current);
		if (!higherDialog()) focus();
		const contain = (event: FocusEvent) => { if (!higherDialog() && event.target instanceof Node && !pane.current?.contains(event.target)) focus(); };
		const observer = new MutationObserver(() => { if (!higherDialog() && !pane.current?.contains(document.activeElement)) focus(); });
		if (pane.current) observer.observe(pane.current, { childList: true, subtree: true });
		document.addEventListener('focusin', contain);
		return () => { observer.disconnect(); document.removeEventListener('focusin', contain); };
	}, [open, modal, suspended]);
	useEffect(() => { setMenuTarget(null); setFocusedPath(null); setPreviewExpanded(false); }, [cwd, directory, tab]);
	useEffect(() => { if (menuTarget) menu.current?.querySelector<HTMLElement>('button')?.focus(); }, [menuTarget]);
	useEffect(() => { if (!menuTarget) return; const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !menuTrigger.current?.contains(event.target)) setMenuTarget(null); }; document.addEventListener('pointerdown', dismiss); return () => document.removeEventListener('pointerdown', dismiss); }, [menuTarget]);
	useLayoutEffect(() => { if (!listingLoading && restoreListFocus.current) { restoreListFocus.current = false; (fileList.current?.querySelector<HTMLElement>('[data-file-path]') ?? fileList.current)?.focus(); } }, [listingLoading, entries]);
	function paneKeyDown(event: KeyboardEvent<HTMLElement>) {
		event.stopPropagation();
		if (event.defaultPrevented || event.nativeEvent.isComposing) return;
		if (event.key === 'Escape') { event.preventDefault(); if (menuTarget) closeMenu(); else onClose(); return; }
		if (modal && event.key === 'Tab') {
			const elements = [...(pane.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], summary') ?? [])].filter(element => element.getClientRects().length > 0);
			const first = elements[0], last = elements.at(-1);
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		}
	}
	function closeMenu() { setMenuTarget(null); menuTrigger.current?.focus(); }
	function fileKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.target instanceof HTMLElement && event.target.closest('[role="menu"], .pd-workbench-file-menu-trigger')) return;
		const index = Math.max(0, visibleFileEntries.findIndex(entry => entry.path === activePath));
		let next = index;
		if (event.key === 'ArrowDown') next = Math.min(index + 1, visibleFileEntries.length - 1);
		else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = visibleFileEntries.length - 1;
		else if (event.key === 'Enter' || event.key === 'ArrowRight') { const entry = visibleFileEntries[index]; if (entry) { event.preventDefault(); void openFile(entry); } return; }
		else if (event.key === 'ArrowLeft' || event.key === 'Backspace') { if (directory) { event.preventDefault(); restoreListFocus.current = true; setDirectory(parentDirectory(directory)); setSelectedFile(null); } return; }
		else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const entry = visibleFileEntries[index]; if (entry) { menuTrigger.current = document.activeElement as HTMLElement; setMenuTarget(entry); } return; }
		else return;
		event.preventDefault(); const entry = visibleFileEntries[next]; if (entry) { setFocusedPath(entry.path); fileList.current?.querySelectorAll<HTMLButtonElement>('[data-file-path]')[next]?.focus(); }
	}

	useLayoutEffect(() => {
		if (commandRun) ignoredCommandIdsRef.current.add(commandRun.id);
		for (const id of eventsRef.current.keys()) ignoredCommandIdsRef.current.add(id);
		while (ignoredCommandIdsRef.current.size > 128) {
			const oldestId = ignoredCommandIdsRef.current.values().next().value;
			if (oldestId === undefined) break;
			ignoredCommandIdsRef.current.delete(oldestId);
		}
		eventsRef.current.clear();
		eventLengthsRef.current.clear();
		omittedOutput.current.clear();
		if (eventRenderTimerRef.current) clearTimeout(eventRenderTimerRef.current);
		eventRenderTimerRef.current = null;
		setCommandRun(null);
		setCommand('');
		setCommandError(null);
		setCommandStarting(false);
		setCommandStopping(false);
		setEventRevision((value) => value + 1);
		fileRequest.current += 1;
		diffRequest.current += 1;
		setDirectory('');
		setEntries([]);
		setSelectedFile(null);
		setFileText('');
		setGitStatus(null);
		setGitLog([]);
		setGitError(null);
		setGitActionError(null);
		setGitActionBusy(false);
		setDiscardTarget(null);
		setBranchCreateOpen(false);
		setBranchName('');
		setBranchCreating(false);
		gitOperation.current = null;
		setDiffPath(null);
		setDiffText('');
		setDiffError(null);
		setDiffLoading(false);
	}, [cwd, bridge]);

	useEffect(() => {
		if (!open || !bridge || !openRequest || openRequest.cwd !== cwd || handledOpenRequest.current === openRequest.requestId) return;
		handledOpenRequest.current = openRequest.requestId;
		setTab('files');
		setDirectory(parentDirectory(openRequest.path));
		void openFile({ kind: 'file', path: openRequest.path, name: openRequest.path.split('/').at(-1) ?? openRequest.path });
	}, [open, bridge, cwd, openRequest]);

	useEffect(() => {
		if (!bridge) return;
		const unsubscribe = bridge.onWorkspaceCommandEvent((event) => {
			if (ignoredCommandIdsRef.current.has(event.id)) return;
			const result = appendCommandOutput(eventsRef.current.get(event.id) ?? [], event, eventLengthsRef.current.get(event.id) ?? 0);
			if (result.omitted) omittedOutput.current.add(event.id);
			eventsRef.current.set(event.id, result.events);
			eventLengthsRef.current.set(event.id, result.length);
			if (eventsRef.current.size > 12) {
				const oldestId = eventsRef.current.keys().next().value!;
				eventsRef.current.delete(oldestId);
				eventLengthsRef.current.delete(oldestId);
			}
			if (event.type === 'exit' || event.type === 'error') {
				if (eventRenderTimerRef.current) clearTimeout(eventRenderTimerRef.current);
				eventRenderTimerRef.current = null;
				setEventRevision((value) => value + 1);
			} else if (!eventRenderTimerRef.current) {
				eventRenderTimerRef.current = setTimeout(() => {
					eventRenderTimerRef.current = null;
					setEventRevision((value) => value + 1);
				}, 100);
			}
		});
		return () => {
			unsubscribe();
			if (eventRenderTimerRef.current) clearTimeout(eventRenderTimerRef.current);
			eventRenderTimerRef.current = null;
		};
	}, [bridge]);

	useEffect(() => {
		if (!bridge || !cwd || !open || tab !== 'files') return;
		const request = ++listingRequest.current;
		setListingLoading(true);
		setEntries([]);
		setListingError(null);
		void bridge.listWorkspaceEntries(directory).then((items) => {
			if (request === listingRequest.current) setEntries([...items].sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name)));
		}).catch((cause: unknown) => {
			if (request === listingRequest.current) setListingError(cause instanceof Error ? cause.message : String(cause));
		}).finally(() => { if (request === listingRequest.current) setListingLoading(false); });
		return () => { listingRequest.current += 1; };
	}, [bridge, cwd, open, tab, directory, listingRevision]);

	useEffect(() => {
		if (!bridge || !cwd || !open || tab !== 'git') return;
		const request = ++gitRequest.current;
		setGitLoading(true);
		setGitError(null);
		void bridge.getWorkspaceGitStatus().then((status) => {
			if (request === gitRequest.current) setGitStatus(status);
		}).catch((cause: unknown) => {
			if (request === gitRequest.current) setGitError(cause instanceof Error ? cause.message : String(cause));
		}).finally(() => { if (request === gitRequest.current) setGitLoading(false); });
		void bridge.getWorkspaceGitLog(20).then((entries) => {
			if (request === gitRequest.current) setGitLog(entries);
		}).catch(() => { /* history stays empty when unavailable */ });
		return () => { gitRequest.current += 1; };
	}, [bridge, cwd, open, tab, gitRevision]);

	async function openFile(entry: WorkspaceEntry) {
		if (!bridge) return;
		if (entry.kind === 'directory') {
			restoreListFocus.current = true;
			setDirectory(entry.path);
			setSelectedFile(null);
			return;
		}
		const request = ++fileRequest.current;
		setSelectedFile(entry.path);
		setFileLoading(true);
		setFileError(null);
		setFileText('');
		try {
			const text = await bridge.readWorkspaceFile(entry.path);
			if (request === fileRequest.current) setFileText(text);
		} catch (cause) {
			if (request === fileRequest.current) setFileError(cause instanceof Error ? cause.message : String(cause));
		} finally { if (request === fileRequest.current) setFileLoading(false); }
	}

	async function openDiff(path: string, source: DiffSource = 'unstaged') {
		if (!bridge) return;
		const request = ++diffRequest.current;
		setDiffPath(path);
		setDiffSource(source);
		setDiffText('');
		setDiffError(null);
		setDiffLoading(true);
		try {
			const text = await bridge.getWorkspaceGitDiff(path, source);
			if (request === diffRequest.current) setDiffText(text);
		} catch (cause) {
			if (request === diffRequest.current) setDiffError(cause instanceof Error ? cause.message : String(cause));
		} finally { if (request === diffRequest.current) setDiffLoading(false); }
	}

	function beginGitOperation() {
		const state = useChatStore.getState();
		if (!bridge || !cwd || state.cwd !== cwd || state.bridge !== bridge || state.navigationPending || gitOperation.current) return null;
		const token = Symbol();
		gitOperation.current = token;
		return token;
	}
	function currentGitOperation(token: symbol) {
		const state = useChatStore.getState();
		return gitOperation.current === token && state.cwd === cwd && state.bridge === bridge;
	}
	/** Each mutation owns its original workspace, including its asynchronous UI result. */
	async function setStaged(path: string, staged: boolean) {
		if (!bridge) return;
		const token = beginGitOperation();
		if (!token) return;
		const previousDiffRequest = diffRequest.current;
		setGitActionBusy(true);
		setGitActionError(null);
		try {
			await bridge.setWorkspaceGitStaged([path], staged);
			if (!currentGitOperation(token)) return;
			setGitRevision((value) => value + 1);
			if (diffPath === path && diffRequest.current === previousDiffRequest) void openDiff(path, diffSource);
		} catch (cause) {
			if (currentGitOperation(token)) setGitActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (currentGitOperation(token)) { gitOperation.current = null; setGitActionBusy(false); }
		}
	}

	/** Shows the real diff and asks for confirmation before discarding (4.5). */
	function requestDiscard(path: string) {
		if (navigationPending || gitOperation.current || useChatStore.getState().cwd !== cwd) return;
		setDiscardTarget({ cwd, path });
		void openDiff(path);
	}

	async function confirmDiscard() {
		if (!bridge || !discardTarget || discardTarget.cwd !== cwd) return;
		const token = beginGitOperation();
		if (!token) return;
		const target = discardTarget;
		setGitActionBusy(true);
		setGitActionError(null);
		try {
			await bridge.discardWorkspaceGitChanges([target.path]);
			if (!currentGitOperation(token)) return;
			setDiscardTarget(null);
			setDiffPath(null);
			setDiffText('');
			setGitRevision((value) => value + 1);
		} catch (cause) {
			if (currentGitOperation(token)) setGitActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (currentGitOperation(token)) { gitOperation.current = null; setGitActionBusy(false); }
		}
	}

	/** Creates and switches to a new branch from the branch row (4.5). */
	async function createBranch(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = branchName.trim();
		if (!bridge || !name) return;
		const token = beginGitOperation();
		if (!token) return;
		setBranchCreating(true);
		setGitActionBusy(true);
		setGitActionError(null);
		try {
			await bridge.createWorkspaceGitBranch(name, true);
			if (!currentGitOperation(token)) return;
			setBranchCreateOpen(false);
			setBranchName('');
			setGitRevision((value) => value + 1);
		} catch (cause) {
			if (currentGitOperation(token)) setGitActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (currentGitOperation(token)) { gitOperation.current = null; setBranchCreating(false); setGitActionBusy(false); }
		}
	}

	/** Opens a workspace file in VS Code / reveals it in the file manager (4.7). */
	async function openInEditor(path: string) {
		if (!bridge) return;
		const workspace = cwd;
		await runWithFeedback({ id: `editor:${workspace}:${path}`, title: t('workbench.openInEditor'), run: () => bridge.openWorkspacePathInEditor(path), canRetry: () => currentCwdRef.current === workspace });
	}

	async function revealPath(path: string) {
		if (!bridge) return;
		const workspace = cwd;
		await runWithFeedback({ id: `reveal:${workspace}:${path}`, title: t('workbench.revealInFolder'), run: () => bridge.revealWorkspacePath(path), canRetry: () => currentCwdRef.current === workspace });
	}

	async function startCommand(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = command.trim();
		if (!bridge || !cwd || !text || commandStarting || commandRunning) return;
		setCommandStarting(true);
		setCommandError(null);
		try {
			const id = await bridge.startWorkspaceCommand(text);
			if (!id) return;
			if (currentCwdRef.current !== cwd) {
				ignoredCommandIdsRef.current.add(id);
				eventsRef.current.delete(id);
				eventLengthsRef.current.delete(id);
				await bridge.stopWorkspaceCommand(id);
				return;
			}
			setCommandRun({ id, command: text, cwd });
			setCommand('');
		} catch (cause) { if (currentCwdRef.current === cwd) setCommandError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (currentCwdRef.current === cwd) setCommandStarting(false); }
	}

	async function stopCommand() {
		if (!bridge || !commandRun || !commandRunning || commandStopping) return;
		setCommandStopping(true);
		setCommandError(null);
		try { await bridge.stopWorkspaceCommand(commandRun.id); }
		catch (cause) { setCommandError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setCommandStopping(false); }
	}
	const previewControls = <>
		<div className="pd-workbench-preview-resize" role="separator" aria-label={label('调整预览比例', 'Resize preview')} aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={80} aria-valuenow={Math.round(previewRatio)} tabIndex={0}
			onPointerDown={event => { if (event.button !== 0) return; ratioDrag.current = { y: event.clientY, ratio: previewRatio, height: pane.current?.querySelector('.pd-workbench-body')?.clientHeight ?? 500 }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
			onPointerMove={event => { const drag = ratioDrag.current; if (drag) setPreviewRatio(Math.max(25, Math.min(80, drag.ratio - (event.clientY - drag.y) / drag.height * 100))); }}
			onPointerUp={event => { ratioDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { ratioDrag.current = null; }}
			onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setPreviewRatio(value => event.key === 'Home' ? 25 : event.key === 'End' ? 80 : Math.max(25, Math.min(80, value + (event.key === 'ArrowUp' ? 5 : -5)))); } }} />
		<button type="button" className="pd-workbench-preview-expand" aria-pressed={previewExpanded} onClick={() => setPreviewExpanded(value => !value)}>{previewExpanded ? label('返回列表', 'Back to list') : label('放大预览', 'Expand preview')}</button>
	</>;

	return (
		<aside ref={pane} className={`pd-workbench${open ? ' is-open' : ''}`} role={modal && open ? 'dialog' : 'complementary'} aria-modal={modal && open || undefined} aria-label={t('workbench.panel')} aria-hidden={!open} inert={!open || suspended} onKeyDown={paneKeyDown} style={{ '--pd-preview-ratio': `${previewRatio}%` } as CSSProperties}>
			<div className="pd-workbench-resize" role="separator" aria-label={label('调整工作台宽度', 'Resize workbench')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={800} aria-valuenow={Math.round(width)} tabIndex={0}
				onPointerDown={event => { if (event.button !== 0) return; widthDrag.current = { x: event.clientX, width }; onResizing?.(true); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
				onPointerMove={event => { const drag = widthDrag.current; if (drag) onWidthChange?.(drag.width + drag.x - event.clientX); }}
				onPointerUp={event => { widthDrag.current = null; onResizing?.(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { widthDrag.current = null; onResizing?.(false); }}
				onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); onWidthChange?.(event.key === 'Home' ? 320 : event.key === 'End' ? 800 : width + (event.key === 'ArrowLeft' ? 16 : -16)); } }} />
			<div className="pd-workbench-content">
			<header className="pd-workbench-header">
				<div><span className="pd-workbench-eyebrow">{t('workbench.workspace')}</span><h2>{t('workbench.title')}</h2></div>
				<button type="button" className="pd-icon-button" onClick={onClose} aria-label={t('workbench.close')}><Icon name="close" width="17" height="17" /></button>
			</header>
			<SegmentedIndicator as="nav" activeKey={tab} className="pd-workbench-tabs" label={t('workbench.tabs')}>
				<button data-segment-key="files" type="button" className={tab === 'files' ? 'is-active' : ''} aria-current={tab === 'files' ? 'page' : undefined} onClick={() => setTab('files')}><Icon name="file" width="15" height="15" />{t('workbench.files')}</button>
				<button data-segment-key="git" type="button" className={tab === 'git' ? 'is-active' : ''} aria-current={tab === 'git' ? 'page' : undefined} onClick={() => setTab('git')}><Icon name="gitBranch" width="15" height="15" />{t('workbench.git')}</button>
				<button data-segment-key="command" type="button" className={tab === 'command' ? 'is-active' : ''} aria-current={tab === 'command' ? 'page' : undefined} onClick={() => setTab('command')}><Icon name="terminal" width="15" height="15" />{t('workbench.command')}</button>
				<button data-segment-key="terminal" type="button" className={tab === 'terminal' ? 'is-active' : ''} aria-current={tab === 'terminal' ? 'page' : undefined} onClick={() => { setTerminalVisited(true); setTab('terminal'); }}>PTY</button>
			</SegmentedIndicator>
			<div className={`pd-workbench-body${previewExpanded && (tab === 'files' && selectedFile || tab === 'git' && diffPath) ? ' is-preview-expanded' : ''}`}>
				{!cwd && <div className="pd-workbench-empty">{t('workbench.emptyWorkspace')}</div>}

				{cwd && tab === 'files' && <>
					<div className="pd-workbench-toolbar">
						<div className="pd-workbench-breadcrumb">
							<HoverTooltip title={cwd}><button type="button" onClick={() => { setDirectory(''); setSelectedFile(null); }}>{cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd}</button></HoverTooltip>
							{breadcrumb.map((part, index) => <span key={`${index}:${part}`}><Icon name="chevronRight" width="12" height="12" /><button type="button" onClick={() => { setDirectory(breadcrumb.slice(0, index + 1).join('/')); setSelectedFile(null); }}>{part}</button></span>)}
						</div>
						<HoverTooltip title={t('workbench.refresh')}><button type="button" className="pd-icon-button" onClick={() => setListingRevision((value) => value + 1)} aria-label={t('workbench.refreshFiles')}><Icon name="refresh" width="15" height="15" /></button></HoverTooltip>
					</div>
					<div ref={fileList} className="pd-workbench-file-list" role="group" tabIndex={visibleFileEntries.length ? -1 : 0} aria-label={t('workbench.fileList')} onKeyDown={fileKeyDown}>
						{visibleFileEntries.map((entry) => <div key={entry.path} className="pd-workbench-file-row"><HoverTooltip title={entry.path}><button type="button" data-file-path={entry.path} tabIndex={entry.path === activePath ? 0 : -1} className={`pd-workbench-entry${selectedFile === entry.path ? ' is-selected' : ''}`} onFocus={() => setFocusedPath(entry.path)} onClick={() => void openFile(entry)} onContextMenu={event => { event.preventDefault(); menuTrigger.current = event.currentTarget; setMenuTarget(entry); }}><Icon name={entry.kind === 'directory' ? 'folder' : 'file'} width="15" height="15" /><span>{entry.name}</span>{entry.kind === 'file' && <small>{readableSize(entry.size)}</small>}</button></HoverTooltip><button className="pd-workbench-file-menu-trigger" type="button" tabIndex={-1} aria-label={`${label('操作', 'Actions')}: ${entry.path}`} onClick={event => { menuTrigger.current = event.currentTarget.previousElementSibling as HTMLElement; setMenuTarget(entry); }}>…</button></div>)}
						{menuTarget && <div ref={menu} className="pd-workbench-file-menu" role="menu" aria-label={menuTarget.path} onKeyDown={event => { event.stopPropagation(); const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenu(); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); } }}>
							<strong>{menuTarget.path || cwd}</strong>
							<button type="button" role="menuitem" onClick={() => { const path = `${cwd.replace(/[\\/]$/, '')}/${menuTarget.path}`; closeMenu(); void runWithFeedback({ id: `copy-path:${path}`, title: label('复制路径', 'Copy path'), run: () => navigator.clipboard.writeText(path), success: label('已复制路径', 'Path copied') }); }}>{label('复制路径', 'Copy path')}</button>
							<button type="button" role="menuitem" onClick={() => { const path = menuTarget.path; closeMenu(); void openInEditor(path); }}>{t('workbench.openInEditor')}</button>
							<button type="button" role="menuitem" onClick={() => { const path = menuTarget.path; closeMenu(); void revealPath(path); }}>{t('workbench.revealInFolder')}</button>
						</div>}
						{listingLoading && <div className="pd-workbench-empty">{t('workbench.loadingFolder')}</div>}
						{listingError && <div className="pd-workbench-error" role="alert">{listingError}</div>}
						{!listingLoading && !listingError && entries.length === 0 && <div className="pd-workbench-empty">{t('workbench.folderEmpty')}</div>}
						{!listingLoading && entries.length >= 400 && <div className="pd-workbench-empty">{t('workbench.entryLimit')}</div>}
					</div>
					{selectedFile && <section className="pd-workbench-preview" aria-label={t('workbench.preview')}>
						{previewControls}
						<div className="pd-workbench-preview-head"><strong title={selectedFile}>{selectedFile}</strong><button type="button" className="pd-icon-button" onClick={() => { setSelectedFile(null); setFileText(''); }} aria-label={t('workbench.closePreview')}><Icon name="close" width="14" height="14" /></button></div>
						{fileLoading ? <div className="pd-workbench-empty">{t('workbench.loadingFile')}</div> : fileError ? <div className="pd-workbench-error" role="alert">{fileError}</div> : <WorkbenchTextView key={selectedFile} text={fileText} path={selectedFile} />}
					</section>}
				</>}

				{cwd && tab === 'git' && <>
					<WorkbenchGitFeatures />
					<div className="pd-workbench-toolbar"><strong>{t('workbench.gitStatus')}</strong><HoverTooltip title={t('workbench.refresh')}><button type="button" className="pd-icon-button" onClick={() => setGitRevision((value) => value + 1)} aria-label={t('workbench.refreshGit')}><Icon name="refresh" width="15" height="15" /></button></HoverTooltip></div>
					{gitLoading && <div className="pd-workbench-empty">{t('workbench.loadingGit')}</div>}
					{gitError && <div className="pd-workbench-error" role="alert">{gitError}</div>}
					{!gitLoading && !gitError && gitStatus && (gitStatus.isRepository ? <>
						<div className="pd-workbench-branch"><Icon name="gitBranch" width="15" height="15" /><span>{gitStatus.branch || 'HEAD'}</span><small>{t('workbench.changes', { count: gitStatus.entries.length })}</small>
							<HoverTooltip title={t('workbench.newBranch')}><button type="button" className="pd-icon-button" disabled={gitActionBusy || navigationPending} onClick={() => setBranchCreateOpen((open) => !open)} aria-label={t('workbench.newBranch')} aria-expanded={branchCreateOpen}><Icon name="plus" width="14" height="14" /></button></HoverTooltip></div>
						{branchCreateOpen && <form className="pd-workbench-branch-form" onSubmit={(event) => void createBranch(event)}>
							<input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder={t('workbench.branchNamePlaceholder')} spellCheck={false} autoComplete="off" aria-label={t('workbench.branchNamePlaceholder')} />
							<button type="submit" disabled={!branchName.trim() || gitActionBusy || navigationPending}>{t(branchCreating ? 'workbench.creating' : 'workbench.createAndSwitch')}</button>
						</form>}
						{gitActionError && <div className="pd-workbench-error" role="alert">{gitActionError}</div>}
						{gitStatus.truncated && <div className="pd-workbench-empty" role="status">{t('workbench.gitStatusTruncated')}</div>}
						<div className="pd-workbench-changes">
							{(['staged', 'unstaged'] as const).map(source => <section className="pd-workbench-git-group" key={source} aria-label={source === 'staged' ? label('已暂存', 'Staged') : label('未暂存', 'Unstaged')}>
								<h3>{source === 'staged' ? label('已暂存', 'Staged') : label('未暂存', 'Unstaged')} <span>{gitGroups[source].length}</span></h3>
								{gitGroups[source].map((entry) => {
								const staged = source === 'staged';
								const untracked = entry.status.startsWith('??');
								const code = entry.status[staged ? 0 : 1];
								const statusText = ({ M: label('修改', 'Modified'), A: label('新增', 'Added'), D: label('删除', 'Deleted'), R: label('重命名', 'Renamed'), C: label('复制', 'Copied'), U: label('冲突', 'Conflict'), '?': label('未跟踪', 'Untracked') } as Record<string, string>)[code ?? ''] ?? code;
								return (<div key={entry.path} className={`pd-workbench-change${diffPath === entry.path && diffSource === source ? ' is-selected' : ''}${discardTarget?.cwd === cwd && discardTarget.path === entry.path ? ' is-discarding' : ''}`}>
									<HoverTooltip title={`${entry.path}\n${statusText}`}><button type="button" data-git-path={entry.path} data-git-source={source} className="pd-workbench-change-main" onClick={() => void openDiff(entry.path, source)}><span className="pd-workbench-git-status" aria-label={statusText}>{code}</span><span className="pd-workbench-change-path">{entry.path}</span><small>{statusText}</small></button></HoverTooltip>
									<span className="pd-workbench-change-actions">
										{staged
											? <HoverTooltip title={t('workbench.unstage')}><button type="button" data-git-action="unstage" disabled={gitActionBusy || navigationPending} onClick={() => void setStaged(entry.path, false)} aria-label={t('workbench.unstage')}><Icon name="minusCircle" width="13" height="13" /></button></HoverTooltip>
											: <HoverTooltip title={t('workbench.stage')}><button type="button" data-git-action="stage" disabled={gitActionBusy || navigationPending} onClick={() => void setStaged(entry.path, true)} aria-label={t('workbench.stage')}><Icon name="plus" width="13" height="13" /></button></HoverTooltip>}
										{!staged && !untracked && <HoverTooltip title={t('workbench.discard')}><button type="button" className="pd-workbench-discard" disabled={gitActionBusy || navigationPending} onClick={() => requestDiscard(entry.path)} aria-label={t('workbench.discard')}><Icon name="rotateCcw" width="13" height="13" /></button></HoverTooltip>}
									</span>
								</div>);
							})}</section>)}
							{gitStatus.entries.length === 0 && <div className="pd-workbench-empty">{t('workbench.clean')}</div>}
						</div>
						{discardTarget?.cwd === cwd && (<div className="pd-workbench-discard-confirm" role="alertdialog" aria-label={t('workbench.discardTitle')}>
							<p><strong>{t('workbench.discardTitle')}</strong><span>{t('workbench.discardHint', { path: discardTarget.path })}</span></p>
							<div className="pd-workbench-discard-actions">
								<button type="button" className="pd-workbench-discard-confirm-button" disabled={gitActionBusy || navigationPending} onClick={() => void confirmDiscard()}>{t('workbench.discard')}</button>
								<button type="button" disabled={gitActionBusy} onClick={() => setDiscardTarget(null)}>{t('workbench.cancel')}</button>
							</div>
						</div>)}
						{diffPath && <section className="pd-workbench-preview" aria-label={t('workbench.diff')}>
							{previewControls}
							<div className="pd-workbench-diff-source">{diffSource === 'staged' ? label('已暂存差异', 'Staged changes') : label('未暂存差异', 'Unstaged changes')}</div>
							<div className="pd-workbench-preview-head"><strong title={diffPath}>{diffPath}</strong><span className="pd-workbench-preview-actions"><HoverTooltip title={t('workbench.openInEditor')}><button type="button" className="pd-icon-button" onClick={() => void openInEditor(diffPath)} aria-label={t('workbench.openInEditor')}><Icon name="code" width="14" height="14" /></button></HoverTooltip><HoverTooltip title={t('workbench.revealInFolder')}><button type="button" className="pd-icon-button" onClick={() => void revealPath(diffPath)} aria-label={t('workbench.revealInFolder')}><Icon name="folder" width="14" height="14" /></button></HoverTooltip><button type="button" className="pd-icon-button" onClick={() => setDiffPath(null)} aria-label={t('workbench.closeDiff')}><Icon name="close" width="14" height="14" /></button></span></div>
							{diffLoading ? <div className="pd-workbench-empty">{t('workbench.loadingDiff')}</div> : diffError ? <div className="pd-workbench-error" role="alert">{diffError}</div> : <WorkbenchTextView key={`${diffSource}:${diffPath}`} diff text={diffText || t('workbench.noDiff')} path={diffPath} />}
						</section>}
						<details className="pd-workbench-history">
							<summary><Icon name="gitCommit" width="13" height="13" />{t('workbench.history')}</summary>
							<ul>
								{gitLog.map((commit) => <li key={commit.hash}><code>{commit.shortHash}</code><span title={commit.subject}>{commit.subject}</span><small>{commit.author} · {new Date(commit.date).toLocaleDateString()}</small></li>)}
								{gitLog.length === 0 && <li className="pd-workbench-empty">{t('workbench.historyEmpty')}</li>}
							</ul>
						</details>
					</> : <div className="pd-workbench-empty">{t('workbench.notRepo')}</div>)}
				</>}

				{cwd && tab === 'command' && <>
					<div className="pd-workbench-toolbar"><strong>{t('workbench.runCommand')}</strong></div>
					<p className="pd-workbench-command-note">{t('workbench.commandNote')}</p>
					<form className="pd-workbench-command-form" onSubmit={(event) => void startCommand(event)}>
						<label htmlFor="pd-workbench-command">{t('workbench.commandLabel')}</label>
						<div><input id="pd-workbench-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('workbench.commandPlaceholder')} spellCheck={false} autoComplete="off" disabled={commandStarting || commandRunning} /><button type="submit" disabled={!command.trim() || commandStarting || commandRunning}>{t(commandStarting ? 'workbench.starting' : 'workbench.run')}</button></div>
					</form>
					{commandError && <div className="pd-workbench-error" role="alert">{commandError}</div>}
					{commandRun && <section className="pd-workbench-command-result" aria-label={t('workbench.output')}>
						<div className="pd-workbench-command-result-head" role="status">
							<strong title={commandRun.command}>$ {commandRun.command}</strong>
							{commandRunning ? <button type="button" onClick={() => void stopCommand()} disabled={commandStopping}>{t(commandStopping ? 'workbench.stopping' : 'workbench.stop')}</button> : <span>{commandFailed ? t('workbench.failed') : t('workbench.exitCode', { code: finalEvent?.code ?? '—' })}</span>}
						</div>
						<div className="pd-workbench-command-location" title={commandRun.cwd}>{commandRun.cwd}</div>
						{!output.text && <p className="pd-workbench-reader-notice">{t(commandRunning ? 'workbench.waitingOutput' : 'workbench.noOutput')}</p>}
						<WorkbenchTextView key={commandRun.id} command text={output.text} errorRanges={output.errorRanges} omitted={omittedOutput.current.has(commandRun.id)} onClear={() => { const retained = commandEvents.filter(event => event.type === 'exit' || event.type === 'error').map(event => ({ ...event, data: undefined })); eventsRef.current.set(commandRun.id, retained); eventLengthsRef.current.set(commandRun.id, 0); omittedOutput.current.delete(commandRun.id); setEventRevision(value => value + 1); }} />
					</section>}
				</>}
				{terminalVisited && <WorkspaceTerminalPane active={open && tab === 'terminal'} />}
			</div>
			</div>
		</aside>
	);
}
