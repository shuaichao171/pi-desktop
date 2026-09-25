export type ModelManagementTarget =
	| { kind: 'manage' }
	| { kind: 'add-provider' }
	| { kind: 'provider'; provider: string };
