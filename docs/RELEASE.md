# 发布与自动更新

## 发布前需要准备的外部资源

源代码仓库是私有的，不能把读取仓库的 GitHub token 放进客户端。应用从单独配置的公开 HTTPS 地址读取更新；这个地址下的安装包和 `latest*.yml` 必须无需登录即可下载。没有配置地址时，应用会显示更新源未配置，也不会发起更新请求。

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `PI_DESKTOP_UPDATE_URL` | 公开 HTTPS 更新目录的完整 URL，必须以 `/` 结尾 |
| Secret | `WIN_CSC_LINK` | Windows 代码签名证书 `.pfx` 的 base64 内容 |
| Secret | `WIN_CSC_KEY_PASSWORD` | `.pfx` 密码 |
| Secret | `MAC_CSC_LINK` | Developer ID Application 证书 `.p12` 的 base64 内容 |
| Secret | `MAC_CSC_KEY_PASSWORD` | `.p12` 密码 |
| Secret | `APPLE_ID` | Apple Developer 账号 |
| Secret | `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用密码 |
| Secret | `APPLE_TEAM_ID` | Apple 团队 ID |

Windows 证书需要向代码签名证书颁发机构获取；macOS 分发和公证需要 Apple Developer Program。证书、密码和 token 只放在 Secrets 中，不提交到仓库。[Windows 签名](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)、[macOS 签名与公证](https://www.electron.build/docs/github-actions/)有导出和配置说明。

在签名凭据和公开更新源尚未准备好的环境中，`main`/PR 仍可运行无签名的构建验证；**版本标签发布会因缺少必要配置而停止**，防止误发未签名或无法更新的正式产物。

## 构建与发布

Windows 输出安装版 Setup 和每次启动会自解压的 Portable；macOS 输出 x64 与 arm64 的 DMG/ZIP；Linux 输出 x64 的 AppImage/DEB。自动更新使用 Windows Setup、macOS 已签名包和 Linux AppImage；Portable 需要手动更换文件。CI 会在对应平台检查打包后的 Pi runtime，版本标签发布流程还会验证签名和公证结果。

1. 同时修改根目录及 `packages/desktop/package.json` 的 `version`，例如 `0.2.0`。
2. 运行 `pnpm install --lockfile-only`、`pnpm typecheck`、`pnpm test`，提交并推送 `main`，等待 CI 全部通过。
3. 确认上表的变量与 Secrets 已配置，并确认公开更新目录可用。
4. 创建并推送匹配的标签：`git tag v0.2.0`、`git push origin v0.2.0`。
5. 检查草稿 GitHub Release 的各平台文件、签名、公证和 `latest*.yml`。草稿 Release 属于私有仓库，只是发布暂存区，**不是**客户端可访问的更新源。
6. 将同一批安装包、ZIP、AppImage 和 `latest*.yml` 等更新文件上传到 `PI_DESKTOP_UPDATE_URL` 指向的公开目录。先上传二进制文件，最后上传元数据，避免客户端先看到新版本却下载不到对应文件。
7. 从未登录状态验证 `latest.yml`、`latest-mac.yml`、`latest-linux.yml` 及其引用的文件可通过 HTTPS 下载，再决定是否发布 GitHub 草稿 Release。

`electron-builder` 的 generic provider 不会替你上传到自有服务器；若希望上传过程完全自动化，需确定具体托管服务后给发布工作流增加该服务的上传步骤。[自动更新说明](https://www.electron.build/v26/docs/features/auto-update/)、[generic 发布说明](https://www.electron.build/v26/docs/publish/)列出元数据与托管要求。

## 更新验证

用已经安装的旧版测试完整升级路径：检查更新、下载、校验、退出安装、重新启动并确认版本号。Windows 要在 Setup 安装版上测试；macOS 要在签名和公证后的包上测试；Linux AppImage 要保留 `APPIMAGE` 环境并在目标发行版测试。还需验证更新源断网、404、校验失败和用户取消时的界面状态。不要在客户端升级期间删除元数据所引用的安装包。

已打包应用的本地调试可以通过 `PI_DESKTOP_UPDATE_URL` 环境变量覆盖打包配置，但发布包必须把真实的公开 HTTPS 地址写入资源文件。不可在客户端内保存私有仓库令牌。
