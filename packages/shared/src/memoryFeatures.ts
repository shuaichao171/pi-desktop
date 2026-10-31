/**
 * Magic Context 记忆管理：pi-desktop 对插件 SQLite 记忆库（context.db）的
 * 查看 / 编辑 / 删除桥接类型。记忆本体由插件写入，本桌面只做管理面板。
 */

/** 记忆分页范围：项目记忆（memories 表，按 project_path）或用户记忆（user_memories 表，全局）。 */
export type UiMemoryScope = 'project' | 'user';

/** 插件 memories 表的一行（columns 是 0.49.x schema 的安全子集，缺列回落 null）。 */
export interface UiProjectMemory {
  id: number;
  category: string;
  content: string;
  /** 1–5；插件允许 NULL（未评分）。 */
  importance: number | null;
  /** active / archived / …（插件语义，原样透传）。 */
  status: string;
  scope: string;
  sourceType: string | null;
  seenCount: number | null;
  retrievalCount: number | null;
  verificationStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 插件 user_memories 表的一行。 */
export interface UiUserMemory {
  id: number;
  content: string;
  status: string;
  promotedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface UiMemoryListQuery {
  /** 空串表示不过滤。 */
  query?: string;
  /** null = 全部分类。 */
  category?: string | null;
  /** null = 全部状态（dismissed 永远排除）。 */
  status?: string | null;
  limit: number;
  offset: number;
}

export interface UiMemoryPage {
  items: UiProjectMemory[];
  /** 命中总数（用于分页与统计展示）。 */
  total: number;
  hasMore: boolean;
}

export interface UiUserMemoryPage {
  items: UiUserMemory[];
  total: number;
  hasMore: boolean;
}

/** 面板顶部统计条。 */
export interface UiMemoryStats {
  total: number;
  active: number;
  archived: number;
  /** 各分类条数（降序）。 */
  byCategory: { category: string; count: number }[];
  userTotal: number;
}

/** 记忆功能可用性：入口灰色锁定与面板空态的判定依据。 */
export interface UiMemoryAvailability {
  /** Magic Context 插件已安装且启用。 */
  pluginReady: boolean;
  /** 记忆库文件存在且表结构可读。 */
  databaseReady: boolean;
  /** 不可用原因（可用时空串）。 */
  reason: string;
}

export interface UiProjectMemoryUpdate {
  id: number;
  /** 编辑 content 需重算去重哈希；与现有记忆重复时报错。 */
  content?: string;
  importance?: number | null;
  status?: string;
}

export interface MemoryFeaturesBridge {
  /** 记忆功能可用性（插件安装/启用 + 数据库可读）。 */
  getMemoryAvailability(cwd: string): Promise<UiMemoryAvailability>;
  /** 当前项目记忆分页（关键词 LIKE 检索 + 分类/状态过滤）。 */
  listProjectMemories(cwd: string, query: UiMemoryListQuery): Promise<UiMemoryPage>;
  /** 用户级记忆分页（全局生效；dismissed 永远排除）。 */
  listUserMemories(query: UiMemoryListQuery): Promise<UiUserMemoryPage>;
  /** 项目 + 用户记忆统计。 */
  getMemoryStats(cwd: string): Promise<UiMemoryStats>;
  /** 编辑项目记忆（content/importance/status）；写库为短事务 + busy_timeout。 */
  updateProjectMemory(cwd: string, update: UiProjectMemoryUpdate): Promise<UiProjectMemory>;
  /** 删除项目记忆（级联清取向量索引）。 */
  deleteProjectMemory(cwd: string, id: number): Promise<void>;
  /** 清空当前项目全部记忆。 */
  clearProjectMemories(cwd: string): Promise<number>;
  /** 用户记忆软删除（status=dismissed，插件同款语义）。 */
  dismissUserMemory(id: number): Promise<void>;
}

/** 供主进程 ipc 与 preload 使用的一致 channel 名。 */
export const MEMORY_FEATURE_CHANNELS = {
  availability: 'memory:availability',
  listProject: 'memory:list-project',
  listUser: 'memory:list-user',
  stats: 'memory:stats',
  updateProject: 'memory:update-project',
  deleteProject: 'memory:delete-project',
  clearProject: 'memory:clear-project',
  dismissUser: 'memory:dismiss-user',
} as const;
