import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import config from '../packages/desktop/electron.vite.config.ts';

test('development CSP allows React Refresh bootstrap without weakening packaged HTML', () => {
  const html = readFileSync(new URL('../packages/desktop/src/renderer/index.html', import.meta.url), 'utf8');
  const plugin = config.renderer.plugins.find((candidate) => candidate?.name === 'development-content-security-policy');
  assert.equal(plugin?.apply, 'serve');
  assert.doesNotMatch(html, /script-src[^"\n]*unsafe-inline/);
  const developmentHtml = plugin.transformIndexHtml(html);
  assert.match(developmentHtml, /script-src 'self' 'unsafe-inline'/);
  assert.match(developmentHtml, /connect-src 'self' ws: wss:/);
});
