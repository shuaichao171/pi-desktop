import type { UiThinkingLevel } from '@pidesktop/shared';

/** 规范思考档位，与 @pidesktop/shared 的 UiThinkingLevel 一致；持久化与请求只允许这个集合。 */
export const THINKING_LEVELS: readonly UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** off 在供应商声明与历史配置里的别名写法，归一化时统一折叠为 off。 */
const OFF_ALIASES: ReadonlySet<string> = new Set(['off', 'none', 'disabled']);

/**
 * 归一化思考档位：`none`/`disabled`/`off` → `off`；规范档位原样返回；
 * 其余未知值返回 undefined（宁可不传 reasoning，也不透传非法 effort）。
 */
export function normalizeThinkingLevel(value: unknown): UiThinkingLevel | undefined {
	if (typeof value !== 'string') return undefined;
	if (OFF_ALIASES.has(value)) return 'off';
	return THINKING_LEVELS.includes(value as UiThinkingLevel) ? value as UiThinkingLevel : undefined;
}

/** SDK 会话上消费档位所需的最小接口，避免耦合具体运行时类型。 */
export interface ThinkingLevelSession {
	thinkingLevel: unknown;
	setThinkingLevel(level: UiThinkingLevel, options?: { persist?: boolean }): void;
}

/**
 * 把会话当前档位拉回规范集：非规范值归一化后写回会话（SDK 会再按模型能力
 * clamp）。/compact 与自动压缩等进入 SDK 内部总结请求前共用此入口，
 * 保证转录与后续请求不再携带 `none` 这类非法档位。
 */
export function applyCanonicalThinkingLevel(session: ThinkingLevelSession): UiThinkingLevel {
	const normalized = normalizeThinkingLevel(session.thinkingLevel) ?? 'off';
	if (session.thinkingLevel !== normalized) session.setThinkingLevel(normalized);
	return normalized;
}

/** 请求 options 里 SDK 使用的 reasoning 档位字段（运行时可能是任意值，含缺失）。 */
type ReasoningRequestOptions = { reasoning?: unknown };

/** 模型目录里的思考档位线上值映射：null 表示该档位不受支持。 */
type ThinkingLevelMappedModel = { thinkingLevelMap?: unknown };

/**
 * OpenAI 兼容接口不接受的 effort 线上值。模型设置页历史上把 off 档位写成
 * `none`，适配器会把它原样作为 reasoning_effort 发给只接受 low…max 的模型。
 */
const ILLEGAL_EFFORTS: ReadonlySet<string> = new Set(['none', 'disabled']);

/**
 * 请求前统一清洗模型与 options（/compact、自动压缩与普通对话共用的模型请求层）：
 * - `options.reasoning` 只保留规范的非 off 档位；off 与未知值一律不传
 *   （与 SDK「off 即不下发 reasoning」语义一致，非法档位绝不透传）；
 * - `thinkingLevelMap` 中映射为 `none`/`disabled` 的线上值被移除：
 *   openai-completions 适配器对缺失的 off 映射不会下发 reasoning_effort，
 *   其余档位则回退为规范档位本身（openai-responses 系适配器对缺失的 off
 *   仍兜底 'none'，为上游 pi-ai 已知行为，只能靠 off:null 显式关闭）。
 */
export function sanitizeReasoningRequest<M extends ThinkingLevelMappedModel, O>(model: M, options: O): { model: M; options: O } {
	const reasoning = options !== null && typeof options === 'object' ? (options as ReasoningRequestOptions).reasoning : undefined;
	const normalized = normalizeThinkingLevel(reasoning);
	const keep = normalized !== undefined && normalized !== 'off';
	const nextOptions: O = keep || reasoning === undefined ? options : dropReasoning(options as object) as O;
	return { model: dropIllegalEfforts(model), options: nextOptions };
}

/** 克隆 options 并移除非法 reasoning。 */
function dropReasoning<O extends object>(options: O): O {
	const { reasoning: _invalid, ...rest } = options as O & ReasoningRequestOptions;
	return rest as O;
}

/** 克隆模型并移除映射为 none/disabled 的线上值；映射干净时保持原对象不变。 */
function dropIllegalEfforts<M extends ThinkingLevelMappedModel>(model: M): M {
	const map = model.thinkingLevelMap;
	if (!map || typeof map !== 'object') return model;
	const entries = Object.entries(map as Record<string, unknown>);
	const illegal = (value: unknown): value is string => typeof value === 'string' && ILLEGAL_EFFORTS.has(value);
	if (!entries.some(([, mapped]) => illegal(mapped))) return model;
	const sanitized = Object.fromEntries(entries.filter(([, mapped]) => !illegal(mapped)));
	return { ...model, thinkingLevelMap: sanitized } as M;
}
