# 子代理展示：Codex 参考与 Pi Desktop 实现

## 参考依据

对用户提供的 Codex 桌面版解包产物作静态分析，未启动 Codex 验证运行时界面。

| 取样模块（`webview/assets/async/`） | 定位点 | 观察 |
| --- | --- | --- |
| `829094.45a3083a2b.js` | `LocalConversationSubagentsPanelTab`、`bw7M`、`PTLI` | 右侧面板按 Active / Done 分组；头像、名称、状态、耗时和单行任务预览组成可点击列表；详情在同一面板内切换，并提供返回列表入口。 |
| `225284.63835849b6.js` | `subagent-activity-row`、`function aU` | 主聊天以轻量活动行记录开始、更新、中断和完成，允许查看时打开代理详情。 |
| `312348.56a643050a.js` | `openLocalConversationSubagentsPanel`、`collabAgentToolCall` | 父子线程 ID 关联 spawn / wait / sendInput 等事件与线程缓存，保留名称、任务和模型信息。 |

REA 对 `312348`、`829094` 两个模块的定向分析证据：`ev_818f4081b8e7d9b33e04d2f7fafdf6107fab08e1d31fb5dec3d6ea2d6172086e`；摘要视图：`ev_77e4e9e153f3020d3421485e850ffed7225025ebfbe9361f28494f0c9b4ce062`。其余未选中模块和动态模块关系不在该分析的覆盖范围内；行内活动模块另经人工静态阅读。

## Pi Desktop 中的设计

- 输入框上方保留子代理摘要、数量和头像，点击打开右侧面板。
- 列表分为“进行中 / 已结束”，保留各组内后端提供的稳定顺序；活动状态变化后进入对应分组。工作流子步骤保留层级。
- 点击代理进入任务、Markdown 对话记录和最终输出；返回按钮回到列表。
- 聊天中的委派记录默认收起，显示名称和简短任务；存在准确匹配的 run ID 时可直接打开对应详情。
- 复用现有 `subagent-fleet`、`subagent-inspect` 数据和插件命令。任务、模型由相同 run ID 的现有工具记录补充，不推测缺失数据。
- 宽屏并排显示聊天与 360px 侧栏；工作区宽度不超过 820px 时改为覆盖式侧栏。
- 详情按需读取并提供刷新，不自动轮询完整对话。状态和耗时仍实时更新。

## 交互边界

- 每条操作分别检查对应插件命令是否存在。
- 检查子步骤时发送父 run ID 和 child ID；引导和停止只用于插件支持的根任务。
- 通过 request ID 匹配详情回复，保留已接收的当前回复，忽略其他请求的迟到回复。
- 15 秒无回复后结束加载并允许刷新；执行失败保留引导输入。
- 切换会话清空当前选择和详情，旧操作完成后不影响新会话。
- 面板支持 Escape 关闭、焦点返回、键盘操作和减少动画偏好。

## 验证

```sh
pnpm --filter @pidesktop/ui typecheck
pnpm --filter @pidesktop/desktop build
node scripts/run-tests.mjs tests/subagent-activity.test.mjs tests/subagent-fleet-order.test.mjs tests/ui-render.test.mjs tests/transcript-find-domain.test.mjs
node tests/fixtures/model-settings/run.mjs --run --scenario=../ui-improvements/subagents.mjs
```

界面场景使用专用无头浏览器与模拟 bridge，不调用模型，不接触用户会话。覆盖列表、对话查看、迟到回复、工作流子步骤、操作目标、实时完成、会话切换、超时恢复、缺失命令、宽屏和窄屏布局。
