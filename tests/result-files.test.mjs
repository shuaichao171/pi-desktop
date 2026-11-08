import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { ResultFileService, RESULT_FILE_LIMITS } from '../packages/desktop/src/main/resultFileService.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-desktop-result-files-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  let current = cwd;
  t.after(() => {
    const target = realpathSync(root);
    const rel = relative(realpathSync.native(tmpdir()), target);
    assert.ok(rel.startsWith('pi-desktop-result-files-') && !rel.includes(sep) && !isAbsolute(rel));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, cwd, service: new ResultFileService(() => current), switchTo: next => { current = next; } };
}

test('result files resolve relative, absolute external and home paths without invoking a shell', async t => {
  const { root, cwd, service } = fixture(t);
  const inside = join(cwd, '中文 file.txt');
  const outside = join(root, 'output.txt');
  writeFileSync(inside, 'hello');
  writeFileSync(outside, 'outside');
  const opened = [], revealed = [];
  await service.openResultFile({ cwd, path: '中文 file.txt', line: 2, column: 1 }, async path => { opened.push(path); return ''; });
  await service.openResultFile({ cwd, path: outside }, async path => { opened.push(path); return ''; });
  await service.revealResultFile({ cwd, path: '../output.txt' }, path => revealed.push(path));
  assert.deepEqual(opened, [realpathSync.native(inside), realpathSync.native(outside)]);
  assert.deepEqual(revealed, [realpathSync.native(outside)]);
  const homeRelative = `~/${relative(homedir(), inside).replaceAll('\\', '/')}`;
  assert.equal((await service.previewResultFile({ cwd, path: homeRelative })).text, 'hello');
  assert.equal((await service.previewResultFile({ cwd, path: '.' })).kind, 'directory');
  await assert.rejects(service.openResultFile({ cwd, path: inside }, async () => 'No default application'), /No default application/);
  await assert.rejects(service.revealResultFile({ cwd, path: inside }, () => { throw new Error('Unavailable'); }), /Unavailable/);
});

test('opening never launches executables or scripts, while preview and reveal still work', async t => {
  const { cwd, service } = fixture(t);
  const opened = [], revealed = [];
  for (const name of ['setup.js', 'fix.BAT', 'run.cmd', 'tool.ps1', 'app.exe', 'page.hta', 'shortcut.lnk', 'build.sh']) {
    writeFileSync(join(cwd, name), 'echo hi');
    await assert.rejects(service.openResultFile({ cwd, path: name }, async path => { opened.push(path); return ''; }), /可执行文件或脚本/, name);
    await service.revealResultFile({ cwd, path: name }, path => revealed.push(path));
  }
  assert.deepEqual(opened, []);
  assert.equal(revealed.length, 8);
  assert.equal((await service.previewResultFile({ cwd, path: 'setup.js' })).text, 'echo hi');
});

test('relative misses fall back to conversation-mentioned absolute paths', async t => {
  const { root, cwd, service } = fixture(t);
  const elsewhere = join(root, 'elsewhere');
  const nested = join(elsewhere, 'nested');
  mkdirSync(nested, { recursive: true });
  const found = join(elsewhere, 'sheepington_basic.zip');
  const report = join(nested, 'report.txt');
  writeFileSync(found, 'zip');
  writeFileSync(report, 'doc');
  const opened = [], revealed = [];
  // The link text names only the file; the conversation mentioned where it lives.
  await service.openResultFile({ cwd, path: 'sheepington_basic.zip', candidates: [found] }, async path => { opened.push(path); return ''; });
  await service.revealResultFile({ cwd, path: 'report.txt', candidates: [join(nested, 'report.txt'), join(root, 'no-such-dir')] }, path => revealed.push(path));
  assert.deepEqual(opened, [realpathSync.native(found)]);
  assert.deepEqual(revealed, [realpathSync.native(report)]);
  assert.equal((await service.previewResultFile({ cwd, path: 'report.txt', candidates: [join(root, 'mentioned-but-gone', 'report.txt'), join(nested, 'report.txt')] })).text, 'doc');
  // Every mention missing keeps the original error, and a fallback that points
  // at a script is still refused.
  await assert.rejects(service.previewResultFile({ cwd, path: 'missing.txt', candidates: [join(root, 'nope.txt')] }), /ENOENT/);
  const script = join(elsewhere, 'setup.js');
  writeFileSync(script, 'echo hi');
  await assert.rejects(service.openResultFile({ cwd, path: 'setup.js', candidates: [script] }, async () => ''), /可执行文件或脚本/);
});

test('result file requests reject URLs, devices, invalid locations and missing files', async t => {
  const { cwd, service } = fixture(t);
  const requests = [null, [], {}, { cwd: '.', path: 'file.txt' }, { cwd, path: '' }, { cwd, path: 'a\0b' },
    ...['https://example.test/file', 'file:///C:/output.txt', 'javascript:alert(1)', 'C:relative.txt', '\\\\?\\C:\\file.txt', '\\\\.\\NUL', '\\\\server\\share\\file.txt'].map(path => ({ cwd, path })),
    { cwd, path: 'file.txt', line: 0 }, { cwd, path: 'file.txt', column: 1.2 }];
  if (process.platform === 'win32') requests.push(...['NUL', 'CON.txt', 'file.txt:stream', 'dir/LPT1'].map(path => ({ cwd, path })));
  for (const request of requests) await assert.rejects(service.previewResultFile(request), /无效/);
  await assert.rejects(service.previewResultFile({ cwd, path: 'missing.txt' }), /ENOENT/);
});

test('previews preserve UTF-8 and UTF-16 and keep HTML and SVG inert text', async t => {
  const { cwd, service } = fixture(t);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好，世界\n🌍', 'utf16le')]);
  const be = Buffer.from(utf16); be.swap16();
  const files = [
    ['utf8.txt', '你好，世界\n🌍', '你好，世界\n🌍'],
    ['utf16.txt', utf16, '你好，世界\n🌍'], ['utf16be.txt', be, '你好，世界\n🌍'],
    ['drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['empty.txt', '', ''],
  ];
  for (const [path, data, expected] of files) {
    writeFileSync(join(cwd, path), data);
    const preview = await service.previewResultFile({ cwd, path });
    assert.equal(preview.kind, 'text', path);
    assert.equal(preview.text, expected, path);
    assert.equal(preview.truncated, false, path);
    assert.equal(preview.dataUrl, undefined, path);
  }
});

test('html previews are served as sandboxed documents within the text budget', async t => {
  const { cwd, service } = fixture(t);
  const page = '<!doctype html><html><body><h1>报表</h1><script>document.title = "x"</script></body></html>';
  for (const path of ['report.html', 'legacy.htm']) {
    writeFileSync(join(cwd, path), page);
    const preview = await service.previewResultFile({ cwd, path });
    assert.equal(preview.kind, 'html', path);
    assert.equal(preview.text, page, path);
    assert.equal(preview.truncated, false, path);
    assert.equal(preview.dataUrl, undefined, path);
    assert.equal(preview.bytesBase64, undefined, path);
  }
  writeFileSync(join(cwd, 'large.html'), '<p>' + '好'.repeat(Math.ceil(RESULT_FILE_LIMITS.html / 3) + 100) + '</p>');
  const large = await service.previewResultFile({ cwd, path: 'large.html' });
  assert.equal(large.kind, 'html');
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.text) <= RESULT_FILE_LIMITS.html);
  assert.ok(large.text.endsWith('好'));
});

test('image and PDF previews have verified data URLs while documents and unknown binary remain unsupported', async t => {
  const { cwd, service } = fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9ioAAAAASUVORK5CYII=', 'base64');
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  writeFileSync(join(cwd, 'image.png'), png);
  writeFileSync(join(cwd, 'document.pdf'), pdf);
  for (const [path, kind, mime, data] of [['image.png', 'image', 'image/png', png], ['document.pdf', 'pdf', 'application/pdf', pdf]]) {
    const preview = await service.previewResultFile({ cwd, path });
    assert.equal(preview.kind, kind);
    assert.equal(preview.dataUrl, `data:${mime};base64,${data.toString('base64')}`);
  }
  for (const [path, bytes] of [['document.docx', 'PK fake archive'], ['unknown.bin', Buffer.from([0, 1, 2, 3])], ['invalid-utf8.txt', Buffer.from([0xc3, 0x28])]]) {
    writeFileSync(join(cwd, path), bytes);
    const preview = await service.previewResultFile({ cwd, path });
    assert.equal(preview.kind, 'unsupported');
    assert.equal(preview.reason, 'unsupported');
    assert.equal(preview.text, undefined);
    assert.equal(preview.dataUrl, undefined);
  }
});

test('preview reads are bounded and truncated text ends on a complete Unicode character', async t => {
  const { cwd, service } = fixture(t);
  writeFileSync(join(cwd, 'large.txt'), '你'.repeat(Math.ceil(RESULT_FILE_LIMITS.text / 3) + 100));
  const text = await service.previewResultFile({ cwd, path: 'large.txt' });
  assert.equal(text.kind, 'text');
  assert.equal(text.truncated, true);
  assert.ok(Buffer.byteLength(text.text) <= RESULT_FILE_LIMITS.text);
  assert.ok(text.text.endsWith('你'));
  assert.equal(text.text.includes('\ufffd'), false);
  for (const [path, prefix, limit] of [['large.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), RESULT_FILE_LIMITS.image], ['large.pdf', '%PDF-1.4', RESULT_FILE_LIMITS.pdf]]) {
    writeFileSync(join(cwd, path), prefix);
    truncateSync(join(cwd, path), limit + 1);
    const preview = await service.previewResultFile({ cwd, path });
    assert.equal(preview.kind, 'unsupported');
    assert.equal(preview.reason, 'too-large');
    assert.equal(preview.dataUrl, undefined);
  }
});

test('Office files use bounded binary previews only for DOCX and XLSX ZIP signatures', async t => {
  const { cwd, service } = fixture(t);
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  for (const format of ['docx', 'xlsx']) {
    writeFileSync(join(cwd, `document.${format}`), bytes);
    const preview = await service.previewResultFile({ cwd, path: `document.${format}` });
    assert.equal(preview.kind, 'office');
    assert.equal(preview.officeFormat, format);
    assert.equal(preview.bytesBase64, bytes.toString('base64'));
    assert.equal(preview.dataUrl, undefined);
    truncateSync(join(cwd, `document.${format}`), RESULT_FILE_LIMITS.office + 1);
    const large = await service.previewResultFile({ cwd, path: `document.${format}` });
    assert.equal(large.reason, 'too-large');
    assert.equal(large.bytesBase64, undefined);
  }
  writeFileSync(join(cwd, 'legacy.doc'), bytes);
  assert.equal((await service.previewResultFile({ cwd, path: 'legacy.doc' })).kind, 'unsupported');
});

test('stale conversations are rejected before reads and again after async path resolution', async t => {
  const { root, cwd, service, switchTo } = fixture(t);
  writeFileSync(join(cwd, 'file.txt'), 'hello');
  const target = { cwd, path: 'file.txt' };
  const nativeCalls = [];
  const open = service.openResultFile(target, async path => { nativeCalls.push(path); return ''; });
  switchTo(root);
  await assert.rejects(open, /对话已切换/);
  await assert.rejects(service.previewResultFile(target), /对话已切换/);
  switchTo(cwd);
  const reveal = service.revealResultFile(target, path => nativeCalls.push(path));
  switchTo(root);
  await assert.rejects(reveal, /对话已切换/);
  assert.deepEqual(nativeCalls, []);
});
