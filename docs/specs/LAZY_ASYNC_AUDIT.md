# 懒加载 / 异步化全局排查

2026-11-02。对应 TODO「全局排查：把所有能懒加载 / 异步化的地方都处理掉」。本文件是清单与优先级；每项落地时在此勾选并记录度量。

## 度量基线

| 指标 | 来源 | 基线 |
|---|---|---|
| 启动主包 JS | `pnpm build` 后 `packages/desktop/out/renderer/assets/index-*.js` | 3,584,131 B |
| 启动主包 CSS | 同上 `index-*.css` | 522,370 B |
| 会话切换 / 首屏绘制 | `sessionOpenMetrics`（`begin → rpc → snapshot → rendered → painted`，经 `recordUiDiagnostic` 写入诊断日志） | 以本机诊断导出为准 |
| 冷启动 | 尚无统一打点 | 待补（见 P2-启动路径） |

## 已落地

- [x] **P0 会话切换 / 新建不阻塞输入**（2026-11-02）
  - 切换与启动期间输入框保持可编辑（`Composer.tsx` 的 `inputLocked` 仅在尚无任何工作区作用域时锁定）；草稿按乐观选中的目标会话作用域保存，发送按钮在会话就绪前保持禁用并以 title 提示「正在连接 Pi…」。
  - 新建对话准备期间可切换模型 / 思考等级：`store.ts` 把选择暂存在 `SessionPreparation.deferred` 并立即显示，在草稿上线、首条消息发送之前应用到运行时；失败只写入 `settingsError`，不使新建失败。回归：`tests/new-conversation.test.mjs`。
  - 切换时的渐进绘制沿用既有 keep-over（保留旧会话）+ 磁盘 peek（`paintSessionPeek`）+ keep-warm 缓存；整屏占位只在没有任何可保留内容时出现。
- [x] **P0 对话进行中安装插件**（2026-11-02）：安装与资源启停只下载 / 写配置，不再要求全部会话空闲；重载推迟到所有会话空闲的边界自动执行（`AgentService.flushPluginReload`，空闲状态事件触发并以 1.5 s 轮询兜底），完成后推送 `plugins-reloaded` 事件并提示。后台安装不占用主进程工作区激活队列，因此不阻止新建对话 / 切项目；更新、移除、手动重载仍需空闲。回归：`tests/plugins-lifecycle.test.mjs`、`tests/plugins-ipc.test.mjs`。
- [x] **P1 渲染层按需 chunk（第一批）**（2026-11-02）：设置面板、搜索弹窗、自动化页、插件页、提交弹窗改为 `React.lazy`（`components/lazySurfaces.tsx`），首帧后在空闲时预取，首次打开不等待网络（本地文件）。
  - 度量：主包 JS 3,584,131 B → 3,152,240 B（−12%），主包 CSS 522,370 B → 363,186 B（−30%）；拆出的 chunk：SettingsPanel 298 KB + 106 KB CSS、PluginsPage 53 KB、AutomationPage 44 KB、SearchDialog 36 KB、ChatCommitDialog 12 KB。
- [x] **P1 主进程热路径同步 IO（第一批）**（2026-11-02）：`workspaceDefault`（移除项目关联）、`sessionOpenWindow` 的 `statSync`/`mkdirSync` 与工作台 `reset()` 的 `rmSync` 改为异步；`reset()` 先摘下临时 hooks 路径再删除，避免删除期间的 git 调用复用正在删除的目录。

## 待办清单（按优先级）

### P1 渲染层

- [ ] **代码高亮移出主包与主线程**：`CodeBlock.tsx` 同步 `import hljs from 'highlight.js/lib/common'` 并在渲染中高亮，是主包剩余体积的主要来源之一。方案：首屏先渲染纯文本，`readingWorkerPool` 同款 worker 返回高亮结果后替换；保留转录搜索高亮（`TranscriptSearchContext`）与复制语义。验收：主包体积、长代码块会话的切换 `painted` 时间。
- [ ] **工作台按首次打开挂载**：`WorkbenchSidePane` 当前始终挂载（`open` 仅控制显示），其 Git 图、文件树、终端随主包加载。需先梳理关闭时仍需响应的 `openRequest` / `terminalRequest`，再改为首次打开才挂载 + 懒 chunk。
- [ ] Git 图（`gitGraphLayout.ts` 及其视图）、查找面板等工作台子视图随工作台一起拆分。
- 已是按需：Mermaid（动态 import，`mermaidBudget.ts`）、KaTeX、Office 预览（`OfficeFilePreview` lazy + `officePreview.worker`）。

### P1 主进程同步 IO（51 处 `*Sync(`，排除 `gitSync`/`cloudSync`/`zipSync` 等同名误报后约 45 处）

按是否在用户操作热路径上分级：

| 位置 | 调用 | 路径 | 处理 |
|---|---|---|---|
| ~~`ipc.ts` `workspaceDefault` 处理器~~ | `statSync` + `mkdirSync` | 每次「移除项目关联」 | 已改异步 |
| ~~`ipc.ts` `sessionOpenWindow`~~ | `statSync(owner)` | 打开会话窗口 | 已改异步 |
| `ipc.ts` `readCurrentDesktopSettings()` | `readStateFile`（同步读 + 解析） | 多个处理器每次调用 | 进程内缓存 + 写入时失效，或统一改 `readStateFileAsync` |
| `stateFiles.ts` `writeStateFile` | `openSync/writeSync/fsyncSync/renameSync` | 窗口位置（已防抖）、外观、语言、桌面设置保存 | 运行期改 `writeStateFileAsync`；退出路径保留同步 |
| ~~`workbenchService.ts` `reset()`~~ | `rmSync` 临时 hooks 目录 | 切工作区 | 已改异步 |
| `ipc.ts` 启动 `createConversationWorkspaceSync` / `statSync` | 启动 | 冷启动一次 | P2，随启动路径一起处理 |
| `desktopLaunch.ts`（18 处）、`piEngine.ts`、`updateService.ts`、`index.ts` | 启动参数 / 引擎探测 / 安装形态 | 冷启动一次 | P2 |

验收：每处改动保持原有错误文案与回退（例如损坏文件备份 `backupCorruptStateFile`），并补对应单测。

### P2 IPC 与数据

- [ ] 会话列表 `listSessions(cwd)` 全量返回：侧栏大项目改分页 / 增量（`sessions-changed` 已按工作区粒度，可只拉变更）。
- [ ] 目录扫描、Git 状态：大仓库首包先返回首屏所需层级，其余流式补齐。
- [ ] 插件目录、模型 / 供应商目录：缓存上次结果先渲染，后台刷新（插件页当前每次进入都全量 `getPluginCatalog`）。
- 已有范例：历史分页 `getHistoryPage`、会话 peek、搜索分页 `searchSessionsPage`。

### P2 重活移出主线程

- [ ] diff 计算（`unifiedDiff.ts`、`wordDiff.ts` 在渲染线程的调用点）、大文件预览、会话全文搜索的渲染侧过滤，参照 `readingWorkerPool` 下沉 worker。

### P2 启动路径

- [ ] 先补冷启动打点（主进程 ready → 窗口 show → 首个 `ready` 事件 → 首帧），再并行化：扩展加载、模型 / 供应商目录、更新检查互不依赖，可并行并把非首屏项延后到首帧之后。

## 约束

- 每项必须有可对比度量与回归测试；不能只改成异步而丢失错误 / 取消语义（迟到结果按导航代次丢弃、失败可重试）。
- 懒加载 chunk 失败时由所在 `ScopedErrorBoundary` 兜底，空闲预取失败静默、首次打开时重试。
