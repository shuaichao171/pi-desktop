// External ACP agents in the renderer: composer picker, capability gating,
// the locked-agent handoff row and the Agents settings page. Fixture data only.
export default async function agentsScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  const trigger = '.pd-composer-agent-trigger';
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(trigger)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(trigger)}).textContent.includes('Pi') && Boolean(document.querySelector('.pd-composer-thinking-trigger'))`, 'A Pi conversation shows the agent picker next to the Pi model and thinking controls');

  await review.click(trigger);
  await review.waitFor('Boolean(document.querySelector(".pd-composer-agent-options [data-agent-id=claude-code]"))');
  await review.assert('document.querySelector("[data-agent-id=codex]").disabled && document.querySelector("[data-agent-id=codex]").textContent.includes("未安装")', 'An agent missing from PATH is listed but cannot be chosen');
  await review.assert('!document.querySelector("[data-agent-id=gemini]") && Boolean(document.querySelector("[data-agent-id=review-agent]"))', 'Disabled agents are hidden; custom agents are listed');
  await review.assert('!document.querySelector(".pd-composer-agent-note")', 'An empty conversation chooses its agent directly, without the handoff note');
  await review.screenshot('agents-menu-empty');

  await review.click('[data-agent-id=claude-code]');
  await review.waitFor(`document.querySelector(${JSON.stringify(trigger)})?.textContent.includes('Claude Code')`);
  await review.assert('window.__modelReview.calls.some(call => call.name === "setSessionAgent" && call.args[0] === "claude-code")', 'Choosing an agent before the first message binds the conversation');
  await review.assert('!document.querySelector(".pd-composer-thinking-trigger") && !document.querySelector(".pd-context-trigger") && document.querySelector(".pd-composer-model-trigger").textContent.includes("Sonnet")', 'An ACP conversation hides thinking and context controls and shows the agent model');
  await review.screenshot('agents-acp-composer');

  await review.click('.pd-composer-model-trigger');
  await review.waitFor('document.querySelectorAll(".pd-composer-config-popover.is-agentModel [role=menuitemradio]").length === 2');
  await review.screenshot('agents-acp-models');
  await review.key('Escape');

  // A conversation that came from a handoff: locked agent, link row, Pi-only actions hidden.
  await review.reloadWithFixture(`(() => {
    const state = window.__modelReview;
    const agent = { id: 'claude-code', kind: 'acp', displayName: 'Claude Code', accentColor: '#D97757', capabilities: { streamsThinking: true, interrupt: true, steer: false, thinkingLevels: false, slashCommands: true, extensions: false, images: false, session: { branch: false, fork: false, editUserMessage: false, rewind: false } }, models: [{ id: 'sonnet', name: 'Sonnet', description: 'Fast, go-to model for everyday work.' }, { id: 'opus', name: 'Opus', description: 'Most capable model for complex work.' }], currentModelId: 'sonnet',
      options: [
        { id: 'reasoning_effort', name: '推理强度', category: 'thought_level', currentValue: 'medium', values: [{ value: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' }, { value: 'medium', name: 'Medium', description: 'Balances speed and reasoning depth' }, { value: 'high', name: 'High', description: 'Greater reasoning depth for complex problems' }] },
        { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'agent', values: [{ value: 'read-only', name: 'Read-only', description: 'Requires approval to edit files' }, { value: 'agent', name: 'Auto review', description: 'Only ask for actions detected as potentially unsafe' }] },
        { id: 'fast-mode', name: 'Fast mode', category: 'speed', currentValue: 'off', values: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On', description: '1.5x speed, increased usage' }] },
      ] };
    Object.assign(state.snapshot, { agent, model: 'sonnet', modelName: 'Sonnet', modelProvider: 'acp:claude-code', thinkingLevel: 'off', availableThinkingLevels: ['off'], historyTotal: 3, messages: [
      { id: 'handoff-1', order: 0, role: 'system', systemKind: 'handoff', text: '上下文交接：Pi → Claude Code', status: 'done', handoff: { direction: 'from', sessionPath: 'C:\\\\renderer-review\\\\earlier.jsonl', fromAgent: 'Pi', toAgent: 'Claude Code' } },
      { id: 'user-1', order: 1, role: 'user', text: '接着把设置页做完', status: 'done' },
      { id: 'assistant-1', order: 2, role: 'assistant', text: '好的，我先检查现有的设置面板结构。', status: 'done' },
    ] });
  })();`);
  await review.waitFor('Boolean(document.querySelector(".pd-handoff-row"))');
  await review.assert('document.querySelector(".pd-handoff-row").textContent.includes("从 Pi 交接而来") && document.querySelector(".pd-handoff-row button").textContent === "打开原对话"', 'The handoff row names the source agent and links back');
  await review.assert('!document.querySelector(".pd-message-row.is-user .pd-message-action[aria-label=\\"编辑\\"]") && !document.querySelector(".pd-message-action[aria-label=\\"分叉\\"]")', 'Edit and fork are hidden for an external agent');
  await review.assert('[...document.querySelectorAll(".pd-assistant-heading")].every(heading => heading.textContent.includes("Claude Code"))', 'Replies are attributed to the conversation agent');
  await review.click(trigger);
  await review.waitFor('Boolean(document.querySelector(".pd-composer-agent-note"))');
  await review.assert('document.querySelector("[data-agent-id=pi]").textContent.includes("交接") && document.querySelector("[data-agent-id=claude-code]").getAttribute("aria-checked") === "true"', 'A started conversation offers other agents as handoffs');
  await review.screenshot('agents-menu-locked');
  await review.key('Escape');

  // Agent session settings: reasoning effort on its own control, the rest in one menu.
  await review.assert('document.querySelector(".pd-composer-agent-effort-trigger")?.textContent.includes("Medium") && Boolean(document.querySelector(".pd-composer-agent-options-trigger"))', 'Reasoning effort and the options menu appear for an agent that exposes them');
  await review.click('.pd-composer-model-trigger');
  await review.waitFor('document.querySelectorAll(".pd-composer-config-popover.is-agentModel [role=menuitemradio]").length === 2');
  await review.assert('document.querySelector(".pd-composer-config-popover.is-agentModel").textContent.includes("Most capable model")', 'Model choices carry the agent descriptions');
  await review.key('Escape');
  await review.click('.pd-composer-agent-effort-trigger');
  await review.waitFor('document.querySelectorAll(".pd-composer-config-popover.is-agentEffort [role=menuitemradio]").length === 3');
  await review.screenshot('agents-acp-effort');
  await review.click('.pd-composer-config-popover.is-agentEffort [data-option-value=high]');
  await review.waitFor('document.querySelector(".pd-composer-agent-effort-trigger")?.textContent.includes("High")');
  await review.assert('window.__modelReview.calls.some(call => call.name === "setAgentOption" && call.args[0] === "reasoning_effort" && call.args[1] === "high")', 'Choosing an effort changes the agent option');
  await review.click('.pd-composer-agent-options-trigger');
  await review.waitFor('document.querySelectorAll(".pd-composer-config-popover.is-agentOptions [role=group]").length === 2');
  await review.screenshot('agents-acp-options');
  await review.click('.pd-composer-config-popover.is-agentOptions [data-option-id=mode] [data-option-value=read-only]');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "setAgentOption" && call.args[0] === "mode" && call.args[1] === "read-only")');
  await review.key('Escape');

  // While an external agent replies, the composer keeps the draft instead of queueing it.
  await review.evaluate('window.__modelReview.snapshot.status = "busy"; window.__modelReview.emitAgent({type:"status",status:"busy"})');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea")?.placeholder.includes("Claude Code 回复中")');
  await review.fill('.pd-composer-shell textarea', '再补一个测试');
  await review.key('Enter');
  await review.waitFor('document.querySelector(".pd-composer-error")?.textContent.includes("不支持在回复过程中追加消息")');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value === "再补一个测试" && !window.__modelReview.calls.some(call => call.name === "submitInput" || call.name === "prompt")', 'A message typed while the agent replies stays in the composer and is not sent');
  await review.screenshot('agents-acp-busy');
  await review.fill('.pd-composer-shell textarea', '');
  await review.evaluate('window.__modelReview.snapshot.status = "idle"; window.__modelReview.emitAgent({type:"status",status:"idle"})');

  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', 'Agents');
  await review.waitFor('Boolean(document.querySelector("[data-settings-page=agents] .pd-mcp-server"))');
  await review.assert('document.querySelectorAll("[data-settings-page=agents] .pd-mcp-server").length === 4 && document.querySelector("[data-settings-page=agents]").textContent.includes("npm install -g @agentclientprotocol/codex-acp")', 'The Agents page lists every agent with its install hint');
  await review.screenshot('agents-settings');
  await review.viewport(600, 800);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'The Agents page fits a narrow window');
  await review.screenshot('agents-settings-narrow');
}
