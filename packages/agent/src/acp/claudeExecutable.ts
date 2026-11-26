import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { resolveCommand } from './command.ts';
import { AcpRequestError } from './protocol.ts';

const EXECUTABLE_VAR = 'CLAUDE_CODE_EXECUTABLE';
const ADAPTER_PACKAGE = '@agentclientprotocol/claude-agent-acp';
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const STANDALONE_EXE = '@anthropic-ai/claude-code/bin/claude.exe';

function packageFile(from: string, specifier: string): string | undefined {
	try {
		const path = createRequire(from).resolve(specifier);
		// Node caches successful resolutions. The Claude updater can move the file mid-run.
		return statSync(path).isFile() ? path : undefined;
	} catch { return undefined; }
}

/** Recover a Windows npm adapter whose platform executable has gone missing. */
export function withClaudeCodeExecutable(command: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (process.platform !== 'win32' || !isAbsolute(command) || basename(command).toLowerCase() !== 'claude-agent-acp.cmd') return env;
	if (Object.keys(env).some((name) => name.toUpperCase() === EXECUTABLE_VAR)) return env;

	const adapter = packageFile(command, ADAPTER_PACKAGE + '/package.json');
	if (!adapter) return env;
	const sdk = packageFile(adapter, SDK_PACKAGE);
	if (!sdk) return env;
	const nativePackage = `${SDK_PACKAGE}-win32-${process.arch}`;
	try {
		// Only use this fallback for npm shims and SDK versions that expect this optional executable.
		const shim = readFileSync(command, 'utf8').replaceAll('\\', '/');
		if (!shim.includes(ADAPTER_PACKAGE + '/')) return env;
		const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> };
		if (!manifest.optionalDependencies?.[nativePackage]) return env;
	} catch { return env; }

	const nativeExe = nativePackage + '/claude.exe';
	if (packageFile(adapter, nativeExe) || packageFile(sdk, nativeExe)) return env;

	// The adapter spawns this path directly, so supply the executable behind any npm shim.
	const launcher = resolveCommand('claude.cmd', env);
	const onPath = resolveCommand('claude.exe', env);
	const executable = packageFile(command, STANDALONE_EXE)
		?? (launcher && isAbsolute(launcher) ? packageFile(launcher, STANDALONE_EXE) : undefined)
		?? (onPath && isAbsolute(onPath) ? onPath : undefined)
		?? resolveCommand(join(homedir(), '.local', 'bin', 'claude.exe'), env);
	return executable ? { ...env, [EXECUTABLE_VAR]: executable } : env;
}

/** The adapter sends this explanation as JSON-RPC data behind a generic Internal error. */
export function claudeExecutableError(error: unknown): Error | null {
	if (!(error instanceof AcpRequestError) || error.code !== -32603) return null;
	const details = (error.data as { details?: unknown } | null)?.details;
	if (typeof details !== 'string' || !/^Claude native binary not found for [\w-]+\./.test(details)) return null;
	return new Error('找不到 Claude Code 的可执行文件。请安装独立的 Claude Code 或重新安装 Claude ACP，然后重试。');
}
