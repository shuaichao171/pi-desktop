import { spawn } from 'node:child_process';
export type ProcessRunner = (file: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeout?: number; maxBytes?: number }) => Promise<{ stdout: string; stderr: string }>;
export const runFeatureProcess: ProcessRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, failed = false;
  const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error(`${file} timed out`)); }, options.timeout ?? 30_000);
  const collect = (target: Buffer[]) => (data: Buffer) => { size += data.length; if (size > (options.maxBytes ?? 32 * 1024 * 1024)) { failed = true; child.kill(); reject(new Error(`${file} output exceeds limit`)); } else target.push(data); };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  child.once('error', error => { clearTimeout(timer); failed = true; reject(error); });
  child.once('close', code => { clearTimeout(timer); if (failed) return; const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8'); if (code === 0) resolve({ stdout: out, stderr: err }); else reject(new Error(`${file} exited ${code}: ${err.trim() || out.trim()}`)); });
  child.stdin.on('error', () => {}); child.stdin.end(options.input);
});
export function safeGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key) && !(key in extra)) delete env[key];
  return env;
}
