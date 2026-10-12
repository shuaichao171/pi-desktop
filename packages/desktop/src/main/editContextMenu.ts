import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import { getAppLocale } from './appLocale';

/**
 * Chromium ships no context menu of its own inside Electron, and the app only
 * renders custom React menus for its sidebar/terminal/workbench targets —
 * those call preventDefault(), which suppresses this handler entirely. Plain
 * text fields (the composer, dialogs, settings and search inputs) still need
 * the desktop-standard right-click menu, so every renderer window pops this
 * native one with the built-in editing roles (the roles drive webContents
 * edit commands, so they are unaffected by the narrow clipboard permissions
 * granted to the renderer).
 */
export function showEditContextMenu(win: BrowserWindow, params: ContextMenuParams): void {
	if (win.isDestroyed()) return;
	const zh = getAppLocale() === 'zh-CN';
	const flags = params.editFlags;
	const template: MenuItemConstructorOptions[] = params.isEditable
		? [
				{ role: 'undo', label: zh ? '撤销' : 'Undo', enabled: flags.canUndo },
				{ role: 'redo', label: zh ? '重做' : 'Redo', enabled: flags.canRedo },
				{ type: 'separator' },
				{ role: 'cut', label: zh ? '剪切' : 'Cut', enabled: flags.canCut },
				{ role: 'copy', label: zh ? '复制' : 'Copy', enabled: flags.canCopy },
				{ role: 'paste', label: zh ? '粘贴' : 'Paste', enabled: flags.canPaste },
				{ role: 'delete', label: zh ? '删除' : 'Delete', enabled: flags.canDelete },
				{ type: 'separator' },
				{ role: 'selectAll', label: zh ? '全选' : 'Select All', enabled: flags.canSelectAll },
			]
		: flags.canCopy
			? [{ role: 'copy', label: zh ? '复制' : 'Copy' }]
			: [];
	if (!template.length) return;
	Menu.buildFromTemplate(template).popup({ window: win });
}
