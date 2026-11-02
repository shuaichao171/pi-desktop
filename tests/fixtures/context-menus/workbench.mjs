// Dedicated renderer fixture: no real project reads or external editor launches.
export default async function workbenchContextMenus(review) {
  await review.reducedMotion(true);
  await review.viewport(1440, 900);
  await review.reloadWithFixture(`(() => {
    window.__workbenchMenuReview = { editorPaths: [] };
    window.piDesktop.listWorkspaceEntries = async () => [
      { path: 'src', name: 'src', kind: 'directory' },
      ...Array.from({ length: 40 }, (_, index) => ({ path: 'readme-' + index + '.ts', name: 'readme-' + index + '.ts', kind: 'file', size: 240 })),
    ];
    window.piDesktop.openWorkspacePathInEditor = async path => { window.__workbenchMenuReview.editorPaths.push(path); };
  })()`);
  await review.click('.pd-top-bar-workspace-button');
  await review.waitFor('document.querySelectorAll(".pd-workbench [data-file-path]").length === 41');

  const openAt = async (path, edge = false) => {
    const point = await review.evaluate(`(() => {
      const element = [...document.querySelectorAll('.pd-workbench [data-file-path]')].find(element => element.dataset.filePath === ${JSON.stringify(path)});
      element.scrollIntoView({ block: ${edge ? "'end'" : "'nearest'"} });
      const box = element.getBoundingClientRect();
      const point = { x: Math.floor(${edge ? 'box.right - 3' : 'box.left + 24'}), y: Math.floor(box.top + box.height / 2) };
      window.__workbenchMenuReview.point = point;
      return point;
    })()`);
    await review.rightClick(point.x, point.y);
    await review.waitFor('Boolean(document.querySelector(".pd-workbench-file-menu")) && getComputedStyle(document.querySelector(".pd-workbench-file-menu")).visibility === "visible"');
  };
  const assertAtPointer = async (message) => review.assert(`(() => {
    const box = document.querySelector('.pd-workbench-file-menu').getBoundingClientRect();
    const point = window.__workbenchMenuReview.point;
    return Math.abs(box.left - point.x) < 1 && Math.abs(box.top - point.y) < 1;
  })()`, message);

  await openAt('src');
  await assertAtPointer('Directory context menu starts at the right-click pointer');
  await review.assert('document.querySelector(".pd-workbench-file-menu").parentElement === document.body', 'File menu escapes workbench overflow and transforms');
  await review.screenshot('workbench-directory-at-pointer');
  await review.key('Escape');
  await review.assert('document.activeElement.dataset.filePath === "src"', 'Escape restores the directory row');

  await openAt('readme-0.ts');
  await assertAtPointer('File context menu starts at the right-click pointer');
  await review.key('Escape');
  await openAt('readme-39.ts', true);
  await review.assert(`(() => {
    const box = document.querySelector('.pd-workbench-file-menu').getBoundingClientRect();
    const point = window.__workbenchMenuReview.point;
    return box.left < point.x && box.top < point.y && box.right <= innerWidth - 7 && box.bottom <= innerHeight - 7;
  })()`, 'Bottom-right menu moves only enough to remain inside the window');
  await review.screenshot('workbench-menu-bottom-right');
  await review.key('Escape');

  await review.evaluate('document.querySelector("[data-file-path=src]").focus()');
  await review.key('F10', { shift: true });
  await review.waitFor('Boolean(document.querySelector(".pd-workbench-file-menu"))');
  await review.assert(`(() => {
    const trigger = document.querySelector('[data-file-path=src]').getBoundingClientRect();
    const menu = document.querySelector('.pd-workbench-file-menu').getBoundingClientRect();
    return Math.abs(menu.left - trigger.left) < 1 && Math.abs(menu.top - trigger.bottom - 5) < 1 && document.activeElement.getAttribute('role') === 'menuitem';
  })()`, 'Shift+F10 anchors at the focused row and focuses the first action');
  await review.key('Escape');
  await review.click('.pd-workbench-file-row:has([data-file-path=src]) .pd-workbench-file-menu-trigger');
  await review.assert(`(() => {
    const trigger = document.querySelector('.pd-workbench-file-row:has([data-file-path=src]) .pd-workbench-file-menu-trigger').getBoundingClientRect();
    const menu = document.querySelector('.pd-workbench-file-menu').getBoundingClientRect();
    return Math.abs(menu.top - trigger.bottom - 5) < 1 && menu.right <= innerWidth - 7;
  })()`, 'Ellipsis opens below its button while staying in the viewport');
  await review.click('.pd-workbench-file-row:has([data-file-path=src]) .pd-workbench-file-menu-trigger');
  await review.assert('getComputedStyle(document.querySelector(".pd-workbench-file-menu")).visibility === "visible"', 'Repeated ellipsis activation does not leave the menu hidden');
  await review.key('Escape');

  await review.viewport(680, 760);
  await review.assert('document.querySelector(".pd-workbench").getAttribute("aria-modal") === "true"', 'Narrow workbench uses its modal focus boundary');
  await openAt('src');
  await assertAtPointer('Narrow modal workbench still anchors the menu at the pointer');
  await review.assert('document.activeElement === document.querySelector(".pd-workbench-file-menu button")', 'Modal focus containment permits the portaled menu');
  await review.key('ArrowDown');
  await review.assert('document.activeElement === document.querySelectorAll(".pd-workbench-file-menu button")[1]', 'Arrow keys can select actions inside the narrow menu');
  await review.screenshot('workbench-menu-narrow-modal');
  // The editor action sits below the create/rename/delete/copy actions.
  for (let step = 0; step < 5; step++) await review.key('ArrowDown');
  await review.assert('document.activeElement?.textContent.trim() === "在编辑器中打开"', 'Arrow keys reach the open-in-editor action');
  await review.key('Enter');
  await review.assert('window.__workbenchMenuReview.editorPaths.join(",") === "src" && !document.querySelector(".pd-workbench-file-menu")', 'Keyboard action uses the correct path and closes the menu');
  await openAt('readme-39.ts', true);
  await review.viewport(680, 560);
  await review.assert(`(() => {
    const box = document.querySelector('.pd-workbench-file-menu').getBoundingClientRect();
    return box.left >= 8 && box.top >= 8 && box.right <= innerWidth - 7 && box.bottom <= innerHeight - 7;
  })()`, 'Open menu stays inside the viewport after window resize');
  await review.key('Escape');
  await review.key('Escape');
  await review.assert('!document.querySelector(".pd-workbench").classList.contains("is-open") && !document.querySelector(".pd-workbench-file-menu")', 'Closing the workbench leaves no detached menu');
}
