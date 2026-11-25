import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UiAgentConfig, UiAgentInstaller } from '@pidesktop/shared';
import { refreshAgentSystemProxy, withSystemProxy } from './agentProxy.ts';
import { BUILTIN_AGENTS, installerCommandLine } from './agentRegistry.ts';
import { resolveCommand, spawnResolved, withAgentSearchPath } from './command.ts';

/**
 * One-click setup of built-in agents: the official installer and the agent's
 * own interactive sign-in. Every command line comes from the built-in catalog;
 * callers only pass an agent id.
 */

export { BUILTIN_AGENTS, installerCommandLine } from './agentRegistry.ts';
export { refreshStoredSearchPath, withAgentSearchPath } from './command.ts';
export { configureAgentSystemProxy } from './agentProxy.ts';

/** Catalog entries only accept plain tokens, so no shell quoting can go wrong. */
const SAFE_TOKEN = /^[\w@./:=-]+$/;
const SAFE_URL = /^https:\/\/[\w.-]+(?:\/[\w.\-/]*)?$/;

export function builtinAgent(agentId: string): UiAgentConfig | undefined {
	return BUILTIN_AGENTS.find((agent) => agent.id === agentId);
}

export interface AgentInstallProcess {
	child: ChildProcess;
	/** The command as shown to the user. */
	display: string;
}

/** Environment for installers: fresh search PATH, no colours, no npm chatter. */
function installEnv(): NodeJS.ProcessEnv {
	return withAgentSearchPath({
		...process.env,
		NO_COLOR: '1', FORCE_COLOR: '0',
		npm_config_color: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false', npm_config_progress: 'false',
	});
}

/** PowerShell arguments carrying `script` base64-encoded, so no command-line quoting is involved. */
function encodedPowerShellArgs(script: string): string[] {
	return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
	const root = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot;
	const system = root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
	return (system && resolveCommand(system, env)) ?? 'powershell.exe';
}

/**
 * Start an installer. stdin is closed, so an installer that asks a question
 * gets EOF instead of hanging. POSIX installers get their own process group
 * so cancelling stops the whole pipeline.
 */
export function startAgentInstall(installer: UiAgentInstaller, platform: NodeJS.Platform = process.platform): AgentInstallProcess {
	const env = installEnv();
	const display = installerCommandLine(installer, platform);
	const options = { env, stdio: ['ignore', 'pipe', 'pipe'] as const, windowsHide: true, detached: platform !== 'win32' };
	if (installer.kind === 'npm') {
		if (!SAFE_TOKEN.test(installer.package)) throw new Error('安装包名无效');
		const npm = resolveCommand('npm', env);
		if (!npm) throw new Error('未找到 npm。请先安装 Node.js（https://nodejs.org），然后重新打开 Pi Desktop 再试。');
		return { child: spawnResolved(npm, ['install', '-g', installer.package], { ...options, stdio: [...options.stdio] }), display };
	}
	const url = platform === 'win32' ? installer.windowsUrl : installer.posixUrl;
	if (!SAFE_URL.test(url)) throw new Error('安装脚本地址无效');
	if (platform === 'win32') {
		// Windows PowerShell 5.1 may still default to TLS 1.0 and draws a slow progress bar for downloads.
		const script = [
			"$ProgressPreference = 'SilentlyContinue'",
			'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
			'[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
			`irm '${url}' | iex`,
		].join('; ');
		// `-Command`, not `-EncodedCommand`: the encoded form reports errors as CLIXML
		// on a redirected stderr. The script holds no double quotes (URL checked above).
		return { child: spawn(windowsPowerShell(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { ...options, stdio: [...options.stdio] }), display };
	}
	return { child: spawn('/bin/bash', ['-c', `set -o pipefail; curl -fsSL '${url}' | bash`], { ...options, stdio: [...options.stdio] }), display };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('spawn', () => { child.unref(); resolve(); });
	});
}

const LINUX_TERMINALS: [string, string[]][] = [
	['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']],
];

/**
 * Open a new terminal window running the agent's sign-in. The window stays
 * open afterwards so the user can read the result.
 */
export async function openAgentLoginTerminal(agent: UiAgentConfig, platform: NodeJS.Platform = process.platform): Promise<void> {
	const login = agent.login;
	if (!login) throw new Error(`${agent.displayName} 没有可在终端中运行的登录命令`);
	if (![login.command, ...login.args].every((token) => SAFE_TOKEN.test(token))) throw new Error('登录命令无效');
	let env = withAgentSearchPath({ ...process.env, ...agent.env });
	if (agent.systemProxy) {
		// Sign-in pages and token exchanges go through the same proxy as the sessions.
		await refreshAgentSystemProxy();
		env = withSystemProxy(env);
	}
	const resolved = resolveCommand(login.command, env);
	if (!resolved) throw new Error(`未找到命令 ${login.command}，请先安装 ${agent.displayName}`);

	if (platform === 'win32') {
		// cmd quoting cannot carry an arbitrary path safely through `start`, so the
		// line goes into a script and PowerShell opens it with the path read from
		// the environment, never parsed as code.
		const dir = join(tmpdir(), 'pi-desktop-agent-login');
		mkdirSync(dir, { recursive: true });
		const script = join(dir, `${agent.id}.cmd`);
		const args = login.args.join(' ');
		writeFileSync(script, [
			'@echo off',
			'chcp 65001 >nul',
			`title ${agent.displayName} sign-in`,
			`call "${resolved.replace(/%/g, '%%')}"${args ? ` ${args}` : ''}`,
			'echo.',
			'echo Sign-in command finished. Return to Pi Desktop and check again.',
			'pause',
			'',
		].join('\r\n'), 'utf8');
		const child = spawn(windowsPowerShell(env),
			encodedPowerShellArgs(`Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c ""' + $env:PI_DESKTOP_LOGIN_SCRIPT + '""')`),
			{ env: { ...env, PI_DESKTOP_LOGIN_SCRIPT: script }, stdio: 'ignore', windowsHide: true });
		await new Promise<void>((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`无法打开终端（退出码 ${code}）`)));
		});
		return;
	}

	const line = `${[resolved, ...login.args].map(shellQuote).join(' ')}; echo; echo 'Sign-in command finished. Return to Pi Desktop and check again.'`;
	if (platform === 'darwin') {
		await waitForSpawn(spawn('osascript', [
			'-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'tell application "Terminal" to activate', '-e', 'end run',
			line,
		], { env, stdio: 'ignore', detached: true }));
		return;
	}
	const shellLine = `${line}; read -r -p 'Press Enter to close' _`;
	for (const [terminal, prefix] of LINUX_TERMINALS) {
		const path = resolveCommand(terminal, env);
		if (!path) continue;
		await waitForSpawn(spawn(path, [...prefix, 'bash', '-lc', shellLine], { env, stdio: 'ignore', detached: true }));
		return;
	}
	throw new Error(`未找到可用的终端程序，请手动运行：${[login.command, ...login.args].join(' ')}`);
}
