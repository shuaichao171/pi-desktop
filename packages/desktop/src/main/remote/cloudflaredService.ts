/**
 * Managed Cloudflare Tunnel (`cloudflared`) subprocess manager.
 *
 * Adapted from T3 Code's apps/server/src/cloud/ManagedEndpointRuntime.ts:
 * - Resolves `cloudflared` from PATH or managed `userData/bin/cloudflared(.exe)`
 * - Supports one-click installation from official Cloudflare GitHub Releases
 * - Supports Quick Tunnel (`--url http://127.0.0.1:<port>`, zero account required)
 *   AND Named Tunnel (`run`, passing TUNNEL_TOKEN strictly via env, never argv)
 * - Automatic QUIC stall detection -> HTTP/2 fallback
 * - Local metrics `/ready` readiness watch + exponential restart backoff
 * - Strict redaction of tunnel tokens from all output/error strings
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RemoteCloudflareMode, UiRemoteCloudflareStatus } from '@pidesktop/shared/remoteAccess';

const execFileAsync = promisify(execFile);

export const CLOUDFLARED_PINNED_VERSION = '2026.2.0';
const QUICK_TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const METRICS_ADDR_REGEX = /Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/i;
const PROTOCOL_REGEX = /\bprotocol=(\w+)/i;
const QUIC_STALL_REGEX = /\btimeout: no recent network activity\b/i;
const REGISTERED_REGEX = /\bRegistered tunnel connection\b/i;
const QUIC_STALLS_BEFORE_HTTP2 = 8;
const QUIC_STALL_WINDOW_MS = 5 * 60_000;
const RESTART_BASE_MS = 1_500;
const RESTART_MAX_MS = 30_000;
const STABLE_UPTIME_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

export interface ResolvedCloudflaredBinary {
  readonly executablePath: string;
  readonly source: 'path' | 'managed';
  readonly version: string | null;
}

/**
 * SHA-256 of every pinned release asset we may download, taken from the GitHub
 * release asset digests of cloudflare/cloudflared@2026.2.0 (the darwin tgz values in
 * that release's notes are stale; the asset digests match the bytes actually served).
 * Bumping CLOUDFLARED_PINNED_VERSION requires refreshing this table.
 */
export const CLOUDFLARED_ASSET_SHA256: Readonly<Record<string, string>> = {
  'cloudflared-windows-amd64.exe': 'b3279f2186a1c3c438ad5865e802bbbec26090c5d3fdb4ac1113f1143a94837a',
  'cloudflared-darwin-arm64.tgz': 'ba99c6f87320236b9f842c3ba4b9526f687560125b7b43a581201579543ca4ff',
  'cloudflared-darwin-amd64.tgz': '685688a260c324eb8d9c9434ca22f0ce4f504fd6acd0706787c4833de8d6eb17',
  'cloudflared-linux-amd64': '176746db3be7dc7bd48f3dd287c8930a4645ebb6e6700f883fddda5a4c307c16',
  'cloudflared-linux-arm64': '03c5d58e283f521d752dc4436014eb341092edf076eb1095953ab82debe54a8e',
};

export function cloudflaredDownloadAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { readonly url: string; readonly archive: 'none' | 'tgz'; readonly binaryName: string; readonly sha256: string } | null {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED_VERSION}`;
  const asset = (name: string, archive: 'none' | 'tgz', binaryName: string) => {
    const sha256 = CLOUDFLARED_ASSET_SHA256[name];
    return sha256 ? { url: `${base}/${name}`, archive, binaryName, sha256 } : null;
  };
  if (platform === 'win32') {
    // Cloudflare publishes no native Windows arm64 build; Windows on Arm runs the x64 build under emulation.
    if (arch === 'x64' || arch === 'arm64') return asset('cloudflared-windows-amd64.exe', 'none', 'cloudflared.exe');
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return asset('cloudflared-darwin-arm64.tgz', 'tgz', 'cloudflared');
    if (arch === 'x64') return asset('cloudflared-darwin-amd64.tgz', 'tgz', 'cloudflared');
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return asset('cloudflared-linux-amd64', 'none', 'cloudflared');
    if (arch === 'arm64') return asset('cloudflared-linux-arm64', 'none', 'cloudflared');
    return null;
  }
  return null;
}

/** Throws unless `bytes` hash to the pinned SHA-256; runs before anything is written or executed. */
export function verifyCloudflaredDownload(bytes: Uint8Array, expectedSha256: string): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`cloudflared 下载校验失败（SHA-256 不匹配）/ Downloaded cloudflared failed SHA-256 verification (expected ${expectedSha256}, got ${actual})`);
  }
}

export function parseCloudflaredLine(line: string): {
  readonly quickUrl?: string;
  readonly metricsAddress?: string;
  readonly registered?: boolean;
  readonly protocol?: string;
  readonly quicStall?: boolean;
} {
  const quickUrl = QUICK_TUNNEL_URL_REGEX.exec(line)?.[0];
  const metricsAddress = METRICS_ADDR_REGEX.exec(line)?.[1];
  const registered = REGISTERED_REGEX.test(line);
  const protocol = PROTOCOL_REGEX.exec(line)?.[1];
  const quicStall = QUIC_STALL_REGEX.test(line);
  return {
    ...(quickUrl ? { quickUrl } : {}),
    ...(metricsAddress ? { metricsAddress } : {}),
    ...(registered ? { registered: true } : {}),
    ...(protocol ? { protocol } : {}),
    ...(quicStall ? { quicStall: true } : {}),
  };
}

export function buildCloudflaredArgs(input: {
  readonly mode: 'quick' | 'named';
  readonly localPort: number;
  readonly http2: boolean;
}): string[] {
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    '--metrics',
    '127.0.0.1:0',
  ];
  if (input.http2) args.push('--protocol', 'http2');
  if (input.mode === 'quick') {
    args.push('--url', `http://127.0.0.1:${input.localPort}`);
  } else {
    args.push('run');
  }
  return args;
}

async function probeBinaryVersion(executablePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executablePath, ['--version'], {
      timeout: 5_000,
      windowsHide: true,
    });
    const match = /version\s+([^\s(]+)/i.exec(String(stdout));
    return match?.[1] ?? String(stdout).trim().slice(0, 40) ?? null;
  } catch {
    return null;
  }
}

export async function resolveCloudflaredBinary(
  managedDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedCloudflaredBinary | null> {
  const binaryName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const managedPath = join(managedDir, binaryName);
  try {
    const info = await stat(managedPath);
    if (info.isFile()) {
      const version = await probeBinaryVersion(managedPath);
      if (version) return { executablePath: managedPath, source: 'managed', version };
    }
  } catch {
    // not installed in managed dir yet
  }

  const pathVersion = await probeBinaryVersion(binaryName);
  if (pathVersion) {
    return { executablePath: binaryName, source: 'path', version: pathVersion };
  }
  return null;
}

function parseNamedPublicUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export async function installCloudflaredBinary(
  managedDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  signal?: AbortSignal,
): Promise<ResolvedCloudflaredBinary> {
  const asset = cloudflaredDownloadAsset(platform, arch);
  if (!asset) {
    throw new Error(`Unsupported platform/arch for managed cloudflared: ${platform}-${arch}`);
  }
  await mkdir(managedDir, { recursive: true });
  const targetPath = join(managedDir, asset.binaryName);
  const tmpPath = `${targetPath}.download-${Date.now()}`;

  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(asset.url, { redirect: 'follow', signal: combinedSignal });
  if (!response.ok) {
    throw new Error(`Failed to download cloudflared (${response.status})`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Downloaded cloudflared exceeds size limit (${contentLength} bytes)`);
  }
  let bytes: Buffer;
  if (response.body) {
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`Downloaded cloudflared exceeds size limit (${MAX_DOWNLOAD_BYTES} bytes)`);
        }
        parts.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    bytes = Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)), received);
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Downloaded cloudflared exceeds size limit (${MAX_DOWNLOAD_BYTES} bytes)`);
    }
  }
  verifyCloudflaredDownload(bytes, asset.sha256);

  try {
    if (asset.archive === 'tgz') {
      const tgzPath = `${tmpPath}.tgz`;
      await writeFile(tgzPath, bytes);
      try {
        await execFileAsync('tar', ['-xzf', tgzPath, '-C', managedDir, 'cloudflared'], {
          timeout: 30_000,
        });
      } finally {
        await rm(tgzPath, { force: true }).catch(() => {});
      }
      await chmod(targetPath, 0o755);
    } else {
      await writeFile(tmpPath, bytes);
      if (platform !== 'win32') await chmod(tmpPath, 0o755);
      await rename(tmpPath, targetPath);
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  const version = await probeBinaryVersion(targetPath);
  if (!version) {
    throw new Error('Downloaded cloudflared binary failed verification');
  }
  return { executablePath: targetPath, source: 'managed', version };
}

export interface CloudflaredDesiredConfig {
  readonly mode: RemoteCloudflareMode;
  readonly localPort: number;
  readonly tunnelToken?: string;
  readonly publicHostname?: string;
}

export class CloudflaredManager {
  private readonly managedDir: string;
  private readonly onStatusChanged: (status: UiRemoteCloudflareStatus) => void;
  private status: UiRemoteCloudflareStatus = {
    mode: 'off',
    status: 'off',
    binaryPath: null,
    binarySource: null,
    version: null,
    protocol: null,
    url: null,
    error: null,
  };
  private desired: CloudflaredDesiredConfig | null = null;
  private child: ChildProcess | null = null;
  private startedAtMs = 0;
  private restartDelayMs = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessTimer: ReturnType<typeof setInterval> | null = null;
  private metricsAddress: string | null = null;
  private notReadyCount = 0;
  private forceHttp2 = false;
  private quicStalls: number[] = [];
  private generation = 0;
  private installAbortController: AbortController | null = null;
  private installPromise: Promise<UiRemoteCloudflareStatus> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(managedDir: string, onStatusChanged: (status: UiRemoteCloudflareStatus) => void) {
    this.managedDir = managedDir;
    this.onStatusChanged = onStatusChanged;
  }

  getStatus(): UiRemoteCloudflareStatus {
    return this.status;
  }

  abortInstall(): void {
    this.installAbortController?.abort();
  }

  async refreshBinaryInfo(): Promise<UiRemoteCloudflareStatus> {
    const resolved = await resolveCloudflaredBinary(this.managedDir);
    this.updateStatus({
      ...this.status,
      binaryPath: resolved?.executablePath ?? null,
      binarySource: resolved?.source ?? null,
      version: resolved?.version ?? null,
    });
    return this.status;
  }

  async install(): Promise<UiRemoteCloudflareStatus> {
    if (this.installPromise) return this.installPromise;
    const run = (async (): Promise<UiRemoteCloudflareStatus> => {
      const controller = new AbortController();
      this.installAbortController = controller;
      this.updateStatus({ ...this.status, status: 'installing', error: null });
      try {
        // Stop any running managed binary before replacing it (Windows locks open executables).
        await this.stopChild();
        const installed = await installCloudflaredBinary(this.managedDir, process.platform, process.arch, controller.signal);
        this.updateStatus({
          ...this.status,
          status: this.desired && this.desired.mode !== 'off' ? 'starting' : 'off',
          binaryPath: installed.executablePath,
          binarySource: installed.source,
          version: installed.version,
          error: null,
        });
        if (this.desired && this.desired.mode !== 'off') {
          await this.applyConfig(this.desired);
        }
        return this.status;
      } catch (error) {
        const aborted = controller.signal.aborted;
        this.updateStatus({
          ...this.status,
          status: aborted ? 'off' : 'error',
          error: aborted ? null : (error instanceof Error ? error.message : String(error)),
        });
        throw error;
      } finally {
        if (this.installAbortController === controller) {
          this.installAbortController = null;
        }
      }
    })();
    this.installPromise = run;
    try {
      return await run;
    } finally {
      if (this.installPromise === run) {
        this.installPromise = null;
      }
    }
  }

  async applyConfig(config: CloudflaredDesiredConfig): Promise<UiRemoteCloudflareStatus> {
    const nextGen = ++this.generation;
    this.desired = config;
    await this.stopChild();
    if (nextGen !== this.generation) return this.status;

    if (config.mode === 'off') {
      const resolved = await resolveCloudflaredBinary(this.managedDir);
      if (nextGen !== this.generation) return this.status;
      this.updateStatus({
        mode: 'off',
        status: 'off',
        binaryPath: resolved?.executablePath ?? null,
        binarySource: resolved?.source ?? null,
        version: resolved?.version ?? null,
        protocol: null,
        url: null,
        error: null,
      });
      return this.status;
    }

    if (config.mode === 'named' && !config.tunnelToken?.trim()) {
      const resolved = await resolveCloudflaredBinary(this.managedDir);
      if (nextGen !== this.generation) return this.status;
      this.updateStatus({
        mode: 'named',
        status: 'error',
        binaryPath: resolved?.executablePath ?? null,
        binarySource: resolved?.source ?? null,
        version: resolved?.version ?? null,
        protocol: null,
        url: null,
        error: '请填写 Cloudflare Tunnel Token / Cloudflare Tunnel Token is required',
      });
      return this.status;
    }

    const resolved = await resolveCloudflaredBinary(this.managedDir);
    if (nextGen !== this.generation) return this.status;
    if (!resolved) {
      this.updateStatus({
        mode: config.mode,
        status: 'error',
        binaryPath: null,
        binarySource: null,
        version: null,
        protocol: null,
        url: null,
        error: '未找到 cloudflared，请点击“下载安装 cloudflared” / cloudflared binary not installed',
      });
      return this.status;
    }

    const namedUrl = config.mode === 'named' ? parseNamedPublicUrl(config.publicHostname) : null;

    this.updateStatus({
      mode: config.mode,
      status: 'starting',
      binaryPath: resolved.executablePath,
      binarySource: resolved.source,
      version: resolved.version,
      protocol: this.forceHttp2 ? 'http2' : null,
      url: namedUrl,
      error: null,
    });

    this.spawnConnector(resolved, config, nextGen);
    return this.status;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.desired = null;
    this.abortInstall();
    await this.stopChild();
    this.updateStatus({
      ...this.status,
      mode: 'off',
      status: 'off',
      protocol: null,
      url: null,
      error: null,
    });
  }

  private spawnConnector(
    binary: ResolvedCloudflaredBinary,
    config: CloudflaredDesiredConfig,
    gen: number,
  ): void {
    const mode = config.mode === 'named' ? 'named' : 'quick';
    const args = buildCloudflaredArgs({
      mode,
      localPort: config.localPort,
      http2: this.forceHttp2,
    });
    const trimmedToken = config.tunnelToken?.trim() ?? '';
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (mode === 'named' && trimmedToken) {
      // Never pass TUNNEL_TOKEN on argv so process listings never expose it.
      env.TUNNEL_TOKEN = trimmedToken;
    }

    const child = spawn(binary.executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    this.child = child;
    this.startedAtMs = Date.now();
    this.metricsAddress = null;
    this.notReadyCount = 0;

    const redact = (text: string) => {
      let out = text;
      if (trimmedToken) out = out.replaceAll(trimmedToken, '<redacted>');
      if (config.tunnelToken && config.tunnelToken !== trimmedToken) {
        out = out.replaceAll(config.tunnelToken, '<redacted>');
      }
      return out;
    };

    const createLineHandler = () => {
      let pendingLine = '';
      return (chunk: Buffer) => {
        if (gen !== this.generation) return;
        pendingLine += chunk.toString('utf8');
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? '';
        for (const raw of lines) {
          const line = redact(raw.trim());
          if (!line) continue;
          this.observeOutputLine(line, gen);
        }
      };
    };

    child.stdout?.on('data', createLineHandler());
    child.stderr?.on('data', createLineHandler());

    child.on('error', (error) => {
      if (gen !== this.generation) return;
      this.clearWatchers();
      if (this.child === child) this.child = null;
      this.updateStatus({
        ...this.status,
        status: 'error',
        ...(mode === 'quick' ? { url: null } : {}),
        error: redact(error.message || 'Failed to spawn cloudflared'),
      });
    });

    child.on('exit', (code) => {
      if (gen !== this.generation) return;
      this.clearWatchers();
      if (this.child === child) this.child = null;
      if (!this.desired || this.desired.mode === 'off') return;

      const uptime = Date.now() - this.startedAtMs;
      if (uptime >= STABLE_UPTIME_MS) {
        this.restartDelayMs = RESTART_BASE_MS;
      } else {
        this.restartDelayMs = this.restartDelayMs === 0
          ? RESTART_BASE_MS
          : Math.min(this.restartDelayMs * 2, RESTART_MAX_MS);
      }
      this.updateStatus({
        ...this.status,
        status: 'starting',
        // A Quick Tunnel's trycloudflare.com URL dies with the process; never keep advertising it.
        ...(mode === 'quick' ? { url: null } : {}),
        error: `cloudflared exited (code ${code ?? 'unknown'}), reconnecting…`,
      });
      const currentDesired = this.desired;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (gen !== this.generation || !currentDesired || currentDesired.mode === 'off') return;
        this.spawnConnector(binary, currentDesired, gen);
      }, this.restartDelayMs);
    });
  }

  private observeOutputLine(line: string, gen: number): void {
    const parsed = parseCloudflaredLine(line);
    if (parsed.metricsAddress && !this.metricsAddress) {
      this.metricsAddress = parsed.metricsAddress;
      this.startReadinessWatcher(parsed.metricsAddress, gen);
    }
    if (parsed.quickUrl && this.status.url !== parsed.quickUrl) {
      this.updateStatus({
        ...this.status,
        status: 'running',
        url: parsed.quickUrl,
        error: null,
      });
    }
    if (parsed.registered) {
      const protocol = parsed.protocol ?? this.status.protocol;
      if (protocol === 'http2') this.forceHttp2 = true;
      this.updateStatus({
        ...this.status,
        status: 'running',
        protocol,
        error: null,
      });
    }
    if (parsed.quicStall && !this.forceHttp2) {
      const now = Date.now();
      this.quicStalls = [...this.quicStalls.filter((at) => now - at < QUIC_STALL_WINDOW_MS), now];
      if (this.quicStalls.length >= QUIC_STALLS_BEFORE_HTTP2 && this.desired) {
        this.forceHttp2 = true;
        this.quicStalls = [];
        void this.applyConfig(this.desired).catch(() => {});
      }
    }
  }

  private startReadinessWatcher(metricsAddress: string, gen: number): void {
    this.clearWatchers();
    this.readinessTimer = setInterval(() => {
      if (gen !== this.generation || !this.child) return;
      void fetch(`http://${metricsAddress}/ready`, { signal: AbortSignal.timeout(4_000) })
        .then((res) => {
          if (gen !== this.generation) return;
          if (res.status === 200) {
            this.notReadyCount = 0;
            if (this.status.status !== 'running') {
              this.updateStatus({ ...this.status, status: 'running', error: null });
            }
          } else if (res.status === 503) {
            this.notReadyCount += 1;
            if (this.notReadyCount >= 6) {
              this.notReadyCount = 0;
              this.child?.kill();
            }
          }
        })
        .catch(() => {
          // ignore transient metrics probe errors
        });
    }, 30_000);
  }

  private clearWatchers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.readinessTimer) {
      clearInterval(this.readinessTimer);
      this.readinessTimer = null;
    }
  }

  private async stopChild(): Promise<void> {
    this.clearWatchers();
    if (this.stopPromise) {
      await this.stopPromise;
    }
    const active = this.child;
    if (!active) return;
    if (active.exitCode !== null || active.signalCode !== null || !active.pid) {
      this.child = null;
      return;
    }
    const stopping = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.child === active) this.child = null;
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          active.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish();
      }, 3_000);
      killTimer.unref?.();
      active.once('exit', () => {
        clearTimeout(killTimer);
        finish();
      });
      active.once('error', () => {
        clearTimeout(killTimer);
        finish();
      });
      try {
        active.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        finish();
      }
    });
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPromise === stopping) {
        this.stopPromise = null;
      }
    }
  }

  private updateStatus(next: UiRemoteCloudflareStatus): void {
    this.status = next;
    this.onStatusChanged(next);
  }
}
