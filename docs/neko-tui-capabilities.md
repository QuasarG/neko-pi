# neko-pi 前端能力清单（vendored opencode TUI）

- 日期：2026-10-23（剩余工作核对及第二十四轮实施）。
- 状态说明：**支持**＝存在真实调用路径；**部分**＝存在实现但功能或验收有缺口；**不可用**＝明确拒绝或隐藏。支持不等于真实账号或完整端到端验收通过。
- 下面是源码状态；本轮未重建 dist/bundle，也未验证已安装命令。验收状态以 [剩余工作总账](superpowers/tasks/2026-10-23-neko-pi-remaining-work-todo.md) 为准。

## 会话与输入

| 入口 | 后端 | 状态 | 说明 |
| --- | --- | --- | --- |
| 新建/搜索/改名/归档/删除/恢复 | POST/PATCH/DELETE /api/session | 支持 | 创建即绑定项目身份 |
| 会话树（按项目分组） | GET /api/neko/sessions | 支持 | 按真实 project_id 归组 |
| 中断运行 | POST /interrupt | 支持 | 置 aborted 并调后端 abort |
| 取消排队消息 | DELETE /inbox/:id | 支持 | 快照保留供补偿 |
| 提交提示词（含图片） | POST /prompt | 支持 | data URI 图片→原生 images；文本文件→文本上下文；冻结接收快照 |
| steer（运行中引导） | 原生 streamingBehavior | 支持 | 冻结上下文注入 steer 文本；waitForIdle 后标 done |
| follow-up 队列 | delivery: "queue" | 支持 | 运行结束后 drain |
| 消息菜单 Edit and resend | POST /:id/truncate | 部分 | 同会话删除所选 user 轮及之后的条目，回填原文；运行中/并发修改 409，无法映射 422；不回滚工具造成的文件修改。原生及渲染测试通过，真机待验 |
| 压缩 | POST /:id/compact | 支持 | 调原生 session.compact() |
| 直接 Shell | POST /:id/shell | 支持 | 原生异步 executeBashWithOperations；started/ended 事件；interrupt 可取消 |
| 导出（jsonl/html） | POST /:id/export、GET /api/experimental/session/:id/export | 部分 | 文件导出调原生方法，GET 返回投影；其他文件格式 400；脱敏矩阵未验 |
| 统计 | GET /:id/stats | 部分 | 端点调原生 getSessionStats()；sessionInfo 汇总持久投影 usage，并用 metadata 区分完整/部分/未知；费用标为估算，原生恢复矩阵待验 |
| 失败恢复 | execution.failed 事件、消息菜单 | 部分 | 常见 provider 错误给出说明和建议；最后一条失败 user 可 Retry，同 ID 复用冻结输入；另可编辑重发；恢复屏与真机待验 |

## 模型与身份

| 入口 | 后端 | 状态 | 说明 |
| --- | --- | --- | --- |
| 模型列表 | GET /api/model | 支持 | 来自真实 ModelRuntime（元数据+auth 状态+聊天类型过滤） |
| 默认模型 | GET /api/model/default | 支持 | 先读 SettingsManager 保存值→首个 active；无可用 409 |
| 思考强度 | POST /thinking | 支持 | pi 七档；非 reasoning 415；前端 /thinking 命令 |
| /connect 认证 | GET /api/integration、POST /api/neko/auth/:provider/login、POST /api/integration/:provider/logout | 部分 | 登录/退出已桥接，常驻 UI 消费授权 URL/设备码/提示；真实订阅 OAuth 全流程未验 |
| /init 身份向导 | /api/neko/init | 支持 | 五步配置 |
| /neko 状态 | /api/neko/status | 支持 | 详情按需查看 |
| /persona-files | /api/neko/files | 支持 | 人设关联文件 |

## 资源与工具

| 入口 | 后端 | 状态 | 说明 |
| --- | --- | --- | --- |
| Skills 列表 | GET /api/skill | 部分 | 来自 ResourceLoader.getSkills()；技能执行经提示词而非独立端点 |
| 命令列表 | GET /api/command | 部分 | 来自 ResourceLoader.getPrompts()；执行经提示词 |
| MCP 列表 | GET /api/mcp | 部分 | 读取全局及项目配置，诚实显示 pending/disabled；没有实时连接状态或连接/断开通道 |
| 重载资源 | POST /api/reload | 支持 | 调原生 session.reload()；运行中 409 |
| 扩展 UI 请求 | neko.ui.request SSE、POST /api/neko/ui/:id/respond 或 /cancel | 部分 | select/confirm/input/editor/notify 已桥接；关闭/超时有处理；自定义原生组件不支持 |

## 能力协议

| 入口 | 状态 | 说明 |
| --- | --- | --- |
| GET /api/neko/capabilities | 支持 | protocol:1；global/perModel；30s 轮询；版本校验 |
| TUI CapabilitiesProvider | 支持 | MCP 入口由 isSupported() 控制；错误通知组件 |
| /thinking 命令 | 支持 | 7 档选择器→POST |

## 已清理（不可用）

Agent 切换、variants 循环、pair/web、自更新、服务重启、worktrees、undo/redo、持久终端、云分享——命令全部移除，TUI 端点返回 404/501。

## 证据与边界

测试路径以仓库根目录为基准。HTTP 测试不替代真实输入框或真实账号验收。

| 功能 | 证据 | 尚未覆盖或限制 |
| --- | --- | --- |
| 会话/消息接收/重投 | `packages/coding-agent/test/bridge-messages.test.ts` | 跨进程崩溃恢复仍需验收矩阵补齐 |
| 模型目录/默认/能力 | `packages/coding-agent/test/bridge-capabilities.test.ts` | 无凭据 409、登录后刷新及协议失败 UI 场景待补 |
| 图片/字段拒绝/投递 | `packages/coding-agent/test/bridge-input.test.ts` | 不支持 file://；非图片按 UTF-8 文本解码，不解析 PDF/Office 二进制 |
| 普通附件与重试冻结 | `packages/coding-agent/test/bridge-attachments.test.ts` | 每文件保留前 4096 个 JS 字符；文本与图片均绑定首次接收的快照 |
| 编辑截断/重载/父链/失败轮 | `packages/coding-agent/test/bridge-truncate.test.ts` | faux 模拟 provider 拒绝；不宣称真实 1301 或已安装命令通过 |
| 编辑菜单/原文回填/失败提示 | `vendor/opencode/tui/test/neko-message-edit.test.tsx` | 使用实际 TUI 渲染器和临时桥，native truncate 在该 UI 测试中为受控实现 |
| Shell/重载/设置/恢复/扩展 UI | `packages/coding-agent/test/bridge-p1.test.ts` | 端点与受控后端测试，完整多会话渲染矩阵待补 |
| 分叉/注入上下文 | `packages/coding-agent/test/bridge-round4.test.ts` | 原生历史与桥映射边界以定向测试为准 |
| 授权交互 | `vendor/opencode/tui/test/neko-auth.test.tsx` | 真实 OAuth 凭据与供应商请求未验 |
| 注入审计 | GET /:id/context、实时 ◈ 通知 | audit injectedSummary 仍为 presence-only，不能用它证明本条实际重注入 |

待完善项与验收 ID 的状态见 [对齐任务表](superpowers/tasks/2026-10-22-tui-backend-capability-alignment-todo.md)。
