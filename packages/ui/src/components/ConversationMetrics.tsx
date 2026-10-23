import { useEffect, useState } from 'react';
import type { UiSessionStats } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { useConversationMetricsPreferences } from '../conversationMetricsPreferences';
import { conversationMetricsAt, formatMetricDuration, formatMetricTokens } from '../conversationMetrics';
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
	const enabled = Object.values(preferences).some(Boolean);
	const scope = JSON.stringify([cwd, sessionPath, sessionId, generation]);
	const [sample, setSample] = useState<{ scope: string; stats: UiSessionStats } | null>(null);
	const [now, setNow] = useState(Date.now);
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
		void refresh();
		const interval = status === 'busy' ? window.setInterval(() => { setNow(Date.now()); void refresh(); }, 1_000) : undefined;
		return () => { active = false; if (interval !== undefined) window.clearInterval(interval); };
	}, [enabled, bridge, scope, sessionId, navigating, status, runs, messageCount]);
	// Nothing has run yet: an all-zero stats line is just noise under a fresh composer.
	// A pending switch transiently clears runs/messages — keep the row mounted
	// (showing em-dashes) so the composer dock never jumps while loading.
	if (!enabled || (!navigating && runs.length === 0 && messageCount === 0 && status !== 'busy')) return null;
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
	if (!showSpeed && !showTokens && !showDuration) return <div className="pd-conversation-metrics is-empty" aria-hidden="true" />;
	return <div className="pd-conversation-metrics" role="group" aria-label={t('settings.conversationMetrics')}>
		{showSpeed && <span className="pd-metric-group pd-metric-speed" aria-label={`${t('settings.metrics.speed')}: ${speed?.toFixed(1)} t/s`}>{speed?.toLocaleString(locale, { maximumFractionDigits: 1 })} t/s</span>}
		{showTokens && <span className="pd-metric-group" aria-label={t('metrics.tokensDescription', { input: exact(stats?.tokens.input), output: exact(stats?.tokens.output), total: exact(stats?.tokens.total) })}><span className="pd-metric-input">↑{tokens(stats?.tokens.input)}</span><span className="pd-metric-output">↓{tokens(stats?.tokens.output)}</span><span>Σ {tokens(stats?.tokens.total)}</span></span>}
		{showDuration && <span className="pd-metric-group pd-metric-duration" aria-label={`${t('settings.metrics.duration')}: ${formatMetricDuration(metrics.durationMs)}`}><Icon name="clock" width="12" height="12" />{formatMetricDuration(metrics.durationMs)}</span>}
	</div>;
}
