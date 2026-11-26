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
  await review.assert('document.querySelector("[data-agent-id=zcode]").textContent.includes("社区") && !document.querySelector("[data-agent-id=claude-code]").textContent.includes("社区")', 'A community ACP adapter is labelled in the agent menu');
  await review.screenshot('agents-menu-empty');

  await review.click('[data-agent-id=claude-code]');
  await review.waitFor(`document.querySelector(${JSON.stringify(trigger)})?.textContent.includes('Claude Code')`);
  await review.assert('window.__modelReview.calls.some(call => call.name === "setSessionAgent" && call.args[0] === "claude-code")', 'Choosing an agent before the first message binds the conversation');
  await review.assert('!document.querySelector(".pd-composer-thinking-trigger") && !document.querySelector(".pd-context-trigger") && document.querySelector(".pd-composer-model-trigger").textContent.includes("Sonnet")', 'An ACP conversation hides thinking and context controls and shows the agent model');
  await review.waitFor('document.querySelector(".pd-composer-quota [data-kind=five_hour]")?.textContent.includes("已用 37%")');
  await review.assert(`(() => {
    const quota = document.querySelector(".pd-composer-quota");
    const rows = [...quota.querySelectorAll(".pd-agent-quota-row")];
    const weekly = quota.querySelector("[data-kind=weekly]");
    return rows.length === 2 && rows[0].querySelector(".pd-agent-quota-label").textContent === "5 小时额度" && rows[0].querySelector(".pd-agent-quota-reset").textContent.endsWith("重置")
      && weekly.classList.contains("is-warning") && weekly.querySelector(".pd-agent-quota-bar > span").style.width === "86%" && weekly.textContent.includes("已用 86%")
      && quota.title.includes("套餐：max") && quota.title.includes("Opus") && !quota.closest(".pd-conversation-metrics");
  })()`, 'An agent conversation shows the 5-hour and weekly limits under the composer as labelled bars with usage and reset time, warning near the limit');
  await review.assert('document.querySelector(".pd-composer-quota").getBoundingClientRect().top >= document.querySelector(".pd-composer-shell").getBoundingClientRect().bottom', 'The limits sit below the composer');
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
    // The host lists its approval setting first.
    agent.options.unshift({ id: '__desktop_approval', name: 'approval (host label)', category: 'approval', currentValue: 'bypass', values: [{ value: 'bypass', name: 'bypass (host label)' }, { value: 'agent', name: 'agent (host label)' }] });
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

  // Agent session settings: one panel holds the model (left) and reasoning effort (right); the rest share one menu.
  await review.assert('!document.querySelector(".pd-composer-agent-effort-trigger") && document.querySelector(".pd-composer-model-trigger .pd-composer-model-effort")?.textContent === "Medium" && Boolean(document.querySelector(".pd-composer-agent-options-trigger"))', 'The model button shows the reasoning effort; there is no separate effort button, and the options menu appears');
  await review.click('.pd-composer-model-trigger');
  const panel = '.pd-composer-config-popover.is-agentModel.has-effort';
  await review.waitFor(`document.querySelectorAll(${JSON.stringify(panel + ' [data-picker-column=model] [role=menuitemradio]')}).length === 2 && document.querySelectorAll(${JSON.stringify(panel + ' [data-picker-column=effort] [role=menuitemradio]')}).length === 3`);
  await review.assert(`(() => { const popup = document.querySelector(${JSON.stringify(panel)}); const models = popup.querySelector('[data-picker-column=model]').getBoundingClientRect(); const effort = popup.querySelector('[data-picker-column=effort]').getBoundingClientRect(); return popup.textContent.includes('Most capable model') && models.right <= effort.left + 1 && Math.abs(models.top - effort.top) <= 1 && popup.querySelector('[data-picker-column=effort] .pd-composer-provider-heading').textContent === '推理强度'; })()`, 'Models sit on the left and reasoning effort on the right of one panel, with the agent descriptions');
  await review.assert('document.activeElement?.closest("[data-picker-column=model]") && document.activeElement.getAttribute("aria-checked") === "true"', 'The current model has focus when the panel opens');
  await review.key('ArrowRight');
  await review.assert('document.activeElement?.closest("[data-picker-column=effort]") && document.activeElement.dataset.optionValue === "medium"', 'Arrow right moves to the current effort');
  await review.key('ArrowLeft');
  await review.assert('Boolean(document.activeElement?.closest("[data-picker-column=model]"))', 'Arrow left returns to the models');
  await review.screenshot('agents-acp-models-effort');
  await review.click(panel + ' [data-model-id=opus]');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "setModel" && call.args[1] === "opus")');
  await review.assert(`Boolean(document.querySelector(${JSON.stringify(panel)}))`, 'Choosing a model keeps the panel open for the effort');
  await review.click(panel + ' [data-picker-column=effort] [data-option-value=high]');
  await review.waitFor('!document.querySelector(".pd-composer-config-popover") && document.querySelector(".pd-composer-model-trigger .pd-composer-model-effort")?.textContent === "High"');
  await review.assert('window.__modelReview.calls.some(call => call.name === "setAgentOption" && call.args[0] === "reasoning_effort" && call.args[1] === "high")', 'Choosing an effort changes the agent option and closes the panel');
  await review.click('.pd-composer-agent-options-trigger');
  await review.waitFor('document.querySelectorAll(".pd-composer-config-popover.is-agentOptions [role=group]").length === 3');
  // The desktop's approval setting follows the app language, not the label the host sent.
  const approval = '.pd-composer-config-popover.is-agentOptions [data-option-id=__desktop_approval]';
  await review.assert(`(() => { const group = document.querySelector(${JSON.stringify(approval)}); return group.getAttribute('aria-label') === '权限审批' && group.querySelector('[data-option-value=bypass]').getAttribute('aria-checked') === 'true' && group.querySelector('[data-option-value=bypass]').textContent.includes('自动通过 Agent 的所有权限请求') && group.querySelector('[data-option-value=agent]').textContent.includes('Agent 默认') && !group.textContent.includes('host label'); })()`, 'The approval setting is listed in the app language with bypass chosen');
  await review.screenshot('agents-acp-options');
  await review.click('.pd-composer-config-popover.is-agentOptions [data-option-id=mode] [data-option-value=read-only]');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "setAgentOption" && call.args[0] === "mode" && call.args[1] === "read-only")');
  await review.key('Escape');
  await review.click('.pd-composer-agent-options-trigger');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(approval + ' [data-option-value=agent]')}))`);
  await review.click(approval + ' [data-option-value=agent]');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "setAgentOption" && call.args[0] === "__desktop_approval" && call.args[1] === "agent")');
  await review.key('Escape');

  await review.viewport(680, 520);
  await review.evaluate(`(() => {
    const state = window.__modelReview, s = state.snapshot;
    s.agent = { ...s.agent, options: s.agent.options.map(option => ({ ...option, values: option.values.map(value => ({ ...value, name: option.category === 'thought_level' ? value.name.repeat(28) : value.name })) })).concat(
      Array.from({length: 9}, (_, index) => ({ id: 'extra-' + index, name: 'Extra option ' + index, currentValue: 'off', values: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'Enable ' + 'LongValue'.repeat(18) }] }))) };
    state.emitAgent({ type: 'model', agent: s.agent, model: s.model, modelName: s.modelName, modelProvider: s.modelProvider, thinkingLevel: s.thinkingLevel, availableThinkingLevels: s.availableThinkingLevels, contextUsage: null });
  })()`);
  await review.click('.pd-composer-agent-options-trigger');
  await review.waitFor('Boolean(document.querySelector(".is-agentOptions [data-option-id=extra-8]"))');
  await review.assert(`(() => { const gear = document.querySelector('.pd-composer-agent-options-trigger').getBoundingClientRect(); const send = document.querySelector('.pd-send-button').getBoundingClientRect(); return gear.right <= send.left && send.right <= innerWidth; })()`, 'A long reasoning label leaves the Agent options and send controls visible');
  await review.evaluate(`(() => { const list = document.querySelector('.is-agentOptions .pd-composer-thinking-options'); list.scrollTop = list.scrollHeight; })()`);
  await review.assert(`(() => { const popup = document.querySelector('.is-agentOptions'); const list = popup.querySelector('.pd-composer-thinking-options'); const close = popup.querySelector('.pd-composer-picker-head button'); const rect = close.getBoundingClientRect(); return list.scrollTop > 0 && close.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()`, 'The close button stays clickable when the Agent options list scrolls');
  await review.screenshot('agents-acp-options-narrow');
  await review.click('.is-agentOptions [data-option-id=extra-8] [data-option-value=on]');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "setAgentOption" && call.args[0] === "extra-8" && call.args[1] === "on")');
  const agentCount = await review.evaluate(`(() => {
    const agents = window.__modelReview.agents, count = agents.length;
    const template = agents.find(agent => agent.id === 'review-agent');
    for (let index = 0; index < 12; index += 1) agents.push({ ...template, id: 'extra-agent-' + index, displayName: 'Extra Agent ' + index });
    return count;
  })()`);
  await review.click(trigger);
  await review.waitFor('Boolean(document.querySelector(".is-agent [data-agent-id=extra-agent-11]"))');
  await review.evaluate(`(() => { const list = document.querySelector('.is-agent .pd-composer-agent-options'); list.scrollTop = list.scrollHeight; })()`);
  await review.assert(`(() => { const list = document.querySelector('.is-agent .pd-composer-agent-options'); const manage = document.querySelector('.is-agent .pd-composer-model-actions button'); const rect = manage.getBoundingClientRect(); return list.scrollTop > 0 && manage.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()`, 'Manage Agents stays visible when the Agent list scrolls');
  await review.key('Escape');
  await review.evaluate(`window.__modelReview.agents.splice(${agentCount})`);
  await review.viewport(1440, 1000);

  // While an external agent replies, the composer keeps the draft instead of queueing it.
  await review.evaluate('window.__modelReview.snapshot.status = "busy"; window.__modelReview.emitAgent({type:"status",status:"busy"})');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea")?.placeholder.includes("Claude Code 回复中")');
  await review.fill('.pd-composer-shell textarea', '再补一个测试');
  await review.key('Enter');
  await review.waitFor('document.querySelector(".pd-composer-error")?.textContent.includes("不支持在回复过程中追加消息")');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value === "再补一个测试" && !window.__modelReview.calls.some(call => call.name === "submitInput" || call.name === "prompt")', 'A message typed while the agent replies stays in the composer and is not sent');
  await review.screenshot('agents-acp-busy');
  await review.fill('.pd-composer-shell textarea', '');

  // An agent that takes mid-turn input (Antigravity) gets the message right away, as steering.
  await review.evaluate(`(() => { const s = window.__modelReview.snapshot; s.agent = { ...s.agent, capabilities: { ...s.agent.capabilities, steer: true } }; window.__modelReview.emitAgent({ type: 'model', agent: s.agent, model: s.model, modelName: s.modelName, modelProvider: s.modelProvider, thinkingLevel: s.thinkingLevel, availableThinkingLevels: s.availableThinkingLevels, contextUsage: null }); })()`);
  await review.waitFor('document.querySelector(".pd-composer-shell textarea")?.placeholder.includes("发送的消息会插入当前回复")');
  await review.fill('.pd-composer-shell textarea', '改成只看 README');
  await review.key('Enter');
  await review.waitFor('window.__modelReview.calls.some(call => (call.name === "submitInput" && call.args[0]?.behavior === "steer" && call.args[0]?.text === "改成只看 README") || (call.name === "prompt" && call.args[1] === "steer"))');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea")?.value === ""');
  await review.assert('!document.querySelector(".pd-composer-error")', 'A steering agent receives the message instead of refusing it');
  await review.screenshot('agents-acp-steer');
  await review.evaluate(`(() => { const s = window.__modelReview.snapshot; s.agent = { ...s.agent, capabilities: { ...s.agent.capabilities, steer: false } }; window.__modelReview.emitAgent({ type: 'model', agent: s.agent, model: s.model, modelName: s.modelName, modelProvider: s.modelProvider, thinkingLevel: s.thinkingLevel, availableThinkingLevels: s.availableThinkingLevels, contextUsage: null }); })()`);
  await review.evaluate('window.__modelReview.snapshot.status = "idle"; window.__modelReview.emitAgent({type:"status",status:"idle"})');

  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', 'Agents');
  await review.waitFor('Boolean(document.querySelector("[data-settings-page=agents] .pd-mcp-server"))');
  await review.assert('document.querySelectorAll("[data-settings-page=agents] .pd-mcp-server").length === 6 && document.querySelector("[data-settings-page=agents]").textContent.includes("npm install -g @agentclientprotocol/codex-acp")', 'The Agents page lists every agent with its install hint');
  await review.assert('(() => { const card = [...document.querySelectorAll("[data-settings-page=agents] .pd-mcp-server")].find((item) => item.textContent.includes("ZCode")); return card && card.textContent.includes("社区 ACP") && card.querySelector(".pd-agent-note")?.textContent.includes("非官方") && card.textContent.includes("yolo"); })()', 'A community ACP adapter is marked as such on its settings card, with its note');
  await review.assert('![...document.querySelectorAll("[data-settings-page=agents] .pd-mcp-server")].find((item) => item.textContent.includes("Claude Code")).querySelector(".pd-agent-note")', 'Official adapters carry no community note');
  await review.waitFor('document.querySelectorAll("[data-agent-quota=claude-code] [role=meter]").length === 3');
  await review.assert('document.querySelector("[data-agent-quota=claude-code]").textContent.includes("已用 37%") && document.querySelector("[data-agent-quota=claude-code]").textContent.includes("max") && !document.querySelector("[data-agent-quota=codex]") && !document.querySelector("[data-agent-quota=zcode]")', 'Ready agents with plan limits show them on their card; others show none');
  await review.waitFor('document.querySelectorAll("[data-agent-quota=antigravity] [role=meter]").length === 4');
  await review.assert('document.querySelector("[data-agent-quota=antigravity]").textContent.includes("Gemini Models · 5 小时额度") && document.querySelector("[data-agent-quota=antigravity]").textContent.includes("Claude and GPT models · 每周额度")', 'Agents with several limit groups name the group of each window');
  await review.evaluate('document.querySelector("[data-agent-quota=antigravity]").scrollIntoView({ block: "center" })');
  await review.screenshot('agents-settings-antigravity-quota');
  await review.clickText('[data-settings-page=agents] footer button', '清除已记住的命令');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "clearAntigravityCommandApprovals") && [...document.querySelectorAll("[data-settings-page=agents] [role=status]")].some(status => status.textContent.includes("已清除"))');
  await review.evaluate('document.querySelector("[data-settings-page=agents] .pd-mcp-server").scrollIntoView({ block: "start" })');
  await review.click('[data-agent-quota=claude-code] button');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "readAgentQuota" && call.args[0] === "claude-code" && call.args[1] === true)');
  await review.screenshot('agents-settings');
  await review.evaluate('[...document.querySelectorAll("[data-settings-page=agents] .pd-mcp-server")].find((item) => item.textContent.includes("ZCode")).scrollIntoView({ block: "center" })');
  await review.screenshot('agents-settings-community');
  await review.evaluate('document.querySelector("[data-settings-page=agents] .pd-mcp-server").scrollIntoView({ block: "start" })');

  // One-click install: confirm first, then live output, then a re-check and the sign-in step.
  const codexCard = '[data-settings-page=agents] .pd-mcp-server:nth-child(2)';
  await review.assert(`(() => { const card = document.querySelector('${codexCard}'); const hint = card.querySelector('.pd-agent-install-hint'); return getComputedStyle(card).borderTopColor === getComputedStyle(document.querySelector('[data-settings-page=agents] .pd-mcp-server.is-connected')).borderTopColor && card.querySelector('.pd-agent-status.is-install') && [...hint.querySelectorAll('button')].some(button => button.textContent.trim() === '安装'); })()`, 'An agent to install keeps a neutral frame, shows its state in a pill, and offers install inside its hint');
  await review.clickText(`${codexCard} .pd-agent-install-hint button`, '安装');
  await review.waitFor('document.querySelector(".pd-agent-install-confirm")?.open === true');
  await review.assert('document.querySelector(".pd-agent-install-confirm").textContent.includes("npm install -g @agentclientprotocol/codex-acp") && !window.__modelReview.calls.some(call => call.name === "installAgent")', 'Install asks for confirmation with the exact command before running anything');
  await review.screenshot('agents-install-confirm');
  await review.clickText('.pd-agent-install-confirm button', '确认安装');
  await review.waitFor('Boolean(document.querySelector(".pd-agent-install.is-running"))');
  await review.assert('window.__modelReview.calls.some(call => call.name === "installAgent" && call.args[0] === "codex")', 'Confirming starts the install of that agent only');
  await review.evaluate(`window.__modelReview.emit('onAgentInstallEvent', { agentId: 'codex', phase: 'running', command: 'npm install -g @agentclientprotocol/codex-acp', output: '> npm install -g @agentclientprotocol/codex-acp\\n\\nadded 112 packages in 9s', startedAt: 1 })`);
  await review.waitFor('document.querySelector(".pd-agent-install-output")?.textContent.includes("added 112 packages")');
  await review.assert('[...document.querySelectorAll(".pd-agent-install button")].some(button => button.textContent === "停止")', 'A running install can be stopped');
  await review.screenshot('agents-install-running');
  await review.evaluate(`(() => {
    const state = window.__modelReview;
    Object.assign(state.agents.find(agent => agent.id === 'codex'), { readiness: 'ready', version: '0.14.0', resolvedCommand: 'C:\\\\review\\\\npm\\\\codex-acp.cmd', message: undefined });
    state.emit('onAgentInstallEvent', { agentId: 'codex', phase: 'succeeded', command: 'npm install -g @agentclientprotocol/codex-acp', output: '> npm install -g @agentclientprotocol/codex-acp\\n\\nadded 112 packages in 9s', startedAt: 1, finishedAt: 2, exitCode: 0 });
  })()`);
  await review.waitFor('Boolean(document.querySelector(".pd-agent-install.is-succeeded")) && window.__modelReview.calls.some(call => call.name === "probeAgents")');
  await review.waitFor(`document.querySelector('${codexCard} .pd-mcp-status')?.textContent === '可用'`);
  await review.assert(`document.querySelector('${codexCard}').textContent.includes('下一步：登录') && [...document.querySelectorAll('${codexCard} footer button')].some(button => button.textContent === '在终端中登录')`, 'A finished install re-checks readiness and points to sign-in');
  await review.screenshot('agents-install-done');
  await review.clickText(`${codexCard} footer button`, '在终端中登录');
  await review.waitFor('window.__modelReview.calls.some(call => call.name === "openAgentLogin" && call.args[0] === "codex")');
  await review.assert('![...document.querySelectorAll("[data-settings-page=agents] .pd-mcp-server:nth-child(6) button")].some(button => button.textContent === "在终端中登录" || button.textContent === "安装")', 'Custom agents offer neither install nor terminal sign-in');
  await review.viewport(600, 800);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'The Agents page fits a narrow window');
  await review.screenshot('agents-settings-narrow');
}
