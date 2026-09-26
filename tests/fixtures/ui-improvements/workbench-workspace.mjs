// Root runs this isolated renderer scenario; all Git operations are deferred mocks.
export default async function workbenchWorkspaceScenario(review) {
  await review.reducedMotion(true);
  await review.waitFor('window.__modelReview?.ready===true');
  await review.viewport(1440,1000);
  await review.evaluate(`(() => {
    const fixture=window.__modelReview;
    const state={pending:{},mutations:[],diffs:[],statuses:[]};
    const mock=(name,fn)=>{window.piDesktop[name]=async(...args)=>{fixture.calls.push({name,args:structuredClone(args)});return fn(...args);};};
    state.switchWorkspace=name=>{
      const cwd='C:/renderer-review/'+name;
      Object.assign(fixture.snapshot,{cwd,sessionPath:cwd+'/session.jsonl',sessionId:name,status:'idle',error:null,messages:[],activities:[]});
      fixture.emitAgent({type:'reset',cwd}); fixture.emitAgent({type:'ready',...structuredClone(fixture.snapshot)}); fixture.emitAgent({type:'status',status:'idle'});
    };
    mock('listWorkspaceEntries',()=>[]);
    mock('getWorkspaceGitStatus',()=>{const cwd=fixture.snapshot.cwd;state.statuses.push(cwd);return {isRepository:true,branch:cwd.split('/').at(-1),entries:[{path:'shared.ts',status:' M'}],truncated:false};});
    mock('getWorkspaceGitLog',()=>[]);
    mock('getWorkspaceGitDiff',(path,source)=>{const cwd=fixture.snapshot.cwd;state.diffs.push({cwd,path,source});return '--- a/'+path+'\\n+++ b/'+path+'\\n@@ -1 +1 @@\\n-old\\n+'+cwd+'\\n';});
    for(const name of ['setWorkspaceGitStaged','discardWorkspaceGitChanges','createWorkspaceGitBranch']) mock(name,(...args)=>{
      state.mutations.push({name,cwd:fixture.snapshot.cwd,args});
      return new Promise((resolve,reject)=>{state.pending[name]={resolve,reject};});
    });
    state.baseline=()=>({diffs:state.diffs.length,statuses:state.statuses.length});
    window.__workbenchWorkspace=state;
    state.switchWorkspace('project-a');
  })()`);
  await review.click('.pd-workbench-toggle');
  await review.click('[data-segment-key=git]');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-a")');

  await review.click('.pd-workbench-discard');
  await review.waitFor('Boolean(document.querySelector(".pd-workbench-discard-confirm"))');
  await review.click('.pd-workbench-branch button');
  await review.fill('.pd-workbench-branch-form input','a-draft');
  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-b")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-b")');
  await review.assert('!document.querySelector(".pd-workbench-discard-confirm") && !document.querySelector(".pd-workbench-branch-form") && window.__workbenchWorkspace.mutations.length===0','Switching projects removes A discard confirmation and branch draft without discarding B');

  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-a")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-a")');
  await review.click('[data-git-path="shared.ts"]');
  await review.click('[data-git-action=stage]');
  await review.waitFor('Boolean(window.__workbenchWorkspace.pending.setWorkspaceGitStaged)');
  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-b")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-b")');
  await review.click('[data-git-path="shared.ts"]');
  await review.waitFor('document.querySelector(".pd-workbench-reader")?.textContent.includes("project-b")');
  await review.evaluate('window.__workbenchWorkspace.before=window.__workbenchWorkspace.baseline();window.__workbenchWorkspace.pending.setWorkspaceGitStaged.resolve()');
  await review.settle();
  await review.assert('JSON.stringify(window.__workbenchWorkspace.baseline())===JSON.stringify(window.__workbenchWorkspace.before) && document.querySelector(".pd-workbench-reader").textContent.includes("project-b") && !document.querySelector("[data-git-action=stage]").disabled','A staging completion cannot refresh B or reopen an old Diff');

  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-a")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-a")');
  await review.click('.pd-workbench-discard');
  await review.click('.pd-workbench-discard-confirm-button');
  await review.waitFor('Boolean(window.__workbenchWorkspace.pending.discardWorkspaceGitChanges)');
  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-b")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-b")');
  await review.click('.pd-workbench-discard');
  await review.evaluate('window.__workbenchWorkspace.pending.discardWorkspaceGitChanges.reject(new Error("A stale discard failure"))');
  await review.settle();
  await review.assert('Boolean(document.querySelector(".pd-workbench-discard-confirm")) && !document.querySelector(".pd-workbench-discard-confirm-button").disabled && !document.querySelector(".pd-workbench").textContent.includes("A stale discard failure")','A discard failure cannot replace B confirmation or disable its retry');
  await review.click('.pd-workbench-discard-actions button:last-child');

  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-a")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-a")');
  await review.click('.pd-workbench-branch button');
  await review.fill('.pd-workbench-branch-form input','old-a-branch');
  await review.click('.pd-workbench-branch-form button');
  await review.waitFor('Boolean(window.__workbenchWorkspace.pending.createWorkspaceGitBranch)');
  await review.evaluate('window.__workbenchWorkspace.switchWorkspace("project-b")');
  await review.waitFor('document.querySelector(".pd-workbench-branch")?.textContent.includes("project-b")');
  await review.click('.pd-workbench-branch button');
  await review.fill('.pd-workbench-branch-form input','new-b-draft');
  await review.evaluate('window.__workbenchWorkspace.before=window.__workbenchWorkspace.baseline();window.__workbenchWorkspace.pending.createWorkspaceGitBranch.resolve()');
  await review.settle();
  await review.assert('document.querySelector(".pd-workbench-branch-form input")?.value==="new-b-draft" && JSON.stringify(window.__workbenchWorkspace.baseline())===JSON.stringify(window.__workbenchWorkspace.before)','A branch creation completion cannot close B editor, erase its draft or refresh its status');
  await review.assert('window.__workbenchWorkspace.mutations.length===3 && window.__workbenchWorkspace.mutations.every(call=>call.cwd.endsWith("/project-a"))','Every submitted Git mutation remains bound to its original project');
  await review.record('workspace-mutation-calls','window.__workbenchWorkspace.mutations');
  await review.screenshot('workbench-workspace-isolation');
}

if(process.argv.includes('--check')) {
  let count=0;
  const compile=expression=>{new Function(expression);count++;};
  await workbenchWorkspaceScenario({evaluate:async x=>compile(x),waitFor:async x=>compile(x),assert:async x=>compile(x),record:async(_n,x)=>compile(x),click:async()=>{},settle:async()=>{},screenshot:async()=>{},viewport:async()=>{},fill:async()=>{},reducedMotion:async()=>{}});
  console.log(`Prepared ${count} workspace-isolation expressions; no browser launched.`);
}
