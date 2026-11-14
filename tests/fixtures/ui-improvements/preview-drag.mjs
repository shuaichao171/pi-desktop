// Built renderer only: verify preview controls and drag-region lifecycle in both window modes.
export function installPreviewDragFixture(mode = 'full') {
  const f = window.__modelReview, bridge = window.piDesktop;
  const info = bridge.getAppInfo.bind(bridge);
  bridge.getAppInfo = async () => ({ ...await info(), windowMode: mode });
  const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 500;
  const context = canvas.getContext('2d');
  context.fillStyle = '#233349'; context.fillRect(0, 0, 900, 500);
  context.fillStyle = '#74bdb1'; context.fillRect(35, 35, 400, 340);
  context.fillStyle = '#e8ba6f'; context.fillRect(465, 35, 400, 340);
  context.fillStyle = '#fff'; context.font = '32px sans-serif'; context.fillText('Preview controls remain clickable', 175, 440);
  const data = canvas.toDataURL('image/png').split(',')[1];
  f.snapshot.messages = [
    { id: 'preview-drag-image', order: 0, role: 'user', status: 'done', text: '查看图片并检查顶部按钮', attachments: [{ kind: 'image', name: '预览测试.png', mimeType: 'image/png', data }] },
    { id: 'preview-drag-table', order: 1, role: 'assistant', status: 'done', text: '| 项目 | 状态 |\n| --- | --- |\n| 关闭预览 | 可点击 |\n| 缩放图片 | 可点击 |' },
  ];
  f.snapshot.historyTotal = 2;
}

export default async function previewDragScenarios(review) {
  const region = `element => getComputedStyle(element).getPropertyValue('-webkit-app-region') || getComputedStyle(element).getPropertyValue('app-region')`;
  for (const mode of ['full', 'pai']) {
    await review.reloadWithFixture(`(${installPreviewDragFixture.toString()})(${JSON.stringify(mode)})`);
    await review.viewport(1440, 860);
    await review.reducedMotion(true);
    const caption = mode === 'full' ? '.pd-top-bar' : '.pd-compact-controls';
    await review.waitFor(`Boolean(document.querySelector('${caption}'))`);
    await review.assert(`(${region})(document.querySelector('${caption}')) === 'drag'`, 'The normal ' + mode + ' window keeps its drag region');
    await review.click('.pd-message-image button');
    await review.waitFor('document.querySelector(".pd-image-preview[open] img")?.complete === true');
    await review.assert(`(${region})(document.querySelector('${caption}')) === 'no-drag'`, 'Opening an image retires the background drag region in ' + mode);
    await review.assert(`['dialog[open]','dialog[open] header','dialog[open] header button','.pd-image-preview-toolbar button'].every(selector => (${region})(document.querySelector(selector)) === 'no-drag')`, 'Preview surfaces, headers and buttons are explicitly outside native drag regions');
    await review.assert('(() => { const b=document.querySelector("dialog[open] header button"),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return hit===b || b.contains(hit); })()', 'The close button wins hit testing at the overlapping title-bar height');
    await review.clickText('.pd-image-preview-toolbar button', '100%');
    await review.click('.pd-image-preview-toolbar button[aria-label="放大"]');
    await review.assert('document.querySelector(".pd-image-preview-toolbar output").textContent === "125%"', 'Image zoom buttons remain actionable');
    await review.screenshot('preview-drag-' + mode);
    await review.click('dialog[open] header button');
    await review.waitFor('!document.querySelector(".pd-image-preview[open]")');
    await review.assert(`(${region})(document.querySelector('${caption}')) === 'drag' && document.activeElement === document.querySelector('.pd-message-image button')`, 'Closing an image restores drag regions and thumbnail focus in ' + mode);

    const tablePoint = await review.evaluate('(() => {const e=document.querySelector(".pd-md-table");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await review.mouseMove(tablePoint.x, tablePoint.y);
    await review.waitFor('getComputedStyle(document.querySelector(".pd-md-table-actions")).pointerEvents === "auto"');
    await review.click('.pd-md-table-actions button[aria-label="在大窗口中查看"]');
    await review.waitFor('Boolean(document.querySelector(".pd-content-preview[open]"))');
    await review.assert(`(${region})(document.querySelector('${caption}')) === 'no-drag'`, 'The shared table/diagram preview shell also retires background dragging');
    await review.click('dialog[open] header button');
    await review.waitFor('!document.querySelector("dialog[open]")');
    await review.assert(`(${region})(document.querySelector('${caption}')) === 'drag'`, 'Table preview restores the ordinary caption region');

    await review.click(mode === 'pai' ? '.pd-pai-settings' : '.pd-settings-entry');
    await review.waitFor('Boolean(document.querySelector(".pd-settings-overlay"))');
    await review.evaluate('(() => {const d=document.createElement("dialog");d.id="preview-nested-native";d.innerHTML="<button>关闭测试预览</button>";document.body.append(d);d.showModal();})()');
    await review.assert(`getComputedStyle(document.querySelector('.pd-settings-overlay'),'::before').getPropertyValue('-webkit-app-region') === 'no-drag'`, 'A native preview above settings disables its transparent drag band');
    await review.evaluate('document.querySelector("#preview-nested-native").close(); document.querySelector("#preview-nested-native").remove()');
    await review.assert(`getComputedStyle(document.querySelector('.pd-settings-overlay'),'::before').getPropertyValue('-webkit-app-region') === 'drag'`, 'Closing the nested preview restores settings dragging');
    await review.key('Escape');
    await review.waitFor('!document.querySelector(".pd-settings-overlay")');
  }
}
