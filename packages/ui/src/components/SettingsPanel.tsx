import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { UiExtensionSummary, UiProviderAuthStatus, UiThinkingLevel, UiUpdateState } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Translate } from '../i18n';
import { Icon } from './Icons';

export type ThemePreference = 'system' | 'dark' | 'light';
type SettingsPage = 'appearance' | 'model' | 'credentials' | 'extensions' | 'shortcuts' | 'updates' | 'about';

function readableModelSize(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '';
	return value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : `${Math.round(value / 1000)}K`;
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

export function SettingsPanel({ initialPage = 'appearance', onClose, themePreference, onThemePreferenceChange }: { initialPage?: 'appearance' | 'updates'; onClose(): void; themePreference: ThemePreference; onThemePreferenceChange(theme: ThemePreference): void }) {
	const { t, locale, setLocale } = useT();
	const [page, setPage] = useState<SettingsPage>(initialPage);
	const [modelSearch, setModelSearch] = useState('');
	const [actionError, setActionError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [extensions, setExtensions] = useState<UiExtensionSummary[]>([]);
	const [extensionsLoading, setExtensionsLoading] = useState(false);
	const [extensionsLoaded, setExtensionsLoaded] = useState(false);
	const [extensionPendingPath, setExtensionPendingPath] = useState<string | null>(null);
	const [extensionError, setExtensionError] = useState<string | null>(null);
	const [extensionFeedback, setExtensionFeedback] = useState<string | null>(null);
	const [updateState, setUpdateState] = useState<UiUpdateState | null>(null);
	const [updatePending, setUpdatePending] = useState(false);
	const [updateActionError, setUpdateActionError] = useState<string | null>(null);
	const extensionRequestRef = useRef(0);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const models = useChatStore((s) => s.models);
	const model = useChatStore((s) => s.model);
	const modelProvider = useChatStore((s) => s.modelProvider);
	const thinkingLevel = useChatStore((s) => s.thinkingLevel);
	const availableThinkingLevels = useChatStore((s) => s.availableThinkingLevels);
	const providerAuth = useChatStore((s) => s.providerAuth);
	const settingsLoading = useChatStore((s) => s.settingsLoading);
	const settingsError = useChatStore((s) => s.settingsError);
	const status = useChatStore((s) => s.status);
	const cwd = useChatStore((s) => s.cwd);
	const appInfo = useChatStore((s) => s.appInfo);
	const bridge = useChatStore((s) => s.bridge);
	const refreshModels = useChatStore((s) => s.refreshModels);
	const refreshProviderAuth = useChatStore((s) => s.refreshProviderAuth);
	const setModel = useChatStore((s) => s.setModel);
	const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
	const canChangeAgent = status === 'idle' && !settingsLoading;
	const waitingForAgent = status === 'starting' || status === 'uninitialized';
	const canReadExtensions = Boolean(bridge) && !waitingForAgent && status !== 'error';
	const filteredModels = useMemo(() => {
		const query = modelSearch.trim().toLocaleLowerCase();
		return models.filter((item) => `${item.provider} ${item.id} ${item.name}`.toLocaleLowerCase().includes(query)).slice(0, 80);
	}, [models, modelSearch]);
	const sortedProviderAuth = useMemo(() => [...providerAuth].sort((a, b) => Number(b.configured) - Number(a.configured) || a.provider.localeCompare(b.provider)), [providerAuth]);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		const unsubscribe = bridge.onUpdateStateChanged((next) => { if (active) setUpdateState(next); });
		void bridge.getUpdateState().then((next) => { if (active) setUpdateState(next); }).catch((error: unknown) => {
			if (active) setUpdateActionError(error instanceof Error ? error.message : String(error));
		});
		return () => { active = false; unsubscribe(); };
	}, [bridge]);

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		return () => {
			const canReceiveFocus = (element: HTMLElement | null): element is HTMLElement =>
				Boolean(element?.isConnected && !element.closest('[inert]') && element.getClientRects().length > 0);
			if (canReceiveFocus(previous)) {
				previous.focus();
				return;
			}
			const settingsEntry = document.querySelector<HTMLButtonElement>('.pd-settings-entry');
			const sidebarToggle = document.querySelector<HTMLButtonElement>('.pd-header-sidebar-toggle');
			if (canReceiveFocus(settingsEntry)) settingsEntry.focus();
			else if (canReceiveFocus(sidebarToggle)) sidebarToggle.focus();
		};
	}, []);

	useEffect(() => {
		if (waitingForAgent) return;
		void refreshModels().catch(() => {});
		void refreshProviderAuth().catch(() => {});
	}, [waitingForAgent, refreshModels, refreshProviderAuth]);

	useEffect(() => {
		if (page !== 'extensions') return;
		setExtensions([]);
		setExtensionsLoaded(false);
		setExtensionError(null);
		setExtensionFeedback(null);
		if (canReadExtensions) void refreshExtensions();
		return () => { extensionRequestRef.current += 1; };
	}, [page, cwd, bridge, canReadExtensions]);

	async function refreshExtensions(): Promise<boolean> {
		if (!bridge || !canReadExtensions) return false;
		const request = ++extensionRequestRef.current;
		setExtensionsLoading(true);
		setExtensionError(null);
		try {
			const items = await bridge.listExtensions();
			if (request !== extensionRequestRef.current) return false;
			setExtensions(items);
			setExtensionsLoaded(true);
			return true;
		} catch (error) {
			if (request !== extensionRequestRef.current) return false;
			setExtensionError(t('settings.extensionLoadFailed', { error: error instanceof Error ? error.message : String(error) }));
			return false;
		} finally {
			if (request === extensionRequestRef.current) setExtensionsLoading(false);
		}
	}

	async function toggleExtension(item: UiExtensionSummary) {
		if (!bridge || !canChangeAgent || pending || extensionPendingPath || extensionsLoading) return;
		setExtensionPendingPath(item.path);
		setExtensionError(null);
		setExtensionFeedback(null);
		try {
			await bridge.setExtensionEnabled(item.path, !item.enabled);
			if (await refreshExtensions()) setExtensionFeedback(t(item.enabled ? 'settings.extensionDisabled' : 'settings.extensionEnabled', { name: item.name }));
		} catch (error) {
			setExtensionError(t('settings.extensionToggleFailed', { error: error instanceof Error ? error.message : String(error) }));
		} finally {
			setExtensionPendingPath(null);
		}
	}

	function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
		if (event.key !== 'Tab') return;
		const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])');
		if (!elements?.length) return;
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	}

	async function updateModel(provider: string, id: string) {
		setPending(true);
		setActionError(null);
		try { await setModel(provider, id); }
		catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
		finally { setPending(false); }
	}

	async function updateThinking(level: UiThinkingLevel) {
		setPending(true);
		setActionError(null);
		try { await setThinkingLevel(level); }
		catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
		finally { setPending(false); }
	}

	async function checkForUpdates() {
		if (!bridge || updatePending) return;
		setUpdatePending(true);
		setUpdateActionError(null);
		try { setUpdateState(await bridge.checkForUpdates()); }
		catch (error) { setUpdateActionError(error instanceof Error ? error.message : String(error)); }
		finally { setUpdatePending(false); }
	}

	async function installUpdate() {
		if (!bridge || updatePending || updateState?.phase !== 'ready') return;
		setUpdatePending(true);
		setUpdateActionError(null);
		try { await bridge.installUpdate(); }
		catch (error) { setUpdateActionError(error instanceof Error ? error.message : String(error)); setUpdatePending(false); }
	}

	const updateStatus = updateState?.phase === 'unavailable'
		? t(`settings.updateUnavailable.${updateState.unavailableReason ?? 'unsupported'}`)
		: updateState?.phase === 'checking' ? t('settings.updateChecking')
		: updateState?.phase === 'downloading' ? t('settings.updateDownloading', { percent: Math.round(updateState.progressPercent ?? 0) })
		: updateState?.phase === 'ready' ? t('settings.updateReady', { version: updateState.availableVersion ?? '' })
		: updateState?.phase === 'up-to-date' ? t('settings.updateCurrent')
		: updateState?.phase === 'error' ? t('settings.updateFailed')
		: t('settings.updateIdle');

	return (
		<div className="pd-settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div ref={dialogRef} className="pd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-settings-title" onKeyDown={onDialogKeyDown}>
				<header className="pd-settings-header"><div><span className="pd-settings-eyebrow">PI DESKTOP</span><h1 id="pd-settings-title">{t('settings.title')}</h1></div><button ref={closeRef} type="button" className="pd-icon-button" onClick={onClose} aria-label={t('settings.close')}><Icon name="close" /></button></header>
				<div className="pd-settings-layout">
					<nav className="pd-settings-nav" aria-label={t('settings.category')}>
						<button type="button" className={page === 'appearance' ? 'is-active' : ''} aria-current={page === 'appearance' ? 'page' : undefined} onClick={() => setPage('appearance')}>{t('settings.appearance')}</button>
						<button type="button" className={page === 'model' ? 'is-active' : ''} aria-current={page === 'model' ? 'page' : undefined} onClick={() => setPage('model')}>{t('settings.modelThinking')}</button>
						<button type="button" className={page === 'credentials' ? 'is-active' : ''} aria-current={page === 'credentials' ? 'page' : undefined} onClick={() => setPage('credentials')}>{t('settings.credentials')}</button>
						<button type="button" className={page === 'extensions' ? 'is-active' : ''} aria-current={page === 'extensions' ? 'page' : undefined} onClick={() => setPage('extensions')}>{t('settings.extensions')}</button>
						<button type="button" className={page === 'shortcuts' ? 'is-active' : ''} aria-current={page === 'shortcuts' ? 'page' : undefined} onClick={() => setPage('shortcuts')}>{t('settings.shortcuts')}</button>
						<button type="button" className={page === 'updates' ? 'is-active' : ''} aria-current={page === 'updates' ? 'page' : undefined} onClick={() => setPage('updates')}>{t('settings.updates')}</button>
						<button type="button" className={page === 'about' ? 'is-active' : ''} aria-current={page === 'about' ? 'page' : undefined} onClick={() => setPage('about')}>{t('settings.about')}</button>
					</nav>
					<div className="pd-settings-content">
						{(actionError || settingsError) && <div className="pd-settings-error" role="alert">{actionError || settingsError}</div>}
						{page === 'appearance' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.appearance')}</h2><p>{t('settings.appearanceDescription')}</p></div>
							<div className="pd-appearance-options" role="group" aria-label={t('settings.themeLabel')}>
								{(['system', 'dark', 'light'] as const).map((theme) => <button type="button" key={theme} className={`pd-appearance-choice${themePreference === theme ? ' is-selected' : ''}`} aria-pressed={themePreference === theme} onClick={() => onThemePreferenceChange(theme)}><span className={`pd-theme-swatch is-${theme}`} aria-hidden="true" /><strong>{t(theme === 'system' ? 'settings.themeSystem' : theme === 'dark' ? 'settings.themeDark' : 'settings.themeLight')}</strong></button>)}
							</div>
							<div className="pd-settings-divider" />
							<div className="pd-settings-section-head"><h2>{t('settings.language')}</h2><p>{t('settings.languageDescription')}</p></div>
							<div className="pd-language-options" role="group" aria-label={t('settings.language')}>
								<button type="button" className={locale === 'zh-CN' ? 'is-selected' : ''} aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>{t('settings.languageZh')}</button>
								<button type="button" className={locale === 'en-US' ? 'is-selected' : ''} aria-pressed={locale === 'en-US'} onClick={() => setLocale('en-US')}>{t('settings.languageEn')}</button>
							</div>
						</>}
						{page === 'model' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.model')}</h2><p>{t('settings.modelDescription', { model: model ? `${modelProvider ? `${modelProvider}/` : ''}${model}` : t('settings.notSelected') })}</p></div>
							<input className="pd-settings-model-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} aria-label={t('composer.pickerSearchLabel')} placeholder={t('composer.pickerSearchPlaceholder')} />
							<div className="pd-settings-model-list" aria-label={t('settings.availableModels')}>
								{filteredModels.map((item) => {
									const selected = item.provider === modelProvider && item.id === model;
									return <button key={`${item.provider}/${item.id}`} type="button" className={`pd-settings-model-row${selected ? ' is-selected' : ''}`} aria-pressed={selected} disabled={!canChangeAgent || pending} onClick={() => void updateModel(item.provider, item.id)}>
										<span className="pd-settings-model-copy"><strong>{item.name || item.id}</strong><small>{item.provider}/{item.id}</small></span>
									<span className="pd-settings-model-meta">{[t(item.reasoning ? 'settings.reasoning' : 'settings.noReasoning'), item.input.includes('image') ? t('settings.image') : null, item.contextWindow ? t('settings.context', { size: readableModelSize(item.contextWindow) }) : null].filter(Boolean).join(' · ')}</span>
									{selected && <span className="pd-settings-model-selected">{t('composer.pickerCurrent')}</span>}
									</button>;
								})}
								{filteredModels.length === 0 && <div className="pd-settings-empty">{t(settingsLoading || waitingForAgent ? 'settings.modelLoading' : status === 'error' ? 'settings.agentError' : modelSearch ? 'settings.modelNoMatch' : 'settings.modelEmpty')}</div>}
							</div>
							{models.length > 80 && <p className="pd-settings-hint">{t('settings.modelLimit')}</p>}
							<div className="pd-settings-divider" />
							<div className="pd-settings-section-head"><h2>{t('settings.thinking')}</h2><p>{t('settings.thinkingDescription')}</p></div>
							<div className="pd-thinking-options" role="group" aria-label={t('settings.thinking')}>
								{availableThinkingLevels.map((level) => <button key={level} type="button" className={thinkingLevel === level ? 'is-selected' : ''} aria-pressed={thinkingLevel === level} disabled={!canChangeAgent || pending} onClick={() => void updateThinking(level)}>{t(`composer.thinking.${level}`)}</button>)}
								{availableThinkingLevels.length === 0 && <span className="pd-settings-hint">{t('settings.thinkingEmpty')}</span>}
							</div>
							{status !== 'idle' && <p className="pd-settings-hint">{t('settings.modelBusy')}</p>}
						</>}
						{page === 'credentials' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.credentials')}</h2><p>{t('settings.credentialDescription')}</p></div>
							<div className="pd-provider-list">{sortedProviderAuth.map((item) => <ProviderCredentialRow key={item.provider} {...item} />)}</div>
							{providerAuth.length === 0 && <div className="pd-settings-empty">{t(settingsLoading || waitingForAgent ? 'settings.providerLoading' : status === 'error' ? 'settings.agentError' : 'settings.providerEmpty')}</div>}
							{status !== 'idle' && <p className="pd-settings-hint">{t('settings.providerBusy')}</p>}
						</>}
						{page === 'extensions' && <>
							<div className="pd-settings-section-head pd-extension-section-head">
								<div><h2>{t('settings.extensions')}</h2><p>{t('settings.extensionDescription')}</p></div>
								<button type="button" className="pd-extension-refresh" onClick={() => void refreshExtensions()} disabled={!canReadExtensions || extensionsLoading || Boolean(extensionPendingPath)}>{t(extensionsLoading ? 'settings.extensionLoading' : 'settings.extensionRefresh')}</button>
							</div>
							{extensionError && <div className="pd-settings-error" role="alert">{extensionError}</div>}
							{extensionFeedback && <p className="pd-settings-feedback" role="status">{extensionFeedback}</p>}
							<div className="pd-extension-list" aria-label={t('settings.extensions')}>
								{extensions.map((item) => <div className="pd-extension-card" key={item.path}>
									<div className="pd-extension-copy"><strong>{item.name}</strong><span>{t(item.scope === 'project' ? 'settings.extensionProject' : 'settings.extensionUser')} · {t(item.origin === 'package' ? 'settings.extensionPackage' : 'settings.extensionTopLevel')}</span><small title={item.path}>{item.source || item.path}</small></div>
									<button type="button" className={`pd-extension-toggle${item.enabled ? ' is-enabled' : ''}`} role="switch" aria-checked={item.enabled} aria-label={t('settings.extensionToggle', { name: item.name })} disabled={!canChangeAgent || pending || extensionsLoading || Boolean(extensionPendingPath)} onClick={() => void toggleExtension(item)}><span aria-hidden="true" />{t(item.enabled ? 'settings.extensionOn' : 'settings.extensionOff')}</button>
								</div>)}
								{extensions.length === 0 && !extensionError && <div className="pd-settings-empty">{t(!canReadExtensions ? waitingForAgent ? 'settings.extensionWaiting' : 'settings.agentError' : extensionsLoading || !extensionsLoaded ? 'settings.extensionLoading' : 'settings.extensionEmpty')}</div>}
							</div>
							{status === 'busy' && <p className="pd-settings-hint">{t('settings.extensionBusy')}</p>}
						</>}
						{page === 'shortcuts' && <>
							<div className="pd-settings-section-head"><h2>{t('settings.shortcuts')}</h2><p>{t('settings.shortcutsDescription')}</p></div>
							<dl className="pd-shortcut-list"><div><dt>{t('settings.shortcutSidebar')}</dt><dd><kbd>Ctrl</kbd> + <kbd>B</kbd></dd></div><div><dt>{t('settings.shortcutSend')}</dt><dd><kbd>Enter</kbd></dd></div><div><dt>{t('settings.shortcutNewline')}</dt><dd><kbd>Shift</kbd> + <kbd>Enter</kbd></dd></div><div><dt>{t('settings.shortcutClose')}</dt><dd><kbd>Esc</kbd></dd></div></dl>
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
									<button type="button" className="pd-extension-refresh" onClick={() => void checkForUpdates()} disabled={!bridge || updatePending || !updateState || !['idle', 'up-to-date', 'error'].includes(updateState.phase)}>{t('settings.updateCheck')}</button>
									{updateState?.phase === 'ready' && <button type="button" className="pd-extension-refresh" onClick={() => void installUpdate()} disabled={updatePending}>{t('settings.updateInstall')}</button>}
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
