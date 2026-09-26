// Built renderer + trusted CDP mouse events. All session/group writes stay in memory.
// Run after building: node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-drag/scenarios.mjs
function installSidebarDragFixture(saved) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const cwd = fixture.snapshot.cwd;
  const prefix = cwd.replace(/\\/g, '/') + '/';
  const ids = ['a1', 'a2', 'a3', 'b1', 'u1', 'u2'];
  const paths = Object.fromEntries(ids.map(id => [id, prefix + 'sidebar-drag-' + id + '.jsonl']));
  const row = (id, index) => ({ id, path: paths[id], name: '拖动会话 ' + id.toUpperCase(), firstMessage: 'Sidebar drag fixture ' + id,
    modified: '2026-09-26T08:00:00Z', messageCount: 2, order: index });
  const state = {
    cwd, paths, rows: saved?.rows ?? ids.map(row),
    groups: saved?.groups ?? [
      { id: 'alpha', name: '分组 Alpha', sessionPaths: ['a1', 'a2', 'a3'].map(id => paths[id]) },
      { id: 'beta', name: '分组 Beta', sessionPaths: [paths.b1] },
      { id: 'empty', name: '空分组', sessionPaths: [] },
    ],
    writes: [], navigation: [], pointerEvents: [], pointerDown: false, aborts: 0, deferGroupFailure: false,
  };
  const record = (name, args) => fixture.calls.push({ name, args: clone(args) });
  bridge.listWorkspaces = async () => { record('listWorkspaces', []); return [cwd]; };
  bridge.listSessions = async () => { record('listSessions', []); return clone(state.rows); };
  bridge.listSessionGroups = async () => { record('listSessionGroups', []); return clone(state.groups); };
  bridge.updateSessionGroups = async change => {
    record('updateSessionGroups', [change]);
    state.writes.push({ kind: 'groups', change: clone(change), pointerDown: state.pointerDown });
    if (state.deferGroupFailure) {
      state.deferGroupFailure = false;
      await new Promise((_resolve, reject) => { state.rejectGroupSave = () => { delete state.rejectGroupSave; reject(new Error('模拟分组保存失败')); }; });
    }
    if (change.type === 'move-session') {
      for (const group of state.groups) group.sessionPaths = group.sessionPaths.filter(path => path !== change.sessionPath);
      if (change.groupId !== null) {
        const group = state.groups.find(item => item.id === change.groupId);
        if (!group) throw new Error('Missing fixture group: ' + change.groupId);
        group.sessionPaths.splice(change.index ?? group.sessionPaths.length, 0, change.sessionPath);
      }
    } else if (change.type === 'reorder-groups') {
      state.groups = change.ids.map(id => state.groups.find(group => group.id === id));
    } else throw new Error('Unexpected group mutation: ' + change.type);
    return clone(state.groups);
  };
  bridge.updateSessionOrders = async entries => {
    record('updateSessionOrders', [entries]);
    state.writes.push({ kind: 'orders', entries: clone(entries), pointerDown: state.pointerDown });
    for (const entry of entries) {
      const item = state.rows.find(row => row.path === entry.path);
      if (!item) throw new Error('Missing fixture session: ' + entry.path);
      if (entry.order === null) delete item.order;
      else item.order = entry.order;
    }
  };
  bridge.updateSessionMeta = async (path, patch) => {
    record('updateSessionMeta', [path, patch]);
    state.writes.push({ kind: 'metadata', path, patch: clone(patch), pointerDown: state.pointerDown });
    Object.assign(state.rows.find(row => row.path === path), patch);
  };
  bridge.switchSession = async path => {
    record('switchSession', [path]); state.navigation.push(path);
    Object.assign(fixture.snapshot, { sessionPath: path, sessionId: state.rows.find(row => row.path === path)?.id ?? path });
    fixture.emitAgent({ type: 'ready', ...clone(fixture.snapshot) });
  };
  bridge.abort = async () => { record('abort', []); state.aborts++; };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    document.addEventListener(type, event => {
      if (!(event.target instanceof Element) || (!event.target.closest('.pd-sidebar') && !state.pointerDown)) return;
      if (type === 'pointerdown') state.pointerDown = true;
      if (type === 'pointerup' || type === 'pointercancel') state.pointerDown = false;
      if (state.pointerEvents.length < 1000) state.pointerEvents.push({ type, trusted: event.isTrusted, buttons: event.buttons, pointerType: event.pointerType });
    }, true);
  }
  Object.assign(fixture.snapshot, { sessionId: 'u1', sessionPath: paths.u1, status: 'busy', error: null });
  fixture.emitAgent({ type: 'ready', ...clone(fixture.snapshot) });
  fixture.emitAgent({ type: 'status', status: 'busy' });
  window.__sidebarDragReview = state;
}

export default async function sidebarDragScenarios(review) {
  const state = 'window.__sidebarDragReview';
  const q = JSON.stringify;
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1100);
  await review.reducedMotion(true);
  await review.evaluate(`(${installSidebarDragFixture.toString()})();`);
  await review.click('.pd-sidebar-list-heading .pd-section-actions button:first-child');
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length === ${state}.rows.length && !document.querySelector('.pd-sidebar-list-heading button:disabled')`);
  const paths = await review.evaluate(`${state}.paths`);
  const row = id => `.pd-session-item[data-session-path=${q(paths[id])}]`;
  const heading = key => `.pd-sidebar-group-heading[data-drag-container=${q(key)}]`;
  const section = key => `.pd-sidebar-group[data-section-key=${q(key)}]`;
  const toggle = key => `${section(key)} .pd-sidebar-group-toggle`;
  const list = key => `.pd-sidebar-group-content[data-drag-container=${q(key)}]`;
  const inSection = (id, key) => `document.querySelector(${q(row(id))})?.closest('[data-section-key]')?.dataset.sectionKey === ${q(key)}`;
  const uniqueRows = `(() => { const paths=[...document.querySelectorAll('.pd-session-item[data-session-path]')].map(row=>row.dataset.sessionPath); return new Set(paths).size===paths.length; })()`;
  const writes = () => review.evaluate(`${state}.writes.length`);
  let pointerAudit;
  async function point(selector, fraction = .5) {
    return review.evaluate(`(() => {
      const node=document.querySelector(${q(selector)}); if(!node) throw new Error('Missing pointer target: '+${q(selector)});
      node.scrollIntoView({block:'nearest',inline:'nearest'});
      const r=node.getBoundingClientRect(), x=r.left+Math.min(r.width*.45,110), y=r.top+r.height*${fraction};
      if(!r.width || !r.height || x<0 || x>=innerWidth || y<0 || y>=innerHeight) throw new Error('Pointer target outside viewport');
      const hit=document.elementFromPoint(x,y); if(hit!==node && !node.contains(hit)) throw new Error('Pointer target obscured');
      return {x,y};
    })()`);
  }
  async function press(id) {
    pointerAudit = await review.evaluate(`({navigation:${state}.navigation.length,collapsed:JSON.stringify(JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1')).collapsed)})`);
    const p = await point(row(id) + ' .pd-session-row');
    await review.mouseDown(p.x, p.y);
    // Cross the real drag threshold while staying in the pressed row.
    await review.mouseMove(p.x + 9, p.y);
    await review.waitFor('document.body.classList.contains("pd-sidebar-dragging") && Boolean(document.querySelector(".pd-sidebar-drag-ghost"))');
  }
  async function hover(selector, fraction = .5, followLayout = true) {
    let p = await point(selector, fraction);
    await review.mouseMove(p.x, p.y, 3);
    const hitTarget = () => review.evaluate(`(() => { const node=document.querySelector(${q(selector)}), hit=document.elementFromPoint(${p.x},${p.y}); return Boolean(node && (node===hit || node.contains(hit))); })()`);
    if (followLayout) {
      // Hovering intermediate groups changes the source/target heights. Follow
      // the same heading in its new position, using at most two real corrections.
      for (let correction = 0; correction < 2; correction++) {
        p = await point(selector, fraction);
        await review.mouseMove(p.x, p.y);
        if (await hitTarget()) break;
      }
    }
    await review.record('sidebar-drag-final-pointer-target', `(() => {
      const node=document.querySelector(${q(selector)}), hit=document.elementFromPoint(${p.x},${p.y});
      return {selector:${q(selector)},pointer:${q(p)},followLayout:${followLayout},targetHit:Boolean(node && (node===hit || node.contains(hit))),
        hitContainer:hit?.closest('[data-drag-container]')?.dataset.dragContainer,
        hitSession:hit?.closest('[data-session-path]')?.dataset.sessionPath,
        preview:[...document.querySelectorAll('.pd-sidebar-group[data-section-key]')].map(section=>({key:section.dataset.sectionKey,
          expanded:section.querySelector('.pd-sidebar-group-toggle')?.getAttribute('aria-expanded'),
          count:section.querySelector('.pd-sidebar-group-toggle > small')?.textContent,
          paths:[...section.querySelectorAll('[data-session-path]')].map(row=>row.dataset.sessionPath)})),writes:${state}.writes.length};
    })()`);
    if (followLayout) await review.assert(`(() => { const node=document.querySelector(${q(selector)}), hit=document.elementFromPoint(${p.x},${p.y}); return Boolean(node && (node===hit || node.contains(hit))); })()`, 'Final pointer still hits the intended heading after preview layout changes');
    await review.assert(uniqueRows, 'Live pointer preview never duplicates a session across groups');
  }
  async function noEarlySave(before, label) {
    await review.assert(`${state}.writes.length === ${before} && ${state}.pointerDown`, label + ': moving while held does not persist');
  }
  async function release() {
    await review.mouseUp();
    await review.waitFor('!document.body.classList.contains("pd-sidebar-dragging") && !document.querySelector(".pd-sidebar-drag-ghost")');
    await review.assert(`${state}.writes.every(call=>!call.pointerDown)`, 'Persistence starts only after the real pointer release');
    await review.assert(`${state}.navigation.length===${pointerAudit.navigation} && JSON.stringify(JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1')).collapsed)===${q(pointerAudit.collapsed)}`, 'Pointer release does not accidentally navigate a session or toggle a group');
  }
  async function moveGroup(id, key) {
    const before = await writes();
    const expectedPreview = await review.evaluate(`(() => {
      const source=document.querySelector(${q(row(id))}).closest('[data-section-key]');
      return {source:source.dataset.sectionKey,sourceCount:Number(source.querySelector('.pd-sidebar-group-toggle > small').textContent)-1,
        targetCount:Number(document.querySelector(${q(toggle(key) + ' > small')}).textContent)+1};
    })()`);
    await press(id);
    await hover(heading(key));
    await review.assert(`Number(document.querySelector(${q(toggle(key) + ' > small')}).textContent)===${expectedPreview.targetCount} && Number(document.querySelector(${q(toggle(expectedPreview.source) + ' > small')}).textContent)===${expectedPreview.sourceCount}`, 'Final cross-group preview updates the intended source and destination counts, including collapsed groups');
    await review.assert(`document.querySelector(${q(toggle(key))}).getAttribute('aria-expanded')==='false' || ${inSection(id, key)}`, 'Expanded destination contains the dragged session before pointer release');
    await noEarlySave(before, id + ' → ' + key);
    await release();
    const groupId = key === 'ungrouped' ? null : key.slice('group:'.length);
    await review.waitFor(`${state}.writes.slice(${before}).some(call=>call.kind==='groups' && call.change.type==='move-session' && call.change.sessionPath===${q(paths[id])} && call.change.groupId===${q(groupId)}) && ${state}.writes.slice(${before}).some(call=>call.kind==='orders')`);
    await review.waitFor(groupId === null
      ? `${state}.groups.every(group=>!group.sessionPaths.includes(${q(paths[id])}))`
      : `${state}.groups.find(group=>group.id===${q(groupId)}).sessionPaths.includes(${q(paths[id])})`);
    await review.settle();
  }

  // Project lists stay inert for session dragging, even over another valid row.
  await review.click('[data-mode="project"]');
  const projectBefore = await writes(), projectStart = await point(row('a1') + ' .pd-session-row');
  await review.mouseDown(projectStart.x, projectStart.y);
  const projectEnd = await point(row('a3') + ' .pd-session-row', .75);
  await review.mouseMove(projectEnd.x, projectEnd.y, 5);
  await review.assert('!document.body.classList.contains("pd-sidebar-dragging") && !document.querySelector(".pd-sidebar-drag-ghost")', 'Project view cannot start a session drag');
  await review.mouseUp();
  await review.assert(`${state}.writes.length===${projectBefore}`, 'Project view pointer gesture produces no group or ordering save');
  await review.click('[data-mode="grouped"]');
  await review.waitFor(`Boolean(document.querySelector(${q(toggle('ungrouped'))}))`);
  await review.screenshot('sidebar-drag-01-grouped-initial');

  // Same-group reorder must recognize the hovered session path, not its container key.
  const reorderBefore = await writes();
  await press('a1');
  // A reordered row intentionally moves away from the insertion point. Keep
  // this gesture's downward direction; heading drops below track layout instead.
  await hover(row('a3') + ' .pd-session-row', .8, false);
  await noEarlySave(reorderBefore, 'Same-group reorder');
  await review.assert(`[...document.querySelectorAll(${q(list('group:alpha') + ' [data-session-path]')})].map(row=>row.dataset.sessionPath).join('|') === ${q([paths.a2, paths.a3, paths.a1].join('|'))}`, 'Same-group live preview moves A1 after A3');
  await release();
  await review.waitFor(`${state}.writes.slice(${reorderBefore}).some(call=>call.kind==='orders')`);
  await review.assert(`${state}.writes.slice(${reorderBefore}).every(call=>call.kind!=='groups')`, 'Sorting within a group does not change group membership');

  // A single uninterrupted press revisits the origin and several destinations.
  const roundTripBefore = await writes();
  await press('u1');
  for (const key of ['group:alpha', 'ungrouped', 'group:beta', 'ungrouped']) {
    await hover(heading(key));
    await review.assert(inSection('u1', key), 'Continuous drag reaches ' + key);
    await noEarlySave(roundTripBefore, 'Continuous cross-group return');
  }
  await review.screenshot('sidebar-drag-02-continuous-return-held');
  await release();
  await review.assert(`${state}.groups.every(group=>!group.sessionPaths.includes(${q(paths.u1)})) && ${state}.writes.slice(${roundTripBefore}).every(call=>call.kind!=='groups')`, 'Releasing back in Ungrouped does not retain a previously hovered group');

  // Separate back-to-back drags also use the latest committed source container.
  await moveGroup('u1', 'group:alpha');
  await review.assert(inSection('u1', 'group:alpha'), 'Ungrouped → group commits to the rendered group');
  await moveGroup('u1', 'ungrouped');
  await review.assert(inSection('u1', 'ungrouped'), 'Group → Ungrouped works immediately after the first drop');

  // Both empty custom groups and an empty Ungrouped section remain drop targets.
  await review.assert(`${state}.groups.find(group=>group.id==='empty').sessionPaths.length===0`, 'Empty custom-group fixture has no sessions');
  await moveGroup('u2', 'group:empty');
  await review.assert(inSection('u2', 'group:empty'), 'An empty custom group accepts a session');
  await moveGroup('u1', 'group:alpha');
  await review.assert(`document.querySelectorAll(${q(list('ungrouped') + ' [data-session-path]')}).length===0 && Boolean(document.querySelector(${q(heading('ungrouped'))}))`, 'Empty Ungrouped keeps a visible drop heading');
  await moveGroup('u2', 'ungrouped');
  await review.assert(inSection('u2', 'ungrouped'), 'An empty Ungrouped section accepts a returning session');

  // Collapsed headings accept drops without opening or changing the user's preference.
  await review.click(toggle('group:alpha'));
  await review.assert(`document.querySelector(${q(toggle('group:alpha'))}).getAttribute('aria-expanded')==='false'`, 'Alpha is collapsed before its drop');
  await moveGroup('u2', 'group:alpha');
  await review.assert(`document.querySelector(${q(toggle('group:alpha'))}).getAttribute('aria-expanded')==='false' && !document.querySelector(${q(section('group:alpha') + ' [data-session-path]')})`, 'Dropping into a collapsed group preserves its collapsed presentation');
  await review.click(toggle('ungrouped'));
  await review.click(toggle('group:alpha'));
  await moveGroup('u2', 'ungrouped');
  await review.assert(`document.querySelector(${q(toggle('ungrouped'))}).getAttribute('aria-expanded')==='false' && !document.querySelector(${q(section('ungrouped') + ' [data-session-path]')})`, 'Collapsed Ungrouped accepts a drop and remains collapsed');
  await review.click(toggle('ungrouped'));

  // Escape cancels a real held-pointer preview. Releasing afterward must stay a no-op.
  const escapeBefore = await writes();
  const persistedBefore = await review.evaluate(`JSON.stringify({rows:${state}.rows,groups:${state}.groups})`);
  await press('u2');
  await hover(heading('group:beta'));
  await review.assert(inSection('u2', 'group:beta'), 'Escape test first creates a real cross-group preview');
  await noEarlySave(escapeBefore, 'Escape preview');
  await review.key('Escape');
  await review.assert(`!document.body.classList.contains('pd-sidebar-dragging') && !document.querySelector('.pd-sidebar-drag-ghost') && ${inSection('u2', 'ungrouped')}`, 'Escape restores the origin immediately');
  await review.mouseUp();
  await review.assert(`${state}.writes.length===${escapeBefore} && JSON.stringify({rows:${state}.rows,groups:${state}.groups})===${q(persistedBefore)} && ${state}.aborts===0`, 'Escape and subsequent pointer release neither persist nor stop generation');

  // A pending save keeps the final preview in place, then rolls back on rejection.
  const failureBefore = await writes();
  await review.evaluate(`${state}.deferGroupFailure=true`);
  await press('u2');
  await hover(heading('group:beta'));
  await noEarlySave(failureBefore, 'Deferred save failure');
  await release();
  await review.waitFor(`typeof ${state}.rejectGroupSave==='function'`);
  await review.assert(inSection('u2', 'group:beta'), 'Final arrangement stays visible while group persistence is pending');
  await review.evaluate(`${state}.rejectGroupSave()`);
  await review.waitFor(`${inSection('u2', 'ungrouped')} && document.querySelector('.pd-sidebar-error')?.textContent.includes('模拟分组保存失败')`);
  await review.assert(`${state}.writes.slice(${failureBefore}).filter(call=>call.kind==='groups').length===1 && ${state}.writes.slice(${failureBefore}).every(call=>call.kind!=='orders') && JSON.stringify({rows:${state}.rows,groups:${state}.groups})===${q(persistedBefore)}`, 'Failed group save restores the confirmed layout and does not write ordering');
  await review.screenshot('sidebar-drag-03-save-failure-restored');

  // Preference round-trip includes Ungrouped in both individual and global collapse.
  await review.click(toggle('ungrouped'));
  await review.assert(`JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1')).collapsed.includes('ungrouped')`, 'Ungrouped collapse is persisted');
  await review.click('[data-mode="project"]');
  await review.click('[data-mode="grouped"]');
  await review.assert(`document.querySelector(${q(toggle('ungrouped'))}).getAttribute('aria-expanded')==='false'`, 'Ungrouped collapse survives changing sidebar views');
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="展开全部"],.pd-sidebar-organize-toolbar button[aria-label="Expand all"]');
  await review.assert(`[...document.querySelectorAll('.pd-sidebar-group-toggle')].every(button=>button.getAttribute('aria-expanded')==='true')`, 'Expand all includes Ungrouped');
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="收起全部"],.pd-sidebar-organize-toolbar button[aria-label="Collapse all"]');
  await review.assert(`[...document.querySelectorAll('.pd-sidebar-group-toggle')].every(button=>button.getAttribute('aria-expanded')==='false') && JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1')).collapsed.includes('ungrouped')`, 'Collapse all includes and persists Ungrouped');
  await review.screenshot('sidebar-drag-04-collapse-all');
  await review.assert(`${state}.pointerEvents.some(event=>event.type==='pointermove' && event.buttons===1) && ${state}.pointerEvents.every(event=>event.trusted && event.pointerType==='mouse')`, 'Drag coverage used trusted mouse input with the button continuously held');
  await review.record('sidebar-drag-persistence-and-input', `({writes:${state}.writes,navigation:${state}.navigation,aborts:${state}.aborts,pointerEvents:${state}.pointerEvents,preferences:JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1'))})`);

  // Reload the owned renderer to prove the saved collapse state is actually read back.
  const saved = await review.evaluate(`({rows:${state}.rows,groups:${state}.groups})`);
  await review.evaluate('location.reload(); void 0');
  await review.waitFor('!window.__sidebarDragReview && window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.evaluate(`(${installSidebarDragFixture.toString()})(${q(saved)});`);
  await review.click('.pd-sidebar-list-heading .pd-section-actions button:first-child');
  await review.waitFor(`document.querySelectorAll('.pd-sidebar-group-toggle').length===4 && Boolean(document.querySelector(${q(toggle('ungrouped'))}))`);
  await review.assert(`[...document.querySelectorAll('.pd-sidebar-group-toggle')].every(button=>button.getAttribute('aria-expanded')==='false')`, 'All groups, including Ungrouped, remain collapsed after renderer reload');
  await review.evaluate("document.documentElement.dataset.theme='light';document.documentElement.style.setProperty('--pd-ui-font-size','20px')");
  await review.screenshot('sidebar-drag-05-reloaded-collapsed-light-20px');

  // Group headings also reorder with a real press; release must not become a toggle click.
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="展开全部"],.pd-sidebar-organize-toolbar button[aria-label="Expand all"]');
  const groupBefore = await writes();
  pointerAudit = await review.evaluate(`({navigation:${state}.navigation.length,collapsed:JSON.stringify(JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1')).collapsed)})`);
  const groupStart = await point(toggle('group:alpha'));
  await review.mouseDown(groupStart.x, groupStart.y);
  await review.mouseMove(groupStart.x + 9, groupStart.y);
  await review.waitFor('document.body.classList.contains("pd-sidebar-dragging") && Boolean(document.querySelector(".pd-sidebar-drag-ghost"))');
  await hover(heading('group:empty'), .5, false);
  await noEarlySave(groupBefore, 'Group heading reorder');
  await review.assert(`JSON.stringify([...document.querySelectorAll('.pd-sidebar-group[data-section-key^="group:"]')].map(group=>group.dataset.sectionKey))===JSON.stringify(['group:beta','group:empty','group:alpha'])`, 'Group heading preview moves Alpha after Empty');
  await release();
  await review.waitFor(`${state}.writes.slice(${groupBefore}).some(call=>call.kind==='groups' && call.change.type==='reorder-groups' && call.change.ids.join('|')==='beta|empty|alpha')`);
  await review.assert(`[...document.querySelectorAll('.pd-sidebar-group-toggle')].every(button=>button.getAttribute('aria-expanded')==='true') && ${state}.writes.slice(${groupBefore}).every(call=>call.kind==='groups')`, 'Heading release saves group order without accidentally collapsing a group or saving session order');
  await review.record('sidebar-drag-heading-reorder', `({writes:${state}.writes.slice(${groupBefore}),groups:${state}.groups,preferences:JSON.parse(localStorage.getItem('pi-desktop.sidebar-organization.v1'))})`);
}
