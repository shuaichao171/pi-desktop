import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const {
	normalizeUsageQueryConfig, usageQueryInfo, validateUsageQueryRequest,
	validateBaseUrl, validateRequestUrl, validateUsageDataList, runUsageScriptQuery, runProviderUsageQuery, UsageQueryError,
} = await import('../packages/agent/src/providerUsageQuery.ts');
const {
	detectBalanceProvider, parseDeepSeekBalance, parseStepFunBalance, parseSiliconFlowBalance, parseOpenRouterBalance, parseNovitaBalance,
} = await import('../packages/agent/src/providerBalance.ts');
const { mergeProviderUsageQuery, parseProviderDocumentText } = await import('../packages/agent/src/customProviders.ts');
const { usageScriptPreset } = await import('../packages/shared/src/usageTemplates.ts');

const loopbackServer = async (routes) => {
	const server = createServer((request, response) => {
		const handler = routes[request.url ?? ''];
		if (handler) handler(request, response);
		else { response.statusCode = 404; response.end('{}'); }
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return { server, baseUrl: `http://127.0.0.1:${port}` };
};

test('usage query configs normalize, validate and project without leaking secrets', () => {
	const config = normalizeUsageQueryConfig({ enabled: true, template: 'newapi', intervalMinutes: 10, accessToken: 'tok', userId: '7', script: 'x' });
	assert.equal(config?.template, 'newapi');
	assert.equal(config?.intervalMinutes, 10);
	assert.equal(normalizeUsageQueryConfig({ enabled: true, template: 'nope' }), null);
	assert.equal(normalizeUsageQueryConfig(null), null);
	assert.equal(normalizeUsageQueryConfig({ enabled: false, template: 'balance', intervalMinutes: -1 })?.intervalMinutes, undefined);
	const info = usageQueryInfo(config);
	assert.equal(info?.hasAccessToken, true);
	assert.equal('accessToken' in (info ?? {}), false);
	assert.equal(usageQueryInfo(config)?.script, 'x');
	assert.equal(usageQueryInfo(null), undefined);
	assert.throws(() => validateUsageQueryRequest({ enabled: true, template: 'general', script: 'x'.repeat(70_000) }), /脚本|无效/u);
	assert.deepEqual(validateUsageQueryRequest({ enabled: true, template: 'general' }), { enabled: true, template: 'general' });
	// An empty access token is a valid "clear" marker, not an error.
	assert.equal(validateUsageQueryRequest({ enabled: true, template: 'newapi', accessToken: '' }).accessToken, '');
});

test('base and request url rules mirror cc-switch security checks', () => {
	assert.ok(validateBaseUrl('http://127.0.0.1.evil.com/api'), 'HTTP for a non-localhost domain must be rejected');
	assert.ok(validateBaseUrl('http://api.example.com'), 'HTTP for a non-localhost domain must be rejected');
	assert.equal(validateBaseUrl('https://api.example.com'), null);
	assert.equal(validateBaseUrl('http://localhost:8080'), null);
	assert.equal(validateBaseUrl('http://127.0.0.1:8080'), null);
	assert.ok(validateBaseUrl('ftp://api.example.com'));
	assert.ok(validateBaseUrl('https://'));

	// Port comparison table (cc-switch test_port_comparison).
	const cases = [
		['https://api.example.com', 'https://api.example.com/v1/test', true],
		['https://api.example.com', 'https://api.example.com:443/v1/test', true],
		['https://api.example.com:443', 'https://api.example.com/v1/test', true],
		['https://api.example.com:443', 'https://api.example.com:443/v1/test', true],
		['https://api.example.com', 'https://api.example.com:8443/v1/test', false],
		['https://api.example.com:443', 'https://api.example.com:8443/v1/test', false],
	];
	for (const [base, request, shouldMatch] of cases) {
		const error = validateRequestUrl(request, base, false);
		assert.equal(error === null, shouldMatch, `base=${base} request=${request}`);
	}
	assert.ok(validateRequestUrl('https://evil.example.com/x', 'https://api.example.com', false), 'cross-origin must be rejected for presets');
	assert.ok(validateRequestUrl('https://api.example.com/x', 'https://api.example.com', true) === null, 'custom scripts may call any endpoint');
	assert.ok(validateRequestUrl('http://10.37.192.156:18344/user/balance', 'http://10.37.192.156:8090/anthropic', true) === null, 'custom scripts may use HTTP LAN endpoints');
	assert.ok(validateRequestUrl('http://api.example.com/x', 'https://api.example.com', false), 'HTTP request for a preset must be rejected');
});

test('usage data validation enforces field types and rejects empty arrays', () => {
	assert.deepEqual(validateUsageDataList({ remaining: 1.5, unit: 'USD' }), [{ remaining: 1.5, unit: 'USD' }]);
	assert.deepEqual(validateUsageDataList([{ remaining: 1 }, { planName: 'x' }]), [{ remaining: 1 }, { planName: 'x' }]);
	assert.deepEqual(validateUsageDataList({ remaining: null }), [{}]);
	assert.throws(() => validateUsageDataList([]), /数组不能为空/u);
	assert.throws(() => validateUsageDataList({ remaining: '7' }), /remaining/u);
	assert.throws(() => validateUsageDataList({ isValid: 'yes' }), /isValid/u);
	assert.throws(() => validateUsageDataList({ remaining: Number.NaN }), /有限/u);
	assert.throws(() => validateUsageDataList({ unit: 'x'.repeat(501) }), /过长/u);
	assert.throws(() => validateUsageDataList(42), /对象/u);
});

test('script templates run end to end against a loopback relay', async t => {
	const json = (body, status = 200) => (_request, response) => {
		response.statusCode = status;
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(body));
	};
	const { server, baseUrl } = await loopbackServer({
		'/user/balance': json({ is_active: true, balance: 7.5 }),
		'/api/user/self': json({ success: true, data: { quota: 5_000_000, used_quota: 2_500_000, group: 'vip' } }),
		'/v1/usage': json({ isValid: true, remaining: -1, quota: { limit: 20, used: 5, unit: 'USD' } }),
		'/denied': json({ message: 'nope' }, 401),
		'/redirect': (_request, response) => { response.statusCode = 302; response.setHeader('location', '/user/balance'); response.end(); },
	});
	t.after(() => server.close());

	const general = await runUsageScriptQuery({ config: { enabled: true, template: 'general' }, baseUrl, apiKey: 'sk-relay' });
	assert.deepEqual(general, [{ isValid: true, remaining: 7.5, unit: 'USD' }]);

	const newapi = await runUsageScriptQuery({
		config: { enabled: true, template: 'newapi', accessToken: 'sys-token', userId: '7' },
		baseUrl, apiKey: 'sk-relay',
	});
	assert.deepEqual(newapi, [{ planName: 'vip', remaining: 10, used: 5, total: 15, unit: 'USD' }]);

	const sub2api = await runUsageScriptQuery({ config: { enabled: true, template: 'sub2api' }, baseUrl, apiKey: 'sk-relay' });
	assert.deepEqual(sub2api, [{ isValid: true, unit: 'USD', used: 5, total: 20 }]);

	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'custom', script: `({ request: { url: "${baseUrl}/denied", method: "GET", headers: {} }, extractor: (r) => r })` },
		baseUrl, apiKey: 'sk-relay',
	}), (error) => error instanceof UsageQueryError && /^HTTP 401/u.test(error.message));

	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'custom', script: `({ request: { url: "${baseUrl}/redirect", method: "GET", headers: {} }, extractor: (r) => r })` },
		baseUrl, apiKey: 'sk-relay',
	}), /重定向/u);
});

test('non-custom templates stay on the provider origin', async () => {
	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'general', script: '({ request: { url: "https://evil.example.com/user/balance", method: "GET", headers: {} }, extractor: (r) => r })' },
		baseUrl: 'https://api.example.com', apiKey: 'sk-relay',
	}), /同源/u);
});

test('script phases validate shape and interrupt runaway code', async () => {
	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'custom', script: '({ request: { url: "https://api.example.com", method: "GET", headers: {} } })' },
		baseUrl: 'https://api.example.com', apiKey: 'k',
	}), /extractor/u);
	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'custom', script: '({ nonsense: true })' },
		baseUrl: 'https://api.example.com', apiKey: 'k',
	}), /request/u);
	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'custom', script: '({ request: { url: "https://api.example.com", method: "TELEPORT", headers: {} }, extractor: (r) => r })' },
		baseUrl: 'https://api.example.com', apiKey: 'k',
	}), /HTTP 方法/u);
	const started = Date.now();
	await assert.rejects(runUsageScriptQuery({
		config: { enabled: true, template: 'custom', script: 'while (true) { Math.sqrt(Math.random()); }' },
		baseUrl: 'https://api.example.com', apiKey: 'k',
	}), /脚本/u);
	assert.ok(Date.now() - started < 15_000, 'infinite loops must be interrupted well before the network timeout');
});

test('native balance parsers port cc-switch behavior', () => {
	// OpenRouter: free/exhausted/overdrawn accounts never imply an invalid key.
	for (const [credits, usage, remaining] of [[0, 0, 0], [100, 100, 0], [100, 105, -5], [100, 25.5, 74.5]]) {
		const parsed = parseOpenRouterBalance({ data: { total_credits: credits, total_usage: usage } });
		assert.equal(parsed[0]?.remaining, remaining);
		assert.equal(parsed[0]?.isValid, true);
	}
	assert.deepEqual(parseOpenRouterBalance({ total_credits: '12.5', total_usage: '2.5' })[0]?.remaining, 10);
	assert.throws(() => parseOpenRouterBalance({ data: { total_credits: 1 } }), /OpenRouter/u);
	assert.throws(() => parseOpenRouterBalance({ data: { total_credits: 'NaN', total_usage: 0 } }), /OpenRouter/u);

	// DeepSeek: empty wallets hide once another wallet has funds.
	const wallets = (a, b) => parseDeepSeekBalance({ is_available: true, balance_infos: [
		{ currency: 'CNY', total_balance: a }, { currency: 'USD', total_balance: b },
	] });
	assert.deepEqual(wallets(10, 0).map((entry) => entry.remaining), [10]);
	assert.deepEqual(wallets(0, 0).map((entry) => entry.remaining), [0, 0]);
	assert.deepEqual(wallets(3, 4).map((entry) => entry.remaining), [3, 4]);
	assert.equal(parseDeepSeekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: 1 }] })[0]?.invalidMessage, '余额不足');

	// Novita amounts are expressed in 0.0001 USD units.
	assert.equal(parseNovitaBalance({ availableBalance: 72_800 })[0]?.remaining, 7.28);
	assert.throws(() => parseNovitaBalance({}), /Novita/u);

	assert.deepEqual(parseStepFunBalance({ balance: 42.5 }), [{ planName: 'StepFun', remaining: 42.5, unit: 'CNY', isValid: true }]);
	assert.equal(parseSiliconFlowBalance({ data: { totalBalance: 8 } }, true)[0]?.unit, 'CNY');
	assert.equal(parseSiliconFlowBalance({ data: { totalBalance: 8 } }, false)[0]?.unit, 'USD');
	assert.throws(() => parseSiliconFlowBalance({}, true), /SiliconFlow/u);

	assert.equal(detectBalanceProvider('https://api.siliconflow.cn/v1'), 'siliconflow-cn');
	assert.equal(detectBalanceProvider('https://api.siliconflow.com/v1'), 'siliconflow-en');
	assert.equal(detectBalanceProvider('https://openrouter.ai/api/v1'), 'openrouter');
	assert.equal(detectBalanceProvider('https://relay.example.com/v1'), null);
});

test('orchestration rejects early without touching the network', async t => {
	const directory = mkdtempSync(join(tmpdir(), 'pi-desktop-usage-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const authPath = join(directory, 'auth.json');
	const entry = (extra) => ({ baseUrl: 'https://relay.example.com/v1', ...extra });

	const disabled = await runProviderUsageQuery({ provider: 'relay', entry: entry({ desktopUsageQuery: { enabled: false, template: 'general' } }), authPath });
	assert.equal(disabled.ok, false);

	writeFileSync(authPath, JSON.stringify({ relay: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } }));
	const oauth = await runProviderUsageQuery({ provider: 'relay', entry: entry({ desktopUsageQuery: { enabled: true, template: 'general' } }), authPath });
	assert.match(oauth.error ?? '', /OAuth/u);

	writeFileSync(authPath, JSON.stringify({ relay: { type: 'api_key', key: 'sk-relay' } }));
	const unknownBalance = await runProviderUsageQuery({ provider: 'relay', entry: entry({ desktopUsageQuery: { enabled: true, template: 'balance' } }), authPath });
	assert.match(unknownBalance.error ?? '', /未识别/u);
	assert.equal(unknownBalance.transient, undefined);

	const crossOrigin = await runProviderUsageQuery({
		provider: 'relay',
		entry: entry({ desktopUsageQuery: { enabled: true, template: 'general', script: '({ request: { url: "https://evil.example.com/balance", method: "GET", headers: {} }, extractor: (r) => r })' } }),
		authPath,
	});
	assert.match(crossOrigin.error ?? '', /同源/u);

	const missingBase = await runProviderUsageQuery({ provider: 'relay', entry: { desktopUsageQuery: { enabled: true, template: 'general' } }, authPath });
	assert.match(missingBase.error ?? '', /baseUrl/u);
});

test('usage query settings merge keeps secrets and removes cleanly', () => {
	const document = parseProviderDocumentText(JSON.stringify({ providers: { relay: { baseUrl: 'https://relay.example.com/v1', api: 'openai-completions', models: [{ id: 'm' }] } } }));
	const first = mergeProviderUsageQuery(document, 'relay', { enabled: true, template: 'newapi', accessToken: 'secret-token', userId: '7' });
	assert.equal(first.providers.relay.desktopUsageQuery.accessToken, 'secret-token');
	// A save without accessToken keeps the stored token (apiKey-style round-trip).
	const second = mergeProviderUsageQuery({ ...document, data: first }, 'relay', { enabled: true, template: 'newapi', userId: '8' });
	const query = second.providers.relay.desktopUsageQuery;
	assert.equal(query.accessToken, 'secret-token');
	assert.equal(query.userId, '8');
	// An explicit empty token clears it.
	const cleared = mergeProviderUsageQuery({ ...document, data: second }, 'relay', { enabled: true, template: 'newapi', accessToken: '' });
	assert.equal(cleared.providers.relay.desktopUsageQuery.accessToken, '');
	const removed = mergeProviderUsageQuery({ ...document, data: cleared }, 'relay', null);
	assert.equal('desktopUsageQuery' in removed.providers.relay, false);
	assert.throws(() => mergeProviderUsageQuery(document, 'missing', { enabled: true, template: 'general' }), /本地配置/u);
});

test('script presets expose the cc-switch template contract', () => {
	for (const template of ['general', 'newapi', 'sub2api', 'custom']) {
		const preset = usageScriptPreset(template);
		assert.match(preset, /request:\s*\{/u);
		assert.match(preset, /extractor:\s*function/u);
	}
	assert.equal(usageScriptPreset('balance'), '');
});
