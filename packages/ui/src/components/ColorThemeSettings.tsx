import { useEffect, useState, type CSSProperties } from 'react';
import { useT } from '../i18n';
import { buildThemeTokens, COLOR_PRESET_IDS, getPresetColors, normalizeHexColor, type ColorMode, type ThemeColorChoice, type ThemeColorPreferences, type ThemeColors } from '../themeColors';
import type { ThemePreference } from './SettingsPanel';
import { SegmentedIndicator } from './SegmentedIndicator';
import { Icon } from './Icons';
import './colorThemeSettings.css';

type ColorField = 'accent' | 'surface' | 'ink';

function ColorInput({ field, mode, value, onChange }: { field: ColorField; mode: ColorMode; value: string; onChange(value: string): void }) {
	const { t } = useT();
	const [draft, setDraft] = useState(value);
	useEffect(() => { setDraft(value); }, [value]);
	const label = t(`settings.color.${field}`);
	const id = `pd-color-${mode}-${field}`;

	function commitDraft() {
		const normalized = normalizeHexColor(draft);
		setDraft(normalized ?? value);
		if (normalized && normalized !== value) onChange(normalized);
	}

	return <div className="pd-theme-color-field">
		<label htmlFor={id}>{label}</label>
		<div className="pd-theme-color-input">
			<input className="pd-theme-color-picker" type="color" value={value} aria-label={t('settings.color.pick', { color: label })} onChange={(event) => onChange(event.target.value)} />
			<input id={id} className="pd-theme-color-hex" data-color-field={field} type="text" value={draft} aria-label={`${label} HEX`} spellCheck={false} autoComplete="off" maxLength={7} onChange={(event) => {
				const next = event.target.value;
				setDraft(next);
				// Commit complete colors immediately, but leave partial typing intact.
				if (/^#[\da-f]{6}$/i.test(next)) onChange(next.toLowerCase());
			}} onBlur={commitDraft} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitDraft(); } }} />
		</div>
	</div>;
}

function ThemePreview({ choice, mode }: { choice: ThemeColorChoice; mode: ColorMode }) {
	const { t } = useT();
	return <div className="pd-theme-preview" style={{ ...buildThemeTokens(choice, mode), colorScheme: mode } as CSSProperties} role="img" aria-label={t('settings.color.preview')}>
		<div className="pd-theme-preview-sidebar" aria-hidden="true"><span className="pd-theme-preview-logo">π</span><i /><i className="is-selected" /><i /><i /></div>
		<div className="pd-theme-preview-chat" aria-hidden="true">
			<div className="pd-theme-preview-user">{t('settings.color.previewUser')}</div>
			<div className="pd-theme-preview-reply"><span>π</span><p>{t('settings.color.previewReply')}</p></div>
			<div className="pd-theme-preview-composer"><span>{t('settings.color.previewPrompt')}</span><i><Icon name="arrowUp" width="13" height="13" /></i></div>
		</div>
	</div>;
}

export function ColorThemeSettings({ themePreference, preferences, onChange, saveFailed }: {
	themePreference: ThemePreference;
	preferences: ThemeColorPreferences;
	onChange(preferences: ThemeColorPreferences): void;
	saveFailed: boolean;
}) {
	const { t } = useT();
	const [editingMode, setEditingMode] = useState<ColorMode>(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
	const mode = themePreference === 'system' ? editingMode : themePreference;
	const choice = preferences[mode];
	function changeColors(patch: Partial<ThemeColors>) {
		onChange({ ...preferences, [mode]: { ...choice, ...patch, preset: 'custom' } });
	}
	function reset() { onChange({ ...preferences, [mode]: getPresetColors('default', mode) }); }

	return <section className="pd-theme-colors" aria-labelledby="pd-theme-colors-title">
		<div className="pd-settings-section-head"><h2 id="pd-theme-colors-title">{t('settings.color.title')}</h2><p>{t('settings.color.description')}</p></div>
		{themePreference === 'system' && <SegmentedIndicator activeKey={mode} className="pd-theme-modes" label={t('settings.color.editMode')}>
			{(['light', 'dark'] as const).map((item) => <button className="pd-theme-mode" data-color-mode={item} data-segment-key={item} key={item} type="button" aria-pressed={mode === item} onClick={() => setEditingMode(item)}>{t(`settings.color.${item}`)}</button>)}
		</SegmentedIndicator>}
		<div className="pd-theme-preset-row">
			<label htmlFor="pd-theme-preset">{t('settings.color.preset')}</label>
			<select id="pd-theme-preset" className="pd-theme-preset-select" value={choice.preset} onChange={(event) => {
				const preset = COLOR_PRESET_IDS.find((id) => id === event.target.value);
				if (preset) onChange({ ...preferences, [mode]: getPresetColors(preset, mode) });
			}}>
				{COLOR_PRESET_IDS.map((preset) => <option key={preset} value={preset}>{t(`settings.color.preset.${preset}`)}</option>)}
				{choice.preset === 'custom' && <option value="custom" disabled>{t('settings.color.preset.custom')}</option>}
			</select>
			<button className="pd-theme-color-reset" type="button" disabled={choice.preset === 'default'} onClick={reset}>{t('settings.color.reset')}</button>
		</div>
		<div className="pd-theme-color-fields">
			{(['accent', 'surface', 'ink'] as const).map((field) => <ColorInput key={`${mode}-${field}`} field={field} mode={mode} value={choice[field]} onChange={(value) => changeColors({ [field]: value })} />)}
		</div>
		<div className="pd-theme-contrast-row"><label htmlFor="pd-theme-contrast">{t('settings.color.contrast')}</label><input id="pd-theme-contrast" className="pd-theme-contrast" type="range" min="0" max="100" step="1" value={choice.contrast} onChange={(event) => changeColors({ contrast: Number(event.target.value) })} /><output htmlFor="pd-theme-contrast">{choice.contrast}</output></div>
		<ThemePreview choice={choice} mode={mode} />
		<p className="pd-settings-hint">{t('settings.color.hint')}</p>
		{saveFailed && <p className="pd-theme-save-error" role="status">{t('settings.color.saveFailed')}</p>}
	</section>;
}
