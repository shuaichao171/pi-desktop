/**
 * pi-subagents plugin integration surface.
 *
 * The plugin reports live async child-agent work to RPC hosts through a
 * bounded JSON snapshot on the `subagent-async` widget key
 * (`PI_SUBAGENT_ASYNC_JSON:` payload) and answers on-demand detail requests
 * through `/subagents-inspect-rpc` replies on the `subagent-inspect` widget
 * key (`PI_SUBAGENT_INSPECT_JSON:` payload, correlated by requestId).
 *
 * Everything here is defensive: unknown fields, malformed payloads, and a
 * missing plugin are all valid states and must degrade to null/empty without
 * errors. Forward compatibility rule from the plugin docs: ignore unknown
 * fields and event types.
 */

/** Node states used by the plugin's async status snapshot (version 1). */
export type UiSubagentFleetState = 'queued' | 'running' | 'complete' | 'failed' | 'partial' | 'paused' | 'stopped' | 'rejected';

export type UiSubagentFleetNodeKind = 'subagent' | 'workflow' | 'step' | 'host-step';

/** Live activity of one child (best effort, all fields optional). */
export interface UiSubagentFleetActivity {
	state?: string;
	currentTool?: string;
	lastActivityAt?: number;
	currentToolStartedAt?: number;
	turnCount?: number;
	toolCount?: number;
}

/** Host-owned monitor row (watchdog verdicts, LSP checks...), display-only. */
export interface UiSubagentFleetHostStep {
	kind: string;
	state: string;
	provider?: string;
	role?: string;
	verdict?: string;
	reasonCode?: string;
	detail?: string;
	target?: string;
	stale?: boolean;
	report?: string;
}

export interface UiSubagentFleetNode {
	id: string;
	kind: UiSubagentFleetNodeKind;
	label: string;
	state: UiSubagentFleetState;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	activity?: UiSubagentFleetActivity;
	hostStep?: UiSubagentFleetHostStep;
	children?: UiSubagentFleetNode[];
}

/** Bounded projection of the plugin's `pi-subagents.async-status-snapshot` (version 1). */
export interface UiSubagentFleetSnapshot {
	generatedAt: number;
	/** Runs dropped by the plugin's snapshot caps (display as "+N more"). */
	omittedRuns: number;
	omittedChildren: number;
	runs: UiSubagentFleetNode[];
}

/** One message of an inspect reply's transcript tail. */
export interface UiSubagentInspectMessage {
	role?: string;
	text: string;
}

/** Defensive projection of a `pi-subagents.inspect-reply` (version 1). */
export interface UiSubagentInspectReply {
	/** Correlates with the requestId the caller passed to /subagents-inspect-rpc. */
	requestId: string;
	asyncId?: string;
	childId?: string;
	status?: string;
	label?: string;
	/** The child session's first user message, when attributable. */
	task?: string;
	/** Transcript tail, newest last, bounded (--lines). */
	messages?: UiSubagentInspectMessage[];
	finalOutput?: string;
	truncated?: boolean;
	error?: { code: string; message: string };
}
