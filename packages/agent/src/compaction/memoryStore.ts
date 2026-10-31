import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	UiMemoryAvailability,
	UiMemoryListQuery,
	UiMemoryPage,
	UiMemoryStats,
	UiProjectMemory,
	UiProjectMemoryUpdate,
	UiUserMemory,
	UiUserMemoryPage,
} from '../../../shared/src/memoryFeatures';
import { detectMagicContextPlugin } from './magicContext.ts';
import type { UiPluginCatalog } from '../../../shared/src/index';

/**
 * [喵喵喵]: 受控简化 — 直接用 node:sqlite 读 Magic Context 0.49.x 的 context.db
 * （插件该版本同样基于 node:sqlite，无 ABI 问题）。读走每次开-查-关的只读连接，
 * 零长锁；写走短事务 + busy_timeout，与插件自身的并发防护兼容。
 * 边界：schema 耦合 0.49.x（列集在 SELECT 里按名取，插件改列只影响对应字段回落 null）；
 * 升级：插件大版本变更时按其源码同步调整列映射。
 */

/** 插件存储目录解析（与其 getMagicContextStorageResolution 同源）。 */
function storageDir(): string {
	const override = process.env.MAGIC_CONTEXT_STORAGE_DIR?.trim();
	if (override && isAbsolute(override)) return override;
	const xdg = process.env.XDG_DATA_HOME?.trim();
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share'), 'cortexkit', 'magic-context');
}

function databasePath(): string {
	return join(storageDir(), 'context.db');
}

/** 插件 computeNormalizedHash 同款：lowercase + 压空白 + trim 后 md5。 */
function computeNormalizedHash(content: string): string {
	return createHash('md5').update(content.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * 插件以 canonical 路径注册项目（realpath），查询同时匹配原样 cwd 与 canonical
 * 两种形式，避免符号链接 / 大小写差异导致查不到。
 */
function projectPathCandidates(cwd: string): string[] {
	const candidates = new Set<string>([cwd]);
	try {
		const canonical = realpathSync(cwd);
		if (canonical !== cwd) candidates.add(canonical);
	} catch {
		// cwd 不存在时保持原样查询，返回空结果即可
	}
	return [...candidates];
}

const PROJECT_COLUMNS = 'id, category, content, importance, status, scope, source_type, seen_count, retrieval_count, verification_status, created_at, updated_at';

function rowToProjectMemory(row: Record<string, unknown>): UiProjectMemory {
	const integer = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : typeof value === 'bigint' ? Number(value) : null;
	const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
	return {
		id: integer(row.id) ?? -1,
		category: typeof row.category === 'string' ? row.category : '',
		content: typeof row.content === 'string' ? row.content : '',
		importance: integer(row.importance),
		status: typeof row.status === 'string' ? row.status : 'active',
		scope: typeof row.scope === 'string' ? row.scope : 'project',
		sourceType: text(row.source_type),
		seenCount: integer(row.seen_count),
		retrievalCount: integer(row.retrieval_count),
		verificationStatus: text(row.verification_status),
		createdAt: integer(row.created_at) ?? 0,
		updatedAt: integer(row.updated_at) ?? 0,
	};
}

function rowToUserMemory(row: Record<string, unknown>): UiUserMemory {
	const integer = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : typeof value === 'bigint' ? Number(value) : null;
	return {
		id: integer(row.id) ?? -1,
		content: typeof row.content === 'string' ? row.content : '',
		status: typeof row.status === 'string' ? row.status : 'active',
		promotedAt: integer(row.promoted_at) ?? 0,
		createdAt: integer(row.created_at) ?? 0,
		updatedAt: integer(row.updated_at) ?? 0,
	};
}

function openDatabase(readonly: boolean): DatabaseSync {
	// busy_timeout（ms）：插件进程持有写锁时等待而非立即失败
	return new DatabaseSync(databasePath(), { readOnly: readonly, timeout: 5_000 });
}

/** 表存在且列集满足读取需要（跨版本守卫：表缺失/缺列都视为 database 不可用）。 */
function tableReady(db: DatabaseSync, table: string, columns: string[]): boolean {
	try {
		const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
		const present = new Set(info.map((item) => typeof item.name === 'string' ? item.name : ''));
		return columns.every((column) => present.has(column));
	} catch {
		return false;
	}
}

export interface MemoryStore {
	availability(catalog: UiPluginCatalog | null): Promise<UiMemoryAvailability>;
	listProjectMemories(cwd: string, query: UiMemoryListQuery): Promise<UiMemoryPage>;
	listUserMemories(query: UiMemoryListQuery): Promise<UiUserMemoryPage>;
	stats(cwd: string): Promise<UiMemoryStats>;
	updateProjectMemory(cwd: string, update: UiProjectMemoryUpdate): Promise<UiProjectMemory>;
	deleteProjectMemory(cwd: string, id: number): Promise<void>;
	clearProjectMemories(cwd: string): Promise<number>;
	dismissUserMemory(id: number): Promise<void>;
}

export function createMemoryStore(): MemoryStore {
	const REQUIRED = {
		memories: ['id', 'project_path', 'category', 'content', 'normalized_hash', 'importance', 'status', 'created_at', 'updated_at'],
		userMemories: ['id', 'content', 'status', 'promoted_at', 'created_at', 'updated_at'],
	};

	async function availability(catalog: UiPluginCatalog | null): Promise<UiMemoryAvailability> {
		const detected = await detectMagicContextPlugin(catalog);
		if (!detected.installed) return { pluginReady: false, databaseReady: false, reason: 'pluginMissing' };
		if (detected.enabled === false) return { pluginReady: false, databaseReady: false, reason: 'pluginDisabled' };
		if (!existsSync(databasePath())) return { pluginReady: true, databaseReady: false, reason: 'dbMissing' };
		try {
			const db = openDatabase(true);
			try {
				if (!tableReady(db, 'memories', REQUIRED.memories)) return { pluginReady: true, databaseReady: false, reason: 'dbSchema' };
			} finally {
				db.close();
			}
		} catch {
			return { pluginReady: true, databaseReady: false, reason: 'dbUnreadable' };
		}
		return { pluginReady: true, databaseReady: true, reason: '' };
	}

	function requireReady(readonly: boolean): DatabaseSync {
		if (!existsSync(databasePath())) throw new Error('Magic Context 记忆库尚未创建（插件还没有写入过记忆）');
		const db = openDatabase(readonly);
		if (!tableReady(db, 'memories', REQUIRED.memories)) {
			db.close();
			throw new Error('Magic Context 记忆库结构不兼容，请更新插件后重试');
		}
		return db;
	}

	function buildProjectWhere(candidates: string[], query: UiMemoryListQuery): { where: string; params: (string | number | null)[] } {
		const params: (string | number | null)[] = [];
		const clauses = [`project_path IN (${candidates.map(() => '?').join(', ')})`, "status != 'dismissed'"];
		params.push(...candidates);
		if (query.category) {
			clauses.push('category = ?');
			params.push(query.category);
		}
		if (query.status) {
			clauses.push('status = ?');
			params.push(query.status);
		}
		if (query.query?.trim()) {
			clauses.push('content LIKE ?');
			params.push(`%${query.query.trim().replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
		}
		return { where: clauses.join(' AND '), params };
	}

	return {
		availability,

		async listProjectMemories(cwd, query) {
			const db = requireReady(true);
			try {
				const candidates = projectPathCandidates(cwd);
				const { where, params } = buildProjectWhere(candidates, query);
				const total = (db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where}`).get(...params) as { count?: unknown }).count;
				const rows = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM memories WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
					.all(...params, query.limit, query.offset) as Record<string, unknown>[];
				return {
					items: rows.map(rowToProjectMemory),
					total: typeof total === 'number' ? total : Number(total ?? 0),
					hasMore: query.offset + rows.length < (typeof total === 'number' ? total : Number(total ?? 0)),
				};
			} finally {
				db.close();
			}
		},

		async listUserMemories(query) {
			const db = requireReady(true);
			try {
			if (!tableReady(db, 'user_memories', REQUIRED.userMemories)) return { items: [], total: 0, hasMore: false };
				const params: (string | number | null)[] = [];
				const clauses = ["status != 'dismissed'"];
				if (query.status) {
					clauses.push('status = ?');
					params.push(query.status);
				}
				if (query.query?.trim()) {
					clauses.push('content LIKE ?');
					params.push(`%${query.query.trim().replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
				}
				const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM user_memories WHERE ${clauses.join(' AND ')}`).get(...params) as { count?: unknown };
				const total = typeof totalRow.count === 'number' ? totalRow.count : Number(totalRow.count ?? 0);
				const rows = db.prepare(`SELECT id, content, status, promoted_at, created_at, updated_at FROM user_memories WHERE ${clauses.join(' AND ')} ORDER BY promoted_at DESC, id DESC LIMIT ? OFFSET ?`)
					.all(...params, query.limit, query.offset) as Record<string, unknown>[];
				return { items: rows.map(rowToUserMemory), total, hasMore: query.offset + rows.length < total };
			} finally {
				db.close();
			}
		},

		async stats(cwd) {
			const db = requireReady(true);
			try {
				const candidates = projectPathCandidates(cwd);
				const pathSlots = candidates.map(() => '?').join(', ');
				const base = db.prepare(`SELECT status, COUNT(*) AS count FROM memories WHERE project_path IN (${pathSlots}) AND status != 'dismissed' GROUP BY status`).all(...candidates) as { status?: unknown; count?: unknown }[];
				const byStatus = new Map(base.map((row) => [typeof row.status === 'string' ? row.status : '', typeof row.count === 'number' ? row.count : Number(row.count ?? 0)]));
				const categories = db.prepare(`SELECT category, COUNT(*) AS count FROM memories WHERE project_path IN (${pathSlots}) AND status != 'dismissed' GROUP BY category ORDER BY count DESC`).all(...candidates) as { category?: unknown; count?: unknown }[];
				let userTotal = 0;
				if (tableReady(db, 'user_memories', REQUIRED.userMemories)) {
					const row = db.prepare("SELECT COUNT(*) AS count FROM user_memories WHERE status != 'dismissed'").get() as { count?: unknown };
					userTotal = typeof row.count === 'number' ? row.count : Number(row.count ?? 0);
				}
				const active = byStatus.get('active') ?? 0;
				const archived = byStatus.get('archived') ?? 0;
				return {
					total: active + archived,
					active,
					archived,
					byCategory: categories
						.filter((row) => typeof row.category === 'string')
						.map((row) => ({ category: row.category as string, count: typeof row.count === 'number' ? row.count : Number(row.count ?? 0) })),
					userTotal,
				};
			} finally {
				db.close();
			}
		},

		async updateProjectMemory(cwd, update) {
			const db = requireReady(false);
			try {
				const candidates = projectPathCandidates(cwd);
				const pathSlots = candidates.map(() => '?').join(', ');
				const current = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM memories WHERE id = ? AND project_path IN (${pathSlots})`)
					.get(update.id, ...candidates) as Record<string, unknown> | undefined;
				if (!current) throw new Error('未找到该记忆（可能已被删除）');
				const nextContent = update.content ?? rowToProjectMemory(current).content;
				const nextImportance = update.importance !== undefined ? update.importance : rowToProjectMemory(current).importance;
				const nextStatus = update.status ?? rowToProjectMemory(current).status;
				db.exec('BEGIN');
				try {
					if (update.content !== undefined) {
						const hash = computeNormalizedHash(nextContent);
						const duplicate = db.prepare(`SELECT id FROM memories WHERE project_path = ? AND normalized_hash = ? AND id != ? AND status != 'dismissed' LIMIT 1`)
							.get(current.project_path as string, hash, update.id) as { id?: unknown } | undefined;
						if (duplicate) throw new Error('修改后的内容与现有记忆重复（插件按内容去重），请调整措辞');
						db.prepare('UPDATE memories SET content = ?, normalized_hash = ?, importance = ?, status = ?, updated_at = ? WHERE id = ?')
							.run(nextContent, hash, nextImportance, nextStatus, Date.now(), update.id);
					} else {
						db.prepare('UPDATE memories SET importance = ?, status = ?, updated_at = ? WHERE id = ?')
							.run(nextImportance, nextStatus, Date.now(), update.id);
					}
					db.exec('COMMIT');
				} catch (error) {
					try { db.exec('ROLLBACK'); } catch { /* 连接即将关闭，回滚失败无需处理 */ }
					throw error;
				}
				const row = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM memories WHERE id = ?`).get(update.id) as Record<string, unknown>;
				return rowToProjectMemory(row);
			} finally {
				db.close();
			}
		},

		async deleteProjectMemory(cwd, id) {
			const db = requireReady(false);
			try {
				const candidates = projectPathCandidates(cwd);
				const pathSlots = candidates.map(() => '?').join(', ');
				// [喵喵喵]: memory_embeddings 经 ON DELETE CASCADE 级联清理；桌面连接
				// 需开启 foreign_keys 才触发级联（node:sqlite 默认关闭）
				db.exec('PRAGMA foreign_keys = ON');
				const result = db.prepare(`DELETE FROM memories WHERE id = ? AND project_path IN (${pathSlots})`).run(id, ...candidates);
				if (!result.changes) throw new Error('未找到该记忆（可能已被删除）');
			} finally {
				db.close();
			}
		},

		async clearProjectMemories(cwd) {
			const db = requireReady(false);
			try {
				const candidates = projectPathCandidates(cwd);
				db.exec('PRAGMA foreign_keys = ON');
				const pathSlots = candidates.map(() => '?').join(', ');
				const result = db.prepare(`DELETE FROM memories WHERE project_path IN (${pathSlots})`).run(...candidates);
				return Number(result.changes ?? 0);
			} finally {
				db.close();
			}
		},

		async dismissUserMemory(id) {
			const db = requireReady(false);
			try {
				if (!tableReady(db, 'user_memories', REQUIRED.userMemories)) throw new Error('Magic Context 记忆库结构不兼容，请更新插件后重试');
				db.prepare("UPDATE user_memories SET status = 'dismissed', updated_at = ? WHERE id = ? AND status != 'dismissed'").run(Date.now(), id);
			} finally {
				db.close();
			}
		},
	};
}
