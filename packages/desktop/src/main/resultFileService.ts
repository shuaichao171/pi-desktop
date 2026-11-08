import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import type { ResultFilePreview, ResultFileTarget } from '@pidesktop/shared';

export const RESULT_FILE_LIMITS = { text: 1024 * 1024, html: 1024 * 1024, image: 16 * 1024 * 1024, pdf: 20 * 1024 * 1024, office: 10 * 1024 * 1024 } as const;

function localPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32_768 || /[\u0000-\u001f]/.test(value)) return false;
  // Reject URLs, network shares, Win32/NT device namespaces and drive-relative paths.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return false;
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(value)) return false;
  if (process.platform === 'win32') {
    if (value.replace(/^[a-z]:/i, '').includes(':')) return false;
    if (value.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(part))) return false;
  }
  return true;
}

/**
 * File types the OS would execute instead of display when "opened". Links come
 * from model output, so launching them must never run code on a single click.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.scr', '.pif', '.cpl', '.msi', '.msp', '.msc', '.appx', '.msix', '.application', '.appref-ms', '.gadget',
  '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.ps1xml', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ws', '.hta', '.sct',
  '.lnk', '.url', '.scf', '.reg', '.inf', '.chm', '.jar', '.jnlp', '.settingcontent-ms',
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.command', '.tool', '.app', '.pkg', '.dmg', '.appimage', '.desktop', '.run', '.bin',
]);

export function isExecutableResultFile(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

function sameDirectory(first: string, second: string): boolean {
  const a = resolve(first), b = resolve(second);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validateTarget(value: unknown): ResultFileTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件请求无效');
  const target = value as ResultFileTarget;
  if (!localPath(target.cwd) || !isAbsolute(target.cwd)) throw new Error('对话文件夹无效');
  if (!localPath(target.path)) throw new Error('文件路径无效');
  for (const position of [target.line, target.column]) {
    if (position !== undefined && (!Number.isSafeInteger(position) || position < 1)) throw new Error('文件位置无效');
  }
  // Fallback mentions are hints, not authority: malformed entries are dropped,
  // and each survivor is still localPath- and realpath-checked before use.
  const candidates = Array.isArray(target.candidates)
    ? target.candidates.filter((candidate): candidate is string => localPath(candidate) && isAbsolute(candidate)).slice(0, 8)
    : undefined;
  return { cwd: target.cwd, path: target.path, line: target.line, column: target.column, ...(candidates?.length ? { candidates } : {}) };
}

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif';
  return undefined;
}

function decodeText(bytes: Buffer, truncated: boolean): string | null {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  try {
    // Streaming decode drops only an incomplete final character at the preview boundary.
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) return null;
    return text;
  } catch { return null; }
}

export class ResultFileService {
  private readonly getWorkspace: () => string;

  constructor(getWorkspace: () => string) { this.getWorkspace = getWorkspace; }

  private assertCurrent(cwd: string): void {
    const current = this.getWorkspace();
    if (!current || !sameDirectory(current, cwd)) throw new Error('对话已切换，请重新打开文件');
  }

  private async resolveTarget(request: unknown): Promise<{ cwd: string; path: string }> {
    const target = validateTarget(request);
    this.assertCurrent(target.cwd);
    const directory = await realpath(target.cwd);
    if (!(await stat(directory)).isDirectory()) throw new Error('对话文件夹无效');
    const expanded = target.path === '~' ? homedir() : /^~[\\/]/.test(target.path) ? resolve(homedir(), target.path.slice(2)) : target.path;
    // A model that searched another directory often names just the file, so the
    // relative join misses; retry the absolute paths the conversation mentioned
    // (newest first) before surfacing the original error.
    let resolved: string;
    try {
      resolved = await realpath(resolve(directory, expanded));
    } catch (primaryError) {
      resolved = '';
      for (const candidate of target.candidates ?? []) {
        try { resolved = await realpath(candidate); break; } catch { /* try the next mention */ }
      }
      if (!resolved) throw primaryError;
    }
    const path = resolved;
    if (!localPath(path)) throw new Error('文件路径无效');
    const info = await stat(path);
    if (!info.isFile() && !info.isDirectory()) throw new Error('此路径不是普通文件或文件夹');
    this.assertCurrent(target.cwd);
    return { cwd: target.cwd, path };
  }

  async openResultFile(request: unknown, openPath: (path: string) => Promise<string>): Promise<void> {
    const requested = validateTarget(request).path;
    const target = await this.resolveTarget(request);
    // Check both the link text and the resolved file: a symlink must not hide a script.
    if (isExecutableResultFile(requested) || isExecutableResultFile(target.path)) {
      throw new Error('出于安全考虑，不会直接运行可执行文件或脚本。请使用“打开所在位置”后自行确认。');
    }
    this.assertCurrent(target.cwd);
    const error = await openPath(target.path);
    if (error) throw new Error(error);
  }

  async revealResultFile(request: unknown, showItemInFolder: (path: string) => void): Promise<void> {
    const target = await this.resolveTarget(request);
    this.assertCurrent(target.cwd);
    showItemInFolder(target.path);
  }

  async previewResultFile(request: unknown): Promise<ResultFilePreview> {
    const target = await this.resolveTarget(request);
    const info = await stat(target.path);
    this.assertCurrent(target.cwd);
    const base = { path: target.path, name: basename(target.path), size: info.size };
    if (info.isDirectory()) return { ...base, kind: 'directory' };
    if (!info.isFile()) throw new Error('此路径不是普通文件');
    const handle = await open(target.path, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error('此路径不是普通文件');
      base.size = opened.size;
      // Identify binary formats from a small prefix before selecting a bounded read.
      const prefix = Buffer.alloc(512);
      const { bytesRead: prefixLength } = await handle.read(prefix, 0, prefix.length, 0);
      const head = prefix.subarray(0, prefixLength);
      const mime = imageMime(head);
      const pdf = head.toString('ascii', 0, 5) === '%PDF-';
      const extension = extname(target.path).toLowerCase();
      const officeFormat = extension === '.docx' ? 'docx' : extension === '.xlsx' ? 'xlsx' : extension === '.pptx' ? 'pptx' : undefined;
      const office = officeFormat && head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const html = extension === '.html' || extension === '.htm';
      const kind = mime ? 'image' : pdf ? 'pdf' : office ? 'office' : html ? 'html' : 'text';
      const limit = RESULT_FILE_LIMITS[kind];
      this.assertCurrent(target.cwd);
      if (kind !== 'text' && kind !== 'html' && opened.size > limit) return { ...base, kind: 'unsupported', reason: 'too-large' };
      // Office archives and executables are never misrepresented as a text preview.
      if (kind === 'text' && /\.(?:docx?|xlsx?|pptx?|od[tpfs]|zip|7z|rar|exe|dll|wasm|mp[34]|mov|avi|wav|flac|ttf|woff2?)$/i.test(extension)) {
        return { ...base, kind: 'unsupported', reason: 'unsupported' };
      }
      const bytes = Buffer.alloc(Math.min(opened.size, limit) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      this.assertCurrent(target.cwd);
      const truncated = offset > limit || opened.size > limit;
      const content = bytes.subarray(0, Math.min(offset, limit));
      // HTML previews render inside a sandboxed iframe and share the text budget.
      if (kind === 'html') {
        const html = decodeText(content, truncated);
        return html === null
          ? { ...base, kind: 'unsupported', reason: 'unsupported' }
          : { ...base, kind: 'html', text: html, truncated };
      }
      if (kind !== 'text') {
        if (truncated) return { ...base, kind: 'unsupported', reason: 'too-large' };
        if (kind === 'office') return { ...base, kind, officeFormat, bytesBase64: content.toString('base64') };
        return { ...base, kind, dataUrl: `data:${mime ?? 'application/pdf'};base64,${content.toString('base64')}` };
      }
      const text = decodeText(content, truncated);
      return text === null
        ? { ...base, kind: 'unsupported', reason: 'unsupported' }
        : { ...base, kind: 'text', text, truncated };
    } finally {
      await handle.close();
      this.assertCurrent(target.cwd);
    }
  }
}
