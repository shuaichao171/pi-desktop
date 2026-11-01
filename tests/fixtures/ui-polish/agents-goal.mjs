// Subagent and goal surfaces: the transcript's child-agent cards, the fleet strip
// above the composer and the goal beacon, collapsed and expanded, in both themes.
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../ui-polish/agents-goal.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../ui-polish/agents-goal.mjs
function seedAgentsAndGoals() {
  const fixture = window.__modelReview, now = Date.now();
  const cwd = fixture.snapshot.cwd;
  const goal = {
    cwd, available: true,
    goals: [{
      id: 'goal-1', objective: '把设置页迁移到新的 settings 卡片组件，所有旧样式删除，并让 pnpm test 全部通过', status: 'active', autoContinue: true, sisyphus: false,
      createdAt: new Date(now - 3600000).toISOString(), updatedAt: new Date(now - 60000).toISOString(), tokensUsed: 412300, tokenBudget: 1000000, activeSeconds: 2780,
      currentTaskId: 't3', tasks: [
        { id: 't1', title: '盘点旧设置页用到的样式类', status: 'complete', evidence: 'grep 结果已附' },
        { id: 't2', title: '迁移通用设置分组', status: 'complete' },
        { id: 't3', title: '迁移模型设置分组', status: 'pending' },
        { id: 't4', title: '删除 legacy-settings.css', status: 'pending' },
        { id: 't5', title: '补充快捷键设置的截图测试', status: 'skipped' },
      ], pendingTasks: 2, completedTasks: 2, skippedTasks: 1,
    }, {
      id: 'goal-2', objective: '修复删除会话时界面卡住的问题', status: 'paused', autoContinue: false, sisyphus: true,
      createdAt: new Date(now - 86400000).toISOString(), updatedAt: new Date(now - 7200000).toISOString(), tokensUsed: 88200, activeSeconds: 640,
      pauseReason: '需要确认是否允许改动 IPC 协议', pauseSuggestedAction: '回复确认后执行 /goal-resume', tasks: [], pendingTasks: 0, completedTasks: 0, skippedTasks: 0,
    }],
    recentEvents: [
      { type: 'task_completed', goalId: 'goal-1', at: new Date(now - 60000).toISOString() },
      { type: 'goal_paused', goalId: 'goal-2', at: new Date(now - 7200000).toISOString() },
    ],
  };
  window.piDesktop.getGoalSnapshot = async () => structuredClone(goal);
  window.piDesktop.listSlashCommands = async () => ['goal-pause', 'goal-resume', 'goal-focus', 'goal-status', 'subagents-stop', 'subagents-steer', 'subagents-inspect-rpc'].map(name => ({ name, description: name, source: 'extension' }));
  // A new session id makes both surfaces re-read the slash commands, so their actions show.
  Object.assign(fixture.snapshot, {
    status: 'idle', historyTotal: 2, sessionId: 'agents-review-session',
    runs: [{ id: 'agents-run', status: 'completed', startedAt: now - 200000, finishedAt: now - 1000 }],
    messages: [
      { id: 'agents-u', runId: 'agents-run', order: 0, role: 'user', text: '让两个子代理分别审查设置页和侧边栏', status: 'done' },
      { id: 'agents-a', runId: 'agents-run', order: 1, role: 'assistant', text: '我把两块审查分给两个子代理。', status: 'done' },
    ],
    activities: [
      { id: 'sub-1', runId: 'agents-run', order: 2, tool: 'subagent', title: 'reviewer', status: 'running', startedAt: now - 95000, endedAt: null,
        subagent: { agent: 'reviewer', task: '审查 packages/ui/src/components/settings 下的组件：找出重复样式、无效 token 和无障碍问题，输出带文件行号的清单。', runId: '7f3c2a91b4d0', model: 'claude-sonnet-5-5', turnCount: 6, toolCount: 14, tokens: 48210, currentTool: 'grep pd-settings-', recentTools: [{ tool: 'read', args: 'SettingsDialog.tsx' }, { tool: 'grep', args: 'pd-settings-' }, { tool: 'read', args: 'settings.css' }] } },
      { id: 'sub-2', runId: 'agents-run', order: 3, tool: 'subagent', title: 'scout', status: 'done', startedAt: now - 180000, endedAt: now - 62000, detail: '侧边栏共 3 处滚动阴影实现不一致，详见报告。',
        subagent: { agent: 'scout', task: '梳理侧边栏滚动渐隐的实现位置', runId: 'a81e55c0d2f4', async: true, model: 'claude-haiku-5-5', turnCount: 4, toolCount: 9, tokens: 12880, outputReference: '.pi/subagents/a81e55c0/report.md' } },
    ],
  });
  const fleet = {
    generatedAt: now, omittedRuns: 0, omittedChildren: 0,
    runs: [
      { id: '7f3c2a91', kind: 'workflow', label: '设置页 + 侧边栏审查', state: 'running', startedAt: now - 180000, updatedAt: now, activity: { turnCount: 10, toolCount: 23 },
        children: [
          { id: 'c1', kind: 'subagent', label: 'reviewer · 审查 settings 组件', state: 'running', startedAt: now - 95000, updatedAt: now, activity: { currentTool: 'grep pd-settings-', turnCount: 6, toolCount: 14 } },
          { id: 'c2', kind: 'subagent', label: 'scout · 梳理滚动渐隐', state: 'complete', startedAt: now - 180000, endedAt: now - 62000, activity: { turnCount: 4, toolCount: 9 } },
          { id: 'c3', kind: 'host-step', label: '汇总评审', state: 'queued', hostStep: { kind: 'review', state: 'queued', verdict: 'pending' } },
        ] },
      { id: 'b51d0e77', kind: 'subagent', label: 'tester · 运行 pnpm test', state: 'failed', startedAt: now - 400000, endedAt: now - 300000, activity: { turnCount: 3, toolCount: 5 } },
    ],
  };
  fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
  fixture.emitAgent({ type: 'subagent-fleet', fleet });
  fixture.emit('onGoalChanged', cwd);
}

export default async function agentsGoalScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-composer-shell"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  const theme = await review.evaluate('document.documentElement.dataset.theme === "light" ? "light" : "dark"');

  await review.evaluate(`(${seedAgentsAndGoals.toString()})()`);
  await review.click('.pd-turn-summary');
  await review.waitFor('Boolean(document.querySelector(".pd-goal-beacon")) && Boolean(document.querySelector(".pd-fleet-card")) && document.querySelectorAll(".pd-subagent-item").length === 2');
  await review.evaluate('document.querySelector(".pd-composer-shell > textarea")?.blur()');
  await review.screenshot(`agents-01-collapsed-${theme}`);

  await review.click('.pd-goal-strip');
  await review.waitFor('Boolean(document.querySelector(".pd-goal-panel .pd-goal-card"))');
  await review.screenshot(`agents-02-goal-open-${theme}`);
  await review.click('.pd-goal-strip');

  await review.click('.pd-fleet-strip');
  await review.waitFor('Boolean(document.querySelector(".pd-fleet-panel .pd-fleet-node"))');
  await review.screenshot(`agents-03-fleet-open-${theme}`);
}
