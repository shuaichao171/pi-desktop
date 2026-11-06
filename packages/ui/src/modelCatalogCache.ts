import type { UiModelProvider, UiModelSummary } from '@pidesktop/shared';

/**
 * 模型 / 供应商目录的跨启动缓存（懒加载审计 P2）：冷启动时模型选择器、
 * 设置页先用上次成功拉取的目录渲染，打开时的后台刷新返回后整体替换。
 *
 * - 只缓存展示元数据：UiModelProvider 本身不含密钥（主机侧只暴露 header 名、
 *   baseUrl 与用量查询的非密字段），因此可以放在本机 localStorage。
 * - 读取时逐项校验结构，损坏或版本不符的数据整体丢弃，不会让渲染层拿到
 *   形状不对的对象；超过体积上限的目录不写入，并清除旧缓存，避免陈旧
 *   数据长期滞留。
 * - 只在「当前列表为空」时用缓存垫底（store.ts），不在启动主路径上读取。
 */
const KEY = 'pi-desktop.model-catalog.v1';
/** 约等于数千个模型条目；超过即视为异常目录，不做持久化。 */
export const MODEL_CATALOG_CACHE_MAX_CHARS = 1_000_000;

export interface ModelCatalogSnapshot {
	models: UiModelSummary[];
	modelProviders: UiModelProvider[];
}

/** 结构上可替换的存储，测试可注入内存实现。 */
export interface CatalogStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function defaultStorage(): CatalogStorage | null {
	try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelSummary(value: unknown): value is UiModelSummary {
	return isRecord(value)
		&& typeof value.provider === 'string' && typeof value.id === 'string' && typeof value.name === 'string'
		&& typeof value.reasoning === 'boolean'
		&& Array.isArray(value.input) && value.input.every((item) => item === 'text' || item === 'image')
		&& typeof value.contextWindow === 'number' && typeof value.maxTokens === 'number'
		&& (value.thinkingLevels === undefined || (Array.isArray(value.thinkingLevels) && value.thinkingLevels.every((level) => typeof level === 'string')))
		&& (value.thinkingLevelMap === undefined || isRecord(value.thinkingLevelMap));
}

function isModelProvider(value: unknown): value is UiModelProvider {
	return isRecord(value)
		&& typeof value.provider === 'string' && typeof value.name === 'string'
		&& typeof value.custom === 'boolean' && typeof value.editable === 'boolean' && typeof value.configured === 'boolean'
		&& (value.baseUrl === null || typeof value.baseUrl === 'string')
		&& (value.api === null || typeof value.api === 'string')
		&& Array.isArray(value.models) && value.models.every(isModelSummary);
}

const EMPTY: ModelCatalogSnapshot = { models: [], modelProviders: [] };

/** 读取上次目录；缺失、损坏或结构不符时返回空目录（不抛错）。 */
export function readModelCatalogCache(storage: CatalogStorage | null = defaultStorage()): ModelCatalogSnapshot {
	if (!storage) return EMPTY;
	try {
		const raw = storage.getItem(KEY);
		if (!raw) return EMPTY;
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return EMPTY;
		const models = Array.isArray(parsed.models) && parsed.models.every(isModelSummary) ? parsed.models : [];
		const modelProviders = Array.isArray(parsed.modelProviders) && parsed.modelProviders.every(isModelProvider) ? parsed.modelProviders : [];
		return { models, modelProviders };
	} catch {
		return EMPTY;
	}
}

/**
 * 写入一次成功拉取的结果（只覆盖给出的部分）。空列表不写：主机在运行时
 * 会话尚未就绪时返回 []，那不是「目录为空」，不能冲掉上一份可用缓存。
 */
export function writeModelCatalogCache(patch: Partial<ModelCatalogSnapshot>, storage: CatalogStorage | null = defaultStorage()): void {
	if (!storage) return;
	const next = { ...readModelCatalogCache(storage) };
	let changed = false;
	if (patch.models?.length) { next.models = patch.models; changed = true; }
	if (patch.modelProviders?.length) { next.modelProviders = patch.modelProviders; changed = true; }
	if (!changed) return;
	try {
		const serialized = JSON.stringify(next);
		if (serialized.length > MODEL_CATALOG_CACHE_MAX_CHARS) { storage.removeItem(KEY); return; }
		storage.setItem(KEY, serialized);
	} catch {
		// 配额已满或存储不可用：缓存只是加速，当前窗口的内存状态不受影响。
	}
}
