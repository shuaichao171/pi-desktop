import { dialog } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isConversationStorageDirectory } from './conversationStorage';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile, writeStateFileAsync } from './stateFiles';
import { isValidPiEngineSelection } from './piEngine';
import type { UiPiEngineSelection } from '@pidesktop/shared';

export interface DesktopSettings {
	/** OS notifications for background/automation completion while the window is unfocused or hidden (4.1). */
	notificationsEnabled: boolean;
	/** What the window close button does on Windows: hide to tray (default) or quit (4.2). */
	closeBehavior: 'tray' | 'quit';
	/** Parent folder used only for newly created standalone conversations. */
	conversationStorageDirectory: string;
	/** Which Pi SDK drives the agent host: bundled or a user-managed install (restart to apply). */
	piEngine: UiPiEngineSelection;
	/** Loopback AI debug endpoint; defaults when absent from stored settings. */
	debugApi?: DesktopDebugApiSettings;
}

/** Loopback AI debug endpoint preferences (see debugServer.ts). */
export interface DesktopDebugApiSettings {
	enabled: boolean;
	port: number;
	authEnabled: boolean;
	token: string;
}

export const DEFAULT_DEBUG_API_SETTINGS: DesktopDebugApiSettings = {
	enabled: false,
	port: 47899,
	authEnabled: false,
	token: '',
};

export function isValidDesktopDebugApiSettings(value: unknown): value is DesktopDebugApiSettings {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<DesktopDebugApiSettings>;
	return typeof candidate.enabled === 'boolean'
		&& typeof candidate.authEnabled === 'boolean'
		&& typeof candidate.token === 'string' && candidate.token.length <= 200 && !/[\u0000-\u001f\u007f]/.test(candidate.token)
		&& typeof candidate.port === 'number' && Number.isInteger(candidate.port) && candidate.port >= 1 && candidate.port <= 65535;
}

export function isValidDesktopSettings(value: unknown): value is DesktopSettings {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<DesktopSettings>;
	return typeof candidate.notificationsEnabled === 'boolean'
		&& (candidate.closeBehavior === 'tray' || candidate.closeBehavior === 'quit')
		&& (candidate.conversationStorageDirectory === undefined || isConversationStorageDirectory(candidate.conversationStorageDirectory))
		&& (candidate.piEngine === undefined || isValidPiEngineSelection(candidate.piEngine))
		&& (candidate.debugApi === undefined || isValidDesktopDebugApiSettings(candidate.debugApi));
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
	notificationsEnabled: true, closeBehavior: 'tray', conversationStorageDirectory: join(homedir(), 'PiDesktopWorkspace'),
	piEngine: { mode: 'builtin' },
	debugApi: DEFAULT_DEBUG_API_SETTINGS,
};

/** Reads desktop-level preferences; corrupt or missing files fall back to defaults (4.1/4.2). */
export function readDesktopSettings(path: string, defaultStorageDirectory = DEFAULT_DESKTOP_SETTINGS.conversationStorageDirectory): DesktopSettings {
	const defaults = { ...DEFAULT_DESKTOP_SETTINGS, conversationStorageDirectory: defaultStorageDirectory, debugApi: DEFAULT_DEBUG_API_SETTINGS };
	try {
		const stored = readStateFile(path, () => defaults, isValidDesktopSettings);
		return { ...defaults, ...stored, debugApi: stored.debugApi ?? DEFAULT_DEBUG_API_SETTINGS };
	} catch (error) {
		if (!(error instanceof CorruptStateFileError)) throw error;
		// Do not allow a later settings write to overwrite bytes we could not preserve.
		const backup = backupCorruptStateFile(path);
		dialog.showErrorBox('Pi Desktop 桌面设置已恢复 / Desktop settings recovered',
			`损坏的桌面设置已备份到 / Damaged settings were saved to:\n${backup}`);
		return defaults;
	}
}

export function writeDesktopSettings(path: string, settings: DesktopSettings): void {
	writeStateFile(path, settings);
}

export function writeDesktopSettingsAsync(path: string, settings: DesktopSettings): Promise<void> {
	return writeStateFileAsync(path, settings);
}
