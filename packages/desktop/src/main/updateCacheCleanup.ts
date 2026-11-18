import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * electron-updater keeps the downloaded installer in "<cache>/pending" after it has been
 * installed and only empties that folder when the next download starts, so every update
 * strands a full installer (~150 MB). The sibling "installer.exe" + "current.blockmap" are
 * the differential-download base written by the NSIS installer and are deliberately kept.
 */

const VERSION_IN_FILE_NAME = /(\d+)\.(\d+)\.(\d+)(?:-(?!(?:x64|arm64|ia32|universal)\b)([0-9A-Za-z.]+))?(?=-(?:x64|arm64|ia32|universal)\b|\.[A-Za-z0-9]+$)/;

interface ParsedVersion { core: [number, number, number]; prerelease: string | null }

function parseVersion(text: string): ParsedVersion | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(text.trim());
	return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null } : null;
}

/** Version embedded in an installer name such as "Pi-Desktop-Setup-0.5.6-x64.exe". */
export function versionFromInstallerName(fileName: string): string | null {
	const match = VERSION_IN_FILE_NAME.exec(fileName);
	return match ? `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}` : null;
}

/** Negative when a < b, zero when equal, positive when a > b; null when either is unparseable. */
export function compareVersions(a: string, b: string): number | null {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	for (let index = 0; index < 3; index += 1) {
		const diff = left.core[index] - right.core[index];
		if (diff !== 0) return diff;
	}
	if (left.prerelease === right.prerelease) return 0;
	// A release sorts after any prerelease of the same core version.
	if (left.prerelease === null) return 1;
	if (right.prerelease === null) return -1;
	return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true });
}

/** Mirrors electron-updater's getAppCacheDir() + updaterCacheDirName on Windows. */
export async function windowsUpdaterCacheDir(resourcesPath: string): Promise<string | null> {
	let config: string;
	try { config = await readFile(join(resourcesPath, 'app-update.yml'), 'utf8'); }
	catch { return null; }
	const match = /^updaterCacheDirName:\s*(['"]?)(.+?)\1\s*$/m.exec(config);
	const dirName = match?.[2];
	// The name must stay a single path segment beneath LOCALAPPDATA.
	if (!dirName || /[\\/]/.test(dirName) || dirName === '.' || dirName === '..') return null;
	return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), dirName);
}

/**
 * Removes "<cacheDir>/pending" when it only holds an installer for the running version or
 * an older one. A newer, downloaded-but-not-installed update is kept so a later install
 * click reuses it instead of downloading again. Returns whether anything was removed.
 */
export async function removeInstalledPendingUpdate(cacheDir: string, currentVersion: string): Promise<boolean> {
	const pendingDir = join(cacheDir, 'pending');
	let fileName: unknown;
	try { fileName = (JSON.parse(await readFile(join(pendingDir, 'update-info.json'), 'utf8')) as { fileName?: unknown }).fileName; }
	catch { return false; }
	if (typeof fileName !== 'string') return false;
	const pendingVersion = versionFromInstallerName(fileName);
	const order = pendingVersion ? compareVersions(pendingVersion, currentVersion) : null;
	if (order === null || order > 0) return false;
	await rm(pendingDir, { recursive: true, force: true, maxRetries: 2 });
	return true;
}
