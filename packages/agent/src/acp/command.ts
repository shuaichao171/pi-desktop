import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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

function pathValue(env: NodeJS.ProcessEnv): string {
	if (!IS_WINDOWS) return env.PATH ?? process.env.PATH ?? '';
	const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
	return (key ? env[key] : undefined) ?? process.env.Path ?? process.env.PATH ?? '';
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
