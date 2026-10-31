/**
 * 上下文压缩 feature：两种压缩方式的类型、设置与 IPC 通道。
 *
 * - builtin：Pi 内置自动压缩（compaction 块阈值触发），由内置扩展 desktop-compaction
 *   接管摘要生成以便流式可见，设置写入 ~/.pi/agent/settings.json。
 * - magicContext：Magic Context 插件的后台压缩（historian 后台子代理 + session-history
 *   注入，无感知），配置写入 ~/.pi/agent/magic-context.jsonc。
 */

/** 压缩方式。两种模式互斥：magic context 接管后内置压缩会被其 cancel。 */
export type UiCompactionMode = 'builtin' | 'magicContext';

/** Pi settings.json 中 compaction 块的有效值（SDK 默认 16384 / 20000）。 */
export interface UiCompactionPiSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** 内置压缩模式下 pi-desktop 侧的选择（存 ~/.pi/agent/desktop-compaction.json）。 */
export interface UiDesktopCompactionPreferences {
  mode: UiCompactionMode;
  /** 压缩摘要使用的模型；null 表示跟随会话模型。 */
  compressModel: { provider: string; id: string } | null;
}

export interface UiCompactionSettings {
  /** Pi 全局 settings.json 的内容哈希，写入时做乐观并发检查。 */
  version: string;
  pi: UiCompactionPiSettings;
  /** pi-desktop 自己的压缩偏好文件内容哈希。 */
  preferencesVersion: string;
  preferences: UiDesktopCompactionPreferences;
}

export interface UiCompactionSettingsWrite {
  expectedPiVersion: string;
  expectedPreferencesVersion: string;
  pi: UiCompactionPiSettings;
  preferences: UiDesktopCompactionPreferences;
}

/** Magic Context 的 magic-context.jsonc 中 pi-desktop 暴露的配置子集。 */
export interface UiMagicContextConfig {
  enabled: boolean;
  historian: {
    /** 形如 "provider/modelId"；null 表示使用插件内置回退链。 */
    model: string | null;
    /** Pi 侧生成历史摘要时传给子代理的推理级别；null 表示不写入（用插件默认）。 */
    thinkingLevel: 'off' | 'low' | 'medium' | 'high' | null;
  };
  embedding: {
    provider: 'local' | 'openai-compatible' | 'off';
    /** 向量模型名；local 默认 Xenova/all-MiniLM-L6-v2。 */
    model: string | null;
    endpoint: string | null;
    /**
     * 原值永不回传 UI；保存时 null=保持现有值不变，''=清除该键，
     * 其他字符串（含 {env:VAR} 引用）=写入新值。
     */
    apiKey: string | null;
    /** 读取快照时配置中是否已有 api_key。 */
    apiKeySet: boolean;
  };
  /** 队列操作强制执行的上下文使用率（20–80）。 */
  executeThresholdPercentage: number | null;
  /** <session-history> 块占可用上下文的比例（0.05–0.5）。 */
  historyBudgetPercentage: number | null;
}

export interface UiMagicContextPluginStatus {
  installed: boolean;
  /** 扩展资源开关；无法解析时为 null。 */
  enabled: boolean | null;
  installedVersion: string | null;
  /** npm registry 上的最新版本；探测失败时为 null。 */
  latestVersion: string | null;
  updateAvailable: boolean;
  /** 探测/安装/更新失败的原因。 */
  error: string | null;
}

export interface UiMagicContextSnapshot {
  /** 用户级配置文件绝对路径（~/.pi/agent/magic-context.jsonc）。 */
  configPath: string;
  /** 配置文件内容哈希，写入时做乐观并发检查。 */
  configVersion: string;
  config: UiMagicContextConfig;
  plugin: UiMagicContextPluginStatus;
}

export interface UiMagicContextConfigWrite {
  expectedVersion: string;
  config: UiMagicContextConfig;
}

export interface CompactionFeaturesBridge {
  getCompactionSettings(): Promise<UiCompactionSettings>;
  saveCompactionSettings(request: UiCompactionSettingsWrite): Promise<UiCompactionSettings>;
  getMagicContextSnapshot(): Promise<UiMagicContextSnapshot>;
  saveMagicContextConfig(request: UiMagicContextConfigWrite): Promise<UiMagicContextSnapshot>;
  /** 安装 npm:@cortexkit/pi-magic-context（user 作用域）并写入默认配置。 */
  installMagicContextPlugin(): Promise<UiMagicContextSnapshot>;
  /** 更新已安装的 Magic Context 插件。 */
  updateMagicContextPlugin(): Promise<UiMagicContextSnapshot>;
  /** 只刷新插件版本/更新状态（不打扰用户填写的表单）。 */
  refreshMagicContextPluginStatus(): Promise<UiMagicContextSnapshot>;
}

export const COMPACTION_FEATURE_CHANNELS = {
  getCompactionSettings: 'compaction:settings',
  saveCompactionSettings: 'compaction:settings:save',
  getMagicContextSnapshot: 'magic-context:snapshot',
  saveMagicContextConfig: 'magic-context:config:save',
  installMagicContextPlugin: 'magic-context:install',
  updateMagicContextPlugin: 'magic-context:update',
  refreshMagicContextPluginStatus: 'magic-context:status',
} as const;
