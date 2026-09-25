import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
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

const THINKING_LEVELS: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_CONTEXT = 128000;
const DEFAULT_OUTPUT = 8192;
type ModelDraft = { id: string; name: string; contextWindow: string; maxTokens: string; reasoning: boolean; image: boolean; thinkingLevelMap?: UiCustomProviderModel['thinkingLevelMap']; thinkingLevels?: UiThinkingLevel[] };
type HeaderDraft = { key: number; name: string; value: string; stored: boolean };
type ImportedDraft = { id: string; draft: ModelDraft; selected: boolean; defaultContext: boolean; defaultOutput: boolean; unknownCapabilities: boolean };

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

function ProviderEditor({ provider, disabled, onSave, onCancel, autoDiscover = false }: { provider?: UiModelProvider; disabled: boolean; onSave(request: UiSaveCustomProviderRequest): Promise<boolean>; onCancel(): void; autoDiscover?: boolean }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const [id, setId] = useState(provider?.provider ?? '');
	const [name, setName] = useState(provider?.name ?? '');
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
	const [api, setApi] = useState<UiProviderApi>((provider?.api as UiProviderApi) ?? 'openai-completions');
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
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setError(null);
		let connection: UiDiscoverProviderModelsRequest;
		try {
			connection = connectionRequest(true);
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
		const invalidImport = selectedImports.find((item) => !modelValue(item.draft, api));
		if (invalidImport) {
			setExpandedImport(invalidImport.id); setImportSearch(invalidImport.id);
			setError(`${invalidImport.id}: ${t(api === 'google-generative-ai' ? 'settings.customModelIndependentRequired' : 'settings.customModelRequired')}`);
			return;
		}
		const additions = selectedImports.map((item) => modelValue(item.draft, api));
		if (!provider && manualEnabled) additions.push(modelValue(firstModel, api));
		if (additions.some((item) => !item)) { setError(t(api === 'google-generative-ai' ? 'settings.customModelIndependentRequired' : 'settings.customModelRequired')); return; }
		const models = [...(provider?.models.map(serializeModel) ?? []), ...additions as UiCustomProviderModel[]];
		if (!models.length) { setError(t('settings.providerChooseModels')); return; }
		if (new Set(models.map((model) => model.id)).size !== models.length) { setError(t('settings.customModelDuplicate')); return; }
		if (await onSave({ ...connection, provider: id.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), api, models, mode: provider ? 'update' : 'create' })) setApiKey('');
	}
	return <form className="pd-model-settings-form" data-provider-editor={provider ? 'edit' : 'create'} onSubmit={(event) => void submit(event)}>
		<h3>{t(provider ? 'settings.providerEdit' : 'settings.providerAdd')}</h3>
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		<label className="pd-model-settings-field">{t('settings.providerId')}<input data-field="provider.id" required value={id} onChange={(event) => { invalidateDiscovery(); setId(event.target.value); }} disabled={busy || Boolean(provider)} spellCheck={false} autoComplete="off" placeholder="my-provider" /><small>{t('settings.providerIdHint')}</small></label>
		<label className="pd-model-settings-field">{t('settings.providerName')}<input data-field="provider.name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} placeholder={id || 'My provider'} /></label>
		<label className="pd-model-settings-field">{t('settings.providerBaseUrl')}<input data-field="provider.baseUrl" required type="url" value={baseUrl} onChange={(event) => { invalidateDiscovery(); setBaseUrl(event.target.value); }} disabled={busy} spellCheck={false} autoComplete="off" placeholder="https://api.example.com/v1" /><small>{t('settings.providerBaseUrlHint')}</small></label>
		<label className="pd-model-settings-field">{t('settings.providerProtocol')}<select data-field="provider.api" value={api} onChange={(event) => { invalidateDiscovery(); setApi(event.target.value as UiProviderApi); }} disabled={busy}>{PROTOCOLS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
		<label className="pd-model-settings-field">{t('settings.apiKey')}<input data-field="provider.apiKey" type="password" value={apiKey} onChange={(event) => { invalidateDiscovery(); setApiKey(event.target.value); }} disabled={busy} autoComplete="new-password" spellCheck={false} placeholder={t(provider?.configured ? 'settings.replaceKey' : 'settings.enterKey')} /><small>{t('settings.providerKeyOptional')}</small></label>
		<section className="pd-model-headers" aria-label={t('settings.providerHeaders')}>
			<div className="pd-model-settings-subhead"><h4>{t('settings.providerHeaders')}</h4><button type="button" className="pd-model-settings-button" data-action="add-header" disabled={busy} onClick={() => changeHeaders([...headers, { key: nextHeaderKey.current++, name: '', value: '', stored: false }])}><Icon name="plus" width="13" height="13" />{t('settings.providerHeaderAdd')}</button></div>
			<p className="pd-model-settings-notice">{t('settings.providerHeadersHint')}</p>
			{headers.map((header) => <div key={header.key} className="pd-model-header-row">
				<label className="pd-model-settings-field"><span>{t('settings.providerHeaderName')}</span><input data-field="header.name" value={header.name} readOnly={header.stored} disabled={busy} placeholder="X-API-Version" spellCheck={false} autoComplete="off" onChange={(event) => changeHeaders(headers.map((item) => item.key === header.key ? { ...item, name: event.target.value } : item))} /></label>
				<label className="pd-model-settings-field"><span>{t('settings.providerHeaderValue')}</span><input data-field="header.value" type="password" value={header.value} disabled={busy} placeholder={t(header.stored ? 'settings.providerHeaderKeep' : 'settings.providerHeaderEnter')} spellCheck={false} autoComplete="new-password" onChange={(event) => changeHeaders(headers.map((item) => item.key === header.key ? { ...item, value: event.target.value } : item))} /></label>
				<button type="button" className="pd-model-settings-button is-danger" disabled={busy} aria-label={t('settings.providerHeaderRemove', { name: header.name || t('settings.providerHeaderName') })} onClick={() => changeHeaders(headers.filter((item) => item.key !== header.key))}><Icon name="close" width="13" height="13" /></button>
			</div>)}
		</section>
		<div className="pd-model-proxy"><label className="pd-model-settings-check"><input ref={proxyRef} data-field="provider.useSystemProxy" type="checkbox" checked={useSystemProxy === true} aria-checked={useSystemProxy === undefined ? 'mixed' : useSystemProxy} disabled={busy} onChange={(event) => { invalidateDiscovery(); setUseSystemProxy(event.target.checked); }} />{t('settings.providerSystemProxy')}</label><p className="pd-model-settings-notice">{t(useSystemProxy === undefined ? 'settings.providerProxyInherited' : useSystemProxy ? 'settings.providerProxyEnabled' : 'settings.providerProxyDisabled')}</p></div>
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
		<div className="pd-model-settings-form-actions"><button type="button" className="pd-model-settings-button" onClick={onCancel} disabled={disabled}>{t('settings.modelSettingsCancel')}</button><button type="submit" className="pd-settings-primary" disabled={busy}>{t('settings.save')}</button></div>
	</form>;
}

function ModelEditor({ model, api, disabled, onSave, onCancel }: { model?: UiModelSummary; api?: string | null; disabled: boolean; onSave(value: UiCustomProviderModel): Promise<boolean>; onCancel(): void }) {
	const { t } = useT();
	const [draft, setDraft] = useState(() => modelDraft(model));
	const [error, setError] = useState<string | null>(null);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabled) return;
		const value = modelValue(draft, api);
		if (!value) { setError(t(api === 'google-generative-ai' ? 'settings.customModelIndependentRequired' : 'settings.customModelRequired')); return; }
		setError(null);
		await onSave(value);
	}
	return <form className="pd-model-settings-form pd-model-settings-inline-editor" data-model-editor={model?.id ?? 'new'} onSubmit={(event) => void submit(event)}>
		<h4>{t(model ? 'settings.customModelEdit' : 'settings.customModelAdd')}</h4>
		<ModelFields draft={draft} onChange={setDraft} disabled={disabled} t={t} />
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		<div className="pd-model-settings-form-actions"><button type="button" className="pd-model-settings-button" disabled={disabled} onClick={onCancel}>{t('settings.modelSettingsCancel')}</button><button type="submit" className="pd-settings-primary" disabled={disabled}>{t('settings.save')}</button></div>
	</form>;
}

export function ModelSettingsPanel({ initialTarget, renderCredential }: { initialTarget?: ModelManagementTarget; renderCredential(provider: UiProviderAuthStatus): ReactNode }) {
	const { t } = useT();
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
	const setThinking = useChatStore((state) => state.setThinkingLevel);
	const targetKind = initialTarget?.kind ?? 'manage';
	const targetProvider = initialTarget?.kind === 'provider' ? initialTarget.provider : '';
	const [selectedId, setSelectedId] = useState(targetProvider);
	const [search, setSearch] = useState('');
	const [modelSearch, setModelSearch] = useState('');
	const [providerEditor, setProviderEditor] = useState<'create' | 'edit' | 'discover' | null>(targetKind === 'add-provider' ? 'create' : null);
	const [modelEditor, setModelEditor] = useState<{ originalId: string | null } | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<'provider' | { model: string } | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const generation = useRef(0);
	const detailRef = useRef<HTMLDivElement>(null);
	const credentialRef = useRef<HTMLDivElement>(null);
	const [credentialTarget, setCredentialTarget] = useState(targetProvider);
	const focusedCredentialTarget = useRef('');
	const canChange = status === 'idle' && !loading && !pending;
	const waitingForAgent = status === 'starting' || status === 'uninitialized';
	const authByProvider = useMemo(() => new Map(providerAuth.map((item) => [item.provider, item])), [providerAuth]);
	const providerGroups = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		const configured: UiModelProvider[] = [];
		const unconfigured: UiModelProvider[] = [];
		for (const item of providers) {
			if (!`${item.provider} ${item.name}`.toLocaleLowerCase().includes(query)) continue;
			((authByProvider.get(item.provider)?.configured ?? item.configured) ? configured : unconfigured).push(item);
		}
		return { configured, unconfigured };
	}, [providers, search, authByProvider]);
	const configuredProviders = providers.filter((item) => authByProvider.get(item.provider)?.configured ?? item.configured);
	const defaultProvider = configuredProviders.find((item) => item.provider === modelProvider) ?? configuredProviders[0] ?? providers[0];
	const selected = providers.find((item) => item.provider === selectedId) ?? defaultProvider;
	const selectedConfigured = selected ? authByProvider.get(selected.provider)?.configured ?? selected.configured : false;
	const filteredModels = selected?.models.filter((item) => `${item.id} ${item.name}`.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())) ?? [];
	const availableIds = new Set(availableModels.map((item) => `${item.provider}/${item.id}`));
	const refreshCatalog = useCallback(async () => {
		const results = await Promise.allSettled([refreshProviders(), refreshModels(), refreshAuth()]);
		const failed = results.find((result) => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}, [refreshProviders, refreshModels, refreshAuth]);

	useEffect(() => {
		setSelectedId(targetProvider); setSearch(''); setModelSearch('');
		setProviderEditor(targetKind === 'add-provider' ? 'create' : null);
		setCredentialTarget(targetProvider); focusedCredentialTarget.current = '';
		setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null);
	}, [targetKind, targetProvider]);

	useLayoutEffect(() => {
		const detail = detailRef.current;
		if (!detail) return;
		detail.scrollTop = 0;
		const editor = modelEditor ? detail.querySelector<HTMLElement>('[data-model-editor]') : null;
		if (editor) detail.scrollTop = Math.max(0, editor.getBoundingClientRect().top - detail.getBoundingClientRect().top - 12);
	}, [selected?.provider, providerEditor, modelEditor]);

	useLayoutEffect(() => {
		if (!credentialTarget || selected?.provider !== credentialTarget || providerEditor || focusedCredentialTarget.current === credentialTarget) return;
		const detail = detailRef.current;
		const credential = credentialRef.current;
		if (!detail || !credential) return;
		focusedCredentialTarget.current = credentialTarget;
		credential.focus({ preventScroll: true });
		detail.scrollTop = Math.max(0, credential.getBoundingClientRect().top - detail.getBoundingClientRect().top + detail.scrollTop - 12);
	}, [credentialTarget, selected?.provider, providerEditor]);

	useEffect(() => {
		const request = ++generation.current;
		setPending(false); setError(null); setFeedback(null);
		if (bridge && !waitingForAgent) void refreshCatalog().catch((reason: unknown) => { if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason)); });
		return () => { generation.current += 1; };
	}, [bridge, cwd, waitingForAgent, refreshCatalog]);

	async function run(work: () => Promise<void>, success?: string): Promise<boolean> {
		const request = generation.current;
		setPending(true); setError(null); setFeedback(null);
		try {
			await work();
			if (generation.current !== request) return false;
			if (success) setFeedback(t(success));
			return true;
		} catch (reason) {
			if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason));
			return false;
		} finally { if (generation.current === request) setPending(false); }
	}

	function selectProvider(provider: string) {
		setSelectedId(provider); setCredentialTarget(''); setModelSearch(''); setProviderEditor(null); setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null);
	}

	async function saveModel(value: UiCustomProviderModel): Promise<boolean> {
		if (!selected || !canChange || !modelEditor) return false;
		if (selected.models.some((item) => item.id === value.id && item.id !== modelEditor.originalId)) { setError(t('settings.customModelDuplicate')); return false; }
		const next = modelEditor.originalId === null ? [...selected.models.map(serializeModel), value] : selected.models.map((item) => item.id === modelEditor.originalId ? value : serializeModel(item));
		if (!await run(() => saveProvider(providerRequest(selected, next)), 'settings.customModelSaved')) return false;
		setModelEditor(null);
		return true;
	}

	async function confirmRemoval() {
		if (!selected || !canChange || !confirmRemove) return;
		if (confirmRemove === 'provider') {
			if (await run(() => removeProvider(selected.provider), 'settings.providerRemoved')) { setConfirmRemove(null); setSelectedId(''); setCredentialTarget(''); }
		} else {
			if (selected.models.length < 2) { setError(t('settings.customModelLast')); return; }
			const next = selected.models.filter((item) => item.id !== confirmRemove.model).map(serializeModel);
			if (await run(() => saveProvider(providerRequest(selected, next)), 'settings.customModelRemoved')) setConfirmRemove(null);
		}
	}

	const credential = selected ? authByProvider.get(selected.provider) ?? { provider: selected.provider, configured: selectedConfigured, supportsApiKey: selected.custom && selected.editable } : null;
	function renderProvider(item: UiModelProvider, configured: boolean) {
		return <button key={item.provider} data-provider={item.provider} type="button" className={`pd-model-provider-option${providerEditor !== 'create' && selected?.provider === item.provider ? ' is-selected' : ''}`} aria-pressed={providerEditor !== 'create' && selected?.provider === item.provider} disabled={pending} onClick={() => selectProvider(item.provider)}><strong>{item.name || item.provider}</strong><span className="pd-model-provider-option-meta"><span className={`pd-model-provider-state${configured ? ' is-ready' : ''}`} aria-label={t(configured ? 'settings.authAvailable' : 'settings.authMissing')} />{configured ? t('settings.providerCount', { count: item.models.length }) : t('settings.authMissing')}</span></button>;
	}
	return <div className="pd-model-settings">
		<div className="pd-settings-section-head"><h2>{t('settings.modelManagement')}</h2><p>{t('settings.modelDescription', { model: model ? `${modelProvider ? `${modelProvider}/` : ''}${model}` : t('settings.notSelected') })}</p></div>
		<div className="pd-model-settings-current"><strong>{t('settings.thinking')}</strong><div className="pd-thinking-options" role="group" aria-label={t('settings.thinking')}>{levels.map((level) => <button key={level} type="button" className={thinking === level ? 'is-selected' : ''} aria-pressed={thinking === level} disabled={!canChange} onClick={() => void run(() => setThinking(level))}>{t(`composer.thinking.${level}`)}</button>)}{!levels.length && <span className="pd-model-settings-notice">{t('settings.thinkingEmpty')}</span>}</div></div>
		{status !== 'idle' && <p className="pd-model-settings-notice">{t('settings.modelBusy')}</p>}
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		{feedback && <p className="pd-model-settings-feedback" role="status">{feedback}</p>}
		<div className="pd-model-provider-layout">
			<div className="pd-model-provider-sidebar">
				<div className="pd-model-provider-heading"><strong>{t('settings.providers')}</strong><HoverTooltip title={t('settings.providerAdd')}><button type="button" data-action="add-provider" className="pd-icon-button" disabled={!canChange} aria-label={t('settings.providerAdd')} onClick={() => { setProviderEditor('create'); setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null); }}><Icon name="plus" width="15" height="15" /></button></HoverTooltip></div>
				<input className="pd-model-provider-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.providerSearch')} aria-label={t('settings.providerSearch')} />
				<div className="pd-model-provider-list" aria-label={t('settings.providers')}>
					{providerGroups.configured.length > 0 && <section className="pd-model-provider-group" data-provider-group="configured" aria-label={t('settings.providersConfigured')}><h4>{t('settings.providersConfigured')}</h4><div className="pd-model-provider-group-items">{providerGroups.configured.map((item) => renderProvider(item, true))}</div></section>}
					{providerGroups.unconfigured.length > 0 && <section className="pd-model-provider-group is-unconfigured" data-provider-group="unconfigured" aria-label={t('settings.providersUnconfigured')}><h4>{t('settings.providersUnconfigured')}</h4><p>{t('settings.providersUnconfiguredHint')}</p><div className="pd-model-provider-group-items">{providerGroups.unconfigured.map((item) => renderProvider(item, false))}</div></section>}
					{!providerGroups.configured.length && !providerGroups.unconfigured.length && <p className="pd-model-settings-notice">{t(loading ? 'settings.providerLoading' : search ? 'settings.providerNoMatch' : 'settings.providerEmpty')}</p>}
				</div>
				<button type="button" className="pd-model-settings-button" disabled={loading || pending} onClick={() => void run(refreshCatalog)} aria-label={t('settings.modelSettingsRefresh')}><Icon name="refresh" width="13" height="13" />{t('settings.modelSettingsRefresh')}</button>
			</div>
			<div ref={detailRef} className="pd-model-provider-detail">
				{providerEditor ? <ProviderEditor key={`${cwd}:${providerEditor}:${providerEditor === 'create' ? 'create' : selected?.provider}`} provider={providerEditor !== 'create' ? selected : undefined} autoDiscover={providerEditor === 'discover'} disabled={!canChange} onCancel={() => setProviderEditor(null)} onSave={async (request) => {
					if (!canChange || !await run(() => saveProvider(request), 'settings.providerSaved')) return false;
					setSelectedId(request.provider); setSearch(''); setProviderEditor(null); return true;
				}} /> : selected ? <>
					<div className="pd-model-provider-detail-head"><div><h3>{selected.name || selected.provider}</h3><span className="pd-model-provider-badge">{t(selected.custom ? 'settings.providerCustom' : 'settings.providerBuiltin')}</span></div>{selected.custom && selected.editable && <button type="button" data-action="edit-provider" className="pd-model-settings-button" disabled={!canChange} onClick={() => { setProviderEditor('edit'); setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null); }}>{t('settings.providerEdit')}</button>}</div>
					<dl className="pd-model-provider-connection"><dt>{t('settings.providerBaseUrl')}</dt><dd>{selected.baseUrl || t('settings.providerDefaultUrl')}</dd><dt>{t('settings.providerProtocol')}</dt><dd>{PROTOCOLS.find((item) => item.value === selected.api)?.label || selected.api || t('settings.providerDefaultProtocol')}</dd>{selected.custom && <><dt>{t('settings.providerSystemProxy')}</dt><dd>{t(selected.useSystemProxy === undefined ? 'settings.providerProxyInheritedShort' : selected.useSystemProxy ? 'settings.providerProxyEnabledShort' : 'settings.providerProxyDisabledShort')}</dd>{Boolean(selected.headerNames?.length) && <><dt>{t('settings.providerHeaders')}</dt><dd>{selected.headerNames!.join(', ')}</dd></>}</>}</dl>
					{selected.custom && !selected.editable && <p className="pd-model-settings-notice">{t('settings.providerReadonly')}</p>}
					{credential && <div key={selected.provider} ref={credentialRef} data-provider-credentials={selected.provider} tabIndex={-1} role="region" aria-label={t('settings.providerCredentials')} className={`pd-model-settings-credentials${credentialTarget === selected.provider ? ' is-targeted' : ''}`}><h4>{t('settings.providerCredentials')}</h4>{renderCredential(credential)}</div>}
					<div className="pd-model-settings-subhead"><h4>{t('settings.model')} <span className="pd-model-settings-notice">{selected.models.length}</span></h4>{selected.custom && selected.editable && <div className="pd-model-settings-model-actions"><button type="button" data-action="discover-provider-models" className="pd-model-settings-button" disabled={!canChange || !bridge} onClick={() => { setProviderEditor('discover'); setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null); }}><Icon name="refresh" width="13" height="13" />{t('settings.providerFetchModels')}</button><button type="button" data-action="add-model" className="pd-model-settings-button" disabled={!canChange} onClick={() => { setModelEditor({ originalId: null }); setConfirmRemove(null); setError(null); setFeedback(null); }}><Icon name="plus" width="13" height="13" />{t('settings.customModelAdd')}</button></div>}</div>
					{modelEditor ? <ModelEditor key={modelEditor.originalId ?? 'new'} model={selected.models.find((item) => item.id === modelEditor.originalId)} api={selected.api} disabled={!canChange} onCancel={() => setModelEditor(null)} onSave={saveModel} /> : <>
						<input className="pd-settings-model-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} aria-label={t('composer.pickerSearchLabel')} placeholder={t('composer.pickerSearchPlaceholder')} />
						<div className="pd-model-settings-models" aria-label={t('settings.availableModels')}>{filteredModels.map((item) => {
							const current = item.provider === modelProvider && item.id === model;
							const available = selectedConfigured && availableIds.has(`${item.provider}/${item.id}`);
							return <div key={item.id} data-model-id={item.id} className={`pd-model-settings-model${current ? ' is-current' : ''}`}>
								<div className="pd-model-settings-model-copy"><strong>{item.name || item.id}</strong><code>{item.id}</code><span className="pd-model-settings-model-meta"><span>{t(item.reasoning ? 'settings.reasoning' : 'settings.noReasoning')}</span>{item.input.includes('image') && <span>{t('settings.image')}</span>}<span>{t('settings.context', { size: modelSize(item.contextWindow) })}</span><span>{t('settings.modelOutputSize', { size: modelSize(item.maxTokens) })}</span>{item.reasoning && Boolean(item.thinkingLevels?.length) && <span>{t('settings.modelThinkingSummary', { levels: item.thinkingLevels!.map((level) => t(`composer.thinking.${level}`)).join(' / ') })}</span>}</span></div>
								<div className="pd-model-settings-model-actions">
									{current ? <span className="pd-model-settings-current-badge">{t('composer.pickerCurrent')}</span> : <button type="button" data-action="use-model" className="pd-model-settings-button" disabled={!canChange || !available} onClick={() => void run(() => setModel(item.provider, item.id))}>{t('settings.customModelUse')}</button>}
									{selected.custom && selected.editable && <>
										<button type="button" data-action="edit-model" className="pd-model-settings-button" disabled={!canChange} aria-label={`${t('settings.customModelEdit')} ${item.name || item.id}`} onClick={() => { setModelEditor({ originalId: item.id }); setConfirmRemove(null); setError(null); setFeedback(null); }}>{t('settings.modelSettingsEdit')}</button>
										<HoverTooltip title={t('settings.customModelRemove')} description={selected.models.length < 2 ? t('settings.customModelLast') : item.name || item.id}><button type="button" data-action="remove-model" className="pd-model-settings-button is-danger" disabled={!canChange || selected.models.length < 2} aria-label={`${t('settings.customModelRemove')} ${item.name || item.id}`} onClick={() => setConfirmRemove({ model: item.id })}>{t('settings.customModelRemove')}</button></HoverTooltip>
									</>}
								</div>
							</div>;
						})}</div>
						{!filteredModels.length && <div className="pd-settings-empty">{t(modelSearch ? 'settings.modelNoMatch' : 'settings.modelEmpty')}</div>}
					</>}
					{!selectedConfigured && <p className="pd-settings-hint">{t('settings.providerConfigureToUse')}</p>}
					{selected.custom && selected.editable && !confirmRemove && <button type="button" data-action="remove-provider" className="pd-settings-remove" disabled={!canChange} onClick={() => setConfirmRemove('provider')}>{t('settings.providerRemove')}</button>}
					{confirmRemove && <div className="pd-model-settings-remove-confirm"><p>{confirmRemove === 'provider' ? t('settings.providerRemoveConfirm', { provider: selected.name || selected.provider }) : t('settings.customModelRemoveConfirm', { model: confirmRemove.model })}</p><button type="button" data-action="cancel-remove" className="pd-model-settings-button" disabled={pending} onClick={() => setConfirmRemove(null)}>{t('settings.modelSettingsCancel')}</button><button type="button" data-action="confirm-remove" className="pd-model-settings-button is-danger" disabled={!canChange} onClick={() => void confirmRemoval()}>{t('settings.modelSettingsConfirmRemove')}</button></div>}
				</> : <div className="pd-settings-empty">{t('settings.providerSelect')}</div>}
			</div>
		</div>
	</div>;
}
