import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseUpdateFeedUrl } from '../packages/desktop/src/main/updateFeed.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Share one feed between the packaged client and electron-builder metadata. */
export function prepareUpdateConfig({ root = ROOT, env = process.env } = {}) {
  const desktop = join(root, 'packages', 'desktop');
  const configured = JSON.parse(readFileSync(join(desktop, 'build', 'update-config.json'), 'utf8'));
  const override = env.PI_DESKTOP_UPDATE_URL;
  const url = parseUpdateFeedUrl(override === undefined || override === '' ? configured.url : override);
  if (!url) throw new Error('The update feed must be a public HTTPS directory URL ending in /, without credentials, query or fragment.');
  const output = join(desktop, 'out', 'update-config.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ url }, null, 2) + '\n', 'utf8');
  return { url, output, publish: { provider: 'generic', url } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(prepareUpdateConfig().url);
}
