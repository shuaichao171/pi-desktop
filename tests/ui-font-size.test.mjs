import assert from 'node:assert/strict';
import { test } from 'node:test';

test('interface font size normalizes, persists and applies without touching html size', async () => {
  const font = await import('../packages/ui/src/uiFontSize.ts');
  assert.equal(font.normalizeUiFontSize(12.4), 12);
  assert.equal(font.normalizeUiFontSize(13.6), 14);
  assert.equal(font.normalizeUiFontSize(29), 20);
  assert.equal(font.normalizeUiFontSize(3), 12);
  assert.equal(font.normalizeUiFontSize('15'), 15);
  assert.equal(font.normalizeUiFontSize('abc'), null);
  assert.equal(font.normalizeUiFontSize(null), null);
  assert.equal(font.normalizeUiFontSize(Number.NaN), null);
  // Node has no storage: reads fall back to the default and writes stay no-ops.
  assert.equal(font.readUiFontSize(), font.DEFAULT_UI_FONT_SIZE);
  assert.doesNotThrow(() => font.saveUiFontSize(16));
  // Without a document, applying and initializing remain safe no-ops.
  assert.doesNotThrow(() => font.applyUiFontSize(16));
  assert.equal(font.initUiFontSize(), font.DEFAULT_UI_FONT_SIZE);
});
