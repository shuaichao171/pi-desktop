/**
 * One date vocabulary for the whole app: "10月9日" / "Oct 9", plus "16:30" when a
 * time matters. The year appears only when it differs from the current one (or
 * when `year: 'always'` asks for an unambiguous tooltip). Times use a 24-hour
 * clock in both languages so lists line up. Invalid input yields ''.
 */
export interface DateFormatOptions {
	time?: boolean;
	seconds?: boolean;
	year?: 'auto' | 'always';
	timeZone?: string;
	now?: number;
}

export function formatDate(value: string | number | Date | null | undefined, locale: string, options: DateFormatOptions = {}): string {
	if (value === null || value === undefined || value === '') return '';
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const zh = locale === 'zh-CN';
	try {
		const yearOf = (target: Date) => Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: options.timeZone }).format(target));
		const showYear = options.year === 'always' || yearOf(date) !== yearOf(new Date(options.now ?? Date.now()));
		return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
			year: showYear ? 'numeric' : undefined,
			month: zh ? 'long' : 'short',
			day: 'numeric',
			...(options.time ? { hour: '2-digit', minute: '2-digit', second: options.seconds ? '2-digit' : undefined, hourCycle: 'h23' } as const : {}),
			timeZone: options.timeZone,
		}).format(date);
	} catch {
		// An unknown time zone falls back to the local zone rather than hiding the date.
		return options.timeZone ? formatDate(date, locale, { ...options, timeZone: undefined }) : '';
	}
}
