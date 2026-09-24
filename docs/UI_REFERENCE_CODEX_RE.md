# Codex UI 参考评估

日期：2026-09-24。参考目录：`D:\codex-re`。

## 结论

值得借鉴，主要收益在视觉规范的一致性、状态变化的连续性和阅读体验。Pi Desktop 已有深浅主题、可调侧栏、分组/置顶、居中对话列、底部输入框和两栏设置，整体布局无需推倒重做。

参考目录是 Codex Windows 客户端的解包与分析工作区，并非可直接开发的完整源码仓库。本次核对了实际 CSS 和业务 JS；结论针对目录中保存的版本，不等同于当前安装版本的所有行为。没有启动参考应用。交互示意是为 Pi 自行实现的设计建议，不是参考客户端运行截图或逐像素复刻。

## 建议优先级

下表记录参考评估时的起点；后续实现与验证见文末。

| 顺序 | 借鉴内容 | 当前项目的差距 | 建议落点 |
| --- | --- | --- | --- |
| 1 | 统一表面、边框、圆角、阴影和动效参数 | 已有颜色变量，但输入框、消息、浮层仍夹杂硬编码值；动画时长分散 | `styles.css` 与各组件 CSS；先建立少量语义变量 |
| 2 | 侧栏和工作台的连续展开/收起 | 侧栏最终样式覆盖为 `transition:none`；工作台直接在 `display:none/flex` 间切换 | `AppShell.tsx`、`WorkbenchSidePane.tsx`；展开约 200–300ms，拖拽保持即时跟手 |
| 3 | 工具活动的轻量披露与收起记忆 | 工具详情条件挂载、瞬间出现；运行数量变化会重新展开用户已收起的组 | `ChatView.tsx`；高度/透明度过渡，尊重用户主动收起 |
| 4 | 分段选中背景平移 | 搜索分类、工作台标签等仅立即换背景 | `SearchDialog.tsx`、工作台标签；文字和点击位置不动，仅移动指示背景 |
| 5 | 输入框由紧凑单行自然扩展到多行/附件形态 | 当前主要是 textarea 增高，外形与工具栏组织基本固定 | `Composer.tsx`；按内容、附件、窗口宽度切换形态，焦点和草稿保持稳定 |
| 6 | 有节制的等待提示和新增正文淡入 | 当前主要是 spinner 与闪烁游标 | `ChatView.tsx`、`MessageItem.tsx`；等待时低频反馈，只给新增块淡入 |
| 7 | 长会话定位、设置检索 | 目前以回到底部、分栏浏览为主 | 较长会话显示用户消息定位点；设置支持搜到具体配置项 |

## 原项目可确认的实现

### 视觉与动画参数

[app-shared CSS](D:/codex-re/ui/extracted/webview/assets/app-shared-b8a3f3143779.css:1) 定义了表面、次级表面、浮层、弱/普通/强边框等语义，基础间距是 4px，圆角分级为 4/6/8/10/12/16/20/24px；基础动效 150ms，较舒缓动效 300ms。入场曲线为 `cubic-bezier(.19,1,.22,1)`，离场为 `cubic-bezier(.8,0,.4,1)`。

Pi 的字体和侧栏尺寸已接近参考。建议收敛规则而非增大所有尺寸；普通行与分组使用间距和轻背景区分，浮层才使用较明显的边框和阴影。

### 面板与分段切换

[app-initial JS](D:/codex-re/ui/extracted/webview/assets/app-initial-78d977413c37.js:1) 的 AppShell 业务动画使用 `{type:'spring',duration:.5,bounce:.1}`，浮动左面板从 `opacity:0,x:-8` 进入，减少动态效果时改为零时长。共享 CSS 中 `.panel-animated [data-panel]` 对 `flex-grow/max-width` 使用 300ms，`.panel-dragging` 关闭过渡。

[animated-segmented-toggle](D:/codex-re/ui/extracted/webview/assets/animated-segmented-toggle-f3a771d1925d.js:1) 使用独立背景元素和 `layoutId`，spring 时长 280ms、bounce 0；按下缩放为 `.98`。这适合 Pi 的分段选择，不需要让整个文字或面板一起移动。

为 Pi 建议先采用较短的 200–300ms 面板过渡。参考中的 500ms spring 是原实现事实，不代表每个小控件都应照搬。

### 工具输出

[tool-activity-disclosure](D:/codex-re/ui/extracted/webview/assets/tool-activity-disclosure-9801aeab4a7c.js:1) 使用 ResizeObserver 测量内容高度，`initial:false`，展开时动画到真实高度并改变 opacity；关闭时设置 `aria-hidden`、`inert` 和 `pointerEvents:none`。它还单独记录用户手动收起。

当前 [ChatView.tsx](E:/ai-work2/pi_desttop/packages/ui/src/components/ChatView.tsx:85) 会在运行/失败/中断数量变化时调用 `setExpanded(true)`。可优先改善“我收起了就保持收起”，再加动画。流式日志增长时不应持续重新播放整组入场，历史回放也应直接显示。

### 输入框与信息层级

[app-initial CSS](D:/codex-re/ui/extracted/webview/assets/app-initial-e8ceb32eb626.css:1) 区分 composer 的 single-line/multiline 和 compact/comfortable 状态；单行可使用 22px 或胶囊圆角，附件和多行输入切换相应布局，内层附件圆角由外层圆角与 inset 推导。

Pi 可以先实现“空闲紧凑、输入多行展开、附件与输入框共享一个表面”，无需换富文本编辑器。参考对 Windows opaque 模式明确关闭背景 blur，毛玻璃不是必要条件。

### 流式反馈与减少动态效果

[app-initial JS](D:/codex-re/ui/extracted/webview/assets/app-initial-78d977413c37.js:1) 的思考状态扫光先等待 600ms，再每 4 秒触发一次、每次 1 秒，并清理定时器；辅助视觉副本 `aria-hidden`。[Markdown CSS](D:/codex-re/ui/extracted/webview/assets/app-initial-e8ceb32eb626.css:1) 对新增片段使用约 150ms 淡入，而不是不断重播整篇回复。

参考同时有系统偏好与应用级 System/On/Off。Pi 当前 [styles.css](E:/ai-work2/pi_desttop/packages/ui/src/styles.css:371) 的 reduced-motion 只覆盖 spinner 和 chevron，游标和其他过渡未统一覆盖。新增动效前先补齐降级规则，减少动态效果时所有内容仍即时可见。

### 适合后续阶段的功能

[用户消息定位轨道](D:/codex-re/ui/extracted/webview/assets/thread-user-message-navigation-rail-app-33e1d82a93e0.css:1) 有紧凑标记与约 160ms 的悬停变化，拖动定位时取消动画。[设置页面](D:/codex-re/ui/extracted/webview/assets/settings-page-a8df02374cb6.js:1) 支持搜索结果定位到具体 section 与文本。这两项对长会话和不断增长的设置更实用，可以放在基础动效统一之后。

## 落地边界

- 第一轮建议限于统一变量、面板展开、工具披露和分段指示器；其余单独推进，避免同时改交互结构与视觉。
- CSS 与少量测量逻辑足以完成第一轮。只有共享布局动画或复杂 spring 需求增多时，再评估引入 Motion；无需迁移当前状态管理。
- 频繁打开的模型菜单适合自行设计 150–200ms 的 opacity/小位移过渡。参考中普通 Radix Dialog/Popover 包装器不足以证明全部默认使用缩放动画；包内另有 600ms 入场的 Modal，不能泛化成统一标准。
- 截图验证应覆盖深浅主题与窄窗口；动画验证还应覆盖中途反向操作、拖拽、键盘焦点、长输出和减少动态效果。只看静态截图无法判断动效是否打断阅读。
- 参考评估阶段只产出对比记录与独立交互示意；随后按用户要求实现了以下优化。
- 独立示意已用隐藏 Electron 窗口验证展开、分类选择、模型菜单、320px 宽度和 reduced-motion；深浅主题截图已检查。验证脚本和截图保存在忽略目录 `out/ui-reference/`，测试窗口与进程已退出。

## 已实现与验证

2026-09-24，按用户要求在应用中落地第一轮优化，沿用 React、Zustand 和 CSS，没有新增动画依赖。

- 统一表面、边框、圆角、阴影及 150ms／280ms 动效变量；浅色主题具有独立阴影。菜单和对话框使用短淡入，系统减少动态效果时关闭动画与平滑滚动。
- 侧栏和工作台保留内容并连续展开／收起，拖拽时关闭过渡；隐藏内容立即设置 `inert`／`aria-hidden`。搜索分类和工作台标签共用实测几何的滑动背景。
- 输入框最初实现了单行／多行自适应，随后按用户反馈改为默认多行：文字在上、工具栏固定在下，空白和短文本也保持此布局。输入区最小 76px，随内容增高至 220px；保留同一个 textarea 的焦点和草稿。ResizeObserver 仅在宽度变化时于下一帧重新计算换行高度。
- 思考过程接入 Pi 的 `thinking_start`／`thinking_delta`／`thinking_end`，按约 80ms 合并更新；支持多块、历史恢复、取消与失败，最多保留 48,000 字符。只展示接口返回的公开文本，过滤签名和 redacted 内容；模型未返回思考时仅显示等待状态。
- 工具调用改为轻量活动行。思考和工具详情均支持高度／透明度过渡，手动展开／收起优先于后续事件；长执行输出预览末尾，提供复制、换行与展开。自动跟随底部时保留连续阅读，向上滚动后不抢位置。
- 独立复查补齐两项边界：思考块中途标记 redacted 时立即撤回旧投影及待发事件；宿主进入致命错误时结束思考／消息流和运行中的工具状态。

验证：`pnpm test` 共 210 项，209 通过、1 项 Unix 进程组测试在 Windows 跳过；类型检查、生产构建、Pi SDK 同步校验和 `git diff --check` 通过。隔离的隐藏 Electron 窗口加载真实生产 renderer，以模拟 IPC 事件验证流式更新、手动折叠、滚动位置、附件、长模型名称、侧栏拖拽、面板焦点和分段背景位置；检查 1280／1101／780／360px 窗口的深浅主题截图及 reduced-motion。脚本与截图位于 `out/review/motion/`。

本轮未调用在线模型；实际返回的思考内容取决于供应商和模型。未复制参考应用的私有实现，也未实现后续建议中的会话定位轨道、设置检索或 Markdown 逐块淡入。

### 回到底部按钮

随后按用户要求对齐参考中的 `Hxc`（`app-initial-78d977413c37.js`）和 `je`／`mt`（`thread-scroll-layout-8416989ad61e.js`）：按钮改为对话底部居中的 32px 圆形，位于输入区上沿上方 24px，1px 主题边框、无阴影，20px 向下箭头；运行中改为三个 4px 圆点，按 0／100／200ms 错峰波动。距底超过 24px 时显示，使用 150ms 透明度过渡，隐藏时退出 Tab 顺序并禁用点击。点击使用 260ms ease-out-cubic 滚动，滚轮、触摸、指针或滚动按键可中断；系统减少动态效果时立即到底并停用圆点动画。

验证了真实生产 renderer 的尺寸与位置、显隐阈值、运行状态、动画中途位置、滚轮中断、滚动中流式增量、深浅主题、360px 窄窗口及减少动态效果；截图与隔离测试脚本位于 `out/review/scroll-bottom/`。12 项相关测试、UI 类型检查、生产构建与差异检查通过，测试窗口已关闭。

默认多行布局调整另经隐藏 Electron 窗口验证：新建空会话、短输入、长文增高与清空回缩、宽窄窗口换行、焦点、附件增删均正常；深色与浅色窄窗口截图保存在 `out/review/multiline/`。UI 类型检查和生产构建通过，验证窗口已关闭。

模型选择弹框随后从右边缘对齐改为以触发按钮为中心向上弹出，保持 6px 间距，靠近窗口边缘时水平避让、上方空间不足时缩短高度并滚动列表。打开期间跟随按钮位置变化，避免面板展开导致弹框留在旧位置；位置不变时不重复更新状态。已验证深浅主题、1440／780／360px 窗口、面板布局变化、搜索结果增减、搜索焦点和 Escape 返回按钮；截图位于 `out/review/model-position/`。模型目录相关 4 项测试、UI 类型检查和生产构建通过，测试窗口已关闭。
