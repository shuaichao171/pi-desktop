import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('file change presentation omits line-count stats and preserves full path identity', async context => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({ root: fileURLToPath(new URL('../packages/ui', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const presentation = await server.ssrLoadModule('/src/components/FileChangePresentation.tsx');
    const { ChangesCard } = await server.ssrLoadModule('/src/components/ComposerChanges.tsx');
    const { FileLabel } = presentation;
    await context.test('line-count stats component is removed and cards render without stats', () => {
      assert.equal('ChangeStats' in presentation, false);
      const html = renderToStaticMarkup(createElement(ChangesCard, {
        items: [{ path: 'src/a.ts', kind: 'modified' }, { path: 'assets/logo.png', kind: 'added', preview: 'binary' }],
        scope: { kind: 'turn', runId: 'r1' },
        variant: 'turn',
        review: () => {},
      }));
      assert.doesNotMatch(html, /pd-change-stats|pd-change-partial/);
      assert.match(html, /已修改 2 个文件/);
    });
    await context.test('Windows and slash paths display directory before basename without status letters', () => {
      for (const path of ['packages/ui/index.ts', 'packages\\ui\\index.ts']) {
        const html = renderToStaticMarkup(createElement(FileLabel, { item: { path, kind: 'modified' } }));
        // The directory is bidi-isolated so lists can shorten it from the front.
        assert.match(html, /<small><bdi>packages\/ui\/<\/bdi><\/small><span>index\.ts<\/span>/);
        assert.match(html, /pd-change-file-icon/);
        assert.doesNotMatch(html, />M<|>A<|>D</);
      }
      const root = renderToStaticMarkup(createElement(FileLabel, { item: { path: 'notes.md', kind: 'added' }, compact: true }));
      assert.doesNotMatch(root, /<small>/);
      assert.match(root, /is-compact/);
      assert.match(root, /新增文件/);
    });
  } finally { await server.close(); }
});
