import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const REPOSITORY = 'shuaichao171/pi-desktop';
const WORKFLOW = 'release.yml';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Unlike $, this end assertion also rejects a trailing newline.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const SHA = /^[a-f0-9]{40}(?![\s\S])/;
const HELP = `Pi Desktop 一键发布

  release.cmd                  自动递增补丁版本，或继续未完成的发布
  release.cmd 0.2.0            指定稳定版本
  release.cmd --dry-run        只读取并预览，不修改文件或发布
  release.cmd --retry          重新运行失败的同一版本构建
  release.cmd --reset          清除本地发布进度，不撤销提交、标签或 Release

其他系统：node scripts/release.mjs [版本] [选项]
发布会提交所有未忽略的工作区改动（含删除），推送 main 和版本标签，
等待 GitHub Actions 校验成功后公开 Release 并设为 Latest。
需要 Node.js >=22.19、项目指定的 pnpm、Git，以及已 gh auth login 的 GitHub CLI。
`;

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'dry-run': { type: 'boolean' }, retry: { type: 'boolean' }, reset: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (positionals.length > 1 || (positionals[0] && !VERSION.test(positionals[0]))) {
    throw new Error('版本必须为稳定的 X.Y.Z，例如 release.cmd 0.2.0。');
  }
  if (values.reset && (values.retry || positionals.length)) throw new Error('--reset 不能和版本或 --retry 一起使用。');
  return { version: positionals[0], dryRun: !!values['dry-run'], retry: !!values.retry, reset: !!values.reset, help: !!values.help };
}

export function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error(`不支持的稳定版本：${a}, ${b}`);
  const right = b.split('.').map(BigInt);
  for (const [index, part] of a.split('.').map(BigInt).entries()) {
    if (part !== right[index]) return part > right[index] ? 1 : -1;
  }
  return 0;
}

export function nextVersion(current, requested) {
  compareVersions(current, current);
  const parts = current.split('.');
  const result = requested ?? `${parts[0]}.${parts[1]}.${BigInt(parts[2]) + 1n}`;
  if (compareVersions(result, current) < 0) throw new Error('目标版本不能低于当前版本。');
  return result;
}

export function assertOrigin(url) {
  if (![ `https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`,
    `git@github.com:${REPOSITORY}.git`, `git@github.com:${REPOSITORY}`,
    `ssh://git@github.com/${REPOSITORY}.git` ].includes(url)) {
    throw new Error(`origin 必须指向 github.com/${REPOSITORY}，且只能有一个推送地址。`);
  }
}

export function assertRun(run, state, workflowId) {
  if (run.headSha !== state.sha || run.headBranch !== `v${state.version}` || run.event !== 'push' ||
      run.workflowDatabaseId !== workflowId || run.databaseId !== state.runId) {
    throw new Error('工作流与本次发布的标签、提交或工作流 ID 不匹配，已停止发布。');
  }
}

export function verifyDraft(release, run, version) {
  if (release.tag_name !== `v${version}` || !release.draft || release.prerelease) throw new Error('目标必须是本版本的正式版草稿。');
  const jobs = run.jobs ?? [];
  for (const name of ['prerequisites', 'build-windows', 'build-linux', 'release']) {
    if (!jobs.some((job) => job.name === name && job.conclusion === 'success')) throw new Error(`发布作业未成功：${name}`);
  }
  const mac = jobs.filter((job) => job.name === 'build-macos' || job.name.startsWith('build-macos ('));
  if (!mac.length || mac.some((job) => !['success', 'skipped'].includes(job.conclusion)) ||
      (mac.some((job) => job.conclusion === 'success') && (mac.length !== 2 || mac.some((job) => job.conclusion !== 'success')))) {
    throw new Error('macOS 作业状态不完整。');
  }
  const setup = `Pi-Desktop-Setup-${version}-x64.exe`;
  const portable = `Pi-Desktop-Portable-${version}-x64.exe`;
  const linux = `Pi-Desktop-${version}-x64.AppImage`;
  const required = [setup, portable, `${setup}.blockmap`, 'latest.yml', linux, `Pi-Desktop-${version}-x64.deb`, 'latest-linux.yml'];
  const optional = [`${portable}.blockmap`, `${linux}.blockmap`];
  if (mac.every((job) => job.conclusion === 'success')) {
    required.push('latest-mac.yml');
    for (const arch of ['x64', 'arm64']) {
      required.push(`Pi-Desktop-${version}-${arch}.dmg`, `Pi-Desktop-${version}-${arch}.zip`);
      optional.push(`Pi-Desktop-${version}-${arch}.zip.blockmap`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  const seen = new Set();
  const verification = jobs.find((job) => job.name === 'release')?.steps?.find((step) => step.name === 'Verify draft contains exactly this release batch');
  const verifiedAt = Date.parse(verification?.completedAt);
  if (verification?.conclusion !== 'success' || !Number.isFinite(verifiedAt)) throw new Error('未确认草稿产物校验步骤成功。');
  for (const asset of release.assets ?? []) {
    const updatedAt = Date.parse(asset.updated_at);
    if (seen.has(asset.name) || !allowed.has(asset.name) || asset.state !== 'uploaded' ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || !Number.isFinite(updatedAt) || updatedAt > verifiedAt) {
      throw new Error(`草稿产物无效或在工作流校验后被修改：${asset.name}`);
    }
    seen.add(asset.name);
  }
  if (required.some((name) => !seen.has(name))) throw new Error('草稿缺少必需的安装包或更新清单。');
}

// Only pnpm needs cmd.exe on Windows. Its arguments below are fixed, never user input.
export function command(program, args, { cwd = ROOT, capture = true, allowFailure = false } = {}) {
  let executable = program;
  let argv = args;
  if (process.platform === 'win32' && program === 'pnpm') {
    if (args.some((arg) => !/^[a-zA-Z0-9:@/_.=-]+$/.test(arg))) throw new Error('不安全的 pnpm 参数。');
    executable = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/s', '/c', `pnpm ${args.join(' ')}`];
  }
  const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.error) throw new Error(`无法运行 ${program}：${result.error.message}`);
  if (result.status !== 0 && !allowFailure) throw new Error(`${program} ${args.join(' ')} 失败（${result.status ?? result.signal}）。\n${result.stderr ?? ''}`.trim());
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function lockRelease(path) {
  try {
    const fd = openSync(path, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`发布锁损坏，请检查 ${path}`);
    try { process.kill(pid, 0); }
    catch (probeError) {
      if (probeError.code !== 'ESRCH') throw probeError;
      unlinkSync(path);
      return lockRelease(path);
    }
    throw new Error(`另一个发布进程正在运行（PID ${pid}）。`);
  }
  return () => unlinkSync(path);
}

export async function release(options, { cwd = ROOT, execute = command, sleep = delay, log = console.log } = {}) {
  if (options.help) { log(HELP); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('需要 Node.js 22.19 或更新版本。');
  const run = (program, args, extra = {}) => execute(program, args, { cwd, ...extra });
  const git = (...args) => run('git', args).stdout;
  const gh = (...args) => run('gh', args).stdout;
  const api = (endpoint, paginate = false) => JSON.parse(gh('api', `repos/${REPOSITORY}${endpoint ? `/${endpoint}` : ''}`,
    ...(paginate ? ['--paginate', '--slurp'] : [])));
  const manifests = ['package.json', 'packages/desktop/package.json'];
  const readManifest = (file) => JSON.parse(readFileSync(resolve(cwd, file), 'utf8'));
  const statePath = resolve(cwd, git('rev-parse', '--git-path', 'pi-desktop-release.json'));
  const unlock = options.dryRun ? () => {} : lockRelease(`${statePath}.lock`);
  try {
    if (options.reset) {
      if (!options.dryRun && existsSync(statePath)) unlinkSync(statePath);
      log(options.dryRun ? `将清除本地发布进度：${statePath}` : '已清除本地发布进度。提交、标签和 GitHub Release 未改变。');
      return;
    }
    let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    if (state && (state.schema !== 1 || !VERSION.test(state.version) || !VERSION.test(state.baseVersion) || !SHA.test(state.baseSha) ||
      (state.sha !== null && !SHA.test(state.sha)) || (state.runId !== null && !Number.isSafeInteger(state.runId)))) {
      throw new Error(`发布进度无效，请检查 ${statePath}。`);
    }
    const save = () => {
      writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(`${statePath}.tmp`, statePath);
    };
    const root = readManifest(manifests[0]);
    const desktop = readManifest(manifests[1]);
    if (state ? ![root.version, desktop.version].every((v) => [state.baseVersion, state.version].includes(v)) : root.version !== desktop.version) {
      throw new Error('两处应用版本不一致，或不符合保存的发布进度。');
    }
    const version = state?.version ?? nextVersion(root.version, options.version);
    if (options.version && options.version !== version) throw new Error(`还有未完成的 v${version}。请先继续，或用 --reset 清除本地进度。`);
    if (options.retry && !state?.sha) throw new Error('--retry 需要已提交的发布进度。');
    const tag = `v${version}`;
    const message = `chore(release): ${tag}`;
    if (git('branch', '--show-current') !== 'main') throw new Error('请切换到 main 分支后发布。');
    assertOrigin(git('remote', 'get-url', 'origin'));
    assertOrigin(git('remote', 'get-url', '--push', '--all', 'origin'));
    if (git('diff', '--name-only', '--diff-filter=U')) throw new Error('请先解决 Git 合并冲突。');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (existsSync(resolve(cwd, git('rev-parse', '--git-path', marker)))) throw new Error('请先完成当前 Git 合并、变基或拣选操作。');
    }
    run('gh', ['auth', 'status', '--hostname', 'github.com']);
    const repo = api('');
    if (repo.archived || !repo.permissions?.push) throw new Error('当前 GitHub 账号没有此仓库的推送权限，或仓库已归档。');
    const workflow = api(`actions/workflows/${WORKFLOW}`);
    if (workflow.state !== 'active') throw new Error('Desktop release 工作流未启用。');
    const releases = api('releases?per_page=100', true).flat();
    const existing = releases.find((item) => item.tag_name === tag);
    // An interrupted publish can already have succeeded; do not rebuild or republish it.
    if (existing && !existing.draft) {
      if (state?.publishing && state.sha) {
        const remote = git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
        if (!remote.split('\n').some((line) => line.startsWith(`${state.sha}\t`))) throw new Error('已公开版本的标签提交与发布进度不匹配。');
        if (existing.prerelease) throw new Error('此版本已公开但被标记为预发行，请检查 GitHub Release 状态。');
        let latest = api('releases/latest');
        const newer = releases.some((item) => !item.draft && !item.prerelease && item.tag_name?.startsWith('v') &&
          VERSION.test(item.tag_name.slice(1)) && compareVersions(item.tag_name.slice(1), version) > 0);
        if (latest.tag_name !== tag && !newer) {
          if (options.dryRun) { log(`此版本已公开，将恢复 Latest 标记：${existing.html_url}`); return; }
          gh('release', 'edit', tag, '--repo', REPOSITORY, '--latest');
          latest = api('releases/latest');
          if (latest.tag_name !== tag) throw new Error('尚未确认本版本为 Latest，发布进度已保留。');
        }
        if (!options.dryRun) unlinkSync(statePath);
        log(`此版本已发布：${existing.html_url}${newer ? '\n已有更高正式版本公开，保持现有 Latest 标记。' : ''}`);
        return;
      }
      throw new Error(`${tag} 已公开，不能覆盖。请发布更高版本。`);
    }
    for (const item of releases.filter((item) => !item.draft && !item.prerelease && VERSION.test(item.tag_name?.slice(1)) && item.tag_name.startsWith('v'))) {
      if (compareVersions(version, item.tag_name.slice(1)) <= 0) throw new Error(`版本必须高于已发布的 ${item.tag_name}。`);
    }
    const head = git('rev-parse', 'HEAD');
    const tagRef = `refs/tags/${tag}`;
    const remoteRefs = () => new Map(git('ls-remote', 'origin', 'refs/heads/main', tagRef, `${tagRef}^{}`).split('\n').filter(Boolean).map((line) => {
      const [sha, ref] = line.split('\t'); return [ref, sha];
    }));
    let refs = remoteRefs();
    const taggedSha = (values) => values.get(`${tagRef}^{}`) ?? values.get(tagRef);
    const localTag = run('git', ['rev-parse', '--verify', '--quiet', `${tagRef}^{commit}`], { allowFailure: true });
    if (!state && (localTag.status === 0 || taggedSha(refs) || existing)) throw new Error(`${tag} 已存在。请使用新版本，或恢复原发布进度。`);
    if (state?.sha && ((localTag.status === 0 && localTag.stdout !== state.sha) || (taggedSha(refs) && taggedSha(refs) !== state.sha))) {
      throw new Error('版本标签指向了另一个提交；脚本不会移动或覆盖标签。');
    }
    log(`\n${state ? '继续发布' : '准备发布'} ${tag} → https://github.com/${REPOSITORY}`);
    if (options.dryRun) {
      log(`当前版本：${root.version}；当前提交：${head}`);
      if (!state?.sha) log(`将提交全部未忽略改动：\n${git('status', '--short') || '（当前工作区干净）'}`);
      log('流程：同步版本 → 冻结安装依赖 → SDK/类型/测试/构建检查 → 提交 → 原子推送 main 与本次标签 → 等待 Actions → 校验草稿 → 公开为 Latest。');
      log(`发布进度：${statePath}\n预览完成，没有修改文件、Git 或 GitHub。`);
      return;
    }
    if (!state) {
      state = { schema: 1, version, baseVersion: root.version, baseSha: head, sha: null, runId: null, publishing: false };
      save();
    }
    if (!state.sha) {
      // Recover a commit that completed immediately before the process was interrupted.
      if (head !== state.baseSha) {
        if (git('log', '-1', '--format=%s') !== message || git('rev-parse', 'HEAD^') !== state.baseSha ||
            manifests.some((file) => JSON.parse(git('show', `HEAD:${file}`)).version !== version)) {
          throw new Error('开始发布后 HEAD 已改变。请检查提交，或 --reset 后重新发布。');
        }
        state.sha = head;
        save();
      } else {
        git('fetch', '--no-tags', 'origin', 'main');
        git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD');
        const requiredPnpm = root.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
        if (!requiredPnpm || run('pnpm', ['--version']).stdout !== requiredPnpm) throw new Error(`请安装项目指定的 pnpm ${requiredPnpm ?? ''}。`);
        git('var', 'GIT_AUTHOR_IDENT');
        git('var', 'GIT_COMMITTER_IDENT');
        for (const file of manifests) {
          const path = resolve(cwd, file);
          const text = readFileSync(path, 'utf8');
          const data = JSON.parse(text);
          data.version = version;
          writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`.replaceAll('\n', text.includes('\r\n') ? '\r\n' : '\n'));
        }
        for (const [program, args] of [ ['pnpm', ['install', '--frozen-lockfile']], [process.execPath, ['scripts/sync-pi.mjs', '--verify']],
          ['pnpm', ['typecheck']], ['pnpm', ['test']], ['pnpm', ['build']] ]) {
          log(`\n> ${program} ${args.join(' ')}`);
          run(program, args, { capture: false });
        }
        if (git('rev-parse', 'HEAD') !== state.baseSha || manifests.some((file) => readManifest(file).version !== version)) {
          throw new Error('检查期间 HEAD 或版本发生变化，请检查工作区后重试。');
        }
        git('add', '-A');
        run('git', ['commit', '--allow-empty', '-m', message], { capture: false });
        state.sha = git('rev-parse', 'HEAD');
        save();
      }
    }
    refs = remoteRefs();
    if (taggedSha(refs) && taggedSha(refs) !== state.sha) throw new Error('远程标签提交不匹配。');
    if (!taggedSha(refs)) {
      if (git('rev-parse', 'HEAD') !== state.sha || git('status', '--porcelain')) throw new Error('发布提交后工作区又有变化。请保存到其他分支，或 --reset 后发布新版本。');
      const currentTag = run('git', ['rev-parse', '--verify', '--quiet', `${tagRef}^{commit}`], { allowFailure: true });
      if (currentTag.status === 0 && currentTag.stdout !== state.sha) throw new Error('本地标签提交不匹配。');
      if (currentTag.status !== 0) git('tag', tag, state.sha);
      run('git', ['push', '--atomic', 'origin', `${state.sha}:refs/heads/main`, `${tagRef}:${tagRef}`], { capture: false });
    }
    // Tag push is the only trigger; dispatching again would build the same release twice.
    if (!state.runId) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const runs = JSON.parse(gh('run', 'list', '--repo', REPOSITORY, '--workflow', WORKFLOW, '--event', 'push', '--branch', tag,
          '--commit', state.sha, '--limit', '20', '--json', 'databaseId,headSha,headBranch,event,workflowDatabaseId'));
        const match = runs.find((item) => item.headSha === state.sha && item.headBranch === tag && item.event === 'push' && item.workflowDatabaseId === workflow.id);
        if (match) { state.runId = match.databaseId; save(); break; }
        if (attempt === 0) log('等待 GitHub 创建本次标签的工作流…');
        await sleep(5000);
      }
      if (!state.runId) throw new Error('尚未找到标签工作流。请检查 Actions 状态；稍后再运行本脚本会继续等待。');
    }
    const getRun = () => JSON.parse(gh('run', 'view', String(state.runId), '--repo', REPOSITORY, '--json',
      'databaseId,headSha,headBranch,event,workflowDatabaseId,status,conclusion,url,updatedAt,jobs,attempt'));
    let build = getRun();
    assertRun(build, state, workflow.id);
    log(`构建进度：${build.url}`);
    if (options.retry && build.status === 'completed' && build.conclusion !== 'success') {
      gh('run', 'rerun', String(state.runId), '--repo', REPOSITORY);
      const previousAttempt = build.attempt;
      for (let attempt = 0; attempt < 24; attempt++) {
        await sleep(5000);
        build = getRun();
        if (build.attempt > previousAttempt || build.status !== 'completed') break;
      }
      if (build.attempt === previousAttempt && build.status === 'completed') throw new Error('重跑请求已发送，稍后再运行脚本以继续。');
    }
    if (build.status !== 'completed') {
      run('gh', ['run', 'watch', String(state.runId), '--repo', REPOSITORY, '--exit-status', '--interval', '10'], { capture: false });
      build = getRun();
    }
    assertRun(build, state, workflow.id);
    if (build.status !== 'completed' || build.conclusion !== 'success') {
      throw new Error('Actions 构建未成功。临时故障可用 --retry；代码问题请 --reset、修复后发布新版本。');
    }
    const draft = api('releases?per_page=100', true).flat().find((item) => item.tag_name === tag);
    if (!draft) throw new Error('构建成功但未找到草稿 Release。');
    draft.assets = api(`releases/${draft.id}/assets?per_page=100`, true).flat();
    verifyDraft(draft, build, version);
    // CI verified SHA-512 and the exact uploaded batch; reject later asset changes above.
    refs = remoteRefs();
    if (taggedSha(refs) !== state.sha) throw new Error('发布前远程标签发生变化。');
    const publicReleases = api('releases?per_page=100', true).flat().filter((item) => !item.draft && !item.prerelease);
    if (publicReleases.some((item) => item.tag_name?.startsWith('v') && VERSION.test(item.tag_name.slice(1)) && compareVersions(item.tag_name.slice(1), version) >= 0)) {
      throw new Error('已有相同或更高版本公开，已停止将本版本设为 Latest。');
    }
    state.publishing = true;
    save();
    run('gh', ['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--prerelease=false', '--latest'], { capture: false });
    const published = api(`releases/tags/${tag}`);
    const latest = api('releases/latest');
    if (published.draft || published.prerelease || latest.tag_name !== tag) throw new Error('公开状态或 Latest 状态未确认，请重试检查。');
    unlinkSync(statePath);
    log(`\n发布完成：${published.html_url}\n安装版现在可以通过软件内更新发现 ${version}。`);
  } finally {
    unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await release(parseOptions(process.argv.slice(2))); }
  catch (error) {
    console.error(`\n[发布失败] ${error.message}\n未完成进度会保留。修复问题后重跑原命令；查看用法：release.cmd --help`);
    process.exitCode = 1;
  }
}
