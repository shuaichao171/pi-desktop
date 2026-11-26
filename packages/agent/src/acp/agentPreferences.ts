import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isValidAgentId, PI_AGENT_ID } from '@pidesktop/shared';
import { parseAgentSettings, type AgentSettingsRecord } from './handoff.ts';

interface StoredPreferences {
	version: 1;
	/** Agent id → the model and settings last chosen in any of its conversations. */
	agents: Record<string, AgentSettingsRecord>;
}

/**
 * The last model and settings the user chose for each external agent, so a new
 * conversation with that agent starts from them instead of the agent's default.
 * A conversation's own choices (its session record) always come first.
 *
 * Permission modes are never stored here: one conversation set to skip approvals
 * must not make every later conversation start that way.
 *
 * The file is re-read before every change: split panes run their own agent host,
 * and a stale copy must not overwrite another process's choice.
 */
export class AgentPreferences {
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	get(agentId: string): AgentSettingsRecord | null {
		return this.read().agents[agentId] ?? null;
	}

	/** Record one choice; failures only lose the remembered default, never the choice itself. */
	remember(agentId: string, change: { model?: string; option?: [string, string] }): void {
		if (!isValidAgentId(agentId) || agentId === PI_AGENT_ID) return;
		try {
			const stored = this.read();
			const previous = stored.agents[agentId] ?? { options: {} };
			const next = parseAgentSettings({
				model: change.model ?? previous.model,
				options: change.option ? { ...previous.options, [change.option[0]]: change.option[1] } : previous.options,
			});
			stored.agents[agentId] = next;
			this.write(stored);
		} catch { /* a remembered default is a convenience */ }
	}

	private read(): StoredPreferences {
		try {
			const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; agents?: unknown };
			if (parsed?.version === 1 && parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)) {
				const agents = Object.fromEntries(Object.entries(parsed.agents)
					.filter(([id]) => isValidAgentId(id) && id !== PI_AGENT_ID)
					.map(([id, value]) => [id, parseAgentSettings(value)]));
				return { version: 1, agents };
			}
		} catch { /* missing or malformed: nothing remembered */ }
		return { version: 1, agents: {} };
	}

	private write(stored: StoredPreferences): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		renameSync(temp, this.file);
	}
}
