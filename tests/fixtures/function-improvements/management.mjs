export default async function managementFeatures(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.evaluate(`(() => {
    const state=window.__modelReview, bridge=window.piDesktop;
    const define=(name,fn)=>bridge[name]=async(...args)=>{state.calls.push({name,args:structuredClone(args)});if(state.failures[name])throw Error(state.failures[name]);return fn(...args);};
    define('testProviderModel',request=>({...request,ok:true,elapsedMs:143,error:null}));define('cancelProviderModelTest',()=>{});
    define('listMachineSessions',()=>[
      {path:state.snapshot.cwd+'/sessions/review.jsonl',id:'review',name:'模型审查会话',firstMessage:'模型审查会话',modified:'2026-10-09T08:00:00Z',messageCount:5,cwd:state.snapshot.cwd,registered:true,running:false,bytes:2048},
      {path:state.snapshot.cwd+'/sessions/archived.jsonl',id:'archived',name:'已归档会话',firstMessage:'已归档会话',modified:'2026-10-08T08:00:00Z',messageCount:2,cwd:state.snapshot.cwd,registered:true,running:false,bytes:1024,archived:true},
    ]);
    bridge.updateSessionMeta=async(path,patch)=>{state.calls.push({name:'updateSessionMeta',args:[path,structuredClone(patch)]});};
    bridge.deleteSession=async path=>{state.calls.push({name:'deleteSession',args:[path]});};
  })()`);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button','会话管理');
  await review.waitFor("document.querySelector('.pd-session-management')?.textContent.includes('已归档会话')");
  await review.assert("document.querySelector('.pd-session-management').textContent.includes('共 2 个会话')", 'Session management counts every machine-wide conversation');
  await review.screenshot('02-session-management');
  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$="archived.jsonl"]'); if (!row) throw new Error('archived row missing'); [...row.querySelectorAll('button')].find(item => item.textContent === '取消归档').click(); })()`);
  await review.waitFor('window.__modelReview.calls.some(c=>c.name==="updateSessionMeta"&&c.args[1].archived===false)');
  for (const width of [900,680]) { await review.viewport(width,900); await review.assert('document.documentElement.scrollWidth<=innerWidth','Management layout does not overflow viewport'); await review.screenshot('03-management-'+width); }
}
