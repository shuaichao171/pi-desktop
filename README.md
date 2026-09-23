# Pi Desktop

基于 [pi coding agent](https://github.com/earendil-works/pi) SDK 的桌面工作台，采用 Electron + React，界面结构参考 ZCode。实际 Agent、工具、扩展、模型与会话文件均由 pi SDK 管理。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│ Electron 主进程 (Node, ESM)                             │
│                                                         │
│   @pidesktop/agent                                      │
│   ┌───────────────────────────────────────────────┐     │
│   │ AgentService                                   │     │
│   │  createAgentSessionRuntime()  ← pi SDK 进程内  │     │
│   │  session.subscribe() → AgentUiEvent 归一化     │     │
│   │  SessionManager → 最近会话恢复 / 历史切换       │     │
│   └──────────────────┬────────────────────────────┘     │
│                      │ ipcMain.handle / webContents.send│
│   @pidesktop/preload桥 (contextBridge → window.piDesktop)│
├─────────────────────────────────────────────────────────┤
│ 渲染进程 (Chromium)                                     │
│   @pidesktop/ui — React 19 + Zustand + Tailwind v4      │
│   AppShell / Sidebar / ChatView / Composer              │
└─────────────────────────────────────────────────────────┘
```

## Monorepo 布局

| 包 | 职责 |
| --- | --- |
| `packages/shared` | IPC 契约：通道名、`AgentUiEvent`、`AgentBridge` 接口 |
| `packages/agent` | pi SDK 服务层：会话生命周期 + 事件归一化（跑在主进程） |
| `packages/ui` | React 聊天界面 + zustand store（不依赖 Electron API） |
| `packages/desktop` | Electron 壳：main / preload / renderer，electron-vite 构建 |

本地 `reference/pi` 与 `reference/zcode` 仅用于设计参考；`reference/` 已从 Git 和安装包中排除。

## 开发

要求：Windows 10/11、Node ≥ 22.19、pnpm 11.11.0。可用 `corepack enable` 启用与 `package.json` 指定版本一致的 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm dev          # 启动 Electron + HMR
pnpm typecheck    # 全部包类型检查
pnpm test         # 状态同步、发送、设置与项目信任回归测试
pnpm build        # 产出 packages/desktop/out/
```

模型与凭据沿用 `~/.pi` 里已有的 pi CLI 配置，也可以在应用设置页选择模型、调整思考级别和添加或删除 provider API Key。API Key 由 pi 的凭据存储管理，不会回传到渲染进程。首次默认工作区是 `~/PiDesktopWorkspace`；在左侧切换文件夹后，下次启动会继续使用该工作区，并恢复其最近的 pi 会话。无可用模型或凭据时，发送框会保留草稿并显示 pi 返回的错误。

首次打开含 `.pi` 或 `.agents` 项目资源的工作区时，应用会询问是否信任。可选择不信任、仅本次信任或始终信任；不信任仍能打开文件夹，但会跳过该工作区的设置、技能和扩展。扩展可能执行本机代码，因此只信任来源明确的工作区。持久化的选择由 pi 的 `ProjectTrustStore` 管理。

`.npmrc` 未启用 Electron 二进制镜像；首次安装时需从 Electron 官方发布源下载运行时。

## Windows 打包

```bash
pnpm pack:dir     # 构建并生成 release/win-unpacked/，便于本地验证
pnpm dist:win     # 生成安装版和便携版 .exe
```

安装包与便携版都在 `release/`：`Pi-Desktop-Setup-<version>-x64.exe` 和 `Pi-Desktop-Portable-<version>-x64.exe`。该目录已加入 `.gitignore`。图标源文件位于 `packages/desktop/build/icon.svg`，Windows 打包使用同目录的 `icon.ico`。修改图标后可使用 `python scripts/make-icon.py` 重新生成 PNG 和 ICO（需 Pillow）。

打包配置只收录编译后的 `out/`、桌面应用的 `package.json` 和运行时依赖。pi SDK 的代码、资源与原生模块随应用打包；本地 `reference/`、测试截图和开发配置不会进入安装包。当前 Windows 构建未签名，也不提供应用内自动更新。

## GitHub CI 与发布

`.github/workflows/ci.yml` 在提交到 `main` 或创建 PR 时执行安装、类型检查、测试、构建与 Windows 解包验证。推送 `v*` 标签会触发 `.github/workflows/release.yml`，生成两个 Windows 构建，并创建包含安装包的 **草稿 Release**，供维护者检查后发布。

发布前将根目录和 `packages/desktop/package.json` 的 `version` 更新为同一版本，再运行 `pnpm install --lockfile-only` 更新锁文件。提交并推送代码后创建与版本一致的标签，例如 `v0.1.0`。GitHub Actions 使用仓库自带的 `GITHUB_TOKEN` 上传草稿，无需额外密钥。

## 当前支持

- 端到端流式对话、Markdown 渲染，以及可展开的工具运行详情和文本输出
- 中止运行、忙时排队 follow-up 与 steer、创建新会话
- 按工作区列出、搜索并切换 pi 的持久化会话，启动时恢复最近会话
- 主进程状态快照与增量事件同步，避免窗口加载期间丢失状态
- 原生文件夹选择器与最近工作区记忆
- 设置页中的模型选择、思考级别与 provider API Key 管理
- 工作区 `.pi` / `.agents` 项目资源的信任确认

## 后续方向

1. 代码差异视图与图片消息
2. 应用内自动更新和 Windows 代码签名
3. 浅色主题
