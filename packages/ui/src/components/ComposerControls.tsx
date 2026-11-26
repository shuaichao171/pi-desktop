import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ExitPresence } from './ExitPresence';
import { createPortal } from 'react-dom';
import type { UiAgentStatus, UiModelProvider, UiModelSummary, UiProviderAuthStatus, UiThinkingLevel } from '@pidesktop/shared';
import { AGENT_APPROVAL_OPTION, PI_AGENT_ID, agentCapabilities } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { groupModelsByProvider, selectModelProvider } from '../modelPicker';
import type { ModelManagementTarget } from '../modelManagement';
import { HoverTooltip } from './HoverTooltip';
import { providerInitial, providerMarkStyle } from '../providerMark';
import { Icon } from './Icons';
import { imageCapability } from '../modelCapabilities';
import './modelCapabilities.css';

type Picker = 'model' | 'thinking' | 'context' | 'agent' | 'agentModel' | 'agentEffort' | 'agentOptions';
type PickerCatalog = { models: UiModelSummary[]; modelProviders: UiModelProvider[]; providerAuth: UiProviderAuthStatus[] };

function readPickerCatalog(): PickerCatalog {
	const { models, modelProviders, providerAuth } = useChatStore.getState();
	return { models, modelProviders, providerAuth };
}

/** Match the final two-column layout without adding fake focusable options. */
function ModelCatalogSkeleton() {
	return <div className="pd-composer-provider-browser is-skeleton" aria-hidden="true">
		<div className="pd-composer-provider-column"><div className="pd-composer-provider-heading"><span className="pd-model-skeleton-line" /></div><div className="pd-composer-provider-list">{[0, 1, 2, 3].map((index) => <div className="pd-model-skeleton-provider" key={index}><i /><span className="pd-model-skeleton-line" /></div>)}</div></div>
		<div className="pd-composer-provider-models"><div className="pd-composer-provider-heading"><span className="pd-model-skeleton-line" /></div><div className="pd-composer-picker-list">{[0, 1, 2, 3, 4].map((index) => <div className="pd-model-skeleton-row" key={index}><span className="pd-model-skeleton-line" /><span className="pd-model-skeleton-line is-short" /><span className="pd-model-skeleton-line is-caption" /></div>)}</div></div>
	</div>;
}

function tokenLabel(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
	return String(Math.round(value));
}

/** Model, reasoning and context controls share one mutually exclusive picker. */
export function ComposerControls({ onOpenModelManagement, hasImages = false }: { onOpenModelManagement(target: ModelManagementTarget): void; hasImages?: boolean }) {
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
	const preparingSession = useChatStore((s) => s.sessionPreparation !== null);
	const navigating = useChatStore((s) => s.sessionLoading || (s.navigationPending && s.sessionPreparation === null));
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const cwd = useChatStore((s) => s.cwd);
	const refreshModels = useChatStore((s) => s.refreshModels);
	const refreshModelProviders = useChatStore((s) => s.refreshModelProviders);
	const refreshProviderAuth = useChatStore((s) => s.refreshProviderAuth);
	const setModel = useChatStore((s) => s.setModel);
	const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
	const setAgentOption = useChatStore((s) => s.setAgentOption);
	const bridge = useChatStore((s) => s.bridge);
	const agent = useChatStore((s) => s.agent);
	const agents = useChatStore((s) => s.agents);
	const refreshAgents = useChatStore((s) => s.refreshAgents);
	const selectAgent = useChatStore((s) => s.selectAgent);
	const handoffToAgent = useChatStore((s) => s.handoffToAgent);
	// The agent is locked once the conversation has a turn; another agent then means a handoff.
	const agentLocked = useChatStore((s) => s.messages.some((message) => message.role === 'user' || message.role === 'assistant'));
	const [open, setOpen] = useState<Picker | null>(null);
	const [search, setSearch] = useState('');
	const [imagesOnly, setImagesOnly] = useState(false);
	const [requestedProvider, setRequestedProvider] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [position, setPosition] = useState<CSSProperties | null>(null);
	const [catalog, setCatalog] = useState<PickerCatalog>(readPickerCatalog);
	const [catalogLoading, setCatalogLoading] = useState(false);
	const [showCatalogProgress, setShowCatalogProgress] = useState(false);
	const [catalogReload, setCatalogReload] = useState(0);
	const [catalogFailed, setCatalogFailed] = useState(false);
	const [revealCatalog, setRevealCatalog] = useState(false);
	const popoverRef = useRef<HTMLDivElement>(null);
	const modelRef = useRef<HTMLButtonElement>(null);
	const thinkingRef = useRef<HTMLButtonElement>(null);
	const effortRef = useRef<HTMLButtonElement>(null);
	const optionsRef = useRef<HTMLButtonElement>(null);
	const agentRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const providerListRef = useRef<HTMLDivElement>(null);
	const modelListRef = useRef<HTMLDivElement>(null);
	const contextRef = useRef<HTMLButtonElement>(null);
	const [compacting, setCompacting] = useState(false);
	const [compactError, setCompactError] = useState<string | null>(null);
	const focusModelsAfterProviderChange = useRef(false);
	const pickerId = useId();
	const generation = useRef(0);
	const pickerRevision = useRef(0);
	// Model and thinking switches only affect the NEXT model request, so they stay
	// available while a conversation turn is running and while a new conversation
	// is still being prepared (the store defers the choice until it goes live);
	// Catalog refreshes are read-only; only navigation and an outstanding choice block.
	const canChange = !navigating && !pending;
	const capabilities = agentCapabilities(agent);
	const external = agent?.kind === 'acp';
	const canThink = capabilities.thinkingLevels && levels.length > 1;
	const currentModel = models.find((item) => item.id === model && item.provider === provider);
	const agentModels = external ? agent.models ?? [] : [];
	const modelLabel = external ? agentModels.find((item) => item.id === model)?.name || model || agent.displayName : model ? modelName?.trim() || model : t('composer.selectModel');
	// Agent session settings: reasoning effort gets its own control (like Pi's thinking
	// level); everything else (mode, speed, ...) shares one menu.
	// The desktop's approval setting arrives with the agent's options; its labels follow the app language.
	const agentOptions = external ? (agent.options ?? []).map((option) => option.id !== AGENT_APPROVAL_OPTION ? option : {
		...option,
		name: t('composer.agentApproval'),
		values: option.values.map((item) => item.value === 'bypass' || item.value === 'agent'
			? { ...item, name: t(`composer.agentApproval.${item.value}`), description: t(`composer.agentApproval.${item.value}Description`) } : item),
	}) : [];
	const effortOption = agentOptions.find((option) => option.category === 'thought_level') ?? null;
	const otherOptions = agentOptions.filter((option) => option !== effortOption);
	const effortLabel = effortOption ? effortOption.values.find((item) => item.value === effortOption.currentValue)?.name ?? effortOption.currentValue : '';
	const optionsSummary = otherOptions.map((option) => `${option.name}: ${option.values.find((item) => item.value === option.currentValue)?.name ?? option.currentValue}`).join(' · ');
	const agentChoices = agents.filter((item) => item.enabled);
	const showAgentPicker = external || agentChoices.length > 0;
	const anchorRef = (picker: Picker | null) => picker === 'model' || picker === 'agentModel' ? modelRef : picker === 'context' ? contextRef : picker === 'agent' ? agentRef : picker === 'agentEffort' ? effortRef : picker === 'agentOptions' ? optionsRef : thinkingRef;
	const capacity = usage?.contextWindow ?? currentModel?.contextWindow ?? null;
	const percent = usage?.percent ?? null;
	// An empty ring with no number reads as a stray control; the figure appears once usage is measurable.
	const showContextPercent = percent !== null && percent >= 1;
	const percentLabel = percent === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(percent);
	const amount = usage?.tokens ?? null;
	const capacityLabel = capacity ? tokenLabel(capacity) : '—';
	const thinkingLabel = thinking ? t(`composer.thinking.${thinking}`) : t('composer.pickerThinking');
	// Keep the visible catalog coherent until all three refreshes have settled.
	// Intermediate provider/auth responses must not tear down a usable model list.
	const displayedCatalog = open === 'model' ? catalog : { models, modelProviders, providerAuth };
	const configuredProviders = useMemo(() => {
		if (!displayedCatalog.modelProviders.length && !displayedCatalog.providerAuth.length) return undefined;
		const byProvider = new Map(displayedCatalog.providerAuth.map((item) => [item.provider, item.configured]));
		const configured = new Set<string>();
		for (const item of displayedCatalog.modelProviders) if (byProvider.get(item.provider) ?? item.configured) configured.add(item.provider);
		return configured;
	}, [displayedCatalog.modelProviders, displayedCatalog.providerAuth]);
	const catalogModels = displayedCatalog.models;
	const providerGroups = useMemo(() => groupModelsByProvider(imagesOnly ? catalogModels.filter(item => imageCapability(item) === 'supported') : catalogModels, search, locale, configuredProviders), [catalogModels, search, locale, configuredProviders, imagesOnly]);
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
		setCatalogLoading(false);
		setShowCatalogProgress(false);
		focusModelsAfterProviderChange.current = false;
	}, [sessionId, sessionPath, cwd]);

	// The agent list is cheap (passive PATH probe, cached by the host); load it once per bridge.
	useEffect(() => { if (bridge) void refreshAgents().catch(() => {}); }, [bridge, refreshAgents]);

	function close(focus: 'trigger' | 'input' | 'none' = 'none') {
		pickerRevision.current += 1;
		focusModelsAfterProviderChange.current = false;
		setOpen(null);
		setCatalogLoading(false);
		setShowCatalogProgress(false);
		if (focus === 'trigger') anchorRef(open).current?.focus();
		if (focus === 'input') document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea')?.focus();
	}

	function toggle(picker: Picker) {
		if (picker === 'thinking' && !canThink) return;
		// External agents report their own models; the Pi catalog does not apply.
		if (picker === 'model' && external) picker = 'agentModel';
		if (picker === 'agent') void refreshAgents().catch(() => {});
		pickerRevision.current += 1;
		setError(null);
		setPosition(null);
		if (picker === 'model' && open !== 'model') {
			setCatalog(readPickerCatalog());
			setCatalogLoading(true);
			setShowCatalogProgress(false);
			setCatalogFailed(false);
			setRevealCatalog(false);
			setSearch('');
			setImagesOnly(false);
			setRequestedProvider(provider || null);
			focusModelsAfterProviderChange.current = false;
		}
		setOpen((current) => current === picker ? null : picker);
	}

	/** Actionable context panel (context-panel task): compact runs /compact like the recovery bar. */
	async function runCompact() {
		const state = useChatStore.getState();
		if (!state.bridge || !cwd || !sessionId || compacting) return;
		setCompacting(true);
		setCompactError(null);
		try {
			await state.bridge.executeSlashCommand({ cwd, sessionId, name: 'compact' });
			close('input');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setCompactError(/compaction cancelled/i.test(message) ? t('composer.compactionTakenOver') : message);
		} finally { setCompacting(false); }
	}

	function openManagement(target: ModelManagementTarget) {
		close('trigger');
		onOpenModelManagement(target);
	}

	useEffect(() => {
		if (!open) return;
		let active = true;
		let progressTimer: ReturnType<typeof setTimeout> | undefined;
		if (open === 'model') {
			setCatalogLoading(true);
			setShowCatalogProgress(false);
			setCatalogFailed(false);
			setError(null);
			const requests = [refreshModels(), refreshModelProviders(), refreshProviderAuth()];
			// refreshModels can hydrate persisted metadata before its first await.
			// A retry keeps the last complete view, even if a failed refresh left
			// only partial metadata in the store. Reopening captures a fresh view.
			const initial = catalog.models.length ? catalog : readPickerCatalog();
			setCatalog(initial);
			progressTimer = setTimeout(() => { if (active) setShowCatalogProgress(true); }, 180);
			void Promise.allSettled(requests).then((results) => {
				if (!active) return;
				clearTimeout(progressTimer);
				const failed = results.find((result) => result.status === 'rejected');
				if (!failed || !initial.models.length) setCatalog(readPickerCatalog());
				setCatalogLoading(false);
				setShowCatalogProgress(false);
				setRevealCatalog(!initial.models.length && useChatStore.getState().models.length > 0);
				if (failed?.status === 'rejected') {
					setCatalogFailed(true);
					setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
				}
			});
		}
		const outside = (event: Event) => {
			const target = event.target as Node;
			if (!popoverRef.current?.contains(target) && !modelRef.current?.contains(target) && !contextRef.current?.contains(target) && !thinkingRef.current?.contains(target) && !agentRef.current?.contains(target)) {
				pickerRevision.current += 1;
				setOpen(null);
			}
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('focusin', outside);
		return () => {
			active = false;
			clearTimeout(progressTimer);
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('focusin', outside);
		};
	}, [open, catalogReload, refreshModels, refreshModelProviders, refreshProviderAuth]);

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
		const anchor = anchorRef(open).current;
		const popover = popoverRef.current;
		if (!anchor || !popover) return;
		const updatePosition = (next: CSSProperties) => setPosition((current) =>
			current?.left === next.left && current?.top === next.top && current?.bottom === next.bottom && current?.maxHeight === next.maxHeight ? current : next);
		const place = () => {
			const rect = anchor.getBoundingClientRect();
			const box = popover.getBoundingClientRect();
			// The wide model picker lines up with the composer's right edge so it
			// stays over the input; the small pickers center on their buttons.
			const shell = open === 'model' ? anchor.closest('.pd-composer-shell')?.getBoundingClientRect() : undefined;
			const preferredLeft = shell ? shell.right - box.width : rect.left + (rect.width - box.width) / 2;
			const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - box.width - 8));
			// Keep both pickers centered above their buttons. Limit their height
			// to the available space and leave the window controls accessible.
			const chrome = document.querySelector('.pd-window-controls')?.getBoundingClientRect();
			const topInset = chrome && chrome.width > 0 && chrome.height > 0 && left < chrome.right && left + box.width > chrome.left
				? Math.max(8, chrome.bottom + 8) : 8;
			// Leave enough room for the Agent menu controls when the composer is near the top.
			const limit = open === 'model' ? 600 : 440;
			const above = rect.top - 6 - topInset;
			const below = window.innerHeight - rect.bottom - 14;
			const agentPicker = open === 'agent' || open === 'agentModel' || open === 'agentEffort' || open === 'agentOptions';
			if (agentPicker && above < 180 && below > above) {
				updatePosition({ left, top: rect.bottom + 6, maxHeight: Math.max(0, Math.min(limit, below)), transformOrigin: 'center top' });
			} else {
				updatePosition({ left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(0, Math.min(limit, above)), transformOrigin: open === 'model' ? 'right bottom' : 'center bottom' });
			}
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
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close('trigger'); return; }
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

	const pickerTitle = open === 'model' ? 'composer.pickerTitle' : open === 'context' ? 'composer.contextTitle' : open === 'agent' ? 'composer.agentPickerTitle' : open === 'agentModel' ? 'composer.agentModelTitle' : open === 'agentEffort' ? 'composer.agentEffortTitle' : open === 'agentOptions' ? 'composer.agentOptionsTitle' : 'composer.pickerThinking';
	const pickerCloseLabel = open === 'model' || open === 'agentModel' || open === 'agentOptions' ? 'composer.pickerClose' : open === 'context' ? 'composer.contextClose' : open === 'agent' ? 'composer.agentClose' : 'composer.thinkingClose';
	const agentStatusLabel = (item: UiAgentStatus) => item.readiness === 'install' ? t('composer.agentInstall') : item.readiness === 'attention' ? t('composer.agentAttention') : null;
	function chooseAgent(id: string) {
		if (id === (agent?.id ?? PI_AGENT_ID)) { close('input'); return; }
		void choose(() => agentLocked ? handoffToAgent(id) : selectAgent(id));
	}
	const agentMark = (name: string, color?: string | null, pi = false) => <span className={`pd-agent-mark${pi ? ' is-pi' : ''}`} style={color ? { background: color } : undefined} aria-hidden="true">{pi ? 'π' : name.slice(0, 1).toUpperCase()}</span>;

	const contextDescription = <span className="pd-context-details">
		<span className="pd-context-summary"><strong>{amount === null ? '—' : tokenLabel(amount)} / {capacityLabel}</strong><span>{percentLabel}{percent === null ? '' : '%'}</span></span>
		<span className="pd-context-progress" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></span>
	</span>;

	return <div className="pd-composer-config">
		{showAgentPicker && <HoverTooltip title={t('composer.agent')} description={agentLocked ? t('composer.agentLockedShort') : t('composer.agentDescription')} disabled={open !== null}>
			<button ref={agentRef} type="button" className="pd-composer-control pd-composer-agent-trigger" onClick={() => toggle('agent')} aria-label={`${t('composer.agent')}: ${agent?.displayName ?? 'Pi'}`} aria-haspopup="menu" aria-expanded={open === 'agent'} aria-controls={open === 'agent' ? 'pd-composer-agent-picker' : undefined}>
				{agentMark(agent?.displayName ?? 'Pi', agent?.accentColor, !external)}<span>{agent?.displayName ?? 'Pi'}</span><Icon name="chevronDown" width="12" height="12" />
			</button>
		</HoverTooltip>}
		{hasImages && !external && <HoverTooltip title={t(imageCapability(currentModel) === 'supported' ? 'model.imageSupportedTitle' : imageCapability(currentModel) === 'unsupported' ? 'model.imageUnsupportedTitle' : 'model.imageUnknownTitle')} disabled={open !== null}><button type="button" className={`pd-composer-control pd-model-image-notice is-${imageCapability(currentModel)}`} onClick={() => { if (open !== 'model') toggle('model'); setImagesOnly(true); }} aria-haspopup="dialog"><Icon name="image" width="14" height="14" /><span>{t(imageCapability(currentModel) === 'supported' ? 'model.imageSupportedShort' : imageCapability(currentModel) === 'unsupported' ? 'model.imageUnsupportedShort' : 'model.imageUnknownShort')}</span></button></HoverTooltip>}
		{!external && <HoverTooltip title={t('composer.contextTitle')} description={contextDescription} disabled={open !== null}>
			<button ref={contextRef} type="button" className={`pd-composer-control pd-context-trigger${percent !== null && percent >= 90 ? ' is-warning' : ''}${showContextPercent ? ' has-percent' : ' is-idle'}`} onClick={() => toggle('context')} aria-label={capacity ? t(percent === null ? 'composer.contextCapacityOnly' : 'composer.contextSummary', { capacity: capacityLabel, percent: percentLabel }) : t('composer.contextTitle')} aria-haspopup="dialog" aria-expanded={open === 'context'} aria-controls={open === 'context' ? 'pd-composer-context-picker' : undefined}>
				<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle className="pd-context-ring-track" cx="10" cy="10" r="6" /><circle className="pd-context-ring-value" cx="10" cy="10" r="6" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, percent ?? 0))} 100`} transform="rotate(-90 10 10)" /></svg>
				{showContextPercent && <span className="pd-context-percent" aria-hidden="true">{Math.round(percent!)}%</span>}
			</button>
		</HoverTooltip>}
		<HoverTooltip title={t('composer.selectModel')} description={external ? agent.displayName : model ? `${provider}/${model}` : t('composer.modelDescription')} disabled={open !== null}>
			<button ref={modelRef} type="button" className="pd-composer-control pd-composer-model-trigger" onClick={() => toggle('model')} aria-label={`${t('composer.selectModel')}: ${modelLabel}`} aria-haspopup="dialog" aria-expanded={open === 'model' || open === 'agentModel'} aria-controls={open === 'model' || open === 'agentModel' ? `pd-composer-${open}-picker` : undefined}>
				<Icon name="spark" className="pd-model-trigger-icon" width="16" height="16" /><span>{modelLabel}</span><Icon name="chevronDown" width="12" height="12" />
			</button>
		</HoverTooltip>
		{capabilities.thinkingLevels && <HoverTooltip title={t('composer.pickerThinking')} description={!thinking ? t('composer.thinkingUnknown') : canThink ? undefined : t('composer.thinkingUnavailable')} disabled={open !== null}>
			<button ref={thinkingRef} type="button" className="pd-composer-control pd-composer-thinking-trigger" aria-disabled={!canThink} onClick={() => toggle('thinking')} aria-label={`${t('composer.pickerThinking')}: ${thinkingLabel}`} aria-haspopup="menu" aria-expanded={open === 'thinking'} aria-controls={open === 'thinking' ? 'pd-composer-thinking-picker' : undefined}>
				<Icon name="lightbulb" width="16" height="16" /><span>{thinking ? t('composer.thinkingTrigger', { level: thinkingLabel }) : thinkingLabel}</span>{canThink && <Icon name="chevronDown" width="12" height="12" />}
			</button>
		</HoverTooltip>}
		{effortOption && <HoverTooltip title={effortOption.name} description={effortOption.description} disabled={open !== null}>
			<button ref={effortRef} type="button" className="pd-composer-control pd-composer-agent-effort-trigger" onClick={() => toggle('agentEffort')} aria-label={`${effortOption.name}: ${effortLabel}`} aria-haspopup="menu" aria-expanded={open === 'agentEffort'} aria-controls={open === 'agentEffort' ? 'pd-composer-agentEffort-picker' : undefined}>
				<Icon name="lightbulb" width="16" height="16" /><span>{effortLabel}</span><Icon name="chevronDown" width="12" height="12" />
			</button>
		</HoverTooltip>}
		{otherOptions.length > 0 && <HoverTooltip title={t('composer.agentOptionsTitle')} description={optionsSummary} disabled={open !== null}>
			<button ref={optionsRef} type="button" className="pd-composer-control pd-composer-agent-options-trigger" onClick={() => toggle('agentOptions')} aria-label={`${t('composer.agentOptionsTitle')}: ${optionsSummary}`} aria-haspopup="menu" aria-expanded={open === 'agentOptions'} aria-controls={open === 'agentOptions' ? 'pd-composer-agentOptions-picker' : undefined}>
				<Icon name="settings" width="15" height="15" />
			</button>
		</HoverTooltip>}
			<ExitPresence show={open !== null} surface="pd-composer-config-popover">{open && createPortal(<div ref={popoverRef} id={`pd-composer-${open}-picker`} className={`pd-composer-config-popover is-${open}`} style={position ?? { visibility: 'hidden' }} role={open === 'thinking' || open === 'agent' || open === 'agentModel' || open === 'agentEffort' || open === 'agentOptions' ? 'menu' : 'dialog'} aria-label={t(open === 'model' ? 'composer.pickerLabel' : pickerTitle)} onKeyDown={onPickerKeyDown}>
			<div className="pd-composer-picker-head"><strong>{t(pickerTitle)}</strong>{open === 'model' && <span className="pd-composer-catalog-status" role="status">{showCatalogProgress && <><Icon name="loader" width="12" height="12" /><span>{t(catalog.models.length ? 'composer.pickerRefreshing' : 'composer.pickerLoading')}</span></>}</span>}<button type="button" onClick={() => close('trigger')} aria-label={t(pickerCloseLabel)}><Icon name="close" width="14" height="14" /></button></div>
			{open === 'model' ? <>
				<div className="pd-composer-picker-tools">
					<label className="pd-composer-picker-searchbox"><Icon name="search" width="14" height="14" /><input ref={searchRef} className="pd-composer-picker-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('composer.pickerSearchPlaceholder')} aria-label={t('composer.pickerSearchLabel')} /></label>
					<label className={`pd-model-image-filter${imagesOnly ? ' is-on' : ''}`} title={t('model.imagesOnlyTitle')}><input type="checkbox" checked={imagesOnly} onChange={event => setImagesOnly(event.target.checked)} /><Icon name="image" width="13" height="13" />{t('model.imagesOnly')}</label>
				</div>
				<div className={`pd-composer-model-body${revealCatalog ? ' is-revealing' : ''}`} aria-busy={catalogLoading}>
				{activeProvider !== null ? <div className="pd-composer-provider-browser">
					<div className="pd-composer-provider-column">
						<div className="pd-composer-provider-heading">{t('composer.pickerProviders')}</div>
						<div ref={providerListRef} className="pd-composer-provider-list" role="tablist" aria-label={t('composer.pickerProviders')} aria-orientation="vertical">
							{providerGroups.map((group) => <HoverTooltip key={group.provider} title={group.provider} description={t('composer.pickerModelCount', { count: group.models.length })} align="start"><button id={providerTabId(group.provider)} data-provider={group.provider} type="button" role="tab" className={`pd-composer-provider-option${group.provider === activeProvider ? ' is-selected' : ''}`} aria-selected={group.provider === activeProvider} aria-controls={`${pickerId}-models`} tabIndex={group.provider === activeProvider ? 0 : -1} disabled={pending} onClick={() => setRequestedProvider(group.provider)}><span className="pd-provider-avatar" style={providerMarkStyle(group.provider)} aria-hidden="true">{providerInitial(group.provider)}</span><span>{group.provider}</span><small>{group.models.length}</small></button></HoverTooltip>)}
						</div>
					</div>
					<section className="pd-composer-provider-models" id={`${pickerId}-models`} role="tabpanel" aria-labelledby={providerTabId(activeProvider)}>
						<div className="pd-composer-provider-heading"><strong>{activeProvider}</strong><small>{t('composer.pickerModelCount', { count: visibleModels.length })}</small></div>
						<div ref={modelListRef} className="pd-composer-picker-list" aria-label={t('composer.pickerList')}>
							{visibleModels.map((item) => <HoverTooltip key={`${item.provider}/${item.id}`} title={item.name.trim() || item.id} description={`${item.provider}/${item.id}`} align="start"><button data-picker-option data-model-id={item.id} data-model-provider={item.provider} type="button" className={`pd-composer-picker-model${item.provider === provider && item.id === model ? ' is-selected' : ''}`} aria-pressed={item.provider === provider && item.id === model} disabled={!canChange} onClick={() => void choose(() => setModel(item.provider, item.id))}><span><strong>{item.name.trim() || item.id}</strong><small>{item.id}</small><span className="pd-model-capabilities"><span>{t(imageCapability(item) === 'supported' ? 'model.capability.images' : imageCapability(item) === 'unsupported' ? 'model.capability.textOnly' : 'model.capability.inputUnknown')}</span><span>{t(typeof item.reasoning !== 'boolean' ? 'model.capability.reasoningUnknown' : item.reasoning ? 'model.capability.reasoning' : 'model.capability.standard')}</span></span></span><small className="pd-composer-picker-context">{tokenLabel(item.contextWindow)}</small>{item.provider === provider && item.id === model && <em aria-label={t('composer.pickerCurrent')}><Icon name="check" width="13" height="13" /></em>}</button></HoverTooltip>)}
						</div>
					</section>
				</div> : catalogLoading && !catalogModels.length ? <ModelCatalogSkeleton /> : <div className="pd-composer-picker-empty" role="status">{t(catalogFailed ? 'composer.pickerLoadFailed' : search || imagesOnly ? 'composer.pickerNoMatch' : 'composer.pickerEmpty')}</div>}
				</div>
				<div className="pd-composer-model-actions">
					<button type="button" disabled={pending} onClick={() => openManagement({ kind: 'add-provider' })}><Icon name="plus" width="15" height="15" /><span>{t('settings.providerAdd')}</span></button>
					<button type="button" disabled={pending} onClick={() => openManagement({ kind: 'manage' })}><Icon name="settings" width="15" height="15" /><span>{t('settings.modelManagement')}</span></button>
				</div>
			</> : open === 'agent' ? <><div className="pd-composer-thinking-options pd-composer-agent-options">
				{agentLocked && <p className="pd-composer-agent-note">{t('composer.agentLocked')}</p>}
				{[{ id: PI_AGENT_ID, displayName: 'Pi', accentColor: null, readiness: 'ready' as const }, ...agentChoices].map((item) => {
					const current = item.id === (agent?.id ?? PI_AGENT_ID);
					const status = 'command' in item ? agentStatusLabel(item) : null;
					return <button key={item.id} data-picker-option data-agent-id={item.id} type="button" role="menuitemradio" aria-checked={current} disabled={!canChange || (!current && item.readiness !== 'ready')} title={'command' in item && item.readiness === 'install' ? item.installHint : undefined} onClick={() => chooseAgent(item.id)}>
						<span className="pd-composer-agent-option">{agentMark(item.displayName, item.accentColor, item.id === PI_AGENT_ID)}<span>{item.displayName}</span>{'community' in item && item.community && <small>{t('composer.agentCommunity')}</small>}{status && <small>{status}</small>}{!current && agentLocked && item.readiness === 'ready' && <small className="is-handoff">{t('composer.agentHandoff')}</small>}</span>{current && <span aria-hidden="true">✓</span>}
					</button>;
				})}
			</div><div className="pd-composer-model-actions"><button type="button" disabled={pending} onClick={() => openManagement({ kind: 'agents' })}><Icon name="settings" width="15" height="15" /><span>{t('composer.agentManage')}</span></button></div></> : open === 'agentModel' ? <div className="pd-composer-thinking-options">
				{agentModels.length ? agentModels.map((item) => <button key={item.id} data-picker-option type="button" role="menuitemradio" aria-checked={item.id === model} disabled={!canChange} onClick={() => void choose(() => setModel(`acp:${agent!.id}`, item.id))}>{agentChoiceText(item.name, item.description)}{item.id === model && <span aria-hidden="true">✓</span>}</button>)
					: <p className="pd-composer-agent-note">{t('composer.agentModelsPending')}</p>}
			</div> : open === 'agentEffort' && effortOption ? <div className="pd-composer-thinking-options">
				{effortOption.values.map((item) => <button key={item.value} data-picker-option data-option-value={item.value} type="button" role="menuitemradio" aria-checked={item.value === effortOption.currentValue} disabled={!canChange} onClick={() => void choose(() => setAgentOption(effortOption.id, item.value))}>{agentChoiceText(item.name, item.description)}{item.value === effortOption.currentValue && <span aria-hidden="true">✓</span>}</button>)}
			</div> : open === 'agentOptions' ? <div className="pd-composer-thinking-options pd-composer-agent-settings">
				{otherOptions.map((option) => <div key={option.id} role="group" aria-label={option.name} className="pd-composer-agent-setting" data-option-id={option.id}>
					<div className="pd-composer-provider-heading"><strong>{option.name}</strong></div>
					{option.values.map((item) => <button key={item.value} data-picker-option data-option-value={item.value} type="button" role="menuitemradio" aria-checked={item.value === option.currentValue} disabled={!canChange} onClick={() => void choose(() => setAgentOption(option.id, item.value))}>{agentChoiceText(item.name, item.description)}{item.value === option.currentValue && <span aria-hidden="true">✓</span>}</button>)}
				</div>)}
			</div> : open === 'thinking' ? <div className="pd-composer-thinking-options">
				{levels.map((level: UiThinkingLevel) => <button key={level} data-picker-option type="button" role="menuitemradio" aria-checked={thinking === level} disabled={!canChange} onClick={() => void choose(() => setThinkingLevel(level))}><span>{t(`composer.thinking.${level}`)}</span>{thinking === level && <span aria-hidden="true">✓</span>}</button>)}
			</div> : <div className="pd-context-panel">
				<div className="pd-context-panel-row"><span>{t('composer.contextTokens')}</span><strong>{amount === null ? '—' : tokenLabel(amount)}</strong></div>
				<div className="pd-context-panel-row"><span>{t('composer.contextWindowLabel')}</span><strong>{capacityLabel}</strong></div>
				<div className="pd-context-panel-row"><span>{t('composer.contextPercent')}</span><strong>{percentLabel}{percent === null ? '' : '%'}</strong></div>
				<div className="pd-context-progress" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></div>
				{amount === null && percent === null ? <p className="pd-context-panel-note">{t('composer.contextPending')}</p> : null}
				<button data-picker-option type="button" className="pd-context-compact" disabled={compacting || status !== 'idle' || preparingSession || !bridge || !cwd || !sessionId} onClick={() => void runCompact()}>{t(compacting ? 'composer.contextCompacting' : 'composer.contextCompact')}</button>
				{compactError && <p className="pd-composer-picker-error" role="alert">{compactError}</p>}
			</div>}
			{error && <p className="pd-composer-picker-error" role="alert">{error}{open === 'model' && catalogFailed && <button type="button" className="pd-composer-catalog-retry" onClick={() => { setError(null); setCatalogFailed(false); setCatalogLoading(true); setShowCatalogProgress(false); setRevealCatalog(false); setCatalogReload((value) => value + 1); }}>{t('composer.pickerRetry')}</button>}</p>}
		</div>, document.body)}</ExitPresence>
	</div>;
}

/** A menu choice with the agent's own one-line explanation under its name. */
function agentChoiceText(name: string, description?: string) {
	return description ? <span className="pd-composer-agent-choice"><span>{name}</span><small>{description}</small></span> : <span>{name}</span>;
}
