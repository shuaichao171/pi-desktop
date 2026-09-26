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

export function handleRendererInvoke<Args extends unknown[]>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown): void {
	ipcMain.handle(channel, (event, ...args: Args) => {
		requireRendererSender(event);
		return handler(event, ...args);
	});
}

/** A closing/crashed renderer cannot interrupt delivery to the other windows. */
export function broadcastToRenderers(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
		} catch (error) {
			console.error(`Failed to send ${channel} to renderer:`, error);
		}
	}
}
