import type { UiAutomationSchedule } from '@pidesktop/shared';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let value = formatters.get(timeZone);
	if (!value) {
		value = new Intl.DateTimeFormat('en-CA', {
			timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
			hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
		});
		// Bound the cache even if renderer input contains many valid aliases.
		if (formatters.size >= 128) formatters.clear();
		formatters.set(timeZone, value);
	}
	return value;
}

export function validateAutomationTimeZone(value: unknown): string {
	if (typeof value !== 'string' || value.length > 128 || !value.trim()) throw new Error('请选择有效的时区');
	try { formatter(value).format(0); }
	catch { throw new Error('请选择有效的时区'); }
	return value;
}

function localParts(timestamp: number, timeZone: string): number[] {
	const parts = formatter(timeZone).formatToParts(timestamp);
	return ['year', 'month', 'day', 'hour', 'minute'].map((type) => Number(parts.find((part) => part.type === type)!.value));
}

function localTimestamp(parts: number[]): number {
	return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0);
}

/** Resolve the first occurrence of a local minute; nonexistent DST minutes are skipped. */
function resolveLocalMinute(parts: number[], timeZone: string): number | null {
	const naive = localTimestamp(parts);
	const offsets = new Set<number>();
	// Sampling both sides also handles half-hour and date-line offset transitions.
	for (let hours = -36; hours <= 36; hours += 12) {
		const sample = naive + hours * 60 * MINUTE;
		offsets.add(localTimestamp(localParts(sample, timeZone)) - sample);
	}
	const candidates = [...offsets].map((offset) => naive - offset)
		.filter((candidate) => localParts(candidate, timeZone).every((part, index) => part === parts[index]));
	return candidates.length ? Math.min(...candidates) : null;
}

export function validateAutomationSchedule(value: unknown): UiAutomationSchedule {
	if (!value || typeof value !== 'object') throw new Error('请选择有效的执行频率');
	const schedule = value as Record<string, unknown>;
	if (schedule.kind === 'interval') {
		if (!Number.isInteger(schedule.minutes) || (schedule.minutes as number) < 5 || (schedule.minutes as number) > 43_200) {
			throw new Error('执行间隔必须为 5 分钟至 30 天的整数分钟');
		}
		return { kind: 'interval', minutes: schedule.minutes as number };
	}
	if (schedule.kind === 'weekly') {
		if (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.length > 7
			|| schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
			|| new Set(schedule.days).size !== schedule.days.length
			|| typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
			throw new Error('请选择有效的星期和执行时间');
		}
		return { kind: 'weekly', days: [...schedule.days].sort((a, b) => a - b), time: schedule.time };
	}
	if (schedule.kind === 'once') {
		if (typeof schedule.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(schedule.at)) {
			throw new Error('请选择有效的执行日期');
		}
		const at = Date.parse(schedule.at);
		const [year, month, day, hour, minute, second = 0] = schedule.at.match(/^\d{4}|\d{2}/g)!.slice(0, 6).map(Number);
		const calendarDate = new Date(Date.UTC(year, month - 1, day));
		if (!Number.isFinite(at) || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
			|| calendarDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new Error('请选择有效的执行日期');
		return { kind: 'once', at: new Date(at).toISOString() };
	}
	throw new Error('请选择有效的执行频率');
}

/** Return a strictly future occurrence. Repeated DST clock times execute only once. */
export function nextAutomationRun(schedule: UiAutomationSchedule, timeZone: string, after: number): string | null {
	if (!Number.isFinite(after)) throw new Error('无效的调度时间');
	if (schedule.kind === 'interval') return new Date(after + schedule.minutes * MINUTE).toISOString();
	if (schedule.kind === 'once') return Date.parse(schedule.at) > after ? schedule.at : null;
	const current = localParts(after, timeZone);
	const [hour, minute] = schedule.time.split(':').map(Number);
	const dayStart = Date.UTC(current[0], current[1] - 1, current[2]);
	for (let offset = 0; offset <= 14; offset++) {
		const date = new Date(dayStart + offset * DAY);
		if (!schedule.days.includes(date.getUTCDay())) continue;
		const candidate = resolveLocalMinute([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute], timeZone);
		if (candidate !== null && candidate > after) return new Date(candidate).toISOString();
	}
	throw new Error('无法计算下次执行时间');
}
