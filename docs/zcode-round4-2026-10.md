# ZCode 借鉴第四轮（2026-10）

本文记录第四轮从 `reference/zcode` 借鉴并落地的四项**设置**改进（对照清单中的 #2、#5、#10、#13）。前三轮见 [ZCode 对照与体验改进](./zcode-experience-improvements.md)、[ZCode 借鉴跟进](./zcode-followups-2026-10.md) 与 [ZCode 借鉴第三轮](./zcode-round3-2026-10.md)。

## 功能总览

| # | 功能 | 入口 | 主要参考 |
|---|---|---|---|
| 2 | 任务运行时保持系统唤醒 | 设置 → 常规 → 任务运行时保持唤醒 | `desktop/src/main/index.ts`（keepAwakeWhileRunning + powerSaveBlocker） |
| 5 | 自动下载并安装更新 | 设置 → 更新 → 自动下载并安装更新 | `desktop/src/main/autoUpdater.ts`（autoDownloadAndInstallUpdates） |
| 10 | 消息流显示/隐藏推理过程 | 设置 → 常规 → 显示推理过程 | `messageStreamShowReasoning`（messageStreamShowReasoning） |
| 13 | 提问未答复自动超时 | 设置 → 常规 → 提问自动超时；提问卡片倒计时 | `askUserQuestionAutoResolution`、`zcode-protocol-v4/interaction-registry.ts` |

## 行为细节

**保持唤醒（2）**：`keepAwake.ts` 主进程控制器持有 `powerSaveBlocker("prevent-app-suspension")`——仅在开关开启**且**（前台任务 busy 或自动化 run 处于 running/retrying）时启动，任一条件失效即停止；只防系统闲置休眠，不防手动睡眠与合盖（zcode 语义）。两路信号：agent status 事件与自动化 onChanged 快照；设置写入、启动引导与 `disposeServices` 都会重读设置并收敛。设置存主进程 `desktop-settings.json`（`keepAwakeWhileRunning`，默认关），旧文件缺字段时按默认合并，不触发损坏恢复。

**自动安装更新（5）**：`autoInstallUpdates`（默认关）存桌面设置。开启后：定时检查（启动 5 秒首次、每 4 小时）经 `setAutoInstallSource` 读取设置并链式执行「检查 → 下载 → 静默安装 → 重启」（复用既有 `check(autoInstall)` → `installRequested` → `quitAndInstall` 通道）；在设置页开启开关视为明确授权——已知有新版本时立即 `install()`，否则立即发起一次带安装意图的 `check(true)`。手动「安装更新」按钮行为不变；关闭开关不影响已下载就绪的更新。

**推理显示开关（10）**：渲染层 localStorage 偏好（`pi-desktop:message-stream-show-reasoning`，默认显示，跨窗口 storage 事件同步）。关闭后 `ConversationTurn` 不再渲染 `ThinkingActivity`（过程折叠区、答案区均隐藏），流式思考期间保留「正在生成」活动指示避免空白；`hasProcess` 折叠判定同步忽略思考块。会话记录不受影响，重新开启即恢复。隐藏路径上 `MessageItem` 的直渲染同样受控。

**提问自动超时（13）**：对齐 zcode interaction-registry：仅作用于 select/input/editor 三类「提问」（confirm 审批与 notify 通知不自动取消）。队首提问启动后 60 秒隐身宽限（不显示倒计时）→ 之后卡片头部显示「m:ss 后自动取消」→ 期满以取消应答自动收口让任务继续。**与提问卡片任何一次点击/聚焦即永久暂停该题的自动取消**；偏好关闭时取消全部进行中的计时，重新开启只对之后新到的提问生效（到达时登记资格）。偏好为渲染层 localStorage（默认开启）。提问自带的 `timeout` 字段逻辑保留，两者先到先收口。

## 验证

- `pnpm typecheck`（4 包）、`pnpm build` 通过。
- 新增测试：`tests/keep-awake.test.mjs`（5 项：开关关不启动、busy 启停、自动化独占与开关即时生效、stop 失败不卡死、重复转换不抖动）、`tests/question-auto-resolution.test.mjs`（4 项：宽限/倒计时/到期三态时间线、m:ss 格式化、仅提问类生效、双偏好默认值）。
- 隔离无界面渲染器验证（`out/settings-toggles-scenario.mjs`，经 `tests/fixtures/model-settings/run.mjs` 运行，报告 `out/review/model-settings/runs/run-StwBS9`，`cleanupError: null`）：四个开关全部渲染、默认值正确（推理/提问超时开、保持唤醒/自动安装关）；点击「保持唤醒」「自动安装」经桥写回 mock 桌面设置；关闭「显示推理过程」写入 localStorage 且按钮态翻转；深浅主题常规页与更新页各出一张截图（`settings-general-toggles.png`、`settings-updates-autoinstall.png`）。
- 既有测试跟进：electron 桩补 `powerSaveBlocker`、`./updateService` 桩补 `setAutoInstallSource`（session-groups-ipc、automation-ipc、plugins-ipc、search-ipc、automation-executor-review）；`desktop-settings.test.mjs` 期望补两字段；顺带修复 HEAD 既有失败——`theme-colors.test.mjs`（011de7c 改 CSS 后生成器 `themeColors.ts` 默认映射未跟上）与 `app-shell-storage.test.mjs`（b522df0 新增 `useAnyExtensionRequestPending` 导出后桩未补）。
- 本轮验证期间工作区存在**另一会话的并发改动**（数据管理/恢复/回收站模块删除与依赖重装），`management-features.test.mjs`（引用已删除的 `usageService.ts`）与 MCP SDK 的 `zod/v3` 解析失败源于该并发改动，与本轮四项无关。
