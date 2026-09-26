import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('file change presentation preserves unknown counts and full path identity', async context => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({ root: fileURLToPath(new URL('../packages/ui', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { ChangeStats, FileLabel } = await server.ssrLoadModule('/src/components/FileChangePresentation.tsx');
    const renderStats = items => renderToStaticMarkup(createElement(ChangeStats, { items }));
    await context.test('binary-only and one-sided unknown counts are never presented as zero', () => {
      assert.equal(renderStats([{ additions: null, deletions: null }]), '');
      const oneSide = renderStats([{ additions: 3, deletions: null }]);
      assert.match(oneSide, />\+3</);
      assert.match(oneSide, />−—</);
      assert.doesNotMatch(oneSide, />−0</);
      const partial = renderStats([{ additions: 3, deletions: 1 }, { additions: null, deletions: null }]);
      assert.match(partial, /部分文件未计入行数/);
      assert.match(partial, />\*</);
      assert.match(partial, />\+3</);
      assert.match(partial, />−1</);
    });
    await context.test('Windows and slash paths display directory before basename without status letters', () => {
      for (const path of ['packages/ui/index.ts', 'packages\\ui\\index.ts']) {
        const html = renderToStaticMarkup(createElement(FileLabel, { item: { path, kind: 'modified' } }));
        assert.match(html, /<small>packages\/ui\/<\/small><span>index\.ts<\/span>/);
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
