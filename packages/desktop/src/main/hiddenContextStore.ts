import { app } from 'electron';
import { join } from 'node:path';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile } from './stateFiles';
import { HIDDEN_CONTEXT_MAX_CHARS } from '@pidesktop/shared';

/**
 * 会话隐藏上下文：每个会话文件一份多行指令文本。
 *
 * 与 conversationBranchStore / sideQuestionStore 相同的存储模式：pi-desktop
 * 自有 JSON（键 = 规范化 sessionPath，见 sessionPaths.normalizeSessionPath），
 * 损坏先备份再重建；Pi 会话文件永远不含这份设置本身。渲染端按会话读写，
 * agent host 只读同一文件（注入时按当前 sessionPath 取值，见
 * packages/agent/src/hiddenContext.ts）。
 */
interface HiddenContextFile { version: 1; contexts: Record<string, string> }

const isFile = (value: unknown): value is HiddenContextFile => Boolean(value && typeof value === 'object'
	&& (value as Partial<HiddenContextFile>).version === 1
	&& ((value as Partial<HiddenContextFile>).contexts ?? null) !== null
	&& Object.entries((value as Partial<HiddenContextFile>).contexts as Record<string, unknown>)
		.every(([path, text]) => typeof path === 'string' && path.length > 0 && typeof text === 'string'));

export class HiddenContextStore {
	private readonly path: string;
	private contexts: Record<string, string>;
	private lastWritten = '';

	constructor(path: string) {
		this.path = path;
		let stored: HiddenContextFile;
		try {
			stored = readStateFile(path, () => ({ version: 1, contexts: {} }), isFile);
		} catch (error) {
			if (error instanceof CorruptStateFileError) {
				// Back the damaged bytes up first (same policy as the other state
				// files) so a later write cannot overwrite what could not be read.
				try {
					const backup = backupCorruptStateFile(path);
					console.warn(`损坏的隐藏上下文已备份到 ${backup}`);
				} catch (backupError) {
					console.error('备份损坏的隐藏上下文失败：', backupError);
				}
			} else {
				console.error('Failed to read hidden context:', error);
			}
			stored = { version: 1, contexts: {} };
		}
		this.contexts = stored.contexts;
		this.lastWritten = JSON.stringify(stored);
	}

	/** One conversation's instruction text ('' when none). */
	get(sessionPath: string): string {
		return this.contexts[sessionPath] ?? '';
	}

	/** Records (empty or blank-only string clears) one conversation's instruction. */
	record(sessionPath: string, text: string): void {
		if (!sessionPath || typeof text !== 'string') return;
		// Blank-only text clears: the injector and the indicator both treat a
		// whitespace-only instruction as "none", so the store must not keep one.
		const trimmed = text.trim() ? text.slice(0, HIDDEN_CONTEXT_MAX_CHARS) : '';
		if (trimmed) this.contexts[sessionPath] = trimmed;
		else if (this.contexts[sessionPath] === undefined) return;
		else delete this.contexts[sessionPath];
		this.persist();
	}

	/** Forgets a conversation entirely (session deletion). */
	clear(sessionPath: string): void {
		if (this.contexts[sessionPath] === undefined) return;
		delete this.contexts[sessionPath];
		this.persist();
	}

	private persist(): void {
		const file: HiddenContextFile = { version: 1, contexts: this.contexts };
		const serialized = JSON.stringify(file);
		if (serialized === this.lastWritten) return;
		try {
			writeStateFile(this.path, file);
			this.lastWritten = serialized;
		} catch (error) {
			console.error('Failed to record hidden context:', error);
		}
	}
}

let store: HiddenContextStore | null = null;

/** Lazily created singleton; all windows of this process share one record. */
export function hiddenContextStore(): HiddenContextStore {
	return store ??= new HiddenContextStore(hiddenContextStorePath());
}

/** The shared file path; the agent host reads the same file through the fork env. */
export function hiddenContextStorePath(): string {
	return join(app.getPath('userData'), 'hidden-context.json');
}
