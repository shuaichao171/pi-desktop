import type { UiAttachment } from '@pidesktop/shared';
import type { InputFeatureBridge, UiInputScope, UiStoredAttachment } from '../../shared/src/inputFeatures';
import type { ComposerDraft } from './composerDrafts';

type Entry = { version: number; refs: WeakMap<UiAttachment, string>; loading?: Promise<{ draft: ComposerDraft; missing: UiStoredAttachment[] }>; requested?: ComposerDraft; saving?: Promise<void> };
export class PersistedComposerDrafts {
	private readonly entries = new Map<string, Entry>();
	private readonly bridge: InputFeatureBridge;
	constructor(bridge: InputFeatureBridge) { this.bridge = bridge; }
	private entry(scope: UiInputScope): Entry { const key = JSON.stringify(scope); let entry = this.entries.get(key); if (!entry) { entry = { version: 0, refs: new WeakMap() }; this.entries.set(key, entry); } return entry; }
	load(scope: UiInputScope): Promise<{ draft: ComposerDraft; missing: UiStoredAttachment[] }> {
		const entry = this.entry(scope);
		return entry.loading ??= this.bridge.getInputDraft(scope).then(async (snapshot) => {
			entry.version = snapshot.version; const attachments: UiAttachment[] = [], missing: UiStoredAttachment[] = [];
			for (const ref of snapshot.attachments) {
				try { const attachment = await this.bridge.readInputAttachment(scope, ref.id); entry.refs.set(attachment, ref.id); attachments.push(attachment); }
				catch { missing.push(ref); }
			}
			return { draft: { text: snapshot.text, attachments }, missing };
		}).catch((error: unknown) => { entry.loading = undefined; throw error; });
	}
	save(scope: UiInputScope, draft: ComposerDraft): Promise<void> {
		const entry = this.entry(scope); entry.requested = draft;
		return entry.saving ??= (async () => {
			await this.load(scope);
			while (entry.requested) {
				const next = entry.requested; entry.requested = undefined;
				const attachmentIds: string[] = [];
				for (const attachment of next.attachments) {
					let id = entry.refs.get(attachment);
					if (!id) { const ref = await this.bridge.putInputAttachment(scope, attachment); id = ref.id; entry.refs.set(attachment, id); }
					attachmentIds.push(id);
				}
				const saved = await this.bridge.saveInputDraft({ ...scope, text: next.text, attachmentIds, expectedVersion: entry.version }); entry.version = saved.version;
			}
		})().finally(() => { entry.saving = undefined; });
	}
}
