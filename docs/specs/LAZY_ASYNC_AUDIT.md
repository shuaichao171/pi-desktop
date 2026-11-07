# 懒加载 / 异步化全局排查

2026-11-02。对应 TODO「全局排查：把所有能懒加载 / 异步化的地方都处理掉」。本文件是清单与优先级；每项落地时在此勾选并记录度量。

## 度量基线与当前值

| 指标 | 来源 | 基线（2026-11-02） | 当前（2026-11-06） |
|---|---|---|---|
| 启动主包 JS | `pnpm build` 后 `packages/desktop/out/renderer/assets/index-*.js` | 3,584,131 B | **2,245,938 B（累计 −37.3%；2026-11-06 收口批次新增目录分页 / 模型缓存 / 预览查找约 +5 KB）** |
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
- [x] **P2 启动窗口配色统一（部分）**（2026-11-06，startup 车道）：`windowTheme.ts` 单一背景色源（默认对齐渲染层 surface：dark `#161616` / light `#f8f8f8`，用户外观取 `colors[mode].surface` 带 hex 校验回退），主窗 / splash / pai 窗三处硬编码 `#111216` 全部消除；splash 深浅双主题渲染，boot 页与错误页同背景切换不闪；`startupSwap.ts` 主窗 `show` 确认后才关 boot 窗（250 ms 兜底），杜绝两窗皆不可见空帧。对应 TODO「启动窗口与主窗无缝衔接」的 boot→主窗段；便携版位图段见下方同日条目。
- [x] **P2 工作台目录分页增量**（2026-11-06）：`workbenchService.listEntriesPage(relativePath, cwd, offset)` 按「文件夹优先 + 名称」排序后分页（每页 `MAX_ENTRIES=400`，只对当页做 lstat，偏移在目录不变时稳定），新增通道 `workspaceListEntriesPage`（托管 pai 窗按自身文件夹作用域，参数校验）；`listEntries` 仍返回首页（输入框上下文选择器等旧调用方不变）。渲染层 `workbenchListing.streamDirectoryListing` 首页立即渲染、续页后台追加（按 path 去重防跨页位移重复、导航代次丢弃迟到页、续页失败保留已显示行并报错），上限 `WORKBENCH_LISTING_CAP=2000` 项后停止并提示「可用搜索查找其余文件」；静默自动刷新等全量回齐后一次替换，大目录不会缩回首页。旧桥（无分页方法）回退单发。修复了原先单目录超过 400 项时其余条目被静默截断的问题。回归：`tests/workbench-listing.test.mjs`、`tests/workbench-ipc.test.mjs`。
- [x] **P2 模型 / 供应商目录跨启动缓存**（2026-11-06）：`modelCatalogCache.ts` 把最近一次成功拉取的 `models` / `modelProviders` 写入 localStorage（逐项结构校验、损坏整半丢弃、>1,000,000 字符不写并清旧缓存、主机未就绪时返回的空列表不冲掉旧缓存）；`store.refreshModels` / `refreshModelProviders` 在当前列表为空时先用缓存垫底渲染，响应到达后整体替换并回写（stale-while-revalidate）。只在刷新时读取，不进启动主路径。会话内本就由 store 保留上次结果，此项补的是冷启动 / 切工作区后首次打开模型选择器的空列表。`UiModelProvider` 不含密钥（主机侧只暴露 header 名与非密字段）。回归：`tests/model-catalog-cache.test.mjs`、`tests/store.test.mjs`。
- [x] **P2 文本预览查找下沉 worker**（2026-11-06）：微基准（1 MB 预览上限、约 1.4 万行）：`readingRows` 3.6 ms；查找单字母 113k 处匹配 19 ms + 分行 2.5 ms，超出一帧预算；语法高亮早已在 `reading.worker`。`literalMatchRanges` 以 `Int32Array` 打包 [start,end] 对（跨 worker 一次 memcpy，免逐对象结构化克隆），`diff.worker` 新增 `reading-find` 请求；`useReadingFind` 在 >200k 字符时走 worker（等待期保留同文本的上次匹配，不闪 0/0；迟到结果按文本+查询丢弃），以下保持同步。`readingRows` 3.6 ms 留在渲染线程（低于 worker 往返收益）。回归：`tests/reading-find.test.mjs`（与旧实现逐例对拍）。
- [x] **P2 启动期状态文件首读预取**（2026-11-06）：boot 窗构建所需的 windowState 与 appearance 改为 `readWindowStateAsync` / `readAppearanceStateAsync` 在主模块求值时并发发起，与 Electron 自身的 ready 等待重叠，ready 后直接取结果（回退语义与同步版一致）；boot 窗与 boot 页共用一次解析出的主题（原先读两次）。新增打点阶段 `state-read`（`app-ready → state-read` 即预取剩余等待）。`desktopLaunch.ts` 的同步 IO 是 ready 前的单实例/配置文件独占声明（`wx` 原子创建 + rename），顺序语义依赖同步，保留；`piEngine.ts` 只在 agent host 子进程与设置页探测时运行，不在主进程冷启动路径；desktopSettings / workspaceSettings 首读已在 state-io 车道缓存化。回归：`tests/window-state.test.mjs`、`tests/appearance-sync.test.mjs`、`tests/startup.test.mjs`。
- [x] **P2 运行期切主题同步已建窗口底色**（2026-11-06）：`windowTheme.syncWindowBackgrounds` 对全部存活窗口 `setBackgroundColor`；在 `appearanceSet`、跨进程 appearance 文件变更（pai 窗）与 `nativeTheme 'updated'`（system 偏好下 OS 切深浅）三处触发，dispose 时摘除监听。回归：`tests/startup-theme.test.mjs`。
- [x] **P2 便携版「原生位图 → boot 窗」衔接**（2026-11-06）：位图改为 boot 页静帧的居中 224×224 裁切（`createPortableSplashHtml` + `portableSplashCrop`，640×480 渲染后 `capturePage(rect)`）：底色 `#161616` 与首启深色 boot 窗一致（原 `#111216` 遗留硬编码消除），logo 96 px 且与 boot 页同一相对中心位置，标题与进度条轨道同位；进度条停在动画首帧（轨道外），boot 窗出现时从首帧起播；随语言变化的状态文字只占位不绘制（位图打包时生成、语言在运行时决定）。回归：`tests/startup-theme.test.mjs`。限制：位图为打包期静态资源，浅色主题用户仍是深色位图 → 浅色 boot 窗；BgImage 居中于主屏，boot 窗恢复到其他位置/显示器时 logo 不重合；非 100% 缩放下 boot 页 logo 按 DPI 放大而位图按原生像素显示。

## 审计结论（2026-11-06 收口）

清单全部处理完毕。以下为有意保留、不再列为待办的项（按诊断再决定）：

- **Git 状态不流式化**：`git status --porcelain` 须在比对完整个索引后才产出结果，管线化读取对首包时间几乎无收益；现状已是异步子进程 + 2 MB 有界读取 + `truncated` 标记与 UI 提示，变更类操作拒绝基于截断结果执行。若需更快，方向是 `core.fsmonitor`/`untrackedCache` 等 git 侧加速，而非 IPC 流式。
- **渲染线程剩余同步点**：≤2000 行代码块的同步 hljs（2000 行封顶 ≈110 ms）、wordDiff（词级粒度小）、`readingRows`（1 MB ≈3.6 ms）、≤200k 字符的预览查找——均低于 worker 往返收益。
- 已有分页/增量范例：历史分页 `getHistoryPage`、会话 peek、搜索分页 `searchSessionsPage`、会话列表分页 `agentListSessionsPage`、工作台目录分页 `workspaceListEntriesPage`。

## 遗留与备查（2026-11-06 三轮独立复审，均 PASS-WITH-NOTES）

- **上游 pi-ai 缺口（Responses 协议 off 档）**：`openai-responses` / `azure-openai-responses` 适配器对缺失的 `thinkingLevelMap.off` 仍兜底发送 `effort:'none'`（`?? "none"`），只接受 low…max 的端点在 off 档仍可能 400。「off 缺省不发参数」仅 `openai-completions` 成立。彻底修法需上游把 responses 系适配器改为「缺失即不发」；当前该协议用户可用取消勾选 off（`off:null`）达成不发参数。请求层清洗（`thinkingLevels.ts`）与 UI 写侧（`thinkingLevelMapEditor.ts`）已覆盖 completions 系端点。
- **hljs 双份打包**（约 +350 KB 安装占用）：渲染懒加载副本与 worker 内联副本不同时加载、均不在主包，属 worker 化固有取舍；若想让 ≤2000 行块也走 worker 可去掉渲染副本。
- **`WorkbenchTextView` 留在主包**：`ResultFilePreviewDialog` 静态引用所致，体量小（依赖 `workbenchReading` / `WordDiffText`），优先级低；可后续懒挂载 `ResultFilePreviewDialogRoot` 或拆文本视图 chunk。
- **持久化「工作台默认打开」的首帧 pane 短暂缺席**：懒 chunk 到位前 pane 区域为空（本地文件通常几十 ms、一次性）；如在意可在 boot 阶段对 stored-open 情形预取 chunk 或给 fallback 占位骨架。
- **windowState close 同步写不经 `writeStateFileAsync` 按路径队列**：极端退出时序下磁盘可能残留旧窗口位置（纯摆放数据，收敛循环随后会再写，有测试覆盖）。
- **测试环境备注**：本机全局 `~/.pi/agent/npm` 缺 `marked-cjk-friendly.min.js` 会导致 `session-capabilities` 导出 HTML 用例失败（环境预存，与代码无关）。
- **退出时序窄口（终审 RX，仅记录）**：`disposeServices` 的 drain 若在 `defaultWorkspaceAsync` 入队前捕获队列尾，该注册写入可逃过排空；写入为临时文件+原子 rename 且 dispose 后续仍有多个 await，最坏仅注册条目落盘与否，无用户可见错误。
- **debugApi getState 瞬态（终审 RX，仅记录）**：getState 在队外读 config+server，动作进行中（写盘后 create 前 / stop 后写盘前）可短暂呈现 enabled=true+running=false；自愈，由 setConfig 返回值立即纠正。
- **设置队列可被对话框阻塞（终审 RX，仅记录）**：损坏设置恢复框的同步 `showErrorBox` 会阻塞 withDesktopSettings 直至用户关闭；属既有设计余量，正常路径不触发。

## 约束

- 每项必须有可对比度量与回归测试；不能只改成异步而丢失错误 / 取消语义（迟到结果按导航代次丢弃、失败可重试）。
- 懒加载 chunk 失败时由所在 `ScopedErrorBoundary` 兜底，空闲预取失败静默、首次打开时重试。
- worktree 内禁止 `git stash`（stash 栈仓库级共享，跨 worktree 竞态已致事故）；临时保存用 patch 或 WIP commit。
