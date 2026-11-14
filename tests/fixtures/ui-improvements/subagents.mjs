// Built-renderer checks with an owned headless shell; no model or user session is used.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../ui-improvements/subagents.mjs
export default async function subagentScenarios(review) {
  await review.reloadWithFixture(`(() => {
    const f = window.__modelReview, bridge = window.piDesktop;
    const now = Date.now();
    window.__fleetCalls = [];
    window.__fleetDelayed = false;
    window.__fleetReplies = [];
    bridge.listSlashCommands = async () => ['subagents-inspect-rpc', 'subagents-steer', 'subagents-stop'].map(name => ({ name, description: name, source: 'extension' }));
    bridge.executeSlashCommand = async request => {
      window.__fleetCalls.push(structuredClone(request));
      if (request.name !== 'subagents-inspect-rpc') return;
      const [requestId, asyncId, childId] = request.args.split(' ');
      const send = () => f.emitAgent({ type: 'subagent-inspect', reply: {
        requestId, asyncId, childId: childId === '--lines' ? undefined : childId,
        label: asyncId, status: 'running', task: '检查子代理的状态与展示，保留父会话的上下文。',
        messages: [{ role: 'user', text: '请检查界面组件与实时状态。' }, { role: 'assistant', text: '已定位 **FleetCard** 和事件订阅。\\n\\n- 保持创建顺序\\n- 按需读取对话' }],
        finalOutput: asyncId === 'review' ? '审查完成：状态更新和列表顺序正常。' : undefined,
      } });
      if (window.__fleetDelayed) window.__fleetReplies.push(send); else send();
    };
    f.snapshot.messages = [
      { id: 'prompt', order: 0, role: 'user', text: '参考 Codex 的子代理展示，改进工作台。', status: 'done' },
      { id: 'reply', order: 1, role: 'assistant', text: '我会分别检查组件结构、事件流和交互状态，然后合并结果。', status: 'done' },
    ];
    f.snapshot.activities = [{ id: 'delegate', order: 2, tool: 'subagent', title: 'subagent', status: 'running', startedAt: now - 62000,
      subagent: { agent: 'researcher', task: '检查代理状态与消息事件，整理展示方式', model: 'review-model', runId: 'research', async: true, turnCount: 3, toolCount: 8 } }];
    f.snapshot.subagentFleet = { generatedAt: now, omittedRuns: 0, omittedChildren: 0, runs: [
      { id: 'research', kind: 'subagent', label: 'researcher', state: 'running', startedAt: now - 62000, activity: { currentTool: 'read', turnCount: 3, toolCount: 8 } },
      { id: 'worker', kind: 'subagent', label: 'worker: 调整侧栏与紧凑列表布局', state: 'running', startedAt: now - 32000, activity: { currentTool: 'edit' } },
      { id: 'pipeline', kind: 'workflow', label: '验证工作流', state: 'queued', startedAt: now - 8000, children: [
        { id: 'step-a', kind: 'step', label: '组件审查', state: 'complete', startedAt: now - 8000, endedAt: now - 1000 },
        { id: 'step-b', kind: 'step', label: '窄屏检查', state: 'queued' },
      ] },
      { id: 'review', kind: 'subagent', label: 'reviewer', state: 'complete', startedAt: now - 90000, endedAt: now - 20000 },
      { id: 'failed', kind: 'subagent', label: 'tester', state: 'failed', startedAt: now - 45000, endedAt: now - 5000 },
    ] };
    f.snapshot.historyTotal = 2;
    f.snapshot.status = 'busy';
  })()`);
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-strip"))');
  await review.assert('!document.querySelector(".pd-fleet-sidepanel")', 'Agents keep a compact entry point until opened');
  await review.assert('document.querySelector(".pd-subagent-head .pd-activity-head")?.getAttribute("aria-expanded") === "false"', 'Delegation records stay compact while running');
  await review.click('.pd-fleet-strip');
  await review.waitFor('document.querySelectorAll(".pd-fleet-node-row").length === 7');
  await review.assert('[...document.querySelectorAll(".pd-fleet-group > h4")].map(x=>x.textContent).join("|") === "进行中3|已结束2"', 'The side panel separates active and finished runs');
  await review.assert('document.querySelector(".pd-fleet-node-preview")?.textContent.includes("检查代理状态")', 'Exact run IDs connect the task preview with its delegation record');
  await review.assert('(() => { const p=document.querySelector(".pd-fleet-sidepanel").getBoundingClientRect(), c=document.querySelector(".pd-conversation-body").getBoundingClientRect(); return c.right <= p.left+1 && p.width === 360; })()', 'Wide layout keeps chat and agents side by side');
  await review.screenshot('subagents-overview');
  await review.evaluate(`(() => { const f=window.__modelReview; window.__fleetFirstRow=document.querySelector('.pd-fleet-node-row'); f.snapshot.subagentFleet.runs[0].updatedAt=Date.now(); f.snapshot.subagentFleet.runs[0].activity.currentTool='grep'; f.emitAgent({type:'subagent-fleet',fleet:structuredClone(f.snapshot.subagentFleet)}); })()`);
  await review.assert('window.__fleetFirstRow === document.querySelector(".pd-fleet-node-row")', 'Progress updates preserve the identity and position of an agent row');
  await review.evaluate('window.__fleetBefore = document.querySelector(".pd-fleet-node-meta time").textContent');
  await review.waitFor('document.querySelector(".pd-fleet-node-meta time").textContent !== window.__fleetBefore');
  await review.click('.pd-fleet-node-row');
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-inspect-task"))');
  await review.assert('document.querySelector(".pd-fleet-detail-heading h4")?.textContent === "researcher" && document.querySelector(".pd-fleet-detail-meta").textContent.includes("review-model")', 'Detail retains identity, model and live state');
  await review.assert('window.__fleetCalls[0].name === "subagents-inspect-rpc" && window.__fleetCalls[0].args.includes(" research --lines 60")', 'Inspection addresses the selected run');
  await review.screenshot('subagents-detail');
  await review.clickText('.pd-fleet-detail-actions button', '引导');
  await review.fill('.pd-fleet-steer textarea', '请优先检查错误与等待状态');
  await review.click('.pd-fleet-steer button[type=submit]');
  await review.waitFor('window.__fleetCalls.some(x=>x.name === "subagents-steer")');
  await review.assert('window.__fleetCalls.find(x=>x.name === "subagents-steer").args === "research 请优先检查错误与等待状态"', 'Steering sends the exact run ID and typed message');
  await review.clickText('.pd-fleet-detail-actions button', '停止');
  await review.waitFor('window.__fleetCalls.some(x=>x.name === "subagents-stop")');
  await review.assert('window.__fleetCalls.find(x=>x.name === "subagents-stop").args === "research"', 'Stop only targets the selected root run');
  await review.evaluate(`(() => { const f=window.__modelReview; Object.assign(f.snapshot.subagentFleet.runs[0],{state:'complete',endedAt:Date.now()}); f.emitAgent({type:'subagent-fleet',fleet:structuredClone(f.snapshot.subagentFleet)}); })()`);
  await review.waitFor('!document.querySelector(".pd-fleet-detail-actions")');
  await review.assert('document.querySelector(".pd-fleet-detail-heading").textContent.includes("已完成")', 'The open preview follows live completion and removes controls for finished work');
  await review.clickText('.pd-fleet-detail-nav button', '返回子代理列表');
  await review.clickText('.pd-fleet-node-label', '组件审查');
  await review.waitFor('window.__fleetCalls.at(-1).args.includes(" pipeline step-a --lines 60")');
  await review.assert('!document.querySelector(".pd-fleet-detail-actions")', 'Workflow children are inspected through the parent and never receive unsupported root actions');
  await review.clickText('.pd-fleet-detail-nav button', '返回子代理列表');
  await review.evaluate('window.__fleetDelayed = true');
  await review.clickText('.pd-fleet-node-label', 'worker: 调整侧栏与紧凑列表布局');
  await review.waitFor('document.querySelector(".pd-fleet-detail-scroll")?.getAttribute("aria-busy") === "true"');
  await review.clickText('.pd-fleet-detail-nav button', '返回子代理列表');
  await review.evaluate('window.__fleetDelayed = false');
  await review.clickText('.pd-fleet-node-label', 'reviewer');
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-final-output"))');
  await review.evaluate('window.__fleetReplies.shift()()');
  await review.assert('document.querySelector(".pd-fleet-detail-heading h4").textContent === "reviewer" && Boolean(document.querySelector(".pd-fleet-final-output"))', 'A stale inspection never replaces another agent preview');
  await review.click('.pd-fleet-detail-nav button[aria-label="刷新对话"]');
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-final-output"))');
  await review.screenshot('subagents-completed');
  await review.viewport(560, 900);
  await review.assert('(() => { const p=document.querySelector(".pd-fleet-sidepanel").getBoundingClientRect(); return p.width <= innerWidth && p.right <= innerWidth+1 && p.height > 500 && document.documentElement.scrollWidth <= innerWidth; })()', 'Narrow layout uses a bounded overlay without horizontal overflow');
  await review.screenshot('subagents-narrow');
  await review.click('.pd-fleet-panel-header button');
  await review.assert('document.activeElement?.classList.contains("pd-fleet-strip")', 'Closing restores focus to the panel trigger');
  await review.viewport(1440, 1000);
  await review.click('.pd-subagent-open');
  await review.waitFor('document.querySelector(".pd-fleet-detail-heading h4")?.textContent === "researcher"');
  await review.assert('window.__fleetCalls.at(-1).args.includes(" research --lines 60")', 'A compact delegation record opens the matching agent directly');
  await review.evaluate(`(() => { const f=window.__modelReview; f.snapshot.sessionId='another-session'; f.snapshot.subagentFleet=null; f.emitAgent({ ...structuredClone(f.snapshot), type:'ready' }); })()`);
  await review.waitFor('!document.querySelector(".pd-fleet-sidepanel") && !document.querySelector(".pd-fleet-strip")');
  await review.assert('!document.querySelector(".pd-subagent-open")', 'Session changes clear the preview and exact-run links');

  // A real timeout must still fire while the live elapsed clock keeps rendering.
  await review.evaluate(`(() => { const f=window.__modelReview; window.__fleetDelayed=true; f.snapshot.subagentFleet={generatedAt:Date.now(),omittedRuns:0,omittedChildren:0,runs:[{id:'timeout-run',kind:'subagent',label:'等待回复的代理',state:'running',startedAt:Date.now()}]}; f.emitAgent({type:'subagent-fleet',fleet:structuredClone(f.snapshot.subagentFleet)}); })()`);
  await review.click('.pd-fleet-strip');
  await review.click('.pd-fleet-node-row');
  await review.waitFor('document.querySelector(".pd-fleet-inspect-error")?.textContent.includes("读取超时")', 20000);
  await review.assert('document.querySelector(".pd-fleet-detail-scroll").getAttribute("aria-busy") === "false"', 'A missing reply ends loading despite one-second elapsed updates');
  await review.evaluate('window.__fleetDelayed=false');
  await review.click('.pd-fleet-detail-nav button[aria-label="刷新对话"]');
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-inspect-task")) && !document.querySelector(".pd-fleet-inspect-error")');
  await review.evaluate(`(() => { const f=window.__modelReview; window.piDesktop.listSlashCommands=async()=>[]; f.snapshot.sessionId='read-only-fleet'; f.emitAgent({...structuredClone(f.snapshot),type:'ready'}); f.emitAgent({type:'subagent-fleet',fleet:structuredClone(f.snapshot.subagentFleet)}); window.__fleetBeforeReadOnly=window.__fleetCalls.length; })()`);
  await review.waitFor('!document.querySelector(".pd-fleet-sidepanel")');
  await review.click('.pd-fleet-strip');
  await review.click('.pd-fleet-node-row');
  await review.assert('document.querySelector(".pd-fleet-empty")?.textContent.includes("未提供对话查看") && !document.querySelector(".pd-fleet-detail-actions") && window.__fleetCalls.length === window.__fleetBeforeReadOnly', 'Missing plugin commands degrade to a read-only preview without dispatching unsupported actions');
  await review.evaluate('window.__modelReview.emitAgent({type:"subagent-fleet",fleet:null})');
  await review.waitFor('!document.querySelector(".pd-fleet-strip")');
  await review.evaluate('window.__modelReview.emitAgent({type:"subagent-fleet",fleet:structuredClone(window.__modelReview.snapshot.subagentFleet)})');
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-strip"))');
  await review.assert('!document.querySelector(".pd-fleet-sidepanel")', 'Clearing a fleet resets its preview even when the parent session stays the same');
}
