# Computer Use（CUA）规格说明

> 状态：v1（Windows 实现）。本文描述 `desktop-cua` 内置扩展的行为、安全模型与验证范围。
> 设计参考：Codex Desktop（sky/cua 分层 + host 编排）、Claude Desktop（单坐标系约定、剪贴板粘贴式输入、JPEG q75+maxWidth）、zcode（fail-closed 平台策略、会话开关）。

## 概述

给 Pi 会话提供操控本机桌面的一组工具：截屏、鼠标、键盘、剪贴板、窗口管理。模型通过工具调用观察屏幕并执行操作，与用户共享同一桌面（不做虚拟桌面/沙箱）。

- 入口：会话内 `/cua on|off` 开关（默认关闭），关闭时所有 `cua_*` 工具被拦截并返回启用指引
- 工具注册：内置隐藏扩展 `desktop-cua`（`packages/agent/src/cua/`），随每个 Pi 会话运行时创建
- 原生层：koffi 3.3.7（N-API FFI，预编译包 `@koromix/koffi-<平台>`，不跑源码构建脚本）直调 Win32 —— SendInput（键鼠）、GDI BitBlt（截屏）、EnumWindows（窗口）、CF_UNICODETEXT（剪贴板）
- 懒加载：扩展构建与模块导入都不触碰原生代码；koffi 与 DLL 绑定在首次调用 `cua_*`（或 `/cua on` 探测）时才加载，加载失败只影响 CUA，不影响会话启动
- 平台：Windows 完整实现；macOS/Linux 工具可见但执行时返回明确"平台不支持"（fail-closed，不降级）

## 工具面（14 个）

| 工具 | 说明 | 注解 |
| --- | --- | --- |
| cua_screenshot | 截屏（整桌面或区域），返回图片（JPEG q75，默认 maxWidth 1600 双线性缩小）+ 分辨率/光标信息 | 只读 |
| cua_mouse_move | 移动鼠标到物理像素坐标 | 注入 |
| cua_left_click | 左键单击（可带坐标，缺省=当前位置） | 注入 |
| cua_double_click | 左键双击 | 注入 |
| cua_right_click | 右键单击（上下文菜单） | 注入 |
| cua_drag | 按住左键从起点拖到终点（缓动插值，默认 350ms，可中止，结束必定松开左键） | 注入 |
| cua_scroll | 在当前光标处滚轮（格数，正=下/右，可水平） | 注入 |
| cua_type | 输入文本：剪贴板+Ctrl+V 粘贴式（布局无关，支持中文），事后尽力恢复剪贴板 | 注入 |
| cua_key | 按键/组合键（"enter"、"ctrl+shift+t"、"alt+f4"、"win"），一个组合只含一个主键，+ 键写作 plus；整组事件一次 SendInput 原子注入 | 注入 |
| cua_read_clipboard | 读剪贴板文本（截断 8000 字符） | 只读 |
| cua_write_clipboard | 写剪贴板文本 | 注入 |
| cua_list_windows | 枚举可见顶层窗口（标题/PID/矩形/最小化/前台，可按标题过滤） | 只读 |
| cua_activate_window | 按 hwnd 或唯一标题激活窗口（先还原最小化） | 注入 |
| cua_wait | 等待 50–30000ms（可中止） | 只读 |

## 坐标系约定（对齐 Claude Desktop）

- 一切坐标 = **原始屏幕物理像素**，原点在主显示器左上角；多显示器向右/下延伸（可能为负值）
- 截屏可能被缩小传输（maxWidth），但 `scale` 因子随图返回；**点击/输入坐标永远基于原始分辨率**，不基于编码图片像素
- 截屏结果文本中重复此约定，模型无需额外记忆

## 安全模型

1. **会话开关默认关**：`/cua on` 后才放行（开启时探测原生层，失败则保持关闭并报错；非 Windows 不会被开启）；所有 `cua_*` 调用经 `tool_call` 钩子拦截（复用 Pi 扩展审批管线位置）
2. **开启后全放行**（用户选定策略）：不做逐次确认；用户对开关负责
3. 开启时通知提醒（`ui.notify` warning 级）："点击/输入等操作将直接作用于桌面"
4. 注入类工具标注 `destructiveHint`/`openWorldHint`，只读类标注 `readOnlyHint`，供权限扩展/审计识别
5. 全部工具（含 cua_wait）`executionMode: sequential`（桌面是共享可变状态，操作串行）
6. 红线：不读取凭据文件；不注入 UAC/管理员提权对话框确认（SendInput 会被 UIPI 拦截，属系统保护）

## 实现分层

```
Pi 扩展 desktop-cua（extension.ts：工具定义/开关/gate）
  └─ core.ts（平台分发、会话状态、键名解析、类型；静态 import win32Native 以便打包）
       └─ win32Native.ts（createRequire 懒加载 koffi：SendInput/BitBlt/EnumWindows/剪贴板/RtlMoveMemory）
       └─ imageEncode.ts（nativeImage JPEG 优先，纯 JS PNG（zlib）兜底；双线性缩小）
       └─ types.ts（共享类型）
```

- koffi 约定：结构体/联合体用普通 JS 对象传值，出参以 `_Out_`/`_Inout_` 声明并回填，Buffer 按指针原地写入（koffi 类型对象不可 `new`）
- 剪贴板：Win32 CF_UNICODETEXT（打开失败时短暂重试）；只能恢复文本剪贴板，图片/文件等非文本内容在 cua_type 后会丢失
- 截屏：GDI `BitBlt(SRCCOPY|CAPTUREBLT)` 虚拟桌面；加载时把当前线程设为 Per-Monitor-V2 DPI 感知（不依赖宿主进程的清单），物理像素坐标与 SendInput 归一化坐标一致
- 输入：SendInput 批量原子注入；键盘事件带扫描码与扩展键标志；绝对坐标按虚拟桌面归一化到 0..65535；等待类操作（拖拽、粘贴、激活窗口、剪贴板重试）均为异步，不阻塞 agent 事件循环
- 打包：koffi 同时声明在 `@pidesktop/agent`（类型检查）与 `@pidesktop/desktop`（electron-vite 外部化 + electron-builder 随包分发）；原生预编译包 `@koromix/koffi-win32-x64` 必须显式写进 desktop 的 `optionalDependencies`（与 `@esbuild/*` 同理，electron-builder 不会收集传递的可选依赖），`.node` 由 asarUnpack 解包

## 已知边界（v1）

- 无隐私遮罩（Claude 的 maskedWindowRects 等价物）与自有窗口排除——截屏包含 pi-desktop 自身窗口
- 无 UIA 无障碍树工具（set_value/select_text/get_app_state 等，v2 候选）
- 无屏幕内容查找（find text/image on screen，v2 候选）
- 无操作录制/回放（Claude watchRecord 等价物）
- 会话开关状态为内存态：重启会话后回到默认关闭；未做设置页持久化开关
- cua_activate_window 受系统前台锁定策略限制（首次失败会模拟一次 Alt 后重试，仍可能失败）
- 目标窗口以管理员权限运行时，SendInput 被 UIPI 拦截（报错说明原因）
- Electron utility process 中 `nativeImage` 可能不可用，此时截图为 PNG（2560×1440 缩到 1600 宽约 0.9MB）
- 截屏被前台程序 DRM/保护拦截时 BitBlt 报错（错误信息说明原因）

## 验证范围

- [x] `pnpm typecheck` 全部 workspace 包通过
- [x] 单元测试 `tests/cua.test.mjs` 11/11；全量 `pnpm test` 1287 项（1285 通过、2 跳过、0 失败）
- [x] Node + koffi 3.3.7 原生实测：截屏（物理分辨率）、光标、枚举窗口、剪贴板往返、记事本端到端（激活 → 点击 → 中文粘贴输入 → ctrl+a/ctrl+c 读回一致）
- [x] Electron 44 utility process 内实测：DPI 感知生效（125% 缩放下取到 2560×1440 物理分辨率）、截屏（nativeImage 不可用，走 PNG）、枚举窗口、剪贴板、按键注入
- [x] `pnpm build` 产物：win32Native 被打进 agentHostImpl chunk，koffi 以 `createRequire(import.meta.url)` 运行时加载
- [x] 打包冒烟（dist-win --dir）：koffi 进入 app.asar，`@koromix/koffi-win32-x64/win32_x64/koffi.node` 解包；用打包后的 exe 从 app.asar 内解析并加载 koffi、调用 Win32 成功
- [ ] 完整应用内由模型驱动的 `/cua on` → 工具调用（未在运行中的会话里实测）

## 参考

- 本项目逆向知识库：`E:\ai-work2\codex_reverse\_ai_work\codex-desktop\KNOWLEDGE.md`（F28/F31/F43 cua 编排、F22/F41 owl 架构）
- Claude Desktop 逆向：`E:\ai-work2\claudeproxy\_ai_work\reverse\claude-desktop-4.23118.1.0\`（computer 工具 schema、cu_* 导出、teach/watch）
- zcode：`E:\ai-work2\pi_desttop\reference\zcode\packages\zcode-cua\`（契约面）、`packages\services\src\cua-permission-broker\`（helper 生命周期）
