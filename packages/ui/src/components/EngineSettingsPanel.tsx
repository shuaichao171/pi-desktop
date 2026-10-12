import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import type { SettingsDraftState } from '../settingsLeaveGuard';
import type { UiPiEngineProbe, UiPiEngineStatus } from '@pidesktop/shared';
import { Icon } from './Icons';
import './engineSettingsPanel.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type EngineMode = 'builtin' | 'custom';

/**
 * Settings section for choosing which Pi engine drives the agent host: the
 * bundled SDK (default) or a user-managed npm install. A saved change applies
 * after the app restarts; the panel offers a one-click relaunch.
 */
export function EngineSettingsPanel({ onDraftStateChange }: { onDraftStateChange(state: SettingsDraftState): void }) {
	const { t, locale } = useT();
	const bridge = useChatStore(state => state.bridge);
	const id = useId();
	const mounted = useRef(false);
	const lock = useRef(false);
	const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [status, setStatus] = useState<UiPiEngineStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [mode, setMode] = useState<EngineMode>('builtin');
	const [path, setPath] = useState('');
	const [savedMode, setSavedMode] = useState<EngineMode | null>(null);
	const [savedPath, setSavedPath] = useState<string>('');
	const [probe, setProbe] = useState<UiPiEngineProbe | null>(null);
	const [probing, setProbing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [pending, setPending] = useState<'pick' | 'save' | 'restart' | null>(null);

	const dirty = savedMode !== null && (mode !== savedMode || (mode === 'custom' && path.trim() !== savedPath));
	const disabled = !bridge || savedMode === null || pending !== null;
	const saveRef = useRef<() => Promise<boolean>>(async () => false);
	const statusRef = useRef<HTMLDivElement>(null);
	const saveDraft = useCallback(() => saveRef.current(), []);

	useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (probeTimer.current) clearTimeout(probeTimer.current); }; }, []);
	useEffect(() => { onDraftStateChange({ dirty, saving: pending !== null, save: dirty ? saveDraft : undefined }); }, [dirty, pending, saveDraft, onDraftStateChange]);
	useEffect(() => () => onDraftStateChange({ dirty: false, saving: false }), [onDraftStateChange]);

	// Load the effective selection plus what the running host actually loaded.
	useEffect(() => {
		if (!bridge?.getPiEngineStatus) return;
		let current = true;
		setStatus(null); setLoadError(null); setError(null); setSaved(false);
		void bridge.getPiEngineStatus().then(next => {
			if (!current) return;
			setStatus(next);
			setMode(next.selection.mode);
			setPath(next.selection.mode === 'custom' ? next.selection.path : '');
			setSavedMode(next.selection.mode);
			setSavedPath(next.selection.mode === 'custom' ? next.selection.path : '');
		}).catch((cause: unknown) => { if (current) setLoadError(errorText(cause)); });
		return () => { current = false; };
	}, [bridge, attempt]);

	const runProbe = useCallback((candidate: string) => {
		const trimmed = candidate.trim();
		setProbe(null);
		if (!bridge?.probePiEngine || !trimmed) return;
		setProbing(true);
		void bridge.probePiEngine(trimmed).then(next => { if (mounted.current) setProbe(next); })
			.catch((cause: unknown) => { if (mounted.current) setProbe({ ok: false, packageDir: null, version: null, problems: [errorText(cause)], warnings: [] }); })
			.finally(() => { if (mounted.current) setProbing(false); });
	}, [bridge]);

	// Debounced probe while typing a custom path; also re-probes the saved path on load.
	useEffect(() => {
		if (!bridge?.probePiEngine || mode !== 'custom') return;
		if (probeTimer.current) clearTimeout(probeTimer.current);
		const trimmed = path.trim();
		if (!trimmed) { setProbe(null); return; }
		probeTimer.current = setTimeout(() => runProbe(trimmed), 500);
		return () => { if (probeTimer.current) clearTimeout(probeTimer.current); };
	}, [bridge, mode, path, runProbe]);

	async function chooseDirectory() {
		if (!bridge?.pickPiEngineDirectory || disabled || lock.current) return;
		lock.current = true; setPending('pick'); setError(null); setSaved(false);
		try {
			const picked = await bridge.pickPiEngineDirectory();
			if (mounted.current && useChatStore.getState().bridge === bridge && picked) {
				setPath(picked);
				runProbe(picked);
			}
		} catch (cause) { if (mounted.current) setError(errorText(cause)); }
		finally { lock.current = false; if (mounted.current) setPending(null); }
	}

	async function save(): Promise<boolean> {
		if (!bridge?.setDesktopSettings || disabled || lock.current) return false;
		if (mode === 'custom' && !path.trim()) return false;
		lock.current = true; setPending('save'); setError(null); setSaved(false);
		const current = () => mounted.current && useChatStore.getState().bridge === bridge;
		try {
			const settings = await bridge.setDesktopSettings({ piEngine: mode === 'custom' ? { mode: 'custom', path: path.trim() } : { mode: 'builtin' } });
			if (!current()) return false;
			const selection = settings.piEngine ?? { mode: 'builtin' as const };
			setMode(selection.mode);
			setSavedMode(selection.mode);
			setPath(selection.mode === 'custom' ? selection.path : '');
			setSavedPath(selection.mode === 'custom' ? selection.path : '');
			if (bridge.getPiEngineStatus) void bridge.getPiEngineStatus().then(next => { if (current()) setStatus(next); }).catch(() => {});
			if (!current()) return false;
			setSaved(true);
			return true;
		} catch (cause) { if (current()) setError(errorText(cause)); return false; }
		finally { lock.current = false; if (mounted.current) setPending(null); }
	}
	saveRef.current = save;

	async function relaunch() {
		if (!bridge?.relaunchApp || restarting) return;
		setRestarting(true);
		setPending('restart');
		try {
			// The user may cancel the running-task confirmation; the app keeps running.
			if (!await bridge.relaunchApp() && mounted.current) { setRestarting(false); setPending(null); }
		} catch (cause) { if (mounted.current) setError(errorText(cause)); setRestarting(false); setPending(null); }
	}

	// Bring the restart prompt into view once a save lands; the save bar sits at the bottom.
	useEffect(() => { if (saved && status?.pendingRestart) statusRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [saved, status?.pendingRestart]);

	function discard() {
		if (savedMode === null || pending !== null) return;
		setMode(savedMode); setPath(savedPath); setError(null); setSaved(false);
	}

	const builtinVersion = status?.builtinVersion ?? null;
	const active = status?.active ?? null;
	const activeName = active ? t(active.mode === 'builtin' ? 'settings.engineBuiltinTitle' : 'settings.engineCustom') : null;
	const restartButton = (action: string) => <button type="button" className="pd-engine-button" data-action={action} disabled={pending !== null} onClick={() => void relaunch()}>
		<Icon name="refresh" width="14" height="14" />{t(restarting ? 'settings.engineRestarting' : 'settings.engineRestart')}
	</button>;
	const modes: Array<{ value: EngineMode; title: string; hint: string; icon: 'spark' | 'folder' }> = [
		{ value: 'builtin', title: t('settings.engineBuiltin', { version: builtinVersion ?? '—' }), hint: t('settings.engineBuiltinHint'), icon: 'spark' },
		{ value: 'custom', title: t('settings.engineCustom'), hint: t('settings.engineCustomHint'), icon: 'folder' },
	];

	return <section className="pd-engine" data-setting="pi-engine" aria-labelledby={`${id}-title`}>
		<div className="pd-settings-section-head"><h2 id={`${id}-title`}>{t('settings.engine')}</h2><p id={`${id}-description`}>{t('settings.engineDescription')}</p></div>
		{loadError ? <div className="pd-engine-callout is-error" role="alert"><p>{t('settings.engineLoadFailed')}：{loadError}</p><button type="button" className="pd-engine-button" onClick={() => setAttempt(value => value + 1)}>{t('projectCreate.retry')}</button></div>
			: savedMode === null ? <p className="pd-engine-loading" role="status">{t('settings.engineLoading')}</p>
			: <form className="pd-engine-form" onSubmit={event => { event.preventDefault(); if (dirty) void save(); }} aria-busy={pending !== null}>
				<div ref={statusRef} className={`pd-engine-status${status?.pendingRestart ? ' is-pending' : ''}`} aria-label={t('settings.engineStatus')}>
					<span className={`pd-engine-status-icon${active ? ' is-running' : ''}`}><Icon name={active?.mode === 'custom' ? 'folder' : 'spark'} width="18" height="18" /></span>
					<div className="pd-engine-status-copy">
						<span className="pd-engine-status-label">{t('settings.engineStatus')}</span>
						<strong>{active ? `${activeName} ${active.version ?? ''}`.trim() : t('settings.engineNotStarted')}</strong>
						<p>{active
							? (active.mode === 'custom' && active.path ? <code title={active.path}>{active.path}</code> : t('settings.engineActiveLine', { engine: t(active.mode === 'builtin' ? 'settings.engineActiveBuiltin' : 'settings.engineActiveCustom', { version: active.version ?? '—' }) }))
							: t('settings.engineIdleLine')}</p>
					</div>
					{active && !status?.pendingRestart && <span className="pd-engine-chip is-success">{t('settings.engineRunning')}</span>}
					{status?.pendingRestart && <span className="pd-engine-chip is-warning">{t('settings.enginePendingBadge')}</span>}
				</div>
				{status?.pendingRestart && <div className="pd-engine-callout is-warning" role="status"><p>{t(saved ? 'settings.engineSavedRestart' : 'settings.enginePendingRestart')}</p>{restartButton('relaunch-app')}</div>}

				<div className="pd-settings-section-head"><h3>{t('settings.engineMode')}</h3><p>{t('settings.engineModeDescription')}</p></div>
				<div className="pd-engine-modes" data-setting="engine-mode" role="radiogroup" aria-label={t('settings.engineMode')}>
					{modes.map(item => <button key={item.value} type="button" role="radio" aria-checked={mode === item.value} className={mode === item.value ? 'is-selected' : ''} disabled={pending !== null}
						onClick={() => { setMode(item.value); setError(null); setSaved(false); }}>
						<span className="pd-engine-mode-icon"><Icon name={item.icon} width="16" height="16" /></span>
						<span className="pd-engine-mode-copy"><strong>{item.title}</strong><small>{item.hint}</small></span>
						<span className="pd-engine-mode-check" aria-hidden>{mode === item.value && <Icon name="check" width="12" height="12" />}</span>
					</button>)}
				</div>

				{mode === 'custom' && <div className="pd-engine-custom">
					<div className="pd-settings-section-head"><h3>{t('settings.enginePath')}</h3><p>{t('settings.enginePathDescription')}</p></div>
					<div className="pd-engine-path">
						<input name="piEngineDirectory" aria-label={t('settings.enginePath')} aria-describedby={`${id}-description`} value={path} disabled={disabled} autoComplete="off" spellCheck={false} title={path || undefined}
							placeholder={locale === 'zh-CN' ? '例如 D:\\engines\\pi' : 'e.g. D:\\engines\\pi'} onChange={event => { setPath(event.target.value); setError(null); setSaved(false); }} />
						<button type="button" className="pd-engine-button" data-action="choose-engine-directory" disabled={disabled} onClick={() => void chooseDirectory()}><Icon name="folder" width="14" height="14" />{t(pending === 'pick' ? 'projectCreate.choosing' : 'settings.engineChoose')}</button>
						<button type="button" className="pd-engine-button" data-action="check-engine-directory" disabled={disabled || !path.trim() || probing} onClick={() => runProbe(path)}>{t(probing ? 'settings.engineChecking' : 'settings.engineCheck')}</button>
					</div>
					{probing && <p className="pd-engine-probe" role="status"><Icon name="loader" width="14" height="14" className="is-spinning" />{t('settings.engineChecking')}</p>}
					{!probing && probe?.ok && <div className="pd-engine-probe is-ok" role="status">
						<Icon name="check" width="14" height="14" />
						<span>{t('settings.engineProbeOk', { version: probe.version ?? '—' })}{probe.packageDir && <code title={probe.packageDir}>{probe.packageDir}</code>}</span>
					</div>}
					{!probing && probe && !probe.ok && <p className="pd-engine-callout is-error" role="alert">{t('settings.engineProbeProblems', { problems: probe.problems.join('；') })}</p>}
					{probe && probe.warnings.length > 0 && <p className="pd-engine-callout is-warning" role="alert">{t('settings.engineWarnings', { warnings: probe.warnings.join('；') })}</p>}
					<div className="pd-engine-notes">
						<strong>{t('settings.engineNotes')}</strong>
						<ul>
							<li className="pd-engine-note">{t('settings.engineInstallHint')}</li>
							<li className="pd-engine-note">{t('settings.engineSharedNote')}</li>
							<li className="pd-engine-note">{t('settings.engineRiskNote')}</li>
						</ul>
					</div>
				</div>}

				{error && <p className="pd-engine-callout is-error" role="alert">{error}</p>}
				{dirty && <div className="pd-engine-savebar">
					<span>{t('settings.engineUnsaved')}</span>
					<button type="button" className="pd-engine-button is-ghost" disabled={pending !== null} onClick={discard}>{t('settings.engineDiscard')}</button>
					<button type="submit" className="pd-engine-button is-primary" data-action="save-engine-settings" disabled={disabled || (mode === 'custom' && !path.trim())}>{t(pending === 'save' ? 'settings.processing' : 'settings.engineSave')}</button>
				</div>}
			</form>}
	</section>;
}
