# 功能优化实施与验收记录

日期：2026-09-26。`function-todo.txt` 的 F-001～F-024 共 24 项曾按清单约定的首期范围实现并验证，原待办文件已清空为 0 字节。F-009 输入历史随后按用户要求移除，其余实施与边界记录保留于本文。

## 逐项实现

| 编号 | 完成的行为 | 主要验证 |
| --- | --- | --- |
| F-001 | 队列使用输入 ID、请求 ID、版本和完整载荷事务更新；消费前预留、消息开始后确认，重复回执不重放 | `input-queue`、`input-sdk-transaction`、`queued-messages` |
| F-002 | 有界附件仓库、内容身份和作用域引用；草稿及附件持久化、历史附件按需读取、孤立内容回收 | `input-attachments`、`persisted-drafts`、`history-attachment-preservation` |
| F-003 | 列举回收站、恢复正文/分支/桌面元数据、保留策略及逐项确认永久清理，删除时释放输入引用 | `data-recovery`、`data-features-ipc`、`session-delete` |
| F-004 | 全部/仅已暂存两种提交范围；说明、预览、执行使用同一候选树，部分暂存与子目录外索引保持 | `workbench-features`、`workbench` |
| F-005 | 可重建增量会话索引、工作区/日期/归档/分支筛选、稳定游标和分页；运行自动化在分页前排除 | `indexed-search`、`search-ipc`、`search-selection` |
| F-006 | 缓存项目路径枚举、统一包含/排除规则、字面量正文查找和行列定位，明确跳过原因 | `indexed-search`、`search-selection` |
| F-007 | Pi JSONL 导入校验与继续对话；独立版本化完整会话备份、全部分支/桌面元数据/历史附件恢复、失败回滚及重试 | `data-recovery`、`data-features-ipc` |
| F-008 | 独立暂停/恢复 follow-up 消费、同类输入排序，保持 steer 语义和当前轮运行 | `input-queue`、`input-sdk-transaction` |
| F-009 | 已按用户要求移除聊天输入历史；普通草稿、附件及对话记录保留 | 历史用例已删除；保留 `persisted-drafts` 与输入 renderer 的草稿/附件场景 |
| F-010 | 可取消、限时限量的本地 PDF 文字提取，保留来源/页码，明确扫描页、加密、损坏与截断 | `pdf-input`、打包后真实 worker 冒烟 |
| F-011 | 对已保存指定模型发起独立最小推理，复用正式协议/代理/鉴权；取消、耗时、固定脱敏失败类别 | `model-inference-test`，真实 SDK + 本地 SSE |
| F-012 | 项目默认值设置页已按用户要求移除；后端配置继承、信任、版本冲突保护与新会话读取保留 | `project-defaults`，真实 AgentService 新会话；项目设置 UI 用例已删除 |
| F-013 | npm 只读检查、约束与准确目标预览；固定版本修复与选择新版本升级分开，安装后验证版本与保存来源 | `plugin-updates`，注入 registry/安装器 |
| F-014 | 启动/RPC/host/插件阶段轮转记录，近期有界脱敏 ZIP 与跳过清单，仅导出本地 | `management-features`、`agent-client` |
| F-015 | 从真实助手 usage 增量汇总，分支/复制历史去重，项目/日期/模型/来源筛选，未知费用明确标记 | `management-features` |
| F-016 | 分类空间扫描、可取消预览、逐文件指纹和根目录身份复核、部分失败及实际释放统计 | `management-features`，包含目录替换故障注入 |
| F-017 | 可配置补跑宽限，过期记录 skipped，单次终止/重复计划向未来推进，旧配置沿用补跑一次 | `automation-service`、原时区/夏令时用例 |
| F-018 | 仅确认尚未开始执行的瞬时派发失败有限退避，稳定运行身份、次数和重试时间落盘，未知执行状态不重跑 | `automation-service`、`automation-executor-review` |
| F-019 | 周期自动化计划次数额度，派发成功计一次，手动/跳过/派发前重试不重复扣减，达到上限完成 | `automation-service`，并发/重启/存储失败用例 |
| F-020 | 最近完成回合的完整文本检查点、预览/外部冲突检测、恢复及失败补偿，索引保持 | `file-checkpoint`，真实临时文件/Git |
| F-021 | 从已提交 ref 创建独立 worktree 新任务，持久绑定实际工作区/分支/会话，重启恢复 | `workbench-features`，临时 Git 仓库 |
| F-022 | 显式普通 push/设置 upstream；另行创建 GitHub 草稿 PR、识别已有 PR 并保存地址 | `workbench-features`，Git/gh 远端操作 mock |
| F-023 | 独立交互 PTY、输入/resize/Ctrl+C、xterm 滚动缓存、背压、页签保活及所属进程清理 | `workspace-terminal`，真实 Windows ConPTY 和打包后冒烟 |
| F-024 | 用户/可信项目 MCP 配置，手动连接/测试/断开，stdio/Streamable HTTP，真实 Pi 工具注册与生命周期隔离 | `mcp-manager`、`mcp-agent-integration`，真实本地协议服务器 |

表中测试名省略 `tests/` 与 `.test.mjs`。协议贯通 shared、preload、主进程、host、agent 与 UI；新增入口位于设置中的模型测试、数据管理和 MCP，以及自动化、插件、输入队列与工作台。

## 契约与失败处理

专项规范记录数据所有者、兼容规则、请求身份、容量及失败状态：

- [输入、附件与 PDF](specs/FUNCTION_INPUT.md)
- [回收、搜索、导入与备份](specs/DATA_RECOVERY_SEARCH.md)
- [模型、配置、插件、用量、诊断与自动化](specs/FUNCTION_MANAGEMENT.md)
- [Git、检查点、worktree、交付与 PTY](specs/FUNCTION_WORKBENCH.md)
- [MCP 配置与连接](specs/MCP_MANAGEMENT.md)

二次故障审查补齐了暂停时仍在准备的自动化禁止重试、未落盘重试记录可取消、接受后结果保存失败不重放、导入元数据补偿失败仍继续回滚会话文件、回收永久清理释放输入、运行会话备份拒绝、分支复制历史去重、清理预览后目录替换拒绝删除等边界。

## 验证结果

- 全量 `node --test tests/*.test.mjs`：**567 项，565 通过，0 失败，2 跳过**，日志 `out/review/function-tests-final.log`。两项跳过是 Windows 文件符号链接权限和 Unix 专属进程组测试。
- agent、UI、desktop main、desktop renderer 的四个 TypeScript 项目分别执行 `tsc`，全部通过。使用依赖内的 TypeScript 可执行文件，避免多个 pnpm 脚本同时触发依赖安装。
- Electron/Vite 生产构建及 `git diff --check` 通过。最终 renderer 为 `index-CoxIjdpU.js` / `index-lv_hU85B.css`；54 处依赖声明与锁文件一致，`node scripts/sync-pi.mjs --verify` 通过。
- Windows x64 目录包构建通过。Windows 打包入口验证 node-pty 自带的 N-API 二进制及 ConPTY helpers，并在目标 Electron 中加载验证，随后使用预编译文件；macOS/Linux 的原生构建策略保持独立。PDF worker 模块与 PTY 可执行资源位于 `app.asar.unpacked`。
- 打包后的 Electron **44.4.5 / Node 24.21.0 / ABI 149** 执行 `packaged-smoke.cjs`：真实 PDF worker 提取文字、ConPTY 输出中文、MCP/Pi SDK 导入均通过，见 `out/review/function-packaged-smoke.log`。目录包位于 `out/review/function-package/win-unpacked`，未执行安装、发布或升级用户应用。
- 增量搜索性能样本为 160 个会话 / 1,329,010 字节：热查询不再读取任何 JSONL，冷/热约 178/60 ms；具体实测见专项记录，不作为所有机器的性能保证。

### UI 验证

实际 renderer JS/CSS 在独立 Chromium headless shell 中运行，bridge 为内存 fixture；鼠标、键盘、DOM、异步状态与截图检查互相补充。每次报告包含资源哈希、断言及清理结果；没有接管用户原有窗口。

| 场景 | 证据 | 覆盖 |
| --- | --- | --- |
| 输入可靠性 | `run-gH8moE`，8 个断言、4 张截图，2026-09-27 | 输入历史入口移除、附件/草稿、队列控制、迟到恢复响应 |
| 恢复与 MCP | `run-3uBkbw`，3 张截图 | 清理确认、取消、恢复目标、导入、MCP 工具与窄屏表单 |
| 管理功能 | `run-C1yiPC`，7 张截图，项目默认值设置页移除前版本 | 独立模型测试、未知价格、清理预览和变化拒绝、ZIP 导出、900/680px；旧版项目默认值界面用例现已删除 |
| 工作台新增功能 | 深色 `run-nxUTKj`，浅色 `run-meeVhN` | 范围提交、检查点冲突、工作树、推送失败/已有 PR、PTY 保活、760px |
| 自动化与插件版本 | `run-IhcGag`，5 张截图 | 固定版修复、准确升级目标、成功清除已消费预览、检查失败清旧目标、安装失败保留重试；宽限/重试/次数保存、完成提示与编辑继续、900/680px |

项目默认值设置页移除后的管理场景 `run-dNhml3` 通过 5 个交互断言并导出 6 张截图，保留模型测试、用量、存储与诊断验证，`cleanupError: null`。

报告与图片均在 `out/review/model-settings/runs/<编号>/`。已查看代表截图并修复原生弹窗居中、浅色链接对比、管理表单对齐、插件预览折行和 MCP 搜索定位。各场景以对应报告的构建哈希为准；最后的插件与自动化修改已重新构建并针对性复验。该目录为忽略的本地验证产物，不随 Git 自动交付；测试场景源码位于 `tests/fixtures/function-improvements/` 与 `tests/fixtures/ui-improvements/workbench-features.mjs`。

## 首期范围与实测限制

- PDF 支持本地文字提取；全扫描文档需要先 OCR 或另附页面图片，不声明原生文档模型协议/页面渲染。PDF.js 对缺少可选 canvas 的警告不影响本轮已验证的文字提取。
- 重启队列恢复为待确认，不自动重放执行状态不确定的输入。完整备份保存会话正文、全部分支和桌面元数据/历史附件；未发送草稿与队列不作为可自动执行内容导入。
- 检查点限定最近完成回合和完整记录的 Git 文本文件；未覆盖、二进制、超限或外部冲突明确报告。精确提交首期不执行 Git hooks/签名，进行中的合并等状态会拒绝。
- 工作树从已提交 ref 创建，不复制未提交内容、不自动删除。PR 限 GitHub.com 与已有 `gh` 身份，不支持 Enterprise 或跨仓库 fork。
- PTY 为一个应用内单会话，绑定工作区；Windows 已实测，macOS/Linux 未在本机运行验收。node-pty 在自然退出清理时可能输出 `AttachConsole failed`，测试确认所属进程正常退出，此第三方诊断保留在日志。
- MCP 手动连接，凭据通过现有环境变量名引用；不包含 OAuth、市场、配置迁移或旧 HTTP+SSE transport。
- 真实供应商付费推理、真实远端 push/PR、真实插件升级未执行。对应协议使用真实 SDK 加本地服务器或注入故障测试，不能等同于所有线上环境已联调。
