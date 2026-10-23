// Renderer-only file actions; this fixture never opens files or external software.
// Prepare: node tests/fixtures/result-files/scenarios.mjs --check
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=../result-files/scenarios.mjs
function installResultFilesFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const state = window.__resultFilesReview = { calls: [], cwd: fixture.snapshot.cwd };
  const markdown = [
    '已生成文件：[报告](<C:/renderer-review/project/报告 final.md>)。',
    '',
    '修改入口：`src/main.ts:12`。',
    '',
    '普通路径：C:/renderer-review/project/results/summary.txt。',
    '',
    '[图片预览](C:/renderer-review/project/chart.png) · [缺失文件](C:/renderer-review/project/missing.txt)',
    '',
    '长路径：C:/renderer-review/project/results/nested-folder/another-folder/final-export-with-a-long-descriptive-name.md',
    '',
    '[网页资料](https://example.com/docs/report.pdf)，网址 https://example.com/src/main.ts 保持为网页链接。',
    '',
    '```ts',
    'const example = "src/not-a-link.ts";',
    '// C:/renderer-review/project/code-only.txt',
    '```',
  ].join('\n');
  const record = (name, target) => {
    state.calls.push({ name, target: structuredClone(target) });
    if (target.path.endsWith('/missing.txt')) throw new Error('文件不存在：missing.txt');
  };
  bridge.openResultFile = async target => { record('open', target); };
  bridge.revealResultFile = async target => { record('reveal', target); };
  bridge.previewResultFile = async target => {
    record('preview', target);
    const path = /^[A-Za-z]:[\\/]/.test(target.path) ? target.path : state.cwd.replaceAll('\\', '/') + '/' + target.path;
    const name = path.split(/[\\/]/).at(-1);
    if (path.endsWith('.png')) return {
      path, name, size: 104, kind: 'image',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMCKSjpKEgBg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAcenKxApp8SuhsAAAAASUVORK5CYII=',
    };
    return { path, name, size: 144, kind: 'text', text: '# 文件预览\n\n这是报告的完整内容，可在软件内阅读。\n\n验证标记：preview-file-content-ready', truncated: false };
  };
  Object.assign(fixture.snapshot, {
    status: 'idle', error: null, activities: [], historyTotal: 2,
    runs: [{ id: 'result-files-run', startedAt: 1000, finishedAt: 5000, status: 'completed' }],
    messages: [
      { id: 'result-files-user', runId: 'result-files-run', order: 0, role: 'user', text: '展示本次生成的文件和修改位置。', status: 'done' },
      { id: 'result-files-answer', runId: 'result-files-run', order: 1, role: 'assistant', text: markdown, status: 'done' },
    ],
  });
}

export default async function resultFilesScenarios(review) {
  const q = JSON.stringify;
  const body = '[data-message-id="result-files-answer"] [data-message-body]';
  const link = path => `${body} a.pd-result-file-link[data-result-file=${q(path)}]`;
  const reportPath = 'C:/renderer-review/project/报告 final.md';
  const imagePath = 'C:/renderer-review/project/chart.png';
  const missingPath = 'C:/renderer-review/project/missing.txt';
  const menu = '[role="menu"][aria-label="文件操作"]';
  const dialog = 'dialog.pd-result-file-preview[open]';
  await review.waitFor('window.__modelReview?.ready === true');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installResultFilesFixture.toString()})();`);
  await review.waitFor(`document.querySelectorAll(${q(body + ' a.pd-result-file-link')}).length === 6`);
  await review.assert(`document.querySelector(${q(link(reportPath))})?.textContent === '报告' && document.querySelector(${q(link('src/main.ts'))})?.textContent === 'src/main.ts:12'`, 'Markdown file links and inline code paths become interactive references without losing their labels');
  await review.assert(`document.querySelector(${q(link('C:/renderer-review/project/results/summary.txt'))})?.textContent === 'C:/renderer-review/project/results/summary.txt'`, 'Bare file paths exclude trailing sentence punctuation');
  await review.assert(`document.querySelector(${q(body + ' a[href="https://example.com/docs/report.pdf"]')})?.classList.contains('pd-result-file-link') === false && !document.querySelector(${q(body + ' pre a.pd-result-file-link')}) && document.querySelector(${q(body + ' pre')})?.textContent.includes('src/not-a-link.ts')`, 'Web links remain web links and fenced code is never decorated as a file');
  await review.record('result-file-colors', `({ file: getComputedStyle(document.querySelector(${q(link(reportPath))})).color, prose: getComputedStyle(document.querySelector(${q(link(reportPath))}).parentElement).color })`);
  await review.screenshot('result-files-answer');
  await review.assert(`(() => { const node = document.querySelector(${q(link(reportPath))}); const color = getComputedStyle(node).color; const channels = color.match(/[0-9.]+/g)?.map(Number); return channels?.length >= 3 && channels[2] > channels[0] && channels[2] > channels[1] && color !== getComputedStyle(node.parentElement).color; })()`, 'File references use a distinct blue link color');

  // A plain click previews the file inside the app; opening externally lives in the context menu.
  await review.click(link(reportPath));
  await review.waitFor(`document.querySelector(${q(dialog + ' .pd-workbench-reader')})?.textContent.includes('preview-file-content-ready')`);
  await review.assert(`(() => { const s = window.__resultFilesReview, call = s.calls.find(call => call.name === 'preview'); return call.target.cwd === s.cwd && call.target.path === ${q(reportPath)} && call.target.line === undefined && !s.calls.some(call => call.name === 'open'); })()`, 'Clicking a generated file previews its complete local path in the conversation directory without launching external software');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector(${q(dialog)})`);
  await review.click(link('src/main.ts'));
  await review.waitFor(`Boolean(document.querySelector(${q(dialog)}))`);
  await review.assert('(() => { const s = window.__resultFilesReview, call = s.calls.filter(call => call.name === "preview").at(-1); return call.target.cwd === s.cwd && call.target.path === "src/main.ts" && call.target.line === 12; })()', 'A source reference keeps its line separate from the path sent to the file service');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector(${q(dialog)})`);

  async function contextMenu(path) {
    const point = await review.evaluate(`(() => { const node = document.querySelector(${q(link(path))}); if (!node) throw new Error('File link is missing'); node.scrollIntoView({ block: 'center', inline: 'nearest' }); const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2; const hit = document.elementFromPoint(x, y); if (!(hit === node || node.contains(hit))) throw new Error('File link is obscured'); return { x, y }; })()`);
    await review.rightClick(point.x, point.y);
    await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`);
    return point;
  }
  const menuPoint = await contextMenu(reportPath);
  await review.assert(`(() => { const box = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(box.left - ${menuPoint.x}) <= 1 && Math.abs(box.top - ${menuPoint.y}) <= 1; })()`, 'A file context menu starts at the pointer location when there is enough room');
  await review.assert(`JSON.stringify([...document.querySelectorAll(${q(menu + ' [role="menuitem"]')})].map(node => node.textContent.trim())) === JSON.stringify(['打开预览', '用默认应用打开', '打开所在位置'])`, 'Right clicking a file exposes preview, default-app, and containing-folder actions');
  await review.screenshot('result-files-context-menu');
  await review.clickText(menu + ' button', '用默认应用打开');
  await review.waitFor('window.__resultFilesReview.calls.some(call => call.name === "open")');
  await review.assert(`(() => { const s = window.__resultFilesReview, call = s.calls.find(call => call.name === 'open'); return call.target.cwd === s.cwd && call.target.path === ${q(reportPath)} && call.target.line === undefined && !document.querySelector(${q(menu)}); })()`, 'Open in default app sends the complete local path and closes the menu');
  await contextMenu(reportPath);
  await review.clickText(menu + ' button', '打开预览');
  await review.waitFor(`document.querySelector(${q(dialog + ' .pd-workbench-reader')})?.textContent.includes('preview-file-content-ready')`);
  await review.assert(`document.querySelector(${q(dialog + ' h2')})?.textContent === '报告 final.md' && !document.querySelector(${q(menu)})`, 'Preview opens a readable in-app file dialog and closes the context menu');
  await review.screenshot('result-files-text-preview');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector(${q(dialog)})`);
  await review.assert(`document.activeElement === document.querySelector(${q(link(reportPath))})`, 'Escape closes the preview and restores focus to its file reference');

  await review.evaluate(`(() => { document.querySelector(${q(link(reportPath))}).focus({ preventScroll: true }); })()`);
  await review.key('F10', { shift: true });
  await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`);
  await review.assert(`(() => { const anchor = document.querySelector(${q(link(reportPath))}).getBoundingClientRect(), box = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(box.top - Math.max(8, Math.min(anchor.bottom + 5, innerHeight - box.height - 8))) <= 1 && Math.abs(box.left - Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))) <= 1; })()`, 'Reopening the file menu from the keyboard anchors it to the link instead of reusing the last pointer location');
  await review.clickText(menu + ' button', '打开所在位置');
  await review.assert(`(() => { const s = window.__resultFilesReview, call = s.calls.find(call => call.name === 'reveal'); return call?.target.cwd === s.cwd && call.target.path === ${q(reportPath)}; })()`, 'The keyboard context menu can reveal the referenced file in its containing folder');

  await contextMenu(missingPath);
  await review.clickText(menu + ' button', '用默认应用打开');
  await review.waitFor('document.querySelector(".pd-operation-notice.is-error")?.textContent.includes("文件不存在：missing.txt")');
  await review.assert(`!document.querySelector(${q(dialog)})`, 'A missing file surfaces its open error without navigating away from the conversation');
  await review.click('.pd-operation-notice.is-error button[aria-label="关闭提示"]');
  await contextMenu(missingPath);
  await review.clickText(menu + ' button', '打开预览');
  await review.waitFor(`document.querySelector(${q(dialog + ' [role="alert"]')})?.textContent.includes('文件不存在：missing.txt')`);
  await review.assert(`document.querySelector(${q(dialog)})?.textContent.includes('无法预览文件') && [...document.querySelectorAll(${q(dialog + ' button')})].some(node => node.textContent.trim() === '重试')`, 'A missing preview shows its error and a retry action inside the dialog');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector(${q(dialog)})`);

  await contextMenu(imagePath);
  await review.clickText(menu + ' button', '打开预览');
  await review.waitFor(`(() => { const image = document.querySelector(${q(dialog + ' .pd-result-file-preview-image img')}); return image?.complete && image.naturalWidth > 0; })()`);
  await review.assert(`document.querySelector(${q(dialog + ' .pd-result-file-preview-image img')})?.alt === 'chart.png' && !document.querySelector(${q(dialog + ' [role="alert"]')})`, 'Image preview renders the returned image data without loading an external resource');
  await review.key('+');
  await review.assert(`document.querySelector(${q(dialog + ' .pd-result-file-preview-zoom output')})?.textContent === '125%'`, 'Image preview supports its zoom controls');
  await review.screenshot('result-files-image-preview');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector(${q(dialog)})`);

  await review.viewport(680, 1000);
  await review.assert(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(${q(body + ' a.pd-result-file-link')})].every(node => { const box = node.getBoundingClientRect(); return box.right <= innerWidth + 1 && box.left >= -1; })`, 'Long result file paths wrap without page overflow at 680 pixels');
  await review.screenshot('result-files-narrow-answer');
  await contextMenu(reportPath);
  await review.clickText(menu + ' button', '打开预览');
  await review.waitFor(`document.querySelector(${q(dialog + ' .pd-workbench-reader')})?.textContent.includes('preview-file-content-ready')`);
  await review.assert(`(() => { const box = document.querySelector(${q(dialog)}).getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1; })()`, 'The file preview fits inside a narrow application window');
  await review.screenshot('result-files-narrow-preview');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector(${q(dialog)})`);
  await review.record('result-file-actions', 'window.__resultFilesReview.calls');
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  const noop = async () => {};
  await resultFilesScenarios({
    evaluate: async expression => { compile(expression); return { x: 1, y: 1 }; },
    waitFor: async expression => compile(expression), assert: async expression => compile(expression),
    record: async (_name, expression) => compile(expression), reloadWithFixture: async expression => compile(expression),
    key: noop, reducedMotion: noop, viewport: noop, rightClick: noop, click: noop, clickText: noop, screenshot: noop,
  });
  console.log(`Prepared ${count} result-file expressions; no browser launched.`);
}
