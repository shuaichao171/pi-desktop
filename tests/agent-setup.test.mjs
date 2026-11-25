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
