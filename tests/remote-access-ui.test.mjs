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
