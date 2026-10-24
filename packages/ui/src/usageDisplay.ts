import type { UiUsageData, UiUsageQueryResult } from '@pidesktop/shared';

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩' };

function amount(value: number): string {
	const digits = Math.abs(value) >= 1000 ? 0 : 2;
	return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** `7.28 USD` → `$7.28`; unknown units keep their code so relays can define their own. */
export function formatUsageBalance(entry: UiUsageData): string {
	if (entry.remaining === undefined || entry.remaining === null) return entry.invalidMessage ?? '';
	const symbol = entry.unit ? CURRENCY_SYMBOLS[entry.unit.toUpperCase()] : undefined;
	const value = amount(entry.remaining);
	return symbol ? `${symbol}${value}` : entry.unit ? `${value} ${entry.unit}` : value;
}

function describe(entry: UiUsageData): string {
	const parts: string[] = [];
	if (entry.planName) parts.push(entry.planName);
	parts.push(formatUsageBalance(entry));
	if (entry.used !== undefined && entry.total !== undefined) parts.push(`${amount(entry.used)}/${amount(entry.total)} ${entry.unit ?? ''}`.trim());
	if (entry.isValid === false && entry.invalidMessage) parts.push(entry.invalidMessage);
	return parts.filter(Boolean).join(' · ');
}

/** Multi-line tooltip: every wallet row, the update time, and the refresh hint. */
export function usageBalanceTooltip(result: UiUsageQueryResult | null, t: (key: string, values?: Record<string, string>) => string): string {
	const time = result ? new Date(result.queriedAt).toLocaleTimeString() : '';
	const lines: string[] = [];
	if (result?.data?.length) for (const entry of result.data) lines.push(describe(entry));
	if (result && !result.ok && result.error) lines.push(result.error);
	if (time) lines.push(t('usage.updatedAt', { time }));
	lines.push(t('usage.clickToRefresh'));
	return lines.join('\n');
}
