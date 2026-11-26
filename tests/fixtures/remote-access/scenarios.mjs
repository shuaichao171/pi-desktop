// Settings → 远程访问: a running LAN server lists plain-HTTP endpoints with an
// "unencrypted" badge plus a trusted-network warning, while HTTPS/loopback routes do not.
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../remote-access/scenarios.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../remote-access/scenarios.mjs
async function installRunningRemoteAccess() {
  const bridge = window.piDesktop;
  const base = await bridge.getRemoteAccessState();
  const endpoint = (id, kind, label, httpBaseUrl, isHttps, isDefault = false) => ({
    id, kind, label, httpBaseUrl, wsBaseUrl: httpBaseUrl.replace(/^http/, 'ws'), isHttps, ...(isDefault ? { isDefault: true } : {}),
  });
  const state = {
    ...base,
    config: { ...base.config, enabled: true, tailscaleServeEnabled: true },
    running: true,
    bindHost: '0.0.0.0',
    port: 47910,
    endpoints: [
      endpoint('lan-0', 'lan', '局域网 (Wi-Fi)', 'http://192.168.1.23:47910', false, true),
      endpoint('ts-https', 'tailscale', 'Tailscale HTTPS', 'https://fixture-desktop.tailnet.ts.net', true),
      endpoint('lo', 'loopback', '本机回环', 'http://127.0.0.1:47910', false),
    ],
    tailscale: { ...base.tailscale, available: true, running: true, active: true, magicDnsName: 'fixture-desktop.tailnet.ts.net', url: 'https://fixture-desktop.tailnet.ts.net' },
  };
  bridge.getRemoteAccessState = async () => structuredClone(state);
  bridge.setRemoteAccessConfig = async () => structuredClone(state);
  bridge.refreshRemoteNetwork = async () => structuredClone(state);
}

export default async function remoteAccessScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.evaluate(`(${installRunningRemoteAccess.toString()})()`);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '远程访问');
  await review.waitFor("document.querySelectorAll('.pd-remote-endpoint-item').length === 3");
  await review.assert("document.querySelectorAll('.pd-remote-badge.is-plaintext').length === 1", 'Only the LAN plain-HTTP endpoint is marked unencrypted (HTTPS and loopback are not)');
  await review.assert("document.querySelector('.pd-remote-endpoint-item .pd-remote-badge.is-plaintext')?.closest('.pd-remote-endpoint-item')?.textContent.includes('192.168.1.23')", 'The unencrypted badge sits on the LAN address');
  await review.assert("Boolean(document.querySelector('[data-role=plaintext-note]')?.textContent.includes('明文 HTTP'))", 'A trusted-network warning explains the plain-HTTP risk');
  await review.evaluate("document.querySelector('[data-role=plaintext-note]').scrollIntoView({ block: 'center' })");
  await review.screenshot('remote-plaintext-wide');
  await review.viewport(680, 900);
  await review.settle();
  await review.evaluate("document.querySelector('[data-role=plaintext-note]').scrollIntoView({ block: 'center' })");
  await review.screenshot('remote-plaintext-narrow');
}
