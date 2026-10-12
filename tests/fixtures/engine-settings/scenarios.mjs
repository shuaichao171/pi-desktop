// Settings → engine: built-in vs custom Pi engine, directory probe, save and restart.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../engine-settings/scenarios.mjs
function installEngineFixture() {
  const bridge = window.piDesktop, clone = value => structuredClone(value);
  const state = window.__engineReview = { calls: [], builtinVersion: '1.0.0', selection: { mode: 'builtin' }, active: { mode: 'builtin', version: '1.0.0' } };
  const versionOf = selection => selection.mode === 'builtin' ? state.builtinVersion : selection.path.includes('good') ? '1.2.0' : null;
  const same = (a, b) => a.mode === b.mode && (a.mode === 'builtin' || a.path === b.path);
  bridge.getPiEngineStatus = async () => clone({ builtinVersion: state.builtinVersion, selection: { ...state.selection, version: versionOf(state.selection) }, active: state.active, pendingRestart: !same(state.selection, state.active) });
  bridge.probePiEngine = async path => {
    state.calls.push(['probe', path]);
    if (path.includes('good')) return { ok: true, packageDir: path + '/node_modules/@earendil-works/pi-coding-agent', version: '1.2.0', problems: [], warnings: ['该版本高于内置引擎 1.0.0，未经完整验证'] };
    return { ok: false, packageDir: null, version: null, problems: ['目录中未找到 @earendil-works/pi-coding-agent 的 package.json'], warnings: [] };
  };
  bridge.pickPiEngineDirectory = async () => { state.calls.push(['pick']); return 'D:/engines/pi-good'; };
  const setDesktopSettings = bridge.setDesktopSettings;
  bridge.setDesktopSettings = async patch => {
    state.calls.push(['save', clone(patch)]);
    if (patch.piEngine) state.selection = clone(patch.piEngine);
    const base = setDesktopSettings ? await setDesktopSettings(patch) : {};
    return { ...base, piEngine: clone(state.selection) };
  };
  bridge.relaunchApp = async () => { state.calls.push(['relaunch']); return false; };
}

const input = 'input[name="piEngineDirectory"]';
const modeButton = position => `[data-setting="engine-mode"] button[role=radio]:${position}-child`;
const calls = name => `window.__engineReview.calls.filter(call => call[0] === '${name}')`;

export default async function engineSettingsScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.evaluate(`(${installEngineFixture.toString()})()`);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '引擎');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(modeButton('first'))}))`);
  await review.assert("document.querySelector('.pd-engine-status').textContent.includes('内置引擎 1.0.0') && !document.querySelector('.pd-engine-savebar')", 'Status card names the running engine and nothing is dirty');
  await review.screenshot('engine-01-builtin');

  await review.click(modeButton('last'));
  await review.waitFor(`Boolean(document.querySelector('${input}')) && Boolean(document.querySelector('.pd-engine-savebar'))`);
  await review.assert(`document.querySelector('[data-action="save-engine-settings"]').disabled`, 'Saving a custom engine needs a directory');
  await review.fill(input, 'D:/engines/pi-bad');
  await review.waitFor(`${calls('probe')}.some(call => call[1].includes('bad')) && Boolean(document.querySelector('.pd-engine-callout.is-error'))`);
  await review.screenshot('engine-02-custom-bad');
  await review.click('[data-action="choose-engine-directory"]');
  await review.waitFor(`document.querySelector('${input}').value.includes('pi-good') && Boolean(document.querySelector('.pd-engine-probe.is-ok'))`);
  await review.assert("document.querySelector('.pd-engine-probe.is-ok').textContent.includes('1.2.0') && Boolean(document.querySelector('.pd-engine-callout.is-warning'))", 'A valid directory shows its version and any compatibility warning');
  await review.screenshot('engine-03-custom-good');

  await review.click('[data-action="save-engine-settings"]');
  await review.waitFor(`${calls('save')}.length === 1 && Boolean(document.querySelector('.pd-engine-status.is-pending')) && !document.querySelector('.pd-engine-savebar')`);
  await review.assert(`${calls('save')}[0][1].piEngine.mode === 'custom' && ${calls('save')}[0][1].piEngine.path.includes('pi-good') && document.querySelector('.pd-engine-callout.is-warning')?.textContent.includes('已保存')`, 'Saving persists the custom directory and asks for a restart');
  await review.screenshot('engine-04-saved-pending');
  await review.click('[data-action="relaunch-app"]');
  await review.waitFor(`${calls('relaunch')}.length === 1 && !document.querySelector('[data-action="relaunch-app"]').disabled`);

  await review.fill(input, 'D:/engines/pi-good-edited');
  await review.waitFor("Boolean(document.querySelector('.pd-engine-savebar'))");
  await review.clickText('.pd-engine-savebar button', '放弃更改');
  await review.waitFor(`!document.querySelector('.pd-engine-savebar') && document.querySelector('${input}').value.endsWith('pi-good')`);

  // Switching back to the built-in engine must offer a visible save action too.
  await review.click(modeButton('first'));
  await review.waitFor(`Boolean(document.querySelector('.pd-engine-savebar [data-action="save-engine-settings"]:not(:disabled)'))`);
  await review.click('[data-action="save-engine-settings"]');
  await review.waitFor(`${calls('save')}.length === 2 && ${calls('save')}[1][1].piEngine.mode === 'builtin' && !document.querySelector('.pd-engine-status.is-pending')`);

  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.clickText('.pd-settings-nav button', '引擎');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(modeButton('last'))}))`);
  await review.click(modeButton('last'));
  await review.fill(input, 'D:/engines/pi-good');
  await review.waitFor("Boolean(document.querySelector('.pd-engine-probe.is-ok'))");
  await review.screenshot('engine-05-light');
  await review.viewport(680, 900);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Engine settings have no horizontal overflow at narrow width');
  await review.screenshot('engine-06-narrow');
}
