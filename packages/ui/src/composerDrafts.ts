import type { UiAttachment } from '@pidesktop/shared';
import { MAX_ATTACHMENTS } from './attachmentPolicy.ts';

export type ComposerDraft = { text: string; attachments: UiAttachment[] };

/** Check the live draft after each read: other drops and removals may finish first. */
export async function appendFileAttachments(
	files: File[],
	read: (file: File) => Promise<UiAttachment>,
	getAttachments: () => UiAttachment[],
	setAttachments: (attachments: UiAttachment[]) => void,
	limitError: () => Error,
): Promise<void> {
	for (const file of files) {
		if (getAttachments().length >= MAX_ATTACHMENTS) throw limitError();
		const attachment = await read(file);
		const current = getAttachments();
		if (current.length >= MAX_ATTACHMENTS) throw limitError();
		setAttachments([...current, attachment]);
	}
}

/** A send acknowledgement must never erase edits made while it was pending. */
export function clearSubmittedDraft(drafts: Map<string, ComposerDraft>, key: string, submitted: ComposerDraft): boolean {
	const current = drafts.get(key);
	if (!current || current.text.trim() !== submitted.text.trim() || current.attachments !== submitted.attachments) return false;
	drafts.set(key, { text: '', attachments: [] });
	return true;
}
