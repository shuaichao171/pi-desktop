# TODO

待办事项清单。勾选方式：把 `[ ]` 改成 `[x]`。

## 进行中

## 计划中

- [ ] 项目的聚焦悬浮框不要挡住右侧按钮：悬浮框弹出时若盖住右侧操作按钮（如展开/菜单/箭头），需错位或翻转方向（2026-11-06 提出）
- [ ] 支持渲染 LaTeX 公式：会话内容中的 LaTeX（$...$ / $$...$$）渲染为公式（候选方案 KaTeX，注意与现有 markdown 管线的集成与转义冲突）（2026-11-06 提出）
- [ ] 目前项目右键只能往右拆分新会话,而我想要右键可以加载好该会话(在左侧栏的左上角添加一个新区域叫:已加载会话),并且可以在当前所处的会话中ctrl tab切换已加载的会话,拆分过的窗格关闭,也不会致使会话关闭,而是临时隐藏,实际关闭要去左上角的已加载会话中关闭（2026-11-07 提出）
- [ ] 应用被直接关闭后，下次启动自动继续之前正在跑的对话：退出时若有会话仍在运行，下次软件启动时自动恢复该会话并向模型发送 `The app was quit while you were working. Please continue from where you left off.`，让其接着完成未完成的工作（2026-11-08 提出）

## 已完成

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
