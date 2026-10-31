import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_COMPACTION_SETTINGS, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { UiCompactionPiSettings, UiCompactionSettings, UiCompactionSettingsWrite, UiDesktopCompactionPreferences } from '../../../shared/src/compactionFeatures';

/**
 * 内置压缩设置的持久化：
 * - Pi 全局 ~/.pi/agent/settings.json 的 compaction 块（enabled/reserveTokens/keepRecentTokens），
 *   与 Pi SDK 的读取逻辑同源，缺失字段回落 SDK 默认值。
 * - pi-desktop 私有 ~/.pi/agent/desktop-compaction.json（压缩方式选择 + 压缩模型），
 *   独立成文件避免污染 Pi 的 settings schema。
 * 两个文件都以内容哈希做乐观并发检查，写入走临时文件原子替换。
 */
function hash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

async function readJson(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return { text: '', value: {} };
		const text = await readFile(path, 'utf8');
		const value = JSON.parse(text);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return { text, value: {} };
		return { text, value: value as Record<string, unknown> };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', value: {} };
		throw error;
	}
}

/** 校验并规范化 compaction 块；非安全整数按缺失处理回落默认。 */
function normalizePiSettings(input: unknown): UiCompactionPiSettings {
	const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
	const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
		reserveTokens: integer(source.reserveTokens) ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		keepRecentTokens: integer(source.keepRecentTokens) ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	};
}

function normalizePreferences(input: unknown): UiDesktopCompactionPreferences {
	const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
	const model = source.compressModel && typeof source.compressModel === 'object' && !Array.isArray(source.compressModel)
		? source.compressModel as Record<string, unknown>
		: undefined;
	return {
		mode: source.mode === 'magicContext' ? 'magicContext' : 'builtin',
		compressModel: model && typeof model.provider === 'string' && typeof model.id === 'string' && model.provider.trim() && model.id.trim()
			? { provider: model.provider.trim().slice(0, 200), id: model.id.trim().slice(0, 400) }
			: null,
	};
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

export class CompactionSettingsService {
	private queue: Promise<unknown> = Promise.resolve();

	private globalSettingsPath(): string {
		return join(getAgentDir(), 'settings.json');
	}

	private preferencesPath(): string {
		return join(getAgentDir(), 'desktop-compaction.json');
	}

	async snapshot(): Promise<UiCompactionSettings> {
		const [global, preferences] = await Promise.all([
			readJson(this.globalSettingsPath()),
			readJson(this.preferencesPath()),
		]);
		return {
			version: hash(global.text),
			pi: normalizePiSettings(global.value.compaction),
			preferencesVersion: hash(preferences.text),
			preferences: normalizePreferences(preferences.value),
		};
	}

	save(request: UiCompactionSettingsWrite): Promise<UiCompactionSettings> {
		const work = this.queue.then(async () => {
			if (!request || typeof request !== 'object') throw new Error('压缩设置请求无效');
			const pi = normalizePiSettings(request.pi);
			const preferences = normalizePreferences(request.preferences);
			const global = await readJson(this.globalSettingsPath());
			if (hash(global.text) !== request.expectedPiVersion) throw new Error('Pi 配置已被外部修改，请刷新后重试');
			const stored = await readJson(this.preferencesPath());
			if (hash(stored.text) !== request.expectedPreferencesVersion) throw new Error('压缩偏好已被外部修改，请刷新后重试');

			// [喵喵喵]: 只覆盖 compaction 块，保留 settings.json 其余字段；Pi 未定义多余键，
			// 这里把 UI 可编辑的三键写全，省去 Pi SDK 读文件时的合并分支
			const nextGlobal = { ...global.value, compaction: pi };
			await atomicWrite(this.globalSettingsPath(), nextGlobal);
			await atomicWrite(this.preferencesPath(), preferences);
			return this.snapshot();
		});
		this.queue = work.catch(() => undefined);
		return work;
	}
}
