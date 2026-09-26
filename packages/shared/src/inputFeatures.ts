import type { UiAttachment, UiQueuedMessage } from './index';

export const INPUT_FEATURE_CHANNELS = {
	submitInput: 'agent:submit-input', getInputQueue: 'agent:input-queue', mutateInputQueue: 'agent:mutate-input-queue',
	putInputAttachment: 'input:put-attachment', readInputAttachment: 'input:read-attachment', getInputDraft: 'input:get-draft', saveInputDraft: 'input:save-draft',
	processPdfInput: 'input:process-pdf', cancelPdfInput: 'input:cancel-pdf',
} as const;

export interface UiInputScope { cwd: string; sessionPath: string | null }
/** Every renderer queue read/write is bound to the exact active conversation. */
export interface UiInputQueueScope extends UiInputScope { sessionId: string }
export function requireInputQueueScope(value: unknown): UiInputQueueScope {
	const scope = value as Partial<UiInputQueueScope> | null | undefined;
	const validPath = (path: unknown): path is string => typeof path === 'string' && Boolean(path.trim()) && path.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(path);
	if (!scope || !validPath(scope.cwd) || scope.sessionPath !== null && !validPath(scope.sessionPath)
		|| typeof scope.sessionId !== 'string' || !scope.sessionId.trim() || scope.sessionId.length > 1024 || /[\u0000-\u001f\u007f]/.test(scope.sessionId)) throw new Error('输入队列所属会话信息无效');
	return scope as UiInputQueueScope;
}
export interface UiStoredAttachment {
	id: string; version: 1; kind: 'image' | 'text'; name: string; mimeType: string; size: number;
}
export interface UiInputDraft { version: number; text: string; attachments: UiStoredAttachment[]; missing: string[] }
export interface UiSaveInputDraft extends UiInputScope { expectedVersion: number; text: string; attachmentIds: string[] }
export interface UiSubmitInput { id: string; sessionId: string; text: string; behavior?: 'steer' | 'followUp'; attachments?: UiAttachment[] }
export interface UiInputReceipt { id: string; state: 'accepted' | 'reserved' | 'consumed' | 'recovered' | 'failed'; message?: string }
/** Editing keeps the original text/attachment metadata visible while withholding delivery. */
export interface UiInputQueueItem extends UiQueuedMessage { version: number; state: UiInputReceipt['state'] | 'editing'; message?: string }
export interface UiInputQueue { version: number; paused: boolean; items: UiInputQueueItem[]; scope?: UiInputQueueScope }
export interface UiInputQueueMutation {
	/** Required by renderer IPC; internal callers may omit it. */
	scope?: UiInputQueueScope;
	/** beginEdit holds one entry; edit saves its text; cancelEdit restores the original payload. */
	requestId: string; expectedVersion: number; action: 'beginEdit' | 'cancelEdit' | 'edit' | 'remove' | 'steer' | 'move' | 'pause' | 'resume' | 'confirm';
	id?: string; text?: string; beforeId?: string | null;
}
export interface UiPdfInputRequest { requestId: string; name: string; data: string }
export interface UiPdfInputResult { attachment: Extract<UiAttachment, { kind: 'text' }>; pageCount: number; scannedPages: number[]; truncated: boolean }
/** Added to AgentBridge by the main integration; every scope is checked against the active workspace. */
export interface InputFeatureBridge {
	submitInput(request: UiSubmitInput): Promise<UiInputReceipt>;
	getInputQueue(scope?: UiInputQueueScope): Promise<UiInputQueue>;
	mutateInputQueue(request: UiInputQueueMutation): Promise<UiInputQueue>;
	putInputAttachment(scope: UiInputScope, attachment: UiAttachment): Promise<UiStoredAttachment>;
	readInputAttachment(scope: UiInputScope, id: string): Promise<UiAttachment>;
	getInputDraft(scope: UiInputScope): Promise<UiInputDraft>;
	saveInputDraft(request: UiSaveInputDraft): Promise<UiInputDraft>;
	processPdfInput(request: UiPdfInputRequest): Promise<UiPdfInputResult>;
	cancelPdfInput(requestId: string): Promise<void>;
}
