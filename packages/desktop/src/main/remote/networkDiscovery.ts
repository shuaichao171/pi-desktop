/**
 * Network interface discovery for desktop LAN and Tailscale route advertising.
 * Adapted from T3 Code's DesktopServerExposure heuristics.
 */

import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { httpToWsUrl, type RemoteAdvertisedEndpoint } from '@pidesktop/shared/remoteAccess';

const VIRTUAL_INTERFACE_PATTERN =
  /^(bridge\d|utun|ipsec|ppp|tun|tap|wg|docker|br-|veth|virbr|vmnet|vboxnet|VirtualBox|VMware|vEthernet|WSL|Loopback)/i;

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 100 && nums[1]! >= 64 && nums[1]! <= 127;
}

export function isUsableLanIpv4Address(address: string): boolean {
  return (
    !address.startsWith('127.') &&
    !address.startsWith('169.254.') &&
    !isTailscaleIpv4Address(address)
  );
}

export interface DiscoveredAddresses {
  readonly lanIpv4: string | null;
  readonly allLanIpv4: readonly string[];
  readonly tailscaleIpv4: string | null;
}

export function discoverHostAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = osNetworkInterfaces(),
): DiscoveredAddresses {
  const physicalLan: string[] = [];
  const fallbackLan: string[] = [];
  let tailscaleIpv4: string | null = null;

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const info of entries ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      if (isTailscaleIpv4Address(info.address)) {
        if (!tailscaleIpv4) tailscaleIpv4 = info.address;
        continue;
      }
      if (!isUsableLanIpv4Address(info.address)) continue;
      if (VIRTUAL_INTERFACE_PATTERN.test(name)) {
        if (!fallbackLan.includes(info.address)) fallbackLan.push(info.address);
      } else {
        if (!physicalLan.includes(info.address)) physicalLan.push(info.address);
      }
    }
  }

  const allLanIpv4 = [...physicalLan, ...fallbackLan];
  return {
    lanIpv4: allLanIpv4[0] ?? null,
    allLanIpv4,
    tailscaleIpv4,
  };
}

export function buildAdvertisedEndpoints(input: {
  readonly port: number;
  readonly exposureMode: 'local-only' | 'lan';
  readonly addresses: DiscoveredAddresses;
  readonly tailscaleHttpsUrl: string | null;
  readonly cloudflareUrl: string | null;
}): RemoteAdvertisedEndpoint[] {
  const endpoints: RemoteAdvertisedEndpoint[] = [];

  if (input.cloudflareUrl) {
    const httpBaseUrl = input.cloudflareUrl.replace(/\/+$/, '');
    endpoints.push({
      id: `cloudflare:${httpBaseUrl}`,
      kind: 'cloudflare',
      label: 'Cloudflare Tunnel',
      httpBaseUrl,
      wsBaseUrl: httpToWsUrl(httpBaseUrl),
      isHttps: httpBaseUrl.startsWith('https://'),
      isDefault: true,
    });
  }

  if (input.tailscaleHttpsUrl) {
    const httpBaseUrl = input.tailscaleHttpsUrl.replace(/\/+$/, '');
    endpoints.push({
      id: `tailscale-https:${httpBaseUrl}`,
      kind: 'tailscale',
      label: 'Tailscale HTTPS',
      httpBaseUrl,
      wsBaseUrl: httpToWsUrl(httpBaseUrl),
      isHttps: true,
      isDefault: endpoints.length === 0,
    });
  }

  if (input.exposureMode === 'lan') {
    for (const ip of input.addresses.allLanIpv4) {
      const httpBaseUrl = `http://${ip}:${input.port}`;
      endpoints.push({
        id: `lan:${httpBaseUrl}`,
        kind: 'lan',
        label: `LAN (${ip})`,
        httpBaseUrl,
        wsBaseUrl: `ws://${ip}:${input.port}`,
        isHttps: false,
        isDefault: endpoints.length === 0,
      });
    }
    if (input.addresses.tailscaleIpv4 && !input.tailscaleHttpsUrl) {
      const httpBaseUrl = `http://${input.addresses.tailscaleIpv4}:${input.port}`;
      endpoints.push({
        id: `tailscale-ip:${httpBaseUrl}`,
        kind: 'tailscale',
        label: `Tailscale (${input.addresses.tailscaleIpv4})`,
        httpBaseUrl,
        wsBaseUrl: `ws://${input.addresses.tailscaleIpv4}:${input.port}`,
        isHttps: false,
        isDefault: endpoints.length === 0,
      });
    }
  }

  const loopbackHttp = `http://127.0.0.1:${input.port}`;
  endpoints.push({
    id: `loopback:${loopbackHttp}`,
    kind: 'loopback',
    label: 'This machine (127.0.0.1)',
    httpBaseUrl: loopbackHttp,
    wsBaseUrl: `ws://127.0.0.1:${input.port}`,
    isHttps: false,
  });

  return endpoints;
}
