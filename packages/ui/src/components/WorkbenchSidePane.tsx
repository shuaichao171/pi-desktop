import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { WorkspaceCommandEvent, WorkspaceEntry, WorkspaceGitStatus } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { SegmentedIndicator } from './SegmentedIndicator';

type WorkbenchTab = 'files' | 'git' | 'command';
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

export function WorkbenchSidePane({ open, onClose, openRequest }: { open: boolean; onClose(): void; openRequest?: WorkbenchOpenRequest | null }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const [tab, setTab] = useState<WorkbenchTab>('files');
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
	const [diffText, setDiffText] = useState('');
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | null>(null);
	const [command, setCommand] = useState('');
	const [commandRun, setCommandRun] = useState<CommandRun | null>(null);
	const [commandStarting, setCommandStarting] = useState(false);
	const [commandStopping, setCommandStopping] = useState(false);
	const [commandError, setCommandError] = useState<string | null>(null);
	const [, setEventRevision] = useState(0);
	const eventsRef = useRef(new Map<string, WorkspaceCommandEvent[]>());
	const eventLengthsRef = useRef(new Map<string, number>());
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
	const commandFailed = commandEvents.some((event) => event.type === 'error');
	const commandRunning = Boolean(commandRun && !finalEvent);
	const breadcrumb = useMemo(() => directory.split('/').filter(Boolean), [directory]);

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
		setDiffPath(null);
		setDiffText('');
	}, [cwd]);

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
			const current = eventsRef.current.get(event.id) ?? [];
			const lastIndex = current.length - 1;
			const last = current[lastIndex];
			if ((event.type === 'stdout' || event.type === 'stderr') && last?.type === event.type && (last.data?.length ?? 0) < 16_000) {
				current[lastIndex] = { ...last, data: (last.data ?? '') + (event.data ?? '') };
			} else current.push(event);
			let length = (eventLengthsRef.current.get(event.id) ?? 0) + (event.data?.length ?? 0);
			while ((length > 120_000 || current.length > 512) && current.length > 1) length -= current.shift()?.data?.length ?? 0;
			if (length > 120_000 && current.length === 1) {
				current[0] = { ...current[0]!, data: current[0]?.data?.slice(-120_000) };
				length = current[0]?.data?.length ?? 0;
			}
			eventsRef.current.set(event.id, current);
			eventLengthsRef.current.set(event.id, length);
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
		return () => { gitRequest.current += 1; };
	}, [bridge, cwd, open, tab, gitRevision]);

	async function openFile(entry: WorkspaceEntry) {
		if (!bridge) return;
		if (entry.kind === 'directory') {
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

	async function openDiff(path: string) {
		if (!bridge) return;
		const request = ++diffRequest.current;
		setDiffPath(path);
		setDiffText('');
		setDiffError(null);
		setDiffLoading(true);
		try {
			const text = await bridge.getWorkspaceGitDiff(path);
			if (request === diffRequest.current) setDiffText(text);
		} catch (cause) {
			if (request === diffRequest.current) setDiffError(cause instanceof Error ? cause.message : String(cause));
		} finally { if (request === diffRequest.current) setDiffLoading(false); }
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

	return (
		<aside className={`pd-workbench${open ? ' is-open' : ''}`} aria-label={t('workbench.panel')} aria-hidden={!open} inert={!open}>
			<div className="pd-workbench-content">
			<header className="pd-workbench-header">
				<div><span className="pd-workbench-eyebrow">{t('workbench.workspace')}</span><h2>{t('workbench.title')}</h2></div>
				<button type="button" className="pd-icon-button" onClick={onClose} aria-label={t('workbench.close')}><Icon name="close" width="17" height="17" /></button>
			</header>
			<SegmentedIndicator as="nav" activeKey={tab} className="pd-workbench-tabs" label={t('workbench.tabs')}>
				<button data-segment-key="files" type="button" className={tab === 'files' ? 'is-active' : ''} aria-current={tab === 'files' ? 'page' : undefined} onClick={() => setTab('files')}><Icon name="file" width="15" height="15" />{t('workbench.files')}</button>
				<button data-segment-key="git" type="button" className={tab === 'git' ? 'is-active' : ''} aria-current={tab === 'git' ? 'page' : undefined} onClick={() => setTab('git')}><Icon name="gitBranch" width="15" height="15" />{t('workbench.git')}</button>
				<button data-segment-key="command" type="button" className={tab === 'command' ? 'is-active' : ''} aria-current={tab === 'command' ? 'page' : undefined} onClick={() => setTab('command')}><Icon name="terminal" width="15" height="15" />{t('workbench.command')}</button>
			</SegmentedIndicator>
			<div className="pd-workbench-body">
				{!cwd && <div className="pd-workbench-empty">{t('workbench.emptyWorkspace')}</div>}

				{cwd && tab === 'files' && <>
					<div className="pd-workbench-toolbar">
						<div className="pd-workbench-breadcrumb">
							<HoverTooltip title={cwd}><button type="button" onClick={() => { setDirectory(''); setSelectedFile(null); }}>{cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd}</button></HoverTooltip>
							{breadcrumb.map((part, index) => <span key={`${index}:${part}`}><Icon name="chevronRight" width="12" height="12" /><button type="button" onClick={() => { setDirectory(breadcrumb.slice(0, index + 1).join('/')); setSelectedFile(null); }}>{part}</button></span>)}
						</div>
						<HoverTooltip title={t('workbench.refresh')}><button type="button" className="pd-icon-button" onClick={() => setListingRevision((value) => value + 1)} aria-label={t('workbench.refreshFiles')}><Icon name="refresh" width="15" height="15" /></button></HoverTooltip>
					</div>
					<div className="pd-workbench-file-list" aria-label={t('workbench.fileList')}>
						{directory && <button type="button" className="pd-workbench-entry" onClick={() => { setDirectory(parentDirectory(directory)); setSelectedFile(null); }}><Icon name="folder" width="15" height="15" /><span>..</span></button>}
						{entries.map((entry) => <HoverTooltip key={entry.path} title={entry.path}><button type="button" className={`pd-workbench-entry${selectedFile === entry.path ? ' is-selected' : ''}`} onClick={() => void openFile(entry)}><Icon name={entry.kind === 'directory' ? 'folder' : 'file'} width="15" height="15" /><span>{entry.name}</span>{entry.kind === 'file' && <small>{readableSize(entry.size)}</small>}</button></HoverTooltip>)}
						{listingLoading && <div className="pd-workbench-empty">{t('workbench.loadingFolder')}</div>}
						{listingError && <div className="pd-workbench-error" role="alert">{listingError}</div>}
						{!listingLoading && !listingError && entries.length === 0 && <div className="pd-workbench-empty">{t('workbench.folderEmpty')}</div>}
						{!listingLoading && entries.length >= 400 && <div className="pd-workbench-empty">{t('workbench.entryLimit')}</div>}
					</div>
					{selectedFile && <section className="pd-workbench-preview" aria-label={t('workbench.preview')}>
						<div className="pd-workbench-preview-head"><strong title={selectedFile}>{selectedFile}</strong><button type="button" className="pd-icon-button" onClick={() => { setSelectedFile(null); setFileText(''); }} aria-label={t('workbench.closePreview')}><Icon name="close" width="14" height="14" /></button></div>
						{fileLoading ? <div className="pd-workbench-empty">{t('workbench.loadingFile')}</div> : fileError ? <div className="pd-workbench-error" role="alert">{fileError}</div> : <pre>{fileText}</pre>}
					</section>}
				</>}

				{cwd && tab === 'git' && <>
					<div className="pd-workbench-toolbar"><strong>{t('workbench.gitStatus')}</strong><HoverTooltip title={t('workbench.refresh')}><button type="button" className="pd-icon-button" onClick={() => setGitRevision((value) => value + 1)} aria-label={t('workbench.refreshGit')}><Icon name="refresh" width="15" height="15" /></button></HoverTooltip></div>
					{gitLoading && <div className="pd-workbench-empty">{t('workbench.loadingGit')}</div>}
					{gitError && <div className="pd-workbench-error" role="alert">{gitError}</div>}
					{!gitLoading && !gitError && gitStatus && (gitStatus.isRepository ? <>
						<div className="pd-workbench-branch"><Icon name="gitBranch" width="15" height="15" /><span>{gitStatus.branch || 'HEAD'}</span><small>{t('workbench.changes', { count: gitStatus.entries.length })}</small></div>
						<div className="pd-workbench-changes">
							{gitStatus.entries.map((entry) => <HoverTooltip key={entry.path} title={entry.path}><button type="button" className={`pd-workbench-change${diffPath === entry.path ? ' is-selected' : ''}`} onClick={() => void openDiff(entry.path)}><span className="pd-workbench-git-status">{entry.status.replaceAll(' ', '·')}</span><span>{entry.path}</span></button></HoverTooltip>)}
							{gitStatus.entries.length === 0 && <div className="pd-workbench-empty">{t('workbench.clean')}</div>}
						</div>
						{diffPath && <section className="pd-workbench-preview" aria-label={t('workbench.diff')}>
							<div className="pd-workbench-preview-head"><strong title={diffPath}>{diffPath}</strong><button type="button" className="pd-icon-button" onClick={() => setDiffPath(null)} aria-label={t('workbench.closeDiff')}><Icon name="close" width="14" height="14" /></button></div>
							{diffLoading ? <div className="pd-workbench-empty">{t('workbench.loadingDiff')}</div> : diffError ? <div className="pd-workbench-error" role="alert">{diffError}</div> : <pre>{diffText || t('workbench.noDiff')}</pre>}
						</section>}
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
						<div className="pd-workbench-command-result-head">
							<strong title={commandRun.command}>$ {commandRun.command}</strong>
							{commandRunning ? <button type="button" onClick={() => void stopCommand()} disabled={commandStopping}>{t(commandStopping ? 'workbench.stopping' : 'workbench.stop')}</button> : <span>{commandFailed ? t('workbench.failed') : t('workbench.exitCode', { code: finalEvent?.code ?? '—' })}</span>}
						</div>
						<div className="pd-workbench-command-location" title={commandRun.cwd}>{commandRun.cwd}</div>
						<pre aria-live="polite">{outputEvents.map((event, index) => <span className={event.type === 'stderr' || event.type === 'error' ? 'is-stderr' : ''} key={index}>{event.data}</span>)}{outputEvents.length === 0 && t(commandRunning ? 'workbench.waitingOutput' : 'workbench.noOutput')}</pre>
					</section>}
				</>}
			</div>
			</div>
		</aside>
	);
}
