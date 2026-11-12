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

已知限制：8.3 短名用例在测试中通过注入 realpath 模拟（真实生成 8.3 名依赖宿主配置，不可移植）；Windows 家族系统上 junction 由 Node 以 symlink 形式呈现，已被同一判定覆盖；realpath 验证与后续实际写操作（open('wx')/rename/回收站）之间存在固有 TOCTOU 窗口（Node/Windows 无 O_RESOLVE_BENEATH/openat2 等价物），与参考实现同级。

## 默认 CA 集废弃根剔除（B11）

### 行为

`packages/desktop/src/main/caHygiene.ts` 在启动时重建 Node 侧默认 CA 集，剔除名单中的废弃／被替换根证书，语义参考 Claude Desktop nodeHost 的 TLS 卫生（round3/PERIPHERY.md）：重建默认 CA 集剔除废弃根（eMudhra/emSign 系列），`tls.setDefaultCACertificates`，失败仅告警。

- **应用点**：主进程（`index.ts` 的 `app.whenReady()` 首步）与 Pi agent host utility process（`agentHost.ts` 的 bootstrap，先于 SDK 导入）各应用一次，覆盖 Node 侧出站 HTTPS：更新检查（`updateService` 走 Electron net 栈不受影响，但 npm 插件发现 `pluginDiscovery`、自定义引擎 npm 操作、SDK 供应商连接均走 Node 栈）。
- **永不碰用户/系统 CA**：重建的是 `tls.getCACertificates('default')`，但它**不只是** Node 内置 Mozilla 集，还并入了系统信任库（Windows 默认即并入，其他平台需 `--use-system-ca`）与 `NODE_EXTRA_CA_CERTS`（实测 Windows 上 Node 24：default 557 = bundled 120 + system 437）。因此凡同时出现在 `system`／`extra` 集中的证书一律保留（`pruneDeprecatedRoots` 的 `preserved`），只剔除仅由 Node 自带的那份废弃根；名单只按具体废弃根主题精确匹配。
- **名单只收根证书计划已采取行动的根**：emSign ECC Root CA - G3（Chrome Root Store 与 Mozilla 于 2026-10 移除）、emSign Root CA - C1／emSign ECC Root CA - C3（Mozilla 按 eMudhra 自身过渡计划退役）。**不含** emSign Root CA - G1：Mozilla 暂不移除、Chrome 未决；剔除浏览器仍信任的根，会让在浏览器里正常的站点在应用里 TLS 失败。
- **优雅降级**：运行时无 `tls.setDefaultCACertificates`（旧 Electron/Node）时 console.warn 一条并跳过；重建过程任何异常仅 console.warn，不阻断启动（返回 `{ applied, removed }` 供调用力诊断）。

### 名单维护

`DEPRECATED_ROOT_SUBJECTS` 是常量数组（OpenSSL oneline 主题格式），匹配经 `normalizeSubject` 归一（兼容多行/逗号两种主题形式、转义字符、顺序与大小写差异），因此**只需原根新主题字符串**：

```ts
export const DEPRECATED_ROOT_SUBJECTS: readonly string[] = [
	'CN=emSign ECC Root CA - G3,OU=emSign PKI,O=eMudhra Technologies Limited,C=IN',
	'CN=emSign Root CA - C1,OU=emSign PKI,O=eMudhra Inc,C=US',
	'CN=emSign ECC Root CA - C3,OU=emSign PKI,O=eMudhra Inc,C=US',
];
```

当前值是 Node 24 内置集中、已被根证书计划移除或退役的 3 个 eMudhra/emSign 根（G3：Chrome Root Store 与 Mozilla 于 2026-10 移除；C1/C3：Mozilla 按 eMudhra 过渡计划退役。`node -e "new (require('node:crypto').X509Certificate)(c).subject"` 可验证主题原文）。emSign Root CA - G1 **刻意不列**：Mozilla 暂不移除、Chrome 未决。**只在根证书计划实际采取行动后**才向数组追加主题（无需改其它代码），不要预判；无法解析主题的证书一律保留（从不猜测）。

测试见 `tests/ca-hygiene.test.mjs`：归一化、名单精确匹配（相似名与 G1 不误伤）、过滤恰好剔除名单项、系统/额外 CA 集中的同名根保留、真实默认集集成断言（system/extra 证书一个不少）、API 缺失/异常仅告警。

已知限制：仅影响 Node 网络栈（fetch/https/tls）；渲染进程与 `net.fetch` 走 Chromium 网络栈与系统证书库，不在本机制范围（与 Claude Desktop 同口径，其 Chromium 侧另有 SPKI 黑名单，此处未引入）。
