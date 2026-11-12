import { useEffect, useRef, useState } from 'react';
import type { UiSessionStats, UiUsageQueryResult } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { useFocusAwarePoll } from '../focusStore';
import { useConversationMetricsPreferences } from '../conversationMetricsPreferences';
import { conversationMetricsAt, formatMetricDuration, formatMetricTokens } from '../conversationMetrics';
import { formatUsageBalance, usageBalanceTooltip } from '../usageDisplay';
import { Icon } from './Icons';
import './conversationMetrics.css';

export function ConversationMetrics() {
	const { t, locale } = useT();
	const [preferences] = useConversationMetricsPreferences();
	const bridge = useChatStore(s => s.bridge);
	const sessionId = useChatStore(s => s.sessionId);
	const sessionPath = useChatStore(s => s.sessionPath);
	const cwd = useChatStore(s => s.cwd);
	const generation = useChatStore(s => s.historyGeneration);
	const status = useChatStore(s => s.status);
	const navigating = useChatStore(s => s.navigationPending || s.sessionLoading);
	const runs = useChatStore(s => s.runs);
	const messageCount = useChatStore(s => s.messages.length);
	const providerId = useChatStore(s => s.modelProvider);
	const providers = useChatStore(s => s.modelProviders);
	const balanceEnabled = preferences.balance && providers.some((entry) => entry.provider === providerId && entry.usageQuery?.enabled);
	const balancePending = preferences.balance && navigating;
	const balanceVisible = balanceEnabled || balancePending;
	const enabled = Object.values(preferences).some(Boolean);
	const scope = JSON.stringify([cwd, sessionPath, sessionId, generation]);
	const [sample, setSample] = useState<{ scope: string; stats: UiSessionStats } | null>(null);
	const [now, setNow] = useState(Date.now);
	// Hooks 规则：轮询 hook 必须在组件顶层（effect 内调用会在 React 19.3 抛 Invalid hook call）。
	// 经 ref 间接调用当前 effect 的 refresh，每次 effect 运行刷新闭包。
	const refreshRef = useRef(() => {});
	// 会话统计轮询（非关键）：未聚焦降频 3 倍、持续未聚焦 10 分钟暂停，重新聚焦立即刷新一次。
	useFocusAwarePoll(() => { setNow(Date.now()); void refreshRef.current(); }, status === 'busy' ? 1_000 : 0);
	useEffect(() => {
		if (!enabled || !sessionId || !bridge?.getSessionStats || navigating || status === 'uninitialized' || status === 'starting') return;
		let active = true, pending = false;
		async function refresh() {
			if (pending) return;
			pending = true;
			try {
				const stats = await bridge!.getSessionStats();
				if (active && stats.sessionId === sessionId) { setSample({ scope, stats }); setNow(Date.now()); }
			} catch { if (active) setSample(null); }
			finally { pending = false; }
		}
		refreshRef.current = refresh;
		void refresh();
		return () => { active = false; refreshRef.current = () => {}; };
	}, [enabled, bridge, scope, sessionId, navigating, status, runs, messageCount]);
	// Nothing has run yet: an all-zero stats line is just noise under a fresh composer.
	// A pending switch transiently clears runs/messages — keep the row mounted
	// (showing em-dashes) so the composer dock never jumps while loading.
	if (!enabled || (!navigating && runs.length === 0 && messageCount === 0 && status !== 'busy' && !balanceVisible)) return null;
	const stats = !navigating && sample?.scope === scope ? sample.stats : null;
	const metrics = conversationMetricsAt(stats, now, status === 'busy');
	const latestRun = runs.at(-1);
	const speed = latestRun && stats?.timing?.latestRun?.id !== latestRun.id ? null : metrics.tokensPerSecond;
	const tokens = (value: number | undefined) => formatMetricTokens(value, locale);
	const exact = (value: number | undefined) => value?.toLocaleString(locale) ?? '—';
	// Only measured values earn a slot: placeholder dashes and zero counts read as noise.
	const showSpeed = preferences.speed && speed !== null;
	const showTokens = preferences.tokens && (stats?.tokens.total ?? 0) > 0;
	const showDuration = preferences.duration && (metrics.durationMs ?? 0) > 0;
	// With nothing measured yet the row stays mounted but blank, so the composer dock never jumps.
	if (!showSpeed && !showTokens && !showDuration && !balanceVisible) return <div className="pd-conversation-metrics is-empty" aria-hidden="true" />;
	return <div className="pd-conversation-metrics" role="group" aria-label={t('settings.conversationMetrics')}>
		{showSpeed && <span className="pd-metric-group pd-metric-speed" aria-label={`${t('settings.metrics.speed')}: ${speed?.toFixed(1)} t/s`}>{speed?.toLocaleString(locale, { maximumFractionDigits: 1 })} t/s</span>}
		{showTokens && <span className="pd-metric-group" aria-label={t('metrics.tokensDescription', { input: exact(stats?.tokens.input), output: exact(stats?.tokens.output), total: exact(stats?.tokens.total) })}><span className="pd-metric-input">↑{tokens(stats?.tokens.input)}</span><span className="pd-metric-output">↓{tokens(stats?.tokens.output)}</span><span>Σ {tokens(stats?.tokens.total)}</span></span>}
		{showDuration && <span className="pd-metric-group pd-metric-duration" aria-label={`${t('settings.metrics.duration')}: ${formatMetricDuration(metrics.durationMs)}`}><Icon name="clock" width="12" height="12" />{formatMetricDuration(metrics.durationMs)}</span>}
		{balanceVisible && <ProviderBalance pending={balancePending} />}
	</div>;
}

/** Balance segment for the current model's provider; auto refreshes only while that provider is in use. */
function ProviderBalance({ pending: switching = false }: { pending?: boolean }) {
	const { t } = useT();
	const bridge = useChatStore(s => s.bridge);
	const providerId = useChatStore(s => s.modelProvider);
	const providers = useChatStore(s => s.modelProviders);
	const status = useChatStore(s => s.status);
	const usageQuery = providers.find((entry) => entry.provider === providerId)?.usageQuery;
	const intervalMinutes = usageQuery?.enabled ? usageQuery.intervalMinutes ?? 10 : 0;
	const [result, setResult] = useState<UiUsageQueryResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [tick, setTick] = useState(0);
	const wasBusy = useRef(false);
	// Hooks 规则：轮询 hook 在组件顶层，经 ref 间接调用当前 effect 的 query（同上）。
	const queryRef = useRef(() => {});
	// 用量查询轮询（非关键）：未聚焦降频 3 倍、持续未聚焦 10 分钟暂停，重新聚焦立即刷新一次。
	useFocusAwarePoll(() => { void queryRef.current(); }, intervalMinutes > 0 ? intervalMinutes * 60_000 : 0);
	// A finished generation is when the balance actually moved; refresh then.
	useEffect(() => {
		if (wasBusy.current && status !== 'busy') setTick((current) => current + 1);
		wasBusy.current = status === 'busy';
	}, [status]);
	useEffect(() => {
		if (switching || !usageQuery?.enabled || !bridge?.queryProviderUsage) return;
		let active = true, pending = false;
		const query = async () => {
			if (pending) return;
			pending = true; setBusy(true);
			try {
				const next = await bridge!.queryProviderUsage(providerId);
				if (active) setResult(next);
			} catch { if (active) setResult(null); }
			finally { pending = false; if (active) setBusy(false); }
		};
		queryRef.current = query;
		void query();
		return () => { active = false; queryRef.current = () => {}; };
	}, [bridge, providerId, usageQuery?.enabled, intervalMinutes, tick, switching]);
	if (switching) return <button type="button" className="pd-metric-group pd-metric-balance" data-action="refresh-balance" title={t('usage.refreshing')} aria-label={t('usage.refreshing')} disabled>—</button>;
	if (!usageQuery?.enabled) return null;
	const refresh = () => setTick((current) => current + 1);
	const first = result?.data?.find((entry) => entry.remaining !== undefined) ?? result?.data?.[0];
	const tooltip = usageBalanceTooltip(result, t);
	const className = `pd-metric-group pd-metric-balance${result && !result.ok ? ' is-error' : ''}${first?.isValid === false ? ' is-invalid' : ''}`;
	if (!result) return <button type="button" className={className} data-action="refresh-balance" title={tooltip} aria-label={tooltip} onClick={refresh}>{busy ? t('usage.refreshing') : '—'}</button>;
	if (!result.ok && !result.data?.length) return <button type="button" className={className} data-action="refresh-balance" title={tooltip} aria-label={tooltip} onClick={refresh}>{busy ? t('usage.refreshing') : t('usage.queryFailedShort')}</button>;
	if (!first) return <button type="button" className={className} data-action="refresh-balance" title={tooltip} aria-label={tooltip} onClick={refresh}>{t('usage.queryFailedShort')}</button>;
	return <button type="button" className={className} data-action="refresh-balance" title={tooltip} aria-label={tooltip} onClick={refresh}>{formatUsageBalance(first)}</button>;
}
