// Local protocol fixture only. It never reads user project files or credentials.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode = 'normal', pidPath] = process.argv.slice(2);
let child;
if (mode === 'tree') child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
if (pidPath) writeFileSync(pidPath, JSON.stringify({ pid: process.pid, child: child?.pid }));
const lines = createInterface({ input: process.stdin });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
lines.on('line', line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  if (mode === 'hang') return;
  if (request.method === 'initialize') send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' } });
  else if (request.method === 'tools/list') send(request.id, { tools: [{ name: 'echo.test', description: 'Echo the provided text', inputSchema: { type: 'object', properties: { text: { type: 'string' }, delay: { type: 'number' } }, required: ['text'] } }] });
  else if (request.method === 'tools/call') setTimeout(() => send(request.id, { content: [{ type: 'text', text: `echo:${request.params.arguments.text}:pid=${process.pid}` }] }), request.params.arguments.delay || 0);
  else if (request.method === 'ping') send(request.id, {});
});
lines.on('close', () => { child?.kill(); process.exit(0); });
