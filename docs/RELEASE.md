# 发布与软件内更新

源码和安装包均发布在公开仓库 [shuaichao171/pi-desktop](https://github.com/shuaichao171/pi-desktop)。软件默认使用该仓库最新正式 Release 的下载目录：

```text
https://github.com/shuaichao171/pi-desktop/releases/latest/download/
```

不需要额外服务器、下载仓库或客户端 GitHub token。同仓库发布使用 GitHub Actions 自带的 `GITHUB_TOKEN`，发布任务具有 `contents: write` 权限。草稿和预发布版本不进入默认更新通道。

## 当前支持

- Windows Setup：检查版本、自动下载、显示进度，用户点击后退出并安装、重新启动。启动 15 秒后首次检查，此后每 6 小时检查，也可在“设置 → 软件更新”手动检查。
- Windows Portable：仍需下载新版并手动替换，不使用 Setup 的自动安装流程。
- Linux AppImage：支持软件内更新；DEB 由系统包管理器更新。
- macOS：只有配置完整签名与公证凭据后，发布流程才构建正式 DMG／ZIP；未配置时跳过，Windows／Linux 继续发布。

仓库还没有正式 Release 或缺少当前平台的更新清单时，软件会显示可重试的提示，不把 404 当成“已经最新”。GitHub 下载使用兼容其重定向与对象存储的 Range 配置。

## 第一次启用

此前 `0.1.0` 安装包没有嵌入更新地址，无法自行发现新的更新源。请先手动安装一次带更新源的 `0.1.1` Setup；此后的更高正式版本才能从软件内更新。单独给服务器上传新包不会改变已安装旧程序内的空配置。

本地执行 `build.cmd` 或 `pnpm dist:win` 即可生成带默认更新源的 Windows 安装包和更新文件。无需手动填写环境变量。输出目录包括：

```text
release/
  Pi-Desktop-Setup-0.1.1-x64.exe
  Pi-Desktop-Setup-0.1.1-x64.exe.blockmap
  Pi-Desktop-Portable-0.1.1-x64.exe
  latest.yml
```

`latest.yml` 引用 Setup，不引用 Portable。资源目录同时包含客户端读取的 `update-config.json` 和 electron-updater 使用的 `app-update.yml`；后者包含下载缓存配置，不能遗漏。

## 日常发布步骤

1. 同时修改根目录 `package.json` 与 `packages/desktop/package.json` 的版本，例如下一版 `0.1.2`。正式通道使用稳定的 `X.Y.Z`，并始终增加版本号。
2. 运行 `pnpm typecheck`、`pnpm test`、`pnpm build`，提交完整源代码并推送 `main`，检查 CI。
3. 创建并推送匹配的标签：
   ```bash
   git tag v0.1.2
   git push origin v0.1.2
   ```
4. `Desktop release` 工作流构建 Windows 和 Linux，并在具备完整凭据时构建 macOS。所有平台固定到标签对应的同一提交；元数据中的版本、文件名、大小和 SHA-512 均需通过校验。
5. 工作流把完整产物上传到本仓库的**草稿 Release**。确认检查完成后，在 GitHub Releases 发布该草稿，并将它设为 Latest。发布后，软件默认地址即可读到新版本，不需要再向其他服务器上传。

也可在 Actions → Desktop release → Run workflow 中选择已有的稳定版本标签。`publish` 默认关闭；开启时，工作流在完整构建和上传后自动发布并设为 Latest。已经公开的同名 Release 不允许覆盖；需要修复时提升版本。草稿可以重新构建。

只有经过校验的安装包、blockmap 和 `latest*.yml` 会上传，不包含日志、调试配置或整个 `release/` 目录。

## 签名配置

Windows 没有签名凭据也可先构建和验证更新；系统可能显示“未知发布者”或信誉提示。有证书后，配置以下 Actions Secrets，工作流会要求签名有效并确认更新配置中的发布者匹配：

| Secret | 内容 |
| --- | --- |
| `WIN_CSC_LINK` | electron-builder 支持的 Windows 证书来源，如 `.pfx` 的 base64 |
| `WIN_CSC_KEY_PASSWORD` | 证书密码 |

这两个值必须同时配置。项目保留 `verifyUpdateCodeSignature: true`；无证书的包没有发布者签名信息，有签名的包继续进行发布者验证。选择硬件或云签名服务时，需按服务提供方接口调整签名步骤。

macOS 正式发布需完整配置以下 Secrets：

| Secret | 内容 |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application `.p12` 证书来源 |
| `MAC_CSC_KEY_PASSWORD` | 证书密码 |
| `APPLE_ID` | Apple Developer 账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用密码 |
| `APPLE_TEAM_ID` | Apple 团队 ID |

未配置或仅部分配置时跳过 macOS，并在工作流中说明原因。有完整配置时，签名和公证失败会阻止该次发布。

## 自定义更新服务器

可选环境变量／Actions Variable `PI_DESKTOP_UPDATE_URL` 可以覆盖默认地址。必须为公开 HTTPS 目录地址，以 `/` 结尾，不含用户名、密码、查询参数或 fragment。

`scripts/prepare-update-config.mjs` 生成忽略目录中的 `packages/desktop/out/update-config.json`，不会把临时覆盖写回受版本控制的默认配置。Windows、Linux 和 macOS 打包脚本将同一地址传给 electron-builder，避免客户端与元数据不一致。

使用自定义服务器时，GitHub 工作流仍把构建产物放到本仓库 Release；需要自行把文件同步到该服务器。先上传二进制，最后上传 `latest*.yml`。不配置该变量即可直接使用本仓库。

## 验证边界

发布前检查版本一致、更新地址、安装包内容、元数据文件及哈希。完整安装验证使用两个版本的 Setup：旧版检查 → 下载 → 校验 → 用户点击安装 → 重启确认版本；同时保留已有会话与配置。

自动下载验证可以使用隔离的 Electron 测试进程和缓存，不调用安装器，也不修改正在使用的软件。它证明检查、下载和校验链路，不能代替实际退出安装测试。macOS／Linux 打包和运行验证仍以各自 CI／目标系统为准。
