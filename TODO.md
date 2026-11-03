# TODO

待办事项清单。勾选方式：把 `[ ]` 改成 `[x]`。

## 进行中

- [ ] 全局排查：把所有能懒加载 / 异步化的地方都处理掉。清单、优先级与度量见 [docs/specs/LAZY_ASYNC_AUDIT.md](docs/specs/LAZY_ASYNC_AUDIT.md)（2026-11-01 提出）
  - 已落地（2026-11-02）：设置 / 搜索 / 自动化 / 插件页 / 提交弹窗与代码高亮（highlight.js）改为按需 chunk 并空闲预取，启动主包 JS 3.58 MB → 2.75 MB（−23%）、CSS 522 KB → 352 KB（−33%）；主进程热路径 `workspaceDefault`、`sessionOpenWindow`、工作台 `reset()` 的同步 IO 改为异步。
  - 待办：工作台首次打开才挂载、长代码块高亮按需下沉 worker、`readCurrentDesktopSettings` / `writeStateFile` 运行期异步化、会话列表 / 目录 / Git 状态分页或增量、diff 与全文搜索下沉 worker、冷启动打点与启动并行化。

## 计划中

- [ ] 启动窗口与启动后主窗口无缝衔接：消除「便携版原生位图 → boot 窗 → 主窗」三段之间的可见跳变（现在三段画面、配色与尺寸都不一致）（2026-11-02 提出）
  - 位图段与 boot 段不同：便携版启动位图是 224×224 透明图标页（`scripts/make-portable-splash.mjs` 渲染 `splash.ts` 的图标版 → `packages/desktop/electron-builder.yml:94` 的 `splashImage`），而紧接的 boot 页是全尺寸深色壳（`splash.ts` 的 `renderBoot`：居中 96px logo + 标题 + 进度条 +「正在启动 Pi Desktop…」），logo 位置与尺寸、背景范围都不同。
  - boot 页配色写死深色：`splash.ts` 固定 `#111216` / `color-scheme: dark`，主窗与 splash 窗的 `backgroundColor` 也硬编码（`index.ts:171`、`index.ts:524`、`ipc.ts:288`），浅色主题或自定义配色的用户会先看到一屏深色再突变。
  - 窗框与窗口状态：boot 窗 `resizable/maximizable: false`、主窗可缩放 / 最大化，win32 两者都是 `frame: false` 且标题栏由渲染层绘制，换窗时标题栏、窗口按钮、圆角与阴影会凭空出现（已确认两窗 `frame` 一致，不是 bug，但会看到一次性跳变）。
  - 换窗时序：`reveal()` 内 `win.show()` → `onReady()` → `splash.close()`，位置靠 `mirror` 仅跟随 boot 窗位置（不同步尺寸 / 最大化变化），并且 boot 窗开启有 `ready-to-show` 与 800ms 兜底两条路径（`index.ts:341-360`、`index.ts:509-560`）；需保证同帧替换、无双窗重叠 / 空窗、任务栏图标与焦点不闪。
  - 启动失败路径 `showStartupError` 在同一 boot 窗内换成错误页，也要保持不闪。
  - 验收：对便携版冷启动录屏（或逐帧截图）逐个阶段比对背景色、logo 位置与尺寸、窗框出现时机，深浅主题各跑一遍；计时从双击到主窗首帧，明确还剩几帧跳变、分别在哪一段（开发模式无原生位图段，需单独标注）。
- [ ] 修复压缩 / 总结请求发错推理档位：`Summarization failed: 400: {"message":"gpt-6.1-sol does not support reasoning effort \"none\"; use low, medium, high, xhigh or max"}`（2026-11-02 提出）
  - 链路：Pi SDK 的总结请求把 `thinkingLevel` 原样放进 `options.reasoning`（`@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:463-467`，只排除 `off`），OpenAI 兼容适配器再直接写成 provider 的 `reasoning_effort`（`dist/bundle/chunks/openai-completions-*.js`：`model.thinkingLevelMap?.[level] ?? level`）；于是 `none` 这类非规范档位被原样发出，被只支持 low…max 的模型 400 拒绝，再由 `getSummarizationFailure`（同文件 533 行）包成「Summarization failed」。
  - 档位来源候选：provider 目录里出现 `none`（`packages/agent/src/providerDiscovery.ts:94-100` 已在读 provider 的 `none`，目前只用于把 UI 选项归一成 `off`）、模型自带的 `thinkingLevelMap`（`off` 被映射成 `none`）、以及压缩插件 / historian.pi 的 `thinking_level`（内置压缩被扩展接管时见 i18n `composer.compactionTakenOver`）。
  - 修复方向：进入压缩前统一归一化并 clamp 档位：`none / disabled / off` → `off`，未知值直接丢弃（宁可不传 reasoning，也不要透传非法 effort），再按模型 supported levels 与 `thinkingLevelMap` 校验；`/compact` 与自动压缩共用同一入口（`packages/agent/src/index.ts:822`），写入侧（设置项 / historian.pi）也只能落规范档位（规范集见 `packages/shared/src/index.ts:198`）。
  - 验证：用只接受 low…max 的模型（如 gpt-6.1-sol）作压缩模型，手动 `/compact` 与自动压缩都要成功；补单测覆盖 `none` 归一化、未知档位丢弃、`thinkingLevelMap.off = "none"` 时不再发出非法 effort。
  - 备注：`04d66b1 chore: 撤销许愿在当前主线的功能与修复改动` 把 compaction / historian 功能从当前主干撤掉了（现在没有 `packages/agent/src/compaction` 与 `CompactionSettingsPanel`）；若问题复现于带该功能的构建，修复要同时落在压缩功能侧与请求前归一化处。

## 已完成

- [x] 修复：左侧活动栏按钮悬停提示不居中：气泡仍在按钮上方，去掉 align="start" 改用默认居中对齐，横向相对按钮中心居中（超出窗口左缘时按视口钳制尽量居中）（2026-11-02）
- [x] 子代理适配：侧栏对话行在子代理运行时显示蓝色圈（优先级 失败 > 未读 > 子代理 > 自身运行，悬停文案「子代理运行中」，项目分组计数同步新增蓝色圈）；修复两个进行中对话切换时子代理 FleetCard 不消失：主机在会话重绑时广播 `subagent-fleet: null`，渲染端乐观切换 / 就绪 / 回滚三条路径都会清掉旧会话的 fleet（`UiSessionRuntimeState.subagentRunning` 由主机按会话记忆并在切换后保留）（2026-11-02）
- [x] 会话切换 / 新建的懒加载与不阻塞：切换与启动期间输入框保持可编辑、不再显示「正在连接 Pi…」，草稿跟随乐观选中的目标会话，就绪前仅禁用发送；新建对话准备期间可切换模型 / 思考等级（选择先显示、在首条消息发送前应用到运行时）；切换时沿用 keep-over + 磁盘 peek 渐进绘制。见 [docs/specs/LAZY_ASYNC_AUDIT.md](docs/specs/LAZY_ASYNC_AUDIT.md)（2026-11-02）
- [x] 对话进行中也能安装插件：安装与资源启停在对话运行时后台下载 / 写配置，不再拦截发消息、切模型、新建对话与切项目；扩展重载推迟到所有会话空闲时自动执行并提示「插件已重载生效」，插件页显示待重载状态；更新、移除与手动重载仍需空闲（2026-11-02）
- [x] 创建 TODO 文件
- [x] 有新版本可用时，在设置按钮上方显示「更新」按钮：活动栏设置上方出现 ⬇ 更新入口（悬停显示版本/进度，点击直达设置「更新」页），取代原设置图标红点；见 [docs/ACTIVITY_BAR.md](docs/ACTIVITY_BAR.md)（2026-11-01）
- [x] 修复：删除会话时会一直卡住等待：确认后弹窗立即关闭、行立即隐藏，删除在后台完成并以提示反馈（失败恢复行并可重试）；主进程删除跳过整项目会话全量解析（大项目单次约 3 秒 × 3 次）（2026-11-01）

## 说明

- 新任务先加到「计划中」，开始做时移到「进行中」，完成后移到「已完成」并勾选。
- 涉及细节较多的任务建议拆分为独立文档，放在 `docs/` 或 `_ai_work/` 下，此处只留条目和链接。
- 日期格式：`YYYY-MM-DD`；需要时在条目后追加日期，如 `- [ ] xxx（2026-02-06 提出）`。
