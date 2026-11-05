import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebContentsView } from 'electron';
import { createIsolatedAgentService } from './agentClient';

/**
 * Registry of hosted pai chat windows.
 *
 * Creation and lifecycle live in ipc.ts; this module only tracks which windows
 * are pai windows so renderer invokes can be routed to the right agent host
 * and main-window-only channels can be enforced (see rendererIpc.ts).
 */

export interface PaiWindowSlot {
	win: BrowserWindow;
	/** Folder this window was opened for; every read-only surface stays inside it. */
	cwd: string;
	agent: unknown;
	/** Session the slot's agent currently has open; null while switching or fresh. */
	liveSessionPath: string | null;
	busy: boolean;
}

const slots = new Map<BrowserWindow, PaiWindowSlot>();

export function registerPaiWindowSlot(slot: PaiWindowSlot): void {
	slots.set(slot.win, slot);
}

export function unregisterPaiWindowSlot(win: BrowserWindow): void {
	slots.delete(win);
}

export function paiWindowSlots(): PaiWindowSlot[] {
	return [...slots.values()];
}

export function isPaiWindow(win: BrowserWindow): boolean {
	return slots.has(win);
}

export function paiSlotForSender(sender: WebContents | undefined): PaiWindowSlot | undefined {
	if (!sender || sender.isDestroyed()) return undefined;
	for (const slot of slots.values()) {
		if (!slot.win.isDestroyed() && slot.win.webContents === sender) return slot;
	}
	return undefined;
}

export function isPaiSender(event: IpcMainInvokeEvent): boolean {
	return paiSlotForSender(event.sender) !== undefined;
}

/** Conversations hosted pai windows are writing; other agents must not restore them. */
export function paiHeldSessionPaths(): string[] {
	const paths: string[] = [];
	for (const slot of slots.values()) {
		if (slot.liveSessionPath) paths.push(slot.liveSessionPath);
	}
	return paths;
}

/** WebContents keyed pane slot — a split pane is a WebContentsView, not a BrowserWindow. */
export interface PaiPaneSlot {
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
		if (slot.liveSessionPath) paths.push(slot.liveSessionPath);
	}
	return paths;
}

/** Union held-session check: a session in any hosted pane or pai window. */
export function hostedHeldSessionPaths(): string[] {
	return [...paiHeldSessionPaths(), ...paneHeldSessionPaths()];
}
