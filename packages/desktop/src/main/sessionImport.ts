import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RecoverableSessionMetadata, SessionImportResult } from '../../../shared/src/dataFeatures';
import { writeStateFileAsync } from './stateFiles.ts';

export const NATIVE_SESSION_LIMIT = 64 * 1024 * 1024;
export const COMPLETE_BACKUP_LIMIT = 256 * 1024 * 1024;
type NativeRecord = Record<string, unknown>;
export type ValidatedNativeSession = { header: NativeRecord & { id: string; cwd: string }; records: NativeRecord[]; raw: string };
export type BackupSource = { path: string; cwd: string; metadata?: RecoverableSessionMetadata };
export interface CompleteSessionBackup {
	format: 'pi-desktop-backup'; version: 1; createdAt: string;
	sessions: Array<{ sourcePath: string; cwd: string; metadata?: RecoverableSessionMetadata; jsonl: string }>;
	attachmentPolicy: 'embedded-content-and-historical-source-references';
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is NativeRecord { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/u.test(value); }
export function validateNativeSession(raw: string): ValidatedNativeSession {
	if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > NATIVE_SESSION_LIMIT || raw.includes('\0')) throw new Error('会话文件超过 64 MiB 或包含无效内容');
	const lines = raw.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.trim());
	if (!lines.length || lines.length > 100_001) throw new Error('会话条目数量无效');
	const records: NativeRecord[] = [];
	for (const line of lines) {
		if (Buffer.byteLength(line, 'utf8') > 20 * 1024 * 1024) throw new Error('单个会话条目超过 20 MiB');
		let value: unknown;
		try { value = JSON.parse(line); } catch { throw new Error(`会话第 ${records.length + 1} 行 JSON 无效`); }
		if (!record(value) || typeof value.type !== 'string') throw new Error('会话条目格式无效');
		records.push(value);
	}
	const header = records[0]!;
	if (header.type !== 'session' || !identity(header.id) || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || header.cwd.includes('\0')) throw new Error('会话头身份或工作区无效');
	const version = header.version === undefined ? 1 : header.version;
	if (version !== 1 && version !== 2 && version !== 3) throw new Error('不支持此 Pi 会话版本');
	const ids = new Set<string>();
	for (const entry of records.slice(1)) {
		if (entry.type === 'session') throw new Error('会话包含多个文件头');
		if (version !== 1) {
			if (!identity(entry.id) || ids.has(entry.id)) throw new Error('会话条目身份缺失或重复');
			if (entry.parentId !== null && (!identity(entry.parentId) || !ids.has(entry.parentId))) throw new Error('会话分支父节点缺失、循环或顺序无效');
			ids.add(entry.id);
		}
		if (entry.type === 'message' && (!record(entry.message) || typeof entry.message.role !== 'string'
			|| entry.message.content !== undefined && typeof entry.message.content !== 'string' && !Array.isArray(entry.message.content))) throw new Error('会话消息格式无效');
	}
	return { header: header as ValidatedNativeSession['header'], records, raw };
}
function cleanMetadata(value: unknown): RecoverableSessionMetadata | undefined {
	if (value === undefined) return undefined;
	if (!record(value)) throw new Error('备份桌面元数据无效');
	const result: RecoverableSessionMetadata = {};
	for (const key of ['pinned', 'archived', 'unread'] as const) {
		if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('备份桌面标记无效');
		if (typeof value[key] === 'boolean') result[key] = value[key];
	}
	if (value.order !== undefined) {
		if (typeof value.order !== 'number' || !Number.isInteger(value.order) || Math.abs(value.order) > 1e9) throw new Error('备份排序无效');
		result.order = value.order;
	}
	if (value.group !== undefined) {
		if (!record(value.group) || !identity(value.group.id) || typeof value.group.name !== 'string' || !value.group.name.trim() || value.group.name.length > 80
			|| typeof value.group.index !== 'number' || !Number.isInteger(value.group.index) || value.group.index < 0) throw new Error('备份分组无效');
		result.group = { id: value.group.id, name: value.group.name.trim(), index: value.group.index };
	}
	return result;
}
export async function readBoundedImport(path: string, format: 'native' | 'backup'): Promise<string> {
	const file = await open(path, 'r');
	try {
		const details = await file.stat();
		const limit = format === 'native' ? NATIVE_SESSION_LIMIT : COMPLETE_BACKUP_LIMIT;
		if (!details.isFile() || details.size > limit) throw new Error(`导入文件超过 ${limit / 1024 / 1024} MiB 或不是普通文件`);
		const chunks: Buffer[] = []; let size = 0;
		for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
			size += chunk.length; if (size > limit) throw new Error('导入文件读取期间超过大小上限'); chunks.push(chunk);
		}
		try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new Error('导入文件不是有效 UTF-8'); }
	} finally { await file.close(); }
}
export async function createCompleteBackup(sources: BackupSource[]): Promise<CompleteSessionBackup> {
	if (!Array.isArray(sources) || sources.length > 5000) throw new Error('备份会话数量超过上限');
	const sessions: CompleteSessionBackup['sessions'] = [];
	let bytes = 0;
	for (const source of sources) {
		const jsonl = await readBoundedImport(source.path, 'native');
		const native = validateNativeSession(jsonl);
		if (resolve(native.header.cwd) !== resolve(source.cwd)) throw new Error('备份会话工作区不匹配');
		bytes += Buffer.byteLength(jsonl); if (bytes > COMPLETE_BACKUP_LIMIT - 1024 * 1024) throw new Error('完整备份超过 256 MiB，请减少会话数量');
		sessions.push({ sourcePath: source.path, cwd: source.cwd, metadata: cleanMetadata(source.metadata), jsonl });
	}
	const backup: CompleteSessionBackup = { format: 'pi-desktop-backup', version: 1, createdAt: new Date().toISOString(), sessions,
		attachmentPolicy: 'embedded-content-and-historical-source-references' };
	if (Buffer.byteLength(JSON.stringify(backup)) > COMPLETE_BACKUP_LIMIT) throw new Error('完整备份编码后超过 256 MiB');
	return backup;
}
export function validateCompleteBackup(raw: string): CompleteSessionBackup {
	if (Buffer.byteLength(raw) > COMPLETE_BACKUP_LIMIT) throw new Error('完整备份超过 256 MiB');
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error('完整备份 JSON 无效'); }
	if (!record(value) || value.format !== 'pi-desktop-backup' || value.version !== 1) throw new Error('不是支持的完整备份格式（version 1）');
	if (!Array.isArray(value.sessions) || value.sessions.length < 1 || value.sessions.length > 5000 || value.attachmentPolicy !== 'embedded-content-and-historical-source-references') throw new Error('完整备份清单无效');
	const sessions: CompleteSessionBackup['sessions'] = [], paths = new Set<string>();
	for (const item of value.sessions) {
		if (!record(item) || typeof item.jsonl !== 'string' || typeof item.cwd !== 'string' || !isAbsolute(item.cwd) || typeof item.sourcePath !== 'string' || !isAbsolute(item.sourcePath) || paths.has(item.sourcePath)) throw new Error('完整备份会话来源无效或重复');
		paths.add(item.sourcePath);
		const native = validateNativeSession(item.jsonl);
		if (resolve(native.header.cwd) !== resolve(item.cwd)) throw new Error('完整备份工作区与会话头不匹配');
		sessions.push({ sourcePath: item.sourcePath, cwd: item.cwd, metadata: cleanMetadata(item.metadata), jsonl: item.jsonl });
	}
	return { format: 'pi-desktop-backup', version: 1, createdAt: String(value.createdAt), sessions, attachmentPolicy: 'embedded-content-and-historical-source-references' };
}
type ImportPlan = { path: string; id: string; checksum: string };
type ImportJournal = { version: 1; fingerprint: string; cwd: string; state: 'pending' | 'complete'; plans: ImportPlan[] };
export function createSessionImporter(options: {
	sessionsRoot: () => string; journalRoot: () => string;
	applyMetadata(items: Array<{ path: string; metadata?: RecoverableSessionMetadata }>): Promise<void>;
	rollbackMetadata?(paths: string[]): Promise<void>;
	/** Failure injection at the exclusive commit boundary. */
	commit?: typeof link;
}) {
	let queue: Promise<void> = Promise.resolve();
	return {
		import(raw: string, format: 'native' | 'backup', cwd: string): Promise<SessionImportResult> {
			const result = queue.then(async () => {
				if (format !== 'native' && format !== 'backup' || typeof cwd !== 'string' || !isAbsolute(cwd) || !(await lstat(cwd)).isDirectory()) throw new Error('请选择有效的目标工作区');
				const items = format === 'native' ? [{ jsonl: validateNativeSession(raw).raw, metadata: undefined }] : validateCompleteBackup(raw).sessions;
				// Validate every item before creating a journal, directory or session file.
				const parsed = items.map((item) => validateNativeSession(item.jsonl));
				const fingerprint = hash(`${format}\n${resolve(cwd)}\n${raw}`), journalPath = join(options.journalRoot(), `${fingerprint}.json`);
				const directory = join(options.sessionsRoot(), `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
				let journal: ImportJournal | undefined;
				try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('导入记录损坏，请保留记录并检查数据'); }
				if (journal && (journal.version !== 1 || journal.fingerprint !== fingerprint || journal.cwd !== cwd || journal.plans.length !== items.length
					|| journal.plans.some((plan) => dirname(plan.path) !== directory || !identity(plan.id)))) throw new Error('导入事务记录无效');
				if (!journal) {
					journal = { version: 1, fingerprint, cwd, state: 'pending', plans: parsed.map(() => {
						const id = randomUUID(); return { id, path: join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`), checksum: '' };
					}) };
				}
				const bodies = parsed.map((session, index) => [{ ...session.header, id: journal!.plans[index]!.id, cwd }, ...session.records.slice(1)].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
				for (let index = 0; index < bodies.length; index++) journal.plans[index]!.checksum = hash(bodies[index]!);
				const existing = await Promise.all(journal.plans.map(async (plan) => {
					try {
						const contents = await readBoundedImport(plan.path, 'native');
						const native = validateNativeSession(contents);
						if (journal!.state === 'complete' ? native.header.id !== plan.id || native.header.cwd !== cwd : hash(contents) !== plan.checksum) throw new Error('导入目标身份冲突，未覆盖现有会话');
						return true;
					}
					catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
				}));
				if (journal.state === 'complete') {
					if (!existing.every(Boolean)) throw new Error('这份文件以前已导入，但部分会话已移动或删除；请先检查回收站');
					return { paths: journal.plans.map((plan) => plan.path), cwd, duplicate: true, warnings: [] };
				}
				await writeStateFileAsync(journalPath, journal);
				await mkdir(directory, { recursive: true });
				const created: string[] = [];
				let metadataPaths: string[] | undefined;
				try {
					for (let index = 0; index < journal.plans.length; index++) {
						if (existing[index]) continue;
						const plan = journal.plans[index]!, temporary = join(directory, `.import-${randomUUID()}.tmp`);
						try {
							const file = await open(temporary, 'wx', 0o600);
							try { await file.writeFile(bodies[index]!, 'utf8'); await file.sync(); } finally { await file.close(); }
							await (options.commit ?? link)(temporary, plan.path); created.push(plan.path);
						} finally { await rm(temporary, { force: true }); }
					}
					metadataPaths = journal.plans.map(plan => plan.path);
					await options.applyMetadata(journal.plans.map((plan, index) => ({ path: plan.path, metadata: items[index]!.metadata })));
					journal.state = 'complete'; await writeStateFileAsync(journalPath, journal);
				} catch (error) {
					const rollbackErrors: unknown[] = [];
					try { await options.rollbackMetadata?.(metadataPaths ?? created); } catch (failure) { rollbackErrors.push(failure); }
					// A metadata failure must not leave newly imported JSONL files half committed.
					for (const path of created) try { await rm(path, { force: true }); } catch (failure) { rollbackErrors.push(failure); }
					if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], '导入失败且部分数据未能回滚；原文件和事务记录已保留，请检查存储权限后重试');
					throw error;
				}
				return { paths: journal.plans.map((plan) => plan.path), cwd, duplicate: false,
					warnings: parsed.some((session) => resolve(session.header.cwd) !== resolve(cwd)) ? ['会话已映射到目标工作区；附件中的原始来源路径保留为历史引用。'] : [] };
			});
			queue = result.then(() => undefined, () => undefined); return result;
		},
	};
}
