// Only the dedicated isolated renderer runner launches this scenario.
export default async function inputScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview, bridge = window.piDesktop;
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#2aa99e'; context.fillRect(0,0,96,64);
    const image = { kind:'image', name:'restored.png', mimeType:'image/png', data:canvas.toDataURL('image/png').split(',')[1] };
    const ref = { id:'stored-image',version:1,kind:'image',name:image.name,mimeType:image.mimeType,size:100 };
    const state = window.__inputReview = { sends:[], saves:[], mutations:[], failSend:true, queue:{version:0,paused:false,items:[]}, image, cwd:fixture.snapshot.cwd };
    const drafts = new Map(['input-main','input-backup'].map(path => [path,{version:1,text:path==='input-main'?'Persisted draft':'Original draft with image',attachments:[ref],missing:[]}]));
    drafts.set('input-missing',{version:1,text:'Keep me',attachments:[{...ref,id:'missing',name:'missing.png'}],missing:['missing']});
    bridge.getInputDraft = async scope => structuredClone(drafts.get(scope.sessionPath) ?? {version:0,text:'',attachments:[],missing:[]});
    bridge.readInputAttachment = async (_scope,id) => { if(id==='missing') throw new Error('Attachment missing'); return structuredClone(image); };
    bridge.putInputAttachment = async () => structuredClone(ref);
    bridge.saveInputDraft = async request => { state.saves.push(structuredClone(request)); const next={version:request.expectedVersion+1,text:request.text,attachments:request.attachmentIds.map(id=>({...ref,id})),missing:[]}; drafts.set(request.sessionPath,next); return next; };
    bridge.submitInput = async request => { state.sends.push(structuredClone(request)); if(state.failSend) throw new Error('Acceptance reply unavailable'); return {id:request.id,state:'accepted'}; };
    bridge.getInputQueue = async () => structuredClone(state.queue);
    state.publishQueue = () => fixture.emitAgent({type:'queue',count:state.queue.items.length,items:state.queue.items});
    bridge.mutateInputQueue = async request => {
      state.mutations.push(structuredClone(request)); if(request.expectedVersion!==state.queue.version) throw new Error('Stale queue');
      if(request.action==='pause'||request.action==='resume') state.queue.paused=request.action==='pause';
      if(request.action==='confirm') state.queue.items.find(item=>item.id===request.id).state='accepted';
      if(request.action==='move') { const moving=state.queue.items.find(item=>item.id===request.id); state.queue.items=state.queue.items.filter(item=>item!==moving); const before=state.queue.items.findIndex(item=>item.id===request.beforeId); state.queue.items.splice(before<0?state.queue.items.length:before,0,moving); }
      state.queue.version++; state.publishQueue(); return structuredClone(state.queue);
    };
    bridge.processPdfInput = request => new Promise((resolve,reject)=>{state.pdf={request,resolve,reject};});
    bridge.cancelPdfInput = async id => { if(state.pdf?.request.requestId===id){state.pdf.reject(new Error('PDF processing cancelled'));state.pdf=null;} };
    state.ready = path => { Object.assign(fixture.snapshot,{sessionId:path,sessionPath:path,messages:[],activities:[],error:null,historyTotal:0,queuedCount:state.queue.items.length,queuedMessages:state.queue.items}); fixture.emitAgent({...fixture.snapshot,type:'ready'}); fixture.emitAgent({type:'status',status:'idle'}); };
    state.uploadPdf = () => {const transfer=new DataTransfer();transfer.items.add(new File(['%PDF-1.4 fixture'],'sample.pdf',{type:'application/pdf'}));const input=document.querySelector('.pd-composer-file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
    state.ready('input-main');
  })()`);
  await review.waitFor('document.querySelector(".pd-composer-shell textarea")?.value === "Persisted draft" && document.querySelectorAll(".pd-composer-attachment").length === 1');
  await review.screenshot('inputs-restored-attachment');
  await review.click('.pd-send-button');
  await review.waitFor('document.querySelector(".pd-composer-error")?.textContent.includes("Acceptance reply unavailable")');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value === "Persisted draft" && document.querySelectorAll(".pd-composer-attachment").length === 1', 'Failed submission preserves draft and attachments');
  await review.evaluate('window.__inputReview.failSend = false');
  await review.click('.pd-send-button');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea").value === ""');
  await review.assert('window.__inputReview.sends.length === 2 && window.__inputReview.sends[0].id === window.__inputReview.sends[1].id', 'Retry keeps the stable request ID');
  await review.evaluate('window.__inputReview.ready("input-backup")');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea").value === "Original draft with image" && document.querySelectorAll(".pd-composer-attachment").length === 1');
  await review.assert('!document.querySelector(".pd-composer-history-button, .pd-input-history") && document.querySelector(".pd-composer-shell textarea").value === "Original draft with image" && document.querySelectorAll(".pd-composer-attachment").length === 1 && window.__inputReview.sends.length === 2', 'The composer restores the independent draft and attachment without an input history entry');
  await review.screenshot('inputs-independent-draft');
  await review.evaluate('window.__inputReview.uploadPdf()');
  await review.waitFor('Boolean(window.__inputReview.pdf)');
  await review.clickText('.pd-composer-attachment-hint button', '取消PDF处理');
  await review.waitFor('!window.__inputReview.pdf && !document.querySelector(".pd-composer-attachment-hint button")');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value === "Original draft with image" && document.querySelectorAll(".pd-composer-attachment").length === 1', 'Cancelling PDF extraction preserves the original draft');
  await review.assert('!document.querySelector(".pd-composer-attachment-job")', 'A cancelled PDF is not left behind as a failed attachment job that blocks sending');
  await review.evaluate(`(() => {const state=window.__inputReview;state.queue.items=[{id:'queue-first',text:'Same text',behavior:'followUp',version:1,state:'accepted',attachments:[{kind:'image',name:'first.png',mimeType:'image/png'}]},{id:'queue-second',text:'Same text',behavior:'followUp',version:1,state:'recovered',message:'Confirm before sending',attachments:[{kind:'image',name:'second.png',mimeType:'image/png'}]}];state.publishQueue();})()`);
  await review.waitFor('document.querySelectorAll(".pd-composer-queue-item").length === 2');
  await review.click('[data-queue-id=queue-first] [aria-label="更多操作"]');
  await review.clickText('.pd-queue-menu button', '暂停后续消息');
  await review.waitFor('window.__inputReview.queue.paused === true');
  await review.clickText('[data-queue-id=queue-second] button', '确认恢复');
  await review.waitFor('document.querySelector("[data-queue-id=queue-second]")?.dataset.state === "accepted" && document.querySelector("[data-queue-id=queue-second]")?.getAttribute("aria-busy") === "false"');
  await review.evaluate('document.querySelector("[data-queue-id=queue-second] .pd-queue-drag").focus()');
  await review.key('ArrowUp');
  await review.waitFor('window.__inputReview.queue.items[0].id === "queue-second"');
  await review.assert('window.__inputReview.queue.items[0].id === "queue-second" && window.__inputReview.queue.items[0].attachments[0].name === "second.png" && window.__inputReview.queue.paused', 'Queue confirmation and sorting retain each image identity while paused');
  await review.screenshot('inputs-queue-paused');
  await review.clickText('.pd-queue-paused button', '继续发送');
  await review.waitFor('window.__inputReview.queue.paused === false');
  await review.assert('window.__inputReview.mutations.map(item=>item.action).join(",") === "pause,confirm,move,resume"', 'Queue actions use versioned backend mutations');
  await review.evaluate('window.__inputReview.ready("input-missing")');
  await review.waitFor('document.querySelector(".pd-composer-error")?.textContent.includes("missing.png")');
  await review.assert('document.querySelector(".pd-send-button").disabled && document.querySelector(".pd-composer-shell textarea").value === "Keep me"', 'Missing persisted attachments block accidental partial submission');
  await review.screenshot('inputs-missing-attachment');
  await review.evaluate(`(() => {const state=window.__inputReview;const original=window.piDesktop.getInputDraft;window.piDesktop.getInputDraft=scope=>scope.sessionPath==='input-late'?new Promise(resolve=>{state.resolveLateDraft=resolve;}):original(scope);state.ready('input-late');})()`);
  await review.waitFor('Boolean(window.__inputReview.resolveLateDraft)');
  await review.fill('.pd-composer-shell textarea', 'User editing while the disk is loading');
  await review.fill('.pd-composer-shell textarea', '');
  await review.evaluate('window.__inputReview.resolveLateDraft({version:1,text:"Old stored text",attachments:[],missing:[]})');
  await review.waitFor('!document.querySelector(".pd-composer-attachment-hint button")');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value === ""', 'Late restoration does not overwrite an intentionally cleared draft');

  await review.evaluate(`(() => {
    const state = window.__inputReview, original = window.piDesktop.getInputDraft;
    state.recoveryReads = {}; state.recoveryPending = {};
    window.piDesktop.getInputDraft = async scope => {
      if (!scope.sessionPath.startsWith('input-recovery-')) return original(scope);
      const count = state.recoveryReads[scope.sessionPath] = (state.recoveryReads[scope.sessionPath] ?? 0) + 1;
      if (count === 1 || scope.sessionPath === 'input-recovery-unread') throw new Error('草稿所属工作区或会话已变化');
      return new Promise(resolve => { state.recoveryPending[scope.sessionPath] = resolve; });
    };
    state.ready('input-recovery-retry');
  })()`);
  const quietRecovery = '!document.querySelector(".pd-composer-error") && !/草稿所属工作区或会话已变化|重试恢复草稿|Retry draft recovery/.test(document.querySelector(".pd-composer-wrap").textContent)';
  await review.waitFor('window.__inputReview.recoveryReads["input-recovery-retry"] === 1');
  // Type only once the switched-to conversation's composer has painted.
  await review.settle();
  await review.fill('.pd-composer-shell textarea', '草稿后台恢复期间继续编辑');
  await review.waitFor('!document.querySelector(".pd-send-button").disabled');
  await review.assert(quietRecovery, 'A failed draft read shows no scope warning or manual recovery button and keeps current input usable');
  await review.waitFor('Boolean(window.__inputReview.recoveryPending["input-recovery-retry"])');
  await review.fill('.pd-composer-shell textarea', '');
  await review.evaluate('window.__inputReview.recoveryPending["input-recovery-retry"]({version:7,text:"Old stored draft",attachments:[],missing:[]})');
  await review.waitFor('window.__inputReview.saves.some(item => item.sessionPath === "input-recovery-retry" && item.expectedVersion === 7 && item.text === "")');
  await review.assert(quietRecovery + ' && document.querySelector(".pd-composer-shell textarea").value === ""', 'Background recovery respects a deliberate clear and resumes persistence only after reading the stored version');

  await review.evaluate('window.__inputReview.ready("input-recovery-away")');
  await review.waitFor('Boolean(window.__inputReview.recoveryPending["input-recovery-away"])');
  await review.fill('.pd-composer-shell textarea', '原对话的本地草稿');
  await review.evaluate('window.__inputReview.ready("input-recovery-unread")');
  await review.waitFor('window.__inputReview.recoveryReads["input-recovery-unread"] >= 1');
  await review.fill('.pd-composer-shell textarea', '读取失败仍然能够正常发送');
  await review.evaluate('window.__inputReview.recoveryPending["input-recovery-away"]({version:9,text:"Another conversation draft",attachments:[],missing:[]})');
  await review.waitFor('window.__inputReview.recoveryReads["input-recovery-unread"] === 3 && !document.querySelector(".pd-send-button").disabled');
  await review.assert(quietRecovery + ' && document.querySelector(".pd-composer-shell textarea").value === "读取失败仍然能够正常发送" && !window.__inputReview.saves.some(item => item.sessionPath.startsWith("input-recovery-") && item.sessionPath !== "input-recovery-retry")', 'Exhausted retries and a late result from another conversation never overwrite unread persisted drafts or current input');
  await review.screenshot('inputs-quiet-draft-recovery');
  await review.click('.pd-send-button');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea").value === "" && window.__inputReview.sends.at(-1).text === "读取失败仍然能够正常发送"');
  await review.assert(quietRecovery + ' && window.__inputReview.recoveryReads["input-recovery-unread"] === 3 && !window.__inputReview.saves.some(item => item.sessionPath === "input-recovery-unread")', 'A current local draft can still be sent after recovery fails without an endless retry loop or overwriting the unread draft');

  await review.evaluate(`(() => {
    const state = window.__inputReview, original = window.piDesktop.submitInput;
    window.piDesktop.submitInput = async request => {
      const result = await original(request);
      return new Promise(resolve => { state.acknowledgeRecoverySend = () => resolve(result); });
    };
    state.ready('input-recovery-sending');
  })()`);
  await review.waitFor('window.__inputReview.recoveryReads["input-recovery-sending"] >= 1');
  await review.fill('.pd-composer-shell textarea', '发送确认期间草稿恢复也不能改变这条消息');
  await review.waitFor('!document.querySelector(".pd-send-button").disabled');
  await review.click('.pd-send-button');
  await review.waitFor('Boolean(window.__inputReview.acknowledgeRecoverySend) && Boolean(window.__inputReview.recoveryPending["input-recovery-sending"])');
  await review.evaluate(`window.__inputReview.recoveryPending['input-recovery-sending']({version:3,text:'Older disk draft',attachments:[{id:'stored-image',version:1,kind:'image',name:'restored.png',mimeType:'image/png',size:100},{id:'missing',version:1,kind:'image',name:'missing.png',mimeType:'image/png',size:100}],missing:['missing']})`);
  await review.waitFor('window.__inputReview.saves.some(item => item.sessionPath === "input-recovery-sending" && item.expectedVersion === 3)');
  await review.assert(quietRecovery + ' && !document.querySelector(".pd-composer-attachment") && document.querySelector(".pd-composer-shell textarea").value === "发送确认期间草稿恢复也不能改变这条消息"', 'Recovery during an unacknowledged send does not merge old attachments or reinstate missing-attachment blockers');
  await review.evaluate('window.__inputReview.acknowledgeRecoverySend()');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea").value === ""');
  await review.assert(quietRecovery + ' && !document.querySelector(".pd-composer-attachment")', 'The acknowledged message clears normally even when background recovery finished during submission');
}
