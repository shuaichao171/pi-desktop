import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { UiAgentConfig } from '@pidesktop/shared';
import type { AcpToolCall } from './protocol.ts';

export const ANTIGRAVITY_COMMAND_APPROVALS = 'desktop-antigravity-command-approvals';

/** Bind desktop consent to the exact terminal request and the directory shown on the card. */
export function antigravityCommandApproval(config: UiAgentConfig, workspace: string, call: AcpToolCall): { command: string; cwd: string; key: string } | undefined {
	if (config.id !== 'antigravity' || call.kind !== 'execute' || call.content?.length) return;
	if (!call.rawInput || typeof call.rawInput !== 'object' || Array.isArray(call.rawInput)) return;
	const input = call.rawInput as Record<string, unknown>;
	if (Object.keys(input).some((name) => !['CommandLine', 'Cwd', 'WaitMsBeforeAsync', 'SafeToAutoRun'].includes(name))) return;
	const { CommandLine: command, Cwd: directory, SafeToAutoRun: safeToAutoRun, WaitMsBeforeAsync: wait } = input;
	if (typeof command !== 'string' || !command.trim() || command.length > 32_000 || command.includes('\0')) return;
	if (directory !== undefined && (typeof directory !== 'string' || !directory || !isAbsolute(directory))) return;
	if (safeToAutoRun !== undefined && typeof safeToAutoRun !== 'boolean') return;
	if (wait !== undefined && (typeof wait !== 'number' || !Number.isFinite(wait))) return;
	try {
		const root = realpathSync.native(workspace);
		const cwd = directory === undefined ? root : realpathSync.native(directory);
		const pathFromRoot = relative(root, cwd);
		if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot) || cwd.length > 4096) return;
		const env = Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
		const key = JSON.stringify([config.id, config.command, config.args, env, root, cwd, command, safeToAutoRun]);
		return { command, cwd, key };
	} catch { return; }
}
