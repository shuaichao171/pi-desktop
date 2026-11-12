# 会话内查找（Find in Transcript）

借鉴 Claude Desktop 的 find_in_page（参考 `reference/claude-desktop-reverse/CONVERSATION-UI.md`：会话内查找 + 折叠内容的 `data-find-omitted` sr-only 占位）：在当前会话转录内查找并逐个定位命中，折叠/省略的内容同样可查。与顶部全局搜索（`indexedSearch`）互不相干——全局搜索跨会话找文件与历史，本功能只在**当前会话的已加载转录窗口**内检索。

## 入口与交互

- `Ctrl+F`（快捷键 `findInTranscript`，见 `packages/ui/src/shortcuts/bindings.ts`）打开**内联**查找栏（`TranscriptFind`，非模态，仓库惯例不开模态框）；再次 `Ctrl+F` 重新聚焦并全选已有查找栏（`focusRequest` 递增计数）。
- 输入即搜：实时显示「当前第 n / 共 m」（`chat.find.count`）。`Enter` 下一个、`Shift+Enter` 上一个，循环切换（`stepFindIndex` 的环形步进，空结果与陈旧索引钳制到首个命中）；工具栏按钮同效。
- `Esc` 关闭：焦点在查找输入框内时由输入框处理；焦点在查找栏与可编辑区域（输入框 composer、设置字段等）之外时由全局 keydown 兜底关闭，不干扰 composer 自身的 Esc 语义（取消召回 / 停止生成）。关闭后焦点回到 composer。
- 命中定位：跳转（虚拟化时先 `scrollToIndex`）到所属行并高亮——当前命中 `is-search-match`（实线描边 + CSS Custom Highlight `pd-find-current`），普通命中 `is-find-match`（虚线描边 + `pd-find-all`）。消息正文内命中用 `::highlight` 精确到词；轮次级命中（工具标题）高亮落在轮次摘要行。
- 双范围：`对话` / `变更`（变更范围在本次对话记录的文件差异中检索，见既有实现）；本文档只描述对话范围。
- 未加载的更早历史不在域内：查找栏显示「仅搜索已加载的 N 条消息」并提供「加载更早内容」按钮（分页加载后命中自动并入）。
- 会话切换 / 重置清空查找状态（`ChatView` 内以 `[cwd, sessionId, sessionPath]` 为键的 effect，语义同 store 的 `sideQuestionTarget` 清理）。

## 搜索域（v1）

域 = 当前会话**已加载转录窗口**内、按时间线顺序（`buildConversationTimeline`）枚举的：

1. **用户 / 助手 / 系统消息文本**（`findOccurrences` / `searchableMessageText`：助手消息按渲染管线做 GFM→HAST 归一化，使「可见文本」而非 Markdown 源码参与匹配）。
2. **工具活动标题**（`toolFindText`：工具种类名 + 标题行——命令 / 原始 title / 涉及文件列表，子代理另含 agent 名与任务；各部分以换行分隔，短语不会跨部分拼接出假命中）。

匹配规则：大小写不敏感（Unicode case folding，`giu`）、**纯子串**（查询按正则元字符转义，不支持正则语法）。

**不在域内（v1 限制，明确记录）：**

- 工具**完整输出**（`detail` / `diff` / 长输出的「显示全部」尾部）不进搜索域——体量大、截断策略与传输上限（IPC 前裁剪）使其不适合作为可靠搜索域；用户可在命中工具标题后展开查看原文。
- 助手**思考文本**（`message.thinking`）v1 不进搜索域（`searchExpands` 的展开判断仍会考虑 thinking，但计数域不含它）。
- 排除项：插件通知（`systemKind: 'extension-notice'`，瞬态弹卡，不是转录行）；工具活动输出的「最近输出」滑窗。
- 变更范围只检索记录的文件差异，与本文对话范围互补。

## 折叠内容与占位机制（data-find-omitted）

折叠 / 省略现状（实现时核实）：

- **轮次过程折叠**（`ConversationTurn`）：整轮结束后工具活动 + 过程消息（含思考）折叠进 `ActivityDisclosure`；从未展开过的轮次内容**完全不在 DOM**，展开过的内容仍在 DOM 但 `inert` + `aria-hidden`。
- **长用户消息折叠**（`UserMessageText`）：`maxHeight` 裁剪，文本仍在 DOM；命中时 `forceExpanded` 自动展开。
- **系统通知**（`SystemMessageItem`）：`<details>`，正文在 DOM；命中自动 `open`。
- **思考折叠**（`ThinkingActivity`）、**工具输出折叠**（`ToolActivityItem`）：`ActivityDisclosure` 保持挂载但折叠。

占位机制（对应 Claude 的 `data-find-omitted` sr-only 占位）：

- 折叠轮次（`hasProcess && !expanded`）渲染 sr-only 占位（`omittedFindText`：工具标题行 + 过程消息文本，按序拼接，总量封顶 `OMITTED_FIND_TEXT_LIMIT`=4000 字符加省略号；封顶只影响占位文本的屏读体量，**不影响命中**——匹配枚举是数据驱动的，不依赖 DOM）。
- 占位对屏幕阅读器友好：折叠期间过程内容不在可访问树（未挂载或 `aria-hidden`），占位是其唯一可读表示，前置本地化标签 `chat.find.omittedLabel`（「已折叠的工具与过程消息：」）；轮次展开后占位随之消失，避免重复朗读。
- 命中折叠内容（工具标题 / 折叠的过程消息）时：定位到所属轮次（`data-turn-id` 行 + `entryContainsRow` 虚拟化解析），`searchExpands` 检测到命中后自动展开该轮，用户即可看到原文。
- 匹配枚举（`transcriptFindMatches`）与 UI 状态（当前命中、命中集合）完全由数据模型驱动：消息命中按消息 id 定位（`findMatchSet`），工具标题命中按轮次 id 定位（`findTurnIds`）。

## 实现位置

| 关注点 | 位置 |
| --- | --- |
| 纯逻辑：域枚举 / 工具标题 / 环形步进 / 占位文本 | `packages/ui/src/transcriptFind.ts` |
| 消息文本归一化与匹配 | `packages/ui/src/conversationState.ts`（`findOccurrences` / `searchableMessageText`） |
| 查找栏 UI（计数、步进、加载更早、双范围） | `packages/ui/src/components/TranscriptFind.tsx` |
| 接线（Ctrl+F / Esc、跳转、高亮、会话切换重置、轨道标记） | `packages/ui/src/components/ChatView.tsx` |
| 轮次折叠 / 占位渲染 / 自动展开 | `packages/ui/src/components/ConversationTurn.tsx` |
| DOM 高亮（CSS Custom Highlight API） | `packages/ui/src/transcriptSearch.ts` |
| 行级样式（`is-search-match` / `is-find-match` / `.pd-find-omitted`） | `packages/ui/src/components/conversationTurn.css`、`transcript.css`、`conversationEnhancements.css` |
| 快捷键 | `packages/ui/src/shortcuts/bindings.ts`（`findInTranscript`，Ctrl+F） |
| 测试 | `tests/transcript-find-domain.test.mjs`（纯逻辑 + 接线约定）、`tests/transcript-find.test.mjs`（查找栏 SSR）、`tests/conversation-state.test.mjs`（消息文本匹配） |

## 限制与已知问题

- 工具完整输出、思考文本不进搜索域（见上）；后续版本可把思考并入域（需同时处理 `ThinkingActivity` 折叠展开与 ordinal 涂色）。
- 工具标题命中在轮次级高亮（摘要行描边），不做工具行内逐词 `::highlight`（标题位于 `<button>` 内，与消息正文的涂色管线不同）。
- 虚拟化窗口外的命中依赖 `scrollToIndex` 挂载后定位（与消息跳转同路径）；`webContents.findInPage`（Electron 原生）未使用，避免与自绘高亮冲突。
- 变更范围（diff 检索）不在本文档范围。
