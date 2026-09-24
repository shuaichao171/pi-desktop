import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { prepareUpdateConfig } from './prepare-update-config.mjs';

const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const { Arch, Platform, build } = require('electron-builder');
const { publish } = prepareUpdateConfig();
const { values } = parseArgs({ options: { output: { type: 'string' }, dir: { type: 'boolean', default: false } } });
const config = {
  publish,
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
