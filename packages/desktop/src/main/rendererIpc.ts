import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

/** Only the main frame of a live application window may invoke the preload API. */
export function requireRendererSender(event: IpcMainInvokeEvent): BrowserWindow {
	const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
	if (!win || win.isDestroyed() || event.sender.isDestroyed() || win.webContents !== event.sender) {
		throw new Error('The requesting window is no longer available.');
	}
	if (!event.senderFrame || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid renderer sender');
	return win;
}

/**
 * Hosted pai chat windows share the process with the main window but must not
 * reach main-window-only channels (workbench, workspace and session管理,
 * automations, updates...). ipc.ts registers the classification at boot.
 */
interface RendererSenderRestriction {
	isPaiSender(event: IpcMainInvokeEvent): boolean;
	mainOnlyChannels: ReadonlySet<string>;
	/** Folder a hosted pai window was opened for; undefined for other windows. */
	hostedWorkspace(event: IpcMainInvokeEvent): string | undefined;
}
let senderRestriction: RendererSenderRestriction | null = null;

export function setRendererSenderRestriction(restriction: RendererSenderRestriction | null): void {
	senderRestriction = restriction;
}

/**
 * Folder a hosted pai chat window is bound to; undefined for every other window.
 * Read-only handlers a pai window may also reach use it to stay inside the folder
 * the window was opened for instead of the main window's active workspace.
 */
export function hostedSenderWorkspace(event: IpcMainInvokeEvent): string | undefined {
	return senderRestriction?.hostedWorkspace(event);
}

export function handleRendererInvoke<Args extends unknown[]>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown): void {
	ipcMain.handle(channel, (event, ...args: Args) => {
		requireRendererSender(event);
		if (senderRestriction?.isPaiSender(event) && senderRestriction.mainOnlyChannels.has(channel)) {
			throw new Error('该功能仅在 Pi Desktop 主窗口中可用');
		}
		return handler(event, ...args);
	});
}

/** A closing/crashed renderer cannot interrupt delivery to the other windows. */
export function broadcastToRenderers(channel: string, payload: unknown, include?: (win: BrowserWindow) => boolean): void {
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			if (include && !include(win)) continue;
			if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
		} catch (error) {
			console.error(`Failed to send ${channel} to renderer:`, error);
		}
	}
}
