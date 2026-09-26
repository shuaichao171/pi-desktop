import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { UiFileCheckpoint } from '@pidesktop/shared/workbenchFeatures';
const exec = promisify(execFile), MAX_BYTES = 2 * 1024 * 1024;
export type CheckpointFileState = { exists: boolean; fingerprint: string; text: string | null; mode?: number };
type Record = { path: string; before: CheckpointFileState; after: CheckpointFileState; reason?: string };
type Checkpoint = { id: string; cwd: string; sessionId: string; completedAt: string; restored: boolean; files: Record[]; warning?: string };
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export class FileCheckpoint {
  private round: Checkpoint | null = null; private bytes = 0; private busy = false; private failure: string | null = null;
  private cwd: string; private manager: SessionManager;
  constructor(cwd: string, manager: SessionManager) { this.cwd = cwd; this.manager = manager; }
  private path() { return join(this.manager.getSessionDir(), '.pi-desktop-checkpoints', `${this.manager.getSessionId()}.json`); }
  private async persist(path: string, value: unknown) { await mkdir(resolve(path, '..'), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`; try { await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, path); } finally { await rm(temp, { force: true }); } }
  async begin() {
    this.round = null; this.bytes = 0; this.failure = null;
    // An interrupted restore owns its backup until explicitly recovered. A new
    // agent round must not replace the only copy of that recovery information.
    if (await readFile(`${this.path()}.recovery`).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) {
      if (!(await this.load())?.restored) return;
      await rm(`${this.path()}.recovery`).catch(() => {});
    }
    try { await exec('git', ['-C', this.cwd, 'rev-parse', '--is-inside-work-tree'], { windowsHide: true, timeout: 4000 }); this.round = { id: randomUUID(), cwd: this.cwd, sessionId: this.manager.getSessionId(), completedAt: '', restored: false, files: [] }; }
    catch { /* First release only supports Git workspaces. */ }
  }
  record(path: string, before: CheckpointFileState, after: CheckpointFileState, reason?: string) {
    if (!this.round || this.round.sessionId !== this.manager.getSessionId()) return;
    const old = this.round.files.find(file => file.path === path);
    if (old && old.after.fingerprint !== before.fingerprint) reason = '回合执行期间文件被其他操作修改';
    const value: Record = { path, before: structuredClone(old?.before ?? before), after: structuredClone(after), reason: old?.reason ?? reason };
    if ([value.before, value.after].some(state => state.text !== null && state.exists && hash(Buffer.from(state.text)) !== state.fingerprint)) { value.reason ??= '文本编码无法无损还原原始字节'; value.before.text = null; value.after.text = null; }
    const size = Buffer.byteLength(value.before.text ?? '') + Buffer.byteLength(value.after.text ?? '');
    if (value.before.text === null || value.after.text === null || size + this.bytes > MAX_BYTES || this.round.files.length >= 200) { value.reason ??= '二进制、超限或未完整捕获的文件'; value.before.text = null; value.after.text = null; }
    this.bytes += size;
    if (old) this.round.files.splice(this.round.files.indexOf(old), 1, value); else if (this.round.files.length < 500) this.round.files.push(value); else this.round.warning = '超过 500 个文件，部分路径未记录；仅撤销下列明确覆盖的文件。';
  }
  uncovered(reason: string) { if (this.round) this.round.warning = reason; }
  async complete() {
    const round = this.round; this.round = null;
    if (!round || round.sessionId !== this.manager.getSessionId()) return;
    round.completedAt = new Date().toISOString();
    try { await this.persist(this.path(), round); }
    catch (error) { this.round = null; this.failure = `最近回合检查点保存失败，不能使用旧检查点：${String(error)}`; }
  }
  private async load(): Promise<Checkpoint | null> {
    try { const bytes = await readFile(this.path()); if (bytes.length > 5 * MAX_BYTES) throw new Error('检查点超限'); const value = JSON.parse(bytes.toString()) as Checkpoint; if (value.cwd !== this.cwd || value.sessionId !== this.manager.getSessionId() || !Array.isArray(value.files) || value.files.length > 500) throw new Error('检查点身份无效'); for (const file of value.files) { await this.target(file.path); for (const state of [file.before, file.after]) if (typeof state?.exists !== 'boolean' || typeof state.fingerprint !== 'string' || !(state.text === null || typeof state.text === 'string') || state.text !== null && state.fingerprint !== (state.exists ? hash(Buffer.from(state.text)) : 'missing')) throw new Error('检查点内容校验失败'); } return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async target(path: string) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('检查点路径无效');
    const root = await realpath(this.cwd), target = resolve(root, path), rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes('.git')) throw new Error('检查点路径越界');
    let current = root; for (const part of rel.split(sep)) { current = join(current, part); const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }); if (info?.isSymbolicLink()) throw new Error('检查点路径包含符号链接'); }
    return target;
  }
  private async current(path: string): Promise<string> {
    const target = await this.target(path);
    try { const info = await lstat(target); if (!info.isFile() || info.size > 8 * 1024 * 1024) return 'unavailable'; return hash(await readFile(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  }
  async preview(): Promise<UiFileCheckpoint | null> {
    if (this.failure) throw new Error(this.failure);
    const saved = await this.load(); if (!saved) return null;
    const files: UiFileCheckpoint['files'] = [];
    for (const file of saved.files) {
      const fingerprint = await this.current(file.path).catch(() => 'unavailable');
      const status = saved.restored ? 'restored' : file.reason ? 'uncovered' : fingerprint !== file.after.fingerprint ? 'conflict' : 'ready';
      files.push({ path: file.path, kind: !file.before.exists ? 'added' : !file.after.exists ? 'deleted' : 'modified', status, reason: file.reason ?? (status === 'conflict' ? '回合后文件已改变，不能覆盖当前内容' : undefined), ...(file.before.text !== null && file.after.text !== null ? { diff: `--- a/${file.path}\n+++ b/${file.path}\n${file.before.text.split('\n').map(line => '-'+line).join('\n')}\n${file.after.text.split('\n').map(line => '+'+line).join('\n')}` } : {}) });
    }
    const recovery = saved.restored ? undefined : await readFile(`${this.path()}.recovery`).then(() => '上次撤销未完成。再次操作将先恢复撤销前内容；发生外部修改的文件不会被覆盖。', () => undefined);
    return { id: saved.id, version: hash(JSON.stringify([saved, files.map(file => file.status)])), cwd: saved.cwd, sessionId: saved.sessionId, completedAt: saved.completedAt, restored: saved.restored, files, warning: saved.warning, recovery };
  }
  private async put(file: Record, state: CheckpointFileState, expected: string) {
    if (state.text === null) throw new Error('文件没有完整备份');
    if (await this.current(file.path) !== expected) throw new Error(`文件出现外部修改：${file.path}`);
    const target = await this.target(file.path);
    if (!state.exists) { await rm(target); return; }
    await mkdir(resolve(target, '..'), { recursive: true }); const temp = `${target}.pi-rewind-${randomUUID()}`;
    try { await writeFile(temp, state.text, { flag: 'wx', mode: state.mode ?? 0o600 }); if (await this.current(file.path) !== expected) throw new Error(`文件出现外部修改：${file.path}`); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
  }
  async rewind(request: { id: string; version: string }): Promise<UiFileCheckpoint> {
    if (this.busy || this.round) throw new Error('回合或文件恢复正在进行');
    this.busy = true; const journalPath = `${this.path()}.recovery`;
    try {
      const saved = await this.load(), view = await this.preview();
      if (!saved || !view || saved.id !== request.id || view.version !== request.version || saved.restored) throw new Error('检查点或文件状态已变化，请刷新预览');
      if (view.recovery) {
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { id: string; paths: string[] };
        if (journal.id !== saved.id || !Array.isArray(journal.paths)) throw new Error('恢复记录身份无效');
        for (const path of [...journal.paths].reverse()) { const file = saved.files.find(file => file.path === path); if (!file) throw new Error('恢复路径无效'); const current = await this.current(path); if (current === file.after.fingerprint) continue; await this.put(file, file.after, file.before.fingerprint); }
        await rm(journalPath); return (await this.preview())!;
      }
      if (view.files.some(file => file.status === 'conflict')) throw new Error('存在外部修改冲突；未修改任何文件');
      const files = saved.files.filter(file => !file.reason && file.before.text !== null && file.after.text !== null);
      if (!files.length) throw new Error('没有完整覆盖的可撤销文件');
      const applied: Record[] = [];
      try {
        for (const file of files) { await this.persist(journalPath, { id: saved.id, paths: [...applied.map(file => file.path), file.path] }); await this.put(file, file.before, file.after.fingerprint); applied.push(file); }
        saved.restored = true; await this.persist(this.path(), saved);
        // The durable restored flag commits this operation. Journal cleanup may
        // fail without turning a completed restore into a rollback.
        await rm(journalPath).catch(() => {});
      } catch (cause) {
        let failed = false; for (const file of [...applied].reverse()) try { await this.put(file, file.after, file.before.fingerprint); } catch { failed = true; }
        if (!failed) await rm(journalPath, { force: true });
        throw new Error(`撤销失败${failed ? '，保留恢复记录，请重新打开检查点修复' : '，已恢复撤销前内容'}：${String(cause)}`);
      }
      return (await this.preview())!;
    } finally { this.busy = false; }
  }
}
