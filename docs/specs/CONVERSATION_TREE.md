# 会话消息树与分支导航

对话不是线性数组而是一棵消息树：编辑重发、重试、fork 都产生兄弟分支，旧回答永不丢弃；有分支的轮次显示 ‹ k/n › 切换器，切换即把下方消息列表重放为该分支路径。（设计借鉴 Claude Desktop 逆向结论。）

## 与 Pi 会话模型的关系（调研结论）

Pi 的会话文件（`~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`）本身就是**追加式条目树**，不是线性日志：

- 每条 entry 都有 `id` 与 `parentId`（`SessionManager`，见 SDK `session-manager.d.ts` 的 "append-only trees" 注释）；
- 内存中有一个叶子指针 `leafId`，`appendMessage` 总是挂到当前叶子下；重载时 `leafId = 文件中最后一条 entry`（即"最后追加的分支获胜"）；
- `AgentSession.navigateTree(targetId)` / `SessionManager.branch(branchFromId)` 把叶子移到历史条目上，**不修改、不删除任何既有 entry**，下一条消息自然长出新分支；
- `navigateTree` 指向用户消息时叶子落在其父节点（编辑语义：新消息成为旧消息的兄弟），指向其他条目时叶子落在该条目上（查看语义）。

因此分支语义取**真分支**（同一会话文件内的 entry 树），不 fork 出新会话文件、不需要前置上下文摘要：

| 能力 | 结论 |
| --- | --- |
| 从某条消息恢复出新分支 | 原生支持（`navigateTree` → 下次追加成为兄弟子树） |
| 旧回答保留 | 原生支持（append-only，永不改写） |
| 树结构与分支枚举 | 原生支持（`getTree()`/`getChildren()`/`getBranch()`；pi-desktop 经 `getSessionTree()` 投影为 `UiSessionTreeNode[]`） |
| "正在查看哪个分支"的持久化 | **Pi 不支持**（重载总是回到最后追加的分支）→ pi-desktop 自建存储（见下） |

已存在的入口（本功能沿用，不重复造）：编辑重发（`editUserMessage`，旧回答保留为兄弟分支）、重新生成（`regenerate`，同样走编辑路径）、回答级 fork（`forkAssistantMessage`）、会话树面板（`SessionTreePanel`）。

## 数据模型（`@pidesktop/shared/conversationTree.ts`）

纯逻辑模块，不碰 IO，主进程与渲染层共用；输入是 `getSessionTree()` 的 `UiSessionTreeNode[]`（或线性消息列表的降级投影）：

- `flattenSessionTree` / `activeTreeLeafId`：拍平 + 当前可见叶子（路径上最后一个 `active` 节点）。
- `buildConversationTreeIndex(nodes)` → `{ forks, byForkId, leafId, parentOf, leafCount }`：
  - **分叉点（fork）**= 可见路径上拥有 ≥2 个子节点的 entry（多个根节点视为 `forkId: null` 的根分叉）；
  - 每个子节点子树是一个**可选分支**（`UiBranchAlternative`）：`id`（子树头）、`targetId`（子树最末端 entry，即"最后追加"的后代，按 timestamp、平局按先序）、`active`（可见分支是否经过它）、`label` 优先取子树内第一条用户消息（编辑分支的实际内容）；
  - 分叉按路径顺序（根→叶）排列，对应切换器在正文中的位置。
- `branchPathIds` / `isOnBranchPath`：路径成员判定（恢复记录时区分"记录点是当前叶子的祖先"与"真正换支"）。
- `selectedChildrenByFork(index, leafId)`：Claude 式 selectedChild 投影（每个分叉点选中的子节点）。持久化只需存叶子 id（全路径可推导），此函数是文档化与测试用的投影面。
- `treeFromLinearMessages(messages)`：从线性消息列表构建单路径树（keep-warm 预览等无树场景的降级，恒无分叉）。

## 交互

- **切换器**：`BranchSwitcher`（‹ k/n ›）渲染在分叉点条目所在行/轮的**正下方**——编辑分支时即上一条回答（或会话开头）与被编辑消息的交界处。根分叉渲染在消息列表顶部。按钮可独立聚焦；分组支持 ←/→ 切换；`aria-label` 报告"分支 k/n"。
- **切换语义**：调用 `switchSessionBranch(targetId)`，`targetId` 为目标子树末端；Pi 把叶子移过去，随后 host 重发 `ready`，渲染层消息列表整体替换为该分支路径。切换要求会话空闲（运行中被禁用）。
- **头部状态**：`ConversationHeader` 显示分支徽标（gitBranch 图标 + 叶子路径数，≥2 才显示），即当前会话的分支总量。
- 会话树面板（ChatHeaderMenu → 会话树）保留完整树浏览；其切换同样走 store 动作以保持记录一致。

## 持久化（pi-desktop 自建，不改 Pi 会话文件）

- 主进程 `conversationBranchStore.ts`：`userData/conversation-branches.json`，`会话文件路径 → 上次查看的叶子 entry id`；随会话删除清理。
- IPC：`agent:get-branch-selection` / `agent:set-branch-selection`（`AgentBridge` 上为可选方法，兼容旧桥）。
- 渲染层（`store.ts`）：
  - 每个会话在本渲染器的第一次 `ready` 后执行一次**恢复**：读记录，若记录叶子存在、且 ≠ 自然叶子、且**不是自然叶子的祖先**（祖先说明当前分支就是它的延续，无需回退），则切到记录分支；
  - 之后每次 `ready`（含轮次落定）**保鲜**：重取树，叶子变化才写记录。否则用户继续聊天/编辑后，旧记录会在下次启动时把视图截回到旧位置；
  - 显式切换（切换器/树面板/搜索跨分支跳转）成功后立即记录。

## 限制

- 切换分支是纯视图切换：被切走的分支若正在运行（不可能——切换要求空闲；但后台常驻会话的分支在其自身上下文中运行）不受影响。
- 以用户消息结尾的分支（如中断在发出瞬间）：`navigateTree` 对用户消息取其父为叶子，因此查看该分支时结尾的用户消息不显示（与 Pi 编辑语义一致）。
- `getSessionTree()` 输出整棵树；超长多分支会话在每次轮次落定后的树重取成本为 O(entry 数)（与 ready 本身同数量级，但 ready 只传最近窗口）。后续可做增量更新。
- 分支的模型上下文由 Pi 的 `buildContextEntries` 沿当前叶子路径解析（含压缩摘要），pi-desktop 不干预；切换到旧分支后继续聊天会在该分支上追加。
- 桌面端记录按会话文件路径全局共享（多窗口不重复加载同一会话，无冲突）；记录文件损坏时回退为空（Pi 自然分支仍可用）。
