import type { UiSideQuestionAskRequest } from '@pidesktop/shared';

/**
 * 侧问（side question）：一次独立的旁路模型调用。
 *
 * 与 nextInputSuggestion / generateCommitMessage 同构：completeSimple 直连
 * 供应商，不经过会话转录，主对话上下文因此结构性不含侧问内容。纯辅助
 * （系统提示词、提示词拼装、答案清理）集中在这里，便于脱离模型测试。
 */

/** 侧问是一次性小问答；超时比完整回合短，比 next-input 建议长。 */
export const SIDE_QUESTION_TIMEOUT_MS = 180_000;

export const SIDE_QUESTION_SYSTEM_PROMPT = [
	'你在一个 AI 编程助手桌面应用的「侧问」通道里回答问题。',
	'用户正在阅读一段对话记录，并针对其中某一轮提出了一个旁路问题。',
	'规则：',
	'- 只依据给出的对话片段回答，不要假设未出现的上下文；片段之外需要的信息就直说看不到。',
	'- 用提问使用的语言回答；直接给答案，不要复述问题。',
	'- 简洁为主：通常几句话到一小段；需要代码或命令时给最小可用片段（Markdown）。',
	'- 侧问不会进入主对话：不要建议「让我来修改」「我们继续」这类主对话式的行动。',
	'- 你的回答只展示给提问者本人，作为对话旁的折叠卡片。',
].join('\n');

/** Assembles the single user message: quoted context slice, then the question. */
export function buildSideQuestionPrompt(request: Pick<UiSideQuestionAskRequest, 'context' | 'question'>): string {
	const context = request.context.trim();
	const quoted = context ? `以下是对话中该轮次附近的片段（可能被截断）：\n\n<<<CONVERSATION\n${context}\nCONVERSATION\n\n` : '';
	return `${quoted}用户针对这个轮次的旁路问题：${request.question.trim()}`;
}

/** Keeps the model answer as-is except for whitespace and a stray full-body code fence. */
export function cleanSideQuestionAnswer(raw: string): string {
	return raw.trim()
		.replace(/^```[a-z]*\n?/i, '')
		.replace(/\n?```$/, '')
		.trim();
}
