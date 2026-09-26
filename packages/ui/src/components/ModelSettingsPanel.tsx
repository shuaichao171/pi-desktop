import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiCustomProviderModel, UiDiscoveredProviderModel, UiDiscoverProviderModelsRequest, UiModelProvider, UiModelSummary, UiProviderApi, UiProviderAuthStatus, UiProviderHeaders, UiSaveCustomProviderRequest, UiThinkingLevel } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Translate } from '../i18n';
import type { ModelManagementTarget } from '../modelManagement';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import './modelSettingsPanel.css';

const PROTOCOLS: { value: UiProviderApi; label: string }[] = [
	{ value: 'openai-completions', label: 'OpenAI Chat Completions' },
	{ value: 'openai-responses', label: 'OpenAI Responses' },
	{ value: 'anthropic-messages', label: 'Anthropic Messages' },
	{ value: 'google-generative-ai', label: 'Google Generative AI' },
];

type ProviderTemplate = { id: string; name: string; baseUrl: string; api: UiProviderApi };
const PROVIDER_TEMPLATES: ProviderTemplate[] = [
	{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
	{ id: 'kimi', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
	{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
	{ id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
	{ id: 'siliconflow', name: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions' },
	{ id: 'zhipu', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
	{ id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', api: 'openai-completions' },
];

const THINKING_LEVELS: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_CONTEXT = 128000;
const DEFAULT_OUTPUT = 8192;
type ModelDraft = { id: string; name: string; contextWindow: string; maxTokens: string; reasoning: boolean; image: boolean; thinkingLevelMap?: UiCustomProviderModel['thinkingLevelMap']; thinkingLevels?: UiThinkingLevel[] };
type HeaderDraft = { key: number; name: string; value: string; stored: boolean };
type ImportedDraft = { id: string; draft: ModelDraft; selected: boolean; defaultContext: boolean; defaultOutput: boolean; unknownCapabilities: boolean };
type DraftState = import('../settingsLeaveGuard').SettingsDraftState;
type DraftSaver = () => Promise<boolean>;

/** Native modal boundaries keep nested settings editors out of the page's Tab order. */
function ModelSettingsDialog({ title, children, onClose, busy = false, compact = false, view, returnFocus }: { title: string; children: ReactNode; onClose(): void; busy?: boolean; compact?: boolean; view?: string; returnFocus?: HTMLElement | null }) {
	const ref = useRef<HTMLDialogElement>(null);
	const [opener] = useState(() => returnFocus ?? (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null));
	const { t } = useT();
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		dialog?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), [data-autofocus]')?.focus();
		return () => {
			dialog?.close();
			queueMicrotask(() => {
				const available = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected && !element.closest('[inert]') && !element.matches(':disabled') && element.getClientRects().length);
				if (available(opener)) { opener.focus({ preventScroll: true }); return; }
				// A successful save may replace the original form or provider row.
				const activeDialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
				const fallback = activeDialog?.querySelector<HTMLElement>('input:not(:disabled), [data-autofocus], button:not(:disabled)') ?? document.querySelector<HTMLElement>('.pd-model-provider-option.is-selected:not(:disabled), .pd-settings-nav [aria-current="page"]');
				if (available(fallback)) fallback.focus({ preventScroll: true });
			});
		};
	}, [opener]);
	useEffect(() => { ref.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), [data-autofocus], [data-template]')?.focus(); }, [view]);
	return createPortal(<dialog ref={ref} data-model-dialog={view ?? 'confirm'} role={compact ? 'alertdialog' : 'dialog'} className={`pd-model-dialog${compact ? ' is-compact' : ''}`} aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
		<header className="pd-model-dialog-header"><h3>{title}</h3><button type="button" className="pd-icon-button" aria-label={t('settings.close')} disabled={busy} onClick={onClose}><Icon name="close" width="18" height="18" /></button></header>
		<div className="pd-model-dialog-body">{children}</div>
	</dialog>, document.body);
}

function modelDraft(model?: UiCustomProviderModel & { thinkingLevels?: UiThinkingLevel[] }): ModelDraft {
	const contextWindow = model?.contextWindow ?? Math.max(DEFAULT_CONTEXT, model?.maxTokens ?? 0);
	return { id: model?.id ?? '', name: model?.name ?? '', contextWindow: String(contextWindow), maxTokens: String(model?.maxTokens ?? Math.min(DEFAULT_OUTPUT, contextWindow)), reasoning: model?.reasoning ?? false, image: model?.input?.includes('image') ?? false, ...(model?.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}), thinkingLevels: model?.thinkingLevels };
}

function advertisedThinkingMap(levels: UiThinkingLevel[]): NonNullable<UiCustomProviderModel['thinkingLevelMap']> {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, levels.includes(level) ? level === 'off' ? 'none' : level : null]));
}

function discoveredDraft(model: UiDiscoveredProviderModel): ImportedDraft {
	const draft = modelDraft({ ...model, ...(model.thinkingLevels ? { thinkingLevelMap: advertisedThinkingMap(model.thinkingLevels), reasoning: model.reasoning ?? model.thinkingLevels.some((level) => level !== 'off') } : {}) });
	return { id: model.id, draft, selected: true, defaultContext: model.contextWindow === undefined, defaultOutput: model.maxTokens === undefined, unknownCapabilities: model.reasoning === undefined || model.input === undefined };
}

function modelValue(draft: ModelDraft, api?: string | null): UiCustomProviderModel | null {
	const contextWindow = Number(draft.contextWindow);
	const maxTokens = Number(draft.maxTokens);
	if (!draft.id.trim() || !Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || (api !== 'google-generative-ai' && maxTokens > contextWindow)) return null;
	return { id: draft.id.trim(), name: draft.name.trim() || undefined, contextWindow, maxTokens, reasoning: draft.reasoning, input: draft.image ? ['text', 'image'] : ['text'], ...(draft.thinkingLevelMap ? { thinkingLevelMap: { ...draft.thinkingLevelMap } } : {}) };
}

function serializeModel(model: UiModelSummary): UiCustomProviderModel {
	return { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, input: [...model.input], ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}) };
}

function providerRequest(provider: UiModelProvider, models = provider.models.map(serializeModel)): UiSaveCustomProviderRequest {
	return { provider: provider.provider, name: provider.name, baseUrl: provider.baseUrl ?? '', api: provider.api as UiProviderApi, models, mode: 'update' };
}

function connectionIdentity(provider: UiModelProvider): string {
	return JSON.stringify([provider.name, provider.baseUrl, provider.api, [...(provider.headerNames ?? [])].sort(), provider.useSystemProxy]);
}

function modelSize(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '—';
	return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
}

function ModelFields({ draft, onChange, disabled, t, idReadOnly = false }: { draft: ModelDraft; onChange(value: ModelDraft): void; disabled: boolean; t: Translate; idReadOnly?: boolean }) {
	const change = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => onChange({ ...draft, [key]: value });
	const supportedLevels = THINKING_LEVELS.filter((level) => draft.thinkingLevelMap?.[level] !== undefined ? draft.thinkingLevelMap[level] !== null : draft.thinkingLevels?.includes(level));
	const customThinking = Boolean(draft.thinkingLevelMap && Object.keys(draft.thinkingLevelMap).length);
	return <>
		<label className="pd-model-settings-field">{t('settings.customModelId')}<input data-field="model.id" required value={draft.id} onChange={(event) => change('id', event.target.value)} spellCheck={false} autoComplete="off" disabled={disabled} readOnly={idReadOnly} placeholder="my-model" /></label>
		<label className="pd-model-settings-field">{t('settings.customModelName')}<input data-field="model.name" value={draft.name} onChange={(event) => change('name', event.target.value)} disabled={disabled} placeholder={draft.id || 'My model'} /></label>
		<div className="pd-model-settings-field-grid">
			<label className="pd-model-settings-field">{t('settings.customModelContext')}<input data-field="model.contextWindow" required type="number" min="1" step="1" value={draft.contextWindow} onChange={(event) => change('contextWindow', event.target.value)} disabled={disabled} /></label>
			<label className="pd-model-settings-field">{t('settings.customModelOutput')}<input data-field="model.maxTokens" required type="number" min="1" step="1" value={draft.maxTokens} onChange={(event) => change('maxTokens', event.target.value)} disabled={disabled} /></label>
		</div>
		<div className="pd-model-settings-toggles">
			<label><input data-field="model.reasoning" type="checkbox" checked={draft.reasoning} onChange={(event) => change('reasoning', event.target.checked)} disabled={disabled} />{t('settings.customModelReasoning')}</label>
			<label><input data-field="model.image" type="checkbox" checked={draft.image} onChange={(event) => change('image', event.target.checked)} disabled={disabled} />{t('settings.customModelImages')}</label>
		</div>
		{draft.reasoning && <fieldset className="pd-model-thinking-fields" disabled={disabled}>
			<legend>{t('settings.modelThinkingLevels')}</legend>
			<label className="pd-model-settings-check"><input type="checkbox" checked={customThinking} onChange={(event) => change('thinkingLevelMap', event.target.checked ? advertisedThinkingMap(draft.thinkingLevels ?? []) : {})} />{t('settings.modelThinkingCustomize')}</label>
			{customThinking ? <div className="pd-model-settings-toggles">{THINKING_LEVELS.map((level) => <label key={level}><input type="checkbox" checked={supportedLevels.includes(level)} onChange={(event) => {
				const next = advertisedThinkingMap(supportedLevels);
				for (const supported of supportedLevels) if (draft.thinkingLevelMap?.[supported] != null) next[supported] = draft.thinkingLevelMap[supported];
				next[level] = event.target.checked ? level === 'off' ? 'none' : level : null;
				change('thinkingLevelMap', next);
			}} />{t(`composer.thinking.${level}`)}</label>)}</div> : <p className="pd-model-settings-notice">{t('settings.modelThinkingInherited')}</p>}
			<p className="pd-model-settings-notice">{t('settings.modelThinkingHint')}</p>
		</fieldset>}
	</>;
}

function ProviderEditor({ provider, template, disabled, onSave, onCancel, autoDiscover = false, mode = 'create', onDirtyChange, onSaveReady }: { provider?: UiModelProvider; template?: ProviderTemplate; disabled: boolean; onSave(request: UiSaveCustomProviderRequest): Promise<boolean>; onCancel(): void; autoDiscover?: boolean; mode?: 'create' | 'connection' | 'discover'; onDirtyChange?(dirty: boolean): void; onSaveReady?(save: DraftSaver | null): void }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const [id, setId] = useState(provider?.provider ?? template?.id ?? '');
	const [name, setName] = useState(provider?.name ?? template?.name ?? '');
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? template?.baseUrl ?? '');
	const [api, setApi] = useState<UiProviderApi>((provider?.api as UiProviderApi) ?? template?.api ?? 'openai-completions');
	const [keyVisible, setKeyVisible] = useState(false);
	const [apiKey, setApiKey] = useState('');
	const [headers, setHeaders] = useState<HeaderDraft[]>(() => (provider?.headerNames ?? []).map((name, key) => ({ key, name, value: '', stored: true })));
	const [headersChanged, setHeadersChanged] = useState(false);
	const nextHeaderKey = useRef(headers.length);
	const [useSystemProxy, setUseSystemProxy] = useState<boolean | undefined>(provider ? provider.useSystemProxy : true);
	const proxyRef = useRef<HTMLInputElement>(null);
	const [manualEnabled, setManualEnabled] = useState(false);
	const [firstModel, setFirstModel] = useState(() => modelDraft());
	const [imports, setImports] = useState<ImportedDraft[]>([]);
	const [importSearch, setImportSearch] = useState('');
	const [expandedImport, setExpandedImport] = useState<string | null>(null);
	const [discovery, setDiscovery] = useState<{ count: number; preserved: number; warnings: string[] } | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const discoveryRef = useRef<HTMLElement>(null);
	const [error, setError] = useState<string | null>(null);
	const requestGeneration = useRef(0);
	const autoStarted = useRef(false);
	const busy = disabled || discovering;
	const selectedImports = imports.filter((item) => item.selected);
	const matchingImports = imports.filter((item) => `${item.draft.id} ${item.draft.name}`.toLocaleLowerCase().includes(importSearch.trim().toLocaleLowerCase()));
	const draftValue = JSON.stringify({ id, name, baseUrl, api, apiKey, headers, headersChanged, useSystemProxy, manualEnabled, firstModel, imports });
	const initialValue = useRef(draftValue);
	const initialConnection = useRef(provider ? connectionIdentity(provider) : null);
	const dirty = initialValue.current !== draftValue;
	useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
	useLayoutEffect(() => { if (proxyRef.current) proxyRef.current.indeterminate = useSystemProxy === undefined; }, [useSystemProxy]);
	useEffect(() => {
		requestGeneration.current += 1;
		setDiscovering(false);
		return () => { requestGeneration.current += 1; autoStarted.current = false; };
	}, [bridge]);
	useEffect(() => {
		if (!autoDiscover || autoStarted.current || disabled || !bridge) return;
		autoStarted.current = true;
		void discover(true);
	}, [autoDiscover, disabled, bridge]);
	useLayoutEffect(() => {
		if (!autoDiscover || !discovery || !discoveryRef.current) return;
		const detail = discoveryRef.current.closest<HTMLElement>('.pd-model-provider-detail');
		if (detail) detail.scrollTop += discoveryRef.current.getBoundingClientRect().top - detail.getBoundingClientRect().top - 12;
	}, [autoDiscover, discovery]);

	function invalidateDiscovery() {
		// 调用者先捕获输入值，再清理目录状态，避免同步渲染后读取到旧 DOM 值。
		requestGeneration.current += 1;
		setDiscovering(false); setImports([]); setDiscovery(null); setExpandedImport(null); setError(null);
	}
	function headerValues(): UiProviderHeaders | undefined {
		if (!headersChanged) return undefined;
		const values: UiProviderHeaders = Object.create(null);
		const seen = new Set<string>();
		for (const header of headers) {
			const name = header.name.trim();
			if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(header.value) || seen.has(name.toLowerCase())) throw new Error(t('settings.providerHeaderInvalid'));
			seen.add(name.toLowerCase());
			values[name] = header.stored && header.value === '' ? null : header.value;
		}
		return values;
	}
	function validateConnection(requireId: boolean) {
		try {
			const url = new URL(baseUrl.trim());
			if ((requireId && !id.trim()) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
		} catch { throw new Error(t(requireId ? 'settings.providerRequired' : 'settings.providerConnectionRequired')); }
	}
	function connectionRequest(requireId = false): UiDiscoverProviderModelsRequest {
		validateConnection(requireId);
		const values = headerValues();
		return { ...(provider ? { provider: provider.provider } : {}), baseUrl: baseUrl.trim(), api, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(values !== undefined ? { headers: values } : {}), ...(useSystemProxy !== undefined ? { useSystemProxy } : {}) };
	}
	async function discover(savedConnection = false) {
		if (disabled || discovering || !bridge) return;
		let request: UiDiscoverProviderModelsRequest;
		try { request = savedConnection && provider ? { provider: provider.provider } : connectionRequest(); }
		catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
		const generation = ++requestGeneration.current;
		setDiscovering(true); setError(null);
		try {
			const result = await bridge.discoverProviderModels(request);
			if (requestGeneration.current !== generation) return;
			const existing = new Set(provider?.models.map((model) => model.id) ?? []);
			const unique = new Map(result.models.map((model) => [model.id, model]));
			const additions = [...unique.values()].filter((model) => !existing.has(model.id));
			setImports((previous) => {
				const drafts = new Map(previous.map((item) => [item.id, item]));
				return additions.map((model) => drafts.get(model.id) ?? discoveredDraft(model));
			});
			setDiscovery({ count: unique.size, preserved: unique.size - additions.length, warnings: result.warnings });
		} catch (reason) {
			if (requestGeneration.current === generation) setError(reason instanceof Error ? reason.message : String(reason));
		} finally { if (requestGeneration.current === generation) setDiscovering(false); }
	}
	function changeHeaders(next: HeaderDraft[]) {
		invalidateDiscovery(); setHeaders(next); setHeadersChanged(true);
	}
	async function submit(event?: FormEvent<HTMLFormElement>): Promise<boolean> {
		event?.preventDefault();
		if (busy) return false;
		setError(null);
		// 长驻表单遇到目录外部更新时保留草稿，避免整份写入覆盖新连接。
		if (mode === 'connection' && provider) {
			const current = useChatStore.getState().modelProviders.find((item) => item.provider === provider.provider);
			if (!current || initialConnection.current !== connectionIdentity(current)) { setError(t('settings.modelCatalogChanged')); return false; }
		}
		let connection: UiDiscoverProviderModelsRequest;
		try {
			connection = connectionRequest(true);
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
		const invalidImport = selectedImports.find((item) => !modelValue(item.draft, api));
		if (invalidImport) {
			setExpandedImport(invalidImport.id); setImportSearch(invalidImport.id);
			setError(`${invalidImport.id}: ${t(api === 'google-generative-ai' ? 'settings.customModelIndependentRequired' : 'settings.customModelRequired')}`);
			return false;
		}
		const additions = selectedImports.map((item) => modelValue(item.draft, api));
		if (!provider && manualEnabled) additions.push(modelValue(firstModel, api));
		if (additions.some((item) => !item)) { setError(t(api === 'google-generative-ai' ? 'settings.customModelIndependentRequired' : 'settings.customModelRequired')); return false; }
		const models = [...(provider?.models.map(serializeModel) ?? []), ...additions as UiCustomProviderModel[]];
		if (!models.length) { setError(t('settings.providerChooseModels')); return false; }
		if (new Set(models.map((model) => model.id)).size !== models.length) { setError(t('settings.customModelDuplicate')); return false; }
		const saved = await onSave({ ...connection, provider: id.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), api, models, mode: provider ? 'update' : 'create' });
		if (saved) setApiKey('');
		return saved;
	}
	useEffect(() => { onSaveReady?.(() => submit()); return () => onSaveReady?.(null); });
	return <form className={`pd-model-settings-form is-${mode}`} data-provider-editor={provider ? 'edit' : 'create'} onSubmit={(event) => void submit(event)}>
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		{mode !== 'discover' && <>
		{mode === 'create' && <label className="pd-model-settings-field">{t('settings.providerId')}<input data-field="provider.id" required value={id} onChange={(event) => { const value = event.target.value; invalidateDiscovery(); setId(value); }} disabled={busy || Boolean(provider)} spellCheck={false} autoComplete="off" placeholder="my-provider" /><small>{t('settings.providerIdHint')}</small></label>}
		<label className="pd-model-settings-field">{t('settings.providerName')}<input data-field="provider.name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} placeholder={id || 'My provider'} /></label>
		<label className="pd-model-settings-field">{t('settings.providerBaseUrl')}<input data-field="provider.baseUrl" required type="url" value={baseUrl} onChange={(event) => { const value = event.target.value; invalidateDiscovery(); setBaseUrl(value); }} disabled={busy} spellCheck={false} autoComplete="off" placeholder="https://api.example.com/v1" /><small>{t('settings.providerBaseUrlHint')}</small></label>
		<label className="pd-model-settings-field">{t('settings.providerProtocol')}<select data-field="provider.api" value={api} onChange={(event) => { const value = event.target.value as UiProviderApi; invalidateDiscovery(); setApi(value); }} disabled={busy}>{PROTOCOLS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
		{mode === 'create' && <label className="pd-model-settings-field">{t('settings.apiKey')}<span className="pd-model-key-row"><input data-field="provider.apiKey" type={keyVisible ? 'text' : 'password'} value={apiKey} onChange={(event) => { const value = event.target.value; invalidateDiscovery(); setApiKey(value); }} disabled={busy} autoComplete="new-password" spellCheck={false} placeholder={t(provider?.configured ? 'settings.replaceKey' : 'settings.enterKey')} /><button type="button" className="pd-model-key-reveal" data-action="toggle-key-visibility" disabled={busy} aria-label={t(keyVisible ? 'settings.hideApiKey' : 'settings.showApiKey')} aria-pressed={keyVisible} onClick={() => setKeyVisible(!keyVisible)}><Icon name={keyVisible ? 'eyeOff' : 'eye'} width="14" height="14" /></button></span><small>{t('settings.providerKeyOptional')}</small></label>}
		<details className="pd-model-advanced"><summary>{t('settings.providerAdvanced')}</summary>
		<section className="pd-model-headers" aria-label={t('settings.providerHeaders')}>
			<div className="pd-model-settings-subhead"><h4>{t('settings.providerHeaders')}</h4><button type="button" className="pd-model-settings-button" data-action="add-header" disabled={busy} onClick={() => changeHeaders([...headers, { key: nextHeaderKey.current++, name: '', value: '', stored: false }])}><Icon name="plus" width="13" height="13" />{t('settings.providerHeaderAdd')}</button></div>
			<p className="pd-model-settings-notice">{t('settings.providerHeadersHint')}</p>
			{headers.map((header) => <div key={header.key} className="pd-model-header-row">
				<label className="pd-model-settings-field"><span>{t('settings.providerHeaderName')}</span><input data-field="header.name" value={header.name} readOnly={header.stored} disabled={busy} placeholder="X-API-Version" spellCheck={false} autoComplete="off" onChange={(event) => changeHeaders(headers.map((item) => item.key === header.key ? { ...item, name: event.target.value } : item))} /></label>
				<label className="pd-model-settings-field"><span>{t('settings.providerHeaderValue')}</span><input data-field="header.value" type="password" value={header.value} disabled={busy} placeholder={t(header.stored ? 'settings.providerHeaderKeep' : 'settings.providerHeaderEnter')} spellCheck={false} autoComplete="new-password" onChange={(event) => changeHeaders(headers.map((item) => item.key === header.key ? { ...item, value: event.target.value } : item))} /></label>
				<button type="button" className="pd-model-settings-button is-danger" disabled={busy} aria-label={t('settings.providerHeaderRemove', { name: header.name || t('settings.providerHeaderName') })} onClick={() => changeHeaders(headers.filter((item) => item.key !== header.key))}><Icon name="close" width="13" height="13" /></button>
			</div>)}
		</section>
		<div className="pd-model-proxy"><label className="pd-model-settings-check"><input ref={proxyRef} data-field="provider.useSystemProxy" type="checkbox" checked={useSystemProxy === true} aria-checked={useSystemProxy === undefined ? 'mixed' : useSystemProxy} disabled={busy} onChange={(event) => { const value = event.target.checked; invalidateDiscovery(); setUseSystemProxy(value); }} />{t('settings.providerSystemProxy')}</label><p className="pd-model-settings-notice">{t(useSystemProxy === undefined ? 'settings.providerProxyInherited' : useSystemProxy ? 'settings.providerProxyEnabled' : 'settings.providerProxyDisabled')}</p></div>
		</details>
		</>}
		{mode !== 'connection' && <>
		<section ref={discoveryRef} className="pd-model-discovery" aria-label={t('settings.providerFetchModels')} aria-busy={discovering}>
			<div className="pd-model-discovery-heading"><div><h4>{t('settings.model')}</h4><p className="pd-model-settings-notice">{t('settings.providerFetchHint')}</p></div><button type="button" className="pd-model-settings-button" data-action="fetch-models" disabled={busy || !bridge} onClick={() => void discover()}><Icon name="refresh" width="13" height="13" />{t(discovering ? 'settings.providerFetchingModels' : 'settings.providerFetchModels')}</button></div>
			{discovering && <p className="pd-model-settings-notice" role="status">{t('settings.providerFetchingModels')}</p>}
			{discovery && <div className="pd-model-discovery-status" role="status"><p>{t('settings.providerDiscoveryResult', { count: discovery.count, added: imports.length, preserved: discovery.preserved })}</p><p className="pd-model-settings-notice">{t('settings.providerDiscoveryPending')}</p>{!discovery.count && <p className="pd-model-settings-notice">{t('settings.providerDiscoveryEmpty')}</p>}{discovery.warnings.map((warning, index) => <p className="pd-model-settings-notice" key={index}>{warning}</p>)}</div>}
			{imports.length > 0 && <>
				<div className="pd-model-import-toolbar"><span>{t('settings.providerImportSelected', { selected: selectedImports.length, count: imports.length })}</span><button type="button" className="pd-model-settings-button" disabled={busy} onClick={() => setImports(imports.map((item) => ({ ...item, selected: true })))}>{t('settings.providerImportSelectAll')}</button><button type="button" className="pd-model-settings-button" disabled={busy} onClick={() => setImports(imports.map((item) => ({ ...item, selected: false })))}>{t('settings.providerImportSelectNone')}</button></div>
				<input className="pd-model-provider-search" type="search" value={importSearch} onChange={(event) => setImportSearch(event.target.value)} aria-label={t('composer.pickerSearchLabel')} placeholder={t('composer.pickerSearchPlaceholder')} />
				<div className="pd-model-import-list">{matchingImports.map((item) => <div key={item.id} className="pd-model-import-item" data-import-model={item.id}>
					<div className="pd-model-import-row"><label className="pd-model-import-selection"><input type="checkbox" checked={item.selected} disabled={busy} onChange={(event) => setImports(imports.map((entry) => entry.id === item.id ? { ...entry, selected: event.target.checked } : entry))} /><span><strong>{item.draft.name || item.id}</strong><code>{item.id}</code></span></label><button type="button" className="pd-model-settings-button" disabled={busy} aria-expanded={expandedImport === item.id} aria-label={`${t('settings.customModelEdit')} ${item.id}`} onClick={() => setExpandedImport(expandedImport === item.id ? null : item.id)}>{t('settings.modelSettingsEdit')}<Icon name={expandedImport === item.id ? 'chevronDown' : 'chevronRight'} width="12" height="12" /></button></div>
					<div className="pd-model-import-meta"><span>{t(item.defaultContext ? 'settings.providerImportDefaultContext' : 'settings.providerImportContext', { count: item.draft.contextWindow })}</span><span>{t(item.defaultOutput ? 'settings.providerImportDefaultOutput' : 'settings.providerImportOutput', { count: item.draft.maxTokens })}</span></div>
					{expandedImport === item.id && <div className="pd-model-import-fields">{(item.defaultContext || item.defaultOutput) && <p className="pd-model-settings-notice">{t('settings.providerImportDefaultsHint')}</p>}{item.unknownCapabilities && <p className="pd-model-settings-notice">{t('settings.providerImportCapabilitiesHint')}</p>}<ModelFields draft={item.draft} disabled={busy || !item.selected} t={t} idReadOnly onChange={(draft) => setImports(imports.map((entry) => entry.id === item.id ? { ...entry, draft, defaultContext: entry.defaultContext && draft.contextWindow === entry.draft.contextWindow, defaultOutput: entry.defaultOutput && draft.maxTokens === entry.draft.maxTokens } : entry))} /></div>}
				</div>)}</div>
				{!matchingImports.length && <p className="pd-model-settings-notice">{t('settings.modelNoMatch')}</p>}
			</>}
		</section>
		{!provider && <div className="pd-model-manual"><label className="pd-model-settings-check"><input type="checkbox" checked={manualEnabled} disabled={busy} onChange={(event) => setManualEnabled(event.target.checked)} />{t('settings.providerManualModel')}</label>{manualEnabled && <div className="pd-model-import-fields"><p className="pd-model-settings-notice">{t('settings.providerFirstModelHint')}</p><ModelFields draft={firstModel} onChange={setFirstModel} disabled={busy} t={t} /></div>}</div>}
		</>}
		{(mode !== 'connection' || dirty) && <div className="pd-model-settings-form-actions"><button type="button" data-action={mode === 'connection' ? 'cancel-connection' : undefined} className="pd-model-settings-button" onClick={onCancel} disabled={disabled}>{t('settings.modelSettingsCancel')}</button><button type="submit" data-action={mode === 'connection' ? 'save-connection' : mode === 'discover' ? 'import-models' : 'save-provider'} className="pd-settings-primary" disabled={busy || (mode === 'discover' && selectedImports.length === 0)}>{t(mode === 'discover' ? 'settings.providerImportConfirm' : 'settings.save', { count: selectedImports.length })}</button></div>}
	</form>;
}

function ModelEditor({ model, api, disabled, onSave, onCancel, onDirtyChange, onSaveReady }: { model?: UiModelSummary; api?: string | null; disabled: boolean; onSave(value: UiCustomProviderModel): Promise<boolean>; onCancel(): void; onDirtyChange?(dirty: boolean): void; onSaveReady?(save: DraftSaver | null): void }) {
	const { t } = useT();
	const [draft, setDraft] = useState(() => modelDraft(model));
	const [error, setError] = useState<string | null>(null);
	const initial = useRef(JSON.stringify(draft));
	const dirty = initial.current !== JSON.stringify(draft);
	useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
	async function submit(event?: FormEvent<HTMLFormElement>): Promise<boolean> {
		event?.preventDefault();
		if (disabled) return false;
		const value = modelValue(draft, api);
		if (!value) { setError(t(api === 'google-generative-ai' ? 'settings.customModelIndependentRequired' : 'settings.customModelRequired')); return false; }
		setError(null);
		return onSave(value);
	}
	useEffect(() => { onSaveReady?.(() => submit()); return () => onSaveReady?.(null); });
	return <form className="pd-model-settings-form pd-model-settings-inline-editor" data-model-editor={model?.id ?? 'new'} onSubmit={(event) => void submit(event)}>
		<ModelFields draft={draft} onChange={setDraft} disabled={disabled} t={t} />
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		<div className="pd-model-settings-form-actions"><button type="button" className="pd-model-settings-button" disabled={disabled} onClick={onCancel}>{t('settings.modelSettingsCancel')}</button><button type="submit" className="pd-settings-primary" disabled={disabled}>{t('settings.save')}</button></div>
	</form>;
}

type SettingsEditor = { kind: 'templates' } | { kind: 'create'; template?: ProviderTemplate } | { kind: 'discover'; provider: UiModelProvider } | { kind: 'model'; provider: UiModelProvider; model?: UiModelSummary };

export function ModelSettingsPanel({ initialTarget, renderCredential, onDraftStateChange }: {
	initialTarget?: ModelManagementTarget;
	renderCredential(provider: UiProviderAuthStatus, onDraftStateChange?: (state: DraftState) => void): ReactNode;
	onDraftStateChange?(state: DraftState): void;
}) {
	const { t, locale } = useT();
	const providers = useChatStore((state) => state.modelProviders);
	const availableModels = useChatStore((state) => state.models);
	const providerAuth = useChatStore((state) => state.providerAuth);
	const model = useChatStore((state) => state.model);
	const modelProvider = useChatStore((state) => state.modelProvider);
	const thinking = useChatStore((state) => state.thinkingLevel);
	const levels = useChatStore((state) => state.availableThinkingLevels);
	const loading = useChatStore((state) => state.settingsLoading);
	const status = useChatStore((state) => state.status);
	const cwd = useChatStore((state) => state.cwd);
	const bridge = useChatStore((state) => state.bridge);
	const refreshProviders = useChatStore((state) => state.refreshModelProviders);
	const refreshModels = useChatStore((state) => state.refreshModels);
	const refreshAuth = useChatStore((state) => state.refreshProviderAuth);
	const saveProvider = useChatStore((state) => state.saveCustomProvider);
	const removeProvider = useChatStore((state) => state.removeCustomProvider);
	const setModel = useChatStore((state) => state.setModel);
	const setModelEnabled = useChatStore((state) => state.setModelEnabled);
	const setThinking = useChatStore((state) => state.setThinkingLevel);
	const targetProvider = initialTarget?.kind === 'provider' ? initialTarget.provider : '';
	const [selectedId, setSelectedId] = useState(targetProvider);
	const [search, setSearch] = useState('');
	const [modelSearch, setModelSearch] = useState('');
	const [editor, setEditor] = useState<SettingsEditor | null>(initialTarget?.kind === 'add-provider' ? { kind: 'templates' } : null);
	const [confirmRemove, setConfirmRemove] = useState<'provider' | { model: string } | null>(null);
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [connectionDirty, setConnectionDirty] = useState(false);
	const [modalDirty, setModalDirty] = useState(false);
	const [credentialState, setCredentialState] = useState<DraftState>({ dirty: false, saving: false });
	const [connectionRevision, setConnectionRevision] = useState(0);
	const [credentialRevision, setCredentialRevision] = useState(0);
	const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
	const [savingLeave, setSavingLeave] = useState(false);
	const [leaveError, setLeaveError] = useState(false);
	const saveLeaveLock = useRef(false);
	const connectionSaver = useRef<DraftSaver | null>(null);
	const modalSaver = useRef<DraftSaver | null>(null);
	const credentialSaver = useRef<DraftSaver | undefined>(undefined);
	const reportConnectionSaver = useCallback((save: DraftSaver | null) => { connectionSaver.current = save; }, []);
	const reportModalSaver = useCallback((save: DraftSaver | null) => { modalSaver.current = save; }, []);
	const generation = useRef(0);
	const detailRef = useRef<HTMLDivElement>(null);
	const credentialRef = useRef<HTMLDivElement>(null);
	const focusedTarget = useRef('');
	const draftFocus = useRef<HTMLElement | null>(null);
	const dirty = connectionDirty || modalDirty || credentialState.dirty;
	const saving = pending || credentialState.saving;
	const canChange = status === 'idle' && !loading && !saving;
	const waitingForAgent = status === 'starting' || status === 'uninitialized';
	const authByProvider = useMemo(() => new Map(providerAuth.map((item) => [item.provider, item])), [providerAuth]);
	const configured = (item: UiModelProvider) => authByProvider.get(item.provider)?.configured ?? item.configured;
	const defaultProvider = providers.find((item) => item.provider === modelProvider && configured(item)) ?? providers.find(configured) ?? providers[0];
	const selected = providers.find((item) => item.provider === selectedId) ?? defaultProvider;
	const selectedConfigured = selected ? configured(selected) : false;
	const matches = providers.filter((item) => `${item.provider} ${item.name}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
	const groups = [{ id: 'configured', items: matches.filter(configured), label: 'settings.providersConfigured' }, { id: 'unconfigured', items: matches.filter((item) => !configured(item)), label: 'settings.providersUnconfigured' }];
	const filteredModels = selected?.models.filter((item) => `${item.id} ${item.name}`.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())) ?? [];
	const availableIds = new Set(availableModels.map((item) => `${item.provider}/${item.id}`));
	const disabledIds = new Set(selected?.disabledModels ?? []);
	const reportCredential = useCallback((value: DraftState) => { credentialSaver.current = value.save; setCredentialState((old) => old.dirty === value.dirty && old.saving === value.saving ? old : value); }, []);
	const saveAllRef = useRef<DraftSaver>(async () => false);
	saveAllRef.current = async () => {
		if (!canChange || saveLeaveLock.current) return false;
		if ((modalDirty && !modalSaver.current) || (connectionDirty && !connectionSaver.current) || (credentialState.dirty && !credentialSaver.current)) return false;
		saveLeaveLock.current = true;
		const saves = [modalDirty ? modalSaver.current : null, connectionDirty ? connectionSaver.current : null, credentialState.dirty ? credentialSaver.current : null];
		try { for (const save of saves) if (save && !await save()) return false; return true; } finally { saveLeaveLock.current = false; }
	};
	const saveAll = useCallback(() => saveAllRef.current(), []);
	useEffect(() => { onDraftStateChange?.({ dirty, saving: saving || savingLeave, save: dirty ? saveAll : undefined }); }, [dirty, saving, savingLeave, saveAll, onDraftStateChange]);
	useEffect(() => () => onDraftStateChange?.({ dirty: false, saving: false }), [onDraftStateChange]);
	const refreshCatalog = useCallback(async () => {
		const results = await Promise.allSettled([refreshProviders(), refreshModels(), refreshAuth()]);
		const failed = results.find((result) => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}, [refreshProviders, refreshModels, refreshAuth]);
	useEffect(() => {
		const request = ++generation.current;
		if (bridge && !waitingForAgent) void refreshCatalog().catch((reason: unknown) => {
			if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason));
		});
		return () => { generation.current += 1; };
	}, [bridge, cwd, waitingForAgent, refreshCatalog]);
	useLayoutEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selected?.provider]);
	useEffect(() => {
		if (!targetProvider || selected?.provider !== targetProvider || focusedTarget.current === targetProvider || editor || !canChange) return;
		if (credentialRef.current) {
			const input = credentialRef.current.querySelector<HTMLElement>('input:not(:disabled)');
			if (!input) return;
			focusedTarget.current = targetProvider;
			input.focus({ preventScroll: true });
			credentialRef.current.scrollIntoView({ block: 'nearest' });
		}
	}, [targetProvider, selected?.provider, editor, canChange]);
	function resetDrafts() {
		setConnectionDirty(false); setModalDirty(false); setCredentialState({ dirty: false, saving: false });
		setConnectionRevision((value) => value + 1); setCredentialRevision((value) => value + 1); setEditor(null); setConfirmRemove(null);
	}
	function navigate(action: () => void) {
		if (pendingRef.current || credentialState.saving || saveLeaveLock.current) return;
		if (dirty) { setLeaveError(false); setLeaveAction(() => action); return; }
		setError(null); setFeedback(null); action();
	}
	function selectProvider(id: string) {
		if (id === selected?.provider) return;
		navigate(() => { resetDrafts(); setSelectedId(id); setModelSearch(''); });
	}
	async function run(work: () => Promise<void>, success?: string): Promise<boolean> {
		if (pendingRef.current) return false;
		const request = generation.current;
		pendingRef.current = true; setPending(true); setError(null); setFeedback(null);
		try {
			await work();
			if (generation.current !== request) return false;
			if (success) setFeedback(t(success));
			return true;
		} catch (reason) {
			if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason));
			return false;
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}
	const latestProvider = (id: string) => useChatStore.getState().modelProviders.find((item) => item.provider === id);
	async function saveModel(value: UiCustomProviderModel): Promise<boolean> {
		if (!canChange || editor?.kind !== 'model') return false;
		const current = latestProvider(editor.provider.provider);
		if (!current) { setError(t('settings.modelCatalogChanged')); return false; }
		const originalId = editor.model?.id;
		if (originalId && !current.models.some((item) => item.id === originalId)) { setError(t('settings.modelCatalogChanged')); return false; }
		if (current.models.some((item) => item.id === value.id && item.id !== originalId)) { setError(t('settings.customModelDuplicate')); return false; }
		const models = originalId ? current.models.map((item) => item.id === originalId ? value : serializeModel(item)) : [...current.models.map(serializeModel), value];
		if (!await run(() => saveProvider(providerRequest(current, models)), 'settings.customModelSaved')) return false;
		setModalDirty(false); setEditor(null); return true;
	}
	async function saveConnection(request: UiSaveCustomProviderRequest) {
		if (!canChange) return false;
		const current = latestProvider(request.provider);
		if (!current) { setError(t('settings.modelCatalogChanged')); return false; }
		if (!await run(() => saveProvider({ ...request, models: current.models.map(serializeModel) }), 'settings.providerSaved')) return false;
		// 连接和凭据分别保存，更新连接不能卸载并清除尚未保存的密钥草稿。
		setConnectionDirty(false); setConnectionRevision((value) => value + 1); return true;
	}
	async function saveImport(request: UiSaveCustomProviderRequest) {
		if (!canChange || editor?.kind !== 'discover') return false;
		const current = latestProvider(editor.provider.provider);
		if (!current) { setError(t('settings.modelCatalogChanged')); return false; }
		const originalIds = new Set(editor.provider.models.map((item) => item.id));
		const currentIds = new Set(current.models.map((item) => item.id));
		const additions = request.models.filter((item) => !originalIds.has(item.id) && !currentIds.has(item.id));
		if (!additions.length) { setError(t('settings.providerNoNewModels')); return false; }
		if (!await run(() => saveProvider(providerRequest(current, [...current.models.map(serializeModel), ...additions])), 'settings.providerSaved')) return false;
		setModalDirty(false); setEditor(null); return true;
	}
	async function confirmRemoval() {
		if (!selected || !canChange || !confirmRemove) return;
		if (confirmRemove === 'provider') {
			if (await run(() => removeProvider(selected.provider), 'settings.providerRemoved')) { resetDrafts(); setSelectedId(''); }
		} else {
			const current = latestProvider(selected.provider);
			if (!current || current.models.length < 2) { setError(t('settings.customModelLast')); return; }
			if (await run(() => saveProvider(providerRequest(current, current.models.filter((item) => item.id !== confirmRemove.model).map(serializeModel))), 'settings.customModelRemoved')) setConfirmRemove(null);
		}
	}
	const auth = selected ? authByProvider.get(selected.provider) ?? { provider: selected.provider, configured: selectedConfigured, supportsApiKey: selected.custom && selected.editable } : null;
	const openEditor = (next: SettingsEditor) => navigate(() => { setModalDirty(false); setEditor(next); });
	const credential = auth && <div ref={credentialRef} key={`credential:${auth.provider}:${credentialRevision}`} className="pd-model-settings-credentials" tabIndex={-1}>{renderCredential(auth, reportCredential)}</div>;
	const closeEditor = () => navigate(() => { setModalDirty(false); setEditor(null); });
	return <div className="pd-model-settings" onFocusCapture={(event) => { if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) draftFocus.current = event.target; }}>
		<div className="pd-model-page-header"><div className="pd-settings-section-head"><h2>{t('settings.modelManagement')}</h2><p>{t('settings.modelManagementHint')}</p></div><div className="pd-model-page-actions">
			<HoverTooltip title={t('settings.modelSettingsRefresh')}><button type="button" data-action="refresh-providers" className="pd-icon-button" disabled={loading || saving} aria-label={t('settings.modelSettingsRefresh')} onClick={() => navigate(() => { resetDrafts(); void run(refreshCatalog); })}><Icon name="refresh" width="16" height="16" /></button></HoverTooltip>
			<button type="button" data-action="add-provider" className="pd-settings-primary" disabled={!canChange} onClick={() => openEditor({ kind: 'templates' })}><Icon name="plus" width="15" height="15" />{t('settings.providerAdd')}</button>
		</div></div>
		<details className="pd-model-current-summary"><summary>{t('settings.modelCurrentSession')}<strong>{model ? `${modelProvider}/${model}` : t('settings.notSelected')}</strong></summary><div className="pd-model-settings-current"><strong>{t('settings.thinking')}</strong><div className="pd-thinking-options" role="group" aria-label={t('settings.thinking')}>{levels.map((level) => <button key={level} type="button" className={thinking === level ? 'is-selected' : ''} aria-pressed={thinking === level} disabled={!canChange} onClick={() => navigate(() => { void run(() => setThinking(level)); })}>{t(`composer.thinking.${level}`)}</button>)}</div></div></details>
		{status !== 'idle' && <p className="pd-model-settings-notice" role="status">{t('settings.modelBusy')}</p>}
		<div className="pd-model-provider-layout">
			<nav className="pd-model-provider-sidebar" aria-label={t('settings.providers')}>
				<div className="pd-model-provider-heading"><strong>{t('settings.providers')}</strong><span>{providers.length}</span></div>
				<input className="pd-model-provider-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.providerSearch')} aria-label={t('settings.providerSearch')} />
				<div className="pd-model-provider-list">{groups.map((group) => group.items.length > 0 && <section key={group.id} className="pd-model-provider-group" data-provider-group={group.id}><h4>{t(group.label)}</h4>{group.items.map((item) => <button key={item.provider} data-provider={item.provider} type="button" className={`pd-model-provider-option${selected?.provider === item.provider ? ' is-selected' : ''}`} aria-pressed={selected?.provider === item.provider} disabled={saving} onClick={() => selectProvider(item.provider)}>
					<span className="pd-model-provider-monogram" aria-hidden="true">{(item.name || item.provider).slice(0, 2).toUpperCase()}</span><span className="pd-model-provider-option-copy"><strong>{item.name || item.provider}</strong><small>{t('settings.providerCount', { count: item.models.length })}</small></span><span className={`pd-model-provider-state${configured(item) ? ' is-ready' : ''}`} aria-label={t(configured(item) ? 'settings.authAvailable' : 'settings.authMissing')} />
				</button>)}</section>)}
				{!matches.length && <p className="pd-model-settings-notice">{t(loading ? 'settings.providerLoading' : search ? 'settings.providerNoMatch' : 'settings.providerEmpty')}</p>}</div>
			</nav>
			<div ref={detailRef} className="pd-model-provider-detail">
				{selected ? <>
					<div className="pd-model-provider-detail-head"><div><h3>{selected.name || selected.provider}</h3><div className="pd-model-provider-subtitle"><code>{selected.provider}</code><span className="pd-model-provider-badge">{t(selected.custom ? 'settings.providerCustom' : 'settings.providerBuiltin')}</span><span>{t(selectedConfigured ? 'settings.authAvailable' : 'settings.authMissing')}</span></div></div>
						{selected.custom && selected.editable && <HoverTooltip title={t('settings.providerRemove')}><button type="button" data-action="remove-provider" className="pd-icon-button is-danger" disabled={!canChange} aria-label={t('settings.providerRemove')} onClick={() => navigate(() => setConfirmRemove('provider'))}><Icon name="trash" width="16" height="16" /></button></HoverTooltip>}
					</div>
					<section className="pd-model-connection-card"><h4>{t('settings.providerConnection')}</h4>
					{selected.custom && selected.editable ? <ProviderEditor key={`connection:${selected.provider}:${connectionRevision}`} provider={selected} mode="connection" disabled={!canChange} onDirtyChange={setConnectionDirty} onSaveReady={reportConnectionSaver} onSave={saveConnection} onCancel={() => { setConnectionDirty(false); setConnectionRevision((value) => value + 1); }} /> : <>
						<dl className="pd-model-provider-connection"><dt>{t('settings.providerBaseUrl')}</dt><dd>{selected.baseUrl || '—'}</dd><dt>{t('settings.providerProtocol')}</dt><dd>{selected.api || '—'}</dd></dl>
						<p className="pd-model-settings-notice">{t(selected.custom ? 'settings.providerReadOnly' : 'settings.providerBuiltinConnection')}</p>
					</>}
					{credential}
					</section>
					<section className="pd-model-catalog"><div className="pd-model-settings-subhead"><h4>{t('settings.availableModels')} <span className="pd-model-count">{selected.models.length}</span></h4>{selected.custom && selected.editable && <div className="pd-model-page-actions"><button type="button" data-action="discover-models" className="pd-model-settings-button" disabled={!canChange} onClick={() => openEditor({ kind: 'discover', provider: selected })}><Icon name="refresh" width="13" height="13" />{t('settings.providerFetchModels')}</button><button type="button" data-action="add-model" className="pd-model-settings-button" disabled={!canChange} onClick={() => openEditor({ kind: 'model', provider: selected })}><Icon name="plus" width="13" height="13" />{t('settings.customModelAdd')}</button></div>}</div>
						<input className="pd-model-provider-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} aria-label={t('composer.pickerSearchLabel')} placeholder={t('composer.pickerSearchPlaceholder')} />
						<div className="pd-model-settings-models" aria-label={t('settings.availableModels')}>{filteredModels.map((item) => {
							const current = item.provider === modelProvider && item.id === model;
							const available = selectedConfigured && availableIds.has(`${item.provider}/${item.id}`);
							return <div key={item.id} data-model-id={item.id} className={`pd-model-settings-model${current ? ' is-current' : ''}${disabledIds.has(item.id) ? ' is-disabled' : ''}`}>
								<div className="pd-model-settings-model-copy"><strong>{item.name || item.id}</strong><code>{item.id}</code><span className="pd-model-settings-model-meta"><span>{t('settings.context', { size: modelSize(item.contextWindow) })}</span>{item.reasoning && <span>{t('settings.reasoning')}</span>}{item.input.includes('image') && <span>{t('settings.image')}</span>}<span>{t('settings.modelOutputSize', { size: modelSize(item.maxTokens) })}</span></span></div>
								<div className="pd-model-settings-model-actions">
									{current ? <span className="pd-model-settings-current-badge">{t('composer.pickerCurrent')}</span> : <HoverTooltip title={t('settings.customModelUse')}><button type="button" data-action="use-model" className="pd-icon-button" disabled={!canChange || !available} aria-label={`${t('settings.customModelUse')} ${item.name || item.id}`} onClick={() => navigate(() => { void run(() => setModel(item.provider, item.id)); })}><Icon name="check" width="15" height="15" /></button></HoverTooltip>}
									{selected.custom && selected.editable && <><HoverTooltip title={t('settings.customModelEdit')}><button type="button" data-action="edit-model" className="pd-icon-button" disabled={!canChange} aria-label={`${t('settings.customModelEdit')} ${item.name || item.id}`} onClick={() => openEditor({ kind: 'model', provider: selected, model: item })}><Icon name="pencil" width="15" height="15" /></button></HoverTooltip>
									<HoverTooltip title={t(selected.models.length < 2 ? 'settings.customModelLast' : 'settings.customModelRemove')}><button type="button" data-action="remove-model" className="pd-icon-button is-danger" disabled={!canChange || selected.models.length < 2} aria-label={`${t('settings.customModelRemove')} ${item.name || item.id}`} onClick={() => navigate(() => setConfirmRemove({ model: item.id }))}><Icon name="trash" width="15" height="15" /></button></HoverTooltip></>}
									<label className="pd-model-switch" title={t(current ? 'settings.modelDisableCurrent' : 'settings.modelShowInPicker')}><input type="checkbox" role="switch" data-action="toggle-model" checked={!disabledIds.has(item.id)} disabled={!canChange || current} aria-label={`${t('settings.modelShowInPicker')} ${item.name || item.id}`} onChange={(event) => { const checked = event.target.checked; navigate(() => { void run(() => setModelEnabled(selected.provider, item.id, checked)); }); }} /><span className="pd-model-switch-track" aria-hidden="true"><span className="pd-model-switch-thumb" /></span></label>
								</div>
							</div>;
						})}</div>
						{!filteredModels.length && <div className="pd-settings-empty">{t(modelSearch ? 'settings.modelNoMatch' : 'settings.modelEmpty')}</div>}
					</section>
					{!selectedConfigured && <p className="pd-settings-hint">{t('settings.providerConfigureToUse')}</p>}
				</> : <div className="pd-settings-empty">{t('settings.providerSelect')}</div>}
				{error && <div className="pd-settings-error pd-model-detail-feedback" role="alert">{error}</div>}
				{feedback && <p className="pd-model-settings-feedback pd-model-detail-feedback" role="status">{feedback}</p>}
			</div>
		</div>
		{editor && <ModelSettingsDialog view={editor.kind} title={t(editor.kind === 'model' ? editor.model ? 'settings.customModelEdit' : 'settings.customModelAdd' : editor.kind === 'discover' ? 'settings.providerFetchModels' : 'settings.providerAdd')} busy={saving} onClose={closeEditor}>
			{error && <div className="pd-settings-error" role="alert">{error}</div>}
			{editor.kind === 'templates' ? <section className="pd-model-template-picker" data-template-picker><p className="pd-model-settings-notice">{t('settings.providerTemplatesHint')}</p><div className="pd-model-template-grid">{PROVIDER_TEMPLATES.filter((item) => !providers.some((provider) => provider.provider === item.id)).map((template) => <button key={template.id} type="button" data-template={template.id} className="pd-model-template-card" onClick={() => setEditor({ kind: 'create', template })}><strong>{template.name}</strong><code>{template.baseUrl}</code></button>)}<button type="button" data-template="custom" className="pd-model-template-card is-custom" onClick={() => setEditor({ kind: 'create' })}><strong>{t('settings.providerTemplateCustom')}</strong><span>{t('settings.providerTemplateCustomHint')}</span></button></div></section>
			: editor.kind === 'model' ? <ModelEditor key={editor.model?.id ?? 'new'} model={editor.model} api={editor.provider.api} disabled={!canChange} onDirtyChange={setModalDirty} onSaveReady={reportModalSaver} onSave={saveModel} onCancel={closeEditor} />
			: <ProviderEditor key={editor.kind === 'create' ? editor.template?.id ?? 'custom' : editor.provider.provider} mode={editor.kind} provider={editor.kind === 'discover' ? editor.provider : undefined} template={editor.kind === 'create' ? editor.template : undefined} autoDiscover={editor.kind === 'discover'} disabled={!canChange} onDirtyChange={setModalDirty} onSaveReady={reportModalSaver} onCancel={editor.kind === 'create' ? () => navigate(() => { setModalDirty(false); setEditor({ kind: 'templates' }); }) : closeEditor} onSave={editor.kind === 'discover' ? saveImport : async (request) => {
				if (!canChange || !await run(() => saveProvider(request), 'settings.providerSaved')) return false;
				setModalDirty(false); setEditor(null); setSelectedId(request.provider); setSearch(''); setModelSearch(''); return true;
			}} />}
		</ModelSettingsDialog>}
		{confirmRemove && selected && <ModelSettingsDialog compact title={t(confirmRemove === 'provider' ? 'settings.providerRemove' : 'settings.customModelRemove')} busy={saving} onClose={() => setConfirmRemove(null)}><p>{confirmRemove === 'provider' ? t('settings.providerRemoveConfirm', { provider: selected.name || selected.provider }) : t('settings.customModelRemoveConfirm', { model: confirmRemove.model })}</p>{error && <p className="pd-settings-error" role="alert">{error}</p>}<div className="pd-model-settings-form-actions"><button type="button" data-autofocus className="pd-model-settings-button" disabled={saving} onClick={() => setConfirmRemove(null)}>{t('settings.modelSettingsCancel')}</button><button type="button" className="pd-model-settings-button is-danger" data-action="confirm-remove" disabled={!canChange} onClick={() => void confirmRemoval()}>{t('settings.modelSettingsConfirmRemove')}</button></div></ModelSettingsDialog>}
		{leaveAction && <ModelSettingsDialog compact busy={savingLeave} returnFocus={draftFocus.current} title={t('settings.discardTitle')} onClose={() => { if (!savingLeave) setLeaveAction(null); }}><p>{t('settings.discardDescription')}</p>{leaveError && <p role="alert">{locale === 'zh-CN' ? '未能保存，请继续编辑并检查错误。草稿已保留。' : 'Could not save. Continue editing to review the error; your draft is preserved.'}</p>}<div className="pd-model-settings-form-actions"><button type="button" data-autofocus disabled={savingLeave} className="pd-model-settings-button" onClick={() => setLeaveAction(null)}>{t('personalization.keepEditing')}</button><button type="button" data-action="discard-model-draft" disabled={savingLeave} className="pd-model-settings-button" onClick={() => { const action = leaveAction; setLeaveAction(null); resetDrafts(); setError(null); setFeedback(null); action(); }}>{t('personalization.discard')}</button><button type="button" data-action="save-model-draft-and-leave" disabled={savingLeave || !canChange} className="pd-settings-primary" onClick={() => { if (saveLeaveLock.current) return; setSavingLeave(true); setLeaveError(false); void saveAll().then((saved) => { if (saved) { const action = leaveAction; setLeaveAction(null); action(); } else setLeaveError(true); }).catch(() => setLeaveError(true)).finally(() => setSavingLeave(false)); }}>{savingLeave ? t('personalization.saving') : locale === 'zh-CN' ? '保存并继续' : 'Save and continue'}</button></div></ModelSettingsDialog>}
	</div>;
}
