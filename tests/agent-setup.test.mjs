import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const { BUILTIN_AGENTS, installerCommandLine } = await import('../packages/agent/src/acp/agentRegistry.ts');
const { withAgentSearchPath, knownAgentDirs } = await import('../packages/agent/src/acp/command.ts');
const { AgentInstallService, renderInstallOutput } = await import('../packages/desktop/src/main/agentInstaller.ts');

const AGY = { kind: 'script', windowsUrl: 'https://antigravity.google/cli/install.ps1', posixUrl: 'https://antigravity.google/cli/install.sh' };

test('installer command lines match the official instructions on each platform', () => {
	assert.equal(installerCommandLine(AGY, 'win32'), 'irm https://antigravity.google/cli/install.ps1 | iex');
	assert.equal(installerCommandLine(AGY, 'darwin'), 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
	assert.equal(installerCommandLine({ kind: 'npm', package: '@agentclientprotocol/codex-acp' }, 'linux'), 'npm install -g @agentclientprotocol/codex-acp');
});

test('every built-in agent has an installer, a matching hint and a plain-token sign-in', () => {
	for (const agent of BUILTIN_AGENTS) {
		assert.ok(agent.installer, agent.id);
		assert.equal(agent.installHint, installerCommandLine(agent.installer), agent.id);
		assert.ok(agent.login, agent.id);
		for (const token of [agent.login.command, ...agent.login.args]) assert.match(token, /^[\w@./:=-]+$/, agent.id);
	}
	const claude = BUILTIN_AGENTS.find((agent) => agent.id === 'claude-code');
	assert.deepEqual(claude.installer, { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp' });
	assert.deepEqual(BUILTIN_AGENTS.find((agent) => agent.id === 'antigravity').installer, AGY);
});

test('known install folders are appended to PATH once, after what is already there', () => {
	const env = process.platform === 'win32'
		? { Path: 'C:\\Tools', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
		: { PATH: '/usr/bin', HOME: '/home/me' };
	const known = knownAgentDirs(env);
	assert.ok(known.length > 0);
	const key = process.platform === 'win32' ? 'Path' : 'PATH';
	const first = withAgentSearchPath(env)[key].split(delimiter);
	assert.equal(first[0], env[key]);
	for (const dir of known) assert.ok(first.includes(dir), dir);
	// Already present (any case / trailing slash on Windows): not added twice.
	const again = withAgentSearchPath({ ...env, [key]: first.join(delimiter) })[key].split(delimiter);
	assert.equal(again.length, first.length);
	if (process.platform === 'win32') {
		const npm = join(env.APPDATA, 'npm');
		const upper = withAgentSearchPath({ ...env, Path: `${npm.toUpperCase()}\\` }).Path.split(delimiter);
		assert.equal(upper.filter((dir) => dir.toLowerCase().replace(/\\$/, '') === npm.toLowerCase()).length, 1);
	}
});

test('install output loses escape codes and keeps the last state of progress lines', () => {
	assert.equal(renderInstallOutput('\u001b[32madded 1 package\u001b[0m\r\n10%\r50%\r100%\ndone\r\n'), 'added 1 package\n100%\ndone\n');
	assert.equal(renderInstallOutput('\u001b]0;title\u0007line'), 'line');
});

function fakeService({ script, timeoutMs = 60_000 } = {}) {
	const events = [];
	const agent = { id: 'fake', displayName: 'Fake', command: 'fake', args: [], enabled: true, builtin: true, installer: { kind: 'npm', package: 'fake' }, login: { command: 'fake', args: [] } };
	const logins = [];
	const service = new AgentInstallService((state) => events.push(state), {
		findAgent: (id) => (id === 'fake' ? agent : id === 'other' ? { ...agent, id: 'other' } : id === 'plain' ? { ...agent, id: 'plain', installer: undefined } : undefined),
		startInstall: () => ({ child: spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }), display: 'npm install -g fake' }),
		openLogin: async (target) => { logins.push(target.id); },
		timeoutMs,
	});
	const settled = () => new Promise((resolve) => {
		const timer = setInterval(() => {
			const last = events.at(-1);
			if (last && last.phase !== 'running') { clearInterval(timer); resolve(last); }
		}, 20);
	});
	return { service, events, logins, settled };
}

test('a successful install streams its output and ends as succeeded', async () => {
	const { service, events, settled } = fakeService({ script: 'console.log("\\u001b[1mhello\\u001b[0m"); console.error("warn line")' });
	const started = service.start('fake');
	assert.equal(started.phase, 'running');
	assert.equal(started.command, 'npm install -g fake');
	const final = await settled();
	assert.equal(final.phase, 'succeeded');
	assert.equal(final.exitCode, 0);
	assert.match(final.output, /^> npm install -g fake\n/);
	assert.match(final.output, /hello/);
	assert.match(final.output, /warn line/);
	assert.ok(!final.output.includes('\u001b'));
	assert.equal(events[0].phase, 'running');
	assert.deepEqual(service.list().map((state) => state.phase), ['succeeded']);
});

test('a failing install reports the exit code', async () => {
	const { service, settled } = fakeService({ script: 'console.error("E404 not found"); process.exit(3)' });
	service.start('fake');
	const final = await settled();
	assert.equal(final.phase, 'failed');
	assert.equal(final.exitCode, 3);
	assert.match(final.error, /3/);
	assert.match(final.output, /E404/);
});

test('installs run one at a time and can be cancelled', async () => {
	const { service, settled } = fakeService({ script: 'console.log("started"); setInterval(() => {}, 1000)' });
	service.start('fake');
	assert.throws(() => service.start('fake'), /正在安装/);
	assert.throws(() => service.start('other'), /另一个 Agent/);
	assert.throws(() => service.start('plain'), /不支持一键安装/);
	assert.throws(() => service.start('missing'), /不支持一键安装/);
	service.cancel('fake');
	const final = await settled();
	assert.equal(final.phase, 'cancelled');
});

test('an install that runs too long is stopped', async () => {
	const { service, settled } = fakeService({ script: 'setInterval(() => {}, 1000)', timeoutMs: 300 });
	service.start('fake');
	const final = await settled();
	assert.equal(final.phase, 'failed');
	assert.match(final.error, /超时/);
});

test('sign-in opens only for catalog agents', async () => {
	const { service, logins } = fakeService({ script: '' });
	await service.openLogin('fake');
	assert.deepEqual(logins, ['fake']);
	await assert.rejects(service.openLogin('missing'), /内置 Agent/);
});

const { proxyUrlFromResolution, withSystemProxy, configureAgentSystemProxy, resolveAgentSystemProxy, agentProxyProbeUrl } = await import('../packages/agent/src/acp/agentProxy.ts');

test('system proxy resolutions become proxy URLs; direct, SOCKS and junk do not', () => {
	assert.equal(proxyUrlFromResolution('PROXY 127.0.0.1:10808; DIRECT'), 'http://127.0.0.1:10808');
	assert.equal(proxyUrlFromResolution('HTTPS proxy.example:443'), 'https://proxy.example');
	assert.equal(proxyUrlFromResolution('DIRECT'), null);
	assert.equal(proxyUrlFromResolution('SOCKS5 127.0.0.1:1080'), null);
	assert.equal(proxyUrlFromResolution('PROXY user:pw@host:1'), null);
	assert.equal(proxyUrlFromResolution(''), null);
});

test('agents get the system proxy as variables unless the user set one', () => {
	const proxy = 'http://127.0.0.1:10808';
	const noProxy = 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local';
	assert.deepEqual(withSystemProxy({ Path: 'x' }, proxy, 'win32'), { Path: 'x', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: noProxy });
	// Windows names are case-insensitive: an empty lowercase spelling is replaced, not duplicated.
	assert.deepEqual(withSystemProxy({ https_proxy: '' }, proxy, 'win32'), { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: noProxy });
	assert.deepEqual(withSystemProxy({ no_proxy: '.corp' }, proxy, 'linux'), { no_proxy: '.corp', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy });
	for (const own of [{ HTTPS_PROXY: 'http://mine:1' }, { all_proxy: 'socks5://mine:1' }, { http_proxy: 'http://mine:1' }]) {
		assert.deepEqual(withSystemProxy({ ...own }, proxy, 'win32'), own);
	}
	assert.deepEqual(withSystemProxy({ A: '1' }, null, 'win32'), { A: '1' });
});

test('Claude Code and Antigravity resolve system proxy rules for their respective service URLs', async () => {
	const urls = Object.fromEntries(BUILTIN_AGENTS.filter((agent) => agent.systemProxy).map((agent) => [agent.id, agent.systemProxy]));
	assert.deepEqual(urls, { 'claude-code': 'https://api.anthropic.com/', antigravity: 'https://www.google.com/' });
	const lookups = [];
	configureAgentSystemProxy(async (url) => {
		lookups.push(url);
		return url === urls['claude-code'] ? 'PROXY 127.0.0.1:10808' : 'DIRECT';
	});
	const [claude, agy, codex, concurrentClaude] = await Promise.all([
		resolveAgentSystemProxy(urls['claude-code']),
		resolveAgentSystemProxy(urls.antigravity),
		resolveAgentSystemProxy(urls.codex),
		resolveAgentSystemProxy(urls['claude-code']),
	]);
	assert.equal(claude, 'http://127.0.0.1:10808');
	assert.equal(concurrentClaude, claude);
	assert.equal(agy, null);
	assert.equal(codex, null);
	assert.deepEqual(lookups, [urls['claude-code'], urls.antigravity]);

	let resolution;
	configureAgentSystemProxy((url) => {
		if (resolution === undefined) throw new Error('proxy lookup failed');
		return Promise.resolve(resolution);
	});
	assert.equal(await resolveAgentSystemProxy(urls['claude-code']), claude);
	assert.equal(await resolveAgentSystemProxy(urls.antigravity), null, 'the last known proxy is scoped to the URL');
	resolution = 'PROXY 127.0.0.1:7890';
	assert.equal(await resolveAgentSystemProxy(urls['claude-code']), 'http://127.0.0.1:7890');
	resolution = 'DIRECT';
	assert.equal(await resolveAgentSystemProxy(urls['claude-code']), null);
});

test('the proxy is resolved for the endpoint the agent really calls (an API relay wins over the vendor URL)', () => {
	const claude = BUILTIN_AGENTS.find((agent) => agent.id === 'claude-code');
	const agy = BUILTIN_AGENTS.find((agent) => agent.id === 'antigravity');
	const codex = BUILTIN_AGENTS.find((agent) => agent.id === 'codex');
	const none = () => ({});
	assert.equal(agentProxyProbeUrl(claude, {}, none), 'https://api.anthropic.com/');
	assert.equal(agentProxyProbeUrl(codex, {}, none), undefined, 'agents without systemProxy get none');
	// Precedence: Claude Code settings.json env, then the agent env, then ours.
	assert.equal(agentProxyProbeUrl(claude, { ANTHROPIC_BASE_URL: 'https://ours.example/v1' }, none), 'https://ours.example/');
	assert.equal(agentProxyProbeUrl({ ...claude, env: { ANTHROPIC_BASE_URL: 'http://agent.example:8080/api' } }, { ANTHROPIC_BASE_URL: 'https://ours.example' }, none), 'http://agent.example:8080/');
	assert.equal(agentProxyProbeUrl({ ...claude, env: { ANTHROPIC_BASE_URL: 'https://agent.example' } }, {}, () => ({ ANTHROPIC_BASE_URL: 'https://relay.example/x' })), 'https://relay.example/');
	// Junk or non-HTTP values fall through to the next source.
	assert.equal(agentProxyProbeUrl(claude, { ANTHROPIC_BASE_URL: 'ftp://x' }, () => ({ ANTHROPIC_BASE_URL: 42 })), 'https://api.anthropic.com/');
	// Only Claude Code reads ANTHROPIC_BASE_URL.
	assert.equal(agentProxyProbeUrl(agy, { ANTHROPIC_BASE_URL: 'https://relay.example' }, none), 'https://www.google.com/');
});
