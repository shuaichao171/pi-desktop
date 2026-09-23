import type { AgentBridge } from '@pidesktop/shared';

declare global {
	interface Window {
		piDesktop: AgentBridge;
	}
}

export {};
