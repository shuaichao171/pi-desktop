/**
 * pi-goal-x plugin integration surface.
 *
 * The desktop reads the plugin's durable state (`.pi/goals/` files and the
 * goal ledger) instead of importing plugin internals, so every method here
 * must degrade silently when the plugin is not installed: `available:false`
 * snapshots, empty lists, and unsubscribe-only listeners are all valid
 * "plugin absent" answers and never errors.
 */

/** One task of a goal's task list (top-level entries; subtasks fold into counts). */
export interface UiGoalTask {
	id: string;
	title: string;
	status: 'pending' | 'complete' | 'skipped';
	evidence?: string;
}

/** Defensive projection of a pi-goal-x GoalRecord (JSON prefix of active_goal_*.md). */
export interface UiGoalRecord {
	id: string;
	objective: string;
	status: 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete';
	autoContinue: boolean;
	sisyphus: boolean;
	createdAt: string;
	updatedAt: string;
	tokensUsed: number;
	activeSeconds: number;
	tokenBudget?: number;
	currentTaskId?: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	tasks: UiGoalTask[];
	pendingTasks: number;
	completedTasks: number;
	skippedTasks: number;
}

/** Newer-first tail of `.pi/goals/goal_events.jsonl`; raw type strings, never trusted beyond display. */
export interface UiGoalLedgerEvent {
	type: string;
	goalId?: string;
	at?: string;
}

export interface UiGoalSnapshot {
	cwd: string;
	/** False when `.pi/goals` does not exist (plugin not installed or never used here). */
	available: boolean;
	/** Open goals, newest activity first. */
	goals: UiGoalRecord[];
	/** Recent ledger events, newest first (best effort, may be empty). */
	recentEvents: UiGoalLedgerEvent[];
}

export interface GoalFeaturesBridge {
	/** Read the goal pool for one workspace. Never throws for a missing plugin; may throw for an unknown workspace. */
	getGoalSnapshot(cwd: string): Promise<UiGoalSnapshot>;
	/** Fired (main → renderer) whenever a workspace's goal files change. */
	onGoalChanged(listener: (cwd: string) => void): () => void;
}
