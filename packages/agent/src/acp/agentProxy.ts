/**
 * The OS proxy, handed to agent processes as environment variables.
 *
 * Agents are separate programs, and most of them (Go, Rust and Node CLIs: agy,
 * codex, claude, gemini) only read HTTP(S)_PROXY from their environment, never
 * the Windows/macOS proxy settings. With a VPN client in "system proxy" mode
 * (no TUN), Pi's own model requests work but those agents cannot reach their
 * service: sign-in and sessions hang or fail. So the desktop resolves the system
 * proxy and passes it down, unless the user already set a proxy variable.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UiAgentConfig } from '@pidesktop/shared';

type SystemProxyResolver = (url: string) => Promise<string>;

/**
 * Variables that move an agent to another endpoint (an API relay). The proxy is
 * resolved for that endpoint instead of the vendor's default, so a PAC file or the
 * system bypass list decides for the host the agent really calls.
 */
const BASE_URL_VARS: Partial<Record<string, string>> = { 'claude-code': 'ANTHROPIC_BASE_URL' };

/** `env` block of Claude Code's user settings, which Claude Code applies to itself. */
function claudeSettingsEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
	try {
		const file = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
		const settings = JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown };
		return settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
	} catch { return {}; }
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/` : undefined;
	} catch { return undefined; }
}

/**
 * The URL to resolve the system proxy for, or undefined when the agent gets none.
 * A configured endpoint override wins over the agent's default (`systemProxy`):
 * Claude Code's settings.json `env`, then the agent's own env, then ours.
 */
export function agentProxyProbeUrl(agent: Pick<UiAgentConfig, 'id' | 'systemProxy' | 'env'>, env: NodeJS.ProcessEnv = process.env, settingsEnv: (env: NodeJS.ProcessEnv) => Record<string, unknown> = claudeSettingsEnv): string | undefined {
	if (!agent.systemProxy) return undefined;
	const name = BASE_URL_VARS[agent.id];
	if (!name) return agent.systemProxy;
	return httpUrl(settingsEnv(env)[name]) ?? httpUrl(agent.env?.[name]) ?? httpUrl(env[name]) ?? agent.systemProxy;
}

const REFRESH_TIMEOUT_MS = 3000;
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
/**
 * Never proxied: loopback and private networks. The OS bypass list (`<local>`,
 * LAN ranges) is not exposed by proxy resolution, and the agent's own shell
 * commands inherit these variables, so intranet hosts must stay direct.
 * CIDR entries are honoured by Go, curl and Python; other clients skip them.
 */
const NO_PROXY_DEFAULT = 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local';

let resolver: SystemProxyResolver | undefined;
const lastProxies = new Map<string, string | null>();
const pendingProxies = new Map<string, Promise<string | null>>();

/**
 * A Chromium proxy resolution (`PROXY host:port; DIRECT`) → proxy URL, or null
 * for direct access. SOCKS is left alone: Node-based agents cannot use it from
 * the environment, and a proxy they cannot speak is worse than none.
 */
export function proxyUrlFromResolution(result: string): string | null {
	const directive = result.split(';').map((item) => item.trim()).find(Boolean);
	const match = directive ? /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(directive) : null;
	if (!match) return null;
	try {
		const url = new URL(`${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`);
		if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
		return `${url.protocol}//${url.host}`;
	} catch { return null; }
}

/** Install the resolver once per process. */
export function configureAgentSystemProxy(next: SystemProxyResolver): void {
	resolver = next;
	pendingProxies.clear();
}

/** Resolve the current system proxy for an agent before starting its process. */
export async function resolveAgentSystemProxy(url?: string): Promise<string | null> {
	const resolve = resolver;
	if (!resolve || !url) return null;
	const pending = pendingProxies.get(url);
	if (pending) return pending;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('timeout')), REFRESH_TIMEOUT_MS);
	});
	const lookup = Promise.race([Promise.resolve().then(() => resolve(url)), timeout]).then((value) => {
		const proxy = proxyUrlFromResolution(value);
		if (pendingProxies.get(url) === lookup) lastProxies.set(url, proxy);
		return proxy;
	}).catch(() => lastProxies.get(url) ?? null).finally(() => {
		clearTimeout(timer);
		if (pendingProxies.get(url) === lookup) pendingProxies.delete(url);
	});
	pendingProxies.set(url, lookup);
	return lookup;
}

function hasVar(env: NodeJS.ProcessEnv, name: string): boolean {
	return Object.entries(env).some(([key, value]) => key.toUpperCase() === name && !!value);
}

/** On Windows variable names are case-insensitive: drop other spellings so the child sees one. */
function setVar(env: NodeJS.ProcessEnv, name: string, value: string, platform: NodeJS.Platform): void {
	if (platform === 'win32') for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
	env[name] = value;
}

/** `env` with the system proxy added, when there is one and no proxy variable is set yet. */
export function withSystemProxy(env: NodeJS.ProcessEnv, proxy: string | null | undefined, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
	if (!proxy || PROXY_VARS.some((name) => hasVar(env, name))) return env;
	const next = { ...env };
	const noProxy = hasVar(env, 'NO_PROXY') ? null : NO_PROXY_DEFAULT;
	setVar(next, 'HTTP_PROXY', proxy, platform);
	setVar(next, 'HTTPS_PROXY', proxy, platform);
	if (noProxy) setVar(next, 'NO_PROXY', noProxy, platform);
	if (platform !== 'win32') {
		// curl and some POSIX tools only read the lowercase spellings.
		next.http_proxy = proxy;
		next.https_proxy = proxy;
		if (noProxy) next.no_proxy = noProxy;
	}
	return next;
}
