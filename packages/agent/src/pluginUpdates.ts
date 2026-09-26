import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import semver from 'semver';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent';
import type { PluginUpdateCheck, PluginUpdatePreview } from '../../shared/src/pluginUpdates.ts';
import type { PluginServices, PluginDependencies } from './plugins.ts';
const previews = new Map<string, { preview: PluginUpdatePreview; fingerprint: string; expires: number }>();
const installing = new Set<string>();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cwdKey = (cwd: string) => process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd);
function parse(source: string): { name: string; constraint: string } {
  const match = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@([^\s]+))?$/i.exec(source);
  if (!match) throw new Error('仅支持标准 npm 包来源'); return { name: match[1], constraint: match[2] || 'latest' };
}
const configured = (services: PluginServices, scope: 'user' | 'project') => (scope === 'project' ? services.settingsManager.getProjectSettings() : services.settingsManager.getGlobalSettings()).packages ?? [];
export async function checkPluginUpdate(services: PluginServices, request: PluginUpdateCheck, dependencies?: PluginDependencies & { fetch?: typeof fetch }): Promise<PluginUpdatePreview> {
  if (!request || typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || cwdKey(request.cwd) !== cwdKey(services.cwd) || !['user', 'project'].includes(request.scope) || typeof request.source !== 'string' || request.latest !== undefined && typeof request.latest !== 'boolean') throw new Error('插件检查参数无效');
  await services.settingsManager.reload();
  const initialFingerprint = fingerprint(configured(services, request.scope));
  const source = configured(services, request.scope).find(entry => (typeof entry === 'string' ? entry : entry.source) === request.source);
  if (!source) throw new Error('插件配置已改变，请刷新');
  const manager = dependencies?.createManager?.(services) ?? new DefaultPackageManager(services);
  const installedPath = manager.getInstalledPath(request.source, request.scope);
  let installed: string | null = null;
  try { const pkg = JSON.parse(await readFile(join(installedPath!, 'package.json'), 'utf8')); installed = semver.valid(pkg.version); } catch { /* missing package is explicitly repairable */ }
  const preview: PluginUpdatePreview = { id: randomUUID(), cwd: services.cwd, scope: request.scope, source: request.source, installed, constraint: request.source, target: null, latest: null, checkedAt: new Date().toISOString(), kind: 'unsupported', message: '', targetSource: null };
  if (!request.source.startsWith('npm:')) { preview.message = '此来源不使用 npm 版本检查；Git 以配置中的 ref 为准，本地目录直接读取源文件。'; return preview; }
  try {
    const parsed = parse(request.source); preview.constraint = parsed.constraint;
    const response = await (dependencies?.fetch ?? fetch)(`https://registry.npmjs.org/${encodeURIComponent(parsed.name)}`, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!response.ok || !response.body) throw new Error('registry failure');
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 8 * 1024 * 1024) throw new Error('metadata too large'); chunks.push(value); } } finally { await reader.cancel().catch(() => undefined); }
    const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const versions = Object.keys(document.versions ?? {}).filter(value => semver.valid(value));
    preview.latest = semver.valid(document['dist-tags']?.latest);
    const wanted = request.latest ? 'latest' : parsed.constraint;
    preview.target = semver.valid(wanted) ?? (semver.validRange(wanted) ? semver.maxSatisfying(versions, wanted) : semver.valid(document['dist-tags']?.[wanted]));
    if (!preview.target || !document.versions?.[preview.target]) throw new Error('no target');
    if (installed && semver.gt(installed, preview.target)) { preview.kind = 'current'; preview.message = '已安装版本高于候选版本，不会降级。'; }
    else if (installed === preview.target && !semver.valid(parsed.constraint)) { preview.kind = 'current'; preview.message = '已安装版本符合当前约束，无可用更新。'; }
    else { preview.kind = installed && semver.lt(installed, preview.target) ? 'upgrade' : 'repair'; preview.message = preview.kind === 'repair' ? '重新安装指定版本以修复缺包；不会自动升级。' : '确认后安装此准确版本，并将此插件来源固定到该版本。'; }
    preview.targetSource = `npm:${parsed.name}@${preview.target}`;
    for (const [id, item] of previews) if (item.expires < Date.now()) previews.delete(id);
    if (previews.size >= 50) previews.delete(previews.keys().next().value!);
    previews.set(preview.id, { preview: structuredClone(preview), fingerprint: initialFingerprint, expires: Date.now() + 600000 });
  } catch { preview.kind = 'failed'; preview.target = null; preview.targetSource = null; preview.message = '未能检查版本：网络、包信息或版本约束不可用，请稍后重试。'; }
  return preview;
}
export async function installPluginUpdate(services: PluginServices, request: { cwd: string; scope: 'user' | 'project'; previewId: string }, dependencies?: PluginDependencies): Promise<void> {
  if (!request || typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || cwdKey(request.cwd) !== cwdKey(services.cwd) || !['user', 'project'].includes(request.scope) || typeof request.previewId !== 'string') throw new Error('插件安装参数无效');
  if (installing.has(request.previewId)) throw new Error('此目标版本正在安装');
  const entry = previews.get(request.previewId);
  if (!entry || entry.expires < Date.now() || entry.preview.cwd !== services.cwd || entry.preview.scope !== request.scope) throw new Error('版本检查已过期，请重新检查');
  const preview = entry.preview;
  if (!['upgrade', 'repair'].includes(preview.kind) || !preview.targetSource || !preview.target) throw new Error('此检查结果没有可安装目标');
  installing.add(request.previewId);
  try {
  await services.settingsManager.reload();
  const packages = configured(services, request.scope);
  if (fingerprint(packages) !== entry.fingerprint) throw new Error('插件配置已改变，请重新检查');
  const manager = dependencies?.createManager?.(services) ?? new DefaultPackageManager(services);
  await manager.install(preview.targetSource, { local: request.scope === 'project' });
  const path = manager.getInstalledPath(preview.targetSource, request.scope);
  const installed = path ? JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).version : null;
  if (installed !== preview.target) throw new Error('实际安装版本与确认版本不符；请刷新查看安装诊断');
  await services.settingsManager.reload();
  if (fingerprint(configured(services, request.scope)) !== entry.fingerprint) throw new Error('安装期间配置被外部修改，配置未覆盖；已安装目标版本，请刷新核对');
  const next = packages.map(item => (typeof item === 'string' ? item : item.source) === preview.source ? typeof item === 'string' ? preview.targetSource! : { ...item, source: preview.targetSource! } : item);
  if (request.scope === 'project') services.settingsManager.setProjectPackages(next); else services.settingsManager.setPackages(next);
  await services.settingsManager.flush();
  previews.delete(request.previewId);
  } finally { installing.delete(request.previewId); }
}
