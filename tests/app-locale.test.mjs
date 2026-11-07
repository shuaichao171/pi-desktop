import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// appLocale 依赖 electron 的 app.getPath 与损坏恢复弹窗；用可变的测试状态打桩。
const state = { userData: '', recoveries: [] };
globalThis.__appLocaleTest = state;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') {
			const source = 'export const app = { getPath: () => globalThis.__appLocaleTest.userData };'
				+ 'export const dialog = { showErrorBox: (...args) => globalThis.__appLocaleTest.recoveries.push(args) };';
			return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		}
		// parentURL 可能带 ?case=N 的 query，按 pathname 判断 .ts 后缀。
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

// 模块内 cachedLocale 是进程级缓存：每个用例用带 query 的独立模块实例。
let loadCount = 0;
const loadAppLocale = (userData) => {
	state.userData = userData;
	state.recoveries = [];
	return import(`../packages/desktop/src/main/appLocale.ts?case=${loadCount += 1}`);
};

const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'pi-desktop-locale-'));

test('the locale file backs the cached language and async saves round-trip', async () => {
	const root = tempRoot();
	try {
		const { getAppLocale, setAppLocale } = await loadAppLocale(root);
		assert.equal(getAppLocale(), 'zh-CN', '缺省语言为简体中文');
		await setAppLocale('en-US');
		assert.equal(JSON.parse(readFileSync(join(root, 'locale.json'), 'utf8')).locale, 'en-US', '异步写入完整 JSON');
		assert.equal(getAppLocale(), 'en-US', '写入成功后更新进程内缓存');
		await assert.rejects(() => setAppLocale('fr-FR'), /Invalid application locale/, '非法语言保持原文案');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a saved locale is read back on first use', async () => {
	const root = tempRoot();
	try {
		writeFileSync(join(root, 'locale.json'), JSON.stringify({ locale: 'en-US' }), 'utf8');
		const { getAppLocale } = await loadAppLocale(root);
		assert.equal(getAppLocale(), 'en-US');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a damaged locale file is backed up and falls back to zh-CN', async () => {
	const root = tempRoot();
	try {
		writeFileSync(join(root, 'locale.json'), '{ not json', 'utf8');
		const { getAppLocale } = await loadAppLocale(root);
		assert.equal(getAppLocale(), 'zh-CN', '损坏文件回退到默认语言');
		const backup = readdirSync(root).find((name) => name.endsWith('.bak'));
		assert.ok(backup, '损坏字节被备份保留');
		assert.equal(readFileSync(join(root, backup), 'utf8'), '{ not json');
		assert.equal(state.recoveries.length, 1, '弹出一次恢复提示');
		assert.ok(state.recoveries[0][1].includes(backup), '提示文案包含备份路径');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
