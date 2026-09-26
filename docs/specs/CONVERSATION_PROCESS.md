# 对话过程与计时

按轮组织中间输出、模型接口实际提供的思考文本和工具调用，运行时默认展开，整轮终止后默认收起；最终回答位于过程之外，始终可见。用户提问、引导消息和系统通知保留原有时间线位置。

## 参考与交互

参考本地 `D:\codex-re` 的 v26.917.51856 样本：`conversation-blocks-ca975d4c03b3.js` 中的过程披露、`split-items-into-render-groups-4c3c347efa8d.js` 中最终回答与过程项分组、`tool-activity-disclosure-9801aeab4a7c.js` 的运行/完成展开状态，以及 `app-initial-78d977413c37.js` 的运行计时。

Codex 样本在最终回答开始时结束过程计时。本项目按用户“整个流程结束后”的要求，计时与自动折叠均等待 SDK 整轮结束；单条助手消息结束、开始调用工具或开始最终正文均不结束整轮计时。

- 首个字出现前即显示“进行中”和耗时，每秒刷新；完成后使用保存的结束时间，数字不再增长。取消、失败、异常中断使用不同状态文案。
- 每轮有独立的过程总开关。运行时手动收起不被增量更新打断；完成时自动收起，之后可再次展开。切换到其他会话不会继承该会话的披露选择。
- 思考内容保留独立开关，首个正文字和后续工具不会重建思考组件、重置用户选择。只显示模型接口提供的可见内容，沿用现有 redacted/签名过滤。
- 工具使用本地化动词和简短摘要，保留未知工具名称。展开可看完整命令、实时输出、失败说明、文件路径和差异；支持命令复制、输出复制、自动换行与长输出展开。
- 搜索命中的中间正文自动展开所在过程，再定位实际正文。折叠内容从键盘导航和阅读锚点选择中排除。最终回答保留复制、引用、重新生成和分支操作。
- 长历史继续使用分页与顶层虚拟列表；默认收起的历史过程延迟挂载。同一虚拟行内收起后保留内部组件，避免丢失工具阅读位置；整轮、思考和工具的披露选择缓存在虚拟行之外，即使滚动卸载再返回也不重置。已处理的导航请求不会因重挂载而重播。

## 生命周期与持久记录

`UiConversationRun` 保存稳定 ID、`startedAt`、可空 `finishedAt` 和 `running/completed/cancelled/failed/interrupted` 状态；消息与工具以可选 `runId` 关联。实时 `run` 事件及 `ready`、快照、历史分页使用同一份运行记录。

开始边界为闲置请求进入准备阶段，结束边界为 SDK `agent_settled`（或明确的准备失败/取消）。工具多轮、自动重试、当前任务引导共享同一运行。排队 follow-up 在实际消费时开始下一轮，排队等待不计入下一轮耗时。准备阶段取消后不会在认证/钩子返回时继续派发模型。

使用 Pi JSONL 隐藏 custom entry 保存开始与结束，不注入模型上下文，不显示在会话树。后台会话、历史分页和重启恢复按当前选中分支读取；分支截断或异常退出缺少结束记录时显示“运行中断”，不猜测截止时间。旧历史没有记录时不生成假耗时。最新一次首 token 前的失败/停止即使没有正文，也保留独立状态摘要。

## 验证

- `tests/conversation-runs.test.mjs` 使用真实 Pi SDK 与 JSONL、本地模拟模型流，验证首 token 等待、多轮工具、排队/引导、自动重试、取消、失败、后台切换、分页、分支及重启。未调用线上模型服务。
- `tests/conversation-process.test.mjs` 验证按轮分组、最终回答、首 token 前终态、store 事件与历史合并。
- `tests/tool-activity.test.mjs` 验证轻量工具列表、完整命令与思考内容渲染。
- `tests/fixtures/conversation-process/scenarios.mjs` 在独立 headless Chromium 中操作实际生产 renderer，验证实时计时、终态冻结、自动折叠、思考手动选择、工具详情/复制、搜索、恢复、会话隔离及深浅色/窄屏布局，并导出截图。
- `tests/fixtures/ui-improvements/conversation.mjs` 回归正文查找、选文引用、附件预览、阅读恢复、会话树及跨页定位。

所有界面场景仅启动专用测试浏览器，在成功或失败后关闭所属进程、移除临时 profile，不操作用户已有窗口。

2026-09-26 最终验证：agent、UI、desktop main/web 类型检查与生产构建通过。`node --test --test-concurrency=4 tests/*.test.mjs` 共 587 项，585 通过、0 失败、2 跳过（Windows 文件符号链接权限和 Unix 进程组专项）。完整日志：`out/review/conversation-full-tests.log`。

生产 renderer（`index-eucxZZdO.js` / `index-CE8Uh6fu.css`）的过程场景 `run-q2wOE8` 通过 30 个行为断言、导出 9 张截图，含 160 轮虚拟卸载往返；既有会话场景 `run-E8C8y5` 通过 34 个断言、导出 7 张截图。深浅色、680px 窄窗口、运行/终态/展开历史已看图检查。报告位于 `out/review/model-settings/runs/`，无 renderer 异常，测试浏览器及临时 profile 均已清理。
