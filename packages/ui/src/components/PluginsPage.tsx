import { useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiPluginCatalog, UiPluginDiscovery, UiPluginMutation, UiPluginPackage, UiPluginResource, UiPluginResourceKind, UiPluginResourcePreview, UiPluginScope } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { SegmentedIndicator } from './SegmentedIndicator';
import './pluginsPage.css';

const KINDS: UiPluginResourceKind[] = ['extensions', 'skills', 'prompts', 'themes'];
const KIND_ICON: Record<UiPluginResourceKind, ComponentProps<typeof Icon>['name']> = { extensions: 'plugins', skills: 'spark', prompts: 'message', themes: 'settings' };
const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value);
const packageKey = (item: UiPluginPackage) => JSON.stringify([item.scope, item.source]);
const resourceKey = (item: UiPluginResource) => JSON.stringify([item.scope, item.kind, item.path]);
const resourcesFor = (catalog: UiPluginCatalog, item: UiPluginPackage) => catalog.resources.filter((resource) => resource.origin === 'package' && resource.source === item.source && resource.scope === item.scope);
type InstallDraft = { source: string; scope: UiPluginScope };
type ConfirmAction = { action: 'remove' | 'update'; item: UiPluginPackage };
type PreviewState = { resource: UiPluginResource; loading: boolean; data: UiPluginResourcePreview | null; error: string | null };

function PluginDialog({ title, onClose, busy = false, children, className = '' }: { title: string; onClose(): void; busy?: boolean; children: ReactNode; className?: string }) {
	const { t } = useT();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const id = useId();
	useEffect(() => {
		const dialog = dialogRef.current;
		dialog?.showModal();
		return () => { dialog?.close(); };
	}, []);
	return createPortal(<dialog ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={id} className={`pd-plugin-dialog ${className}`} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
		<header><h2 id={id}>{title}</h2><button type="button" className="pd-icon-button" aria-label={t('plugins.close')} onClick={onClose} disabled={busy}><Icon name="close" /></button></header>{children}
	</dialog>, document.body);
}

function ResourceRow({ resource, canChange, busy, onToggle, onPreview }: { resource: UiPluginResource; canChange: boolean; busy: boolean; onToggle(): void; onPreview(): void }) {
	const { t } = useT();
	const previewable = resource.kind === 'skills' || resource.kind === 'prompts';
	return <article className="pd-plugin-resource" data-kind={resource.kind} data-resource-path={resource.path}>
		<span className="pd-plugin-resource-icon"><Icon name={KIND_ICON[resource.kind]} width="18" height="18" /></span>
		<div className="pd-plugin-resource-copy"><div><strong>{resource.name}</strong><span className="pd-plugin-tag">{t(`plugins.kind.${resource.kind}`)}</span><span className="pd-plugin-tag">{t(`plugins.scope.${resource.scope}`)}</span></div>{resource.description && <p>{resource.description}</p>}<small title={resource.path}>{resource.path}</small><span className={`pd-plugin-resource-status${resource.error ? ' is-error' : ''}`}>{resource.error || t(!resource.enabled ? 'plugins.disabled' : resource.loaded ? 'plugins.loaded' : 'plugins.notLoaded')}</span></div>
		<div className="pd-plugin-resource-actions">{previewable && <button type="button" className="pd-plugin-button is-quiet" onClick={onPreview} disabled={busy}>{t('plugins.preview')}</button>}<button type="button" className="pd-plugin-switch" role="switch" aria-checked={resource.enabled} aria-label={t('plugins.toggleResource', { name: resource.name })} title={resource.canToggle ? t(resource.enabled ? 'plugins.disable' : 'plugins.enable') : t('plugins.cannotToggle')} disabled={!canChange || busy || !resource.canToggle} onClick={onToggle}><span aria-hidden="true" /></button></div>
	</article>;
}

export function PluginsPage({ onToggleSidebar, headerControls }: { onToggleSidebar(): void; headerControls?: ReactNode }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const sessionId = useChatStore((state) => state.sessionId);
	const status = useChatStore((state) => state.status);
	const settingsLoading = useChatStore((state) => state.settingsLoading);
	const navigationPending = useChatStore((state) => state.navigationPending);
	const [catalog, setCatalog] = useState<UiPluginCatalog | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [tab, setTab] = useState<'installed' | 'discover'>('installed');
	const [query, setQuery] = useState('');
	const [scope, setScope] = useState<'all' | UiPluginScope>('all');
	const [kind, setKind] = useState<'all' | UiPluginResourceKind>('all');
	const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
	const [detailKey, setDetailKey] = useState<string | null>(null);
	const [install, setInstall] = useState<InstallDraft | null>(null);
	const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	const [dialogError, setDialogError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [picking, setPicking] = useState(false);
	const [retry, setRetry] = useState(0);
	const [discovery, setDiscovery] = useState<UiPluginDiscovery | null>(null);
	const [discoveryLoading, setDiscoveryLoading] = useState(false);
	const [discoveryError, setDiscoveryError] = useState<string | null>(null);
	const [discoveryRetry, setDiscoveryRetry] = useState(0);
	const active = useRef(false);
	const generation = useRef(0);
	const fetchRequest = useRef(0);
	const mutationLock = useRef(false);
	const previewRequest = useRef(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const listScroll = useRef(0);
	const ready = Boolean(bridge && cwd && status !== 'starting' && status !== 'uninitialized');
	const canChange = Boolean(bridge && cwd && status === 'idle' && !settingsLoading && !navigationPending && !loading);
	const contextCurrent = (token: number) => active.current && generation.current === token && useChatStore.getState().bridge === bridge && useChatStore.getState().cwd === cwd && useChatStore.getState().sessionId === sessionId;

	useEffect(() => { active.current = true; return () => { active.current = false; generation.current += 1; }; }, []);
	useEffect(() => {
		generation.current += 1; fetchRequest.current += 1; previewRequest.current += 1;
		setCatalog(null); setDetailKey(null); setInstall(null); setConfirm(null); setPreview(null); setError(null); setFeedback(null); setDialogError(null); setBusy(false); setPicking(false); mutationLock.current = false;
	}, [bridge, cwd, sessionId]);
	useEffect(() => {
		if (!ready || !bridge || busy) return;
		const token = generation.current;
		const request = ++fetchRequest.current;
		setLoading(true);
		void bridge.getPluginCatalog(cwd).then((value) => { if (contextCurrent(token) && request === fetchRequest.current) setCatalog(value); }).catch((cause) => { if (contextCurrent(token) && request === fetchRequest.current) setError(errorMessage(cause)); }).finally(() => { if (contextCurrent(token) && request === fetchRequest.current) setLoading(false); });
		return () => { fetchRequest.current += 1; };
	}, [bridge, cwd, sessionId, ready, retry, busy]);
	function refreshCatalog() { setError(null); setRetry((value) => value + 1); }
	useEffect(() => {
		if (tab !== 'discover' || !bridge) return;
		let alive = true;
		setDiscoveryLoading(true); setDiscoveryError(null); setDiscovery(null);
		const timer = window.setTimeout(() => {
			void bridge.discoverPlugins(query.trim()).then((value) => { if (alive) setDiscovery(value); }).catch((cause) => { if (alive) setDiscoveryError(errorMessage(cause)); }).finally(() => { if (alive) setDiscoveryLoading(false); });
		}, 350);
		return () => { alive = false; window.clearTimeout(timer); };
	}, [bridge, tab, query, discoveryRetry]);
	async function mutate(input: UiPluginMutation, done?: () => void, inDialog = false) {
		if (!bridge || !canChange || mutationLock.current) return;
		const token = generation.current;
		mutationLock.current = true; fetchRequest.current += 1; setBusy(true); setError(null); setDialogError(null); setFeedback(null);
		try {
			const value = await bridge.mutatePlugin(input);
			if (!contextCurrent(token)) return;
			setCatalog(value); setFeedback(t(value.warnings.length ? 'plugins.doneWithWarnings' : `plugins.done.${input.action}`)); done?.();
		} catch (cause) { if (contextCurrent(token)) (inDialog ? setDialogError : setError)(errorMessage(cause)); }
		finally { if (contextCurrent(token)) { mutationLock.current = false; setBusy(false); } }
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
		void mutate({ cwd, action: 'install', source: install.source.trim(), scope: install.scope }, () => setInstall(null), true);
	}
	async function showPreview(resource: UiPluginResource) {
		if (!bridge) return;
		const token = generation.current;
		const request = ++previewRequest.current;
		setPreview({ resource, loading: true, data: null, error: null });
		try { const value = await bridge.previewPluginResource({ cwd, path: resource.path, kind: resource.kind, scope: resource.scope }); if (contextCurrent(token) && request === previewRequest.current) setPreview({ resource, loading: false, data: value, error: null }); }
		catch (cause) { if (contextCurrent(token) && request === previewRequest.current) setPreview({ resource, loading: false, data: null, error: errorMessage(cause) }); }
	}
	function showDetail(item: UiPluginPackage) { listScroll.current = scrollRef.current?.scrollTop ?? 0; setDetailKey(packageKey(item)); scrollRef.current?.scrollTo({ top: 0 }); }
	function backToList() { setDetailKey(null); requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = listScroll.current; }); }
	function toggleResource(resource: UiPluginResource) { void mutate({ cwd, action: 'set-enabled', path: resource.path, kind: resource.kind, scope: resource.scope, enabled: !resource.enabled }); }
	const detail = catalog?.packages.find((item) => packageKey(item) === detailKey);
	const detailWritable = canChange && Boolean(detail && (detail.scope === 'user' || catalog?.projectTrusted));
	const detailUpdatable = Boolean(detail && /^(?:npm:|(?:git:)?https:\/\/)/.test(detail.source));
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
	const renderResource = (resource: UiPluginResource) => <ResourceRow key={resourceKey(resource)} resource={resource} canChange={canChange && (resource.scope === 'user' || Boolean(catalog?.projectTrusted))} busy={busy} onToggle={() => toggleResource(resource)} onPreview={() => void showPreview(resource)} />;
	return <main className="pd-main pd-plugins-page">
		<header className="pd-chat-header">{headerControls}<button className="pd-icon-button pd-header-sidebar-toggle" type="button" onClick={onToggleSidebar} aria-label={t('chat.toggleSidebar')}><Icon name="panel" /></button><div className="pd-plugins-header-title"><Icon name="plugins" width="16" height="16" /><span>{t('sidebar.plugins')}</span>{detail && <><Icon name="chevronRight" width="13" height="13" /><span>{detail.name}</span></>}</div></header>
		<div className="pd-plugins-scroll" ref={scrollRef}><div className="pd-plugins-content">
			{detail ? <>
				<button type="button" className="pd-plugin-button is-quiet pd-plugin-back" onClick={backToList}><Icon name="arrowLeft" width="15" height="15" />{t('plugins.back')}</button>
				<div className="pd-plugin-detail-heading"><span className="pd-plugin-avatar is-large"><Icon name="plugins" width="28" height="28" /></span><div><div className="pd-plugin-detail-title"><h1>{detail.name}</h1><span className="pd-plugin-tag">{t(`plugins.scope.${detail.scope}`)}</span></div><p>{detail.description || t('plugins.noDescription')}</p></div></div>
				<div className="pd-plugin-detail-actions">
					{!detail.installed && <button type="button" className="pd-plugin-button is-primary" onClick={() => { setDialogError(null); setInstall({ source: detail.source, scope: detail.scope }); }} disabled={!detailWritable || busy}>{t('plugins.install')}</button>}
					{detail.installed && detailUpdatable && <button type="button" className="pd-plugin-button" onClick={() => { setDialogError(null); setConfirm({ action: 'update', item: detail }); }} disabled={!detailWritable || busy}><Icon name="refresh" width="14" height="14" />{t('plugins.update')}</button>}
					<button type="button" className="pd-plugin-button is-danger" onClick={() => { setDialogError(null); setConfirm({ action: 'remove', item: detail }); }} disabled={!detailWritable || busy}>{t('plugins.remove')}</button>
					<span className={`pd-plugin-status${detail.installed ? ' is-enabled' : ''}`}>{t(detail.installed ? 'plugins.installed' : 'plugins.missing')}</span>
				</div>
				{detail.installed && !detailUpdatable && <p className="pd-plugin-note">{t('plugins.localUpdateHint')}</p>}
			</> : <div className="pd-plugins-intro"><div><span className="pd-plugins-eyebrow">{t('plugins.eyebrow')}</span><h1>{t('plugins.title')}</h1><p>{t('plugins.description')}</p></div><div className="pd-plugins-intro-actions"><button type="button" className="pd-plugin-button is-quiet" onClick={refreshCatalog} disabled={!ready || loading || busy} aria-label={t('plugins.refresh')}><Icon name="refresh" width="16" height="16" /></button><button type="button" className="pd-plugin-button is-primary" onClick={() => showInstall()} disabled={!canChange || busy}><Icon name="plus" width="16" height="16" />{t('plugins.add')}</button></div></div>}
			{error && <div className="pd-plugin-alert is-error" role="alert">{error}<button type="button" onClick={refreshCatalog} disabled={loading || busy}>{t('plugins.retry')}</button></div>}
			{feedback && <p className="pd-plugin-feedback" role="status"><Icon name="check" width="14" height="14" />{feedback}</p>}
			{!canChange && cwd && !loading && <p className="pd-plugin-note"><Icon name="clock" width="14" height="14" />{t('plugins.idleHint')}</p>}
			{catalog && !catalog.projectTrusted && <p className="pd-plugin-note"><Icon name="folder" width="14" height="14" />{t('plugins.trustHint')}</p>}
			{catalog?.warnings.length ? <details className="pd-plugin-warnings"><summary>{t('plugins.warnings', { count: catalog.warnings.length })}</summary>{catalog.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
			{detail && catalog ? <><section className="pd-plugin-detail-section"><h2>{t('plugins.includes')}</h2><p className="pd-plugin-note">{t('plugins.resourceHint')}</p>{resourcesFor(catalog, detail).length ? <div className="pd-plugin-resources">{resourcesFor(catalog, detail).map(renderResource)}</div> : <div className="pd-plugin-empty is-compact">{t('plugins.noResources')}</div>}{resourcesFor(catalog, detail).some((resource) => resource.kind === 'themes') && <p className="pd-plugin-note">{t('plugins.themeHint')}</p>}</section><section className="pd-plugin-detail-section"><h2>{t('plugins.information')}</h2><dl className="pd-plugin-info"><div><dt>{t('plugins.version')}</dt><dd>{detail.version || '—'}</dd></div><div><dt>{t('plugins.source')}</dt><dd>{detail.source}</dd></div><div><dt>{t('plugins.scopeLabel')}</dt><dd>{t(`plugins.scope.${detail.scope}`)}</dd></div>{detail.path && <div><dt>{t('plugins.path')}</dt><dd>{detail.path}</dd></div>}</dl></section></> : <>
				<div className="pd-plugins-toolbar"><SegmentedIndicator className="pd-plugins-tabs" label={t('plugins.views')} activeKey={tab}>{(['installed', 'discover'] as const).map((value) => <button type="button" data-segment-key={value} key={value} className={tab === value ? 'is-active' : ''} aria-pressed={tab === value} onClick={() => { setTab(value); setQuery(''); }}>{t(`plugins.${value}`)}</button>)}</SegmentedIndicator><label className="pd-plugins-search"><Icon name="search" width="15" height="15" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t(tab === 'installed' ? 'plugins.searchInstalled' : 'plugins.searchDiscover')} placeholder={t(tab === 'installed' ? 'plugins.searchInstalled' : 'plugins.searchDiscover')} /></label></div>
				{tab === 'installed' ? <>
					<div className="pd-plugin-filters"><label>{t('plugins.scopeLabel')}<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="all">{t('plugins.allScopes')}</option><option value="user">{t('plugins.scope.user')}</option><option value="project">{t('plugins.scope.project')}</option></select></label><label>{t('plugins.kindLabel')}<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">{t('plugins.allKinds')}</option>{KINDS.map((value) => <option key={value} value={value}>{t(`plugins.kind.${value}`)}</option>)}</select></label><label>{t('plugins.stateLabel')}<select value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value as typeof enabledFilter)}><option value="all">{t('plugins.allStates')}</option><option value="enabled">{t('plugins.enabled')}</option><option value="disabled">{t('plugins.disabled')}</option></select></label><button type="button" className="pd-plugin-button is-quiet" onClick={() => void mutate({ cwd, action: 'reload' })} disabled={!canChange || busy}><Icon name="refresh" width="13" height="13" />{t('plugins.reload')}</button></div>
					{!cwd ? <div className="pd-plugin-empty"><Icon name="folder" width="28" height="28" /><h2>{t('plugins.openProjectTitle')}</h2><p>{t('plugins.openProjectHint')}</p><button type="button" className="pd-plugin-button" onClick={() => void useChatStore.getState().pickWorkspace().catch((cause) => setError(errorMessage(cause)))}>{t('sidebar.openProject')}</button></div> : loading && !catalog ? <div className="pd-plugin-empty" role="status">{t('plugins.loading')}</div> : catalog && !visiblePackages.length && !standaloneResources.length ? <div className="pd-plugin-empty"><span className="pd-plugin-avatar is-large"><Icon name="plugins" width="25" height="25" /></span><h2>{t(query || scope !== 'all' || kind !== 'all' || enabledFilter !== 'all' ? 'plugins.noMatches' : 'plugins.emptyTitle')}</h2><p>{t(query || scope !== 'all' || kind !== 'all' || enabledFilter !== 'all' ? 'plugins.noMatchesHint' : 'plugins.emptyHint')}</p><button type="button" className="pd-plugin-button" onClick={() => { setTab('discover'); setQuery(''); }}>{t('plugins.browse')}<Icon name="arrowRight" width="14" height="14" /></button></div> : <>
						{visiblePackages.length > 0 && <section className="pd-plugin-list-section"><div className="pd-plugin-section-heading"><h2>{t('plugins.packages')}</h2><span>{visiblePackages.length}</span></div><div className="pd-plugin-grid">{visiblePackages.map((item) => { const resources = resourcesFor(catalog!, item); return <article className="pd-plugin-card" key={packageKey(item)}><button type="button" className="pd-plugin-card-main" onClick={() => showDetail(item)}><span className="pd-plugin-avatar"><Icon name="plugins" width="23" height="23" /></span><span className="pd-plugin-card-copy"><span className="pd-plugin-card-title">{item.name}</span><span className="pd-plugin-card-description">{item.description || t('plugins.noDescription')}</span></span><Icon name="chevronRight" width="16" height="16" /></button><div className="pd-plugin-card-meta"><span className="pd-plugin-tag">{t(`plugins.scope.${item.scope}`)}</span>{item.version && <span>{item.version}</span>}<span className={`pd-plugin-status${item.installed ? '' : ' is-warning'}`}>{t(item.installed ? 'plugins.installed' : 'plugins.missing')}</span></div><div className="pd-plugin-card-kinds">{KINDS.filter((value) => resources.some((resource) => resource.kind === value)).map((value) => <span key={value}><Icon name={KIND_ICON[value]} width="12" height="12" />{t(`plugins.kind.${value}`)} {resources.filter((resource) => resource.kind === value).length}</span>)}</div>{(kind !== 'all' || enabledFilter !== 'all') && <div className="pd-plugin-card-matches">{resources.filter(resourceMatches).map((resource) => <span key={resourceKey(resource)}>{resource.name}</span>)}</div>}</article>; })}</div></section>}
						{standaloneResources.length > 0 && <section className="pd-plugin-list-section"><div className="pd-plugin-section-heading"><h2>{t('plugins.localResources')}</h2><span>{standaloneResources.length}</span></div><div className="pd-plugin-resources">{standaloneResources.map(renderResource)}</div></section>}
					</>}{kind === 'themes' && <p className="pd-plugin-note">{t('plugins.themeHint')}</p>}
				</> : <><p className="pd-plugin-discovery-note"><Icon name="plugins" width="14" height="14" />{t('plugins.discoveryHint')}</p>{discoveryError && <div className="pd-plugin-alert is-error" role="alert">{discoveryError}<button type="button" onClick={() => setDiscoveryRetry((value) => value + 1)}>{t('plugins.retry')}</button></div>}{discoveryLoading && <p role="status" className="pd-plugin-note">{t('plugins.searching')}</p>}{discovery && <><div className="pd-plugin-section-heading"><h2>{t('plugins.community')}</h2><span>{t('plugins.resultCount', { count: discovery.items.length })}</span></div><div className="pd-plugin-grid">{discovery.items.map((item) => <article className="pd-plugin-card pd-plugin-discovery-card" key={item.source}><div className="pd-plugin-card-main"><span className="pd-plugin-avatar"><Icon name="plugins" width="23" height="23" /></span><div className="pd-plugin-card-copy"><h2 className="pd-plugin-card-title">{item.name}</h2><p className="pd-plugin-card-description">{item.description || t('plugins.noDescription')}</p></div></div><div className="pd-plugin-card-meta"><span className="pd-plugin-tag">npm</span><span>{item.version}</span>{item.author && <span title={item.author}>{item.author}</span>}</div><button type="button" className="pd-plugin-button" disabled={!canChange || busy} onClick={() => showInstall(item.source)}>{t('plugins.install')}<Icon name="plus" width="13" height="13" /></button></article>)}</div>{!discovery.items.length && !discoveryLoading && <div className="pd-plugin-empty"><Icon name="search" width="25" height="25" /><h2>{t('plugins.noMatches')}</h2><p>{t('plugins.discoveryEmptyHint')}</p></div>}</>}</>}
			</>}
		</div></div>
		{install && <PluginDialog title={t('plugins.add')} onClose={() => setInstall(null)} busy={busy || picking}><form className="pd-plugin-install-form" onSubmit={installPackage}><div className="pd-plugin-dialog-body"><label className="pd-plugin-field"><span>{t('plugins.source')}</span><input autoFocus required maxLength={4096} spellCheck={false} value={install.source} onChange={(event) => setInstall((old) => old ? { ...old, source: event.target.value } : old)} placeholder="npm:package-name@1.0.0" disabled={busy || picking} /></label><div className="pd-plugin-source-help"><p>{t('plugins.sourceHint')}</p><button className="pd-plugin-button" type="button" onClick={() => void pickDirectory()} disabled={busy || picking}><Icon name="folder" width="14" height="14" />{t(picking ? 'plugins.picking' : 'plugins.pickDirectory')}</button></div><label className="pd-plugin-field"><span>{t('plugins.installScope')}</span><select value={install.scope} onChange={(event) => setInstall((old) => old ? { ...old, scope: event.target.value as UiPluginScope } : old)} disabled={busy || picking}><option value="user">{t('plugins.scope.user')}</option><option value="project" disabled={!catalog?.projectTrusted}>{t('plugins.scope.project')}</option></select><small>{t(install.scope === 'user' ? 'plugins.userScopeHint' : 'plugins.projectScopeHint')}</small></label><p className="pd-plugin-note">{t('plugins.installHint')}</p>{dialogError && <p className="pd-plugin-alert is-error" role="alert">{dialogError}</p>}{busy && <p className="pd-plugin-note" role="status">{t('plugins.installingHint')}</p>}</div><footer><button className="pd-plugin-button" type="button" onClick={() => setInstall(null)} disabled={busy || picking}>{t('plugins.cancel')}</button><button className="pd-plugin-button is-primary" type="submit" disabled={!canChange || busy || picking || !install.source.trim() || (install.scope === 'project' && !catalog?.projectTrusted)}>{t(busy ? 'plugins.installing' : 'plugins.confirmInstall')}</button></footer></form></PluginDialog>}
		{confirm && <PluginDialog title={t(confirm.action === 'remove' ? 'plugins.removeTitle' : 'plugins.updateTitle')} onClose={() => setConfirm(null)} busy={busy}><div className="pd-plugin-dialog-body"><p>{t(confirm.action === 'remove' ? 'plugins.removeConfirm' : 'plugins.updateConfirm', { name: confirm.item.name })}</p><code className="pd-plugin-source-code">{confirm.item.source}</code><p className="pd-plugin-note">{t(`plugins.scope.${confirm.item.scope}`)}</p>{dialogError && <p className="pd-plugin-alert is-error" role="alert">{dialogError}</p>}</div><footer><button className="pd-plugin-button" type="button" disabled={busy} onClick={() => setConfirm(null)}>{t('plugins.cancel')}</button><button className={`pd-plugin-button ${confirm.action === 'remove' ? 'is-danger' : 'is-primary'}`} type="button" disabled={!canChange || busy || (confirm.item.scope === 'project' && !catalog?.projectTrusted)} onClick={() => void mutate({ cwd, action: confirm.action, source: confirm.item.source, scope: confirm.item.scope }, () => { setConfirm(null); if (confirm.action === 'remove') backToList(); }, true)}>{t(busy ? 'plugins.processing' : confirm.action === 'remove' ? 'plugins.remove' : 'plugins.update')}</button></footer></PluginDialog>}
		{preview && <PluginDialog title={preview.resource.name} onClose={() => { previewRequest.current += 1; setPreview(null); }} className="pd-plugin-preview-dialog"><div className="pd-plugin-dialog-body"><div className="pd-plugin-preview-meta"><span className="pd-plugin-tag">{t(`plugins.kind.${preview.resource.kind}`)}</span><code>{preview.resource.path}</code></div>{preview.loading ? <p role="status">{t('plugins.loadingPreview')}</p> : preview.error ? <p className="pd-plugin-alert is-error" role="alert">{preview.error}<button type="button" onClick={() => void showPreview(preview.resource)}>{t('plugins.retry')}</button></p> : <>{preview.data?.truncated && <p className="pd-plugin-note">{t('plugins.previewTruncated')}</p>}<pre className="pd-plugin-preview-text">{preview.data?.text || t('plugins.emptyFile')}</pre></>}</div></PluginDialog>}
	</main>;
}
