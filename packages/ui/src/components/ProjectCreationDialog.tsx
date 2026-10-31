import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import './projectCreationDialog.css';

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const childPath = (parent: string, name: string) => `${parent.replace(/[\\/]+$/, '')}${parent.includes('\\') ? '\\' : '/'}${name}`;

export function ProjectCreationDialog({ onClose, onCreated }: { onClose(opened: boolean): void; onCreated?: (workspace: string) => void }) {
	const { t } = useT();
	const bridge = useChatStore(state => state.bridge);
	const switchWorkspace = useChatStore(state => state.switchWorkspace);
	const refreshWorkspaces = useChatStore(state => state.refreshWorkspaces);
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const mounted = useRef(false);
	const lock = useRef(false);
	const retryActivation = useRef(false);
	const [source, setSource] = useState<'create' | 'existing'>('create');
	const [name, setName] = useState('');
	const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
	const [directory, setDirectory] = useState<string | null>(null);
	const [directoryError, setDirectoryError] = useState<string | null>(null);
	const [directoryRequest, setDirectoryRequest] = useState(0);
	const [createdFolder, setCreatedFolder] = useState<string | null>(null);
	const [busy, setBusy] = useState<'pick' | 'create' | 'open' | null>(null);
	const [error, setError] = useState<string | null>(null);
	const locked = busy !== null || createdFolder !== null;
	const preview = source === 'existing' ? selectedFolder : createdFolder ?? (directory ? childPath(directory, name.trim() || t('projectCreate.name')) : null);
	const canSubmit = Boolean(bridge && !busy && (createdFolder || (source === 'create' ? directory && name.trim() : selectedFolder)));

	useEffect(() => {
		mounted.current = true;
		const node = dialog.current;
		node?.showModal();
		nameInput.current?.focus();
		return () => { mounted.current = false; node?.close(); };
	}, []);
	useEffect(() => {
		if (!bridge) return;
		let cancelled = false;
		setDirectory(null); setDirectoryError(null);
		void bridge.getProjectsDirectory().then(path => { if (!cancelled) setDirectory(path); })
			.catch((cause: unknown) => { if (!cancelled) setDirectoryError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { cancelled = true; };
	}, [bridge, directoryRequest]);

	function close(opened: boolean) {
		dialog.current?.close();
		onClose(opened);
	}
	async function chooseFolder() {
		if (!bridge || lock.current) return;
		lock.current = true; setBusy('pick'); setError(null);
		try {
			const path = await bridge.pickWorkspace();
			if (mounted.current && useChatStore.getState().bridge === bridge && path) {
				if (path !== selectedFolder) retryActivation.current = false;
				setSelectedFolder(path);
			}
		} catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { lock.current = false; if (mounted.current) setBusy(null); }
	}
	async function submit() {
		if (!bridge || !canSubmit || lock.current) return;
		lock.current = true; setError(null);
		setBusy(source === 'create' && !createdFolder ? 'create' : 'open');
		const current = () => mounted.current && useChatStore.getState().bridge === bridge;
		try {
			let path = createdFolder ?? selectedFolder;
			if (source === 'create' && !createdFolder) {
				path = await bridge.createProject(name.trim());
				if (!current()) return;
				// Retry opening the directory if activation fails, without creating it again.
				setCreatedFolder(path);
				await refreshWorkspaces();
			}
			if (!path || !current()) return;
			setBusy('open');
			try {
				await switchWorkspace(path, retryActivation.current ? { force: true } : undefined);
				retryActivation.current = false;
			} catch (cause) { retryActivation.current = true; throw cause; }
			if (current()) { onCreated?.(path); close(true); }
		} catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { lock.current = false; if (mounted.current) setBusy(null); }
	}

	return createPortal(<dialog ref={dialog} className="pd-project-create-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy !== null}
		onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!lock.current) close(false); }}>
		<form onSubmit={event => { event.preventDefault(); void submit(); }}>
			<header><h2 id={`${id}-title`}>{t('projectCreate.title')}</h2><button type="button" className="pd-icon-button" aria-label={t('projectCreate.close')} disabled={busy !== null} onClick={() => close(false)}><Icon name="close" width="17" height="17" /></button></header>
			<div className="pd-project-create-name"><span aria-hidden="true"><Icon name="folder" width="19" height="19" /></span><input ref={nameInput} autoFocus name="projectName" aria-label={t('projectCreate.name')} placeholder={t('projectCreate.name')} autoComplete="off" maxLength={120} value={source === 'existing' ? selectedFolder ? folderName(selectedFolder) : '' : name} readOnly={source === 'existing' || createdFolder !== null} disabled={busy !== null} onChange={event => { setName(event.target.value); setError(null); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} /></div>
			<label className="pd-project-create-source-label" htmlFor={`${id}-source`}>{t('projectCreate.source')}</label>
			<div className="pd-project-create-source">
				<div className="pd-project-create-source-picker"><select id={`${id}-source`} name="projectSource" value={source} disabled={locked} onChange={event => { setSource(event.target.value as 'create' | 'existing'); setError(null); }}><option value="create">{t('projectCreate.createFolder')}</option><option value="existing">{t('projectCreate.existingFolder')}</option></select><Icon name="chevronDown" width="13" height="13" /></div>
				{source === 'create' ? <>
					{directoryError ? <div className="pd-project-create-directory-error"><p role="alert">{directoryError}</p><button type="button" onClick={() => setDirectoryRequest(value => value + 1)}>{t('projectCreate.retry')}</button></div> : <p className="pd-project-create-path" aria-live="polite">{preview ?? t('projectCreate.loadingDirectory')}</p>}
					{createdFolder && <p className="pd-project-create-hint">{t('projectCreate.created')}</p>}
				</> : <>
					{selectedFolder && <p className="pd-project-create-path">{selectedFolder}</p>}
					<button type="button" className="pd-project-create-choose" data-action="choose-folder" disabled={busy !== null} onClick={() => void chooseFolder()}><Icon name="folder" width="16" height="16" />{t(busy === 'pick' ? 'projectCreate.choosing' : selectedFolder ? 'projectCreate.changeFolder' : 'projectCreate.addFolder')}</button>
				</>}
			</div>
			{error && <p className="pd-project-create-error" role="alert">{error}</p>}
			<footer><button type="button" data-action="cancel" className="pd-project-create-cancel" disabled={busy !== null} onClick={() => close(false)}>{t('sidebar.cancel')}</button><button type="submit" className="pd-project-create-submit" disabled={!canSubmit}>{t(busy === 'create' ? 'projectCreate.creating' : busy === 'open' ? 'projectCreate.opening' : createdFolder ? 'sidebar.openProject' : source === 'existing' ? 'projectCreate.addProject' : 'projectCreate.title')}</button></footer>
		</form>
	</dialog>, document.body);
}
