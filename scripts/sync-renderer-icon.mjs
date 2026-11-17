import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Keep the renderer's title-bar brand image byte-identical to the packaged app
 * icon. The renderer serves it from its Vite public dir at ./icon.png.
 */
export function syncRendererIcon({ root = ROOT } = {}) {
	const source = join(root, 'packages', 'desktop', 'build', 'icon.png');
	const output = join(root, 'packages', 'desktop', 'src', 'renderer', 'public', 'icon.png');
	mkdirSync(dirname(output), { recursive: true });
	copyFileSync(source, output);
	return { source, output };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const { output } = syncRendererIcon();
	console.log(`renderer icon synced -> ${output}`);
}
