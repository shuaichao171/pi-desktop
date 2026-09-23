# 发布指南

## 当前发布流程

仓库的 `.github/workflows/ci.yml` 会在 Windows 上安装依赖、检查类型、运行测试、构建并验证打包后的 Pi SDK 和独立 Agent 进程。`.github/workflows/release.yml` 在推送 `v*` 标签时生成安装版与便携版，并创建草稿 GitHub Release。

1. 同时修改根目录和 `packages/desktop/package.json` 的 `version`，例如 `0.2.0`。
2. 运行 `pnpm install --lockfile-only`、`pnpm typecheck`、`pnpm test`、`pnpm dist:win`。
3. 提交并推送 `main`，等待 CI 通过。
4. 创建对应标签并推送：`git tag v0.2.0`、`git push origin v0.2.0`。
5. 检查草稿 Release 中的两个 `.exe`、版本号与发布说明，然后在 GitHub 发布。

不要把签名证书、API Key 或 GitHub token 提交到仓库。当前 Release 是草稿，打标签本身不会让用户直接获得正式发布版。

## 后续接入 Windows 签名

向可信证书颁发机构申请适用于 Windows 代码签名的证书，按 [electron-builder v26 的 Windows 签名说明](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)导出可供 CI 使用的证书，并在 GitHub 仓库 Secrets 中配置 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD`。前者可使用证书文件的 base64 内容，后者是证书密码。先在单独标签的草稿 Release 验证安装包签名和安装体验，再发布给用户。

## 后续接入自动更新

Windows 安装包已采用 NSIS，但还需要在应用中接入 `electron-updater`，在主进程处理检查、下载、安装与错误状态，并在更新界面向用户显示进度。每次发布都需要上传安装包及 `latest.yml` 等更新元数据；升级路径应覆盖从旧版安装、下载更新到重启安装。[electron-builder 自动更新说明](https://www.electron.build/docs/features/auto-update/)列出了 NSIS 与更新元数据要求。

本仓库是私有仓库。不要把可读取仓库的个人访问令牌嵌入应用。若安装包要分发给不具备该私有仓库访问权限的人，先选择一个公开的二进制更新源，或建立有鉴权的自有更新服务，并让应用只从该源获取版本与安装包。个人使用时，可继续从私有 GitHub Release 手动下载安装包。

## 后续支持 macOS / Linux

在 `packages/desktop/electron-builder.yml` 中增设 `mac` / `linux` 目标，并在 GitHub Actions 中分别使用 `macos-latest` 与 `ubuntu-latest` 构建。Pi 的原生依赖需要按目标平台重新安装、打包和验证，不能直接复用 Windows 产物。macOS 分发前需要 Apple Developer 证书、公证及一台 macOS CI runner；Linux 则选择 AppImage、deb 等目标并在实际发行版上测试。参照 [electron-builder GitHub Actions 指南](https://www.electron.build/docs/github-actions/)配置构建与发布矩阵。
