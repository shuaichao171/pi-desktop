# 工作台功能契约（F-004、F-020～F-023）

## 数据所有者与调用边界

`workbenchFeatures.ts` 是类型及 IPC 名称的唯一来源。桌面主进程拥有提交预览、工作树映射、交付预览和 PTY；agent 的 `SessionFileChanges` 拥有会话检查点。preload 经已认证 renderer IPC 暴露方法，检查点走既有 agent RPC。UI 的异步完成同时校验原工作区、bridge 与本地请求代次；检查点还校验会话身份。

## 提交范围

- `all` 在独立索引构建当前工作区的全部更改；`stagedOnly` 精确复制实际索引中的当前工作区条目。预览文件、生成说明上下文和最终提交使用同一候选树。
- 嵌套工作区只提交该子目录，外部暂存内容保留；部分暂存文件的未暂存工作内容保留。
- 预览最多 8 个、有效 10 分钟，退出应用清理临时索引。执行前比较 HEAD、分支、索引及工作内容指纹；变化后必须重新预览。
- 提交使用真实索引锁、`commit-tree` 和 CAS `update-ref`。索引发布失败会 CAS 回滚 HEAD；回滚也失败时错误包含新提交 hash，不伪报成功。工作文件本身不重写。
- 首期不接管 merge/cherry-pick/revert 的进行中状态；不执行 Git hooks 或签名流程。大 diff 的生成上下文截断为 64 Ki 字符，文件清单和实际树不受截断影响。

## 最近回合文件检查点

- 每个已完成 agent 回合独立保存 `.pi-desktop-checkpoints/<sessionId>.json`，仅支持 Git 工作区。不写入模型上下文。
- 原始文本前后内容总预算 2 MiB，至多 200 个完整覆盖文件和 500 条路径记录。二进制、非无损编码、超限、不完整 shell 扫描与并发归属不明的文件明确标为未覆盖。
- 撤销前比较当前字节与回合完成指纹，任何外部编辑冲突都阻止该次撤销；每次写入再次核验目标。索引不回退，新增/删除/修改文件分别还原。
- 恢复使用逐文件临时写入和持久恢复记录。中途失败回滚已经修改的文件；回滚再失败保留恢复日志，下一次明确操作先恢复撤销前内容。未解决的恢复日志不会被新回合覆盖。
- agent idle 与会话生命周期锁覆盖整个撤销。符号链接、`.git` 和工作区外路径不允许还原。检查点不是仓库级事务；外部程序恰好在最后一次校验和文件替换之间写入仍是文件系统并发限制。

## 独立工作树任务

- 桌面数据目录的 `worktrees/<uuid>` 存放 Git 管理的工作树，`worktrees.json` 原子保存来源项目、实际 cwd、ref、精确 commit、分支、会话路径。
- 从已提交 ref 创建新分支，默认 `codex/` 前缀。不会复制未提交内容，不会自动删除工作树或分支。子目录项目要求所选提交包含该目录。
- 创建后切换到工作树并创建新会话，再绑定会话路径。若分配的空会话尚未落盘，重启打开时创建新会话；已持久会话继续原任务。
- 重复分支、无效 ref、目录缺失和记录保存失败显式报告。Git 创建成功但记录失败时返回真实目录位置供恢复，不删除已创建结果。

## 推送及 GitHub 草稿 PR

- 预览绑定 cwd、分支、HEAD 和完整远端配置；显示的 URL 去除内嵌凭据。Detached HEAD 拒绝交付。
- 推送是显式普通 `git push --set-upstream`，不 force、不自动改基。远端拒绝和凭据失败直接显示，不能显示成功。
- 创建 PR 是另一个明确操作，只支持 GitHub.com 与已安装登录的 `gh`。先验证远端分支等于预览 HEAD，不自动推送。先查现有开放 PR，再通过 `--draft` 和 UTF-8 正文临时文件创建。
- PR URL 按 cwd、分支、完整目标远端持久保存。PR 成功但本地记录失败时仍返回包含实际 URL 的错误，避免丢失可恢复结果。
- 测试中的远端推送及 `gh` 全部为注入 mock；没有执行真实推送或创建真实 PR。GitHub Enterprise、跨仓库 fork PR 暂不支持。

## 交互终端

- 单个应用只保留一个 PTY，绑定启动时的工作区。切换页签或收起面板保留进程；切换项目后回到原项目才能关闭该终端并启动另一个。
- Windows 使用 node-pty 1.1.0 + ConPTY + PowerShell；其他平台使用用户 Shell 或 bash。xterm 6 负责 UTF-8、交互输入、粘贴和窗口尺寸。
- 最近输出限制 256 Ki 字符，16ms 分批，renderer 完成写入后回执；未确认输出达到限制暂停 PTY，低水位恢复。输入单次上限 64 Ki 字符，UI 粘贴按 16 Ki 分块。
- 明确终止与应用退出清理所属进程树；自然退出也调用 node-pty 公共清理 API，避免 ConPTY worker 留在后台。不会操作任务开始前用户已打开的软件或终端。
- 已知 Windows 第三方诊断：node-pty 的 console-list helper 在 shell 已被清理后可能输出 `AttachConsole failed`，其 5 秒 fallback 会退出。真实测试确认主测试进程正常退出、测试子进程消亡；不能将这条库诊断误报为交互功能失败。

## 验收证据

- `tests/workbench-features.test.mjs`：临时 Git 仓库验证部分暂存、子目录范围、初始提交、陈旧预览、索引发布失败回滚、工作树隔离与重启映射、普通 push 和既有 PR mock。
- `tests/file-checkpoint.test.mjs`：真实工具生命周期的新增/删除/修改还原、索引保持、外部冲突、二进制与 BOM、写入失败回滚、恢复日志跨重启保留。
- `tests/workspace-terminal.test.mjs`：Windows 真实隐藏 ConPTY，中文、100×30 resize、Read-Host、Ctrl+C、大输出背压、子进程终止、自然退出与重新启动均通过。没有声称 macOS/Linux 已实测。
- `tests/fixtures/ui-improvements/workbench-features.mjs` 提供范围提交、冲突检查点、工作树映射、推送失败/既有 PR 和终端页签保留的 renderer mock 场景。2026-09-26 使用独立 headless runner 在深浅主题及 760px 窄窗口运行通过，检查导出的实际截图并修复了全局 margin reset 导致原生弹窗靠左上角的问题。两次 runner 均自动关闭自有浏览器（`cleanupError: null`），没有使用 computer-use，也没有操作用户已有窗口。
