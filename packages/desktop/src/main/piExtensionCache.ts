/**
 * Share Pi's extension module cache across working directories.
 *
 * The SDK caches loaded extension factories in one process-wide map, but only
 * for a single cwd: `useExtensionCacheCwd` clears the whole map whenever a
 * runtime is created for a different directory. The Pi CLI has one cwd per
 * process, so that never costs anything there. The desktop agent host serves
 * every project at once and gives each project-less conversation a fresh
 * folder, so every new conversation (and every cold open in another project)
 * re-imported all extensions with their dependency graphs — about 3–5 s, most
 * of it synchronous, blocking every other conversation in the host meanwhile.
 *
 * Factories are keyed by the extension's resolved absolute path, so sharing
 * them across directories is the same reuse the SDK already does across
 * sessions of one directory: project-local extensions live at per-project paths
 * and keep separate entries, and an explicit resource reload (plugin changes,
 * /reload) still clears the cache through `clearExtensionCache()`.
 *
 * The SDK is an external module (possibly a user-selected engine), so this
 * rewrites its loader source at load time instead of patching node_modules.
 * Only the two exact functions below are touched; any other SDK version keeps
 * its own behavior unchanged. Dependency-free (node: built-ins only) so the
 * agent host bootstrap can install it before anything imports the SDK.
 */
import { registerHooks } from 'node:module';

const LOADER_URL = /\/@earendil-works\/pi-coding-agent\/dist\/core\/extensions\/loader\.js$/;

const CWD_CLEAR = /(function useExtensionCacheCwd\(cwd\) \{\r?\n\s*const resolvedCwd = resolvePath\(cwd\);\r?\n)\s*if \(extensionCacheCwd !== undefined && !pathsEqual\(extensionCacheCwd, resolvedCwd\)\) \{\r?\n\s*clearExtensionCache\(\);\r?\n\s*\}\r?\n/;
const CWD_TOKEN = /(function isCurrentCacheToken\(cacheToken\) \{\r?\n\s*return \(cacheToken !== undefined &&\r?\n)\s*extensionCacheCwd === cacheToken\.cwd &&\r?\n/;

/** Returns the patched loader source, or null when this SDK build does not match exactly. */
export function shareExtensionCacheAcrossCwds(source: string): string | null {
	if (!CWD_CLEAR.test(source) || !CWD_TOKEN.test(source)) return null;
	return source.replace(CWD_CLEAR, '$1').replace(CWD_TOKEN, '$1');
}

let installed = false;
let applied = false;

/** Whether a loaded SDK actually received the shared cache (diagnostics and tests). */
export function extensionCacheShared(): boolean { return applied; }

export function installSharedExtensionCache(): void {
	if (installed) return;
	installed = true;
	registerHooks({
		load(url, context, nextLoad) {
			const result = nextLoad(url, context);
			if (!LOADER_URL.test(url.split('?')[0]!) || result.source === undefined || result.source === null) return result;
			const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source as Uint8Array).toString('utf8');
			const patched = shareExtensionCacheAcrossCwds(text);
			if (patched === null) return result;
			applied = true;
			return { ...result, source: patched };
		},
	});
}
