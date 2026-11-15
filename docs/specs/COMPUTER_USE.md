# Computer Use（CUA）规格说明

> 状态：v2.0（Windows 实现，按对话请求授权）。本文描述 `desktop-cua` 内置扩展的行为、安全模型与验证范围。
> 设计参考：Codex Desktop（sky/cua 分层 + host 编排）、Claude Desktop（单坐标系约定、剪贴板粘贴式输入、JPEG q75+maxWidth）、zcode（fail-closed 平台策略、会话开关；v1.2 借鉴其类型化错误码 + actionSent、frame 精确栅格、锁屏 fail-closed、会话结束释放修饰键与模型面使用守则；v2.0 借鉴其无障碍优先 + 窗口作用域范式：get_app_state 元素索引观察与 captureWindowPng 窗口截屏）。

## 概述

给 Pi 会话提供操控本机桌面的一组工具：截屏、无障碍树观察、鼠标、键盘、剪贴板、窗口管理。模型通过工具调用观察屏幕并执行操作，与用户共享同一桌面（不做虚拟桌面/沙箱）。

- 入口：AI 首次调用 `cua_*` 工具时，暂停调用并显示电脑控制授权确认。用户确认后执行原调用，同一对话后续无需重复确认；仍支持 `/cua on|off` 手动开启、撤销授权
- 工具注册：内置隐藏扩展 `desktop-cua`（`packages/agent/src/cua/`），随每个 Pi 会话运行时创建
- 原生层：koffi 3.3.7（N-API FFI，预编译包 `@koromix/koffi-<平台>`，不跑源码构建脚本）直调 Win32 —— SendInput（键鼠）、GDI BitBlt/PrintWindow（截屏）、EnumWindows（窗口）、CF_UNICODETEXT（剪贴板）、UIAutomation COM vtable（无障碍树）
- 懒加载：扩展构建与模块导入都不触碰原生代码；koffi 与 DLL 绑定在首次调用 `cua_*`（或 `/cua on` 探测）时才加载，加载失败只影响 CUA，不影响会话启动
- 平台：Windows 完整实现；macOS/Linux 工具可见但执行时返回明确"平台不支持"（fail-closed，不降级）
- 失败语义（v1.2）：所有工具失败抛 `CuaError`，消息内嵌封闭错误码与 `actionSent` 标志（`CUA <CODE> (actionSent=<bool>): <详情>`）；动作可能已送达目标应用时 actionSent=true，模型仅可在 false 时安全重试非幂等动作
- 帧校验（v1.2）：每次截屏分配递增 frame 号并记录当时虚拟桌面几何；坐标类工具可传该 frame 号，执行前校验屏幕布局未变，已变则拒绝（STALE_STATE）而不是点错位置。只校验布局变化，不检测内容变化
- 锁屏门（v1.2）：注入与截屏前探测 `OpenInputDesktop`；屏幕锁定或安全桌面（UAC）活动时直接拒绝（SCREEN_LOCKED），不盲注
- 释放兜底（v1.2）：`/cua off` 与会话结束时尽力发送一次"释放全部修饰键"原子批次（多余 KEYUP 被系统忽略），防止中止后用户键盘卡住；仅在本会话已启用时触发，不触碰未加载的原生层
- 无障碍优先（v2.0，借鉴 zcode）：`cua_get_state` 读取目标窗口的 UIA 控制视图树为带索引的紧凑元素行；点击/滚轮工具接受 `element` 索引寻址，解析为元素中心坐标并校验窗口未移动（索引超出/窗口移动/元素离屏均 fail-closed），无需从截图推算坐标
- 窗口作用域（v2.0）：`cua_screenshot` 支持 `window` 参数，只截取单个窗口（DWM 扩展边界 + PrintWindow，被遮挡也能截到；BitBlt 兜底）；帧记录携带窗口矩形，窗口移动后旧帧坐标拒绝执行

## 工具面（15 个）

| 工具 | 说明 | 注解 |
| --- | --- | --- |
| cua_screenshot | 截屏：整桌面 / 区域 / `window` 单窗口（DWM 边界 + PrintWindow，遮挡部分也截入，与区域参数互斥），返回图片（JPEG q75，默认 maxWidth 1600 双线性缩小）+ 分辨率/光标/**frame 帧号**（窗口作用域时帧内含窗口矩形） | 只读 |
| cua_get_state | 读取窗口 UIA 无障碍树（v2.0）：紧凑元素行带索引（角色/名称/automationId/矩形/值/状态），存为会话最近观察；缺省前台窗口，可传 hwnd 或唯一标题 | 只读 |
| cua_mouse_move | 移动鼠标到物理像素坐标（可选 frame 校验） | 注入 |
| cua_left_click | 左键单击：坐标、element 索引（解析中心并校验窗口未移动，与坐标互斥）或当前位置；可选 frame 校验 | 注入 |
| cua_double_click | 左键双击（同上，可选 element/frame） | 注入 |
| cua_right_click | 右键单击（上下文菜单；同上，可选 element/frame） | 注入 |
| cua_drag | 按住左键从起点拖到终点（缓动插值，默认 350ms，可中止，结束必定松开左键；可选 frame 校验；中止/释放失败时报告 actionSent 与"左键可能仍被按住"） | 注入 |
| cua_scroll | 滚轮：缺省当前光标处；提供 element 时先移到元素中心再滚（格数，正=下/右，可水平） | 注入 |
| cua_type | 输入文本：剪贴板+Ctrl+V 粘贴式（布局无关，支持中文），事后尽力恢复剪贴板 | 注入 |
| cua_key | 按键/组合键（"enter"、"ctrl+shift+t"、"alt+f4"、"win"），一个组合只含一个主键，+ 键写作 plus；整组事件一次 SendInput 原子注入 | 注入 |
| cua_read_clipboard | 读剪贴板文本（截断 8000 字符） | 只读 |
| cua_write_clipboard | 写剪贴板文本 | 注入 |
| cua_list_windows | 枚举可见顶层窗口（标题/**进程可执行名**/PID/矩形/最小化/前台，可按标题过滤） | 只读 |
| cua_activate_window | 按 hwnd 或唯一标题激活窗口（先还原最小化）；零匹配报 TARGET_GONE、多匹配报 AMBIGUOUS_TARGET、抢焦点失败报 FOREGROUND_FAILED | 注入 |
| cua_wait | 等待 50–30000ms（可中止） | 只读 |

## 坐标系约定（对齐 Claude Desktop）

- 一切坐标 = **原始屏幕物理像素**，原点在主显示器左上角；多显示器向右/下延伸（可能为负值）
- 截屏可能被缩小传输（maxWidth），但 `scale` 因子随图返回；**点击/输入坐标永远基于原始分辨率**，不基于编码图片像素
- 截屏结果文本中重复此约定，模型无需额外记忆
- 截图返回 frame 帧号；同一帧上可连续执行多个确定性动作，布局变化后旧帧失效（STALE_STATE，需重新截屏）

## 安全模型

1. **未授权时先等待用户确认**：所有 `cua_*` 调用经 `tool_call` 钩子拦截（复用 Pi 扩展审批管线与按对话显示的确认界面）。确认前不探测原生层、不截屏、不注入输入；确认后才探测原生层并放行原调用。非 Windows、原生层失败、授权记录读写失败均不放行
2. **授权仅覆盖当前对话**：确认文案明确包含屏幕、剪贴板、鼠标和键盘能力。确认后本对话不再逐次询问；并发首次调用合并为一次确认。取消后记住拒绝决定，后续调用直接返回拒绝原因，不反复弹出。`/cua on` 可重新开启，`/cua off` 撤销并禁止再次自动询问
3. **本机保存决定**：Pi 用户目录的 `desktop-cua-permissions/` 按工作目录、会话 ID、会话文件路径分别保存授权或拒绝记录，重新打开同一对话仍有效。记录独立于对话正文，分叉、新建或导入其他路径的对话不继承。停止任务或销毁运行时后到达的确认结果作废，不会写入授权；无确认界面的首次调用保持关闭
4. 注入类工具标注 `destructiveHint`/`openWorldHint`，只读类标注 `readOnlyHint`，供权限扩展/审计识别
5. 全部工具（含 cua_wait）`executionMode: sequential`（桌面是共享可变状态，操作串行）
6. 红线：不读取凭据文件；不注入 UAC/管理员提权对话框确认（SendInput 会被 UIPI 拦截，属系统保护）
7. **类型化错误（v1.2，借鉴 zcode）**：封闭错误码 PERMISSION_DENIED / UNSUPPORTED_PLATFORM / INVALID_ARGUMENTS / SCREEN_LOCKED / STALE_STATE / TARGET_GONE / AMBIGUOUS_TARGET / FOREGROUND_FAILED / INPUT_BLOCKED / CAPTURE_BLOCKED / CLIPBOARD_BUSY / ABORTED / ELEMENT_UNAVAILABLE / INTERNAL（v2.0 新增 ELEMENT_UNAVAILABLE）；`actionSent` 标志动作是否可能已送达，只有 false 时才可安全重试非幂等动作
8. **锁屏与释放兜底（v1.2）**：输入桌面不可访问（锁屏/安全桌面/断开的会话）时注入与截屏均 fail-closed；撤销与会话结束强制释放全部修饰键
9. **无障碍树只读 + 元素寻址 fail-closed（v2.0）**：UIA 访问仅限只读（元素获取/属性读取/树遍历），不注册事件回调、不调用写式 pattern；element 索引仅在最近一次观察内有效，执行前校验窗口矩形未变，越界/移动/离屏一律拒绝并提示重新观察（ELEMENT_UNAVAILABLE / STALE_STATE）；/cua off 与会话结束同时清空观察

## 无障碍树与元素寻址（v2.0）

- 观察语义：`cua_get_state` 一次返回整棵控制视图树（上限默认 400 元素/可调 1000，超出截断并提示）；元素行格式 `[索引] 角色 "名称" id=automationId [x,y WxH] 值="…" 标志`，根元素（窗口自身）为 [0]，索引为 pre-order DFS 序号
- 寻址语义：动作工具传 `element` 索引 → 取该元素矩形中心（clamp 在窗口矩形内）作为坐标；执行前校验最近观察的窗口矩形与当前一致（移动/改大小报 STALE_STATE），元素离屏或无矩形报 ELEMENT_UNAVAILABLE；同一观察上可连续执行多个确定性动作
- Chromium/Electron 窗口的树可能只暴露标题栏与空 pane（浏览器未开启无障碍时）；此时回退 cua_screenshot 坐标方式，Win32 原生应用（记事本/资源管理器/Office 等）树完整
- UIA 实现为手动 COM vtable 调用（无原生编译）：IUIAutomation(6)→ElementFromHandle、属性经 GetCurrentPropertyValue(10)、ControlViewWalker(14) 遍历；VARIANT 用 24 字节 Buffer 传参后原生读取（vt@0/union@8）并 VariantClear；字符串一律 lstrlenW+RtlMoveMemory 拷贝（koffi str16 解码整数地址会段错误）；每个元素用毕 Release

## 实现分层

```
Pi 扩展 desktop-cua（extension.ts：工具定义/开关/gate）
  └─ core.ts（平台分发、会话状态、键名解析、类型；静态 import win32Native 以便打包）
       └─ win32Native.ts（createRequire 懒加载 koffi：SendInput/BitBlt/EnumWindows/剪贴板/RtlMoveMemory；v1.2 新增 OpenInputDesktop 锁屏探测、QueryFullProcessImageNameW 进程名、releaseAllModifiers 修饰键释放；v2.0 新增 PrintWindow+DWM 边界窗口截屏、CoCreateInstance(CUIAutomation) 手动 vtable UIA 树抓取）
       └─ imageEncode.ts（nativeImage JPEG 优先，纯 JS PNG（zlib）兜底；双线性缩小）
       └─ types.ts（共享类型）
```

- koffi 约定：结构体/联合体用普通 JS 对象传值，出参以 `_Out_`/`_Inout_` 声明并回填，Buffer 按指针原地写入（koffi 类型对象不可 `new`）
- 剪贴板：Win32 CF_UNICODETEXT（打开失败时短暂重试）；只能恢复文本剪贴板，图片/文件等非文本内容在 cua_type 后会丢失
- 截屏：GDI `BitBlt(SRCCOPY|CAPTUREBLT)` 虚拟桌面；窗口作用域用 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 取精确边界 + `PrintWindow(PW_RENDERFULLCONTENT)`（含 DirectComposition/Chromium 内容，遮挡也截入），失败回退 BitBlt；加载时把当前线程设为 Per-Monitor-V2 DPI 感知（不依赖宿主进程的清单），物理像素坐标与 SendInput 归一化坐标、UIA 元素矩形一致
- 输入：SendInput 批量原子注入；键盘事件带扫描码与扩展键标志；绝对坐标按虚拟桌面归一化到 0..65535；等待类操作（拖拽、粘贴、激活窗口、剪贴板重试）均为异步，不阻塞 agent 事件循环
- 打包：koffi 同时声明在 `@pidesktop/agent`（类型检查）与 `@pidesktop/desktop`（electron-vite 外部化 + electron-builder 随包分发）；原生预编译包 `@koromix/koffi-win32-x64` 必须显式写进 desktop 的 `optionalDependencies`（与 `@esbuild/*` 同理，electron-builder 不会收集传递的可选依赖），`.node` 由 asarUnpack 解包

## 已知边界（v2.0）

- 无隐私遮罩（Claude 的 maskedWindowRects 等价物）；但 v2.0 窗口作用域截屏已可避开拍入 pi-desktop 自身窗口与无关桌面内容
- UIA 树为只读观察（v2.0）：set_value/select_text 等写式模式调用与元素 diff 树（zcode 省 token 手段）未实现，后续候选；Chromium/Electron 窗口在浏览器未开启无障碍时树较稀疏
- 无屏幕内容查找（find text/image on screen，候选）
- 无操作录制/回放（Claude watchRecord 等价物）
- 活跃开关为内存态，授权决定按对话保存在本机；恢复已授权对话时仍在首次工具调用前探测原生层。未做设置页全局开关
- frame 校验只检测屏幕几何（分辨率/显示器布局）与（v2.0）窗口矩形变化，不检测窗口内容变化；帧号仅保留最近 8 帧
- cua_activate_window 受系统前台锁定策略限制（首次失败会模拟一次 Alt 后重试，仍可能失败；此时 actionSent=true，Alt 键已送出）
- 目标窗口以管理员权限运行时，SendInput 被 UIPI 拦截（INPUT_BLOCKED；部分注入时 actionSent=true）
- Electron utility process 中 `nativeImage` 可能不可用，此时截图为 PNG（2560×1440 缩到 1600 宽约 0.9MB）
- 截屏被前台程序 DRM/保护拦截时 BitBlt 报错（CAPTURE_BLOCKED，错误信息说明原因）

## 验证范围

- [x] `pnpm typecheck` 全部 workspace 包通过
- [x] 单元测试 `tests/cua.test.mjs` 28/28（v1.2 新增 6 项：CuaError 格式与升级、frame 校验/过期/上限、锁屏 fail-closed、撤销与关闭释放修饰键、进程名与窗口错误码、参数校验错误码；v2.0 新增 4 项：get_state 索引行与观察存储、元素寻址中心解析与 fail-closed、窗口作用域截屏与帧窗口矩形校验、撤销清空观察；win32 冒烟扩展覆盖 windowRect/captureWindow/captureUiaTree）；全量 `pnpm test` 1309 项（1307 通过、2 跳过、0 失败）
- [x] UIA-over-koffi 可行性探针（`_ai_work/uia-probe.mjs` 系列）：CoCreateInstance(CUIAutomation)、手动 vtable 调用、VARIANT Buffer 读回、SAFEARRAY 矩形解码、BSTR 释放、ControlViewWalker 遍历全部实测通过；槽位与属性 ID 对照 SDK 10.0.18362 IDL 逐项核实（Name=30005 而非直觉记忆的 30022、IUIAutomation 槽位 5/6/14 等）
- [x] v2.0 生产代码真实冒烟：captureWindow（真实窗口 1316×919 真实像素）、captureUiaTree（含中文按钮名）、windowRect（DWM 扩展边界）
- [x] Node + koffi 3.3.7 原生实测：截屏（物理分辨率）、光标、枚举窗口、剪贴板往返、记事本端到端（激活 → 点击 → 中文粘贴输入 → ctrl+a/ctrl+c 读回一致）
- [x] Electron 44 utility process 内实测：DPI 感知生效（125% 缩放下取到 2560×1440 物理分辨率）、截屏（nativeImage 不可用，走 PNG）、枚举窗口、剪贴板、按键注入
- [x] `pnpm build` 产物：win32Native 被打进 agentHostImpl chunk，koffi 以 `createRequire(import.meta.url)` 运行时加载
- [x] 打包冒烟（dist-win --dir）：koffi 进入 app.asar，`@koromix/koffi-win32-x64/win32_x64/koffi.node` 解包；用打包后的 exe 从 app.asar 内解析并加载 koffi、调用 Win32 成功
- [ ] 完整应用内由在线模型驱动的授权 → 桌面操作（本次使用隔离授权测试，不操作用户桌面）
- [x] 对话授权回归：未确认前暂停、并发请求合并、拒绝不重复询问、撤销、终止后的迟到确认作废、记录损坏及原生层不可用时保持拦截
- [x] 真实 SDK + 本地离线模型通过 CUA 工具调用请求桌面确认，验证原调用继续、重开对话恢复授权、新对话重新询问和拒绝记忆（仅执行 `cua_wait`）
- [x] 隔离 renderer 中的首次授权确认与取消，桌面／窄窗口截图检查；不更改用户正在使用的对话授权

## 参考

- 本项目逆向知识库：`E:\ai-work2\codex_reverse\_ai_work\codex-desktop\KNOWLEDGE.md`（F28/F31/F43 cua 编排、F22/F41 owl 架构）
- Claude Desktop 逆向：`E:\ai-work2\claudeproxy\_ai_work\reverse\claude-desktop-4.23118.1.0\`（computer 工具 schema、cu_* 导出、teach/watch）
- zcode：`E:\ai-work2\pi_desttop\reference\zcode\packages\zcode-cua\`（契约面）、`packages\services\src\cua-permission-broker\`（helper 生命周期）、`E:\ZCode\analysis\`（ax_native 原生模块逆向归档，52 API 注册表）
