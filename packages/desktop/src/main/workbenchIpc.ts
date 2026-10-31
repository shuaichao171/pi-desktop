import { dialog, shell } from 'electron';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { WorkbenchService, type ProjectNicknameStore } from './workbenchService';
import { ResultFileService } from './resultFileService';
import { createWorkspaceWatcher } from './workspaceWatcher.ts';
import { broadcastToRenderers, handleRendererInvoke, requireRendererSender } from './rendererIpc';
import { isAbsolute, join } from 'node:path';
import { app } from 'electron';

export function registerWorkbenchIpc(getWorkspace: () => string, nicknameStore?: ProjectNicknameStore): WorkbenchService {
	const resultFiles = new ResultFileService(getWorkspace);
	handleRendererInvoke(IPC_CHANNELS.resultFileOpen, (event, target: unknown) => resultFiles.openResultFile(target, (path) => {
		requireRendererSender(event);
		return shell.openPath(path);
	}));
	handleRendererInvoke(IPC_CHANNELS.resultFileReveal, (event, target: unknown) => resultFiles.revealResultFile(target, (path) => {
		requireRendererSender(event);
		shell.showItemInFolder(path);
	}));
	handleRendererInvoke(IPC_CHANNELS.resultFilePreview, (event, target: unknown) => resultFiles.previewResultFile(target).then(preview => {
		requireRendererSender(event);
		return preview;
	}));
	const service = new WorkbenchService(getWorkspace, (event) => {
		broadcastToRenderers(IPC_CHANNELS.workspaceCommandEvent, event);
	}, nicknameStore);
	const watcher = createWorkspaceWatcher((event) => broadcastToRenderers(IPC_CHANNELS.workspaceChanged, event));
	handleRendererInvoke(IPC_CHANNELS.workspaceWatch, (_event, cwd: unknown) => {
		if (cwd === null) { watcher.watch(null); return; }
		// Only the active workspace may be watched; a stale request after a switch is ignored.
		if (typeof cwd !== 'string' || !cwd || cwd !== getWorkspace()) return;
		watcher.watch(cwd);
	});
	const disposeService = service.dispose.bind(service);
	service.dispose = async () => { watcher.stop(); await disposeService(); };
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenFolder, async (event, cwd: string) => {
		await service.openWorkspaceFolder(cwd, (path) => {
			requireRendererSender(event);
			return shell.openPath(path);
		});
	});
	// 自定义命令的“打开文件或文件夹”：相对路径按项目根解析，~ 展开为用户目录；文件用默认程序，文件夹用资源管理器。
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenPath, async (event, path: unknown, cwd: unknown) => {
		requireRendererSender(event);
		if (typeof path !== 'string' || path.trim().length === 0) throw new Error('路径无效');
		if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('项目路径无效');
		const expanded = path.startsWith('~') ? join(app.getPath('home'), path.slice(1)) : path;
		const resolved = isAbsolute(expanded) ? expanded : join(cwd, expanded);
		const failure = await shell.openPath(resolved);
		if (failure) throw new Error(failure);
	});
	handleRendererInvoke(IPC_CHANNELS.workspacePickPath, async (event, mode: unknown, cwd: unknown) => {
		requireRendererSender(event);
		if (mode !== 'file' && mode !== 'folder') throw new Error('选择模式无效');
		const result = await dialog.showOpenDialog({ properties: mode === 'file' ? ['openFile', 'treatPackageAsDirectory'] : ['openDirectory'], defaultPath: typeof cwd === 'string' && cwd ? cwd : undefined });
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenWith, async (_event, cwd: unknown, openerId: unknown) => {
		if (typeof cwd !== 'string' || typeof openerId !== 'string') throw new Error('打开方式无效');
		await service.openWorkspaceWith(cwd, openerId);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenInVsCode, async (_event, cwd: string) => {
		await service.openWorkspaceInVsCode(cwd);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpenPathInEditor, async (_event, relativePath: unknown, line: unknown, column: unknown, editorId: unknown) => {
		if (typeof relativePath !== 'string') throw new Error('文件路径无效');
		await service.openPathInEditor(relativePath, typeof line === 'number' ? line : undefined, typeof column === 'number' ? column : undefined, typeof editorId === 'string' && editorId ? editorId : undefined);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceRevealPath, async (_event, relativePath: unknown) => {
		if (typeof relativePath !== 'string') throw new Error('文件路径无效');
		await service.revealPathInFolder(relativePath, (path) => shell.showItemInFolder(path));
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceOpeners, () => service.listWorkspaceOpeners());
	handleRendererInvoke(IPC_CHANNELS.workspaceProjectNickname, async (_event, cwd: unknown) => {
		if (typeof cwd !== 'string') throw new Error('工作区路径无效');
		return service.getProjectNickname(cwd);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceSetProjectNickname, async (_event, cwd: unknown, nickname: unknown) => {
		if (typeof cwd !== 'string' || typeof nickname !== 'string') throw new Error('备注名参数无效');
		await service.setProjectNickname(cwd, nickname);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceCommitContext, () => service.gitCommitContext());
	handleRendererInvoke(IPC_CHANNELS.workspaceCommit, (_event, message: string) => service.gitCommit(message));
	handleRendererInvoke(IPC_CHANNELS.workspaceListEntries, (_event, relativePath?: string) => service.listEntries(relativePath));
	handleRendererInvoke(IPC_CHANNELS.workspaceReadFile, (_event, relativePath: string) => service.readFile(relativePath));
	handleRendererInvoke(IPC_CHANNELS.workspaceCreateEntry, (_event, parentPath: unknown, name: unknown, kind: unknown) => {
		if (typeof parentPath !== 'string' || typeof name !== 'string' || (kind !== 'file' && kind !== 'directory')) throw new Error('新建参数无效');
		return service.createEntry(parentPath, name, kind);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceRenameEntry, (_event, path: unknown, newName: unknown) => {
		if (typeof path !== 'string' || typeof newName !== 'string') throw new Error('重命名参数无效');
		return service.renameEntry(path, newName);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceDeleteEntry, (_event, path: unknown) => {
		if (typeof path !== 'string') throw new Error('删除参数无效');
		// Trash semantics keep every delete recoverable from the OS recycle bin.
		return service.deleteEntry(path, (target) => shell.trashItem(target));
	});
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
	handleRendererInvoke(IPC_CHANNELS.workspaceGitSync, (_event, action: unknown) => {
		if (action !== 'fetch' && action !== 'pull' && action !== 'push') throw new Error('Git 同步操作无效');
		return service.gitSync(action);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceGitGraph, (_event, limit: unknown) => {
		const count = typeof limit === 'number' ? limit : 60;
		return service.gitGraph(count);
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
