import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PdfInputProcessor } from '../packages/desktop/src/main/pdfInput.ts';

function pdf(pages) {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const ids = [];
  for (const text of pages) {
    const id = objects.length; ids.push(id);
    const stream = text ? `BT /F1 8 Tf 30 390 Td ${text.match(/.{1,80}/g).map(line => '(' + line + ') Tj 0 -9 Td').join(' ')} ET` : '0.5 g 30 30 80 80 re f';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${ids.map(id => id + ' 0 R').join(' ')}] /Count ${ids.length} >>`;
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (let id = 1; id < objects.length; id++) { offsets.push(Buffer.byteLength(text)); text += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const start = Buffer.byteLength(text); text += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  text += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text).toString('base64');
}
const request = data => ({ requestId: randomUUID(), name: 'source.pdf', data });

test('PDF text extraction preserves page provenance and explicitly identifies scanned pages', async () => {
  const service = new PdfInputProcessor();
  try {
    const result = await service.process(request(pdf(['First page', 'Second page', ''])));
    assert.equal(result.pageCount, 3); assert.deepEqual(result.scannedPages, [3]);
    assert.match(result.attachment.text, /\[Page 1\][\s\S]*First page[\s\S]*\[Page 2\][\s\S]*Second page/);
    assert.match(result.attachment.text, /OCR is not available/); assert.equal(result.attachment.mimeType, 'text/x-pi-pdf-extract');
  } finally { service.dispose(); }
});

test('PDF rejects scan-only, malformed, encrypted and over-page documents without returning an attachment', async () => {
  const service = new PdfInputProcessor();
  try {
    await assert.rejects(service.process(request(pdf(['']))), /扫描|OCR/);
    await assert.rejects(service.process(request(Buffer.from('%PDF-1.4\ncorrupt').toString('base64'))), /PDF无法读取/);
    await assert.rejects(service.process(request(pdf(Array(101).fill('Page')))), /100页/);
    await assert.rejects(service.process(request(readFileSync(new URL('./fixtures/input/encrypted.pdf', import.meta.url)).toString('base64'))), /加密PDF/);
  } finally { service.dispose(); }
});

test('PDF cancellation terminates processing and leaves the request retryable', async () => {
  const service = new PdfInputProcessor(), input = request(pdf(['Retryable text']));
  try {
    const pending = service.process(input); service.cancel(input.requestId);
    await assert.rejects(pending, /已取消/);
    const result = await service.process(input); assert.match(result.attachment.text, /Retryable text/);
  } finally { service.dispose(); }
});

test('PDF timeout terminates its worker and removes the active request', async () => {
  const service = new PdfInputProcessor(1), input = request(pdf(['Local text']));
  try { await assert.rejects(service.process(input), /超过.*已取消/); assert.equal(service.jobs.size, 0); }
  finally { service.dispose(); }
});

test('PDF extraction bounds long text and explicitly records truncation', async () => {
  const service = new PdfInputProcessor();
  try {
    const result = await service.process(request(pdf(Array(100).fill('Long content '.repeat(250)))));
    assert.equal(result.truncated, true); assert.ok(result.attachment.text.length <= 200_000);
    assert.match(result.attachment.text, /Text truncated/); assert.match(result.attachment.text, /\[Page 1\]/);
  } finally { service.dispose(); }
});
