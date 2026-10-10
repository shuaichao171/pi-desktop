import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import type { SettingsDraftState } from '../settingsLeaveGuard';
import { Icon } from './Icons';
import { SettingsRow } from './SettingsRows';
import './conversationStorageSettings.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ConversationStorageSettings({ onDraftStateChange }: { onDraftStateChange(state: SettingsDraftState): void }) {
	const { t } = useT();
	const bridge = useChatStore(state => state.bridge);
	const id = useId();
	const mounted = useRef(false);
	const lock = useRef(false);
	const [directory, setDirectory] = useState('');
	const [savedDirectory, setSavedDirectory] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [pending, setPending] = useState<'pick' | 'save' | null>(null);
	const dirty = savedDirectory !== null && directory !== savedDirectory;
	const disabled = !bridge || savedDirectory === null || pending !== null;
	const saveRef = useRef<() => Promise<boolean>>(async () => false);
	const saveDraft = useCallback(() => saveRef.current(), []);

	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => { onDraftStateChange({ dirty, saving: pending !== null, save: dirty ? saveDraft : undefined }); }, [dirty, pending, saveDraft, onDraftStateChange]);
	useEffect(() => () => onDraftStateChange({ dirty: false, saving: false }), [onDraftStateChange]);
	useEffect(() => {
		if (!bridge) return;
		let current = true;
		setSavedDirectory(null); setLoadError(null); setError(null); setSaved(false);
		void bridge.getDesktopSettings().then(settings => {
			if (!current) return;
			setDirectory(settings.conversationStorageDirectory);
			setSavedDirectory(settings.conversationStorageDirectory);
		}).catch((cause: unknown) => { if (current) setLoadError(errorText(cause)); });
		return () => { current = false; };
	}, [bridge, attempt]);

	async function chooseDirectory() {
		if (!bridge || disabled || lock.current) return;
		lock.current = true; setPending('pick'); setError(null); setSaved(false);
		try {
			const path = await bridge.pickConversationStorageDirectory();
			if (mounted.current && useChatStore.getState().bridge === bridge && path) setDirectory(path);
		} catch (cause) { if (mounted.current) setError(errorText(cause)); }
		finally { lock.current = false; if (mounted.current) setPending(null); }
	}

	async function save(): Promise<boolean> {
		if (!bridge || disabled || lock.current || !directory.trim()) return false;
		lock.current = true; setPending('save'); setError(null); setSaved(false);
		const current = () => mounted.current && useChatStore.getState().bridge === bridge;
		try {
			const settings = await bridge.setDesktopSettings({ conversationStorageDirectory: directory.trim() });
			if (!current()) return false;
			setDirectory(settings.conversationStorageDirectory);
			setSavedDirectory(settings.conversationStorageDirectory);
			await useChatStore.getState().refreshWorkspaces();
			if (!current()) return false;
			setSaved(true);
			return true;
		} catch (cause) { if (current()) setError(errorText(cause)); return false; }
		finally { lock.current = false; if (mounted.current) setPending(null); }
	}
	saveRef.current = save;

	return <section className="pd-conversation-storage" data-setting="conversation-storage" aria-labelledby={`${id}-title`}>
		<SettingsRow stacked title={t('settings.conversationStorage')} description={<span id={`${id}-description`}>{t('settings.conversationStorageDescription')}</span>}>
			{loadError ? <div className="pd-conversation-storage-error" role="alert"><p>{loadError}</p><button type="button" className="pd-conversation-storage-choose" onClick={() => setAttempt(value => value + 1)}>{t('projectCreate.retry')}</button></div> : savedDirectory === null ? <p className="pd-settings-feedback" role="status">{t('settings.conversationStorageLoading')}</p> : <form onSubmit={event => { event.preventDefault(); if (dirty) void save(); }} aria-busy={pending !== null}>
				<div className="pd-conversation-storage-field">
					<input id={`${id}-title`} name="conversationStorageDirectory" aria-label={t('settings.conversationStorage')} aria-describedby={`${id}-description`} value={directory} disabled={disabled} autoComplete="off" spellCheck={false} title={directory || undefined} onChange={event => { setDirectory(event.target.value); setError(null); setSaved(false); }} />
					<button type="button" className="pd-conversation-storage-choose" data-action="choose-conversation-storage" disabled={disabled} onClick={() => void chooseDirectory()}><Icon name="folder" width="15" height="15" />{t(pending === 'pick' ? 'projectCreate.choosing' : 'settings.conversationStorageChoose')}</button>
					{dirty && <button type="submit" className="pd-settings-primary" data-action="save-conversation-storage" disabled={disabled || !directory.trim()}>{t(pending === 'save' ? 'settings.processing' : 'settings.save')}</button>}
				</div>
				{error && <p className="pd-conversation-storage-error" role="alert">{error}</p>}
				{saved && <p className="pd-settings-feedback is-success" role="status"><Icon name="check" width="13" height="13" />{t('settings.conversationStorageSaved')}</p>}
			</form>}
		</SettingsRow>
	</section>;
}
