// Dialog surfaces in both themes: one panel colour for every dialog, a light
// veil instead of a muddy grey backdrop, and white fields in light mode.
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../ui-polish/dialog-surfaces.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../ui-polish/dialog-surfaces.mjs
const expected = {
  light: { dialog: 'rgb(255, 255, 255)', field: 'rgb(255, 255, 255)', composer: 'rgb(255, 255, 255)' },
  dark: { dialog: 'rgb(34, 34, 34)', field: null, composer: null },
};

export default async function dialogSurfaces(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 900);
  await review.reducedMotion(true);
  const theme = await review.evaluate('document.documentElement.dataset.theme === "light" ? "light" : "dark"');
  const want = expected[theme];
  const background = selector => `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`;

  if (want.composer) await review.assert(`${background('.pd-composer-shell')} === ${JSON.stringify(want.composer)}`, 'The light composer reads as a white input field');

  await review.click('.pd-settings-entry');
  await review.waitFor('Boolean(document.querySelector(".pd-settings-dialog"))');
  await review.assert(`${background('.pd-settings-dialog')} === ${JSON.stringify(want.dialog)}`, 'Settings uses the shared dialog panel colour');
  if (theme === 'light') {
    await review.assert(`${background('.pd-settings-content')} !== ${JSON.stringify(want.dialog)} && ${background('.pd-settings-group-body')} === ${JSON.stringify(want.dialog)}`, 'Light settings content sits on an inset with white cards');
    await review.assert(`getComputedStyle(document.querySelector('.pd-settings-overlay')).backdropFilter.includes('blur')`, 'The light backdrop softly blurs instead of greying the window');
  }
  await review.screenshot(`dialog-surfaces-settings-${theme}`);
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog")');

  await review.evaluate(`window.piDesktop.getProjectsDirectory = async () => 'C:/Users/review/Projects';`);
  await review.click('.pd-project-empty button');
  await review.waitFor('document.querySelector(".pd-project-create-dialog")?.open === true');
  await review.assert(`${background('.pd-project-create-dialog')} === ${JSON.stringify(want.dialog)}`, 'Project creation uses the shared dialog panel colour');
  if (want.field) await review.assert(`${background('.pd-project-create-name')} === ${JSON.stringify(want.field)} && getComputedStyle(document.querySelector('.pd-project-create-name input')).boxShadow === 'none'`, 'The project name field is one white box without an inner focus ring');
  await review.assert(`(() => { const button = document.querySelector('.pd-project-create-submit'); return button.disabled && getComputedStyle(button).opacity === '1'; })()`, 'A disabled primary action stays opaque and neutral');
  await review.screenshot(`dialog-surfaces-project-${theme}`);
}
