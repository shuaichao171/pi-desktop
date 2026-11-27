import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// React Refresh injects an inline bootstrap script only while Vite serves the UI.
// Keep the packaged HTML's stricter CSP unchanged.
const developmentCsp = {
	name: 'development-content-security-policy',
	apply: 'serve' as const,
	transformIndexHtml(html: string): string {
		return html.replace(
			/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]+("\s*\/?>)/,
			(_match, before: string, after: string) => `${before}default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' data:; connect-src 'self' ws: wss:${after}`,
		);
	},
};

/**
 * Build layout (ESM everywhere — the pi SDK is ESM-only and needs a recent
 * bundled Node, which Electron 44 provides):
 *
 *   main    → out/main/index.js     (lightweight Electron window + IPC host)
 *   agent   → out/main/agentHost.js (Pi SDK in an Electron utility process)
 *   preload → out/preload/index.mjs (bundles @pidesktop/shared source)
 *   renderer→ out/renderer          (React app via Vite, bundles everything)
 */
export default defineConfig({
	main: {
		define: {
			'process.env.PI_DESKTOP_RELEASE_ANDROID': JSON.stringify(process.env.PI_DESKTOP_RELEASE_ANDROID ?? ''),
		},
		plugins: [
			externalizeDepsPlugin({ exclude: ['@pidesktop/agent', '@pidesktop/shared'] }),
		],
		build: {
			rollupOptions: {
				input: {
					index: resolve('src/main/index.ts'),
					agentHost: resolve('src/main/agentHost.ts'),
				},
				// undici must stay a runtime require of the real package: bundling it into
				// this ESM output breaks its internal `require('node:http2')` shim (issue #1),
				// silently disabling HTTP/2 for every provider whose TLS negotiates h2.
				external: ['undici'],
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ['@pidesktop/shared'] })],
	},
	renderer: {
		plugins: [developmentCsp, react(), tailwindcss()],
		resolve: {
			alias: {
				'@': resolve('src/renderer/src'),
			},
		},
	},
});
