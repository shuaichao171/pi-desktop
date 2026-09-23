import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppLocale } from '@pidesktop/shared';

let cachedLocale: AppLocale | null = null;

function localePath(): string {
	return join(app.getPath('userData'), 'locale.json');
}

export function getAppLocale(): AppLocale {
	if (cachedLocale) return cachedLocale;
	try {
		const value = JSON.parse(readFileSync(localePath(), 'utf8')) as { locale?: unknown };
		cachedLocale = value.locale === 'en-US' ? 'en-US' : 'zh-CN';
	} catch {
		cachedLocale = 'zh-CN';
	}
	return cachedLocale;
}

export function setAppLocale(locale: AppLocale): void {
	if (locale !== 'zh-CN' && locale !== 'en-US') throw new Error('Invalid application locale');
	cachedLocale = locale;
	mkdirSync(app.getPath('userData'), { recursive: true });
	writeFileSync(localePath(), JSON.stringify({ locale }), 'utf8');
}
