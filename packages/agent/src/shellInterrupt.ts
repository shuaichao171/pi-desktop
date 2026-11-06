/**
 * Interruptible shell tools (bash / powershell) for Pi Desktop.
 *
 * Pi's agent loop only offers `abort()` (ends the whole turn) — there is no way
 * to stop just the command a tool is currently running. The queue's steer
 * messages are only polled at input acceptance points, so a long script also
 * blocks every queued instruction. This module closes that gap:
 *
 * - The built-in `bash` / `powershell` tools are replaced (via the SDK's
 *   `customTools`, same mechanism as the Windows GBK override) with tool
 *   definitions whose shell operations we own. Every spawned command is
 *   registered in a per-session registry keyed by toolCallId.
 * - `interrupt()` kills the process tree of the running command. The exec
 *   resolves normally with exit code 130 plus an `[interrupted by user]`
 *   marker in the output, so the tool call fails, the agent loop continues,
 *   and queued steering is delivered at the next acceptance point — the turn
 *   itself is never aborted.
 *
 * The exec implementation mirrors pi's local shell operations (detached on
 * Unix, stdin transport for legacy WSL bash, timeout → `timeout:<seconds>`,
 * abort → `aborted`, signal exits reported as 128+signal) because the SDK does
 * not export its internal process helpers and restricts deep imports.
 *
 * SDK exports are resolved through a dynamic import so an older custom Pi
 * engine that lacks them keeps the built-in tools (no interrupt support)
 * instead of failing to load the agent host.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AgentToolUpdateCallback, BashOperations, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { hasGbkSupport, wrapOperationsWithTranscoding, type ShellEncodingSettings } from './winShellEncoding.ts';

/** Exit code reported for user-interrupted commands (128 + SIGINT convention). */
export const INTERRUPT_EXIT_CODE = 130;
/** Marker appended to the command output so the model understands the failure. */
const INTERRUPT_MARKER = '\n[interrupted by user]\n';
/** Grace window for output pipes to fall quiet after the shell exits. */
const EXIT_PIPE_GRACE_MS = 120;

/** A running shell command that can be interrupted from the UI. */
export interface ShellRunHandle {
	readonly tool: 'bash' | 'powershell';
	readonly toolCallId: string;
	readonly command: string;
	readonly startedAt: number;
	/** Kill the process tree. Returns false when the command already ended. */
	interrupt(): boolean;
}

/** Running shell commands per session (usually zero or one per toolCallId). */
export class ShellRunRegistry {
	private readonly sessions = new Map<string, Map<string, ShellRunHandle>>();

	register(sessionId: string, handle: ShellRunHandle): void {
		let bucket = this.sessions.get(sessionId);
		if (!bucket) { bucket = new Map(); this.sessions.set(sessionId, bucket); }
		bucket.set(handle.toolCallId, handle);
	}

	unregister(sessionId: string, toolCallId: string): void {
		const bucket = this.sessions.get(sessionId);
		if (!bucket) return;
		bucket.delete(toolCallId);
		if (bucket.size === 0) this.sessions.delete(sessionId);
	}

	running(sessionId: string): ShellRunHandle[] {
		return [...(this.sessions.get(sessionId)?.values() ?? [])];
	}

	/** Interrupt matching commands; returns how many kills were issued. */
	interrupt(sessionId: string, toolCallId?: string): number {
		let interrupted = 0;
		for (const handle of this.running(sessionId)) {
			if (toolCallId !== undefined && handle.toolCallId !== toolCallId) continue;
			if (handle.interrupt()) interrupted += 1;
		}
		return interrupted;
	}

	clear(): void { this.sessions.clear(); }
}

/**
 * Process-wide registry. The agent host runs one process; entries are keyed by
 * session id so background sessions (automations) are never cross-interrupted.
 */
export const shellRunRegistry = new ShellRunRegistry();

/** Routes the executing toolCallId/sessionId down into the operations layer. */
const execScope = new AsyncLocalStorage<{ sessionId: string; toolCallId: string }>();

function killProcessTree(pid: number): void {
	if (process.platform === 'win32') {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		try {
			const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
				stdio: 'ignore',
				detached: true,
				windowsHide: true,
			});
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once('error', () => { });
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// Already gone.
			}
		}
	}
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/**
 * Wait for the shell to terminate without hanging on stdio pipes held open by
 * detached descendants: resolve on exit once the pipes end or fall quiet.
 */
function waitForChildSettled(child: ChildProcess): Promise<{ code: number | null; signalCode: string | null }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let code: number | null = null;
		let signalCode: string | null = null;
		let openPipes = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
		let quietTimer: ReturnType<typeof setTimeout> | null = null;
		// The grace path is a post-exit fallback only: a running-but-quiet
		// command (sleep, a daemon startup) must never resolve early.
		const armQuiet = () => { if (quietTimer) clearTimeout(quietTimer); quietTimer = setTimeout(() => { if (exited) finish(); }, EXIT_PIPE_GRACE_MS); };
		function finish() {
			if (settled) return;
			settled = true;
			if (quietTimer) clearTimeout(quietTimer);
			child.stdout?.removeListener('data', armQuiet);
			child.stderr?.removeListener('data', armQuiet);
			child.stdout?.removeListener('end', onPipeClosed);
			child.stderr?.removeListener('end', onPipeClosed);
			resolve({ code, signalCode });
		}
		function onPipeClosed() {
			openPipes = Math.max(0, openPipes - 1);
			if (exited && openPipes === 0) finish();
		}
		child.once('error', (error) => {
			if (settled) return;
			settled = true;
			if (quietTimer) clearTimeout(quietTimer);
			reject(error);
		});
		child.once('exit', (exitCode, sig) => {
			exited = true;
			code = exitCode;
			signalCode = sig;
			if (openPipes === 0) finish();
			else armQuiet();
		});
		child.stdout?.on('data', armQuiet);
		child.stderr?.on('data', armQuiet);
		child.stdout?.on('end', onPipeClosed);
		child.stderr?.on('end', onPipeClosed);
	});
}

/** Shell operations that own the child process and register it for interruption. */
export function createInterruptibleShellOperations(
	tool: 'bash' | 'powershell',
	resolveShell: () => { shell: string; args: string[]; commandTransport?: 'argv' | 'stdin' },
	registry: ShellRunRegistry = shellRunRegistry,
): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const scope = execScope.getStore();
			const shell = resolveShell();
			const stdinTransport = shell.commandTransport === 'stdin';
			const child = spawn(shell.shell, stdinTransport ? shell.args : [...shell.args, command], {
				cwd,
				detached: process.platform !== 'win32',
				env: options.env ?? process.env,
				stdio: [stdinTransport ? 'pipe' : 'ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
			if (stdinTransport) {
				child.stdin?.on('error', () => { });
				child.stdin?.end(command);
			}
			const state = { exited: false, interrupted: false };
			const sessionId = scope?.sessionId ?? '';
			const handle: ShellRunHandle = {
				tool,
				toolCallId: scope?.toolCallId ?? '',
				command,
				startedAt: Date.now(),
				interrupt() {
					if (state.exited || state.interrupted) return false;
					state.interrupted = true;
					if (child.pid) killProcessTree(child.pid);
					return true;
				},
			};
			if (scope) registry.register(sessionId, handle);
			let timedOut = false;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
			try {
				child.stdout?.on('data', options.onData);
				child.stderr?.on('data', options.onData);
				if (options.timeout !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, options.timeout * 1000);
				}
				const signal = options.signal;
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener('abort', onAbort, { once: true });
				}
				const { code, signalCode } = await waitForChildSettled(child);
				state.exited = true;
				if (signal?.aborted) throw new Error('aborted');
				if (timedOut) throw new Error(`timeout:${options.timeout}`);
				if (state.interrupted) {
					// The command failed on purpose; report it through the normal
					// result path so the agent loop (and queued steering) continues.
					options.onData(Buffer.from(INTERRUPT_MARKER, 'utf8'));
					return { exitCode: INTERRUPT_EXIT_CODE };
				}
				return { exitCode: code ?? (signalCode ? 128 + (SIGNAL_NUMBERS[signalCode] ?? 0) : 1) };
			} finally {
				state.exited = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener('abort', onAbort);
				if (scope) registry.unregister(sessionId, handle.toolCallId);
			}
		},
	};
}

/** Wrap a tool definition so its executions register in the shell run registry. */
export function withShellRunTracking(definition: ToolDefinition): ToolDefinition {
	const execute = definition.execute;
	if (typeof execute !== 'function') return definition;
	const tracked = (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<never> | undefined, ctx: ExtensionToolContext | undefined) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? '';
		return execScope.run({ sessionId, toolCallId }, () => (execute as (id: string, args: unknown, sig: AbortSignal | undefined, update: AgentToolUpdateCallback<never> | undefined, context: ExtensionToolContext | undefined) => unknown).call(definition, toolCallId, params, signal, onUpdate, ctx));
	};
	return { ...definition, execute: tracked } as ToolDefinition;
}

/**
 * Build the desktop's interruptible `bash` (all platforms) and `powershell`
 * (Windows) tool overrides. Returns [] when the engine lacks the required SDK
 * exports — the built-in tools then keep working without interrupt support.
 * Shell path/prefix are read at execution time so settings changes survive
 * session reloads, matching the built-in tools' behavior.
 */
export async function createInterruptibleShellTools(
	cwd: string,
	settings: ShellEncodingSettings,
	registry: ShellRunRegistry = shellRunRegistry,
): Promise<ToolDefinition[]> {
	const sdk = await import('@earendil-works/pi-coding-agent');
	const { createBashToolDefinition, createPowerShellToolDefinition, getShellConfig, getPowerShellConfig } = sdk as {
		createBashToolDefinition?: typeof import('@earendil-works/pi-coding-agent')['createBashToolDefinition'];
		createPowerShellToolDefinition?: typeof import('@earendil-works/pi-coding-agent')['createPowerShellToolDefinition'];
		getShellConfig?: typeof import('@earendil-works/pi-coding-agent')['getShellConfig'];
		getPowerShellConfig?: typeof import('@earendil-works/pi-coding-agent')['getPowerShellConfig'];
	};
	if (typeof createBashToolDefinition !== 'function' || typeof getShellConfig !== 'function') return [];
	const tools: ToolDefinition[] = [];
	const baseBashOperations = createInterruptibleShellOperations('bash', () => getShellConfig(settings.getShellPath() ?? undefined), registry);
	let bashOperations: BashOperations = {
		exec: (command, execCwd, options) => {
			// Apply the configured command prefix at execution time (same as the
			// previous Windows GBK override; the built-in reads it once at build).
			const prefix = settings.getShellCommandPrefix();
			const resolved = prefix ? `${prefix}\n${command}` : command;
			return baseBashOperations.exec(resolved, execCwd, options);
		},
	};
	if (process.platform === 'win32' && hasGbkSupport()) bashOperations = wrapOperationsWithTranscoding(bashOperations);
	tools.push(withShellRunTracking(createBashToolDefinition(cwd, { operations: bashOperations }) as ToolDefinition));
	if (process.platform === 'win32' && typeof createPowerShellToolDefinition === 'function' && typeof getPowerShellConfig === 'function') {
		let powershellOperations = createInterruptibleShellOperations('powershell', () => getPowerShellConfig(), registry);
		if (hasGbkSupport()) powershellOperations = wrapOperationsWithTranscoding(powershellOperations);
		tools.push(withShellRunTracking(createPowerShellToolDefinition(cwd, { operations: powershellOperations }) as ToolDefinition));
	}
	return tools;
}
