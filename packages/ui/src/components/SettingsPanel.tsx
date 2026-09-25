import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { UiProviderAuthStatus, UiUpdateState } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Translate } from '../i18n';
import { Icon } from './Icons';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { ColorThemeSettings } from './ColorThemeSettings';
import { PersonalizationPanel } from './PersonalizationPanel';
import type { ThemeColorPreferences } from '../themeColors';
import type { ModelManagementTarget } from '../modelManagement';

export type ThemePreference = 'system' | 'dark' | 'light';
type SettingsPage = 'general' | 'appearance' | 'personalization' | 'model' | 'shortcuts' | 'updates' | 'about';

function authSourceLabel({ configured, source }: UiProviderAuthStatus, t: Translate): string {
	if (!configured) return t('settings.authMissing');
	switch (source) {
		case 'stored': return t('settings.authStored');
		case 'runtime': return t('settings.authRuntime');
		case 'environment': return t('settings.authEnvironment');
		case 'models_json_key': return t('settings.authModelKey');
		case 'models_json_command': return t('settings.authModelCommand');
		case 'fallback': return t('settings.authFallback');
		default: return t('settings.authAvailable');
	}
}

function ProviderCredentialRow({ provider, configured, source, supportsApiKey }: UiProviderAuthStatus) {
	const { t } = useT();
	const [secret, setSecret] = useState('');
	const [pending, setPending] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const status = useChatStore((s) => s.status);
	const settingsLoading = useChatStore((s) => s.settingsLoading);
	const setProviderApiKey = useChatStore((s) => s.setProviderApiKey);
	const removeProviderCredential = useChatStore((s) => s.removeProviderCredential);
	const canChange = status === 'idle' && !settingsLoading && !pending;

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = secret.trim();
		if (!value || !canChange) return;
		setSecret('');
		setPending(true);
		setFeedback(null);
		try {
			await setProviderApiKey(provider, value);
			setFeedback(t('settings.saved'));
		} catch (error) {
			setFeedback(t('settings.saveFailed', { error: error instanceof Error ? error.message : String(error) }));
		} finally {
			setPending(false);
		}
	}

	async function remove() {
		if (!canChange) return;
		setPending(true);
		setFeedback(null);
		try {
			await removeProviderCredential(provider);
			setFeedback(t('settings.removed'));
		} catch (error) {
			setFeedback(t('settings.removeFailed', { error: error instanceof Error ? error.message : String(error) }));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="pd-provider-card">
			<div className="pd-provider-card-heading"><strong>{provider}</strong><span className={`pd-provider-auth-state${configured ? ' is-configured' : ''}`}>{authSourceLabel({ provider, configured, source, supportsApiKey }, t)}</span></div>
			{supportsApiKey ? <form onSubmit={(event) => void save(event)} className="pd-provider-form">
				<label htmlFor={`pd-api-key-${provider}`}>{t('settings.apiKey')}</label>
				<div className="pd-provider-form-row">
					<input id={`pd-api-key-${provider}`} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" spellCheck={false} placeholder={t(configured ? 'settings.replaceKey' : 'settings.enterKey')} disabled={!canChange} />
					<button type="submit" className="pd-settings-primary" disabled={!secret.trim() || !canChange}>{t(pending ? 'settings.processing' : 'settings.save')}</button>
				</div>
			</form> : <p className="pd-provider-method-note">{t('settings.unsupportedKey')}</p>}
			{source === 'stored' && <button type="button" className="pd-settings-remove" onClick={() => void remove()} disabled={!canChange}>{t('settings.removeKey')}</button>}
			{feedback && <p className="pd-settings-feedback" role="status">{feedback}</p>}
		</div>
	);
}

export function SettingsPanel({ initialPage = 'general', modelManagementTarget, onClose, themePreference, onThemePreferenceChange, colorPreferences, onColorPreferencesChange, colorSaveFailed }: { initialPage?: 'general' | 'appearance' | 'model' | 'updates'; modelManagementTarget?: ModelManagementTarget; onClose(): void; themePreference: ThemePreference; onThemePreferenceChange(theme: ThemePreference): void; colorPreferences: ThemeColorPreferences; onColorPreferencesChange(preferences: ThemeColorPreferences): void; colorSaveFailed: boolean }) {
	const { t, locale, setLocale } = useT();
	const [page, setPage] = useState<SettingsPage>(initialPage);
	const [modelTarget, setModelTarget] = useState(modelManagementTarget);
	const [draftState, setDraftState] = useState({ dirty: false, saving: false });
	const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
	const keepEditingRef = useRef<HTMLButtonElement>(null);
	const wasConfirmingDiscard = useRef(false);
	const [updateState, setUpdateState] = useState<UiUpdateState | null>(null);
	const [updatePending, setUpdatePending] = useState(false);
	const [updateActionError, setUpdateActionError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	// Capture the opener before a child layout effect can focus a configuration target.
	const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const settingsError = useChatStore((s) => s.settingsError);
	const status = useChatStore((s) => s.status);
	const cwd = useChatStore((s) => s.cwd);
	const appInfo = useChatStore((s) => s.appInfo);
	const bridge = useChatStore((s) => s.bridge);
	const refreshModels = useChatStore((s) => s.refreshModels);
	const refreshProviderAuth = useChatStore((s) => s.refreshProviderAuth);
	const waitingForAgent = status === 'starting' || status === 'uninitialized';
	function requestLeave(action = onClose) {
		if (draftState.saving) return;
		if (draftState.dirty) setDiscardAction(() => action);
		else action();
	}
	useEffect(() => {
		if (discardAction) keepEditingRef.current?.focus();
		else if (wasConfirmingDiscard.current) closeRef.current?.focus();
		wasConfirmingDiscard.current = Boolean(discardAction);
	}, [discardAction]);
	function keepEditing() { setDiscardAction(null); setPage('personalization'); }

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let receivedEvent = false;
		const unsubscribe = bridge.onUpdateStateChanged((next) => {
			receivedEvent = true;
			if (active) {
				setUpdateState(next);
				if (next.phase !== 'error') setUpdateActionError(null);
			}
		});
		void bridge.getUpdateState().then((next) => { if (active && !receivedEvent) setUpdateState(next); }).catch((error: unknown) => {
			if (active) setUpdateActionError(error instanceof Error ? error.message : String(error));
		});
		return () => { active = false; unsubscribe(); };
	}, [bridge]);

	useEffect(() => {
		if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus();
		return () => {
			const canReceiveFocus = (element: HTMLElement | null): element is HTMLElement =>
				Boolean(element?.isConnected && !element.closest('[inert]') && element.getClientRects().length > 0);
			if (canReceiveFocus(returnFocus)) {
				returnFocus.focus();
				return;
			}
			const settingsEntry = document.querySelector<HTMLButtonElement>('.pd-settings-entry');
			const sidebarToggle = document.querySelector<HTMLButtonElement>('.pd-header-sidebar-toggle');
			if (canReceiveFocus(settingsEntry)) settingsEntry.focus();
			else if (canReceiveFocus(sidebarToggle)) sidebarToggle.focus();
		};
	}, [returnFocus]);

	useEffect(() => {
		if (waitingForAgent) return;
		void refreshModels().catch(() => {});
		void refreshProviderAuth().catch(() => {});
	}, [waitingForAgent, refreshModels, refreshProviderAuth]);

	function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Escape') { event.stopPropagation(); if (discardAction) keepEditing(); else requestLeave(); return; }
		if (event.key !== 'Tab') return;
		const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.matches(':disabled') && !element.closest('[inert]'));
		if (!elements?.length) return;
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	}

	async function checkForUpdates() {
		if (!bridge || updateBusy) return;
		setUpdatePending(true);
		setUpdateActionError(null);
		try { setUpdateState(await bridge.checkForUpdates()); }
		catch (error) { setUpdateActionError(error instanceof Error ? error.message : String(error)); }
		finally { setUpdatePending(false); }
	}

	async function installUpdate() {
		if (!bridge || updateBusy || !updateAvailable) return;
		setUpdatePending(true);
		setUpdateActionError(null);
		try { await bridge.installUpdate(); }
		catch (error) { setUpdateActionError(error instanceof Error ? error.message : String(error)); }
		finally { setUpdatePending(false); }
	}

	const updateBusy = updatePending || Boolean(updateState?.installRequested) || updateState?.phase === 'installing';
	const updateAvailable = updateState?.phase === 'downloading' || updateState?.phase === 'ready' || updateState?.phase === 'installing'
		|| Boolean(updateState?.availableVersion && (updateState.phase === 'error' || updateState.phase === 'checking'));
	const updateStatus = updateState?.phase === 'unavailable'
		? t(`settings.updateUnavailable.${updateState.unavailableReason ?? 'unsupported'}`)
		: updateState?.phase === 'installing' ? t('settings.updateInstalling')
		: updateState?.installRequested ? t('settings.updateRequestedNotice')
		: updateState?.phase === 'checking' ? t('settings.updateChecking')
		: updateState?.phase === 'downloading' ? t('settings.updateDownloading', { percent: Math.round(updateState.progressPercent ?? 0) })
		: updateState?.phase === 'ready' ? t('settings.updateReady', { version: updateState.availableVersion ?? '' })
		: updateState?.phase === 'up-to-date' ? t('settings.updateCurrent')
		: updateState?.phase === 'error' ? t('settings.updateFailed')
		: t('settings.updateIdle');

	return (
		<div className="pd-settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !discardAction) requestLeave(); }}>
			<div ref={dialogRef} className="pd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-settings-title" onKeyDown={onDialogKeyDown}>
				<header className="pd-settings-header" inert={Boolean(discardAction)}><div><span className="pd-settings-eyebrow">PI DESKTOP</span><h1 id="pd-settings-title">{t('settings.title')}</h1></div><button ref={closeRef} type="button" className="pd-icon-button" disabled={draftState.saving} onClick={() => requestLeave()} aria-label={t('settings.close')}><Icon name="close" /></button></header>
				{discardAction && <div className="pd-settings-discard" role="alertdialog" aria-modal="true" aria-labelledby="pd-discard-title" aria-describedby="pd-discard-description"><h2 id="pd-discard-title">{t('personalization.discardTitle')}</h2><p id="pd-discard-description">{t('personalization.discardDescription')}</p><div className="pd-instruction-actions"><button ref={keepEditingRef} className="pd-instruction-button" type="button" onClick={keepEditing}>{t('personalization.keepEditing')}</button><button className="pd-instruction-button" type="button" onClick={discardAction}>{t('personalization.discard')}</button></div></div>}
				<div className="pd-settings-layout" inert={Boolean(discardAction)}>
					<nav className="pd-settings-nav" aria-label={t('settings.category')}>
						<button type="button" className={page === 'general' ? 'is-active' : ''} aria-current={page === 'general' ? 'page' : undefined} onClick={() => setPage('general')}>{t('settings.general')}</button>
						<button type="button" className={page === 'appearance' ? 'is-active' : ''} aria-current={page === 'appearance' ? 'page' : undefined} onClick={() => setPage('appearance')}>{t('settings.appearance')}</button>
						<button type="button" className={page === 'personalization' ? 'is-active' : ''} aria-current={page === 'personalization' ? 'page' : undefined} onClick={() => setPage('personalization')}>{t('settings.personalization')}</button>
						<button type="button" className={page === 'model' ? 'is-active' : ''} aria-current={page === 'model' ? 'page' : undefined} onClick={() => { if (page !== 'model') { setModelTarget(undefined); setPage('model'); } }}>{t('settings.modelManagement')}</button>
						<button type="button" className={page === 'shortcuts' ? 'is-active' : ''} aria-current={page === 'shortcuts' ? 'page' : undefined} onClick={() => setPage('shortcuts')}>{t('settings.shortcuts')}</button>
						<button type="button" className={page === 'updates' ? 'is-active' : ''} aria-current={page === 'updates' ? 'page' : undefined} onClick={() => setPage('updates')}>{t('settings.updates')}</button>
						<button type="button" className={page === 'about' ? 'is-active' : ''} aria-current={page === 'about' ? 'page' : undefined} onClick={() => setPage('about')}>{t('settings.about')}</button>
					</nav>
					<div className="pd-settings-content">
						{settingsError && <div className="pd-settings-error" role="alert">{settingsError}</div>}
						<PersonalizationPanel active={page === 'personalization'} onDraftStateChange={setDraftState} />
						{page === 'general' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.general')}</h2><p>{t('settings.generalDescription')}</p></div>
							<div className="pd-settings-section-head"><h3>{t('settings.language')}</h3><p>{t('settings.languageDescription')}</p></div>
							<div className="pd-language-options" role="group" aria-label={t('settings.language')}>
								<button type="button" className={locale === 'zh-CN' ? 'is-selected' : ''} aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>{t('settings.languageZh')}</button>
								<button type="button" className={locale === 'en-US' ? 'is-selected' : ''} aria-pressed={locale === 'en-US'} onClick={() => setLocale('en-US')}>{t('settings.languageEn')}</button>
							</div>
						</>}
						{page === 'appearance' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.appearance')}</h2><p>{t('settings.appearanceDescription')}</p></div>
							<div className="pd-appearance-options" role="group" aria-label={t('settings.themeLabel')}>
								{(['system', 'dark', 'light'] as const).map((theme) => <button type="button" key={theme} className={`pd-appearance-choice${themePreference === theme ? ' is-selected' : ''}`} aria-pressed={themePreference === theme} onClick={() => onThemePreferenceChange(theme)}><span className={`pd-theme-swatch is-${theme}`} aria-hidden="true" /><strong>{t(theme === 'system' ? 'settings.themeSystem' : theme === 'dark' ? 'settings.themeDark' : 'settings.themeLight')}</strong></button>)}
							</div>
							<div className="pd-settings-divider" />
							<ColorThemeSettings themePreference={themePreference} preferences={colorPreferences} onChange={onColorPreferencesChange} saveFailed={colorSaveFailed} />
						</>}
						{page === 'model' && <ModelSettingsPanel key={cwd} initialTarget={modelTarget} renderCredential={(provider) => <ProviderCredentialRow key={provider.provider} {...provider} />} />}
						{page === 'shortcuts' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.shortcuts')}</h2><p>{t('settings.shortcutsDescription')}</p></div>
							<dl className="pd-shortcut-list"><div><dt>{t('settings.shortcutSearch')}</dt><dd><kbd>{appInfo?.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd> + <kbd>K</kbd></dd></div><div><dt>{t('settings.shortcutSidebar')}</dt><dd><kbd>{appInfo?.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd> + <kbd>B</kbd></dd></div><div><dt>{t('settings.shortcutSend')}</dt><dd><kbd>Enter</kbd></dd></div><div><dt>{t('settings.shortcutNewline')}</dt><dd><kbd>Shift</kbd> + <kbd>Enter</kbd></dd></div><div><dt>{t('settings.shortcutClose')}</dt><dd><kbd>Esc</kbd></dd></div></dl>
						</>}
						{page === 'updates' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.updates')}</h2><p>{t('settings.updateDescription')}</p></div>
							<div className="pd-update-card" aria-live="polite">
								<strong>{updateStatus}</strong>
								<span>{t('settings.updateInstalled', { version: updateState?.currentVersion ?? appInfo?.appVersion ?? '—' })}</span>
								{updateState?.phase === 'downloading' && <progress max={100} value={updateState.progressPercent ?? 0} aria-label={t('settings.updateProgress')} />}
								{updateState?.error && <p className="pd-settings-error" role="alert">{updateState.error}</p>}
								{updateActionError && <p className="pd-settings-error" role="alert">{updateActionError}</p>}
								<div className="pd-update-actions">
									<button type="button" className="pd-extension-refresh" onClick={() => void checkForUpdates()} disabled={!bridge || updateBusy || !updateState || !['idle', 'up-to-date', 'error'].includes(updateState.phase)}>{t('settings.updateCheck')}</button>
									{updateAvailable && <button type="button" className="pd-extension-refresh" onClick={() => void installUpdate()} disabled={!bridge || updateBusy}>{t(updateState?.phase === 'ready' ? 'settings.updateInstall' : 'settings.updateNow')}</button>}
								</div>
							</div>
						</>}
						{page === 'about' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.aboutTitle')}</h2><p>{t('settings.aboutDescription')}</p></div>
							<dl className="pd-about-list"><div><dt>{t('settings.appVersion')}</dt><dd>{appInfo?.appVersion ?? t('settings.unknown')}</dd></div><div><dt>Electron</dt><dd>{appInfo?.electronVersion ?? '—'}</dd></div><div><dt>Node.js</dt><dd>{appInfo?.nodeVersion ?? '—'}</dd></div><div><dt>{t('settings.platform')}</dt><dd>{appInfo?.platform ?? '—'}</dd></div><div><dt>{t('settings.currentWorkspace')}</dt><dd title={cwd}>{cwd || t('settings.noWorkspace')}</dd></div></dl>
						</>}
					</div>
				</div>
			</div>
		</div>
	);
}
