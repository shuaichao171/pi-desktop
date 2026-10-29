import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_BAR_PRESETS, projectBarStyle } from '../packages/ui/src/sidebarAppearance.ts';

test('preset bars map to their fixed gradients and preset ids stay in sync with shared', async () => {
  const { PROJECT_BAR_PRESET_IDS } = await import('../packages/shared/src/index.ts');
  assert.deepEqual(PROJECT_BAR_PRESETS.map((preset) => preset.id), [...PROJECT_BAR_PRESET_IDS], 'UI presets and the main-process whitelist must list the same ids');
  for (const preset of PROJECT_BAR_PRESETS) {
    assert.equal(projectBarStyle(preset.id)?.background, preset.css);
    assert.equal(typeof preset.light, 'boolean');
  }
});

test('hex bars pass through with luminance-chosen text; junk degrades to the default bar', () => {
  assert.deepEqual(projectBarStyle('#ff0044'), { background: '#ff0044', light: false });
  assert.deepEqual(projectBarStyle('#f6d365'), { background: '#f6d365', light: true });
  assert.deepEqual(projectBarStyle('#abc'), { background: '#abc', light: true }, '#aabbcc is a light tone, so heading text goes dark');
  assert.equal(projectBarStyle('#12345'), null, '5-digit hex is not a color');
  assert.equal(projectBarStyle('not-a-preset'), null);
  assert.equal(projectBarStyle('linear-gradient(evil)'), null, 'only preset ids or hex reach the renderer');
  assert.equal(projectBarStyle(null), null);
  assert.equal(projectBarStyle(undefined), null);
  assert.equal(projectBarStyle(''), null);
});
