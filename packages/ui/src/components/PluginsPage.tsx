import { PluginUpdateControls } from './PluginUpdateControls';
import { useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiPluginCatalog, UiPluginDiscovery, UiPluginMutation, UiPluginPackage, UiPluginResource, UiPluginResourceKind, UiPluginResourcePreview, UiPluginScope } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { managementCopy } from '../managementCopy';
import { pluginResourceGroups } from '../managementState';
import { createPluginCatalogCache } from '../pluginCatalogCache';
import { PLUGIN_RECOMMENDATIONS, installedNpmPackage, installedRecommendation, pluginSourceUrl } from '../pluginRecommendations';
import { technicalInputAttributes } from '../technicalInputAttributes';
import { ConversationMarkdown } from './ConversationMarkdown';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { SegmentedIndicator } from './SegmentedIndicator';
import './pluginsPage.css';

const KINDS: UiPluginResourceKind[] = ['extensions', 'skills', 'prompts', 'themes'];
const KIND_ICON: Record<UiPluginResourceKind, ComponentProps<typeof Icon>['name']> = { extensions: 'plugins', skills: 'spark', prompts: 'message', themes: 'settings' };
/** 上次目录按工作区缓存：重进插件页先渲染缓存，后台刷新完成后替换（突变回包也同步写入）。 */
const pluginCatalogCache = createPluginCatalogCache();
const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value);
const packageKey = (item: UiPluginPackage) => JSON.stringify([item.scope, item.source]);
const resourceKey = (item: UiPluginResource) => JSON.stringify([item.scope, item.kind, item.path]);
const resourcesFor = (catalog: UiPluginCatalog, item: UiPluginPackage) => catalog.resources.filter((resource) => resource.origin === 'package' && resource.source === item.source && resource.scope === item.scope);
type PluginTab = 'installed' | 'recommended' | 'discover';
const TABS: readonly PluginTab[] = ['installed', 'recommended', 'discover'];
const SEARCH_LABEL: Record<PluginTab, string> = { installed: 'plugins.searchInstalled', recommended: 'plugins.searchRecommended', discover: 'plugins.searchDiscover' };
type InstallDraft = { source: string; scope: UiPluginScope };
type ConfirmAction = { action: 'remove' | 'update'; item: UiPluginPackage };
type PreviewState = { resource: UiPluginResource; loading: boolean; data: UiPluginResourcePreview | null; error: string | null };

function PluginDialog({ title, onClose, busy = false, active = true, children, className = '' }: { title: string; onClose(): void; busy?: boolean; active?: boolean; children: ReactNode; className?: string }) {
	const { t } = useT();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const id = useId();
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (active) {
			if (!dialog.open) {
				dialog.showModal();
				dialog.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')?.focus();
			}
		} else if (dialog.open) {
			dialog.close();
		}
		return () => { if (dialog.open) dialog.close(); };
	}, [active]);
	return createPortal(<dialog
		ref={dialogRef}
		role={active ? 'dialog' : undefined}
		aria-modal={active ? 'true' : undefined}
		aria-labelledby={id}
		hidden={!active}
		className={`pd-plugin-dialog ${className}`}
		onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
		onClick={(event) => {
			if (busy || event.target !== event.currentTarget) return;
			const rect = event.currentTarget.getBoundingClientRect();
			if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
		}}
	>
		<header><h2 id={id}>{title}</h2><button type="button" className="pd-icon-button" aria-label={t('plugins.close')} onClick={onClose} disabled={busy}><Icon name="close" /></button></header>{children}
	</dialog>, document.body);
}

function ResourceRow({ resource, canChange, busy, pending, onToggle, onPreview, onReveal }: { resource: UiPluginResource; canChange: boolean; busy: boolean; pending: boolean; onToggle(): void; onPreview(): void; onReveal?: () => void }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
	const [copyError, setCopyError] = useState('');
	const copyTimer = useRef<number | null>(null);
	useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);
	async function copyPath() {
		if (copyTimer.current !== null) { window.clearTimeout(copyTimer.current); copyTimer.current = null; }
		try {
			await navigator.clipboard.writeText(resource.path);
			setCopyStatus('copied');
			copyTimer.current = window.setTimeout(() => { setCopyStatus('idle'); copyTimer.current = null; }, 2500);
		}
		catch (cause) { setCopyStatus('error'); setCopyError(errorMessage(cause)); }
	}
	const previewable = resource.kind === 'skills' || resource.kind === 'prompts';
	const toggleHint = resource.canToggle ? t(resource.enabled ? 'plugins.disable' : 'plugins.enable') : t('plugins.cannotToggle');
	return <article className={`pd-plugin-resource${pending ? ' is-pending' : ''}`} data-kind={resource.kind} data-resource-path={resource.path}>
		<span className="pd-plugin-resource-icon"><Icon name={KIND_ICON[resource.kind]} width="18" height="18" /></span>
		<div className="pd-plugin-resource-copy">
			<div><strong>{resource.name}</strong><span className="pd-plugin-tag">{t(`plugins.scope.${resource.scope}`)}</span><span className={`pd-plugin-resource-enabled${resource.enabled ? ' is-enabled' : ''}`}>{t(resource.enabled ? 'plugins.enabled' : 'plugins.disabled')}</span></div>
			{resource.description && <p>{resource.description}</p>}
			<span className={`pd-plugin-resource-status${resource.error ? ' is-error' : ''}`} role={resource.error ? 'alert' : undefined}>{resource.error || t(!resource.enabled ? 'plugins.disabled' : resource.loaded ? 'plugins.loaded' : 'plugins.notLoaded')}</span>
			<details className="pd-plugin-resource-path">
				<summary>{copy.path}</summary>
				<code>{resource.path}</code>
				<div className="pd-plugin-path-actions">
					<button type="button" className="pd-btn is-sm pd-plugin-button is-ghost" onClick={() => void copyPath()}>{copy.copyPath}</button>
					{onReveal && <button type="button" className="pd-btn is-sm pd-plugin-button is-ghost" onClick={onReveal}><Icon name="folder" width="13" height="13" />{t('plugins.revealFolder')}</button>}
				</div>
				{copyStatus !== 'idle' && <span role={copyStatus === 'error' ? 'alert' : 'status'}>{copyStatus === 'error' ? `${copy.copyFailed}: ${copyError}` : copy.copied}</span>}
			</details>
		</div>
		<div className="pd-plugin-resource-actions">
			{previewable && <button type="button" className="pd-btn is-sm pd-plugin-button is-ghost" onClick={onPreview} disabled={busy}>{t('plugins.preview')}</button>}
			<HoverTooltip title={toggleHint} align="end">
				<button type="button" className={`pd-plugin-switch${pending ? ' is-pending' : ''}`} role="switch" aria-checked={resource.enabled} aria-busy={pending || undefined} aria-label={t('plugins.toggleResource', { name: resource.name })} disabled={!canChange || busy || !resource.canToggle} onClick={onToggle}><span aria-hidden="true" /></button>
			</HoverTooltip>
		</div>
	</article>;
}

function ResourceGroups({ resources, expanded, renderResource }: { resources: UiPluginResource[]; expanded: boolean; renderResource(resource: UiPluginResource): ReactNode }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const id = useId();
	const [collapsed, setCollapsed] = useState<Partial<Record<UiPluginResourceKind, boolean>>>({});
	return <div className="pd-plugin-resource-groups">{pluginResourceGroups(resources).map((group) => {
		const forcedOpen = expanded || group.hasError;
		const open = forcedOpen || !collapsed[group.kind];
		return <section key={group.kind} className={`pd-plugin-resource-group${group.hasError ? ' has-error' : ''}`}>
			<h3><button type="button" aria-expanded={open} aria-controls={`${id}-${group.kind}`} aria-disabled={forcedOpen || undefined} onClick={() => { if (!forcedOpen) setCollapsed((old) => ({ ...old, [group.kind]: !old[group.kind] })); }}><Icon name={KIND_ICON[group.kind]} width="16" height="16" /><span>{t(`plugins.kind.${group.kind}`)}</span><span>{group.resources.length}</span>{group.hasError && <span className="pd-plugin-group-errors">{copy.errors} {group.resources.filter((resource) => resource.error).length}</span>}<Icon name={open ? 'chevronDown' : 'chevronRight'} width="14" height="14" /></button></h3>
			<div id={`${id}-${group.kind}`} hidden={!open} className="pd-plugin-resources">{group.resources.map(renderResource)}</div>
		</section>;
	})}</div>;
}

export function PluginsPage({ active = true }: { active?: boolean }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const sessionId = useChatStore((state) => state.sessionId);
	const status = useChatStore((state) => state.status);
	const settingsLoading = useChatStore((state) => state.settingsLoading);
	const navigationPending = useChatStore((state) => state.navigationPending);
	const pluginReloadRevision = useChatStore((state) => state.pluginReloadRevision);
	const [catalog, setCatalog] = useState<UiPluginCatalog | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [tab, setTab] = useState<PluginTab>('installed');
	const [query, setQuery] = useState('');
	const [scope, setScope] = useState<'all' | UiPluginScope>('all');
	const [kind, setKind] = useState<'all' | UiPluginResourceKind>('all');
	const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
	const [detailKey, setDetailKey] = useState<string | null>(null);
	const [detailQuery, setDetailQuery] = useState('');
	const [detailPathCopied, setDetailPathCopied] = useState(false);
	const [install, setInstall] = useState<InstallDraft | null>(null);
	const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	const [previewMode, setPreviewMode] = useState<'rendered' | 'raw'>('rendered');
	const [previewCopied, setPreviewCopied] = useState(false);
	const [dialogError, setDialogError] = useState<string | null>(null);
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	const [picking, setPicking] = useState(false);
	const [retry, setRetry] = useState(0);
	const [discovery, setDiscovery] = useState<UiPluginDiscovery | null>(null);
	const [discoveryLoading, setDiscoveryLoading] = useState(false);
	const [discoveryError, setDiscoveryError] = useState<string | null>(null);
	const [discoveryRetry, setDiscoveryRetry] = useState(0);
	const mounted = useRef(false);
	const wasActive = useRef(active);
	const generation = useRef(0);
	const fetchRequest = useRef(0);
	const mutationLock = useRef(false);
	const previewRequest = useRef(0);
	const discoveryCache = useRef(new Map<string, UiPluginDiscovery>());
	const lastDiscoveryRetry = useRef(0);
	const detailCopyTimer = useRef<number | null>(null);
	const previewCopyTimer = useRef<number | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const listScroll = useRef(0);
	const busy = pendingKey !== null;
	const ready = Boolean(bridge && cwd && status !== 'starting' && status !== 'uninitialized');
	const canChange = Boolean(bridge && cwd && status === 'idle' && !settingsLoading && !navigationPending && !loading);
	// Installing and toggling only write configuration: allowed mid-conversation,
	// with the reload deferred until every session is idle (agent runPluginMutation).
	const canInstall = Boolean(bridge && cwd && (status === 'idle' || status === 'busy') && !settingsLoading && !navigationPending && !loading);
	const contextCurrent = (token: number) => mounted.current && generation.current === token && useChatStore.getState().bridge === bridge && useChatStore.getState().cwd === cwd && useChatStore.getState().sessionId === sessionId;

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			generation.current += 1;
			if (detailCopyTimer.current !== null) window.clearTimeout(detailCopyTimer.current);
			if (previewCopyTimer.current !== null) window.clearTimeout(previewCopyTimer.current);
		};
	}, []);
	useEffect(() => {
		discoveryCache.current.clear();
		setDiscovery(null);
	}, [bridge]);
	useEffect(() => {
		generation.current += 1; fetchRequest.current += 1; previewRequest.current += 1;
		setCatalog(null); setLoading(false); setRefreshing(false); setDetailKey(null); setInstall(null); setConfirm(null); setPreview(null); setError(null); setFeedback(null); setDialogError(null); setPendingKey(null); setPicking(false); mutationLock.current = false;
	}, [bridge, cwd, sessionId]);
	// Quietly refresh cached catalog when the user returns to a preserved Plugins view.
	useEffect(() => {
		const previous = wasActive.current;
		wasActive.current = active;
		if (!previous && active && ready && !busy) setRetry((value) => value + 1);
	}, [active, ready, busy]);
	useEffect(() => {
		if (!ready || !bridge || busy) return;
		const token = generation.current;
		const request = ++fetchRequest.current;
		// Cache-first: paint the previous catalog immediately and refresh behind it;
		// a failed refresh keeps the cached view and stays retryable through the same error path.
		const cached = pluginCatalogCache.read(cwd);
		if (cached) setCatalog(cached);
		else setLoading(true);
		setRefreshing(true);
		void bridge.getPluginCatalog(cwd).then((value) => {
			if (!contextCurrent(token) || request !== fetchRequest.current) return;
			pluginCatalogCache.write(cwd, value);
			setCatalog(value);
		}).catch((cause) => { if (contextCurrent(token) && request === fetchRequest.current) setError(errorMessage(cause)); }).finally(() => { if (contextCurrent(token) && request === fetchRequest.current) { setLoading(false); setRefreshing(false); } });
		return () => { fetchRequest.current += 1; setRefreshing(false); };
	}, [bridge, cwd, sessionId, ready, retry, busy, pluginReloadRevision]);
	function refreshCatalog() { setError(null); setRetry((value) => value + 1); }
	useEffect(() => {
		if (tab !== 'discover' || !bridge) return;
		let alive = true;
		const trimmed = query.trim();
		const cached = discoveryCache.current.get(trimmed);
		const forcedRetry = discoveryRetry !== lastDiscoveryRetry.current;
		lastDiscoveryRetry.current = discoveryRetry;
		setDiscoveryError(null);
		if (cached && !forcedRetry) {
			setDiscovery(cached);
			setDiscoveryLoading(false);
			return;
		}
		if (cached) setDiscovery(cached);
		else {
			setDiscovery(null);
			setDiscoveryLoading(true);
		}
		const timer = window.setTimeout(() => {
			void bridge.discoverPlugins(trimmed).then((value) => {
				if (!alive) return;
				if (discoveryCache.current.size >= 16) discoveryCache.current.delete(discoveryCache.current.keys().next().value!);
				discoveryCache.current.set(trimmed, value);
				setDiscovery(value);
			}).catch((cause) => { if (alive) setDiscoveryError(errorMessage(cause)); }).finally(() => { if (alive) setDiscoveryLoading(false); });
		}, cached ? 0 : 350);
		return () => { alive = false; window.clearTimeout(timer); };
	}, [bridge, tab, query, discoveryRetry]);

	async function mutate(input: UiPluginMutation, key: string, done?: () => void, inDialog = false): Promise<boolean> {
		if (!bridge || !(input.action === 'install' || input.action === 'set-enabled' ? canInstall : canChange) || mutationLock.current) return false;
		const token = generation.current;
		mutationLock.current = true; fetchRequest.current += 1; setPendingKey(key); setError(null); setDialogError(null); setFeedback(null);
		try {
			const value = await bridge.mutatePlugin(input);
			if (!contextCurrent(token)) return false;
			pluginCatalogCache.write(cwd, value);
			setCatalog(value); setFeedback(t(value.warnings.length ? 'plugins.doneWithWarnings' : value.reloadPending ? 'plugins.doneReloadPending' : `plugins.done.${input.action === 'update-target' ? 'update' : input.action}`)); done?.();
			return true;
		} catch (cause) { if (contextCurrent(token)) (inDialog ? setDialogError : setError)(errorMessage(cause)); return false; }
		finally { if (contextCurrent(token)) { mutationLock.current = false; setPendingKey(null); } }
	}
	async function pickDirectory() {
		if (!bridge || picking || busy) return;
		const token = generation.current;
		setPicking(true); setDialogError(null);
		try { const path = await bridge.pickPluginDirectory(); if (contextCurrent(token) && path) setInstall((old) => old ? { ...old, source: path } : old); }
		catch (cause) { if (contextCurrent(token)) setDialogError(errorMessage(cause)); }
		finally { if (contextCurrent(token)) setPicking(false); }
	}
	function showInstall(source = '') { setDialogError(null); setInstall({ source, scope: 'user' }); }
	function installPackage(event: FormEvent) {
		event.preventDefault();
		if (!install || !install.source.trim()) return;
		void mutate({ cwd, action: 'install', source: install.source.trim(), scope: install.scope }, 'install', () => setInstall(null), true);
	}
	async function showPreview(resource: UiPluginResource) {
		if (!bridge) return;
		const token = generation.current;
		const request = ++previewRequest.current;
		setPreviewMode('rendered');
		setPreviewCopied(false);
		setPreview({ resource, loading: true, data: null, error: null });
		try { const value = await bridge.previewPluginResource({ cwd, path: resource.path, kind: resource.kind, scope: resource.scope }); if (contextCurrent(token) && request === previewRequest.current) setPreview({ resource, loading: false, data: value, error: null }); }
		catch (cause) { if (contextCurrent(token) && request === previewRequest.current) setPreview({ resource, loading: false, data: null, error: errorMessage(cause) }); }
	}
	async function copyPreviewText() {
		if (!preview?.data?.text) return;
		if (previewCopyTimer.current !== null) { window.clearTimeout(previewCopyTimer.current); previewCopyTimer.current = null; }
		try {
			await navigator.clipboard.writeText(preview.data.text);
			setPreviewCopied(true);
			previewCopyTimer.current = window.setTimeout(() => { setPreviewCopied(false); previewCopyTimer.current = null; }, 2500);
		} catch (cause) { setError(errorMessage(cause)); }
	}
	async function copyDetailPath(path: string) {
		if (detailCopyTimer.current !== null) { window.clearTimeout(detailCopyTimer.current); detailCopyTimer.current = null; }
		try {
			await navigator.clipboard.writeText(path);
			setDetailPathCopied(true);
			detailCopyTimer.current = window.setTimeout(() => { setDetailPathCopied(false); detailCopyTimer.current = null; }, 2500);
		} catch (cause) { setError(errorMessage(cause)); }
	}
	async function revealPluginPath(path: string) {
		if (!bridge?.revealPluginPath || !cwd) return;
		try { await bridge.revealPluginPath({ cwd, path }); }
		catch (cause) { setError(errorMessage(cause)); }
	}
	function switchTab(next: PluginTab) {
		// Preserve search terms when moving between Recommended and Discover so users can widen a search seamlessly.
		const keepQuery = (tab === 'recommended' && next === 'discover') || (tab === 'discover' && next === 'recommended');
		setTab(next);
		if (!keepQuery) setQuery('');
	}
	function showDetail(item: UiPluginPackage) { listScroll.current = scrollRef.current?.scrollTop ?? 0; setDetailQuery(''); setDetailPathCopied(false); setDetailKey(packageKey(item)); scrollRef.current?.scrollTo({ top: 0 }); }
	function backToList() { setDetailKey(null); requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = listScroll.current; }); }
	function toggleResource(resource: UiPluginResource) { void mutate({ cwd, action: 'set-enabled', path: resource.path, kind: resource.kind, scope: resource.scope, enabled: !resource.enabled }, `toggle:${resourceKey(resource)}`); }

	const canReveal = Boolean(bridge?.revealPluginPath && cwd);
	const detail = catalog?.packages.find((item) => packageKey(item) === detailKey);
	const detailTrusted = Boolean(detail && (detail.scope === 'user' || catalog?.projectTrusted));
	const detailWritable = canChange && detailTrusted;
	const detailUpdatable = Boolean(detail && /^(?:npm:|(?:git:)?https:\/\/)/.test(detail.source));
	const detailSourceUrl = detail ? pluginSourceUrl(detail.source) : null;
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matches = (text: string) => !normalizedQuery || text.toLocaleLowerCase().includes(normalizedQuery);
	const resourceMatches = (resource: UiPluginResource) => (scope === 'all' || resource.scope === scope) && (kind === 'all' || resource.kind === kind) && (enabledFilter === 'all' || resource.enabled === (enabledFilter === 'enabled')) && matches(`${resource.name} ${resource.description} ${resource.source} ${resource.path}`);
	const visiblePackages = catalog?.packages.filter((item) => {
		if (scope !== 'all' && item.scope !== scope) return false;
		const resources = resourcesFor(catalog, item);
		const packageMatches = matches(`${item.name} ${item.description} ${item.source}`);
		if (kind !== 'all' || enabledFilter !== 'all') return resources.some((resource) => (kind === 'all' || resource.kind === kind) && (enabledFilter === 'all' || resource.enabled === (enabledFilter === 'enabled')) && (packageMatches || resourceMatches(resource)));
		return packageMatches || resources.some(resourceMatches);
	}) ?? [];
	const standaloneResources = catalog?.resources.filter((resource) => resourceMatches(resource) && (resource.origin !== 'package' || !catalog.packages.some((item) => item.scope === resource.scope && item.source === resource.source))) ?? [];
	const detailResources = detail && catalog ? resourcesFor(catalog, detail).filter((resource) => `${resource.name} ${resource.description} ${resource.path} ${resource.error || ''}`.toLocaleLowerCase().includes(detailQuery.trim().toLocaleLowerCase())) : [];
	const hasFilters = Boolean(query || scope !== 'all' || kind !== 'all' || enabledFilter !== 'all');
	function clearFilters() { setQuery(''); setScope('all'); setKind('all'); setEnabledFilter('all'); }
	const renderResource = (resource: UiPluginResource) => <ResourceRow key={resourceKey(resource)} resource={resource} canChange={canInstall && (resource.scope === 'user' || Boolean(catalog?.projectTrusted))} busy={busy} pending={pendingKey === `toggle:${resourceKey(resource)}`} onToggle={() => toggleResource(resource)} onPreview={() => void showPreview(resource)} onReveal={canReveal ? () => void revealPluginPath(resource.path) : undefined} />;
	const recommendations = PLUGIN_RECOMMENDATIONS.filter((item) => matches(`${item.name} ${item.author} ${item.category[locale]} ${item.description[locale]} ${item.source}`));
	const installedRecommendations = PLUGIN_RECOMMENDATIONS.filter((item) => installedRecommendation(catalog?.packages, item)).length;
	const renderRecommended = () => <><p className="pd-plugin-discovery-note"><Icon name="spark" width="14" height="14" />{t('plugins.recommendedHint')}</p>
		<section className="pd-plugin-list-section"><div className="pd-plugin-section-heading"><h2>{t('plugins.recommendedHeading')}</h2><span>{t('plugins.recommendedCount', { count: PLUGIN_RECOMMENDATIONS.length, installed: installedRecommendations })}</span></div>
			{recommendations.length ? <div className="pd-plugin-grid">{recommendations.map((item) => {
				const installed = installedRecommendation(catalog?.packages, item);
				const sourceUrl = pluginSourceUrl(item.source);
				return <article className="pd-plugin-card pd-plugin-discovery-card pd-plugin-recommended-card" key={item.source}>
					<div className="pd-plugin-card-main"><span className="pd-plugin-avatar"><Icon name={item.icon} width="22" height="22" /></span><div className="pd-plugin-card-copy"><h2 className="pd-plugin-card-title">{item.name}</h2><p className="pd-plugin-card-description">{item.description[locale]}</p></div></div>
					<div className="pd-plugin-card-meta"><span className="pd-plugin-tag">{item.category[locale]}</span><span title={item.author}>{item.author}</span>{installed && <span className="pd-plugin-status is-enabled"><Icon name="check" width="12" height="12" />{t('plugins.installed')}</span>}</div>
					<div className="pd-plugin-discovery-actions">
						{installed ? <button type="button" className="pd-btn pd-plugin-button is-ghost" onClick={() => { setTab('installed'); setQuery(''); showDetail(installed); }}>{t('plugins.viewInstalled')}<Icon name="arrowRight" width="13" height="13" /></button>
							: <button type="button" className="pd-btn pd-plugin-button" disabled={!canInstall || busy} onClick={() => showInstall(item.source)}>{t('plugins.install')}<Icon name="plus" width="13" height="13" /></button>}
						{sourceUrl && <a className="pd-icon-button pd-plugin-external-link" href={sourceUrl} target="_blank" rel="noreferrer" aria-label={`${item.name} · ${t('plugins.openSource')}`} title={t('plugins.openSource')}><Icon name="globe" width="14" height="14" /></a>}
					</div>
				</article>;
			})}</div> : <div className="pd-plugin-empty"><Icon name="search" width="25" height="25" /><h2>{t('plugins.noMatches')}</h2><p>{t('plugins.recommendedEmptyHint')}</p>{query.trim() && <button type="button" className="pd-btn pd-plugin-button" onClick={() => setTab('discover')}>{t('plugins.searchInDiscover', { query: query.trim() })}<Icon name="arrowRight" width="14" height="14" /></button>}</div>}
		</section></>;

	return <main className="pd-main pd-plugins-page">
		<div className="pd-plugins-scroll" ref={scrollRef}><div className="pd-plugins-content">
			{detail ? <>
				<button type="button" className="pd-btn pd-plugin-button is-ghost pd-plugin-back" onClick={backToList}><Icon name="arrowLeft" width="15" height="15" />{t('plugins.back')}</button>
				<div className="pd-plugin-detail-heading"><span className="pd-plugin-avatar is-large"><Icon name="plugins" width="28" height="28" /></span><div className="pd-plugin-detail-copy"><div className="pd-plugin-detail-title"><h1>{detail.name}</h1><span className="pd-plugin-tag">{t(`plugins.scope.${detail.scope}`)}</span></div><p>{detail.description || t('plugins.noDescription')}</p>
					<div className="pd-plugin-detail-meta"><span className={`pd-plugin-status${detail.installed ? ' is-enabled' : ' is-warning'}`}>{t(detail.installed ? 'plugins.installed' : 'plugins.missing')}</span>{detail.version && <span className="pd-plugin-detail-version">{detail.version}</span>}</div></div>
				<div className="pd-plugin-detail-actions">
					{detailSourceUrl && <a className="pd-btn pd-plugin-button is-ghost" href={detailSourceUrl} target="_blank" rel="noreferrer"><Icon name="globe" width="14" height="14" />{t('plugins.openSource')}</a>}
					{!detail.installed && <button type="button" className="pd-btn pd-plugin-button is-primary" onClick={() => { setDialogError(null); setInstall({ source: detail.source, scope: detail.scope }); }} disabled={!canInstall || !detailTrusted || busy}>{t('plugins.install')}</button>}
					{detail.installed && detailUpdatable && !detail.source.startsWith('npm:') && <button type="button" className="pd-btn pd-plugin-button" onClick={() => { setDialogError(null); setConfirm({ action: 'update', item: detail }); }} disabled={!detailWritable || busy}><Icon name="refresh" width="14" height="14" />{t('plugins.update')}</button>}
					<button type="button" className="pd-btn pd-plugin-button is-danger" onClick={() => { setDialogError(null); setConfirm({ action: 'remove', item: detail }); }} disabled={!detailWritable || busy}>{t('plugins.remove')}</button>
				</div></div>
				{detail.source.startsWith('npm:') && <PluginUpdateControls key={`${cwd}:${detail.scope}:${detail.source}`} item={detail} cwd={cwd} canInstall={canChange && detailWritable && !busy} install={(previewId) => mutate({ cwd, action: 'update-target', scope: detail.scope, previewId }, 'update-target')} />}
				{detail.installed && !detailUpdatable && <div className="pd-plugin-local-bar"><p className="pd-plugin-note">{t('plugins.localUpdateHint')}</p><button type="button" className={`pd-btn is-sm pd-plugin-button${pendingKey === 'reload' ? ' is-pending' : ''}`} aria-busy={pendingKey === 'reload' || undefined} onClick={() => void mutate({ cwd, action: 'reload' }, 'reload')} disabled={!canChange || busy}><Icon name={pendingKey === 'reload' ? 'loader' : 'refresh'} width="13" height="13" />{t('plugins.reload')}</button></div>}
			</> : <div className="pd-plugins-intro"><div><span className="pd-plugins-eyebrow">{t('plugins.eyebrow')}</span><h1>{t('plugins.title')}</h1><p>{t('plugins.description')}</p></div><div className="pd-plugins-intro-actions">
				<HoverTooltip title={t(refreshing ? 'plugins.refreshing' : 'plugins.refresh')} align="end">
					<button type="button" className={`pd-btn pd-plugin-button is-ghost${refreshing ? ' is-refreshing' : ''}`} onClick={refreshCatalog} disabled={!ready || loading || refreshing || busy} aria-label={t(refreshing ? 'plugins.refreshing' : 'plugins.refresh')} aria-busy={refreshing || undefined}><Icon name="refresh" width="16" height="16" /></button>
				</HoverTooltip>
				<button type="button" className="pd-btn pd-plugin-button is-primary" onClick={() => showInstall()} disabled={!canInstall || busy}><Icon name="plus" width="16" height="16" />{t('plugins.add')}</button>
			</div></div>}
			{error && <div className="pd-plugin-alert is-error" role="alert">{error}<button type="button" onClick={refreshCatalog} disabled={loading || busy}>{t('plugins.retry')}</button></div>}
			{feedback && <p className="pd-plugin-feedback" role="status"><Icon name="check" width="14" height="14" />{feedback}</p>}
			{!canChange && cwd && !loading && <p className="pd-plugin-note"><Icon name="clock" width="14" height="14" />{t(canInstall ? 'plugins.busyHint' : 'plugins.idleHint')}</p>}
			{catalog?.reloadPending && <p className="pd-plugin-note" role="status"><Icon name="refresh" width="14" height="14" />{t('plugins.reloadPendingHint')}</p>}
			{catalog && !catalog.projectTrusted && <p className="pd-plugin-note"><Icon name="folder" width="14" height="14" />{t('plugins.trustHint')}</p>}
			{catalog?.warnings.length ? <details className="pd-plugin-warnings"><summary>{t('plugins.warnings', { count: catalog.warnings.length })}</summary>{catalog.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
			{detail && catalog ? <><section className="pd-plugin-detail-section"><h2>{t('plugins.includes')}</h2><p className="pd-plugin-note">{t('plugins.resourceHint')}</p>{resourcesFor(catalog, detail).length ? <><label className="pd-plugins-search pd-plugin-detail-search"><Icon name="search" width="15" height="15" /><input type="search" value={detailQuery} onChange={(event) => setDetailQuery(event.target.value)} aria-label={t('plugins.searchInstalled')} placeholder={t('plugins.searchInstalled')} /></label><ResourceGroups key={detailKey} resources={detailResources} expanded={Boolean(detailQuery.trim())} renderResource={renderResource} />{!detailResources.length && <p className="pd-plugin-note">{t('plugins.noMatches')}</p>}</> : <div className="pd-plugin-empty is-compact">{t('plugins.noResources')}</div>}{resourcesFor(catalog, detail).some((resource) => resource.kind === 'themes') && <p className="pd-plugin-note">{t('plugins.themeHint')}</p>}</section><section className="pd-plugin-detail-section"><h2>{t('plugins.information')}</h2><dl className="pd-plugin-info"><div><dt>{t('plugins.source')}</dt><dd>{detailSourceUrl ? <a className="pd-plugin-info-link" href={detailSourceUrl} target="_blank" rel="noreferrer">{detail.source}</a> : detail.source}</dd></div><div><dt>{t('plugins.scopeLabel')}</dt><dd>{t(`plugins.scope.${detail.scope}`)}</dd></div>{detail.path && <div><dt>{t('plugins.path')}</dt><dd className="pd-plugin-info-path"><code>{detail.path}</code><span className="pd-plugin-path-actions"><button type="button" className="pd-btn is-sm pd-plugin-button is-ghost" onClick={() => void copyDetailPath(detail.path!)}><Icon name={detailPathCopied ? 'check' : 'copy'} width="13" height="13" />{detailPathCopied ? copy.copied : copy.copyPath}</button>{canReveal && <button type="button" className="pd-btn is-sm pd-plugin-button is-ghost" onClick={() => void revealPluginPath(detail.path!)}><Icon name="folder" width="13" height="13" />{t('plugins.revealFolder')}</button>}</span></dd></div>}</dl></section></> : <>
				<div className="pd-plugins-toolbar"><SegmentedIndicator className="pd-plugins-tabs pd-seg" label={t('plugins.views')} activeKey={tab}>{TABS.map((value) => <button type="button" data-segment-key={value} key={value} className={tab === value ? 'is-active' : ''} aria-pressed={tab === value} onClick={() => switchTab(value)}>{t(`plugins.${value}`)}</button>)}</SegmentedIndicator><label className="pd-plugins-search"><Icon name="search" width="15" height="15" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t(SEARCH_LABEL[tab])} placeholder={t(SEARCH_LABEL[tab])} /></label></div>
				{tab === 'installed' ? <>
					<div className="pd-plugin-filters"><label>{t('plugins.scopeLabel')}<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="all">{t('plugins.allScopes')}</option><option value="user">{t('plugins.scope.user')}</option><option value="project">{t('plugins.scope.project')}</option></select></label><label>{t('plugins.kindLabel')}<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">{t('plugins.allKinds')}</option>{KINDS.map((value) => <option key={value} value={value}>{t(`plugins.kind.${value}`)}</option>)}</select></label><label>{t('plugins.stateLabel')}<select value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value as typeof enabledFilter)}><option value="all">{t('plugins.allStates')}</option><option value="enabled">{t('plugins.enabled')}</option><option value="disabled">{t('plugins.disabled')}</option></select></label><button type="button" className={`pd-btn pd-plugin-button is-ghost${pendingKey === 'reload' ? ' is-pending' : ''}`} aria-busy={pendingKey === 'reload' || undefined} onClick={() => void mutate({ cwd, action: 'reload' }, 'reload')} disabled={!canChange || busy}><Icon name={pendingKey === 'reload' ? 'loader' : 'refresh'} width="13" height="13" />{t('plugins.reload')}</button></div>
					{!cwd ? <div className="pd-plugin-empty"><Icon name="folder" width="28" height="28" /><h2>{t('plugins.openProjectTitle')}</h2><p>{t('plugins.openProjectHint')}</p><button type="button" className="pd-btn pd-plugin-button" onClick={() => void useChatStore.getState().pickWorkspace().catch((cause) => setError(errorMessage(cause)))}>{t('sidebar.openProject')}</button></div> : loading && !catalog ? <div className="pd-plugin-empty" role="status">{t('plugins.loading')}</div> : catalog && !visiblePackages.length && !standaloneResources.length ? <div className="pd-plugin-empty"><span className="pd-plugin-avatar is-large"><Icon name="plugins" width="25" height="25" /></span><h2>{t(hasFilters ? 'plugins.noMatches' : 'plugins.emptyTitle')}</h2><p>{t(hasFilters ? 'plugins.noMatchesHint' : 'plugins.emptyHint')}</p>{hasFilters ? <button type="button" className="pd-btn pd-plugin-button" onClick={clearFilters}>{t('plugins.clearFilters')}</button> : <button type="button" className="pd-btn pd-plugin-button" onClick={() => { setTab('discover'); setQuery(''); }}>{t('plugins.browse')}<Icon name="arrowRight" width="14" height="14" /></button>}</div> : <>
						{visiblePackages.length > 0 && <section className="pd-plugin-list-section"><div className="pd-plugin-section-heading"><h2>{t('plugins.packages')}</h2><span>{visiblePackages.length}</span></div><div className="pd-plugin-grid">{visiblePackages.map((item) => {
							const resources = resourcesFor(catalog!, item);
							const enabledCount = resources.filter((resource) => resource.enabled).length;
							const errorCount = resources.filter((resource) => Boolean(resource.error)).length;
							return <article className={`pd-plugin-card${errorCount ? ' has-error' : ''}`} key={packageKey(item)}>
								<button type="button" className="pd-plugin-card-main" onClick={() => showDetail(item)}><span className="pd-plugin-avatar"><Icon name="plugins" width="23" height="23" /></span><span className="pd-plugin-card-copy"><span className="pd-plugin-card-title">{item.name}</span><span className="pd-plugin-card-description">{item.description || t('plugins.noDescription')}</span></span><Icon name="chevronRight" width="16" height="16" /></button>
								<div className="pd-plugin-card-meta">
									<span className="pd-plugin-tag">{t(`plugins.scope.${item.scope}`)}</span>
									{item.version && <span>{item.version}</span>}
									{errorCount > 0 && <span className="pd-plugin-health-badge is-error"><Icon name="alert" width="11" height="11" />{t('plugins.errorBadge', { count: errorCount })}</span>}
									{errorCount === 0 && resources.length > 0 && enabledCount === 0 && <span className="pd-plugin-health-badge is-warning">{t('plugins.allDisabled')}</span>}
									{errorCount === 0 && resources.length > 0 && enabledCount > 0 && enabledCount < resources.length && <span className="pd-plugin-health-badge">{t('plugins.enabledRatio', { enabled: enabledCount, total: resources.length })}</span>}
									<span className={`pd-plugin-status${item.installed ? '' : ' is-warning'}`}>{t(item.installed ? 'plugins.installed' : 'plugins.missing')}</span>
								</div>
								<div className="pd-plugin-card-kinds">{KINDS.filter((value) => resources.some((resource) => resource.kind === value)).map((value) => <span key={value}><Icon name={KIND_ICON[value]} width="12" height="12" />{t(`plugins.kind.${value}`)} {resources.filter((resource) => resource.kind === value).length}</span>)}</div>
								{(kind !== 'all' || enabledFilter !== 'all') && <div className="pd-plugin-card-matches">{resources.filter(resourceMatches).map((resource) => <span key={resourceKey(resource)}>{resource.name}</span>)}</div>}
							</article>;
						})}</div></section>}
						{standaloneResources.length > 0 && <section className="pd-plugin-list-section"><div className="pd-plugin-section-heading"><h2>{t('plugins.localResources')}</h2><span>{standaloneResources.length}</span></div><ResourceGroups resources={standaloneResources} expanded={Boolean(normalizedQuery || kind !== 'all' || enabledFilter !== 'all' || scope !== 'all')} renderResource={renderResource} /></section>}
					</>}{kind === 'themes' && <p className="pd-plugin-note">{t('plugins.themeHint')}</p>}
				</> : tab === 'recommended' ? renderRecommended() : <><p className="pd-plugin-discovery-note"><Icon name="plugins" width="14" height="14" />{t('plugins.discoveryHint')}</p>{discoveryError && <div className="pd-plugin-alert is-error" role="alert">{discoveryError}<button type="button" onClick={() => setDiscoveryRetry((value) => value + 1)}>{t('plugins.retry')}</button></div>}{discoveryLoading && <p role="status" className="pd-plugin-note">{t('plugins.searching')}</p>}{discovery && <><div className="pd-plugin-section-heading"><h2>{t('plugins.community')}</h2><span>{discovery.total > discovery.items.length ? t('plugins.resultCountTotal', { count: discovery.items.length, total: discovery.total }) : t('plugins.resultCount', { count: discovery.items.length })}</span></div><div className="pd-plugin-grid">{discovery.items.map((item) => {
					const installed = installedNpmPackage(catalog?.packages, item.source);
					const sourceUrl = pluginSourceUrl(item.source);
					return <article className="pd-plugin-card pd-plugin-discovery-card" key={item.source}>
						<div className="pd-plugin-card-main"><span className="pd-plugin-avatar"><Icon name="plugins" width="23" height="23" /></span><div className="pd-plugin-card-copy"><h2 className="pd-plugin-card-title">{item.name}</h2><p className="pd-plugin-card-description">{item.description || t('plugins.noDescription')}</p></div></div>
						<div className="pd-plugin-card-meta"><span className="pd-plugin-tag">npm</span><span>{item.version}</span>{item.author && <span title={item.author}>{item.author}</span>}{installed && <span className="pd-plugin-status is-enabled"><Icon name="check" width="12" height="12" />{t('plugins.installed')}</span>}</div>
						<div className="pd-plugin-discovery-actions">
							{installed ? <button type="button" className="pd-btn pd-plugin-button is-ghost" onClick={() => { setTab('installed'); setQuery(''); showDetail(installed); }}>{t('plugins.viewInstalled')}<Icon name="arrowRight" width="13" height="13" /></button>
								: <button type="button" className="pd-btn pd-plugin-button" disabled={!canInstall || busy} onClick={() => showInstall(item.source)}>{t('plugins.install')}<Icon name="plus" width="13" height="13" /></button>}
							{sourceUrl && <a className="pd-icon-button pd-plugin-external-link" href={sourceUrl} target="_blank" rel="noreferrer" aria-label={`${item.name} · ${t('plugins.openSource')}`} title={t('plugins.openSource')}><Icon name="globe" width="14" height="14" /></a>}
						</div>
					</article>;
				})}</div>{!discovery.items.length && !discoveryLoading && <div className="pd-plugin-empty"><Icon name="search" width="25" height="25" /><h2>{t('plugins.noMatches')}</h2><p>{t('plugins.discoveryEmptyHint')}</p></div>}</>}</>}
			</>}
		</div></div>
		{install && <PluginDialog title={t('plugins.add')} onClose={() => setInstall(null)} busy={busy || picking} active={active}><form className="pd-plugin-install-form" onSubmit={installPackage}><div className="pd-plugin-dialog-body"><label className="pd-plugin-field"><span>{t('plugins.source')}</span><input data-autofocus required maxLength={4096} value={install.source} onChange={(event) => setInstall((old) => old ? { ...old, source: event.target.value } : old)} placeholder="npm:package-name@1.0.0" disabled={busy || picking} {...technicalInputAttributes} /></label><div className="pd-plugin-source-help"><p>{t('plugins.sourceHint')}</p><button className="pd-btn pd-plugin-button" type="button" onClick={() => void pickDirectory()} disabled={busy || picking}><Icon name="folder" width="14" height="14" />{t(picking ? 'plugins.picking' : 'plugins.pickDirectory')}</button></div><label className="pd-plugin-field"><span>{t('plugins.installScope')}</span><select value={install.scope} onChange={(event) => setInstall((old) => old ? { ...old, scope: event.target.value as UiPluginScope } : old)} disabled={busy || picking}><option value="user">{t('plugins.scope.user')}</option><option value="project" disabled={!catalog?.projectTrusted}>{t('plugins.scope.project')}</option></select><small>{t(install.scope === 'user' ? 'plugins.userScopeHint' : 'plugins.projectScopeHint')}</small></label><p className="pd-plugin-note">{t('plugins.installHint')}</p>{dialogError && <p className="pd-plugin-alert is-error" role="alert">{dialogError}</p>}{busy && <p className="pd-plugin-note" role="status">{t('plugins.installingHint')}</p>}</div><footer><button className="pd-btn pd-plugin-button" type="button" onClick={() => setInstall(null)} disabled={busy || picking}>{t('plugins.cancel')}</button><button className="pd-btn pd-plugin-button is-primary" type="submit" disabled={!canInstall || busy || picking || !install.source.trim() || (install.scope === 'project' && !catalog?.projectTrusted)}>{t(busy ? 'plugins.installing' : 'plugins.confirmInstall')}</button></footer></form></PluginDialog>}
		{confirm && <PluginDialog title={t(confirm.action === 'remove' ? 'plugins.removeTitle' : 'plugins.updateTitle')} onClose={() => setConfirm(null)} busy={busy} active={active}><div className="pd-plugin-dialog-body"><p>{t(confirm.action === 'remove' ? 'plugins.removeConfirm' : 'plugins.updateConfirm', { name: confirm.item.name })}</p><code className="pd-plugin-source-code">{confirm.item.source}</code><p className="pd-plugin-note">{t(`plugins.scope.${confirm.item.scope}`)}</p>{dialogError && <p className="pd-plugin-alert is-error" role="alert">{dialogError}</p>}</div><footer><button className="pd-btn pd-plugin-button" type="button" disabled={busy} onClick={() => setConfirm(null)}>{t('plugins.cancel')}</button><button className={`pd-btn pd-plugin-button ${confirm.action === 'remove' ? 'is-danger' : 'is-primary'}`} type="button" disabled={!canChange || busy || (confirm.item.scope === 'project' && !catalog?.projectTrusted)} onClick={() => void mutate({ cwd, action: confirm.action, source: confirm.item.source, scope: confirm.item.scope }, confirm.action, () => { setConfirm(null); if (confirm.action === 'remove') backToList(); }, true)}>{t(busy ? 'plugins.processing' : confirm.action === 'remove' ? 'plugins.remove' : 'plugins.update')}</button></footer></PluginDialog>}
		{preview && <PluginDialog title={preview.resource.name} onClose={() => { previewRequest.current += 1; setPreview(null); }} active={active} className="pd-plugin-preview-dialog"><div className="pd-plugin-dialog-body">
			<div className="pd-plugin-preview-toolbar">
				<div className="pd-plugin-preview-meta"><span className="pd-plugin-tag">{t(`plugins.kind.${preview.resource.kind}`)}</span><code>{preview.resource.path}</code></div>
				{preview.data?.text && <div className="pd-plugin-preview-controls">
					<SegmentedIndicator className="pd-seg" label={t('plugins.preview')} activeKey={previewMode}>
						<button type="button" data-segment-key="rendered" className={previewMode === 'rendered' ? 'is-active' : ''} aria-pressed={previewMode === 'rendered'} onClick={() => setPreviewMode('rendered')}>{t('plugins.previewRendered')}</button>
						<button type="button" data-segment-key="raw" className={previewMode === 'raw' ? 'is-active' : ''} aria-pressed={previewMode === 'raw'} onClick={() => setPreviewMode('raw')}>{t('plugins.previewRaw')}</button>
					</SegmentedIndicator>
					<button type="button" className="pd-btn is-sm pd-plugin-button is-ghost" onClick={() => void copyPreviewText()}><Icon name={previewCopied ? 'check' : 'copy'} width="13" height="13" />{t(previewCopied ? 'plugins.contentCopied' : 'plugins.copyContent')}</button>
				</div>}
			</div>
			{preview.loading ? <p role="status">{t('plugins.loadingPreview')}</p> : preview.error ? <p className="pd-plugin-alert is-error" role="alert">{preview.error}<button type="button" onClick={() => void showPreview(preview.resource)}>{t('plugins.retry')}</button></p> : <>
				{preview.data?.truncated && <p className="pd-plugin-note">{t('plugins.previewTruncated')}</p>}
				{preview.data?.text
					? previewMode === 'rendered'
						? <div className="pd-plugin-preview-markdown pd-markdown"><ConversationMarkdown>{preview.data.text}</ConversationMarkdown></div>
						: <pre className="pd-plugin-preview-text">{preview.data.text}</pre>
					: <p className="pd-plugin-note">{t('plugins.emptyFile')}</p>}
			</>}
		</div></PluginDialog>}
	</main>;
}
