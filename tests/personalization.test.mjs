import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

// Real temporary files exercise reads/writes. Only native rename failure is
// injected to check that an atomic-write error never damages the original.
const io = `
  import * as fs from 'node:fs/promises';
  export const { chmod, lstat, mkdir, open, realpath, stat, unlink } = fs;
  export const rename = (...args) => globalThis.__instructionRenameFailure
    ? Promise.reject(new Error('Simulated rename failure')) : fs.rename(...args);
`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:fs/promises' && context.parentURL?.endsWith('/personalization.ts')) {
    return { url: `data:text/javascript,${encodeURIComponent(io)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { createPersonalizationService } = await import('../packages/agent/src/personalization.ts');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-personalization-'));
  const userDirectory = join(root, 'user');
  const agentDirectory = join(root, 'agent');
  await mkdir(agentDirectory);
  return { root, userDirectory, agentDirectory, userPath: join(userDirectory, 'AGENTS.md'),
    service: createPersonalizationService({ userDirectory, agentDirectory }),
    async cleanup() {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('only controlled user and Pi instruction files are exposed, with Pi override precedence and no CLAUDE fallback', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.agentDirectory, 'CLAUDE.md'), 'not a Pi AGENTS document');
    assert.deepEqual(await f.service.list(), [{ id: 'user', path: f.userPath, exists: false, content: '', revision: null }]);
    const refused = await f.service.save({ id: 'pi', content: 'must not be created', revision: null });
    assert.equal(refused.status, 'conflict');
    assert.equal(refused.document.exists, false);
    assert.deepEqual(await readdir(f.agentDirectory), ['CLAUDE.md']);
    await writeFile(join(f.agentDirectory, 'AGENTS.md'), 'ordinary');
    await writeFile(join(f.agentDirectory, 'AGENTS.override.md'), 'override');
    let documents = await f.service.list();
    assert.equal(documents[1].path, join(f.agentDirectory, 'AGENTS.override.md'));
    assert.equal(documents[1].content, 'override');
    await rm(join(f.agentDirectory, 'AGENTS.override.md'));
    await mkdir(join(f.agentDirectory, 'AGENTS.override.md'));
    documents = await f.service.list();
    assert.equal(documents[1].path, join(f.agentDirectory, 'AGENTS.md'), 'directories are skipped when a regular Pi candidate exists');
    const created = await f.service.save({ id: 'user', content: '个人说明\n', revision: null });
    assert.equal(created.status, 'saved');
    assert.equal(created.document.content, '个人说明\n');
    assert.equal(created.document.exists, true);
    assert.match(created.document.revision, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(f.userPath, 'utf8'), '个人说明\n');
    assert.deepEqual(await readdir(f.userDirectory), ['AGENTS.md']);
    for (const request of [
      { id: 'other', content: '', revision: null }, { id: 'user', content: '', revision: null, path: join(f.root, 'escape.md') },
      { id: 'user', content: 42, revision: null }, { id: 'user', content: '', revision: undefined },
    ]) await assert.rejects(f.service.save(request), /参数无效/);
  } finally { await f.cleanup(); }
});

test('external edits, additions and deletions return conflicts instead of overwriting user files', async () => {
  const f = await fixture();
  try {
    const original = await f.service.save({ id: 'user', content: 'first', revision: null });
    await writeFile(f.userPath, 'external');
    const edited = await f.service.save({ id: 'user', content: 'stale replacement', revision: original.document.revision });
    assert.equal(edited.status, 'conflict');
    assert.equal(edited.document.content, 'external');
    assert.equal(await readFile(f.userPath, 'utf8'), 'external');
    await rm(f.userPath);
    const deleted = await f.service.save({ id: 'user', content: 'must not recreate blindly', revision: edited.document.revision });
    assert.equal(deleted.status, 'conflict');
    assert.equal(deleted.document.exists, false);
    await writeFile(f.userPath, 'created externally');
    const added = await f.service.save({ id: 'user', content: 'new but stale editor', revision: null });
    assert.equal(added.status, 'conflict');
    assert.equal(added.document.content, 'created externally');
    assert.deepEqual(await readdir(f.userDirectory), ['AGENTS.md']);
  } finally { await f.cleanup(); }
});

test('Pi revision binds the selected path even when an override has identical content, and deleted Pi files are never created', async () => {
  const f = await fixture();
  try {
    const ordinary = join(f.agentDirectory, 'AGENTS.md');
    const override = join(f.agentDirectory, 'AGENTS.override.md');
    await writeFile(ordinary, 'identical');
    const before = (await f.service.list()).find(document => document.id === 'pi');
    await writeFile(override, 'identical');
    const changed = await f.service.save({ id: 'pi', content: 'wrong target', revision: before.revision });
    assert.equal(changed.status, 'conflict');
    assert.equal(changed.document.path, override);
    assert.notEqual(changed.document.revision, before.revision);
    assert.equal(await readFile(override, 'utf8'), 'identical');
    await rm(ordinary); await rm(override);
    const gone = await f.service.save({ id: 'pi', content: 'never create', revision: changed.document.revision });
    assert.equal(gone.status, 'conflict');
    assert.equal(gone.document.exists, false);
    assert.deepEqual(await readdir(f.agentDirectory), []);
    assert.equal((await f.service.list()).length, 1);
  } finally { await f.cleanup(); }
});

test('saved instruction files retain UTF-8 BOM, CRLF and file permissions', async () => {
  const f = await fixture();
  try {
    await mkdir(f.userDirectory);
    await writeFile(f.userPath, Buffer.from('\ufeffone\r\ntwo\r\n', 'utf8'));
    if (process.platform !== 'win32') await chmod(f.userPath, 0o640);
    const document = (await f.service.list())[0];
    assert.equal(document.content, 'one\r\ntwo\r\n');
    const result = await f.service.save({ id: 'user', content: '一行\nsecond 😀\n', revision: document.revision });
    assert.equal(result.status, 'saved');
    assert.deepEqual(await readFile(f.userPath), Buffer.from('\ufeff一行\r\nsecond 😀\r\n', 'utf8'));
    assert.equal(result.document.content, '一行\r\nsecond 😀\r\n');
    if (process.platform !== 'win32') assert.equal((await stat(f.userPath)).mode & 0o777, 0o640);
  } finally { await f.cleanup(); }
});

test('malformed, oversized and non-file documents report independent errors without exposing unreadable contents', async () => {
  const f = await fixture();
  try {
    await mkdir(f.userDirectory);
    await mkdir(f.userPath);
    await writeFile(join(f.agentDirectory, 'AGENTS.md'), Buffer.from([0xc3, 0x28]));
    let documents = await f.service.list();
    assert.match(documents[0].error, /不是普通文件/);
    assert.match(documents[1].error, /UTF-8/);
    assert.equal(documents[1].content, '');
    await assert.rejects(f.service.save({ id: 'user', content: 'do not overwrite directory', revision: null }), /不是普通文件/);
    await rm(f.userPath, { recursive: true });
    await writeFile(f.userPath, 'x'.repeat(128 * 1024 + 1));
    documents = await f.service.list();
    assert.match(documents[0].error, /128 KiB/);
    await assert.rejects(f.service.save({ id: 'user', content: 'x'.repeat(128 * 1024 + 1), revision: null }), /128 KiB/);
    await rm(f.userPath);
    const exact = await f.service.save({ id: 'user', content: 'x'.repeat(128 * 1024), revision: null });
    assert.equal(exact.status, 'saved');
    assert.equal((await stat(f.userPath)).size, 128 * 1024);
    await writeFile(f.userPath, 'existing\r\n');
    const crlf = (await f.service.list())[0];
    await assert.rejects(f.service.save({ id: 'user', content: '\n'.repeat(65537), revision: crlf.revision }), /128 KiB/);
    assert.equal(await readFile(f.userPath, 'utf8'), 'existing\r\n', 'post-CRLF encoding limit is checked before replacement');

    const notDirectory = join(f.root, 'not-directory');
    await writeFile(notDirectory, 'file');
    const isolated = createPersonalizationService({ userDirectory: f.userDirectory, agentDirectory: notDirectory });
    documents = await isolated.list();
    assert.equal(documents[0].content, 'existing\r\n');
    assert.ok(documents[1].error, 'ENOTDIR is not mistaken for a missing Pi document');
  } finally { await f.cleanup(); }
});

test('symbolic-link instruction files cannot redirect saves to an external target', async (t) => {
  const f = await fixture();
  try {
    await mkdir(f.userDirectory);
    const external = join(f.root, 'outside.md');
    await writeFile(external, 'must remain unchanged');
    try { await symlink(external, f.userPath, 'file'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Creating file symlinks requires Windows Developer Mode or privilege'); return; } throw error; }
    const document = (await f.service.list())[0];
    assert.match(document.error, /符号链接/);
    assert.equal(document.content, '');
    await assert.rejects(f.service.save({ id: 'user', content: 'overwrite', revision: null }), /符号链接/);
    assert.equal(await readFile(external, 'utf8'), 'must remain unchanged');
  } finally { await f.cleanup(); }
});

test('serialized saves conflict predictably, and rename failures preserve originals and clean temporary files', async () => {
  const f = await fixture();
  try {
    const original = await f.service.save({ id: 'user', content: 'before', revision: null });
    const [first, second] = await Promise.all([
      f.service.save({ id: 'user', content: 'first editor', revision: original.document.revision }),
      f.service.save({ id: 'user', content: 'second stale editor', revision: original.document.revision }),
    ]);
    assert.equal(first.status, 'saved');
    assert.equal(second.status, 'conflict');
    assert.equal(second.document.content, 'first editor');
    globalThis.__instructionRenameFailure = true;
    await assert.rejects(f.service.save({ id: 'user', content: 'failed save', revision: first.document.revision }), /rename failure/);
    assert.equal(await readFile(f.userPath, 'utf8'), 'first editor');
    assert.deepEqual(await readdir(f.userDirectory), ['AGENTS.md']);
    globalThis.__instructionRenameFailure = false;
    const recovered = await f.service.save({ id: 'user', content: 'recovered', revision: first.document.revision });
    assert.equal(recovered.status, 'saved');
    assert.equal(recovered.document.content, 'recovered');
    assert.deepEqual(await readdir(f.userDirectory), ['AGENTS.md']);
  } finally { delete globalThis.__instructionRenameFailure; await f.cleanup(); }
});

test('real SDK loaders observe saved Pi instructions on reload and inherit user instructions only beneath their directory', async () => {
  const f = await fixture();
  // The SDK walks ancestors to the filesystem root and discovers ~/.agents even
  // with noSkills enabled. Bound its discovery I/O to this fixture so this test
  // never reads the developer's instructions, Git metadata or skill files.
  const sdkIo = `
    import * as fs from 'node:fs';
    import { resolve, sep } from 'node:path';
    export * from 'node:fs';
    const root = ${JSON.stringify(resolve(f.root))};
    const inside = path => resolve(path) === root || resolve(path).startsWith(root + sep);
    export const existsSync = path => inside(path) && fs.existsSync(path);
    const guarded = method => (path, ...args) => {
      if (!inside(path)) throw new Error('SDK test attempted I/O outside its temporary fixture');
      return fs[method](path, ...args);
    };
    export const readFileSync = guarded('readFileSync');
    export const readdirSync = guarded('readdirSync');
    export const statSync = guarded('statSync');
  `;
  const sdkHook = registerHooks({ resolve(specifier, context, nextResolve) {
    if ((specifier === 'node:fs' || specifier === 'fs')
      && /\/pi-coding-agent\/dist\/core\/(resource-loader|package-manager|footer-data-provider)\.js$/.test(context.parentURL ?? '')) {
      return { url: `data:text/javascript,${encodeURIComponent(sdkIo)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  try {
    const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const project = join(f.userDirectory, 'project');
    const sibling = join(f.root, 'elsewhere');
    await mkdir(project, { recursive: true });
    await mkdir(sibling);
    const piPath = join(f.agentDirectory, 'AGENTS.md');
    await writeFile(piPath, 'Original Pi instructions');
    const userSaved = await f.service.save({ id: 'user', content: 'Inherited user instructions', revision: null });
    assert.equal(userSaved.status, 'saved');
    const createLoader = cwd => new DefaultResourceLoader({
      cwd, agentDir: f.agentDirectory, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    const loader = createLoader(project);
    await loader.reload();
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, [
      { path: piPath, content: 'Original Pi instructions' },
      { path: f.userPath, content: 'Inherited user instructions' },
    ]);

    const piDocument = (await f.service.list()).find(document => document.id === 'pi');
    const piSaved = await f.service.save({ id: 'pi', content: 'Updated Pi instructions', revision: piDocument.revision });
    assert.equal(piSaved.status, 'saved');
    assert.equal(loader.getAgentsFiles().agentsFiles[0].content, 'Original Pi instructions', 'loaded context remains a snapshot until reload');
    await loader.reload();
    assert.equal(loader.getAgentsFiles().agentsFiles[0].content, 'Updated Pi instructions');

    const newLoader = createLoader(project);
    await newLoader.reload();
    assert.deepEqual(newLoader.getAgentsFiles().agentsFiles, loader.getAgentsFiles().agentsFiles);
    const outsideLoader = createLoader(sibling);
    await outsideLoader.reload();
    assert.deepEqual(outsideLoader.getAgentsFiles().agentsFiles, [
      { path: piPath, content: 'Updated Pi instructions' },
    ], 'user instructions do not apply to a sibling project outside the user directory');
  } finally {
    sdkHook.deregister();
    await f.cleanup();
  }
});
