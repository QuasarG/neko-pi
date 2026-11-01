# neko-pi · apps/web（pi 社区 Web 前端接入）

## 这是什么

agegr/pi-web 的 vendored 副本（MIT），作为 neko-pi monorepo 的 `apps/web` 住户。
上游锚点：`agegr/pi-web@d128bae47`（subtree squash 导入，合并提交 94604cff9）。
后续同步：`git remote add piweb https://github.com/agegr/pi-web && git fetch piweb && git subtree pull --squash --prefix=apps/web piweb main`。

## 交互参考

可参考 [ZCode](https://github.com/zai-org/ZCode) 的功能组织和交互方式。视觉方向（2026-10-30 用户裁定更新）：布局、配色、动效已按 ZCode 源码级设计语言完成三波改造（令牌层＋悬浮框架＋自适应列宽 / 动效令牌阶梯＋统一入场＋流式渐入 / 加载语汇＋空态瀑布＋滚动条焦点环），配色遵循"高级感、不做高对比撞色"（近单色＋透明度分层、低饱和 slate accent）。权威契约见 `apps/web/DESIGN.md`；规格出处 `.superpowers/sdd/WEB-TUI-HANDOFF/zcode-design-catalog.md`。不引入 ZCode 的组件库或新依赖。

## 安装模型（重要，别用根目录装）

apps/web **不在根 workspaces 里**（根 package.json 的 workspaces 不含 `apps/*`）。
原因：Next 16 Turbopack 在"npm workspace 提升 + 根锁文件"的布局下解析必炸
（build-manifest/module not found 一串）。因此 apps/web 自带独立 `package-lock.json`，
在 `apps/web/` 目录内安装，形状与上游 standalone 完全一致。

七个 `@earendil-works/pi-*` 依赖改成了 `file:../../packages/<pkg>`，并用
`npm install --install-links=true` 装成**拷贝**（不是软链——Turbopack 对软链出
锁文件域的依赖解析不了）。拷贝来自本地 packages 的 dist，改了本地包后要重刷：

```bash
npm --prefix apps/web run sync:pi
```

## 启动（对准 neko-pi 的账本）

```bash
npm --prefix apps/web run dev   # http://127.0.0.1:30141
```

默认读取 `~/.neko_pi`；可通过 `NEKO_PI_HOME` 指定其他数据目录。

## 已验证 / 待办

- 已验证：`/api/sessions` 列出 `~/.neko_pi/sessions` 全部会话（含名称/消息数/cwd），本地芯（file: 拷贝自 packages/*）驱动；web 发出的消息会写入同一本会话账（2026-10-30 实测首条"test（发自web）"）。
- R2-1（已修复 2026-10-30）：web 聊天路径注入缺失——web 发的消息曾是裸文本（无 <message_time>/<runtime_activity>/<runtime_memory>/<checkpoint>）。根因：SDK 路径 createAgentSessionServices 不带 CLI 的 builtInExtensions（只有 main.ts 入口才并入），pi-web 只自装 codemode/tool-search/mcp。修法（A）：coding-agent 新增 `./extensions` 导出（dist 产物本就存在，无需重建），rpc-manager 装配区把 builtInExtensions 排最前、pi-web 自己的三件随后按 replaceable 语义接管。端到端已验：web API 开新会话，user 消息 18975B 全家桶注入、助手回复正常。改本地包后需 `npm --prefix apps/web run sync:pi` 刷拷贝。
- 详情接口 `/api/sessions/<id>`：2026-10-30 重新验证可读取现有注入会话，浏览器可展示并展开上下文；此前记录的空消息问题在当前版本未复现，空分支等边界仍需覆盖。
- R2（部分完成）：用户消息中的注入上下文复用核心解析器，按 runtime-context / memory 折叠展示；复制、编辑与侧栏标题使用用户原文，持久化内容保持完整。其余 persona/记忆/衣橱工具的专用渲染仍需核对。
- Web 已补齐 `/edit [n]`、`/undo`、`/turns`、`/context`，通过内置扩展进入现有命令列表。编辑与撤销直接使用原生截断和文件日志，未增加会话格式；审计与轮次报告不写入会话。
- 扩展绑定使用交互模式，现有 custom UI 终端承载完整提问框，支持选项描述、多选、自由输入；待办组件在工具结束后重新渲染，`/todo` 可切换折叠。2026-10-31 对齐裁定 R6 例外：`ask_user` 按名映射（rpc-manager 的 `EXTENSION_UI_MODE_OVERRIDES`）固定走 select 通道，由输入区上方的问题卡 AskUserDock 承载；其余扩展仍走 custom UI 终端。
- 验证：110 项 Web 渲染、启动记录、命令、提问、待办和扩展 UI 测试通过；15 项核心注入解析、日志与截断测试通过。新增命令集成测试使用临时 `NEKO_PI_HOME` 和 faux provider。
- 浏览器验证：复用本机 Chrome，打开现有会话并展开注入上下文，无客户端异常。新增包导出后须重启开发进程以刷新 Node 的包导出缓存；Turbopack 与输出追踪统一以 `apps/web` 为根。
- 后台任务已按会话隔离：原生 bash / subagent 记录 owner，通知和 `/tasks` 只发给所属会话；重载期间完成的任务恢复后补送一次。目标循环只等待本会话的任务；Web 在本会话仍有后台任务时保持运行时和完成事件通道。
- 原生子代理在 SDK/Web 宿主内通过核心配置帮助函数定位本包 CLI，保留无 persona、无持久会话的子进程边界，并使用工具指定的工作目录。通过本地假 CLI 验证启动参数，不调用真实模型。
- Project settings hints, model scopes, cache notices, skill attribution, trust checks, and subagent profiles use the native `CONFIG_DIR_NAME` (`.neko_pi`). Relevant tests use `NEKO_PI_HOME` and cover project/global profile storage, extension trust, nested projects, and symlinks.
- Web built-in command palette maps `/settings`, `/scoped-models`, `/tree`, `/model [search]`, `/thinking [search]`, `/new`, `/debug`, `/export`, `/fork`, `/resume`, `/trust`, `/login [provider]`, `/logout [provider]`, `/import`, `/changelog`, and `/hotkeys`. Import validates JSONL and writes the same session format into the active session manager's native directory; changelog reads the installed pi package asset; help commands and auth flows do not create a session.
- `/share`（2026-10-30 补齐）：先弹同意对话框，写明离开本机的内容——完整当前会话分支的 JSONL（消息、工具调用及结果，含文件内容与命令输出）加系统提示词与工具架构（`pi.share` 尾部条目）——并显示目标（读 TUI 同一份持久化设置 `sessionShareDestination`，`~/.neko_pi/settings.json`，默认 auto：Radius artifact 优先、`gh` gist 回退；radius 上传地址沿用原生 `DEFAULT_RADIUS_GATEWAY`，gist 含 `gh auth status` 预检与 pi.dev 查看链接）。对话框另提供零网络出口"下载 JSONL（不上传）"，与上传为同一份序列化。确认后 `POST /api/sessions/[id]/share` 经 rpc-manager 在活动会话上执行原生序列化（`serializeSessionBranch` + `createShareTrailingEntries`，经 ADR 0006 dist 文件加载）。
- `/bug <description>`（2026-10-30 补齐）：四步同意对话框复刻原生顺序与措辞——免责声明+问题描述（`/bug` 参数预填）、是否含会话记录（写明记录含消息/工具结果/文件内容/命令输出）、拒绝记录时提供模型代写摘要（警告记录会用用户自己的凭据发送到其提供商）、投递确认（点名 `getRadiusGatewayUrl()` 的实际网关主机；`PI_OFFLINE` 时禁用上传）。确认后 `POST /api/sessions/[id]/bug-report` 以 `bug_report` agent 命令在活动会话上执行：元数据/诊断收集（`collectBugReportMetadata`/`Diagnostics`，原生脱敏规则）、摘要经 `session.summarizeForBugReport` 走真实模型、上传走 `uploadBugReport`（Bearer 可选）、zip 走 `writeBugReportArchive` 以附件下载返回（浏览器不能写 `process.cwd()`，故 zip 记录不写 `path` 字段）。投递成功后在**同一本原生会话 JSONL** 追加与 TUI 完全一致的 `pi.bug-report` custom 条目（`{id, createdAt, hint, sessionIncluded, summaryIncluded, delivery, path?}`），有崩溃记录时 `clearCrashLog()`。
- `/quit`（平台限制）：浏览器端没有可退出的进程。Web 在客户端拦截 `/quit`，提示"浏览器端没有可退出的进程；关闭标签页即可结束"，**绝不**把该命令发给模型（关闭标签页即结束会话；服务端会话按空闲超时自行关闭）。
- 移除 Web 独有能力（2026-10-30，用户裁定"以 TUI 为准"）：① Windows PowerShell 切换（Settings 面板的 Shell tool 段与 `/api/tools/settings` 的 `enabled` 分支；核心共享设置键 `shellPath`/`shellCommandPrefix` 不受影响，`powershell-settings.ts` 的解析助手保留）；② pi-web 的 bash 影子扩展（`createProjectCommandBashExtension`/`preferUserBashExtension`）——模型的 `bash` 回归 pi 核心内置，读共享 `~/.neko_pi/settings.json`，与 TUI 完全一致；代价是模型 bash 可读到 `PI_WEB_PASSWORD` 等宿主环境变量（ADR 0001 已如实记为接受的回归；`!`/`!!` 直连命令与 MCP stdio 环境净化保留）；③ 只读模式（`createReadOnlyMcpPolicyExtension` 会话级 MCP 拦截 + 预设选择器 read-only 项；通用 `set_tools`/preset 钉选机制与子代理只读 MCP 策略保留）。同批清理死代码 `applyCodemodeWorkerDefault`（SDK 已硬编码 codemode worker 上限 2，不再读 `PI_CODEMODE_MAX_WORKERS`）。
- 工具预设只在会话开始前可选（2026-10-31）：首条消息发出后预设即对本次会话冻结——工具列表属于提供商提示词缓存前缀，中途换预设会把整个缓存重新计费。判定"已开始"：wrapper 创建时会话已有对话消息条目（续开的旧会话生而锁定），或本生命周期内首个 prompt/steer/follow-up 已派发；判定式为"任意非 system 角色的 `message` 条目"（`hasConversationMessageEntries`，实测新会话 0 条目、setup 条目（钉选/model_change）不计、`bashExecution` 计）。执行双层：服务端 `setRpcSessionTools` 与 wrapper `set_tools` 以英文错误拒绝（含无 wrapper 时的文件检查），UI 选择器锁定时禁用并显示三语 tooltip（`chat.toolPresetLocked`）；开场的已存偏好钉选与树导航同选重钉不是用户改动，保持不动；扩展/核心的内部工具变更不经此 RPC，不受门禁。
- Web/TUI 次级差距备忘（backlog，未实现）：① `/export <path>` 带参会落到模型当普通文本，且 JSONL 导出无 Web 路径（仅 HTML 导出）；② 未知斜杠命令无守卫，参数形态的 `/import`、`/resume`、`/new`、`/debug`、`/trust`、`/changelog`、`/hotkeys`、`/fork` 同样落到模型；③ `/turns` 报告缺原生每轮耗时；④ `/import` 参数形态相反（原生要求路径参数，Web 只接受裸命令+上传对话框）；⑤ `/fork` 无法在命令行指定任意历史消息（原生打开消息选择器）。
- R3（待办）：记忆浏览器、衣橱管理、活动/着装侧栏。
- 完整对齐尚未验收：仍需核对其余 TUI 命令、子代理与后台任务的多会话归属、扩展 UI 的空实现、旧 Web 测试环境变量和浏览器端到端交互。R3 属于额外管理界面，不能替代这些功能与存储一致性验证。
- 注意：`npm install-scripts approve node-pty` 后需 `npm rebuild node-pty`，
  Linux 上 prebuild 会"SKIPPED (not Windows)"，直接 `cd node_modules/node-pty && npx node-gyp rebuild`。
