// Real renderer and trusted pointer input; all session writes stay in memory.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-titles/scenarios.mjs
function installSidebarTitlesFixture(options = {}) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const cwd = 'C:\\sidebar-title-review\\project';
  const rows = [
    { id: 'short', name: '短标题' },
    { id: 'long', name: '检查侧栏对话标题的完整展示，鼠标悬停后可以来回阅读这段很长的标题和最后的结尾文字' },
    { id: 'border', name: options.borderTitle ?? '只在悬停显示操作按钮后溢出的标题' },
  ].map((row, order) => ({ ...row, path: cwd + '\\' + row.id + '.jsonl', firstMessage: row.name, order,
    modified: '2026-09-27T00:00:00Z', messageCount: 2 }));
  const state = { cwd, rows, writes: [], navigation: [] };
  bridge.getDefaultWorkspace = async () => 'C:\\sidebar-title-review\\home';
  bridge.listWorkspaces = async () => [cwd];
  bridge.listSessions = async workspace => workspace === cwd ? clone(rows) : [];
  bridge.listSessionGroups = async () => [];
  bridge.updateSessionMeta = async (path, patch) => {
    const row = rows.find(item => item.path === path);
    if (!row) throw new Error('Unexpected session metadata target');
    state.writes.push({ path, patch: clone(patch) });
    Object.assign(row, patch);
  };
  bridge.switchSession = async path => { state.navigation.push(path); };
  Object.assign(fixture.snapshot, { cwd, sessionId: rows[0].id, sessionPath: rows[0].path,
    status: 'idle', messages: [], activities: [], runs: [], error: null });
  localStorage.setItem('pi-desktop.sidebar-width', '274');
  localStorage.setItem('pi-desktop.sidebar-organization.v1', JSON.stringify({ mode: 'grouped' }));
  localStorage.setItem('pi-desktop.theme', options.theme ?? 'dark');
  window.__sidebarTitlesReview = state;
}

export default async function sidebarTitlesScenarios(review) {
  const q = JSON.stringify, state = 'window.__sidebarTitlesReview';
  const row = id => `.pd-session-item[data-session-path$="${id}.jsonl"]`;
  const title = id => `${row(id)} .pd-session-title`;
  const text = id => `${title(id)} .pd-session-title-text`;
  const actions = id => `${row(id)} .pd-session-actions`;
  const animation = id => `document.querySelector(${q(text(id))}).getAnimations().find(animation => animation.animationName === 'pd-session-title-scroll')`;
  const translateX = id => `(() => { const transform = getComputedStyle(document.querySelector(${q(text(id))})).transform; return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41; })()`;
  const overflow = id => `document.querySelector(${q(title(id))}).classList.contains('is-overflowing')`;
  async function moveTo(id) {
    const point = await review.evaluate(`(() => { const node = document.querySelector(${q(row(id))}); node.scrollIntoView({ block: 'nearest' }); const rect = node.getBoundingClientRect(); return { x: rect.left + 48, y: rect.top + rect.height / 2 }; })()`);
    await review.mouseMove(point.x, point.y);
    await review.waitFor(`document.querySelector(${q(row(id))}).matches(':hover')`);
  }
  async function moveAway() { await review.mouseMove(700, 600); }
  async function assertIdle() {
    await review.assert(`['short', 'long', 'border'].every(id => { const row = document.querySelector('.pd-session-item[data-session-path$="' + id + '.jsonl"]'), title = row.querySelector('.pd-session-title'), button = row.querySelector('.pd-session-row'); const r = button.getBoundingClientRect(), t = title.getBoundingClientRect(); return r.right - t.right <= 12 && t.width > r.width - 24; })`, 'Idle titles use the full row width instead of reserving space for hidden action buttons');
    await review.assert(`Array.from(document.querySelectorAll('.pd-session-actions')).every(node => getComputedStyle(node).opacity === '0' && getComputedStyle(node).pointerEvents === 'none')`, 'Idle action buttons are invisible and do not intercept title clicks');
    await review.assert(`!(${animation('short')}) && !(${animation('long')}) && !(${animation('border')})`, 'No conversation title scrolls while the pointer is outside the sidebar');
  }
  async function assertHover(id) {
    await review.waitFor(`getComputedStyle(document.querySelector(${q(actions(id))})).opacity === '1'`);
    await review.assert(`(() => { const target = document.querySelector(${q(actions(id))}), style = getComputedStyle(target), before = getComputedStyle(target, '::before'); const visible = value => value !== 'none' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)'; return style.position === 'absolute' && style.pointerEvents !== 'none' && (visible(style.backgroundColor) || visible(style.backgroundImage) || visible(before.backgroundColor) || visible(before.backgroundImage)); })()`, 'Hovered action buttons overlay the row with a visible backing surface');
    await review.assert(`(() => { const viewport = document.querySelector(${q(title(id))}).getBoundingClientRect(), action = document.querySelector(${q(actions(id))}).getBoundingClientRect(); return viewport.right <= action.left + 1; })()`, 'The hovered title stays clear of the overlaid action buttons');
  }
  async function assertScrolling(id) {
    await review.waitFor(`${overflow(id)} && Boolean(${animation(id)})`);
    await review.assert(`(() => { const style = getComputedStyle(document.querySelector(${q(title(id))})), mask = style.maskImage || style.webkitMaskImage; return mask.includes('linear-gradient') && mask.split('rgba(0, 0, 0, 0)').length + mask.split('transparent').length - 2 >= 2; })()`, 'Overflowing hovered titles fade at both horizontal edges');
    await review.waitFor(`${translateX(id)} < -1`, 2000);
    await review.assert(`(() => { const timing = (${animation(id)}).effect.getTiming(); return timing.iterations === Infinity && timing.direction === 'alternate'; })()`, 'The long hovered title repeats its scrolling animation in both directions');
    await review.record('scrolling-' + id, `({ transform: getComputedStyle(document.querySelector(${q(text(id))})).transform, viewportWidth: document.querySelector(${q(title(id))}).clientWidth, titleWidth: document.querySelector(${q(text(id))}).scrollWidth, timing: (${animation(id)}).effect.getTiming(), keyframes: (${animation(id)}).effect.getKeyframes() })`);
  }

  await review.viewport(1440, 900);
  await review.reducedMotion(false);
  await review.reloadWithFixture(`(${installSidebarTitlesFixture.toString()})();`);
  await review.waitFor('document.querySelectorAll(".pd-session-title-text").length === 3');
  await moveAway();
  // Fit one title between the idle width and the smaller hover viewport using
  // the real renderer font, so this case remains meaningful on other machines.
  const borderTitle = await review.evaluate(`(() => { const viewport = document.querySelector(${q(title('border'))}), inner = viewport.querySelector('.pd-session-title-text'), action = document.querySelector(${q(actions('border'))}); const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.font = getComputedStyle(inner).font; const target = viewport.clientWidth - action.getBoundingClientRect().width / 2; let value = '悬停边界标题'; while (context.measureText(value + '文字').width < target) value += '文字'; return value; })()`);
  await review.reloadWithFixture(`(${installSidebarTitlesFixture.toString()})(${q({ borderTitle })});`);
  await review.waitFor('document.querySelectorAll(".pd-session-title-text").length === 3');
  await moveAway();
  await assertIdle();
  await review.assert(`!(${overflow('border')}) && document.querySelector(${q(text('border'))}).scrollWidth <= document.querySelector(${q(title('border'))}).clientWidth`, 'The boundary title fits completely before the buttons are revealed');
  await review.screenshot('sidebar-titles-dark-idle-full-width');

  await moveTo('short');
  await assertHover('short');
  await review.assert(`!(${overflow('short')}) && !(${animation('short')}) && ${translateX('short')} === 0`, 'A short title stays stationary when hovered');
  await moveTo('long');
  await assertHover('long');
  await assertScrolling('long');
  // Seek the renderer animation after observing natural movement to verify its
  // far endpoint and return leg without waiting through a very long title.
  await review.evaluate(`(() => { const animation = ${animation('long')}; animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) - 200; })()`);
  await review.assert(`(() => { const viewport = document.querySelector(${q(title('long'))}), inner = document.querySelector(${q(text('long'))}), travel = ${translateX('long')}; return Math.abs(inner.scrollWidth + travel - viewport.clientWidth) <= 2; })()`, 'The far scroll endpoint reveals the complete title without stopping before its final characters');
  const endpoint = await review.evaluate(translateX('long'));
  await review.screenshot('sidebar-titles-dark-hover-end');
  await review.evaluate(`(() => { const animation = ${animation('long')}; animation.currentTime = Number(animation.effect.getTiming().duration) * 1.5; })()`);
  await review.assert(`${translateX('long')} < -1 && ${translateX('long')} > ${endpoint + 1}`, 'The second animation leg scrolls back toward the beginning');
  await review.screenshot('sidebar-titles-dark-hover-scroll');
  await moveAway();
  await review.waitFor(`!(${animation('long')}) && ${translateX('long')} === 0`);
  await assertIdle();

  await moveTo('border');
  await assertHover('border');
  await assertScrolling('border');
  await moveAway();
  await review.waitFor(`!(${overflow('border')}) && !(${animation('border')}) && ${translateX('border')} === 0`);
  await review.assert(`document.querySelector(${q(text('border'))}).scrollWidth <= document.querySelector(${q(title('border'))}).clientWidth`, 'Leaving restores the full width and removes hover-only overflow');

  await review.reducedMotion(true);
  await moveTo('long');
  await assertHover('long');
  await review.assert(`!(${animation('long')}) && ${translateX('long')} === 0`, 'Reduced-motion preference prevents automatic title scrolling');
  await review.screenshot('sidebar-titles-reduced-motion');
  await review.reducedMotion(false);
  await moveAway();

  // Use the public setting for a second theme instead of editing CSS under test.
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog") && document.documentElement.dataset.theme === "light"');
  await moveAway();
  await assertIdle();
  await review.screenshot('sidebar-titles-light-idle-full-width');
  await moveTo('long');
  await assertHover('long');
  await assertScrolling('long');
  await review.screenshot('sidebar-titles-light-hover-scroll');

  await review.click(`${row('long')} [data-session-action="pin"]`);
  await review.waitFor(`${state}.rows.find(row => row.id === 'long').pinned === true`);
  await review.assert(`${state}.writes.length === 1 && ${state}.writes[0].patch.pinned === true && ${state}.navigation.length === 0`, 'The overlaid pin button updates exactly its conversation without opening it');
  await moveTo('border');
  // zcode-style inline confirm: the first click only arms the row.
  await review.click(`${row('border')} [data-session-action="archive"]`);
  await review.waitFor(`${row('border')}.classList.contains('is-archive-confirming')`);
  await review.assert(`(() => { const item = document.querySelector(${q(row('border'))}); const button = item.querySelector('[data-session-action="archive"]'); return button.classList.contains('is-confirming') && button.getAttribute('aria-label').startsWith('确认归档') && getComputedStyle(item.querySelector('.pd-session-actions')).opacity === '1' && ${state}.writes.length === 1; })()`, 'The first archive click arms an inline confirm (visible without hover) and writes nothing yet');
  await review.screenshot('sidebar-titles-archive-confirming');
  await review.click(`${row('border')} [data-session-action="archive"]`);
  await review.waitFor(`!document.querySelector(${q(row('border'))})`);
  await review.assert(`${state}.writes.length === 2 && ${state}.writes[1].patch.archived === true && ${state}.rows.find(row => row.id === 'border').archived === true && ${state}.navigation.length === 0`, 'The second click archives exactly its conversation without opening it');
}
