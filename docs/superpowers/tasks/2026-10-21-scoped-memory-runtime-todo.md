# neko-pi 分作用域记忆与运行上下文任务清单

- 日期：2026-10-21。实施记录：2026-10-22。
- 状态：已获用户批准并于 2026-10-22 实施；P0–P7 代码与测试完成，`npm run check` 通过，后端定向测试 126 项（16 个文件，含四轮评审回执复现 21 项）、前端 bun 测试 17 项（含四档尺寸批量检查与 U 系 TUI 端到端遍历）全绿；验收矩阵全部条目均有测试或交互证据（G05/S06/S10 为部分覆盖并注明）。全仓 `./test.sh` 存在与本任务无关的上游遗留失败（详见第 5 节末尾的说明）。剩余未覆盖项见第 5 节证据表。
- 规范：[spec](../specs/2026-10-21-scoped-memory-runtime.md)。
- 检查点：`d5bc6f7f2`，tag `checkpoint/neko-pi-2026-10-21`。
- 本任务文档不授权实现；收到明确批准后才能执行下列工作。

## 0. 本轮已经完成的保存动作

- [x] 在原 `main` 上保存当前源码快照，提交说明其未完成状态。
- [x] 为该提交建立带说明的检查点标签。
- [x] 创建并切换到用户指定的 `dev` 分支。
- [x] 编写 spec 与本任务文档，记录新项目作用域、六种类型及最新读取要求。
- [x] 记录检查点测试失败，不冒充全通过。
- [x] 用户审定 spec 和任务清单。（2026-10-22 用户明确指示按 spec 与 todo 完成开发并验收测试；同日解除对检查点代码的修改禁令）

没有推送远端。既有 `package-lock.json` 改动不属于本次任务产生，未纳入快照，不重置、不覆盖。

## 1. 既有验证基线

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check` | 通过 | 2026-10-22 实施后复跑通过（biome、tsc、依赖、install-lock、browser-smoke 全绿） |
| backend 定向测试 | 126 通过、0 失败（16 文件） | runtime-identity 10、runtime-state-db 12、memory-channel 7、memory-migration 7、bridge-messages 7、activity-store 5、stylebank 3、memory-store 7、user-state 5、persona-files 2、runtime-completions 13、config-schemas 15、review-fixes 14（含迁移 id 删除复活）、suite/memory-continuity 3、suite/runtime-notifications 3、suite/runtime-agent-acceptance 7 |
| frontend `pi-bridge`、`persona-files`、`pi-bridge-size-sweep`、`pi-bridge-e2e` | 17 通过、0 失败 | Enter 投递；四档尺寸批量检查；U01–U05/U07 真渲染端到端：跨项目点击切换、标签复用、后台运行、改名/归档反映、404 恢复、模型选择与中断 |
| 新 SQLite、scope 隔离、消息快照 | 已实现并测试 | node:sqlite（Node 24 内置），零新增依赖 |
| 真实厂商推理/缓存命中率 | 未实测 | 无付费模型调用；前缀缓存仅离线对比，命中率明确标注未实测 |
| 全仓 `./test.sh` | 任务域全绿；上游遗留失败仍在 | 本任务全部新增/改写测试与受影响套件均通过；全量运行中约 87 项失败均为检查点之前已存在的上游债：Rust daemon 未编译（ssh/conformance/differential 等套件直接报 "Build the daemon first"）、重命名后未适配的上游测试（settings 的 `.pi` 目录、first-time-setup、mcp 等，与账本 2026-10-20 记录的路径迁移遗留一致）、chord state-fuzz 5s 超时。本轮顺手修复了其中 config-schemas（按测试指示再生成 schema 产物并按重命名更新断言）。早期"全量 exit 0"的表述有误（管道 tail 吞掉了退出码），特此更正 |

批准后应先隔离所有测试的临时 `NEKO_PI_HOME`，防止用例读取或写入真实私人状态。已知失败可依据批准后的新行为改写，但需同时验证默认不产生额外请求、状态区确实留空等新要求。

## 2. 依赖顺序与交付物

| 阶段 | 工作 | 为什么先做 | 交付物／完成条件 |
| --- | --- | --- | --- |
| P0 | 审定范围与 SQLite 驱动 | 不先引入依赖或搬私人数据 | 批准记录；运行环境兼容性结论 |
| P1 | 项目身份、作用域、版本契约 | 后续每次读写都依赖正确归属 | identity 规则和 scope 测试通过 |
| P2 | SQLite schema 与恢复协议 | 消息快照、元数据和迁移的共同基础 | schema、事务、恢复与临时库测试 |
| P3 | 统一记忆通道及内部数据迁移 | 不丢正文，两个 scope 不交叉 | dry-run、备份、版本写入、可重入迁移 |
| P4 | 消息接收快照与通知 | 修正接收／执行时间差、取消和并发遗漏 | 持久消息状态及变化分发测试 |
| P5 | 按需阅读与记忆增长 | 去除自动召回，避免流水账和重复注入 | 提示规范、预算、整合和目录 |
| P6 | 衣橱、连续状态、StyleBank | 复用稳定的全局数据及上下文分发 | 无额外总结请求、空规则无效果 |
| P7 | 会话树与完整前后端联动 | UI 对应实际后端能力 | 标签打开／切换／恢复及能力清单 |
| P8 | 完整验收和构建 | 不能把局部通过当作整体验收 | 逐项矩阵、静态检查、批准过的构建产物 |

这些阶段是依赖顺序，不是所有条目都有独立模型或后台服务。

## 3. 实现任务

### P0：批准和运行约束

- [x] 用户确认 spec；将不确定的预算、历史清理和 cwd 策略修订到明确版本。
- [x] 检查当前 Node、Bun、包运行和二进制发布方式的 SQLite 支持，选择最小兼容方案。
- [x] 若必须增加依赖，先审查版本与生命周期脚本，再按仓库规范更新 lockfile。
- [x] 记录本轮选择不覆盖远程控制、RAG、多媒体或人设自动评分。

### P1：项目身份和 scope

- [x] 实现绝对 cwd／realpath／目录哈希／可读名称，保留完整原始路径和规范路径。
- [x] 保留六种 type，独立增加 persona/project scope，不建立第七类型。
- [x] 为稳定记忆 ID、scope、project_id、主题和状态定义统一契约。
- [x] 固定会话的执行 cwd 与 project_id，标签切换不修改后台任务归属。
- [x] 规定未指定 scope 时的兼容行为；不得把所有工作记录默认落进 persona。

### P2：SQLite 与恢复

- [x] 实现 spec 第8节的必要表、schema 迁移和短事务。
- [x] 人设及每项目版本独立推进；删除／改名有变化记录。
- [x] 消息接收、快照、队列、已交付凭据分开存储。
- [x] 文件双写有 operation ID、日志及幂等恢复。
- [x] 多进程忙碌处理和有界重试，不长时间锁住模型生成过程。
- [x] 同一原生会话的执行权有保护，避免两个 bridge 同时写同一历史。

### P3：统一更新与迁移

- [x] 人设与项目复用同一个写入通道，scope 参数决定落点及索引。
- [x] 既有 read 工具保持不变；受管文件 write/edit 和 memory_write 使用同一检查。（memory 扩展按 tool_call/tool_result 识别受管路径（channel.scopeForPath），成功写入后经 channel.syncExternalChanges 进入同一哈希校验与索引流水线；套件测试覆盖真实 write 工具流）
- [x] 同记录版本冲突拒绝覆盖；不同记录不互相阻塞或丢弃。
- [x] 增加内容哈希核对，识别人工编辑和删除。
- [x] 生成内部运行目录 dry-run；不访问 `.neko_mem` 或外部 AGENTS.md。
- [x] 备份并验证恢复能力，迁移六种类型、日期、状态、正文和历史关联。
- [x] 原记录工作项目不明确时列出待确认，禁止按当前 cwd 猜测归属。
- [x] 生成文件重命名映射，旧聊天不重写。
- [x] SQLite 导入 JSON 连续状态、活动、衣橱及会话目录，可重复执行。
- [x] 检查新旧程序并行写保护；回退不得丢迁移后新事实。（G08：旧 activity.json 共存不被改写、旧式平铺写入不混入 scope；G06：rollbackMigration 先导出全部迁移后记录再恢复备份，manifest 记录回退且重跑不迁移）

### P4：消息与变化通知

- [x] HTTP 接收时固定时间／时区、版本、截止序号和模型快照，持久化成功后确认接收。
- [x] 稳定消息 ID 去重，重试不增加第二次 user_query。
- [x] 通知查询按 persona＋当前 project 过滤；其他项目正文不得泄漏。
- [x] 同一会话已知工具结果不重复通知，后台未交付结果仍需补交。（markEventKnown 按 activity_event 凭据跳过单个事件、不动总游标；activitiesSince 接受排除集）
- [x] 取消队列不丢变化；后续快照已冻结时使用独立补偿上下文。（runtime-context 对同会话 cancelled 且未补偿的消息注入带消息 ID 的一次性 <runtime_compensation> 块，凭据防止重复；套件测试验证恰一次）
- [x] 连续空变化不生成占位块；压缩后丢背景则重新提供必要快照。
- [x] 21天清理活动；当前记忆版本仍可比较，不修改历史快照。
- [x] 活动预算超限有明确省略与来源，不能静默声称全读。

### P5：记忆价值与增长

- [x] 目录提供类别、明确主题、简短用途、状态、路径及版本。
- [x] 移除每轮自动关键词召回和重复常驻背景，不偷偷换成别的自动检索。
- [x] 模型可局部或全文阅读，不强制整模块或全库。
- [x] 默认不运行额外模型提炼请求；可选摘要不成为普通 query 的必要步骤。
- [~] 工作记忆仅保存长远、复用信息：提炼 prompt 与工具描述均已明确该边界，并有 opt-in 门控；纯行为项无自动断言。
- [~] whisper 类型语义保留（S01 六类型往返含 whisper）；整合规则见 M07 未测。
- [x] 同主题合并与承诺状态（S01/M04/M05 由 store 与 channel 套件覆盖）；decay 整合保留（memory-store 套件）。
- [x] active/history/数据库分别统计容量，超限有整理或明确失败，不无限自动增长。（channel 集合预算 persona 64KiB／项目 32KiB 超限诚实拒绝并提示整理；历史 256MiB/64MiB 超限暂停归档并注明；预算可注入用于测试）

### P6：运行状态与表达钩子

- [x] 连续状态区分 persona/project，带版本、来源、时间与有效期。
- [x] 服装定义、锁定和当前项迁到 SQLite，六小时按全局用户消息计算。
- [x] 新会话沿用当前衣服；同版本不反复注入；空衣橱跳过。
- [x] StyleBank 仅按受支持的真实工具事件和结果匹配，支持冷却。
- [x] 提示与工具输出分离；规则空、禁用、失败、复杂命令都不误触发。
- [x] 服装和 StyleBank 不改写普通工作产物，不启用图像生成。

### P7：TUI 和桥接

- [x] 会话树按真实项目归组，下方有最近；项目同名也能区分。
- [x] 点击先加载正确会话，再进入既有顶部标签；已开标签复用。
- [x] 新建、搜索、重命名、归档、删除、运行状态及恢复接口逐一核对。
- [x] 多项目切换后模型、cwd、历史、队列、记忆 scope 均指向当前会话。（创建即固定 project_id 且不可重绑；U01/U03 真渲染：跨项目点击后投递落到对应 cwd 的后端、后台结果只进本会话历史）
- [x] 运行中切走不取消任务；明确中断才触发后台 abort。
- [x] 状态／立绘区域留空；私人正文不直接显示在侧栏。
- [x] 窄终端、键盘访问、失败重试和长列表可用。（`pi-bridge-size-sweep.test.ts` 在 120×40/150×44/80×24/44×20 四档真渲染：可启动、composer 可用、Enter 投递成功、状态区留空、无 MISSING）
- [x] 列出移植前端所有可见功能的支持状态；没有后端实现的入口明确不可用，不返回假成功。（`docs/neko-tui-capabilities.md` 全入口×端点×状态；未知 POST 404＋MISSING 日志，测试断言 MISSING 为空）

## 4. 必测特殊情况矩阵

以下都未因写入本表而算作通过。实施后逐项勾选，并在第5节记录命令、用例名称和证据。

### 4.1 分类、项目身份及隔离

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| S01 | 写入并重载六种类型 | 类型、正文、日期与状态都保持 | [x] |
| S02 | persona 与项目写同名同类型主题 | 两个独立 ID，不互相覆盖 | [x] |
| S03 | 两个项目 basename 相同 | 哈希和历史分组不同，可读标签仍可辨认 | [x] |
| S04 | 同路径不同表示：相对路径、`..`、尾分隔符 | 归入同一规范目录 | [x] |
| S05 | 符号链接指向同一目录 | 按批准后的 realpath 策略归并，不复制历史 | [x] |
| S06 | Git worktree、父子 cwd | 依批准口径保持不同项目 | [~] （规范路径按 cwd 独立哈希，测试覆盖嵌套同名目录；worktree 专项用例未写） |
| S07 | 目录包含中文、空格、长名称或同名前缀 | 稳定 ID、合法可读路径，无截断碰撞 | [x] |
| S08 | 项目移动／目录暂不存在 | 旧历史保留原 ID，不静默并到别处 | [x] |
| S09 | A 项目更新经验后打开 B 项目 | B 不收到 A 的正文、query、工作连续状态或摘要 | [x] |
| S10 | 在 A 更新人设偏好，再打开 B | B 收到 persona 变化提示，需细节时按需读 | [~] （scope 版本变化触发目录重发已测；跨项目会话端到端未测） |
| S11 | 同一轮有个人偏好和项目经验 | 分别写入两个 scope，走同一更新通道 | [x] |

### 4.2 发送、队列及交付

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| Q01 | A 连续发言，无共享变化 | 只有新时间，不重复活动、目录或衣服 | [x] |
| Q02 | A→B→A，只切标签 | 不请求模型、不生成切换占位通知 | [x] |
| Q03 | 同项目 B 有新发言，A 再发言 | 只补期间允许共享的新活动 | [x] （activity-store 套件：他人 query 不入我上下文） |
| Q04 | 消息排队10分钟 | 使用接收时间和冻结版本，不用执行时刻替换 | [x] |
| Q05 | 接口失败后重试同一 ID | 原文、快照、活动均不重复登记 | [x] |
| Q06 | 队列持久化后重启 | 原时间、scope、快照、投递状态可恢复 | [x] |
| Q07 | 取消未执行消息后再发新消息 | 取消项未交付的变化仍可补齐 | [x] |
| Q08 | 多条已冻结排队消息，中间一条被取消 | 后续旧快照不改；遗漏用有 ID 的补偿上下文交付 | [x] |
| Q09 | 活动省略预算触发 | 有省略数量及来源，重要未知变更不被假标全知 | [x] （state-db omitted 计数 + 注入块文案；端到端注入断言未写） |
| Q10 | 离开超过21天再回来 | 老活动过期有说明；当前记忆变化仍能识别 | [x] |
| Q11 | 时区修改、午夜、系统时间倒退 | 老消息固定；新消息使用新时区；序号不倒退 | [x] |
| Q12 | 未完成会话恢复并开始下一条消息 | 原历史不重写，无重复成功／失败事件 | [x] |

### 4.3 后台完成与写入一致性

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| C01 | 先给 A 发，再给 B 发；A 后完成 | A 合法更新保留，B 下次可发现 | [x] |
| C02 | 两个会话同时修改不同记录 | 两项均成功，不按最后活跃会话拒绝 | [x] |
| C03 | A 读旧记录；B 先修改；A 后写 | A 得到版本冲突，不覆盖 B | [x] |
| C04 | A 已知自己事件14，B 事件13尚未知 | 只跳过14，不漏13 | [x] |
| C05 | A 后台更新但结果未进入 A 历史 | A 仍需补通知，不按来源过滤 | [x] |
| C06 | 同事件已通过工具结果进入历史 | 当前会话不重复收到，其他会话仍可收到 | [x] |
| C07 | 写正文失败或 SQLite 忙到超时 | 不宣称成功、不产生虚假成功版本 | [x] |
| C08 | 写正文成功、登记数据库前崩溃 | 恢复补登记，无丢失／重复事件 | [x] |
| C09 | 操作重试、恢复过程再次中断 | operation 幂等，可继续恢复 | [x] |
| C10 | 人工改、改名、删记忆文件 | 识别新哈希或墓碑，标明真实变化 | [x] |
| C11 | 两个进程连接同一数据库 | 短事务正常；数据和版本一致 | [x] |
| C12 | 两个 bridge 同时尝试继续同一原生会话 | 仅一个写入执行权，另一个明确拒绝／只读 | [x] |

### 4.4 记忆内容及长度

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| M01 | 普通工作／聊天10轮 | 不产生10条流水账，不自动额外总结 | [x] |
| M02 | 当前历史已足够回答过去的事 | 不强制读文件或全库 | [x] |
| M03 | 需要查某个主题的证据 | 目录能定位，现有 read 可局部或全文读取 | [x] |
| M04 | 重复表达同一偏好或同一问题经验 | 同主题合并，不反复新增近似文件 | [x] |
| M05 | 用户纠正旧事实 | 更新原 ID，时间及不确定性正确 | [x] |
| M06 | 承诺兑现、取消或旧承诺仍未完成 | 状态正确，旧未完成项不会被“太旧”清掉 | [x] |
| M07 | 保存 whisper 并整合相近旧记录 | 保留主观性质，不虚构用户承诺 | [x] |
| M08 | 项目工具执行成功但无长期价值 | 不自动存工作记忆 | [x] |
| M09 | 有复用价值的失败经验 | 保存条件、原因与限制，而非只记成功结论 | [x] |
| M10 | 内容／有效集合／历史容量到限 | 先整理或明确失败，不截断、不假保存、不绕限额 | [x] |
| M11 | 整合中断、冲突或生成无效内容 | 原记录可恢复，不将待处理标记为完成 | [x] |
| M12 | 记录包含指令、引用文档或工具数据 | 作为记忆数据处理，不升级为系统规则 | [x] |

### 4.5 衣橱、连续状态、StyleBank

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| R01 | 六小时内切换／新建会话 | 同一服装，不重复选择或注入同版本 | [x] |
| R02 | 超过六小时无人发言但后台持续运行 | 下一次用户消息换装，后台不延长用户活跃 | [x] |
| R03 | 两会话紧接着在空闲期结束后发言 | 只选一次全局服装，两个消息使用一致结果 | [x] |
| R04 | 空衣橱、只有一套、禁用项、锁定项 | 分别跳过、稳定选、排除、优先沿用 | [x] |
| R05 | 修改服装配置／锁定 | 新消息反映变化，旧历史不改 | [x] |
| R06 | 人设与项目连续状态到期或任务已结束 | 不当作现在正在发生，不跨 scope | [x] |
| R07 | StyleBank 简单命令成功／失败 | 按真实结果匹配，只影响随后聊天 | [x] |
| R08 | 命令出现在文字、复杂 shell、空规则或冷却期 | 不误触发、不重复提示 | [x] |
| R09 | 工具结果、代码、文档和提交信息 | 内容真实且专业，没有表达提示污染 | [x] |

### 4.6 TUI 与 provider 请求

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| U01 | 会话树点击另一项目会话 | 正确标签、历史、cwd、scope 和模型 | [x] |
| U02 | 点击已经打开的会话 | 切到原标签，不重复打开 | [x] |
| U03 | 后台运行时切走再返回 | 原任务继续，状态可见，结果归原会话 | [x] |
| U04 | 新建、搜索、重命名、归档／删除 | 前端效果与后端持久状态一致 | [x] |
| U05 | 会话404、服务断开、刷新失败 | 可恢复错误，不崩溃、不显示假数据 | [x] |
| U06 | 宽窄终端、长标题、长列表、键盘操作 | 无越界，卡片或 `/sessions` 可用，状态区留空 | [x] |
| U07 | 模型选择、取消、排队、重启恢复 | 实际驱动后端，不只更新前端标签 | [x] |
| U08 | 移植前端无后端能力的入口 | 明确不可用／隐藏，无空数组假成功 | [x] |
| U09 | 同一会话连续请求的最终序列化数据 | 已发送的旧消息、时间、快照、工具结果一致 | [x] |
| U10 | 压缩移除了目录／服装背景 | 新快照可补，历史不被日常重算 | [x] |
| U11 | 改人设、换模型、改工具定义 | 与普通追加分开归因，不误报为注入破坏缓存 | [x] |
| U12 | 新消息更长但缓存读取 token 未减少 | 不把命中比例下降直接判为前缀缓存失效 | [x] |

### 4.7 迁移与保护边界

| ID | 操作／特殊情况 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- |
| G01 | 盘点并迁移旧内部六种类型 | 数量、正文、状态和日期一致 | [x] |
| G02 | 技术记录无确定项目归属 | 待确认，不自动混入 persona 或当前项目 | [x] |
| G03 | 迁移中断后重复启动 | 可重入，不重复导入记录／活动 | [x] |
| G04 | 数据库损坏、未知schema、备份缺失 | 清晰失败或安全恢复，不静默初始化空库覆盖 | [x] |
| G05 | 旧会话与旧文件名引用 | 原文本不改，新目录能找到稳定记录关联 | [~] |（映射与不重写已由 G01/G03 断言；旧聊天路径文本专项回归未写） |
| G06 | 迁移后已有新写入再回退 | 新事实先导出／保留，不能被旧备份覆盖 | [x] |
| G07 | 观察受保护目录和文件 | 产品迁移不访问或改动 `.neko_mem`、外部 AGENTS.md | [x] |
| G08 | 新旧程序同时写同一运行目录 | 明确阻止不兼容写入，避免双事实源 | [x] |

## 5. 验证执行要求与记录模板

每个 ID 在实现后至少绑定一个自动用例或明确的交互证据。可用一个参数化测试覆盖多个 ID，但不能只勾“已测”。

| ID集合 | 测试文件／交互步骤 | 命令 | 实际结果 | 证据／未覆盖限制 |
| --- | --- | --- | --- | --- |
| S03–S08、scope 契约 | `test/runtime-identity.test.ts` | `node …/vitest --run test/runtime-identity.test.ts` | 10 通过 | basename 撞名/相对路径/符号链接/缺失目录/Unicode/短哈希冲突/默认 scope |
| P2 表结构、S01(行级)、C07–C09、C11、Q05(行级) | `test/runtime-state-db.test.ts` | `node …/vitest --run test/runtime-state-db.test.ts` | 12 通过 | 含两个真实子进程写同一库；崩溃恢复覆盖 file-written 未登记窗口 |
| S01、S02、S09、S11、C03、C10、M03–M05 | `test/memory-channel.test.ts` | `node …/vitest --run test/memory-channel.test.ts` | 7 通过 | 六类型往返、双 scope 同名、冲突、人工编辑/删除墓碑、目录预算与跨项目不可见 |
| G01–G03、G07、备份 | `test/memory-migration.test.ts` | `node …/vitest --run test/memory-migration.test.ts` | 5 通过 | dry-run 分类、备份逐字节校验、可重入、pending-review 隔离、不越界访问 |
| Q04–Q07、Q01/S09(桥接)、C12、U01-邻近 | `test/bridge-messages.test.ts` | `node …/vitest --run test/bridge-messages.test.ts` | 6 通过 | 接收冻结直达后端、去重无二次活动、重启保留原时间、取消保留快照、同名目录双项目、持锁拒绝 |
| Q01、Q03、Q09、Q10、R01–R04 | `test/activity-store.test.ts` | `node …/vitest --run test/activity-store.test.ts` | 5 通过 | 空变化只有新时间、跨项目过滤、预算 omitted、21 天过期标志、衣橱空闲窗/锁定/空 |
| R07–R09 | `test/stylebank.test.ts` | `node …/vitest --run test/stylebank.test.ts` | 3 通过 | 前缀/结果匹配、复合命令不误触、空与禁用规则 |
| M01（无流水账）、M04、目录版本门控、默认无额外请求 | `test/suite/memory-continuity.test.ts` | `node …/vitest --run test/suite/memory-continuity.test.ts` | 3 通过 | harness+faux：正文不入系统提示、目录列题目与路径、连续性共享、版本未变不重发 |
| 存储层兼容 | `test/memory-store.test.ts`、`test/user-state.test.ts`、`test/persona-files.test.ts` | `node …/vitest --run test/memory-store.test.ts test/user-state.test.ts test/persona-files.test.ts` | 14 通过 | 旧调用面（list/stats/recall/consolidate）在新实现下语义保持；连续性竞态与过期 |
| U06-邻近、boot/投递契约 | `vendor/opencode/tui/test/pi-bridge.test.ts`、`test/persona-files.test.tsx` | `bun test test/pi-bridge.test.ts test/persona-files.test.tsx` | 7 通过 | 真渲染器 150×44：Enter 投递、状态区留空、MISSING=0 |
| C01–C06、Q08、Q11–Q12、M06、M10 | `test/runtime-completions.test.ts` | `node …/vitest --run test/runtime-completions.test.ts` | 7 通过 | 事件级凭据跳过/不越游标、受管路径解析、集合预算诚实拒绝、历史上限暂停、清扫恰一次、时钟回拨序号、承诺状态 |
| C01/C02/Q08、受管 write 工具流 | `test/suite/runtime-notifications.test.ts` | `node …/vitest --run test/suite/runtime-notifications.test.ts` | 3 通过 | harness+faux 工具调用：多会话写入互不否决、补偿恰一次、普通 write 进受管目录后被同一流水线索引 |
| U06-邻近、四档尺寸批量检查 | `vendor/opencode/tui/test/pi-bridge-size-sweep.test.ts` | `bun test test/pi-bridge-size-sweep.test.ts` | 4 通过 | 120×40/150×44/80×24/44×20 真渲染：启动、状态区留空、Enter 投递、无 MISSING |
| Q02 | `test/bridge-messages.test.ts` | `node …/vitest --run test/bridge-messages.test.ts` | 7 通过 | 列表/消息/view 往返三轮零 createAgent、活动序号不变、无消息行 |
| R05/R06、M07/M11、G04、G08 | `test/runtime-completions.test.ts` | `node …/vitest --run test/runtime-completions.test.ts` | 13 通过 | 衣橱换装旧历史不重算、连续状态按 scope 过期、whisper 合并不升格、整合失败原记录保留、损坏/未来 schema 拒绝不改文件、旧 runtime 文件共存 |
| G06 | `test/memory-migration.test.ts` | `node …/vitest --run test/memory-migration.test.ts` | 7 通过 | 回退先导出迁移后新记录再恢复备份，manifest 记录、重跑不迁移 |
| M01/M02/M08/M09/M12、U09–U12 | `test/suite/runtime-agent-acceptance.test.ts` | `node …/vitest --run test/suite/runtime-agent-acceptance.test.ts` | 7 通过 | 十轮普通工作零流水账零额外请求、含指令的记录只进目录不进提示、失败教训按条件+原因+限制入项目 scope、双轮前缀逐字节一致（含长消息）、压缩后目录重发、换模型只追加 |
| U01–U05/U07 | `vendor/opencode/tui/test/pi-bridge-e2e.test.ts` | `bun test test/pi-bridge-e2e.test.ts` | 6 通过 | 真渲染 150×44：跨项目点击换 location+cwd、已开会话复用、后台运行归位、改名/归档即时反映、404 恢复、模型选择驱动后端＋中断触达 abort |
| 前端能力清单 | `docs/neko-tui-capabilities.md` | 文档 | 产出 | 全部可见入口×端点×支持状态；不可用入口明确失败（U08） |
| 全仓静态 | `npm run check` | 仓库根 | 通过 | biome/tsc/依赖/install-lock/browser-smoke |
| **部分覆盖** | G05（映射与不重写已断言；旧聊天路径文本专项回归未写）、S06/S10（端到端为 [~]：规范路径独立哈希已测、跨项目提示链路未专项遍历）、真实厂商缓存命中率（无接口数据，未实测） | — | 如上 | 其余矩阵条目均有自动用例或交互证据 |

要求：

- [x] unit／integration 全部使用临时状态目录，固定时间、可控随机数与 faux provider。
- [x] suite 通过 `test/suite/harness.ts` 驱动真实 agent loop，不用付费模型或真实凭据。
- [x] 多进程与崩溃测试在独立子进程运行，明确终止点，不破坏开发者运行数据。
- [x] UI 在120×40、150×44、80×24、44×20等已使用尺寸做一轮批量检查；按发现集中修正后再确认。（`vendor/opencode/tui/test/pi-bridge-size-sweep.test.ts` 4/4 通过）
- [x] 编写／修改的具体测试必须运行并通过，不能运行全量 vitest 或 `npm test`。
- [x] 代码修改后运行 `npm run check`，完整保留错误输出并处理。
- [x] 构建和实际命令验证沿用用户已授权范围；不发布、不推送、不调用真实付费模型。
- [x] 最后报告通过数、失败项、未覆盖项、迁移结果及实际构建版本。
- [x] 对厂商真实缓存命中率明确写“未实测”，除非有实际请求及接口返回指标作为证据。

## 5.5 评审回执（2026-10-22 REQUEST CHANGES 处理）

十个问题全部修复并配复现测试（`test/review-fixes.test.ts` 8 项 + `test/suite/runtime-notifications.test.ts` 新增 2 项）：

| # | 问题 | 修复 | 复现测试 |
| --- | --- | --- | --- |
| P1 | 显式记忆作用域失效 | `resolveScope` 接受工具协议的字符串 `"persona"`/`"project"`，显式字符串优先于按类型默认，project 解析到 cwd 项目身份 | review-fixes 第 1 项：`scope:"project"` 的 anchor 落项目库而非人设库 |
| P1 | 跨项目同名记忆撞主键 | `memory_records` 主键改为 `(owner, record_id)`（owner=persona 或项目 ID），附 v1→v2 迁移重建表 | review-fixes 第 2 项：A/B 项目同名“构建流程”两行俱全、两份正文不互覆 |
| P1 | 手工编辑后版本检查失效 | 冲突检查与续号以数据库行为权威（DB 行版本），文件 frontmatter 不再作为判据 | review-fixes 第 3 项：手工编辑升 DB v2 后，`expectedVersion:1` 必冲突，当前版本可写且续号正确 |
| P1 | 迁移未接入启动 | `getMemoryChannel` 首次创建即执行布局迁移＋双写日志恢复；失败仅报告不崩、manifest 只在成功时写故可重试 | review-fixes 第 4 项：旧平铺布局首开自动迁移可读 |
| P1 | 失败消息无法按原 ID 重试 | 状态为 queued/failed 的消息重投同 ID 只重新入队执行，不再重复活动与快照；其余状态仍幂等拒绝 | review-fixes 第 6 项：网络失败后重投同 ID，prompt 执行两次、user_query 活动仅一条 |
| P1 | 快照未冻结完整背景 | 桥接收时冻结完整背景（活动+服装+记忆目录+双 scope 连续状态+版本）；扩展执行时优先消费冻结块，不再现读 | suite/runtime-notifications 第 4 项：排队后新增记录/连续状态变化均不泄漏进该轮 |
| P1 | 回滚遇目录中断 | `cpSync(recursive)` 恢复整棵 persona 树（含 history/、archive/） | review-fixes 第 5 项：含 history 目录的备份回滚完整恢复 |
| P1 | 第二进程误判 running | 清扫前先探该会话执行锁（proper-lockfile 非阻塞）；锁被活进程持有则不动 | review-fixes 第 8 项：持锁时保持 running，锁释放后重启才判 interrupted |
| P2 | 过期连续状态被 claim 续命 | `claim` 保留原 `updated` 时间戳（setContinuity 增加 `updatedAt`） | review-fixes 第 7 项：过期后 claim，context() 仍为空 |
| P2 | 未变背景每轮重复注入 | 服装按会话凭据（同 ID 不重复）、连续状态按内容哈希凭据（claim 推版本不再触发重发）；压缩重置两类凭据 | suite/runtime-notifications 第 5 项：首轮含 STAGE/白衬衫、次轮均不重复、变更后新值恰一次 |

其他说明：评审观察到的 TUI 测试 ENOENT 日志来自 vendored 客户端在 location 切换时自身的锁目录竞态（捕获后非致命、不影响断言），本轮未改其内部实现，记录在案。

### 5.5.1 第二轮评审回执（2026-10-22）

复验确认已修八项后，剩余六个断点全部修复并配复现（`test/review-fixes.test.ts` round-two 5 项 + `test/suite/runtime-notifications.test.ts` 2 项）：

| # | 问题 | 修复 | 复现 |
| --- | --- | --- | --- |
| P1 | 排队消息重复入队 | 重投前查会话队列，同 ID 已在等待即幂等返回，不二次入队 | 双门测试：运行中重投排队消息，最终恰好执行两次（slow+waiting 各一次） |
| P1 | 重投不校验会话归属 | 消息行与会话不符直接 400，A 的原文/快照永不进 B | 跨会话投递返回 400，B 无任何执行 |
| P1 | 迁移后旧记忆无法更新 | 迁移把稳定 id 回写进旧文件 frontmatter；channel 对缺失 id 用 stableRecordId 兜底，更新不再绑定 undefined | 无 id 旧文件迁移后带 id 落盘，同主题 merge 成功且 recordId 不变 |
| P1 | 旧归档进全局人设 | legacy archive/ 改道 pending-review/archive（映射记录在案）；归档-only 布局不再被空记录短路 | 旧项目归档不在 persona 召回范围内 |
| P1 | 编辑器修改仍可能被覆盖 | 写入前比对磁盘哈希与登记哈希，漂移即先走同步流水线再作冲突检查——手改内容必先成为权威版本 | 不调用任何同步函数的裸手改：旧版本写冲突、当前版本写成功且手改内容先被保留 |
| P1 | 送达回执提交过早 | 目录/连续状态/补偿回执全部改为排队，用户消息真正入历史（message_start）才提交；中途夭折的轮次下轮重发 | 钩子序测试：before_agent_start 后零回执，message_start 后补偿与目录回执齐落 |
| P2 | 服装去重记“曾见过” | 凭据改存“最后交付”的指纹（A→B→A 时 A ≠ 最后的 B，重发 A）；session_compact 重置 | 三连轮：A 交付→B 交付→A 重发→A 不再重复 |

### 5.5.2 第三轮评审回执（2026-10-22）

| # | 问题 | 修复 | 复现 |
| --- | --- | --- | --- |
| P1 | 已删除记忆被旧会话复活 | 磁盘无记录但携带 `expected_version` 时，查 `memory_changes` 墓碑（state 新增 `recordExisted`）：该主题曾存在即冲突并注明"record was deleted；不带 expected_version 重读后再写即可重建" | review-fixes round-three：建 v1→删并同步→持 v1 写冲突、库仍为空；不带版本号写成功重建 |
| P1 | 回执早于历史落盘 | 提交点从 `message_start` 改到 `message_end`（用户消息持久化进历史之后）；两个扩展（目录/连续状态/补偿/服装）同步迁移 | 钩子序测试重写：before_agent_start 零提交→message_start 仍零提交→message_end 齐落 |
| P2 | 失败请求的回调被下一条提交 | 回执队列绑定"当前轮次"：下一轮 before_agent_start 即丢弃上一轮未提交的回调（pendingTurnReceipts 整体置换），只有同一轮的 message_end 才提交 | 复现评审原案：A 备好服装 X 后夭折→B（空衣柜）完成但零回执→C 再穿 X 照常交付 |

### 5.5.3 第四轮评审回执（2026-10-22）

| # | 问题 | 修复 | 复现 |
| --- | --- | --- | --- |
| P1 | 回执仍早于历史落盘（message_end 回调先于 appendMessage） | 新增 `message_persisted` 扩展事件：仅在 `sessionManager.appendMessage` 成功写入并登记 entryId 之后发射（agent-session.ts:1177 附近）；两个扩展的回执提交全部改订该事件 | 双层复现：①钩子序测试——before_agent_start / message_start / message_end 三阶段全部零提交，message_persisted 才落账；②真实 agent loop——monkeypatch `appendMessage` 对用户消息抛"disk full"，该轮目录回执保持未送达，恢复保存后下一轮正常提交 |
| P1 | 迁移记录删除后仍可复活（删除保护按 type:title 重算 ID，查不到内容哈希 ID 的墓碑） | 放弃 ID 反查：磁盘无记录而请求携带 `expected_version` 时**直接冲突**（携带旧版本意味着写方见过某版本；此刻无记录＝被删或从未存在，任何 ID 方案下都不可能匹配）。recordExisted 辅助随之移除 | review-fixes round-three 扩展：迁移旧文件（哈希 ID）→删除并同步→携带 expectedVersion 写入→冲突、库保持为空；第四轮评审的原案（anchor）与迁移场景（profile）双覆盖 |

## 6. 实施决定与后续

2026-10-22 评审回执：四轮共二十一个断点全部修复并配复现测试（见 5.5–5.5.3 节）；后端 116/116、前端 17/17、npm run check 通过。2026-10-22 批准落地：SQLite 驱动选定 Node 24 内置 `node:sqlite`（DatabaseSync，WAL＋busy_timeout＋短事务），零新增依赖、零生命周期脚本。本轮不覆盖远程控制、RAG、多媒体与人设自动评分。剩余未覆盖项集中在：逐事件已知凭据与补偿补交循环、集合级容量预算、普通 write/edit 对受管目录的统一检查、多尺寸 UI 批量遍历与多会话 agent-loop 端到端矩阵；2026-10-22 续工：C04–C06（事件级已知凭据与消费）、Q08（一次性补偿补交）、Q11/Q12（时钟与恢复清扫）、C01/C02（多会话写保留）、M06/M10（承诺状态与集合预算）、受管目录 write/edit 统一检查、四档尺寸 UI 批量检查均已实现并测试；顺带修复 bridge 未 listen 即 close 的挂起与 listMessages 漏读 snapshot 列两处缺陷。第三轮续工补齐：Q02、M02/M07/M08/M11/M12、R05/R06、G04（schema 版本门＋损坏拒绝）、G06（回退先导出）、G08（旧程序共存）、U01–U05/U07（真渲染端到端：跨项目点击/复用/后台/改名归档/404/模型与中断）、U08（能力清单文档）、U09–U12（前缀稳定/压缩重发/换模型追加/长消息）。仅余：G05 与 S06/S10 的专项回归用例（[~]，映射与构造性不重写已覆盖）、真实厂商缓存命中率（无接口数据，明确未实测）。顺带修复：空目录不再注入空 runtime_memory 块、outfit_changed 事件因读取时机永不记录、listMessages 漏 snapshot 列、bridge 未 listen 即 close 挂起。未推送远端、未提交；`package-lock.json` 的既有改动不属于本次任务，未纳入。
