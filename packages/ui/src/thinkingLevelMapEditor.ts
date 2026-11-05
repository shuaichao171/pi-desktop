import type { UiCustomProviderModel, UiThinkingLevel } from '@pidesktop/shared';

/** 与共享层一致的规范思考档位顺序。 */
export const THINKING_LEVELS: readonly UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 模型目录里的思考档位线上值映射：null 表示该档位不受支持。 */
export type ThinkingLevelMap = NonNullable<UiCustomProviderModel['thinkingLevelMap']>;

/** OpenAI 兼容端点不接受的 off 线上值（历史 UI 写入过 'none'，重建映射时不再保留）。 */
const ILLEGAL_OFF_VALUES: ReadonlySet<string> = new Set(['none', 'disabled']);

/**
 * 按声明档位生成默认映射。off 受支持时【不写条目】而不是写 'none'：
 * openai-completions 适配器对缺失的 off 映射不会下发 reasoning_effort（缺失即
 * 「不发参数、推理关闭」）；'none' 则会被只接受 low…max 的端点以 400 拒绝。
 * 注意：openai-responses / azure-openai-responses 适配器（上游 pi-ai 行为）对
 * 缺失的 off 映射仍兜底发送 effort:'none'——该协议下只有显式 off:null 才不发。
 */
export function advertisedThinkingMap(levels: readonly UiThinkingLevel[]): ThinkingLevelMap {
	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) {
		if (!levels.includes(level)) { map[level] = null; continue; }
		if (level === 'off') continue;
		map[level] = level;
	}
	return map as ThinkingLevelMap;
}

/**
 * 镜像 pi-ai 的 getSupportedThinkingLevels 语义：
 * null = 不支持；off/minimal/low/medium/high 缺省视为支持；xhigh/max 需显式线上值。
 * 无映射时回退到声明档位列表（与定制前的继承语义一致）。
 */
export function supportedThinkingLevels(map: ThinkingLevelMap | undefined, declared?: readonly UiThinkingLevel[]): UiThinkingLevel[] {
	if (!map) return THINKING_LEVELS.filter((level) => declared?.includes(level) ?? false);
	return THINKING_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === 'xhigh' || level === 'max') return mapped !== undefined;
		return true;
	});
}

/**
 * 切换某档位的勾选：off 勾选 = 保持缺省条目（不发 effort）；取消勾选 = null（不支持）。
 * 重建时保留其他已支持档位的既有线上值，但丢弃 off 档位遗留的非法 'none'/'disabled'。
 */
export function toggleThinkingLevel(current: ThinkingLevelMap | undefined, level: UiThinkingLevel, checked: boolean, supported: readonly UiThinkingLevel[]): ThinkingLevelMap {
	const next = advertisedThinkingMap(supported);
	for (const other of supported) {
		if (other === level) continue;
		const mapped = current?.[other];
		if (typeof mapped !== 'string' || mapped === '') continue;
		if (other === 'off' && ILLEGAL_OFF_VALUES.has(mapped)) continue;
		next[other] = mapped;
	}
	if (checked) { if (level !== 'off') next[level] = level; }
	else next[level] = null;
	return next;
}
