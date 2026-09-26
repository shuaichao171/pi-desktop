import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitDeliveryPreview, GitDeliveryResult, TaskWorktree } from '@pidesktop/shared/workbenchFeatures';
import { runFeatureProcess, safeGitEnv, type ProcessRunner } from './gitFeatureProcess.ts';
export function githubRepository(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? null;
}
const safeUrl = (url: string) => url.replace(/(https?:\/\/)[^/@]+@/g, '$1');
export class WorktreeDeliveryService {
  private busy = false; private deliveries = new Map<string, GitDeliveryPreview>();
  private currentCwd: () => string; private directory: string; private run: ProcessRunner;
  constructor(currentCwd: () => string, directory: string, run: ProcessRunner = runFeatureProcess) { this.currentCwd = currentCwd; this.directory = directory; this.run = run; }
  private git(cwd: string, args: string[]) { return this.run('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], { env: safeGitEnv(), timeout: 120_000 }); }
  private async read<T>(name: string, fallback: T): Promise<T> { try { const bytes = await readFile(join(this.directory, name)); if (bytes.length > 2 * 1024 * 1024) throw new Error('工作台记录超限'); return JSON.parse(bytes.toString()) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; } }
  private async save(name: string, value: unknown) { await mkdir(this.directory, { recursive: true }); const temp = join(this.directory, `${name}.${randomUUID()}.tmp`); try { await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, join(this.directory, name)); } finally { await rm(temp, { force: true }); } }
  async listWorktrees(): Promise<TaskWorktree[]> { const items = await this.read<TaskWorktree[]>('worktrees.json', []); if (!Array.isArray(items) || items.length > 1000) throw new Error('工作树记录无效'); return Promise.all(items.map(async item => ({ ...item, missing: !await stat(item.cwd).then(info => info.isDirectory(), () => false), sessionMissing: item.sessionPath ? !await stat(item.sessionPath).then(info => info.isFile(), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; }) : false }))); }
  async createWorktree(request: { cwd: string; ref: string; branch: string }): Promise<TaskWorktree> {
    if (this.busy) throw new Error('工作台修改正在进行');
    if (!request || request.cwd !== this.currentCwd() || typeof request.ref !== 'string' || !request.ref || request.ref.length > 250 || request.ref.startsWith('-') || /[\x00-\x1f]/.test(request.ref) || typeof request.branch !== 'string' || !request.branch || request.branch.startsWith('-') || request.branch.length > 250) throw new Error('工作区、ref 或分支无效');
    this.busy = true; let created: string | undefined;
    try {
      const project = await realpath(request.cwd); const repo = (await this.git(project, ['rev-parse', '--show-toplevel'])).stdout.trim();
      await this.git(project, ['check-ref-format', '--branch', request.branch]);
      const commit = (await this.git(project, ['rev-parse', '--verify', `${request.ref}^{commit}`])).stdout.trim();
      const prefix = relative(repo, project); if (isAbsolute(prefix) || prefix.startsWith(`..${sep}`)) throw new Error('项目不属于仓库');
      if (prefix && (await this.git(repo, ['cat-file', '-t', `${commit}:${prefix.split(sep).join('/')}`])).stdout.trim() !== 'tree') throw new Error('所选提交不包含项目目录');
      const id = randomUUID(), path = join(this.directory, 'worktrees', id); await mkdir(resolve(path, '..'), { recursive: true });
      if (this.currentCwd() !== request.cwd) throw new Error('工作区已切换，请重新创建');
      await this.git(repo, ['worktree', 'add', '-b', request.branch, path, commit]); created = path;
      const item: TaskWorktree = { id, project, cwd: join(path, prefix), branch: request.branch, ref: request.ref, commit, createdAt: new Date().toISOString() };
      const items = await this.listWorktrees(); if (items.length >= 1000) throw new Error('工作树记录数量达到上限'); await this.save('worktrees.json', [...items, item]); return item;
    } catch (error) { if (created) throw new Error(`工作树已创建在 ${created}，但记录保存失败；未自动删除，请保留该路径。${String(error)}`); throw error; }
    finally { this.busy = false; }
  }
  async bindWorktree(request: { id: string; sessionPath: string }): Promise<TaskWorktree> {
    if (this.busy) throw new Error('工作台修改正在进行');
    if (!request || typeof request.sessionPath !== 'string' || !isAbsolute(request.sessionPath) || request.sessionPath.includes('\0')) throw new Error('会话路径无效');
    this.busy = true;
    try { const items = await this.listWorktrees(), item = items.find(item => item.id === request.id);
      if (!item || item.cwd !== this.currentCwd() || item.missing) throw new Error('请先切换至目标工作树');
      item.sessionPath = request.sessionPath; await this.save('worktrees.json', items); return item;
    } finally { this.busy = false; }
  }
  async deliveryPreview(cwd: string): Promise<GitDeliveryPreview> {
    if (typeof cwd !== 'string' || cwd !== this.currentCwd()) throw new Error('工作区已切换');
    const branch = await this.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(result => result.stdout.trim(), () => null);
    if (!branch) throw new Error('Detached HEAD 无法推送，请先创建或切换到本地分支');
    const head = (await this.git(cwd, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    const names = (await this.git(cwd, ['remote'])).stdout.trim().split('\n').filter(Boolean);
    const remotes = await Promise.all(names.map(async name => { const url = (await this.git(cwd, ['remote', 'get-url', '--push', name])).stdout.trim(); return { name, url, github: Boolean(githubRepository(url)) }; }));
    const upstream = await this.git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then(result => result.stdout.trim(), () => null);
    const ghAvailable = await this.run('gh', ['--version'], { timeout: 5000 }).then(() => true, () => false);
    const links = await this.read<Record<string, string>>('pull-requests.json', {});
    const defaultRemote = remotes.find(item => item.name === 'origin') ?? remotes[0];
    const preview: GitDeliveryPreview = { id: randomUUID(), cwd, branch, head, upstream, remotes, ghAvailable, savedPr: defaultRemote ? links[JSON.stringify([cwd, branch, defaultRemote.url])] : undefined };
    this.deliveries.set(preview.id, preview); while (this.deliveries.size > 20) this.deliveries.delete(this.deliveries.keys().next().value!);
    return { ...preview, remotes: remotes.map(item => ({ ...item, url: safeUrl(item.url) })) };
  }
  private async approved(id: string, remote: string) {
    const preview = this.deliveries.get(id), destination = preview?.remotes.find(item => item.name === remote);
    if (!preview || !destination || !/^[A-Za-z0-9._/-]+$/.test(remote) || remote.startsWith('-') || preview.cwd !== this.currentCwd()) throw new Error('交付预览无效，请刷新');
    const refreshed = await this.deliveryPreview(preview.cwd), current = this.deliveries.get(refreshed.id)!;
    if (preview.cwd !== this.currentCwd() || current.head !== preview.head || current.branch !== preview.branch || current.remotes.find(item => item.name === remote)?.url !== destination.url) throw new Error('分支、提交或远端已变化，请刷新后确认');
    return { preview, destination };
  }
  async push(request: { id: string; remote: string }): Promise<GitDeliveryResult> {
    if (!request || typeof request.id !== 'string' || typeof request.remote !== 'string') throw new Error('推送请求无效');
    if (this.busy) throw new Error('工作台修改正在进行'); this.busy = true;
    try { const { preview } = await this.approved(request.id, request.remote); await this.git(preview.cwd, ['push', '--set-upstream', request.remote, `HEAD:refs/heads/${preview.branch}`]); return { branch: preview.branch, head: preview.head, remote: request.remote }; }
    finally { this.busy = false; }
  }
  async draftPr(request: { id: string; remote: string; base: string; title: string; body: string }): Promise<GitDeliveryResult> {
    if (this.busy) throw new Error('工作台修改正在进行');
    if (!request || typeof request.id !== 'string' || typeof request.remote !== 'string' || typeof request.title !== 'string' || !request.title.trim() || request.title.length > 250 || typeof request.body !== 'string' || request.body.length > 64_000 || typeof request.base !== 'string' || !request.base || request.base.startsWith('-')) throw new Error('PR 标题、正文或目标分支无效');
    this.busy = true; let bodyFile: string | undefined;
    try {
      const { preview, destination } = await this.approved(request.id, request.remote), repository = githubRepository(destination.url);
      if (!repository || !preview.ghAvailable) throw new Error('首期草稿 PR 需要 GitHub.com 远端与已安装的 gh');
      await this.git(preview.cwd, ['check-ref-format', '--branch', request.base]);
      const remoteHead = (await this.git(preview.cwd, ['ls-remote', request.remote, `refs/heads/${preview.branch}`])).stdout.split(/\s/)[0];
      if (remoteHead !== preview.head) throw new Error('此提交尚未推送到所选远端；请先明确执行推送');
      const existing = JSON.parse((await this.run('gh', ['pr', 'list', '--repo', repository, '--head', preview.branch, '--state', 'open', '--json', 'url'], { cwd: preview.cwd, timeout: 30_000 })).stdout) as { url: string }[];
      let url = existing[0]?.url;
      if (!url) {
        await mkdir(this.directory, { recursive: true }); bodyFile = join(this.directory, `pr-body-${randomUUID()}.md`); await writeFile(bodyFile, request.body, { flag: 'wx', mode: 0o600 });
        url = (await this.run('gh', ['pr', 'create', '--draft', '--repo', repository, '--head', preview.branch, '--base', request.base, '--title', request.title.trim(), '--body-file', bodyFile], { cwd: preview.cwd, timeout: 120_000 })).stdout.trim();
      }
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)) throw new Error('gh 未返回有效的 PR 地址，请检查 GitHub 后刷新');
      const links = await this.read<Record<string, string>>('pull-requests.json', {}); links[JSON.stringify([preview.cwd, preview.branch, destination.url])] = url;
      try { await this.save('pull-requests.json', links); } catch (error) { throw new Error(`PR 已存在：${url}，但本地关联保存失败，请保留此链接。${String(error)}`); }
      return { branch: preview.branch, head: preview.head, remote: request.remote, url, existing: existing.length > 0 };
    } finally { if (bodyFile) await rm(bodyFile, { force: true }); this.busy = false; }
  }
}
