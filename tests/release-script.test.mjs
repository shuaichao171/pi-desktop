import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { REPOSITORY, assertOrigin, assertRun, compareVersions, nextVersion, parseOptions, release, verifyDraft } from '../scripts/release.mjs';

const BASE_SHA = 'a'.repeat(40);
const RELEASE_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const WORKFLOW_ID = 17;
const RUN_ID = 41;
const VERSION = '0.1.2';
const VERIFIED_AT = '2026-09-25T01:00:10Z';
const ASSET_AT = '2026-09-25T01:00:09Z';
const LATER_AT = '2026-09-25T02:00:00Z';
const manifests = ['package.json', 'packages/desktop/package.json'];

function buildRun(version = VERSION, { macos = false } = {}) {
  const job = (name, conclusion = 'success', steps = []) => ({ name, status: 'completed', conclusion,
    startedAt: '2026-09-25T00:00:00Z', completedAt: VERIFIED_AT, steps });
  return { databaseId: RUN_ID, headSha: RELEASE_SHA, headBranch: `v${version}`, event: 'push',
    workflowDatabaseId: WORKFLOW_ID, status: 'completed', conclusion: 'success', attempt: 1,
    url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`, updatedAt: LATER_AT,
    jobs: [job('prerequisites'), job('build-windows'), job('build-linux'),
      ...(macos ? [job('build-macos (macos-15-intel, x64, x86_64)'), job('build-macos (macos-15, arm64, arm64)')]
        : [job('build-macos', 'skipped')]),
      job('release', 'success', [{ name: 'Verify draft contains exactly this release batch', number: 10,
        status: 'completed', conclusion: 'success', startedAt: ASSET_AT, completedAt: VERIFIED_AT }])],
  };
}

function draftRelease(version = VERSION, { macos = false } = {}) {
  const names = [`Pi-Desktop-Setup-${version}-x64.exe`, `Pi-Desktop-Portable-${version}-x64.exe`,
    `Pi-Desktop-Setup-${version}-x64.exe.blockmap`, 'latest.yml', `Pi-Desktop-${version}-x64.AppImage`,
    `Pi-Desktop-${version}-x64.deb`, 'latest-linux.yml'];
  if (macos) names.push('latest-mac.yml', ...['x64', 'arm64'].flatMap((arch) =>
    ['dmg', 'zip'].map((ext) => `Pi-Desktop-${version}-${arch}.${ext}`)));
  return { id: 73, tag_name: `v${version}`, draft: true, prerelease: false,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/v${version}`,
    assets: names.map((name, index) => ({ id: index + 1, name, size: 100 + index, state: 'uploaded', updated_at: ASSET_AT })),
  };
}

/** All commands are simulated. This fixture never spawns Git, GitHub CLI or pnpm. */
function fixture(t) {
  const parent = realpathSync(tmpdir());
  const cwd = mkdtempSync(join(parent, 'pi-release-script-'));
  t.after(() => {
    const target = realpathSync(cwd);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith('pi-release-script-'));
    rmSync(target, { recursive: true, force: true });
  });
  mkdirSync(join(cwd, '.git'));
  mkdirSync(join(cwd, 'packages', 'desktop'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({ name: 'release-fixture', version: '0.1.1', packageManager: 'pnpm@11.11.0' }, null, 2)}\n`);
  writeFileSync(join(cwd, 'packages', 'desktop', 'package.json'), `${JSON.stringify({ name: 'desktop-fixture', version: '0.1.1' }, null, 2)}\n`);
  writeFileSync(join(cwd, 'source.txt'), 'Uncommitted user changes must remain intact.\n');
  const statePath = join(cwd, '.git', 'pi-desktop-release.json');
  const data = { cwd, statePath, calls: [], logs: [], sleeps: [], head: BASE_SHA, remoteMain: BASE_SHA,
    remoteTag: null, localTag: null, dirty: true, committed: null, draft: null, published: false, latest: null, otherReleases: [],
    run: buildRun(), failCheck: null, failPush: false, failPublishResponse: false, mutateDraft: null, viewOverride: null };
  const version = () => JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  function execute(program, args, options = {}) {
    assert.equal(options.cwd, cwd, 'commands must stay inside the temporary fixture');
    data.calls.push({ program, args: [...args], options: { ...options } });
    const result = (stdout = '', status = 0) => {
      const response = { status, stdout, stderr: status ? `fixture failure: ${program} ${args.join(' ')}` : '' };
      if (status && !options.allowFailure) throw new Error(response.stderr);
      return response;
    };
    const json = (value) => result(JSON.stringify(value));
    if (program === 'git') {
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return result(`.git/${args[2]}`);
      if (args.join(' ') === 'branch --show-current') return result('main');
      if (args[0] === 'remote' && args[1] === 'get-url') return result(`https://github.com/${REPOSITORY}.git`);
      if (args[0] === 'diff') return result('');
      if (args.join(' ') === 'rev-parse HEAD') return result(data.head);
      if (args.join(' ') === 'rev-parse HEAD^') return result(BASE_SHA);
      if (args[0] === 'rev-parse' && args[1] === '--verify') return data.localTag ? result(data.localTag) : result('', 1);
      if (args[0] === 'ls-remote') {
        const refs = new Map([['refs/heads/main', data.remoteMain]]);
        if (data.remoteTag) refs.set(`refs/tags/v${version()}`, data.remoteTag);
        return result([...refs].filter(([ref]) => args.slice(2).includes(ref)).map(([ref, sha]) => `${sha}\t${ref}`).join('\n'));
      }
      if (args[0] === 'status') return result(data.dirty ? ' M source.txt' : '');
      if (args[0] === 'fetch' || args[0] === 'merge-base' || args[0] === 'add') return result();
      if (args[0] === 'var') return result('Release Fixture <fixture@example.invalid> 1 +0000');
      if (args[0] === 'commit') {
        assert.equal(data.head, BASE_SHA, 'the fixture must never commit this release twice');
        data.head = RELEASE_SHA; data.dirty = false;
        data.committed = new Map(manifests.map((file) => [file, readFileSync(join(cwd, file), 'utf8')]));
        return result();
      }
      if (args[0] === 'log') return result(`chore(release): v${version()}`);
      if (args[0] === 'show') return result(data.committed?.get(args[1].slice('HEAD:'.length)) ?? '');
      if (args[0] === 'tag') { data.localTag = args[2]; return result(); }
      if (args[0] === 'push') {
        assert.deepEqual(args, ['push', '--atomic', 'origin', `${RELEASE_SHA}:refs/heads/main`, `refs/tags/v${version()}:refs/tags/v${version()}`]);
        if (data.failPush) return result('', 1);
        data.remoteMain = RELEASE_SHA; data.remoteTag = RELEASE_SHA;
        data.draft = draftRelease(version());
        data.mutateDraft?.(data.draft);
        return result();
      }
    }
    if (program === 'pnpm') {
      if (args[0] === '--version') return result('11.11.0');
      assert.ok(['install', 'typecheck', 'test', 'build'].includes(args[0]), `unexpected pnpm command ${args}`);
      if (data.failCheck === args[0]) return result('', 1);
      return result();
    }
    if (program === process.execPath) {
      assert.deepEqual(args, ['scripts/sync-pi.mjs', '--verify']);
      return result();
    }
    if (program === 'gh') {
      if (args[0] === 'auth') return result();
      if (args[0] === 'api') {
        assert.ok(args[1] === `repos/${REPOSITORY}` || args[1].startsWith(`repos/${REPOSITORY}/`));
        const endpoint = args[1].slice(`repos/${REPOSITORY}`.length).replace(/^\//, '');
        if (!endpoint) return json({ archived: false, permissions: { push: true } });
        if (endpoint === 'actions/workflows/release.yml') return json({ id: WORKFLOW_ID, state: 'active' });
        if (endpoint === 'releases?per_page=100') return json([[...(data.draft ? [data.draft] : []), ...data.otherReleases]]);
        if (endpoint === 'releases/73/assets?per_page=100') return json([data.draft.assets]);
        if (endpoint === 'releases/latest') return json(data.latest ?? data.draft);
        if (endpoint === `releases/tags/v${version()}`) {
          if (data.failPublishResponse) return result('', 1);
          return json(data.draft);
        }
      }
      if (args[0] === 'run' && args[1] === 'list') {
        assert.equal(args[args.indexOf('--commit') + 1], RELEASE_SHA);
        assert.equal(args[args.indexOf('--branch') + 1], `v${version()}`);
        assert.equal(args[args.indexOf('--workflow') + 1], 'release.yml');
        return json([data.run]);
      }
      if (args[0] === 'run' && args[1] === 'view') return json({ ...data.run, ...data.viewOverride });
      if (args[0] === 'run' && args[1] === 'watch') { data.run.status = 'completed'; return result(); }
      if (args[0] === 'run' && args[1] === 'rerun') {
        data.run = { ...buildRun(version()), attempt: data.run.attempt + 1 };
        return result();
      }
      if (args[0] === 'release' && args[1] === 'edit') {
        if (!args.includes('--draft=false')) {
          assert.deepEqual(args, ['release', 'edit', `v${version()}`, '--repo', REPOSITORY, '--latest']);
          data.latest = data.draft;
          return result();
        }
        assert.deepEqual(args, ['release', 'edit', `v${version()}`, '--repo', REPOSITORY, '--draft=false', '--prerelease=false', '--latest']);
        data.published = true; data.draft.draft = false; data.latest = data.draft;
        return result();
      }
    }
    throw new Error(`Unmocked command, never executed: ${program} ${args.join(' ')}`);
  }
  data.invoke = (args = []) => release(parseOptions(args), { cwd, execute, sleep: async (ms) => { data.sleeps.push(ms); }, log: (line) => data.logs.push(line) });
  data.state = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  data.count = (program, subcommand) => data.calls.filter((call) => call.program === program && call.args[0] === subcommand).length;
  return data;
}

function snapshot(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[path, readFileSync(path).toString('base64')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}

test('release options, stable version arithmetic and origin reject ambiguous or unsafe inputs', () => {
  assert.deepEqual(parseOptions([]), { version: undefined, dryRun: false, retry: false, reset: false, help: false });
  assert.equal(parseOptions(['0.2.0', '--dry-run']).version, '0.2.0');
  assert.equal(nextVersion('0.1.9'), '0.1.10');
  assert.equal(nextVersion('0.1.9007199254740993'), '0.1.9007199254740994');
  assert.equal(compareVersions('2.0.0', '1.9999.9999'), 1);
  assert.equal(nextVersion('0.1.2', '0.1.2'), '0.1.2');
  assert.throws(() => nextVersion('0.1.2', '0.1.1'));
  for (const value of ['v0.1.2', '0.1', '01.1.2', '0.1.2-beta.1', '0.1.2+build', '0.1.2\n', ' 0.1.2', '0.1.2 ']) {
    assert.throws(() => parseOptions([value]), `reject version ${JSON.stringify(value)}`);
    assert.throws(() => compareVersions(value, '0.1.1'));
  }
  for (const args of [['--unknown'], ['--reset', '--retry'], ['--reset', '0.1.2'], ['0.1.2', '0.1.3']]) assert.throws(() => parseOptions(args));
  for (const url of [`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`, `ssh://git@github.com/${REPOSITORY}.git`]) assert.doesNotThrow(() => assertOrigin(url));
  for (const url of [`https://github.com/${REPOSITORY}.git\nhttps://example.com/other.git`, `https://github.com.evil.invalid/${REPOSITORY}.git`, `https://github.com/${REPOSITORY}-other`, 'git@github.com:other/repository.git']) assert.throws(() => assertOrigin(url));
});

test('dry-run preserves every file and sends only read-only Git and GitHub commands', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.cwd);
  await f.invoke(['--dry-run']);
  assert.deepEqual(snapshot(f.cwd), before);
  assert.equal(f.state(), null);
  assert.ok(f.logs.some((line) => line.includes('v0.1.2')));
  const reads = new Set(['rev-parse', 'branch', 'remote', 'diff', 'ls-remote', 'status']);
  assert.ok(f.calls.every(({ program, args }) => program === 'git' ? reads.has(args[0]) : program === 'gh' && ['auth', 'api'].includes(args[0])));
  assert.equal(f.published, false);
});

test('failed local checks preserve resumable version changes without committing, tagging or pushing', async (t) => {
  const f = fixture(t);
  f.failCheck = 'test';
  await assert.rejects(f.invoke(), /fixture failure: pnpm test/);
  assert.equal(f.state().version, VERSION);
  assert.equal(f.state().sha, null);
  assert.equal(f.head, BASE_SHA);
  for (const command of ['add', 'commit', 'tag', 'push']) assert.equal(f.count('git', command), 0);
  assert.equal(f.count('gh', 'release'), 0);
  assert.equal(existsSync(`${f.statePath}.lock`), false);
  for (const file of manifests) assert.equal(JSON.parse(readFileSync(join(f.cwd, file), 'utf8')).version, VERSION);
  assert.equal(readFileSync(join(f.cwd, 'source.txt'), 'utf8'), 'Uncommitted user changes must remain intact.\n');
  f.failCheck = null;
  await f.invoke();
  assert.equal(f.published, true);
  assert.equal(f.count('git', 'commit'), 1);
  assert.equal(f.state(), null);
  assert.equal(JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8')).version, VERSION);
});

test('push failure resumes the same commit and tag without another version bump or local build', async (t) => {
  const f = fixture(t);
  f.failPush = true;
  await assert.rejects(f.invoke(), /fixture failure: git push/);
  assert.deepEqual(f.state(), { schema: 1, version: VERSION, baseVersion: '0.1.1', baseSha: BASE_SHA,
    sha: RELEASE_SHA, runId: null, publishing: false });
  assert.equal(f.localTag, RELEASE_SHA);
  assert.equal(f.remoteTag, null);
  const beforePreview = snapshot(f.cwd);
  await f.invoke(['--dry-run']);
  assert.deepEqual(snapshot(f.cwd), beforePreview, 'resuming in dry-run must not even rewrite progress');
  f.failPush = false;
  await f.invoke();
  assert.equal(f.count('git', 'commit'), 1);
  assert.equal(f.count('git', 'tag'), 1);
  assert.equal(f.count('git', 'push'), 2);
  assert.equal(f.calls.filter(({ program, args }) => program === 'pnpm' && args[0] === 'build').length, 1);
  assert.equal(f.published, true);
  assert.equal(f.state(), null);
  assert.equal(existsSync(`${f.statePath}.lock`), false);
  for (const file of manifests) assert.equal(JSON.parse(readFileSync(join(f.cwd, file), 'utf8')).version, VERSION);
});

test('unsuccessful CI remains a draft; retry reuses the exact workflow run without pushing again', async (t) => {
  const f = fixture(t);
  f.run.conclusion = 'failure';
  await assert.rejects(f.invoke(), /Actions/);
  assert.equal(f.state().runId, RUN_ID);
  assert.equal(f.state().publishing, false);
  assert.equal(f.draft.draft, true);
  assert.equal(f.count('gh', 'release'), 0);
  await f.invoke(['--retry']);
  assert.equal(f.published, true);
  assert.equal(f.count('git', 'commit'), 1);
  assert.equal(f.count('git', 'push'), 1);
  assert.equal(f.calls.filter(({ program, args }) => program === 'gh' && args[0] === 'run' && args[1] === 'rerun').length, 1);
  assert.equal(f.calls.some(({ program, args }) => program === 'gh' && args[0] === 'workflow'), false);
});

test('workflow identity rejects another SHA, tag, event, workflow or run ID before publishing', async (t) => {
  const state = { version: VERSION, sha: RELEASE_SHA, runId: RUN_ID };
  assert.doesNotThrow(() => assertRun(buildRun(), state, WORKFLOW_ID));
  for (const changes of [{ headSha: OTHER_SHA }, { headBranch: 'main' }, { headBranch: 'v0.1.3' },
    { event: 'workflow_dispatch' }, { workflowDatabaseId: WORKFLOW_ID + 1 }, { databaseId: RUN_ID + 1 }]) {
    assert.throws(() => assertRun({ ...buildRun(), ...changes }, state, WORKFLOW_ID));
  }
  const f = fixture(t);
  f.viewOverride = { headSha: OTHER_SHA };
  await assert.rejects(f.invoke(), /不匹配/);
  assert.equal(f.published, false);
  assert.equal(f.count('gh', 'release'), 0);
  assert.equal(f.state().runId, RUN_ID);
});

test('draft validation requires complete successful jobs and exactly the supported platform asset set', () => {
  assert.doesNotThrow(() => verifyDraft(draftRelease(), buildRun(), VERSION));
  const mutations = [
    (draft) => { draft.tag_name = 'v0.1.3'; }, (draft) => { draft.draft = false; }, (draft) => { draft.prerelease = true; },
    (draft) => { draft.assets.pop(); }, (draft) => { draft.assets.push({ ...draft.assets[0] }); },
    (draft) => { draft.assets[0].name = 'builder-debug.yml'; }, (draft) => { draft.assets[0].state = 'new'; },
    (draft) => { draft.assets[0].size = 0; }, (draft) => { draft.assets[0].updated_at = 'not-a-date'; },
  ];
  for (const mutate of mutations) { const draft = draftRelease(); mutate(draft); assert.throws(() => verifyDraft(draft, buildRun(), VERSION)); }
  for (const name of ['prerequisites', 'build-windows', 'build-linux', 'release']) {
    const run = buildRun(); run.jobs.find((job) => job.name === name).conclusion = 'failure';
    assert.throws(() => verifyDraft(draftRelease(), run, VERSION));
  }
  const noMac = buildRun(); noMac.jobs = noMac.jobs.filter((job) => job.name !== 'build-macos');
  assert.throws(() => verifyDraft(draftRelease(), noMac, VERSION));
  const withMac = buildRun(VERSION, { macos: true });
  assert.doesNotThrow(() => verifyDraft(draftRelease(VERSION, { macos: true }), withMac, VERSION));
  assert.throws(() => verifyDraft(draftRelease(), withMac, VERSION));
  withMac.jobs.find((job) => job.name.startsWith('build-macos (')).conclusion = 'skipped';
  assert.throws(() => verifyDraft(draftRelease(VERSION, { macos: true }), withMac, VERSION));
});

test('asset verification uses the successful batch verification step time, not the later run update time', () => {
  for (const mutate of [
    (job) => { job.steps = []; },
    (job) => { job.steps[0].name = 'Some unrelated verification'; },
    (job) => { job.steps[0].conclusion = 'failure'; },
    (job) => { job.steps[0].completedAt = ''; },
  ]) {
    const run = buildRun(); mutate(run.jobs.find((job) => job.name === 'release'));
    assert.throws(() => verifyDraft(draftRelease(), run, VERSION));
  }
  const changed = draftRelease();
  changed.assets[0].updated_at = '2026-09-25T01:30:00Z';
  assert.throws(() => verifyDraft(changed, buildRun(), VERSION), 'an asset changed after verification must fail even before run.updatedAt');
});

test('a successful workflow cannot publish an incomplete draft', async (t) => {
  const f = fixture(t);
  f.mutateDraft = (draft) => { draft.assets = draft.assets.filter((asset) => asset.name !== 'latest-linux.yml'); };
  await assert.rejects(f.invoke(), /草稿/);
  assert.equal(f.run.conclusion, 'success');
  assert.equal(f.published, false);
  assert.equal(f.state().publishing, false);
  assert.equal(f.count('gh', 'release'), 0);
});

test('confirmed public release clears progress; an interrupted confirmation resumes without republishing', async (t) => {
  const f = fixture(t);
  f.failPublishResponse = true;
  await assert.rejects(f.invoke(), /fixture failure: gh api/);
  assert.equal(f.published, true);
  assert.equal(f.state().publishing, true);
  assert.equal(f.count('gh', 'release'), 1);
  const saved = snapshot(f.cwd);
  await f.invoke(['--dry-run']);
  assert.deepEqual(snapshot(f.cwd), saved);
  f.failPublishResponse = false;
  await f.invoke();
  assert.equal(f.count('gh', 'release'), 1, 'a public release must never be published twice');
  assert.equal(f.count('git', 'commit'), 1);
  assert.equal(f.count('git', 'push'), 1);
  assert.equal(f.state(), null);
  assert.equal(existsSync(`${f.statePath}.lock`), false);
});

test('public-release recovery repairs Latest when needed and never replaces a newer stable Latest', async (t) => {
  for (const newerPublished of [false, true]) {
    const f = fixture(t);
    f.failPublishResponse = true;
    await assert.rejects(f.invoke(), /fixture failure: gh api/);
    f.failPublishResponse = false;
    const otherVersion = newerPublished ? '0.1.3' : '0.1.1';
    const other = { ...draftRelease(otherVersion), id: 74, draft: false };
    f.otherReleases = [other];
    f.latest = other;
    const before = snapshot(f.cwd);
    const remoteEdits = f.count('gh', 'release');
    await f.invoke(['--dry-run']);
    assert.deepEqual(snapshot(f.cwd), before);
    assert.equal(f.count('gh', 'release'), remoteEdits, 'preview must not change the Latest marker');
    await f.invoke();
    assert.equal(f.latest.tag_name, newerPublished ? 'v0.1.3' : `v${VERSION}`);
    assert.equal(f.count('gh', 'release'), newerPublished ? remoteEdits : remoteEdits + 1);
    assert.equal(f.calls.filter(({ program, args }) => program === 'gh' && args.includes('--draft=false')).length, 1);
    assert.equal(f.count('git', 'commit'), 1);
    assert.equal(f.count('git', 'push'), 1);
    assert.equal(f.state(), null);
  }
});

test('public-release recovery keeps progress when the remote tag changed or the release became a prerelease', async (t) => {
  for (const corruptRemote of [
    (f) => { f.remoteTag = OTHER_SHA; },
    (f) => { f.draft.prerelease = true; },
  ]) {
    const f = fixture(t);
    f.failPublishResponse = true;
    await assert.rejects(f.invoke(), /fixture failure: gh api/);
    f.failPublishResponse = false;
    corruptRemote(f);
    const before = readFileSync(f.statePath, 'utf8');
    await assert.rejects(f.invoke(), /不匹配|预发行/);
    assert.equal(readFileSync(f.statePath, 'utf8'), before);
    assert.equal(f.count('gh', 'release'), 1);
    assert.equal(existsSync(`${f.statePath}.lock`), false);
  }
});

test('reset deletes only local release progress and dry-run reset leaves it intact', async (t) => {
  const f = fixture(t);
  f.failPush = true;
  await assert.rejects(f.invoke(), /fixture failure: git push/);
  const before = snapshot(f.cwd);
  await f.invoke(['--reset', '--dry-run']);
  assert.deepEqual(snapshot(f.cwd), before);
  const callCount = f.calls.length;
  await f.invoke(['--reset']);
  assert.deepEqual(f.calls.slice(callCount).map(({ program, args }) => [program, ...args]), [['git', 'rev-parse', '--git-path', 'pi-desktop-release.json']]);
  assert.equal(f.state(), null);
  assert.equal(f.head, RELEASE_SHA);
  assert.equal(f.localTag, RELEASE_SHA);
  assert.equal(f.count('git', 'commit'), 1);
  assert.equal(JSON.parse(readFileSync(join(f.cwd, 'package.json'), 'utf8')).version, VERSION);
});
