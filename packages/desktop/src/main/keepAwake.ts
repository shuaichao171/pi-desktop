import { powerSaveBlocker } from 'electron';
import { readDesktopSettings, type DesktopSettings } from './desktopSettings';

/**
 * keep-awake (zcode keepAwakeWhileRunning): while the preference is on AND a
 * foreground task or automation run is active, the main process holds a
 * powerSaveBlocker("prevent-app-suspension") so idle sleep cannot interrupt
 * the run. It never blocks manual sleep or lid close. Blocking is derived from
 * two independent sources (agent status, automation runs); the settings file
 * is re-read on every reconcile so external writes apply immediately.
 */

export interface KeepAwakeControllerOptions {
	settingsPath: () => string;
	defaultStorageDirectory?: string;
	/** Injectable for tests; defaults to Electron's powerSaveBlocker. */
	startBlocker?: () => number;
	stopBlocker?: (id: number) => void;
	log?: (message: string) => void;
}

export interface KeepAwakeController {
	setAgentBusy(active: boolean): void;
	setAutomationActive(active: boolean): void;
	/** Re-reads the settings file and reconciles the blocker. */
	settingsChanged(): void;
	isBlocking(): boolean;
	dispose(): void;
}

export function createKeepAwakeController(options: KeepAwakeControllerOptions): KeepAwakeController {
	const startBlocker = options.startBlocker ?? (() => powerSaveBlocker.start('prevent-app-suspension'));
	const stopBlocker = options.stopBlocker ?? ((id: number) => powerSaveBlocker.stop(id));
	const log = options.log ?? ((message: string) => console.log(message));
	let agentBusy = false;
	let automationActive = false;
	let blockerId: number | null = null;

	const readPreference = (): boolean => {
		try {
			const settings: DesktopSettings = readDesktopSettings(options.settingsPath(), options.defaultStorageDirectory);
			return settings.keepAwakeWhileRunning === true;
		} catch {
			// Unreadable settings must never wedge a started blocker.
			return false;
		}
	};

	const reconcile = (): void => {
		const shouldBlock = readPreference() && (agentBusy || automationActive);
		if (shouldBlock && blockerId === null) {
			blockerId = startBlocker();
			log(`[keep-awake] powerSaveBlocker started id=${blockerId}`);
		} else if (!shouldBlock && blockerId !== null) {
			const stopped = blockerId;
			blockerId = null;
			try {
				stopBlocker(stopped);
			} catch {
				// The id may already be invalid after a system sleep/wake cycle.
			}
			log(`[keep-awake] powerSaveBlocker stopped id=${stopped}`);
		}
	};

	return {
		setAgentBusy(active: boolean): void {
			if (agentBusy === active) return;
			agentBusy = active;
			reconcile();
		},
		setAutomationActive(active: boolean): void {
			if (automationActive === active) return;
			automationActive = active;
			reconcile();
		},
		settingsChanged(): void {
			reconcile();
		},
		isBlocking(): boolean {
			return blockerId !== null;
		},
		dispose(): void {
			agentBusy = false;
			automationActive = false;
			reconcile();
		},
	};
}
