import type { Locale } from './i18n';

export type IntervalUnit = 'minutes' | 'hours' | 'days';

export const INTERVAL_UNIT_FACTOR: Record<IntervalUnit, number> = {
	minutes: 1,
	hours: 60,
	days: 1440,
};

export const INTERVAL_PRESETS: readonly { minutes: number; value: number; unit: IntervalUnit }[] = [
	{ minutes: 30, value: 30, unit: 'minutes' },
	{ minutes: 60, value: 1, unit: 'hours' },
	{ minutes: 240, value: 4, unit: 'hours' },
	{ minutes: 720, value: 12, unit: 'hours' },
	{ minutes: 1440, value: 1, unit: 'days' },
];

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 43_200;

/** 把总分钟数拆为最自然的展示单位（整天→天，整小时→小时，其余→分钟）。 */
export function splitIntervalMinutes(minutes: number): { value: number; unit: IntervalUnit } {
	if (Number.isInteger(minutes) && minutes >= 1440 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
	if (Number.isInteger(minutes) && minutes >= 60 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
	return { value: minutes, unit: 'minutes' };
}

/** 将表单中的数值与单位换算为受限的整数分钟（5 ~ 43200）；非法输入返回 null。 */
export function toIntervalMinutes(value: string | number, unit: IntervalUnit): number | null {
	const text = typeof value === 'number' ? String(value) : value.trim();
	if (!text) return null;
	const numeric = Number(text);
	if (!Number.isInteger(numeric) || numeric <= 0) return null;
	const minutes = numeric * INTERVAL_UNIT_FACTOR[unit];
	return Number.isInteger(minutes) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES ? minutes : null;
}

/** 格式化单次运行的耗时；未完成或时间异常返回 null。 */
export function formatRunDuration(startedAt: string, finishedAt: string | null, locale: Locale): string | null {
	if (!finishedAt) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	const totalSeconds = Math.round((end - start) / 1000);
	const zh = locale === 'zh-CN';
	if (totalSeconds < 1) return zh ? '<1 秒' : '<1s';
	if (totalSeconds < 60) return zh ? `${totalSeconds} 秒` : `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		if (seconds === 0) return zh ? `${totalMinutes} 分钟` : `${totalMinutes}m`;
		return zh ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes}m ${seconds}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (minutes === 0) return zh ? `${hours} 小时` : `${hours}h`;
	return zh ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`;
}

const FALLBACK_TIME_ZONES = [
	'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Seoul',
	'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
	'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Australia/Sydney',
];

let cachedTimeZones: string[] | null = null;

/** 返回浏览器支持的 IANA 时区列表，供时区输入框 datalist 自动补全。 */
export function supportedTimeZones(): string[] {
	if (cachedTimeZones) return cachedTimeZones;
	try {
		const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
		const list = supportedValuesOf?.('timeZone');
		cachedTimeZones = list?.length ? list : FALLBACK_TIME_ZONES;
	} catch {
		cachedTimeZones = FALLBACK_TIME_ZONES;
	}
	return cachedTimeZones;
}
