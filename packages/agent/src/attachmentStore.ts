import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { UiAttachment } from '@pidesktop/shared';
import type { UiInputDraft, UiInputScope, UiSaveInputDraft, UiStoredAttachment } from '../../shared/src/inputFeatures.ts';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_STORE_MAX_BYTES = 256 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function inputScopeKey(scope: UiInputScope): string { return digest(JSON.stringify([resolve(scope.cwd), scope.sessionPath ? resolve(scope.sessionPath) : null])); }
export function atomicInputJson(path: string, value: unknown): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const file = openSync(temp, 'wx', 0o600);
		try { writeFileSync(file, JSON.stringify(value)); fsyncSync(file); } finally { closeSync(file); }
		renameSync(temp, path);
	}
	finally { if (existsSync(temp)) unlinkSync(temp); }
}
type Owner = { scope: string; refs: UiStoredAttachment[]; updated: number; version: number; text?: string; expires?: number };
export function validateStoredAttachment(value: UiAttachment): string {
	if (!value || !['image', 'text'].includes(value.kind) || typeof value.name !== 'string' || value.name.length > 200 || typeof value.mimeType !== 'string' || value.mimeType.length > 200) throw new Error('附件信息无效');
	if (value.kind === 'image' ? typeof value.data !== 'string' || !value.data || !/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(value.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) : typeof value.text !== 'string') throw new Error('附件内容无效');
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > ATTACHMENT_MAX_BYTES) throw new Error('附件超过 20 MiB 存储限制');
	return json;
}

/** Immutable blobs plus independently atomic owners allow draft and queue references to coexist. */
export class AttachmentStore {
	readonly blobs: string; readonly owners: string;
	readonly root: string; readonly maxBytes: number;
	constructor(root: string, maxBytes = ATTACHMENT_STORE_MAX_BYTES) {
		this.root = root; this.maxBytes = maxBytes;
		this.blobs = join(root, 'blobs'); this.owners = join(root, 'owners');
		mkdirSync(this.blobs, { recursive: true }); mkdirSync(this.owners, { recursive: true });
	}
	private ownerPath(owner: string): string { return join(this.owners, `${digest(owner)}.json`); }
	private owner(owner: string): Owner | null {
		try { const value = JSON.parse(readFileSync(this.ownerPath(owner), 'utf8')) as Owner; if (!value || !Array.isArray(value.refs) || typeof value.scope !== 'string') throw new Error('Invalid owner'); return value; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('附件引用记录损坏，请保留草稿并重试'); }
	}
	private blob(id: string): string { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('附件身份无效'); return join(this.blobs, `${id}.json`); }
	put(scope: UiInputScope, attachment: UiAttachment, owner?: string): UiStoredAttachment {
		const json = validateStoredAttachment(attachment), id = digest(json), path = this.blob(id);
		owner ??= `stage:${inputScopeKey(scope)}:${id}`;
		if (!existsSync(path)) {
			this.collect();
			const used = readdirSync(this.blobs).reduce((sum, name) => sum + statSync(join(this.blobs, name)).size, 0);
			if (used + Buffer.byteLength(json) > this.maxBytes) throw new Error('附件存储已满，请删除不需要的草稿后重试');
			atomicInputJson(path, attachment);
		}
		const ref: UiStoredAttachment = { id, version: 1, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: Buffer.byteLength(json) };
		const previous = this.owner(owner); if (previous && previous.scope !== inputScopeKey(scope)) throw new Error('附件引用不属于此会话');
		atomicInputJson(this.ownerPath(owner), { scope: inputScopeKey(scope), refs: [...(previous?.refs.filter((item) => item.id !== id) ?? []), ref], updated: Date.now(), version: (previous?.version ?? 0) + 1, ...(owner.startsWith('stage:') ? { expires: Date.now() + RETENTION_MS } : {}) });
		return ref;
	}
	read(scope: UiInputScope, id: string): UiAttachment {
		const scopeId = inputScopeKey(scope); let authorized = false;
		for (const file of readdirSync(this.owners)) {
			if (!file.endsWith('.json')) continue;
			try { const record = JSON.parse(readFileSync(join(this.owners, file), 'utf8')) as Owner; if (record.scope === scopeId && record.refs.some((ref) => ref.id === id)) { authorized = true; break; } } catch { /* Damaged owners grant no access. */ }
		}
		if (!authorized) throw new Error('附件不属于此会话或已经移除');
		let raw: string; try { const path = this.blob(id); if (statSync(path).size > ATTACHMENT_MAX_BYTES) throw new Error('附件超过读取限制'); raw = readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('附件文件缺失，请重新添加'); throw error; }
		if (digest(raw) !== id) throw new Error('附件内容校验失败，请重新添加');
		const attachment = JSON.parse(raw) as UiAttachment; validateStoredAttachment(attachment); return attachment;
	}
	getDraft(scope: UiInputScope): UiInputDraft {
		const record = this.owner(`draft:${inputScopeKey(scope)}`);
		if (!record) return { version: 0, text: '', attachments: [], missing: [] };
		return { version: record.version, text: record.text ?? '', attachments: record.refs, missing: record.refs.filter((ref) => !existsSync(this.blob(ref.id))).map((ref) => ref.id) };
	}
	saveDraft(request: UiSaveInputDraft): UiInputDraft {
		if (typeof request.text !== 'string' || request.text.length > 200_000 || !Array.isArray(request.attachmentIds) || request.attachmentIds.length > 12) throw new Error('草稿内容超过限制');
		const owner = `draft:${inputScopeKey(request)}`, current = this.owner(owner);
		if (request.expectedVersion !== (current?.version ?? 0)) throw new Error('草稿已被其他窗口修改，请重新读取后合并');
		const refs = request.attachmentIds.map((id) => { const attachment = this.read(request, id); return { id, version: 1 as const, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: statSync(this.blob(id)).size }; });
		atomicInputJson(this.ownerPath(owner), { scope: inputScopeKey(request), refs, text: request.text, updated: Date.now(), version: (current?.version ?? 0) + 1 });
		return { version: (current?.version ?? 0) + 1, text: request.text, attachments: refs, missing: [] };
	}
	release(owner: string): void { try { unlinkSync(this.ownerPath(owner)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
	/** Only permanent session deletion releases all draft, queue and staging owners. */
	releaseScope(scope: UiInputScope): void {
		const key = inputScopeKey(scope);
		for (const name of readdirSync(this.owners)) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const path = join(this.owners, name); let record: Owner;
			try { record = JSON.parse(readFileSync(path, 'utf8')) as Owner; } catch { continue; }
			if (record?.scope === key) unlinkSync(path);
		}
	}
	/** Queue owners are retained until acknowledgement; stale staging owners expire after one day. */
	collect(now = Date.now()): { removed: number } {
		const retained = new Set<string>(); let removed = 0;
		for (const file of readdirSync(this.owners)) {
			if (!file.endsWith('.json')) continue;
			try { const path = join(this.owners, file); const record = JSON.parse(readFileSync(path, 'utf8')) as Owner; if (record.expires && record.expires < now) { unlinkSync(path); continue; } for (const ref of record.refs) retained.add(ref.id); }
			catch { return { removed: 0 }; } // Never collect through an unreadable ownership record.
		}
		for (const file of readdirSync(this.blobs)) { const id = file.replace(/\.json$/, ''), path = join(this.blobs, file); if (/^[a-f0-9]{64}\.json$/.test(file) && !retained.has(id) && now - statSync(path).mtimeMs > RETENTION_MS) { unlinkSync(path); removed++; } }
		return { removed };
	}
}
