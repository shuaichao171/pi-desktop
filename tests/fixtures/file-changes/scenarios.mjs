// Prepare only: node tests/fixtures/file-changes/scenarios.mjs --check
// Run after the renderer build: node tests/fixtures/model-settings/run.mjs --run --scenario=../file-changes/scenarios.mjs
// Turn-level settlement: one card per completed run, lazy diffs via getFileChangeDiffs. It never invokes Git or edits workspace files.
export default async function fileChangesScenarios(review) {
  const card = '.pd-conversation-changes';
  const row = path => `${card} .pd-composer-changes-file[title=${JSON.stringify(path)}]`;
  const selected = path => `document.querySelector('.pd-changes-file.is-selected')?.title === ${JSON.stringify(path)}`;
  const visibleRows = `[...document.querySelectorAll('${card} .pd-composer-changes-file')].filter(window.__changesReview.visible)`;
  const diffControl = label => `[...document.querySelectorAll('.pd-changes-diff button')].find(button => new RegExp(${JSON.stringify(label)}, 'i').test([button.getAttribute('aria-label'),button.title,button.textContent].join(' ')))`;
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = window.__changesReview = { path: fixture.snapshot.sessionPath, copied: null };
    state.visible = node => !!node && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { state.copied = text; } } });
    state.textFile = (path, index = 0) => ({ path, kind: 'modified', additions: index + 2, deletions: 1 });
    state.diffFor = (path, index = 0) => ({ path, diff: '--- a/' + path + '\\n+++ b/' + path + '\\n@@ -1,2 +1,2 @@\\n context line\\n-old value\\n+new value ' + index + ' ' + 'long output '.repeat(25) + '\\n' });
    state.firstPath = 'src/engine.ts'; state.binaryPath = 'assets/header.png'; state.unknownPath = 'generated/catalog.json';
    state.items = [state.textFile(state.firstPath),
      { path: state.binaryPath, kind: 'modified', additions: null, deletions: null, preview: 'binary' },
      { path: state.unknownPath, kind: 'modified', additions: null, deletions: null, preview: 'too-large' },
      ...Array.from({length:25}, (_, index) => state.textFile('packages/feature-' + String(index).padStart(2,'0') + '/nested/component-with-a-long-name.ts', index + 3))];
    state.lastPath = state.items.at(-1).path;
    state.diffsFor = items => items.map(item => item.preview ? { path: item.path, diff: null, preview: item.preview } : state.diffFor(item.path, item.additions));
    state.fileDiffs = state.diffsFor(state.items);
    // The fixture bridge serves getFileChangeDiffs from window.__modelReview.
    fixture.fileDiffs = structuredClone(state.fileDiffs);
    state.apply = (items, turns, activeRunId) => {
      Object.assign(fixture.snapshot, { fileChanges: structuredClone(items), fileChangeTurns: structuredClone(turns), fileChangeActiveRunId: activeRunId });
      fixture.emitAgent({ type: 'file-changes', items: structuredClone(items), turns: structuredClone(turns), activeRunId });
    };
    state.ready = (path, items, status = 'idle', sessionId = 'shared-changes-session', runId = 'changes-run') => {
      const busy = status === 'busy', now = Date.now();
      const run = {id:runId,startedAt:now-12000,finishedAt:busy ? null : now,status:busy ? 'running' : 'completed'};
      const messages = [{id:'changes-user',runId:run.id,order:0,role:'user',status:'done',text:'审查本轮修改的文件'},
        {id:'changes-answer',runId:run.id,order:1,role:'assistant',status:busy ? 'streaming' : 'done',text:'修改已记录。这一轮的文件变更汇总在下方。'}];
      const turns = items.length ? [{ runId: run.id, items: structuredClone(items) }] : [];
      Object.assign(fixture.snapshot, { sessionId, sessionPath:path, messages, activities:[], runs:[run], fileChanges:structuredClone(items), fileChangeTurns:structuredClone(turns), fileChangeActiveRunId:busy ? run.id : null, status, error:null, historyTotal:2, queuedCount:0, queuedMessages:[] });
      fixture.emitAgent({...structuredClone(fixture.snapshot),type:'ready'});
      fixture.emitAgent({type:'status',status});
    };
    state.publish = items => {
      const busy = fixture.snapshot.status === 'busy';
      const runId = fixture.snapshot.runs.at(-1)?.id ?? 'changes-run';
      state.apply(items, items.length ? [{ runId, items }] : [], busy ? runId : null);
    };
    state.publishLegacy = items => {
      state.apply(items, items.length ? [{ runId: null, items }] : [], null);
    };
    state.status = status => {
      fixture.snapshot.status=status;
      if (status === 'idle') {
        for (const message of fixture.snapshot.messages) if (message.role === 'assistant' && message.status === 'streaming') {
          message.status='done'; fixture.emitAgent({type:'assistant-end',id:message.id,text:message.text});
        }
        for (const run of fixture.snapshot.runs) if (run.status === 'running') {
          run.status='completed'; run.finishedAt=Date.now(); fixture.emitAgent({type:'run',run:structuredClone(run)});
        }
        fixture.snapshot.fileChangeActiveRunId = null;
      }
      fixture.emitAgent({type:'status',status});
    };
    state.focusSelected = () => document.querySelector('.pd-changes-file.is-selected')?.focus();
    state.selectionVisible = () => {
      const list=document.querySelector('.pd-changes-file-list'), selected=document.querySelector('.pd-changes-file.is-selected');
      if(!list || !selected) return false;
      const outer=list.getBoundingClientRect(), inner=selected.getBoundingClientRect();
      return inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
    };
    state.ready(state.path,state.items.slice(0,2),'busy');
  })()`);

  // Running turn: compact summary above the input shows the active run's changes.
  await review.waitFor('Boolean(document.querySelector(".pd-composer-changes.is-running"))');
  await review.assert('!document.querySelector(".pd-transcript .pd-conversation-changes") && [...document.querySelectorAll(".pd-composer-changes.is-running .pd-composer-changes-file")].filter(window.__changesReview.visible).length === 0', 'A running turn settles nothing yet: the compact composer summary is the only entry');
  await review.screenshot('changes-running-dark-1440');
  await review.click('.pd-composer-changes-toggle');
  await review.waitFor('window.__changesReview.visible(document.querySelector(".pd-changes-live-popover"))');
  await review.assert('document.querySelector(".pd-composer-changes-toggle").getAttribute("aria-expanded") === "true" && [...document.querySelectorAll(".pd-changes-live-popover .pd-composer-changes-file")].filter(window.__changesReview.visible).length === 2 && document.querySelector(".pd-changes-live-scope")?.textContent.includes("本轮") && !document.querySelector(".pd-changes-dialog")', 'The running popover lists the active turn\'s files under a turn scope label');
  await review.screenshot('changes-running-popover-dark-1440');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-changes-live-popover")');
  await review.assert('document.querySelector(".pd-composer-changes-toggle").getAttribute("aria-expanded") === "false" && document.activeElement === document.querySelector(".pd-composer-changes-toggle")', 'Escape closes the running file list and restores focus to its toggle');
  await review.click('.pd-composer-changes-toggle');
  await review.click('.pd-changes-live-popover .pd-composer-changes-file[title="assets/header.png"]');
  await review.waitFor(selected('assets/header.png'));
  await review.waitFor('document.querySelector(".pd-changes-diff")?.textContent.includes("二进制")');
  await review.assert('document.querySelector(".pd-changes-dialog")?.open === true && !document.querySelector(".pd-changes-live-popover")', 'Choosing a running file lazily loads its diff and shows the binary limitation');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-changes-dialog") && document.activeElement === document.querySelector(".pd-changes-live-main")');
  await review.assert('window.__changesReview.visible(document.activeElement) && !document.activeElement.closest("[inert]")', 'Closing a review opened from a removed popover row restores usable focus to the running summary');
  await review.click('.pd-composer-changes-toggle');
  await review.evaluate('document.querySelector(".pd-changes-live-popover .pd-composer-changes-file").focus(); window.__changesReview.status("idle")');
  await review.waitFor('Boolean(document.querySelector(".pd-conversation-turn .pd-conversation-changes")) && !document.querySelector(".pd-composer-changes.is-running") && (document.activeElement?.matches(".pd-changes-card-main,.pd-composer-shell textarea") ?? false)');
  await review.assert('window.__changesReview.visible(document.activeElement) && !document.activeElement.closest("[inert]") && !document.querySelector(".pd-changes-dialog")', 'Completing the run while a popover file has keyboard focus restores focus to the settled turn card or composer');
  await review.evaluate('window.__changesReview.ready(window.__changesReview.path,window.__changesReview.items.slice(0,2),"busy")');
  await review.waitFor('Boolean(document.querySelector(".pd-composer-changes.is-running"))');
  await review.click('.pd-composer-changes.is-running .pd-composer-changes-review');
  await review.waitFor('document.querySelector(".pd-changes-dialog")?.open === true');
  await review.evaluate('window.__changesReview.dialog = document.querySelector(".pd-changes-dialog"); window.__changesReview.runningTrigger=document.querySelector(".pd-composer-changes.is-running .pd-composer-changes-review"); window.__changesReview.publish(window.__changesReview.items)');
  await review.waitFor('document.querySelectorAll(".pd-changes-file").length === window.__changesReview.items.length');
  await review.assert('document.querySelector(".pd-changes-dialog") === window.__changesReview.dialog && document.querySelector(".pd-changes-file.is-selected").title === window.__changesReview.firstPath', 'Appending snapshots to the running turn updates the same open dialog without losing its selection');
  await review.evaluate('window.__changesReview.status("idle")');
  await review.waitFor('Boolean(document.querySelector(".pd-conversation-turn .pd-conversation-changes")) && !document.querySelector(".pd-composer-changes.is-running")');
  await review.assert('document.querySelector(".pd-changes-dialog") === window.__changesReview.dialog && window.__changesReview.dialog.open', 'Busy-to-idle swaps the live strip for the turn card without unmounting the open review dialog');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-changes-dialog")');
  await review.assert('!window.__changesReview.runningTrigger.isConnected && document.activeElement?.isConnected && !document.activeElement.closest("[inert]") && (document.activeElement.matches(".pd-composer-shell textarea") || Boolean(document.activeElement.closest(".pd-conversation-changes")))', 'Escape returns to a usable fallback when the original running trigger was removed');

  // Settled turn card: sits inside the turn that produced the changes.
  await review.assert(`Boolean(document.querySelector(".pd-conversation-turn .pd-turn-changes")) && /本轮|this turn/i.test(document.querySelector('${card}').textContent)`, 'The settled card labels its turn scope');
  await review.assert(`${visibleRows}.length === 3`, 'The turn card initially shows only three files');
  await review.assert(`!document.querySelector('${row('assets/header.png')} .pd-change-stats') && !document.querySelector('${row('generated/catalog.json')} .pd-change-stats')`, 'Binary and unknown file sizes never claim fabricated zero additions or deletions');
  await review.assert('(() => { const card=document.querySelector(".pd-turn-changes")?.getBoundingClientRect(), answer=document.querySelector(".pd-turn-answer")?.getBoundingClientRect(); return !!card && !!answer && Math.abs(card.left-answer.left)<=1 && Math.abs(card.right-answer.right)<=1; })()', 'The wide turn card aligns both horizontal edges with the turn answer column');
  await review.screenshot('changes-turn-card-dark-1440');

  // The main card button and the explicit review action both open the same review UI.
  await review.click(`${card} .pd-changes-card-main`);
  await review.waitFor('document.querySelector(".pd-changes-dialog")?.open === true && Boolean(document.querySelector(".pd-changes-diff .pd-changes-code"))');
  await review.key('Escape');
  await review.click(`${card} .pd-composer-changes-review`);
  await review.waitFor('document.querySelector(".pd-changes-dialog")?.open === true && Boolean(document.querySelector(".pd-changes-diff .pd-changes-code"))');
  await review.screenshot('changes-dialog-dark-1440');
  await review.key('Escape');
  await review.click(`${card} .pd-changes-show-more`);
  await review.waitFor(`${visibleRows}.length === window.__changesReview.items.length`);
  await review.click(`${card} .pd-changes-show-more`);
  await review.waitFor(`${visibleRows}.length === 3`);
  await review.click(`${card} .pd-changes-show-more`);
  await review.evaluate(`(() => { const node=[...document.querySelectorAll('${card} .pd-composer-changes-file')].find(item=>item.title===window.__changesReview.lastPath);node.scrollIntoView({block:'center'}); })()`);
  const lastPath = 'packages/feature-24/nested/component-with-a-long-name.ts';
  await review.click(row(lastPath));
  await review.waitFor('document.querySelector(".pd-changes-file.is-selected")?.title === window.__changesReview.lastPath && window.__changesReview.selectionVisible()');
  await review.assert('document.querySelector(".pd-changes-file-list").scrollTop > 0', 'Opening a later file automatically scrolls the selected sidebar entry into view');
  await review.evaluate('window.__changesReview.focusSelected()');
  await review.key('Home');
  await review.waitFor('document.querySelector(".pd-changes-file.is-selected")?.title === window.__changesReview.firstPath');
  await review.key('ArrowDown');
  await review.waitFor(selected('assets/header.png'));
  await review.assert('document.querySelector(".pd-changes-diff").textContent.includes("二进制") && !document.querySelector(".pd-changes-diff .pd-change-stats")', 'Keyboard file navigation selects binary files and shows the explicit preview limitation');
  await review.key('ArrowUp');
  await review.waitFor(selected('src/engine.ts'));
  await review.key('End');
  await review.waitFor('document.querySelector(".pd-changes-file.is-selected")?.title === window.__changesReview.lastPath && window.__changesReview.selectionVisible()');

  // Copy operates on the selected raw diff; wrap is a reading control, not a data mutation.
  await review.evaluate(`(() => { const button=${diffControl('复制差异|copy diff')}; if(!button) throw new Error('Diff copy control missing');button.click(); })()`);
  await review.waitFor('window.__changesReview.copied === window.__changesReview.fileDiffs.at(-1).diff');
  await review.evaluate(`(() => { const button=${diffControl('换行|wrap')}; if(!button) throw new Error('Diff wrap control missing');window.__changesReview.wrapBefore=button.getAttribute('aria-pressed');button.click(); })()`);
  await review.assert(`(${diffControl('换行|wrap')})?.getAttribute('aria-pressed') !== window.__changesReview.wrapBefore && document.querySelector('.pd-changes-file.is-selected').title === window.__changesReview.lastPath`, 'Wrap toggle changes reading state without changing the selected file');
  await review.key('Escape');

  // A removed selection falls back once; its reappearance must not steal selection.
  await review.click(row('src/engine.ts'));
  await review.waitFor(selected('src/engine.ts'));
  await review.evaluate('window.__changesReview.publish(window.__changesReview.items.filter(item=>item.path!==window.__changesReview.firstPath))');
  await review.waitFor('Boolean(document.querySelector(".pd-changes-file.is-selected")) && document.querySelector(".pd-changes-file.is-selected").title !== window.__changesReview.firstPath');
  await review.evaluate('window.__changesReview.fallbackPath=document.querySelector(".pd-changes-file.is-selected").title; window.__changesReview.publish(window.__changesReview.items)');
  await review.waitFor('document.querySelectorAll(".pd-changes-file").length === window.__changesReview.items.length');
  await review.assert('document.querySelector(".pd-changes-file.is-selected").title === window.__changesReview.fallbackPath', 'Reappearing files do not restore a stale, previously removed selection');
  await review.key('Escape');

  // A session ID can be reused across imports; the file path remains part of isolation.
  await review.click(`${card} .pd-composer-changes-review`);
  await review.waitFor('document.querySelector(".pd-changes-dialog")?.open === true');
  await review.evaluate('window.__changesReview.ready(window.__changesReview.path+"-other",[window.__changesReview.textFile("other-session/only.ts")],"idle","shared-changes-session","other-run")');
  await review.waitFor('!document.querySelector(".pd-changes-dialog") && document.querySelector(".pd-conversation-changes")?.textContent.includes("only.ts")');
  await review.assert(`!document.querySelector('${card}').textContent.includes('engine.ts') && ${visibleRows}.length === 0 && !document.querySelector('${card} .pd-changes-show-more')`, 'Same ID with a new session path closes stale review state and renders a single-file title without duplicate file rows');
  await review.click(`${card} .pd-changes-card-main`);
  await review.waitFor(selected('other-session/only.ts'));
  await review.key('Escape');
  await review.click(`${card} .pd-composer-changes-review`);
  await review.waitFor(selected('other-session/only.ts'));
  await review.key('Escape');
  await review.evaluate('window.__changesReview.publish(window.__changesReview.items.slice(1,3))');
  await review.waitFor(`${visibleRows}.length === 2`);
  await review.assert(`!document.querySelector('${card} .pd-change-stats')`, 'A card containing only binary or unknown files does not present an invented zero-line total');

  // Legacy records without a run settle once at the transcript end under a conversation label.
  await review.evaluate('window.__changesReview.publishLegacy(window.__changesReview.items.slice(0,3))');
  await review.waitFor(`document.querySelector('.pd-transcript-end.pd-transcript-changes .pd-conversation-changes')?.textContent.includes('本次对话')`);
  await review.screenshot('changes-legacy-card-dark-1440');

  // Verify both themes at wide and narrow widths through the real appearance setting.
  await review.evaluate('window.__changesReview.ready(window.__changesReview.path,window.__changesReview.items)');
  await review.waitFor(`${visibleRows}.length === 3`);
  await review.viewport(680, 1000);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Narrow dark file card does not overflow the application');
  await review.screenshot('changes-card-dark-680');
  await review.click(`${card} .pd-composer-changes-review`);
  await review.assert('document.querySelector(".pd-changes-dialog").getBoundingClientRect().right <= innerWidth && document.querySelector(".pd-changes-dialog").getBoundingClientRect().left >= 0', 'Narrow dark dialog remains inside the viewport');
  await review.assert('(() => { const label=document.querySelector(".pd-changes-file .pd-change-filename"), directory=label?.querySelector("small")?.getBoundingClientRect(), filename=label?.querySelector(":scope > span")?.getBoundingClientRect(); return !!directory && !!filename && Math.abs(directory.right-filename.left)<=1; })()', 'Narrow dialog keeps the first file directory directly adjacent to its filename');
  await review.screenshot('changes-dialog-dark-680');
  await review.key('Escape');
  await review.viewport(1440, 1000);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog") && document.documentElement.dataset.theme === "light"');
  await review.screenshot('changes-card-light-1440');
  await review.click(`${card} .pd-composer-changes-review`);
  await review.screenshot('changes-dialog-light-1440');
  await review.key('Escape');
  await review.viewport(680, 1000);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Narrow light file card does not overflow the application');
  await review.screenshot('changes-card-light-680');
  await review.click(`${card} .pd-composer-changes-review`);
  await review.screenshot('changes-dialog-light-680');
  await review.evaluate('window.__changesReview.publish([])');
  await review.waitFor('!document.querySelector(".pd-conversation-changes,.pd-composer-changes,.pd-changes-dialog") && document.activeElement?.matches(".pd-composer-shell textarea")');
  await review.assert('window.__changesReview.visible(document.activeElement) && !document.activeElement.closest("[inert]")', 'Removing every file while review is open closes the empty dialog and restores focus to the visible composer');
  await review.evaluate('window.__changesReview.publish(window.__changesReview.items)');
  await review.waitFor(`${visibleRows}.length === 3`);
  await review.evaluate('document.querySelector(".pd-conversation-changes .pd-composer-changes-file").focus(); window.__changesReview.publish([window.__changesReview.items.at(-1)])');
  await review.waitFor('document.activeElement?.matches(".pd-changes-card-main") && !document.querySelector(".pd-conversation-changes .pd-composer-changes-file")');
  await review.assert('window.__changesReview.visible(document.activeElement)', 'Replacing a focused file list with a single-file card restores focus to its review entry');
  await review.evaluate('window.__changesReview.publish([])');
  await review.waitFor('!document.querySelector(".pd-conversation-changes") && document.activeElement?.matches(".pd-composer-shell textarea")');
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  const noop = async () => {};
  await fileChangesScenarios({ evaluate: async value => compile(value), waitFor: async value => compile(value), assert: async value => compile(value), record: async (_name, value) => compile(value), reducedMotion: noop, viewport: noop, click: noop, clickText: noop, key: noop, screenshot: noop });
  console.log(`Prepared ${count} file-changes expressions; no browser launched.`);
}
