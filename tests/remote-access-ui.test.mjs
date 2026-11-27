import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('RemoteAccessPanel renders cleanly and is indexed by Settings search (zh-CN + en-US)', async () => {
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);

  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const { RemoteAccessPanel } = await server.ssrLoadModule('/src/components/RemoteAccessPanel.tsx');
    const { searchSettings } = await server.ssrLoadModule('/src/settingsSearch.ts');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');

    const html = renderToStaticMarkup(createElement(RemoteAccessPanel));
    assert.ok(html.includes('data-setting="remote-access"'));
    assert.ok(html.includes(translate('settings.remote.title')));
    assert.ok(html.includes(translate('settings.remote.tailscaleTitle')));
    assert.ok(html.includes(translate('settings.remote.cloudflareTitle')));
    assert.ok(html.includes(translate('settings.remote.generateQr')));

    const zhHits = searchSettings('远程访问', (k) => translate(k, undefined, 'zh-CN'), ['general', 'remote', 'debug'], {
      paiMode: false,
      windows: true,
      desktopSettings: true,
    });
    assert.equal(zhHits.some((r) => r.page === 'remote'), true);

    const enHits = searchSettings('Cloudflare', (k) => translate(k, undefined, 'en-US'), ['general', 'remote', 'debug'], {
      paiMode: false,
      windows: true,
      desktopSettings: true,
    });
    assert.equal(enHits.some((r) => r.page === 'remote'), true);
  } finally {
    await server.close();
  }
});

test('Activity bar 手机远控 entry and the remote-control page layout (SSR)', async () => {
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const { ActivityBar } = await server.ssrLoadModule('/src/components/ActivityBar.tsx');
    const { RemoteControlPage } = await server.ssrLoadModule('/src/components/RemoteControlPage.tsx');
    const { RemoteAccessPanel } = await server.ssrLoadModule('/src/components/RemoteAccessPanel.tsx');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');
    const noop = () => {};
    const bar = (props) => renderToStaticMarkup(createElement(ActivityBar, {
      mainView: 'chat', onOpenView: noop, onNewSession: noop, onOpenSettings: noop, onOpenUpdates: noop,
      navigationPending: false, sidebarOpen: true, onToggleSidebar: noop, ...props,
    }));
    const railOrder = (html) => [...html.matchAll(/pd-activity-item (pd-activity-[a-z-]+)/g)].map((match) => match[1]);

    assert.deepEqual(railOrder(bar({ showRemote: true })).slice(0, 4), ['pd-activity-sessions', 'pd-activity-remote', 'pd-activity-automations', 'pd-activity-plugins'], 'the phone button sits between the sidebar toggle and Automations');
    assert.equal(bar({}).includes('pd-activity-remote'), false, 'pai windows and split panes (showRemote off) get no phone button');
    const active = bar({ showRemote: true, mainView: 'remote' });
    assert.match(active, /pd-activity-remote is-active" aria-label="手机远控" aria-current="page"/);

    const page = renderToStaticMarkup(createElement(RemoteControlPage));
    assert.ok(page.includes('data-view="remote"'));
    assert.ok(page.includes(translate('remote.page.title')));
    assert.ok(page.includes('data-remote-variant="page"'));
    assert.equal(page.includes('data-setting="remote-access"'), false, 'the page is not indexed as the Settings panel');
    assert.equal(page.includes('data-setting="remote-access-enabled"'), false, 'page switches do not duplicate Settings data-setting hooks');
    assert.equal(page.includes('data-setting="remote-tailscale"'), false);
    const groups = (html) => [...html.matchAll(/<section class="pd-settings-group" aria-label="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(groups(page), ['remote.page.groupStatus', 'settings.remote.groupPairing', 'settings.remote.groupDevices', 'remote.page.groupNetwork', 'settings.remote.groupTunnels'].map((key) => translate(key)));
    assert.deepEqual(groups(renderToStaticMarkup(createElement(RemoteAccessPanel))), ['settings.remote.groupService', 'settings.remote.groupTunnels', 'settings.remote.groupPairing', 'settings.remote.groupDevices'].map((key) => translate(key)), 'Settings keeps its original order');

    for (const key of ['activity.remoteView', 'remote.page.eyebrow', 'remote.page.title', 'remote.page.description', 'remote.page.groupStatus', 'remote.page.groupNetwork', 'remote.page.groupNetworkDesc', 'settings.remote.pairNeedsServer']) {
      assert.notEqual(translate(key, undefined, 'zh-CN'), key);
      assert.notEqual(translate(key, undefined, 'en-US'), key);
    }
  } finally {
    await server.close();
  }
});
