import type { UiPluginCatalog } from '@pidesktop/shared';

/**
 * 插件目录渲染缓存：插件页每次进入先用上次目录立即渲染，后台刷新完成后替换。
 * 目录按工作区（cwd）缓存；只有当发起拉取的上下文仍然有效时才写入缓存，
 * 迟到的旧响应不会覆盖其他工作区或新导航代次下的缓存。
 */
export interface PluginCatalogCache {
	read(cwd: string): UiPluginCatalog | null;
	write(cwd: string, catalog: UiPluginCatalog): void;
	invalidate(cwd?: string): void;
}

/** 最近使用优先，容量按侧栏可注册的项目数量级取值。 */
export function createPluginCatalogCache(limit = 16): PluginCatalogCache {
	const entries = new Map<string, UiPluginCatalog>();
	return {
		read(cwd) {
			return entries.get(cwd) ?? null;
		},
		write(cwd, catalog) {
			entries.delete(cwd);
			entries.set(cwd, catalog);
			while (entries.size > limit) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		invalidate(cwd) {
			if (cwd === undefined) entries.clear();
			else entries.delete(cwd);
		},
	};
}
