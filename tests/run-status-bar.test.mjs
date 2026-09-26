import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('operation errors never offer an agent retry while the agent is healthy', async () => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({ root: fileURLToPath(new URL('../packages/ui', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { RunStatusBar } = await server.ssrLoadModule('/src/components/RunStatusBar.tsx');
    const { useChatStore } = await server.ssrLoadModule('/src/store.ts');
    // React's server snapshot deliberately reads Zustand's initial state.
    const initial = useChatStore.getInitialState();
    const original = { ...initial };
    try {
      Object.assign(initial, { status: 'idle', error: 'Network failure listing sessions', bridge: {} });
      const healthy = renderToStaticMarkup(createElement(RunStatusBar));
      assert.match(healthy, /Network failure listing sessions/);
      assert.doesNotMatch(healthy, /<button/);
      Object.assign(initial, { status: 'error', error: 'Network unavailable' });
      const failed = renderToStaticMarkup(createElement(RunStatusBar));
      assert.match(failed, /pd-run-status-action/);
      Object.assign(initial, { status: 'error', error: '401 Unauthorized' });
      assert.doesNotMatch(renderToStaticMarkup(createElement(RunStatusBar)), /<button/);
      assert.match(renderToStaticMarkup(createElement(RunStatusBar, { onOpenModelManagement() {} })), /<button/);
    } finally { Object.assign(initial, original); }
  } finally { await server.close(); }
});
