# 会话阅读、定位与内容操作

范围：UI-003、004、005、006、007、015、016、017。UI-028 书签及置顶摘要已按用户要求移除。复用现有历史分页、React 虚拟列表、分支操作和按会话隔离的文本草稿，不创建另一套会话状态。

## 产品规则与状态归属

- **UI-003 阅读记忆**：内存最多保存 100 个阅读位置。身份包括工作区、会话路径和分支尾部消息 ID；记录第一条可见消息 ID、相对视口偏移以及是否跟随底部。活动分支追加消息时迁移当前锚点。返回后尾部变化时，先在当前分支验证旧尾部确实存在，再恢复位置；分歧分支不套用旧位置。锚点不在初始页时使用既有分页补齐。显式搜索覆盖恢复；图片和折叠区域变高时保持阅读锚点，贴底者继续跟随。
- **UI-004 逐词查找**：以消息 ID、正文偏移和该消息内序号标识每次命中。Markdown 索引解析可见正文及代码，链接地址和格式标记不计作正文。CSS Highlight/DOM Range 高亮不改 DOM 文本、Markdown 源码或复制内容；当前命中使用独立颜色。Enter/Shift+Enter 逐词循环，历史前插或追加输出保留稳定命中键；含命中的折叠代码临时展开。原有已加载范围说明、继续加载按钮和轨道标记保留。
- **UI-005 跨历史定位**：全局搜索和阅读恢复共用 `locateHistoryMessage`。逐页加载直到找到稳定 ID、历史耗尽或无进展。任务捕获工作区、会话、导航序号和历史分支代数；切换任一身份或新定位即取消旧结果。显示定位中及未找到状态，失败可重试。先精确 ID，仅在历史耗尽时允许既有瞬时 ID 的片段兼容匹配。分页只改 timelineRevision，不自行递增 historyGeneration。
- **UI-006 失败回答动作**：已有正文始终允许复制。最后一轮回答（包括无正文失败）在 idle 时可以显式重新生成，指定原回答 ID，拒绝旧轮次和 busy 状态；原用户提问和附件由现有编辑/分支路径重发，省略附件从持久记录恢复。纯图片提问也可重新生成。主机故障操作命名为“重新连接 agent”，与模型回答重新生成分开；凭据和上下文问题保留相应配置/整理入口。
- **UI-007 图片预览**：待发送缩略图和历史图片共用原生模态 dialog。提供文件名、适应窗口、100%、25%–400% 缩放、左右切图、加载/失败/重试；Esc 关闭后返回原缩略图焦点。仅查看不改变草稿附件。历史中省略图片携带原附件索引、类型、名称、MIME 和尺寸元数据；点击后才调用受限读取。
- **UI-015 引用选文**：仅接受同一回答正文内的非空选区，拒绝横跨按钮、代码标题等控件的选文。保留选择文本和换行，追加来源消息 ID 及 Markdown 引用到当前会话草稿；已有草稿不覆盖。引用块可检查、单独移除，也可直接在默认多行文本框编辑；不拦截普通复制。
- **UI-016 动作说明**：重新生成使用 rotateCcw，分支使用 gitBranch，HoverTooltip 同时支持鼠标和键盘，解释二者语义。进行中显示文字并阻止重复提交，复制错误和分支结果接入全局操作反馈。原有 hover/focus-within 动作显示保留。
- **UI-017 会话树**：选择节点只显示现有类型、时间、截断摘要；独立按钮确认后才切换。当前路径与当前节点分别标记。初始展开当前路径，提供定位当前节点；左右键展开/折叠或进入子/父节点，上下键和 Home/End 移动焦点。使用单一 Tab 入口和真实 aria-expanded、aria-level、aria-posinset、aria-setsize；20 层缩进视觉上限保持名称可读。运行时仍可读摘要，切换按钮禁用；失败保留目标以重试。

## 附件接口边界

`AgentBridge.getMessageAttachment(sessionPath, messageId, index)` 经 preload、已认证 renderer IPC、agent-host 允许列表到活动 runtime。两端验证索引和字符串形状；runtime 要求请求路径仍是活动会话，并且消息属于当前分支。返回一份独立附件对象，单次编码载荷最多 **20 MiB**，图片 MIME 限制为 PNG/JPEG/WebP/GIF/AVIF/BMP。未初始化、切换中、分支不存在、超限或解码失败只影响该预览。历史广播和分页仍使用原 **8 MiB** 预算；再次预算裁剪仍保留原索引，不改变持久内容。

## 验收证据

2026-09-26 移除书签前：UI、agent、desktop TypeScript 检查通过。以下命令当时 **38 项通过**，当前已删除书签存储用例：

```text
node --test tests/conversation-state.test.mjs tests/store-regenerate.test.mjs tests/store-history.test.mjs tests/transcript-find.test.mjs tests/ui-render.test.mjs tests/run-status-bar.test.mjs tests/history-attachment-preservation.test.mjs tests/agent-history-paging.test.mjs tests/agent-ipc.test.mjs tests/agent-host-protocol.test.mjs
```

| 编号 | 逻辑证据 | 实际 renderer 场景 |
| --- | --- | --- |
| UI-003 | reading cache 分支/项目隔离、容量；既有分页 stale-response 用例 | 中部切会话后锚点偏移恢复 |
| UI-004 | 同回答 3 次、Markdown 链接目标不误计、Unicode 偏移、补页保持键 | 3 个 Range、Enter/Shift+Enter、折叠代码命中 |
| UI-005 | 跨页精确定位、耗尽退出、分支代数变化取消、等待已有分页时 abort | 最新 400 条之外全局搜索；旧响应不拉回新会话 |
| UI-006 | 原附件/省略附件恢复、纯图片轮次、拒绝旧回答和 busy | 部分失败复制；重新生成调用原用户 ID |
| UI-007 | 广播预算、索引跨重复裁剪保留、路径/分支/索引拒绝、20 MiB 限制、IPC认证 | 100%、按需失败重试、多图、Esc 焦点返回 |
| UI-015 | 原草稿、来源、代码空白及可移除引用块 | 选择回答、追加、切会话草稿隔离、移除 |
| UI-016 | SSR 失败正文动作回归、store 再生约束 | 失败复制与再生按钮操作、原生 Tooltip |
| UI-017 | 20 层树、折叠可见性、路径/叶子区别 | Home/Left/End/Tab/Enter 选择再确认 |

真实 renderer 脚本：`tests/fixtures/ui-improvements/conversation.mjs`。书签移除前的验收 `run-MQmWmX` 通过34个交互断言，生成7张截图；错误检查为空，隔离测试进程清理成功。该报告包含GFM可见正文与DOM高亮一致、图片实际缩放、分支失败重试原节点和已移除的书签布局。当前场景已删除书签部分，此旧报告不代表移除后的界面验收。虚拟器与锚点布局按动画帧处理，ResizeObserver循环错误已消除。关键截图已核对，完整证据见 [总体验收记录](../UI_IMPROVEMENTS_2026-09-26.md)。

移除后的会话场景 `run-XeiUsS` 通过 31 个交互断言并导出 5 张截图，报告的 `cleanupError` 为 null。
