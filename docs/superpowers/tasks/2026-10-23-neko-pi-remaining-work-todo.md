# neko-pi 待完善总账（2026-10-23）

- 依据：22 轮 scoped-memory/对齐实施（[spec](../specs/2026-10-21-scoped-memory-runtime.md)、[alignment spec](../specs/2026-10-22-tui-backend-capability-alignment.md) 及其 todo 第 1–23 轮记录）＋ 2026-10-23 当晚用户反馈（thinking 415、注入通知诚实性、跨会话警示、记忆数量纪律、消息重发缺口、上游 1301 审核拦截）。
- 本文是唯一权威的剩余工作清单；各 alignment 条目完成即回到对应 todo 勾选，新事项先进本文。
- 状态：`[ ]` 未做、`[~]` 部分完成、`[x]` 完成且有证据。不把"暂缓"记成"已实现"。

## 0. 当前基线（本文写作时）

以下三项是写作时记录，不代表第二十四轮后的工作树或发布产物。

- 后端定向套件逐文件全绿（bridge/memory/runtime/suite 共 9 批次）；前端 bun neko 套件 7/7；`npm run check` exit 0；dist/bundle 与源码一致（第二十三轮重建）。
- 全部工作（约 71 个文件，含 27 个新文件）**仍未提交**，在 `dev` 分支工作树中。
- 已实测可用：api-key 登录流（deepseek，2026-10-23 真机）、模型目录/切换、thinking 端点（off–high，xhigh/max 需 thinkingLevelMap）、记忆六本书注入与收据门控、跨会话 pending 警示、便签（continuity）写入-注入闭环（DB 指纹逐条核对）。

### 第二十四轮核对（2026-10-23）

- 开始时为 `dev`，`git status --short` 共 72 个路径；已有改动未提交。本轮在现有改动上增量实施，未提交、未构建发布产物。
- **不一致：1.3**。源码此前已接通非图片 data URI 解码及 4096 字符截断，`bridge-p1.test.ts` 已有普通文件到达 prompt 的断言；旧“尚未接通”描述过时。但重试此前只复用裸正文，丢失首次附件，第二十四轮已修复。
- **不一致：1.1 的设计推断**。原生 `reload()` 重载资源，不重新读取 JSONL；必须 `setSessionFile()`＋`refreshContext()`。记忆门控在收据版本匹配时跳过注入，保留最新收据不会触发“全量重注入”；截断后将 memory_catalog/continuity/outfit 收据标为 -1，使下一条消息重新携带背景。
- **不一致：能力文档**。认证登录/退出、扩展弹窗及异步 Shell 已有实现；旧文档仍写未接通或 execSync。本轮已按入口、限制与证据重写。
- **一致（代码可直接确认）**：失败错误仍原样呈现；MCP 仅 pending/disabled，不能连接/断开；`/context` injectedSummary 为 presence-only；sessionInfo 仍硬编码零统计；桥日志仍双轨；vendor TUI tsconfig 仍引用缺失的 `../core`。
- **本轮未重验**：旧 54/87 个失败用例的数量与根因、真实 OAuth/供应商请求、用户本地模型与凭据状态、旧 dist/bundle 一致性。保留待办，不将历史记录冒充新证据。

## 1. P0 功能缺口（用户可感知，按优先级）

### 1.1 消息编辑与重发（in-place revert） `[~]`

- 第二十四轮源码已实现：消息菜单增加 Edit and resend，调用 `POST /api/session/:id/truncate`；同一会话裁剪原生 JSONL 与桥投影，回填原文及附件。此前仅能用 Fork 变通。真机 smoke 与启动产物同步仍待完成，暂不勾 [x]。
- 实施要点：
  - 截断端点定位原生 entry（`session.entryByMessage`），原子改写 JSONL 丢掉该 user 消息及其后全部条目；保留之前的其他分支，必要时补 custom 叶节点标记，保证重新打开仍回到所选父链。同步裁剪 `history` 和 `entryByMessage`，取消已移除 user 的执行状态；记忆数据不回滚，将背景收据标为 -1 强制重注入。
  - 截断后 `setSessionFile()`＋`refreshContext()`＋`reload()`；重载失败恢复原文件与上下文。运行中、直接 Shell 执行中、编辑中、跨进程锁冲突或持久状态已变更返回 409。
  - 消息菜单恢复"编辑并重发"动作：截断成功后 `setPrompt(projectedPromptInput(message))` 复用上游回填逻辑；失败（422/409）时 toast 原因。
  - 失败消息（state=failed，如上游 1301）是首要场景：provider 拒绝后原生历史里留有失败轮，重发前应可截断。
- 测试：bridge 层截断/重载/背景收据失效三断言；TUI 层动作存在性＋失败 toast；真机 smoke 一遍。
- 第二十四轮证据：`test/bridge-truncate.test.ts`（原生上下文、重载失败恢复、首轮、分支父链、faux 1301 后编辑替换、桥投影/映射/收据失效/并发拒绝）；`vendor/opencode/tui/test/neko-message-edit.test.tsx`（真实菜单点击、回填、422 toast）。不回滚工具已修改的工作文件。

### 1.2 失败消息的用户体验 `[~]`

- 源码已实现：失败通知将 1301 审核拦截、401 凭据、429 限流、5xx 和网络失败转换为说明与操作建议，未知错误保留原文。失败会话最后一条 user 消息菜单提供 Retry，同 ID 重投并复用后端冻结快照；Edit and resend 仍可修改内容后重发。
- 证据：`vendor/opencode/tui/test/provider-error.test.ts` 覆盖错误分类；`neko-message-edit.test.tsx` 覆盖实际点击 Retry、编辑回填与失败 toast，合计 4/4 通过。`npm run check` 通过。错误恢复屏、真实 provider 拒绝、已安装命令尚未验收，保留部分完成。
- 注意：审核拦截是上游政策，产品层只做呈现与换模型引导（如提示切换 provider），不做规避。

### 1.3 普通文件附件接通（A08 剩余） `[x]`

- 第二十四轮确认普通文本 data URI 首次发送此前已接通；补齐重试缺口：收据冻结 model-facing 正文、图片及原始文件附件，同 ID 重试不接受调用者替换内容；队列与 steer 均使用冻结输入。气泡显示用户原文，编辑回填保留附件。
- 证据：`test/bridge-p1.test.ts` 普通文件到达 prompt；`test/bridge-attachments.test.ts` 验证每文件前 4096 个 JS 字符、截断标记、原文显示、附件回填数据、失败重试正文/图片一致、非法附件数组 400；`test/bridge-input.test.ts` 验证图片与能力拒绝。仅按 UTF-8 解码文本，不承诺解析 PDF/Office 二进制；A08 的整体草稿与组合场景继续保持部分验收。

### 1.4 MCP connect/disconnect（B02/R01） `[~]`

- pi 的连接状态在扩展闭包内，桥不可操作——需要 pi 侧新增受控 API 或扩展命令通道。先在上游 pi 提 issue 讨论，拿到原语再接面板；在此之前 MCP 面板如实显示 pending。

### 1.5 Persona continuity 每三次 user query 强制写入 `[x]`

- 用户于第二十四轮实施期间明确要求，并确认是成功写入硬约束：每个会话独立在第 3、6、9…次 user query 到期；未成功写入 persona 便签不得将执行记为完成。
- 原生 memory 扩展在到期请求前声明规则，在 `agent_before_settle` 检查实际保存的会话 checkpoint；遗漏调用则追加原生 continuation，只有 `continuity_update` persona `saved=true` 才消账。project、空摘要、超预算和版本冲突均不算完成；中断/供应商失败保留欠账。
- 计数及成功 checkpoint 保存在原生 active branch：重启/压缩保持，截断随历史裁剪；桥消息 ID 去重重试；内部提示不计数；已标记其他 session 的分叉历史不占用新会话计数。旧的无标记 user 历史按已有查询计数。
- 跨会话冲突保留乐观版本锁，工具返回当前摘要/版本，模型合并后用 `expected_version` 重试。其他会话的成功写入不抵扣本会话的要求。
- 证据：`test/suite/continuity-cadence.test.ts` 覆盖 3/6 次 checkpoint、重启恢复、失败欠账、内部提示排除、重试去重、分叉隔离、截断回退与版本冲突重试；最终定向回归 8 个文件 35/35 通过，`npm run check` 通过。源码未同步到发布产物。

## 2. 本轮验证结果

- `[x]` `npm run check`：通过（Biome、依赖/导入/entry graph/install-lock 检查、TypeScript、browser smoke）。
- `[x]` 定向回归：`continuity-cadence`、`runtime-notifications`、`budget`、`memory-continuity`、`memory-external-edit`、`runtime-agent-acceptance`、`steer-lifecycle`、`bridge-truncate`、`bridge-attachments`，8 个测试文件共 35/35 通过。
- `[ ]` 未运行全量测试、build 或 installed-binary smoke；按仓库规则未自行运行 build/`npm test`。真实 OAuth 等验证债务见下节。

## 3. P1 验证债务（有实现、缺证据）

- `[ ]` L01/L02 真实订阅 OAuth 浏览器流端到端（授权完成→目录刷新→发起模型请求）。api-key 流已真机验证（deepseek），OAuth 流仍无真实凭据证据。
- `[ ]` M03 faux 端到端：steer 生命周期（原生 streaming 消费边界）＋最终 provider 请求断言（thinking 级别真实出现在上游请求体）。
- `[x]` A05 无凭据场景验证（第二十五轮）：bridge-noauth 测试——faux runtime 无凭据时目录全部 unauthorized、/api/model/default 409 "No model available"（不偷偷回退到跑不了的模型）。
- `[ ]` A04/K03/K04：能力驱动的功能显隐控制＋目录刷新场景（登录/登出后 30s 轮询与手动刷新）。
- `[ ]` S05 导出脱敏矩阵：jsonl/html 导出的敏感信息过滤逐项验证。
- `[ ]` D04 统计口径区分"未知/估计/实际"并在前端标注来源。
- `[x]` /context 审计端点与 ◈ 行共享 injectedStates 收据门控（第二十五轮）：audit 的 injectedSummary 现在带 injected/cached，与实时通知同一真值；bridge-round4 回归 17/17。

## 4. P2 卫生与技术债

- `[ ]` **提交**：约 71 个文件（27 新文件）未提交，含 dist/bundle。需要主人授权后分批提交（建议顺序：core/memory＋extensions → tui-bridge → vendor TUI → docs＋dist），提交前逐批跑 check。多会话并行规则：只 add 本会话改动路径。
- `[ ]` 上游 54 条测试因 `~/.pi → ~/.neko_pi` 路径迁移失败，无人修复——逐条判定：改路径期望／上游 bug 上报／标记 skip。
- `[ ]` 全量 vitest 单进程 `--run test/` 约 87 个环境敏感用例失败（settings-manager/theme/trust 等串扰）——隔离根因（全局单例、env stub 泄漏），恢复整树一键绿。
- `[~]` vendored TUI typecheck 通道已恢复（第二十五轮）：删除指向无 tsconfig 的 `../core` reference（node_modules 解析即可）；Neko 自有文件（app.tsx/theme.tsx/capabilities/neko-*）类型错误清零，其中修复两处真 bug——`process.on` cast 剥离 this 导致 EventEmitter 崩溃（改 .bind(process)）、SecretPrompt 键盘过滤比较 `eventType !== "Down"` 恒真（KeyEventType 实为 press/repeat/release，改为 "press"）。剩余约 106 个为上游 vendored 存量（bun-types 差异、string|undefined、effect 版本），bun test 全绿不受影响——上游文件不逐个乱改，清单留存待上游同步决策。
- `[x]` TUI fixture 清理竞态修复（第二十五轮）：tmpdir dispose 前 25ms drain 让异步持久化（session tabs/config）收尾，rm 后追加一次兜底重删；三连跑 ENOENT 零出现。
- `[~]` sessionInfo 已汇总持久投影中 assistant 的 usage/cost，附 `metadata.usage` 标明 recorded/partial/unknown、缺失消息数、费用为模型定价估计、reasoning 包含在 output。前端费用标为 estimated；无数据的零字段仅保留协议兼容，前端不显示零费用。`bridge-usage.test.ts` 覆盖汇总与缺失/非法数据，连同能力/消息回归 13/13 通过；原生恢复全矩阵和未知状态的完整 UI 展示待验。
- `[ ]` 桥日志双轨：默认写 `~/.neko_pi/tui/bridge.log`，`NEKO_PI_BRIDGE_DEBUG=1` 时走 stderr——统一到 debug-log 约定（此前评估过，遗留代码改动）。
- `[x]` glm-5.3-flash thinkingLevelMap 配置完成（第二十五轮）：上游 anthropic 兼容端点实测 low/high/xhigh/max 全部接受（effort adaptive），map 写入 models.json（minimal→low、medium→medium、xhigh→xhigh、max→max）；registry 验证 zai/anthropic 条目档位生效。附带发现：上游目录把 GLM 系列复制到 12 个 provider 条目（opencode.ai/aliyun/radius/bigmodel…），`providerID+id` 存在同 provider 双条目歧义（zai 同时有 builtin openai-completions 与用户 anthropic 条目）——桥的 find 可能命中错误条目，见新增待办。
- `[x]` 便签提醒方案已由用户新指令取代：persona continuity 不再采用可选 nudge，改为 1.5 的会话级每三次 user query 成功写入硬约束；project continuity 仍按需更新。
- `[ ]` C05：无实现功能的间接入口与上游产品文案清理（法律声明保留）。
- `[ ]` C06：旧 TUI 配置兼容核查（废弃字段忽略、有效主题/布局/快捷键保留）。
- `[x]` E01：第二十四轮重写 `docs/neko-tui-capabilities.md`，注明入口/操作/限制/证据/源码状态，纠正登录、扩展 UI、异步 Shell、MCP、统计及导出旧描述；明确源码与发布产物、端点测试与真机验收的区别。
- `[ ]` E02：用户命令与设置说明更新，移除已取消操作的承诺。
- `[ ]` E04：全部验收 ID（A/B/C/D/E/K/L/M/Q/R/S/W）汇总表：通过/失败/未覆盖，不假称真实账号已测。
- `[ ]` 同 providerID+id 双条目歧义（第二十五轮发现）：上游目录 GLM 系列在多家 provider 重复，zai 同时存在 builtin openai-completions 条目与用户 models.json 的 anthropic-messages 条目（同 providerID zai、同 id）——桥 /thinking、/model、/api/model 的 find 按 providerID+id 匹配可能命中错误条目（错误的 baseUrl/auth）。修法：条目排序稳定化（用户 override 优先）或匹配键加入 api/baseUrl；先写复现测试再改。
- `[ ]` 上游 pi（earendil-works/pi）同步策略：fork 漂移已有（vendored TUI 31.5 万行＋neko 分支改动），建立定期 rebase/挑选机制或显式声明停止跟随。

## 5. 用户侧运维（非代码，需要主人操作或授权）

- `[ ]` DeepSeek 已登录：切模型实测一轮（含 1301 场景对比），确认作为敏感内容备用通道。
- `[ ]` 本地模型接入评估：4060 8G＋models.json 指 localhost（openai-completions），零审核零上传；候选 Qwen 系量化。主人点头后排期。
- `[ ]` 凭据巡检：auth.json 含 zai-coding-cn＋deepseek key，确认权限范围与轮换计划；密钥不入库不入日志。

## 5.6 第二十六轮（2026-10-24 凌晨·去桥回归原生——用户架构决定）

用户裁决：去掉 opencode 桥接层与 vendored 前端，回到 pi 原生 TUI＋原生模型管理（"pi 默认做了适配获取上游信息，手动 models.json 不对"）；首要要义＝注入可见无歧义、harness 流程可看可控；ponytail 模式（最小完整改动）。前置：6 个存档 commit＋~/.neko_pi tar.zst 备份（~/backups/neko_pi-backup-20261024.tar.zst，sha 07f893ae…）。

- **去桥**（commit 42dcbfef6）：main.ts 删 opencode 分支（ui 子命令＋interactive 默认接管）；删 src/modes/tui-bridge/（8 文件）＋桥测试（12+2 个）＋vendor/opencode/（~1890 文件）；truncateNativeSession 作为 core/session-truncate.ts 存续（edit-resend 原语）；user-state/review-fixes/runtime-completions 剥离桥用例保留核心；check 0、18 文件 112/112。
- **模型管理回归原生**：发现用户 models.json 的 zai override 把 builtin 7 个 openai-completions 模型嫁接到 anthropic baseUrl（不可用组合）＋同 key 已在 auth.json（zai-coding-cn）→ models.json 清空、默认模型 zai-coding-cn/glm-5.3-flash（builtin 目录自带 thinkingLevelMap/cost/端点适配）；settings.json 修正 defaultModel 格式（须拆 defaultProvider＋纯 model id，曾因此回退 deepseek）。
- **注入可见性（◈ classic 版）**：core/injected-context.ts 解析 user 消息尾部 <message_time>/<runtime_activity>/<runtime_memory> 块（真实 transcript 验证，多换行分隔修复）；InjectedContextComponent 折叠标记（一行摘要：墙钟·活动数·记忆版本·便签，可点击/ctrl+o 展开原文）；用户气泡只显示人打的原文；3/3 测试＋真机渲染验证。
- **tps 统计行**：assistant 完成后一行 `⏱ 3.5s · out 115 · think 112 · in 22k · 32.9 tok/s`（durationMs＋usage；<250ms 跳过）；真实调用验证。
- **/context 审计命令**：内联面板（changelog 风格）——persona 包（identity/voice 字节）、记忆两作用域（版本/记录数/字节/收据 delivered-vs-pending）、便签（新鲜度+过期+预览）、穿着、近期活动；真机验证。
- **真机验收**：pty smoke（Persona "Neko" loaded＋全部 neko skills 发现）；真实 GLM 调用端到端（人格/六本书/穿着全注入生效，"皮肤上还带着事后的薄红"即余韵注入证据）；副作用检查（版本/便签无意外变化）。
- 待续：仓库精简（桥删除后的死引用扫描）、deepseek-harness 调用轨迹思想借鉴、旧 ◈ 相关文档更新（neko-runtime.md/neko-tui-capabilities.md 大量桥内容已过时）。

## 5.5 第二十五轮（2026-10-23 深夜·Neko 接力 GPT）

- 验证第二十四轮全部改动：后端 12＋54＋21、前端 4、suite 4，逐批全绿；check exit 0；bundle 重建（GPT 留下的"源码未同步发布产物"已补）。
- /context 审计与 ◈ 行统一真值：injectedStates 收据门控抽为共享方法，audit 的 injectedSummary 现在标注 injected/cached（A05 关联项）。
- vendored TUI typecheck 通道从"完全无法运行"恢复：references 修复＋自有文件清零，顺带抓出两个真 bug——process.on cast 丢 this（EventEmitter 崩溃，.bind 修复）与 SecretPrompt eventType "Down" 恒真比较（实为 "press"）。剩余 ~106 上游存量不乱改，清单留存。
- TUI fixture 清理竞态（25ms drain＋兜底重删）三连 ENOENT 零。
- flash thinkingLevelMap：上游 effort low/high/xhigh/max 实测全收，配置写入生效；发现同 providerID 双条目歧义（新待办）。
- A05 无凭据 409 测试落地。
- 最终：本轮新增/改动测试全绿（bridge-round4 17/17、bridge-thinking 3/3、bridge-noauth 1/1、TUI neko 套件 11/11×3）、check exit 0、bundle 重建。

## 5.7 第二十七轮（2026-10-24 凌晨·去桥后清扫与借鉴）

- 死引用扫描：全仓 grep tui-bridge/opencode——src 零残留（余下 opencode 字样均为上游 pi 自带 provider 名/注释）；候选 core 模块引用清点全部有活引用，零死代码可删。
- 文档去桥化（已提交）：neko-tui-capabilities.md 整体重写为原生架构能力清单（含已知边界诚实清单）；neko-runtime.md 三处桥段落改写（冻结快照表述、receipt 去重归属），"bridge" 零残留。
- stylebank 真实运行验证：原只有 3 个单元测试（规则解析＋匹配）且主人环境零配置；新增 harness 端到端（stylebank-e2e 1/1）：规则配置→模型调 bash→tool_result→hint 以 custom 消息（customType "stylebank"）紧跟工具结果落进会话、每轮一次（emitted 闩）。调试中确认落点是 custom 消息而非 user steer。
- hook 逐项证据刷新：stylebank-e2e＋memory-external-edit＋steer-lifecycle＋continuity-cadence＋memory-continuity＋runtime-notifications＋runtime-agent-acceptance 共 30/30——覆盖 tool_result 重索引、auto-steer sweep、便签 3-query 检查点、agent_end 写 runtime.json；before_agent_start 注入由真实调用（persona/六本书/穿着生效）与◈标记双重证明。
- deepseek-harness 调研（shallow clone 至 ~/Projects/projects_github/deepseek-harness）：核心思想两个——①turn-metrics 的 TTFT/decode 分离（首 token 延迟＝感知延迟，decode 窗口＝真实吞吐）；②process-groups 工具活动分类分组（两次回复之间的工具折叠成组、标题按前三类活动命名＋运行中实时类别）。落地①：⏱ 行升级 `ttft 0.0s · decode 10.1s · think 206 · out 213 · in 21k · 21.0 tok/s`（message_start/message_update 探针＋durationMs，真机验证）；②记入待办（涉 pi-tui 工具渲染组件，较重）。
- 验证：7/7＋check 0＋bundle 重建（注意：bundle 脚本以 dist 的 tsc 产物为输入——改 src 后必须先 npm run build 再 bundle，否则打进旧代码）。

## 5.8 第二十八轮（2026-10-24 凌晨·编辑重发落地）

- `/edit [n]` slash 命令（classic TUI 交互模型下对 opencode 消息菜单的等价物）：截断倒数第 n 条 user 轮（默认最后一条）＋rebuildChatFromMessages 重放＋composer 回填剥离注入后的原文；运行中拒绝；参数校验。check 0。
- 端到端测试 suite/session-truncate（1/1）：live 上下文与持久化文件双双移除所选轮、会话身份保持、父链完整（延续被删桥测试的原语覆盖，改走 harness 原生路径——注意 harness 默认内存会话无文件，需 SessionManager.create 显式落盘）。
- 真机验证：真实 GLM 会话两轮→/edit→磁盘 JSONL 只剩第一轮、TUI 状态行确认、transcript 重放正确。
- 至此"编辑重发"从原语到入口全链路可用；能力文档的 "No frontend menu entry" 边界项可勾销。

## 5.9 第二十九轮（2026-10-24 凌晨·工具分组落地）

- deepseek-harness process-groups 思想落地（turn 级投影，不动上游 ToolExecutionComponent）：assistant 回复完成且本轮 ≥3 次工具调用时，在 ⏱ 行上方输出一行分类计数 `⟐ N 次调用 · 读取×3 · 命令×2 · 查找×1 等4类`（top3＋等N类，deepseek 原版形态）；分类映射 read→读取、glob/grep/list→查找、write/edit→修改、bash→命令、webfetch→网络、其余→工具；<3 次保持逐行（少而清）。数据源为 message.content 的 toolCall parts（每轮 assistant message 自含）。
- 真机验证：单工具轮不显示（门槛生效）；"读三个文件"轮显示 `⟐ 3 次调用 · 读取×3`＋⏱ 行。测试 3/3（排序/门槛/未知工具兜底）＋check 0＋bundle 重建。
- deepseek-harness 两大思想（TTFT 分离＋process-groups）至此全部落地。

## 5.10 第三十轮（2026-10-24 凌晨·记忆演化全周期真实验收）

目标核心问题"neko 是否真的越来越懂主人"的机制级证据，真实 GLM 会话跨多轮验证五环全通：
- **写入**：真实会话指示 memory_write → 记录落盘（project 作用域新建 af55662f v1）＋文件/DB 双侧一致。
- **上限纪律（计划外收获）**：persona 六本书 6/6 满时模型撞上限被拒，如实报告"要腾位置"并请示——没有谎称已记录、没有硬塞。数量上限在真实模型行为下正确工作，主人账本被机制保护。
- **重注入**：同会话下一条 query 的 <runtime_memory> 同时含 persona v43 六本书全文＋project v1 新记录全文——版本跳变→全量重注入的硬证据（transcript 级）。
- **便签检查点**：第三条 user query 触发强制检查点（continuity_update 调用 ×2，含版本冲突后合并重试——设计行为），未写不收工。
- **跨会话召回**：全新会话凭注入准确复述测试事实且指名来源（"项目档案那本「验收测试·主人的测试饮品」"）——不仅记得，还知道自己从哪记得。
- **恢复**：验收后便签回 v63 原时间戳、测试 project 记忆/DB 行/会话文件全清、六本书 diff 备份零变化——主人账本无测试污染。
- 方法论：真实验收用 project 作用域装测试事实（cap 有余量、可整体清除），不碰 persona 六本书；恢复目标以演化前实时基线为准（备份时点可能更早）。

## 5.11 第三十一轮（2026-10-24·dsh 轨迹全貌对照＋工具集可见性）

deepseek-harness 轨迹体系完整挖掘（本地 clone），五件套对照：
| dsh 组件 | 思想 | neko-pi 现状 |
| --- | --- | --- |
| ContextInjectionRow/ContextBody | 注入折叠行带三属性：角色（注入/召回/工具更新）＋生产者（谁注入）＋形态（展开方式） | ◈ 标记（摘要分段 time/activity/memory/continuity，可展开原文）——缺"角色＋生产者"维度；工具更新角色本轮落地 |
| ToolCallTree | 递归工具调用投影成树（父子配对/深度上限/环检测） | 无（pi-tui 平铺；codemode 嵌套场景低频，记待办） |
| TurnRail/turn outline | 轮级导航梯子（每轮 prompt/response 预览＋锚点＋未加载翻页） | 无（pi 有 /tree 分支导航，无轮级 ladder；记待办） |
| turn-metrics | TTFT/decode 分离 | 已落地（r27） |
| process-groups | 工具活动分类分组 | 已落地（r29） |

本轮落地：工具集变化可见性（dsh toolsUpdated 角色行的等价物）——runtime-context 在 wardrobe 补入真实发生时发 toolset-update custom 消息（"工具集已恢复：+wardrobe…"），transcript 可见、每次修复仅一条、已含则静默；wardrobe 套件断言补齐（修复出标记×1、二次 prompt 不重复），3/3＋check 0。这正是 r18 老会话工具冻结坑的可见性补丁——以前工具"突然出现"，现在轨迹里写明为什么。

## 5.12 第三十二轮（2026-10-24·/undo 落地）

用户需求："undo 能做吗？只需要回滚最后一轮，不然缓存吃不消"。落地：
- **core/turn-file-journal**：轮级文件日志——write/edit 工具执行前快照目标文件原内容（首个快照生效：一轮内多次写只保最初版），新建文件标记待删；**新 user 轮开始即清空 journal**——undo 作用域恒等于最后一轮、磁盘占用恒定一轮（正是"缓存吃不消"的解法）。文件名 base64url 编码（\u0000 编码被文件系统拒绝，实测坑）。
- **undo-journal builtin 扩展**：tool_call 拦截 write/edit 的 path（bash 不拦——shell 可碰任何文件，声明边界而非假装）；按 branch 最后 user entry 作 turn key；custom 消息（扩展自制）不清 scope。
- **/undo 命令**：restoreTurn（文件回滚＋删新建）→ truncateNativeSession（轮移除）→ rebuild；状态行如实报告（"restored N file(s), removed the turn. Bash-driven changes are not rolled back"）。截断失败时文件保持已恢复状态（重跑 /undo 幂等）。
- 测试：journal 单测 2（首快照优先/轮作用域隔离——旧轮快照被清、恢复到本轮起点）＋harness 端到端 1（真实 write 工具→快照→恢复→live 上下文核对）；check 0、bundle 重建。
- **真机验证**：真实会话让模型用 write 工具改 demo.txt→/undo→文件回原文（"original content"）＋轮消失＋状态行确认。

## 5.13 第三十三轮（2026-10-24·◈ 角色化）

dsh ContextInjectionRow 三属性（角色/生产者/形态）照搬第一块：折叠标记从混合单行改为**按生产者分行**——`◈ runtime-context 时间…·活动 N·穿着…`＋`◈ memory persona v43 (6本)·便签×1`；展开态每个注入块带生产者标题（形态属性）。旧混合 summary 删除（死代码即删）；测试迁移 producerSummaries 3/3、check 0、bundle 重建、真机验证双行渲染。剩 ToolCallTree 嵌套呈现＋TurnRail /turns（r34）。

## 5.14 第三十四轮（2026-10-24·轨迹照搬完成：工具树＋轮清单）

- **嵌套工具行**（dsh ToolCallTree 的 TUI 浅树）：parentToolCallId 子调用原本被 start 分支 break、update/end 查不到组件**静默丢弃**（注释写"shown inside parent's row"实为不可见）——改为在父组件下方渲染缩进行（indent 选项，每层 2 空格），update/end 经 pendingTools 自然命中。
- **/turns 轮清单**（dsh TurnRail/turn outline 的 TUI 化）：每轮一行 `#N · 用户原文 → 回复预览 (N 次调用 · X.Xs)`，内联渲染、transcript 滚动即导航；pi 的 scrollTo 是像素级、无组件定位原语——跳转交互（选中滚动到轮）记待办需布局查询支持。
- 真机验证：两轮真实对话后 /turns 输出两行清单（含各自耗时）。check 0、bundle 重建。
- **dsh 五件套照搬至此全部落地**：ContextInjectionRow→◈ 生产者双行（r33）、ToolCallTree→缩进嵌套行（本轮）、TurnRail→/turns 清单（本轮）、turn-metrics→TTFT（r27）、process-groups→⟐（r29）。

## 6. 完成判据

- 每项完成需同时具备：实际代码路径、成功/失败行为、定向测试、`npm run check` exit 0；涉及真机的（OAuth/本地模型/切模型）留证据（日志或截图）。
- P0/P1 完成即回写 alignment todo 对应条目状态；本文条目完成打 `[x]` 并注明轮次。
