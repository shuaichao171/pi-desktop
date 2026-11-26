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
    const state=window.__pluginRecState={refreshCalls:0,holdRefresh:false,resolveRefresh:null,revealed:[],discoverQueries:[]};
    bridge.getPluginCatalog=async()=>{
      state.refreshCalls++;
      if(state.holdRefresh) return new Promise(resolve=>{ state.resolveRefresh=()=>resolve(clone(catalog)); });
      return clone(catalog);
    };
    bridge.revealPluginPath=async req=>{ state.revealed.push(clone(req)); };
    bridge.discoverPlugins=async query=>{
      state.discoverQueries.push(query);
      return {
        total: 42,
        items: [
          { name: 'pi-subagents', description: 'Subagents workflow', version: '0.75.0', source: 'npm:pi-subagents@0.75.0', author: 'Nico Bailon' },
          { name: 'pi-extra-tool', description: 'Uninstalled community tool', version: '1.2.0', source: 'npm:pi-extra-tool@1.2.0', author: 'someone' },
        ],
      };
    };
  })()`);
  await review.click('.pd-activity-plugins');
  await review.waitFor('document.querySelectorAll(".pd-plugin-card-main").length === 3');
  // Filtered empty state resets filters instead of navigating away to Discover.
  await review.fill('.pd-plugins-search input', 'no-such-plugin-xyz');
  await review.waitFor('document.querySelector(".pd-plugin-empty button")?.textContent === "清除筛选条件"');
  await review.clickText('.pd-plugin-empty button', '清除筛选条件');
  await review.waitFor('document.querySelectorAll(".pd-plugin-card-main").length === 3 && document.querySelector(".pd-plugins-search input").value === ""');
  // Manual refresh gives immediate refreshing feedback even when the catalog is already cached.
  await review.evaluate('window.__pluginRecState.holdRefresh = true');
  await review.click('.pd-plugins-intro-actions button[aria-label="刷新列表"]');
  await review.waitFor('document.querySelector(".pd-plugins-intro-actions button.is-refreshing")?.disabled === true && document.querySelector(".pd-plugins-intro-actions button.is-refreshing")?.getAttribute("aria-busy") === "true"');
  await review.evaluate('window.__pluginRecState.holdRefresh = false; window.__pluginRecState.resolveRefresh?.()');
  await review.waitFor('!document.querySelector(".pd-plugins-intro-actions button.is-refreshing")');
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
  await review.assert('document.querySelector(".pd-plugin-detail-actions a")?.getAttribute("href") === "https://www.npmjs.com/package/pi-subagents"', 'Detail view offers a safe external npm page link');
  await review.clickText('.pd-plugin-info-path button', '在文件夹中显示');
  await review.waitFor('window.__pluginRecState.revealed.length === 1 && window.__pluginRecState.revealed[0].path === "C:/renderer-review/plugins/pi-subagents"');
  // Switching back to Chat and returning to Plugins preserves the open detail view.
  await review.click('.pd-activity-plugins');
  await review.waitFor('document.querySelector(".pd-chat-view-host")?.getAttribute("hidden") === null');
  await review.click('.pd-activity-plugins');
  await review.waitFor('document.querySelector(".pd-plugin-detail-title h1")?.textContent === "pi-subagents"');
  await review.viewport(560, 900);
  await review.clickText('.pd-plugin-back', '返回插件');
  await review.clickText('.pd-plugins-tabs button', '推荐');
  await review.waitFor('document.querySelectorAll(".pd-plugin-recommended-card").length === 9');
  await review.screenshot('plugin-recommendations-narrow');
  // Searching an unmatched term in Recommended offers a one-click jump to Discover keeping the query.
  await review.viewport(1440, 1000);
  await review.fill('.pd-plugins-search input', 'extra-tool');
  await review.waitFor('document.querySelector(".pd-plugin-empty button")?.textContent.includes("在「发现」中搜索")');
  await review.click('.pd-plugin-empty button');
  await review.waitFor('document.querySelectorAll(".pd-plugin-discovery-card").length === 2');
  await review.assert('document.querySelector(".pd-plugins-search input")?.value === "extra-tool" && window.__pluginRecState.discoverQueries.at(-1) === "extra-tool" && document.querySelector(".pd-plugin-section-heading span")?.textContent.includes("2 / 42") && document.querySelectorAll(".pd-plugin-discovery-card .pd-plugin-status.is-enabled").length === 1 && document.querySelector(".pd-plugin-discovery-card button")?.textContent.includes("查看详情") && document.querySelector(".pd-plugin-discovery-card a.pd-plugin-external-link")?.getAttribute("href") === "https://www.npmjs.com/package/pi-subagents"', 'Discover tab preserves the search query, shows total count, installed state with View details, and safe npm link');
}
