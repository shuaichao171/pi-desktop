// Built-renderer regression through an owned headless shell; never attaches a user window.
// Prepare: node tests/fixtures/conversation-process/scenarios.mjs --check
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=../conversation-process/scenarios.mjs
export default async function conversationProcessScenarios(review) {
  const turn = id => `.pd-conversation-turn[data-run-id="${id}"]`;
  const summary = id => `${turn(id)} button.pd-turn-summary`;
  const expanded = (id, value) => `document.querySelector(${JSON.stringify(summary(id))})?.getAttribute('aria-expanded') === '${value}'`;
  const elapsed = id => `Number(document.querySelector(${JSON.stringify(`${turn(id)} .pd-turn-duration`)})?.dataset.elapsedMs)`;
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = window.__processReview = { path: fixture.snapshot.sessionPath, order: 0 };
    state.visible = node => !!node && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
    state.ready = (path, messages = [], activities = [], runs = [], status = 'idle', sessionId = path) => {
      Object.assign(fixture.snapshot, { sessionId, sessionPath: path, messages: structuredClone(messages), activities: structuredClone(activities), runs: structuredClone(runs), historyTotal: messages.length, status, error: null });
      fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
      fixture.emitAgent({ type: 'status', status });
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { state.copied = text; } } });
    state.fullCommand = 'pnpm test --filter lifecycle -- --reporter=verbose --output="artifacts/lifecycle report.json"';
    state.send = event => {
      const snapshot = fixture.snapshot;
      if (event.type === 'run') snapshot.runs = [...snapshot.runs.filter(run => run.id !== event.run.id), structuredClone(event.run)];
      if (event.type === 'status') snapshot.status = event.status;
      if (event.type === 'user-message') snapshot.messages.push({ ...event, type: undefined, role: 'user', status: 'done' });
      if (event.type === 'assistant-start') snapshot.messages.push({ id: event.id, order: event.order, runId: event.runId, role: 'assistant', text: '', status: 'streaming' });
      if (event.type === 'assistant-delta') snapshot.messages.find(message => message.id === event.id).text += event.delta;
      if (event.type === 'assistant-thinking') Object.assign(snapshot.messages.find(message => message.id === event.id), { thinking: event.thinking, thinkingStatus: event.thinkingStatus });
      if (event.type === 'assistant-end') {
        const message = snapshot.messages.find(item => item.id === event.id);
        Object.assign(message, { text: event.text || message.text, status: event.aborted || event.errorMessage ? 'error' : 'done', thinkingStatus: event.thinkingStatus ?? (message.thinkingStatus ? event.errorMessage ? 'error' : event.aborted ? 'interrupted' : 'done' : undefined), errorMessage: event.errorMessage });
      }
      if (event.type === 'tool') snapshot.activities = [...snapshot.activities.filter(activity => activity.id !== event.activity.id), structuredClone(event.activity)];
      snapshot.historyTotal = snapshot.messages.length;
      fixture.emitAgent(event);
    };
    state.start = (id, prompt, offset = 0) => {
      const run = { id, startedAt: Date.now() - offset, finishedAt: null, status: 'running' };
      state.send({ type: 'run', run });
      state.send({ type: 'status', status: 'busy' });
      state.send({ type: 'user-message', id: id + '-user', runId: id, order: state.order++, text: prompt });
      return run;
    };
    state.assistant = (runId, id) => state.send({ type: 'assistant-start', id, runId, order: state.order++ });
    state.finish = (id, status = 'completed') => {
      const run = fixture.snapshot.runs.find(item => item.id === id);
      state.send({ type: 'run', run: { ...run, status, finishedAt: Date.now() } });
      state.send({ type: 'status', status: 'idle' });
    };
    state.ready(state.path);
    state.start('live', '审查对话过程，保留思考与工具输出', 62000);
    state.assistant('live', 'live-analysis');
    state.send({ type: 'assistant-thinking', id: 'live-analysis', thinking: '先检查生命周期，再验证整轮折叠和计时。', thinkingStatus: 'streaming' });
  })()`);
  await review.waitFor(expanded('live', true));
  await review.assert('window.__processReview.visible(document.querySelector("[data-run-id=live] .pd-thinking-markdown")) && document.querySelector("[data-run-id=live] .pd-thinking-markdown").textContent.includes("先检查生命周期")', 'Running turn exposes the provider thinking content');
  await review.assert(`${elapsed('live')} >= 62000`, 'Elapsed time begins at the recorded run start, not component mount');
  await review.evaluate(`window.__processReview.beforeTick = ${elapsed('live')}`);
  await review.waitFor(`${elapsed('live')} >= window.__processReview.beforeTick + 900`);
  await review.click('[data-run-id=live] .pd-thinking-summary');
  await review.evaluate('window.__processReview.send({type:"assistant-thinking",id:"live-analysis",thinking:"先检查生命周期，再验证整轮折叠和计时。追加的思考也不能覆盖用户收起状态。",thinkingStatus:"streaming"})');
  await review.assert('document.querySelector("[data-run-id=live] .pd-thinking-summary").getAttribute("aria-expanded") === "false"', 'Thinking increments preserve the user choice to collapse that thinking block');
  await review.evaluate('window.__processReview.send({type:"assistant-delta",id:"live-analysis",delta:"先检查生命周期。"})');
  await review.assert('document.querySelector("[data-run-id=live] .pd-thinking-summary").getAttribute("aria-expanded") === "false"', 'First text token does not remount thinking and reopen its manually collapsed content');
  await review.evaluate(`(() => {
    const s = window.__processReview;
    s.send({ type: 'assistant-end', id: 'live-analysis', text: '定位问题标记：正在检查计时与状态转换。', thinkingStatus: 'done' });
    s.send({ type: 'tool', activity: { id: 'read-source', runId: 'live', order: s.order++, tool: 'read', title: '读取生命周期源码', status: 'running', detail: 'export function beginRun() {}', files: ['src/lifecycle.ts'], startedAt: Date.now() - 2500 } });
    s.send({ type: 'tool', activity: { ...window.__modelReview.snapshot.activities[0], status: 'done', endedAt: Date.now() } });
    s.send({ type: 'tool', activity: { id: 'run-checks', runId: 'live', order: s.order++, tool: 'bash', title: '运行回归检查', command: s.fullCommand, status: 'running', detail: 'Checking lifecycle…', startedAt: Date.now() } });
  })()`);
  await review.waitFor('document.querySelectorAll("[data-run-id=live] .pd-activity-item").length === 2');
  await review.assert('document.querySelector("[data-run-id=live] .pd-thinking-summary").getAttribute("aria-expanded") === "false"', 'Tool arrival preserves the thinking disclosure choice when assistant prose becomes an intermediate step');
  await review.click('[data-run-id=live] .pd-thinking-summary');
  await review.assert(expanded('live', true), 'A finished assistant item and first tool do not close a running turn');
  await review.assert('window.__processReview.visible(document.querySelector("[data-message-id=live-analysis] [data-message-body]"))', 'Intermediate assistant prose stays visible while tools execute');
  await review.screenshot('process-running-thinking-tools');

  await review.evaluate(`(() => {
    const s = window.__processReview;
    s.send({ type: 'tool', activity: { ...window.__modelReview.snapshot.activities.find(item => item.id === 'run-checks'), status: 'done', detail: '2 lifecycle checks passed.', exitCode: 0, endedAt: Date.now() } });
    s.assistant('live', 'live-final');
    s.send({ type: 'assistant-delta', id: 'live-final', delta: '修复已完成。最终回答在过程之外持续显示。' });
  })()`);
  await review.waitFor('document.querySelector("[data-message-id=live-final] [data-message-body]") !== null');
  await review.assert(expanded('live', true), 'Starting the final streaming body does not collapse a still-running turn');
  await review.evaluate(`window.__processReview.finalTick = ${elapsed('live')}`);
  await review.waitFor(`${elapsed('live')} >= window.__processReview.finalTick + 900`);
  await review.evaluate('window.__processReview.send({type:"assistant-end",id:"live-final",text:"修复已完成。最终回答在过程之外持续显示。"})');
  await review.assert(expanded('live', true), 'Assistant-end alone is not the completion boundary for the whole run');
  await review.evaluate('window.__processReview.finish("live")');
  await review.waitFor(expanded('live', false));
  await review.assert('(() => { const body=document.querySelector("[data-message-id=live-final] [data-message-body]"); return window.__processReview.visible(body) && !body.closest(".pd-turn-process"); })()', 'Completed turn collapses only its process and preserves the final answer');
  await review.assert('!window.__processReview.visible(document.querySelector("[data-message-id=live-analysis] [data-message-body]"))', 'Collapsed process removes intermediate prose from the accessible visible surface');
  await review.evaluate(`window.__processReview.frozen = ${elapsed('live')}; window.__processReview.frozenAt = Date.now(); window.__processReview.completedSnapshot = structuredClone(window.__modelReview.snapshot)`);
  await review.waitFor('Date.now() - window.__processReview.frozenAt > 1200');
  await review.assert(`${elapsed('live')} === window.__processReview.frozen && ${elapsed('live')} === window.__modelReview.snapshot.runs[0].finishedAt - window.__modelReview.snapshot.runs[0].startedAt`, 'Completed duration remains fixed at the recorded finish boundary');
  await review.screenshot('process-completed-final-visible');
  await review.click(summary('live'));
  await review.assert('window.__processReview.visible(document.querySelector("[data-run-id=live] .pd-thinking-markdown")) && document.querySelectorAll("[data-run-id=live] .pd-activity-item").length === 2', 'Expanding completed process restores all thinking and both tool histories');
  await review.click('[data-run-id=live] .pd-activity-item:last-child .pd-activity-head');
  await review.assert('[...document.querySelectorAll("[data-run-id=live] .pd-activity-output")].some(node => window.__processReview.visible(node) && node.textContent.includes("2 lifecycle checks passed"))', 'Retained tool output remains expandable after the whole turn has completed');
  await review.click('[data-run-id=live] button[aria-label="复制完整命令"]');
  await review.assert('window.__processReview.copied === window.__processReview.fullCommand', 'Command copy preserves the full invocation including quoting and trailing arguments');
  await review.screenshot('process-history-expanded');

  await review.click(summary('live'));
  await review.key('f', { ctrl: true });
  await review.fill('.pd-transcript-find-input', '定位问题标记');
  await review.waitFor(expanded('live', true));
  await review.assert('window.__processReview.visible(document.querySelector("[data-message-id=live-analysis] [data-message-body]")) && CSS.highlights.get("pd-find-current")?.size === 1', 'Finding intermediate prose opens its process group and paints the actual occurrence');
  await review.screenshot('process-search-opens-history');
  await review.key('Escape');

  await review.evaluate(`(() => { const s=window.__processReview; s.start('manual','手动收起运行过程'); s.assistant('manual','manual-analysis'); s.send({type:'assistant-thinking',id:'manual-analysis',thinking:'这段思考应允许手动收起。',thinkingStatus:'streaming'}); })()`);
  await review.waitFor(expanded('manual', true));
  await review.click(summary('manual'));
  await review.evaluate(`(() => { const s=window.__processReview; s.send({type:'assistant-end',id:'manual-analysis',text:'中间检查完成。'}); s.assistant('manual','manual-final'); s.send({type:'assistant-end',id:'manual-final',text:'手动折叠不会隐藏这条最终回答。'}); s.finish('manual'); })()`);
  await review.waitFor(expanded('manual', false));
  await review.assert('window.__processReview.visible(document.querySelector("[data-message-id=manual-final] [data-message-body]"))', 'Completing a manually collapsed running turn never forces it open or hides its answer');

  // Protocol terminal states remain distinguishable even without a final message.
  await review.evaluate(`(() => {
    const s=window.__processReview, now=Date.now();
    const statuses=['cancelled','failed','interrupted'];
    const messages=statuses.flatMap((status,index)=>[{id:status+'-u',runId:status,order:index*2,role:'user',text:status==='cancelled'?'用户主动停止':status==='failed'?'模型调用失败':'进程意外中断',status:'done'},{id:status+'-a',runId:status,order:index*2+1,role:'assistant',text:'',thinking:'已保留的过程记录 '+status,thinkingStatus:status==='failed'?'error':'interrupted',status:'error',errorMessage:status==='failed'?'验证用连接失败':'运行已停止'}]);
    const runs=statuses.map((status,index)=>({id:status,status,startedAt:now-15000-index*1000,finishedAt:status==='interrupted'?null:now-1000}));
    s.ready(s.path+'-terminal',messages,[],runs);
  })()`);
  await review.waitFor('document.querySelectorAll(".pd-turn-summary").length === 3');
  await review.assert('(() => { const text=id=>document.querySelector("[data-run-id="+id+"] .pd-turn-summary").textContent; return text("cancelled")!==text("failed") && /停止|取消/.test(text("cancelled")) && /失败/.test(text("failed")) && /中断/.test(text("interrupted")); })()', 'Cancelled, failed and interrupted runs have distinct, accurate summary labels');
  await review.record('terminal-state-labels', '[...document.querySelectorAll(".pd-turn-summary")].map(node=>node.textContent)');
  await review.screenshot('process-terminal-states');
  await review.evaluate(`(() => {
    const s=window.__processReview, now=Date.now(), statuses=['cancelled','failed','interrupted'];
    const messages=statuses.map((status,index)=>({id:'empty-'+status+'-u',runId:'empty-'+status,order:index,role:'user',text:'首次输出前 '+status,status:'done'}));
    const runs=statuses.map(status=>({id:'empty-'+status,status,startedAt:now-17000,finishedAt:status==='interrupted'?null:now-1000}));
    s.ready(s.path+'-before-first-token',messages,[],runs);
  })()`);
  await review.waitFor('document.querySelectorAll(".pd-turn-summary").length === 3');
  await review.assert('(() => { const text=id=>document.querySelector("[data-run-id=empty-"+id+"] .pd-turn-summary").textContent; return /停止|取消/.test(text("cancelled")) && /失败/.test(text("failed")) && /中断/.test(text("interrupted")) && document.querySelectorAll(".pd-turn-process,.pd-turn-summary[aria-expanded]").length === 0; })()', 'Stopping, failing or interrupting before an assistant item retains a terminal summary without an empty disclosure');
  await review.assert(`${elapsed('empty-cancelled')} === 16000 && ${elapsed('empty-failed')} === 16000 && document.querySelector('[data-run-id=empty-interrupted] .pd-turn-duration') === null`, 'Pre-token terminal summaries use observed completion time and do not fabricate crash duration');
  await review.screenshot('process-terminal-before-first-token');

  // Restored lifecycle metadata controls the timer; receiving ready must not reset it.
  await review.evaluate(`(() => {
    const s=window.__processReview, snapshot=s.completedSnapshot;
    const run={...snapshot.runs[0],startedAt:Date.now()-300000,finishedAt:Date.now()-175000};
    s.ready(s.path,snapshot.messages,snapshot.activities,[run]);
    s.restoredFinished=run.finishedAt-run.startedAt;
  })()`);
  await review.waitFor(`${elapsed('live')} === window.__processReview.restoredFinished`);
  await review.assert('window.__processReview.restoredFinished >= 124990 && window.__processReview.restoredFinished <= 125010', 'Ready restoration uses the stored 125-second completed duration');
  await review.evaluate(`(() => { const s=window.__processReview, snapshot=window.__modelReview.snapshot; s.ready(s.path,snapshot.messages,snapshot.activities,snapshot.runs); })()`);
  await review.assert(`${elapsed('live')} === window.__processReview.restoredFinished`, 'Repeated ready for the same completed run keeps its original duration');

  await review.evaluate(`(() => {
    const s=window.__processReview;
    s.sharedMessages=label=>[{id:'shared-u',runId:'shared',order:0,role:'user',text:'会话 '+label,status:'done'},{id:'shared-process',runId:'shared',order:1,role:'assistant',text:'会话 '+label+' 的中间记录',thinking:'保留会话 '+label+' 的思考',thinkingStatus:'done',status:'done'},{id:'shared-final',runId:'shared',order:2,role:'assistant',text:'会话 '+label+' 的最终回答',status:'done'}];
    s.sharedRun={id:'shared',startedAt:100000,finishedAt:107000,status:'completed'};
    s.ready(s.path+'-a',s.sharedMessages('A'),[],[s.sharedRun],'idle','same-session-id');
  })()`);
  await review.waitFor(expanded('shared', false));
  await review.click(summary('shared'));
  await review.evaluate('window.__processReview.ready(window.__processReview.path+"-b",window.__processReview.sharedMessages("B"),[],[window.__processReview.sharedRun],"idle","same-session-id")');
  await review.waitFor(expanded('shared', false));
  await review.assert('document.querySelector("[data-message-id=shared-final]").textContent.includes("会话 B") && !document.querySelector(".pd-transcript").textContent.includes("会话 A") && window.__modelReview.snapshot.sessionId === "same-session-id"', 'Same session ID with a different path does not inherit expansion or content, even with identical run and message IDs');
  await review.evaluate(`(() => {
    const s=window.__processReview, run={id:'restored-running',startedAt:Date.now()-95000,finishedAt:null,status:'running'};
    s.ready(s.path+'-running',[{id:'restored-u',runId:run.id,order:0,role:'user',text:'恢复进行中的工作',status:'done'},{id:'restored-a',runId:run.id,order:1,role:'assistant',text:'',thinking:'继续检查已有运行。',thinkingStatus:'streaming',status:'streaming'}],[],[run],'busy');
  })()`);
  await review.waitFor(expanded('restored-running', true));
  await review.assert(`${elapsed('restored-running')} >= 95000`, 'Restoring a running turn preserves time already spent before mounting');
  await review.evaluate(`window.__processReview.restoreTick = ${elapsed('restored-running')}`);
  await review.waitFor(`${elapsed('restored-running')} >= window.__processReview.restoreTick + 900`);

  // Layout evidence uses real built styles and the public theme control.
  await review.evaluate('(() => { const s=window.__processReview, snapshot=s.completedSnapshot; s.ready(s.path+"-layout",snapshot.messages,snapshot.activities,snapshot.runs); })()');
  await review.waitFor(expanded('live', false));
  await review.click(summary('live'));
  await review.viewport(680, 1000);
  await review.assert('document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".pd-turn-summary,.pd-turn-process")].every(node=>{const box=node.getBoundingClientRect();return box.right<=innerWidth+1 && box.left>=-1;})', 'Expanded process has no page or group overflow at 680 pixels');
  await review.screenshot('process-narrow-expanded');
  await review.viewport(1440, 1000);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.key('Escape');
  await review.waitFor('document.querySelector(".pd-settings-dialog") === null && document.documentElement.dataset.theme === "light"');
  await review.screenshot('process-light-expanded');
  await review.click(summary('live'));
  await review.viewport(680, 1000);
  await review.assert(expanded('live', false), 'Narrow light theme preserves completed collapse state');
  await review.assert('window.__processReview.visible(document.querySelector("[data-message-id=live-final] [data-message-body]")) && document.documentElement.scrollWidth <= innerWidth', 'Narrow light theme keeps the final answer readable without horizontal overflow');
  await review.screenshot('process-light-narrow-completed');

  // Virtual rows may unmount, but the reader's disclosure choices belong to
  // the conversation. Find the user on return so search cannot force the process open.
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const s=window.__processReview, messages=[], activities=[], runs=[];
    for(let i=0;i<160;i++) {
      const label=String(i).padStart(3,'0'), runId='virtual-run-'+i;
      runs.push({id:runId,startedAt:1000+i*10000,finishedAt:6000+i*10000,status:'completed'});
      messages.push({id:'virtual-u'+i,runId,order:i*4,role:'user',text:'Virtual question '+label,status:'done'},
        {id:'virtual-p'+i,runId,order:i*4+1,role:'assistant',text:'Virtual process '+label,thinking:'Retained thinking '+label,thinkingStatus:'done',status:'done'},
        {id:'virtual-a'+i,runId,order:i*4+3,role:'assistant',text:'Virtual final '+label,status:'done'});
      activities.push({id:'virtual-t'+i,runId,order:i*4+2,tool:'read',title:'read(src/file-'+i+'.ts)',detail:'Retained tool output '+label,status:'done'});
    }
    s.ready(s.path+'-virtual',messages,activities,runs);
  })()`);
  await review.waitFor('document.querySelector(".pd-virtual-row") !== null');
  await review.key('f', { ctrl: true });
  await review.fill('.pd-transcript-find-input', 'Virtual process 070');
  await review.waitFor(expanded('virtual-run-70', true));
  await review.key('Escape');
  await review.click('[data-run-id=virtual-run-70] .pd-thinking-summary');
  await review.click('[data-run-id=virtual-run-70] .pd-activity-head');
  await review.assert('document.querySelector("[data-run-id=virtual-run-70] .pd-thinking-summary").getAttribute("aria-expanded")==="false" && document.querySelector("[data-run-id=virtual-run-70] .pd-activity-head").getAttribute("aria-expanded")==="true"', 'Reader chooses independent thinking and tool states before virtual eviction');
  await review.evaluate('(() => {const node=document.querySelector(".pd-transcript");node.scrollTop=node.scrollHeight;})()');
  await review.waitFor('document.querySelector("[data-run-id=virtual-run-70]") === null');
  await review.key('f', { ctrl: true });
  await review.fill('.pd-transcript-find-input', 'Virtual question 070');
  await review.waitFor('document.querySelector("[data-message-id=virtual-u70]") !== null');
  await review.key('Escape');
  await review.waitFor(expanded('virtual-run-70', true));
  await review.assert('document.querySelector("[data-run-id=virtual-run-70] .pd-thinking-summary").getAttribute("aria-expanded")==="false" && document.querySelector("[data-run-id=virtual-run-70] .pd-activity-head").getAttribute("aria-expanded")==="true"', 'Virtual remount retains expanded process, collapsed thinking and expanded tool without a process search match');
  await review.click(summary('virtual-run-70'));
  await review.evaluate('window.__processReview.virtualOffset=document.querySelector(".pd-transcript").scrollTop');
  await review.evaluate('(() => {const node=document.querySelector(".pd-transcript");node.scrollTop=node.scrollHeight;})()');
  await review.waitFor('document.querySelector("[data-run-id=virtual-run-70]") === null');
  await review.evaluate('document.querySelector(".pd-transcript").scrollTop=window.__processReview.virtualOffset');
  await review.waitFor('document.querySelector("[data-run-id=virtual-run-70]") !== null');
  await review.assert(expanded('virtual-run-70', false), 'A previously handled reveal request cannot reopen the reader-collapsed process on virtual remount');
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  const noop = async () => {};
  await conversationProcessScenarios({ evaluate: async value => compile(value), waitFor: async value => compile(value), assert: async value => compile(value), record: async (_name, value) => compile(value), key: noop, reducedMotion: noop, viewport: noop, click: noop, clickText: noop, fill: noop, screenshot: noop });
  console.log(`Prepared ${count} conversation-process expressions; no browser launched.`);
}
