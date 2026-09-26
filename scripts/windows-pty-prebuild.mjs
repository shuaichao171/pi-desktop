import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// node-pty ships N-API binaries (node-addon-api), so its Windows prebuilds stay
// ABI compatible with the bundled Electron and need no native rebuild. Rebuilding
// them would require Visual Studio purely by accident of electron-builder's
// default npmRebuild behaviour.
export const WINDOWS_PTY_PREBUILD_CONFIG = { npmRebuild: false };

// ConPTY helpers and the three native addons the PTY sessions load at runtime.
const NATIVE_MODULES = ['conpty.node', 'conpty_console_list.node', 'pty.node'];
const PTY_FILES = [...NATIVE_MODULES, 'conpty/conpty.dll', 'conpty/OpenConsole.exe'];

const desktop = () => createRequire(new URL('../packages/desktop/package.json', import.meta.url));

/**
 * Fails fast when the shipped prebuilds are missing or cannot be loaded by the
 * target Electron, which is the precondition for WINDOWS_PTY_PREBUILD_CONFIG.
 */
export function verifyWindowsPtyPrebuilds(require = desktop()) {
  const prebuilds = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', 'win32-x64');
  for (const file of PTY_FILES) accessSync(join(prebuilds, file));
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const check = spawnSync(require('electron'), ['-e', 'for (const file of process.argv.slice(1)) require(file)',
    ...NATIVE_MODULES.map((file) => join(prebuilds, file))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  });
  if (check.error || check.status !== 0) throw new Error(`Windows PTY prebuild validation failed: ${check.error?.message ?? check.stderr}`);
}
