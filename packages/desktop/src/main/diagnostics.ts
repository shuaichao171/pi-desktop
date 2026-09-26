import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

export interface DiagnosticEvent { stage: 'startup' | 'rpc' | 'host' | 'plugin'; action: string; outcome: 'start' | 'success' | 'failure' | 'exit'; durationMs?: number; requestId?: number; code?: string }
const MAX_FILE = 512 * 1024, KEEP = 8, MAX_EXPORT = 4 * 1024 * 1024;
const token = (value: string) => /^[\w:.-]{1,100}$/.test(value) ? value : 'redacted';
export class DiagnosticsService {
  private queue: Promise<void> = Promise.resolve();
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  record(event: DiagnosticEvent): void {
    // Only explicitly allowed telemetry fields. Never serialize arbitrary errors or IPC payloads.
    const record = { time: new Date().toISOString(), stage: event.stage, action: token(event.action), outcome: event.outcome,
      ...(Number.isFinite(event.durationMs) ? { durationMs: Math.max(0, Math.round(event.durationMs!)) } : {}),
      ...(Number.isSafeInteger(event.requestId) ? { requestId: event.requestId } : {}), ...(event.code ? { code: token(event.code) } : {}) };
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const active = join(this.directory, 'events.jsonl');
      const size = await lstat(active).then(info => info.size, () => 0);
      if (size >= MAX_FILE) {
        await rm(join(this.directory, `events.${KEEP}.jsonl`), { force: true });
        for (let i = KEEP - 1; i >= 1; i--) await rename(join(this.directory, `events.${i}.jsonl`), join(this.directory, `events.${i + 1}.jsonl`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rename(active, join(this.directory, 'events.1.jsonl'));
      }
      await appendFile(active, JSON.stringify(record) + '\n', { mode: 0o600 });
    }).catch(() => { /* Diagnostics must not prevent chat or startup. */ });
  }
  async archive(path: string, days: number, versions: Record<string, string>): Promise<{ entries: number; skipped: string[] }> {
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('请选择最近 1 至 30 天');
    await this.queue;
    const files: Record<string, Uint8Array> = {}, skipped: string[] = [];
    let omitted = 0;
    const skip = (reason: string) => { if (skipped.length < 200) skipped.push(reason); else omitted++; };
    let bytes = 0, entries = 0;
    const cutoff = Date.now() - days * 86400000;
    const names = await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') { skipped.push('日志目录不存在'); return []; } throw error; });
    for (const name of names.filter(name => /^events(?:\.\d+)?\.jsonl$/.test(name)).sort()) {
      try {
        const info = await lstat(join(this.directory, name));
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE + 4096) { skipped.push(`${name}: 非普通文件或超限`); continue; }
        const lines = (await readFile(join(this.directory, name), 'utf8')).split('\n'), safe: string[] = [];
        for (const line of lines) {
          if (!line) continue;
          try {
            const value = JSON.parse(line);
            if (Date.parse(value.time) < cutoff || !Number.isFinite(Date.parse(value.time))) continue;
            if (!['startup', 'rpc', 'host', 'plugin'].includes(value.stage) || !['start', 'success', 'failure', 'exit'].includes(value.outcome)) continue;
            safe.push(JSON.stringify({ time: new Date(value.time).toISOString(), stage: value.stage, action: token(String(value.action)), outcome: value.outcome,
              ...(Number.isFinite(value.durationMs) ? { durationMs: value.durationMs } : {}), ...(Number.isSafeInteger(value.requestId) ? { requestId: value.requestId } : {}), ...(value.code ? { code: token(String(value.code)) } : {}) }));
          } catch { skip(`${name}: 跳过损坏记录`); }
        }
        const data = strToU8(safe.join('\n'));
        if (bytes + data.length > MAX_EXPORT) { skipped.push(`${name}: 达到导出容量上限`); continue; }
        files[name] = data; bytes += data.length; entries += safe.length;
      } catch { skipped.push(`${name}: 无法读取`); }
    }
    if (omitted) skipped.push(`其余 ${omitted} 条损坏记录已省略`);
    files['manifest.json'] = strToU8(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), days, versions, entries, bytes, capacity: MAX_EXPORT, skipped, privacy: 'Only phase, outcome, duration and numeric RPC identity. No prompts, attachment bodies, credentials, URLs or raw errors.' }, null, 2));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, zipSync(files), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return { entries, skipped };
  }
  flush(): Promise<void> { return this.queue; }
}
let diagnostics: DiagnosticsService | null = null;
export function initializeDiagnostics(directory: string): DiagnosticsService { return diagnostics ??= new DiagnosticsService(directory); }
export function recordDiagnostic(event: DiagnosticEvent): void { diagnostics?.record(event); }
