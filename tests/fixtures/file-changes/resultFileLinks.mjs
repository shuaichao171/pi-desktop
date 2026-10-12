// Regression: file links inside assistant text must open around conversation completion.
// The first settle of a new conversation assigns its session file path (null -> path) and
// relocates the settled reply; the preview dialog survives that resync, and a click pressed
// just before the swap still opens (press rescue).
// Run after the renderer build: node tests/fixtures/model-settings/run.mjs --run --scenario=../file-changes/resultFileLinks.mjs
export default async function linkRepro(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  // Install bridge methods the fixture lacks (previewResultFile/openResultFile/revealResultFile).
  await review.reloadWithFixture(`
    const real = window.piDesktop;
    const previews = window.__linkPreviews = { calls: [] };
    window.piDesktop = new Proxy(real, {
      get(target, key) {
        if (key === 'previewResultFile') return async (t) => {
          previews.calls.push({ path: t.path, line: t.line, cwd: t.cwd });
          return { kind: 'text', path: 'C:\\\\renderer-review\\\\project\\\\' + t.path.replace(/\\\\/g, '/'), name: (t.path.split('/').at(-1) ?? t.path), size: 128, text: Array.from({ length: 40 }, (_, i) => 'line ' + (i + 1)).join('\\n'), truncated: false };
        };
        if (key === 'openResultFile' || key === 'revealResultFile') return async () => {};
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  `);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = window.__repro = {};
    state.startRun = () => {
      const now = Date.now();
      const run = { id: 'run-1', startedAt: now, finishedAt: null, status: 'running' };
      Object.assign(fixture.snapshot, {
        sessionId: 'link-session', status: 'busy',
        messages: [
          { id: 'u1', order: 0, runId: run.id, role: 'user', status: 'done', text: '帮我看看这些文件' },
          { id: 'a1', order: 1, runId: run.id, role: 'assistant', status: 'streaming', text: '我查看了 src/engine.ts:42 和 \\\`lib/utils.js\\\` 的内容，问题在函数入口。' },
        ],
        activities: [], runs: [run], fileChanges: [], fileChangeTurns: [], fileChangeActiveRunId: null, historyTotal: 2, error: null,
      });
      fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
      fixture.emitAgent({ type: 'status', status: 'busy' });
    };
    state.settle = () => {
      const now = Date.now();
      const run = { id: 'run-1', startedAt: now - 30000, finishedAt: now, status: 'completed' };
      Object.assign(fixture.snapshot, {
        sessionPath: 'C:\\\\renderer-review\\\\link-session.jsonl', status: 'idle',
        messages: [
          { id: 'u1', order: 0, runId: run.id, role: 'user', status: 'done', text: '帮我看看这些文件' },
          { id: 'a1', order: 1, runId: run.id, role: 'assistant', status: 'done', text: '我查看了 src/engine.ts:42 和 \\\`lib/utils.js\\\` 的内容，问题在函数入口。' },
        ],
        runs: [run], fileChangeActiveRunId: null,
      });
      fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
      fixture.emitAgent({ type: 'status', status: 'idle' });
    };
    fixture.snapshot.sessionPath = null; // brand-new conversation: no session file yet
    state.startRun();
  })()`);
  await review.waitFor('Boolean(document.querySelector(".pd-result-file-link"))');

  // 1) Open the preview DURING the run, then the run settles (sessionPath appears for the first time).
  await review.click('.pd-result-file-link');
  await review.waitFor('document.querySelector(".pd-result-file-preview")?.open === true');
  await review.record('preview-open-during-run', 'true');
  await review.evaluate('window.__repro.settle()');
  await review.evaluate('new Promise(r => setTimeout(r, 300))');
  const afterSettle = await review.evaluate(`({ open: document.querySelector('.pd-result-file-preview')?.open === true, linkStillThere: Boolean(document.querySelector('.pd-result-file-link')), focus: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null })`);
  await review.record('preview-after-first-settle', `JSON.parse(${JSON.stringify(JSON.stringify(afterSettle))})`);

  // 2) After the settle the preview stays open; Escape must still close it,
  //    and a fresh click must reopen it.
  if (afterSettle.open) {
    await review.key('Escape');
    await review.waitFor('!document.querySelector(".pd-result-file-preview")');
    await review.click('.pd-result-file-link');
    await review.evaluate('new Promise(r => setTimeout(r, 250))');
    const reopen = await review.evaluate(`document.querySelector('.pd-result-file-preview')?.open === true`);
    await review.record('reopen-after-settle', String(reopen));
    if (reopen) await review.key('Escape');
  } else {
    await review.click('.pd-result-file-link');
    await review.evaluate('new Promise(r => setTimeout(r, 250))');
    const reopen = await review.evaluate(`document.querySelector('.pd-result-file-preview')?.open === true`);
    await review.record('reopen-after-settle', String(reopen));
    if (reopen) await review.key('Escape');
  }

  // 3) Click racing the settle itself: mousedown on the link, settle fires, mouseup.
  await review.evaluate('window.__repro.startRun()');
  await review.waitFor('document.querySelector(".pd-result-file-link") !== null');
  const point = await review.evaluate(`(() => { const e = document.querySelector('.pd-result-file-link'); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
  await review.mouseDown(point.x, point.y);
  await review.evaluate('window.__repro.settle()');
  await review.mouseUp();
  await review.evaluate('new Promise(r => setTimeout(r, 300))');
  const raced = await review.evaluate(`({ open: document.querySelector('.pd-result-file-preview')?.open === true, previewCalls: window.__linkPreviews.calls.length })`);
  await review.record('click-racing-settle', `JSON.parse(${JSON.stringify(JSON.stringify(raced))})`);
  if (raced.open) { await review.key('Escape'); await review.waitFor('!document.querySelector(".pd-result-file-preview")'); }

  // 4) Second run in the SAME session (sessionPath already known): settle must not disturb the preview.
  await review.evaluate('window.__repro.startRun()');
  await review.click('.pd-result-file-link');
  await review.waitFor('document.querySelector(".pd-result-file-preview")?.open === true');
  // This settle keeps sessionPath (it already existed in the snapshot from step 3's settle).
  await review.evaluate('window.__repro.settle()');
  await review.evaluate('new Promise(r => setTimeout(r, 300))');
  const stable = await review.evaluate(`document.querySelector('.pd-result-file-preview')?.open === true`);
  await review.record('preview-survives-later-settle', String(stable));
  if (stable) { await review.key('Escape'); await review.waitFor('!document.querySelector(".pd-result-file-preview")'); }
  await review.assert('true', 'link repro finished');
}
