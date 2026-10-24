import type { UiThinkingLevel } from './index';

export interface ModelTestRequest { requestId: string; provider: string; model: string }
export interface ModelTestResult { requestId: string; provider: string; model: string; ok: boolean; elapsedMs: number; error: string | null }
/** Usage-query template kinds, mirroring cc-switch's template families. */
export type UiUsageQueryTemplate = 'general' | 'newapi' | 'sub2api' | 'balance' | 'custom';
/** Per-provider usage-query configuration stored in models.json next to the provider entry. */
export interface UiUsageQueryConfig {
  enabled: boolean;
  template: UiUsageQueryTemplate;
  /** Minutes between automatic queries of the provider in use; 0 disables auto refresh. */
  intervalMinutes?: number;
  /** Script for script-based templates; the template preset applies when omitted. */
  script?: string;
  /** newapi template: system access token. Omit on save to keep the stored value; empty string clears it. */
  accessToken?: string;
  /** newapi template: user id shown in the relay console. */
  userId?: string;
}
/** Read-only usage-query view returned to the UI; the access token value never leaves the host. */
export interface UiProviderUsageQueryInfo {
  enabled: boolean;
  template: UiUsageQueryTemplate;
  intervalMinutes?: number;
  script?: string;
  userId?: string;
  hasAccessToken?: boolean;
}
/** One balance line; every field is optional exactly like cc-switch's usage data. */
export interface UiUsageData { planName?: string; remaining?: number; used?: number; total?: number; unit?: string; isValid?: boolean; invalidMessage?: string; }
export interface UiUsageQueryResult {
  provider: string;
  ok: boolean;
  queriedAt: number;
  data?: UiUsageData[];
  error?: string;
  /** True for transient transport failures; callers keep the last good sample. */
  transient?: boolean;
}
/** Targeted write of the usage-query settings; connection fields stay untouched (mirrors saveProviderModels). */
export interface UiSaveProviderUsageQueryRequest { provider: string; usageQuery: UiUsageQueryConfig | null }
export interface ProjectDefaultValues { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: UiThinkingLevel }
export interface ProjectDefaultsSnapshot {
  cwd: string; path: string; version: string; trusted: boolean; reason: string | null;
  global: ProjectDefaultValues; project: ProjectDefaultValues; effective: ProjectDefaultValues;
}
export interface ProjectDefaultsWrite { cwd: string; expectedVersion: string; values: ProjectDefaultValues }
export interface DiagnosticExportResult { path: string | null; entries: number; skipped: string[] }
export interface ManagementFeaturesBridge {
  testProviderModel(request: ModelTestRequest): Promise<ModelTestResult>;
  cancelProviderModelTest(requestId: string): Promise<void>;
  getProjectDefaults(): Promise<ProjectDefaultsSnapshot>;
  saveProjectDefaults(request: ProjectDefaultsWrite): Promise<ProjectDefaultsSnapshot>;
  exportDiagnostics(days: number): Promise<DiagnosticExportResult>;
  queryProviderUsage(provider: string): Promise<UiUsageQueryResult>;
  saveProviderUsageQuery(request: UiSaveProviderUsageQueryRequest): Promise<void>;
}
export const MANAGEMENT_FEATURE_CHANNELS = {
  testProviderModel: 'management:model-test', cancelProviderModelTest: 'management:model-test-cancel',
  getProjectDefaults: 'management:project-defaults', saveProjectDefaults: 'management:project-defaults-save', exportDiagnostics: 'management:diagnostics-export',
  queryProviderUsage: 'management:usage-query',
  saveProviderUsageQuery: 'management:usage-query-save',
} as const;
