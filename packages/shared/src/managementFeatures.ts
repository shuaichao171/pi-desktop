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
export interface ManagementFeaturesBridge {
  testProviderModel(request: ModelTestRequest): Promise<ModelTestResult>;
  cancelProviderModelTest(requestId: string): Promise<void>;
  getProjectDefaults(): Promise<ProjectDefaultsSnapshot>;
  saveProjectDefaults(request: ProjectDefaultsWrite): Promise<ProjectDefaultsSnapshot>;
  exportDiagnostics(days: number): Promise<DiagnosticExportResult>;
}
export const MANAGEMENT_FEATURE_CHANNELS = {
  testProviderModel: 'management:model-test', cancelProviderModelTest: 'management:model-test-cancel',
  getProjectDefaults: 'management:project-defaults', saveProjectDefaults: 'management:project-defaults-save', exportDiagnostics: 'management:diagnostics-export',
} as const;
