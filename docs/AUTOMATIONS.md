# 本地自动化

自动化入口现已从占位按钮接通为本地任务列表与调度服务。页面借鉴 Codex 的搜索、状态筛选、任务操作与运行历史，以及 ZCode 的任务卡片、模板入口和单页编辑流程。

## 参考来源

- Codex：`D:/codex-re/ui/extracted/webview/assets/automations-page-223d19469975.js`、`automation-dialog-2627d6bcb494.js`、`automation-frequency-section-ad3906174f39.js`、`cloud-automation-detail-panel-9f07f5943aee.js`。
- ZCode：`reference/zcode/packages/ui/src/settings/AutomationsSection.tsx`、`AutomationEditView.tsx`、`reference/zcode/packages/desktop/src/scheduler/index.ts`、`reference/zcode/packages/services/src/session/automationRepo.ts`。
- 只使用本机执行能力；未加入云端、后台系统服务或其他没有实现的选项。模板只预填，由用户保存后创建任务。

## 行为

- 选择已登记的工作区、模型、思考强度、日程与时区。支持每天、工作日、每周多日、5 分钟至 30 天间隔，以及本地日期时间的单次任务。
- 任务可新建、编辑、搜索、按启用状态筛选、暂停／恢复、立即运行、停止和删除。暂停不取消已经运行的任务；运行中须先停止才可删除。
- 每次在独立 utility process 中创建新 Pi 会话，最多同时运行两个任务，同一任务不重叠。手动运行不推进下次定时计划。
- 先原子保存运行占用与下次调度时间，再执行模型。应用退出／休眠期间错过的任务最多补一次，之后跳至未来；这与 ZCode 超过 5 分钟直接跳过的策略有所不同。
- 重复日程按所选 IANA 时区计算；夏令时回拨的重复分钟只执行第一次，春季不存在的本地分钟跳过。单次任务触发后停用。
- 接受 prompt 只表示开始接收；收到模型真正空闲／错误并完成进程退出后，才记录终态和开放结果会话。模型自动重试成功不被之前失败覆盖。
- 运行会话从主窗口历史和搜索中暂时隐藏，自动恢复工作区时也排除；切换项目与后台会话初始化使用同一队列，避免同时写同一会话。
- 执行沿用 Pi 已保存的信任，无法在无人值守时授予新信任或批准扩展交互。需要交互时停止并记录原因。执行超过 30 分钟会停止。
- 自动化指定的模型与思考强度只作用于该次会话，不修改 Pi 的默认设置；用户在日常对话中主动选择模型时仍按原行为保存默认。
- 配置及最近 200 条历史存于应用数据目录 `automations.json`。进程重启后遗留运行标为中断。损坏文件保留原样；写入失败通过页面提示并暂停调度，随后重试保存，避免重复执行。

## 实现与验证

契约在 `packages/shared/src/index.ts`；调度与原子存储在 `packages/desktop/src/main/automationService.ts`，时区计算在 `automationSchedule.ts`，独立执行在 `automationExecutor.ts`。主进程验证自动化 IPC 的窗口和主框架来源，再校验任务字段和登记工作区。

界面在 `packages/ui/src/components/AutomationPage.tsx` 与 `automationPage.css`；ChatView 切换时保留挂载，保留草稿和阅读状态。扩展通知与交互挂在全局 AppShell，浏览自动化时原对话仍可请求交互。编辑、删除、历史弹窗使用原生 modal dialog，约束焦点并屏蔽会话导航快捷键。支持中英文、深浅主题、窄窗口与系统减少动态效果。

回归测试涵盖 CRUD、损坏存储、写入失败恢复、并发调度、取消、重启、DST、真实完成状态、自动重试、进程退出、IPC 来源与工作区验证。测试使用临时数据和模拟执行器，不调用在线模型或创建用户真实计划。

隐藏 Electron 窗口加载生产 renderer，验证模板预填、新建／编辑、搜索／筛选、暂停／恢复、运行／停止、历史／打开结果、删除、过时快照、草稿保留及弹窗快捷键；检查深浅主题和 1440／780／420px 窗口截图。脚本与截图位于本机忽略目录 `out/review/automations/`，验证窗口由脚本关闭。

2026-09-24 最终检查：`pnpm test` 共 239 项，238 通过、1 项 Unix 进程组测试在 Windows 跳过，无失败；`pnpm typecheck`、`pnpm build`、Pi SDK 同步校验和 `git diff --check` 通过。未进行真实在线模型生成。
