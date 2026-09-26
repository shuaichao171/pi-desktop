# 模型管理界面回归

`pnpm test:model-settings-ui` 构建真实 renderer，静态编译测试表达式，再使用专属 Chromium headless shell 验证界面。需要 Node 22.19+；Windows 自动查找 `%LOCALAPPDATA%/ms-playwright/chromium_headless_shell-*`，其他路径通过 `PI_REVIEW_BROWSER` 指向 headless shell 可执行文件。

不启动浏览器的准备检查：

```powershell
node tests/fixtures/model-settings/preflight.mjs
node tests/fixtures/model-settings/run.mjs --check
```

已有构建时直接运行：

```powershell
node tests/fixtures/model-settings/run.mjs --run
```

`--skip-layout` 跳过已验证的主题/尺寸截图与模板流程，仅执行模型、导入、连接、凭据和导航回归。`--trace-inputs` 预先记录输入事件供诊断。模拟服务只使用 `.invalid` 地址和虚构凭据，不调用在线模型。测试使用实际鼠标/键盘事件，检查保存请求与 DOM，包含失败保留草稿、取消零写入、导入去重、迟到响应、独立凭据草稿、焦点/选区、忙状态及当前模型保护。

每次测试创建独立 profile、调试端口和 loopback 文件服务，只清理自己启动的浏览器进程。失败时直接记录并清理，不在失败后继续界面探查。PNG 和含构建哈希的 `report.json` 写入忽略目录 `out/review/model-settings/runs/`。本测试覆盖 renderer；真实 IPC、供应商协议与凭据持久化由 `pnpm test` 中的集成测试覆盖。

更新设置的独立检查/安装按钮也复用此驱动：`node tests/fixtures/model-settings/update-scenarios.mjs --check` 仅做静态准备；`node tests/fixtures/model-settings/run.mjs --run --scenario=update-scenarios.mjs` 验证实际按钮状态及 bridge 调用。所有更新状态均为模拟，不下载或安装真实更新。
