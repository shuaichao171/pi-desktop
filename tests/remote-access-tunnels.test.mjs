import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@pidesktop/shared/remoteAccess') {
      return nextResolve(new URL('../packages/shared/src/remoteAccess.ts', import.meta.url).href, context);
    }
    if (specifier === '@pidesktop/shared/remoteClient') {
      return nextResolve(new URL('../packages/shared/src/remoteClient.ts', import.meta.url).href, context);
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

test('network discovery separates LAN, Tailscale, and virtual adapters and orders endpoints', async () => {
  const { discoverHostAddresses, buildAdvertisedEndpoints, isTailscaleIpv4Address } = await import(
    '../packages/desktop/src/main/remote/networkDiscovery.ts'
  );

  assert.equal(isTailscaleIpv4Address('100.64.0.1'), true);
  assert.equal(isTailscaleIpv4Address('100.127.255.254'), true);
  assert.equal(isTailscaleIpv4Address('192.168.1.50'), false);

  const discovered = discoverHostAddresses({
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    'vEthernet (WSL)': [{ address: '172.24.16.1', netmask: '255.255.240.0', family: 'IPv4', mac: '00:15:5d:00:00:01', internal: false, cidr: '172.24.16.1/20' }],
    'Wi-Fi': [{ address: '192.168.1.42', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.42/24' }],
    Tailscale: [{ address: '100.99.10.5', netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '100.99.10.5/32' }],
  });

  assert.equal(discovered.lanIpv4, '192.168.1.42');
  assert.equal(discovered.tailscaleIpv4, '100.99.10.5');

  const endpoints = buildAdvertisedEndpoints({
    port: 47910,
    exposureMode: 'lan',
    addresses: discovered,
    tailscaleHttpsUrl: 'https://dev-box.tailnet.ts.net',
    cloudflareUrl: 'https://sunny-owl.trycloudflare.com',
  });
  assert.deepEqual(
    endpoints.map((e) => e.kind),
    ['cloudflare', 'tailscale', 'lan', 'lan', 'loopback'],
  );
  assert.equal(endpoints[0].isDefault, true);
  assert.equal(endpoints[0].wsBaseUrl, 'wss://sunny-owl.trycloudflare.com');
  assert.equal(endpoints[1].wsBaseUrl, 'wss://dev-box.tailnet.ts.net');
});

test('tailscaleService parses status, invokes serve --bg, and cleanly disables only root path', async () => {
  const { probeTailscaleStatus, enableTailscaleServe, disableTailscaleServe } = await import(
    '../packages/desktop/src/main/remote/tailscaleService.ts'
  );

  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'status') {
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: {
            DNSName: 'workstation.tail1234.ts.net.',
            TailscaleIPs: ['100.101.102.103', 'fd7a:115c::1'],
            CapMap: { https: [] },
          },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };

  const probed = await probeTailscaleStatus(mockRunner, 'linux');
  assert.equal(probed.available, true);
  assert.equal(probed.running, true);
  assert.equal(probed.magicDnsName, 'workstation.tail1234.ts.net');
  assert.equal(probed.httpsEnabled, true);

  const enabled = await enableTailscaleServe({ localPort: 47910, servePort: 443 }, mockRunner, 'linux');
  assert.equal(enabled.active, true);
  assert.equal(enabled.url, 'https://workstation.tail1234.ts.net');
  assert.deepEqual(calls.at(-1), ['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:47910']);

  await disableTailscaleServe({ servePort: 443 }, mockRunner, 'linux');
  assert.deepEqual(calls.at(-1), ['tailscale', 'serve', '--https=443', '--set-path=/', 'off']);

  // Missing binary degrades cleanly without throwing
  const missingRunner = async () => {
    const err = new Error('spawn tailscale ENOENT');
    err.code = 'ENOENT';
    throw err;
  };
  const missing = await probeTailscaleStatus(missingRunner, 'win32');
  assert.equal(missing.available, false);
  assert.equal(missing.error, null);
});

test('cloudflaredService parses Quick Tunnel URLs, metrics, QUIC stalls, and never leaks tokens into argv', async () => {
  const { parseCloudflaredLine, buildCloudflaredArgs, cloudflaredDownloadAsset } = await import(
    '../packages/desktop/src/main/remote/cloudflaredService.ts'
  );

  const quickParsed = parseCloudflaredLine('2026-11-27T00:00:00Z INF |  https://crisp-falcon-demo.trycloudflare.com  |');
  assert.equal(quickParsed.quickUrl, 'https://crisp-falcon-demo.trycloudflare.com');

  const metricsParsed = parseCloudflaredLine('INF Starting metrics server on 127.0.0.1:54321/metrics');
  assert.equal(metricsParsed.metricsAddress, '127.0.0.1:54321');

  const regParsed = parseCloudflaredLine('INF Registered tunnel connection connIndex=0 protocol=quic');
  assert.equal(regParsed.registered, true);
  assert.equal(regParsed.protocol, 'quic');

  const stallParsed = parseCloudflaredLine('WRN Failed to serve quic connection error="timeout: no recent network activity"');
  assert.equal(stallParsed.quicStall, true);

  const quickArgs = buildCloudflaredArgs({ mode: 'quick', localPort: 47910, http2: false });
  assert.ok(quickArgs.includes('--url'));
  assert.ok(quickArgs.includes('http://127.0.0.1:47910'));

  const namedArgs = buildCloudflaredArgs({ mode: 'named', localPort: 47910, http2: true });
  assert.ok(namedArgs.includes('--protocol'));
  assert.ok(namedArgs.includes('http2'));
  assert.equal(namedArgs.at(-1), 'run');
  assert.equal(namedArgs.includes('--token'), false);

  assert.equal(cloudflaredDownloadAsset('win32', 'x64')?.binaryName, 'cloudflared.exe');
  assert.equal(cloudflaredDownloadAsset('darwin', 'arm64')?.archive, 'tgz');
  assert.equal(cloudflaredDownloadAsset('linux', 'x64')?.binaryName, 'cloudflared');
});

test('mergeLearnedRemoteRoutes promotes LAN on HTTP pairing but refuses HTTPS->HTTP token downgrade', async () => {
  const { mergeLearnedRemoteRoutes } = await import('../packages/shared/src/remoteClient.ts');

  const advertised = [
    { id: 'lan:1', kind: 'lan', label: 'LAN', httpBaseUrl: 'http://192.168.1.50:47910', wsBaseUrl: 'ws://192.168.1.50:47910', isHttps: false },
    { id: 'ts:1', kind: 'tailscale', label: 'Tailscale HTTPS', httpBaseUrl: 'https://box.tailnet.ts.net', wsBaseUrl: 'wss://box.tailnet.ts.net', isHttps: true },
    { id: 'lo:1', kind: 'loopback', label: 'Loopback', httpBaseUrl: 'http://127.0.0.1:47910', wsBaseUrl: 'ws://127.0.0.1:47910', isHttps: false },
  ];

  const httpsPaired = {
    environmentId: 'env-1',
    label: 'Work PC',
    accessToken: 'tok',
    sessionId: 's1',
    role: 'full',
    scopes: ['chat:read', 'chat:operate', 'workspace:read'],
    pairedOverHttps: true,
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    routes: [{ id: 'manual:cf', kind: 'cloudflare', label: 'Cloudflare', httpBaseUrl: 'https://demo.trycloudflare.com', wsBaseUrl: 'wss://demo.trycloudflare.com', learned: false }],
    addedAt: new Date().toISOString(),
    lastConnectedAt: null,
  };
  const mergedHttps = mergeLearnedRemoteRoutes(httpsPaired, advertised);
  // Loopback excluded; plain HTTP LAN excluded because pairedOverHttps=true; Tailscale HTTPS learned and prioritized ahead of Cloudflare!
  assert.deepEqual(
    mergedHttps.map((r) => r.httpBaseUrl),
    ['https://box.tailnet.ts.net', 'https://demo.trycloudflare.com'],
  );

  const httpPaired = { ...httpsPaired, pairedOverHttps: false };
  const mergedHttp = mergeLearnedRemoteRoutes(httpPaired, advertised);
  // LAN comes first, then Tailscale HTTPS, then Cloudflare; loopback is still never adopted!
  assert.deepEqual(
    mergedHttp.map((r) => r.httpBaseUrl),
    ['http://192.168.1.50:47910', 'https://box.tailnet.ts.net', 'https://demo.trycloudflare.com'],
  );
});
