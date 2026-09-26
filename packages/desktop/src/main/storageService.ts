import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { StorageCategory, StorageCleanupResult, StoragePlan, StorageSnapshot } from '@pidesktop/shared';
interface File { path: string; category: StorageCategory; bytes: number; mtime: number; fingerprint: string; cleanable: boolean }
const categories: StorageCategory[] = ['sessions', 'attachments', 'trash', 'diagnostics', 'search-cache', 'corrupt-backups', 'settings'];
const cleanable = new Set<StorageCategory>(['diagnostics', 'search-cache', 'corrupt-backups']);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export class StorageService {
  private operations = new Map<string, AbortController>();
  private plans = new Map<string, { plan: StoragePlan; files: File[]; roots: Map<string, string> }>();
  private cleanup: Promise<StorageCleanupResult> | null = null;
  private userData: string; private agentDir: string;
  constructor(userData: string, agentDir: string) { this.userData = userData; this.agentDir = agentDir; }
  cancel(id: string): void { this.operations.get(id)?.abort(); }
  private async rootIdentity(root: string) { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('应用数据根目录已替换或属于链接'); return `${await realpath(root)}:${info.dev}:${info.ino}`; }
  private async safeParents(path: string, roots: Map<string, string>) {
    const root = [...roots.keys()].find(root => resolve(path).startsWith(resolve(root) + sep));
    if (!root || await this.rootIdentity(root) !== roots.get(root)) throw new Error('应用数据根目录已改变');
    let parent = resolve(root);
    for (const part of relative(root, path).split(sep).slice(0, -1)) { parent = join(parent, part); const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('目录已替换为链接'); }
  }
  private async scan(requestId: string): Promise<{ files: File[]; skipped: string[]; limited: boolean }> {
    if (!/^[\w-]{1,100}$/.test(requestId) || this.operations.has(requestId) || this.operations.size >= 2) throw new Error('空间扫描请求无效或仍在进行');
    const controller = new AbortController(); this.operations.set(requestId, controller);
    const files: File[] = [], skipped: string[] = []; let count = 0, limited = false;
    const add = async (path: string, category: StorageCategory, mayClean: boolean) => {
      controller.signal.throwIfAborted();
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) { skipped.push(`${path}: 链接`); return; }
        if (info.isFile()) files.push({ path, category, bytes: info.size, mtime: info.mtimeMs, fingerprint: `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`, cleanable: mayClean });
      } catch { skipped.push(`${path}: 无法读取`); }
    };
    const walk = async (root: string, category: StorageCategory, depth = 0): Promise<void> => {
      controller.signal.throwIfAborted();
      if (++count > 30000 || depth > 5) { limited = true; return; }
      let entries; try { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) return; entries = await readdir(root, { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push(`${root}: 无法读取`); return; }
      for (const entry of entries) {
        if (++count > 30000) { limited = true; break; }
        const path = join(root, entry.name);
        if (entry.isDirectory()) await walk(path, category, depth + 1);
        else if (category === 'sessions' && depth === 0 && entry.name === '.desktop-search-v1.json') await add(path, 'search-cache', true);
        else await add(path, category, category === 'diagnostics' && /^events\.\d+\.jsonl$/.test(entry.name));
        if (count % 250 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    try {
      await walk(join(this.agentDir, 'sessions'), 'sessions');
      await walk(join(this.agentDir, 'desktop-inputs'), 'attachments');
      await walk(join(this.userData, 'session-trash'), 'trash');
      await walk(join(this.userData, 'diagnostics'), 'diagnostics');
      for (const root of [this.userData, this.agentDir]) {
        for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isFile()) continue;
          const category: StorageCategory = /\.corrupt-.*\.bak$/.test(entry.name) ? 'corrupt-backups' : entry.name === 'desktop-usage-index.json' ? 'search-cache' : 'settings';
          await add(join(root, entry.name), category, cleanable.has(category));
        }
      }
      return { files, skipped, limited };
    } finally { this.operations.delete(requestId); }
  }
  async snapshot(id: string): Promise<StorageSnapshot> {
    const result = await this.scan(id);
    return { items: categories.map(category => ({ category, bytes: result.files.filter(file => file.category === category).reduce((sum, file) => sum + file.bytes, 0), files: result.files.filter(file => file.category === category).length, cleanable: cleanable.has(category) })), skipped: result.skipped, limited: result.limited };
  }
  async preview(request: { requestId: string; categories: StorageCategory[]; olderThanDays: number }): Promise<StoragePlan> {
    if (!request || !Array.isArray(request.categories) || request.categories.some(category => !cleanable.has(category)) || !Number.isInteger(request.olderThanDays) || request.olderThanDays < 1 || request.olderThanDays > 3650) throw new Error('清理范围无效');
    const roots = new Map<string, string>(); for (const root of [this.userData, this.agentDir]) try { roots.set(root, await this.rootIdentity(root)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const result = await this.scan(request.requestId), cutoff = Date.now() - request.olderThanDays * 86400000;
    const files = result.files.filter(file => file.cleanable && request.categories.includes(file.category) && file.mtime < cutoff).slice(0, 1000);
    const controller = new AbortController(); this.operations.set(request.requestId, controller);
    try { for (const file of files) { controller.signal.throwIfAborted(); await this.safeParents(file.path, roots); if (file.bytes <= 64 * 1024 * 1024) file.fingerprint += `:${digest(await readFile(file.path, { signal: controller.signal }))}`; } }
    finally { this.operations.delete(request.requestId); }
    const plan: StoragePlan = { id: randomUUID(), files: files.map(({ path, category, bytes }) => ({ path, category, bytes })), bytes: files.reduce((sum, file) => sum + file.bytes, 0), expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
    for (const [id, entry] of this.plans) if (Date.parse(entry.plan.expiresAt) <= Date.now()) this.plans.delete(id);
    if (this.plans.size >= 10) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, { plan, files, roots }); return plan;
  }
  async execute(id: string): Promise<StorageCleanupResult> {
    if (this.cleanup) throw new Error('已有清理正在进行');
    const entry = this.plans.get(id); if (!entry || Date.parse(entry.plan.expiresAt) <= Date.now()) throw new Error('清理预览已过期，请重新扫描');
    this.plans.delete(id);
    this.cleanup = (async () => {
      const result: StorageCleanupResult = { releasedBytes: 0, removed: 0, failed: [] };
      for (const file of entry.files) {
        try {
          const allowed = [this.userData, this.agentDir].some(root => { const rel = relative(resolve(root), resolve(file.path)); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.includes(':'); });
          if (!allowed || !file.cleanable) throw new Error('清理目标不属于应用缓存');
          // Walk parent directories again so replacement junctions cannot redirect deletion.
          await this.safeParents(file.path, entry.roots);
          const info = await lstat(file.path);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('文件类型已变化');
          let fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
          if (file.bytes <= 64 * 1024 * 1024) fingerprint += `:${digest(await readFile(file.path))}`;
          if (fingerprint !== file.fingerprint) throw new Error('文件已变化，请重新预览');
          await this.safeParents(file.path, entry.roots);
          const after = await lstat(file.path); if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` !== `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}` || after.isSymbolicLink()) throw new Error('文件已变化，请重新预览');
          await unlink(file.path); result.releasedBytes += file.bytes; result.removed++;
        } catch (error) { result.failed.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) }); }
      }
      return result;
    })();
    try { return await this.cleanup; } finally { this.cleanup = null; }
  }
}
