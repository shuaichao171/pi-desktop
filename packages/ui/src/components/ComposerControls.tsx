import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiThinkingLevel } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { groupModelsByProvider, listUnconfiguredProviders, selectModelProvider } from '../modelPicker';
import type { ModelManagementTarget } from '../modelManagement';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';

type Picker = 'model' | 'thinking';

function tokenLabel(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
	return String(Math.round(value));
}

/** Model, reasoning and context controls share one mutually exclusive picker. */
export function ComposerControls({ onOpenModelManagement }: { onOpenModelManagement(target: ModelManagementTarget): void }) {
	const { t, locale } = useT();
	const model = useChatStore((s) => s.model);
	const modelName = useChatStore((s) => s.modelName);
	const provider = useChatStore((s) => s.modelProvider);
	const models = useChatStore((s) => s.models);
	const modelProviders = useChatStore((s) => s.modelProviders);
	const providerAuth = useChatStore((s) => s.providerAuth);
	const thinking = useChatStore((s) => s.thinkingLevel);
	const levels = useChatStore((s) => s.availableThinkingLevels);
	const usage = useChatStore((s) => s.contextUsage);
	const status = useChatStore((s) => s.status);
	const loading = useChatStore((s) => s.settingsLoading);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const cwd = useChatStore((s) => s.cwd);
	const refreshModels = useChatStore((s) => s.refreshModels);
	const refreshModelProviders = useChatStore((s) => s.refreshModelProviders);
	const refreshProviderAuth = useChatStore((s) => s.refreshProviderAuth);
	const setModel = useChatStore((s) => s.setModel);
	const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
	const [open, setOpen] = useState<Picker | null>(null);
	const [search, setSearch] = useState('');
	const [requestedProvider, setRequestedProvider] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [position, setPosition] = useState<CSSProperties | null>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const modelRef = useRef<HTMLButtonElement>(null);
	const thinkingRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const providerListRef = useRef<HTMLDivElement>(null);
	const modelListRef = useRef<HTMLDivElement>(null);
	const focusModelsAfterProviderChange = useRef(false);
	const pickerId = useId();
	const generation = useRef(0);
	const pickerRevision = useRef(0);
	const canChange = status === 'idle' && !loading && !pending;
	const canThink = levels.length > 1;
	const currentModel = models.find((item) => item.id === model && item.provider === provider);
	const modelLabel = model ? modelName?.trim() || model : t('composer.selectModel');
	const capacity = usage?.contextWindow ?? currentModel?.contextWindow ?? null;
	const percent = usage?.percent ?? null;
	const percentLabel = percent === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(percent);
	const amount = usage?.tokens ?? null;
	const capacityLabel = capacity ? tokenLabel(capacity) : '—';
	const thinkingLabel = thinking ? t(`composer.thinking.${thinking}`) : t('composer.pickerThinking');
	const providerGroups = useMemo(() => groupModelsByProvider(models, search, locale), [models, search, locale]);
	const unconfiguredProviders = useMemo(() => listUnconfiguredProviders(modelProviders, providerAuth, search, locale), [modelProviders, providerAuth, search, locale]);
	const activeProvider = selectModelProvider(providerGroups, requestedProvider, provider);
	const visibleModels = providerGroups.find((group) => group.provider === activeProvider)?.models ?? [];
	const providerTabId = (name: string) => `${pickerId}-provider-${encodeURIComponent(name)}`;
	const positioned = position !== null;

	useEffect(() => {
		generation.current += 1;
		pickerRevision.current += 1;
		setOpen(null);
		setError(null);
		setPending(false);
		focusModelsAfterProviderChange.current = false;
	}, [sessionId, sessionPath, cwd]);

	function close(focus: 'trigger' | 'input' | 'none' = 'none') {
		pickerRevision.current += 1;
		focusModelsAfterProviderChange.current = false;
		setOpen(null);
		if (focus === 'trigger') (open === 'model' ? modelRef : thinkingRef).current?.focus();
		if (focus === 'input') document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea')?.focus();
	}

	function toggle(picker: Picker) {
		if (picker === 'thinking' && !canThink) return;
		pickerRevision.current += 1;
		setError(null);
		setPosition(null);
		if (picker === 'model' && open !== 'model') {
			setSearch('');
			setRequestedProvider(provider || null);
			focusModelsAfterProviderChange.current = false;
		}
		setOpen((current) => current === picker ? null : picker);
	}

	function openManagement(target: ModelManagementTarget) {
		close('trigger');
		onOpenModelManagement(target);
	}

	useEffect(() => {
		if (!open) return;
		let active = true;
		if (open === 'model') {
			void Promise.allSettled([refreshModels(), refreshModelProviders(), refreshProviderAuth()]).then((results) => {
				const failed = results.find((result) => result.status === 'rejected');
				if (active && failed?.status === 'rejected') setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
			});
		}
		const outside = (event: Event) => {
			const target = event.target as Node;
			if (!popoverRef.current?.contains(target) && !modelRef.current?.contains(target) && !thinkingRef.current?.contains(target)) {
				pickerRevision.current += 1;
				setOpen(null);
			}
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('focusin', outside);
		return () => {
			active = false;
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('focusin', outside);
		};
	}, [open, refreshModels, refreshModelProviders, refreshProviderAuth]);

	useLayoutEffect(() => {
		// The first portal render is hidden until measured; hidden controls cannot focus.
		if (!open || !positioned) return;
		if (open === 'model') { searchRef.current?.focus(); return; }
		const popover = popoverRef.current;
		const selected = popover?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
		const first = popover?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)');
		(selected ?? first ?? popover?.querySelector<HTMLButtonElement>('.pd-composer-picker-head button'))?.focus();
	}, [open, positioned]);

	useLayoutEffect(() => {
		if (open !== 'model' || !positioned) return;
		if (modelListRef.current) modelListRef.current.scrollTop = 0;
		providerListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		if (focusModelsAfterProviderChange.current) {
			focusModelsAfterProviderChange.current = false;
			modelListRef.current?.querySelector<HTMLButtonElement>('[data-picker-option]:not(:disabled)')?.focus();
		} else if (!search) {
			modelListRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
		}
	}, [open, positioned, activeProvider, search]);

	useLayoutEffect(() => {
		if (!open) return;
		const anchor = (open === 'model' ? modelRef : thinkingRef).current;
		const popover = popoverRef.current;
		if (!anchor || !popover) return;
		const updatePosition = (next: CSSProperties) => setPosition((current) =>
			current?.left === next.left && current?.top === next.top && current?.bottom === next.bottom && current?.maxHeight === next.maxHeight ? current : next);
		const place = () => {
			const rect = anchor.getBoundingClientRect();
			const box = popover.getBoundingClientRect();
			const preferredLeft = open === 'model' ? rect.left + (rect.width - box.width) / 2 : rect.right - box.width;
			const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - box.width - 8));
			if (open === 'model') {
				// Center above the clicked button. Shrink/scroll the contents
				// when space is limited, leaving the window controls accessible.
				const chrome = document.querySelector('.pd-window-controls')?.getBoundingClientRect();
				const topInset = chrome && chrome.width > 0 && chrome.height > 0 && left < chrome.right && left + box.width > chrome.left
					? Math.max(8, chrome.bottom + 8) : 8;
				updatePosition({ left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(0, Math.min(440, rect.top - 6 - topInset)) });
				return;
			}
			const height = Math.min(box.height, window.innerHeight - 16);
			const above = rect.top - height - 6;
			const below = rect.bottom + 6;
			updatePosition({
				left,
				top: above >= 8 ? above : below + height <= window.innerHeight - 8 ? below : 8,
			});
		};
		place();
		// Panel transitions can move the button without resizing it. Track only
		// while open; unchanged coordinates do not trigger a React update.
		let frame = 0;
		const followAnchor = () => { place(); frame = requestAnimationFrame(followAnchor); };
		frame = requestAnimationFrame(followAnchor);
		return () => cancelAnimationFrame(frame);
	}, [open]);

	async function choose(action: () => Promise<void>) {
		if (!canChange) return;
		const request = generation.current;
		const pickerRequest = pickerRevision.current;
		setPending(true);
		setError(null);
		try {
			await action();
			if (generation.current === request && pickerRevision.current === pickerRequest) close('input');
		} catch (reason) {
			if (generation.current === request && pickerRevision.current === pickerRequest) setError(reason instanceof Error ? reason.message : String(reason));
		} finally { if (generation.current === request) setPending(false); }
	}

	function onPickerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close('trigger'); return; }
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (open === 'model') {
			const target = event.target instanceof HTMLElement ? event.target : null;
			const providerButton = target?.closest<HTMLButtonElement>('[data-provider]');
			const modelButton = target?.closest<HTMLButtonElement>('[data-model-id]');
			if (event.key === 'ArrowRight' && providerButton) {
				event.preventDefault(); event.stopPropagation();
				const next = providerButton.dataset.provider!;
				if (next === activeProvider) modelListRef.current?.querySelector<HTMLButtonElement>('[data-picker-option]:not(:disabled)')?.focus();
				else { focusModelsAfterProviderChange.current = true; setRequestedProvider(next); }
				return;
			}
			if (event.key === 'ArrowLeft' && modelButton) {
				event.preventDefault(); event.stopPropagation();
				providerListRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
				return;
			}
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			if (!providerButton && !modelButton && target !== searchRef.current) return;
			event.preventDefault(); event.stopPropagation();
			const options = Array.from((modelButton ? modelListRef : providerListRef).current?.querySelectorAll<HTMLButtonElement>(modelButton ? '[data-picker-option]:not(:disabled)' : '[data-provider]:not(:disabled)') ?? []);
			if (!options.length) return;
			const index = options.indexOf(document.activeElement as HTMLButtonElement);
			const next = index < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
			options[next]?.focus();
			options[next]?.scrollIntoView({ block: 'nearest' });
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const options = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>('[data-picker-option]:not(:disabled)') ?? []);
		if (!options.length) return;
		event.preventDefault();
		const index = options.indexOf(document.activeElement as HTMLButtonElement);
		const next = index < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
		options[next]?.focus();
	}

	const contextDescription = <span className="pd-context-details">
		<span className="pd-context-summary"><strong>{amount === null ? t('composer.contextUnknown') : tokenLabel(amount)} / {capacityLabel}</strong><span>{percentLabel}{percent === null ? '' : '%'}</span></span>
		<span className="pd-context-progress" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></span>
		<span className="pd-context-stat"><span>{t('composer.contextUsed')}</span><span>{amount === null ? t('composer.contextUnknown') : `${amount.toLocaleString(locale)} tokens`}</span></span>
		<span className="pd-context-stat"><span>{t('composer.contextCapacity')}</span><span>{capacity ? `${capacity.toLocaleString(locale)} tokens` : t('composer.contextUnknown')}</span></span>
		<span className="pd-context-note">{t(amount === null ? 'composer.contextPending' : 'composer.contextEstimate')}</span>
	</span>;

	return <div className="pd-composer-config">
		<HoverTooltip title={t('composer.contextTitle')} description={contextDescription} disabled={open !== null}>
			<button type="button" className={`pd-composer-control pd-context-trigger${percent !== null && percent >= 90 ? ' is-warning' : ''}`} aria-label={capacity ? t(percent === null ? 'composer.contextCapacityOnly' : 'composer.contextSummary', { capacity: capacityLabel, percent: percentLabel }) : t('composer.contextTitle')}>
				<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle className="pd-context-ring-track" cx="10" cy="10" r="7" /><circle className="pd-context-ring-value" cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, percent ?? 0))} 100`} transform="rotate(-90 10 10)" /></svg>
			</button>
		</HoverTooltip>
		<HoverTooltip title={t('composer.selectModel')} description={model ? `${provider}/${model}` : t('composer.modelDescription')} disabled={open !== null}>
			<button ref={modelRef} type="button" className="pd-composer-control pd-composer-model-trigger" onClick={() => toggle('model')} aria-label={`${t('composer.selectModel')}: ${modelLabel}`} aria-haspopup="dialog" aria-expanded={open === 'model'} aria-controls={open === 'model' ? 'pd-composer-model-picker' : undefined}>
				<Icon name="spark" className="pd-model-trigger-icon" width="16" height="16" /><span>{modelLabel}</span><Icon name="chevronDown" width="12" height="12" />
			</button>
		</HoverTooltip>
		<HoverTooltip title={t('composer.pickerThinking')} description={t(!thinking ? 'composer.thinkingUnknown' : canThink ? 'composer.thinkingDescription' : 'composer.thinkingUnavailable')} disabled={open !== null}>
			<button ref={thinkingRef} type="button" className="pd-composer-control pd-composer-thinking-trigger" aria-disabled={!canThink} onClick={() => toggle('thinking')} aria-label={`${t('composer.pickerThinking')}: ${thinkingLabel}`} aria-haspopup="menu" aria-expanded={open === 'thinking'} aria-controls={open === 'thinking' ? 'pd-composer-thinking-picker' : undefined}>
				<Icon name="brain" width="16" height="16" /><span>{thinkingLabel}</span>{canThink && <Icon name="chevronDown" width="12" height="12" />}
			</button>
		</HoverTooltip>
		{open && createPortal(<div ref={popoverRef} id={`pd-composer-${open}-picker`} className={`pd-composer-config-popover is-${open}`} style={position ?? { visibility: 'hidden' }} role={open === 'model' ? 'dialog' : 'menu'} aria-label={t(open === 'model' ? 'composer.pickerLabel' : 'composer.pickerThinking')} onKeyDown={onPickerKeyDown}>
			<div className="pd-composer-picker-head"><strong>{t(open === 'model' ? 'composer.pickerTitle' : 'composer.pickerThinking')}</strong><button type="button" onClick={() => close('trigger')} aria-label={t(open === 'model' ? 'composer.pickerClose' : 'composer.thinkingClose')}><Icon name="close" width="14" height="14" /></button></div>
			{open === 'model' ? <>
				<input ref={searchRef} className="pd-composer-picker-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('composer.pickerSearchPlaceholder')} aria-label={t('composer.pickerSearchLabel')} />
				{activeProvider !== null ? <div className="pd-composer-provider-browser">
					<div className="pd-composer-provider-column">
						<div className="pd-composer-provider-heading">{t('composer.pickerProviders')}</div>
						<div ref={providerListRef} className="pd-composer-provider-list" role="tablist" aria-label={t('composer.pickerProviders')} aria-orientation="vertical">
							{providerGroups.map((group) => <HoverTooltip key={group.provider} title={group.provider} description={t('composer.pickerModelCount', { count: group.models.length })} align="start"><button id={providerTabId(group.provider)} data-provider={group.provider} type="button" role="tab" className={`pd-composer-provider-option${group.provider === activeProvider ? ' is-selected' : ''}`} aria-selected={group.provider === activeProvider} aria-controls={`${pickerId}-models`} tabIndex={group.provider === activeProvider ? 0 : -1} disabled={pending} onClick={() => setRequestedProvider(group.provider)}><span>{group.provider}</span><small>{group.models.length}</small><Icon name="chevronRight" width="12" height="12" /></button></HoverTooltip>)}
						</div>
					</div>
					<section className="pd-composer-provider-models" id={`${pickerId}-models`} role="tabpanel" aria-labelledby={providerTabId(activeProvider)}>
						<div className="pd-composer-provider-heading"><strong>{activeProvider}</strong><small>{t('composer.pickerModelCount', { count: visibleModels.length })}</small></div>
						<div ref={modelListRef} className="pd-composer-picker-list" aria-label={t('composer.pickerList')}>
							{visibleModels.map((item) => <HoverTooltip key={`${item.provider}/${item.id}`} title={item.name.trim() || item.id} description={`${item.provider}/${item.id}`} align="start"><button data-picker-option data-model-id={item.id} data-model-provider={item.provider} type="button" className={`pd-composer-picker-model${item.provider === provider && item.id === model ? ' is-selected' : ''}`} aria-pressed={item.provider === provider && item.id === model} disabled={!canChange} onClick={() => void choose(() => setModel(item.provider, item.id))}><span><strong>{item.name.trim() || item.id}</strong><small>{item.id}</small></span><small>{tokenLabel(item.contextWindow)}</small>{item.provider === provider && item.id === model && <em aria-label={t('composer.pickerCurrent')}>✓</em>}</button></HoverTooltip>)}
						</div>
					</section>
				</div> : <div className="pd-composer-picker-empty">{t(loading ? 'composer.pickerLoading' : search ? 'composer.pickerNoMatch' : 'composer.pickerEmpty')}</div>}
				{unconfiguredProviders.length > 0 && <section className="pd-composer-unconfigured" aria-label={t('settings.providersUnconfigured')}>
					<div className="pd-composer-unconfigured-heading"><span>{t('settings.providersUnconfigured')}</span><small>{t('composer.configureProviderHint')}</small></div>
					<div className="pd-composer-unconfigured-list">{unconfiguredProviders.map((item) => <button key={item.provider} type="button" data-configure-provider={item.provider} disabled={pending} onClick={() => openManagement({ kind: 'provider', provider: item.provider })}><span>{item.name}</span><Icon name="chevronRight" width="12" height="12" /></button>)}</div>
				</section>}
				<div className="pd-composer-model-actions">
					<button type="button" disabled={pending} onClick={() => openManagement({ kind: 'add-provider' })}><Icon name="plus" width="15" height="15" /><span>{t('settings.providerAdd')}</span></button>
					<button type="button" disabled={pending} onClick={() => openManagement({ kind: 'manage' })}><Icon name="settings" width="15" height="15" /><span>{t('settings.modelManagement')}</span></button>
				</div>
			</> : <div className="pd-composer-thinking-options">
				{levels.map((level: UiThinkingLevel) => <button key={level} data-picker-option type="button" role="menuitemradio" aria-checked={thinking === level} disabled={!canChange} onClick={() => void choose(() => setThinkingLevel(level))}><span>{t(`composer.thinking.${level}`)}</span>{thinking === level && <span aria-hidden="true">✓</span>}</button>)}
			</div>}
			{error && <p className="pd-composer-picker-error" role="alert">{error}</p>}
			{status !== 'idle' && <p className="pd-composer-picker-hint">{t('composer.pickerBusy')}</p>}
		</div>, document.body)}
	</div>;
}
