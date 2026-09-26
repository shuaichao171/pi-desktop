import { BrowserWindow, Notification } from 'electron';
import type { AgentEventEnvelope } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { readDesktopSettings } from './desktopSettings';

export interface DesktopNotifierOptions {
	settingsPath: () => string;
	getMainWindow: () => BrowserWindow | null;
	/** Brings the conversation back on click (window is shown and focused first). */
	revealSession: (sessionPath: string) => void;
}

/**
 * OS notifications (4.1): fire only while the window is unfocused or hidden,
 * covering foreground turn completion/failure and finished automation runs.
 * Windows Focus Assist / system do-not-disturb suppress toasts natively.
 */
export function createDesktopNotifier(options: DesktopNotifierOptions) {
	let turnActive = false;
	let turnError: string | null = null;

	const english = (): boolean => getAppLocale() === 'en-US';

	const windowActive = (): boolean => {
		const win = options.getMainWindow();
		return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
	};

	const notify = (title: string, body: string, sessionPath: string | null): void => {
		if (!readDesktopSettings(options.settingsPath()).notificationsEnabled) return;
		if (!Notification.isSupported()) return;
		try {
			const notification = new Notification({ title, body: body.slice(0, 200), silent: false });
			notification.on('click', () => {
				const win = options.getMainWindow();
				if (win && !win.isDestroyed()) {
					win.show();
					win.focus();
				}
				if (sessionPath) options.revealSession(sessionPath);
			});
			notification.show();
		} catch (error) {
			console.error('Desktop notification failed:', error);
		}
	};

	return {
		/** Tracks foreground turns via the active session's status events. */
		handleAgentEvent(envelope: AgentEventEnvelope, activeSessionPath: string | null): void {
			const event = envelope.event;
			if (event.type === 'status') {
				if (event.status === 'busy') {
					turnActive = true;
					turnError = null;
				} else if ((event.status === 'idle' || event.status === 'error') && turnActive) {
					turnActive = false;
					if (!windowActive()) {
						if (event.status === 'error') {
							notify(english() ? 'Pi Desktop' : 'Pi Desktop', english() ? `Task failed: ${event.message ?? 'unknown error'}` : `任务失败：${event.message ?? '未知错误'}`, activeSessionPath);
						} else {
							notify(english() ? 'Pi Desktop' : 'Pi Desktop', english() ? 'Task finished' : '任务已完成', activeSessionPath);
						}
					}
				}
			} else if (event.type === 'assistant-end' && event.errorMessage && turnActive) {
				turnError = event.errorMessage;
			}
		},
		/** Notifies about finished automation runs (cancelled runs stay silent). */
		handleAutomationRun(entry: { status: string; summary: string; error: string | null; sessionPath: string | null }, taskName: string): void {
			if (entry.status !== 'succeeded' && entry.status !== 'failed') return;
			if (windowActive()) return;
			if (entry.status === 'failed') {
				notify(english() ? `Automation failed: ${taskName}` : `自动化任务失败：${taskName}`, entry.error ?? '', entry.sessionPath);
			} else {
				notify(english() ? `Automation finished: ${taskName}` : `自动化任务完成：${taskName}`, entry.summary ?? '', entry.sessionPath);
			}
		},
	};
}
