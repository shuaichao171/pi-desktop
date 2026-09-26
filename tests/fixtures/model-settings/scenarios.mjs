// Regression coverage against the actual renderer build and an isolated mock bridge.
export default async function runScenarios(review) {
  const gateway = '[data-provider="review-gateway"]';
  const connection = '.pd-model-provider-detail [data-provider-editor="edit"]';
  const modelDialog = 'dialog[open][data-model-dialog="model"] [data-model-editor="review-reasoner"]';
  const modelRow = '[data-model-id="review-reasoner"]';
  const customModels = 'document.querySelectorAll("[data-model-id]").length';
  const saveCalls = 'window.__modelReview.calls.filter(call => call.name === "saveCustomProvider")';
  const selectGateway = async () => {
    await review.click(gateway);
    await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(connection)}))`);
  };
  const noOpenModelDialog = () => review.waitFor('document.querySelector("dialog[open].pd-model-dialog") === null');
  const dialogCentered = (view) => review.assert(`(() => {const box=document.querySelector(${JSON.stringify(`dialog[open][data-model-dialog="${view}"]`)}).getBoundingClientRect(); return Math.abs(box.x+box.width/2-innerWidth/2)<3 && Math.abs(box.y+box.height/2-innerHeight/2)<3;})()`, `${view} dialog is centered in the viewport`);
  const guard = 'dialog[open][data-model-dialog="confirm"], [role="alertdialog"]';
  const guardButtons = 'dialog[open][data-model-dialog="confirm"] button, [role="alertdialog"] button';
  const waitForGuard = () => review.waitFor(`Boolean(document.querySelector(${JSON.stringify(guard)}))`);
  const keepEditing = async () => review.clickText(guardButtons, '继续编辑');
  const discard = async () => review.clickText(guardButtons, '舍弃修改');

  await review.waitFor('window.__modelReview?.ready === true');
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '模型管理');
  await review.waitFor('document.querySelectorAll("[data-provider]").length === 3');
  await review.assert('document.querySelector("[data-provider-group=configured] [data-provider=openai]") !== null', 'Configured providers are grouped');
  await review.assert('document.querySelector("[data-provider-group=unconfigured] [data-provider=anthropic]") !== null', 'Unconfigured providers are grouped');
  await selectGateway();
  if (process.argv.includes('--trace-inputs')) await review.evaluate('window.__modelReview.traceInputs()');
  const oneConnection = (stage) => review.assert(`document.querySelectorAll(${JSON.stringify(connection)}).length === 1 && document.querySelector(${JSON.stringify(connection)}).isConnected`, `Exactly one connected provider form: ${stage}`);
  await oneConnection('initial');
  await review.assert(`${customModels} === 3`, 'Model list remains mounted with the inline connection editor');
  if (!process.argv.includes('--skip-layout')) {
  for (const [theme, label] of [['dark', '深色'], ['light', '浅色']]) {
    await review.clickText('.pd-settings-nav button', '外观');
    await review.clickText('.pd-appearance-choice', label);
    await review.clickText('.pd-settings-nav button', '模型管理');
    await selectGateway();
    for (const width of [1440, 900, 680]) {
      await review.viewport(width, 1000);
      await review.assert('document.documentElement.scrollWidth <= innerWidth', `No page horizontal overflow: ${theme} ${width}`);
      await review.record(`layout-${theme}-${width}`, `(() => { const selectors = ['.pd-settings-dialog','.pd-model-provider-sidebar','.pd-model-provider-detail']; return Object.fromEntries(selectors.map(selector => {const element = document.querySelector(selector); const box = element.getBoundingClientRect(); return [selector, {x:box.x,y:box.y,width:box.width,height:box.height,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}]})); })()`);
      await review.screenshot(`01-${theme}-${width}-custom-provider`);
    }
  }
  await review.viewport(1440, 1000);

  // Template-to-create changes the native dialog content and focuses its first input.
  await review.click('[data-action="add-provider"]');
  await review.waitFor('Boolean(document.querySelector("dialog[open][data-model-dialog=templates]"))');
  await review.click('dialog[open] [data-template="custom"]');
  await review.waitFor('Boolean(document.querySelector("dialog[open][data-model-dialog=create]"))');
  await dialogCentered('create');
  await review.assert(`document.activeElement === document.querySelector(${JSON.stringify('dialog[open] [data-field="provider.id"]')})`, 'Template transition focuses the new provider id');
  await review.screenshot('02-create-provider-focus');
  await review.click('dialog[open][data-model-dialog="create"] .pd-model-dialog-header button');
  await noOpenModelDialog();
  }

  // Failure keeps the model draft; cancellation does not call the bridge again.
  await review.click(`${modelRow} [data-action="edit-model"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(modelDialog)}))`);
  await dialogCentered('model');
  await review.assert(`${customModels} === 3`, 'Model rows remain mounted behind the native editor dialog');
  await review.fill(`${modelDialog} [data-field="model.name"]`, '模型编辑失败后仍保留的草稿');
  await review.evaluate('window.__modelReview.failures.saveCustomProvider = "模拟保存失败，请保留草稿"');
  await review.click(`${modelDialog} button[type="submit"]`);
  await review.waitFor('document.body.textContent.includes("模拟保存失败，请保留草稿")');
  await review.assert(`document.querySelector(${JSON.stringify(`${modelDialog} [data-field="model.name"]`)}).value === '模型编辑失败后仍保留的草稿'`, 'Failed model save keeps typed content');
  await review.assert('window.__modelReview.providers.find(p=>p.provider==="review-gateway").models.find(m=>m.id==="review-reasoner").name === "团队推理模型"', 'Failed model save does not mutate catalog');
  await review.screenshot('02-model-save-failed-draft');
  const failedSaveCount = await review.evaluate(`${saveCalls}.length`);
  await review.clickText(`${modelDialog} button`, '取消');
  await waitForGuard();
  await discard();
  await noOpenModelDialog();
  await oneConnection('after model discard');
  await review.assert(`${saveCalls}.length === ${failedSaveCount}`, 'Cancelling model editor does not write');
  await review.evaluate('delete window.__modelReview.failures.saveCustomProvider');
  await review.click(`${modelRow} [data-action="edit-model"]`);
  await review.fill(`${modelDialog} [data-field="model.name"]`, '已成功更新的推理模型');
  await review.click(`${modelDialog} button[type="submit"]`);
  await noOpenModelDialog();
  await oneConnection('after model save');
  await review.waitFor(`document.querySelector(${JSON.stringify(modelRow)}).textContent.includes('已成功更新的推理模型')`);

  // Discovery preserves existing models, deduplicates new ids, imports selection.
  await review.evaluate(`window.__modelReview.discovery = {models: [{id:'review-reasoner',name:'不应覆盖已有名称',contextWindow:2,maxTokens:1}, {id:'import-selected',name:'本次选择导入',contextWindow:128000,maxTokens:8192,input:['text'],reasoning:false}, {id:'import-skipped',name:'本次不导入',contextWindow:128000,maxTokens:8192,input:['text'],reasoning:false}, {id:'import-selected',name:'重复目录项',contextWindow:128000,maxTokens:8192,input:['text'],reasoning:false}],warnings:[]}`);
  const beforeDiscoverySaves = await review.evaluate(`${saveCalls}.length`);
  await review.click('[data-action="discover-models"]');
  await review.waitFor('document.querySelectorAll("dialog[open][data-model-dialog=discover] [data-import-model]").length === 2');
  await dialogCentered('discover');
  await review.assert('document.querySelector("dialog[open] [data-import-model=review-reasoner]") === null', 'Discovery excludes existing ids from import candidates');
  await review.assert(`${saveCalls}.length === ${beforeDiscoverySaves}`, 'Discovery itself does not save');
  await review.click('dialog[open] [data-import-model="import-skipped"] input[type="checkbox"]');
  await review.screenshot('03-discovery-selection');
  await review.click('dialog[open][data-model-dialog="discover"] [data-action="import-models"]');
  await noOpenModelDialog();
  await oneConnection('after discovery import');
  await review.waitFor('Boolean(document.querySelector("[data-model-id=import-selected]"))');
  await review.assert('document.querySelector("[data-model-id=import-skipped]") === null', 'Only selected new models are imported');
  await review.assert('window.__modelReview.providers.find(p=>p.provider==="review-gateway").models.find(m=>m.id==="review-reasoner").name === "已成功更新的推理模型"', 'Discovery preserves existing custom metadata');
  await review.assert('window.__modelReview.providers.find(p=>p.provider==="review-gateway").models.filter(m=>m.id==="import-selected").length === 1', 'Discovery duplicates become one model');

  // A discovery response arriving after closing its dialog cannot alter the catalog.
  await review.evaluate('window.__modelReview.delays.discoverProviderModels = "defer"');
  const beforeLateDiscovery = await review.evaluate(`${saveCalls}.length`);
  await review.click('[data-action="discover-models"]');
  await review.waitFor('Boolean(window.__modelReview.pending.discoverProviderModels)');
  await review.click('dialog[open][data-model-dialog="discover"] .pd-model-dialog-header button');
  await noOpenModelDialog();
  await review.evaluate('window.__modelReview.resolvePending("discoverProviderModels", {models:[{id:"too-late-model",name:"过期结果"}],warnings:[]}); delete window.__modelReview.delays.discoverProviderModels');
  await review.settle();
  await review.assert('document.querySelector("dialog[open].pd-model-dialog") === null', 'Late discovery cannot reopen a closed dialog');
  await review.assert(`${saveCalls}.length === ${beforeLateDiscovery} && !window.__modelReview.providers.some(p=>p.models.some(m=>m.id==='too-late-model'))`, 'Late discovery cannot write or modify the catalog');

  // Connection changes protect provider selection and top-level settings changes.
  const connectionUrl = `${connection} [data-field="provider.baseUrl"]`;
  const connectionName = `${connection} [data-field="provider.name"]`;
  const credentialInput = '.pd-model-settings-credentials input[type="password"]';
  await review.fill(credentialInput, 'fixture-secret-not-a-real-key');
  await review.fill(connectionUrl, 'https://cancel.example.invalid/v1');
  await review.record('connection-draft-before-cancel', `({url:document.querySelector(${JSON.stringify(connectionUrl)}).value, actions:[...document.querySelectorAll(${JSON.stringify(`${connection} [data-action]`)})].map(e=>e.dataset.action)})`);
  await review.screenshot('04-connection-draft-before-cancel');
  const beforeCancelConnection = await review.evaluate(`${saveCalls}.length`);
  await review.click('[data-action="cancel-connection"]');
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://models.example.invalid/v1'`, 'Connection cancel restores only connection values');
  await review.assert(`document.querySelector(${JSON.stringify(guard)}) === null`, 'Connection cancel resets directly without a confirmation');
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === 'fixture-secret-not-a-real-key'`, 'Connection cancel preserves independent credential draft');
  await review.assert(`${saveCalls}.length === ${beforeCancelConnection}`, 'Connection cancel makes no write');
  await review.fill(connectionName, '已保存连接名称');
  await review.click('[data-action="save-connection"]');
  await review.waitFor('window.__modelReview.providers.find(p=>p.provider==="review-gateway").name === "已保存连接名称"');
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === 'fixture-secret-not-a-real-key'`, 'Connection save preserves independent credential draft');
  await review.assert(`${saveCalls}.at(-1).args[0].apiKey === undefined`, 'Connection save never includes the credential draft');
  await review.fill(credentialInput, '');
  await review.fill(connectionUrl, 'https://draft.example.invalid/v1');
  const beforeConnectionLeave = await review.evaluate(`${saveCalls}.length`);
  await review.click(gateway);
  await review.assert(`document.querySelector(${JSON.stringify(guard)}) === null`, 'Selecting the current provider does not open a discard guard');
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://draft.example.invalid/v1'`, 'Selecting the current provider preserves connection draft');
  // URL inputs do not support selection APIs, so verify selection with the name field.
  await review.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(connectionName)}); e.focus(); e.setSelectionRange(1,4,'backward'); })()`);
  await review.click('[data-provider="openai"]');
  await waitForGuard();
  await keepEditing();
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://draft.example.invalid/v1'`, 'Keeping connection draft retains provider and content');
  await review.assert(`(() => {const e=document.querySelector(${JSON.stringify(connectionName)}); return document.activeElement===e && e.selectionStart===1 && e.selectionEnd===4 && e.selectionDirection==='backward';})()`, 'Provider guard restores the original draft input and selection');
  await review.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(connectionName)}); e.focus(); e.setSelectionRange(0,3,'forward'); })()`);
  await review.clickText('.pd-settings-nav button', '常规');
  await waitForGuard();
  await review.screenshot('04-connection-leave-guard');
  await keepEditing();
  await review.assert('document.querySelector(".pd-settings-nav [aria-current=page]").textContent === "模型管理"', 'Keeping connection draft stays on model settings');
  await review.assert(`(() => {const e=document.querySelector(${JSON.stringify(connectionName)}); return document.activeElement===e && e.selectionStart===0 && e.selectionEnd===3 && e.selectionDirection==='forward';})()`, 'Settings guard restores the original draft input and selection');
  await review.clickText('.pd-settings-nav button', '常规');
  await discard();
  await review.assert(`${saveCalls}.length === ${beforeConnectionLeave}`, 'Discarding connection changes does not save');
  await review.clickText('.pd-settings-nav button', '模型管理');
  await selectGateway();
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://models.example.invalid/v1'`, 'Discarded connection was not persisted');

  // Credential content is also unsaved data and must protect closing settings.
  await review.fill(credentialInput, 'fixture-secret-not-a-real-key');
  await review.evaluate('window.__modelReview.failures.setProviderApiKey = "模拟凭据保存失败"');
  await review.click('.pd-model-settings-credentials button[type="submit"]');
  await review.waitFor('document.querySelector(".pd-model-settings-credentials").textContent.includes("模拟凭据保存失败")');
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === 'fixture-secret-not-a-real-key'`, 'Failed credential save retains the secret draft');
  await review.evaluate('delete window.__modelReview.failures.setProviderApiKey');
  const beforeSecret = await review.evaluate('window.__modelReview.calls.filter(call=>call.name==="setProviderApiKey").length');
  await review.click('.pd-settings-header button[aria-label="关闭设置"]');
  await waitForGuard();
  await keepEditing();
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === 'fixture-secret-not-a-real-key'`, 'Keeping secret draft retains it in memory');
  await review.click('.pd-settings-header button[aria-label="关闭设置"]');
  await discard();
  await review.waitFor('document.querySelector(".pd-settings-dialog") === null');
  await review.assert(`window.__modelReview.calls.filter(call=>call.name==="setProviderApiKey").length === ${beforeSecret}`, 'Closing after discard never writes the secret');
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '模型管理');
  await selectGateway();
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === ''`, 'Reopening does not resurrect discarded secret');

  // Running agent gates writes; the active model cannot be disabled even idle.
  await review.click('[data-provider="openai"]');
  await review.assert('document.querySelector("[data-model-id=gpt-review] [data-action=toggle-model]").disabled === true', 'The current model cannot be disabled');
  await selectGateway();
  await review.evaluate('window.__modelReview.snapshot.status = "busy"; window.__modelReview.emitAgent({type:"status",status:"busy"})');
  await review.settle();
  await review.assert(`document.querySelector(${JSON.stringify('[data-field="provider.baseUrl"]')}).disabled === true`, 'Busy state disables connection mutation');
  await review.assert('[...document.querySelectorAll("[data-action=add-model],[data-action=edit-model],[data-action=toggle-model],[data-action=discover-models],[data-action=add-provider]")].every(element=>element.disabled)', 'Busy state disables model and provider mutations');
  await review.screenshot('05-busy-gated-controls');
  await review.evaluate('window.__modelReview.snapshot.status = "idle"; window.__modelReview.emitAgent({type:"status",status:"idle"})');
  await review.settle();
  await review.assert('document.querySelector("[data-action=add-model]").disabled === false', 'Controls recover after agent becomes idle');
}
