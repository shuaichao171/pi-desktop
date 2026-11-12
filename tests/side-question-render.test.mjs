// 侧问区域挂在每条用户消息下：真实挂载（React 19 客户端渲染）验证其 store 选择器
// 不会因每次返回新数组而陷入 "Maximum update depth exceeded" 的无限重渲染。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

/** Minimal host container: the regions under test render null, so no DOM nodes are ever created. */
function installDomStub() {
	const noop = () => {};
	const doc = { nodeType: 9, nodeName: '#document', addEventListener: noop, removeEventListener: noop, activeElement: null, defaultView: globalThis };
	doc.documentElement = { nodeType: 1, nodeName: 'HTML', tagName: 'HTML', localName: 'html', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc };
	doc.body = { nodeType: 1, nodeName: 'BODY', ownerDocument: doc };
	const container = {
		nodeType: 1, nodeName: 'DIV', tagName: 'DIV', localName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml',
		addEventListener: noop, removeEventListener: noop, ownerDocument: doc, childNodes: [], firstChild: null, removeChild: noop, appendChild: noop,
	};
	// Installed for the rest of this (per-file) test process: modules loaded under it
	// keep timers that read `window` after the test body ends.
	globalThis.document = doc;
	globalThis.window ??= globalThis;
	globalThis.addEventListener ??= noop;
	globalThis.removeEventListener ??= noop;
	globalThis.HTMLIFrameElement ??= class HTMLIFrameElement {};
	return { container };
}

test('side-question regions settle after one render and stay stable across unrelated store updates', async () => {
	const React = await import(pathToFileURL(uiRequire.resolve('react')).href);
	const { createRoot } = await import(pathToFileURL(uiRequire.resolve('react-dom/client')).href);
	const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
	const server = await createServer({ root: fileURLToPath(new URL('../packages/ui', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
	const dom = installDomStub();
	const errors = [];
	const originalError = console.error;
	console.error = (...args) => { errors.push(String(args[0])); };
	try {
		const { SideQuestionRegion } = await server.ssrLoadModule('/src/components/SideQuestion.tsx');
		const { useChatStore } = await server.ssrLoadModule('/src/store.ts');
		let renders = 0;
		const Probe = ({ anchor }) => { renders += 1; return React.createElement(SideQuestionRegion, { anchorEntryId: anchor }); };
		const root = createRoot(dom.container, { onUncaughtError: (error) => errors.push(error.message), onRecoverableError: (error) => errors.push(error.message) });
		// Several user messages mount several regions, none of which has records.
		root.render(React.createElement(React.Fragment, null, ['u1', 'u2', 'u3'].map((anchor) => React.createElement(Probe, { key: anchor, anchor }))));
		await new Promise((resolve) => setTimeout(resolve, 200));
		// A record for another turn and an unrelated store update must not loop either.
		useChatStore.setState({ sideQuestions: [{ id: 'q', sessionPath: 'C:\\s.jsonl', anchorEntryId: 'other', question: 'q', answer: null, status: 'done', modelProvider: '', modelId: '', modelName: null, contextTruncated: false, createdAt: 1, finishedAt: 2 }] });
		useChatStore.setState({ timelineRevision: useChatStore.getState().timelineRevision + 1 });
		await new Promise((resolve) => setTimeout(resolve, 200));
		root.unmount();
		assert.deepEqual(errors.filter((message) => /Maximum update depth|getSnapshot should be cached/.test(message)), []);
		assert.ok(renders <= 3, `each region renders once (parents never re-render here); got ${renders}`);
	} finally {
		console.error = originalError;
		await server.close();
	}
});
