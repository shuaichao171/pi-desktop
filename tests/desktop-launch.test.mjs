import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseDesktopLaunch, rendererLaunchUrl, reservePaiProfile, validatePaiWorkspace } from '../packages/desktop/src/main/desktopLaunch.ts';

async function temporary(action) {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-launch-'));
  try { await action(root); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 4 }); }
}

test('pai parses explicit folders without changing regular Electron launch behavior', () => {
  assert.deepEqual(parseDesktopLaunch(['electron', 'out/main/index.js', '--inspect=9229']), { windowMode: 'full' });
  assert.deepEqual(parseDesktopLaunch(['pi.exe', '--pai', '--cwd', 'D:\\项目 文件夹'], 'win32'), { windowMode: 'pai', cwd: 'D:\\项目 文件夹' });
  assert.deepEqual(parseDesktopLaunch(['--cwd=\\\\server\\share\\project', '--pai'], 'win32'), { windowMode: 'pai', cwd: '\\\\server\\share\\project' });
  assert.deepEqual(parseDesktopLaunch(['--pai', '--cwd=/work/my project'], 'linux'), { windowMode: 'pai', cwd: '/work/my project' });
  for (const args of [
    ['--pai'], ['--pai', '--cwd'], ['--pai', '--cwd='], ['--pai', '--cwd', '../project'],
    ['--pai', '--cwd', 'D:relative'], ['--pai', '--cwd', '\\rooted'],
    ['--pai', '--cwd', 'D:\\one', '--cwd', 'D:\\two'], ['--pai', '--pai', '--cwd', 'D:\\one'],
    ['--pai=true', '--cwd', 'D:\\one'], ['--cwd', 'D:\\one'],
  ]) assert.throws(() => parseDesktopLaunch(args, 'win32'), /--pai|--cwd/);
});

test('pai requires an existing directory and its renderer starts directly in compact mode', async () => {
  await temporary(async root => {
    assert.equal(validatePaiWorkspace(root), root);
    const file = join(root, 'file.txt');
    await writeFile(file, 'not a directory');
    assert.throws(() => validatePaiWorkspace(file), /existing folder/);
    assert.throws(() => validatePaiWorkspace(join(root, 'missing')));
    const launch = { windowMode: 'pai', cwd: root };
    const url = new URL(rendererLaunchUrl('http://localhost:5173/?existing=1#chat', launch));
    assert.equal(url.searchParams.get('mode'), 'pai');
    assert.equal(url.searchParams.get('existing'), '1');
    assert.equal(url.hash, '#chat');
    assert.equal(rendererLaunchUrl('http://localhost:5173/', { windowMode: 'full' }), 'http://localhost:5173/');
  });
});

test('active pai profiles isolate app and Chromium state while released profiles retain settings', async () => {
  await temporary(async root => {
    const first = reservePaiProfile(root), second = reservePaiProfile(root);
    assert.notEqual(first.userData, second.userData);
    assert.notEqual(first.sessionData, second.sessionData);
    assert.notEqual(first.userData, root);
    const settings = join(first.userData, 'desktop-settings.json');
    const rendererSettings = join(first.sessionData, 'persistent-settings-sentinel');
    await writeFile(settings, '{"closeBehavior":"quit"}');
    await writeFile(rendererSettings, 'dark');
    first.release();
    const next = reservePaiProfile(root);
    assert.equal(next.userData, first.userData);
    assert.equal(await readFile(settings, 'utf8'), '{"closeBehavior":"quit"}');
    assert.equal(await readFile(rendererSettings, 'utf8'), 'dark');
    // The old release closure must not remove the replacement owner's lease.
    first.release();
    await access(join(dirname(next.userData), 'lease.json'));
    next.release(); second.release();
  });
});

test('a dead lease and crashed claim are recovered without deleting profile data', async () => {
  await temporary(async root => {
    const slot = join(root, 'pai-profiles', 'slot-1');
    await mkdir(join(slot, '.claim'), { recursive: true });
    await writeFile(join(slot, '.claim', 'owner.json'), JSON.stringify({ pid: 8801, token: 'dead-claim' }));
    await writeFile(join(slot, 'lease.json'), JSON.stringify({ pid: 8801, token: 'dead-lease' }));
    const profile = reservePaiProfile(root, { pid: 8802, isProcessRunning: pid => pid !== 8801 });
    assert.equal(profile.userData, join(slot, 'profile'));
    assert.equal(JSON.parse(await readFile(join(slot, 'lease.json'), 'utf8')).pid, 8802);
    assert.equal(JSON.parse(await readFile(join(slot, '.claim', 'owner.json'), 'utf8')).token, 'dead-claim');
    profile.release();
    const reused = reservePaiProfile(root, { pid: 8803, isProcessRunning: pid => pid !== 8801 });
    assert.equal(reused.userData, profile.userData, 'an abandoned claim does not permanently block its profile');
    reused.release();
  });
});

test('live or unreadable owners are skipped and release never removes another owner', async () => {
  await temporary(async root => {
    const first = reservePaiProfile(root);
    const lease = join(dirname(first.userData), 'lease.json');
    await writeFile(lease, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
    first.release();
    assert.equal(JSON.parse(await readFile(lease, 'utf8')).token, 'replacement-owner');
    const second = reservePaiProfile(root);
    assert.notEqual(second.userData, first.userData);
    second.release();
    await writeFile(lease, '{bad json');
    const third = reservePaiProfile(root);
    assert.notEqual(third.userData, first.userData);
    third.release();
  });
});

test('simultaneous operating-system processes cannot acquire the same profile', async () => {
  await temporary(async root => {
    const moduleUrl = new URL('../packages/desktop/src/main/desktopLaunch.ts', import.meta.url).href;
    const source = `import { reservePaiProfile } from ${JSON.stringify(moduleUrl)};
      const profile = reservePaiProfile(process.argv[1]);
      console.log(JSON.stringify({ userData: profile.userData, sessionData: profile.sessionData }));
      process.stdin.resume(); process.stdin.once('data', () => { profile.release(); process.exit(0); });`;
    const children = [];
    try {
      const profiles = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        children.push(child);
        let output = '', errorOutput = '';
        child.on('error', reject);
        child.stderr.on('data', data => { errorOutput += data; });
        child.on('exit', code => { if (code !== 0) reject(new Error(errorOutput || `profile child exited: ${code}`)); });
        child.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
      })));
      assert.equal(new Set(profiles.map(profile => profile.userData)).size, 4);
      assert.equal(new Set(profiles.map(profile => profile.sessionData)).size, 4);
      await Promise.all(children.map(child => new Promise((resolve, reject) => {
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`profile child exited: ${code}`)));
        child.stdin.end('release');
      })));
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  });
});

test('multi parses a full-size second instance and keeps its profiles separate from pai', async () => {
  assert.deepEqual(parseDesktopLaunch(['pi.exe', '--multi'], 'win32'), { windowMode: 'multi' });
  assert.deepEqual(parseDesktopLaunch(['--multi', '--inspect=9229'], 'win32'), { windowMode: 'multi' });
  for (const args of [
    ['--multi', '--multi'], ['--pai', '--multi'], ['--multi', '--pai'],
    ['--multi=1'], ['--multi', '--cwd', 'D:\one'],
  ]) assert.throws(() => parseDesktopLaunch(args, 'win32'), /--multi|--pai|--cwd/);
  assert.equal(rendererLaunchUrl('http://localhost:5173/', { windowMode: 'multi' }), 'http://localhost:5173/');
  await temporary(async root => {
    const pai = reservePaiProfile(root);
    const multi = reservePaiProfile(root, { rootName: 'multi-profiles' });
    assert.ok(pai.userData.includes(join('pai-profiles', 'slot-')), pai.userData);
    assert.ok(multi.userData.includes(join('multi-profiles', 'slot-')), multi.userData);
    assert.notEqual(pai.userData, multi.userData);
    pai.release();
    multi.release();
  });
});
