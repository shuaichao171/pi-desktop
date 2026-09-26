import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProjectDefaultValues, ProjectDefaultsSnapshot, ProjectDefaultsWrite } from '../../shared/src/managementFeatures.ts';
const keys = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'] as const;
const version = (text: string) => createHash('sha256').update(text).digest('hex');
async function read(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('配置文件必须是小于 1 MiB 的普通文件');
    const text = await readFile(path, 'utf8'), value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目配置格式无效');
    return { text, value };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', value: {} }; throw e; }
}
function values(input: Record<string, unknown>): ProjectDefaultValues {
  const result: ProjectDefaultValues = {};
  for (const key of keys) if (typeof input[key] === 'string') Object.assign(result, { [key]: input[key] });
  return result;
}
export class ProjectDefaultsService {
  private queue: Promise<unknown> = Promise.resolve();
  async snapshot(cwd: string, agentDir: string, trusted: boolean): Promise<ProjectDefaultsSnapshot> {
    const path = join(cwd, '.pi', 'settings.json');
    const [global, project] = await Promise.all([read(join(agentDir, 'settings.json')), read(path)]);
    const defaults = values(global.value), overrides = values(project.value);
    return { cwd, path, version: version(project.text), trusted, reason: trusted ? null : '项目尚未受信任，项目覆盖未生效且不能编辑', global: defaults, project: overrides, effective: { ...defaults, ...(trusted ? overrides : {}) } };
  }
  save(cwd: string, agentDir: string, trusted: boolean, request: ProjectDefaultsWrite): Promise<ProjectDefaultsSnapshot> {
    const work = this.queue.then(async () => {
      if (!trusted) throw new Error('请先信任项目，再修改项目默认值');
      if (!request || resolve(request.cwd) !== resolve(cwd)) throw new Error('项目已改变，请刷新');
      if (!request.values || typeof request.values !== 'object' || Array.isArray(request.values) || Object.keys(request.values).some(key => !keys.includes(key as typeof keys[number]))) throw new Error('仅支持模型和思考级别默认值');
      for (const [key, value] of Object.entries(request.values)) {
        if (typeof value !== 'string' || !value.trim() || value.length > 400 || /[\x00-\x1f]/.test(value)) throw new Error('默认值无效');
        if (key === 'defaultThinkingLevel' && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('思考级别无效');
      }
      const path = join(cwd, '.pi', 'settings.json'), current = await read(path);
      if (version(current.text) !== request.expectedVersion) throw new Error('配置已被外部修改，请刷新后重试');
      const next = { ...current.value }; for (const key of keys) delete next[key]; Object.assign(next, request.values);
      await mkdir(dirname(path), { recursive: true });
      const directory = await lstat(dirname(path)); if (directory.isSymbolicLink()) throw new Error('项目配置目录不能是链接');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
        if (version((await read(path)).text) !== request.expectedVersion) throw new Error('配置已被外部修改，请刷新后重试');
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      return this.snapshot(cwd, agentDir, trusted);
    });
    this.queue = work.catch(() => undefined); return work;
  }
}
