import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { UiPdfInputRequest, UiPdfInputResult } from '../../../shared/src/inputFeatures';

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getDocument } = await import(workerData.module);
  const task = getDocument({data:new Uint8Array(workerData.data),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0,stopAtErrors:true});
  let pdf;
  try {
    pdf = await task.promise;
    if(pdf.numPages>100) throw new Error('PDF超过100页限制，请拆分后添加');
    const pages=[], scannedPages=[]; let remaining=190000, truncated=false;
    for(let page=1;page<=pdf.numPages;page++) {
      const source=await pdf.getPage(page), content=await source.getTextContent();
      const text=content.items.map(item=> typeof item.str==='string'?item.str+(item.hasEOL?'\\n':' '):'').join('').trim();
      if(!text) scannedPages.push(page);
      const header='[Page '+page+']\\n';
      if(remaining>header.length) { const value=text.slice(0,remaining-header.length); pages.push(header+(value||'[No extractable text: image/scanned page]')); remaining-=header.length+value.length; if(value.length<text.length) truncated=true; }
      else truncated=true;
      source.cleanup();
    }
    if(scannedPages.length===pdf.numPages) throw new Error('此PDF没有可提取文字（可能是扫描件）；首期不支持OCR，请先转换为文字PDF或添加页面图片');
    parentPort.postMessage({ok:true,pageCount:pdf.numPages,scannedPages,truncated,text:pages.join('\\n\\n')});
  } finally { try { await task.destroy(); } catch {} }
})().catch(error=>parentPort.postMessage({ok:false,error:error?.name==='PasswordException'?'加密PDF暂不支持，请先解密后添加':String(error?.message||error)}));
`;

/** Parsing runs in a disposable worker; cancellation and timeout terminate CPU work too. */
export class PdfInputProcessor {
	private readonly jobs = new Map<string, { worker: Worker; cancel(): void }>();
	private readonly timeoutMs: number;
	constructor(timeoutMs = 20_000) { this.timeoutMs = timeoutMs; }
	async process(request: UiPdfInputRequest): Promise<UiPdfInputResult> {
		if (!request || !/^[a-zA-Z0-9_-]{8,128}$/.test(request.requestId) || typeof request.name !== 'string' || !request.name.toLowerCase().endsWith('.pdf') || request.name.length > 200 || typeof request.data !== 'string' || request.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.data)) throw new Error('PDF输入参数无效或文件过大');
		if (this.jobs.has(request.requestId) || this.jobs.size >= 2) throw new Error('PDF正在处理，请等待或取消当前任务');
		const data = Buffer.from(request.data, 'base64');
		if (data.length > 20 * 1024 * 1024 || !data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF无效或超过20 MiB限制');
		const resolvedModule = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
		const module = pathToFileURL(resolvedModule.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')).href;
		return new Promise((resolve, reject) => {
			const worker = new Worker(WORKER, { eval: true, workerData: { module, data }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
			let finished = false;
			const finish = (error?: Error, result?: UiPdfInputResult) => { if (finished) return; finished = true; clearTimeout(timer); this.jobs.delete(request.requestId); void worker.terminate(); if (error) reject(error); else resolve(result!); };
			const timer = setTimeout(() => finish(new Error(`PDF处理超过${Math.ceil(this.timeoutMs / 1000)}秒，已取消；请拆分文档后重试`)), this.timeoutMs);
			this.jobs.set(request.requestId, { worker, cancel: () => finish(new Error('PDF处理已取消，原草稿已保留')) });
			worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error)))); worker.once('exit', (code) => { if (!finished) finish(new Error(`PDF解析进程退出 (${code})`)); });
			worker.once('message', (result: { ok: boolean; error?: string; text: string; pageCount: number; scannedPages: number[]; truncated: boolean }) => {
				if (!result.ok) { finish(new Error(`PDF无法读取：${result.error}`)); return; }
				const note = [result.truncated ? '[Text truncated at 200,000 characters.]' : '', result.scannedPages.length ? `[Pages without extractable text: ${result.scannedPages.join(', ')}. OCR is not available.]` : ''].filter(Boolean).join('\n');
				finish(undefined, { attachment: { kind: 'text', name: request.name, mimeType: 'text/x-pi-pdf-extract', text: `PDF: ${JSON.stringify(request.name)}\nPages: ${result.pageCount}\n${note}\n\n${result.text}` }, pageCount: result.pageCount, scannedPages: result.scannedPages, truncated: result.truncated });
			});
		});
	}
	cancel(requestId: string): void { this.jobs.get(requestId)?.cancel(); }
	dispose(): void { for (const job of this.jobs.values()) job.cancel(); }
}
