import { app, BrowserWindow } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS, type UiUpdateState, type UiUpdateUnavailableReason } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { isGitHubReleaseFeedUrl, parseUpdateFeedUrl } from './updateFeed';

type Updater = typeof import('electron-updater').autoUpdater;

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function configuredFeed(): { url: string | null; invalid: boolean } {
	let raw: unknown = process.env.PI_DESKTOP_UPDATE_URL;
	if (raw === undefined) {
		try {
			const data: unknown = JSON.parse(readFileSync(join(process.resourcesPath, 'update-config.json'), 'utf8'));
			raw = data && typeof data === 'object' && 'url' in data ? data.url : undefined;
		} catch {
			// Development builds and unconfigured packages have no update configuration.
		}
	}
	const url = parseUpdateFeedUrl(raw);
	return { url, invalid: raw !== undefined && raw !== '' && !url };
}

function runningAsAppImage(): boolean {
	if (!process.env.APPIMAGE) return false;
	try { return statSync(process.env.APPIMAGE).isFile(); }
	catch { return false; }
}

function unavailable(reason: UiUpdateUnavailableReason): UiUpdateState {
	return { phase: 'unavailable', unavailableReason: reason, currentVersion: app.getVersion() };
}

function initialState(): { state: UiUpdateState; feedUrl: string | null } {
	if (!app.isPackaged) return { state: unavailable('development'), feedUrl: null };
	if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
		return { state: unavailable('portable'), feedUrl: null };
	}
	if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
		return { state: unavailable('unsupported'), feedUrl: null };
	}
	// DEB/RPM installations are upgraded by their package manager. AppImage is self-contained.
	if (process.platform === 'linux' && !runningAsAppImage()) {
		return { state: unavailable('unsupported'), feedUrl: null };
	}
	const feed = configuredFeed();
	if (feed.invalid) return { state: unavailable('invalid-feed'), feedUrl: null };
	if (!feed.url) return { state: unavailable('unconfigured'), feedUrl: null };
	return { state: { phase: 'idle', currentVersion: app.getVersion() }, feedUrl: feed.url };
}

class UpdateService {
	private readonly feedUrl: string | null;
	private state: UiUpdateState;
	private updaterPromise: Promise<Updater> | null = null;
	private checkPromise: Promise<UiUpdateState> | null = null;
	private firstCheck: ReturnType<typeof setTimeout> | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private beforeInstall: (() => Promise<void>) | null = null;
	private installing = false;
	private servicesClosedForInstall = false;

	constructor() {
		const initial = initialState();
		this.state = initial.state;
		this.feedUrl = initial.feedUrl;
	}

	getState(): UiUpdateState { return { ...this.state }; }

	setBeforeInstall(callback: () => Promise<void>): void { this.beforeInstall = callback; }

	start(): void {
		if (!this.feedUrl || this.firstCheck || this.interval) return;
		// A slow updater import or network request must never delay splash or first paint.
		this.firstCheck = setTimeout(() => { this.firstCheck = null; void this.check(); }, FIRST_CHECK_DELAY_MS);
		this.interval = setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this.firstCheck) clearTimeout(this.firstCheck);
		if (this.interval) clearInterval(this.interval);
		this.firstCheck = null;
		this.interval = null;
	}

	private publish(patch: Partial<UiUpdateState>): void {
		this.state = { ...this.state, ...patch };
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC_CHANNELS.updateStateChanged, this.getState());
		}
	}

	private reportError(error: unknown): void {
		const missingReleaseManifest = this.feedUrl && isGitHubReleaseFeedUrl(this.feedUrl)
			&& error instanceof Error && 'code' in error && error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
		const message = missingReleaseManifest
			? getAppLocale() === 'en-US'
				? 'GitHub has not published an update for this installation type yet. Please try again later.'
				: 'GitHub 尚未发布适用于此安装方式的更新，请稍后重试。'
			: error instanceof Error ? error.message : String(error);
		const restartHint = this.installing && this.servicesClosedForInstall
			? getAppLocale() === 'en-US' ? ' Restart the app before retrying.' : ' 请重启应用后重试。'
			: '';
		if (this.installing) {
			this.installing = false;
			this.start();
		}
		this.publish({ phase: 'error', error: `${message.slice(0, 300 - restartHint.length)}${restartHint}` });
	}

	private async getUpdater(): Promise<Updater> {
		if (!this.feedUrl) throw new Error('Update source is not configured.');
		this.updaterPromise ??= import('electron-updater').then((module) => {
			// electron-updater is CommonJS and Electron Vite emits ESM for this project.
			const updater = module.default?.autoUpdater ?? module.autoUpdater;
			updater.setFeedURL({ provider: 'generic', url: this.feedUrl!,
				...(isGitHubReleaseFeedUrl(this.feedUrl!) ? { useMultipleRangeRequest: false } : {}),
			});
			updater.autoDownload = true;
			updater.autoInstallOnAppQuit = false;
			updater.allowDowngrade = false;
			updater.allowPrerelease = false;
			updater.on('checking-for-update', () => this.publish({ phase: 'checking', error: undefined, progressPercent: undefined }));
			updater.on('update-available', (info) => this.publish({ phase: 'downloading', availableVersion: info.version, progressPercent: 0 }));
			updater.on('download-progress', (progress) => this.publish({ phase: 'downloading', progressPercent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0 }));
			updater.on('update-not-available', () => this.publish({ phase: 'up-to-date', availableVersion: undefined, progressPercent: undefined }));
			updater.on('update-downloaded', (info) => this.publish({ phase: 'ready', availableVersion: info.version, progressPercent: 100 }));
			// Installers can report failure through this event without throwing from quitAndInstall.
			updater.on('error', (error) => this.reportError(error));
			return updater;
		}).catch((error: unknown) => {
			this.updaterPromise = null;
			throw error;
		});
		return this.updaterPromise;
	}

	async check(): Promise<UiUpdateState> {
		if (!this.feedUrl || this.installing || this.state.phase === 'ready' || this.state.phase === 'downloading') return this.getState();
		if (this.checkPromise) return this.checkPromise;
		this.checkPromise = (async () => {
			this.publish({ phase: 'checking', error: undefined, progressPercent: undefined });
			try {
				const updater = await this.getUpdater();
				const result = await updater.checkForUpdates();
				// Metadata checking resolves before the automatic download. Its separate promise
				// still rejects after the updater emits "error", so it needs its own handler.
				void result?.downloadPromise?.catch((error: unknown) => this.reportError(error));
			} catch (error) {
				this.reportError(error);
			} finally {
				this.checkPromise = null;
			}
			return this.getState();
		})();
		return this.checkPromise;
	}

	async install(): Promise<void> {
		if (this.state.phase !== 'ready' || this.installing) throw new Error('No downloaded update is ready to install.');
		if (!this.beforeInstall) throw new Error('Update installation is unavailable.');
		this.installing = true;
		this.servicesClosedForInstall = false;
		try {
			const updater = await this.getUpdater();
			// Shutdown may partially succeed before rejecting; either case requires a restart.
			this.servicesClosedForInstall = true;
			await this.beforeInstall();
			this.stop();
			updater.quitAndInstall(false, true);
			if (!this.installing) throw new Error(this.state.error || 'Update installation failed.');
		} catch (error) {
			// An emitted error has already released the lock and published its restart hint.
			if (this.installing) this.reportError(error);
			throw error;
		}
	}
}

export const updateService = new UpdateService();
