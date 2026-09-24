import { createRequire } from 'node:module';
import { prepareUpdateConfig } from './prepare-update-config.mjs';

const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const { Arch, Platform, build } = require('electron-builder');
const { publish } = prepareUpdateConfig();
await build({
  targets: Platform.LINUX.createTarget(['AppImage', 'deb'], Arch.x64),
  publish: 'never',
  config: { publish },
});
