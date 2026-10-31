import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { UiMagicContextConfig, UiMagicContextPluginStatus, UiMagicContextThinkingLevel, UiPluginCatalog } from '../../../shared/src/index';

/** Magic Context Pi 扩展的 npm 包名（pi install 形式为 npm:<name>）。 */
export const MAGIC_CONTEXT_PACKAGE = '@cortexkit/pi-magic-context';
export const MAGIC_CONTEXT_SOURCE = `npm:${MAGIC_CONTEXT_PACKAGE}`;

const LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(MAGIC_CONTEXT_PACKAGE)}/latest`;
const PROBE_TIMEOUT_MS = 12_000;
const PROBE_CACHE_MS = 60_000;
const DEFAULT_THRESHOLD = { min: 20, max: 80 };
const DEFAULT_HISTORY_BUDGET = { min: 0.05, max: 0.5 };

/**
 * [喵喵喵]: 受控简化 — Magic Context 0.49.x 读 CortexKit 共享配置：用户级
 * ~/.config/cortexkit/magic-context.jsonc（XDG_CONFIG_HOME 优先），项目级
 * $cwd/.cortexkit/ 优先于用户级；~/.pi/agent/ 旧位置只是 legacy 迁移源，向旧位置
 * 写入会触发插件迁移 conflict 导致新配置不生效，因此读写一律走新路径。
 * 边界：项目级覆盖不在此管理，UI 以提示告知；升级：插件若再改配置位置，按其源码调整。
 */
function cortexKitUserConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	const configHome = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
	return join(configHome, 'cortexkit', 'magic-context.jsonc');
}

/** legacy 位置只作读取回落（用户旧插件时代可能残留），保存时会被移开。 */
function legacyUserConfigPath(): string {
	return join(getAgentDir(), 'magic-context.jsonc');
}

function hash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/**
 * 剥掉 JSONC 的行/块注释后解析。字符串字面量内部的 // 与 /* 不受影响，
 * 截断的块注释按文件尾收尾（与 VS Code 的宽容行为一致）。
 */
export function parseJsonc(text: string): Record<string, unknown> {
	let out = '';
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i]!;
		if (char === '"') {
			let literal = char;
			i += 1;
			while (i < text.length) {
				const inner = text[i]!;
				literal += inner;
				i += 1;
				if (inner === '\\') {
					if (i < text.length) {
						literal += text[i]!;
						i += 1;
					}
				} else if (inner === '"') break;
			}
			out += literal;
			i -= 1;
			continue;
		}
		if (char === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			out += '\n';
			continue;
		}
		if (char === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
			i += 1;
			out += ' ';
			continue;
		}
		out += char;
	}
	try {
		const value = JSON.parse(out);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

async function readConfig(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
	try {
		const info = await lstat(path);
		// 配置损坏时不阻断读取：返回空对象让 UI 以默认值展示，保存时整体重写
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return { text: '', value: {} };
		const text = await readFile(path, 'utf8');
		return { text, value: parseJsonc(text) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', value: {} };
		throw error;
	}
}

/** 新路径无内容时回落 legacy 只读展示（用户旧插件时代残留，尚未被插件迁移）。 */
async function readEffectiveConfig(): Promise<{ source: 'current' | 'legacy'; text: string; value: Record<string, unknown> }> {
	const current = await readConfig(cortexKitUserConfigPath());
	if (current.text.trim()) return { source: 'current', ...current };
	const legacy = await readConfig(legacyUserConfigPath());
	if (legacy.text.trim()) return { source: 'legacy', ...legacy };
	return { source: 'current', text: '', value: {} };
}

/**
 * [喵喵喵]: 以 legacy 为基准写入新路径后把 legacy 改名 .migrated（对齐插件的
 * moved-aside 迁移语义），否则插件下次加载会因两份内容不同触发迁移 conflict。
 */
async function moveAsideLegacyConfig(): Promise<void> {
	try {
		await rename(legacyUserConfigPath(), `${legacyUserConfigPath()}.migrated`);
	} catch {
		// ENOENT 或目标已存在：插件迁移已处理或本就无残留，无需干预
	}
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const directory = await lstat(dirname(path));
	if (directory.isSymbolicLink()) throw new Error('配置目录不能是链接');
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, 'wx', 0o600);
		try {
			await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function optionalText(value: unknown, max: number): string | null {
	return typeof value === 'string' && value.trim() && value.length <= max ? value : null;
}

/** 非数组对象取值；其他一律当空块，避免把字符串/数组当配置块展开。 */
function objectBlock(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 推理级别取值：只接受插件 schema 列出的档位（无 none），其余视为未设置。 */
function readThinkingLevel(value: unknown): UiMagicContextThinkingLevel | null {
	return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
		? value as UiMagicContextThinkingLevel
		: null;
}

/** 备选模型项：字符串，或 {model, thinking_level} 对象（按 model 读入）。 */
function readFallbackModel(value: unknown): string | null {
	if (typeof value === 'string') return optionalText(value, 400);
	if (value && typeof value === 'object' && !Array.isArray(value)) return optionalText((value as Record<string, unknown>).model, 400);
	return null;
}

interface MagicHistorianRead {
	model: string | null;
	fallbackModels: string[];
	thinkingLevel: UiMagicContextThinkingLevel | null;
	/** 值来自 historian.pi 块（true）还是旧顶层同名字段的只读回落（false）。 */
	modelFromPi: boolean;
	thinkingFromPi: boolean;
}

/**
 * [喵喵喵]: Magic Context 只在 historian.pi 块内读模型设置（opencode/omp 是其他 harness 的
 * 专用块，omp 缺省继承 pi）；顶层的 historian.model/thinking_level 是 pi-desktop 旧版写入的
 * 过时层级，插件根本不识别。因此优先读 pi 块，只有 pi 未给出的键才回落到旧顶层字段，
 * 否则用户此前在桌面版填的模型看起来「已设置」却始终不生效。
 * pi.model 允许 {model, thinking_level} 对象形态，其嵌套推理级别与块级同级看待。
 */
function readMagicHistorian(historian: Record<string, unknown>): MagicHistorianRead {
	const pi = objectBlock(historian.pi);
	const rawModel = pi.model;
	const nested = objectBlock(rawModel);
	const piModel = typeof rawModel === 'string' ? optionalText(rawModel, 400) : optionalText(nested.model, 400);
	const piThinking = readThinkingLevel(pi.thinking_level) ?? readThinkingLevel(nested.thinking_level);
	const fallbackRaw = Array.isArray(pi.fallback_models) ? pi.fallback_models : [];
	return {
		model: piModel ?? optionalText(historian.model, 400),
		thinkingLevel: piThinking ?? readThinkingLevel(historian.thinking_level),
		fallbackModels: fallbackRaw.map(readFallbackModel).filter((item): item is string => item !== null),
		modelFromPi: piModel !== null,
		thinkingFromPi: piThinking !== null,
	};
}

/** 校验并规范化 pi-desktop 暴露的配置子集；越界数值回落插件默认（null=不写入）。 */
export function normalizeMagicContextConfig(input: unknown): UiMagicContextConfig {
	const source = objectBlock(input);
	const historian = objectBlock(source.historian);
	const embedding = objectBlock(source.embedding);
	const threshold = source.execute_threshold_percentage;
	const budget = source.history_budget_percentage;
	const read = readMagicHistorian(historian);
	const percentage = (value: unknown, range: { min: number; max: number }): number | null =>
		typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max ? value : null;
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
		historian: { model: read.model, fallbackModels: read.fallbackModels, thinkingLevel: read.thinkingLevel },
		embedding: {
			provider: embedding.provider === 'openai-compatible' || embedding.provider === 'off' ? embedding.provider : 'local',
			model: optionalText(embedding.model, 400),
			endpoint: optionalText(embedding.endpoint, 2000),
			apiKey: null,
			apiKeySet: typeof embedding.api_key === 'string' && embedding.api_key.trim() !== '',
		},
		executeThresholdPercentage: percentage(threshold, DEFAULT_THRESHOLD),
		historyBudgetPercentage: percentage(budget, DEFAULT_HISTORY_BUDGET),
	};
}

/** 把 UI 配置合并进现有 jsonc 值：只动 pi-desktop 管理的键，保留插件的其他设置。 */
function mergeConfig(current: Record<string, unknown>, config: UiMagicContextConfig): Record<string, unknown> {
	const next: Record<string, unknown> = { ...current };
	next.enabled = config.enabled;

	const historian = { ...objectBlock(next.historian) };
	const pi = { ...objectBlock(historian.pi) };
	const before = readMagicHistorian(historian);
	const fallbackFromPi = Array.isArray(pi.fallback_models);
	const thinkingAtBlock = readThinkingLevel(pi.thinking_level) !== null;

	// [喵喵喵]: 值未变时不重写 —— pi.model 的对象形态被压成字符串会丢掉嵌套 reasoning 级别；
	// 但只要模型键被重写（用户改了模型），就必须把推理级别落到块级，否则嵌套值随之消失。
	const nextModel = config.historian.model;
	const nextThinking = config.historian.thinkingLevel;
	const modelUnchanged = before.modelFromPi && before.model === nextModel && before.thinkingLevel === nextThinking;
	if (!modelUnchanged) {
		if (nextModel) pi.model = nextModel;
		else delete pi.model;
	}
	if (!(before.thinkingFromPi && before.thinkingLevel === nextThinking && (thinkingAtBlock || modelUnchanged))) {
		if (nextThinking) pi.thinking_level = nextThinking;
		else delete pi.thinking_level;
	}

	// 备选链同理：未变则保留原数组，避免把 {model, thinking_level} 对象项压成纯字符串
	const nextFallbacks = config.historian.fallbackModels.map((item) => item.trim()).filter(Boolean);
	const fallbacksUnchanged = nextFallbacks.length === before.fallbackModels.length
		&& nextFallbacks.every((item, index) => item === before.fallbackModels[index]);
	if (!(fallbackFromPi && fallbacksUnchanged)) {
		if (nextFallbacks.length) pi.fallback_models = nextFallbacks;
		else delete pi.fallback_models;
	}

	// 旧层级同名键一律清掉：留着会让用户以为设置生效，实际插件只认 pi 块（值已迁移进 pi）
	delete historian.model;
	delete historian.thinking_level;
	if (Object.keys(pi).length) historian.pi = pi;
	else delete historian.pi;
	if (Object.keys(historian).length) next.historian = historian;
	else delete next.historian;

	next.embedding = { ...(next.embedding && typeof next.embedding === 'object' ? next.embedding as Record<string, unknown> : {}) };
	(next.embedding as Record<string, unknown>).provider = config.embedding.provider;
	if (config.embedding.model) (next.embedding as Record<string, unknown>).model = config.embedding.model;
	else delete (next.embedding as Record<string, unknown>).model;
	if (config.embedding.provider === 'openai-compatible' && config.embedding.endpoint) (next.embedding as Record<string, unknown>).endpoint = config.embedding.endpoint;
	else delete (next.embedding as Record<string, unknown>).endpoint;
	// apiKey: null=保持（不写）、''=清除、其他=写入
	if (config.embedding.apiKey !== null) {
		if (config.embedding.apiKey === '') delete (next.embedding as Record<string, unknown>).api_key;
		else (next.embedding as Record<string, unknown>).api_key = config.embedding.apiKey;
	}

	if (config.executeThresholdPercentage !== null) next.execute_threshold_percentage = config.executeThresholdPercentage;
	else delete next.execute_threshold_percentage;
	if (config.historyBudgetPercentage !== null) next.history_budget_percentage = config.historyBudgetPercentage;
	else delete next.history_budget_percentage;
	return next;
}

/** 安装成功后的默认配置（README 最小可用形态：本地向量、无模型覆盖）。 */
export function defaultMagicContextConfig(): Record<string, unknown> {
	return {
		$schema: 'https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json',
		enabled: true,
		embedding: { provider: 'local' },
	};
}

/** 无会话时从 Pi 全局 settings.json 的 packages 声明判断是否已安装。 */
async function detectInstalledFromSettings(): Promise<boolean> {
	try {
		const { value } = await readConfig(join(getAgentDir(), 'settings.json'));
		const packages = value.packages;
		if (!Array.isArray(packages)) return false;
		return packages.some((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Record<string, unknown>).source === 'string' ? (item as Record<string, unknown>).source as string : null) === MAGIC_CONTEXT_SOURCE);
	} catch {
		return false;
	}
}

/** 从插件目录解析 Magic Context 的安装与开关状态；无目录时降级为 packages 声明检测。 */
export async function detectMagicContextPlugin(catalog: UiPluginCatalog | null): Promise<Pick<UiMagicContextPluginStatus, 'installed' | 'enabled' | 'installedVersion'>> {
	if (!catalog) return { installed: await detectInstalledFromSettings(), enabled: null, installedVersion: null };
	const pkg = catalog.packages.find((item) => item.source === MAGIC_CONTEXT_SOURCE) ?? null;
	let enabled: boolean | null = null;
	if (pkg) {
		// 包内资源全部关掉视为禁用；无资源信息时保持 null（不妄断）
		const resources = catalog.resources.filter((item) => item.origin === 'package' && item.source === MAGIC_CONTEXT_SOURCE);
		if (resources.length) {
			const extensions = resources.filter((item) => item.kind === 'extensions');
			const target = extensions.length ? extensions : resources;
			enabled = target.every((item) => item.enabled);
		}
	}
	return {
		installed: pkg?.installed ?? false,
		enabled,
		installedVersion: pkg?.version ?? null,
	};
}

export interface MagicContextStore {
	/** 读取用户级配置（含内容哈希与插件状态）；catalog 为空时降级检测安装状态。 */
	snapshot(catalog: UiPluginCatalog | null): Promise<{ configPath: string; configVersion: string; config: UiMagicContextConfig; plugin: UiMagicContextPluginStatus }>;
	/** 乐观锁写入配置；只覆盖 pi-desktop 管理的键。 */
	save(request: { expectedVersion: string; config: UiMagicContextConfig }): Promise<{ configPath: string; configVersion: string; config: UiMagicContextConfig }>;
	/**
	 * [喵喵喵]: 写插件的 compaction.enabled 接管键 — builtin 模式写 false（compaction-off，
	 * 插件在 session_before_compact 放行、其余功能保留），magicContext 模式写 true（插件接管）。
	 * 该键是插件 boot 闭包捕获，写入后必须重载插件才生效（调用方负责）。
	 */
	setCompactionOwnership(pluginOwns: boolean): Promise<void>;
	/** 安装默认配置文件（仅在文件不存在时创建）。 */
	ensureDefaultConfig(): Promise<void>;
	/** 探测 npm 最新版本（失败静默返回 null；60s 内复用结果避免每次快照都请求）。 */
	probeLatestVersion(): Promise<string | null>;
}

export function createMagicContextStore(fetcher: typeof fetch = fetch): MagicContextStore {
	let probeCache: { at: number; version: string | null } | null = null;
	return {
		async snapshot(catalog) {
			const current = await readEffectiveConfig();
			const detected = await detectMagicContextPlugin(catalog);
			const latest = await this.probeLatestVersion();
			const installed = detected.installedVersion;
			return {
				configPath: current.source === 'legacy' ? legacyUserConfigPath() : cortexKitUserConfigPath(),
				configVersion: hash(current.text),
				config: normalizeMagicContextConfig(current.value),
				plugin: {
					...detected,
					latestVersion: latest,
					updateAvailable: Boolean(installed && latest && installed !== latest),
					error: null,
				},
			};
		},
		async save(request) {
			const current = await readEffectiveConfig();
			if (hash(current.text) !== request.expectedVersion) throw new Error('Magic Context 配置已被外部修改，请刷新后重试');
			await atomicWrite(cortexKitUserConfigPath(), mergeConfig(current.value, request.config));
			if (current.source === 'legacy') await moveAsideLegacyConfig();
			const next = await readConfig(cortexKitUserConfigPath());
			return { configPath: cortexKitUserConfigPath(), configVersion: hash(next.text), config: normalizeMagicContextConfig(next.value) };
		},
		async setCompactionOwnership(pluginOwns) {
			const current = await readEffectiveConfig();
			const next: Record<string, unknown> = { ...current.value };
			const compaction = next.compaction && typeof next.compaction === 'object' && !Array.isArray(next.compaction)
				? { ...(next.compaction as Record<string, unknown>) }
				: {};
			compaction.enabled = pluginOwns;
			next.compaction = compaction;
			await atomicWrite(cortexKitUserConfigPath(), next);
			if (current.source === 'legacy') await moveAsideLegacyConfig();
		},
		async ensureDefaultConfig() {
			const current = await readConfig(cortexKitUserConfigPath());
			if (!current.text.trim()) await atomicWrite(cortexKitUserConfigPath(), defaultMagicContextConfig());
		},
		async probeLatestVersion() {
			if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.version;
			try {
				const response = await fetcher(LATEST_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'error', headers: { Accept: 'application/json' } });
				let version: string | null = null;
				if (response.ok) {
					const data: unknown = await response.json().catch(() => null);
					version = data && typeof (data as { version?: unknown }).version === 'string' ? (data as { version: string }).version : null;
				}
				probeCache = { at: Date.now(), version };
				return version;
			} catch {
				// [喵喵喵]: 探测失败不缓存结果（下次快照会重试），UI 仅少显示最新版本号
				return null;
			}
		},
	};
}
