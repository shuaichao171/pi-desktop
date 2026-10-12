/**
 * IPC wiring for the loopback AI debug endpoint.
 *
 * getState/setConfig are restricted to the main window's main frame like every
 * other privileged channel. The server binds 127.0.0.1 only and restarts
 * whenever the configuration changes; it starts automatically at app boot when
 * enabled. When authentication is turned on without a token, a UUID is
 * generated, persisted and returned so the UI can display it.
 */

import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { DEBUG_API_CHANNELS, type UiDebugApiConfig, type UiDebugApiState } from '@pidesktop/shared';
import { handleRendererInvoke } from './rendererIpc.ts';
import { DEFAULT_DEBUG_API_SETTINGS, isValidDesktopDebugApiSettings, readDesktopSettings, writeDesktopSettingsAsync, type DesktopDebugApiSettings } from './desktopSettings.ts';
import { createDebugServer, type DebugServer } from './debugServer.ts';
import type { CloudSyncService } from './cloudSync/cloudSyncService.ts';

export interface DebugApiIpc {
	getState(): UiDebugApiState;
	dispose(): Promise<void>;
}

function normalizeConfig(value: unknown): UiDebugApiConfig {
	if (typeof value !== 'object' || value === null) throw new Error('调试接口配置无效 / invalid debug config');
	const candidate = value as Record<string, unknown>;
	const port = Number(candidate.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('调试端口无效（1-65535）/ invalid port');
	const token = typeof candidate.token === 'string' ? candidate.token.trim() : '';
	if (token.length > 200 || /[\u0000-\u001f\u007f\s]/.test(token)) throw new Error('调试令牌无效 / invalid token');
	if (token && !/^[A-Za-z0-9._~+/=-]+$/.test(token)) throw new Error('调试令牌仅支持字母数字与 . _ ~ + / = - / token characters');
	const authEnabled = candidate.authEnabled === true;
	const config: UiDebugApiConfig = {
		enabled: candidate.enabled === true,
		port,
		authEnabled,
		token: authEnabled && !token ? randomUUID() : token,
	};
	if (!isValidDesktopDebugApiSettings(config)) throw new Error('调试接口配置无效 / invalid debug config');
	return config;
}

export function registerDebugApiIpc(options: {
	/** desktop-settings.json path (owned by ipc.ts). */
	settingsPath: string;
	cloudSync: () => CloudSyncService | null;
	appVersion(): string;
	requireTrustedSender: (event: IpcMainInvokeEvent) => void;
}): DebugApiIpc {
	const { settingsPath } = options;
	let server: DebugServer | null = null;

	const readConfig = (): DesktopDebugApiSettings => readDesktopSettings(settingsPath).debugApi ?? DEFAULT_DEBUG_API_SETTINGS;
	const snapshot = (): UiDebugApiState => {
		const config = readConfig();
		return { ...config, running: server !== null, baseUrl: server !== null ? `http://127.0.0.1:${server.port}` : null };
	};

	async function applyConfig(config: UiDebugApiConfig): Promise<UiDebugApiState> {
		const settings = readDesktopSettings(settingsPath);
		if (server) {
			await server.stop();
			server = null;
		}
		await writeDesktopSettingsAsync(settingsPath, { ...settings, debugApi: config });
		if (config.enabled) {
			server = await createDebugServer(config, {
				cloudSync: options.cloudSync,
				appVersion: options.appVersion,
			});
		}
		return snapshot();
	}

	handleRendererInvoke(DEBUG_API_CHANNELS.getState, (event) => {
		options.requireTrustedSender(event);
		return snapshot();
	});
	handleRendererInvoke(DEBUG_API_CHANNELS.setConfig, (event, config: unknown) => {
		options.requireTrustedSender(event);
		return applyConfig(normalizeConfig(config));
	});

	// Auto-start at boot when enabled; a failure keeps running=false and is
	// reported through the UI on the next getState call.
	const initial = readConfig();
	if (initial.enabled) {
		void applyConfig(initial).catch((error: unknown) => {
			console.error('调试接口启动失败 / debug server failed to start:', error);
		});
	}

	return {
		getState: snapshot,
		async dispose(): Promise<void> {
			if (server) {
				await server.stop();
				server = null;
			}
		},
	};
}
