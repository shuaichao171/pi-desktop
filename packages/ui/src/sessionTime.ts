import { translate, type Locale } from './i18n.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact recency label for sidebar rows: "刚刚 / 5分钟 / 3小时 / 2天" within a
 * week. Older rows get no label: a column of identical dates is noise, and the
 * full timestamp stays in the session manager. Future timestamps (clock skew)
 * read as the most recent bucket; unparseable ones get no label.
 */
export function sessionTimeLabel(iso: string | undefined, now: number, locale: string): string {
	const time = iso ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(time)) return '';
	const t = (key: string, params?: { value: number }) => translate(key, params, locale as Locale);
	const elapsed = Math.max(0, now - time);
	if (elapsed < MINUTE) return t('sessionTime.now');
	if (elapsed < HOUR) { const value = Math.floor(elapsed / MINUTE); return t('sessionTime.minutes', { value }); }
	if (elapsed < DAY) { const value = Math.floor(elapsed / HOUR); return t('sessionTime.hours', { value }); }
	if (elapsed < 7 * DAY) { const value = Math.floor(elapsed / DAY); return t('sessionTime.days', { value }); }
	return '';
}
