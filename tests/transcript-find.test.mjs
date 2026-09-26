import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('the transcript find bar counts matches and exposes keyboard stepping', async () => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const { TranscriptFind } = await server.ssrLoadModule('/src/components/TranscriptFind.tsx');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');
    const html = renderToStaticMarkup(createElement(TranscriptFind, { query: 'needle', onQueryChange() {}, index: 1, total: 3, onStep() {}, onClose() {} }));
    assert.match(html, /pd-transcript-find/);
    assert.ok(html.includes(translate('chat.find.count', { current: '2', total: '3' })));
    assert.ok(!html.includes('disabled'));
    const empty = renderToStaticMarkup(createElement(TranscriptFind, { query: 'zzz', onQueryChange() {}, index: null, total: 0, onStep() {}, onClose() {} }));
    assert.match(empty, /pd-transcript-find-count is-empty/);
    assert.ok(empty.includes(translate('chat.find.noResults')));
    assert.ok(empty.includes('disabled'));

    const partial = renderToStaticMarkup(createElement(TranscriptFind, { query: 'old needle', onQueryChange() {}, index: null, total: 0, onStep() {}, onClose() {}, loadedMessages: 40, hasOlder: true, onLoadOlder() {} }));
    assert.ok(partial.includes(translate('chat.find.loadedOnly', { count: '40' })));
    assert.ok(partial.includes(translate('chat.find.loadOlder')));
    assert.match(partial, /pd-transcript-find-scope.*role="status"/);
    assert.ok(!empty.includes('pd-transcript-find-scope'), 'complete histories do not show a scope warning');
  } finally {
    await server.close();
  }
});
