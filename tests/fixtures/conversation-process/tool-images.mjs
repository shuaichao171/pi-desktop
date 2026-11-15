// Visual verification: images a tool produced render inline in the conversation
// (claude.ai-style): head badge, lazy payload fetch via getToolResultImage,
// per-image failure fallback, click-through preview dialog.
// Prepare: node tests/fixtures/conversation-process/tool-images.mjs --check
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=../conversation-process/tool-images.mjs
export default async function toolResultImageScenarios(review) {
  const turn = '.pd-conversation-turn[data-run-id="verify"]';
  const card = `${turn} .pd-activity-item`;
  const head = `${card} .pd-activity-head`;
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = window.__toolImageReview = { path: fixture.snapshot.sessionPath, calls: [] };
    // Canvas-drawn PNG payload stands in for an image the agent viewed.
    state.png = () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 320, 200);
      gradient.addColorStop(0, '#4c8dff'); gradient.addColorStop(1, '#0b2e6f');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 320, 200);
      ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText('tool image', 24, 108);
      return canvas.toDataURL('image/png').split(',')[1];
    };
    // Lazy payloads: index 0 loads, index 1 fails so both outcomes are visible.
    window.piDesktop.getToolResultImage = async (sessionPath, toolCallId, index) => {
      state.calls.push({ sessionPath, toolCallId, index });
      if (index === 1) throw new Error('fixture failure');
      return { kind: 'image', name: 'read-image.png', mimeType: 'image/png', data: state.png() };
    };
    const now = Date.now();
    const messages = [
      { id: 'verify-user', runId: 'verify', order: 0, role: 'user', text: '查看这两张图并比较', status: 'done' },
      { id: 'verify-final', runId: 'verify', order: 4, role: 'assistant', status: 'done', text: '两张图已比较完成，差异见上。' },
    ];
    const activities = [
      { id: 'view-image', runId: 'verify', order: 1, tool: 'read', title: '读取 screenshot.png', status: 'done',
        detail: 'Read image file [image/png]', files: ['docs/screenshot.png'],
        images: [{ mimeType: 'image/png', approxBytes: 2048 }, { mimeType: 'image/png', approxBytes: 2048 }],
        startedAt: now - 8000, endedAt: now - 7000 },
    ];
    const runs = [{ id: 'verify', startedAt: now - 9000, finishedAt: now - 1000, status: 'completed' }];
    Object.assign(fixture.snapshot, { sessionId: state.path, sessionPath: state.path, messages, activities, runs, historyTotal: messages.length, status: 'idle', error: null });
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  })()`);
  await review.waitFor(`document.querySelector('${turn} .pd-turn-summary') !== null`);
  await review.click(`${turn} .pd-turn-summary`);
  await review.waitFor(`document.querySelector('${turn} .pd-turn-summary')?.getAttribute('aria-expanded') === 'true'`, 4000);
  // Collapsed card: the badge already announces the images without any payload fetch.
  await review.assert(`(() => { const badge = document.querySelector('${head} .pd-activity-image-badge'); return badge?.title.includes('2') && window.__toolImageReview.calls.length === 0; })()`, 'Head badge counts images before any payload is fetched');
  await review.screenshot('tool-images-collapsed-badge');
  await review.click(head);
  await review.waitFor(`document.querySelector('${head}')?.getAttribute('aria-expanded') === 'true'`, 4000);
  await review.waitFor(`document.querySelector('${card} .pd-activity-image img') !== null`, 4000);
  await review.assert(`(() => { const state = window.__toolImageReview; const img = document.querySelector('${card} .pd-activity-image img'); return state.calls.length === 2 && state.calls[0].toolCallId === 'view-image' && img?.src.startsWith('data:image/png;base64,'); })()`, 'Expanding the card lazily fetches exactly the listed images');
  await review.waitFor(`document.querySelector('${card} .pd-activity-image-note.is-error') !== null`, 4000);
  await review.assert(`(() => { const notes = [...document.querySelectorAll('${card} .pd-activity-image-note')]; return notes.length === 1 && notes[0].textContent.includes('加载失败'); })()`, 'A failed payload degrades to an inline error note');
  await review.screenshot('tool-images-expanded-strip');
  // The loaded thumbnail opens the shared preview dialog.
  await review.click(`${card} .pd-activity-image button`);
  await review.waitFor(`document.querySelector('dialog[open] img') !== null`, 4000);
  await review.assert(`(() => Boolean(document.querySelector('dialog[open] img')?.src.startsWith('data:image/png;base64,')))()`, 'Clicking a thumbnail opens the full preview dialog');
  await review.screenshot('tool-images-preview-dialog');
  await review.key('Escape');
  await review.waitFor(`document.querySelector('dialog[open]') === null`, 4000);
}
