import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { compact } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { AgentUiEvent } from '../../../shared/src/index';
import type { UiDesktopCompactionPreferences } from '../../../shared/src/compactionFeatures';

export type CompactionPreviewEvent = Extract<AgentUiEvent, { type: 'compaction-preview' }>;

export interface CompactionExtensionServices {
	/** 压缩发生时读取当前偏好（模式 + 压缩模型），设置变更无需重建会话即时生效。 */
	getPreferences(): UiDesktopCompactionPreferences;
	/** 把压缩预览事件推给 UI（singleAgentService.fire）。 */
	emit(event: CompactionPreviewEvent): void;
}

function errorMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.trim() ? text.trim().slice(0, 400) : '压缩失败';
}

/**
 * 内置隐藏扩展 desktop-compaction：接管 Pi 的压缩摘要生成。
 *
 * - builtin 模式：用配置的压缩模型（未配置则跟随会话模型）调 SDK 的 compact()，
 *   通过自定义 streamFn 把摘要 text delta 实时推给 UI —— snow-app 同款的
 *   "压缩流独立于正式消息 + 内容实时可见"。
 * - magicContext 模式：不注册任何行为，内置压缩交给 Magic Context 插件接管
 *   （插件 cancel 内置压缩后由 historian 后台压缩，无感知）。
 * - 失败语义与 snow-app 一致：cancel 本次压缩并展示错误横线，SDK 不落
 *   CompactionEntry，上下文保持原样，下一轮达到阈值会再次触发。
 */
export function createCompactionExtension(services: CompactionExtensionServices): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on('session_before_compact', async (event, ctx) => {
			const preferences = services.getPreferences();
			// [喵喵喵]: magic context 模式不接管 —— 插件需要 cancel 内置压缩实现后台无感知，
			// 这里若抢先返回摘要会破坏其接管语义
			if (preferences.mode !== 'builtin') return undefined;

			services.emit({ type: 'compaction-preview', phase: 'start', reason: event.reason });
			try {
				// 压缩模型：优先用户配置；未配置或解析失败时回落会话模型
				const model = (preferences.compressModel ? ctx.modelRegistry.find(preferences.compressModel.provider, preferences.compressModel.id) : undefined)
					?? ctx.model;
				if (!model) throw new Error('未找到可用的压缩模型，请先在设置中选择模型或配置会话模型');
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				// ProviderHeaders 允许 null 值（抑制默认头）；compact() 的 headers 参数不收 null
				const requestHeaders: Record<string, string> | undefined = auth.headers
					? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
					: undefined;

				const result = await compact(
					event.preparation,
					model,
					auth.apiKey,
					requestHeaders,
					event.customInstructions,
					event.signal,
					undefined,
					(model2, context, options) => {
						// [喵喵喵]: streamFn 转发层 —— compact() 只在提供 streamFn 时把摘要请求交给本层；
						// 这里调 pi-ai 的 streamSimple 发起请求，转发全部事件给消费方（result() 由
						// done/error 事件自动收敛），同时把 text delta 推给 UI 做流式预览
						const upstream = streamSimple(model2, context, options);
						const preview = createAssistantMessageEventStream();
						void (async () => {
							try {
								for await (const chunk of upstream) {
									if (chunk.type === 'text_delta' && chunk.delta) {
										services.emit({ type: 'compaction-preview', phase: 'delta', reason: event.reason, delta: chunk.delta });
									}
									preview.push(chunk);
								}
							} catch (streamError) {
								// 上游在产出 error 事件前直接抛出（传输层异常）时兜底收尾，
								// 保证 result() 不会永久挂起
								const failed: AssistantMessage = {
									role: 'assistant',
									content: [],
									api: model2.api,
									provider: model2.provider,
									model: model2.id,
									usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
									stopReason: 'error',
									errorMessage: errorMessage(streamError),
									timestamp: Date.now(),
								};
								preview.push({ type: 'error', reason: 'error', error: failed });
								preview.end(failed);
							}
						})();
						return preview;
					},
				);

				services.emit({ type: 'compaction-preview', phase: 'end', reason: event.reason });
				return { compaction: result };
			} catch (error) {
				// [喵喵喵]: 失败同 snow-app 语义 —— 取消本次压缩并显示错误横线，不回落
				// SDK 内置压缩（避免用户经历两次摘要消耗），下一轮再试
				services.emit({ type: 'compaction-preview', phase: 'error', reason: event.reason, message: errorMessage(error) });
				return { cancel: true };
			}
		});

		pi.on('session_compact_failed', (event) => {
			// 扩展提供的摘要内容在 SDK 落库阶段失败：UI 已收到 end，这里补一条错误横线
			if (event.fromExtension && !event.aborted) {
				services.emit({ type: 'compaction-preview', phase: 'error', reason: event.reason, message: event.errorMessage ? errorMessage(event.errorMessage) : '压缩写入会话失败' });
			}
		});
	};
}
