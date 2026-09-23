import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { WorkbenchService } from './workbenchService';

export function registerWorkbenchIpc(getWorkspace: () => string): WorkbenchService {
	const service = new WorkbenchService(getWorkspace, (event) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send(IPC_CHANNELS.workspaceCommandEvent, event);
		}
	});
	ipcMain.handle(IPC_CHANNELS.workspaceListEntries, (_event, relativePath?: string) => service.listEntries(relativePath));
	ipcMain.handle(IPC_CHANNELS.workspaceReadFile, (_event, relativePath: string) => service.readFile(relativePath));
	ipcMain.handle(IPC_CHANNELS.workspaceGitStatus, () => service.gitStatus());
	ipcMain.handle(IPC_CHANNELS.workspaceGitDiff, (_event, relativePath: string) => service.gitDiff(relativePath));
	ipcMain.handle(IPC_CHANNELS.workspaceCommandStart, (_event, command: string) => service.startCommand(command));
	ipcMain.handle(IPC_CHANNELS.workspaceCommandStop, (_event, id: string) => service.stopCommand(id));
	return service;
}
