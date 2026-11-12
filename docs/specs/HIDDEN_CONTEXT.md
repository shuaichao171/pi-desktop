# 会话隐藏上下文（Hidden Context）

借鉴 Claude Desktop 的 hiddenContext（自然语言指令注入上下文但不显示在消息流）：每个会话一份多行指令，随每次发送注入该会话的**系统提示词**，消息流里不出现、也不追加进用户消息文本。

## 注入点论证（调研结论，实现前已验证）

调研路径：`bridge.prompt` → 主进程 IPC（`agentPrompt`）→ agent host（`AgentService.prompt` → SDK `AgentSession.prompt`）→ `before_agent_start` 扩展事件 → 系统提示词组装。

| 候选注入点 | 结论 | 证据 |
| --- | --- | --- |
| `AgentSession.prompt(text, options)` 的参数 | **不存在** system 补充参数 | `PromptOptions` 只有 `expandPromptTemplates / images / streamingBehavior / source / preflightResult`（SDK `agent-session.d.ts:176-187`） |
| `completeSimple({ systemPrompt })` | 仅适用于独立模型调用（`generateCommitMessage` / `suggestNextInput` / 侧问先例），主对话不走它，不可用 | `packages/agent/src/index.ts:1440/1477/1507` |
| resource loader 的 `appendSystemPrompt` / `sections` | 会话创建期一次性注入，运行中改指令需要整段重建；且与用户全局配置合流进同一 `addendum` 段 | `resource-loader.d.ts:88-123`、`system-prompt.d.ts:24` |
| **`before_agent_start` 扩展事件（采用）** | 每次运行开始都触发，事件携带**可变的** `systemPromptOptions`（`NormalizedBuildSystemPromptOptions`），就地改 `sections` 后 SDK 在本次请求生效 | SDK `extensions/types.d.ts:718-726`；文档原文："Prefer changing prompt sections … so Pi can append a transcript delta" |

采用方案：pi-desktop 自有隐藏扩展 `desktop-hidden-context`（与 `desktop-file-changes`、`desktop-mcp` 同一注册模式，`createAgentSessionServices` 的 `extensionFactories`，`hidden: true`），在 `before_agent_start` 里把指令写进 `systemPromptOptions.sections['session_instructions']`。

选 `sections` 而非 `appendSystemPrompt` 的理由：独立段落有自己的 tag，与用户配置的 `addendum` 段互不干扰；指令增删时 SDK 的段落 diff 只 patch 这一段（`diffSystemPromptSections`，删除输出 `null` 值）。段名必须匹配 `^[a-z][a-z0-9_-]*$` 且不得为 `preamble`（`system-prompt.js:6`），测试已固化。

### 注入后的去向（诚实披露）

- SDK 把段落渲染进本次请求的系统提示词，并以**结构化 system 段落增量**（`SystemMessage.sections`）追加到 Pi 会话转录（`agent-session.js:_prepareRun → _preparePromptAndToolLoadout`）。即：**Pi 会话文件里能看到该段落**（审计友好），但 pi-desktop 的时间线投影只渲染 user/assistant 与特定 custom 条目，**消息流不显示**（`packages/agent/src/index.ts` `historyTimeline` 无 system 行投影）。
- 会话内指令修改后，下一个 run 的 diff 会把 `session_instructions` 段 patch 成新值；清空后 patch 为 `null`（模型不再看到），历史增量保留在转录里（可追溯何时改过）。
- `exportToHtml` 会导出**当前完整 system prompt**（`session-export.js` 里 `systemPrompt: state?.systemPrompt`），因此**HTML 导出包含指令文本**——导出文件给他人前请注意。JSONL 导出按条目序列化，同样包含 system 段落增量。
- 压缩（compaction）不丢系统提示词：投影保留 `getCurrentSystemMessage`，每个 run 开始都会按 base+handler 重推导，自愈。

## 存储与进程拓扑

- 文件：`<userData>/hidden-context.json`，`{ version: 1, contexts: Record<sessionPath, string> }`。**键 = 规范化 sessionPath**（`normalizeSessionPath` = 绝对路径 `resolve()`，与 conversationBranchStore / sideQuestionStore 相同；渲染端拿到的 sessionPath 本就来自 host 的 SDK 解析路径，两端一致）。
- 写入方**只有主进程**（`HiddenContextStore`，损坏先备份 `.corrupt-*.bak` 再重建，空串即删键，store 层把单条上限钳到 8000，见 `stateFiles` 惯例）。
- agent host 是**只读**读者：fork 时主进程经 `PI_DESKTOP_HIDDEN_CONTEXT_FILE` 环境变量传入路径（与 `PI_DESKTOP_ENGINE_DIR` 同一通道），注入时按当前 `sessionManager.getSessionFile()` 取值，每次 `before_agent_start` 现读（≤8KB JSON，开销可忽略；原子写保证不会读到半截）。host 读失败一律按「无指令」处理（fail-open），绝不阻塞发送，也不在 host 侧备份/写回。
- 会话删除：`sessionDelete` 处理器与 branch/sideQuestion 同点调用 `hiddenContextStore().clear(target)`（主进程拒绝删除已加载会话，因此无需 changed 广播）。

## 上限与校验

- 上限 **8000 字符**（`HIDDEN_CONTEXT_MAX_CHARS`）。渲染端 IPC 边界**拒绝**超限输入（`requireHiddenContextText`，报错「隐藏指令不能超过 8000 字符」），store 层再钳制一次作为纵深（手改文件、旧写入方）。编辑器显示 `当前/8000` 计数，超限时保存按钮禁用。
- 允许任意多行文本（含换行/制表），仅拒绝 `\0`。

## 透明度与交互（MVP）

- **指示器**：会话已有文件即常驻 Composer 工具栏左侧（`+` 旁）：激活（有非空指令）时显示小眼睛，悬停提示「本会话含隐藏指令」；未激活时显示弱化（半透明）的「眼睛关闭」图标，悬停提示「未设置隐藏指令」，点击同样打开编辑器——首条消息后即可新增，不存在「无指令→无入口→无法创建」的自举死角。
- **查看/编辑**：点击眼睛在 Composer 内联展开编辑面板（textarea + 字符计数 + 保存/清除/取消）。内容只在用户显式点击后展示（渲染端 store 平时只持有会话现值，用于指示与编辑种子）。Esc/取消关闭；会话切换自动收起（防串会话保存）。
- 保存即生效于**下一次发送**；正在流式中的本轮不重注入（转录里已有本 run 的段落）。
- 多窗口/分屏：`hidden-context:changed` 广播让同会话的其他窗格同步指示器与编辑种子。

## 已知限制

- **全新会话（尚无会话文件）不能设置**：Pi 的会话文件在首条用户消息后才创建（`session-manager.js: _persist` 的 `_hasConversation` 门槛），键无处可挂。首条消息发出后的下一次 ready（每轮 settle 都会 resync）指示器即可用。
- 侧问（side question）走 `completeSimple` 独立调用，**不注入**隐藏指令（它不经 `before_agent_start`）；如需覆盖，需在侧问的 systemPrompt 拼装处另行接入（未做）。
- HTML/JSONL 导出包含指令文本（见上）；跨设备同步：`hidden-context.json` 属本机 `userData`，**不随** Pi 会话文件或云同步走——在新机器上打开同一会话（若会话目录共享）不会自动带回指令，需重新设置。
- 指令对模型的约束力是提示词层面的，无硬保证（与所有系统提示词同）。
- 指令原文未做 XML 转义：含 `</session_instructions>` 或伪造段落标签的文本可在本会话系统提示词内越段（写指令者即会话所有者，无跨会话影响；SDK 对 `project_context` 段同样原样嵌入，属先例内的同等暴露）。
