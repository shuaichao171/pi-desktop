import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebContentsView } from 'electron';
import { createIsolatedAgentService } from './agentClient';

export interface PaiPaneSlot {
	paneId: number;
	view: WebContentsView;
	parentWin: BrowserWindow;
	webContents: WebContents;
	cwd: string;
	sessionPath?: string;
	agent: PaneAgentService;
	liveSessionPath: string | null;
	busy: boolean;
	loaded: boolean;
	firstPaintReady: boolean;
	rendererReady: boolean;
	revealed: boolean;
	closing: boolean;
	disposed: boolean;
}

export type PaneAgentService = ReturnType<typeof createIsolatedAgentService>;

const paneSlotMap = new Map<WebContents, PaiPaneSlot>();

export function registerPaneSlot(slot: PaiPaneSlot): void {
	paneSlotMap.set(slot.webContents, slot);
}

export function unregisterPaneSlot(webContents: WebContents): void {
	paneSlotMap.delete(webContents);
}

export function paneSlots(): PaiPaneSlot[] {
	return [...paneSlotMap.values()];
}

export function paneSlotForSender(sender: WebContents | undefined): PaiPaneSlot | undefined {
	if (!sender || sender.isDestroyed()) return undefined;
	return paneSlotMap.get(sender);
}

export function isPaneSender(event: IpcMainInvokeEvent): boolean {
	return paneSlotForSender(event.sender) !== undefined;
}

/** Conversations hosted split panes are writing; other agents must not restore them. */
export function paneHeldSessionPaths(): string[] {
	const paths: string[] = [];
	for (const slot of paneSlotMap.values()) {
		// The requested path counts from the moment the pane opens: the agent init
		// takes seconds and the session must not be double-activated meanwhile.
		if (slot.sessionPath) paths.push(slot.sessionPath);
		if (slot.liveSessionPath && slot.liveSessionPath !== slot.sessionPath) paths.push(slot.liveSessionPath);
	}
	return paths;
}

/** Union held-session check: a session in any hosted pane or pai window. */
export function hostedHeldSessionPaths(): string[] {
	return [...paiHeldSessionPaths(), ...paneHeldSessionPaths()];
}

