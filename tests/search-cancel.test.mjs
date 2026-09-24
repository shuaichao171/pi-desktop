import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

globalThis.__searchFileSystem = fs;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:fs/promises' && context.parentURL?.endsWith('/searchService.ts')) {
      const code = `
        const fs = globalThis.__searchFileSystem;
        export const { lstat, open, opendir, stat } = fs;
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
  assert.deepEqual(await old, { files: [], truncated: true });
  releaseLatest();
  const result = await latest;
  assert.equal(result.truncated, false);
  assert.equal(result.files[0].name, 'latest.txt');
});
