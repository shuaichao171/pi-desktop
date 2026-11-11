import { app } from 'electron';
import { join } from 'node:path';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile } from './stateFiles';

/**
 * Last-viewed branch leaf per conversation file (selectedChild persistence).
 *
 * Pi sessions are append-only entry trees and always reload onto the
 * last-appended branch, so a purely viewed (older) branch would be lost on
 * restart. pi-desktop keeps its own record — one leaf entry id per session
 * path — and the renderer reapplies it after a session's first ready. The Pi
 * session file itself is never touched.
 */
interface ConversationBranchFile { version: 1; selections: Record<string, string> }

const isFile = (value: unknown): value is ConversationBranchFile => Boolean(value && typeof value === 'object'
	&& (value as Partial<ConversationBranchFile>).version === 1
	&& (value as Partial<ConversationBranchFile>).selections !== undefined
	&& ((value as Partial<ConversationBranchFile>).selections as Record<string, unknown>) !== null
	&& Object.entries((value as Partial<ConversationBranchFile>).selections as Record<string, unknown>)
		.every(([path, leaf]) => typeof path === 'string' && path.length > 0 && typeof leaf === 'string' && leaf.length > 0));

export class ConversationBranchStore {
	private readonly path: string;
	private selections: Record<string, string>;
	private lastWritten = '';

	constructor(path: string) {
		this.path = path;
		let stored: ConversationBranchFile;
		try {
			stored = readStateFile(path, () => ({ version: 1, selections: {} }), isFile);
		} catch (error) {
			if (error instanceof CorruptStateFileError) {
				// Do not allow a later record() write to overwrite bytes we could not
				// preserve: back the damaged file up first (same policy as the other
				// state files), then continue with an empty record.
				try {
					const backup = backupCorruptStateFile(path);
					console.warn(`损坏的会话分支记录已备份到 ${backup}`);
				} catch (backupError) {
					console.error('备份损坏的会话分支记录失败：', backupError);
				}
			} else {
				console.error('Failed to read conversation branch selections:', error);
			}
			stored = { version: 1, selections: {} };
		}
		this.selections = stored.selections;
		this.lastWritten = JSON.stringify(stored);
	}

	/** Leaf entry id remembered for a conversation file, if any. */
	get(sessionPath: string): string | null {
		return this.selections[sessionPath] ?? null;
	}

	/** Records (null clears) the leaf to restore on the next load. */
	record(sessionPath: string, leafId: string | null): void {
		if (!sessionPath || (!leafId && this.selections[sessionPath] === undefined)) return;
		if (leafId) this.selections[sessionPath] = leafId;
		else delete this.selections[sessionPath];
		this.persist();
	}

	/** Forgets a conversation entirely (session deletion). */
	clear(sessionPath: string): void {
		if (this.selections[sessionPath] === undefined) return;
		delete this.selections[sessionPath];
		this.persist();
	}

	private persist(): void {
		const file: ConversationBranchFile = { version: 1, selections: this.selections };
		const serialized = JSON.stringify(file);
		if (serialized === this.lastWritten) return;
		try {
			writeStateFile(this.path, file);
			this.lastWritten = serialized;
		} catch (error) {
			console.error('Failed to record conversation branch selection:', error);
		}
	}
}

let store: ConversationBranchStore | null = null;

/** Lazily created singleton; all windows of this process share one record. */
export function conversationBranchStore(): ConversationBranchStore {
	return store ??= new ConversationBranchStore(join(app.getPath('userData'), 'conversation-branches.json'));
}
