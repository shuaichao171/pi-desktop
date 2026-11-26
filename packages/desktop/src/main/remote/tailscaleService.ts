/**
 * Tailscale Serve integration for private HTTPS remote access.
 * Modeled on T3 Code's packages/tailscale/src/tailscale.ts:
 * - Probes `tailscale status --json` for MagicDNS & HTTPS capability
 * - Exposes loopback via `tailscale serve --bg --https=<port> http://127.0.0.1:<localPort>`
 * - Removes only the root mount on disable (`--set-path=/ off`)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  type UiRemoteTailscaleStatus,
} from '@pidesktop/shared/remoteAccess';
import { isTailscaleIpv4Address } from './networkDiscovery.ts';

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 3_500;
const SERVE_TIMEOUT_MS = 10_000;

export type TailscaleRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: TailscaleRunner = async (command, args, timeoutMs) => {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
};

export function tailscaleExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tailscale.exe' : 'tailscale';
}

export function buildTailscaleHttpsUrl(magicDnsName: string, servePort = DEFAULT_TAILSCALE_SERVE_PORT): string {
  const normalized = magicDnsName.trim().replace(/\.$/u, '');
  const url = new URL(`https://${normalized}`);
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  return url.origin;
}

export function classifyTailscaleError(stderr: string, fallback: string): string {
  const text = stderr.trim();
  if (/not logged in|logged out|needs? login/i.test(text)) {
    return 'Tailscale 未登录 / Tailscale is not logged in';
  }
  if (/doesn't appear to be running|tailscaled\.service not running|tailscale is stopped|failed to connect to local tailscale/i.test(text)) {
    return 'Tailscale 服务未运行 / Tailscale daemon is not running';
  }
  if (/permission denied|access denied|must be root|operation not permitted/i.test(text)) {
    return '缺少 Tailscale Serve 操作权限（Linux 请配置 operator 权限）/ Permission denied for tailscale serve';
  }
  if (/https.*not enabled|enable https/i.test(text)) {
    return '请在 Tailscale 控制台开启 MagicDNS 与 HTTPS 证书 / Enable MagicDNS and HTTPS certificates in Tailscale admin';
  }
  return text || fallback;
}

export interface ParsedTailscaleStatus {
  readonly running: boolean;
  readonly magicDnsName: string | null;
  readonly tailnetIpv4: string | null;
  readonly httpsEnabled: boolean | null;
}

export function parseTailscaleStatusJson(raw: string): ParsedTailscaleStatus {
  const parsed = JSON.parse(raw) as {
    BackendState?: unknown;
    Self?: { DNSName?: unknown; TailscaleIPs?: unknown; CapMap?: unknown };
  };
  const running = parsed.BackendState === 'Running';
  const dnsRaw = typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName.trim().replace(/\.$/u, '') : '';
  const magicDnsName = dnsRaw || null;
  let tailnetIpv4: string | null = null;
  if (Array.isArray(parsed.Self?.TailscaleIPs)) {
    for (const ip of parsed.Self.TailscaleIPs) {
      if (typeof ip === 'string' && isTailscaleIpv4Address(ip)) {
        tailnetIpv4 = ip;
        break;
      }
    }
  }
  const capMap = parsed.Self?.CapMap;
  const httpsEnabled =
    typeof capMap === 'object' && capMap !== null && !Array.isArray(capMap)
      ? Object.hasOwn(capMap, 'https')
      : null;
  return { running, magicDnsName, tailnetIpv4, httpsEnabled };
}

export async function probeTailscaleStatus(
  runner: TailscaleRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<UiRemoteTailscaleStatus> {
  const exe = tailscaleExecutable(platform);
  try {
    const { stdout } = await runner(exe, ['status', '--json'], STATUS_TIMEOUT_MS);
    const parsed = parseTailscaleStatusJson(stdout);
    return {
      available: true,
      running: parsed.running,
      active: false,
      magicDnsName: parsed.magicDnsName,
      tailnetIpv4: parsed.tailnetIpv4,
      httpsEnabled: parsed.httpsEnabled,
      url: null,
      error: parsed.running ? null : 'Tailscale 未处于运行状态 / Tailscale is not running',
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      return {
        available: false,
        running: false,
        active: false,
        magicDnsName: null,
        tailnetIpv4: null,
        httpsEnabled: null,
        url: null,
        error: null,
      };
    }
    return {
      available: true,
      running: false,
      active: false,
      magicDnsName: null,
      tailnetIpv4: null,
      httpsEnabled: null,
      url: null,
      error: classifyTailscaleError(err.stderr ?? '', err.message || 'tailscale status failed'),
    };
  }
}

export async function enableTailscaleServe(
  input: { readonly localPort: number; readonly servePort?: number },
  runner: TailscaleRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<UiRemoteTailscaleStatus> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const status = await probeTailscaleStatus(runner, platform);
  if (!status.available) {
    return {
      ...status,
      error: '未检测到 Tailscale CLI / Tailscale CLI not found in PATH',
    };
  }
  if (!status.running || !status.magicDnsName) {
    return {
      ...status,
      error: status.error ?? 'Tailscale 未连接或未启用 MagicDNS / Tailscale not connected or MagicDNS disabled',
    };
  }
  if (status.httpsEnabled === false) {
    return {
      ...status,
      error: '请在 Tailscale 控制台启用 HTTPS 证书 / Enable HTTPS certificates in Tailscale admin',
    };
  }

  const exe = tailscaleExecutable(platform);
  try {
    await runner(
      exe,
      ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${input.localPort}`],
      SERVE_TIMEOUT_MS,
    );
    return {
      ...status,
      active: true,
      url: buildTailscaleHttpsUrl(status.magicDnsName, servePort),
      error: null,
    };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return {
      ...status,
      active: false,
      url: null,
      error: classifyTailscaleError(err.stderr ?? '', err.message || 'tailscale serve failed'),
    };
  }
}

export async function disableTailscaleServe(
  input: { readonly servePort?: number } = {},
  runner: TailscaleRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const exe = tailscaleExecutable(platform);
  try {
    await runner(exe, ['serve', `--https=${servePort}`, '--set-path=/', 'off'], SERVE_TIMEOUT_MS);
  } catch {
    // Handler might already be absent or tailscale not installed; safe to ignore on disable.
  }
}
