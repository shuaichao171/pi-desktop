// Every top-level surface in one run, for visual review: empty, conversation, running,
// narrow window, workbench, search, automations, plugins and each settings page.
// Any page that falls into an error boundary or bridge gap fails the run.
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../ui-audit/scenarios.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../ui-audit/scenarios.mjs
function seed() {
  const fixture = window.__modelReview, bridge = window.piDesktop, now = Date.now();
  const cwd = 'C:\\Users\\review\\Projects\\pi-desktop';
  const other = 'C:\\Users\\review\\Projects\\blog-site';
  const mk = (ws, list) => list.map((name, order) => ({ id: ws + order, name, firstMessage: name, path: ws + '\\s' + order + '.jsonl', order, modified: new Date(now - order * 3600e3 * 5).toISOString(), messageCount: 6 + order }));
  const rows = { [cwd]: mk(cwd, ['重构设置面板的卡片布局', '修复删除会话时界面卡住', '为 composer 增加附件拖拽上传并支持粘贴截图', '对话压缩策略调研']), [other]: mk(other, ['迁移到 Astro 5', '暗色模式配色'] ) };
  bridge.listWorkspaces = async () => [cwd, other];
  bridge.listSessions = async ws => structuredClone(rows[ws] ?? []);
  bridge.listConversationWorkspaces = async () => [cwd, other];
  const runs = [{ id: 'r1', status: 'completed', startedAt: now - 95000, finishedAt: now - 3000 }];
  const messages = [
    { id: 'u1', runId: 'r1', order: 0, role: 'user', text: '帮我看看设置面板为什么在窄窗口下会出现横向滚动条，顺便把卡片间距统一一下。', status: 'done' },
    { id: 'a1', runId: 'r1', order: 3, role: 'assistant', thinking: '先定位 settings 容器的宽度约束，再检查卡片 gap。', thinkingStatus: 'done', status: 'done', text: [
      '定位到原因了：`.pd-settings-content` 设置了 `min-width: 640px`，窗口窄于 860px 时就会溢出。',
      '',
      '## 修改方案',
      '',
      '1. 去掉固定 `min-width`，改为 `minmax(0, 1fr)`',
      '2. 卡片之间统一使用 `--pd-space-4`（16px）',
      '3. 分组标题与卡片间距改为 8px',
      '',
      '```css',
      '.pd-settings-content {',
      '  display: grid;',
      '  grid-template-columns: minmax(0, 1fr);',
      '  gap: var(--pd-space-4);',
      '}',
      '```',
      '',
      '| 文件 | 变更 | 说明 |',
      '| --- | --- | --- |',
      '| settings.css | +12 −8 | 布局与间距 |',
      '| SettingsPanel.tsx | +3 −1 | 移除内联宽度 |',
      '',
      '> 已运行 `pnpm test`，全部 214 项通过。',
    ].join('\n') },
  ];
  const activities = [
    { id: 't1', runId: 'r1', order: 1, tool: 'read', title: '读取 settings.css', status: 'done', detail: '.pd-settings-content { min-width: 640px; }', startedAt: now - 90000, endedAt: now - 89000 },
    { id: 't2', runId: 'r1', order: 2, tool: 'bash', title: '运行测试', command: 'pnpm test', status: 'done', detail: '214 passed', startedAt: now - 60000, endedAt: now - 20000 },
  ];
  Object.assign(fixture.snapshot, { cwd, sessionId: rows[cwd][0].id, sessionPath: rows[cwd][0].path, status: 'idle', messages, activities, runs, historyTotal: messages.length, error: null,
    contextUsage: { tokens: 48200, contextWindow: 200000, percent: 24.1 },
    fileChanges: [{ path: 'packages/ui/src/settings.css', status: 'modified', additions: 12, deletions: 8 }, { path: 'packages/ui/src/components/SettingsPanel.tsx', status: 'modified', additions: 3, deletions: 1 }] });
  fixture.sessionStats = { sessionId: fixture.snapshot.sessionId, userMessages: 1, assistantMessages: 1, toolCalls: 2, toolResults: 2, totalMessages: 4, tokens: { input: 40100, output: 3200, cacheRead: 12000, cacheWrite: 0, total: 55300 }, cost: 0.083, timing: { sampledAt: now, durationMs: 92000, running: false, latestRun: null } };
  localStorage.setItem('pi-desktop.sidebar-width', '274');
}

export default async function uiAudit(review) {
  const errors = [];
  const step = async (name, fn) => { try { await fn(); } catch (error) { errors.push(name + ': ' + error.message); } };
  const shot = async (name) => { await review.screenshot(name); if (await review.evaluate("document.body.innerText.includes(\"暂时无法显示\") || document.body.innerText.includes(\"加载失败\")")) errors.push(name + ": error state visible"); };
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-top-bar"))');
  await review.reducedMotion(true);
  await review.viewport(1440, 900);
  await step("empty", () => shot('01-empty'));
  await step('seed', () => review.reloadWithFixture(`(${seed.toString()})()`));
  await step('conversation', async () => { await review.waitFor('Boolean(document.querySelector("[data-message-id=a1]"))', 6000); await shot('02-conversation'); });
  await step('scrolltop', async () => { await review.evaluate('document.querySelectorAll("*").forEach(e => { if (e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== "visible") e.scrollTop = 0; })'); await shot('03-conversation-top'); });
  await step('busy', async () => { await review.evaluate(`(() => { const f = window.__modelReview; f.snapshot.status = 'busy'; f.emitAgent({ type: 'run', run: { id: 'r2', status: 'running', startedAt: Date.now() - 12000, finishedAt: null } }); f.emitAgent({ type: 'status', status: 'busy' }); f.emitAgent({ type: 'user-message', id: 'u2', runId: 'r2', order: 10, text: '再把暗色模式下的边框对比度调高一点' }); f.emitAgent({ type: 'assistant-start', id: 'a2', runId: 'r2', order: 11 }); f.emitAgent({ type: 'assistant-thinking', id: 'a2', thinking: '检查 --pd-border 在暗色下的取值……', thinkingStatus: 'streaming' }); f.emitAgent({ type: 'tool', activity: { id: 't3', runId: 'r2', order: 12, tool: 'bash', title: '搜索边框 token', command: 'rg --pd-border packages/ui', status: 'running', detail: '', startedAt: Date.now() - 3000 } }); })()`); await review.settle(); await shot('04-busy'); });
  await step('narrow', async () => { await review.viewport(900, 800); await shot('05-narrow-900'); await review.viewport(1440, 900); });
  await step('workbench', async () => { await review.click('.pd-top-bar-workspace-button'); await review.settle(); await shot('06-workbench'); await review.click('.pd-top-bar-workspace-button'); });
  await step('search', async () => { await review.key('k', { ctrl: true }); await review.settle(); await shot('07-search'); await review.key('Escape'); });
  await step('automation', async () => { await review.click('.pd-activity-automations'); await shot('08-automations'); });
  await step('plugins', async () => { await review.click('.pd-activity-plugins'); await review.waitFor('!document.querySelector(".pd-scoped-error, [role=alert] .pd-error-boundary")', 3000).catch(() => {}); await shot('09-plugins'); });
  const pages = ['常规', '外观', '个性化', '快捷键', '模型管理', '引擎', 'MCP', 'AI 调试接口', '云备份', '会话管理', '更新'];
  await step('settings', async () => { await review.click('.pd-settings-entry'); await review.waitFor('Boolean(document.querySelector(".pd-settings-dialog"))'); });
  for (const [index, page] of pages.entries()) await step('settings-' + page, async () => { await review.clickText('.pd-settings-nav button', page); await new Promise(r => setTimeout(r, 300)); await shot(`s${String(index).padStart(2, '0')}-settings`); });
  await step('close', () => review.key('Escape'));
  await review.record("auditErrors", JSON.stringify(errors));
  if (errors.length) throw new Error("UI audit: " + errors.join(" / "));
}
