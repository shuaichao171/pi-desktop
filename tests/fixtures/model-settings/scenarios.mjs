// Regression coverage against the actual renderer build and an isolated mock bridge.
export default async function runScenarios(review) {
  const gateway = '[data-provider="review-gateway"]';
  const editDialog = 'dialog[open][data-model-dialog="edit"]';
  const connection = `${editDialog} [data-provider-editor="edit"]`;
  const modelDialog = 'dialog[open][data-model-dialog="model"] [data-model-editor="review-reasoner"]';
  const modelRow = '[data-model-id="review-reasoner"]';
  const customModels = 'document.querySelectorAll("[data-model-id]").length';
  // Connection saves and models-only saves are both models.json writes.
  const saveCalls = 'window.__modelReview.calls.filter(call => call.name === "saveCustomProvider" || call.name === "saveProviderModels")';
  const templatesDialog = 'dialog[open][data-model-dialog="templates"]';
  const credentialsDialog = 'dialog[open][data-model-dialog="credentials"]';
  const waitForTemplates = () => review.waitFor(`Boolean(document.querySelector(${JSON.stringify(templatesDialog)}))`);
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
  await review.waitFor('document.querySelectorAll("[data-provider]").length === 2');
  await review.assert('document.querySelector("[data-provider-group=configured] [data-provider=openai]") !== null', 'Configured providers are grouped');
  // The default selection is the builtin OpenAI provider: it must also offer
  // live model discovery, while manual model adding stays custom-only.
  await review.assert('Boolean(document.querySelector(".pd-model-catalog [data-action=discover-models]"))', 'Builtin provider offers model discovery');
  await review.assert('document.querySelector(".pd-model-catalog [data-action=add-model]") === null', 'Builtin provider keeps manual model adding hidden');
  await review.assert('document.querySelector("[data-provider=anthropic], [data-provider-group=unconfigured], [data-add-provider=anthropic]") === null', 'Unconfigured builtin providers stay out of the sidebar until Add provider opens');
  // The detail pane stays compact: URL and models only; editing lives behind the Edit settings dialog.
  await review.click(gateway);
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "review-gateway" && Boolean(document.querySelector(".pd-model-provider-connection-row"))');
  if (process.argv.includes('--trace-inputs')) await review.evaluate('window.__modelReview.traceInputs()');
  await review.assert('document.querySelector(".pd-model-provider-detail [data-provider-editor]") === null', 'Provider detail keeps the connection editor out of the compact view');
  await review.assert('document.querySelector(".pd-model-provider-url code").textContent === "https://models.example.invalid/v1"', 'Provider detail shows the API URL');
  await review.assert(`${customModels} === 3`, 'Model list stays visible without opening the editor');
  await review.assert('getComputedStyle(document.querySelector("[data-model-id=review-fast] .pd-model-settings-model-tools")).opacity === "0"', 'Model row tools stay hidden until the row is hovered');
  {
    const box = await review.evaluate('(() => { const box = document.querySelector("[data-model-id=review-fast]").getBoundingClientRect(); return { x: box.x + box.width / 3, y: box.y + box.height / 2 }; })()');
    await review.mouseMove(box.x, box.y);
    await review.waitFor('getComputedStyle(document.querySelector("[data-model-id=review-fast] .pd-model-settings-model-tools")).opacity === "1"');
    await review.screenshot('01-model-row-hover');
    await review.mouseMove(5, 5);
  }
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(editDialog)}))`);
  const oneConnection = (stage) => review.assert(`document.querySelectorAll(${JSON.stringify(connection)}).length === 1 && document.querySelector(${JSON.stringify(connection)}).isConnected`, `Exactly one connected provider form: ${stage}`);
  await oneConnection('initial');
  await review.assert(`${customModels} === 3`, 'Model list remains mounted behind the provider settings dialog');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();
  if (!process.argv.includes('--skip-layout')) {
  for (const [theme, label] of [['dark', '深色'], ['light', '浅色']]) {
    await review.clickText('.pd-settings-nav button', '外观');
    await review.clickText('.pd-appearance-choice', label);
    await review.clickText('.pd-settings-nav button', '模型管理');
    await review.click(gateway);
    await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "review-gateway"');
    for (const width of [1440, 900, 680]) {
      await review.viewport(width, 1000);
      await review.assert('document.documentElement.scrollWidth <= innerWidth', `No page horizontal overflow: ${theme} ${width}`);
      await review.record(`layout-${theme}-${width}`, `(() => { const selectors = ['.pd-settings-dialog','.pd-model-provider-sidebar','.pd-model-provider-detail']; return Object.fromEntries(selectors.map(selector => {const element = document.querySelector(selector); const box = element.getBoundingClientRect(); return [selector, {x:box.x,y:box.y,width:box.width,height:box.height,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}]})); })()`);
      await review.assert(`document.querySelector(${JSON.stringify(connection)}) === null`, `Compact provider detail renders without an inline editor: ${theme} ${width}`);
      await review.screenshot(`01-${theme}-${width}-custom-provider`);
      await review.click('[data-action="add-provider"]');
      await waitForTemplates();
      await review.assert(`(() => {const dialog=document.querySelector(${JSON.stringify(templatesDialog)}); const custom=dialog.querySelector('[data-template=custom]'); const grid=dialog.querySelector('.pd-model-template-grid'); const cards=[...grid.querySelectorAll('button')]; const box=custom.getBoundingClientRect(); return !grid.contains(custom) && cards.length>0 && cards.every(card=>{const other=card.getBoundingClientRect(); return other.top>=box.bottom && box.width>other.width && box.height>other.height;});})()`, `Custom provider stands alone above larger than the other cards: ${theme} ${width}`);
      await review.assert('document.documentElement.scrollWidth <= innerWidth', `Add provider has no page horizontal overflow: ${theme} ${width}`);
      await review.screenshot(`01-${theme}-${width}-add-provider`);
      await review.click(`${templatesDialog} .pd-model-dialog-header button`);
      await noOpenModelDialog();
    }
  }
  await review.viewport(1440, 1000);
  // The frameless title bar (56px) must be part of the dialog's height budget;
  // without it the model page spills past the window bottom and looks covered.
  await review.viewport(1440, 860);
  await review.assert('document.querySelector(".pd-settings-dialog").getBoundingClientRect().bottom <= innerHeight + 0.5', 'Settings dialog stays inside the frameless viewport at 860px height');
  await review.screenshot('01-frameless-fit-1440x860');
  await review.viewport(1440, 1000);
  }

  // Template-to-create changes the native dialog content and focuses its first input.
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.assert(`document.querySelector(${JSON.stringify(`${templatesDialog} [data-add-provider="anthropic"]`)}) !== null && document.querySelector('[data-provider=anthropic]') === null`, 'Unconfigured Anthropic appears only in the Add provider dialog');
  await review.click('dialog[open] [data-template="custom"]');
  await review.waitFor('Boolean(document.querySelector("dialog[open][data-model-dialog=create]"))');
  await dialogCentered('create');
  await review.assert(`(() => {const dialog=document.querySelector('dialog[open][data-model-dialog=create]');const input=dialog.querySelector('[data-field="provider.apiKey"]');const eye=dialog.querySelector('.pd-model-key-reveal');if(!input||!eye)return false;const box=(element)=>element.getBoundingClientRect();const key=box(input),eyeBox=box(eye);return eyeBox.top>=key.top-0.5&&eyeBox.bottom<=key.bottom+0.5&&eyeBox.right<=key.right;})()`, 'The key reveal eye stays vertically centered inside the key input');
  await review.assert(`document.activeElement === document.querySelector(${JSON.stringify('dialog[open] [data-field="provider.id"]')})`, 'Template transition focuses the new provider id');
  await review.screenshot('02-create-provider-focus');
  await review.click('dialog[open][data-model-dialog="create"] .pd-model-dialog-header button');
  await noOpenModelDialog();

  // Returning to the provider picker protects a credential draft without writing it.
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.click(`${templatesDialog} [data-add-provider="anthropic"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(credentialsDialog)}))`);
  await dialogCentered('credentials');
  const anthropicKey = `${credentialsDialog} input#pd-api-key-anthropic`;
  const beforeBackCredentialSaves = await review.evaluate('window.__modelReview.calls.filter(call=>call.name==="setProviderApiKey").length');
  await review.fill(anthropicKey, 'fixture-anthropic-draft');
  await review.click(`${credentialsDialog} [data-action="back-to-providers"]`);
  await waitForGuard();
  await keepEditing();
  await review.assert(`document.querySelector(${JSON.stringify(anthropicKey)}).value === 'fixture-anthropic-draft'`, 'Keeping a credential draft stays in its configuration dialog');
  await review.click(`${credentialsDialog} [data-action="back-to-providers"]`);
  await waitForGuard();
  await discard();
  await waitForTemplates();
  await review.assert(`window.__modelReview.calls.filter(call=>call.name==="setProviderApiKey").length === ${beforeBackCredentialSaves}`, 'Discarding a credential draft to return to Add provider makes no write');
  await review.click(`${templatesDialog} [data-add-provider="anthropic"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(anthropicKey)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(anthropicKey)}).value === ''`, 'Reopening provider configuration does not resurrect the discarded credential');
  await review.fill(anthropicKey, 'fixture-anthropic-configured-key');
  await review.click(`${credentialsDialog} button[type="submit"]`);
  await noOpenModelDialog();
  await review.waitFor('Boolean(document.querySelector("[data-provider=anthropic]"))');
  await review.assert('document.querySelectorAll("[data-provider]").length === 3 && window.__modelReview.providers.find(provider=>provider.provider==="anthropic").configured', 'Saving a credential closes configuration and adds the provider to the main list');
  await review.click('[data-provider="anthropic"]');
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(`${editDialog} input#pd-api-key-anthropic`)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(`${editDialog} .pd-model-provider-connection`)}).textContent.includes('https://api.anthropic.com') === false`, 'Builtin provider settings show read-only connection info');
  await review.click(`${editDialog} .pd-settings-remove`);
  await review.waitFor('document.querySelector("[data-provider=anthropic]") === null');
  await review.assert('document.querySelectorAll("[data-provider]").length === 2', 'Removing the stored credential removes the unconfigured provider from the main list');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.assert(`Boolean(document.querySelector(${JSON.stringify(`${templatesDialog} [data-add-provider="anthropic"]`)}))`, 'The provider returns to Add provider after its credential is removed');
  await review.click(`${templatesDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();
  await review.click(gateway);
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "review-gateway"');

  // Failure keeps the model draft; cancellation does not call the bridge again.
  await review.click(`${modelRow} [data-action="edit-model"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(modelDialog)}))`);
  await dialogCentered('model');
  await review.assert(`${customModels} === 3`, 'Model rows remain mounted behind the native editor dialog');
  await review.fill(`${modelDialog} [data-field="model.name"]`, '模型编辑失败后仍保留的草稿');
  await review.evaluate('window.__modelReview.failures.saveProviderModels = "模拟保存失败，请保留草稿"');
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
  await review.assert(`document.querySelector(${JSON.stringify(connection)}) === null`, 'Model discard leaves no stray provider form');
  await review.assert(`${saveCalls}.length === ${failedSaveCount}`, 'Cancelling model editor does not write');
  await review.evaluate('delete window.__modelReview.failures.saveProviderModels');
  await review.click(`${modelRow} [data-action="edit-model"]`);
  await review.fill(`${modelDialog} [data-field="model.name"]`, '已成功更新的推理模型');
  await review.click(`${modelDialog} button[type="submit"]`);
  await noOpenModelDialog();
  await review.assert(`document.querySelector(${JSON.stringify(connection)}) === null`, 'Model save leaves no stray provider form');
  await review.waitFor(`document.querySelector(${JSON.stringify(modelRow)}).textContent.includes('已成功更新的推理模型')`);

  // Per-model inference test replaces the standalone panel; results render inline in the model row.
  await review.assert('document.querySelector("[data-setting=model-test]") === null', 'The standalone inference test panel is gone');
  await review.click('[data-model-id="review-fast"] [data-action="test-model"]');
  await review.waitFor('document.querySelector("[data-model-id=review-fast]").textContent.includes("推理成功 · 231 ms")');
  await review.evaluate('window.__modelReview.modelTestOk = false');
  await review.click('[data-model-id="review-fast"] [data-action="test-model"]');
  await review.waitFor('document.querySelector("[data-model-id=review-fast]").textContent.includes("401")');
  await review.evaluate('delete window.__modelReview.modelTestOk');

  // Discovery preserves existing models, deduplicates new ids, imports selection.
  await review.evaluate(`window.__modelReview.discovery = {models: [{id:'review-reasoner',name:'不应覆盖已有名称',contextWindow:2,maxTokens:1}, {id:'import-selected',name:'本次选择导入',contextWindow:128000,maxTokens:8192,input:['text'],reasoning:false}, {id:'import-skipped',name:'本次不导入',contextWindow:128000,maxTokens:8192,input:['text'],reasoning:false}, {id:'import-selected',name:'重复目录项',contextWindow:128000,maxTokens:8192,input:['text'],reasoning:true,thinkingLevels:['off','low','medium','high'],inferred:true}],warnings:['已按内置规则为 1 个模型推测思考能力（标记为“推测”）；重新获取且供应商播报真实数据后将自动覆盖。']}`);
  const beforeDiscoverySaves = await review.evaluate(`${saveCalls}.length`);
  await review.click('[data-action="discover-models"]');
  await review.waitFor('document.querySelectorAll("dialog[open][data-model-dialog=discover] [data-import-model]").length === 2');
  await dialogCentered('discover');
  await review.assert('document.querySelector("dialog[open] [data-import-model=review-reasoner]") === null', 'Discovery excludes existing ids from import candidates');
  await review.assert('document.querySelector("dialog[open] [data-import-model=import-selected] .pd-model-import-inferred") !== null', 'Inferred models carry the guess badge in the import list');
  await review.assert('document.querySelector("dialog[open] [data-import-model=import-skipped] .pd-model-import-inferred") === null', 'Advertised models do not carry the guess badge');
  await review.assert(`${saveCalls}.length === ${beforeDiscoverySaves}`, 'Discovery itself does not save');
  await review.click('dialog[open] [data-import-model="import-skipped"] input[type="checkbox"]');
  await review.screenshot('03-discovery-selection');
  await review.click('dialog[open][data-model-dialog="discover"] [data-action="import-models"]');
  await noOpenModelDialog();
  await review.assert(`document.querySelector(${JSON.stringify(connection)}) === null`, 'Discovery import leaves no stray provider form');
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

  // Connection and credential drafts live in the provider settings dialog and guard closing it.
  const connectionUrl = `${connection} [data-field="provider.baseUrl"]`;
  const connectionName = `${connection} [data-field="provider.name"]`;
  const credentialInput = `${editDialog} .pd-model-settings-credentials input[type="password"]`;
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(connection)}))`);
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
  await review.waitFor(`document.querySelector(${JSON.stringify('.pd-model-provider-detail-head h3')}).textContent.includes('已保存连接名称')`);
  await review.fill(credentialInput, '');
  await review.fill(connectionUrl, 'https://draft.example.invalid/v1');
  const beforeConnectionLeave = await review.evaluate(`${saveCalls}.length`);
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await keepEditing();
  await review.assert(`document.querySelector(${JSON.stringify(editDialog)}) !== null && document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://draft.example.invalid/v1'`, 'Keeping the connection draft retains the dialog and its content');
  // URL inputs do not support selection APIs, so verify selection with the name field.
  await review.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(connectionName)}); e.focus(); e.setSelectionRange(1,4,'backward'); })()`);
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await review.screenshot('04-connection-leave-guard');
  await keepEditing();
  await review.assert(`(() => {const e=document.querySelector(${JSON.stringify(connectionName)}); return document.activeElement===e && e.selectionStart===1 && e.selectionEnd===4 && e.selectionDirection==='backward';})()`, 'Dialog guard restores the original draft input and selection');
  await review.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(connectionName)}); e.focus(); e.setSelectionRange(0,3,'forward'); })()`);
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await discard();
  await noOpenModelDialog();
  await review.assert(`${saveCalls}.length === ${beforeConnectionLeave}`, 'Discarding connection changes does not save');
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(connectionUrl)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://models.example.invalid/v1'`, 'Discarded connection was not persisted');
  await review.fill(connectionUrl, 'https://saved-and-continue.example.invalid/v1');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await review.assert('document.querySelector("[data-action=save-model-draft-and-leave]").disabled === false', 'A connection draft can be saved when leaving the provider settings dialog');
  await review.click('[data-action="save-model-draft-and-leave"]');
  await noOpenModelDialog();
  await review.waitFor('window.__modelReview.providers.find(p=>p.provider==="review-gateway").baseUrl === "https://saved-and-continue.example.invalid/v1"');

  // Credential content is also unsaved data and must protect closing the provider settings dialog.
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(credentialInput)}))`);
  await review.fill(credentialInput, 'fixture-secret-not-a-real-key');
  await review.evaluate('window.__modelReview.failures.setProviderApiKey = "模拟凭据保存失败"');
  await review.click(`${editDialog} .pd-model-settings-credentials button[type="submit"]`);
  await review.waitFor(`document.querySelector(${JSON.stringify(`${editDialog} .pd-model-settings-credentials`)}).textContent.includes("模拟凭据保存失败")`);
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === 'fixture-secret-not-a-real-key'`, 'Failed credential save retains the secret draft');
  await review.evaluate('delete window.__modelReview.failures.setProviderApiKey');
  const beforeSecret = await review.evaluate('window.__modelReview.calls.filter(call=>call.name==="setProviderApiKey").length');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await keepEditing();
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === 'fixture-secret-not-a-real-key'`, 'Keeping secret draft retains it in memory');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await discard();
  await noOpenModelDialog();
  await review.assert(`window.__modelReview.calls.filter(call=>call.name==="setProviderApiKey").length === ${beforeSecret}`, 'Closing after discard never writes the secret');
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(credentialInput)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(credentialInput)}).value === ''`, 'Reopening does not resurrect discarded secret');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();

  // Running agent still permits new providers while protecting session settings.
  await review.click('[data-provider="openai"]');
  await review.assert('document.querySelector("[data-model-id=gpt-review] [data-action=toggle-model]").disabled === true', 'The current model cannot be disabled');
  await review.click(gateway);
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "review-gateway"');
  await review.evaluate('window.__modelReview.snapshot.status = "busy"; window.__modelReview.emitAgent({type:"status",status:"busy"})');
  await review.settle();
  await review.assert('document.querySelector("[data-action=edit-provider]").disabled === true', 'Busy state blocks provider settings editing');
  await review.assert('[...document.querySelectorAll("[data-action=add-model],[data-action=edit-model],[data-action=toggle-model],[data-action=discover-models],[data-action=use-model],[data-action=remove-provider],[data-action=edit-provider]")].every(element=>element.disabled)', 'Busy state protects existing models, connections, and provider removal');
  await review.assert('document.querySelector("[data-action=add-provider]").disabled === false', 'Busy state permits adding a new provider');
  await review.screenshot('05-busy-gated-controls');
  await review.click('[data-action="add-provider"]');
  await review.click('dialog[open] [data-template="custom"]');
  const createDialog = 'dialog[open][data-model-dialog="create"]';
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(createDialog)}))`);
  await review.fill(`${createDialog} [data-field="provider.id"]`, 'created-during-chat');
  await review.fill(`${createDialog} [data-field="provider.name"]`, '聊天期间新增供应商');
  await review.fill(`${createDialog} [data-field="provider.baseUrl"]`, 'https://during-chat.example.invalid/v1');
  await review.fill(`${createDialog} [data-field="provider.apiKey"]`, 'fixture-running-provider-key');
  await review.evaluate('window.__modelReview.discovery = {models:[{id:"busy-import",name:"运行中导入模型",contextWindow:128000,maxTokens:8192,input:["text"],reasoning:false}],warnings:[]}');
  await review.click(`${createDialog} [data-action="fetch-models"]`);
  await review.waitFor('Boolean(document.querySelector("dialog[open] [data-import-model=busy-import]"))');
  await review.screenshot('06-create-provider-during-chat');
  await review.click(`${createDialog} [data-action="save-provider"]`);
  await noOpenModelDialog();
  await review.waitFor('Boolean(document.querySelector("[data-provider=created-during-chat]"))');
  await review.assert('window.__modelReview.providers.find(provider=>provider.provider==="created-during-chat")?.configured === true', 'A provider and its credential can be saved while the conversation is busy');
  await review.assert('window.__modelReview.providers.find(provider=>provider.provider==="created-during-chat")?.models[0].id === "busy-import"', 'Discovery in a new provider form remains available during a conversation');
  await review.assert('window.__modelReview.snapshot.status === "busy" && window.__modelReview.snapshot.modelProvider === "openai" && window.__modelReview.snapshot.model === "gpt-review" && window.__modelReview.snapshot.thinkingLevel === "medium"', 'Adding a provider does not interrupt the task or switch its model or thinking level');
  await review.assert('document.querySelector("[data-action=use-model]").disabled === true && document.querySelector("[data-action=remove-provider]").disabled === true', 'Newly created providers cannot switch the running model or bypass removal protection');
  await review.screenshot('07-created-provider-chat-running');
  await review.click('[data-action="add-provider"]');
  await review.click('dialog[open] [data-template="custom"]');
  await review.fill(`${createDialog} [data-field="provider.id"]`, 'saved-draft-during-chat');
  await review.fill(`${createDialog} [data-field="provider.baseUrl"]`, 'https://draft-during-chat.example.invalid/v1');
  await review.click(`${createDialog} [data-action="fetch-models"]`);
  await review.waitFor('Boolean(document.querySelector("dialog[open] [data-import-model=busy-import]"))');
  await review.click(`${createDialog} .pd-model-dialog-header button`);
  await waitForGuard();
  await review.assert('document.querySelector("[data-action=save-model-draft-and-leave]").disabled === false', 'A new provider draft can be saved when leaving its editor during a task');
  await review.click('[data-action="save-model-draft-and-leave"]');
  await noOpenModelDialog();
  await review.waitFor('window.__modelReview.providers.some(provider=>provider.provider==="saved-draft-during-chat")');
  await review.waitFor('Boolean(document.querySelector(\'[data-provider-group=unconfigured] [data-provider=saved-draft-during-chat]\'))');
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "saved-draft-during-chat"');
  await review.assert('!window.__modelReview.providers.find(provider=>provider.provider==="saved-draft-during-chat").configured && document.querySelector("[data-provider=saved-draft-during-chat]").closest("[data-provider-group]").dataset.providerGroup === "unconfigured"', 'A provider created without a key appears immediately in the unconfigured group and gets selected');
  await review.assert('window.__modelReview.snapshot.status === "busy"', 'Saving a provider draft while leaving its editor keeps the task running');
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.assert(`Boolean(document.querySelector(${JSON.stringify(`${templatesDialog} [data-add-provider="saved-draft-during-chat"]`)}))`, 'A saved provider without credentials remains available through Add provider');
  await review.click(`${templatesDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();
  await review.click('[data-provider="created-during-chat"]');
  await review.evaluate('window.__modelReview.snapshot.status = "idle"; window.__modelReview.emitAgent({type:"status",status:"idle"})');
  await review.settle();
  await review.assert('document.querySelector("[data-action=add-model]").disabled === false', 'Controls recover after agent becomes idle');

  // Unconfigured custom providers retain connection maintenance and removal in Add provider.
  const setupConnection = `${credentialsDialog} [data-provider-editor="edit"]`;
  const setupUrl = `${setupConnection} [data-field="provider.baseUrl"]`;
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.click(`${templatesDialog} [data-add-provider="saved-draft-during-chat"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(setupConnection)}))`);
  await review.fill(setupUrl, 'https://maintained-draft.example.invalid/v1');
  await review.click(`${setupConnection} [data-action="save-connection"]`);
  await review.waitFor('window.__modelReview.providers.find(provider=>provider.provider==="saved-draft-during-chat")?.baseUrl === "https://maintained-draft.example.invalid/v1"');
  await review.assert(`Boolean(document.querySelector(${JSON.stringify(setupConnection)})) && document.querySelector('[data-provider=saved-draft-during-chat]')?.closest('[data-provider-group]')?.dataset.providerGroup === 'unconfigured'`, 'Saving an unconfigured custom connection keeps its Add provider editor open and its sidebar entry in the unconfigured group');
  const beforeSetupDiscard = await review.evaluate(`${saveCalls}.length`);
  await review.fill(setupUrl, 'https://discarded-setup.example.invalid/v1');
  await review.click(`${credentialsDialog} [data-action="back-to-providers"]`);
  await waitForGuard();
  await discard();
  await waitForTemplates();
  await review.assert(`${saveCalls}.length === ${beforeSetupDiscard}`, 'Discarding an unconfigured custom connection on return makes no write');
  await review.click(`${templatesDialog} [data-add-provider="saved-draft-during-chat"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(setupConnection)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(setupUrl)}).value === 'https://maintained-draft.example.invalid/v1'`, 'Reopening an unconfigured custom provider restores its saved connection');
  await review.click(`${credentialsDialog} [data-action="remove-provider"]`);
  await review.waitFor('Boolean(document.querySelector("dialog[open] [data-action=confirm-remove]"))');
  await review.click('dialog[open] [data-action="confirm-remove"]');
  await review.waitFor('!window.__modelReview.providers.some(provider=>provider.provider==="saved-draft-during-chat")');
  await noOpenModelDialog();
  await review.click(gateway);
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "review-gateway"');
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(connectionUrl)}))`);

  // Removing credentials can hide the selected provider, so it must protect connection drafts.
  const beforeGuardedRemoval = await review.evaluate('window.__modelReview.calls.filter(call=>call.name==="removeProviderCredential").length');
  await review.fill(connectionUrl, 'https://credential-removal-draft.example.invalid/v1');
  await review.click(`${editDialog} .pd-settings-remove`);
  await waitForGuard();
  await review.assert(`window.__modelReview.calls.filter(call=>call.name==="removeProviderCredential").length === ${beforeGuardedRemoval}`, 'Credential removal waits for the connection draft guard');
  await keepEditing();
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://credential-removal-draft.example.invalid/v1'`, 'Keeping the connection draft after credential removal preserves its URL');
  await review.assert(`window.__modelReview.calls.filter(call=>call.name==="removeProviderCredential").length === ${beforeGuardedRemoval}`, 'Keeping the connection draft cancels credential removal');
  await review.click('[data-action="cancel-connection"]');
  await review.assert(`document.querySelector(${JSON.stringify(connectionUrl)}).value === 'https://saved-and-continue.example.invalid/v1' && window.__modelReview.providers.find(provider=>provider.provider==='review-gateway').configured`, 'Cancelling the connection draft retains the original connection and credential');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();

  // An entirely unconfigured catalog keeps custom providers listed while exposing every provider through Add provider.
  const configuredProviderIds = await review.evaluate('window.__modelReview.providers.filter(provider=>provider.configured).map(provider=>provider.provider)');
  for (const provider of configuredProviderIds || []) {
    const custom = await review.evaluate(`Boolean(window.__modelReview.providers.find(item=>item.provider===${JSON.stringify(provider)})?.custom)`);
    await review.click(`[data-provider="${provider}"]`);
    await review.click('[data-action="edit-provider"]');
    await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(`dialog[open] input#pd-api-key-${provider}`)}))`);
    await review.click('dialog[open] .pd-settings-remove');
    if (custom) await review.waitFor(`document.querySelector(${JSON.stringify(`[data-provider="${provider}"]`)})?.closest('[data-provider-group]')?.dataset.providerGroup === 'unconfigured'`);
    else await review.waitFor(`document.querySelector(${JSON.stringify(`[data-provider="${provider}"]`)}) === null`);
    await review.click('dialog[open] .pd-model-dialog-header button');
    await noOpenModelDialog();
  }
  const unconfiguredCustomCount = await review.evaluate('window.__modelReview.providers.filter(provider=>provider.custom).length');
  await review.assert(`document.querySelectorAll("[data-provider]").length === ${unconfiguredCustomCount} && [...document.querySelectorAll("[data-provider]")].every(element => element.closest('[data-provider-group=unconfigured]'))`, 'Removing every credential keeps custom providers visible in the unconfigured group');
  await review.assert('document.querySelector("[data-provider-group=configured]") === null && document.querySelector(".pd-model-provider-list .pd-model-settings-notice") === null', 'No configured group or empty-state notice renders while unconfigured custom providers are listed');
  await review.assert('document.querySelector("[data-action=add-provider]").disabled === false', 'Add provider remains enabled with no configured providers');
  await review.screenshot('08-unconfigured-custom-providers');
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.assert(`Boolean(document.querySelector(${JSON.stringify(`${templatesDialog} [data-template="custom"]`)})) && Boolean(document.querySelector(${JSON.stringify(`${templatesDialog} .pd-model-template-grid [data-template]`)}))`, 'The empty configured list still offers custom creation and provider templates');
  await review.assert(`(() => {const listed=new Set([...document.querySelectorAll(${JSON.stringify(`${templatesDialog} [data-add-provider]`)})].map(element=>element.dataset.addProvider)); return listed.size===window.__modelReview.providers.length && window.__modelReview.providers.every(provider=>listed.has(provider.provider));})()`, 'Add provider exposes all unconfigured built-in and custom providers');
  await review.screenshot('09-all-unconfigured-providers');
  await review.click(`${templatesDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();

  // Unconfigured custom providers can be selected in the sidebar and deleted from the detail pane.
  await review.click('[data-provider="created-during-chat"]');
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "created-during-chat"');
  await review.assert('document.querySelector(".pd-model-provider-detail").textContent.includes("无可用凭据")', 'The detail pane explains the missing credential');
  await review.assert('Boolean(document.querySelector("[data-action=remove-provider]")) && document.querySelector("[data-action=remove-provider]").disabled === false', 'An unconfigured custom provider offers an enabled delete action');
  await review.click('[data-action="remove-provider"]');
  await review.waitFor('Boolean(document.querySelector("dialog[open] [data-action=confirm-remove]"))');
  await review.screenshot('08-unconfigured-provider-delete');
  await review.click('dialog[open] [data-action="confirm-remove"]');
  await review.waitFor('!window.__modelReview.providers.some(provider=>provider.provider==="created-during-chat")');
  await review.waitFor('document.querySelector("[data-provider=created-during-chat]") === null');
  await noOpenModelDialog();
  await review.assert(`document.querySelectorAll("[data-provider]").length === ${unconfiguredCustomCount - 1}`, 'Deleting an unconfigured custom provider removes it from the sidebar list');

  // Builtin providers join the configured list with a key and can import their
  // live model list, pinning a custom catalog entry for the provider.
  // Earlier steps swap the discovery fixture; restore the standard catalog first.
  await review.evaluate(`window.__modelReview.discovery = ${JSON.stringify({ models: [{ id: 'discovered-model', name: '新发现模型', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false }, { id: 'metadata-missing', name: '需要核对能力的模型' }], warnings: ['模拟目录：不连接真实供应商'] })}`);
  await review.click('[data-action="add-provider"]');
  await waitForTemplates();
  await review.click(`${templatesDialog} [data-add-provider="openai"]`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(credentialsDialog)}))`);
  await review.fill(`${credentialsDialog} input#pd-api-key-openai`, 'fixture-openai-key');
  await review.click(`${credentialsDialog} button[type="submit"]`);
  await noOpenModelDialog();
  await review.waitFor('Boolean(document.querySelector("[data-provider=openai]"))');
  await review.click('[data-provider="openai"]');
  await review.waitFor('Boolean(document.querySelector(".pd-model-catalog [data-action=discover-models]"))');
  await review.click('[data-action="discover-models"]');
  await review.waitFor('Boolean(document.querySelector("dialog[open][data-model-dialog=discover] [data-import-model=discovered-model]"))');
  await review.assert(`Boolean(document.querySelector('dialog[open][data-model-dialog=discover] [data-field="provider.useSystemProxy"]'))`, 'Builtin discovery offers the system proxy option');
  const beforeBuiltinImport = await review.evaluate(`${saveCalls}.length`);
  await review.click('dialog[open][data-model-dialog=discover] button[type="submit"]');
  await review.waitFor(`${saveCalls}.length === ${beforeBuiltinImport} + 1`);
  await review.waitFor('document.querySelector("dialog[open].pd-model-dialog") === null');
  await review.assert('window.__modelReview.providers.find(provider=>provider.provider==="openai").models.some(model=>model.id==="discovered-model")', 'Importing a builtin catalog pins the discovered model');
  await review.assert(`(() => { const args = ${saveCalls}.at(-1).args[0]; return ${saveCalls}.at(-1).name === 'saveProviderModels' && args.provider === 'openai' && args.upsert.map(m => m.id).join() === 'discovered-model'; })()`, 'Builtin import writes only the new models, never the builtin catalog');
  await review.screenshot('10-builtin-import');

  // A hand-written provider keeps its connection read-only but its models.json models editable.
  await review.evaluate(`window.__modelReview.providers.push(${JSON.stringify({
    provider: 'hand-written', name: '手写配置', custom: true, editable: false, modelsEditable: true, readOnlyReason: 'unsupported-api', configModelIds: ['hand-one'],
    configured: true, baseUrl: 'https://hand.example.invalid', api: 'mistral-conversations', headerNames: [], disabledModels: [],
    models: [{ provider: 'hand-written', id: 'hand-one', name: '手写模型', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096 }, { provider: 'hand-written', id: 'hand-override', name: '覆盖模型', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096 }],
  })})`);
  await review.click('[data-action="refresh-providers"]');
  await review.waitFor('Boolean(document.querySelector("[data-provider=hand-written]"))');
  await review.click('[data-provider="hand-written"]');
  await review.waitFor('document.querySelector(".pd-model-provider-option.is-selected")?.dataset.provider === "hand-written"');
  await review.assert('Boolean(document.querySelector(".pd-model-catalog [data-action=add-model]")) && document.querySelector(".pd-model-catalog [data-action=discover-models]") === null', 'Read-only connections still allow adding models; unsupported protocols cannot discover');
  await review.assert('document.querySelector("[data-model-id=hand-one] [data-action=edit-model]") !== null && document.querySelector("[data-model-id=hand-override] [data-action=edit-model]") === null', 'Only models.json entries offer edit and remove');
  await review.assert('document.querySelector(".pd-model-provider-detail-head [data-action=remove-provider]") === null', 'A read-only connection cannot remove the provider');
  await review.click('[data-action="edit-provider"]');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(editDialog)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(editDialog)}).textContent.includes('协议不在编辑器支持的范围内') && document.querySelector(${JSON.stringify(`${editDialog} [data-provider-editor]`)}) === null`, 'The edit dialog explains why the connection is read-only');
  await review.click(`${editDialog} .pd-model-dialog-header button`);
  await noOpenModelDialog();
  await review.click('[data-model-id="hand-one"] [data-action="edit-model"]');
  await review.waitFor('Boolean(document.querySelector("dialog[open][data-model-dialog=model] [data-model-editor=hand-one]"))');
  await review.fill('dialog[open][data-model-dialog=model] [data-field="model.name"]', '手写模型（已改名）');
  await review.click('dialog[open][data-model-dialog=model] button[type="submit"]');
  await noOpenModelDialog();
  await review.assert(`(() => { const call = ${saveCalls}.at(-1); return call.name === 'saveProviderModels' && call.args[0].provider === 'hand-written' && call.args[0].upsert.length === 1 && call.args[0].upsert[0].name === '手写模型（已改名）' && !('baseUrl' in call.args[0]); })()`, 'Editing a model sends only that model, never the connection');
  await review.waitFor('document.querySelector("[data-model-id=hand-one]").textContent.includes("手写模型（已改名）")');
}
