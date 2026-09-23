import { app, BrowserWindow, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentService, defaultWorkspace, registerIpc } from './ipc';

const here = fileURLToPath(new URL('.', import.meta.url));

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 680,
		minHeight: 520,
		backgroundColor: '#111216',
		title: 'Pi Desktop',
		show: false,
		webPreferences: {
			preload: join(here, '../preload/index.mjs'),
			contextIsolation: true,
			// ESM preload requires sandbox: false (Electron ≥ 28).
			sandbox: false,
			nodeIntegration: false,
		},
	});

	win.on('ready-to-show', () => win.show());
	const openExternalLink = (url: string): void => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
				void shell.openExternal(parsed.toString());
			}
		} catch {
			// Ignore malformed links from generated content.
		}
	};
	win.webContents.setWindowOpenHandler(({ url }) => {
		openExternalLink(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (url === win.webContents.getURL()) return;
		event.preventDefault();
		openExternalLink(url);
	});

	// electron-vite dev serves the renderer from the HMR server.
	if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(here, '../renderer/index.html'));
	}
}

app.whenReady().then(() => {
	registerIpc();
	createWindow();

	// Bootstrap the agent against the default workspace so the first prompt
	// works without touching the folder picker.
	const workspace = defaultWorkspace();
	mkdirSync(workspace, { recursive: true });
	void agentService.init({ cwd: workspace }).catch((error: unknown) => {
		console.error('Pi agent failed to initialize:', error);
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

let readyToQuit = false;
let disposing = false;
app.on('before-quit', (event) => {
	if (readyToQuit) return;
	event.preventDefault();
	if (disposing) return;
	disposing = true;
	void agentService.dispose()
		.catch((error: unknown) => console.error('Pi agent shutdown failed:', error))
		.finally(() => {
			readyToQuit = true;
			app.quit();
		});
});
