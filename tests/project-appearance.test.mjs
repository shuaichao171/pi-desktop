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
  // url() now passes validation; the "渲染是否允许离开本机" prompt gates it in the UI.
  assert.equal(projectBarStyle('url(https://evil/x.png)')?.background, 'url(https://evil/x.png)');
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
  const pasted = oneLine.replace(', repeating', ',\nrepeating') + '\n';
  assert.equal(isValidProjectBarValue(pasted), true, 'the validator normalizes pasted newlines instead of rejecting');
  const rendered = projectBarStyle(pasted);
  assert.equal(rendered?.background, oneLine, 'the renderer normalizes and renders it anyway');
  assert.equal(isValidProjectBarValue('  linear-gradient(45deg, #f66, #3cf)  '), true, 'outer whitespace is trimmed');
});

test('network references trip the leave-machine check', async () => {
  const { projectBarLeavesMachine } = await import('../packages/shared/src/index.ts');
  assert.equal(projectBarLeavesMachine('url(https://evil/x.png)'), true);
  assert.equal(projectBarLeavesMachine('url(//evil/x.png)'), true, 'protocol-relative is still the network');
  assert.equal(projectBarLeavesMachine('image-set("https://a" 1x)'), true);
  assert.equal(projectBarLeavesMachine('linear-gradient(90deg, #fff, #000)'), false);
  assert.equal(projectBarLeavesMachine('url(data:image/png;base64,AAAA)'), false, 'embedded bytes stay local');
  assert.equal(projectBarLeavesMachine('url(data:image/png;base64,AAA), url(https://evil)'), true, 'one remote ref is enough');
  assert.equal(projectBarLeavesMachine('url(file:///C:/bg.png)'), false, 'local disk is not the network');
  // data:/file: URLs can never pass storage validation (semicolons are banned),
  // so the leave-machine prompt only ever sees genuine network references.
  const { normalizeProjectBarValue } = await import('../packages/shared/src/index.ts');
  assert.equal(normalizeProjectBarValue('data:image/png;base64,AAAA'), null);
});

test('animation tiers stay in sync with shared and only map to whitelisted keyframe names', async () => {
  const { PROJECT_BAR_ANIM_IDS } = await import('../packages/shared/src/index.ts');
  const { PROJECT_BAR_ANIMS } = await import('../packages/ui/src/sidebarAppearance.ts');
  assert.deepEqual(PROJECT_BAR_ANIMS.map((anim) => anim.id), [...PROJECT_BAR_ANIM_IDS]);
  for (const anim of PROJECT_BAR_ANIMS) {
    assert.match(anim.animation, /^pd-bar-[a-z]+ [\d.]+s (ease-in-out|linear) infinite$/, 'only app-owned keyframes may be referenced');
    if (anim.size) assert.match(anim.size, /^\d+% \d+%$/);
  }
});
