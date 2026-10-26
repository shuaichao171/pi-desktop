import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';

/**
 * Registry of hosted pai chat windows.
 *
 * Creation and lifecycle live in ipc.ts; this module only tracks which windows
 * are pai windows so renderer invokes can be routed to the right agent host
 * and main-window-only channels can be enforced (see rendererIpc.ts).
 */

export interface PaiWindowSlot {
	win: BrowserWindow;
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
