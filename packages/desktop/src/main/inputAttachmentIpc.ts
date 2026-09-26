import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { UiAttachment } from '@pidesktop/shared';
import { INPUT_FEATURE_CHANNELS, type UiInputScope, type UiSaveInputDraft, type UiPdfInputRequest } from '../../../shared/src/inputFeatures.ts';
import { AttachmentStore } from '../../../agent/src/attachmentStore.ts';
import { handleRendererInvoke } from './rendererIpc.ts';
import { PdfInputProcessor } from './pdfInput.ts';

export function registerInputAttachmentIpc(getScope: () => UiInputScope): { dispose(): void; storage: AttachmentStore } {
	const storage = new AttachmentStore(join(getAgentDir(), 'desktop-inputs', 'attachments'));
	const pdf = new PdfInputProcessor();
	const knownScopes = new Set<string>();
	const check = (scope: UiInputScope) => { const active = getScope(); const key = JSON.stringify([scope?.cwd, scope?.sessionPath]); if (scope?.cwd === active.cwd && scope.sessionPath === active.sessionPath) knownScopes.add(key); else if (!knownScopes.has(key)) throw new Error('草稿所属工作区或会话已变化'); };
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.putInputAttachment, (_event, scope: UiInputScope, attachment: UiAttachment) => { check(scope); return storage.put(scope, attachment); });
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.readInputAttachment, (_event, scope: UiInputScope, id: string) => { check(scope); return storage.read(scope, id); });
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.getInputDraft, (_event, scope: UiInputScope) => { check(scope); return storage.getDraft(scope); });
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.saveInputDraft, (_event, request: UiSaveInputDraft) => { check(request); return storage.saveDraft(request); });
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.processPdfInput, (_event, request: UiPdfInputRequest) => pdf.process(request));
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.cancelPdfInput, (_event, id: string) => { if (typeof id !== 'string') throw new Error('PDF请求ID无效'); pdf.cancel(id); });
	return { storage, dispose: () => pdf.dispose() };
}
