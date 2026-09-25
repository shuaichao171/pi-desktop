import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { WorkbenchService } from './workbenchService';

export function registerWorkbenchIpc(getWorkspace: () => string): WorkbenchService {
	const service = new WorkbenchService(getWorkspace, (event) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send(IPC_CHANNELS.workspaceCommandEvent, event);
		}
	});
	ipcMain.handle(IPC_CHANNELS.workspaceOpenFolder, async (event, cwd: string) => {
		const requireSender = () => {
			const win = BrowserWindow.fromWebContents(event.sender);
			if (!win || win.isDestroyed() || event.sender.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== win.webContents.mainFrame) {
				throw new Error('无法确认文件夹打开请求来源');
			}
		};
		requireSender();
		await service.openWorkspaceFolder(cwd, (path) => {
			requireSender();
			return shell.openPath(path);
		});
	});
	ipcMain.handle(IPC_CHANNELS.workspaceOpenInVsCode, async (event, cwd: string) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.isDestroyed() || event.sender.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== win.webContents.mainFrame) {
			throw new Error('无法确认编辑器打开请求来源');
		}
		await service.openWorkspaceInVsCode(cwd);
	});
	ipcMain.handle(IPC_CHANNELS.workspaceOpeners, () => service.listWorkspaceOpeners());
	ipcMain.handle(IPC_CHANNELS.workspaceCommitContext, () => service.gitCommitContext());
	ipcMain.handle(IPC_CHANNELS.workspaceCommit, (_event, message: string) => service.gitCommit(message));
	ipcMain.handle(IPC_CHANNELS.workspaceListEntries, (_event, relativePath?: string) => service.listEntries(relativePath));
	ipcMain.handle(IPC_CHANNELS.workspaceReadFile, (_event, relativePath: string) => service.readFile(relativePath));
	ipcMain.handle(IPC_CHANNELS.workspaceGitStatus, () => service.gitStatus());
	ipcMain.handle(IPC_CHANNELS.workspaceGitDiff, (_event, relativePath: string) => service.gitDiff(relativePath));
	ipcMain.handle(IPC_CHANNELS.workspaceBranches, () => service.gitBranches());
	ipcMain.handle(IPC_CHANNELS.workspaceCheckoutBranch, (_event, branch: string) => service.gitCheckout(branch));
	ipcMain.handle(IPC_CHANNELS.workspaceCommandStart, async (event, command: string) => {
		if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw new Error('命令无效或过长');
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame) throw new Error('无法确认命令来源');
		const cwd = getWorkspace();
		if (!cwd) throw new Error('请先打开工作区');
		const english = getAppLocale() === 'en-US';
		const result = await dialog.showMessageBox(win, {
			type: 'warning',
			buttons: english ? ['Cancel', 'Run command'] : ['取消', '运行命令'],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
			message: english ? 'Run this command on your computer?' : '要在本机运行此命令吗？',
			detail: `${english ? 'Workspace' : '工作区'}: ${cwd}\n\n${command}`,
		});
		// An empty id means the user cancelled; no process is started.
		if (result.response !== 1) return '';
		if (win.isDestroyed() || event.sender.isDestroyed()) return '';
		if (getWorkspace() !== cwd) throw new Error(english ? 'Workspace changed; run the command again.' : '工作区已切换，请重新运行命令');
		return service.startCommand(command, cwd);
	});
	ipcMain.handle(IPC_CHANNELS.workspaceCommandStop, (_event, id: string) => service.stopCommand(id));
	return service;
}
