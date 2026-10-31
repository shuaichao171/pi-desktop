import { memo, useLayoutEffect, useRef } from 'react';
import { ConversationMarkdown } from './ConversationMarkdown';
import { Icon } from './Icons';
import { useChatStore } from '../store';
import { useT } from '../i18n';

/**
 * 压缩过程可见化（snow-app CompactionStream 同款样式）：
 * - 压缩中：圆角卡片 + 标题栏（压缩图标 +「正在生成上下文摘要」）+ 流式 Markdown 主体；
 *   摘要生成是后台独立请求，内容边生成边显示，正文不动。
 * - 未产出首个字符前显示三条灰色扫掠占位动画。
 * - 失败：同款警告横线（两侧细线 + 警告图标 + 小字 + 关闭），不阻断阅读，保留至用户关闭。
 * 成功后本卡片消失，压缩条目由既有系统行摘要卡（可折叠）接棒展示。
 */
export const CompactionStream = memo(function CompactionStream() {
	const { t } = useT();
	const preview = useChatStore((s) => s.compactionPreview);
	const error = useChatStore((s) => s.compactionError);
	const dismiss = useChatStore((s) => s.dismissCompactionError);
	const bodyRef = useRef<HTMLDivElement>(null);

	// 同款行为：摘要增量到达时保持滚动到卡片底部
	useLayoutEffect(() => {
		if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
	}, [preview?.text]);

	if (!preview && !error) return null;

	return (
		<>
			{preview ? (
				<section className="pd-compaction-stream" aria-live="polite">
					<header className="pd-compaction-stream-title">
						<span className="pd-compaction-stream-icon" aria-hidden="true">
							<Icon name="minimize" width={15} height={15} />
						</span>
						<span className="pd-compaction-stream-heading">{t('compaction.generating')}</span>
					</header>
					<div className="pd-compaction-stream-body" ref={bodyRef}>
						{preview.text ? (
							<ConversationMarkdown>{preview.text}</ConversationMarkdown>
						) : (
							<div className="pd-compaction-placeholder" aria-hidden="true">
								<span />
								<span />
								<span />
							</div>
						)}
					</div>
				</section>
			) : null}
			{error ? (
				// [喵喵喵]: 失败横线沿用 snow-app 语义——弱化呈现不占注意力，本轮压缩已取消，
				// 达到阈值会再次触发，所以只提示不提供重试按钮
				<div className="pd-compaction-notice" role="alert">
					<span className="pd-compaction-notice-rule" aria-hidden="true" />
					<span className="pd-compaction-notice-label" title={error}>
						<Icon name="alert" width={13} height={13} />
						<span className="pd-compaction-notice-text">{error}</span>
					</span>
					<button type="button" className="pd-compaction-notice-close" onClick={dismiss} title={t('common.close')} aria-label={t('common.close')}>
						<Icon name="close" width={12} height={12} />
					</button>
					<span className="pd-compaction-notice-rule" aria-hidden="true" />
				</div>
			) : null}
		</>
	);
});
