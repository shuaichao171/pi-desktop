import { dialog, shell } from 'electron';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { WorkbenchService } from './workbenchService';
import { broadcastToRenderers, handleRendererInvoke, requireRendererSender } from './rendererIpc';

export function registerWorkbenchIpc(getWorkspace: () => string): WorkbenchService {
	const service = new WorkbenchService(getWorkspace, (event) => {
		broadcastToRenderers(IPC_CHANNELS.workspaceCommandEvent, event);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenFolder, async (event, cwd: string) => {
		await service.openWorkspaceFolder(cwd, (path) => {
			requireRendererSender(event);
			return shell.openPath(path);
		});
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenInVsCode, async (_event, cwd: string) => {
		await service.openWorkspaceInVsCode(cwd);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenPathInEditor, async (_event, relativePath: unknown, line: unknown, column: unknown) => {
		if (typeof relativePath !== 'string') throw new Error('文件路径无效');
		await service.openPathInEditor(relativePath, typeof line === 'number' ? line : undefined, typeof column === 'number' ? column : undefined);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceRevealPath, async (_event, relativePath: unknown) => {
		if (typeof relativePath !== 'string') throw new Error('文件路径无效');
		await service.revealPathInFolder(relativePath, (path) => shell.showItemInFolder(path));
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpeners, () => service.listWorkspaceOpeners());
	handleRendererInvoke(IPC_CHANNELS.workspaceCommitContext, () => service.gitCommitContext());
	handleRendererInvoke(IPC_CHANNELS.workspaceCommit, (_event, message: string) => service.gitCommit(message));
	handleRendererInvoke(IPC_CHANNELS.workspaceListEntries, (_event, relativePath?: string) => service.listEntries(relativePath));
	handleRendererInvoke(IPC_CHANNELS.workspaceReadFile, (_event, relativePath: string) => service.readFile(relativePath));
	handleRendererInvoke(IPC_CHANNELS.workspaceGitStatus, () => service.gitStatus());
	handleRendererInvoke(IPC_CHANNELS.workspaceGitDiff, (_event, relativePath: string, source?: 'staged' | 'unstaged' | 'all') => service.gitDiff(relativePath, source));
	handleRendererInvoke(IPC_CHANNELS.workspaceBranches, () => service.gitBranches());
	handleRendererInvoke(IPC_CHANNELS.workspaceCheckoutBranch, (_event, branch: string) => service.gitCheckout(branch));
	handleRendererInvoke(IPC_CHANNELS.workspaceGitSetStaged, (_event, paths: unknown, staged: unknown) => {
		if (!Array.isArray(paths) || typeof staged !== 'boolean') throw new Error('暂存参数无效');
		return service.gitSetStaged(paths, staged);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceGitDiscard, (_event, paths: unknown) => {
		if (!Array.isArray(paths)) throw new Error('丢弃参数无效');
		return service.gitDiscard(paths);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceGitLog, (_event, limit: unknown) => {
		const count = typeof limit === 'number' ? limit : 30;
		return service.gitLog(count);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceGitCreateBranch, (_event, name: unknown, checkout: unknown) => {
		if (typeof name !== 'string' || typeof checkout !== 'boolean') throw new Error('分支参数无效');
		return service.gitCreateBranch(name, checkout);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceCommandStart, async (event, command: string) => {
		if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw new Error('命令无效或过长');
		const win = requireRendererSender(event);
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
	handleRendererInvoke(IPC_CHANNELS.workspaceCommandStop, (_event, id: string) => service.stopCommand(id));
	return service;
}
