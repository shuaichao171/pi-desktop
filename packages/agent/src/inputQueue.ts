import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UiQueuedAttachment } from '@pidesktop/shared';
import type { UiInputQueue, UiInputQueueItem, UiInputQueueMutation, UiInputReceipt, UiInputScope, UiSubmitInput } from '../../shared/src/inputFeatures.ts';
import { AttachmentStore, atomicInputJson, inputScopeKey } from './attachmentStore.ts';

type Message = { role: string; content: string | Record<string, unknown>[]; [key: string]: unknown };
type Queue = { messages: Message[]; enqueue(message: Message): void; drain(): Message[]; clear(): void; hasItems(): boolean; peek(): Message[] };
type SessionPort = { isIdle: boolean; agent: { steeringQueue: Queue; followUpQueue: Queue }; _steeringMessages: string[]; _followUpMessages: string[]; _emitQueueUpdate(): void; _runAgentPrompt(messages: Message[]): Promise<void> };
type Row = { id: string; fingerprint?: string; behavior: 'steer' | 'followUp'; state: UiInputQueueItem['state']; version: number; text: string; attachments: UiQueuedAttachment[]; message?: Message; enqueued?: boolean; reason?: string; retryable?: boolean };
type DiskState = { version: number; paused: boolean; rows: Row[]; mutations: Record<string, { fingerprint: string }> };
const rawText = (message: Message) => typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = (row: Row) => row.state === 'accepted' || row.state === 'recovered' || row.state === 'editing';
const validId = (id: string) => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(id);

/** Version-checked adapter for the pinned Pi 0.87 PendingMessageQueue implementation. */
export class DurableInputQueue {
	private state: DiskState = { version: 0, paused: false, rows: [], mutations: {} };
	private readonly messages = new Map<string, Message>();
	private readonly identities = new WeakMap<object, string>();
	private readonly file: string;
	private readonly port: SessionPort;
	private readonly restore: (() => void)[] = [];
	readonly scope: UiInputScope; readonly storage: AttachmentStore;
	readonly options: {
		currentInput(): UiSubmitInput | undefined;
		preview(message: Message): { text: string; attachments: UiQueuedAttachment[] };
		changed(): void; resume(): void; error(message: string): void;
	};
	constructor(session: unknown, scope: UiInputScope, root: string, storage: AttachmentStore, options: DurableInputQueue['options']) {
		this.scope = scope; this.storage = storage; this.options = options;
		this.port = session as SessionPort;
		for (const queue of [this.port.agent?.steeringQueue, this.port.agent?.followUpQueue]) if (!queue || !Array.isArray(queue.messages) || typeof queue.enqueue !== 'function' || typeof queue.drain !== 'function' || typeof queue.clear !== 'function' || typeof queue.peek !== 'function' || typeof queue.hasItems !== 'function') throw new Error('当前 Pi SDK 不支持安全队列适配，请更新桌面应用');
		if (!Array.isArray(this.port._steeringMessages) || !Array.isArray(this.port._followUpMessages) || typeof this.port._emitQueueUpdate !== 'function' || typeof this.port._runAgentPrompt !== 'function') throw new Error('Pi SDK 队列显示协议不兼容');
		mkdirSync(root, { recursive: true }); this.file = join(root, `${inputScopeKey(scope)}.json`);
		if (existsSync(this.file)) {
			const saved = JSON.parse(readFileSync(this.file, 'utf8')) as DiskState;
			if (!Array.isArray(saved.rows) || !Number.isSafeInteger(saved.version) || typeof saved.paused !== 'boolean') throw new Error('输入账本损坏；已停止恢复以避免重复执行');
			this.state = saved;
			for (const row of this.state.rows) if (row.state === 'accepted' || row.state === 'reserved' || row.state === 'editing') {
				row.reason = row.state === 'editing' ? '上次编辑尚未保存；确认后恢复原始输入' : '上次运行的接收或消费状态不确定；确认后才重新发送';
				row.state = 'recovered'; row.version++;
			}
			this.state.version++; this.save(this.state);
		}
		this.wrap('steer', this.port.agent.steeringQueue); this.wrap('followUp', this.port.agent.followUpQueue);
	}
	private save(state: DiskState): void { atomicInputJson(this.file, state); }
	private transaction(change: (next: DiskState) => void, apply?: () => void): void {
		const next = structuredClone(this.state); change(next); next.version++; this.save(next); apply?.(); this.state = next; this.options.changed();
	}
	private storeMessage(id: string, message: Message, attachments = this.options.currentInput()?.attachments as UiQueuedAttachment[] | undefined): Message {
		const copy = structuredClone(message);
		const names = attachments?.filter((item) => item.kind === 'image') ?? []; let imageIndex = 0;
		if (Array.isArray(copy.content)) copy.content = copy.content.map((part) => {
			if (part.type !== 'image' || typeof part.data !== 'string' || typeof part.mimeType !== 'string') return part;
			const name = names[imageIndex]?.name ?? `Image ${imageIndex + 1}`; imageIndex++;
			const ref = this.storage.put(this.scope, { kind: 'image', name, mimeType: part.mimeType, data: part.data }, `queue:${inputScopeKey(this.scope)}:${id}`);
			const { data: _, ...rest } = part; return { ...rest, desktopAttachmentId: ref.id };
		});
		return copy;
	}
	private restoreMessage(message: Message): Message {
		const copy = structuredClone(message);
		if (Array.isArray(copy.content)) copy.content = copy.content.map((part) => {
			if (typeof part.desktopAttachmentId !== 'string') return part;
			const attachment = this.storage.read(this.scope, part.desktopAttachmentId); if (attachment.kind !== 'image') throw new Error('排队图片类型不匹配');
			const { desktopAttachmentId: _, ...rest } = part; return { ...rest, data: attachment.data };
		}); return copy;
	}
	private mirror(): void {
		this.port._steeringMessages = this.port.agent.steeringQueue.messages.filter((message) => message.role === 'user').map(rawText);
		this.port._followUpMessages = this.port.agent.followUpQueue.messages.filter((message) => message.role === 'user').map(rawText);
	}
	private wrap(behavior: 'steer' | 'followUp', queue: Queue): void {
		const enqueue = queue.enqueue, drain = queue.drain, clear = queue.clear, hasItems = queue.hasItems;
		queue.hasItems = () => !(behavior === 'followUp' && this.state.paused) && hasItems.call(queue);
		queue.enqueue = (message) => {
			if (message.role !== 'user') { enqueue.call(queue, message); return; }
			const input = this.options.currentInput(), id = input?.id ?? randomUUID();
			const previous = this.state.rows.find((row) => row.id === id);
			if (previous && (this.messages.has(id) || previous.state === 'consumed')) return;
			const preview = this.options.preview(message), stored = this.storeMessage(id, message, input?.attachments ?? preview.attachments);
			try {
				this.transaction((next) => {
					const index = next.rows.findIndex((row) => row.id === id);
					const row: Row = { ...previous, id, behavior, state: 'accepted', version: (previous?.version ?? 0) + 1, ...preview, message: stored, enqueued: true };
					if (index >= 0) next.rows[index] = row; else next.rows.push(row);
				}, () => { enqueue.call(queue, message); this.messages.set(id, message); this.identities.set(message, id); this.mirror(); });
			} catch (error) { this.mirror(); throw error; }
		};
		queue.drain = () => {
			if (behavior === 'followUp' && this.state.paused) return [];
			// Read precisely the SDK mode's next batch before committing its consumption reservation.
			const batch = queue.peek();
			const ids = new Set(batch.map((message) => this.identities.get(message)).filter(Boolean));
			if (!ids.size) return drain.call(queue);
			try {
				let result: Message[] = [];
				this.transaction((next) => { for (const row of next.rows) if (ids.has(row.id)) { row.state = 'reserved'; row.version++; } }, () => { result = drain.call(queue); this.mirror(); });
				return result;
			} catch (error) { this.options.error(`队列消费记录无法保存，后续输入已保留：${String(error)}`); return []; }
		};
		queue.clear = () => {
			const ids = new Set(queue.messages.map((message) => this.identities.get(message)).filter(Boolean));
			this.transaction((next) => { for (const row of next.rows) if (ids.has(row.id)) { row.state = 'failed'; row.reason = '已清除未执行输入'; row.message = undefined; row.text = ''; row.attachments = []; row.version++; } }, () => { clear.call(queue); for (const id of ids) this.messages.delete(id!); this.mirror(); });
			for (const id of ids) this.storage.release(`queue:${inputScopeKey(this.scope)}:${id}`);
		};
		this.restore.push(() => { queue.enqueue = enqueue; queue.drain = drain; queue.clear = clear; queue.hasItems = hasItems; });
	}
	snapshot(): UiInputQueue { return { version: this.state.version, paused: this.state.paused, items: this.state.rows.filter((row) => row.state === 'recovered' || row.state === 'editing' || row.state === 'accepted' && row.enqueued).sort((a, b) => a.behavior === b.behavior ? 0 : a.behavior === 'steer' ? -1 : 1).map((row) => ({ id: row.id, text: row.text, behavior: row.behavior, version: row.version, state: row.state, ...(row.attachments.length ? { attachments: structuredClone(row.attachments) } : {}), ...(row.reason ? { message: row.reason } : {}) })) }; }
	receipt(id: string): UiInputReceipt | undefined { const row = this.state.rows.find((item) => item.id === id); return row ? { id, state: row.state === 'editing' ? 'accepted' : row.state, ...(row.reason ? { message: row.reason } : {}) } : undefined; }
	/** Held/recovered rows keep their ledger position even when restored in another order. */
	private insertAtPosition(row: Row, message: Message, next: DiskState, queue: Queue): void {
		const index = next.rows.findIndex((item) => item.id === row.id);
		const before = next.rows.slice(index + 1).filter((item) => item.behavior === row.behavior && item.state === 'accepted')
			.map((item) => this.messages.get(item.id)).find((candidate) => candidate && queue.messages.includes(candidate));
		const list = queue.messages.filter((item) => item !== message);
		list.splice(before ? list.indexOf(before) : list.length, 0, message); queue.messages = list;
		this.messages.set(row.id, message); this.identities.set(message, row.id);
	}
	begin(request: UiSubmitInput, preparedText = request.text): UiInputReceipt | undefined {
		if (!validId(request.id)) throw new Error('输入请求 ID 无效');
		const fingerprint = hash(request), previous = this.state.rows.find((row) => row.id === request.id);
		if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('相同输入 ID 的内容已改变，请创建新请求'); if (!previous.retryable || previous.state !== 'failed') return this.receipt(request.id); }
		if (!previous && this.state.rows.length >= 5000 || this.snapshot().items.length >= 100) throw new Error('会话输入账本已满，请创建新会话');
		const stored = this.storeMessage(request.id, { role: 'user', content: [{ type: 'text', text: preparedText }, ...(request.attachments ?? []).filter((item) => item.kind === 'image').map((item) => ({ type: 'image', data: item.data, mimeType: item.mimeType }))] }, request.attachments);
		this.transaction((next) => { next.rows = next.rows.filter((row) => row.id !== request.id); next.rows.push({ id: request.id, fingerprint, behavior: request.behavior ?? 'followUp', state: 'reserved', version: (previous?.version ?? 0) + 1, text: request.text, attachments: (request.attachments ?? []).map(({ kind, name, mimeType }) => ({ kind, name, mimeType })), message: stored }); });
		return undefined;
	}
	acknowledge(id: string): void { const row = this.state.rows.find((item) => item.id === id); if (row?.state === 'reserved' && !this.messages.has(id)) this.transaction((next) => { next.rows.find((item) => item.id === id)!.state = 'accepted'; }); }
	fail(id: string, error: unknown): void {
		if (!this.state.rows.some((row) => row.id === id && row.state === 'reserved' && !row.enqueued)) return;
		this.transaction((next) => { const row = next.rows.find((item) => item.id === id)!; row.state = 'failed'; row.retryable = true; row.reason = error instanceof Error ? error.message : String(error); row.message = undefined; row.text = ''; row.attachments = []; row.version++; });
		this.storage.release(`queue:${inputScopeKey(this.scope)}:${id}`);
	}
	describeInput(message: unknown, directId?: string): { id: string; behavior: 'steer' | 'followUp'; queued: boolean } | undefined {
		const id = message && typeof message === 'object' ? this.identities.get(message) ?? directId : directId;
		const row = id ? this.state.rows.find(item => item.id === id) : undefined;
		return row ? { id: row.id, behavior: row.behavior, queued: row.enqueued === true } : undefined;
	}
	consumed(message: unknown, directId?: string): void {
		const id = message && typeof message === 'object' ? this.identities.get(message) ?? directId : directId;
		if (!id || !this.state.rows.some((row) => row.id === id && row.state !== 'consumed')) return;
		this.transaction((next) => { const row = next.rows.find((item) => item.id === id)!; row.state = 'consumed'; row.version++; row.message = undefined; row.text = ''; row.attachments = []; }, () => this.messages.delete(id));
		this.storage.release(`queue:${inputScopeKey(this.scope)}:${id}`);
	}
	mutate(request: UiInputQueueMutation): UiInputQueue {
		if (!validId(request.requestId)) throw new Error('队列请求 ID 无效');
		const fingerprint = hash(request), prior = this.state.mutations[request.requestId];
		if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('相同请求 ID 不能用于其他操作'); return this.snapshot(); }
		if (Object.keys(this.state.mutations).length >= 5000) throw new Error('会话队列操作记录已满，请创建新会话');
		if (request.expectedVersion !== this.state.version) throw new Error('队列已变化，请刷新后重试');
		const next = structuredClone(this.state), row = next.rows.find((item) => item.id === request.id);
		const queue = row?.behavior === 'steer' ? this.port.agent.steeringQueue : this.port.agent.followUpQueue;
		const original = row ? this.messages.get(row.id) : undefined;
		let replacement: Message | undefined, apply = () => {};
		if (request.action === 'pause' || request.action === 'resume') next.paused = request.action === 'pause';
		else {
			if (!row || !pending(row)) throw new Error('该输入已经消费或不存在');
			if (row.state !== 'recovered' && (!original || row.state !== 'editing' && !queue.messages.includes(original))) throw new Error('该输入已开始消费，不能修改');
			if (request.action === 'remove') { row.state = 'failed'; row.reason = '用户移除'; row.message = undefined; row.text = ''; row.attachments = []; apply = () => { if (original) queue.messages = queue.messages.filter((message) => message !== original); this.messages.delete(row.id); }; }
			else if (request.action === 'confirm') {
				if (row.state !== 'recovered' || !row.message) throw new Error('该输入不需要恢复确认');
				replacement = this.restoreMessage(row.message); row.state = 'accepted'; row.reason = undefined; row.enqueued = true;
				apply = () => this.insertAtPosition(row, replacement!, next, queue);
			} else if (row.state === 'recovered') throw new Error('请先确认恢复或移除此输入');
			else if (request.action === 'beginEdit') {
				if (next.rows.some((item) => item.state === 'editing')) throw new Error('请先保存或取消正在编辑的输入');
				row.state = 'editing';
				apply = () => { queue.messages = queue.messages.filter((message) => message !== original); };
			} else if (request.action === 'cancelEdit') {
				if (row.state !== 'editing') throw new Error('该输入不在编辑中');
				row.state = 'accepted'; apply = () => this.insertAtPosition(row, original!, next, queue);
			}
			else if (request.action === 'edit') {
				if (typeof request.text !== 'string' || !request.text.trim() && !row.attachments.length || request.text.length > 200_000) throw new Error('排队文字无效');
				const editing = row.state === 'editing';
				const current = rawText(original!), marker = current.indexOf('\n\n<!-- pi-desktop:attachments-v1 -->\n');
				const raw = request.text + (marker >= 0 ? current.slice(marker) : ''); replacement = structuredClone(original!);
				replacement.content = [{ type: 'text', text: raw }, ...(Array.isArray(original!.content) ? original!.content.filter((part) => part.type !== 'text') : [])];
				row.text = request.text; row.message = this.storeMessage(row.id, replacement, row.attachments); row.state = 'accepted';
				apply = editing ? () => this.insertAtPosition(row, replacement!, next, queue)
					: () => { queue.messages = queue.messages.map((message) => message === original ? replacement! : message); this.messages.set(row.id, replacement!); this.identities.set(replacement!, row.id); };
			} else if (request.action === 'steer') {
				if (row.state === 'editing') throw new Error('请先保存或取消正在编辑的输入');
				if (row.behavior !== 'followUp') throw new Error('该输入已经是引导消息'); row.behavior = 'steer'; next.rows = [...next.rows.filter((item) => item.id !== row.id), row];
				apply = () => { queue.messages = queue.messages.filter((message) => message !== original); this.port.agent.steeringQueue.messages = [...this.port.agent.steeringQueue.messages, original!]; };
			} else if (request.action === 'move') {
				if (row.state === 'editing') throw new Error('请先保存或取消正在编辑的输入');
				const before = request.beforeId ? this.messages.get(request.beforeId) : undefined;
				if (request.beforeId && (!before || before === original || !queue.messages.includes(before))) throw new Error('只能对同类型尚未消费输入排序');
				const list = queue.messages.filter((message) => message !== original); list.splice(before ? list.indexOf(before) : list.length, 0, original!);
				next.rows = next.rows.filter((item) => item.id !== row.id); const beforeIndex = request.beforeId ? next.rows.findIndex((item) => item.id === request.beforeId) : -1; next.rows.splice(beforeIndex < 0 ? next.rows.length : beforeIndex, 0, row);
				apply = () => { queue.messages = list; };
			} else throw new Error('队列操作无效');
			row.version++;
		}
		next.version++;
		const priorState = this.state; this.state = next; const result = this.snapshot(); this.state = priorState;
		next.mutations[request.requestId] = { fingerprint }; this.save(next); apply(); this.state = next; this.mirror(); this.options.changed();
		if (request.action === 'remove') this.storage.release(`queue:${inputScopeKey(this.scope)}:${row!.id}`);
		if (request.action === 'resume' || request.action === 'confirm' || request.action === 'steer' || request.action === 'edit' || request.action === 'cancelEdit') this.options.resume();
		return result;
	}
	async resumeIdle(): Promise<void> {
		if (!this.port.isIdle) return;
		const messages = this.port.agent.steeringQueue.drain();
		if (!messages.length) messages.push(...this.port.agent.followUpQueue.drain());
		if (messages.length) await this.port._runAgentPrompt(messages);
	}
	dispose(): void { for (const restore of this.restore) restore(); }
}
