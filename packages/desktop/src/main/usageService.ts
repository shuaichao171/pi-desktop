import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { UsageQuery, UsageReport, UsageRow } from '@pidesktop/shared';
import { readStateFileAsync, writeStateFileAsync } from './stateFiles.ts';
interface Entry { key: string; timestamp: string; cwd: string; provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }
interface Cached { fingerprint: string; entries: Entry[]; parentSession?: string }
interface Ledger { version: 2; files: Record<string, Cached> }
const validDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validCache = (value: Cached | undefined): value is Cached => !!value && typeof value.fingerprint === 'string' && Array.isArray(value.entries) && value.entries.every(entry => entry && ['key', 'timestamp', 'cwd', 'provider', 'model'].every(key => typeof entry[key as keyof Entry] === 'string') && Number.isFinite(Date.parse(entry.timestamp)) && [entry.input, entry.output, entry.cacheRead, entry.cacheWrite].every(value => Number.isFinite(value) && value >= 0) && (entry.cost === null || Number.isFinite(entry.cost) && entry.cost >= 0));
export class UsageService {
  private cache: Ledger | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, AbortController>();
  private sessionsRoot: string; private indexPath: string;
  constructor(sessionsRoot: string, indexPath: string) { this.sessionsRoot = sessionsRoot; this.indexPath = indexPath; }
  cancel(id: string): void { this.pending.get(id)?.abort(); }
  report(query: UsageQuery, workspaces: string[], automatedPaths: string[]): Promise<UsageReport> {
    if (!query || !/^[\w-]{1,100}$/.test(query.requestId) || !validDate(query.from) || !validDate(query.to) || query.from > query.to) return Promise.reject(new Error('用量查询范围无效'));
    const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: query.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (this.pending.has(query.requestId) || this.pending.size >= 3) return Promise.reject(new Error('用量查询仍在进行'));
    const controller = new AbortController(); this.pending.set(query.requestId, controller);
    const work = this.queue.then(async () => {
      controller.signal.throwIfAborted();
      if (!this.cache) this.cache = await readStateFileAsync(this.indexPath, (): Ledger => ({ version: 2, files: {} }), (v): v is Ledger => !!v && typeof v === 'object' && (v as Ledger).version === 2 && !!(v as Ledger).files && typeof (v as Ledger).files === 'object').catch((): Ledger => ({ version: 2, files: {} }));
      const next: Ledger = { version: 2, files: {} }, skipped: string[] = [], seen = new Set<string>(), rows = new Map<string, UsageRow>();
      const automated = new Set(automatedPaths), allowed = new Set(workspaces);
      let scanned = 0, updated = 0, bytes = 0;
      scan: for (const directory of await readdir(this.sessionsRoot, { withFileTypes: true }).catch(() => [])) {
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
        for (const name of await readdir(join(this.sessionsRoot, directory.name)).catch(() => { skipped.push(`${directory.name}: 无法读取目录`); return []; })) {
          controller.signal.throwIfAborted(); if (!name.endsWith('.jsonl')) continue;
          if (++scanned > 20000 || bytes > 512 * 1024 * 1024) { skipped.push('达到单次扫描上限，请缩小历史数据范围后重试'); break scan; }
          const path = join(this.sessionsRoot, directory.name, name);
          try {
            const info = await lstat(path), fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
            if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) { skipped.push(`${name}: 超限或非普通文件`); continue; }
            let cached = this.cache!.files[path];
            if (!validCache(cached) || cached.fingerprint !== fingerprint) {
              cached = { fingerprint, ...await parseUsage(path, controller.signal) }; bytes += info.size; updated++;
              const after = await lstat(path); if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== fingerprint) { skipped.push(`${name}: 正在写入，将在下次刷新统计`); continue; }
            }
            next.files[path] = cached;
          } catch (error) { controller.signal.throwIfAborted(); skipped.push(`${name}: ${error instanceof SyntaxError ? '记录损坏' : '无法统计'}`); }
        }
      }
      // A SDK fork keeps historical message IDs but creates a new session ID.
      // Count an inherited message at its original file before applying project
      // and automation filters, so a copy cannot change cost ownership.
      const keysByPath = new Map(Object.entries(next.files).map(([path, file]) => [path, new Set(file.entries.map(entry => entry.key))]));
      for (const [path, cached] of Object.entries(next.files)) {
            for (const entry of cached.entries) {
              controller.signal.throwIfAborted();
              if (cached.parentSession && keysByPath.get(cached.parentSession)?.has(entry.key)) continue;
              if (seen.has(entry.key)) continue; seen.add(entry.key);
              if (!allowed.has(entry.cwd) || (query.cwd && entry.cwd !== query.cwd) || (query.provider && entry.provider !== query.provider) || (query.model && entry.model !== query.model)) continue;
              const date = dateFormat.format(new Date(entry.timestamp)); if (date < query.from || date > query.to) continue;
              const source = automated.has(path) ? 'automation' : 'interactive'; if (query.source && query.source !== source) continue;
              const key = JSON.stringify([date, entry.cwd, entry.provider, entry.model, source]);
              const row = rows.get(key) ?? { date, cwd: entry.cwd, provider: entry.provider, model: entry.model, source, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownPriceMessages: 0, priceSource: 'session-message-estimate' as const };
              row.messages++; for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) row[key] += entry[key];
              if (entry.cost === null) row.unknownPriceMessages++; else row.cost = (row.cost ?? 0) + entry.cost;
              rows.set(key, row);
            }
      }
      controller.signal.throwIfAborted();
      await writeStateFileAsync(this.indexPath, next); this.cache = next;
      for (const row of rows.values()) if (row.unknownPriceMessages > 0) row.cost = null;
      return { rows: [...rows.values()].sort((a, b) => b.date.localeCompare(a.date)), skipped, scanned, updated };
    }).finally(() => this.pending.delete(query.requestId));
    this.queue = work.catch(() => undefined); return work;
  }
}
async function parseUsage(path: string, signal: AbortSignal): Promise<{ entries: Entry[]; parentSession?: string }> {
  const stream = createReadStream(path, { encoding: 'utf8', signal }), lines = createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = '', cwd = '', count = 0, parentSession: string | undefined; const entries: Entry[] = [];
  try { for await (const line of lines) {
    signal.throwIfAborted(); if (!line.trim()) continue;
    if (line.length > 16 * 1024 * 1024) throw new Error('记录超限');
    const record = JSON.parse(line);
    if (record.type === 'session') { sessionId = typeof record.id === 'string' ? record.id : ''; cwd = typeof record.cwd === 'string' ? record.cwd : ''; parentSession = typeof record.parentSession === 'string' ? record.parentSession : undefined; continue; }
    const message = record.message, usage = message?.usage;
    if (record.type !== 'message' || message?.role !== 'assistant' || !usage || !sessionId || !cwd || typeof record.id !== 'string') continue;
    const timestamp = message.timestamp ?? record.timestamp;
    if (!Number.isFinite(new Date(timestamp).getTime())) continue;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    const total = usage.cost?.total;
    const key = createHash('sha256').update(JSON.stringify([record.id, new Date(timestamp).toISOString(), message.provider, message.model, usage])).digest('hex');
    entries.push({ key, timestamp: new Date(timestamp).toISOString(), cwd, provider: String(message.provider ?? 'unknown'), model: String(message.model ?? 'unknown'), input: number(usage.input), output: number(usage.output), cacheRead: number(usage.cacheRead), cacheWrite: number(usage.cacheWrite), cost: typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null });
    if (++count % 250 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  } } finally { lines.close(); stream.destroy(); }
  return { entries, parentSession };
}
