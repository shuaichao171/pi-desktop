// Renderer-only fixtures. No credentials, model calls, real IPC, or project writes.
export function installModelSettingsFixture(options = {}) {
  const clone = (value) => structuredClone(value);
  const model = (provider, id, name, extra = {}) => ({ provider, id, name, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16000, ...extra });
  const providers = [
    { provider: 'openai', name: 'OpenAI', custom: false, editable: false, configured: true, baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', models: [model('openai', 'gpt-review', 'GPT Review')] },
    { provider: 'review-gateway', name: '团队模型网关', custom: true, editable: true, configured: true, baseUrl: 'https://models.example.invalid/v1', api: 'openai-completions', headerNames: ['X-Review-Version'], useSystemProxy: false, disabledModels: ['hidden-model'], models: [model('review-gateway', 'review-reasoner', '团队推理模型'), model('review-gateway', 'review-fast', '快速模型', { reasoning: false, input: ['text'] }), model('review-gateway', 'hidden-model', '已隐藏模型')] },
    { provider: 'anthropic', name: 'Anthropic', custom: false, editable: false, configured: false, baseUrl: null, api: 'anthropic-messages', models: [model('anthropic', 'claude-review', 'Claude Review')] },
  ];
  const state = {
    calls: [], unexpected: [], ready: false, errors: [], providers,
    delays: {}, failures: {}, pending: {},
    discovery: { models: [{ id: 'discovered-model', name: '新发现模型', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false }, { id: 'metadata-missing', name: '需要核对能力的模型' }], warnings: ['模拟目录：不连接真实供应商'] },
    desktopSettings: { notificationsEnabled: false, closeBehavior: 'quit', conversationStorageDirectory: 'C:\\Users\\review\\PiDesktopWorkspace' },
    pluginCatalog: {
      projectTrusted: true, warnings: [],
      packages: [
        { source: 'npm:@review/pi-git-tools', scope: 'user', name: '@review/pi-git-tools', description: 'Git 提交、分支与 PR 辅助命令', version: '1.2.0', installed: true, path: 'C:\\Users\\review\\.pi\\agent\\packages\\pi-git-tools' },
        { source: 'npm:@review/pi-lint-skills', scope: 'project', name: '@review/pi-lint-skills', description: '项目代码规范技能包', version: '0.4.1', installed: true, path: 'C:\\renderer-review\\project\\.pi\\packages\\pi-lint-skills' },
      ],
      resources: [
        { path: 'C:\\Users\\review\\.pi\\agent\\packages\\pi-git-tools\\extensions\\git.ts', kind: 'extensions', name: 'git', description: '在对话中执行 Git 操作', enabled: true, loaded: true, canToggle: true, scope: 'user', source: 'npm:@review/pi-git-tools', origin: 'package' },
        { path: 'C:\\Users\\review\\.pi\\agent\\extensions\\notify.ts', kind: 'extensions', name: 'notify', description: '任务完成时发送系统通知', enabled: false, loaded: false, canToggle: true, scope: 'user', source: 'local', origin: 'top-level' },
        { path: 'C:\\renderer-review\\project\\.pi\\packages\\pi-lint-skills\\skills\\lint\\SKILL.md', kind: 'skills', name: 'lint', description: '按项目规范检查并修复代码风格', enabled: true, loaded: true, canToggle: true, scope: 'project', source: 'npm:@review/pi-lint-skills', origin: 'package' },
        { path: 'C:\\Users\\review\\.pi\\agent\\prompts\\review.md', kind: 'prompts', name: 'review', description: '代码审查提示词', enabled: true, loaded: true, canToggle: true, scope: 'user', source: 'local', origin: 'top-level' },
      ],
    },
    engineStatus: { builtinVersion: '1.4.0', selection: { mode: 'builtin', version: '1.4.0' }, active: { mode: 'builtin', version: '1.4.0' }, pendingRestart: false },
    mcpServers: [
      { id: 'filesystem', name: 'filesystem', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], requestTimeoutMs: 30000, scope: 'user', status: 'connected', tools: [{ name: 'read_file', registeredName: 'filesystem_read_file', description: '读取文件内容' }, { name: 'list_directory', registeredName: 'filesystem_list_directory', description: '列出目录' }] },
      { id: 'docs', name: 'docs', enabled: true, transport: 'http', url: 'https://mcp.example.invalid/docs', requestTimeoutMs: 30000, scope: 'project', status: 'error', error: '连接被拒绝（ECONNREFUSED）', tools: [] },
    ],
    mcpCliServers: [],
    // External ACP agents: one ready, one missing from PATH, one custom (all fictional commands).
    agents: [
      { id: 'claude-code', displayName: 'Claude Code', command: 'claude-agent-acp', args: [], enabled: true, builtin: true, accentColor: '#D97757', installHint: 'npm install -g @agentclientprotocol/claude-agent-acp', installer: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp' }, login: { command: 'claude-agent-acp', args: ['--cli'] }, loginHint: '在打开的 Claude Code 里输入 /login 完成登录', quota: 'claude', readiness: 'ready', version: '0.9.0', resolvedCommand: 'C:\\review\\bin\\claude-agent-acp.cmd' },
      { id: 'codex', displayName: 'Codex', command: 'codex-acp', args: [], enabled: true, builtin: true, accentColor: '#10A37F', installHint: 'npm install -g @agentclientprotocol/codex-acp', installer: { kind: 'npm', package: '@agentclientprotocol/codex-acp' }, login: { command: 'codex-acp', args: ['login'] }, loginHint: '或在终端运行 codex login', quota: 'codex', readiness: 'install', version: null, resolvedCommand: null, message: '未找到命令 codex-acp' },
      { id: 'antigravity', displayName: 'Antigravity', command: 'agy', args: ['acp'], enabled: true, builtin: true, accentColor: '#3186FF', quota: 'antigravity', readiness: 'ready', version: '1.5.17', resolvedCommand: 'C:\\review\\agy\\agy.exe' },
      { id: 'gemini', displayName: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], enabled: false, builtin: true, accentColor: '#4285F4', installHint: 'npm install -g @google/gemini-cli', readiness: 'disabled', version: null, resolvedCommand: null },
      { id: 'zcode', displayName: 'ZCode', command: 'zcode-acp-server', args: [], enabled: true, builtin: true, accentColor: '#2F6BFF', installHint: 'npm install -g zcode-acp-server', installer: { kind: 'npm', package: 'zcode-acp-server' }, login: { command: 'zcode-acp', args: ['setup', '--provider', 'bigmodel'] }, community: true, note: '需要本机已安装 ZCode（桌面版或 CLI 0.14.8 以上）；它默认使用 yolo 模式，不经确认执行操作，可在 Agent 选项中切换。', readiness: 'ready', version: '0.94.0', resolvedCommand: 'C:\review\bin\zcode-acp-server.cmd' },
      { id: 'review-agent', displayName: 'Review Agent', command: 'C:\\review\\agent.exe', args: ['--acp'], env: { REVIEW_MODE: '1' }, enabled: true, builtin: false, accentColor: null, readiness: 'ready', version: '1.0.0', resolvedCommand: 'C:\\review\\agent.exe' },
    ],
    cloudSync: { configured: false, config: null, status: { lastUploadAt: null, lastAutoSyncAt: null, lastError: null, pending: false } },
    machineSessions: [
      { path: 'C:\\Users\\review\\.pi\\agent\\sessions\\project\\a.jsonl', id: 'machine-a', name: '重构设置面板的卡片布局', firstMessage: '重构设置面板的卡片布局', modified: '2026-10-30T08:00:00Z', messageCount: 12, cwd: 'C:\\renderer-review\\project', registered: true, running: false, bytes: 48213 },
      { path: 'C:\\Users\\review\\.pi\\agent\\sessions\\legacy\\b.jsonl', id: 'machine-b', firstMessage: '旧项目里的一次调试', modified: '2026-09-12T02:30:00Z', messageCount: 4, cwd: 'D:\\legacy\\tool', registered: false, running: false, bytes: 9120 },
    ],
    workspaceEntries: {
      '': [{ name: 'src', path: 'src', kind: 'directory' }, { name: 'package.json', path: 'package.json', kind: 'file', size: 812 }, { name: 'README.md', path: 'README.md', kind: 'file', size: 1460 }],
      src: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file', size: 320 }],
    },
    workspaceFiles: { 'package.json': '{\n  "name": "review-project",\n  "private": true\n}\n', 'README.md': '# Review project\n', 'src/index.ts': 'export const ready = true;\n' },
    gitLog: [
      { hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', shortHash: 'a1b2c3d', author: 'Review', date: '2026-10-30T08:00:00Z', subject: 'feat: 设置面板卡片布局' },
      { hash: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890', shortHash: 'b2c3d4e', author: 'Review', date: '2026-10-29T08:00:00Z', subject: 'fix: 窄窗口横向滚动' },
    ],
    snapshot: { sequence: 0, status: 'idle', model: 'gpt-review', modelName: 'GPT Review', modelProvider: 'openai', thinkingLevel: 'medium', availableThinkingLevels: ['off', 'low', 'medium', 'high'], contextUsage: null, cwd: 'C:\\renderer-review\\project', sessionId: 'model-review-session', sessionPath: 'C:\\renderer-review\\session.jsonl', messages: [], activities: [], queuedCount: 0, queuedMessages: [], fileChanges: [], historyTotal: 0, error: null },
  };
  const listeners = new Map();
  state.emit = (name, event) => { for (const listener of listeners.get(name) ?? []) listener(clone(event)); };
  state.emitAgent = (event) => { state.snapshot.sequence += 1; state.emit('onAgentEvent', { sequence: state.snapshot.sequence, event }); };
  state.resolvePending = (name, value) => { const pending = state.pending[name]; if (!pending) throw new Error(`No deferred ${name}`); delete state.pending[name]; pending.resolve(value); };
  state.rejectPending = (name, message) => { const pending = state.pending[name]; if (!pending) throw new Error(`No deferred ${name}`); delete state.pending[name]; pending.reject(new Error(message)); };
  state.traceInputs = () => {
    const ids = new WeakMap(); let next = 0;
    const log = (event, phase) => {
      const element = event.target;
      if (!(element instanceof HTMLInputElement)) return;
      if (!ids.has(element)) ids.set(element, ++next);
      const value = element.type === 'password' ? { characters: element.value.length } : element.value;
      console.debug('__MODEL_REVIEW_INPUT__' + JSON.stringify({ type: event.type, phase, field: element.dataset.field ?? element.id, elementId: ids.get(element), value, connected: element.isConnected, active: document.activeElement === element, prevented: event.defaultPrevented, trusted: event.isTrusted }));
    };
    for (const type of ['focusin', 'focusout', 'beforeinput', 'input', 'change']) {
      document.addEventListener(type, (event) => { log(event, 'capture'); queueMicrotask(() => log(event, 'capture-microtask')); }, true);
      document.addEventListener(type, (event) => { log(event, 'bubble'); queueMicrotask(() => log(event, 'bubble-microtask')); });
    }
  };
  const methods = {
    getAgentSnapshot: () => clone(state.snapshot),
    getFileChangeDiffs: (scope) => clone(state.fileDiffByScope?.[JSON.stringify(scope)] ?? state.fileDiffs ?? []),
    getSessionStats: () => clone(state.sessionStats ?? { sessionId: state.snapshot.sessionId, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, timing: { sampledAt: Date.now(), durationMs: state.snapshot.messages.length ? null : 0, running: false, latestRun: null } }),
    getAppInfo: () => ({ appVersion: '0.1.5-review', nodeVersion: '24', electronVersion: 'renderer-fixture', platform: 'win32' }),
    notifyRendererReady: () => { state.ready = true; },
    setAppLocale: () => {},
    listWorkspaces: () => [state.snapshot.cwd],
    listConversationWorkspaces: async () => [await window.piDesktop.getDefaultWorkspace()],
    getDefaultWorkspace: () => state.snapshot.cwd,
    listSessions: () => [],
    // Scenarios that only mock listSessions still load their rows: page over that listing.
    listSessionsPage: async (cwd, offset = 0, limit = Infinity) => {
      const sessions = await window.piDesktop.listSessions(cwd);
      return { sessions: sessions.slice(offset, offset + limit), total: sessions.length, hasMore: offset + limit < sessions.length, revision: 0 };
    },
    // Hovering a conversation row asks for its summary; no summary keeps the title-only preview.
    sessionPreview: () => null,
    // No conversation is hosted in another pane, so activating a row switches the main view.
    focusHostedSession: () => false,
    listSideQuestions: () => [],
    // No remembered branch: the renderer keeps the branch Pi itself loaded.
    getSessionBranchSelection: () => null,
    listPinnedWorkspaces: () => [],
    listSessionGroups: () => [],
    getPendingExtensionDialogs: () => [],
    getWindowChromeState: () => ({ isMaximized: false }),
    getUpdateState: () => ({ phase: 'unavailable', unavailableReason: 'development', currentVersion: '0.1.5-review' }),
    getDesktopSettings: () => clone(state.desktopSettings),
    setDesktopSettings: (patch) => clone(Object.assign(state.desktopSettings, patch)),
    getAppearance: () => clone(state.appearance ?? null),
    setAppearance: (value) => { state.appearance = clone(value); },
    pickConversationStorageDirectory: () => null,
    listSlashCommands: () => [],
    listAgents: () => clone(state.agents),
    probeAgents: () => clone(state.agents),
    saveAgent: (request) => {
      const index = state.agents.findIndex((agent) => agent.id === request.id);
      const previous = index >= 0 ? state.agents[index] : { id: request.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), builtin: false };
      const next = { ...previous, ...request, id: previous.id, readiness: request.enabled ? 'ready' : 'disabled', version: request.enabled ? '1.0.0' : null, resolvedCommand: request.enabled ? request.command : null };
      if (index >= 0) state.agents[index] = next; else state.agents.push(next);
      return clone(state.agents);
    },
    installAgent: (id) => {
      const agent = state.agents.find((item) => item.id === id);
      return { agentId: id, phase: 'running', command: agent.installHint, output: `> ${agent.installHint}\n`, startedAt: 1 };
    },
    cancelAgentInstall: () => {},
    listAgentInstalls: () => [],
    openAgentLogin: () => {},
    // Plan limits: Claude Code reports a near-full week; anything else has no plan limits.
    readAgentQuota: (agentId) => {
      const now = Date.now();
      if (agentId === 'claude-code') return { agentId, ok: true, queriedAt: now, plan: 'max', windows: [{ kind: 'five_hour', usedPercent: 37, resetsAt: now + 2 * 3600_000 }, { kind: 'weekly', usedPercent: 86, resetsAt: now + 3 * 86400_000 }, { kind: 'other', label: 'Opus', usedPercent: 8, resetsAt: null }] };
      // Antigravity: each model group has its own windows.
      if (agentId === 'antigravity') return { agentId, ok: true, queriedAt: now, plan: null, windows: [{ kind: 'weekly', group: 'Gemini Models', usedPercent: 1.22, resetsAt: now + 6 * 86400_000 }, { kind: 'five_hour', group: 'Gemini Models', usedPercent: 12, resetsAt: now + 4 * 3600_000 }, { kind: 'weekly', group: 'Claude and GPT models', usedPercent: 0, resetsAt: null }, { kind: 'five_hour', group: 'Claude and GPT models', usedPercent: 64, resetsAt: now + 3600_000 }] };
      return { agentId, ok: true, queriedAt: now, windows: [] };
    },
    removeAgent: (id) => { state.agents = state.agents.filter((agent) => agent.id !== id || agent.builtin); return clone(state.agents); },
    clearAntigravityCommandApprovals: () => undefined,
    setSessionAgent: (agentId) => {
      const config = state.agents.find((agent) => agent.id === agentId);
      const agent = agentId === 'pi'
        ? { id: 'pi', kind: 'pi', displayName: 'Pi', accentColor: null, capabilities: { streamsThinking: true, interrupt: true, steer: true, thinkingLevels: true, slashCommands: true, extensions: true, images: true, session: { branch: true, fork: true, editUserMessage: true, rewind: true } } }
        : { id: agentId, kind: 'acp', displayName: config.displayName, accentColor: config.accentColor, capabilities: { streamsThinking: true, interrupt: true, steer: false, thinkingLevels: false, slashCommands: true, extensions: false, images: false, session: { branch: false, fork: false, editUserMessage: false, rewind: false } }, models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }], currentModelId: 'sonnet', ...(config.quota ? { quota: true } : {}) };
      Object.assign(state.snapshot, { agent, ...(agentId === 'pi' ? {} : { model: 'sonnet', modelName: 'Sonnet', modelProvider: `acp:${agentId}`, thinkingLevel: 'off', availableThinkingLevels: ['off'] }) });
      state.emitAgent({ type: 'model', agent, model: state.snapshot.model, modelName: state.snapshot.modelName, modelProvider: state.snapshot.modelProvider, thinkingLevel: state.snapshot.thinkingLevel, availableThinkingLevels: state.snapshot.availableThinkingLevels, contextUsage: null });
    },
    // Sends are only recorded; the reply is driven by the scenario's own events.
    submitInput: (request) => ({ id: request.id, state: 'accepted' }),
    setAgentOption: (optionId, value) => {
      const agent = state.snapshot.agent;
      agent.options = (agent.options ?? []).map((option) => option.id === optionId ? { ...option, currentValue: value } : option);
      state.emitAgent({ type: 'model', agent, model: state.snapshot.model, modelName: state.snapshot.modelName, modelProvider: state.snapshot.modelProvider, thinkingLevel: state.snapshot.thinkingLevel, availableThinkingLevels: state.snapshot.availableThinkingLevels, contextUsage: null });
    },
    getWorkspaceBranches: () => ({ isRepository: true, current: 'review-fixture', detached: false, branches: ['review-fixture'] }),
    getWorkspaceGitStatus: () => ({ isRepository: true, branch: 'review-fixture', entries: [], truncated: false }),
    listWorkspaceOpeners: () => [],
    // Activity-bar scenarios open the automation view; provide an empty backend.
    getAutomationSnapshot: () => ({ revision: 0, automations: [], runs: [] }),
    // The workbench subscribes to file-system changes while open (auto refresh).
    watchWorkspace: () => undefined,
    getWorkspaceGitGraph: () => [],
    listModels: () => clone(state.providers.filter((provider) => provider.configured).flatMap((provider) => provider.models.filter((entry) => !provider.disabledModels?.includes(entry.id)))),
    listModelProviders: () => clone(state.providers),
    listProviderAuth: () => state.providers.map(({ provider, configured }) => ({ provider, configured, supportsApiKey: true, ...(configured ? { source: 'stored' } : {}) })),
    discoverProviderModels: () => clone(state.discovery),
    setModel: (provider, id) => {
      const entry = state.providers.find((item) => item.provider === provider)?.models.find((item) => item.id === id);
      if (!entry) throw new Error('Fixture model missing');
      Object.assign(state.snapshot, { modelProvider: provider, model: id, modelName: entry.name });
      state.emitAgent({ type: 'model', modelProvider: provider, model: id, modelName: entry.name, thinkingLevel: state.snapshot.thinkingLevel, availableThinkingLevels: state.snapshot.availableThinkingLevels, contextUsage: null });
    },
    setThinkingLevel: (level) => { state.snapshot.thinkingLevel = level; state.emitAgent({ type: 'thinking-level', level }); },
    setProviderApiKey: (provider) => { state.providers.find((item) => item.provider === provider).configured = true; },
    removeProviderCredential: (provider) => { state.providers.find((item) => item.provider === provider).configured = false; },
    setModelEnabled: (provider, id, enabled) => {
      const entry = state.providers.find((item) => item.provider === provider);
      entry.disabledModels = [...new Set([...(entry.disabledModels ?? []).filter((value) => value !== id), ...(enabled ? [] : [id])])];
    },
    saveCustomProvider: (request) => {
      const index = state.providers.findIndex((entry) => entry.provider === request.provider);
      const previous = index >= 0 ? state.providers[index] : undefined;
      const next = { provider: request.provider, name: request.name || request.provider, custom: true, editable: true, configured: Boolean(request.apiKey || previous?.configured), baseUrl: request.baseUrl, api: request.api, useSystemProxy: request.useSystemProxy ?? previous?.useSystemProxy, headerNames: request.headers ? Object.keys(request.headers) : previous?.headerNames, disabledModels: previous?.disabledModels ?? [], models: request.models.map((entry) => model(request.provider, entry.id, entry.name || entry.id, entry)) };
      if (index >= 0) state.providers[index] = next; else state.providers.push(next);
    },
    removeCustomProvider: (provider) => { state.providers = state.providers.filter((entry) => entry.provider !== provider); },
    saveProviderModels: ({ provider, upsert = [], remove = [] }) => {
      const entry = state.providers.find((item) => item.provider === provider);
      if (!entry) throw new Error('Fixture provider missing');
      const models = entry.models.filter((item) => !remove.includes(item.id));
      for (const value of upsert) {
        const index = models.findIndex((item) => item.id === value.id);
        const next = model(provider, value.id, value.name || value.id, value);
        if (index >= 0) models[index] = next; else models.push(next);
      }
      entry.models = models;
      if (entry.configModelIds) entry.configModelIds = [...new Set([...entry.configModelIds.filter((id) => !remove.includes(id)), ...upsert.map((value) => value.id)])];
    },
    getPersonalization: () => [],
    getInputDraft: () => ({ version: 0, text: '', attachments: [], missing: [] }),
    saveInputDraft: request => ({ version: request.expectedVersion + 1, text: request.text, attachments: [], missing: [] }),
    getInputQueue: () => ({ version: 0, paused: false, items: [] }),
    testProviderModel: (request) => {
      if (state.failures.testProviderModel) throw new Error(state.failures.testProviderModel);
      const ok = state.modelTestOk !== false;
      return { requestId: request.requestId, provider: request.provider, model: request.model, ok, elapsedMs: 231, error: ok ? null : '推理鉴权失败（401），请检查凭据' };
    },
    cancelProviderModelTest: () => undefined,
    recordUiDiagnostic: () => undefined,
    exportDiagnostics: () => ({ path: '/fixture/diagnostics.zip', entries: 1, skipped: [] }),
    getDebugApiState: () => ({ enabled: false, port: 47899, authEnabled: false, token: '', running: false, baseUrl: null }),
    setDebugApiConfig: request => ({ enabled: request.enabled, port: request.port, authEnabled: request.authEnabled, token: request.token ?? '', running: false, baseUrl: null }),
    // GoalBeacon subscribes whenever the bridge exposes these two; the fixture keeps
    // the plugin-only surface invisible instead of letting the unknown-call proxy
    // clone a listener function.
    getGoalSnapshot: () => null,
    getMemoryAvailability: () => ({ pluginReady: false, databaseReady: false, reason: 'renderer fixture' }),
    getProjectNickname: () => ({ nickname: null, hasWorkspaceFile: false }),
    getProjectAppearance: () => ({ bar: null, anim: null }),
    getCompactionSettings: () => ({ version: 'fixture', pi: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, preferencesVersion: 'fixture', preferences: { mode: 'builtin', compressModel: null } }),
    getMagicContextSnapshot: () => ({
      configPath: 'C:\\Users\\review\\.pi\\agent\\magic-context.jsonc', configVersion: 'fixture',
      config: { enabled: false, historian: { model: null, thinkingLevel: null }, embedding: { provider: 'off', model: null, endpoint: null, apiKey: null, apiKeySet: false }, executeThresholdPercentage: null, historyBudgetPercentage: null },
      plugin: { installed: false, enabled: null, installedVersion: null, latestVersion: null, updateAvailable: false, error: null },
    }),
    // Read-only surfaces behind the plugins, engine, MCP, data and workbench pages.
    // Sample data lives on `state` so a scenario can reshape it before opening a page;
    // every write action stays unstubbed and still reports as an unexpected call.
    getPluginCatalog: (cwd) => ({ cwd, ...clone(state.pluginCatalog) }),
    discoverPlugins: () => ({ items: [], total: 0 }),
    listExtensions: () => clone(state.pluginCatalog.resources.filter((item) => item.kind === 'extensions').map(({ path, name, enabled, scope, origin, source }) => ({ path, name, enabled, scope, origin, source }))),
    getPiEngineStatus: () => clone(state.engineStatus),
    getMcpSnapshot: () => ({ cwd: state.snapshot.cwd, sessionId: state.snapshot.sessionId, projectTrusted: true, servers: clone(state.mcpServers), cliServers: clone(state.mcpCliServers) }),
    getCloudSyncState: () => clone(state.cloudSync),
    getProjectDefaults: () => ({ cwd: state.snapshot.cwd, path: `${state.snapshot.cwd}\\.pi\\settings.json`, version: 'fixture', trusted: true, reason: null, global: {}, project: {}, effective: { defaultProvider: state.snapshot.modelProvider, defaultModel: state.snapshot.model, defaultThinkingLevel: state.snapshot.thinkingLevel } }),
    listMachineSessions: () => clone(state.machineSessions),
    searchSessions: () => ({ sessions: [], truncated: false }),
    searchSessionsPage: () => ({ sessions: [], total: 0, truncated: false, diagnostics: { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 } }),
    searchProjectFiles: (request) => ({ files: [], total: 0, truncated: false, ignoredDirectories: [], skipReasons: { binary: 0, large: 0, unreadable: 0, ignored: 0 }, rules: request?.rules ?? { ignoredDirectories: [], include: [], exclude: [], maxFileBytes: 1048576 }, diagnostics: { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 } }),
    cancelDataSearch: () => undefined,
    peekSession: () => null,
    getResidentSessionSnapshot: () => null,
    getHistoryPage: (offset, limit) => ({ offset, limit, total: state.snapshot.historyTotal, messages: [], activities: [], runs: [] }),
    getSessionTree: () => [],
    getProjectsDirectory: () => 'C:\\Users\\review\\Projects',
    listWorkspaceEntries: (relativePath = '') => clone(state.workspaceEntries[relativePath] ?? []),
    // Scenarios that only mock listWorkspaceEntries still list their rows: one page over that listing.
    listWorkspaceEntriesPage: async (relativePath = '', offset = 0) => {
      const entries = await window.piDesktop.listWorkspaceEntries(relativePath);
      return { entries: entries.slice(offset), nextOffset: null, total: entries.length };
    },
    searchWorkspaceFiles: () => ({ files: [], truncated: false }),
    readWorkspaceFile: (relativePath) => state.workspaceFiles[relativePath] ?? '',
    getWorkspaceGitLog: () => clone(state.gitLog),
    getWorkspaceGitDiff: () => '',
    getWorkspaceCommitContext: () => '',
    listTaskWorktrees: () => [],
    getWorkspaceTerminal: () => null,
    getFileCheckpoint: () => null,
    listProjectMemories: () => ({ items: [], total: 0, hasMore: false }),
    listUserMemories: () => ({ items: [], total: 0, hasMore: false }),
    // Main-window startup reads: split panes (none open), interrupted runs (none).
    listSplitPanes: () => [],
    describeSplitPanes: () => [],
    takeInterruptedRuns: () => [],
  };
  const subscriptions = ['onAgentEvent', 'onUpdateStateChanged', 'onAppCommand', 'onWindowChromeStateChanged', 'onExtensionDialog', 'onExtensionDialogClosed', 'onWorkspaceCommandEvent', 'onAutomationChanged', 'onWorkspaceChanged', 'onGoalChanged', 'onCloudSyncChanged', 'onWorkspaceTerminalEvent', 'onSplitPaneChanged', 'onSplitPaneClosed', 'onSideQuestionsChanged', 'onAgentInstallEvent'];
  const bridge = {};
  for (const name of subscriptions) bridge[name] = (listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    return () => listeners.get(name).delete(listener);
  };
  for (const [name, method] of Object.entries(methods)) bridge[name] = async (...args) => {
    state.calls.push({ name, args: clone(args) });
    if (state.delays[name] === 'defer') return new Promise((resolve, reject) => { state.pending[name] = { resolve, reject }; });
    if (state.delays[name]) await new Promise((resolve) => setTimeout(resolve, state.delays[name]));
    if (state.failures[name]) throw new Error(state.failures[name]);
    return method(...args);
  };
  window.__modelReview = state;
  window.piDesktop = new Proxy(bridge, { get(target, key) {
    if (key in target || typeof key !== 'string' || key === 'then') return target[key];
    return (...args) => { const message = `Unexpected bridge call: ${key}`; state.unexpected.push({ name: key, args: clone(args) }); throw new Error(message); };
  } });
  localStorage.setItem('pi-desktop.locale', options.locale ?? 'zh-CN');
  localStorage.setItem('pi-desktop.theme', options.theme ?? 'dark');
  localStorage.setItem('pi-desktop.workbench-open', 'false');
  window.addEventListener('error', (event) => state.errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => state.errors.push(String(event.reason)));
}
