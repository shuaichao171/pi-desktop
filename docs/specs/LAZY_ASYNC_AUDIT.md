# 懒加载 / 异步化全局排查

2026-11-02。对应 TODO「全局排查：把所有能懒加载 / 异步化的地方都处理掉」。本文件是清单与优先级；每项落地时在此勾选并记录度量。

## 度量基线与当前值

| 指标 | 来源 | 基线（2026-11-02） | 当前（2026-11-06） |
|---|---|---|---|
| 启动主包 JS | `pnpm build` 后 `packages/desktop/out/renderer/assets/index-*.js` | 3,584,131 B | **2,240,547 B（累计 −37.5%）** |
| 启动主包 CSS | 同上 `index-*.css` | 522,370 B | **338,788 B（累计 −35.1%）** |
| 会话切换 / 首屏绘制 | `sessionOpenMetrics`（`begin → rpc → snapshot → rendered → painted`，经 `recordUiDiagnostic` 写入诊断日志） | 以本机诊断导出为准 | 不变 |
| 冷启动 | `startupMetrics`（`main-start → … → first-frame`，diagnostics 结构化 + `PI_STARTUP_LOG=1` 单行） | 原无统一打点 | 打点已落地，以本机诊断导出为准 |

2026-11-06 批次拆出的按需 chunk：`WorkbenchSidePane` 529,815 B（含 xterm/Git 图/文件树/查找面板）、`codeHighlight.worker` 378,162 B（自含 hljs）、`diff.worker` 约 3 KB；渲染侧 hljs 懒加载副本（`common-*.js`）349 KB 与 worker 副本不同时加载。

## 已落地

- [x] **P0 会话切换 / 新建不阻塞输入**（2026-11-02）
  - 切换与启动期间输入框保持可编辑（`Composer.tsx` 的 `inputLocked` 仅在尚无任何工作区作用域时锁定）；草稿按乐观选中的目标会话作用域保存，发送按钮在会话就绪前保持禁用并以 title 提示「正在连接 Pi…」。
  - 新建对话准备期间可切换模型 / 思考等级：`store.ts` 把选择暂存在 `SessionPreparation.deferred` 并立即显示，在草稿上线、首条消息发送之前应用到运行时；失败只写入 `settingsError`，不使新建失败。回归：`tests/new-conversation.test.mjs`。
  - 切换时的渐进绘制沿用既有 keep-over（保留旧会话）+ 磁盘 peek（`paintSessionPeek`）+ keep-warm 缓存；整屏占位只在没有任何可保留内容时出现。
- [x] **P0 对话进行中安装插件**（2026-11-02）：安装与资源启停只下载 / 写配置，不再要求全部会话空闲；重载推迟到所有会话空闲的边界自动执行（`AgentService.flushPluginReload`，空闲状态事件触发并以 1.5 s 轮询兜底），完成后推送 `plugins-reloaded` 事件并提示。后台安装不占用主进程工作区激活队列，因此不阻止新建对话 / 切项目；更新、移除、手动重载仍需空闲。回归：`tests/plugins-lifecycle.test.mjs`、`tests/plugins-ipc.test.mjs`。
- [x] **P1 渲染层按需 chunk（第一批）**（2026-11-02）：设置面板、搜索弹窗、自动化页、插件页、提交弹窗改为 `React.lazy`（`components/lazySurfaces.tsx`），首帧后在空闲时预取，首次打开不等待网络（本地文件）。
  - 度量：主包 JS 3,584,131 B → 3,152,240 B（−12%），主包 CSS 522,370 B → 363,186 B（−30%）；拆出的 chunk：SettingsPanel 298 KB + 106 KB CSS、PluginsPage 53 KB、AutomationPage 44 KB、SearchDialog 36 KB、ChatCommitDialog 12 KB。
- [x] **P1 代码高亮移出主包**（2026-11-02）：`CodeBlock.tsx` 改用 `codeHighlighter.ts` 按需加载 highlight.js，未加载时渲染转义后的纯文本（语言标签沿用声明值），加载后常驻、后续渲染同步高亮不闪烁；空闲预取与其他懒面板一起触发。高亮只替换 span，不改变行高，不引起转录重排。回归：`tests/tool-renderers.test.mjs`（加载前纯文本 / 加载后高亮）。
  - 度量：主包 JS 3,152,240 B → 2,754,742 B（再 −397 KB；相对基线累计 −23%），highlight.js 独立 chunk 349 KB。
- [x] **P1 主进程热路径同步 IO（第一批）**（2026-11-02）：`workspaceDefault`（移除项目关联）、`sessionOpenWindow` 的 `statSync`/`mkdirSync` 与工作台 `reset()` 的 `rmSync` 改为异步；`reset()` 先摘下临时 hooks 路径再删除，避免删除期间的 git 调用复用正在删除的目录。
- [x] **P1 工作台首开才挂载 + 子视图随拆分**（2026-11-06，wb-lazy 车道）：`AppShell.tsx` 用 `React.lazy` + `workbenchMounted` 状态实现首次打开才挂载（`workbenchMounted` 只置 true 从不复位，关闭仅隐藏不卸载）；未挂载时 `openRequest` / `terminalRequest` 先挂载再由首挂载 effect 处理（ref 防重放）。Git 图、查找面板、终端随 `WorkbenchSidePane` 一起拆为按需 chunk。
  - 度量：主包 JS 2,754,742 B → 2,240,547 B（再 −18.7%）；`WorkbenchSidePane` chunk 529,815 B（另拆 CSS）。回归：`tests/workbench-lazy-mount.test.mjs`。
- [x] **P1 长代码块高亮下沉 worker**（2026-11-06，heavy-worker 车道）：新增 `workerTaskPool`（并发 ≤2、空闲 5 s 销毁、超时 terminate + 主线程回退、队列上限 32 溢出回退）；`codeHighlightWorker` 对非流式、2000–20000 行的代码块走 worker（与主线程同用 `highlight.js/lib/common`，标记集合一致），>20000 行渲染纯文本；流式消息不走 worker（每次增量都会变）。阈值经微基准校准（hljs 2000 行 ≈ 110 ms 同步）。回归：`tests/diff-worker-pool.test.mjs`、`tests/code-highlight-worker.test.mjs`、`tests/heavy-worker-ui.test.mjs`、`tests/changes-find.test.mjs`、`tests/unified-diff.test.mjs`、`tests/tool-renderers.test.mjs`。
- [x] **P1 `readCurrentDesktopSettings` 缓存化 + `writeStateFile` 运行期异步化**（2026-11-06，state-io 车道）：`desktopSettings.ts` 按路径进程内缓存（损坏仍备份 + 恢复框），写后换入缓存保证写后读一致；`writeStateFileAsync` 同目标按调用序串行 + Windows EPERM/EACCES 有界重试（5 次 × 10 ms）；`windowState` 运行期 500 ms 防抖异步、close 保留同步写；`saveCloseChoice` / `desktopSettingsSet` / `appearanceSet` / `appSetLocale` 四处理器改异步写。2026-11-06 复审后追加：`desktopSettings.ts` 新增 `withDesktopSettings` 共享队列，`debugApiIpc.applyConfig` 的读-改-写与 `defaultWorkspaceAsync` 的注册写入分别并入桌面设置 / 工作区设置队列，交错写不再互相回滚；二轮复审再把 `applyConfig` 的 server stop/create 一并收进队列，消除并发 setConfig 的遗留监听窗口。回归：`tests/desktop-settings.test.mjs`、`tests/state-files.test.mjs`、`tests/desktop-settings-queue.test.mjs`。
- [x] **P2 会话列表分页 / 增量**（2026-11-06，ipc-data 车道）：新增 `agentListSessionsPage` 通道与 `UiSessionListPage` 类型；主进程按工作区快照缓存（`sessions-changed` / 重命名 / 删除 / fork / 自动化完成失效，失效带代次计数——在途重列期间到达的失效不会被吞掉），元数据（置顶 / 未读 / 顺序）serve 时实时合并不触发重列；UI store 首页 100 条先渲染、续页 500 条后台补齐，请求代次 + 快照 revision 双层迟到丢弃，旧桥回退全量。回归：`tests/ipc-session-list-cache.test.mjs`、`tests/session-list-paging.test.mjs`。
- [x] **P2 插件目录缓存**（2026-11-06，ipc-data 车道）：`pluginCatalogCache.ts` LRU（16 条）缓存上次结果先渲染，插件变更 revision 触发重取。回归：`tests/plugins-ipc.test.mjs`。
- [x] **P2 diff 与全文变更搜索下沉 worker**（2026-11-06，heavy-worker 车道）：`diff.worker` 承接 unified / pi-edit diff 解析（>200k 字符主线程；微基准 15 万字符 ≈1.5 ms）；`useChangesFind` 全文变更搜索 >400k 总字符走 worker，等待期返回路径匹配过渡态；`useDiffParse` / `useChangesFind` 身份校验丢弃迟到结果。wordDiff 仍在渲染线程（词级 diff 粒度小）。回归：`tests/diff-worker-pool.test.mjs`。
- [x] **P2 冷启动打点 + 启动并行化**（2026-11-06，startup 车道）：`startupMetrics.ts` 冷启动时间线（`main-start → app-ready → splash-created → splash-shown → ipc-ready → window-created ∥ workspace-ready → renderer-loaded → ready-to-show → renderer-ready → first-frame`），diagnostics 每阶段一条结构化事件 + `PI_STARTUP_LOG=1` / dev 单行输出（打包默认静默）；`bootstrap()` 重构为「主窗创建 + 渲染层加载 ∥ 异步工作区解析」双并行分支，agent 初始化在工作区就绪后启动，更新检查移到主窗创建后；`defaultWorkspaceAsync` 取代启动路径同步 IO（行为与同步版逐条对齐，注册写入并入工作区设置队列）；防御性 stat/mkdir 改异步（盘符根不 mkdir 语义保留）。复审后追加：工作区分支取消短路、`showStartupError` 重入保护、冷启动 pai 请求失败隔离。回归：`tests/startup*.test.mjs`（45 项）、`tests/agent-ipc.test.mjs`。
- [x] **P2 启动窗口配色统一（部分）**（2026-11-06，startup 车道）：`windowTheme.ts` 单一背景色源（默认对齐渲染层 surface：dark `#161616` / light `#f8f8f8`，用户外观取 `colors[mode].surface` 带 hex 校验回退），主窗 / splash / pai 窗三处硬编码 `#111216` 全部消除；splash 深浅双主题渲染，boot 页与错误页同背景切换不闪；`startupSwap.ts` 主窗 `show` 确认后才关 boot 窗（250 ms 兜底），杜绝两窗皆不可见空帧。对应 TODO「启动窗口与主窗无缝衔接」的 boot→主窗段；便携版位图段见遗留。

## 待办清单（按优先级）

### P2 IPC 与数据

- [ ] 目录扫描、Git 状态：大仓库首包先返回首屏所需层级，其余流式补齐（现状 `workbenchService.ts` 单发截断 `MAX_ENTRIES=400`，有界但无增量）。
- [ ] 模型 / 供应商目录：缓存上次结果先渲染，后台刷新（插件目录半句已落地，见上）。
- 已有范例：历史分页 `getHistoryPage`、会话 peek、搜索分页 `searchSessionsPage`、会话列表分页 `agentListSessionsPage`。

### P2 重活移出主线程

- [ ] 大文件预览的文本部分下沉 worker（Office 预览已有 `officePreview.worker`；`WorkbenchTextView` 文本预览仍在渲染线程）。
- 渲染线程剩余阻塞点（审计即如此设计，按诊断再决定）：≤2000 行块的同步 hljs、wordDiff、文本大预览。

### P2 启动路径（剩余）

- [ ] 便携版「原生位图 → boot 窗」段跳变：224×224 透明图标页与全尺寸 boot 页的画面衔接（`scripts/make-portable-splash.mjs` 边界）。
- [ ] 启动期各状态文件首读（desktopSettings / workspaceSettings / appearance / windowState 各一次）与 `desktopLaunch.ts` / `piEngine.ts` 的启动参数解析仍有同步 IO（冷启动一次，`startupMetrics` 已可度量其占比）。
- [ ] 运行期切换主题不跟随已建窗口 `backgroundColor`（仅影响重绘 / 调整大小瞬间的预绘制底色；如需可监听 appearance 变更重建常量）。

## 遗留与备查（2026-11-06 三轮独立复审，均 PASS-WITH-NOTES）

- **上游 pi-ai 缺口（Responses 协议 off 档）**：`openai-responses` / `azure-openai-responses` 适配器对缺失的 `thinkingLevelMap.off` 仍兜底发送 `effort:'none'`（`?? "none"`），只接受 low…max 的端点在 off 档仍可能 400。「off 缺省不发参数」仅 `openai-completions` 成立。彻底修法需上游把 responses 系适配器改为「缺失即不发」；当前该协议用户可用取消勾选 off（`off:null`）达成不发参数。请求层清洗（`thinkingLevels.ts`）与 UI 写侧（`thinkingLevelMapEditor.ts`）已覆盖 completions 系端点。
- **hljs 双份打包**（约 +350 KB 安装占用）：渲染懒加载副本与 worker 内联副本不同时加载、均不在主包，属 worker 化固有取舍；若想让 ≤2000 行块也走 worker 可去掉渲染副本。
- **`WorkbenchTextView` 留在主包**：`ResultFilePreviewDialog` 静态引用所致，体量小（依赖 `workbenchReading` / `WordDiffText`），优先级低；可后续懒挂载 `ResultFilePreviewDialogRoot` 或拆文本视图 chunk。
- **持久化「工作台默认打开」的首帧 pane 短暂缺席**：懒 chunk 到位前 pane 区域为空（本地文件通常几十 ms、一次性）；如在意可在 boot 阶段对 stored-open 情形预取 chunk 或给 fallback 占位骨架。
- **windowState close 同步写不经 `writeStateFileAsync` 按路径队列**：极端退出时序下磁盘可能残留旧窗口位置（纯摆放数据，收敛循环随后会再写，有测试覆盖）。
- **测试环境备注**：本机全局 `~/.pi/agent/npm` 缺 `marked-cjk-friendly.min.js` 会导致 `session-capabilities` 导出 HTML 用例失败（环境预存，与代码无关）。

## 约束

- 每项必须有可对比度量与回归测试；不能只改成异步而丢失错误 / 取消语义（迟到结果按导航代次丢弃、失败可重试）。
- 懒加载 chunk 失败时由所在 `ScopedErrorBoundary` 兜底，空闲预取失败静默、首次打开时重试。
- worktree 内禁止 `git stash`（stash 栈仓库级共享，跨 worktree 竞态已致事故）；临时保存用 patch 或 WIP commit。
