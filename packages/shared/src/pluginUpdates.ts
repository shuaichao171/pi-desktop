import type { UiPluginScope } from './index';
export interface PluginUpdateCheck { cwd: string; scope: UiPluginScope; source: string; latest?: boolean }
export interface PluginUpdatePreview { id: string; cwd: string; scope: UiPluginScope; source: string; installed: string | null; constraint: string; target: string | null; latest: string | null; checkedAt: string; kind: 'upgrade' | 'repair' | 'current' | 'unsupported' | 'failed'; message: string; targetSource: string | null }
export interface PluginUpdatesBridge { checkPluginUpdate(request: PluginUpdateCheck): Promise<PluginUpdatePreview> }
export const PLUGIN_UPDATE_CHANNELS = { checkPluginUpdate: 'plugin:check-update' } as const;
