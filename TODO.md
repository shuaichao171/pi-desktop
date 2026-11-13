# TODO

待办事项清单。勾选方式：把 `[ ]` 改成 `[x]`。

## 进行中

## 计划中

- [ ] 支持渲染 LaTeX 公式：会话内容中的 LaTeX（$...$ / $$...$$）渲染为公式（候选方案 KaTeX，注意与现有 markdown 管线的集成与转义冲突）（2026-11-06 提出；2026-11-10 按用户要求暂缓，本批跳过）

## 已完成

- [x] 子代理 FleetCard 条目顺序稳定：运行和刷新过程中 run / 子节点不再上下换位（2026-11-13 提出并完成）
  - 根因：pi-subagents 生成 `subagent-async` 快照时用 `asyncJobOrder` 排序——先按状态（运行中 > 排队 > 已结束），再按 `updatedAt` 倒序；`updatedAt` 随每次工具调用/回合刷新，宿主 `projectSubagentFleetSnapshot` 和 `FleetCard` 又原样按数组顺序渲染，所以哪个子代理刚有动静就跳到最上面，状态变化（运行→完成）也会整体换组；未被工作流步骤认领的子 run 同样按这个规则排。顶栏 headline 取「第一个运行中」也跟着来回切换。
  - 修复：`packages/agent` 新增 `stabilizeSubagentFleetOrder(next, previous)`，在 `consumeSubagentWidget` 收到快照后以上一份 fleet 为参照：已出现过的 run / 子节点（按 `kind:id` 匹配，逐层递归）保持原相对位置，新 run 追加在后并按 `startedAt` 从早到晚，新子节点保持插件顺序（工作流步骤本就按步骤序号）；数据本身照常更新、不修改输入；fleet 被清空或会话切换置 null 后重新开始排序。`FleetCard` 的 headline 改为「最早的运行中 run，全部结束时取最新一条」。
  - 验证：新增 `tests/subagent-fleet-order.test.mjs`（按插件同款排序模拟 40 次进度/状态更新，断言插件原始顺序确实会洗牌而稳定后顺序不变；新增 run 追加、移除 run 退出、子节点保持首次顺序且不改输入、清空后重新排序）；渲染器夹具 `../ui-polish/agents-goal.mjs` 截图确认 FleetCard 收起/展开正常（该夹具直接向渲染端推 fleet，不经宿主投影；顺带给 `tests/fixtures/model-settings/fixture.mjs` 补上 `getSessionBranchSelection` 桩（返回 null，即没有记忆的分支），深浅主题场景均 passed）；全量 1287 项（1285 通过、0 失败、2 跳过）；四个包 typecheck 通过。

- [x] 结果文件预览弹窗对 markdown 文件做语法着色：点开会话中提到的 .md 文件时（ResultFilePreviewDialog → WorkbenchTextView 纯文本视图），按 markdown 语法（标题/加粗/斜体/行内代码/代码块/链接/列表/引用）分色显示，配色主题参考 VSCode 的 Monokai（背景 #272822、标题黄 #a6e22e、强调橙 #fd971f、关键字紫 #f92672、字符串绿 #e6db74 等）（2026-11-13 提出并完成）
  - 现状：`.md` 早已交给阅读 worker 的 highlight.js markdown 语法分词，但阅读视图没有 `hljs-section` / `hljs-strong` / `hljs-bullet` 等类的样式，所以看起来仍是纯文本；代码块也只是一整段扁平的 `hljs-code`。
  - 落地：`readingHighlight.ts` 新增 `highlightMarkdownLines`，围栏代码块（``` / ~~~，含未闭合到文件尾）按信息串语言单独高亮、未知语言保持扁平代码色，仍保证每个源码行一段 HTML；`.markdown` / `.mdx` 也按 markdown 处理。`ResultFilePreviewDialog` 给 markdown 预览加 `is-markdown`，`resultFilePreview.css` 里定义 Monokai 配色（标题 #a6e22e 加粗、加粗/斜体 #fd971f、列表符 #f92672、行内与围栏代码 #e6db74、链接文字 #66d9ef、地址 #ae81ff 下划线、引用 #75715e 斜体，代码块内关键字/字符串/数字/注释也按 Monokai），深浅主题下都固定使用；搜索高亮与选区颜色同步适配。仅作用于结果文件预览弹窗，工作台文件页不变。
  - 验证：`tests/reading-analysis.test.mjs`（结构分色、围栏按语言、未知语言、未闭合围栏、CRLF、HTML 转义）；渲染器回归 `tests/fixtures/result-files/scenarios.mjs` 新增 Monokai 背景/前景、各语法元素颜色、围栏内关键字/字符串颜色断言，截图 `_ai_work/markdown-preview/monokai-preview.png`；全量 1282 项（1280 通过、0 失败）、四个包 typecheck 通过。
  - 顺带：截图夹具补齐 `onSideQuestionsChanged` / `onHiddenContextChanged` 订阅与 `listSessionsPage` / `listSideQuestions` / `getHiddenContext` 桩（此前缺这些桩，依赖默认夹具的场景在启动时就因 `structuredClone` 回调失败）。

- [x] 项目的聚焦悬浮框不再挡住右侧按钮（2026-11-06 提出，2026-11-10 完成）
  - 根因：项目行标题提示已在 6e20bd7 修过；剩下的是行内操作按钮（新建对话、置顶等）的 `side="right"` 提示以按钮自身右缘为锚点，盖住同排相邻按钮。
  - 修复：新增纯函数 `packages/ui/src/tooltipPlacement.ts`（`placeTooltip`），右侧提示改为锚定到所在侧栏（`[data-tooltip-rail], .pd-sidebar`）的右缘之外，空间不足 120px 时回退原有翻转；`HoverTooltip.tsx` 接入。
  - 验证：`tests/tooltip-placement.test.mjs`。

- [x] 排队发送的内容立刻出现在对话里，带「立即发送」「取消发送」（2026-11-09 提出，2026-11-10 完成）
  - `useInputQueue.ts` 改为按 bridge+作用域共享一个控制器（引用计数），输入框排队条与对话气泡看到同一份队列；`queuedTranscript.ts` 把队列条目合成为排队中 / 引导中 / 已暂停 / 编辑中 / 待确认恢复几种气泡，`QueuedTranscriptMessages.tsx` 渲染在消息列表末尾（只在界面合成，不写会话记录），按钮复用 `steer` / `remove` / `confirm`。
  - 不重复：SDK 的 `consumed` 队列事件与 `user-message` 同一轮先后到达，被消费的条目先从队列消失再出现真实消息。
  - 验证：`tests/queued-transcript.test.mjs`。

- [x] 应用被直接关闭后，下次启动自动继续之前正在跑的对话（2026-11-08 提出，2026-11-10 完成）
  - 主进程 `interruptedRuns.ts`（`InterruptedRunTracker`）实时镜像主窗 / pai 小窗 / 分屏窗格中运行中（running / waiting-input / waiting-approval）的会话，写入 `userData/interrupted-runs.json`；崩溃、强杀同样留下记录；退出时先冻结再释放服务，避免释放过程把记录清掉。
  - 下次启动由主窗渲染端一次性领取（`interrupted-runs:take`，领取即清空，重载不会重复续跑），`useInterruptedRunResume` 在启动会话就绪后逐个切过去发送 `The app was quit while you were working. Please continue from where you left off.`，最后回到启动时的会话；右下角提示进度与失败原因。已不存在的会话文件自动跳过。
  - 验证：`tests/interrupted-runs.test.mjs`。

- [x] 对话完成后在输入框显示「猜你下一句」（2026-11-08 提出，2026-11-10 完成）
  - agent 侧 `nextInputSuggestion.ts` + `SingleAgentService.suggestNextInput`：取当前分支最近 12 条消息（单条 2000 字、总计 12000 字截断）走一次 `completeSimple`，20 s 超时，结果清洗为单行 ≤200 字；不写入会话记录。经 `agent:suggest-next-input` 通道暴露。
  - 渲染端：设置 → 常规 新增「猜你下一句」开关（默认关）与「建议使用的模型」（默认跟随当前对话）；每轮回复结束（busy → idle）请求一次，按会话与最后一条消息缓存，失败静默；仅在输入框为空、无附件、会话空闲时以灰字 placeholder 显示，Tab 或点击「Tab 采用建议」填入。
  - 验证：`tests/next-input-suggestion.test.mjs`；渲染器回归 `tests/fixtures/next-input-suggestion/scenarios.mjs`（默认不请求、开关与模型选择、灰字显示、Tab 填入），截图 `_ai_work/todo-batch-2026-11-10/suggestion-01-settings.png`、`suggestion-02-placeholder.png`。

- [x] 已加载会话：右键或拖动加载、Ctrl+Tab 切换、窗格关闭仅隐藏（2026-11-07 提出；2026-11-10 追加拖动需求并完成）
  - 侧栏左上角新增「已加载会话」区：右键会话「加载到已加载会话」，或把会话拖到该区域即加载（主 agent 后台建好上下文并钉住，不参与 LRU 淘汰）；把会话拖到对话区右侧会出现「松开以在右侧分屏打开」放置区，松开即分屏打开。列表持久化，下次启动后台重新预热。
  - Ctrl+Tab / Ctrl+Shift+Tab 在主窗已加载会话间循环（快捷键可在设置中改）；分屏窗格顶栏的关闭按钮改为隐藏窗格（会话继续运行），已加载区列出全部窗格（显示/已隐藏），点击恢复，× 才真正关闭。
  - 落地：agent `loadSession` / `unloadSession`（`pinnedSessions`、`backgroundLoads`），主进程 `splitPaneSetHidden` / `splitPaneDescribe` / `splitPaneChanged`；渲染端 `loadedSessions.ts`、`loadedSessionActions.ts`、`LoadedSessionsRegion.tsx`、`SessionDropOverlays.tsx`。
  - 验证：`tests/loaded-sessions.test.mjs`；渲染器回归 `tests/fixtures/loaded-sessions/scenarios.mjs`（右键加载、真实鼠标拖到已加载区与分屏区、拖动不误触打开、Ctrl+Tab 前后切换、窗格隐藏/恢复/关闭、移出），截图 `_ai_work/todo-batch-2026-11-10/loaded-02-drag-to-loaded.png`、`loaded-05-drag-to-split.png`、`loaded-06-hidden-pane.png`。
  - 顺带：截图夹具补齐 `listSplitPanes` / `describeSplitPanes` / `takeInterruptedRuns` 与两个分屏订阅的桩（此前缺 `listSplitPanes` 桩会让依赖默认夹具的场景在挂载时就失败）。

- [x] 修复：助手回复里的 http 链接会把 pai 小窗 / 分屏窗格整块导航走（目标地址失效时窗口变黑屏后自毁）（2026-11-09 提出并完成）
  - 根因：只有主窗注册了 `will-navigate` 防护；`createPaiWindow`（`ipc.ts`）与 `createSplitPane`（`splitPanes.ts`）只有 `setWindowOpenHandler`，而它只拦 `window.open` / `target="_blank"`。普通 `<a href>` 点击会让承载会话的 WebContents 自己导航到目标地址，`http://127.0.0.1:5173` 这类已关闭的本地服务直接 `ERR_CONNECTION_REFUSED`，pai 窗与窗格随后按 `did-fail-load` 走失败清理被关闭（用户看到的就是整块黑屏）。
  - 修复：新增 `packages/desktop/src/main/externalLinks.ts`（`openExternalHttpUrl` 只转交 http(s) 给系统浏览器；`guardExternalNavigation` 对新窗请求一律 deny、对主框架导航一律取消，仅放行「重新加载当前文档」）；主窗、pai 窗、分屏窗格三处统一安装，删掉三份重复的内联处理器。
  - 验证：`tests/external-links.test.mjs`（只放行 http(s)、新窗请求不建窗、死地址夺不走当前文档、重载当前文档不算离开、三个渲染面都装了防护）；CDP 隔离实例在修复前复现（窗格与 pai 窗均 `ERR_CONNECTION_REFUSED` 后被清理），修复后真实鼠标点击同一链接，两者都停在原文档，截图 `_ai_work/link-click/after-pane.png`、`after-pai.png`；全量 1129 项通过、四个包 typecheck 通过。

- [x] 修改供应商设置不再等待整套扩展重载：保存立即落盘返回（真实配置实测 5579 ms → 22 ms，用户本机运行日志里的 38–44 s 消失），扩展镜像副本改为后台空闲重载；右下角浮动卡片提示「正在后台重载 / 已完成 / 失败」，连续修改合并为「本轮一次 + 期间改动后再一次」；受影响供应商的发送与选模型会等重载完成，其它供应商照常（2026-11-09 提出并完成）
  - 根因：models.json 会被 pi-model-manager 这类扩展镜像注册，只有该扩展重建自己的副本才能看到新配置；重建 = `session.reload()` 重新转译并加载全部扩展、再 emit `session_shutdown`/`session_start`（本机 5.6–7 s，用户机器上 38–44 s，见 `_ai_work/provider-save-timing/README.md`），旧实现把这步放在保存事务里同步执行。
  - 落地：`packages/agent/src/index.ts` 新增 `providerResync` 待重载集合与单飞后台 pass（不占供应商锁、空闲或下一次事件推进、失败退避重试）；`provider-resync` 事件贯通 `packages/shared`，渲染端 `store.ts` 复用 `operationFeedback` 同一张卡片（同 id 替换，不叠加），重载完成后自动刷新模型目录；文案在 `i18n.ts`。
  - 仅在「该供应商正在待重载集合中」时 `prompt`/`submitInput`/`setModel` 才等待重载；空闲时保持同步启动，不改变原有忙状态时序。
  - 验证：`tests/provider-resync.test.mjs`（保存不等重载、连续修改合并、受影响模型等待、无关供应商照常、无镜像供应商仍同步刷新）、`tests/provider-resync-notice.test.mjs`（卡片合并与三种结果）；全量 1124 项通过、四个包 typecheck 通过；真实配置副本实测保存 22–25 ms + 后台重载 7.1 s 完成。
  - 已知取舍：重载完成前设置页的模型目录可能短暂滞后（提示卡片期间），但发送/选模型会被拦住等待，不会用旧连接发请求。

- [x] 分屏多窗格会话监控（2026-11-02 提出；b1inkie 交接，2026-11-07 完成）
  - 目标：侧栏右键任意项目任意会话 →「打开方式 › 在右侧窗格打开」→ 主窗右侧嵌入窗格（WebContentsView），可同时监控多个会话、都能打字；会话区与各窗格横向均分，关闭后剩余重排。
  - 架构：每 pane = WebContentsView 嵌主窗 contentView，复用 pai 小窗隔离基建（独立 agent host/cwd/信任态/按 sender IPC 路由）。主进程 `splitPanes.ts`（生命周期、按 id 定位/隐藏）+ `paneRegistry.ts`（注册表，避免与 `paiWindows.ts` 循环依赖）；渲染层 `splitPaneRegions.ts`（占位区上报 rect、主窗重载后经 `listSplitPanes` 重新同步）。
  - 交接卡点的根因：`openSplitPane` 中途多了一行 `return entry.paneId`，其后挂载/加载/事件注册全是死代码；另有 `setSplitPaneBounds` 漏传 paneId、preload `onSplitPaneClosed` 回调签名错、desktop 15 处 tsc 错误。均已修复，调试探针（写 `D:/ai/.pigit/pane-trace.log`）已整体移除。
  - 补齐：原生视图盖在整页之上，设置/搜索/提交弹窗、非会话页、窄窗抽屉、工作台浮层打开时隐藏窗格，body 级弹层（菜单、对话框）与窗格相交时该窗格让位；窗格内新建对话走窗格自己的 agent；pai 小窗与窗格互斥占用同一会话；主窗关闭时释放其窗格。
  - 验证：`tests/agent-ipc.test.mjs` 新增窗格路由/主窗专用通道/按 id 定位隐藏关闭/占用拦截用例；全量 1105 通过；隔离 profile 实机截图验证单窗格、跨项目双窗格均分、设置遮挡让位、主窗重载重同步、激活已托管会话红警、窗格自关后重排、顶栏菜单让位。
  - 遗留：窗格会话头标题取首条用户消息而非会话名（托管窗口不拉会话列表，pai 小窗同样如此）；需要 agent ready 事件携带会话名并处理改名同步。

- [x] 全局排查：把所有能懒加载 / 异步化的地方都处理掉。清单、优先级与度量见 [docs/specs/LAZY_ASYNC_AUDIT.md](docs/specs/LAZY_ASYNC_AUDIT.md)（2026-11-01 提出；2026-11-06 完成）
  - 已落地（2026-11-02）：设置 / 搜索 / 自动化 / 插件页 / 提交弹窗与代码高亮（highlight.js）改为按需 chunk 并空闲预取，启动主包 JS 3.58 MB → 2.75 MB（−23%）、CSS 522 KB → 352 KB（−33%）；主进程热路径 `workspaceDefault`、`sessionOpenWindow`、工作台 `reset()` 的同步 IO 改为异步。
  - 已落地（2026-11-06）：工作台首开才挂载（含 Git 图/终端拆 chunk）、长代码块高亮/diff 解析/全文变更搜索下沉 worker、`readCurrentDesktopSettings` 缓存化与 `writeStateFile` 运行期异步化（含跨模块 RMW 入队）、会话列表分页增量与插件目录缓存、冷启动打点与启动并行化；主包 JS 累计 3.58 MB → 2.24 MB（−37.5%）、CSS 522 KB → 339 KB（−35.1%），经多轮独立复审全部修复后合入。
  - 收口（2026-11-06）：工作台目录分页增量（修复单目录超 400 项被静默截断，首页先渲染、续页后台追加，上限 2000 项提示搜索）、模型 / 供应商目录跨启动缓存（冷启动首开模型选择器先渲染上次目录）、文本预览查找 >200k 字符下沉 worker（1 MB 单字母查找约 22 ms → 渲染线程约 5 ms）、启动期 windowState / appearance 首读改为与 Electron ready 并发预取。Git 状态不流式化（git 须算完整个索引才出结果，流式无首包收益）等有意保留项见审计文档「审计结论」。

- [x] 启动窗口与启动后主窗口无缝衔接（2026-11-02 提出；2026-11-06 完成，验收留给用户）
  - 已落地（2026-11-06）：`windowTheme.ts` 单一背景色源消除主窗/splash/pai 窗三处硬编码 `#111216`，splash 深浅双主题（boot/错误页同背景不闪）；`startupSwap` 主窗 `show` 确认后才关 boot 窗（250ms 兜底），无双窗重叠/空窗帧；换窗时窗框/标题栏一次性出现为固有行为（两窗 frame 一致非 bug）。详见 [docs/specs/LAZY_ASYNC_AUDIT.md](docs/specs/LAZY_ASYNC_AUDIT.md)。
  - 收口（2026-11-06）：便携版原生位图改为 boot 页静帧的居中裁切（底色 `#161616`、96 px logo、标题与进度条轨道同位，消除遗留 `#111216`），位图 → boot 窗不再换底色、logo 不再从 216 px 缩到 96 px；运行期切主题（含 system 偏好下 OS 切深浅、pai 窗跨进程同步）即时更新所有已建窗口 `backgroundColor`。限制：浅色主题用户仍是深色位图（打包期静态资源），boot 窗恢复到非居中位置 / 非 100% 缩放时 logo 不完全重合。
  - 验收（留给用户）：便携版冷启动录屏逐帧比对背景色、logo 位置尺寸、窗框出现时机，深浅主题各跑一遍；计时从双击到主窗首帧（可用 `PI_STARTUP_LOG=1` 打点对照）。

- [x] 修复压缩 / 总结请求发错推理档位（400 `reasoning effort "none"`）（2026-11-02 提出；2026-11-06 完成）
  - 根因：UI 模型设置页把 off 档线上值 `'none'` 写进 models.json 的 `thinkingLevelMap`（手动勾选处理器），会话档位为 off 时 OpenAI 兼容适配器把 `reasoning_effort:'none'` 发给只接受 low…max 的端点（如 gpt-6.1-sol）被 400 拒绝；providerDiscovery 目录归一化与持久化设置两个候选已排除。
  - 修复（双层防线）：请求层 `packages/agent/src/thinkingLevels.ts` 归一化 + `providerNetwork.ts` 四处 runtime 请求包装（手动 /compact、自动压缩、普通对话、分支总结全覆盖；off 档不发 reasoning、非法档位丢弃）；写侧 `packages/ui/src/thinkingLevelMapEditor.ts`（off 支持不再写 `'none'`，重建映射丢弃遗留非法值）。models.json 存量 `off:'none'` 无需迁移（请求层已剥离）。回归：`tests/thinking-levels.test.mjs`、`tests/thinking-level-map-editor.test.mjs`（含 compaction 400 场景）。
  - 遗留：openai-responses / azure-openai-responses 适配器（上游 pi-ai）对缺失的 off 映射仍兜底发送 `effort:'none'`，该协议下需取消勾选 off 才不发——彻底修法在上游（见审计文档「遗留与备查」）；真实模型（gpt-6.1-sol）压缩验收留给用户。

- [x] 修复：左侧活动栏按钮悬停提示不居中：气泡仍在按钮上方，去掉 align="start" 改用默认居中对齐，横向相对按钮中心居中（超出窗口左缘时按视口钳制尽量居中）（2026-11-02）
- [x] 子代理适配：侧栏对话行在子代理运行时显示蓝色圈（优先级 失败 > 未读 > 子代理 > 自身运行，悬停文案「子代理运行中」，项目分组计数同步新增蓝色圈）；修复两个进行中对话切换时子代理 FleetCard 不消失：主机在会话重绑时广播 `subagent-fleet: null`，渲染端乐观切换 / 就绪 / 回滚三条路径都会清掉旧会话的 fleet（`UiSessionRuntimeState.subagentRunning` 由主机按会话记忆并在切换后保留）（2026-11-02）
- [x] 会话切换 / 新建的懒加载与不阻塞：切换与启动期间输入框保持可编辑、不再显示「正在连接 Pi…」，草稿跟随乐观选中的目标会话，就绪前仅禁用发送；新建对话准备期间可切换模型 / 思考等级（选择先显示、在首条消息发送前应用到运行时）；切换时沿用 keep-over + 磁盘 peek 渐进绘制。见 [docs/specs/LAZY_ASYNC_AUDIT.md](docs/specs/LAZY_ASYNC_AUDIT.md)（2026-11-02）
- [x] 对话进行中也能安装插件：安装与资源启停在对话运行时后台下载 / 写配置，不再拦截发消息、切模型、新建对话与切项目；扩展重载推迟到所有会话空闲时自动执行并提示「插件已重载生效」，插件页显示待重载状态；更新、移除与手动重载仍需空闲（2026-11-02）
- [x] 创建 TODO 文件
- [x] 有新版本可用时，在设置按钮上方显示「更新」按钮：活动栏设置上方出现 ⬇ 更新入口（悬停显示版本/进度，点击直达设置「更新」页），取代原设置图标红点；见 [docs/ACTIVITY_BAR.md](docs/ACTIVITY_BAR.md)（2026-11-01）
- [x] 修复：删除会话时会一直卡住等待：确认后弹窗立即关闭、行立即隐藏，删除在后台完成并以提示反馈（失败恢复行并可重试）；主进程删除跳过整项目会话全量解析（大项目单次约 3 秒 × 3 次）（2026-11-01）

## 说明

- 新任务先加到「计划中」，开始做时移到「进行中」，完成后移到「已完成」并勾选。
- 涉及细节较多的任务建议拆分为独立文档，放在 `docs/` 或 `_ai_work/` 下，此处只留条目和链接。
- 日期格式：`YYYY-MM-DD`；需要时在条目后追加日期，如 `- [ ] xxx（2026-02-06 提出）`。
