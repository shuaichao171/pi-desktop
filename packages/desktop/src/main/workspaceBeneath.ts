/**
 * Workspace path guard (safe-fs beneath semantics, cf. O_RESOLVE_BENEATH).
 *
 * Every workspace file-tree operation resolves its target through this module:
 * the target's fully resolved path (native realpath: symlinks, junctions and
 * Windows 8.3 short names included) must lie inside the workspace root's own
 * realpath. Any escape — a `..` segment, a symlink/junction pointing outside,
 * a subdirectory mount or a same-different-drive trick — is rejected with a
 * `WORKSPACE_PATH_ESCAPE` error. There is never a fallback: an escaping path
 * is refused outright, never reinterpreted against the root.
 *
 * Comparisons follow the platform's filesystem semantics: on Windows both
 * sides are compared case-insensitively with drive letters normalized (via
 * `path.win32.relative`), and a different drive is outside by definition; on
 * macOS/Linux the comparison is byte-exact, which is safe because both sides
 * come from the same native realpath canonicalization.
 */
import { realpath as realpathCallback } from 'node:fs';
import { realpath as realpathJs } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';

/** Windows needs its case-insensitive comparison rules; other platforms compare exactly. */
const platformPath = process.platform === 'win32' ? win32 : posix;

/** True when `candidate` equals `root` or lies lexically below it (never via a sibling prefix). */
export function isBeneath(root: string, candidate: string): boolean {
	const rel = platformPath.relative(root, candidate);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${platformPath.sep}`) && !platformPath.isAbsolute(rel));
}

/** Native realpath resolves symlinks, junctions and 8.3 short names; the JS fallback keeps exotic filesystems working. */
const realpathNative = promisify(realpathCallback.native);

/** Canonicalizes a path via libuv's realpath, falling back to the pure-JS realpath when native resolution is unsupported. */
export async function canonicalRealpath(path: string): Promise<string> {
	try {
		return await realpathNative(path);
	} catch {
		// A genuinely missing path fails here again with the same ENOENT-style
		// error callers already expect; only native-specific failures (EINVAL
		// and the like on unusual filesystems) are rescued by the fallback.
		return realpathJs(path);
	}
}

/** Errors thrown by the guard: `code` separates malformed input from an escaping target. */
export class WorkspacePathError extends Error {
	readonly code: 'WORKSPACE_PATH_INVALID' | 'WORKSPACE_PATH_ESCAPE';

	constructor(message: string, code: 'WORKSPACE_PATH_INVALID' | 'WORKSPACE_PATH_ESCAPE') {
		super(message);
		this.name = 'WorkspacePathError';
		this.code = code;
	}
}

export type PathRealpath = (path: string) => Promise<string>;

export interface BeneathResolution {
	/** The workspace root after realpath canonicalization. */
	root: string;
	/** The target after realpath canonicalization; always inside `root`. */
	path: string;
	/** The resolved path relative to `root`, with forward slashes (workspace entry key). */
	relativePath: string;
}

/**
 * Resolves `relativePath` against `root` with beneath semantics. `realpath`
 * is injected so tests can simulate symlinks, junctions and short names; the
 * production callers pass {@link canonicalRealpath}.
 */
export async function resolveBeneathRoot(root: string, relativePath: string, realpath: PathRealpath = canonicalRealpath): Promise<BeneathResolution> {
	if (typeof relativePath !== 'string' || relativePath.includes('\0') || platformPath.isAbsolute(relativePath)) {
		throw new WorkspacePathError('文件路径无效', 'WORKSPACE_PATH_INVALID');
	}
	// The root itself is canonicalized first, so a workspace opened through a
	// symlink or a short path guards against the real location, not the alias.
	const realRoot = await realpath(root);
	const candidate = platformPath.resolve(realRoot, relativePath);
	if (!isBeneath(realRoot, candidate)) throw new WorkspacePathError('文件不属于当前工作区', 'WORKSPACE_PATH_ESCAPE');
	// Resolving the candidate exposes symlink/junction/short-name escapes;
	// missing targets propagate their original error (ENOENT and friends).
	const real = await realpath(candidate);
	if (!isBeneath(realRoot, real)) throw new WorkspacePathError('文件不属于当前工作区', 'WORKSPACE_PATH_ESCAPE');
	return { root: realRoot, path: real, relativePath: platformPath.relative(realRoot, real).split(platformPath.sep).join('/') };
}
