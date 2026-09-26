import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { prepareUpdateConfig } from './prepare-update-config.mjs';
import { WINDOWS_PTY_PREBUILD_CONFIG, verifyWindowsPtyPrebuilds } from './windows-pty-prebuild.mjs';

const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const { Arch, Platform, build } = require('electron-builder');
const { publish } = prepareUpdateConfig();
const { values } = parseArgs({ options: { output: { type: 'string' }, dir: { type: 'boolean', default: false } } });
// node-pty ships Windows N-API binaries and ConPTY helpers. Rebuilding them
// unnecessarily requires Visual Studio, even though they are ABI independent.
// Verify the target artifacts before opting out of native rebuilds for Windows;
// macOS/Linux keep their own native build policies.
verifyWindowsPtyPrebuilds(require);
const config = {
  publish,
  ...WINDOWS_PTY_PREBUILD_CONFIG,
  ...(values.output ? { directories: { output: values.output } } : {}),
};

await build({
  targets: Platform.WINDOWS.createTarget(values.dir ? ['dir'] : ['nsis', 'portable'], Arch.x64),
  publish: 'never',
  ...(Object.keys(config).length ? { config } : {}),
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
