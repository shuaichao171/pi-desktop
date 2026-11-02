import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../packages/ui/package.json', import.meta.url));
const { zipSync, strToU8 } = require('fflate');
const archive = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])))).toString('base64');
const docx = archive({ 'word/document.xml': '<w:document xmlns:w="word"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>产品验收报告</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>工作区记忆与文档预览已完成。</w:t></w:r></w:p><w:p><w:r><w:t>切换项目后恢复打开的文件、目录、Git 差异和所选来源。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>功能</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>后台高亮</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>通过</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
const xlsx = archive({
  'xl/workbook.xml': '<workbook><sheets><sheet name="功能验收" r:id="r1"/><sheet name="延迟测量" r:id="r2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>检查项目</t></is></c><c r="B1" t="inlineStr"><is><t>状态</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>工作区记忆</t></is></c><c r="B2" t="inlineStr"><is><t>通过</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>打开耗时（ms）</t></is></c><c r="B1"><v>12</v></c></row></sheetData></worksheet>',
});

export default async function borrowedWorkbench(review) {
  await review.reducedMotion(true); await review.waitFor('window.__modelReview?.ready===true'); await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = { pending: null, reads: [] };
    const mock = (name, run) => { window.piDesktop[name] = async (...args) => { fixture.calls.push({name,args:structuredClone(args)}); return run(...args); }; };
    state.switchTo = name => { const cwd = 'C:/renderer-review/' + name; Object.assign(fixture.snapshot, {cwd,sessionId:name,sessionPath:cwd+'/session.jsonl',status:'idle',error:null,messages:[],activities:[]}); fixture.emitAgent({type:'reset',cwd});fixture.emitAgent({type:'ready',...structuredClone(fixture.snapshot)});fixture.emitAgent({type:'status',status:'idle'}); };
    mock('listWorkspaceEntries', path => path === 'src' ? [{path:'src/app.ts',name:'app.ts',kind:'file',size:90}] : [{path:'src',name:'src',kind:'directory'},{path:'report.docx',name:'report.docx',kind:'file',size:800},{path:'report.xlsx',name:'report.xlsx',kind:'file',size:800}]);
    mock('readWorkspaceFile', path => { const workspace=fixture.snapshot.cwd; state.reads.push({workspace,path}); if(state.delay) { state.delay=false;return new Promise(resolve=>state.pending=resolve); } return '/* multiline comment\\n   comment continued */\\nconst workspace = '+JSON.stringify(workspace)+';\\nconst count = 12;'; });
    mock('getWorkspaceGitStatus',()=>({isRepository:true,branch:'main',entries:[{path:'src/app.ts',status:'MM'}]}));mock('getWorkspaceGitLog',()=>[]);
    mock('getWorkspaceGitDiff', (path,source) => '--- a/'+path+'\\n+++ b/'+path+'\\n@@ -1,2 +1,2 @@\\n const same = 1;\\n-const color = "dark";\\n+const color = "bright '+source+'";');
    mock('previewResultFile', target => ({kind:'office',path:target.path,name:target.path,size:800,officeFormat:target.path.endsWith('docx')?'docx':'xlsx',bytesBase64:target.path.endsWith('docx')?${JSON.stringify(docx)}:${JSON.stringify(xlsx)}}));
    window.__borrowedWorkbench=state; state.switchTo('project-a');
  })()`);
  await review.click('.pd-top-bar-workspace-button'); await review.waitFor('Boolean(document.querySelector("[data-file-path=src]"))');
  await review.click('[data-file-path=src]'); await review.waitFor('Boolean(document.querySelector("[data-file-path=\\\"src/app.ts\\\"]"))');
  await review.click('[data-file-path="src/app.ts"]');
  await review.waitFor('document.querySelectorAll(".pd-workbench-reader .hljs-comment").length === 2');
  await review.assert('document.querySelector(".pd-workbench-reader").textContent.includes("project-a")', 'Background syntax worker preserves multiline tokens and displays project A');
  await review.evaluate('window.__borrowedWorkbench.switchTo("project-b")');
  await review.waitFor('Boolean(document.querySelector("[data-file-path=src]"))');
  await review.assert('!document.querySelector(".pd-workbench-preview")', 'Unvisited workspace starts with its own empty preview');
  await review.click('[data-segment-key=git]'); await review.waitFor('Boolean(document.querySelector("[data-git-source=staged]"))');
  await review.click('[data-git-source=staged]'); await review.waitFor('document.querySelectorAll(".pd-diff-word").length >= 2');
  await review.screenshot('workbench-word-diff');
  await review.evaluate('window.__borrowedWorkbench.switchTo("project-a")');
  await review.waitFor('document.querySelector(".pd-workbench-reader")?.textContent.includes("project-a")');
  await review.assert('document.querySelector("[data-segment-key=files]").getAttribute("aria-current")==="page" && Boolean(document.querySelector("[data-file-path=\\\"src/app.ts\\\"]"))', 'Project A restores its file tab, directory and file');
  await review.evaluate('window.__borrowedWorkbench.delay=true'); await review.click('[data-file-path="src/app.ts"]');
  await review.waitFor('Boolean(window.__borrowedWorkbench.pending)');
  await review.evaluate('window.__borrowedWorkbench.switchTo("project-b")');
  await review.waitFor('document.querySelector(".pd-workbench-reader")?.textContent.includes("bright staged")');
  await review.evaluate('window.__borrowedWorkbench.pending("WRONG STALE PROJECT A")'); await review.settle();
  await review.assert('document.querySelector("[data-segment-key=git]").getAttribute("aria-current")==="page" && !document.querySelector(".pd-workbench").textContent.includes("WRONG STALE")', 'Project B restores staged diff and rejects a late file read from project A');
  await review.click('[data-segment-key=files]'); await review.waitFor('Boolean(document.querySelector("[data-file-path=\\\"report.docx\\\"]"))');
  await review.click('[data-file-path="report.docx"]'); await review.waitFor('document.querySelector(".pd-office-document")?.textContent.includes("产品验收报告")');
  await review.click('.pd-workbench-preview-expand'); await review.screenshot('workbench-docx-preview');
  await review.click('.pd-workbench-preview-expand'); await review.click('[data-file-path="report.xlsx"]'); await review.waitFor('document.querySelector(".pd-office-sheet")?.textContent.includes("工作区记忆")');
  await review.evaluate('(()=>{const select=document.querySelector(".pd-office-preview select");select.value="1";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await review.waitFor('document.querySelector(".pd-office-sheet")?.textContent.includes("打开耗时")');
  await review.click('.pd-workbench-preview-expand'); await review.screenshot('workbench-xlsx-preview');
  await review.assert('!document.querySelector(".pd-office-preview input, .pd-office-preview [contenteditable=true]") && document.documentElement.scrollWidth <= innerWidth', 'Office preview is read-only and stays inside the window');
}

if (process.argv.includes('--check')) {
  let count = 0; const compile = expression => { new Function(expression); count++; };
  await borrowedWorkbench({ evaluate: async x => compile(x), waitFor: async x => compile(x), assert: async x => compile(x), click: async () => {}, settle: async () => {}, screenshot: async () => {}, viewport: async () => {}, reducedMotion: async () => {} });
  console.log(`Prepared ${count} workbench borrowing expressions; no browser launched.`);
}
