import type { Translate } from './i18n';

export type SettingsPage = 'general' | 'conversation' | 'notifications' | 'appearance' | 'personalization' | 'model' | 'backup' | 'debug' | 'engine' | 'shortcuts' | 'updates' | 'sessions' | 'mcp' | 'agents';

export const SETTINGS_PAGE_LABELS: Record<SettingsPage, string> = {
	general: 'settings.general', conversation: 'settings.conversation', notifications: 'settings.notificationsPage', appearance: 'settings.appearance', personalization: 'settings.personalization',
	model: 'settings.modelManagement', backup: 'settings.cloudBackup', debug: 'settings.debugApi',
	engine: 'settings.engine', shortcuts: 'settings.shortcuts', updates: 'settings.updates', sessions: 'settings.sessions', mcp: 'MCP', agents: 'agents.title',
};

type SearchEntry = {
	page: SettingsPage;
	labelKey: string;
	descriptionKey?: string;
	selector?: string;
	windowsOnly?: boolean;
	desktopSettings?: boolean;
};

// Index labels explicitly instead of mounting inactive pages and their editors.
const SETTINGS_SEARCH_ENTRIES: SearchEntry[] = [
	{ page: 'general', labelKey: 'settings.language', descriptionKey: 'settings.languageDescription', selector: '[data-setting="language"]' },
	{ page: 'general', labelKey: 'settings.conversationStorage', descriptionKey: 'settings.conversationStorageDescription', selector: '[data-setting="conversation-storage"]' },
	{ page: 'conversation', labelKey: 'settings.busyInputBehavior', descriptionKey: 'settings.busyInputBehaviorDescription', selector: '[data-setting="busy-input-behavior"]' },
	{ page: 'conversation', labelKey: 'settings.showReasoning', descriptionKey: 'settings.showReasoningDescription', selector: '[data-setting="show-reasoning"]' },
	{ page: 'conversation', labelKey: 'settings.projectAutoAssign', descriptionKey: 'settings.projectAutoAssignDescription', selector: '[data-setting="project-auto-assign"]' },
	{ page: 'conversation', labelKey: 'settings.nextSuggestion', descriptionKey: 'settings.nextSuggestionDescription', selector: '[data-setting="next-suggestion"]' },
	{ page: 'conversation', labelKey: 'settings.nextSuggestionModel', descriptionKey: 'settings.nextSuggestionModelDescription', selector: '[data-setting="next-suggestion-model"]' },
	{ page: 'conversation', labelKey: 'settings.questionAutoResolution', descriptionKey: 'settings.questionAutoResolutionDescription', selector: '[data-setting="question-auto-resolution"]' },
	{ page: 'conversation', labelKey: 'settings.conversationMetrics', descriptionKey: 'settings.conversationMetricsDescription', selector: '.pd-metrics-settings' },
	{ page: 'notifications', labelKey: 'settings.extensionNotices', descriptionKey: 'settings.extensionNoticesDescription', selector: '[data-setting="extension-notices"]' },
	{ page: 'notifications', labelKey: 'settings.notifications', descriptionKey: 'settings.notificationsDescription', selector: '[data-setting="notifications"]' },
	{ page: 'notifications', labelKey: 'settings.notificationSound', descriptionKey: 'settings.notificationSoundDescription', selector: '[data-setting="notification-sound"]' },
	{ page: 'notifications', labelKey: 'settings.operationNoticeTimeout', descriptionKey: 'settings.operationNoticeTimeoutDescription', selector: '[data-setting="operation-notice-timeout"]' },
	{ page: 'general', labelKey: 'settings.closeBehavior', descriptionKey: 'settings.closeBehaviorDescription', selector: '[data-setting="tray"]', windowsOnly: true, desktopSettings: true },
	{ page: 'general', labelKey: 'settings.keepAwake', descriptionKey: 'settings.keepAwakeDescription', selector: '[data-setting="keep-awake"]', desktopSettings: true },
	{ page: 'appearance', labelKey: 'settings.themeLabel', descriptionKey: 'settings.appearanceDescription', selector: '.pd-appearance-options' },
	{ page: 'appearance', labelKey: 'settings.uiFontSize', descriptionKey: 'settings.uiFontSizeDescription', selector: '[data-setting="font"]' },
	{ page: 'appearance', labelKey: 'settings.codeFontSize', selector: '[data-setting="code-font"]' },
	{ page: 'appearance', labelKey: 'settings.commandFontSize', selector: '[data-setting="command-font"]' },
	{ page: 'appearance', labelKey: 'settings.monoFontFamily', descriptionKey: 'settings.monoFontFamilyDescription', selector: '[data-setting="mono-font-family"]' },
	{ page: 'appearance', labelKey: 'settings.sansFontFamily', descriptionKey: 'settings.sansFontFamilyDescription', selector: '[data-setting="sans-font-family"]' },
	{ page: 'appearance', labelKey: 'settings.color.title', descriptionKey: 'settings.color.description', selector: '.pd-theme-colors' },
	{ page: 'personalization', labelKey: 'personalization.instructions', descriptionKey: 'personalization.description' },
	{ page: 'model', labelKey: 'settings.apiKey', descriptionKey: 'settings.modelManagementHint' },
	{ page: 'backup', labelKey: 'settings.cloudBackup', descriptionKey: 'settings.cloudBackupDescription' },
	{ page: 'debug', labelKey: 'settings.debugApi', descriptionKey: 'settings.debugApiDescription' },
	{ page: 'engine', labelKey: 'settings.engineMode', descriptionKey: 'settings.engineModeDescription', selector: '[data-setting="engine-mode"]' },
	{ page: 'engine', labelKey: 'settings.enginePath', descriptionKey: 'settings.enginePathDescription' },
	{ page: 'shortcuts', labelKey: 'settings.shortcuts', descriptionKey: 'settings.shortcutsDescription' },
	{ page: 'updates', labelKey: 'settings.autoInstallUpdates', descriptionKey: 'settings.autoInstallUpdatesDescription', selector: '[data-setting="auto-install-updates"]', desktopSettings: true },
	{ page: 'mcp', labelKey: 'mcp.addServer', descriptionKey: 'mcp.description' },
	{ page: 'agents', labelKey: 'agents.add', descriptionKey: 'agents.description' },
];

export type SettingsSearchResult = { page: SettingsPage; title: string; category: string; selector?: string };

export function searchSettings(query: string, t: Translate, pages: SettingsPage[], options: { paiMode: boolean; windows: boolean; desktopSettings: boolean }): SettingsSearchResult[] {
	const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
	const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
	if (!terms.length) return [];
	const results: SettingsSearchResult[] = [];
	for (const page of pages) {
		const category = t(SETTINGS_PAGE_LABELS[page]);
		const entries: SearchEntry[] = [{ page, labelKey: SETTINGS_PAGE_LABELS[page] }, ...SETTINGS_SEARCH_ENTRIES.filter(entry => entry.page === page)];
		for (const entry of entries) {
			if ((entry.windowsOnly && (!options.windows || options.paiMode)) || (entry.desktopSettings && !options.desktopSettings)) continue;
			const title = t(entry.labelKey);
			const haystack = normalize(`${category} ${title} ${entry.descriptionKey ? t(entry.descriptionKey) : ''}`);
			if (!terms.every(term => haystack.includes(term))) continue;
			if (results.some(result => result.page === page && result.title === title)) continue;
			results.push({ page, title, category, selector: entry.selector });
		}
	}
	return results;
}
