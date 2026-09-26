import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { parseKeys } from '../shortcuts/bindings';
import { useShortcutBindings } from '../shortcuts/useShortcutBindings';

/**
 * Settings shortcuts page body (4.3): renders the declarative registry with
 * inline rebinding (click a key, press the new combination), per-binding reset,
 * conflict hints and a restore-all-defaults action. Fixed typing semantics
 * (Enter family, Esc stop) are listed but cannot be rebound.
 */
export function ShortcutSettings({ isMac }: { isMac: boolean }) {
	const { t } = useT();
	const { overrides, setOverride, resetAll, conflicts, bindings } = useShortcutBindings();
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

	const display = (keys: string): string => keys
		.replace(/\bCtrl\b/g, isMac ? '⌘' : 'Ctrl')
		.replace(/\bAlt\b/g, isMac ? '⌥' : 'Alt')
		.replace(/\bShift\b/g, isMac ? '⇧' : 'Shift');

	return (
		<div className="pd-shortcut-settings">
			<ul className="pd-shortcut-rows">
				{bindings.map((binding) => {
					const keys = overrides[binding.id] ?? binding.keys;
					const conflict = conflicts.find((entry) => entry.ids.includes(binding.id));
					return (
						<li key={binding.id} className={conflict ? 'has-conflict' : undefined}>
							<span className="pd-shortcut-label">{t(binding.labelKey)}</span>
							<span className="pd-shortcut-keys">
								{binding.fixed
									? <kbd>{display(keys)}</kbd>
									: <button type="button" className={`pd-shortcut-capture${capturing === binding.id ? ' is-capturing' : ''}`} aria-keyshortcuts={keys}
										onClick={() => setCapturing(capturing === binding.id ? null : binding.id)}>
										{capturing === binding.id ? t('settings.shortcutCapturing') : display(keys)}
									</button>}
								{!binding.fixed && overrides[binding.id] !== undefined
									? <button type="button" className="pd-shortcut-reset" onClick={() => setOverride(binding.id, null)}>{t('settings.shortcutReset')}</button>
									: null}
							</span>
							{conflict ? <span className="pd-shortcut-conflict" role="alert">{t('settings.shortcutConflict')}</span> : null}
						</li>
					);
				})}
			</ul>
			<button type="button" className="pd-shortcut-reset-all" onClick={() => { setCapturing(null); resetAll(); }}>{t('settings.shortcutResetAll')}</button>
		</div>
	);
}
