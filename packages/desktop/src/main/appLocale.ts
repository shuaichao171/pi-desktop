import { app, dialog } from 'electron';
import { join } from 'node:path';
import type { AppLocale } from '@pidesktop/shared';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile } from './stateFiles';

let cachedLocale: AppLocale | null = null;
let localeRecoveryFailed = false;

function localePath(): string {
	return join(app.getPath('userData'), 'locale.json');
}

export function getAppLocale(): AppLocale {
	if (cachedLocale) return cachedLocale;
	try {
		const value = readStateFile(localePath(), () => ({ locale: 'zh-CN' as const }),
			(input): input is { locale: AppLocale } => typeof input === 'object' && input !== null && 'locale' in input
				&& (input.locale === 'en-US' || input.locale === 'zh-CN'));
		cachedLocale = value.locale;
	} catch (error) {
		if (error instanceof CorruptStateFileError) {
			try {
				const backup = backupCorruptStateFile(localePath());
				dialog.showErrorBox('Pi Desktop 语言设置已恢复 / Language settings recovered',
					`损坏的语言设置已备份到 / Damaged settings were saved to:\n${backup}`);
			} catch (backupError) {
				localeRecoveryFailed = true;
				console.error('Failed to back up the damaged locale file:', backupError);
			}
		} else {
			localeRecoveryFailed = true;
			console.error('Failed to read application locale; preserving the saved file:', error);
		}
		cachedLocale = 'zh-CN';
	}
	return cachedLocale;
}

export function setAppLocale(locale: AppLocale): void {
	if (locale !== 'zh-CN' && locale !== 'en-US') throw new Error('Invalid application locale');
	if (localeRecoveryFailed) throw new Error('语言设置文件无法备份，请先手动检查 locale.json');
	writeStateFile(localePath(), { locale });
	cachedLocale = locale;
}
