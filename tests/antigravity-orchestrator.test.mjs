import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const mod = await import('../packages/agent/src/acp/antigravityOrchestrator.ts');
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp/fake-agent.mjs', import.meta.url));
const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('antigravitySettingsPath resolves default and flag overrides safely', () => {
	const home = 'C:\\Users\\tester';
	assert.equal(
		mod.antigravitySettingsPath({ args: ['acp'] }, home),
		join(home, '.gemini', 'antigravity-cli', 'settings.json'),
	);
	// Relative --gemini-dir falls back to home/.gemini just like agy acp.
	assert.equal(
		mod.antigravitySettingsPath({ args: ['acp', '--gemini-dir', '.gemini'] }, home),
		join(home, '.gemini', 'antigravity-cli', 'settings.json'),
	);
	const customGemini = mkdtempSync(join(tmpdir(), 'pi-agy-dir-'));
	try {
		assert.equal(
			mod.antigravitySettingsPath({ args: ['acp', '--gemini-dir', customGemini, '--app-data-dir=custom-cli', '--cli_dir_name', 'sub'] }, home),
			join(customGemini, 'custom-cli', 'sub', 'settings.json'),
		);
		assert.equal(
			mod.antigravitySettingsPath({ args: ['acp', '--gemini-dir', customGemini, '--app-data-dir', '../escape'] }, home),
			join(customGemini, 'antigravity-cli', 'settings.json'),
		);
	} finally {
		rmSync(customGemini, { recursive: true, force: true });
	}
});

test('writeAntigravityOrchestratorSettings preserves unrelated keys and rejects malformed JSON', () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-agy-settings-'));
	try {
		const file = join(root, 'antigravity-cli', 'settings.json');
		mkdirSync(join(root, 'antigravity-cli'), { recursive: true });
		writeFileSync(file, JSON.stringify({
			model: 'Gemini 4 Neon (Low)',
			toolPermission: 'always-proceed',
			orchestrator: { planner: 'Gemini 4 Neon (XHigh)', customFlag: true },
		}, null, 2), 'utf8');

		mod.writeAntigravityOrchestratorSettings(file, { executor: 'Gemini 4 Hydrogen (Medium)' });
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		assert.equal(saved.model, 'Gemini 4 Neon (Low)');
		assert.equal(saved.toolPermission, 'always-proceed');
		assert.deepEqual(saved.orchestrator, {
			planner: 'Gemini 4 Neon (XHigh)',
			executor: 'Gemini 4 Hydrogen (Medium)',
			customFlag: true,
		});
		assert.deepEqual(mod.readAntigravityOrchestratorSettings(file), {
			planner: 'Gemini 4 Neon (XHigh)',
			executor: 'Gemini 4 Hydrogen (Medium)',
		});

		writeFileSync(file, '{broken', 'utf8');
		assert.throws(() => mod.writeAntigravityOrchestratorSettings(file, { planner: 'Gemini 4 Neon (High)' }), /格式无效/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('parseAntigravityOrchestratorModels and buildAntigravityOrchestratorConfig group models and strengths', () => {
	const variantModels = [
		{ id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
		{ id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
		{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
		{ id: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
		{ id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
		{ id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
		{ id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
		{ id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
	];
	const config = mod.buildAntigravityOrchestratorConfig({
		modelId: 'gemini-pro-orchestrator-neon',
		variantModels,
		settings: { planner: 'Gemini 4 Neon (XHigh)' },
	});
	assert.ok(config);
	assert.equal(config.planner.currentValue, 'Gemini 4 Neon (XHigh)');
	assert.equal(config.planner.defaultValue, 'Gemini 4 Neon (High)');
	assert.equal(config.executor.currentValue, 'Gemini 4 Hydrogen (High)');
	assert.equal(config.models.some((m) => /Orchestrator/i.test(m.name)), false);
	const neon = config.models.find((m) => m.name === 'Gemini 4 Neon');
	assert.deepEqual(neon.variants.map((v) => [v.effort, v.effortName]), [
		['low', 'Low'],
		['high', 'High'],
		['xhigh', 'Extra'],
	]);

	assert.equal(mod.buildAntigravityOrchestratorConfig({
		modelId: 'gemini-4-neon',
		variantModels,
		settings: {},
	}), null);

	assert.equal(mod.orchestratorPresetForPlanner('Gemini 4 Carbon (High)', ['gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator']), 'gemini-pro-orchestrator');
	assert.equal(mod.orchestratorPresetForPlanner('Claude Opus 5.5 (High)', ['gemini-pro-orchestrator-neon']), null);
	assert.equal(mod.plannerForOrchestratorPreset('gemini-pro-orchestrator', 'Gemini 4 Neon (XHigh)', config.models), 'Gemini 4 Carbon (High)');
});

test('AcpConversation captures availableModels variants alongside configOptions for Antigravity Orchestrator', async (t) => {
	const { AcpConversation } = await import('../packages/agent/src/acp/conversation.ts');
	let variantModels = [];
	let models = [];
	let currentModelId = null;
	let options = [];
	const conv = new AcpConversation({
		id: 'antigravity',
		displayName: 'Antigravity',
		command: process.execPath,
		args: [FAKE_AGENT],
		env: { FAKE_ACP_SETTINGS: 'antigravity-orchestrator', FAKE_ACP_LOAD: '1' },
		enabled: true,
		builtin: true,
	}, process.cwd(), null, {
		emit: () => {},
		persist: () => {},
		requestPermission: async () => ({ outcome: 'cancelled' }),
		requestElicitation: async () => ({ action: 'cancel' }),
		onPlan: () => {},
		onCommands: () => {},
		onModels: (list, current) => { models = list; currentModelId = current; },
		onVariantModels: (list) => { variantModels = list; },
		onConfigOptions: (list) => { options = list; },
		onNativeSession: () => {},
		onExit: () => {},
		historyContext: () => null,
	});
	t.after(async () => { await conv.dispose(); });

	await conv.warmup();
	assert.equal(currentModelId, 'gemini-4-neon');
	assert.ok(models.some((m) => m.id === 'gemini-pro-orchestrator-neon'));
	assert.ok(variantModels.some((m) => m.name === 'Gemini 4 Neon (XHigh)'));
	assert.ok(options.some((o) => o.category === 'thought_level'));

	await conv.setModel('gemini-pro-orchestrator-neon');
	assert.equal(currentModelId, 'gemini-pro-orchestrator-neon');
	assert.equal(options.some((o) => o.category === 'thought_level'), false, 'thought_level disappears under Orchestrator');
	const built = mod.buildAntigravityOrchestratorConfig({
		modelId: currentModelId,
		variantModels,
		settings: { planner: 'Gemini 4 Neon (XHigh)' },
	});
	assert.equal(built?.planner.currentValue, 'Gemini 4 Neon (XHigh)');
	assert.equal(built?.executor.currentValue, 'Gemini 4 Hydrogen (High)');
});

test('ComposerControls renders Orchestrator trigger with planner and executor summary', async () => {
	const react = uiRequire('react');
	const jsxRuntime = uiRequire('react/jsx-runtime');
	const { renderToStaticMarkup } = uiRequire('react-dom/server');
	const typescript = desktopRequire('typescript');
	const sharedRuntimes = await import('../packages/shared/src/agentRuntimes.ts');
	const { selectModelProvider, groupModelsByProvider } = await import('../packages/ui/src/modelPicker.ts');
	const source = typescript.transpileModule(
		readFileSync(new URL('../packages/ui/src/components/ComposerControls.tsx', import.meta.url), 'utf8'),
		{ compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022 } },
	).outputText;

	const chatState = {
		model: 'gemini-pro-orchestrator-neon',
		modelName: 'Orchestrator (Neon)',
		modelProvider: 'acp:antigravity',
		thinkingLevel: 'medium',
		availableThinkingLevels: [],
		contextUsage: null,
		status: 'idle',
		sessionPreparation: null,
		sessionLoading: false,
		navigationPending: false,
		sessionPath: null,
		sessionId: null,
		cwd: 'D:/work',
		bridge: null,
		messages: [],
		models: [],
		modelProviders: [],
		providerAuth: [],
		agents: [],
		refreshModels: async () => {},
		refreshModelProviders: async () => {},
		refreshProviderAuth: async () => {},
		refreshAgents: async () => {},
		selectAgent: async () => {},
		handoffToAgent: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		setAgentOption: async () => {},
		agent: {
			id: 'antigravity',
			kind: 'acp',
			displayName: 'Antigravity',
			capabilities: sharedRuntimes.ACP_AGENT_CAPABILITIES,
			models: [{ id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' }],
			currentModelId: 'gemini-pro-orchestrator-neon',
			options: [{ id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', values: [{ value: 'default', name: 'Default' }] }],
			orchestrator: {
				planner: { currentValue: 'Gemini 4 Neon (XHigh)', defaultValue: 'Gemini 4 Neon (High)' },
				executor: { currentValue: 'Gemini 4 Hydrogen (High)', defaultValue: 'Gemini 4 Hydrogen (High)' },
				models: [
					{ name: 'Gemini 4 Neon', variants: [{ value: 'Gemini 4 Neon (High)', effort: 'high', effortName: 'High' }, { value: 'Gemini 4 Neon (XHigh)', effort: 'xhigh', effortName: 'Extra' }] },
					{ name: 'Gemini 4 Hydrogen', variants: [{ value: 'Gemini 4 Hydrogen (High)', effort: 'high', effortName: 'High' }] },
				],
			},
		},
	};

	const context = {
		exports: {},
		module: { exports: {} },
		require: (specifier) => {
			if (specifier === 'react') return react;
			if (specifier === 'react/jsx-runtime') return jsxRuntime;
			if (specifier === 'react-dom') return { createPortal: (node) => node };
			if (specifier === '@pidesktop/shared') return { ...sharedRuntimes, PI_AGENT_ID: 'pi' };
			if (specifier === '../store') return { useChatStore: Object.assign((select) => select(chatState), { getState: () => chatState }) };
			if (specifier === '../i18n') return { useT: () => ({ t: (k) => k, locale: 'zh-CN' }) };
			if (specifier === '../modelPicker') return { groupModelsByProvider, selectModelProvider };
			if (specifier === './ExitPresence') return { ExitPresence: ({ children }) => children };
			if (specifier === './HoverTooltip') return { HoverTooltip: ({ children }) => children };
			if (specifier === './Icons') return { Icon: ({ name }) => react.createElement('span', { 'data-icon': name }) };
			if (specifier === '../providerMark') return { providerInitial: () => 'A', providerMarkStyle: () => ({}) };
			if (specifier === '../modelCapabilities') return { imageCapability: () => null };
			return {};
		},
	};
	context.module.exports = context.exports;
	vm.runInNewContext(source, context);
	const { ComposerControls } = context.module.exports;

	const html = renderToStaticMarkup(react.createElement(ComposerControls, { onOpenModelManagement: () => {} }));
	assert.match(html, /pd-composer-agent-orchestrator-trigger/);
	assert.match(html, /Neon \(XHigh\) \/ Hydrogen \(High\)/);
	assert.doesNotMatch(html, /pd-composer-agent-effort-trigger/);
});
