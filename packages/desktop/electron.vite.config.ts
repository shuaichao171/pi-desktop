import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Build layout (ESM everywhere — the pi SDK is ESM-only and needs a recent
 * bundled Node, which Electron 44 provides):
 *
 *   main    → out/main/index.js     (lightweight Electron window + IPC host)
 *   agent   → out/main/agentHost.js (Pi SDK in an Electron utility process)
 *   preload → out/preload/index.js  (bundles @pidesktop/shared source)
 *   renderer→ out/renderer          (React app via Vite, bundles everything)
 */
export default defineConfig({
	main: {
		plugins: [
			externalizeDepsPlugin({ exclude: ['@pidesktop/agent', '@pidesktop/shared'] }),
		],
		build: {
			rollupOptions: {
				input: {
					index: resolve('src/main/index.ts'),
					agentHost: resolve('src/main/agentHost.ts'),
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ['@pidesktop/shared'] })],
	},
	renderer: {
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				'@': resolve('src/renderer/src'),
			},
		},
	},
});
