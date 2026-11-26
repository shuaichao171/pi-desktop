const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(monorepoRoot, 'packages', 'shared')];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@pidesktop/shared': path.join(monorepoRoot, 'packages', 'shared', 'src'),
};

module.exports = config;
