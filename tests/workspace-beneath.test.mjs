import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Workspace beneath-guard tests (safe-fs beneath semantics). Pure decision
 * cases run against resolveBeneathRoot with an injected realpath so symlink /
 * junction / short-name escapes are deterministic on every platform; the last
 * case exercises the real WorkbenchService against the real filesystem.
 */

function escapeError() {
	return (error) => {
		assert.ok(error instanceof Error, 'guard failures are Errors');
		assert.equal(error.code, 'WORKSPACE_PATH_ESCAPE', `expected escape code on: ${error.message}`);
		return true;
	};
}

test('isBeneath accepts the root itself and descendants, rejects siblings, parents and other drives', async () => {
	const { isBeneath } = await import('../packages/desktop/src/main/workspaceBeneath.ts');
	const posix = (await import('node:path')).posix;
	// Pure string cases run on posix semantics regardless of host platform.
	const root = '/workspace';
	assert.equal(isBeneath(root, root), true);
	assert.equal(isBeneath(root, '/workspace/src/file.ts'), true);
	assert.equal(isBeneath(root, '/workspace/../secret'), false);
	assert.equal(isBeneath(root, '/workspaces/file.ts'), false, 'sibling with shared prefix must not pass');
	assert.equal(isBeneath(root, '/other/file.ts'), false);
	assert.equal(isBeneath(root, posix.resolve(root, 'a/../..')), false);
});

test('isBeneath compares Windows paths case-insensitively across drive-letter casing', async () => {
	const { win32, posix } = await import('node:path');
	// The guard picks its comparator from process.platform, so drive-letter
	// behaviour is verified through win32.relative directly (what the guard
	// uses on Windows); on win32 the drive letter case is normalized away.
	assert.equal(win32.relative('C:\\work', 'c:\\work\\sub'), 'sub');
	assert.notEqual(posix.relative('/work', '/Work/sub'), 'sub', 'posix comparison stays case-sensitive');
});

test('resolveBeneathRoot resolves plain descendants and reports forward-slash relative paths', async () => {
	const { resolveBeneathRoot } = await import('../packages/desktop/src/main/workspaceBeneath.ts');
	const { posix, win32 } = await import('node:path');
	const platformPath = process.platform === 'win32' ? win32 : posix;
	const resolved = await resolveBeneathRoot('/w', ['src', 'nested', 'file.ts'].join(platformPath.sep), async (path) => path);
	assert.equal(resolved.root, '/w');
	assert.equal(resolved.path, platformPath.resolve('/w', ['src', 'nested', 'file.ts'].join(platformPath.sep)));
	assert.equal(resolved.relativePath, 'src/nested/file.ts');
	// Dot segments are resolved away before any comparison.
	const dotted = await resolveBeneathRoot('/w', ['src', '..', 'file.ts'].join(platformPath.sep), async (path) => path);
	assert.equal(dotted.relativePath, 'file.ts');
	// The empty relative path addresses the workspace root itself (file-tree listing).
	const rootItself = await resolveBeneathRoot('/w', '', async (path) => path);
	assert.equal(rootItself.relativePath, '');
});

test('resolveBeneathRoot rejects relative traversal with an escape error and never falls back to the root', async () => {
	const { resolveBeneathRoot } = await import('../packages/desktop/src/main/workspaceBeneath.ts');
	for (const input of ['..', join('..', 'outside.txt'), join('a', '..', '..', 'b')]) {
		await assert.rejects(resolveBeneathRoot('/w', input, async (path) => path), escapeError());
	}
});

test('resolveBeneathRoot rejects symlink, junction and short-name escapes after realpath', async () => {
	const { resolveBeneathRoot } = await import('../packages/desktop/src/main/workspaceBeneath.ts');
	const { resolve } = await import('node:path');
	// A link inside the workspace whose realpath lands outside must be refused.
	const linkEscape = async (path) => path === resolve('/w/link') ? resolve('/elsewhere/target') : path;
	await assert.rejects(resolveBeneathRoot('/w', 'link', linkEscape), escapeError());
	// A short-name alias (PROGRA~1 style) that resolves outside is refused too.
	const shortEscape = async (path) => path === resolve('/w/PROGRA~1') ? resolve('/Program Files') : path;
	await assert.rejects(resolveBeneathRoot('/w', 'PROGRA~1', shortEscape), escapeError());
	// An interior symlink that still lands inside the root stays allowed.
	const innerLink = async (path) => path === resolve('/w/alias') ? resolve('/w/real/file.txt') : path;
	const allowed = await resolveBeneathRoot('/w', 'alias', innerLink);
	assert.equal(allowed.path, resolve('/w/real/file.txt'));
});

test('resolveBeneathRoot canonicalizes the workspace root through its own realpath', async () => {
	const { resolveBeneathRoot } = await import('../packages/desktop/src/main/workspaceBeneath.ts');
	const { resolve } = await import('node:path');
	// The root arrives as an alias (short name / symlink); the guard must
	// compare against the real location, not the alias spelling.
	const realRoot = resolve('/real/root');
	const resolved = await resolveBeneathRoot('/SHORT~1/root', 'file.txt', async (path) =>
		path === '/SHORT~1/root' ? realRoot : resolve(realRoot, 'file.txt'));
	assert.equal(resolved.root, realRoot);
	assert.equal(resolved.relativePath, 'file.txt');
});

test('resolveBeneathRoot keeps invalid input distinguishable from escapes and preserves missing-target errors', async () => {
	const { resolveBeneathRoot, WorkspacePathError } = await import('../packages/desktop/src/main/workspaceBeneath.ts');
	for (const input of [undefined, null, 42, '/absolute/path', 'a\0b']) {
		await assert.rejects(resolveBeneathRoot('/w', input, async (path) => path), (error) => {
			assert.ok(error instanceof WorkspacePathError);
			assert.equal(error.code, 'WORKSPACE_PATH_INVALID');
			assert.equal(error.message, '文件路径无效');
			return true;
		});
	}
	// A target that does not exist surfaces the filesystem error itself.
	const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
	await assert.rejects(
		resolveBeneathRoot('/w', 'gone.txt', async (path) => { throw missing; }),
		(error) => error.code === 'ENOENT',
	);
});

test('WorkbenchService file-tree mutations refuse entries that realpath outside the workspace', async (t) => {
	const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-beneath-'));
	const workspace = join(tempRoot, 'workspace');
	const outside = join(tempRoot, 'outside');
	mkdirSync(workspace);
	mkdirSync(outside);
	writeFileSync(join(outside, 'target.txt'), 'outside');
	const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
	const service = new WorkbenchService(() => workspace, () => {});
	try {
		// A directory junction/symlink placed inside the workspace points outside.
		try {
			symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
			t.skip('Creating symbolic links is unavailable on this host'); return;
		}
		// Reading through the link must be refused, never resolved to the target.
		await assert.rejects(service.readFile('escape/target.txt'), escapeError());
		// Deleting the link (which would trash the linked directory) is refused.
		await assert.rejects(service.deleteEntry('escape', async () => {}), escapeError());
		// Creating inside the escaped directory is refused as well.
		await assert.rejects(service.createEntry('escape', 'new.txt', 'file'), escapeError());
		// Renaming the workspace root itself stays refused.
		await assert.rejects(service.renameEntry('', 'renamed'), /不能重命名工作区根目录/);
		// A genuine workspace file still round-trips through the same guards.
		writeFileSync(join(workspace, 'inside.txt'), 'inside');
		assert.equal(await service.readFile('inside.txt'), 'inside');
	} finally {
		await service.dispose();
		rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
