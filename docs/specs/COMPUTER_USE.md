# Computer Use（CUA）规格说明

> Windows 实现。本文描述 `desktop-cua` 的应用授权、窗口观察与输入行为。
> 设计参考：Codex Desktop（sky/cua 分层 + host 编排）、Claude Desktop（单坐标系约定、剪贴板粘贴式输入、JPEG q75+maxWidth）、zcode（fail-closed 平台策略、会话开关；v1.2 借鉴其类型化错误码 + actionSent、frame 精确栅格、锁屏 fail-closed、会话结束释放修饰键与模型面使用守则；v2.0 借鉴其无障碍优先 + 窗口作用域范式：get_app_state 元素索引观察与 captureWindowPng 窗口截屏）。

## 概述

给 Pi 会话提供操控本机桌面的一组工具：截屏、无障碍树观察、鼠标、键盘、剪贴板、窗口管理。模型通过工具调用观察屏幕并执行操作，与用户共享同一桌面（不做虚拟桌面/沙箱）。

- 入口：工具首次访问一个权限范围时显示授权选项。应用、窗口列表、整屏或区域截图、剪贴板读写分别授权。
- 工具注册：内置隐藏扩展 `desktop-cua`（`packages/agent/src/cua/`），随每个 Pi 会话运行时创建
- 原生层：koffi 3.3.7（N-API FFI，预编译包 `@koromix/koffi-<平台>`，不跑源码构建脚本）直调 Win32 —— SendInput（键鼠）、GDI BitBlt/PrintWindow（截屏）、EnumWindows（窗口）、CF_UNICODETEXT（剪贴板）、UIAutomation COM vtable（无障碍树）
- 懒加载：扩展构建与模块导入都不触碰原生代码；koffi 与 DLL 绑定在首次调用 `cua_*`（或 `/cua on` 探测）时才加载，加载失败只影响 CUA，不影响会话启动
- 平台：Windows 完整实现；macOS/Linux 工具可见但执行时返回明确"平台不支持"（fail-closed，不降级）
- 失败语义（v1.2）：所有工具失败抛 `CuaError`，消息内嵌封闭错误码与 `actionSent` 标志（`CUA <CODE> (actionSent=<bool>): <详情>`）；动作可能已送达目标应用时 actionSent=true，模型仅可在 false 时安全重试非幂等动作
- 帧校验（v1.2）：每次截屏分配递增 frame 号并记录当时虚拟桌面几何；坐标类工具可传该 frame 号，执行前校验屏幕布局未变，已变则拒绝（STALE_STATE）而不是点错位置。只校验布局变化，不检测内容变化
- 锁屏门（v1.2）：注入与截屏前探测 `OpenInputDesktop`；屏幕锁定或安全桌面（UAC）活动时直接拒绝（SCREEN_LOCKED），不盲注
- 释放兜底（v1.2）：`/cua off` 与会话结束时尽力发送一次"释放全部修饰键"原子批次（多余 KEYUP 被系统忽略），防止中止后用户键盘卡住；仅在本会话已启用时触发，不触碰未加载的原生层
- 无障碍优先（v2.0，借鉴 zcode）：`cua_get_state` 读取目标窗口的 UIA 控制视图树为带索引的紧凑元素行；点击/滚轮工具接受 `element` 索引寻址，解析为元素中心坐标并校验窗口未移动（索引超出/窗口移动/元素离屏均 fail-closed），无需从截图推算坐标
- 窗口作用域：`cua_screenshot({window})` 用 `PrintWindow` 抓取目标窗口并按 DWM 边界裁剪；也支持组合 `window` 与 `x/y/width/height`（屏幕物理像素，自动裁剪到窗口边界内）单独截取被遮挡窗口的局部区域。窗口抓取失败返回 `CAPTURE_BLOCKED`。不传 `window` 的整屏和区域截图使用独立授权和 `BitBlt` 路径。
- 窗口绑定输入：鼠标和键盘动作支持 `window` 参数。单窗口截图的 `frame` 或 UIA 的 `element` 也会绑定目标窗口。输入前会尝试激活目标并核对前台窗口，鼠标动作还会用 `WindowFromPoint` 核对落点。目标窗口被遮挡或焦点切换时返回 `TARGET_MISMATCH`，请重新观察。目标窗口自己弹出的同进程弹层（被它拥有的弹出窗口，以及同一 UI 线程的菜单 `#32768`、下拉列表 `ComboLBox`）视为目标的一部分：落点与前台检查都接受，且不会为了激活主窗口而把弹层关掉。键盘输入仍要求焦点在目标窗口本身；模态对话框会禁用主窗口，需改用对话框的 hwnd 重新观察。

## 工具面（17 个）

| 工具 | 说明 | 注解 |
| --- | --- | --- |
| cua_screenshot | 截屏：整桌面 / 区域 / `window` 单窗口（`PrintWindow` + DWM 边界裁剪，遮挡部分也截入；可与 `x/y/width/height` 组合截取被遮挡窗口的局部区域，坐标仍为屏幕物理像素并自动限制在窗口边界内），返回图片（JPEG q75，默认 maxWidth 1600 双线性缩小）+ 分辨率/光标/**frame 帧号**（窗口作用域时帧内含整窗矩形与裁剪区域边界） | 只读 |
| cua_get_state | 读取窗口 UIA 无障碍树（v2.0）：紧凑元素行带索引（角色/名称/automationId/矩形/值/状态），存为会话最近观察；缺省前台窗口，可传 hwnd 或唯一标题 | 只读 |
| cua_invoke | 用 `observationId` 和 `element` 触发支持 Invoke 的控件 | 应用控制 |
| cua_set_value | 用同样的观察参数设置支持 SetValue 的控件文本 | 应用控制 |
| cua_mouse_move | 移动鼠标到物理像素坐标（可选 frame 校验） | 注入 |
| cua_left_click | 左键单击：坐标、element 索引（解析中心并校验窗口未移动，与坐标互斥）或当前位置；可选 frame 校验 | 注入 |
| cua_double_click | 左键双击（同上，可选 element/frame） | 注入 |
| cua_right_click | 右键单击（上下文菜单；同上，可选 element/frame） | 注入 |
| cua_drag | 按住左键从起点拖到终点（缓动插值，默认 350ms，可中止，结束必定松开左键；可选 frame 校验；中止/释放失败时报告 actionSent 与"左键可能仍被按住"） | 注入 |
| cua_scroll | 滚轮：可指定坐标或 element，缺省在当前光标处（格数，正=下/右，可水平） | 注入 |
| cua_type | 64 字符内单行文本默认 Unicode 键入，其余默认剪贴板粘贴，可显式传 `method`。剪贴板含富文本/图片/文件时不覆盖：单行文本（≤1000 字符）自动改用 Unicode，多行文本报 `CLIPBOARD_FORMATS`，需显式传 `method: "unicode"`（换行和 Tab 作为真实按键发送，可能触发提交或切换焦点） | 注入 |
| cua_key | 按键/组合键（"enter"、"ctrl+shift+t"、"alt+f4"、"win"），一个组合只含一个主键，+ 键写作 plus；整组事件一次 SendInput 原子注入 | 注入 |
| cua_read_clipboard | 读剪贴板文本（截断 8000 字符） | 只读 |
| cua_write_clipboard | 写剪贴板文本 | 注入 |
| cua_list_windows | 枚举可见顶层窗口（标题/**进程可执行名**/PID/矩形/最小化/前台，可按标题过滤） | 只读 |
| cua_activate_window | 按 hwnd 或唯一标题激活窗口（先还原最小化）；零匹配报 TARGET_GONE、多匹配报 AMBIGUOUS_TARGET、抢焦点失败报 FOREGROUND_FAILED | 注入 |
| cua_wait | 等待 50–30000ms（可中止） | 只读 |

## 坐标系约定（对齐 Claude Desktop）

- 一切坐标 = **原始屏幕物理像素**，原点在主显示器左上角；多显示器向右/下延伸（可能为负值）
- 默认使用原始物理像素。若指定 `coordinateSpace: "image"` 和 `frame`，程序按记录的原始尺寸、编码尺寸和抓取原点换算坐标。
- 截屏结果文本中重复此约定，模型无需额外记忆
- 截图返回 frame 帧号；同一帧上可连续执行多个确定性动作，布局变化后旧帧失效（STALE_STATE，需重新截屏）
- 显式 `window`、窗口 `frame` 和 `element` 一起使用时必须指向同一窗口。按应用授权的拖拽校验起点、途经点和终点，适用于应用窗口内的操作。

## 安全模型

1. 每项权限可选择「本对话内允许」「仅本次允许」「始终允许（所有对话）」或「拒绝」。「本对话内允许」只保存在当前对话的运行时内存中，不写盘、不被其他对话继承；「仅本次允许」只覆盖当前这一次工具调用。应用身份使用 AUMID 或完整可执行文件路径。排队和确认之后重新核验窗口的应用身份和 PID，再读图或发出输入。
2. 「始终允许」存到 Pi 用户目录的 `desktop-cua-app-permissions/`，对之后的所有对话生效。用 `/cua off` 关闭当前对话的电脑控制（同时撤销本对话内授权），用 `/cua on` 重新启用，用 `/cua reset` 清除记住的授权。旧的对话许可只负责启停。
3. **不能授权控制 Pi Desktop 自身**：应用身份等于宿主可执行文件（`process.execPath`）的窗口一律拒绝（PERMISSION_DENIED），即使已有记住的授权也不放行，也不会弹出授权选项。否则模型可以操作自己的授权弹窗、设置和其他会话，绕过按应用授权。未指定目标时默认取前台窗口，而前台通常就是 Pi 自身，因此模型需要先用 `cua_list_windows` 找到目标窗口再传 `window`/`hwnd`。
4. Agent 进程内队列和 Windows 命名互斥锁覆盖准备、执行与清理。授权提示和 `cua_wait` 在锁外等待。中止的排队动作会退出队列。
5. 输入桌面不可访问时拒绝截图和输入。窗口或落点改变时请重新观察。错误中的 `actionSent` 表示操作可能已送达，有副作用的操作需要先检查结果再重试。

## 无障碍树与元素寻址（v2.0）

- 观察语义：`cua_get_state` 一次返回整棵控制视图树（上限默认 400 元素/可调 1000，超出截断并提示）；元素行格式 `[索引] 角色 "名称" id=automationId [x,y WxH] 值="…" 标志`，根元素（窗口自身）为 [0]，索引为 pre-order DFS 序号
- 元素索引与 `observationId` 配对。点击和滚动使用元素中心点。UIA 语义动作重新定位控件并比对运行时 ID，窗口切换、控件失效、跨进程或不可用时拒绝。控件执行成功后重新观察。
- Invoke/SetValue 在 koffi 工作线程上调用（UIA 以 MTA 初始化）。WinForms 等提供者会在目标 UI 线程上同步执行点击，打开模态对话框的按钮要等对话框关闭才返回；改用工作线程后，这种情况不会阻塞 agent 事件循环。超过 5 秒未返回时，工具结果为「已送达但未返回」（`completed: false`），COM 引用在调用真正返回后才释放；在此期间新的 UIA 语义动作会被拒绝（INPUT_BLOCKED），鼠标和键盘工具不受影响。
- 默认读取控制视图。顶层提供者仅返回窗口边框时会尝试读取同进程的原生子窗口。也可指定 `view: "raw"`。应用授权的树输出限定在目标进程，被 UIA 标记为密码的值不返回。
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
- 剪贴板粘贴保留纯文本和空剪贴板状态。遇到富文本、文件或图片格式会拒绝暂存。粘贴和恢复前会检查 Windows 剪贴板序号，避免覆盖期间用户复制的新内容。
- 整屏和区域截图使用 `BitBlt`。窗口截图用 `PrintWindow` 按 `GetWindowRect` 尺寸渲染（含 Win10/11 左右下约 7px 的不可见缩放边框），再裁剪到 DWM 可见边界或请求的局部区域，使图片像素与 frame 记录的屏幕原点逐像素对齐（早期实现按 DWM 尺寸建位图，带不可见边框的窗口截图会整体横向错位）。截屏区域参数只在 `core.ts` 的 `normalizeRegion` 校验一次（四项齐全、取整、有限值、宽高大于 0），原生层只负责限制到屏幕或窗口范围内。Win32 线程设置 Per-Monitor-V2 DPI 感知，截图和 UIA 返回物理像素坐标。
- 输入：SendInput 批量原子注入；键盘事件带扫描码与扩展键标志；绝对坐标按虚拟桌面归一化到 0..65535；等待类操作（拖拽、粘贴、激活窗口、剪贴板重试）均为异步，不阻塞 agent 事件循环
- 打包：koffi 同时声明在 `@pidesktop/agent`（类型检查）与 `@pidesktop/desktop`（electron-vite 外部化 + electron-builder 随包分发）；原生预编译包 `@koromix/koffi-win32-x64` 必须显式写进 desktop 的 `optionalDependencies`（与 `@esbuild/*` 同理，electron-builder 不会收集传递的可选依赖），`.node` 由 asarUnpack 解包

## 已知边界

- 无隐私遮罩（Claude 的 maskedWindowRects 等价物）；但 v2.0 窗口作用域截屏已可避开拍入 pi-desktop 自身窗口与无关桌面内容
- UIA 语义动作依赖目标应用提供对应模式。Chromium/Electron 窗口在未开启无障碍时树较稀疏。
- 无屏幕内容查找（find text/image on screen，候选）
- 无操作录制/回放（Claude watchRecord 等价物）
- frame 校验检测屏幕几何与窗口矩形变化，窗口绑定额外检查实际前台与落点。窗口内容变化仍需重新观察，帧号仅保留最近 8 帧。
- `cua_activate_window` 受系统的前台激活规则限制。桌面应用授权路径在激活失败时会返回错误。
- 目标窗口以管理员权限运行时，SendInput 被 UIPI 拦截（INPUT_BLOCKED；部分注入时 actionSent=true）
- Electron utility process 中 `nativeImage` 可能不可用，此时截图为 PNG（2560×1440 缩到 1600 宽约 0.9MB）
- 截屏被前台程序 DRM/保护拦截时 BitBlt 报错（CAPTURE_BLOCKED，错误信息说明原因）

## 验证范围

- 独立 WinForms 窗口验证脚本使用真实 UIA 和键鼠。覆盖了 DPI 120 与 DPI 96、遮挡、模态弹窗、焦点切换、窗口移动、两个对话争用及排队中止。测试按窗口收到的事件断言输入目标。
- SDK 集成测试用本地模型响应验证授权选项、记住的权限和拒绝状态。剪贴板并发替换和中止恢复使用模拟剪贴板验证。
- 使用以下命令构建并运行独立窗口测试。测试只操作自己启动的窗体。

  ```powershell
  dotnet build tests/fixtures/cua/capture/Capture.csproj -c Release --artifacts-path _ai_work/cua-capture-build
  node tests/fixtures/cua/run.mjs verify
  ```

- 窗口局部截图（2026-11-28）：`tests/cua.test.mjs` 当前 46 项全部通过，新增覆盖区域参数规范化、BGRA 精确裁剪、窗口局部截图的 PNG 像素内容、缩小后的图片坐标点击换算、窗口移动后拒绝旧帧，以及只凭应用授权即可截取局部区域（整屏授权被拒时）。win32 冒烟实截真实窗口的局部区域并核对尺寸与原点。另用当时的前台窗口比对 `captureWindow` 与同一矩形的 `BitBlt` 截图：对齐时平均通道差 0.07，人为错开 1–8px 时为 4.7–8.3，确认裁剪后图片与屏幕坐标对齐。本轮未重跑上面的 WinForms 独立窗口验证。

### 窗口截图后端评估

每种应用和遮挡状态下，两个后端各独立启动测试进程，预热一次后采集 6 次。成功指标为抓取完成且画面有多个颜色采样值。耗时包含取图和读回，内存为测试进程的工作集。CPU 记为 0 表示进程计数器在该采样间隔没有增量。WGC 每次创建独立的捕获会话，未测常驻会话的连续采集。

| 窗口 | 状态 | PrintWindow 非空帧 | WGC 非空帧 | 耗时中位数 PrintWindow / WGC | 进程 CPU 中位数 PrintWindow / WGC | 工作集 PrintWindow / WGC |
| --- | --- | --- | --- | --- | --- | --- |
| WinForms | 可见 | 6/6 | 6/6 | 7.9 / 52.8 ms | 0 / 31.3 ms | 27.5 / 87.8 MiB |
| WinForms | 遮挡 | 6/6 | 6/6 | 7.4 / 54.9 ms | 0 / 31.3 ms | 27.5 / 88.1 MiB |
| Chromium | 可见 | 6/6 | 6/6 | 7.9 / 57.7 ms | 0 / 15.6 ms | 27.5 / 88.8 MiB |
| Chromium | 遮挡 | 6/6 | 6/6 | 7.7 / 56.5 ms | 0 / 31.3 ms | 27.5 / 88.7 MiB |
| Microsoft Word | 可见 | 6/6 | 6/6 | 21.7 / 75.8 ms | 0 / 62.5 ms | 27.5 / 166.6 MiB |
| Microsoft Word | 遮挡 | 6/6 | 6/6 | 21.3 / 71.5 ms | 7.8 / 78.1 ms | 27.5 / 166.1 MiB |

因此，单次窗口截图默认采用 `PrintWindow`。运行 `node tests/fixtures/cua/run.mjs benchmark` 可复测。传入 Word 可执行文件作为第二个参数可加测独立空白 Word 实例。WGC 通过 [Microsoft 的窗口捕获接口](https://learn.microsoft.com/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow) 实现。

### 早期验证记录

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
