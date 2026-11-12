import type { UiModelSummary } from './index';

/**
 * 侧问（side question）：挂在某条消息轮次下的一次性旁路问答。
 *
 * 借鉴 Claude Desktop 的 side_question：用父消息附近的上下文回答一个问题，
 * 答案挂在那个轮次下方展示，但**绝不进入主对话上下文**。与临时 Pi 会话方案
 * 不同，pi-desktop 用一次独立的模型调用（completeSimple，同 generateCommitMessage
 * / suggestNextInput 的先例）回答——不创建会话文件、不写转录，主会话隔离是
 * 结构性保证。
 */

export const SIDE_QUESTION_CHANNELS = {
	list: 'side-questions:list',
	ask: 'side-questions:ask',
	delete: 'side-questions:delete',
	changed: 'side-questions:changed',
} as const;

export type UiSideQuestionStatus = 'running' | 'done' | 'error';

/** One persisted aside question with its answer, anchored on a turn. */
export interface UiSideQuestion {
	id: string;
	/** Session file the record belongs to (records never enter the Pi session itself). */
	sessionPath: string;
	/** Entry id of the user message anchoring the turn the aside hangs on. */
	anchorEntryId: string;
	question: string;
	/** Model answer in Markdown; null while running or after a failure. */
	answer: string | null;
	status: UiSideQuestionStatus;
	/** Failure text for the last run (status 'error' only). */
	error?: string;
	modelProvider: string;
	modelId: string;
	modelName: string | null;
	/** True when the context slice dropped or clipped text to fit the budget. */
	contextTruncated: boolean;
	createdAt: number;
	finishedAt: number | null;
}

/** Agent-side reply to an aside ask: the answer plus the model that actually ran. */
export interface UiSideQuestionAnswer {
	answer: string;
	modelProvider: string;
	modelId: string;
	modelName: string | null;
}

/** Renderer → main ask request; the context slice is built renderer-side from the loaded transcript. */
export interface UiSideQuestionAskRequest {
	/** Client-generated identity: optimistic UI updates replace the record with the same id. */
	id: string;
	sessionPath: string;
	anchorEntryId: string;
	question: string;
	/** Visible-branch slice around the anchor turn, already within the size budget. */
	context: string;
	contextTruncated: boolean;
	/** Selected model; omitted falls back to the conversation's current model. */
	model?: Pick<UiModelSummary, 'provider' | 'id' | 'name'>;
}

export function requireSideQuestionAskRequest(value: unknown): UiSideQuestionAskRequest {
	const request = value as Partial<UiSideQuestionAskRequest> | null | undefined;
	if (!request || typeof request !== 'object') throw new Error('侧问请求无效');
	const identifier = (input: unknown, what: string, max: number): string => {
		if (typeof input !== 'string' || !input.trim() || input.length > max || /[\u0000-\u001f\u007f]/.test(input)) throw new Error(`侧问${what}无效`);
		return input;
	};
	identifier(request.id, '标识', 128);
	identifier(request.anchorEntryId, '锚点', 512);
	identifier(request.sessionPath, '会话', 32_768);
	if (typeof request.question !== 'string' || !request.question.trim() || request.question.length > 8_192 || request.question.includes('\0')) throw new Error('侧问内容无效或过长');
	if (typeof request.context !== 'string' || request.context.length > 64_000 || request.context.includes('\0')) throw new Error('侧问上下文无效或过长');
	if (typeof request.contextTruncated !== 'boolean') throw new Error('侧问上下文标记无效');
	if (request.model !== undefined && (typeof request.model?.provider !== 'string' || typeof request.model?.id !== 'string'
		|| typeof request.model?.name !== 'string' || request.model.provider.length > 80 || request.model.id.length > 200 || request.model.name.length > 200)) throw new Error('侧问模型无效');
	return request as UiSideQuestionAskRequest;
}

/** Added to AgentBridge by the main integration; records live in pi-desktop's own storage. */
export interface SideQuestionFeatureBridge {
	/** Persisted records of one conversation, oldest first. */
	listSideQuestions(sessionPath: string): Promise<UiSideQuestion[]>;
	/** Runs the aside model call and persists the record; resolves with the settled record. */
	askSideQuestion(request: UiSideQuestionAskRequest): Promise<UiSideQuestion>;
	/** Removes one record (its in-flight run, if any, is abandoned). */
	deleteSideQuestion(sessionPath: string, id: string): Promise<void>;
	/** Push: records of a conversation changed (asked elsewhere, settled, deleted). */
	onSideQuestionsChanged?(listener: (sessionPath: string, records: UiSideQuestion[]) => void): () => void;
}
