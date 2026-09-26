import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DefaultPackageManager, parseFrontmatter, type PackageManager, type PackageSource, type ResolvedResource, type ResourceLoader, type SettingsManager } from '@earendil-works/pi-coding-agent';
import type { UiPluginCatalog, UiPluginMutation, UiPluginResource, UiPluginResourceKind, UiPluginResourcePreview, UiPluginScope } from '@pidesktop/shared';
import { installPluginUpdate } from './pluginUpdates.ts';

const KINDS: UiPluginResourceKind[] = ['extensions', 'skills', 'prompts', 'themes'];
const TEXT_LIMIT = 65_536;
export interface PluginServices { cwd: string; agentDir: string; settingsManager: SettingsManager; resourceLoader: ResourceLoader }
export interface PluginDependencies { createManager?: (services: PluginServices) => PackageManager }
const managerFor = (services: PluginServices, dependencies?: PluginDependencies): PackageManager => dependencies?.createManager?.(services) ?? new DefaultPackageManager(services);
const key = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const safeText = (value: unknown, limit = 600): string => typeof value === 'string' ? value.replaceAll('\0', '').slice(0, limit) : '';
const describeError = (error: unknown): string => safeText(error instanceof Error ? error.message : String(error), 2000);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function inputText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label}无效`);
  return value.trim();
}
function checkCwd(services: PluginServices, cwd: unknown): void {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || key(cwd) !== key(services.cwd)) throw new Error('插件所属项目已改变，请刷新后重试');
}
function checkScope(value: unknown): asserts value is UiPluginScope {
  if (value !== 'user' && value !== 'project') throw new Error('插件作用域无效');
}
function checkKind(value: unknown): asserts value is UiPluginResourceKind {
  if (!KINDS.includes(value as UiPluginResourceKind)) throw new Error('插件资源类型无效');
}
function requireTrust(services: PluginServices, scope: UiPluginScope): void {
  if (scope === 'project' && !services.settingsManager.isProjectTrusted()) throw new Error('此项目尚未受信任，无法修改项目插件');
}
async function readText(path: string): Promise<{ text: string; truncated: boolean }> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('资源不是普通文件');
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(buffer.subarray(0, Math.min(length, TEXT_LIMIT)));
    if (text.includes('\0')) throw new Error('资源不是可预览的文本');
    return { text, truncated: length > TEXT_LIMIT };
  } finally { await file.close(); }
}
async function metadata(path: string): Promise<Record<string, unknown>> {
  try {
    const contents = await readText(path);
    if (contents.truncated) return {};
    const parsed: unknown = JSON.parse(contents.text.replace(/^\uFEFF/, ''));
    return isObject(parsed) ? parsed : {};
  } catch { return {}; }
}
function resourcePattern(services: PluginServices, item: ResolvedResource): string | null {
  const base = item.metadata.baseDir ?? (item.metadata.scope === 'project' ? join(services.cwd, '.pi') : services.agentDir);
  const path = relative(base, item.path);
  if (!path) return null;
  const outside = isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
  if (outside && item.metadata.origin === 'package') return null;
  // Top-level resources may intentionally live in ~/.agents or ancestor projects.
  return (outside ? resolve(item.path) : path).split(sep).join('/');
}
async function canToggle(services: PluginServices, item: ResolvedResource, manager: PackageManager): Promise<boolean> {
  if (item.metadata.scope === 'temporary' || (item.metadata.scope === 'project' && !services.settingsManager.isProjectTrusted())) return false;
  if (!resourcePattern(services, item)) return false;
  if (item.metadata.origin === 'package') {
    const entry = (item.metadata.scope === 'project' ? services.settingsManager.getProjectSettings() : services.settingsManager.getGlobalSettings()).packages
      ?.find((entry) => (typeof entry === 'string' ? entry : entry.source) === item.metadata.source);
    if (!entry) return false;
    // Pi ignores resource filters for local single-file package sources.
    const source = typeof entry === 'string' ? entry : entry.source;
    if (!source.startsWith('npm:') && !/^(?:git:)?https?:\/\//.test(source) && !/^(?:git:|ssh:\/\/)/.test(source)) {
      const installedPath = manager.getInstalledPath(source, item.metadata.scope);
      try { if (!installedPath || (await stat(installedPath)).isFile()) return false; } catch { return false; }
    }
  }
  return true;
}
async function refreshSettings(services: PluginServices, strict: boolean): Promise<string[]> {
  await services.settingsManager.reload();
  const warnings = services.settingsManager.drainErrors().map((entry) => describeError(entry.error));
  if (strict && warnings.length) throw new Error(`插件配置读取失败：${warnings.join('；')}`);
  return warnings;
}

export async function readPluginCatalog(services: PluginServices, dependencies?: PluginDependencies): Promise<UiPluginCatalog> {
  const warnings = await refreshSettings(services, false);
  const manager = managerFor(services, dependencies);
  const configured = manager.listConfiguredPackages();
  const missing = new Set<string>();
  const resolved = await manager.resolve(async (source) => { missing.add(source); return 'skip'; });
  const extensions = services.resourceLoader.getExtensions();
  const skills = services.resourceLoader.getSkills();
  const prompts = services.resourceLoader.getPrompts();
  const themes = services.resourceLoader.getThemes();
  for (const item of extensions.errors) warnings.push(`${item.path}: ${item.error}`);
  for (const group of [skills, prompts, themes]) for (const diagnostic of group.diagnostics) warnings.push(diagnostic.message);
  const loaded = {
    extensions: new Map(extensions.extensions.flatMap((item) => [[key(item.path), item], [key(item.resolvedPath), item]] as const)),
    skills: new Map(skills.skills.map((item) => [key(item.filePath), item])),
    prompts: new Map(prompts.prompts.map((item) => [key(item.filePath), item])),
    themes: new Map(themes.themes.filter((item) => item.sourcePath || item.sourceInfo?.path).map((item) => [key(item.sourcePath ?? item.sourceInfo!.path), item])),
  };
  const resources: UiPluginResource[] = [];
  for (const kind of KINDS) for (const item of resolved[kind]) {
    if (item.metadata.scope === 'temporary') continue;
    const active = loaded[kind].get(key(item.path));
    let name = active && 'name' in active ? safeText(active.name, 160) : '';
    let description = active && 'description' in active ? safeText(active.description) : '';
    if ((!name || !description) && (kind === 'skills' || kind === 'prompts')) {
      try {
        const contents = await readText(item.path);
        const frontmatter = parseFrontmatter(contents.text).frontmatter;
        name ||= safeText(frontmatter.name, 160);
        description ||= safeText(frontmatter.description);
      } catch { /* The runtime diagnostics remain the source of loading failures. */ }
    }
    name ||= kind === 'skills' && basename(item.path) === 'SKILL.md' ? basename(dirname(item.path)) : basename(item.path, extname(item.path));
    const error = kind === 'extensions' ? extensions.errors.find((entry) => key(entry.path) === key(item.path))?.error
      : (kind === 'skills' ? skills : kind === 'prompts' ? prompts : themes).diagnostics.find((entry) => entry.type === 'error' && entry.path && key(entry.path) === key(item.path))?.message;
    resources.push({ path: item.path, kind, name, description, enabled: item.enabled, loaded: Boolean(active), canToggle: await canToggle(services, item, manager),
      scope: item.metadata.scope, source: item.metadata.source, origin: item.metadata.origin, ...(error ? { error: safeText(error, 2000) } : {}) });
  }
  const packages = await Promise.all(configured.map(async (item) => {
    const info = item.installedPath ? await metadata(join(item.installedPath, 'package.json')) : {};
    const installed = Boolean(item.installedPath) && !missing.has(item.source);
    if (!installed) warnings.push(`插件尚未安装或版本不匹配：${item.source}`);
    return { source: item.source, scope: item.scope, name: safeText(info.name, 160) || item.source,
      description: safeText(info.description), version: safeText(info.version, 100) || null,
      installed, path: item.installedPath ?? null };
  }));
  return { cwd: services.cwd, projectTrusted: services.settingsManager.isProjectTrusted(), packages, resources, warnings: [...new Set(warnings.map((warning) => safeText(warning, 2000)))].slice(0, 100) };
}

/** Only explicit npm specs, HTTPS Git repositories, or absolute local directories. */
async function validateInstallSource(value: unknown): Promise<string> {
  const source = inputText(value, '插件来源');
  if (source.startsWith('npm:')) {
    const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(source);
    if (!match || match[1].length > 214 || (match[2] && !/^(?:[a-zA-Z][a-zA-Z0-9._-]*|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.test(match[2]))) throw new Error('请输入有效的 npm 包名，可附加版本或标签');
    return source;
  }
  if (/^(?:git:)?https:\/\//.test(source)) {
    const raw = source.startsWith('git:') ? source.slice(4) : source;
    const url = new URL(raw);
    const repository = url.pathname.split('@')[0];
    if (url.username || url.password || url.search || url.hash || !url.hostname || !/^\/(?:[^/]+\/)+[^/]+$/.test(repository)
      || /[\s\\]/.test(source) || source.includes('%') || source.split('/').includes('..')) throw new Error('Git 来源必须为不含凭据的 HTTPS 仓库地址');
    const ref = url.pathname.slice(repository.length);
    if (ref && !/^@[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error('Git 分支或版本格式无效');
    return source;
  }
  if (!isAbsolute(source)) throw new Error('请选择本地插件目录，或输入 npm / HTTPS Git 来源');
  const path = await realpath(source);
  if (!(await stat(path)).isDirectory()) throw new Error('本地插件必须是目录，请选择包含资源的插件文件夹');
  return path;
}

function updatePatterns(current: string[] | undefined, pattern: string, enabled: boolean, packageEntry?: Exclude<PackageSource, string>): string[] {
  // [] means none for a package, whereas only +/- patterns default to all.
  const base = current?.length === 0 && packageEntry && packageEntry.autoload !== false ? ['!**/*'] : [...(current ?? [])];
  return [...base.filter((entry) => !/^[!+-]/.test(entry) || entry.replace(/^[!+-]+/, '').replaceAll('\\', '/') !== pattern), `${enabled ? '+' : '-'}${pattern}`];
}
function writePaths(services: PluginServices, kind: UiPluginResourceKind, scope: UiPluginScope, paths: string[]): void {
  const settings = services.settingsManager;
  if (kind === 'extensions') scope === 'project' ? settings.setProjectExtensionPaths(paths) : settings.setExtensionPaths(paths);
  if (kind === 'skills') scope === 'project' ? settings.setProjectSkillPaths(paths) : settings.setSkillPaths(paths);
  if (kind === 'prompts') scope === 'project' ? settings.setProjectPromptTemplatePaths(paths) : settings.setPromptTemplatePaths(paths);
  if (kind === 'themes') scope === 'project' ? settings.setProjectThemePaths(paths) : settings.setThemePaths(paths);
}
async function flushSettings(services: PluginServices): Promise<void> {
  await services.settingsManager.flush();
  const failures = services.settingsManager.drainErrors();
  if (failures.length) {
    await services.settingsManager.reload();
    throw new Error(`插件配置保存失败：${failures.map((entry) => describeError(entry.error)).join('；')}`);
  }
}

export async function applyPluginMutation(services: PluginServices, input: UiPluginMutation, dependencies?: PluginDependencies): Promise<void> {
  if (!isObject(input)) throw new Error('插件操作格式无效');
  checkCwd(services, input.cwd);
  await refreshSettings(services, true);
  if (input.action === 'reload') return;
  checkScope(input.scope);
  requireTrust(services, input.scope);
  const manager = managerFor(services, dependencies);
  if (input.action === 'set-enabled') {
    checkKind(input.kind);
    if (typeof input.enabled !== 'boolean') throw new Error('插件启用状态无效');
    const path = inputText(input.path, '插件资源路径', 32_768);
    if (!isAbsolute(path)) throw new Error('资源路径必须为绝对路径');
    const resources = await manager.resolve(async () => 'skip');
    const item = resources[input.kind].find((item) => key(item.path) === key(path) && item.metadata.scope === input.scope);
    if (!item) throw new Error('未找到此项目中的插件资源');
    if (!await canToggle(services, item, manager)) throw new Error('此资源不支持单独启用或停用，请管理所属插件');
    if (item.enabled === input.enabled) return;
    const pattern = resourcePattern(services, item)!;
    const settings = services.settingsManager;
    const current = input.scope === 'project' ? settings.getProjectSettings() : settings.getGlobalSettings();
    if (item.metadata.origin === 'package') {
      const packages = [...(current.packages ?? [])];
      const index = packages.findIndex((entry) => (typeof entry === 'string' ? entry : entry.source) === item.metadata.source);
      if (index < 0) throw new Error('未找到资源所属插件');
      const original = packages[index];
      const entry = typeof original === 'string' ? { source: original } : original;
      packages[index] = { ...entry, [input.kind]: updatePatterns(entry[input.kind], pattern, input.enabled, entry) };
      input.scope === 'project' ? settings.setProjectPackages(packages) : settings.setPackages(packages);
    } else writePaths(services, input.kind, input.scope, updatePatterns(current[input.kind], pattern, input.enabled));
    await flushSettings(services);
    return;
  }
  if (input.action === 'update-target') {
    await installPluginUpdate(services, input, dependencies);
    await flushSettings(services);
    return;
  }
  if (!['install', 'remove', 'update'].includes(input.action)) throw new Error('插件操作无效');
  const source = inputText(input.source, '插件来源');
  if (input.action === 'install') await manager.installAndPersist(await validateInstallSource(source), { local: input.scope === 'project' });
  else {
    const configured = manager.listConfiguredPackages().find((item) => item.scope === input.scope && item.source === source);
    if (!configured) throw new Error('未找到此作用域中的已配置插件');
    if (input.action === 'remove') {
      if (source.startsWith('npm:')) await validateInstallSource(source);
      // Persisted local paths are relative to settings, but the SDK interprets
      // removal input relative to cwd. Pass their absolute identity instead.
      const remote = /^(?:npm:|git:|https?:\/\/|ssh:\/\/)/.test(source);
      const removalSource = remote ? source : configured.installedPath ?? resolve(input.scope === 'project' ? join(services.cwd, '.pi') : services.agentDir, source);
      const removed = await manager.removeAndPersist(removalSource, { local: input.scope === 'project' });
      if (!removed) throw new Error('插件配置未移除，请刷新后重试');
    }
    else {
      if (!/^npm:|^(?:git:)?https:\/\//.test(source)) throw new Error('本地插件从源目录读取，无需更新；此远程来源暂不支持桌面更新');
      await validateInstallSource(source);
      await manager.update(source);
    }
  }
  await flushSettings(services);
}

export async function readPluginResourcePreview(services: PluginServices, request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }, dependencies?: PluginDependencies): Promise<UiPluginResourcePreview> {
  if (!isObject(request)) throw new Error('插件预览参数无效');
  checkCwd(services, request.cwd); checkKind(request.kind); checkScope(request.scope);
  if (request.kind !== 'skills' && request.kind !== 'prompts') throw new Error('仅支持预览技能和提示词文本');
  const path = inputText(request.path, '资源路径', 32_768);
  if (!isAbsolute(path)) throw new Error('资源路径必须为绝对路径');
  await refreshSettings(services, true);
  const resolved = await managerFor(services, dependencies).resolve(async () => 'skip');
  const resource = resolved[request.kind].find((item) => key(item.path) === key(path) && item.metadata.scope === request.scope);
  if (!resource || extname(resource.path).toLowerCase() !== '.md') throw new Error('未找到可预览的插件资源');
  return { path: resource.path, ...await readText(resource.path) };
}
