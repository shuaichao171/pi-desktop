# Pi Desktop

基于 [Pi coding agent](https://github.com/earendil-works/pi) SDK 的桌面工作台，提供 Windows、macOS 和 Linux 构建。界面布局参考 ZCode；Agent、模型、工具、扩展与会话文件仍由 Pi 管理。本项目独立开发，未修改 Pi 的工具执行与审批逻辑。

## 功能

- 流式对话、Markdown、完整的消息与工具调用时间线；可展开、复制工具输出
- 选择模型和思考级别、管理 provider API Key、中止生成，以及忙时 follow-up / steer
- 图片和文本附件；图片进入 Pi 的图像输入，文本文件附在提示词中
- 多工作区项目树与会话列表；切换时保留后台 Pi 运行环境，可重命名、置顶、归档和标记未读
- Pi 扩展的通知、选择、确认、输入与编辑交互；设置中可查看并启用／禁用扩展
- 工作台文件树、UTF-8 文件预览、Git 状态和差异，以及按需运行单条命令并查看输出
- 可调整宽度的侧栏、深色／浅色／跟随系统主题、中英文界面、启动画面和单实例窗口
- 设置页中的更新状态、检查与安装入口；发布包通过可配置的公开 HTTPS 更新源获取更新

命令面板运行的是**单条命令**（Windows 使用 PowerShell，macOS/Linux 使用 `/bin/sh`），可停止并查看输出；它不是交互式 PTY 终端。每次运行前，主进程会显示工作区和完整命令供用户确认；命令拥有当前用户的本机权限，请只运行自己信任的内容。此确认仅用于工作台命令面板，Pi 工具原有的执行与审批逻辑不变。文件预览限制为 1 MB；较大的 Git 差异会显示前 1 MB 并提示截断。扩展开关会重新加载当前 Pi 会话，其他已打开的会话可能需要重新打开才能应用新配置。文本草稿按工作区和会话保存在本地；未发送的附件仅保留在当前窗口，应用重启后需要重新添加。

## 架构

```text
React UI ── window.piDesktop ── Electron preload ── Electron main
                                                     ├─ 工作区 / Git / 命令服务
                                                     └─ utilityProcess RPC ── Pi SDK / AgentService
```

Pi SDK 在独立的 Electron utility process 中运行，避免 SDK 初始化或工具运行阻塞主窗口。主进程负责原生窗口、文件夹选择、项目信任提示和受限的 IPC 桥；渲染进程不直接访问 Node 或 `ipcRenderer`。

Electron ESM preload 的兼容性要求关闭窗口 sandbox；窗口仍启用 `contextIsolation`，preload 只暴露定义好的 `window.piDesktop` 桥接方法。主进程校验工作台文件路径，并在执行用户命令前再次确认。

| 目录 | 职责 |
| --- | --- |
| `packages/agent` | Pi SDK 会话运行环境、事件与附件适配 |
| `packages/shared` | 主进程、preload 与 UI 共用的类型和通道契约 |
| `packages/desktop` | Electron 壳、utility process、工作台服务和打包配置 |
| `packages/ui` | React 界面、状态管理与双语文案 |

`reference/` 仅作设计参考，已从 Git 和安装包排除。

## 开发

需要 Node.js ≥ 22.19、pnpm 11.11.0，以及对应平台的构建环境。Windows 目标支持 Windows 10/11。首次安装会从 Electron 官方发布源下载运行时。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

模型和凭据沿用 Pi CLI 的 `~/.pi` 配置。首次默认工作区是 `~/PiDesktopWorkspace`，之后会恢复上次工作区及其 Pi 会话。打开包含 `.pi` 或 `.agents` 项目资源的文件夹时，应用会询问是否信任；持久化选择由 Pi 的 `ProjectTrustStore` 管理。不信任仍可打开文件夹，但不加载该工作区的设置、技能和扩展。

若工作区、会话标记或语言设置文件损坏，应用会把原文件保留为 `.corrupt-*.bak` 备份并提示路径，再使用默认设置继续。可从备份手动恢复之前的工作区列表或会话标记。

## 打包与发布

```bash
pnpm pack:dir  # release/win-unpacked/
pnpm dist:win  # 安装版 + 便携版
pnpm dist:mac  # macOS：当前机器架构的 DMG + ZIP；CI 分别构建 x64 / arm64
pnpm dist:linux # Linux：AppImage + DEB，x64（在 Linux 上运行）
```

输出位于 `release/`。Windows 的 Portable 是单文件自解压包，每次启动都要先解压 Electron 和应用文件；解压期间会显示原生启动图。日常使用推荐安装 Setup 版，从其快捷方式启动可跳过每次解压。未配置公开 HTTPS 更新源的构建不会检查更新；Portable 需要手动替换。Windows 图标源文件是 `packages/desktop/build/icon.svg`；修改后可运行 `python scripts/make-icon.py` 重新生成 PNG 与 ICO，再运行 `python scripts/make-portable-splash.py` 更新便携版启动图（均需 Pillow）。

提交到 `main` 或提交 PR 会触发多平台 CI。推送与应用版本一致的 `v*` 标签会检查签名凭据和更新源，生成各平台产物，并创建**草稿 Release**；维护者检查后再发布。缺少 Windows 签名证书、Apple Developer 凭据或公开更新源时，标签发布的前置检查会阻止不完整的正式发行。具体配置、文件同步和升级验证见 [发布指南](docs/RELEASE.md)。

## 许可证

本项目采用与 Pi 相同的 [MIT 许可证](LICENSE)，并保留 Pi 的版权声明。
