import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

function isFile(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
	const raw = env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
	const list = raw.split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith('.'));
	return list.length ? list : ['.com', '.exe', '.bat', '.cmd'];
}

function pathKey(env: NodeJS.ProcessEnv): string {
	if (!IS_WINDOWS) return 'PATH';
	return Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path';
}

function pathValue(env: NodeJS.ProcessEnv): string {
	if (!IS_WINDOWS) return env.PATH ?? process.env.PATH ?? '';
	const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
	return (key ? env[key] : undefined) ?? process.env.Path ?? process.env.PATH ?? '';
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (!IS_WINDOWS) return env[name];
	const key = Object.keys(env).find((item) => item.toUpperCase() === name.toUpperCase());
	return key ? env[key] : undefined;
}

/**
 * Folders that official agent installers write to. A running app keeps the
 * PATH it started with, so a CLI installed afterwards (or whose installer only
 * edited the user PATH / shell profile) is still found here.
 */
export function knownAgentDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	if (IS_WINDOWS) {
		const appData = envValue(env, 'APPDATA');
		const localAppData = envValue(env, 'LOCALAPPDATA');
		return [
			...(appData ? [join(appData, 'npm')] : []),
			...(localAppData ? [join(localAppData, 'agy', 'bin')] : []),
		];
	}
	const home = env.HOME ?? process.env.HOME;
	return [
		...(home ? [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')] : []),
		'/usr/local/bin',
		'/opt/homebrew/bin',
	];
}

let storedPathDirs: string[] = [];

/** `reg query` value of one PATH entry, `%VAR%` expanded; entries that did not decode cleanly are dropped. */
function readRegistryPath(key: string, env: NodeJS.ProcessEnv): Promise<string[]> {
	return new Promise((resolve) => {
		execFile('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (error, stdout) => {
			const match = error ? null : /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout);
			if (!match) { resolve([]); return; }
			resolve(match[1].split(';')
				.map((item) => item.trim().replace(/%([^%]+)%/g, (whole, name: string) => envValue(env, name) ?? whole))
				.filter((item) => item && !item.includes('%') && !item.includes('�')));
		});
	});
}

/**
 * Re-read the user and machine PATH that installers edit (Windows registry).
 * Later `withAgentSearchPath` calls append these folders; elsewhere this is a no-op.
 */
export async function refreshStoredSearchPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (!IS_WINDOWS) return;
	const [user, machine] = await Promise.all([
		readRegistryPath('HKCU\\Environment', env),
		readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', env),
	]);
	storedPathDirs = [...machine, ...user];
}

/**
 * `env` with folders an installer may have added since this process started
 * appended to PATH (never prepended: what the PATH already finds wins).
 */
export function withAgentSearchPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const current = pathValue(env);
	const normalize = (dir: string) => {
		const value = dir.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
		return IS_WINDOWS ? value.toLowerCase() : value;
	};
	const seen = new Set(current.split(delimiter).map(normalize).filter(Boolean));
	const extra: string[] = [];
	for (const dir of [...storedPathDirs, ...knownAgentDirs(env)]) {
		const key = normalize(dir);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		extra.push(dir);
	}
	if (!extra.length) return env;
	return { ...env, [pathKey(env)]: [current, ...extra].filter(Boolean).join(delimiter) };
}

/**
 * Resolve an executable the way a shell would (PATH + PATHEXT on Windows),
 * without running anything. Returns null when nothing matches.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const value = command.trim();
	if (!value || value.includes('\0')) return null;
	const candidates = (base: string): string[] => {
		if (!IS_WINDOWS) return [base];
		const ext = extname(base).toLowerCase();
		const extensions = windowsExtensions(env);
		// An explicit runnable extension is used as-is; otherwise try PATHEXT in order.
		return ext && extensions.includes(ext) ? [base] : extensions.map((item) => base + item);
	};
	const hasSeparator = value.includes('/') || (IS_WINDOWS && value.includes('\\'));
	if (isAbsolute(value) || hasSeparator) {
		return candidates(value).find(isFile) ?? null;
	}
	for (const dir of pathValue(env).split(delimiter)) {
		const folder = dir.trim().replace(/^"(.*)"$/, '$1');
		if (!folder) continue;
		for (const candidate of candidates(join(folder, value))) {
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}

// cmd.exe quoting, following cross-spawn: quote for CommandLineToArgvW, then
// caret-escape cmd metacharacters (twice for batch files that forward `%*`,
// which cmd parses a second time: npm shims, both node_modules/.bin and the
// global %APPDATA%\npm ones).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
	let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
	quoted = `"${quoted}"`.replace(CMD_META, '^$1');
	return doubleEscape ? quoted.replace(CMD_META, '^$1') : quoted;
}

function escapeCmdCommand(command: string): string {
	return command.replace(CMD_META, '^$1');
}

/** True when a batch file passes its arguments on with `%*` (re-parsed by cmd). */
function forwardsArguments(path: string): boolean {
	if (/node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(path)) return true;
	try { return readFileSync(path, 'latin1').slice(0, 65536).includes('%*'); } catch { return false; }
}

/**
 * Spawn a resolved executable. Windows batch shims (.cmd/.bat, which is how
 * npm installs CLIs) cannot be spawned directly since Node 20, so they run
 * through cmd.exe with explicit escaping instead of `shell: true`.
 */
export function spawnResolved(resolved: string, args: string[], options: SpawnOptions): ChildProcess {
	const ext = extname(resolved).toLowerCase();
	if (IS_WINDOWS && (ext === '.cmd' || ext === '.bat')) {
		const doubleEscape = forwardsArguments(resolved);
		const line = [escapeCmdCommand(resolved), ...args.map((arg) => escapeCmdArgument(arg, doubleEscape))].join(' ');
		const shell = process.env.ComSpec && existsSync(process.env.ComSpec) ? process.env.ComSpec : 'cmd.exe';
		return spawn(shell, ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
	}
	return spawn(resolved, args, options);
}
