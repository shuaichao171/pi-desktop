# ZCode 借鉴第三轮（2026-10）

本文记录第三轮从 `reference/zcode` 借鉴并落地的八项设定。前两轮见 [ZCode 对照与体验改进](./zcode-experience-improvements.md) 与 [ZCode 借鉴跟进](./zcode-followups-2026-10.md)。

## 功能总览

| # | 功能 | 入口 | 主要参考 |
|---|---|---|---|
| 1 | Windows 路径链接保留反斜杠 | 对话 Markdown | `lib/windowsFileLinkEscapeRemarkPlugin.ts` |
| 2 | 等待确认时通知 | 系统通知、提示音 | `lib/taskNotificationOrchestrator.ts` |
| 3 | 工作台自动刷新 | 工作台 → 文件 / Git | `lib/gitAutoRefresh.ts` |
| 4 | 文件添加到对话 | 文件树右键「添加到对话」、拖入输入框 | `lib/workspaceFileDrag.ts`、`lib/workspaceFileComposer.ts` |
| 5 | 工具分组语义摘要 | 对话中的工具活动组 | `lib/exploreToolCall.ts`、`v4/conversationAssistantWorkItems.ts` |
| 6 | Git 推送/拉取与领先落后 | 工作台 → Git 分支行 | `git-action-menu/display.ts`、`git-branch-switcher/switchAssist.ts` |
| 7 | 更多「打开方式」 | 会话顶部打开按钮、文件 `file:line` 跳转 | `desktop/src/main/editors.ts` |
| 8 | 代码选区加入对话 | 文件预览、Git 差异、结果文件预览 | `lib/codeCommentContext.ts` |

## 行为细节

**路径（1）**：CommonMark 把 `\.`、`\_`、`\#` 当作转义，`E:\proj\.github\ci.yml` 会被解析成 `E:\proj.github\ci.yml`。`windowsPathEscapes.ts` 在 remark 阶段按节点源码切片还原：链接目标只处理盘符/UNC 路径，并要求「原文反转义后等于解析值」才改写；正文只还原 Windows 路径片段，其余转义（如 `\*`）照旧。同时修复了 `parseResultFileReference` 把渲染时编码出的 `E:%5C…` 误判为 URL 协议的问题——此前反斜杠路径链接一律无法作为文件打开。

**通知（2）**：审批、选择、输入类扩展请求在窗口未聚焦时发系统通知（「需要你的确认 / 需要你的回答」），每个请求最多一次，点击回到对应会话；纯通知类请求不提醒。尚未显示过的窗口（启动阶段）不通知。渲染层在请求到达且窗口失焦时复用任务提示音。

**自动刷新（3）**：主进程 `workspaceWatcher.ts` 监听当前工作区（Windows/macOS 递归原生监听；Linux 只监听根目录与 `.git`，与 ZCode 一致），忽略 `node_modules`、构建缓存与 `.git/objects` 等噪声，400ms 防抖后只广播「文件树/Git 可能变化」，不传路径或内容。工作台在该事件、任务结束（busy → 非 busy）和窗口重新聚焦时静默重读当前可见标签页：不清空列表、不显示加载态。

**添加到对话（4）**：文件树右键「添加到对话」，或把文件/文件夹行拖入输入框，均走输入框既有的 `readContext` 路径（与 `@` 选择相同的大小与路径校验）；只接受当前工作区的条目。「..」行和根目录不提供该项。

**语义摘要（5）**：`toolGroupSummary.ts` 将 read 归为读取、grep/find/ls 归为搜索、edit/write 归为编辑；shell 命令仅当每段都是只读程序（cat、rg、ls、`git status/log/diff`、Get-Content 等）且无重定向、无命令替换时计为读取/搜索，否则计为运行。读取与编辑按去重文件数统计。全部为读取/搜索的组标题显示「已探索 / 正在探索」。

**Git 同步（6）**：`git status` 同时返回上游、领先/落后（仅本地 refs，不联网）。分支行提供获取（`fetch --prune`）、拉取（`pull --ff-only`，分叉时明确拒绝而不产生合并）、推送；无上游时首次推送用 `--set-upstream`（origin 或唯一远程）。网络操作禁用终端凭据提示以免挂起，GUI 凭据管理器仍可用；认证失败、需先拉取等给出可操作的提示。切换分支被未提交修改阻止时列出文件并建议提交或 stash；提交前检查 Git 身份，缺失时提示配置命令且不改动索引。

**打开方式（7）**：`editorCatalog.ts` 检测 VS Code/Insiders、Cursor、Windsurf、VSCodium、Trae、Zed、Sublime Text、JetBrains（IDEA/WebStorm/PyCharm/GoLand/CLion/Rider）及 Windows Terminal / macOS 终端；只查常见安装目录与 PATH shim 对应的真实程序，结果缓存 60 秒。打开按钮显示应用名称与图标；文件 `file:line` 跳转使用所选编辑器的语法（VS Code 系 `-g`、JetBrains `--line`、Zed/Sublime `path:line`），所选为文件管理器或终端时回退到 VS Code。

**代码选区（8）**：在文件预览、Git 差异或结果文件预览中选中代码，浮出「添加到对话」，按整行引用，插入 `[path:起始-结束]` 加带语言的代码围栏（围栏长度自动超过代码中的反引号）；差异使用 `diff` 围栏。引用以可移除的标签显示在输入框下方。

## 验证

- `pnpm typecheck`、`pnpm test`（873 项：871 通过、0 失败、2 跳过）、`pnpm build` 通过。
- 新增测试：`windows-path` 场景（`result-file-markdown.test.mjs`）、`notifications.test.mjs`（审批通知）、`workspace-watcher.test.mjs`、`workspace-context-transfer.test.mjs`、`tool-group-summary.test.mjs`、`workbench.test.mjs`（本地裸仓库上的推送/获取/快进拉取/分叉拒绝、切换失败说明）、`workbench-features.test.mjs`（缺少 Git 身份）、`editor-catalog.test.mjs`、`code-quote.test.mjs`。
- 隔离无界面 Electron 验证（`out/zcode3-review-run.mjs`，忽略目录 `out/`）：真实组件 + 模拟 bridge，覆盖路径链接、两类摘要、打开方式菜单与启动、监听订阅与静默刷新、拖拽属性与「添加到对话」、「..」菜单、选区引用行号、领先落后徽标与推送；深浅主题截图 `out/review-ui/zcode3-*.png`，无控制台错误。

测试使用模拟数据与本地临时仓库，不涉及真实远程或凭据。

## 后续修复（2026-10-07）

**路径链接在对话完成瞬间点击无响应**：新会话的第一轮回答完成时，settle 重同步会首次带上会话文件路径（`sessionPath` 由 `null` 变为实际路径），并把回答从运行中的过程折叠迁移到轮尾答案位。此前两处把这次重同步当作上下文切换：`ResultFilePreviewDialog` 的 store 订阅立即关闭已打开的预览，`ResultFileLink` 自持的预览状态随链接重挂载丢失；同时浏览器只在 mousedown/mouseup 命中同一元素时才派发 click，跨过重排的点击被静默吞掉。修复分三层（对照 ZCode：其链接按消息携带 workspace 身份、入口位置从运行到终态不变，点击目标不移动）：

- `resultFileContext.ts`：`sameResultFileSession` 把「同会话首次获得文件路径」视为同一上下文（bridge/cwd/sessionId/navigationRequestId 仍须一致），预览对话框与链接的焦点恢复不再被它打断。
- `resultFilePreviewStore.ts` + `ResultFilePreviewDialogRoot`（AppShell 挂载）：预览对话框提升为应用级单例，链接重挂载（轮键含 `disclosureScope`、历史分页、settle 重排）不再关闭已打开的预览。
- `resultFilePressRescue.ts`：全局记录落在 `.pd-result-file-link` 上的左键按压，若松开时位移很小且未产生 click（节点在按压期间被替换），按记录的 href 重新打开预览；拖选（位移超阈值）不触发。

回归场景：`tests/fixtures/file-changes/resultFileLinks.mjs`（运行中打开→首次 settle 存活；settle 后关闭/重开；跨 settle 的点击经救援打开；后续轮次 settle 不受影响）。全量 `pnpm test` 884 项通过。
