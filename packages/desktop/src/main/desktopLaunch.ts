import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';

export type DesktopLaunch = { windowMode: 'full' } | { windowMode: 'multi' } | { windowMode: 'pai'; cwd: string };

/** Electron switches and its development entry point may surround our arguments. */
export function parseDesktopLaunch(argv: readonly string[], platform: NodeJS.Platform = process.platform): DesktopLaunch {
	let pai = false;
	let multi = false;
	let cwd: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === '--pai') {
			if (pai) throw new Error('Duplicate --pai argument');
			if (multi) throw new Error('--pai cannot be combined with --multi');
			pai = true;
		} else if (argument.startsWith('--pai=')) throw new Error('Use --pai without a value');
		else if (argument === '--multi') {
			if (multi) throw new Error('Duplicate --multi argument');
			if (pai) throw new Error('--multi cannot be combined with --pai');
			multi = true;
		} else if (argument.startsWith('--multi=')) throw new Error('Use --multi without a value');
		else if (argument === '--cwd' || argument.startsWith('--cwd=')) {
			if (cwd !== undefined) throw new Error('Duplicate --cwd argument');
			cwd = argument === '--cwd' ? argv[++index] : argument.slice('--cwd='.length);
			if (!cwd || cwd.startsWith('--') || cwd.includes('\0')) throw new Error('--cwd requires an absolute folder path');
		}
	}
	if (multi) {
		if (cwd !== undefined) throw new Error('--cwd requires --pai');
		return { windowMode: 'multi' };
	}
	if (!pai) {
		if (cwd !== undefined) throw new Error('--cwd requires --pai');
		return { windowMode: 'full' };
	}
	const paths = platform === 'win32' ? win32 : posix;
	// A Windows rooted path such as \project still depends on the current drive.
	if (!cwd || !paths.isAbsolute(cwd) || platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(cwd)) {
		throw new Error('--pai requires --cwd with an absolute folder path');
	}
	return { windowMode: 'pai', cwd: paths.normalize(cwd) };
}

export function validatePaiWorkspace(cwd: string): string {
	if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('--cwd must name an existing folder');
	return realpathSync(cwd);
}

interface Owner { pid: number; token: string }
interface ProfileOptions {
	pid?: number;
	isProcessRunning?(pid: number): boolean;
	/** Profile root name under the base userData directory; pai and multi instances stay separated. */
	rootName?: string;
}
export interface PaiProfile {
	userData: string;
	sessionData: string;
	/** Release only after Electron and the agent have shut down. Never removes profile data. */
	release(): void;
}

function processRunning(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function readOwner(path: string): Owner | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (value && typeof value === 'object' && 'pid' in value && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
			&& 'token' in value && typeof value.token === 'string' && value.token.length > 0) return value as Owner;
	} catch { /* Unknown owners are never considered dead. */ }
	return null;
}

function sameOwner(path: string, owner: Owner): boolean {
	const current = readOwner(path);
	return current?.pid === owner.pid && current.token === owner.token;
}

function removeOwnedClaim(path: string, owner: Owner): void {
	if (!sameOwner(join(path, 'owner.json'), owner)) return;
	try { unlinkSync(join(path, 'owner.json')); } catch { return; }
	try { rmdirSync(path); } catch { /* Never recursively remove another claimant's directory. */ }
}

/**
 * Publish a fully written claim atomically. A crashed holder is superseded by
 * a child claim, so two reclaimers can never delete a newly acquired lock.
 */
function claimProfile(slot: string, owner: Owner, running: (pid: number) => boolean): (() => void) | null {
	const candidate = join(slot, `.claim-${owner.token}`);
	mkdirSync(candidate);
	try {
		writeFileSync(join(candidate, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
		let claim = join(slot, '.claim');
		for (let depth = 0; depth < 64; depth++) {
			try {
				renameSync(candidate, claim);
				return () => removeOwnedClaim(claim, owner);
			} catch (error) {
				if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
				const prior = readOwner(join(claim, 'owner.json'));
				if (!prior || running(prior.pid)) return null;
				claim = join(claim, 'takeover');
			}
		}
		return null;
	} finally { removeOwnedClaim(candidate, owner); }
}

/**
 * Keep a separate persistent Chromium/app-state slot per live extra instance
 * (pai window or --multi full window). Slots retain settings between launches.
 * SDK credentials, sessions, and input journals remain in Pi's global agent
 * directory, which this module never edits.
 */
export function reservePaiProfile(baseUserData: string, options: ProfileOptions = {}): PaiProfile {
	const root = join(resolve(baseUserData), options.rootName ?? 'pai-profiles');
	const owner: Owner = { pid: options.pid ?? process.pid, token: randomUUID() };
	const running = options.isProcessRunning ?? processRunning;
	mkdirSync(root, { recursive: true });
	for (let index = 1; index <= 1024; index++) {
		const slot = join(root, `slot-${index}`);
		mkdirSync(slot, { recursive: true });
		const releaseClaim = claimProfile(slot, owner, running);
		if (!releaseClaim) continue;
		const lease = join(slot, 'lease.json');
		try {
			try {
				statSync(lease);
				const previous = readOwner(lease);
				if (!previous || running(previous.pid)) continue;
				unlinkSync(lease);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			writeFileSync(lease, JSON.stringify(owner), { flag: 'wx' });
			const userData = join(slot, 'profile');
			const sessionData = join(userData, 'chromium');
			try { mkdirSync(sessionData, { recursive: true }); }
			catch (error) { if (sameOwner(lease, owner)) unlinkSync(lease); throw error; }
			return {
				userData, sessionData,
				release: () => { if (sameOwner(lease, owner)) { try { unlinkSync(lease); } catch { /* A failed release conservatively keeps the slot reserved. */ } } },
			};
		} finally { releaseClaim(); }
	}
	throw new Error('No free pai profile is available');
}

export function rendererLaunchUrl(url: string, launch: DesktopLaunch): string {
	if (launch.windowMode !== 'pai') return url;
	const target = new URL(url);
	target.searchParams.set('mode', 'pai');
	return target.toString();
}
