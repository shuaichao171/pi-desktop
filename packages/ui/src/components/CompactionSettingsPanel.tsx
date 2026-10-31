import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UiCompactionMode, UiCompactionPiSettings, UiCompactionSettings, UiDesktopCompactionPreferences, UiMagicContextConfig, UiMagicContextSnapshot } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRows';
import './compactionSettings.css';

type Draft = {
	loaded: boolean;
	pi: UiCompactionPiSettings;
	preferences: UiDesktopCompactionPreferences;
	magic: UiMagicContextConfig;
	piVersion: string;
	preferencesVersion: string;
	magicVersion: string;
};

type PluginState = { installed: boolean; enabled: boolean | null; installedVersion: string | null; latestVersion: string | null; updateAvailable: boolean };

const FOLLOW_MODEL = '__follow__';
const THINKING_NONE = '__none__';

const DEFAULT_PI: UiCompactionPiSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const DEFAULT_PREFERENCES: UiDesktopCompactionPreferences = { mode: 'builtin', compressModel: null };
const DEFAULT_MAGIC: UiMagicContextConfig = {
	enabled: true,
	historian: { model: null, thinkingLevel: null },
	embedding: { provider: 'local', model: null, endpoint: null, apiKey: null, apiKeySet: false },
	executeThresholdPercentage: null,
	historyBudgetPercentage: null,
};

function integerInput(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 上下文压缩设置：两种互斥方式（参考 snow-app 的压缩机制）。
 * - 内置自动压缩：Pi compaction 块阈值触发，desktop-compaction 扩展接管摘要生成，
 *   压缩过程以同款卡片流式可见；可配置独立压缩模型。
 * - Magic Context 后台压缩：依赖 @cortexkit/pi-magic-context 插件，historian
 *   在后台压缩历史并注入 system prompt，全程无感知；配置压缩模型与向量模型。
 */
export function CompactionSettingsPanel() {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const models = useChatStore((s) => s.models);
	const [draft, setDraft] = useState<Draft>({ loaded: false, pi: DEFAULT_PI, preferences: DEFAULT_PREFERENCES, magic: DEFAULT_MAGIC, piVersion: '', preferencesVersion: '', magicVersion: '' });
	const [plugin, setPlugin] = useState<PluginState>({ installed: false, enabled: null, installedVersion: null, latestVersion: null, updateAvailable: false });
	const [busy, setBusy] = useState(false);
	const [pluginBusy, setPluginBusy] = useState(false);
	const [feedback, setFeedback] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

	const applySnapshot = useCallback((settings: UiCompactionSettings, magic: UiMagicContextSnapshot) => {
		setDraft({
			loaded: true,
			pi: settings.pi,
			preferences: settings.preferences,
			magic: magic.config,
			piVersion: settings.version,
			preferencesVersion: settings.preferencesVersion,
			magicVersion: magic.configVersion,
		});
		setPlugin(magic.plugin);
	}, []);

	useEffect(() => {
		if (!bridge) return;
		let cancelled = false;
		void (async () => {
			try {
				const [settings, magic] = await Promise.all([bridge.getCompactionSettings(), bridge.getMagicContextSnapshot()]);
				if (!cancelled) applySnapshot(settings, magic);
			} catch (error) {
				if (!cancelled) setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
			}
		})();
		return () => { cancelled = true; };
	}, [bridge, applySnapshot]);

	const modelValue = draft.preferences.compressModel ? `${draft.preferences.compressModel.provider}/${draft.preferences.compressModel.id}` : FOLLOW_MODEL;
	const mode: UiCompactionMode = draft.preferences.mode;

	const patch = (update: Partial<Draft>) => setDraft((current) => ({ ...current, ...update }));
	const patchPi = (update: Partial<UiCompactionPiSettings>) => setDraft((current) => ({ ...current, pi: { ...current.pi, ...update } }));
	const patchMagic = (update: Partial<UiMagicContextConfig>) => setDraft((current) => ({ ...current, magic: { ...current.magic, ...update } }));

	const save = useCallback(async () => {
		if (!bridge || busy || !draft.loaded) return;
		setBusy(true);
		setFeedback(null);
		try {
			// [喵喵喵]: 顺序保存 —— 先写模式与 Pi compaction 块（决定扩展行为），再写
			// Magic Context 配置；任一版本冲突都会中止并提示刷新，避免半套配置生效
			const settings = await bridge.saveCompactionSettings({
				expectedPiVersion: draft.piVersion,
				expectedPreferencesVersion: draft.preferencesVersion,
				pi: draft.pi,
				preferences: draft.preferences,
			});
			const magic = await bridge.saveMagicContextConfig({ expectedVersion: draft.magicVersion, config: draft.magic });
			applySnapshot(settings, magic);
			setFeedback({ kind: 'ok', text: t('compaction.settings.saved') });
		} catch (error) {
			setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	}, [bridge, busy, draft, applySnapshot, t]);

	const runPluginAction = useCallback(async (action: 'install' | 'update') => {
		if (!bridge || pluginBusy) return;
		setPluginBusy(true);
		setFeedback(null);
		try {
			const magic = action === 'install' ? await bridge.installMagicContextPlugin() : await bridge.updateMagicContextPlugin();
			setDraft((current) => ({ ...current, magic: magic.config, magicVersion: magic.configVersion }));
			setPlugin(magic.plugin);
			setFeedback({ kind: 'ok', text: action === 'install' ? t('compaction.settings.mcInstalled') : t('compaction.settings.mcUpdated') });
		} catch (error) {
			setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
		} finally {
			setPluginBusy(false);
		}
	}, [bridge, pluginBusy, t]);

	const refreshPlugin = useCallback(async () => {
		if (!bridge) return;
		try {
			const magic = await bridge.refreshMagicContextPluginStatus();
			setDraft((current) => ({ ...current, magic: magic.config, magicVersion: magic.configVersion }));
			setPlugin(magic.plugin);
		} catch (error) {
			setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
		}
	}, [bridge]);

	const modelOptions = useMemo(() => models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.name || model.id} · ${model.provider}` })), [models]);

	if (!draft.loaded) {
		return <section className="pd-compaction-settings" aria-label={t('compaction.settings.title')}>
			<SettingsGroup title={t('compaction.settings.title')}><p className="pd-compaction-settings-loading" role="status">{t('compaction.settings.loading')}</p></SettingsGroup>
		</section>;
	}

	return <section className="pd-compaction-settings" aria-label={t('compaction.settings.title')}>
		<SettingsGroup title={t('compaction.settings.title')} description={t('compaction.settings.description')}>
			<SettingsRow stacked title={t('compaction.settings.mode')} description={t('compaction.settings.modeDescription')}>
				<div className="pd-compaction-mode-picker" role="radiogroup" aria-label={t('compaction.settings.mode')}>
					{(['builtin', 'magicContext'] as const).map((value) => (
						<button key={value} type="button" role="radio" aria-checked={mode === value} className={`pd-compaction-mode${mode === value ? ' is-selected' : ''}`} data-mode={value} onClick={() => patch({ preferences: { ...draft.preferences, mode: value } })}>
							<strong>{t(`compaction.settings.mode.${value}.title`)}</strong>
							<span>{t(`compaction.settings.mode.${value}.description`)}</span>
						</button>
					))}
				</div>
			</SettingsRow>

			{mode === 'builtin' && <>
				<SettingsRow title={t('compaction.settings.autoTitle')} description={t('compaction.settings.autoDescription')} setting="compaction-auto">
					<SettingsSwitch checked={draft.pi.enabled} label={t('compaction.settings.autoTitle')} onChange={(next) => patchPi({ enabled: next })} />
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.thresholdTitle')} description={t('compaction.settings.thresholdDescription')} labelFor="compaction-reserve" setting="compaction-reserve">
					<input id="compaction-reserve" className="pd-compaction-number" type="number" min={0} step={1024} value={draft.pi.reserveTokens} disabled={!draft.pi.enabled}
						onChange={(event) => patchPi({ reserveTokens: integerInput(event.target.value, draft.pi.reserveTokens) })} />
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.keepRecentTitle')} description={t('compaction.settings.keepRecentDescription')} labelFor="compaction-keep" setting="compaction-keep">
					<input id="compaction-keep" className="pd-compaction-number" type="number" min={0} step={1024} value={draft.pi.keepRecentTokens} disabled={!draft.pi.enabled}
						onChange={(event) => patchPi({ keepRecentTokens: integerInput(event.target.value, draft.pi.keepRecentTokens) })} />
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.modelTitle')} description={t('compaction.settings.modelDescription')} labelFor="compaction-model" setting="compaction-model">
					<select id="compaction-model" value={modelValue} onChange={(event) => {
						const value = event.target.value;
						if (value === FOLLOW_MODEL) { patch({ preferences: { ...draft.preferences, compressModel: null } }); return; }
						const separator = value.indexOf('/');
						patch({ preferences: { ...draft.preferences, compressModel: { provider: value.slice(0, separator), id: value.slice(separator + 1) } } });
					}}>
						<option value={FOLLOW_MODEL}>{t('compaction.settings.modelFollow')}</option>
						{modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
					</select>
				</SettingsRow>
			</>}

			{mode === 'magicContext' && <>
				<SettingsRow stacked title={t('compaction.settings.mcPluginTitle')} description={t('compaction.settings.mcPluginDescription')}>
					<div className="pd-compaction-plugin-state">
						{plugin.installed ? <>
							<span className={`pd-compaction-plugin-badge${plugin.enabled === false ? ' is-off' : plugin.enabled ? '' : ' is-unknown'}`}>
								{t(plugin.enabled === false ? 'compaction.settings.mcDisabled' : plugin.enabled ? 'compaction.settings.mcEnabled' : 'compaction.settings.mcStateUnknown')}
							</span>
							{plugin.installedVersion && <span className="pd-compaction-plugin-version">v{plugin.installedVersion}</span>}
							{plugin.updateAvailable && <button type="button" className="pd-compaction-plugin-action" disabled={pluginBusy} onClick={() => void runPluginAction('update')}>{t('compaction.settings.mcUpdateNow')}</button>}
							<button type="button" className="pd-compaction-plugin-action is-ghost" disabled={pluginBusy} onClick={() => void refreshPlugin()}>{t('compaction.settings.mcRefresh')}</button>
						</> : <>
							<span className="pd-compaction-plugin-badge is-off">{t('compaction.settings.mcNotInstalled')}</span>
							<button type="button" className="pd-compaction-plugin-action" disabled={pluginBusy} onClick={() => void runPluginAction('install')}>{t('compaction.settings.mcInstall')}</button>
						</>}
						{pluginBusy && <span className="pd-compaction-plugin-busy" role="status">{t('compaction.settings.mcBusy')}</span>}
					</div>
					{!plugin.installed && <p className="pd-compaction-plugin-hint">{t('compaction.settings.mcInstallHint')}</p>}
					{plugin.installed && <p className="pd-compaction-plugin-hint">{t('compaction.settings.mcProjectOverrideHint')}</p>}
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.mcEnabledTitle')} description={t('compaction.settings.mcEnabledDescription')} setting="mc-enabled">
					<SettingsSwitch checked={draft.magic.enabled} label={t('compaction.settings.mcEnabledTitle')} onChange={(next) => patchMagic({ enabled: next })} />
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.mcModelTitle')} description={t('compaction.settings.mcModelDescription')} labelFor="mc-historian-model" setting="mc-historian-model">
					<div className="pd-compaction-inline-controls">
						<input id="mc-historian-model" className="pd-compaction-text" type="text" placeholder="anthropic/claude-haiku-4-5" value={draft.magic.historian.model ?? ''} list="compaction-model-options"
							onChange={(event) => patchMagic({ historian: { ...draft.magic.historian, model: event.target.value.trim() ? event.target.value.trim() : null } })} />
						<select aria-label={t('compaction.settings.mcThinkingTitle')} value={draft.magic.historian.thinkingLevel ?? THINKING_NONE}
							onChange={(event) => patchMagic({ historian: { ...draft.magic.historian, thinkingLevel: event.target.value === THINKING_NONE ? null : event.target.value as 'off' | 'low' | 'medium' | 'high' } })}>
							<option value={THINKING_NONE}>{t('compaction.settings.mcThinkingDefault')}</option>
							{(['off', 'low', 'medium', 'high'] as const).map((level) => <option key={level} value={level}>{t(`compaction.settings.thinking.${level}`)}</option>)}
						</select>
					</div>
				</SettingsRow>
				<SettingsRow stacked title={t('compaction.settings.mcEmbeddingTitle')} description={t('compaction.settings.mcEmbeddingDescription')} setting="mc-embedding">
					<div className="pd-compaction-embedding">
						<select aria-label={t('compaction.settings.mcEmbeddingProvider')} value={draft.magic.embedding.provider}
							onChange={(event) => patchMagic({ embedding: { ...draft.magic.embedding, provider: event.target.value as UiMagicContextConfig['embedding']['provider'] } })}>
							<option value="local">{t('compaction.settings.mcEmbeddingLocal')}</option>
							<option value="openai-compatible">{t('compaction.settings.mcEmbeddingRemote')}</option>
							<option value="off">{t('compaction.settings.mcEmbeddingOff')}</option>
						</select>
						<input className="pd-compaction-text" type="text" aria-label={t('compaction.settings.mcEmbeddingModel')} placeholder="Xenova/all-MiniLM-L6-v2" value={draft.magic.embedding.model ?? ''}
							onChange={(event) => patchMagic({ embedding: { ...draft.magic.embedding, model: event.target.value.trim() ? event.target.value.trim() : null } })} />
						{draft.magic.embedding.provider === 'openai-compatible' && <>
							<input className="pd-compaction-text" type="text" aria-label={t('compaction.settings.mcEmbeddingEndpoint')} placeholder="https://api.openai.com/v1" value={draft.magic.embedding.endpoint ?? ''}
								onChange={(event) => patchMagic({ embedding: { ...draft.magic.embedding, endpoint: event.target.value.trim() ? event.target.value.trim() : null } })} />
							<input className="pd-compaction-text" type="password" aria-label={t('compaction.settings.mcEmbeddingApiKey')} placeholder={draft.magic.embedding.apiKeySet ? t('compaction.settings.mcApiKeyKept') : t('compaction.settings.mcApiKeyPlaceholder')} value={draft.magic.embedding.apiKey ?? ''}
								onChange={(event) => patchMagic({ embedding: { ...draft.magic.embedding, apiKey: event.target.value } })} />
							{draft.magic.embedding.apiKeySet && <button type="button" className="pd-compaction-plugin-action is-ghost" onClick={() => patchMagic({ embedding: { ...draft.magic.embedding, apiKey: '' } })}>{t('compaction.settings.mcApiKeyClear')}</button>}
						</>}
					</div>
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.mcThresholdTitle')} description={t('compaction.settings.mcThresholdDescription')} labelFor="mc-threshold" setting="mc-threshold">
					<input id="mc-threshold" className="pd-compaction-number" type="number" min={20} max={80} value={draft.magic.executeThresholdPercentage ?? ''}
						placeholder="65"
						onChange={(event) => {
							const raw = event.target.value.trim();
							if (!raw) { patchMagic({ executeThresholdPercentage: null }); return; }
							const parsed = Number.parseFloat(raw);
							patchMagic({ executeThresholdPercentage: Number.isFinite(parsed) && parsed >= 20 && parsed <= 80 ? parsed : draft.magic.executeThresholdPercentage });
						}} />
				</SettingsRow>
				<SettingsRow title={t('compaction.settings.mcBudgetTitle')} description={t('compaction.settings.mcBudgetDescription')} labelFor="mc-budget" setting="mc-budget">
					<input id="mc-budget" className="pd-compaction-number" type="number" min={0.05} max={0.5} step={0.05} value={draft.magic.historyBudgetPercentage ?? ''}
						placeholder="0.15"
						onChange={(event) => {
							const raw = event.target.value.trim();
							if (!raw) { patchMagic({ historyBudgetPercentage: null }); return; }
							const parsed = Number.parseFloat(raw);
							patchMagic({ historyBudgetPercentage: Number.isFinite(parsed) && parsed >= 0.05 && parsed <= 0.5 ? parsed : draft.magic.historyBudgetPercentage });
						}} />
				</SettingsRow>
			</>}

			<SettingsRow stacked title={t('compaction.settings.applyTitle')} footer={
				feedback ? <p className={`pd-settings-feedback${feedback.kind === 'error' ? ' is-error' : ''}`} role="status">{feedback.text}</p> : null
			}>
				<div className="pd-compaction-settings-actions">
					<button type="button" className="pd-compaction-settings-save" disabled={busy} onClick={() => void save()}>{t(busy ? 'compaction.settings.saving' : 'compaction.settings.save')}</button>
				</div>
			</SettingsRow>
		</SettingsGroup>
		<datalist id="compaction-model-options">
			{modelOptions.map((option) => <option key={option.value} value={option.value} />)}
		</datalist>
	</section>;
}
