import { spawnSync } from 'node:child_process';
import { prepareUpdateConfig } from './prepare-update-config.mjs';

if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Run dist:mac on an Intel or Apple Silicon Mac to package its native architecture');
}

function run(args) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['build']);
const { url } = prepareUpdateConfig();
run(['exec', 'electron-builder', '--mac', 'dmg', 'zip', `--${process.arch}`, '--publish', 'never', '--config.publish.provider=generic', `--config.publish.url=${url}`]);
