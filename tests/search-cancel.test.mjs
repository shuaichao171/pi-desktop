import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

globalThis.__searchFileSystem = fs;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:fs/promises' && ['/searchService.ts', '/indexedSearch.ts'].some(path => context.parentURL?.endsWith(path))) {
      const code = `
        const fs = globalThis.__searchFileSystem;
        export const { open, stat, readFile } = fs;
        export async function lstat(path) {
          if (path === globalThis.__failSearchEntry) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return fs.lstat(path);
        }
        export async function opendir(path) {
          if (path === globalThis.__failSearchDirectory) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return fs.opendir(path);
        }
        export async function realpath(path) {
          if (globalThis.__delaySearchPath) {
            const gate = globalThis.__delaySearchPath;
            globalThis.__delaySearchPath = null;
            await gate;
          }
          return fs.realpath(path);
        }
      `;
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

test('a delayed old file search cannot cancel a later search after root resolution', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-search-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, 'latest.txt'), '');
  const { searchWorkspaceFiles } = await import('../packages/desktop/src/main/searchService.ts');
  let releaseOld;
  globalThis.__delaySearchPath = new Promise((resolve) => { releaseOld = resolve; });
  const old = searchWorkspaceFiles(root, 'old');
  let releaseLatest;
  globalThis.__delaySearchPath = new Promise((resolve) => { releaseLatest = resolve; });
  const latest = searchWorkspaceFiles(root, 'latest');
  releaseOld();
  const oldResult = await old;
  assert.deepEqual(oldResult.files, []);
  assert.equal(oldResult.truncated, true);
  releaseLatest();
  const result = await latest;
  assert.equal(result.truncated, false);
  assert.equal(result.files[0].name, 'latest.txt');
});

test('unreadable files and directories are skipped without reporting a budget limit', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-search-permissions-'));
  t.after(async () => {
    globalThis.__failSearchDirectory = undefined;
    globalThis.__failSearchEntry = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(join(root, 'blocked'));
  await fs.writeFile(join(root, 'readable.txt'), '');
  await fs.writeFile(join(root, 'blocked.txt'), '');
  const resolvedRoot = await fs.realpath(root);
  globalThis.__failSearchDirectory = join(resolvedRoot, 'blocked');
  globalThis.__failSearchEntry = join(resolvedRoot, 'blocked.txt');
  const { searchWorkspaceFiles } = await import('../packages/desktop/src/main/searchService.ts');
  const result = await searchWorkspaceFiles(root, 'txt');
  assert.equal(result.truncated, false);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.files.map((entry) => entry.name), ['readable.txt']);
});
