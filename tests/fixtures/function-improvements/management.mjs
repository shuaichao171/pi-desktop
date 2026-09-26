export default async function managementFeatures(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.evaluate(`(() => {
    const state=window.__modelReview, bridge=window.piDesktop;
    const define=(name,fn)=>bridge[name]=async(...args)=>{state.calls.push({name,args:structuredClone(args)});if(state.failures[name])throw Error(state.failures[name]);return fn(...args);};
    define('testProviderModel',request=>({...request,ok:true,elapsedMs:143,error:null}));define('cancelProviderModelTest',()=>{});
    define('listSessionTrash',()=>({entries:[],retentionDays:30}));
    define('getProjectSearchRules',()=>({ignoredDirectories:['node_modules','.git'],include:[],exclude:[],maxFileBytes:1048576}));
    define('getUsageReport',query=>({rows:[{date:query.to,cwd:state.snapshot.cwd,provider:'openai',model:'gpt-review',source:'interactive',messages:4,input:6400,output:2100,cacheRead:2000,cacheWrite:0,cost:0.015,unknownPriceMessages:0,priceSource:'session-message-estimate'},{date:query.to,cwd:state.snapshot.cwd,provider:'local',model:'unpriced',source:'automation',messages:1,input:400,output:50,cacheRead:0,cacheWrite:0,cost:null,unknownPriceMessages:1,priceSource:'session-message-estimate'}],skipped:[],scanned:4,updated:2}));
    define('getStorageSnapshot',()=>({items:[{category:'sessions',bytes:500000,files:6,cleanable:false},{category:'attachments',bytes:2000000,files:4,cleanable:false},{category:'diagnostics',bytes:512000,files:3,cleanable:true},{category:'corrupt-backups',bytes:4000,files:2,cleanable:true}],skipped:[],limited:false}));
    define('previewStorageCleanup',()=>({id:'cleanup-preview',files:[{path:'C:/review/app/diagnostics/events.1.jsonl',category:'diagnostics',bytes:500}],bytes:500,expiresAt:new Date(Date.now()+600000).toISOString()}));
    define('executeStorageCleanup',id=>({releasedBytes:0,removed:0,failed:[{path:'C:/review/app/diagnostics/events.1.jsonl',reason:'文件已变化，请重新预览'}]}));
    define('cancelManagementOperation',()=>{});
    define('exportDiagnostics',()=>({path:'C:/review/pi-diagnostics.zip',entries:12,skipped:[]}));
  })()`);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button','模型管理');
  await review.clickText('[data-setting=model-test] button','发送测试请求');
  await review.waitFor('document.querySelector("[data-setting=model-test] [role=status]")?.textContent.includes("推理成功")');
  await review.assert('window.__modelReview.calls.filter(c=>c.name==="testProviderModel").length===1','Explicit inference test calls the saved selected model once');
  await review.screenshot('02-model-test');
  await review.clickText('.pd-settings-nav button','数据管理');
  await review.clickText('.pd-management-subnav button','用量统计');
  await review.clickText('[data-setting=usage] button','查询用量');
  await review.waitFor('document.querySelectorAll("[data-setting=usage] tbody tr").length===2');
  await review.assert('document.querySelector("[data-setting=usage]").textContent.includes("未知") && document.querySelector("[data-setting=usage]").textContent.includes("自动化")','Usage separates automation and unknown prices');
  await review.screenshot('03-usage');
  await review.clickText('.pd-management-subnav button','存储空间');
  await review.clickText('[data-setting=storage] button','扫描空间');
  await review.waitFor('document.querySelectorAll("[data-setting=storage] tbody tr").length===4');
  await review.clickText('[data-setting=storage] button','生成清理预览');
  await review.waitFor('Boolean(document.querySelector(".pd-management-plan"))');
  await review.assert('window.__modelReview.calls.filter(c=>c.name==="executeStorageCleanup").length===0','Cleanup preview does not delete');
  await review.screenshot('04-cleanup-preview');
  await review.clickText('[data-setting=storage] button','确认清理以上文件');
  await review.waitFor('document.querySelector("[data-setting=storage] [role=status]")?.textContent.includes("文件已变化")');
  await review.clickText('.pd-management-subnav button','诊断导出');
  await review.clickText('[data-setting=diagnostics] button','选择位置并导出 ZIP');
  await review.waitFor('document.querySelector("[data-setting=diagnostics] [role=status]")?.textContent.includes("pi-diagnostics.zip")');
  await review.screenshot('05-diagnostics');
  for (const width of [900,680]) { await review.viewport(width,900); await review.assert('document.documentElement.scrollWidth<=innerWidth','Management layout does not overflow viewport'); await review.screenshot('06-management-'+width); }
}
