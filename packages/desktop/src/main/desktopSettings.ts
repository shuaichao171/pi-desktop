import { dialog } from 'electron';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile, writeStateFileAsync } from './stateFiles';

export interface DesktopSettings {
	/** OS notifications for background/automation completion while the window is unfocused or hidden (4.1). */
	notificationsEnabled: boolean;
	/** What the window close button does on Windows: hide to tray (default) or quit (4.2). */
	closeBehavior: 'tray' | 'quit';
}

export function isValidDesktopSettings(value: unknown): value is DesktopSettings {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<DesktopSettings>;
	return typeof candidate.notificationsEnabled === 'boolean'
		&& (candidate.closeBehavior === 'tray' || candidate.closeBehavior === 'quit');
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = { notificationsEnabled: true, closeBehavior: 'tray' };

/** Reads desktop-level preferences; corrupt or missing files fall back to defaults (4.1/4.2). */
export function readDesktopSettings(path: string): DesktopSettings {
	try {
		return readStateFile(path, () => ({ ...DEFAULT_DESKTOP_SETTINGS }), isValidDesktopSettings);
	} catch (error) {
		if (!(error instanceof CorruptStateFileError)) throw error;
		// Do not allow a later settings write to overwrite bytes we could not preserve.
		const backup = backupCorruptStateFile(path);
		dialog.showErrorBox('Pi Desktop 桌面设置已恢复 / Desktop settings recovered',
			`损坏的桌面设置已备份到 / Damaged settings were saved to:\n${backup}`);
		return { ...DEFAULT_DESKTOP_SETTINGS };
	}
}

export function writeDesktopSettings(path: string, settings: DesktopSettings): void {
	writeStateFile(path, settings);
}

export function writeDesktopSettingsAsync(path: string, settings: DesktopSettings): Promise<void> {
	return writeStateFileAsync(path, settings);
}
