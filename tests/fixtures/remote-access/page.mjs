// Activity bar 手机远控: the phone button sits between the sidebar toggle and Automations,
// opens the remote-control page (status → pairing QR → devices → network/tunnels) and
// toggles back to the chat on a second click.
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../remote-access/page.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../remote-access/page.mjs
async function installRunningRemoteAccess() {
  const bridge = window.piDesktop;
  const base = await bridge.getRemoteAccessState();
  const now = Date.now();
  const state = {
    ...base,
    config: { ...base.config, enabled: true },
    running: true,
    bindHost: '0.0.0.0',
    port: 47910,
    endpoints: [
      { id: 'lan-0', kind: 'lan', label: '局域网 (Wi-Fi)', httpBaseUrl: 'http://192.168.1.23:47910', wsBaseUrl: 'ws://192.168.1.23:47910', isHttps: false, isDefault: true },
      { id: 'lo', kind: 'loopback', label: '本机回环', httpBaseUrl: 'http://127.0.0.1:47910', wsBaseUrl: 'ws://127.0.0.1:47910', isHttps: false },
    ],
    sessions: [{
      sessionId: 'phone-1', label: 'Pixel 9', deviceType: 'mobile', os: 'android', role: 'full', scopes: ['chat:read', 'chat:operate', 'workspace:read'],
      createdAt: new Date(now - 86400000).toISOString(), lastSeenAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 29 * 86400000).toISOString(),
      connected: true, connectedAt: new Date(now - 600000).toISOString(), remoteAddress: '192.168.1.40',
    }],
  };
  window.__remoteReview = { state };
  bridge.getRemoteAccessState = async () => structuredClone(state);
  bridge.setRemoteAccessConfig = async () => structuredClone(state);
  bridge.refreshRemoteNetwork = async () => structuredClone(state);
}

const railOrder = `[...document.querySelectorAll('.pd-activity-bar-top .pd-activity-item')].map((button) => [...button.classList].find((name) => name.startsWith('pd-activity-') && name !== 'pd-activity-item')).join(',')`;

export default async function remoteControlPageScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.evaluate(`(${installRunningRemoteAccess.toString()})()`);

  await review.assert(`${railOrder} === 'pd-activity-sessions,pd-activity-remote,pd-activity-automations,pd-activity-plugins'`, 'The phone button sits between the sidebar toggle and Automations');
  await review.assert("document.querySelector('.pd-activity-remote')?.getAttribute('aria-label') === '手机远控'", 'The phone button is labelled 手机远控');
  await review.click('.pd-activity-remote');
  await review.waitFor("Boolean(document.querySelector('.pd-remote-page [data-remote-variant=page] .pd-remote-status-card'))");
  await review.assert("document.querySelector('.pd-activity-remote').classList.contains('is-active') && document.querySelector('.pd-chat-view-host').hidden", 'The remote view replaces the chat and marks the rail entry active');
  await review.assert("[...document.querySelectorAll('.pd-remote-page .pd-settings-group > .pd-settings-group-head h3')].map((h) => h.textContent).join(',') === '服务状态,手机配对,已配对设备,网络设置,私网与公网穿透'", 'The page leads with status, pairing and devices; network and tunnel settings follow');
  await review.assert("!document.querySelector('.pd-remote-page [data-role=pairing-needs-server]')", 'No “turn on the service” hint while the service runs');
  await review.screenshot('remote-page-top');

  await review.click('.pd-remote-page [data-action=create-remote-pairing]');
  await review.waitFor("Boolean(document.querySelector('.pd-remote-page [data-testid=remote-pairing-qr] svg'))");
  await review.evaluate("document.querySelector('.pd-remote-page [data-testid=remote-pairing-qr]').scrollIntoView({ block: 'center' })");
  await review.screenshot('remote-page-qr');

  await review.evaluate("document.querySelector('.pd-remote-page-scroll').scrollTop = 1e6");
  await review.screenshot('remote-page-settings');

  await review.viewport(680, 900);
  await review.settle();
  await review.evaluate("document.querySelector('.pd-remote-page-scroll').scrollTop = 0");
  await review.screenshot('remote-page-narrow');
  await review.viewport(1440, 1000);
  await review.settle();

  // Service off: pairing explains what to do first.
  await review.evaluate("(() => { const s = window.__remoteReview.state; s.running = false; s.config = { ...s.config, enabled: false }; s.endpoints = []; s.sessions = []; window.__modelReview.emit('onRemoteAccessChanged', structuredClone(s)); })()");
  await review.waitFor("Boolean(document.querySelector('.pd-remote-page [data-role=pairing-needs-server]'))");
  await review.assert("!document.querySelector('.pd-remote-page [data-testid=remote-pairing-qr]')", 'Stopping the service drops the QR generated earlier');
  await review.evaluate("document.querySelector('.pd-remote-page-scroll').scrollTop = 0");
  await review.screenshot('remote-page-stopped');

  await review.click('.pd-activity-remote');
  await review.waitFor("!document.querySelector('.pd-chat-view-host').hidden");
  await review.assert("!document.querySelector('.pd-activity-remote').classList.contains('is-active')", 'A second click returns to the chat');
}
