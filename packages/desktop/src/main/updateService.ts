import { app, BrowserWindow, net } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS, type UiUpdateState, type UiUpdateUnavailableReason } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { isGitHubReleaseFeedUrl, parseUpdateFeedUrl } from './updateFeed';

type Updater = typeof import('electron-updater').autoUpdater;

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

interface CheckAttempt { failed: boolean }

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
	private checkAttempt: CheckAttempt | null = null;
	private notesVersion: string | null = null;
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
		if (!this.feedUrl || this.servicesClosedForInstall || this.firstCheck || this.interval) return;
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

	private errorMessage(error: unknown): string {
		const missingReleaseManifest = this.feedUrl && isGitHubReleaseFeedUrl(this.feedUrl)
			&& error instanceof Error && 'code' in error && error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
		return missingReleaseManifest
			? getAppLocale() === 'en-US'
				? 'GitHub has not published an update for this installation type yet. Please try again later.'
				: 'GitHub 尚未发布适用于此安装方式的更新，请稍后重试。'
			: error instanceof Error ? error.message : String(error);
	}

	private reportCheckError(error: unknown, attempt: CheckAttempt | null): void {
		// The updater emits an error and rejects a promise for the same failure.
		// A late rejection from an old download must not cancel a newly requested retry.
		if (this.installing || this.servicesClosedForInstall || attempt !== this.checkAttempt || attempt?.failed) return;
		if (attempt) attempt.failed = true;
		this.publish({ phase: 'error', error: this.errorMessage(error).slice(0, 300), installRequested: false });
	}

	private reportInstallError(error: unknown): void {
		if (!this.installing) return;
		const restartHint = this.servicesClosedForInstall
			? getAppLocale() === 'en-US' ? ' Restart the app before retrying.' : ' 请重启应用后重试。'
			: '';
		this.installing = false;
		this.publish({ phase: 'error', error: `${this.errorMessage(error).slice(0, 300 - restartHint.length)}${restartHint}`, installRequested: false });
		// Closing services may have only partially succeeded. Keep this process inert
		// until restart instead of starting another check or closing services twice.
		if (this.servicesClosedForInstall) this.stop();
	}

	private acceptsUpdateEvents(): boolean {
		return !this.installing && !this.servicesClosedForInstall && !this.checkAttempt?.failed;
	}

	/** Best-effort changelog for the hover hint; GitHub feeds publish it as the release body. */
	private async fetchReleaseNotes(version: string): Promise<void> {
		if (!this.feedUrl || !isGitHubReleaseFeedUrl(this.feedUrl) || this.notesVersion === version) return;
		this.notesVersion = version;
		const feed = this.feedUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//);
		if (!feed) return;
		try {
			const response = await net.fetch(`https://api.github.com/repos/${feed[1]}/${feed[2]}/releases/tags/v${encodeURIComponent(version)}`, {
				headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-desktop-update-check' },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return;
			const data: unknown = JSON.parse(await response.text());
			if (!data || typeof data !== 'object') return;
			const release = data as { body?: unknown; published_at?: unknown };
			const notes = typeof release.body === 'string' ? release.body.replace(/\0/g, '').slice(0, 20_000) : undefined;
			if (!notes || this.state.availableVersion !== version) return;
			const date = typeof release.published_at === 'string' ? release.published_at : undefined;
			this.publish({ releaseNotes: notes, ...(date ? { releaseDate: date } : {}) });
		} catch {
			// Notes are optional decoration; update flows continue without them.
		}
	}

	/** Downloads the previously found update (never automatic — user consent required). */
	private async startDownload(): Promise<void> {
		const attempt = this.checkAttempt;
		this.publish({ phase: 'downloading', progressPercent: 0, error: undefined });
		try {
			const updater = await this.getUpdater();
			await updater.downloadUpdate();
		} catch (error) {
			// 同一次失败可能先触发 error 事件、稍后才拒绝 Promise；旧下载不能取消已经开始的新重试。
			this.reportCheckError(error, attempt);
		}
	}

	private async getUpdater(): Promise<Updater> {
		if (!this.feedUrl) throw new Error('Update source is not configured.');
		this.updaterPromise ??= import('electron-updater').then((module) => {
			// electron-updater is CommonJS and Electron Vite emits ESM for this project.
			const updater = module.default?.autoUpdater ?? module.autoUpdater;
			updater.setFeedURL({ provider: 'generic', url: this.feedUrl!,
				...(isGitHubReleaseFeedUrl(this.feedUrl!) ? { useMultipleRangeRequest: false } : {}),
			});
			// Updates are never fetched silently: the state only records availability
			// (plus release notes) and the download starts when the user consents.
			updater.autoDownload = false;
			updater.autoInstallOnAppQuit = false;
			updater.allowDowngrade = false;
			updater.allowPrerelease = false;
			updater.on('checking-for-update', () => {
				if (this.acceptsUpdateEvents() && this.state.phase === 'checking') this.publish({ error: undefined, progressPercent: undefined });
			});
			updater.on('update-available', (info) => {
				if (this.acceptsUpdateEvents() && ['checking', 'available', 'downloading'].includes(this.state.phase)) {
					// downloadUpdate() re-emits this event mid-download; keep that phase.
					if (this.state.phase !== 'downloading') this.publish({ phase: 'available', availableVersion: info.version, progressPercent: undefined });
					else this.publish({ availableVersion: info.version });
					void this.fetchReleaseNotes(info.version);
				}
			});
			updater.on('download-progress', (progress) => {
				if (this.acceptsUpdateEvents() && this.state.phase === 'downloading') {
					this.publish({ progressPercent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0 });
				}
			});
			updater.on('update-not-available', () => {
				if (this.acceptsUpdateEvents() && this.state.phase === 'checking') {
					this.publish({ phase: 'up-to-date', availableVersion: undefined, progressPercent: undefined, installRequested: false, error: undefined, releaseNotes: undefined, releaseDate: undefined });
				}
			});
			updater.on('update-downloaded', (info) => {
				if (!this.acceptsUpdateEvents() || !['checking', 'downloading'].includes(this.state.phase)) return;
				this.publish({ phase: 'ready', availableVersion: info.version, progressPercent: 100, error: undefined });
				if (this.state.installRequested) void this.installReadyUpdate().catch(() => { /* Error state is published by installation. */ });
			});
			// Installers can report failure through this event without throwing from quitAndInstall.
			updater.on('error', (error) => {
				if (this.installing) this.reportInstallError(error);
				else this.reportCheckError(error, this.checkAttempt);
			});
			return updater;
		}).catch((error: unknown) => {
			this.updaterPromise = null;
			throw error;
		});
		return this.updaterPromise;
	}

	async check(autoInstall = false): Promise<UiUpdateState> {
		if (!this.feedUrl || this.installing || this.servicesClosedForInstall || this.state.phase === 'ready' || this.state.phase === 'downloading') return this.getState();
		if (this.checkPromise) return this.checkPromise;
		const attempt: CheckAttempt = { failed: false };
		this.checkAttempt = attempt;
		this.checkPromise = (async () => {
			this.publish({ phase: 'checking', error: undefined, progressPercent: undefined, ...(autoInstall ? { installRequested: true } : {}) });
			try {
				const updater = await this.getUpdater();
				const result = await updater.checkForUpdates();
				// Metadata checking resolves before the automatic download. Its separate promise
				// still rejects after the updater emits "error", so it needs its own handler.
				void result?.downloadPromise?.catch((error: unknown) => this.reportCheckError(error, attempt));
				// With autoDownload off, a check with an explicit installation request
				// must chain into the download itself.
				if (!attempt.failed && attempt === this.checkAttempt && this.state.installRequested && this.state.phase === 'available') {
					await this.startDownload();
				}
			} catch (error) {
				this.reportCheckError(error, attempt);
			} finally {
				this.checkPromise = null;
			}
			return this.getState();
		})();
		return this.checkPromise;
	}

	async install(): Promise<void> {
		if (this.installing || this.state.installRequested) return;
		if (this.servicesClosedForInstall) throw new Error(this.state.error || 'Restart the app before retrying.');
		if (!this.beforeInstall) throw new Error('Update installation is unavailable.');
		const phase = this.state.phase;
		if (phase !== 'ready' && phase !== 'downloading' && phase !== 'available' && !(['checking', 'error'].includes(phase) && this.state.availableVersion)) {
			throw new Error('No available update is ready to install.');
		}
		this.publish({ installRequested: true });
		if (phase === 'ready') await this.installReadyUpdate();
		else if (phase === 'available') await this.startDownload();
		else if (phase === 'error') {
			// An error event can arrive before the metadata promise settles. Let that
			// attempt finish first so retrying cannot accidentally reuse its promise.
			if (this.checkPromise) await this.checkPromise;
			if (this.state.installRequested && !this.installing && this.state.phase === 'error') await this.check();
		}
	}

	private async installReadyUpdate(): Promise<void> {
		if (this.installing) return;
		if (this.servicesClosedForInstall) throw new Error(this.state.error || 'Restart the app before retrying.');
		if (this.state.phase !== 'ready' || !this.beforeInstall) throw new Error('Update installation is unavailable.');
		this.installing = true;
		this.publish({ phase: 'installing', installRequested: true, error: undefined });
		try {
			const updater = await this.getUpdater();
			if (!this.installing) throw new Error(this.state.error || 'Update installation failed.');
			// Shutdown may partially succeed before rejecting; either case requires a restart.
			this.servicesClosedForInstall = true;
			await this.beforeInstall();
			if (!this.installing) throw new Error(this.state.error || 'Update installation failed.');
			this.stop();
			updater.quitAndInstall(false, true);
			if (!this.installing) throw new Error(this.state.error || 'Update installation failed.');
		} catch (error) {
			// An emitted error has already released the lock and published its restart hint.
			if (this.installing) this.reportInstallError(error);
			throw error;
		}
	}
}

export const updateService = new UpdateService();
