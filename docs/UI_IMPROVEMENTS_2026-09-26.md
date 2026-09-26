# UI 优化实施与验收记录

日期：2026-09-26。

`ui-todo.txt` 中 UI-001 至 UI-028 共28项曾实现并完成本轮验收。随后按用户要求移除了 UI-011 设置搜索、UI-028 书签、置顶摘要、项目默认值设置页及关于页。逐项行为、主要代码及历史验证证据保存在本记录和四份专项规范中；原待办文件按要求清空为0字节。

移除后的验证：生产构建与 desktop renderer 类型检查通过，相关单测 43 项通过（`out/review/remove-features-tests.log`）。界面回归为会话 `run-XeiUsS`（31 个断言、5 张截图）、设置 `run-Io2pP5`（19 个断言、7 张截图）、管理 `run-dNhml3`（5 个断言、6 张截图）、模型完整场景 `run-JvqF8J`（50 个断言、12 张截图），合计 105 个断言、30 张截图；四份报告的 `cleanupError` 均为 null。下文旧报告对应移除前版本。

专项规则见 [设置与反馈](specs/UI_SETTINGS_AND_FEEDBACK.md)、[会话阅读](specs/UI_CONVERSATION.md)、[会话及资源管理](specs/UI_MANAGEMENT.md)、[工作台与搜索](specs/UI_WORKBENCH.md)。

## 最终验证

2026-09-26，最终源码通过 `pnpm typecheck`、`pnpm build`、`pnpm test` 和 `git diff --check`。全部五组界面场景使用同一最终构建：`index-DlOINwFW.js`、`index-DYGT18Kz.css`，报告包含资源SHA-256。

| 验证层 | 最终结果 | 覆盖 |
| --- | --- | --- |
| 完整 Node 测试 | 489项，487通过，0失败，2跳过；日志 `out/review/ui-improvements-tests.log` | 两项跳过分别为缺少Windows文件符号链接权限、Unix专属进程组测试 |
| 设置与反馈 renderer | [run-tgLXRD](../out/review/model-settings/runs/run-tgLXRD/report.json)：passed，29个交互断言，7张截图 | 搜索、组合草稿、保存失败、字号、模型能力、菜单/侧栏关闭后的反馈和重复重试 |
| 管理 renderer | [run-619d7W](../out/review/model-settings/runs/run-619d7W/report.json)：passed，19个交互断言，5张截图 | 后台runtime、列表请求、删除失败重试及焦点返回、自动化、插件 |
| 工作台 renderer | [run-6g525g](../out/review/model-settings/runs/run-6g525g/report.json)：passed，23个交互断言，4张截图 | Git分源、文件导航、焦点约束、空间调整、搜索重试及输出阅读 |
| 会话 renderer | [run-MQmWmX](../out/review/model-settings/runs/run-MQmWmX/report.json)：passed，34个交互断言，7张截图 | GFM与DOM高亮一致、代码内部滚动、阅读恢复、图片实际缩放、引用、书签窄窗、树失败重试、历史补页取消 |
| 工作台跨项目 renderer | [run-Em0jUZ](../out/review/model-settings/runs/run-Em0jUZ/report.json)：passed，5个交互断言，1张截图 | A的丢弃确认切B后失效；暂存/丢弃/新建分支的迟到结果不污染B |

报告位于 `out/review/model-settings/runs/<运行编号>/report.json`，图片位于相同目录。报告记录构建资源哈希，旧报告不能自动证明后续修改后的构建通过。上述输出目录为本地验证产物；如交付包不包含该目录，应随最终验收记录另附所需报告或图片。

五组场景合计110个交互断言、24张截图，renderer错误、未预期bridge调用、控制台错误和外部网络请求均为空，测试进程及profile清理成功。已人工核对关键截图，包含窄窗20px设置、模型能力标签、图片预览、窄窗书签、会话树、Git差异以及自动化/插件管理。

实际界面场景位于 `tests/fixtures/ui-improvements/` 下的 `settings.mjs`、`conversation.mjs`、`management.mjs`、`workbench.mjs`、`workbench-workspace.mjs`，通过已有 `tests/fixtures/model-settings/run.mjs` 驱动真实构建的 renderer。例如：

```powershell
pnpm build
node tests/fixtures/model-settings/run.mjs --run --scenario=../ui-improvements/conversation.mjs
```

## 验证方法与范围

- **逻辑/状态测试**：直接验证真实的纯函数、store、组件效果、异步请求身份和错误处理；不把检查源码字符串等同于交互验证。
- **后端/协议集成测试**：验证实际 IPC 参数校验、agent-host 允许列表、离线 Pi runtime、临时 Git 仓库、临时会话文件及回收站行为；不执行在线模型请求、真实自动化计划或真实插件安装。
- **renderer 交互测试**：加载真实 renderer JS/CSS，注入内存 mock bridge，使用隔离 Chromium headless shell 的鼠标/键盘事件检查 DOM、焦点、请求对象和状态转换，并生成截图。它验证前端行为与 bridge 调用约定，不代表已连接真实 Electron IPC、操作真实用户文件或完成在线服务联调。
- **布局记录**：代表场景包括深/浅主题、中/英文、680/900/1440px、UI 字号 12/13/16/20，以及减少动态效果。覆盖分布在各场景，未声称所有页面与所有条件的笛卡尔积均已截图。中文内容输入也不等同于本机输入法完整组合态实测。
- 本轮未触碰用户原本打开的软件或窗口。界面验证只使用任务自行启动的隔离 headless 测试进程及 profile，runner 负责关闭和清理；未通过 computer-use 接管用户桌面。

下表的renderer证据均以最终验证表列出的报告为准。

## 逐项实施与验证

代码路径简写：`UI/` = `packages/ui/src/`，`Desktop/` = `packages/desktop/src/`，`Agent/` = `packages/agent/src/`，`Shared/` = `packages/shared/src/`。表内测试文件均位于 `tests/`。

| 编号 | 当前实际行为 | 主要代码 | 验证类型与已覆盖场景 |
| --- | --- | --- | --- |
| UI-001 | 操作反馈独立于菜单与侧栏显示；按操作及目标去重，失败可保留、看详情、重试。重试捕获原路径；导出会检查原会话，防止切走后导错对象 | `UI/operationFeedback.ts`；`UI/components/OperationFeedback.tsx`、`ChatHeaderMenu.tsx`、`Sidebar.tsx` | `ui-enhancements.test.mjs` 验证菜单关闭后的反馈、原目标重试及防重；设置 renderer 检查可见错误与详情 |
| UI-002 | 连接、模型和凭据草稿接入内存 dirty/saving/save 协议。切供应商、分类、Esc、关闭设置提供保存、放弃或继续编辑；保存失败留草稿、保存期间防重 | `UI/settingsLeaveGuard.ts`；`UI/components/SettingsPanel.tsx`、`ModelSettingsPanel.tsx` | `settings-leave-guard.test.mjs`、`ui-enhancements.test.mjs`；设置 renderer 验证组合草稿、离开保护、保存失败与恢复编辑 |
| UI-003 | 按工作区、会话和分支保存可见消息锚点、偏移及贴底状态，内存上限100条。返回时验证分支身份，必要时补历史；显式搜索优先，内容变高时维持锚点 | `UI/conversationState.ts`、`conversationNavigation.ts`；`UI/components/ChatView.tsx` | `conversation-state.test.mjs`、`store-history.test.mjs`；会话 renderer 验证中部切走返回的阅读位置。包含ResizeObserver修正后回归 |
| UI-004 | 每次关键词出现分别计数，以消息 ID/文本偏移保持当前命中，Enter/Shift+Enter 逐词切换。DOM Range/CSS Highlight 不改复制文本；折叠代码命中可临时展开 | `UI/conversationState.ts`；`UI/components/TranscriptFind.tsx`、`ChatView.tsx`、`MessageItem.tsx`、`CodeBlock.tsx` | `conversation-state.test.mjs`、`transcript-find.test.mjs`；会话 renderer 验证同回答3次、正反跳转及折叠代码。包含GFM语法和跨块正文/高亮一致性 |
| UI-005 | 全局搜索和阅读恢复共用按稳定 ID 的分页定位。显示定位状态，历史耗尽/无进展停止；会话、工作区、分支或新定位变化取消旧请求 | `UI/conversationNavigation.ts`；`UI/components/AppShell.tsx`、`ChatView.tsx`；`UI/store.ts` | `conversation-state.test.mjs`、`store-history.test.mjs`、`session-selection.test.mjs`；会话 renderer 验证初始400条之外命中及旧响应不拉回新会话 |
| UI-006 | 有正文的失败/中断回答仍可复制。idle 下显式重新生成最后一轮，保留原用户内容、附件和分支路径；拒绝 busy 或旧回答。主机恢复明确为“重新连接 agent” | `UI/components/MessageItem.tsx`、`RunStatusBar.tsx`；`UI/store.ts`；`Agent/index.ts` | `store-regenerate.test.mjs`、`run-status-bar.test.mjs`、`history-attachment-preservation.test.mjs`；会话 renderer 验证部分失败复制及原轮次重新生成 |
| UI-007 | 待发送和历史图片共用预览 dialog，支持适应窗口、100%、25%–400%缩放、左右切图、加载失败重试及 Esc 焦点返回。省略图片保留稳定索引，点击才受限按需读取 | `UI/components/ImagePreviewDialog.tsx`、`Composer.tsx`、`MessageItem.tsx`；`Shared/index.ts`；`Desktop/preload/index.ts`、`main/ipc.ts`、`main/agentHostProtocol.ts`；`Agent/index.ts` | `history-attachment-preservation.test.mjs`、`agent-history-paging.test.mjs`、`agent-ipc.test.mjs`、`agent-host-protocol.test.mjs`；会话 renderer 验证多图、按需失败重试、100%及焦点返回。容量与身份边界见下文 |
| UI-008 | runtime 独立提供运行、等待输入、等待授权、失败、idle 摘要，未读独立保留。后台状态持续更新，项目/自定义组折叠后仍显示聚合数量；运行中的未持久化会话保持可达 | `Shared/index.ts`；`Agent/index.ts`；`UI/store.ts`、`managementState.ts`；`UI/components/SidebarSessionPanel.tsx` | `multi-runtime.test.mjs` 验证真实离线 runtime 切换、等待授权、完成及失败恢复；`management-state.test.mjs` 验证身份与聚合；管理 renderer 验证切到B后A仍运行及折叠待处理数量 |
| UI-009 | 1100px以下工作台覆盖模式约束焦点，打开移入、Tab/Shift+Tab循环、Esc返回触发器；并排模式可正常跨栏。设置、搜索与原生模态层优先，覆盖模式收起窄窗侧栏 | `UI/components/AppShell.tsx`、`WorkbenchSidePane.tsx`、`shellMotion.css` | 工作台 renderer 在1440px检查并排可访问，在900px检查Tab/Shift+Tab/Esc及返回，在680px检查覆盖；`app-shell-storage.test.mjs` 等支持状态回归 |
| UI-010 | 文件/差异阅读器提供行号、增删层级、固定标题、原文复制、查找与逐次跳转。双语分段标题、重命名信息和截断提示单独识别，不伪造缺失上下文；大文件逐步展开 | `UI/workbenchReading.ts`；`UI/components/WorkbenchTextView.tsx`、`WorkbenchSidePane.tsx`、`workbenchReading.css` | `workbench-reading.test.mjs` 验证分段patch、重命名、Unicode、CRLF及截断；工作台 renderer 验证真实行号/增删行与命中跳转 |
| UI-011 | 设置搜索已按用户要求移除；通过分类导航访问设置 | 原搜索组件及索引已删除 | 搜索专用单测已删除；设置 renderer 改为分类导航并保留草稿保护和外观验证 |
| UI-012 | 控件、状态与错误使用语义UI字号。代码/文件/Diff 与命令正文分别独立调节12–24px、保存和重置，不改变周围图标或控件尺寸；存储被拒仍可在当前窗口调整 | `UI/uiFontSize.ts`、`contentFontSize.ts`、`controlStandards.css`；`UI/components/SettingsPanel.tsx`及相关私有CSS | `ui-font-size.test.mjs`、`ui-enhancements.test.mjs`；设置 renderer 分别覆盖UI12/13/16/20、代码18/命令22及存储；管理/工作台补充长路径和放大字号截图 |
| UI-013 | 工作台宽度320–800px偏好、默认420px，按视口约束且不覆盖宽窗记忆；宽度和列表/预览比例均有拖动、键盘和持久化。窄窗可放大预览并返回列表 | `UI/workbenchReading.ts`；`UI/components/AppShell.tsx`、`WorkbenchSidePane.tsx`、`shellMotion.css` | `workbench-reading.test.mjs`、`app-shell-storage.test.mjs` 验证尺寸及存储；工作台 renderer 验证键盘调宽/比例、保存偏好、680px放大返回 |
| UI-014 | 模型菜单显示目录中的图片输入、推理能力，缺失字段明确未知；有图片草稿时提示当前兼容性，可主动筛选图片模型，不自动切换 | `UI/modelPicker.ts`、`modelCapabilities.ts`；`UI/components/ComposerControls.tsx`、`Composer.tsx`、`modelCapabilities.css`；`Shared/index.ts` | `model-picker.test.mjs`、`ui-enhancements.test.mjs`；设置 renderer 检查能力标记及图片模型筛选，确认不自动切换 |
| UI-015 | 同一回答正文选区可引用到当前草稿，保留准确选文、换行与消息来源，追加而不覆盖；引用可检查/移除，普通复制不受拦截，拒绝混入工具栏控件的选文 | `UI/conversationState.ts`；`UI/components/MessageItem.tsx`、`Composer.tsx`、`ChatView.tsx` | `conversation-state.test.mjs` 验证来源、原草稿、代码空白和精确移除；会话 renderer 验证选文追加、移除及会话草稿隔离 |
| UI-016 | 重新生成使用独立旋转图标，分支保留gitBranch；鼠标/键盘提示解释两者区别。操作进行中有文字且禁重复，复制错误和分支结果接入全局反馈 | `UI/components/MessageItem.tsx`、`HoverTooltip.tsx`；`UI/transcript.css`、`operationFeedback.ts` | `ui-render.test.mjs`、`store-regenerate.test.mjs`及反馈逻辑测试；会话 renderer 检查复制、重新生成及对应请求 |
| UI-017 | 会话树可折叠，当前路径与当前节点分别标识；选择只预览摘要，另行确认才切换。提供定位当前节点、单Tab入口、上下左右/Home/End导航，深层缩进设视觉上限 | `UI/components/SessionTreePanel.tsx`；`UI/sessionTree.ts`；已有Shared/Agent树协议 | `conversation-state.test.mjs` 验证20层树、折叠与路径/叶子区别；会话 renderer 验证选择、键盘移动及确认切换，busy仍禁切换 |
| UI-018 | 会话删除使用原生确认dialog，显示标题、工作区及移入应用回收站语义；处理中防重复，失败原位重试，取消不提交。成功关闭原生模态后同步恢复相邻行/列表焦点并反馈 | `UI/components/SessionTrashDialog.tsx`、`SidebarSessionPanel.tsx`；`UI/store.ts`；现有`Desktop/main/sessionTrash.ts` | `session-delete.test.mjs` 验证真实临时回收站及组清理；管理 renderer 验证Esc、重复激活、失败重试、目标身份和焦点返回 |
| UI-019 | 每工作区明确保存idle/loading/refreshing/error、请求ID和错误。刷新保留旧行，失败有局部重试；旧请求/旧bridge不覆盖新状态，后台runtime新事件优先于在途列表旧值 | `UI/store.ts`、`managementState.ts`；`UI/components/SidebarSessionPanel.tsx` | `store.test.mjs`、`management-state.test.mjs` 验证隔离、空列表、晚到成功/失败、bridge替换和summary形状兼容；管理 renderer 验证失败停止loading与本组重试 |
| UI-020 | 全局搜索失败分组本身是可导航option，上下键选择、Enter重试。会话/文件源独立刷新，成功源不清空，查询、选中身份和搜索框保留，请求中禁重复 | `UI/components/SearchDialog.tsx`及`searchDialog.css` | `search-selection.test.mjs` 驱动组件效果与键盘，确认只重试失败源；工作台 renderer 验证失败会话源重试时文件结果持续存在 |
| UI-021 | Git已暂存读取X列，未暂存读取Y列并包含??，MM在两组分别可操作；差异source经preload/IPC传到服务端，默认all保持兼容，选择组展示真实对应差异 | `UI/workbenchReading.ts`；`UI/components/WorkbenchSidePane.tsx`；`Shared/index.ts`；`Desktop/preload/index.ts`、`main/workbenchIpc.ts`、`main/workbenchService.ts` | `workbench-reading.test.mjs`、`workbench.test.mjs`、`workbench-ipc.test.mjs`：真实临时Git仓库MM两类patch互不混入、非法source拒绝；工作台 renderer 检查各状态归组与source请求 |
| UI-022 | 文件列表单Tab入口，方向键/Home/End遍历、Enter/右箭头打开、左箭头/Backspace回父目录；右键/Shift+F10/行尾菜单提供复制路径、编辑器打开及资源管理器定位，失败可见且重试绑定原目标 | `UI/components/WorkbenchSidePane.tsx`；`UI/operationFeedback.ts`；现有工作台打开接口 | 工作台 renderer 验证真实键盘进出目录、菜单对象和Esc返回；`workbench.test.mjs`、`workbench-ipc.test.mjs`覆盖受限读取/打开和错误，保留400项上限说明 |
| UI-023 | 命令输出上滚暂停跟随，回到底部恢复；可复制原文、查找和清空显示，清空不停止运行。120000字符/512事件达到实际裁剪时明确提示；状态单独播报，正文不整段aria-live | `UI/workbenchReading.ts`；`UI/components/WorkbenchSidePane.tsx`、`WorkbenchTextView.tsx`、`workbenchReading.css` | `workbench-reading.test.mjs`验证截断、stderr范围与终态；工作台 renderer 验证流式追加不抢阅读、恢复跟随、裁剪提示、清空与停止 |
| UI-024 | 卡片分开呈现计划启用/暂停与最近完成结果及时间，运行中另有状态和停止。最近结果直接打开并聚焦对应记录，历史可按运行/成功/失败/取消/中断过滤 | `UI/components/AutomationPage.tsx`、`automationPage.css`；`UI/managementState.ts` | `management-state.test.mjs`验证乱序运行、计划隔离和结果过滤；管理 renderer 验证启用与最近失败并存、记录直达及成功过滤 |
| UI-025 | 自动化编辑按做什么/在哪做/何时做分层；默认模型选项折叠，非默认配置展开且摘要可见。时间摘要持续显示明确时区；沿用实际调度输入规则，不自建未来触发计算 | `UI/components/AutomationPage.tsx`、`automationPage.css` | 管理 renderer 验证默认模型无额外配置保存、非默认配置编辑、680px/20px下短窗保存区；后端调度语义仍由既有automation测试负责 |
| UI-026 | 插件详情按扩展/技能/提示词/主题分组计数，正常组可折叠，错误组持续展开，筛选命中自动展开。名称/状态/错误优先，路径按需展开复制，开关和预览保留完整资源身份 | `UI/components/PluginsPage.tsx`、`pluginsPage.css`；`UI/managementState.ts`、`managementCopy.ts` | `management-state.test.mjs`验证30资源唯一分组及错误标记；管理 renderer 检查折叠/筛选、错误可见、路径复制与开关目标一致，含深浅及20px截图 |
| UI-027 | 复用现有组件并共享菜单/表单的最小高度、图文间距、圆角和焦点边框；放大字号可增长。菜单与搜索结果显示时抑制被动Tooltip，保留避让、关闭、焦点和减少动态效果 | `UI/controlStandards.css`、`styles.css`；`UI/components/SidebarPopover.tsx`、`HoverTooltip.tsx`及各私有CSS | 设置/管理/工作台 renderer 提供跨页面截图和键盘交互；设置与工作台场景包含减少动态效果。关键截图已核对，会话场景亦通过 |
| UI-028 | 书签已按用户要求移除；阅读恢复与搜索定位保留 | 书签组件和存储逻辑已删除 | 书签专用用例已删除；会话 renderer 保留阅读、定位和内容操作验证 |

## 验收中定位的修正

本节记录实际验收推动的修正，最终验证已包含以下改动。

- 模型能力标记补齐专用CSS与语义字号；界面字号默认值修复循环变量依赖，提供可用fallback。
- 侧栏安装失败接入全局操作反馈，重试绑定安装操作并去重，进行中明确pending状态。
- 删除确认原先在dialog卸载后通过RAF归还焦点，存在界面已关闭而焦点尚未恢复的窗口。改为先关闭原生模态，再在列表提交的layout effect中恢复相邻行/列表焦点。
- 无runtime覆盖时曾向旧summary附加 `runtime: undefined`，破坏原对象形状。现保持原summary对象及字段缺省，只有有效状态（含显式idle）才覆盖；旧store测试期望保留，并补充兼容回归断言。
- 会话查找索引对齐实际Markdown的GFM→HAST渲染文本路径，避免表格、代码与换行规则造成文字偏移。虚拟列表启用ResizeObserver的动画帧调度，阅读锚点的布局响应也移到RAF，消除观测回调内同步布局引发的循环错误。
- 工作台丢弃确认绑定原cwd和路径；切工作区清空Git确认/编辑状态，以请求令牌隔离旧Git异步结果。导航进行中禁止新Git修改，避免旧操作影响新目标。
- 会话树区分加载失败和分支切换失败，重试绑定失败节点，改选节点清理旧错误；节点类型使用中文/英文名称。
- 旧版书签面板曾调整为会话上方布局；该功能现已移除。消息动作进行中文字可撑开按钮。

## 附件协议与持久化边界

历史快照、事件广播与历史分页继续保留原来的 **8 MiB 附件传输预算**。预算裁剪可省略正文中的图片数据，但保留消息身份、附件原始索引和基础元数据；再次裁剪不重排原始索引。

`getMessageAttachment(sessionPath, messageId, index)` 只在用户请求预览时读取，贯通共享bridge、preload、已认证renderer IPC、agent-host允许列表和活动runtime。两端校验参数；runtime要求请求路径仍为活动会话，消息属于当前分支，索引存在。单次返回载荷最多 **20 MiB**：图片按编码字符串长度计量，文本按UTF-8字节计量；不是“任意20 MiB原始图片均可通过”。允许的图片MIME为PNG/JPEG/WebP/GIF/AVIF/BMP。

无会话、切换中、过期路径、错误分支、无效索引、超限或预览解码失败均只影响本次查看，不使整个历史消息不可用；不修改持久化消息或待发送草稿。renderer mock场景验证加载/重试/切图交互，真实容量与身份拒绝由agent及IPC测试验证。

阅读记忆保存在有容量上限的内存缓存中；UI/内容字号和工作台尺寸使用本机存储。凭据草稿仅驻留内存。未新增跨设备同步、云共享、PTY终端、多窗口或完整IDE等清单外产品能力。

28项曾在本轮既定范围内完成，后续移除项见本文开头；未进行在线模型、真实编辑器启动、真实更新安装或生产自动化任务联调。`function-todo.txt` 不属于本轮实施清单。
