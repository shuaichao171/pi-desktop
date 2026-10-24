# 与 Pi 上游同步

Pi Desktop 通过发布在 npm 的 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK 运行 Pi。`packages/agent/src/index.ts` 是主要适配层；Electron 的 utility process 加载这个适配层，再把会话事件传给界面。上游正式 npm 版本是升级依据；[Pi 上游仓库](https://github.com/earendil-works/pi)、[SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)和 [Release Notes](https://github.com/earendil-works/pi/releases)用于理解变化。

`reference/pi` 是被 Git 忽略的本地参考 clone，可能不存在或落后于上游。它不参与安装、CI 或打包；不要把它的 `main` 分支提交直接当作已发布的 Pi SDK。Pi Desktop 的 SDK 版本与桌面应用版本分别管理。锁文件确定每次构建使用的 SDK 版本，不在用户设备上单独替换 Pi 代码。

## 查看与升级版本

在仓库根目录执行：

```bash
node scripts/sync-pi.mjs --verify
node scripts/sync-pi.mjs --check-latest
```

`--verify` 离线检查根目录、`packages/agent`、`packages/desktop` 的 Pi SDK 精确版本声明、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 中的 Pi 包版本例外，以及打包用 esbuild 版本是否一致。`--check-latest` 向 npm 查询最新正式版并显示当前与最新版本；它不修改文件。

升级到 npm 的最新正式版，或指定已发布的版本：

```bash
node scripts/sync-pi.mjs --update-latest
# 或指定目标已发布版本，例如：node scripts/sync-pi.mjs --update 0.87.1
pnpm install --lockfile-only
node scripts/sync-pi.mjs --verify
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`--update-latest` / `--update VERSION` 会统一修改三个 `package.json` 和 `pnpm-workspace.yaml`，但不会生成锁文件。因此，必须在更新后运行 `pnpm install --lockfile-only`，再运行 `--verify`。指定版本必须是 npm 已发布的精确稳定版本。确认 `pnpm-lock.yaml` 中 Pi 相关包的解析版本，以及必要时的 esbuild 版本变化；不要只改其中一个清单文件。安装和构建时不需要本地 `reference/pi`。

## 自动发现与人工合并

GitHub 的定时及手动同步工作流检查 npm 正式版。发现新版本时，它在独立分支更新版本声明和锁文件，并向仓库提交升级 PR；没有新版本时不改动仓库。这个工作流用于提出升级，不直接合并，也不直接向用户发布应用。

仓库首次启用时，在 GitHub **Settings → Actions → General → Workflow permissions** 中开启 **Allow GitHub Actions to create and approve pull requests**；否则工作流虽有 `pull-requests: write` 权限，仍不能创建升级 PR。同步工作流只创建或更新 PR，不提交批准。它会主动调度跨平台 CI，因为 GitHub 不会自动运行由同一 `GITHUB_TOKEN` 推送触发的普通工作流。

审查升级 PR 时：

1. 阅读目标版本的 [Pi Release Notes](https://github.com/earendil-works/pi/releases)，必要时比较上游两个发布标签的差异。尤其检查会话存储格式、模型与凭据、扩展 UI、项目资源信任、工具执行及审批行为。
2. 审核 `packages/agent/src/index.ts` 对 Pi SDK 的调用是否仍符合[对应版本的 SDK 契约](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)。保留 Pi 自身的工具与审批逻辑；如上游接口改变，在适配层解决。
3. 等待 CI 的 TypeScript 检查、会话与扩展集成测试、Windows 构建及解包、macOS 双架构和 Linux 打包验证全部通过。测试通过后仍需检查实际界面及关键会话流程；CI 不能完全覆盖交互行为。
4. Pi ≥1.4.0 不再依赖 `@earendil-works/chord`，打包里保留的 esbuild 平台二进制只由 `packages/desktop/package.json` 的可选依赖声明；`--verify` 要求它们版本一致且已在锁文件中解析。如果将来某个 Pi 版本重新内置 esbuild（或改变 npm 包内的二进制、WASM 布局），再按上一段的方式同步 `packages/desktop/package.json` 的可选依赖、`electron-builder.yml` 的解包规则，以及 CI 与发布工作流中的产物检查。不要为消除失败而直接删除运行时检查。

只有审查和验证完成后才合并 PR。上游处于 `0.x` 版本阶段，版本升级仍可能改变 SDK 行为；锁文件和测试门禁用于阻止未经检查的漂移。

## 用户自定义引擎（例外通道）

「设置 → 引擎」允许用户把桌面应用指向一个自行 `npm install` 的 `@earendil-works/pi-coding-agent` 目录（`packages/desktop/src/main/piEngine.ts` 负责探测与重定向；`agentHost.ts` 是无依赖引导入口，在加载实现前安装 `registerHooks` 重定向并校验适配层所需导出）。该通道**不受本文件的锁文件与 CI 门禁约束**：

- 用户自装引擎的版本漂移、行为差异与会话格式兼容性由用户自行承担；设置页在保存前做结构探测（包名、`dist/index.js`、依赖目录）并提示主版本差异或缺依赖等风险，但不做版本硬限制。
- 引导入口在加载自定义引擎后会检查 `piEngine.ts` 中列出的适配层必需导出；缺失时报错并退出 agent 进程，主进程以 fatal 错误提示，用户可切回内置引擎。
- 升级 Pi SDK 时若适配层新增或改名了从 SDK 导入的运行时符号，必须同步更新 `REQUIRED_SDK_EXPORTS`，否则自定义引擎的可用性判断会失真。
- 队列恢复走的是 SDK 私有协议：`packages/agent/src/inputQueue.ts` 在 Pi ≤1.3 用 `_runAgentPrompt(messages)`，在 Pi ≥1.4 改用 `_startRun(trigger)`；两代都缺失时报「Pi SDK 队列显示协议不兼容」。上游再次改名该协议时，先在这里补新分支并加测试，再同步本文件与设置页文案。
- 主进程对 SDK 的直接使用仅限 `getAgentDir`（路径计算，与引擎版本无关），不做重定向。

## 让用户获得新版 Pi

合并 SDK 升级 PR 只会更新下一次构建所包含的 Pi。需要按[发布指南](RELEASE.md)提升 **Pi Desktop 应用版本**、构建并发布新的桌面安装包，用户才能获得新版 Pi。应用内的更新功能下载 Pi Desktop 的正式发布包；它不会从 npm 热更新 SDK。Portable 版仍需用户手动更换文件。
