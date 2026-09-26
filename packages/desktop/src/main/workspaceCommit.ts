import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommitScope, WorkspaceCommitPreview } from '@pidesktop/shared/workbenchFeatures';
import { runFeatureProcess, safeGitEnv, type ProcessRunner } from './gitFeatureProcess.ts';
type Snapshot = { preview: WorkspaceCommitPreview; root: string; repository: string; directory: string; index: string; indexBytes: Buffer | null; tree: string; fingerprint: string; prefix: string };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class WorkspaceCommitService {
  private previews = new Map<string, Snapshot>(); private busy = false;
  private currentCwd: () => string; private run: ProcessRunner;
  constructor(currentCwd: () => string, run: ProcessRunner = runFeatureProcess) { this.currentCwd = currentCwd; this.run = run; }
  private git(root: string, args: string[], index?: string, input?: string | Buffer) {
    return this.run('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], { env: safeGitEnv(index ? { GIT_INDEX_FILE: index } : {}), input });
  }
  private async readIndex(path: string) { return readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }); }
  private async snapshot(cwd: string, scope: CommitScope): Promise<Snapshot> {
    if (typeof cwd !== 'string' || cwd !== this.currentCwd() || !['all', 'stagedOnly'].includes(scope)) throw new Error('工作区或提交范围无效');
    const root = await realpath(cwd), repository = (await this.git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const directory = await mkdtemp(join(tmpdir(), 'pi-commit-')); const index = resolve(root, (await this.git(root, ['rev-parse', '--git-path', 'index'])).stdout.trim());
    try {
      for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) { const path = resolve(root, (await this.git(root, ['rev-parse', '--git-path', name])).stdout.trim()); if (await readFile(path).then(() => true, () => false)) throw new Error('请先在 Git 中完成当前合并或挑选操作'); }
      const head = await this.git(root, ['rev-parse', '--verify', 'HEAD']).then(result => result.stdout.trim(), () => null);
      const branch = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(result => result.stdout.trim(), () => null);
      const prefix = relative(repository, root).split(sep).join('/');
      if (isAbsolute(prefix) || prefix === '..' || prefix.startsWith('../')) throw new Error('工作区不属于仓库');
      const candidate = join(directory, 'candidate');
      await this.git(repository, head ? ['read-tree', head] : ['read-tree', '--empty'], candidate);
      if (scope === 'all') await this.git(root, ['add', '-A', '--', '.'], candidate);
      else {
        const paths = (await this.git(root, ['ls-files', '-z', '--', '.'], candidate)).stdout.split('\0').filter(Boolean);
        for (let offset = 0; offset < paths.length; offset += 30) await this.git(root, ['update-index', '--force-remove', '--', ...paths.slice(offset, offset + 30)], candidate);
        const entries = (await this.git(repository, ['ls-files', '--stage', '-z', '--', prefix || '.'])).stdout;
        if (/(?:^|\0)\d+ [a-f0-9]+ [123]\t/.test(entries)) throw new Error('索引包含未解决的冲突');
        if (entries) await this.git(repository, ['update-index', '-z', '--index-info'], candidate, entries);
      }
      const tree = (await this.git(repository, ['write-tree'], candidate)).stdout.trim();
      const base = head ?? (await this.git(repository, ['hash-object', '-w', '-t', 'tree', '--stdin'], undefined, '')).stdout.trim();
      const names = (await this.git(repository, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', base, tree])).stdout.split('\0');
      const files: WorkspaceCommitPreview['files'] = [];
      for (let i = 0; i + 1 < names.length; i += 2) if (names[i] && names[i + 1]) files.push({ status: names[i]!, path: prefix ? names[i + 1]!.slice(prefix.length + 1) : names[i + 1]! });
      const fullDiff = (await this.git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', base, tree])).stdout;
      const context = `# Commit scope: ${scope}\n${files.map(file => `${file.status} ${file.path}`).join('\n')}\n\n${fullDiff.slice(0, 64 * 1024)}`;
      const indexBytes = await this.readIndex(index);
      const worktree = (await this.git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--', '.'])).stdout;
      const fingerprint = digest(JSON.stringify([head, branch, tree, indexBytes && digest(indexBytes), worktree]));
      return { root, repository, directory, index, indexBytes, tree, fingerprint, prefix, preview: { id: randomUUID(), cwd, scope, branch, head, files, context, truncated: fullDiff.length > 64 * 1024, createdAt: new Date().toISOString() } };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async preview(request: { cwd: string; scope: CommitScope }): Promise<WorkspaceCommitPreview> {
    const snapshot = await this.snapshot(request.cwd, request.scope);
    for (const [id, previous] of this.previews) if (Date.now() - Date.parse(previous.preview.createdAt) > 600_000 || this.previews.size >= 8) { this.previews.delete(id); await rm(previous.directory, { recursive: true, force: true }); }
    this.previews.set(snapshot.preview.id, snapshot); return structuredClone(snapshot.preview);
  }
  async commit(request: { id: string; message: string }): Promise<string> {
    if (this.busy) throw new Error('提交正在进行');
    if (!request || typeof request.id !== 'string') throw new Error('提交预览无效');
    const saved = this.previews.get(request.id);
    if (!saved || Date.now() - Date.parse(saved.preview.createdAt) > 600_000) throw new Error('提交预览已过期，请刷新');
    if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 4000 || request.message.includes('\0')) throw new Error('提交说明无效');
    this.busy = true; let current: Snapshot | undefined; let indexLock: Awaited<ReturnType<typeof open>> | undefined; let newHead: string | undefined; let moved = false;
    try {
      current = await this.snapshot(saved.preview.cwd, saved.preview.scope);
      if (current.fingerprint !== saved.fingerprint) throw new Error('工作区或暂存区已改变，请刷新预览后重新确认');
      if (!saved.preview.files.length) throw new Error('所选范围没有可提交的更改');
      const finalIndex = join(current.directory, 'final-index');
      if (current.indexBytes) await copyFile(current.index, finalIndex); else await this.git(current.repository, ['read-tree', '--empty'], finalIndex);
      const paths = (await this.git(current.root, ['ls-files', '-z', '--', '.'], finalIndex)).stdout.split('\0').filter(Boolean);
      for (let offset = 0; offset < paths.length; offset += 30) await this.git(current.root, ['update-index', '--force-remove', '--', ...paths.slice(offset, offset + 30)], finalIndex);
      const entries = (await this.git(current.repository, ['ls-files', '--stage', '-z', '--', current.prefix || '.'], join(current.directory, 'candidate'))).stdout;
      if (entries) await this.git(current.repository, ['update-index', '-z', '--index-info'], finalIndex, entries);
      await mkdir(resolve(current.index, '..'), { recursive: true });
      indexLock = await open(`${current.index}.lock`, 'wx');
      const actualIndex = await this.readIndex(current.index);
      if (digest(actualIndex ?? '') !== digest(current.indexBytes ?? '') || this.currentCwd() !== saved.preview.cwd) throw new Error('工作区或暂存区已改变，请重新预览');
      await indexLock.writeFile(await readFile(finalIndex)); await indexLock.sync(); await indexLock.close();
      newHead = (await this.git(current.repository, ['commit-tree', current.tree, ...(saved.preview.head ? ['-p', saved.preview.head] : []), '-m', request.message.trim()])).stdout.trim();
      await this.git(current.repository, ['update-ref', '-m', 'pi-desktop commit', 'HEAD', newHead, saved.preview.head ?? '0000000000000000000000000000000000000000']); moved = true;
      await rename(`${current.index}.lock`, current.index); indexLock = undefined;
      this.previews.delete(request.id); await rm(saved.directory, { recursive: true, force: true }).catch(() => {});
      return newHead.slice(0, 12);
    } catch (error) {
      if (moved && newHead && current) {
        try { await this.git(current.repository, saved.preview.head ? ['update-ref', 'HEAD', saved.preview.head, newHead] : ['update-ref', '-d', 'HEAD', newHead]); }
        catch { throw new Error(`提交 ${newHead} 已创建，但索引更新失败。请检查 Git HEAD 与索引后恢复。${String(error)}`); }
      }
      throw error;
    } finally {
      if (indexLock && current) { await indexLock.close().catch(() => {}); await rm(`${current.index}.lock`, { force: true }); }
      this.busy = false;
      if (current) await rm(current.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  async dispose() { const previews = [...this.previews.values()]; this.previews.clear(); await Promise.all(previews.map(item => rm(item.directory, { recursive: true, force: true }))); }
}
