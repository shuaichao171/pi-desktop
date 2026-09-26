// Explicit check/install separation in the real built SettingsPanel.
// Static preparation: node tests/fixtures/model-settings/update-scenarios.mjs --check
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=update-scenarios.mjs
export default async function updateScenarios(review) {
  const check = '.pd-update-actions [data-action="check-updates"]';
  const install = '.pd-update-actions [data-action="install-update"]';
  const buttonState = (checkDisabled, installDisabled, label) => review.assert(`(() => {
    const check=document.querySelector(${JSON.stringify(check)});
    const install=document.querySelector(${JSON.stringify(install)});
    return Boolean(check && install && check.getClientRects().length && install.getClientRects().length)
      && check.disabled===${checkDisabled} && install.disabled===${installDisabled};
  })()`, label);
  const emit = async (state) => {
    await review.evaluate(`window.__updateReview.setState(${JSON.stringify(state)})`);
    await review.settle();
  };
  const resolveCheck = async (state) => {
    await review.evaluate(`window.__updateReview.resolveCheck(${JSON.stringify(state)})`);
    await review.settle();
  };
  const resolveInstall = async (state) => {
    await review.evaluate(`window.__updateReview.resolveInstall(${JSON.stringify(state)})`);
    await review.settle();
  };

  await review.waitFor('window.__modelReview?.ready === true');
  await review.evaluate(`(() => {
    const fixture=window.__modelReview;
    const clone=value=>structuredClone(value);
    const state={current:{phase:'idle',currentVersion:'0.1.5'},checks:[],installs:[],pendingCheck:null,pendingInstall:null};
    state.setState=next=>{state.current={currentVersion:'0.1.5',...next};fixture.emit('onUpdateStateChanged',state.current);return clone(state.current);};
    state.resolveCheck=next=>{if(!state.pendingCheck)throw new Error('No pending update check');const pending=state.pendingCheck;state.pendingCheck=null;pending.resolve(state.setState(next));};
    state.rejectCheck=message=>{if(!state.pendingCheck)throw new Error('No pending update check');const pending=state.pendingCheck;state.pendingCheck=null;state.setState({phase:'error',error:message});pending.reject(new Error(message));};
    state.resolveInstall=next=>{if(!state.pendingInstall)throw new Error('No pending installation');const pending=state.pendingInstall;state.pendingInstall=null;state.setState(next);pending.resolve();};
    window.piDesktop.getUpdateState=async()=>{fixture.calls.push({name:'getUpdateState',args:[]});return clone(state.current);};
    window.piDesktop.checkForUpdates=async(...args)=>{
      fixture.calls.push({name:'checkForUpdates',args:clone(args)});state.checks.push(clone(args));
      if(state.pendingCheck)throw new Error('Duplicate update check');
      state.setState({phase:'checking',...(state.current.availableVersion?{availableVersion:state.current.availableVersion}:{})});
      return new Promise((resolve,reject)=>{state.pendingCheck={resolve,reject};});
    };
    window.piDesktop.installUpdate=async(...args)=>{
      fixture.calls.push({name:'installUpdate',args:clone(args)});state.installs.push(clone(args));
      if(state.pendingInstall)throw new Error('Duplicate installation');
      const ready=state.current.phase==='ready';
      state.setState({phase:ready?'installing':'downloading',availableVersion:state.current.availableVersion,installRequested:true,...(!ready?{progressPercent:12}:{})});
      return new Promise((resolve,reject)=>{state.pendingInstall={resolve,reject};});
    };
    window.__updateReview=state;
    state.setState(state.current);
  })()`);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '更新');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(check)}))`);
  await buttonState(false, true, 'Idle shows both buttons; only check is enabled');
  await review.assert(`document.querySelector(${JSON.stringify(check)}).textContent.trim()==='检查更新'`, 'Check button describes a query without installation');
  await review.assert(`document.querySelector(${JSON.stringify(install)}).textContent.trim()==='安装更新'`, 'Install is a separate visible action');
  await review.assert('window.__updateReview.checks.length===0 && window.__updateReview.installs.length===0', 'Opening update settings triggers no check or installation');
  await review.screenshot('updates-01-idle');

  await review.click(check);
  await review.waitFor('Boolean(window.__updateReview.pendingCheck)');
  await buttonState(true, true, 'Checking disables both actions');
  await review.assert('window.__updateReview.checks.length===1 && window.__updateReview.checks[0].length===1 && window.__updateReview.checks[0][0]===false', 'Check explicitly calls checkForUpdates(false)');
  await review.assert('window.__updateReview.installs.length===0', 'Checking never invokes installUpdate');
  await resolveCheck({ phase: 'available', availableVersion: '0.1.6' });
  await buttonState(false, false, 'Available update enables independent check and install');
  await review.assert('window.__updateReview.installs.length===0', 'Discovering a release does not install it');
  await review.screenshot('updates-02-available');

  await review.click(check);
  await review.waitFor('window.__updateReview.checks.length===2 && Boolean(window.__updateReview.pendingCheck)');
  await buttonState(true, true, 'Rechecking an available release still disables both actions');
  await resolveCheck({ phase: 'available', availableVersion: '0.1.6' });
  await buttonState(false, false, 'Available releases can be checked again');
  await review.assert('window.__updateReview.checks.every(args=>args.length===1&&args[0]===false) && window.__updateReview.installs.length===0', 'Repeated checks remain query-only');

  await review.click(install);
  await review.waitFor('window.__updateReview.installs.length===1 && Boolean(window.__updateReview.pendingInstall)');
  await buttonState(true, true, 'Downloading disables check and installation');
  await review.assert('window.__updateReview.checks.length===2 && window.__updateReview.installs[0].length===0', 'Only the explicit install click invokes installUpdate without checking again');
  await emit({ phase: 'installing', availableVersion: '0.1.6', installRequested: true });
  await buttonState(true, true, 'Installing disables both actions');
  await resolveInstall({ phase: 'ready', availableVersion: '0.1.6' });
  await buttonState(true, false, 'Ready release permits installation without another check');
  await review.assert(`(() => {const button=document.querySelector(${JSON.stringify(install)});return button.getClientRects().length>0&&!button.disabled&&button.textContent.trim()==='安装并重启';})()`, 'Ready release changes the install label to install and restart');
  await review.assert(`document.querySelector(${JSON.stringify(check)}).getClientRects().length>0`, 'Check button stays visible for a ready release');
  await review.click(install);
  await review.waitFor('window.__updateReview.installs.length===2 && Boolean(window.__updateReview.pendingInstall)');
  await buttonState(true, true, 'Explicit ready installation disables both actions');
  await review.assert('window.__updateReview.checks.length===2', 'Install and restart does not call checkForUpdates');
  await resolveInstall({ phase: 'up-to-date', currentVersion: '0.1.6' });
  await buttonState(false, true, 'Latest version keeps install visible and disabled');

  await review.click(check);
  await review.waitFor('Boolean(window.__updateReview.pendingCheck)');
  await review.evaluate('window.__updateReview.rejectCheck("模拟更新查询失败")');
  await review.settle();
  await buttonState(false, true, 'Check failure without a release permits retry but disables install');
  await review.assert('document.querySelector(".pd-update-card").textContent.includes("模拟更新查询失败")', 'Query failure is visible in the update card');
  await review.assert('window.__updateReview.installs.length===2', 'A failed query never adds an installation request');
  await review.click(check);
  await review.waitFor('Boolean(window.__updateReview.pendingCheck)');
  await resolveCheck({ phase: 'up-to-date', currentVersion: '0.1.6' });
  await buttonState(false, true, 'A successful retry returns to latest-version state');
  await emit({ phase: 'error', availableVersion: '0.1.7', error: '模拟下载失败' });
  await buttonState(false, false, 'Error with a known release permits independent check or install retry');
  await emit({ phase: 'downloading', availableVersion: '0.1.7', progressPercent: 50 });
  await buttonState(true, true, 'Downloading from an external update event disables both actions');
  await emit({ phase: 'checking' });
  await buttonState(true, true, 'Checking from an external update event disables both actions');
  await emit({ phase: 'installing', availableVersion: '0.1.7' });
  await buttonState(true, true, 'Installing from an external update event disables both actions');
  await emit({ phase: 'unavailable', unavailableReason: 'portable' });
  await buttonState(true, true, 'Unsupported updates retain both disabled buttons');
  await review.assert('window.__updateReview.checks.length===4 && window.__updateReview.checks.every(args=>args.length===1&&args[0]===false) && window.__updateReview.installs.length===2 && window.__updateReview.installs.every(args=>args.length===0)', 'All four checks are query-only; both installs correspond to separate clicks');
  await review.record('update-action-calls', '({checks:window.__updateReview.checks,installs:window.__updateReview.installs})');
}

if (process.argv[1]?.endsWith('update-scenarios.mjs') && process.argv.includes('--check')) {
  let count=0;
  const compile=expression=>{new Function(expression);count+=1;};
  await updateScenarios({
    evaluate:async expression=>{compile(expression);return 0;},
    waitFor:async expression=>compile(expression),assert:async expression=>compile(expression),
    record:async(_name,expression)=>compile(expression),
    click:async()=>{},clickText:async()=>{},screenshot:async()=>{},settle:async()=>{},
  });
  console.log(`Prepared ${count} update expressions: syntax valid; no browser launched.`);
}
