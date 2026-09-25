import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'packages', 'desktop');
const OUTPUT = join(ROOT, 'release-debug');
// Stage the build OUTSIDE the repository: editor/agent file watchers holding handles
// inside the workspace make electron-builder's rm/rename fail with EPERM/EBUSY.
// Same volume as release-debug, so placing finished artifacts is an instant rename.
const STAGING = join(dirname(ROOT), '.pi-desktop-debug-staging');
const SPLASH = join(DESKTOP, 'build', 'portable-splash.bmp');
const DEBUG_PORT = 9223;
const HELP = `Pi Desktop 本地调试构建（便携版，无需发布）

  debug.cmd                  构建并输出到 release-debug/
  debug.cmd --splash         强制重新生成便携版启动位图（默认仅在缺失时生成）
  debug.cmd --no-build       复用上一次的 out/ 编译产物，只重新打包
  debug.cmd --no-launcher    不生成 run-debug.cmd 启动器

其他系统：node scripts/dist-debug.mjs [选项]

产物是独立的 "Pi Desktop Debug" 便携版：
- 与正式安装互不影响（独立 userData：%APPDATA%\\Pi Desktop Debug，单实例锁也独立）
- 便携模式自动停用更新检查，不会误升级到线上版本
- release-debug/win-unpacked/Pi Desktop Debug.exe 可免解压直接运行（注意它带有真实更新源）
- run-debug.cmd 以远程调试端口 ${DEBUG_PORT} 启动，便于 CDP 检查 UI

打包在仓库外的 ${STAGING} 完成，避免编辑器/代理的文件监视锁住中间产物。`;

// Default binary downloads (electron zip, winCodeSign, nsis) to the npmmirror CDN
// so packaging works without GitHub access; explicit env always wins.
if (!process.env.ELECTRON_MIRROR) process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

function run(program, args, { cwd = ROOT } = {}) {
	let executable = program;
	let argv = args;
	// Only pnpm needs cmd.exe on Windows. Its arguments below are fixed, never user input.
	if (process.platform === 'win32' && program === 'pnpm') {
		if (args.some((arg) => !/^[a-zA-Z0-9:@/_.=-]+$/.test(arg))) throw new Error('不安全的 pnpm 参数。');
		executable = process.env.ComSpec || 'cmd.exe';
		argv = ['/d', '/s', '/c', `pnpm ${args.join(' ')}`];
	}
	const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', stdio: 'inherit', windowsHide: true });
	if (result.error) throw new Error(`无法运行 ${program}：${result.error.message}`);
	if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} 失败（${result.status ?? result.signal}）。`);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Best-effort removal; returns true when the path is gone. Watchers can hold stale files. */
async function removeWithRetry(target, { attempts = 3, label = target } = {}) {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		if (!existsSync(target)) return true;
		try {
			rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 });
			if (!existsSync(target)) return true;
		} catch { /* retry below */ }
		await sleep(1000 * attempt);
	}
	return !existsSync(target);
}

function warnLocked(label, target) {
	console.warn(`警告：无法移除 ${target}（可能被编辑器或代理占用）。可稍后重启相关软件后手动删除。`);
}

const { values } = parseArgs({ options: {
	splash: { type: 'boolean' },
	'no-build': { type: 'boolean' },
	'no-launcher': { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
	console.log(HELP);
	process.exit(0);
}

// 1. Portable splash bitmap: regenerate only when missing (or forced).
if (values.splash || !existsSync(SPLASH)) {
	console.log('[1/4] 生成便携版启动位图...');
	run(process.execPath, ['scripts/make-portable-splash.mjs']);
} else {
	console.log('[1/4] 复用现有启动位图（--splash 可强制重新生成）');
}

// 2. Compile the app (electron-vite build + update config).
if (!values['no-build']) {
	console.log('[2/4] 编译应用...');
	run('pnpm', ['--filter', '@pidesktop/desktop', 'build']);
} else {
	console.log('[2/4] 跳过编译，复用 out/ 产物');
}

// 3. Package the portable target with a separate debug identity, outside the repo.
console.log('[3/4] 打包便携版（仓库外暂存）...');
const { version } = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
const require = createRequire(join(DESKTOP, 'package.json'));
const { Arch, Platform, build } = require('electron-builder');
if (!(await removeWithRetry(STAGING))) throw new Error(`暂存目录无法清空：${STAGING}`);
mkdirSync(OUTPUT, { recursive: true });
await build({
	projectDir: DESKTOP,
	targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64),
	publish: 'never',
	config: {
		directories: { output: STAGING },
		extraMetadata: { name: 'pi-desktop-debug', productName: 'Pi Desktop Debug' },
		portable: {
			artifactName: 'Pi-Desktop-Debug-Portable-${version}-${arch}.${ext}',
			splashImage: 'build/portable-splash.bmp',
		},
	},
	effectiveOptionComputed(options) {
		// The built-in portable template does not load nsis.include. Configure
		// makensis before it generates/signs the launcher instead. Its bitmap
		// must stay at native pixels, rather than being blurred by Windows DPI
		// virtualization. This hook is provided by the pinned electron-builder.
		if (Array.isArray(options) && options[0]?.SPLASH_IMAGE && options[1]) {
			options[1].ManifestDPIAware = 'true';
		}
		return false;
	},
});

const exeName = `Pi-Desktop-Debug-Portable-${version}-x64.exe`;
const stagedExe = join(STAGING, exeName);
if (!existsSync(stagedExe)) throw new Error(`未找到构建产物：${stagedExe}`);

// 4. Place finished artifacts into release-debug (instant same-volume renames).
console.log('[4/4] 放置产物到 release-debug/ ...');
let finalExeName = exeName;
for (const stale of readdirSync(OUTPUT)) {
	if (/^Pi-Desktop-Debug-Portable-.*\.exe$/.test(stale) || /^builder-(debug|effective-config)\./.test(stale) || /^win-unpacked(\.tmp)?$/.test(stale)) {
		if (!(await removeWithRetry(join(OUTPUT, stale)))) {
			if (stale === exeName) {
				finalExeName = `Pi-Desktop-Debug-Portable-${version}-${Date.now()}.exe`;
				console.warn(`旧的 ${exeName} 被占用，本次产物改名为 ${finalExeName}。`);
			} else {
				warnLocked(stale, join(OUTPUT, stale));
			}
		}
	}
}
renameSync(stagedExe, join(OUTPUT, finalExeName));
if (existsSync(join(STAGING, 'win-unpacked'))) {
	if (!existsSync(join(OUTPUT, 'win-unpacked'))) {
		renameSync(join(STAGING, 'win-unpacked'), join(OUTPUT, 'win-unpacked'));
	} else {
		console.warn('release-debug/win-unpacked 未能替换（旧目录被占用），保留暂存副本。');
	}
}

if (!values['no-launcher']) {
	// English-only comments: cmd.exe may run under a legacy codepage.
	const lines = [
		'@echo off',
		`rem Pi Desktop Debug launcher. Starts the portable build with a remote debugging port (${DEBUG_PORT}) for CDP.`,
		`start "" "%~dp0${finalExeName}" --remote-debugging-port=${DEBUG_PORT}`,
		'',
	];
	writeFileSync(join(OUTPUT, 'run-debug.cmd'), lines.join('\r\n'), 'utf8');
}

if (!(await removeWithRetry(STAGING, { attempts: 2 }))) warnLocked('staging', STAGING);

const fastStart = existsSync(join(OUTPUT, 'win-unpacked', 'Pi Desktop.exe'))
	? `\n  快速启动    ${join(OUTPUT, 'win-unpacked', 'Pi Desktop Debug.exe')}（免解压；带真实更新源）` : '';
console.log(`
构建完成：
  便携版      ${join(OUTPUT, finalExeName)}${fastStart}
  ${values['no-launcher'] ? '' : `调试启动    ${join(OUTPUT, 'run-debug.cmd')}（CDP 端口 ${DEBUG_PORT}）\n`}独立身份  userData = %APPDATA%\\Pi Desktop Debug，与正式安装互不影响；便携模式更新检查已停用。`.trim());
