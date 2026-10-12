import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { parseKeys, type ShortcutBinding, type ShortcutScope } from '../shortcuts/bindings';
import { useShortcutBindings } from '../shortcuts/useShortcutBindings';
import { useBusyInputBehavior } from '../busyInputBehavior';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './shortcutSettings.css';

const SCOPES: Array<{ scope: ShortcutScope; labelKey: string }> = [
	{ scope: 'global', labelKey: 'settings.shortcutScopeGlobal' },
	{ scope: 'transcript', labelKey: 'settings.shortcutScopeTranscript' },
	{ scope: 'composer', labelKey: 'settings.shortcutScopeComposer' },
];

const KEY_GLYPHS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ' ': 'Space' };

/** Splits a 'Ctrl+Shift+X' spec into display keycaps (a trailing '+' key stays intact). */
function keycaps(keys: string, isMac: boolean): string[] {
	const parts = keys.split('+').map((part) => part.trim());
	if (keys.endsWith('+')) parts.splice(parts.length - 2, 2, '+');
	return parts.filter(Boolean).map((part) => {
		if (part === 'Ctrl') return isMac ? '⌘' : 'Ctrl';
		if (part === 'Alt') return isMac ? '⌥' : 'Alt';
		if (part === 'Shift') return isMac ? '⇧' : 'Shift';
		return KEY_GLYPHS[part] ?? part;
	});
}

/**
 * Settings shortcuts page body (4.3): renders the declarative registry grouped
 * by scope with inline rebinding (click a key, press the new combination),
 * per-binding reset, conflict hints and a restore-all-defaults action. Fixed
 * typing semantics (Enter family, Esc stop) are listed but cannot be rebound.
 */
export function ShortcutSettings({ isMac }: { isMac: boolean }) {
	const { t } = useT();
	const { overrides, setOverride, resetAll, conflicts, bindings } = useShortcutBindings();
	const [busyInputBehavior] = useBusyInputBehavior();
	const [capturing, setCapturing] = useState<string | null>(null);

	useEffect(() => {
		if (!capturing) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			if (event.isComposing || event.keyCode === 229) return;
			if (event.key === 'Escape') { setCapturing(null); return; }
			if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') return;
			const parts: string[] = [];
			if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
			if (event.altKey) parts.push('Alt');
			if (event.shiftKey) parts.push('Shift');
			parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
			const spec = parts.join('+');
			if (parseKeys(spec)) setOverride(capturing, spec);
			setCapturing(null);
		};
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [capturing, setOverride]);

	const renderKeys = (keys: string) => keys.trim()
		? keycaps(keys, isMac).map((cap, index) => <kbd key={index}>{cap}</kbd>)
		: <span className="pd-shortcut-unassigned">{t('settings.shortcutUnassigned')}</span>;

	const label = (binding: ShortcutBinding): string => {
		if (binding.id !== 'send' && binding.id !== 'steer') return t(binding.labelKey);
		const busyAction = binding.id === 'send' ? busyInputBehavior : busyInputBehavior === 'followUp' ? 'steer' : 'followUp';
		return t('settings.shortcutSendWhileRunning', { action: t(busyAction === 'followUp' ? 'settings.busyInputQueue' : 'settings.busyInputSteer') });
	};

	const hasOverrides = Object.keys(overrides).length > 0;

	return (
		<div className="pd-shortcut-settings">
			<div className="pd-shortcut-toolbar">
				<p><Icon name="pencil" width="13" height="13" />{t('settings.shortcutEditHint')}</p>
				<button type="button" className="pd-shortcut-reset-all" disabled={!hasOverrides} onClick={() => { setCapturing(null); resetAll(); }}>
					<Icon name="rotateCcw" width="14" height="14" />{t('settings.shortcutResetAll')}
				</button>
			</div>
			{SCOPES.map(({ scope, labelKey }) => {
				const scoped = bindings.filter((binding) => binding.scope === scope);
				if (!scoped.length) return null;
				return (
					<section key={scope} className="pd-shortcut-group" aria-label={t(labelKey)}>
						<h3>{t(labelKey)}</h3>
						<ul className="pd-shortcut-rows">
							{scoped.map((binding) => {
								const keys = overrides[binding.id] ?? binding.keys;
								const conflict = conflicts.find((entry) => entry.ids.includes(binding.id));
								const modified = !binding.fixed && overrides[binding.id] !== undefined;
								const active = capturing === binding.id;
								return (
									<li key={binding.id} className={[conflict && 'has-conflict', active && 'is-capturing', binding.fixed && 'is-fixed'].filter(Boolean).join(' ') || undefined}>
										<div className="pd-shortcut-label">
											<span>{label(binding)}</span>
											{modified && <span className="pd-shortcut-badge is-modified">{t('settings.shortcutModified')}</span>}
											{binding.fixed && <span className="pd-shortcut-badge" title={t('settings.shortcutFixedHint')}>{t('settings.shortcutFixed')}</span>}
											{conflict ? <span className="pd-shortcut-conflict" role="alert">{t('settings.shortcutConflict')}</span> : null}
										</div>
										<div className="pd-shortcut-keys">
											{modified && <HoverTooltip title={t('settings.shortcutReset')} align="end">
												<button type="button" className="pd-shortcut-reset" onClick={() => setOverride(binding.id, null)}>
													<Icon name="rotateCcw" width="14" height="14" /><span className="pd-shortcut-sr-only">{t('settings.shortcutReset')}</span>
												</button>
											</HoverTooltip>}
											{binding.fixed
												? <span className="pd-shortcut-combo">{renderKeys(keys)}</span>
												: <button type="button" className={`pd-shortcut-capture${active ? ' is-capturing' : ''}`} aria-keyshortcuts={keys || undefined} aria-pressed={active}
													title={active ? undefined : t('settings.shortcutEdit')}
													onClick={() => setCapturing(active ? null : binding.id)} onBlur={() => { if (active) setCapturing(null); }}>
													{active
														? <><span className="pd-shortcut-capture-dot" aria-hidden />{t('settings.shortcutCapturing')}<small>{t('settings.shortcutCapturingHint')}</small></>
														: renderKeys(keys)}
												</button>}
										</div>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
		</div>
	);
}
