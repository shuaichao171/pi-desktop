import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import * as themeColors from '../packages/ui/src/themeColors.ts';
import * as workbenchReading from '../packages/ui/src/workbenchReading.ts';
import * as shortcutBindings from '../packages/ui/src/shortcuts/bindings.ts';

const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const typescript = desktopRequire('typescript');
const source = typescript.transpileModule(readFileSync(new URL('../packages/ui/src/components/AppShell.tsx', import.meta.url), 'utf8'), {
	compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022 },
}).outputText;

/** 迷你 React：hook 状态按槽位跨渲染保存，事件/副作用里的 setState 同步触发再渲染。 */
function createHookReact() {
	const hooks = [];
	let cursor = 0;
	let dirty = false;
	const slotAt = (index) => hooks[index] ?? (hooks[index] = {});
	const depsChanged = (previous, next) => next === undefined
		? true
		: previous === undefined || previous.length !== next.length || previous.some((value, index) => !Object.is(value, next[index]));
	const registerEffect = () => (callback, deps) => {
		const slot = slotAt(cursor++);
		if (!slot.isEffect || depsChanged(slot.deps, deps)) {
			slot.isEffect = true;
			slot.deps = deps;
			slot.callback = callback;
			slot.pending = true;
		}
	};
	const react = {
		Fragment: Symbol('fragment'),
		Suspense: Symbol('suspense'),
		useEffect: registerEffect(),
		useLayoutEffect: registerEffect(),
		useRef: (initial) => {
			const slot = slotAt(cursor++);
			if (!('current' in slot)) slot.current = initial;
			return slot;
		},
		useState: (initial) => {
			const slot = slotAt(cursor++);
			if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial;
			const setValue = (update) => {
				const next = typeof update === 'function' ? update(slot.value) : update;
				if (Object.is(next, slot.value)) return;
				slot.value = next;
				dirty = true;
			};
			return [slot.value, setValue];
		},
		useMemo: (factory, deps) => {
			const slot = slotAt(cursor++);
			if (!('memo' in slot) || depsChanged(slot.deps, deps)) {
				slot.memo = true;
				slot.deps = deps;
				slot.value = factory();
			}
			return slot.value;
		},
	};
	function flushEffects() {
		for (const slot of hooks) {
			if (!slot?.pending) continue;
			slot.pending = false;
			if (typeof slot.cleanup === 'function') slot.cleanup();
			const cleanup = slot.callback();
			slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
		}
	}
	function render(component) {
		for (let round = 0; round < 50; round++) {
			cursor = 0;
			const tree = component();
			flushEffects();
			if (!dirty) return tree;
			dirty = false;
		}
		throw new Error('渲染未收敛：状态更新出现循环');
	}
	return { react, render };
}

function findAll(node, type, out = []) {
	if (!node || typeof node !== 'object') return out;
	if (Array.isArray(node)) { for (const child of node) findAll(child, type, out); return out; }
	if (node.type === type) out.push(node);
	if (node.props && 'children' in node.props) findAll(node.props.children, type, out);
	return out;
}

function memoryStorage(entries = {}) {
	const map = new Map(Object.entries(entries));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => { map.set(key, String(value)); },
		removeItem: (key) => { map.delete(key); },
	};
}

function mountShell(storage, chatState = { appInfo: { platform: 'win32' }, cwd: 'C:/proj' }) {
	const keydownCapture = [];
	const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	const document = {
		documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
		querySelector: () => null,
		querySelectorAll: () => [],
		hasFocus: () => false,
	};
	const window = {
		location: { search: '' },
		innerWidth: 1400,
		matchMedia: media,
		addEventListener(type, callback, options) { if (type === 'keydown' && (options === true || options?.capture)) keydownCapture.push(callback); },
		removeEventListener() {},
		requestAnimationFrame: () => 0,
	};
	const { react, render } = createHookReact();
	// 各组件以唯一 symbol 作为元素类型，测试据此在渲染树里定位元素。
	const WORKBENCH = Symbol('WorkbenchSidePane');
	const TOP_BAR = Symbol('TopBar');
	const SIDEBAR = Symbol('Sidebar');
	const SEARCH_DIALOG = Symbol('SearchDialog');
	const context = {
		exports: {}, document, window, navigator: { userAgent: 'Windows' }, localStorage: storage, URLSearchParams,
		require: (specifier) => {
			if (specifier === 'react') return react;
			if (specifier === 'react/jsx-runtime') {
				const record = (type, props) => ({ type, props });
				return { jsx: record, jsxs: record, Fragment: Symbol.for('fragment') };
			}
			if (specifier === '../store') {
				const store = Object.assign((select) => select(chatState), { getState: () => chatState });
				return { useChatStore: store };
			}
			if (specifier === '../i18n') return { useT: () => ({ t: (key) => key }) };
			if (specifier === './splitPaneRegions') return { useSplitPaneRegions: () => ({ paneIds: [], hostRef: { current: null } }), SPLIT_PANE_OPENED_EVENT: 'pi-split-pane-opened' };
			if (specifier === '../useSessionNavigation') return { useSessionNavigation: () => ({ canGoBack: false, canGoForward: false, navigating: false, goBack: async () => {}, goForward: async () => {} }) };
			if (specifier === '../workbenchReading') return workbenchReading;
			if (specifier === '../shortcuts/bindings') return shortcutBindings;
			if (specifier === '../taskNotificationSound') return { playTaskNotificationSound: async () => {}, shouldPlayTaskCompletionSound: () => false };
			if (specifier === './lazySurfaces') return {
				SettingsPanel: Symbol('SettingsPanel'), SearchDialog: SEARCH_DIALOG, AutomationPage: Symbol('AutomationPage'),
				PluginsPage: Symbol('PluginsPage'), ChatCommitDialog: Symbol('ChatCommitDialog'), WorkbenchSidePane: WORKBENCH,
				preloadLazySurfaces: () => () => {},
			};
			if (specifier === './ExtensionDialogHost') return { ExtensionDialogHost: Symbol('ExtensionDialogHost'), useExtensionRequestPending: () => false, useAnyExtensionRequestPending: () => false };
			if (specifier === '../themeColors') return {
				...themeColors,
				readColorPreferences: () => themeColors.readColorPreferences(storage),
				writeColorPreferences: (prefs) => themeColors.writeColorPreferences(prefs, storage),
			};
			if (specifier === './TopBar') return { TopBar: TOP_BAR };
			if (specifier === './Sidebar') return { Sidebar: SIDEBAR };
			if (specifier === './ChatView') return { ChatView: Symbol('ChatView') };
			if (specifier === './ScopedErrorBoundary') return { ScopedErrorBoundary: Symbol('ScopedErrorBoundary') };
			if (specifier === './ExitPresence') return { ExitPresence: Symbol('ExitPresence') };
			if (specifier === './ActivityBar') return { ActivityBar: Symbol('ActivityBar') };
			if (specifier === './Icons') return { Icon: Symbol('Icon') };
			if (specifier === './HoverTooltip') return { HoverTooltip: Symbol('HoverTooltip') };
			if (specifier === './WindowControls') return { WindowControls: Symbol('WindowControls') };
			if (specifier === './UpdateNotice') return { UpdateNotice: Symbol('UpdateNotice') };
			if (specifier === './OperationFeedback') return { OperationFeedback: Symbol('OperationFeedback') };
			if (specifier === './FolderProjectDropZone') return { FolderProjectDropZone: Symbol('FolderProjectDropZone') };
			if (specifier === './ResultFilePreviewDialog') return { ResultFilePreviewDialogRoot: Symbol('ResultFilePreviewDialogRoot') };
			if (specifier === '../resultFilePressRescue') return { installResultFilePressRescue: () => {} };
			if (specifier === '../inputModality') return { installInputModality: () => {} };
			return {};
		},
	};
	vm.runInNewContext(source, context);
	return {
		types: { WORKBENCH, TOP_BAR, SIDEBAR, SEARCH_DIALOG },
		keydownCapture,
		// 每次调用都重新渲染并冲刷副作用；无状态变化时结果与上次一致。
		getTree: () => render(() => context.exports.AppShell()),
	};
}

test('工作台按首次打开挂载，关闭再打开不卸载重置', () => {
	const { types, getTree } = mountShell(memoryStorage());
	// 未打开：懒加载的工作台不在渲染树中（连同文件树/Git 图/终端子树）。
	assert.equal(findAll(getTree(), types.WORKBENCH).length, 0, '未打开时工作台不应挂载');

	// 顶栏开关首次打开：同一次提交内完成挂载且 open=true。
	const toggle = () => findAll(getTree(), types.TOP_BAR)[0].props.onToggleWorkbench();
	toggle();
	let pane = findAll(getTree(), types.WORKBENCH);
	assert.equal(pane.length, 1, '首次打开后工作台应挂载');
	assert.equal(pane[0].props.open, true);

	// 关闭仅隐藏：元素保持挂载，终端状态、宽度与 tab 不随关闭重置。
	pane[0].props.onClose();
	pane = findAll(getTree(), types.WORKBENCH);
	assert.equal(pane.length, 1, '关闭不应卸载工作台');
	assert.equal(pane[0].props.open, false);

	// 再次打开不重复挂载，仍是同一棵子树。
	toggle();
	pane = findAll(getTree(), types.WORKBENCH);
	assert.equal(pane.length, 1);
	assert.equal(pane[0].props.open, true);
});

test('未挂载时 terminalRequest（侧栏打开终端与快捷键）仍生效', () => {
	{
		const { types, getTree } = mountShell(memoryStorage());
		assert.equal(findAll(getTree(), types.WORKBENCH).length, 0);
		// 侧栏「打开终端」：先挂载再投递 terminalRequest。
		findAll(getTree(), types.SIDEBAR)[0].props.onOpenTerminal();
		const pane = findAll(getTree(), types.WORKBENCH);
		assert.equal(pane.length, 1, '终端请求应先挂载工作台');
		assert.equal(pane[0].props.open, true);
		assert.equal(pane[0].props.terminalRequest, 1, '首次挂载即收到终端请求，工作台内部可据此切到终端 tab');
	}
	{
		const { types, getTree, keydownCapture } = mountShell(memoryStorage());
		assert.equal(findAll(getTree(), types.WORKBENCH).length, 0);
		assert.ok(keydownCapture.length > 0, '快捷键监听应在挂载时注册');
		keydownCapture.at(-1)({
			ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: '`',
			repeat: false, defaultPrevented: false, isComposing: false, keyCode: 0,
			preventDefault() {}, stopPropagation() {},
		});
		const pane = findAll(getTree(), types.WORKBENCH);
		assert.equal(pane.length, 1, 'Ctrl+` 在未挂载时应先挂载工作台');
		assert.equal(pane[0].props.open, true);
		assert.equal(pane[0].props.terminalRequest, 1);
		// 再按一次 Ctrl+`：已打开且在终端 tab 上时切换为关闭，语义与现状一致。
		keydownCapture.at(-1)({
			ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: '`',
			repeat: false, defaultPrevented: false, isComposing: false, keyCode: 0,
			preventDefault() {}, stopPropagation() {},
		});
		// 默认 tab 为 files，第二次按键聚焦终端而不是关闭。
		const paneAfter = findAll(getTree(), types.WORKBENCH);
		assert.equal(paneAfter.length, 1);
		assert.equal(paneAfter[0].props.terminalRequest, 2);
	}
});

test('未挂载时 openRequest（搜索定位文件）仍生效', () => {
	const { types, getTree } = mountShell(memoryStorage());
	assert.equal(findAll(getTree(), types.WORKBENCH).length, 0);
	// 打开搜索面板并定位一个工作区文件。
	findAll(getTree(), types.TOP_BAR)[0].props.onOpenSearch();
	const dialog = findAll(getTree(), types.SEARCH_DIALOG);
	assert.equal(dialog.length, 1, '搜索面板应打开');
	dialog[0].props.onSelectFile({ kind: 'file', path: 'src/app.ts', name: 'app.ts' });
	const pane = findAll(getTree(), types.WORKBENCH);
	assert.equal(pane.length, 1, '文件定位请求应先挂载工作台');
	assert.equal(pane[0].props.open, true);
	// 跨 VM realm 的对象无法 deepStrictEqual，逐字段比对。
	assert.equal(pane[0].props.openRequest.cwd, 'C:/proj');
	assert.equal(pane[0].props.openRequest.path, 'src/app.ts');
	assert.equal(pane[0].props.openRequest.requestId, 1);
});

test('启动时恢复“工作台已打开”偏好仍立即挂载', () => {
	const { types, getTree } = mountShell(memoryStorage({ 'pi-desktop.workbench-open': 'true' }));
	const pane = findAll(getTree(), types.WORKBENCH);
	assert.equal(pane.length, 1, '恢复打开偏好在首个提交内完成挂载');
	assert.equal(pane[0].props.open, true);
});
