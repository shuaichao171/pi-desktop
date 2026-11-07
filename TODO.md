# TODO

待办事项清单。勾选方式：把 `[ ]` 改成 `[x]`。

## 进行中

- [ ] 【交接中】分屏多窗格会话监控（feat/split-panes；2026-11-07 已在该分支合入最新 main，含 store 工厂重构，无需再 rebase）（2026-11-02 提出，当前由 b1inkie 侧 AI 交接）
  - 目标：侧栏右键任意项目任意会话 →「在右侧窗格打开」→ 主窗右侧出现嵌入窗格（WebContentsView），可同时监控多个会话、都能打字；多窗格横向均分、主窗内容收缩让位、关闭后剩余重排。
  - 架构：每 pane = WebContentsView 嵌主窗 contentView，复用 pai 小窗隔离基建（独立 agent host/cwd/信任态/按 sender IPC 路由）。核心文件：`packages/desktop/src/main/splitPanes.ts`（生命周期+layoutPanesFor 主进程均分布局）、`paneRegistry.ts`（pane 注册表，斩断 paiWindows↔splitPanes 循环依赖）、`paiWindows.ts`、`ipc.ts`（splitPaneOpen/Close/SetBounds 三通道）、`AppShell.tsx`（paneIds 状态 + .pd-split-pane-host）。
  - 已验证可用：pane 创建/agent init/页面加载（did-finish-load）/主进程均分定位/dedup 聚焦（重复打开同一会话聚焦已有 pane）/主窗激活 hosted 会话红警+聚焦宿主。
  - 卡点（未解）：主窗 renderer 的 paneIds 链不工作——①新建 pane 的 invoke 曾漏 return（已修未验证：splitPanes.ts 新建分支补 return entry.paneId）；②窗格加载成功后主窗区域从不上报 bounds（setSplitPaneBounds 从未被调用），pane 以 overlay 形式盖在主窗右半而非挤压并排；③AppShell paneIds.length>0 区域渲染分支疑似未生效，renderer console 不进主进程 stdout 无法直接观测。
  - 证据链与工具：`D:/ai/.pigit/pane-trace.log`（trace() 写文件：invoke/created/layout/load done/STILL LOADING；主窗 renderer console 经 console-message 桥接进同文件，前缀 main-rdr）；`dev-ai.cmd`（仓库根，已 ignore）= 冷启动+全量日志重定向到 `D:/ai/.pigit/dev-ai.log`。
  - 环境陷阱（会严重误导调试）：electron-vite dev 的 watcher 常静默死亡（改码后 electron 不重启，测的是旧代码）；dev 模式运行的是 watcher 内存转换代码而非 out/ 产物（手动 build 不影响运行实例）；验证改动生效必须查 electron 进程 StartTime 晚于改动时间。
  - 接手建议：用 trace 文件复现（点拆分→读 pane-trace.log）；优先查 AppShell paneIds 区域为何不渲染（renderer 侧 DevTools 或 console-message 桥）；布局可考虑彻底主进程化（当前 layoutPanesFor 已是，renderer 只需视觉占位）。
  - 交互规范（用户已拍板）：多窗格均分；重复打开=聚焦已有 pane；主窗激活 hosted 会话=红警「该会话已在分屏窗格中打开」+聚焦宿主；改名只在左侧栏；顶栏无会话标题（ConversationHeader 在会话区顶部）。

## 计划中

- [ ] 项目的聚焦悬浮框不要挡住右侧按钮：悬浮框弹出时若盖住右侧操作按钮（如展开/菜单/箭头），需错位或翻转方向（2026-11-06 提出）
- [ ] 支持渲染 LaTeX 公式：会话内容中的 LaTeX（$...$ / $$...$$）渲染为公式（候选方案 KaTeX，注意与现有 markdown 管线的集成与转义冲突）（2026-11-06 提出）

## 已完成

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
