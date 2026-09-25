import { randomUUID } from 'node:crypto';
import type { UiSessionGroup, UiSidebarGroupChange } from '@pidesktop/shared';
import { backupCorruptStateFileAsync, CorruptStateFileError, readStateFileAsync, writeStateFileAsync } from './stateFiles';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80
		&& !/[\u0000-\u001f\u007f]/.test(value);
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSessionPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0');
}

function nameKey(name: string): string { return name.toLowerCase(); }

function isSessionGroups(value: unknown): value is UiSessionGroup[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	const names = new Set<string>();
	const paths = new Set<string>();
	for (const group of value) {
		if (!isRecord(group) || !isId(group.id) || !isName(group.name) || group.name !== group.name.trim()
			|| !Array.isArray(group.sessionPaths) || ids.has(group.id) || names.has(nameKey(group.name))) return false;
		ids.add(group.id);
		names.add(nameKey(group.name));
		for (const path of group.sessionPaths) {
			if (!isSessionPath(path) || paths.has(path)) return false;
			paths.add(path);
		}
	}
	return true;
}

function normalizeChange(value: unknown): UiSidebarGroupChange {
	if (!isRecord(value)) throw new Error('分组更新参数无效');
	if (value.type === 'create' || value.type === 'rename') {
		if (!isName(value.name)) throw new Error('分组名称须为 1–80 个字符');
		if (value.type === 'create') return { type: 'create', name: value.name.trim() };
		if (!isId(value.id)) throw new Error('分组编号无效');
		return { type: 'rename', id: value.id, name: value.name.trim() };
	}
	if (value.type === 'delete') {
		if (!isId(value.id)) throw new Error('分组编号无效');
		return { type: 'delete', id: value.id };
	}
	if (value.type === 'move-session') {
		if (!isSessionPath(value.sessionPath)) throw new Error('会话路径无效');
		if (value.groupId !== null && !isId(value.groupId)) throw new Error('分组编号无效');
		const index = value.index;
		if (index !== undefined && index !== null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) throw new Error('分组位置无效');
		return { type: 'move-session', sessionPath: value.sessionPath, groupId: value.groupId, index: typeof index === 'number' ? index : undefined };
	}
	if (value.type === 'reorder-groups') {
		if (!Array.isArray(value.ids) || value.ids.length === 0 || !value.ids.every((id: unknown) => isId(id))) throw new Error('分组顺序无效');
		return { type: 'reorder-groups', ids: value.ids };
	}
	throw new Error('分组更新类型无效');
}

/** One queue protects both definitions and membership, including reads and recovery. */
export class SessionGroupService {
	private queue: Promise<void> = Promise.resolve();
	private readonly path: string;
	private readonly validateSessionPath: (path: string) => Promise<void>;
	private readonly onCorruptState?: (backupPath: string) => void;

	constructor(options: {
		path: string;
		validateSessionPath: (path: string) => Promise<void>;
		onCorruptState?: (backupPath: string) => void;
	}) {
		this.path = options.path;
		this.validateSessionPath = options.validateSessionPath;
		this.onCorruptState = options.onCorruptState;
	}

	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		const result = this.queue.then(action);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async read(): Promise<UiSessionGroup[]> {
		try { return await readStateFileAsync(this.path, () => [], isSessionGroups); }
		catch (error) {
			if (!(error instanceof CorruptStateFileError)) throw error;
			const backup = await backupCorruptStateFileAsync(this.path);
			this.onCorruptState?.(backup);
			return [];
		}
	}

	list(): Promise<UiSessionGroup[]> { return this.enqueue(() => this.read()); }

	update(value: UiSidebarGroupChange): Promise<UiSessionGroup[]> {
		return this.enqueue(async () => {
			const change = normalizeChange(value);
			const groups = await this.read();
			if (change.type === 'create' || change.type === 'rename') {
				if (groups.some((group) => nameKey(group.name) === nameKey(change.name)
					&& (change.type === 'create' || group.id !== change.id))) throw new Error('分组名称已存在');
			}
			if (change.type === 'create') groups.unshift({ id: randomUUID(), name: change.name, sessionPaths: [] });
			else if (change.type === 'rename' || change.type === 'delete') {
				const index = groups.findIndex((group) => group.id === change.id);
				if (index < 0) throw new Error('未找到分组');
				if (change.type === 'rename') groups[index]!.name = change.name;
				else groups.splice(index, 1);
		} else if (change.type === 'reorder-groups') {
			const byId = new Map(groups.map((group) => [group.id, group]));
			const reordered = change.ids.map((id) => byId.get(id)).filter((group) => group !== undefined);
			if (reordered.length !== new Set(change.ids).size) throw new Error('分组顺序无效');
			groups.splice(0, groups.length, ...change.ids.map((id) => byId.get(id)!));
		} else {
			const target = change.groupId === null ? undefined : groups.find((group) => group.id === change.groupId);
			if (change.groupId !== null && !target) throw new Error('未找到分组');
			await this.validateSessionPath(change.sessionPath);
			for (const group of groups) group.sessionPaths = group.sessionPaths.filter((path) => path !== change.sessionPath);
			if (target) {
				const insertAt = change.index === undefined ? target.sessionPaths.length : Math.min(change.index, target.sessionPaths.length);
				target.sessionPaths.splice(insertAt, 0, change.sessionPath);
			}
		}
			await writeStateFileAsync(this.path, groups);
			return groups;
		});
	}

	flush(): Promise<void> { return this.queue; }
}
