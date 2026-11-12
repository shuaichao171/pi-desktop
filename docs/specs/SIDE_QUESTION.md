# 侧问（Side Question）

借鉴 Claude Desktop 的 `side_question`（参考 `reference/claude-desktop-reverse/CONVERSATION-UI.md` §3.4/§4：`POST …/side_question`，body 含 `question / btw_history / parent_message_uuid / model / thinking_mode`）：挂在某条消息下的一次性旁路问答——用父消息附近上下文回答一个问题，答案挂在该轮 UI 下方，**不进入主对话上下文**。

## 方案取舍

调研结论（实现前必读）：

1. **Pi SDK 完全支持并发会话**。每个 `AgentHostClient` 各自 fork 一个 utility process；自动化执行器（`automationExecutor`）就是每次运行拉起一个独立 host + 新会话的先例。原设想「后台临时 Pi 会话」可行。
2. **但有更轻的原语**：`session.modelRuntime.completeSimple()` —— 一次独立模型调用，不经会话转录。`generateCommitMessage` / `suggestNextInput` 已用一个先例（注释明确："Standalone LLM call: never touches the session transcript, so it is safe even while a conversation turn is streaming"）。

因此 MVP 采用：**侧问 = completeSimple 单次调用**，而非临时 Pi 会话。理由：

| | 临时 Pi 会话 | completeSimple（采用） |
| --- | --- | --- |
| 主会话隔离 | 需另建会话文件、事后清理 | 结构性保证（无转录写入） |
| 主对话流式中可用 | 是 | 是（先例注释背书） |
| 资源开销 | 每问 fork 一个进程 + 会话 IO | 一次 HTTP 请求 |
| 附带产物 | 会话文件残留在列表 | 无 |
| 工具调用能力 | 有（Pi 全量工具） | 无（纯问答，符合侧问定位） |

代价：侧问中**模型不能读文件/跑命令**（纯上下文问答）——这正是「旁路问答」的定位，记为已知限制。

## 入口与交互（MVP 范围）

- 入口：用户消息/助手回答悬停操作行的「侧问此轮」（spark 图标）。助手消息点击时锚点解析为其所属轮次的**用户消息**（`sideQuestionAnchorFor` 回溯最近前置用户消息；无前置用户消息时点击无操作）。右键菜单未做（悬停按钮 + 键盘可达已覆盖入口，见限制）。
- 输入：锚点用户消息下方**内联展开**的非模态输入框（textarea + 模型选择 + 提问/取消）。Enter 提问、Shift+Enter 换行、Esc 关闭。模型默认当前会话模型，可改选（已配置供应商的可用模型）。
- 卡片：提问后在同一位置出现折叠卡片，运行中显示 spinner + 计时；完成后自动展开一次（Markdown 渲染复用 `ConversationMarkdown`），再点击折叠/展开。
- 卡片操作：复制答案、重新问（原问题预填回输入框，提交**复用同一记录 id** 原位重跑）、删除记录；失败显示错误 + 重试按钮（同 id 重跑）。
- 边界：同一轮可并存多条侧问；侧问运行中主对话可继续（含流式中提问）；每会话记录上限 200 条（超出丢最旧）。

## 上下文切片规则

渲染端用 `packages/ui/src/sideQuestionContext.ts`（纯函数，有单测）从**已加载的转录窗口**拼装：

- 轮次 = 一条用户消息及其后的助手回复直到下一条用户消息；只取 user/assistant 文本（系统/插件通知不进切片）。
- 窗口 = 锚点轮 + 前 1 轮 + 后 1 轮（`SIDE_QUESTION_TURNS_BEFORE/AFTER`）；**前轮优先于后轮**（btw_history 语义）。
- 预算：整段 24,000 字符（`SIDE_QUESTION_CONTEXT_LIMIT`），单条消息 10,000（`SIDE_QUESTION_MESSAGE_LIMIT`）。
- 分配从内向外：放不下的整轮丢弃；锚点轮自身超预算时按消息截断，**每条消息保留结尾**（问句与结论通常在末尾，与对话引用 `readSessionContext` 的取尾规则一致），标注 `[beginning omitted]`。
- 任一丢弃/截断 → `contextTruncated` 标记，卡片上显示「上下文已截断」。
- 更早历史若未加载（分页窗口之外）天然不在切片内（见限制）。

提示词拼装在 `packages/agent/src/sideQuestion.ts`：系统提示词声明旁路通道约束（只依据片段回答、不进入主对话、用提问语言、简洁）；用户消息 = `<<<CONVERSATION … CONVERSATION>` 引文 + 问题。超时 180s（`SIDE_QUESTION_TIMEOUT_MS`）。

## 存储格式

- 文件：`<userData>/side-questions.json`，`{ version: 1, records: Record<sessionPath, UiSideQuestion[]> }`（`packages/desktop/src/main/sideQuestionStore.ts`，与 `conversationBranchStore` 同模式：原子写、损坏备份后重建、单例懒加载）。
- 记录字段见 `UiSideQuestion`（shared）：`id`（渲染端生成 UUID，乐观更新与重跑幂等）、`anchorEntryId`（锚点用户消息 entry id）、`question/answer/status/error`、`model*`、`contextTruncated`、`createdAt/finishedAt`。
- **Pi 会话文件永不含侧问内容**；会话删除时 `sideQuestionStore().clear(path)`。
- 分支安全：卡片按「锚点 entry id 存在于当前可见分支」渲染，切到其他分支自然隐藏，切回恢复；被编辑/fork 抛弃的旧分支上的记录不再显示（存储仍在，直至会话删除或手动删卡）。
- 跨窗口同步：主进程每次记录变更向所有 renderer（含分栏 pane、pai 窗口）推送 `side-questions:changed {sessionPath, records}`；展示该会话的 store 原子替换列表。渲染端本地乐观插入 `running` 记录，invoke 回执与推送按 id 幂等 upsert；删除与晚到的完成写入竞争时**删除获胜**（主进程写回前检查记录仍存在）。

## 通道

`packages/shared/src/sideQuestions.ts`：

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `side-questions:list` | renderer → main | 取某会话记录（ready/bootstrap 时恢复） |
| `side-questions:ask` | renderer → main | 校验（`requireSideQuestionAskRequest`）→ 记录 running → `answerSideQuestion` → 落盘 + 推送 → 返回终态记录 |
| `side-questions:delete` | renderer → main | 删除记录并推送 |
| `side-questions:changed` | main → renderer | 记录集变更推送 |

`answerSideQuestion` 经 agent host 协议（`AGENT_HOST_METHODS`）路由到发起窗口自己的 host（`agentFor(event)`），在 `SingleAgentService` 内校验 `sessionPath` 未切换、解析模型（请求指定或会话默认）后 `completeSimple`，返回答案与实际模型。host RPC 超时 300s 档。

## 已知限制

- **无 token 流式**：答案整体返回（卡片只有进行中状态 + 完成展开）。流式需经 host 协议新增事件通道，留待后续。
- **无思考档位控制**：侧问调用不传 reasoning（Claude 的 `thinking_mode` 对应项未接）。
- **无工具调用**：模型只依据切片回答，不能读文件/执行命令。
- 切片只覆盖已加载转录窗口：锚点靠近窗口顶端且更早历史未加载时，前 1 轮可能缺失（标注截断）。
- 锚点是用户消息 entry id：对尚未落盘的乐观用户气泡提问，其后 id 被替换时该卡片不再显示。
- 右键菜单入口未做（悬停按钮已覆盖）；侧问不能引用除切片外的其他上下文（文件、其他会话）。
- 会话文件被外部移动/改名后记录按旧路径失联（与 conversationBranchStore 同限制）。

## 验证入口

- `tests/side-question-context.test.mjs`：切片纯逻辑（锚点解析、窗口顺序、系统行过滤、预算丢弃、取尾截断、前轮优先）。
- `tests/side-question-prompt.test.mjs`：提示词拼装与答案清理。
- `tests/side-question-store.test.mjs`：状态文件损坏备份、round-trip、同 id upsert、删除、清空。
- `tests/side-question-actions.test.mjs`：渲染 store 动作（乐观 running、按 id 落定、失败记录、跨会话推送过滤、重跑复用 id、删除）。
