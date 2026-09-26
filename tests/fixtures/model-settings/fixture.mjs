// Renderer-only fixtures. No credentials, model calls, real IPC, or project writes.
export function installModelSettingsFixture(options = {}) {
  const clone = (value) => structuredClone(value);
  const model = (provider, id, name, extra = {}) => ({ provider, id, name, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16000, ...extra });
  const providers = [
    { provider: 'openai', name: 'OpenAI', custom: false, editable: false, configured: true, baseUrl: null, api: 'openai-responses', models: [model('openai', 'gpt-review', 'GPT Review')] },
    { provider: 'review-gateway', name: '团队模型网关', custom: true, editable: true, configured: true, baseUrl: 'https://models.example.invalid/v1', api: 'openai-completions', headerNames: ['X-Review-Version'], useSystemProxy: false, disabledModels: ['hidden-model'], models: [model('review-gateway', 'review-reasoner', '团队推理模型'), model('review-gateway', 'review-fast', '快速模型', { reasoning: false, input: ['text'] }), model('review-gateway', 'hidden-model', '已隐藏模型')] },
    { provider: 'anthropic', name: 'Anthropic', custom: false, editable: false, configured: false, baseUrl: null, api: 'anthropic-messages', models: [model('anthropic', 'claude-review', 'Claude Review')] },
  ];
  const state = {
    calls: [], unexpected: [], ready: false, errors: [], providers,
    delays: {}, failures: {}, pending: {},
    discovery: { models: [{ id: 'discovered-model', name: '新发现模型', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false }, { id: 'metadata-missing', name: '需要核对能力的模型' }], warnings: ['模拟目录：不连接真实供应商'] },
    desktopSettings: { notificationsEnabled: false, closeBehavior: 'quit' },
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
    getAppInfo: () => ({ appVersion: '0.1.5-review', nodeVersion: '24', electronVersion: 'renderer-fixture', platform: 'win32' }),
    notifyRendererReady: () => { state.ready = true; },
    setAppLocale: () => {},
    listWorkspaces: () => [state.snapshot.cwd],
    getDefaultWorkspace: () => state.snapshot.cwd,
    listSessions: () => [],
    listPinnedWorkspaces: () => [],
    listSessionGroups: () => [],
    getPendingExtensionDialogs: () => [],
    getWindowChromeState: () => ({ isMaximized: false }),
    getUpdateState: () => ({ phase: 'unavailable', unavailableReason: 'development', currentVersion: '0.1.5-review' }),
    getDesktopSettings: () => clone(state.desktopSettings),
    setDesktopSettings: (patch) => clone(Object.assign(state.desktopSettings, patch)),
    listSlashCommands: () => [],
    getWorkspaceBranches: () => ({ isRepository: true, current: 'review-fixture', detached: false, branches: ['review-fixture'] }),
    getWorkspaceGitStatus: () => ({ isRepository: true, branch: 'review-fixture', entries: [], truncated: false }),
    listWorkspaceOpeners: () => [],
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
    getPersonalization: () => [],
    getInputDraft: () => ({ version: 0, text: '', attachments: [], missing: [] }),
    saveInputDraft: request => ({ version: request.expectedVersion + 1, text: request.text, attachments: [], missing: [] }),
    getInputQueue: () => ({ version: 0, paused: false, items: [] }),
  };
  const subscriptions = ['onAgentEvent', 'onUpdateStateChanged', 'onAppCommand', 'onWindowChromeStateChanged', 'onExtensionDialog', 'onExtensionDialogClosed', 'onWorkspaceCommandEvent', 'onAutomationChanged'];
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
