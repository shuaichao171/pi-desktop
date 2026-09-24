import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { UiCustomProviderModel, UiModelProvider, UiModelSummary, UiProviderApi, UiProviderAuthStatus, UiSaveCustomProviderRequest } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Translate } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import './modelSettingsPanel.css';

const PROTOCOLS: { value: UiProviderApi; label: string }[] = [
	{ value: 'openai-completions', label: 'OpenAI Chat Completions' },
	{ value: 'openai-responses', label: 'OpenAI Responses' },
	{ value: 'anthropic-messages', label: 'Anthropic Messages' },
	{ value: 'google-generative-ai', label: 'Google Generative AI' },
];

type ModelDraft = { id: string; name: string; contextWindow: string; maxTokens: string; reasoning: boolean; image: boolean };

function modelDraft(model?: UiModelSummary): ModelDraft {
	return { id: model?.id ?? '', name: model?.name ?? '', contextWindow: String(model?.contextWindow ?? 128000), maxTokens: String(model?.maxTokens ?? 8192), reasoning: model?.reasoning ?? false, image: model?.input.includes('image') ?? false };
}

function modelValue(draft: ModelDraft): UiCustomProviderModel | null {
	const contextWindow = Number(draft.contextWindow);
	const maxTokens = Number(draft.maxTokens);
	if (!draft.id.trim() || !Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > contextWindow) return null;
	return { id: draft.id.trim(), name: draft.name.trim() || undefined, contextWindow, maxTokens, reasoning: draft.reasoning, input: draft.image ? ['text', 'image'] : ['text'] };
}

function serializeModel(model: UiModelSummary): UiCustomProviderModel {
	return { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, input: [...model.input] };
}

function providerRequest(provider: UiModelProvider, models = provider.models.map(serializeModel)): UiSaveCustomProviderRequest {
	return { provider: provider.provider, name: provider.name, baseUrl: provider.baseUrl ?? '', api: provider.api as UiProviderApi, models, mode: 'update' };
}

function modelSize(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '—';
	return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
}

function ModelFields({ draft, onChange, disabled, t }: { draft: ModelDraft; onChange(value: ModelDraft): void; disabled: boolean; t: Translate }) {
	const change = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => onChange({ ...draft, [key]: value });
	return <>
		<label className="pd-model-settings-field">{t('settings.customModelId')}<input data-field="model.id" required value={draft.id} onChange={(event) => change('id', event.target.value)} spellCheck={false} autoComplete="off" disabled={disabled} placeholder="my-model" /></label>
		<label className="pd-model-settings-field">{t('settings.customModelName')}<input data-field="model.name" value={draft.name} onChange={(event) => change('name', event.target.value)} disabled={disabled} placeholder={draft.id || 'My model'} /></label>
		<div className="pd-model-settings-field-grid">
			<label className="pd-model-settings-field">{t('settings.customModelContext')}<input data-field="model.contextWindow" required type="number" min="1" step="1" value={draft.contextWindow} onChange={(event) => change('contextWindow', event.target.value)} disabled={disabled} /></label>
			<label className="pd-model-settings-field">{t('settings.customModelOutput')}<input data-field="model.maxTokens" required type="number" min="1" step="1" value={draft.maxTokens} onChange={(event) => change('maxTokens', event.target.value)} disabled={disabled} /></label>
		</div>
		<div className="pd-model-settings-toggles">
			<label><input data-field="model.reasoning" type="checkbox" checked={draft.reasoning} onChange={(event) => change('reasoning', event.target.checked)} disabled={disabled} />{t('settings.customModelReasoning')}</label>
			<label><input data-field="model.image" type="checkbox" checked={draft.image} onChange={(event) => change('image', event.target.checked)} disabled={disabled} />{t('settings.customModelImages')}</label>
		</div>
	</>;
}

function ProviderEditor({ provider, disabled, onSave, onCancel }: { provider?: UiModelProvider; disabled: boolean; onSave(request: UiSaveCustomProviderRequest): Promise<boolean>; onCancel(): void }) {
	const { t } = useT();
	const [id, setId] = useState(provider?.provider ?? '');
	const [name, setName] = useState(provider?.name ?? '');
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
	const [api, setApi] = useState<UiProviderApi>((provider?.api as UiProviderApi) ?? 'openai-completions');
	const [apiKey, setApiKey] = useState('');
	const [firstModel, setFirstModel] = useState(() => modelDraft());
	const [error, setError] = useState<string | null>(null);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabled) return;
		setError(null);
		try {
			const url = new URL(baseUrl.trim());
			if (!id.trim() || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
		} catch { setError(t('settings.providerRequired')); return; }
		const initial = provider ? null : modelValue(firstModel);
		if (!provider && !initial) { setError(t('settings.customModelRequired')); return; }
		const secret = apiKey.trim();
		setApiKey('');
		await onSave({ provider: id.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), api, ...(secret ? { apiKey: secret } : {}), models: provider ? provider.models.map(serializeModel) : [initial!], mode: provider ? 'update' : 'create' });
	}
	return <form className="pd-model-settings-form" data-provider-editor={provider ? 'edit' : 'create'} onSubmit={(event) => void submit(event)}>
		<h3>{t(provider ? 'settings.providerEdit' : 'settings.providerAdd')}</h3>
		<label className="pd-model-settings-field">{t('settings.providerId')}<input data-field="provider.id" required value={id} onChange={(event) => setId(event.target.value)} disabled={disabled || Boolean(provider)} spellCheck={false} autoComplete="off" placeholder="my-provider" /><small>{t('settings.providerIdHint')}</small></label>
		<label className="pd-model-settings-field">{t('settings.providerName')}<input data-field="provider.name" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} placeholder={id || 'My provider'} /></label>
		<label className="pd-model-settings-field">{t('settings.providerBaseUrl')}<input data-field="provider.baseUrl" required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={disabled} spellCheck={false} autoComplete="off" placeholder="https://api.example.com/v1" /><small>{t('settings.providerBaseUrlHint')}</small></label>
		<label className="pd-model-settings-field">{t('settings.providerProtocol')}<select data-field="provider.api" value={api} onChange={(event) => setApi(event.target.value as UiProviderApi)} disabled={disabled}>{PROTOCOLS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
		<label className="pd-model-settings-field">{t('settings.apiKey')}<input data-field="provider.apiKey" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={disabled} autoComplete="new-password" spellCheck={false} placeholder={t(provider?.configured ? 'settings.replaceKey' : 'settings.enterKey')} /><small>{t('settings.providerKeyOptional')}</small></label>
		{!provider && <><h4>{t('settings.providerFirstModel')}</h4><p className="pd-model-settings-notice">{t('settings.providerFirstModelHint')}</p><ModelFields draft={firstModel} onChange={setFirstModel} disabled={disabled} t={t} /></>}
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		<div className="pd-model-settings-form-actions"><button type="button" className="pd-model-settings-button" onClick={onCancel} disabled={disabled}>{t('settings.modelSettingsCancel')}</button><button type="submit" className="pd-settings-primary" disabled={disabled}>{t('settings.save')}</button></div>
	</form>;
}

function ModelEditor({ model, disabled, onSave, onCancel }: { model?: UiModelSummary; disabled: boolean; onSave(value: UiCustomProviderModel): Promise<boolean>; onCancel(): void }) {
	const { t } = useT();
	const [draft, setDraft] = useState(() => modelDraft(model));
	const [error, setError] = useState<string | null>(null);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabled) return;
		const value = modelValue(draft);
		if (!value) { setError(t('settings.customModelRequired')); return; }
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

export function ModelSettingsPanel({ renderCredential }: { renderCredential(provider: UiProviderAuthStatus): ReactNode }) {
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
	const saveProvider = useChatStore((state) => state.saveCustomProvider);
	const removeProvider = useChatStore((state) => state.removeCustomProvider);
	const setModel = useChatStore((state) => state.setModel);
	const setThinking = useChatStore((state) => state.setThinkingLevel);
	const [selectedId, setSelectedId] = useState(modelProvider);
	const [search, setSearch] = useState('');
	const [modelSearch, setModelSearch] = useState('');
	const [providerEditor, setProviderEditor] = useState<'create' | 'edit' | null>(null);
	const [modelEditor, setModelEditor] = useState<{ originalId: string | null } | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<'provider' | { model: string } | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const generation = useRef(0);
	const detailRef = useRef<HTMLDivElement>(null);
	const canChange = status === 'idle' && !loading && !pending;
	const waitingForAgent = status === 'starting' || status === 'uninitialized';
	const selected = providers.find((item) => item.provider === selectedId) ?? providers.find((item) => item.provider === modelProvider) ?? providers[0];
	const filteredProviders = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		return providers.filter((item) => `${item.provider} ${item.name}`.toLocaleLowerCase().includes(query));
	}, [providers, search]);
	const filteredModels = selected?.models.filter((item) => `${item.id} ${item.name}`.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())) ?? [];
	const availableIds = new Set(availableModels.map((item) => `${item.provider}/${item.id}`));

	useLayoutEffect(() => {
		const detail = detailRef.current;
		if (!detail) return;
		detail.scrollTop = 0;
		const editor = modelEditor ? detail.querySelector<HTMLElement>('[data-model-editor]') : null;
		if (editor) detail.scrollTop = Math.max(0, editor.getBoundingClientRect().top - detail.getBoundingClientRect().top - 12);
	}, [selected?.provider, providerEditor, modelEditor]);

	useEffect(() => {
		const request = ++generation.current;
		setProviderEditor(null); setModelEditor(null); setConfirmRemove(null); setPending(false); setError(null); setFeedback(null);
		if (bridge && !waitingForAgent) void refreshProviders().catch((reason: unknown) => { if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason)); });
		return () => { generation.current += 1; };
	}, [bridge, cwd, waitingForAgent, refreshProviders]);

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
		setSelectedId(provider); setModelSearch(''); setProviderEditor(null); setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null);
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
			if (await run(() => removeProvider(selected.provider), 'settings.providerRemoved')) { setConfirmRemove(null); setSelectedId(modelProvider); }
		} else {
			if (selected.models.length < 2) { setError(t('settings.customModelLast')); return; }
			const next = selected.models.filter((item) => item.id !== confirmRemove.model).map(serializeModel);
			if (await run(() => saveProvider(providerRequest(selected, next)), 'settings.customModelRemoved')) setConfirmRemove(null);
		}
	}

	const credential = selected ? providerAuth.find((item) => item.provider === selected.provider) ?? { provider: selected.provider, configured: selected.configured, supportsApiKey: selected.custom && selected.editable } : null;
	return <div className="pd-model-settings">
		<div className="pd-settings-section-head"><h2>{t('settings.model')}</h2><p>{t('settings.modelDescription', { model: model ? `${modelProvider ? `${modelProvider}/` : ''}${model}` : t('settings.notSelected') })}</p></div>
		<div className="pd-model-settings-current"><strong>{t('settings.thinking')}</strong><div className="pd-thinking-options" role="group" aria-label={t('settings.thinking')}>{levels.map((level) => <button key={level} type="button" className={thinking === level ? 'is-selected' : ''} aria-pressed={thinking === level} disabled={!canChange} onClick={() => void run(() => setThinking(level))}>{t(`composer.thinking.${level}`)}</button>)}{!levels.length && <span className="pd-model-settings-notice">{t('settings.thinkingEmpty')}</span>}</div></div>
		{status !== 'idle' && <p className="pd-model-settings-notice">{t('settings.modelBusy')}</p>}
		{error && <div className="pd-settings-error" role="alert">{error}</div>}
		{feedback && <p className="pd-model-settings-feedback" role="status">{feedback}</p>}
		<div className="pd-model-provider-layout">
			<div className="pd-model-provider-sidebar">
				<div className="pd-model-provider-heading"><strong>{t('settings.providers')}</strong><HoverTooltip title={t('settings.providerAdd')}><button type="button" data-action="add-provider" className="pd-icon-button" disabled={!canChange} aria-label={t('settings.providerAdd')} onClick={() => { setProviderEditor('create'); setModelEditor(null); setConfirmRemove(null); setError(null); setFeedback(null); }}><Icon name="plus" width="15" height="15" /></button></HoverTooltip></div>
				<input className="pd-model-provider-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.providerSearch')} aria-label={t('settings.providerSearch')} />
				<div className="pd-model-provider-list" aria-label={t('settings.providers')}>{filteredProviders.map((item) => <button key={item.provider} data-provider={item.provider} type="button" className={`pd-model-provider-option${providerEditor !== 'create' && selected?.provider === item.provider ? ' is-selected' : ''}`} aria-pressed={providerEditor !== 'create' && selected?.provider === item.provider} disabled={pending} onClick={() => selectProvider(item.provider)}><strong>{item.name || item.provider}</strong><span className="pd-model-provider-option-meta"><span className={`pd-model-provider-state${item.configured ? ' is-ready' : ''}`} aria-label={t(item.configured ? 'settings.authAvailable' : 'settings.authMissing')} />{t('settings.providerCount', { count: item.models.length })}</span></button>)}</div>
				{!filteredProviders.length && <p className="pd-model-settings-notice">{t(loading ? 'settings.providerLoading' : search ? 'settings.providerNoMatch' : 'settings.providerEmpty')}</p>}
				<button type="button" className="pd-model-settings-button" disabled={loading || pending} onClick={() => void run(refreshProviders)} aria-label={t('settings.modelSettingsRefresh')}><Icon name="refresh" width="13" height="13" />{t('settings.modelSettingsRefresh')}</button>
			</div>
			<div ref={detailRef} className="pd-model-provider-detail">
				{providerEditor ? <ProviderEditor key={providerEditor === 'create' ? 'create' : selected?.provider} provider={providerEditor === 'edit' ? selected : undefined} disabled={!canChange} onCancel={() => setProviderEditor(null)} onSave={async (request) => {
					if (!canChange || !await run(() => saveProvider(request), 'settings.providerSaved')) return false;
					setSelectedId(request.provider); setSearch(''); setProviderEditor(null); return true;
				}} /> : selected ? <>
					<div className="pd-model-provider-detail-head"><div><h3>{selected.name || selected.provider}</h3><span className="pd-model-provider-badge">{t(selected.custom ? 'settings.providerCustom' : 'settings.providerBuiltin')}</span></div>{selected.custom && selected.editable && <button type="button" data-action="edit-provider" className="pd-model-settings-button" disabled={!canChange} onClick={() => { setProviderEditor('edit'); setModelEditor(null); setConfirmRemove(null); }}>{t('settings.providerEdit')}</button>}</div>
					<dl className="pd-model-provider-connection"><dt>{t('settings.providerBaseUrl')}</dt><dd>{selected.baseUrl || t('settings.providerDefaultUrl')}</dd><dt>{t('settings.providerProtocol')}</dt><dd>{PROTOCOLS.find((item) => item.value === selected.api)?.label || selected.api || t('settings.providerDefaultProtocol')}</dd></dl>
					{selected.custom && !selected.editable && <p className="pd-model-settings-notice">{t('settings.providerReadonly')}</p>}
					{credential && <details key={selected.provider} className="pd-model-settings-credentials" open={!selected.configured}><summary>{t('settings.providerCredentials')}</summary>{renderCredential(credential)}</details>}
					<div className="pd-model-settings-subhead"><h4>{t('settings.model')} <span className="pd-model-settings-notice">{selected.models.length}</span></h4>{selected.custom && selected.editable && <button type="button" data-action="add-model" className="pd-model-settings-button" disabled={!canChange} onClick={() => { setModelEditor({ originalId: null }); setConfirmRemove(null); setError(null); }}><Icon name="plus" width="13" height="13" />{t('settings.customModelAdd')}</button>}</div>
					{modelEditor ? <ModelEditor key={modelEditor.originalId ?? 'new'} model={selected.models.find((item) => item.id === modelEditor.originalId)} disabled={!canChange} onCancel={() => setModelEditor(null)} onSave={saveModel} /> : <>
						<input className="pd-settings-model-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} aria-label={t('composer.pickerSearchLabel')} placeholder={t('composer.pickerSearchPlaceholder')} />
						<div className="pd-model-settings-models" aria-label={t('settings.availableModels')}>{filteredModels.map((item) => {
							const current = item.provider === modelProvider && item.id === model;
							const available = availableIds.has(`${item.provider}/${item.id}`);
							return <div key={item.id} data-model-id={item.id} className={`pd-model-settings-model${current ? ' is-current' : ''}`}>
								<div className="pd-model-settings-model-copy"><strong>{item.name || item.id}</strong><code>{item.id}</code><span className="pd-model-settings-model-meta"><span>{t(item.reasoning ? 'settings.reasoning' : 'settings.noReasoning')}</span>{item.input.includes('image') && <span>{t('settings.image')}</span>}<span>{t('settings.context', { size: modelSize(item.contextWindow) })}</span></span></div>
								<div className="pd-model-settings-model-actions">
									{current ? <span className="pd-model-settings-current-badge">{t('composer.pickerCurrent')}</span> : <button type="button" data-action="use-model" className="pd-model-settings-button" disabled={!canChange || !available} onClick={() => void run(() => setModel(item.provider, item.id))}>{t('settings.customModelUse')}</button>}
									{selected.custom && selected.editable && <>
										<button type="button" data-action="edit-model" className="pd-model-settings-button" disabled={!canChange} aria-label={`${t('settings.customModelEdit')} ${item.name || item.id}`} onClick={() => { setModelEditor({ originalId: item.id }); setConfirmRemove(null); setError(null); }}>{t('settings.modelSettingsEdit')}</button>
										<HoverTooltip title={t('settings.customModelRemove')} description={selected.models.length < 2 ? t('settings.customModelLast') : item.name || item.id}><button type="button" data-action="remove-model" className="pd-model-settings-button is-danger" disabled={!canChange || selected.models.length < 2} aria-label={`${t('settings.customModelRemove')} ${item.name || item.id}`} onClick={() => setConfirmRemove({ model: item.id })}>{t('settings.customModelRemove')}</button></HoverTooltip>
									</>}
								</div>
							</div>;
						})}</div>
						{!filteredModels.length && <div className="pd-settings-empty">{t(modelSearch ? 'settings.modelNoMatch' : 'settings.modelEmpty')}</div>}
					</>}
					{!selected.configured && <p className="pd-settings-hint">{t('settings.providerConfigureToUse')}</p>}
					{selected.custom && selected.editable && !confirmRemove && <button type="button" data-action="remove-provider" className="pd-settings-remove" disabled={!canChange} onClick={() => setConfirmRemove('provider')}>{t('settings.providerRemove')}</button>}
					{confirmRemove && <div className="pd-model-settings-remove-confirm"><p>{confirmRemove === 'provider' ? t('settings.providerRemoveConfirm', { provider: selected.name || selected.provider }) : t('settings.customModelRemoveConfirm', { model: confirmRemove.model })}</p><button type="button" data-action="cancel-remove" className="pd-model-settings-button" disabled={pending} onClick={() => setConfirmRemove(null)}>{t('settings.modelSettingsCancel')}</button><button type="button" data-action="confirm-remove" className="pd-model-settings-button is-danger" disabled={!canChange} onClick={() => void confirmRemoval()}>{t('settings.modelSettingsConfirmRemove')}</button></div>}
				</> : <div className="pd-settings-empty">{t('settings.providerSelect')}</div>}
			</div>
		</div>
	</div>;
}
