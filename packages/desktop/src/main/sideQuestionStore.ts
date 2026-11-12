import { app } from 'electron';
import { join } from 'node:path';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile } from './stateFiles';
import type { UiSideQuestion } from '@pidesktop/shared';

/**
 * 侧问记录：每条会话文件一组，挂在轮次锚点（用户消息 entry id）下。
 *
 * 侧问的问答只存在 pi-desktop 自己的状态文件里；Pi 会话文件永远不含侧问
 * 内容（回答来自一次独立的模型调用，不经转录）。渲染端按「锚点 entry id
 * 在当前可见分支上」过滤——分支切换后，不在可见分支上的记录自然隐藏，
 * 切回时恢复显示。
 */
interface SideQuestionsFile { version: 1; records: Record<string, UiSideQuestion[]> }

const MAX_RECORDS_PER_SESSION = 200;

const isRecord = (value: unknown): value is UiSideQuestion => {
	if (!value || typeof value !== 'object') return false;
	const record = value as Partial<UiSideQuestion>;
	return typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 128
		&& typeof record.anchorEntryId === 'string' && record.anchorEntryId.length > 0 && record.anchorEntryId.length <= 512
		&& typeof record.question === 'string'
		&& (record.answer === null || typeof record.answer === 'string')
		&& (record.status === 'running' || record.status === 'done' || record.status === 'error')
		&& typeof record.modelProvider === 'string' && typeof record.modelId === 'string'
		&& (record.modelName === null || typeof record.modelName === 'string')
		&& typeof record.contextTruncated === 'boolean'
		&& typeof record.createdAt === 'number' && Number.isFinite(record.createdAt);
};

const isFile = (value: unknown): value is SideQuestionsFile => Boolean(value && typeof value === 'object'
	&& (value as Partial<SideQuestionsFile>).version === 1
	&& ((value as Partial<SideQuestionsFile>).records ?? null) !== null
	&& Object.entries((value as Partial<SideQuestionsFile>).records as Record<string, unknown>)
		.every(([path, records]) => typeof path === 'string' && path.length > 0
			&& Array.isArray(records) && (records as unknown[]).every(isRecord)));

export class SideQuestionStore {
	private readonly path: string;
	private records: Record<string, UiSideQuestion[]>;
	private lastWritten = '';

	constructor(path: string) {
		this.path = path;
		let stored: SideQuestionsFile;
		try {
			stored = readStateFile(path, () => ({ version: 1, records: {} }), isFile);
		} catch (error) {
			if (error instanceof CorruptStateFileError) {
				// Back the damaged bytes up first (same policy as the other state
				// files) so a later write cannot overwrite what could not be read.
				try {
					const backup = backupCorruptStateFile(path);
					console.warn(`损坏的侧问记录已备份到 ${backup}`);
				} catch (backupError) {
					console.error('备份损坏的侧问记录失败：', backupError);
				}
			} else {
				console.error('Failed to read side questions:', error);
			}
			stored = { version: 1, records: {} };
		}
		this.records = stored.records;
		this.lastWritten = JSON.stringify(stored);
	}

	/** One conversation's records, oldest first. */
	list(sessionPath: string): UiSideQuestion[] {
		return [...this.records[sessionPath] ?? []].sort((left, right) => left.createdAt - right.createdAt);
	}

	/** Upserts one record (same id replaces); a deleted record must not resurrect. */
	record(sessionPath: string, entry: UiSideQuestion): void {
		if (!sessionPath) return;
		const current = this.records[sessionPath] ?? [];
		const index = current.findIndex((item) => item.id === entry.id);
		if (index >= 0) current.splice(index, 1, entry);
		else {
			current.push(entry);
			// Bound the per-conversation record set; oldest asks drop off first.
			if (current.length > MAX_RECORDS_PER_SESSION) current.sort((left, right) => left.createdAt - right.createdAt).splice(0, current.length - MAX_RECORDS_PER_SESSION);
		}
		this.records[sessionPath] = current;
		this.persist();
	}

	/** True when the record was removed (false when it never existed). */
	remove(sessionPath: string, id: string): boolean {
		const current = this.records[sessionPath];
		if (!current) return false;
		const index = current.findIndex((item) => item.id === id);
		if (index < 0) return false;
		current.splice(index, 1);
		if (current.length === 0) delete this.records[sessionPath];
		this.persist();
		return true;
	}

	/** Forgets a conversation entirely (session deletion). */
	clear(sessionPath: string): void {
		if (this.records[sessionPath] === undefined) return;
		delete this.records[sessionPath];
		this.persist();
	}

	private persist(): void {
		const file: SideQuestionsFile = { version: 1, records: this.records };
		const serialized = JSON.stringify(file);
		if (serialized === this.lastWritten) return;
		try {
			writeStateFile(this.path, file);
			this.lastWritten = serialized;
		} catch (error) {
			console.error('Failed to record side questions:', error);
		}
	}
}

let store: SideQuestionStore | null = null;

/** Lazily created singleton; all windows of this process share one record. */
export function sideQuestionStore(): SideQuestionStore {
	return store ??= new SideQuestionStore(join(app.getPath('userData'), 'side-questions.json'));
}
