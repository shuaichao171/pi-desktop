import type { UiAgentQuota, UiAgentQuotaWindow } from '@pidesktop/shared';

type Translate = (key: string, values?: Record<string, string>) => string;

/** At or above this share of a window the limit reads as a warning. */
export const AGENT_QUOTA_WARNING_PERCENT = 80;

/** The window's name; the full form leads with its model group when the account has several. */
export function agentQuotaWindowLabel(window: UiAgentQuotaWindow, t: Translate, short = false): string {
	const name = window.kind === 'five_hour' ? t(short ? 'agentQuota.fiveHourShort' : 'agentQuota.fiveHour')
		: window.kind === 'weekly' ? t(short ? 'agentQuota.weeklyShort' : 'agentQuota.weekly')
			: window.label ?? '';
	return !short && window.group ? `${window.group} · ${name}` : name;
}

export function formatAgentQuotaPercent(value: number): string {
	return `${Math.round(value)}%`;
}

/** Today: the time only; otherwise the date and time. */
export function formatAgentQuotaReset(resetsAt: number, locale: string, now = Date.now()): string {
	const date = new Date(resetsAt);
	const sameDay = new Date(now).toDateString() === date.toDateString();
	return sameDay
		? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The 5-hour and weekly windows, in that order; other windows only show in the details.
 * With several model groups (Antigravity) each kind shows its most used window.
 */
export function mainAgentQuotaWindows(quota: UiAgentQuota | null): UiAgentQuotaWindow[] {
	if (!quota) return [];
	return (['five_hour', 'weekly'] as const).flatMap((kind) => {
		const windows = quota.windows.filter((window) => window.kind === kind);
		return windows.length ? [windows.reduce((most, window) => window.usedPercent > most.usedPercent ? window : most)] : [];
	});
}

export function agentQuotaLevel(window: UiAgentQuotaWindow): 'ok' | 'warning' | 'exhausted' {
	return window.usedPercent >= 100 ? 'exhausted' : window.usedPercent >= AGENT_QUOTA_WARNING_PERCENT ? 'warning' : 'ok';
}

/** Multi-line description of every window, the plan, the query time and any error. */
export function agentQuotaTooltip(quota: UiAgentQuota | null, t: Translate, locale: string): string {
	const lines: string[] = [];
	if (quota) {
		if (quota.plan) lines.push(t('agentQuota.plan', { plan: quota.plan }));
		for (const window of quota.windows) {
			const reset = window.resetsAt ? ` · ${t('agentQuota.resets', { time: formatAgentQuotaReset(window.resetsAt, locale) })}` : '';
			lines.push(`${agentQuotaWindowLabel(window, t)}: ${t('agentQuota.used', { percent: formatAgentQuotaPercent(window.usedPercent) })}${reset}`);
		}
		if (quota.ok && !quota.windows.length) lines.push(t('agentQuota.none'));
		if (!quota.ok && quota.error) lines.push(t('agentQuota.failed', { error: quota.error }));
		if (!quota.ok && quota.windows.length) lines.push(t('agentQuota.stale'));
		lines.push(t('usage.updatedAt', { time: new Date(quota.queriedAt).toLocaleTimeString(locale) }));
	}
	lines.push(t('usage.clickToRefresh'));
	return lines.join('\n');
}
