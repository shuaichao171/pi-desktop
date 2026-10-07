/**
 * IPC wiring for the provider-database cloud sync (cc-switch style).
 *
 * Every channel is restricted to the main window's main frame — the same
 * sender check personalizationSave uses — because saveConfig/testConnection
 * carry credentials and restore rewrites the provider database.
 */

import { app, type IpcMainInvokeEvent } from 'electron';
import { CLOUD_SYNC_FEATURE_CHANNELS, type UiCloudSyncConfig } from '@pidesktop/shared';
import { broadcastToRenderers, handleRendererInvoke } from './rendererIpc.ts';
import { createCloudSyncService, type CloudSyncService } from './cloudSync/cloudSyncService.ts';
import type { AgentHostService } from './agentHostProtocol.ts';

export interface CloudSyncIpc {
	service: CloudSyncService;
	dispose(): Promise<void>;
}

export function registerCloudSyncIpc(agent: AgentHostService, requireTrustedSender: (event: IpcMainInvokeEvent) => unknown): CloudSyncIpc {
	const service = createCloudSyncService({
		userDataPath: app.getPath('userData'),
		appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '',
		agent,
		onChanged: (state) => broadcastToRenderers(CLOUD_SYNC_FEATURE_CHANNELS.changed, state),
	});
	handleRendererInvoke(CLOUD_SYNC_FEATURE_CHANNELS.getState, (event) => {
		requireTrustedSender(event);
		return service.getState();
	});
	handleRendererInvoke(CLOUD_SYNC_FEATURE_CHANNELS.saveConfig, (event, config: UiCloudSyncConfig) => {
		requireTrustedSender(event);
		return service.saveConfig(config);
	});
	handleRendererInvoke(CLOUD_SYNC_FEATURE_CHANNELS.testConnection, (event, config: UiCloudSyncConfig) => {
		requireTrustedSender(event);
		return service.testConnection(config);
	});
	handleRendererInvoke(CLOUD_SYNC_FEATURE_CHANNELS.upload, (event) => {
		requireTrustedSender(event);
		return service.upload();
	});
	handleRendererInvoke(CLOUD_SYNC_FEATURE_CHANNELS.inspect, (event) => {
		requireTrustedSender(event);
		return service.inspect();
	});
	handleRendererInvoke(CLOUD_SYNC_FEATURE_CHANNELS.restore, (event) => {
		requireTrustedSender(event);
		return service.restore();
	});
	return { service, dispose: () => service.dispose() };
}
