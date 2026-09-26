// Prepared without launching UI. The root runs this in its isolated renderer.
export default async function workbenchFeatures(review) {
  await review.reducedMotion(true);
  await review.waitFor('window.__modelReview?.ready===true');
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const fixture=window.__modelReview, cwd=fixture.snapshot.cwd;
    const state={scopes:[],generated:[],commits:[],pushes:0,prs:0,acks:[],terminal:null};
    const mock=(name,fn)=>{window.piDesktop[name]=async(...args)=>{fixture.calls.push({name,args:structuredClone(args)});return fn(...args);};};
    mock('listWorkspaceEntries',()=>[]);
    mock('getWorkspaceGitStatus',()=>({isRepository:true,branch:'codex/review',entries:[{path:'partial.ts',status:'MM'}],truncated:false}));
    mock('getWorkspaceGitLog',()=>[]);
    mock('getWorkspaceCommitPreview',request=>{state.scopes.push(request.scope);return {id:'preview-'+request.scope,cwd,scope:request.scope,branch:'codex/review',head:'a'.repeat(40),files:[{path:request.scope==='stagedOnly'?'partial-index.ts':'full-worktree.ts',status:'M'}],context:request.scope==='stagedOnly'?'INDEX_CONTENT_ONLY':'ALL_CONTENT',createdAt:new Date().toISOString(),truncated:false};});
    mock('generateCommitMessage',context=>{state.generated.push(context);return 'Commit approved index';});
    mock('commitWorkspacePreview',request=>{state.commits.push(request);return 'abcdef123456';});
    mock('getFileCheckpoint',()=>({id:'checkpoint',version:'v1',cwd,sessionId:fixture.snapshot.sessionId,completedAt:new Date().toISOString(),restored:false,files:[{path:'manual.txt',kind:'modified',status:'conflict',reason:'回合后文件已改变，不能覆盖当前内容'},{path:'image.png',kind:'modified',status:'uncovered',reason:'二进制文件未覆盖'}]}));
    mock('rewindFileCheckpoint',()=>{throw new Error('Conflicting checkpoint must never submit');});
    mock('listTaskWorktrees',()=>[{id:'tree-1',project:cwd,cwd:'C:/fixture/worktrees/task-one',branch:'codex/task-one',ref:'HEAD',commit:'b'.repeat(40),createdAt:new Date().toISOString(),sessionPath:'C:/fixture/task-one.jsonl'}]);
    mock('getGitDeliveryPreview',()=>({id:'delivery-1',cwd,branch:'codex/review',head:'c'.repeat(40),upstream:null,ghAvailable:true,remotes:[{name:'origin',url:'https://github.com/example/review.git',github:true}]}));
    mock('pushWorkspaceBranch',()=>{if(++state.pushes===1)throw new Error('Mock non-fast-forward; fetch and inspect');return {branch:'codex/review',head:'c'.repeat(40),remote:'origin'};});
    mock('createWorkspaceDraftPr',()=>{state.prs++;return {branch:'codex/review',head:'c'.repeat(40),remote:'origin',url:'https://github.com/example/review/pull/17',existing:true};});
    mock('getWorkspaceTerminal',()=>state.terminal);
    window.piDesktop.onWorkspaceTerminalEvent=()=>()=>{};
    mock('openWorkspaceTerminal',()=>state.terminal={id:'terminal-1',cwd,shell:'mock interactive shell',running:true,output:'PTY 中文输出\\r\\n$ ',sequence:1,truncated:false});
    mock('acknowledgeWorkspaceTerminal',request=>state.acks.push(request));
    mock('resizeWorkspaceTerminal',()=>{});mock('writeWorkspaceTerminal',()=>{});
    mock('closeWorkspaceTerminal',()=>{state.terminal=null;});
    window.__workbenchFeatures=state;
  })()`);
  await review.click('.pd-chat-header-more');
  await review.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(button=>/提交|Commit/.test(button.textContent)).click()`);
  await review.waitFor('Boolean(document.querySelector(".pd-commit-files"))');
  await review.evaluate(`(() => {const select=document.querySelector('.pd-commit-label select');select.value='stagedOnly';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await review.waitFor('document.querySelector(".pd-commit-files")?.textContent.includes("partial-index.ts")');
  await review.click('.pd-commit-actions .pd-commit-secondary:nth-child(2)');
  await review.waitFor('document.querySelector("#pd-commit-message")?.value==="Commit approved index"');
  await review.assert('window.__workbenchFeatures.generated[0]==="INDEX_CONTENT_ONLY"','Generated message uses staged-only content');
  await review.screenshot('commit-staged-only-preview');
  await review.click('.pd-commit-primary');
  await review.waitFor('window.__workbenchFeatures.commits.length===1');
  await review.assert('window.__workbenchFeatures.commits[0].id==="preview-stagedOnly"','Commit consumes the exact preview identity');
  await review.waitFor('!document.querySelector(".pd-commit-dialog")');

  await review.click('.pd-workbench-toggle');
  await review.click('[data-segment-key=git]');
  await review.click('[data-feature=checkpoint]');
  await review.waitFor('document.querySelector(".pd-feature-dialog")?.textContent.includes("manual.txt")');
  await review.assert('[...document.querySelectorAll(".pd-feature-dialog button")].find(button=>button.textContent.includes("确认撤销")).disabled','External edits block destructive checkpoint rewind');
  await review.assert('document.querySelector(".pd-feature-dialog").getBoundingClientRect().left>300 && document.querySelector(".pd-feature-dialog").getBoundingClientRect().top>100','Native feature dialog is centered despite global margin reset');
  await review.screenshot('checkpoint-conflict-preview');
  await review.key('Escape');
  await review.assert('document.activeElement?.getAttribute("data-feature")==="checkpoint"','Native modal restores checkpoint trigger focus');
  await review.click('[data-feature=worktree]');
  await review.waitFor('document.querySelector(".pd-feature-worktree")?.textContent.includes("codex/task-one")');
  await review.screenshot('managed-worktree-list');
  await review.key('Escape');
  await review.click('[data-feature=delivery]');
  await review.waitFor('Boolean(document.querySelector(".pd-feature-dialog select"))');
  await review.evaluate(`[...document.querySelectorAll('.pd-feature-dialog button')].find(button=>button.textContent.includes('普通推送')).click()`);
  await review.waitFor('document.querySelector(".pd-feature-dialog [role=alert]")?.textContent.includes("non-fast-forward")');
  await review.assert('!document.querySelector(".pd-feature-dialog").textContent.includes("已将")','Failed push never shows success');
  await review.evaluate(`[...document.querySelectorAll('.pd-feature-dialog button')].find(button=>button.textContent.includes('普通推送')).click()`);
  await review.waitFor('document.querySelector(".pd-feature-dialog")?.textContent.includes("已将")');
  await review.fill('.pd-feature-dialog form label:nth-child(2) input','Review approved changes');
  await review.click('.pd-feature-dialog form button[type=submit]');
  await review.waitFor('document.querySelector(".pd-feature-dialog a")?.href==="https://github.com/example/review/pull/17"');
  await review.assert('window.__workbenchFeatures.pushes===2 && window.__workbenchFeatures.prs===1','Push and draft PR remain separate explicit mock actions');
  await review.screenshot('delivery-existing-pr');
  await review.viewport(760,900);
  await review.screenshot('delivery-compact');
  await review.viewport(1440,1000);
  await review.key('Escape');
  await review.click('[data-segment-key=terminal]');
  await review.click('.pd-terminal-pane .pd-feature-toolbar button:first-of-type');
  await review.waitFor('document.querySelector(".pd-terminal-pane")?.textContent.includes("mock interactive shell") && window.__workbenchFeatures.acks.length>0');
  await review.click('[data-segment-key=git]');
  await review.click('[data-segment-key=terminal]');
  await review.assert('window.__modelReview.calls.filter(call=>call.name==="openWorkspaceTerminal").length===1 && Boolean(document.querySelector(".xterm"))','Tab switch retains terminal without starting another process');
  await review.screenshot('interactive-terminal-retained');
  await review.click('.pd-terminal-pane .pd-feature-toolbar button:first-of-type');
  await review.waitFor('window.__workbenchFeatures.terminal===null');
}

if(process.argv.includes('--check')) {
  let count=0;const compile=expression=>{new Function(expression);count++;};
  await workbenchFeatures({evaluate:async x=>compile(x),waitFor:async x=>compile(x),assert:async x=>compile(x),click:async()=>{},screenshot:async()=>{},viewport:async()=>{},fill:async()=>{},key:async()=>{},reducedMotion:async()=>{}});
  console.log(`Prepared ${count} feature expressions; no browser launched.`);
}
