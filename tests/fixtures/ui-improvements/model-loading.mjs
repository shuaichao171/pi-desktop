// Built renderer + deferred fixture IPC, without model requests or user windows.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../ui-improvements/model-loading.mjs
function installModelLoadingFixture() {
  const f = window.__modelReview, bridge = window.piDesktop;
  localStorage.removeItem('pi-desktop.model-catalog.v1');
  const model = f.providers[0].models[0];
  f.providers[0].models.push(...Array.from({ length: 18 }, (_, i) => ({ ...model, id: `gpt-${i}`, name: `GPT Model ${i}` })));
  const state = window.__modelLoading = { batch: 0, hold: true, pending: [] };
  for (const name of ['listModels', 'listModelProviders', 'listProviderAuth']) {
    const original = bridge[name].bind(bridge);
    bridge[name] = async (...args) => {
      if (!state.hold) return original(...args);
      return new Promise((resolve, reject) => state.pending.push({ name, batch: state.batch, resolve: async (value) => resolve(value ?? await original(...args)), reject }));
    };
  }
  state.release = (name, batch = state.batch, value) => {
    const selected = state.pending.filter(item => item.name === name && item.batch === batch);
    state.pending = state.pending.filter(item => !selected.includes(item));
    for (const item of selected) void item.resolve(value);
  };
  state.fail = (name, batch = state.batch) => {
    const selected = state.pending.filter(item => item.name === name && item.batch === batch);
    state.pending = state.pending.filter(item => !selected.includes(item));
    for (const item of selected) item.reject(new Error('模型目录暂时无法连接'));
  };
  state.finish = (batch = state.batch) => { for (const name of ['listModels', 'listModelProviders', 'listProviderAuth']) state.release(name, batch); };
  state.measure = () => {
    const box = document.querySelector('#pd-composer-model-picker').getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height, left: box.left, width: box.width };
  };
  f.snapshot.messages = [{ id: 'loading-user', role: 'user', order: 0, text: '切换对话后选择模型', status: 'done' }];
  f.snapshot.historyTotal = 1;
}

export default async function modelLoadingScenarios(review) {
  const picker = '#pd-composer-model-picker';
  const body = '.pd-composer-model-body';
  await review.reloadWithFixture(`(${installModelLoadingFixture.toString()})()`);
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.click('.pd-composer-model-trigger');
  await review.waitFor(`document.querySelector('${body}')?.getAttribute('aria-busy') === 'true'`);
  await review.assert('Boolean(document.querySelector(".pd-composer-provider-browser.is-skeleton")) && !document.querySelector(".pd-composer-picker-empty") && !document.querySelector(".pd-composer-picker-model")', 'The first load shows a two-column placeholder instead of a false empty state');
  await review.assert('getComputedStyle(document.querySelector(".is-skeleton .pd-composer-picker-list")).overflowY === "hidden" && getComputedStyle(document.querySelector(".pd-model-skeleton-line")).animationName === "none"', 'Loading placeholders avoid fake scrollbars and respect reduced motion');
  await review.waitFor('document.querySelector(".pd-composer-catalog-status")?.textContent.includes("正在加载模型")');
  await review.evaluate('window.__modelLoading.coldBox = window.__modelLoading.measure()');
  await review.screenshot('model-loading-placeholder');
  await review.evaluate('window.__modelLoading.release("listModels"); window.__modelLoading.release("listModelProviders")');
  await review.assert('Boolean(document.querySelector(".is-skeleton")) && document.querySelector(".pd-composer-model-body").getAttribute("aria-busy") === "true"', 'Partial responses wait for authentication before replacing the placeholder');
  await review.evaluate('window.__modelLoading.release("listProviderAuth")');
  await review.waitFor('document.querySelectorAll(".pd-composer-picker-model").length === 19 && !document.querySelector(".is-skeleton")');
  await review.assert('(() => { const before=window.__modelLoading.coldBox,after=window.__modelLoading.measure(); return Math.abs(before.height-after.height)<1 && Math.abs(before.top-after.top)<1 && Math.abs(before.bottom-after.bottom)<1; })()', 'Loading and ready states share the same panel dimensions and anchor');
  await review.assert('document.activeElement === document.querySelector(".pd-composer-picker-search") && !document.querySelector(".pd-composer-catalog-status").textContent', 'The first result preserves search focus and clears progress feedback');
  await review.key('Escape');

  // The next open keeps its usable catalog through staggered refreshes.
  await review.evaluate('window.__modelLoading.batch=1');
  await review.click('.pd-composer-model-trigger');
  await review.waitFor('document.querySelector(".pd-composer-catalog-status")?.textContent.includes("正在更新列表")');
  await review.assert('[...document.querySelectorAll(".pd-composer-picker-model")].every(row=>!row.disabled && getComputedStyle(row).opacity === "1")', 'Refreshing metadata never dims or blocks the existing model list');
  await review.fill('.pd-composer-picker-search', 'gpt');
  await review.evaluate('window.__modelLoading.warmBox=window.__modelLoading.measure(); window.__modelLoading.list=document.querySelector(".pd-composer-provider-models .pd-composer-picker-list"); window.__modelLoading.list.scrollTop=250; window.__modelLoading.scroll=window.__modelLoading.list.scrollTop; window.__modelLoading.first=document.querySelector(".pd-composer-picker-model"); true');
  await review.evaluate('window.__modelLoading.release("listModels",1,[...window.__modelReview.providers[0].models,{...window.__modelReview.providers[0].models[0],id:"gpt-new",name:"GPT New"}])');
  await review.assert('document.querySelectorAll(".pd-composer-picker-model").length===19 && window.__modelLoading.first===document.querySelector(".pd-composer-picker-model")', 'An early models response does not replace rows before the full catalog is ready');
  await review.screenshot('model-loading-background-refresh');
  await review.evaluate('window.__modelLoading.release("listModelProviders",1); window.__modelLoading.release("listProviderAuth",1)');
  await review.waitFor('Boolean(document.querySelector("[data-model-id=gpt-new]"))');
  await review.assert('window.__modelLoading.first===document.querySelector(".pd-composer-picker-model") && window.__modelLoading.list.scrollTop===window.__modelLoading.scroll && document.querySelector(".pd-composer-picker-search").value==="gpt" && document.activeElement===document.querySelector(".pd-composer-picker-search")', 'The completed refresh preserves rows, scroll position, query and keyboard focus');
  await review.assert('Math.abs(window.__modelLoading.warmBox.height-window.__modelLoading.measure().height)<1', 'Background refresh keeps the panel height stable');
  await review.key('Escape');

  await review.evaluate('window.__modelLoading.batch=2');
  await review.click('.pd-composer-model-trigger');
  await review.evaluate('window.__modelLoading.release("listModels",2,[]); window.__modelLoading.release("listModelProviders",2); window.__modelLoading.fail("listProviderAuth",2)');
  await review.waitFor('Boolean(document.querySelector(".pd-composer-catalog-retry"))');
  await review.assert('document.querySelectorAll(".pd-composer-picker-model").length>0 && !document.querySelector(".pd-composer-picker-empty")', 'A failed refresh retains its usable catalog and offers retry');
  await review.screenshot('model-loading-refresh-error');
  await review.evaluate('window.__modelLoading.batch=3');
  await review.click('.pd-composer-catalog-retry');
  await review.assert('document.querySelectorAll(".pd-composer-picker-model").length>0 && !document.querySelector(".is-skeleton") && !document.querySelector(".pd-composer-picker-error")', 'Retry retains the last complete list even after a partial refresh emptied the store');
  await review.evaluate('window.__modelLoading.finish(3)');
  await review.waitFor('!document.querySelector(".pd-composer-picker-error") && document.querySelector(".pd-composer-model-body").getAttribute("aria-busy")==="false"');
  await review.key('Escape');

  // Session reset keeps this workspace's metadata, while retiring old requests.
  await review.evaluate('window.__modelLoading.batch=4');
  await review.click('.pd-composer-model-trigger');
  await review.evaluate(`(() => { const f=window.__modelReview; f.emitAgent({type:'reset',cwd:f.snapshot.cwd}); Object.assign(f.snapshot,{sessionId:'loading-session-b',sessionPath:f.snapshot.sessionPath+'-b',model:'gpt-4',modelName:'GPT Model 4'}); f.emitAgent({...structuredClone(f.snapshot),type:'ready'}); })()`);
  await review.waitFor(`!document.querySelector('${picker}')`);
  await review.evaluate('window.__modelLoading.batch=5');
  await review.click('.pd-composer-model-trigger');
  await review.assert('!document.querySelector(".is-skeleton") && Boolean(document.querySelector("[data-model-id=gpt-4][aria-pressed=true]"))', 'The next conversation opens immediately with its workspace catalog and correct selection');
  await review.evaluate('window.__modelLoading.release("listModels",4,[]); window.__modelLoading.release("listModelProviders",4,[]); window.__modelLoading.release("listProviderAuth",4,[])');
  await review.assert('document.querySelectorAll(".pd-composer-picker-model").length>0 && document.querySelector(".pd-composer-model-body").getAttribute("aria-busy")==="true"', 'Late responses from the old session cannot clear the new conversation list or loading state');
  await review.evaluate('window.__modelLoading.finish(5)');
  await review.waitFor('document.querySelector(".pd-composer-model-body").getAttribute("aria-busy")==="false"');
  await review.screenshot('model-loading-after-session-switch');
  await review.key('Escape');

  // Existing models can still be chosen before the background refresh finishes.
  await review.evaluate('window.__modelLoading.batch=6');
  await review.click('.pd-composer-model-trigger');
  await review.click('[data-model-id=gpt-1]');
  await review.waitFor(`!document.querySelector('${picker}') && window.__modelReview.snapshot.model === 'gpt-1'`);
  await review.evaluate('window.__modelLoading.finish(6); window.__modelLoading.hold=false');
  await review.click('.pd-composer-model-trigger');
  await review.waitFor('document.querySelector(".pd-composer-model-body").getAttribute("aria-busy")==="false"');
  await review.assert('!document.querySelector(".pd-composer-catalog-status").textContent && !document.querySelector(".is-skeleton")', 'A fast refresh never flashes the delayed loading indicator');
  await review.viewport(480, 800);
  await review.assert(`(() => { const box=document.querySelector('${picker}').getBoundingClientRect(); return box.left>=0 && box.right<=innerWidth+1 && box.top>=0 && box.bottom<=innerHeight+1; })()`, 'The same loading layout stays within a narrow viewport');
  await review.screenshot('model-loading-narrow');
  await review.key('Escape');

  await review.reloadWithFixture(`(${installModelLoadingFixture.toString()})()`);
  await review.click('.pd-composer-model-trigger');
  await review.evaluate('window.__modelLoading.fail("listModels"); window.__modelLoading.release("listModelProviders"); window.__modelLoading.release("listProviderAuth")');
  await review.waitFor('Boolean(document.querySelector(".pd-composer-catalog-retry"))');
  await review.assert('document.querySelector(".pd-composer-picker-empty")?.textContent.includes("加载失败") && !document.querySelector(".is-skeleton") && document.querySelector(".pd-composer-model-body").getAttribute("aria-busy")==="false"', 'An initial load failure ends its placeholder and offers retry without reporting missing credentials');
  await review.key('Escape');
}
