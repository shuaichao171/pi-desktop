# 路线图：阅读体验、会话能力、系统集成

本文记录 2026-09 起的三条主线（M2/M3/M4）及其文件级任务，供跨会话接续实现。基线为 `0.1.5`，另有 18 个文件未提交改动（供应商模板、模型启停、项目菜单等，见 M1）。

## 实施状态（2026-09-26 更新）

M1-M4 已全部实施并通过验证（416 项测试 / 414 通过 / 0 失败，四包 typecheck、构建、SSR+CDP 双主题截图均绿）。各节完成情况：

- M1（WIP 加固）：置顶项目落盘 `workspace.json`、`forgetWorkspace` 跨隔离 RPC、模型可见性配置锁、迁移与回归测试。
- M2（2.1-2.6）：字号令牌与设置滑杆、工具活动结构化卡片（diff/退出码/时长/文件 chip）、highlight.js 代码块、助手标题去重、Ctrl+F 查找、历史分页（READY_HISTORY_LIMIT=400）与阈值虚拟化（250）。
- M3（3.1-3.6）：会话统计/导出（HTML/JSONL/Markdown 复制）/回收站删除/重新生成/会话树分支切换/压缩与系统行可见。
- M4 系统（4.1-4.4）：系统通知（窗口非活跃时）与托盘菜单扩展、关闭策略设置（托盘/退出+记住选择）、快捷键注册表（bindings/conflicts/useShortcutBindings）与设置页改键、重试进度与错误分级的 RunStatusBar。
- M4 工作台（4.5/4.7/4.8）：Git 暂存/取消暂存/丢弃（真实 diff 二次确认）/提交历史/建分支；文件级编辑器打开（`-g file:line`）与资源管理器定位；工作区切换状态重置（既有 effect 已覆盖，已验证）。

### 残留风险与未实施项

- 4.6 文件树右键菜单（新建/重命名/删除）、图片/Markdown 预览与工作台内文件搜索未实施（本期范围收敛）；现有 1 MB 文本预览与 400 条目上限保持不变。
- 4.9 命令历史落盘与 PTY 终端未实施（按计划保持低优先）。
- M5（多窗口/quick chat、自动化触发器、macOS 验证、性能预算）未开始。
- 通知点击回会话依赖渲染层已加载；托盘“最近会话”仅显示当前工作区前 5 条。
- 快捷键注册表覆盖全局/会话/输入三域，但 Composer 的 Enter 语义保持内联实现（注册表中标记为 fixed）。
- pnpm 11.11.0 在本机 `add` 无效/挂起，新增依赖仍需 Corepack pnpm 12 生成 lockfile 后回装（本次未新增依赖）。

## 参考来源

- Codex：`D:/codex-re/UI_ANALYSIS.md`（设计系统、多窗口、制品、编辑器打开方式）、`JS_ANALYSIS.md`（`codex-host-chunked-message-v1` 分块序列化）、`D:/codex-re/ui/extracted/webview/assets/`（`chatgpt-code-block-highlighting-633e786cedd0.js`、`highlight-code-7c4c2ef3d4d8.js`、`_virtual_settings-search-documents-c95d013b6e2b.js`、`tool-activity-disclosure-9801aeab4a7c.js`、`thread-user-message-navigation-rail-app-33e1d82a93e0.css`）。
- ZCode：`reference/zcode/DESIGN.md`（字号令牌、间距、圆角层级、菜单密度）、`reference/zcode/packages/ui/src/`（`lib/uiFontSize.ts`、`lib/shikiHighlighter.ts`、`lib/toolDiffPreview.ts`、`ToolCallBlocks/renderers.tsx`、`shortcuts/bindings.ts`、`shortcuts/conflicts.ts`、`lib/taskNotificationOrchestrator.ts`、`lib/chatSessionScrollMemory.ts`、`lib/chatErrorAttribution.ts`、`ModelTrajectorySearch*.ts`、`GitPaneChangeCard.tsx`、`git-graph/`、`workspace-file-search/`、`terminal/`）。
- Pi SDK 0.87.1：`AgentSession.getSessionStats()`／`exportToHtml()`、`SessionManager.getTree()`／`branch()`／`branchWithSummary()`、`tools/edit-diff.generateDiffString`、`core/usage-totals.ts`。

## 现状与基线

| 项 | 结果 |
| --- | --- |
| 测试 | `pnpm test`：362 项，360 通过、2 跳过（Unix 专属），无失败 |
| 类型/构建 | `pnpm typecheck`、`pnpm build` 通过 |
| 规模 | agent 3.7k 行、desktop 4.2k 行、ui 9.3k 行 TypeScript；`packages/ui/src/styles.css` 98 KB，381 处硬编码 `font-size`，仅 50 个 CSS 变量 |
| 未提交改动 | 18 个文件（供应商模板、模型启停与密钥显隐、项目右键菜单、会话行悬停、`removeWorkspace`、`setModelEnabled`），另有 4 个 `scripts-tmp-*` 临时文件位于仓库根 |

已具备且不在本路线图重复的能力：工程主流程（utility process 隔离、多工作区、会话分组/置顶/归档/未读）、草稿与队列、steer/followUp、上下文引用与附件、插件与自动化页、工作台（文件/Git/命令）、更新与发布流水线、深浅主题与配色自定义。因此本文只补短板。

---

## 里程碑总览

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 收尾 | 未提交改动评审修正、清理临时文件、发布 `0.1.6` | 待办（未启动） |
| M2 阅读体验 | 设计令牌与界面字号、对话信息层级、工具卡片与真实 diff、代码高亮、会话内查找、长会话性能 | 本次规划 |
| M3 会话能力 | 统计与用量、导出、删除、重新生成、会话树与分支、压缩可见化 | 本次规划 |
| M4 系统集成与工作台 | 通知与托盘、关闭策略、快捷键注册表、错误分级、Git 操作、文件树与预览、编辑器定位 | 本次规划 |
| M5 备选 | 多窗口/快速提问、自动化触发器扩展、PTY 终端、macOS 实机验证、性能预算入 CI | 未排期 |

---

## M1 收尾（待启动）

| # | 事项 | 落点 |
| --- | --- | --- |
| 1.1 | “在此项目新建对话”误用 `pencil` 图标，应与“重命名”区分 | `packages/ui/src/components/SidebarSessionPanel.tsx`、`packages/ui/src/components/Icons.tsx` |
| 1.2 | 置顶项目只存 `localStorage`，项目移除后不同步；改为落盘到主进程状态文件并在移除时清理 | `packages/ui/src/sidebarOrganization.ts`、`packages/desktop/src/main/stateFiles.ts`、`packages/desktop/src/main/ipc.ts` |
| 1.3 | `removeWorkspace` 未回收后台已加载的 Pi 上下文与 `lastContextByCwd`；新增 `forgetWorkspace(cwd)` | `packages/agent/src/index.ts`、`packages/ui/src/store.ts` |
| 1.4 | `setModelEnabled` 需与“所有会话空闲才可改配置”的既有约束一致，并避免模型选择器重复项 | `packages/agent/src/index.ts`、`packages/ui/src/modelPicker.ts`、`packages/ui/src/components/ComposerControls.tsx` |
| 1.5 | 清理仓库根 `scripts-tmp-*.cjs` / `*.png`；验证脚本统一放忽略目录 | 仓库根 |

验收：`pnpm test` / `pnpm typecheck` / `pnpm build` 通过；`pnpm dist:win` 与 `release.cmd` 流程可发布 `0.1.6`；仓库根无临时文件残留。

---

## M2 阅读体验

### 2.1 设计令牌与界面字号

目标：把散落的硬编码字号/间距/圆角收敛为语义令牌，并提供“界面字号”设置（12–20px，改字号不动图标与间距）。

- 新增 `packages/ui/src/uiFontSize.ts`：`--pd-ui-font-size`（默认 13px，范围 12–20），只写 CSS 变量，不改 `html` 字号；模型见 ZCode `lib/uiFontSize.ts`。
- `packages/ui/src/styles.css` 与各 `components/*.css`：新增 6 档语义字号（`--pd-font-xl/lg/base/caption/sm/xs`）、间距与圆角变量；把 381 处 `font-size` 分批映射，优先处理高频档（12/11/10px）。
- `packages/ui/src/components/SettingsPanel.tsx`（外观页）与 `packages/ui/src/i18n.ts`：字号滑块与文案；深浅主题各自独立预览。
- 圆角按“嵌套层级”递减（容器 → 面板 → 菜单 → 控件），间距统一 4px 节奏，浮层与卡片不混用同一层次。

验收：12/13/16/20px 四档下深色与浅色截图正确，图标、间距、圆角与字号无关；`prefers-reduced-motion` 覆盖全部新动效。

### 2.2 对话信息层级

目标：降低长会话噪声，让“谁在说话、说到哪、是工具还是正文”一眼可辨。

- `packages/ui/src/components/MessageItem.tsx`：`π Pi` 标记只在角色切换或连续段落起点出现；助手正文与用户气泡的层级差再明确一档。
- `packages/ui/src/components/ChatView.tsx`、`packages/ui/src/timeline.ts`：相邻工具/思考活动合并为一段“活动区”，空结果不占行。
- `packages/ui/src/components/ToolActivity.tsx`、`ThinkingActivity.tsx`、`ActivityDisclosure.tsx`、`packages/ui/src/transcript.css`：间距与折叠节奏统一，用户手动收起状态优先于后续事件（现有行为保持）。

验收：同一段会话在 1280/780/360px 三档宽度下阅读节奏一致；连续 10 次工具调用不产生 10 个独立标题行。

### 2.3 工具调用卡片与真实 diff

目标：`edit`/`write` 显示带行号的增删 diff，`bash`/`powershell` 显示命令行与退出码，路径可点击。

- `packages/shared/src/index.ts`：`UiToolActivity` 增加可选字段 `startedAt`/`endedAt`/`exitCode`/`files`/`diff`（历史会话缺字段时按 `null` 渲染，保持向后兼容）。
- `packages/agent/src/index.ts`：`tool_execution_start/end` 记录起止时间；`describeToolUse` 之外新增按工具类型提取文件名与命令；对 `edit`/`write` 结果提取 diff 文本（`generateDiffString` 输出）或其等价结构。
- `packages/ui/src/components/ToolActivity.tsx`：拆为“摘要行 + 渲染器”；新增 `packages/ui/src/components/toolRenderers/`（`editDiff`、`fileRead`、`search`、`command` 等，参考 ZCode `ToolCallBlocks/renderers.tsx`、`lib/toolDiffPreview.ts`）。
- `packages/ui/src/unifiedDiff.ts`、`packages/ui/src/components/composerChanges.css`：复用既有 diff 解析与配色，统一工作台与会话内的 diff 外观。
- 路径 chip 支持：在工作台打开、在资源管理器中定位、用编辑器打开（依赖 4.7 的 IPC）。

验收：`edit` 工具调用显示真实增删行与行号；`bash` 失败时退出码与错误输出在折叠前可见；每条活动显示耗时；历史会话仍可正常渲染。

### 2.4 Markdown 与代码高亮

目标：代码块可读、可复制、可折叠；文件路径可点击。

- `packages/ui/src/components/MessageItem.tsx`：`react-markdown` 注入自定义 `code`/`pre` 渲染器。
- 新增 `packages/ui/src/components/CodeBlock.tsx` + `codeBlock.css`：语言标签、复制按钮、超过 30 行默认折叠、超长行横向滚动。
- `packages/ui/package.json`：新增高亮依赖。首选 `highlight.js`（同步 API、体积可控，用 `common` 子集 + 语言白名单）；备选 `shiki`（保真度更高，异步与体积成本更大，参考 ZCode `lib/shikiHighlighter.ts` 与 Codex `highlight-code-7c4c2ef3d4d8.js`）。注意 Pi 已依赖 `highlight.js@10.7.3`，若引入 11.x 会存在第二份副本，需在实现时确认体积。
- `packages/ui/src/i18n.ts`：复制、折叠、语言未知等文案。

验收：深浅主题下代码块对比度达标；折叠/复制可用键盘完成；单条大代码块（> 2000 行）不阻塞输入。

### 2.5 会话内查找（Ctrl+F）

目标：在当前会话内查找文本，全部匹配高亮、上下跳转、计数，与定位轨道联动。

- 新增 `packages/ui/src/components/TranscriptFind.tsx`（+ CSS），挂载于 `packages/ui/src/components/ChatView.tsx`；复用 `scrollRef` 与既有 `BOTTOM_THRESHOLD` 滚动模型，查找时不抢滚动位置。
- 与 `packages/ui/src/components/ConversationRail.tsx` 联动：命中点标记在轨道上。
- `packages/ui/src/components/SettingsPanel.tsx` 快捷键页登记该组合键（见 4.3）。
- 参考：ZCode `ModelTrajectorySearch.ts`、`ModelTrajectorySearchBar.tsx`、`ModelTrajectorySearchHighlight.ts`。

验收：查找期间流式输出继续到达不丢失高亮；Esc 退出后焦点回到输入框；`Ctrl+K`（全局搜索）与 `Ctrl+F`（会话内）职责在界面上不混。

### 2.6 长会话性能（历史分页 + 虚拟化）

目标：长会话（数千条消息）打开与滚动不卡顿，IPC 不一次推送整条分支。

- `packages/shared/src/index.ts`：新增历史分页 RPC 与 `UiHistoryPage` 类型。
- `packages/desktop/src/main/agentHostProtocol.ts`、`agentClient.ts`、`packages/desktop/src/main/ipc.ts`、`packages/desktop/src/preload/index.ts`：透传分页请求。
- `packages/agent/src/index.ts`：`fireReady` 只发送最近 N 条与总条数；新增 `getHistoryPage(offset, limit)`；超大结果沿用 Codex 的分块思路（`JS_ANALYSIS.md` 的 `codex-host-chunked-message-v1`）。
- `packages/ui/src/store.ts`：`messageWindow` 状态与 `loadOlderMessages()`；切换会话时重置。
- `packages/ui/src/components/ChatView.tsx`：列表窗口化（首选 `@tanstack/react-virtual`），保留“回到底部”“滚动跟随”“搜索定位”“轨道跳转”四条既有行为的语义。
- 与 `packages/ui/src/components/MessageItem.tsx` 配合：视口外消息延迟渲染 Markdown。

验收：2000 条消息的会话首屏可交互时间不高于 1.5s（本机基准）；向上滚动加载历史时无跳动；流式输出期间不触发全量重排。

---

## M3 会话能力

### 3.1 会话统计与用量

- `packages/agent/src/index.ts`：暴露 `getSessionStats()`（`userMessages`/`assistantMessages`/`toolCalls`/`tokens.input|output|cacheRead|cacheWrite|total`/`cost`/`contextUsage`）。
- `packages/shared/src/index.ts`：`UiSessionStats`；`packages/desktop/src/main/ipc.ts`、`preload/index.ts`：新通道 `agent:session-stats`。
- 新增 `packages/ui/src/components/SessionInfoPanel.tsx`，入口在 `packages/ui/src/components/ChatHeaderMenu.tsx`（与重命名、提交并列）。
- 参考：ZCode `WorkspaceSidebarFooterUsageSummary.tsx`、`lib/tokenNumberFormat.ts`。

验收：数值与 Pi CLI `/session` 一致；切换会话后统计刷新，不显示上一个会话的数据。

### 3.2 导出与复制

- `packages/agent/src/index.ts`：调用 `session.exportToHtml()`、`exportSessionToJsonl()`；`packages/desktop/src/main/ipc.ts` 使用保存对话框返回路径。
- 渲染层新增“复制整段对话 Markdown”（`store.messages` 组装，含工具输出可选开关）。
- 入口：`packages/ui/src/components/ChatHeaderMenu.tsx`。
- 导出内容可能包含提示词、命令输出与文件内容，UI 需按 Pi 文档给出提示。

验收：导出的 HTML 可离线打开、JSONL 可被 Pi 重新导入；取消对话框不产生文件。

### 3.3 删除会话与回收

- 现状：只有归档，无删除；Pi `SessionManager` 不提供删除。
- `packages/desktop/src/main/stateFiles.ts` / 新增 `sessionTrash.ts`：删除即移动到 `.trash` 目录（可恢复），并清理该会话的元数据（置顶/分组/未读/排序）。
- `packages/ui/src/components/SidebarSessionPanel.tsx`：菜单项 + 二次确认（参考 ZCode `lib/archivedTaskDeletion.ts`、`DeleteAllArchivedTasksButton.tsx`）。
- 若删除的是当前会话，需要先切到新会话再执行，避免 Agent 持有已删除文件。

验收：删除后侧栏与磁盘状态一致；回收站恢复后会话可正常打开；删除当前会话不产生 RPC 错误。

### 3.4 重新生成与继续

- `packages/ui/src/store.ts`：`regenerate()`（回退到最近一条用户消息并重发）与 `continueTurn()`；复用已有 `agent/src/index.ts:editUserMessage` 的 `navigateTree` 路径。
- `packages/ui/src/components/MessageItem.tsx`：助手消息动作增加“重新生成”（仅最后一条可用，忙碌时禁用）。

验收：重新生成保留原分支（Pi 会话树语义），失败时错误可见且可重试。

### 3.5 会话树与分支

- `packages/agent/src/index.ts`：新增 `getSessionTree()`（`sessionManager.getTree()` + 分支摘要），并暴露 `switchBranch(entryId)`（`branch()` / `branchWithSummary()`）。
- `packages/shared/src/index.ts`：`UiSessionTreeNode`；`packages/ui/src/components/SessionTreePanel.tsx`：可展开时间线，显示用户/助手/工具节点、当前叶子标记、分支切换。
- 与 3.6 配合：离开分支时把摘要作为系统行插入可见时间线。
- 参考：ZCode `ModelTrajectoryTimeline.tsx`、`ModelTrajectoryPane.tsx`、`ModelTrajectoryExpandableMessage.tsx`。

验收：切换分支后对话内容与 `getBranch()` 一致；切换动作在忙碌时被拒绝并给出原因。

### 3.6 压缩与系统条目可见化

- 现状：`packages/agent/src/index.ts:historyTimeline` 只处理 `message` 条目，`compaction`/`branchSummary`/`custom`/`session-info` 条目被丢弃，`/compact` 后对话“凭空跳变”。
- 改动：把这些条目投影成系统行；`/compact` 前后显示 token 变化与摘要内容（可折叠）。
- `packages/shared/src/index.ts`：`UiMessage.role` 增加 `'system'`（或新增 `UiSystemNotice` 类型），`packages/ui/src/components/MessageItem.tsx` 渲染系统行。

验收：手动与自动压缩都能在时间线中看到摘要卡；旧版本会话（无相关条目）渲染不受影响。

---

## M4 系统集成与工作台

### 4.1 系统通知与托盘

- 新增 `packages/desktop/src/main/notifications.ts`：`Notification` 在“窗口未聚焦/已隐藏”时发送，覆盖任务完成、失败、需要用户交互；遵守系统勿扰与“已读即清”策略。
- `packages/desktop/src/main/tray.ts`：菜单扩展为“当前状态与项目 / 新建会话 / 最近 5 个会话 / 暂停自动化 / 检查更新 / 显示 / 退出”，图标提示显示运行状态。
- 未读联动：任务在后台完成时标记会话未读（`backgroundActivity` 已具备）。
- 设置开关：`packages/ui/src/components/SettingsPanel.tsx`（常规页）+ `packages/ui/src/i18n.ts`。
- 参考：ZCode `lib/taskNotificationOrchestrator.ts`、`lib/taskNotificationPreferences.ts`、`lib/taskStatusUnreadSync.ts`。

验收：窗口隐藏时完成任务能收到系统通知，点击后回到对应会话；设置关闭后不再通知。

### 4.2 关闭策略与运行状态

- `packages/desktop/src/main/index.ts`（`win.on('close')`）：生成中关闭窗口时先提示“仍在运行，已最小化到托盘”，并提供“本次记住选择”。
- 设置项：常规页可选“关闭窗口时：最小化到托盘 / 直接退出（有任务时确认）”。

验收：运行中直接退出会二次确认；托盘存在时不会出现不可见的孤儿窗口。

### 4.3 快捷键注册表与快捷键设置页

- 新增 `packages/ui/src/shortcuts/`：`bindings.ts`（声明式注册表：id、默认键、作用域、说明）、`conflicts.ts`（冲突检测）、`useShortcutBindings.ts`。
- 迁移现有分散处理：`packages/ui/src/components/AppShell.tsx`（`Ctrl+K`/`Ctrl+Shift+P`、`Ctrl+B`、`Ctrl+[`/`]`）、`packages/ui/src/components/Composer.tsx`（Enter/Shift+Enter/Ctrl+Enter）、`ConversationRail.tsx`（Alt+↑/↓）、新增 `Esc` 停止生成。
- `packages/ui/src/components/SettingsPanel.tsx`：快捷键页改为从注册表生成，支持改键与冲突提示（当前是 5 条静态文本）。
- 参考：ZCode `shortcuts/bindings.ts`、`shortcuts/conflicts.ts`、`lib/keyboardShortcuts.ts`。

验收：改键后立即生效并持久化；与输入法组合输入不冲突（`isComposing`）；恢复默认可用。

### 4.4 错误分级与运行状态条

- 现状：`auto_retry_start` 写入的 `statusMessage`（英文裸串）在渲染层没有任何组件读取；鉴权失败、限流、上下文超限都是同一种红色 banner（`packages/ui/src/components/ChatView.tsx`）。
- `packages/shared/src/index.ts`：错误与状态结构化（`kind`、`retryable`、`attempt`/`maxAttempts`、`provider`）。
- 新增 `packages/ui/src/errorAttribution.ts`（参考 ZCode `lib/chatErrorAttribution.ts`、`lib/usageErrorCopy.ts`）与 `packages/ui/src/components/RunStatusBar.tsx`：运行中/自动重试/限流等待/失败可操作四态，按钮直达修复动作（去配置密钥、压缩上下文、重试）。
- `packages/ui/src/i18n.ts`：全部状态文案（不再出现英文裸串）。

验收：模拟鉴权失败、限流、上下文超限三类错误时状态条给出不同建议；自动重试期间显示 `attempt/maxAttempts`。

### 4.5 Git 操作补齐

- `packages/desktop/src/main/workbenchService.ts`、`workbenchIpc.ts`、`packages/shared/src/index.ts`：新增文件级 `stage` / `unstage` / `discard`、`git log`（提交历史）、创建分支；现有 `getWorkspaceGitStatus`/`getWorkspaceGitDiff`/`checkoutWorkspaceBranch` 保持。
- `packages/ui/src/components/WorkbenchSidePane.tsx`：Git 页改造为改动卡片（状态、增删行、单文件操作），提交区沿用现有 `ChatCommitDialog`。
- 破坏性操作（discard）必须二次确认并展示将丢失的差异。
- 参考：ZCode `GitPaneChangeCard.tsx`、`GitActionMenu.tsx`、`GitBranchSwitcher.tsx`、`git-graph/`（提交历史可视化为可选后续）。

验收：stage/unstage/discard 后状态与 `git status` 一致；discard 确认框显示真实 diff；提交对话框仍可用。

### 4.6 文件树与预览增强

- `packages/ui/src/components/WorkbenchSidePane.tsx`：文件树右键菜单（新建/重命名/删除/复制相对路径/在资源管理器中打开/用编辑器打开），需新增对应主进程 IPC 与工作区路径校验（沿用 `workbenchService` 现有边界检查）。
- 预览扩展：图片（新增受限二进制读取通道）、Markdown（渲染 + 相对路径解析）、SVG 文本化；文本预览保持 1 MB 限制。
- 文件搜索：把 `searchWorkspaceFiles` 接入工作台内搜索框，大仓库使用 Worker 过滤（参考 ZCode `workspace-file-search/`、`useWorkspaceFileSearchFilter.ts`）。
- 参考：ZCode `WorkspaceFileTree.tsx`、`PreviewPane*.tsx`。

验收：越界路径被拒绝；图片预览不加载超限文件；重命名/删除在工作区外或 Git 忽略目录的行为有明确提示。

### 4.7 编辑器定位与“打开方式”

- `packages/desktop/src/main/workbenchService.ts`：已有 `listWorkspaceOpeners()` 与 `openWorkspaceInVsCode()`；新增 `openPathInEditor(path, openerId)` 与 `revealPathInFolder(path)`，并支持 VS Code 的 `file:line` 定位（diff 与工具活动跳转需要）。
- `packages/ui/src/components/WorkspaceOpenButton.tsx` 已实现“打开方式”选择与持久化，工作台与工具卡片复用同一偏好。
- 参考：ZCode `lib/openWithEditors.ts`、`lib/editorPreference.ts`。

验收：从工具活动 diff 跳到编辑器时定位到对应文件（可行时含行号）；未安装编辑器时给出可操作提示。

### 4.8 工作台状态与工作区切换一致性

- `packages/ui/src/components/WorkbenchSidePane.tsx`：`cwd` 变化时重置选中文件、diff、命令输出与滚动位置（当前部分状态跨工作区保留，可能显示上一个项目的内容）。
- `packages/ui/src/store.ts`：工作区切换失败时保留原工作台状态，不清空。

验收：切换项目后工作台不显示上一个项目的文件/差异；切换失败后原内容仍在。

### 4.9 命令历史与 PTY 评估（低优先）

- `packages/desktop/src/main/workbenchService.ts`：命令历史落盘（可复用、可收藏），保持“执行前确认”的既有安全模型。
- 交互式终端（node-pty）单独评估：涉及打包体积、进程管理与安全边界；当前 README 明确“命令面板不是 PTY”，扩展前需要产品决策。参考 ZCode `terminal/TerminalSession.tsx`。

---

## 依赖与新增库

| 用途 | 首选 | 说明 |
| --- | --- | --- |
| 代码高亮 | `highlight.js`（`common` 子集 + 语言白名单） | 同步 API、体积可控；Pi 已依赖 10.7.3，若用 11.x 会多一份副本，需实测体积 |
| 长列表虚拟化 | `@tanstack/react-virtual` | 体积小、支持可变行高；替代方案为自研窗口化 |
| diff 解析 | 复用 `packages/ui/src/unifiedDiff.ts` + Pi 的 `generateDiffString` 输出 | 如需“忽略空白/并排”再评估 `diff@8` |
| 高亮备选 | `shiki` | 保真度高（ZCode 方案），异步与体积成本更大 |

## 风险与约束

- 2.6 的虚拟化会牵动“回到底部”“滚动跟随”“搜索定位”“定位轨道”四条既有行为，必须同批修改并逐条回归，避免破坏当前良好的阅读连续性。
- `UiToolActivity`/`UiMessage` 的字段扩展必须对旧会话向后兼容（缺失字段按未知渲染），历史回放不得报错。
- 删除（3.3）与 discard（4.5）是破坏性操作：先入回收站或二次确认，且展示将丢失的内容。
- 通知（4.1）需可关闭并遵守系统勿扰；关闭策略（4.2）不得让进程变成不可见的孤儿窗口。
- 依赖新增会影响安装包体积（Windows Setup/Portable、macOS、Linux），每次引入后需检查打包产物大小并在文档中记录。

## 验证方式

- 每个任务完成后执行 `pnpm test`（新增逻辑用 `node:test`，命名沿用 `tests/*.test.mjs`）、`pnpm typecheck`、`pnpm build`；涉及主进程/窗口行为时补隐藏 Electron 窗口脚本。
- UI 改动按项目既有做法在隐藏 Electron 窗口中以真实生产渲染层截图验证：深色/浅色、1280/780/360px、`prefers-reduced-motion`；脚本与截图放在被忽略的 `out/` 目录，不进入提交。
- 长会话性能任务（2.6）需要固定基准：同一份 2000 条消息的会话，记录首屏可交互时间、向上加载历史耗时、流式输出期间帧间隔。
