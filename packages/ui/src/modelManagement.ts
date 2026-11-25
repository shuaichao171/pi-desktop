export type ModelManagementTarget =
	| { kind: 'manage' }
	| { kind: 'add-provider' }
	| { kind: 'provider'; provider: string }
	/** The Agents settings page (external ACP agents). */
	| { kind: 'agents' };
