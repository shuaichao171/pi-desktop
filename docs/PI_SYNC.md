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
4. 如果 Pi 改变 Chord 所需的 esbuild 版本或 npm 包内的二进制、WASM 布局，同步调整 `packages/desktop/package.json` 的各平台可选依赖、`electron-builder.yml` 的解包规则，以及 CI 与发布工作流中的产物检查。不要为消除失败而直接删除运行时检查。

只有审查和验证完成后才合并 PR。上游处于 `0.x` 版本阶段，版本升级仍可能改变 SDK 行为；锁文件和测试门禁用于阻止未经检查的漂移。

## 让用户获得新版 Pi

合并 SDK 升级 PR 只会更新下一次构建所包含的 Pi。需要按[发布指南](RELEASE.md)提升 **Pi Desktop 应用版本**、构建并发布新的桌面安装包，用户才能获得新版 Pi。应用内的更新功能下载 Pi Desktop 的正式发布包；它不会从 npm 热更新 SDK。Portable 版仍需用户手动更换文件。
