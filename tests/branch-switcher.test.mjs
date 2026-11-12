import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('the branch switcher hides when no alternative is active and reports k/n otherwise', async () => {
	const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
	const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
	const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
	const server = await createServer({ root: fileURLToPath(new URL('../packages/ui', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
	try {
		const { BranchSwitcher } = await server.ssrLoadModule('/src/components/BranchSwitcher.tsx');
		const alternative = (id, active) => ({ id, kind: 'user', label: id, targetId: id, active });
		const fork = (activeIndex) => ({ forkId: null, alternatives: [alternative('u1', false), alternative('u2', activeIndex === 1)], activeIndex });
		// The docked leaf itself grew the sibling subtrees: nothing to report — the
		// group must not render a dead "‹ 0/2 ›".
		assert.equal(renderToStaticMarkup(createElement(BranchSwitcher, { fork: fork(-1), onSwitch() {} })), '');
		assert.equal(renderToStaticMarkup(createElement(BranchSwitcher, { fork: { forkId: null, alternatives: [alternative('u1', true)], activeIndex: 0 }, onSwitch() {} })), '', 'a single alternative never renders a switcher');
		const active = renderToStaticMarkup(createElement(BranchSwitcher, { fork: fork(1), onSwitch() {} }));
		assert.match(active, /pd-branch-position/);
		assert.match(active, />2\/2</);
		assert.match(active, /aria-label="[^"]*2[^"]*2/);
		const disabled = renderToStaticMarkup(createElement(BranchSwitcher, { fork: fork(1), disabled: true, onSwitch() {} }));
		assert.match(disabled, /is-disabled/, 'an external busy state keeps the switcher visible but disabled');
	} finally {
		await server.close();
	}
});
