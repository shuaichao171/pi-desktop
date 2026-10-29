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
  // User-pasted CSS passes through after the shared validator strips dangerous constructs.
  assert.deepEqual(projectBarStyle('linear-gradient(45deg, #f66, #3cf)'), { background: 'linear-gradient(45deg, #f66, #3cf)', light: false });
  assert.equal(projectBarStyle('url(https://evil/x.png)'), null, 'remote sources are rejected');
  assert.equal(projectBarStyle('linear-gradient(45deg,#f66,#3cf); color:red'), null, 'multiple declarations are rejected');
  assert.equal(projectBarStyle('radial-gradient(@import x)'), null, 'at-rules are rejected');
  assert.equal(projectBarStyle('repeating-linear-gradient(90deg, #fff 0 10%, #000 10% 20%)').background.startsWith('repeating-'), true, 'repeating gradients survive');
  assert.equal(projectBarStyle('not-a-preset'), null, 'bare junk without a function call stays out');
  // Broken-but-harmless CSS (linear-gradient(evil)) is user error like any pasted CSS:
  // the browser ignores the invalid value and the text keeps its shadow scrim.
  assert.deepEqual(projectBarStyle('linear-gradient(evil)'), { background: 'linear-gradient(evil)', light: false });
  assert.equal(projectBarStyle(null), null);
  assert.equal(projectBarStyle(undefined), null);
  assert.equal(projectBarStyle(''), null);
});

test('multi-line AI output still applies: newlines collapse to spaces before validation', async () => {
  const { isValidProjectBarValue } = await import('../packages/shared/src/index.ts');
  const oneLine = 'radial-gradient(200% 340% at 0% 50%, #ff2ec433 0%, transparent 55%), radial-gradient(200% 340% at 100% 50%, #00e5ff2b 0%, transparent 55%), repeating-linear-gradient(115deg, transparent 0 9px, #ffffff07 9px 10px), linear-gradient(90deg, #080112 0%, #170b31 50%, #080112 100%)';
  const pasted = oneLine.slice(0, 60) + '\n' + oneLine.slice(60) + '\n';
  assert.equal(isValidProjectBarValue(pasted), false, 'raw newline paste is not valid as-is');
  const rendered = projectBarStyle(pasted);
  assert.equal(rendered?.background, oneLine, 'the renderer normalizes and renders it anyway');
  assert.equal(isValidProjectBarValue('  linear-gradient(45deg, #f66, #3cf)  '), true, 'outer whitespace is trimmed');
});
