// Prepare only: node tests/fixtures/model-settings/run.mjs --check
// Run after the renderer build: node tests/fixtures/model-settings/run.mjs --run --scenario=../ui-improvements/plugin-recommendations.mjs
// Plugins page "Recommended" tab: curated cards, installed state matched by npm name (version-insensitive), install entry prefilled.
export default async function pluginRecommendationScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => {
    const fixture=window.__modelReview,bridge=window.piDesktop,clone=value=>structuredClone(value),cwd=fixture.snapshot.cwd;
    const pkg=(source,name,version)=>({source,scope:'user',name,description:'',version,installed:true,path:'C:/renderer-review/plugins/'+name});
    const catalog={cwd,projectTrusted:true,warnings:[],resources:[],packages:[pkg('npm:pi-subagents@0.70.0','pi-subagents','0.70.0'),pkg('npm:pi-mcp-adapter','pi-mcp-adapter','5.0.0'),pkg('npm:@ff-labs/pi-fff','@ff-labs/pi-fff','0.11.0')]};
    bridge.getPluginCatalog=async()=>clone(catalog);
  })()`);
  await review.click('.pd-activity-plugins');
  await review.clickText('.pd-plugins-tabs button', '推荐');
  await review.waitFor('document.querySelectorAll(".pd-plugin-recommended-card").length === 9');
  await review.waitFor('document.querySelectorAll(".pd-plugin-recommended-card .pd-plugin-status.is-enabled").length === 3');
  await review.assert('[...document.querySelectorAll(".pd-plugins-tabs button")].map(b=>b.textContent).join("|") === "已安装|推荐|发现"', 'Recommended sits between Installed and Discover');
  await review.screenshot('plugin-recommendations');
  await review.fill('.pd-plugins-search input', 'memory');
  await review.waitFor('document.querySelectorAll(".pd-plugin-recommended-card").length === 1');
  await review.clickText('.pd-plugin-recommended-card button', '安装');
  await review.waitFor('document.querySelector("dialog[open] .pd-plugin-install-form input")?.value === "npm:pi-observational-memory"');
  await review.screenshot('plugin-recommendation-install');
  await review.clickText('dialog[open] footer button', '取消');
  await review.fill('.pd-plugins-search input', '');
  await review.clickText('.pd-plugin-recommended-card button', '查看详情');
  await review.waitFor('document.querySelector(".pd-plugin-detail-title h1")?.textContent === "pi-subagents"');
  await review.viewport(560, 900);
  await review.clickText('.pd-plugin-back', '返回插件');
  await review.clickText('.pd-plugins-tabs button', '推荐');
  await review.waitFor('document.querySelectorAll(".pd-plugin-recommended-card").length === 9');
  await review.screenshot('plugin-recommendations-narrow');
}
