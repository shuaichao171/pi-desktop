import { app, dialog } from 'electron';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { MANAGEMENT_FEATURE_CHANNELS, type UsageQuery, type StorageCategory } from '@pidesktop/shared';
import { handleRendererInvoke } from './rendererIpc.ts';
import { initializeDiagnostics } from './diagnostics.ts';
import { StorageService } from './storageService.ts';
import { readStateFileAsync, writeStateFileAsync } from './stateFiles.ts';
import type { AgentHostService } from './agentHostProtocol.ts';

export function registerManagementIpc(agent: AgentHostService, workspaces: () => Promise<string[]>) {
  const directory = app.getPath('userData'), diagnostics = initializeDiagnostics(join(directory, 'diagnostics'));
  const storage = new StorageService(directory, getAgentDir());
  const automationPath = join(directory, 'automation-session-ledger.json');
  let queue: Promise<unknown> = Promise.resolve();
  const readAutomated = () => readStateFileAsync(automationPath, (): Record<string, string> => ({}), (value): value is Record<string, string> => !!value && typeof value === 'object' && Object.values(value).every(id => typeof id === 'string'));
  function rememberAutomation(path: string, runId: string): Promise<void> {
    const next = queue.then(async () => { const map = await readAutomated(); map[path] = runId; await writeStateFileAsync(automationPath, map); });
    queue = next.catch(() => undefined); return next;
  }
  handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.exportDiagnostics, async (_event, days: number) => {
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('请选择最近 1 至 30 天');
    const result = await dialog.showSaveDialog({ title: '导出脱敏诊断包', defaultPath: `pi-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (result.canceled || !result.filePath) return { path: null, entries: 0, skipped: [] };
    const report = await diagnostics.archive(result.filePath, days, { app: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, platform: process.platform });
    return { path: result.filePath, ...report };
  });
  handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.getUsageReport, async (_event, query: UsageQuery) => {
    await queue; return agent.getUsageReport(query, await workspaces(), Object.keys(await readAutomated()));
  });
  handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.cancelManagementOperation, async (_event, id: string) => { storage.cancel(id); await agent.cancelUsageReport(id); });
  handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.getStorageSnapshot, (_event, id: string) => storage.snapshot(id));
  handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.previewStorageCleanup, (_event, request: { requestId: string; categories: StorageCategory[]; olderThanDays: number }) => storage.preview(request));
  handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.executeStorageCleanup, (_event, id: string) => storage.execute(id));
  return { rememberAutomation, dispose: async () => { await queue; await diagnostics.flush(); } };
}
