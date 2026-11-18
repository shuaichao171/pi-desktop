const { app, BrowserWindow } = require('electron');

app.setPath('userData', process.argv[2]);
let window;
app.whenReady().then(async () => {
	window = new BrowserWindow({ width: 640, height: 440, title: 'Pi CUA Chromium fixture' });
	const html = '<body style="background:#12685d;color:#fff;font:24px system-ui"><h1>Pi capture fixture</h1><div style="width:80%;height:80px;background:#ffd646"></div><button>Chromium button</button></body>';
	await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
	console.log(JSON.stringify({ kind: 'ready', hwnd: Number(window.getNativeWindowHandle().readBigUInt64LE(0)) }));
});
process.stdin.resume();
process.stdin.on('data', () => app.quit());
app.on('window-all-closed', () => app.quit());
