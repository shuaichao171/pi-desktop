import { McpSettingsPanel } from './McpSettingsPanel';
import { ModelTestPanel } from './ModelTestPanel';
import { DataManagementPanel } from './DataManagementPanel';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { UiDesktopSettings, UiProviderAuthStatus, UiUpdateState } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Translate } from '../i18n';
import { Icon } from './Icons';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { CONTENT_FONT_MIN, CONTENT_FONT_MAX, DEFAULT_CONTENT_FONT_SIZE, readContentFontSize, saveContentFontSize, type ContentFontKind } from '../contentFontSize';
import { ShortcutSettings } from './ShortcutSettings';
import { ColorThemeSettings } from './ColorThemeSettings';
import { PersonalizationPanel } from './PersonalizationPanel';
import type { ThemeColorPreferences } from '../themeColors';
import type { ModelManagementTarget } from '../modelManagement';
import { DEFAULT_UI_FONT_SIZE, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN, applyUiFontSize, readUiFontSize, saveUiFontSize } from '../uiFontSize';
import { createSettingsLeaveGuard, type SettingsDraftState as DraftState, type SettingsLeaveRequest } from '../settingsLeaveGuard';

export type ThemePreference = 'system' | 'dark' | 'light';
type SettingsPage = 'general' | 'appearance' | 'personalization' | 'model' | 'shortcuts' | 'updates' | 'data' | 'mcp';
type DraftFocus = { element: HTMLElement; selection?: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } };
type PendingLeave = SettingsLeaveRequest<SettingsPage, DraftFocus | null>;

function captureDraftFocus(element: HTMLElement | null): DraftFocus | null {
	if (!element) return null;
	const selection = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.selectionStart !== null && element.selectionEnd !== null
		? { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection ?? 'none' } : undefined;
	return { element, selection };
}

function canFocus(element: HTMLElement | null): element is HTMLElement {
	return Boolean(element?.isConnected && !element.closest('[inert], [hidden]') && !element.matches(':disabled') && element.getClientRects().length > 0);
}

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

function ProviderCredentialRow({ provider, configured, source, supportsApiKey, onDraftStateChange }: UiProviderAuthStatus & { onDraftStateChange?(state: DraftState): void }) {
	const { t } = useT();
	const [secret, setSecret] = useState('');
	const [pending, setPending] = useState(false);
	const saveLock = useRef(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const status = useChatStore((s) => s.status);
	const settingsLoading = useChatStore((s) => s.settingsLoading);
	const setProviderApiKey = useChatStore((s) => s.setProviderApiKey);
	const removeProviderCredential = useChatStore((s) => s.removeProviderCredential);
	const canChange = status === 'idle' && !settingsLoading && !pending;
	const saveRef = useRef<() => Promise<boolean>>(async () => false);
	const saveDraft = useCallback(() => saveRef.current(), []);
	useEffect(() => { onDraftStateChange?.({ dirty: Boolean(secret), saving: pending, save: secret ? saveDraft : undefined }); }, [secret, pending, saveDraft, onDraftStateChange]);

	async function save(event?: FormEvent<HTMLFormElement>): Promise<boolean> {
		event?.preventDefault();
		const value = secret.trim();
		if (!value || !canChange || saveLock.current) return false;
		saveLock.current = true;
		setPending(true);
		setFeedback(null);
		try {
			await setProviderApiKey(provider, value);
			setSecret('');
			setFeedback(t('settings.saved'));
			return true;
		} catch (error) {
			setFeedback(t('settings.saveFailed', { error: error instanceof Error ? error.message : String(error) }));
			return false;
		} finally {
			saveLock.current = false;
			setPending(false);
		}
	}

	saveRef.current = () => save();

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
	const [draftState, setDraftState] = useState<DraftState>({ dirty: false, saving: false });
	const [leaveGuard] = useState(() => createSettingsLeaveGuard<SettingsPage, DraftFocus | null>());
	const reportDraftState = useCallback((next: DraftState) => {
		leaveGuard.report(next);
		setDraftState((previous) => previous.dirty === next.dirty && previous.saving === next.saving && Boolean(previous.save) === Boolean(next.save) ? previous : next);
	}, [leaveGuard]);
	const [uiFontSize, setUiFontSize] = useState(readUiFontSize);
	const [contentFonts, setContentFonts] = useState(() => ({ code: readContentFontSize('code'), command: readContentFontSize('command') }));
	const [savingLeave, setSavingLeave] = useState(false);
	const [leaveError, setLeaveError] = useState(false);
	const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
	const draftFocusRef = useRef<HTMLElement | null>(null);
	const restoreDraftFocusRef = useRef<DraftFocus | null>(null);
	const focusCategoryRef = useRef(false);
	const keepEditingRef = useRef<HTMLButtonElement>(null);
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
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const request = leaveGuard.request({ action, page, focus: captureDraftFocus(canFocus(draftFocusRef.current) ? draftFocusRef.current : active) });
		if (request) { setLeaveError(false); setPendingLeave(request); }
	}
	function selectPage(next: SettingsPage) {
		if (next === page) return;
		requestLeave(() => {
			if (next === 'model') setModelTarget(undefined);
			draftFocusRef.current = null;
			focusCategoryRef.current = true;
			setPage(next);
		});
	}
	function keepEditing() {
		const request = leaveGuard.keepEditing();
		if (!request) return;
		restoreDraftFocusRef.current = request.focus;
		setPendingLeave(null);
		setPage(request.page);
	}
	async function saveAndLeave() {
		if (savingLeave) return;
		setSavingLeave(true); setLeaveError(false);
		try { const request = await leaveGuard.takeSaved(); if (request) { setPendingLeave(null); reportDraftState({ dirty: false, saving: false }); request.action(); } else setLeaveError(true); } catch { setLeaveError(true); } finally { setSavingLeave(false); }
	}
	function discardChanges() {
		const request = leaveGuard.takeDiscard();
		if (!request) return;
		setPendingLeave(null);
		reportDraftState({ dirty: false, saving: false });
		request.action();
	}
	useEffect(() => {
		if (pendingLeave) { keepEditingRef.current?.focus(); return; }
		const target = restoreDraftFocusRef.current;
		restoreDraftFocusRef.current = null;
		if (target && canFocus(target.element)) {
			target.element.focus({ preventScroll: true });
			if (target.selection && (target.element instanceof HTMLInputElement || target.element instanceof HTMLTextAreaElement)) {
				target.element.setSelectionRange(target.selection.start, target.selection.end, target.selection.direction);
			}
		} else if (target || focusCategoryRef.current) {
			dialogRef.current?.querySelector<HTMLButtonElement>('.pd-settings-nav [aria-current="page"]')?.focus();
		}
		focusCategoryRef.current = false;
	}, [pendingLeave, page]);

	const [desktopSettings, setDesktopSettings] = useState<UiDesktopSettings | null>(null);
	const [desktopSettingsError, setDesktopSettingsError] = useState<string | null>(null);
	const [savingDesktopSettings, setSavingDesktopSettings] = useState(false);
	const desktopSettingsPending = useRef(false);
	async function saveDesktopSettings(patch: Partial<UiDesktopSettings>): Promise<void> {
		if (!bridge?.setDesktopSettings || desktopSettingsPending.current) return;
		desktopSettingsPending.current = true;
		setSavingDesktopSettings(true);
		setDesktopSettingsError(null);
		try { setDesktopSettings(await bridge.setDesktopSettings(patch)); }
		catch (error) { setDesktopSettingsError(error instanceof Error ? error.message : String(error)); }
		finally { desktopSettingsPending.current = false; setSavingDesktopSettings(false); }
	}
	useEffect(() => {
		if (!bridge?.getDesktopSettings) return;
		let active = true;
		void bridge.getDesktopSettings().then((next) => { if (active) setDesktopSettings(next); }).catch((error: unknown) => {
			if (active) setDesktopSettingsError(error instanceof Error ? error.message : String(error));
		});
		return () => { active = false; };
	}, [bridge]);

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
		if (!dialogRef.current?.contains(document.activeElement) && !document.querySelector('dialog[open]')?.contains(document.activeElement)) closeRef.current?.focus();
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
		// Portaled native model editors own their modal focus boundary and Escape.
		if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
		if (event.defaultPrevented || event.nativeEvent.isComposing) return;
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (leaveGuard.pending) keepEditing(); else requestLeave(); return; }
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
		try { setUpdateState(await bridge.checkForUpdates(false)); }
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

	const updateBusy = updatePending || Boolean(updateState?.installRequested) || updateState?.phase === 'checking' || updateState?.phase === 'downloading' || updateState?.phase === 'installing';
	const updateAvailable = updateState?.phase === 'available' || updateState?.phase === 'ready'
		|| Boolean(updateState?.availableVersion && updateState.phase === 'error');
	const updateStatus = updateState?.phase === 'unavailable'
		? t(`settings.updateUnavailable.${updateState.unavailableReason ?? 'unsupported'}`)
		: updateState?.phase === 'installing' ? t('settings.updateInstalling')
		: updateState?.installRequested ? t('settings.updateRequestedNotice')
		: updateState?.phase === 'checking' ? t('settings.updateChecking')
		: updateState?.phase === 'downloading' ? t('settings.updateDownloading', { percent: Math.round(updateState.progressPercent ?? 0) })
		: updateState?.phase === 'ready' ? t('settings.updateReady', { version: updateState.availableVersion ?? '' })
		: updateState?.phase === 'available' ? t('settings.updateAvailableVersion', { version: updateState.availableVersion ?? '' })
		: updateState?.phase === 'up-to-date' ? t('settings.updateCurrent')
		: updateState?.phase === 'error' ? t('settings.updateFailed')
		: t('settings.updateIdle');

	return (
		<div className="pd-settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !pendingLeave) requestLeave(); }}>
			<div ref={dialogRef} className="pd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-settings-title" onKeyDown={onDialogKeyDown}>
				<header className="pd-settings-header" inert={Boolean(pendingLeave)}><div><span className="pd-settings-eyebrow">PI DESKTOP</span><h1 id="pd-settings-title">{t('settings.title')}</h1></div><button ref={closeRef} type="button" className="pd-icon-button" disabled={draftState.saving} onClick={() => requestLeave()} aria-label={t('settings.close')}><Icon name="close" /></button></header>
				{pendingLeave && <div className="pd-settings-discard" role="alertdialog" aria-modal="true" aria-labelledby="pd-discard-title" aria-describedby="pd-discard-description"><h2 id="pd-discard-title">{t('settings.discardTitle')}</h2><p id="pd-discard-description">{t('settings.discardDescription')}</p><div className="pd-instruction-actions"><button ref={keepEditingRef} className="pd-instruction-button" type="button" disabled={savingLeave} onClick={keepEditing}>{t('personalization.keepEditing')}</button><button className="pd-instruction-button" type="button" disabled={savingLeave} onClick={discardChanges}>{t('personalization.discard')}</button>{draftState.save && <button className="pd-settings-primary" data-action="save-settings-and-leave" type="button" disabled={savingLeave} onClick={() => void saveAndLeave()}>{savingLeave ? t('personalization.saving') : locale === 'zh-CN' ? '保存并继续' : 'Save and continue'}</button>}</div>{leaveError && <p role="alert">{locale === 'zh-CN' ? '保存失败，请继续编辑并查看错误。草稿已保留。' : 'Saving failed. Continue editing to review the error; your draft is preserved.'}</p>}</div>}
				<div className="pd-settings-layout" inert={Boolean(pendingLeave)}>
					<nav className="pd-settings-nav" aria-label={t('settings.category')}>
						<button type="button" className={page === 'general' ? 'is-active' : ''} aria-current={page === 'general' ? 'page' : undefined} onClick={() => selectPage('general')}>{t('settings.general')}</button>
						<button type="button" className={page === 'appearance' ? 'is-active' : ''} aria-current={page === 'appearance' ? 'page' : undefined} onClick={() => selectPage('appearance')}>{t('settings.appearance')}</button>
						<button type="button" className={page === 'personalization' ? 'is-active' : ''} aria-current={page === 'personalization' ? 'page' : undefined} onClick={() => selectPage('personalization')}>{t('settings.personalization')}</button>
						<button type="button" className={page === 'model' ? 'is-active' : ''} aria-current={page === 'model' ? 'page' : undefined} onClick={() => selectPage('model')}>{t('settings.modelManagement')}</button>
						<button type="button" className={page === 'shortcuts' ? 'is-active' : ''} aria-current={page === 'shortcuts' ? 'page' : undefined} onClick={() => selectPage('shortcuts')}>{t('settings.shortcuts')}</button>
						<button type="button" className={page === 'updates' ? 'is-active' : ''} aria-current={page === 'updates' ? 'page' : undefined} onClick={() => selectPage('updates')}>{t('settings.updates')}</button>
						<button type="button" className={page === 'mcp' ? 'is-active' : ''} aria-current={page === 'mcp' ? 'page' : undefined} onClick={() => selectPage('mcp')}>MCP</button>
						<button type="button" className={page === 'data' ? 'is-active' : ''} aria-current={page === 'data' ? 'page' : undefined} onClick={() => selectPage('data')}>{locale === 'zh-CN' ? '数据管理' : 'Data management'}</button>
					</nav>
					<div className="pd-settings-content" onFocusCapture={(event) => { if (event.target instanceof HTMLElement) draftFocusRef.current = event.target; }}>
						{settingsError && <div className="pd-settings-error" role="alert">{settingsError}</div>}
						{page === 'data' && <DataManagementPanel />}
						{page === 'mcp' && <McpSettingsPanel />}
						{page === 'personalization' && <PersonalizationPanel active onDraftStateChange={reportDraftState} />}
						{page === 'general' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.general')}</h2><p>{t('settings.generalDescription')}</p></div>
							<div className="pd-settings-section-head"><h3>{t('settings.language')}</h3><p>{t('settings.languageDescription')}</p></div>
							<div className="pd-language-options" data-setting="language" role="group" aria-label={t('settings.language')}>
								<button type="button" className={locale === 'zh-CN' ? 'is-selected' : ''} aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>{t('settings.languageZh')}</button>
								<button type="button" className={locale === 'en-US' ? 'is-selected' : ''} aria-pressed={locale === 'en-US'} onClick={() => setLocale('en-US')}>{t('settings.languageEn')}</button>
						</div>
						<div className="pd-settings-section-head"><h3>{t('settings.notifications')}</h3><p>{t('settings.notificationsDescription')}</p></div>
						{desktopSettingsError && <p role="alert">{desktopSettingsError}</p>}
						{desktopSettings && (
							<div className="pd-language-options" data-setting="notifications" role="group" aria-label={t('settings.notifications')}>
								<button type="button" className={desktopSettings.notificationsEnabled ? 'is-selected' : ''} aria-pressed={desktopSettings.notificationsEnabled}
									disabled={savingDesktopSettings} onClick={() => { void saveDesktopSettings({ notificationsEnabled: true }); }}>{t('settings.notificationsOn')}</button>
								<button type="button" className={!desktopSettings.notificationsEnabled ? 'is-selected' : ''} aria-pressed={!desktopSettings.notificationsEnabled}
									disabled={savingDesktopSettings} onClick={() => { void saveDesktopSettings({ notificationsEnabled: false }); }}>{t('settings.notificationsOff')}</button>
							</div>
						)}
						{appInfo?.platform === 'win32' && desktopSettings && (
							<>
								<div className="pd-settings-section-head"><h3>{t('settings.closeBehavior')}</h3><p>{t('settings.closeBehaviorDescription')}</p></div>
									<div className="pd-language-options" data-setting="tray" role="group" aria-label={t('settings.closeBehavior')}>
										<button type="button" className={desktopSettings.closeBehavior === 'tray' ? 'is-selected' : ''} aria-pressed={desktopSettings.closeBehavior === 'tray'}
											disabled={savingDesktopSettings} onClick={() => { void saveDesktopSettings({ closeBehavior: 'tray' }); }}>{t('settings.closeBehaviorTray')}</button>
										<button type="button" className={desktopSettings.closeBehavior === 'quit' ? 'is-selected' : ''} aria-pressed={desktopSettings.closeBehavior === 'quit'}
											disabled={savingDesktopSettings} onClick={() => { void saveDesktopSettings({ closeBehavior: 'quit' }); }}>{t('settings.closeBehaviorQuit')}</button>
									</div>
								</>
						) }
						</>}
						{page === 'appearance' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.appearance')}</h2><p>{t('settings.appearanceDescription')}</p></div>
							<div className="pd-appearance-options" role="group" aria-label={t('settings.themeLabel')}>
								{(['system', 'dark', 'light'] as const).map((theme) => <button type="button" key={theme} className={`pd-appearance-choice${themePreference === theme ? ' is-selected' : ''}`} aria-pressed={themePreference === theme} onClick={() => onThemePreferenceChange(theme)}><span className={`pd-theme-swatch is-${theme}`} aria-hidden="true" /><strong>{t(theme === 'system' ? 'settings.themeSystem' : theme === 'dark' ? 'settings.themeDark' : 'settings.themeLight')}</strong></button>)}
						</div>
						<div className="pd-settings-section-head"><h3>{t('settings.uiFontSize')}</h3><p>{t('settings.uiFontSizeDescription')}</p></div>
						<div className="pd-font-size-row" data-setting="font">
							<input type="range" aria-label={t('settings.uiFontSize')} min={UI_FONT_SIZE_MIN} max={UI_FONT_SIZE_MAX} step={1} value={uiFontSize} onChange={(event) => {
								const size = Number(event.target.value);
								setUiFontSize(size);
								applyUiFontSize(size);
								saveUiFontSize(size);
							}} />
							<span className="pd-font-size-value" aria-live="polite">{uiFontSize}px</span>
							{uiFontSize !== DEFAULT_UI_FONT_SIZE && <button type="button" className="pd-font-size-reset" onClick={() => { setUiFontSize(DEFAULT_UI_FONT_SIZE); applyUiFontSize(DEFAULT_UI_FONT_SIZE); saveUiFontSize(DEFAULT_UI_FONT_SIZE); }}>{t('settings.uiFontSizeReset')}</button>}
						</div>
							<div className="pd-settings-divider" />
							{(['code', 'command'] as ContentFontKind[]).map(kind => <div className="pd-content-font-setting" data-setting={kind + '-font'} key={kind}><label htmlFor={'pd-' + kind + '-font'}>{locale === 'zh-CN' ? kind === 'code' ? '代码与差异字号' : '命令输出字号' : kind === 'code' ? 'Code and diff font size' : 'Command output font size'}</label><div className="pd-font-size-row"><input id={'pd-' + kind + '-font'} type="range" min={CONTENT_FONT_MIN} max={CONTENT_FONT_MAX} step={1} value={contentFonts[kind]} onChange={event => { const value = Number(event.target.value); saveContentFontSize(kind, value); setContentFonts(old => ({ ...old, [kind]: value })); }} /><output>{contentFonts[kind]}px</output><button type="button" className="pd-font-size-reset" disabled={contentFonts[kind] === DEFAULT_CONTENT_FONT_SIZE} onClick={() => { saveContentFontSize(kind, DEFAULT_CONTENT_FONT_SIZE); setContentFonts(old => ({ ...old, [kind]: DEFAULT_CONTENT_FONT_SIZE })); }}>{t('settings.uiFontSizeReset')}</button></div></div>)}
							<div className="pd-settings-divider" />
							<ColorThemeSettings themePreference={themePreference} preferences={colorPreferences} onChange={onColorPreferencesChange} saveFailed={colorSaveFailed} />
						</>}
						{page === 'model' && <><ModelSettingsPanel key={cwd} initialTarget={modelTarget} onDraftStateChange={reportDraftState} renderCredential={(provider: UiProviderAuthStatus, onDraftStateChange?: (state: DraftState) => void) => <ProviderCredentialRow key={provider.provider} {...provider} onDraftStateChange={onDraftStateChange} />} /><ModelTestPanel /></>}
						{page === 'shortcuts' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.shortcuts')}</h2><p>{t('settings.shortcutsDescription')}</p></div>
						<ShortcutSettings isMac={appInfo?.platform === 'darwin'} />
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
									<button type="button" data-action="check-updates" className="pd-extension-refresh" onClick={() => void checkForUpdates()} disabled={!bridge || updateBusy || !updateState || !['idle', 'up-to-date', 'available', 'error'].includes(updateState.phase)}>{t('settings.updateCheck')}</button>
									<button type="button" data-action="install-update" className="pd-extension-refresh" onClick={() => void installUpdate()} disabled={!bridge || updateBusy || !updateAvailable}>{t(updateState?.phase === 'ready' ? 'settings.updateInstall' : 'settings.updateNow')}</button>
								</div>
							</div>
						</>}
					</div>
				</div>
			</div>
		</div>
	);
}
