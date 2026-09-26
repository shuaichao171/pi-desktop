// Run with the packaged Electron in ELECTRON_RUN_AS_NODE mode, passing its resources directory.
// Only starts an owned hidden PowerShell child; no application window or remote request.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const requirePackaged = createRequire(join(process.argv[2], 'app.asar', 'package.json'));

function samplePdf() {
  const stream = 'BT /F1 12 Tf 30 200 Td (Packaged PDF text) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return new Uint8Array(Buffer.from(text + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
}

async function main() {
  const fs = require('node:fs');
  const rendererRoot = join(process.argv[2], 'app.asar', 'out', 'renderer');
  const html = fs.readFileSync(join(rendererRoot, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^\"]+)"/g)].map(match => match[1]);
  assert(assets.some(path => path.endsWith('.js')) && assets.some(path => path.endsWith('.css')));
  for (const asset of assets) assert(fs.statSync(join(rendererRoot, asset)).size > 0);
  console.log('PASS packaged renderer assets:', assets.join(', '));
  const pdfModule = pathToFileURL(requirePackaged.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')).href;
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {getDocument}=await import(workerData.module);const task=getDocument({data:workerData.data,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0});
    try{const pdf=await task.promise;const content=await(await pdf.getPage(1)).getTextContent();parentPort.postMessage(content.items.map(i=>i.str||'').join(' '));}finally{await task.destroy();}})().catch(e=>{throw e;});`,
    { eval: true, workerData: { module: pdfModule, data: samplePdf() } });
  try {
    const text = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Packaged PDF timed out')), 15000);
      worker.once('message', text => { clearTimeout(timeout); resolve(text); });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    assert.match(text, /Packaged PDF text/); console.log('PASS packaged PDF worker text extraction');
  } finally { await worker.terminate(); }

  const pty = requirePackaged('node-pty').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', "Write-Output 'PACKAGED-PTY-中文'"],
    { name: 'xterm-256color', cwd: process.cwd(), cols: 100, rows: 30, env: process.env, useConpty: true });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Packaged PTY timed out')), 15000);
      pty.onData(data => { output += data; });
      pty.onExit(({ exitCode }) => { clearTimeout(timeout); exitCode === 0 ? resolve() : reject(new Error(`PTY exit ${exitCode}`)); });
    });
    assert.match(output, /PACKAGED-PTY-中文/); console.log('PASS packaged ConPTY process and UTF-8');
  } finally { pty.kill(); }

  const mcp = await import(pathToFileURL(requirePackaged.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  assert.equal(typeof mcp.Client, 'function');
  // Pi exports its entry for ESM only, so CJS require.resolve cannot select it.
  const piRoot = join(process.argv[2], 'app.asar', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const piManifest = JSON.parse(require('node:fs').readFileSync(join(piRoot, 'package.json'), 'utf8'));
  const pi = await import(pathToFileURL(join(piRoot, piManifest.exports['.'].import)).href);
  assert.equal(typeof pi.createAgentSessionRuntime, 'function');
  console.log('PASS packaged MCP and Pi SDK imports');
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
