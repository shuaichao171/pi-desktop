import type { UiThinkingLevel } from './index';

export interface ModelTestRequest { requestId: string; provider: string; model: string }
export interface ModelTestResult { requestId: string; provider: string; model: string; ok: boolean; elapsedMs: number; error: string | null }
export interface ProjectDefaultValues { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: UiThinkingLevel }
export interface ProjectDefaultsSnapshot {
  cwd: string; path: string; version: string; trusted: boolean; reason: string | null;
  global: ProjectDefaultValues; project: ProjectDefaultValues; effective: ProjectDefaultValues;
}
export interface ProjectDefaultsWrite { cwd: string; expectedVersion: string; values: ProjectDefaultValues }
export interface DiagnosticExportResult { path: string | null; entries: number; skipped: string[] }
export interface UsageQuery { requestId: string; timeZone: string; from: string; to: string; cwd?: string; provider?: string; model?: string; source?: 'interactive' | 'automation' }
export interface UsageRow {
  date: string; cwd: string; provider: string; model: string; source: 'interactive' | 'automation';
  messages: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number | null; unknownPriceMessages: number; priceSource: 'session-message-estimate';
}
export interface UsageReport { rows: UsageRow[]; skipped: string[]; scanned: number; updated: number }
export type StorageCategory = 'sessions' | 'attachments' | 'trash' | 'diagnostics' | 'search-cache' | 'corrupt-backups' | 'settings';
export interface StorageItem { category: StorageCategory; bytes: number; files: number; cleanable: boolean }
export interface StorageSnapshot { items: StorageItem[]; skipped: string[]; limited: boolean }
export interface StoragePlan { id: string; files: Array<{ path: string; category: StorageCategory; bytes: number }>; bytes: number; expiresAt: string }
export interface StorageCleanupResult { releasedBytes: number; removed: number; failed: Array<{ path: string; reason: string }> }
export interface ManagementFeaturesBridge {
  testProviderModel(request: ModelTestRequest): Promise<ModelTestResult>;
  cancelProviderModelTest(requestId: string): Promise<void>;
  getProjectDefaults(): Promise<ProjectDefaultsSnapshot>;
  saveProjectDefaults(request: ProjectDefaultsWrite): Promise<ProjectDefaultsSnapshot>;
  exportDiagnostics(days: number): Promise<DiagnosticExportResult>;
  getUsageReport(query: UsageQuery): Promise<UsageReport>;
  cancelManagementOperation(requestId: string): Promise<void>;
  getStorageSnapshot(requestId: string): Promise<StorageSnapshot>;
  previewStorageCleanup(request: { requestId: string; categories: StorageCategory[]; olderThanDays: number }): Promise<StoragePlan>;
  executeStorageCleanup(planId: string): Promise<StorageCleanupResult>;
}
export const MANAGEMENT_FEATURE_CHANNELS = {
  testProviderModel: 'management:model-test', cancelProviderModelTest: 'management:model-test-cancel',
  getProjectDefaults: 'management:project-defaults', saveProjectDefaults: 'management:project-defaults-save',
  exportDiagnostics: 'management:diagnostics-export', getUsageReport: 'management:usage',
  cancelManagementOperation: 'management:cancel', getStorageSnapshot: 'management:storage',
  previewStorageCleanup: 'management:cleanup-preview', executeStorageCleanup: 'management:cleanup-execute',
} as const;
