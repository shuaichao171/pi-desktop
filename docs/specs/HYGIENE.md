# 安全卫生：工作区路径防护与 CA 清洗

记录两个主进程安全卫生机制的行为与维护方式。参考来源：Claude Desktop 逆向（`reference/claude-desktop-reverse/`，REPORT §10.3 safe-fs beneath* 与 round3/PERIPHERY.md nodeHost 的 TLS 卫生）。

## 工作区 beneath 路径防护（B10）

### 行为

`packages/desktop/src/main/workspaceBeneath.ts` 是工作区文件树操作的统一路径防护模块，语义参考 `O_RESOLVE_BENEATH`：目标路径经完整 realpath 解析（`fs.realpath.native`，含 `.native` 变体：symlink、Windows junction、8.3 短名、盘符大小写全部规范化）之后，必须真实位于工作区根的 realpath 之内，否则直接拒绝。

判定算法（`resolveBeneathRoot`）：

1. 入参校验：相对路径必须是字符串、不含 `\0`、不是绝对路径，否则 `WORKSPACE_PATH_INVALID`（消息「文件路径无效」）。
2. 根规范化：工作区根先经 realpath 解析（工作区通过 symlink／短名打开时，以真实位置为准）。
3. 词法判定：`resolve(root, relativePath)` 后做 beneath 检查，`..` 逃逸、兄弟目录前缀（`/work` vs `/workspaces`）、跨盘符路径在此被拒。
4. 物理判定：目标再经 realpath 解析，链接／junction／短名指向根外即拒绝。目标不存在时保留原始错误（如 `ENOENT`）。
5. 两次拒绝均抛 `WorkspacePathError`，`code = 'WORKSPACE_PATH_ESCAPE'`，消息沿用「文件不属于当前工作区」。**绝不做「逃逸后回退到根目录」的 fallback**——拒绝就是拒绝。

大小写与盘符比较遵循平台文件系统语义：Windows 用 `path.win32.relative`（大小写不敏感、盘符字母归一、不同盘符即外部）；macOS/Linux 精确比较（两侧都来自同一次 native realpath 规范化）。native realpath 在个别文件系统上不可用时回退到纯 JS realpath（对 symlink／junction 逃逸依然安全）。

### 覆盖范围

`WorkbenchService.resolveEntry` 统一走该模块，因此文件树的**新建、重命名（含目录内移动）、删除（回收站）、列表、读取、差异预览**全部受保护；`workspaceRoot()` 也改用 `canonicalRealpath`，Git 操作与命令 cwd 与防护使用同一套规范化根。

明确不在覆盖范围（工作区外的合法场景，刻意不拦）：用户自选附件路径、任意「打开文件／选择目录」对话框返回的路径、`ResultFileService` 的会话结果文件（会话链接本就允许指向项目外）、拖拽添加项目。

### 名单与维护

无名单。新增文件树操作时直接复用 `resolveBeneathRoot`／`isBeneath`（从 `./workspaceBeneath.ts` 导入），不要在调用点重新实现字符串前缀判断。判定纯函数支持注入 realpath（`resolveBeneathRoot(root, relativePath, realpath)`），测试见 `tests/workspace-beneath.test.mjs`（含 `..`、symlink、junction、短名别名、大小写、根别名等用例与真实文件系统集成断言）。

已知限制：8.3 短名用例在测试中通过注入 realpath 模拟（真实生成 8.3 名依赖宿主配置，不可移植）；Windows 家族系统上 junction 由 Node 以 symlink 形式呈现，已被同一判定覆盖。
