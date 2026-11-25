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

type SystemProxyResolver = (url: string) => Promise<string>;

/** Agents talk to overseas services; a PAC file is asked about one of them. */
const PROBE_URL = 'https://www.google.com/';
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
let systemProxy: string | null = null;
let refreshing: Promise<void> | null = null;
let refreshId = 0;

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

/** Install the resolver (once per process) and read the current setting. */
export function configureAgentSystemProxy(next: SystemProxyResolver): Promise<void> {
	resolver = next;
	refreshing = null;
	return refreshAgentSystemProxy();
}

/** Re-read the system proxy; call before starting an agent process. Never throws. */
export function refreshAgentSystemProxy(): Promise<void> {
	const resolve = resolver;
	if (!resolve) return Promise.resolve();
	if (refreshing) return refreshing;
	const id = ++refreshId;
	refreshing = (async () => {
		// Yield first: a resolver that throws synchronously would otherwise run the
		// `finally` below before `refreshing` is assigned and leave it stuck.
		await Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), REFRESH_TIMEOUT_MS); });
			systemProxy = proxyUrlFromResolution(await Promise.race([resolve(PROBE_URL), timeout]));
		} catch { /* keep the last known setting */ } finally {
			clearTimeout(timer);
			// A newer refresh (after configureAgentSystemProxy) owns the slot now.
			if (refreshId === id) refreshing = null;
		}
	})();
	return refreshing;
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
export function withSystemProxy(env: NodeJS.ProcessEnv, proxy: string | null = systemProxy, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
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
