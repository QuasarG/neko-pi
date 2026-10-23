# neko-pi TUI 与 Pi 后端能力对齐任务及验收表

- 日期：2026-10-22，Asia/Shanghai。
- 状态：第三轮评审（2026-10-22 夜）8 项 P1/P2 全部修复：thinking 入口（真实 DialogSelect＋GET /thinking＋current 别名）、设置真实读写（SettingsManager 回读＋/runtime-settings 对话框）、分叉接通（before 线格式＋entryByMessage 映射＋forkFromEntry 边界＋投影历史＋pointer 启动）、Shell 异步化（pi 原生 executeBashWithOperations＋started/ended 事件＋interrupt abort）、会话环境隔离（不再写 process.env）、扩展 UI 通道两端接通（bindExtensions＋TUI NekoUiRequests 消费）、/api/location/reload、GET experimental export；另接通 B01 login/logout（runtime.login＋UI 通道交互）、S03 原生会话打开恢复、B02 MCP 配置列表（状态诚实 pending/disabled，connect/disconnect 仍 partial）；修复 TUI mcp.list capabilities ReferenceError 回归。后端定向 144×3 三连稳（18 文件，bridge-p1 20 项）；前端 21/21（5 文件）；npm run check exit 0。既有失败备忘：app-lifecycle 的 SIGHUP/title 两项与 command-selection 一项在 HEAD 同样失败（终端 title 环境依赖）；settings-manager/sdk-session-manager 部分用例读取真实机器配置失败（环境性，非本轮引入，不在基线集合）。
- 实施记录：后端定向 138/138（新增 bridge-capabilities 5、bridge-input 7），前端 bun 17/17，npm run check 通过。A01/A02 并入实现轮（入口盘点以既有 capability 文档＋本轮 grep 清单为准，A02 以 pi-bridge/e2e 套件为新基线）。未覆盖：M03 最终 provider 请求验证（faux 端到端）、I02 图片过大/读取失败细分、I03 组合顺序、L 系列（认证）、W/R/S/D 系列（P1/P2）。
- 第四轮（2026-10-22 深夜·续）：5 项剩余问题修复——①分叉边界改为事件驱动精确映射（message_end 捕获消息对象，waitForIdle 后经 AgentSession.getEntryIdForMessage 解析原生 entry ID，删除按条目顺序的猜测）；②恢复/分叉只显示用户可见原文（投影剥离 <message_time>/<runtime_activity>/<runtime_memory>/<runtime_compensation> 注入块；fork 优先用桥回执冻结的原文）；③steer 携带与普通投递完全一致的记忆背景（runtime_memory/runtime_activity/message_time 逐字对齐扩展格式＋相同 receipt gating，键用原生 sessionId）；④认证前端入口（/connect 列 provider＋登录/退出，neko.auth.event 消费 auth_url/device_code 弹窗，敏感输入标注）；⑤项目 MCP 配置路径修正为 .neko_pi（CONFIG_DIR_NAME）；另修 /api/info 声明 capabilities.persistentPty:false，前端 persistent-pty 501 探测清零。MCP 连接/断开仍 partial——"全部 B 系列完成"系旧文案残留，B02 保持 [~]。后端 149×3 三连稳（19 文件，新增 bridge-round4 5 项）；前端 21/21；check exit 0。
- 第五轮（2026-10-22 夜·末）：4 项残留修复——①认证事件监听从连接面板移到常驻的 NekoUiRequests（面板被菜单替换后 auth_url/device_code 仍可达），同时修正面板缺失的 useClient 引用；②/api/integration 改为 opencode Integration.Info 线格式（methods＋connections），修复 hasConnectedProvider 崩溃——由新增的真渲染测试抓出；③steer 的记忆/衣橱回执延迟到投递成功（done 转换）后提交，失败/取消的重投携带完整背景（bridge-round4 新增失败重投回归）；④敏感输入改为真掩码 SecretPrompt（renderer.keyInput 原始按键自绘 • 行，值不落屏）；login/logout fetch 检查 response.ok。测试证据：新增 test/neko-auth.test.tsx（真桥真渲染：/connect 打开→provider 列表→点击发起登录→auth 调用断言→设备码弹窗在面板替换后仍显示→secret 输入不泄露明文）；后端 150×3 三连稳（19 文件）；前端 22/22（6 文件）；check exit 0。
- 第六轮（2026-10-22 深夜·收尾）：2 项 P2 修复——①OAuth 链接/设备码复制改用 TUI 的 useClipboard().write()（bun 下 navigator.clipboard 为 undefined，旧代码静默失败仍报"已复制"），成功提示仅在写入 resolve 后出现，失败显示错误并保留输入框内容；②供应商列表改为 DialogSelect 常驻根＋emptyView 兜底——键盘上下选择＋回车进入登录菜单（此前仅鼠标），同时修正对话框栈只求值一次元素闭包导致根级 providers() 分支冻结首帧的问题（列表需保持 DialogSelect 内部响应式）。neko-auth 测试补齐两项缺口：纯键盘进入登录菜单；按回车后断言"设备码已复制"出现在真实 clipboard.write resolve 之后且"复制失败"不出现。真实订阅 OAuth 登录＋模型请求仍未验证（无真实凭据，L01/L02 保持未覆盖）。后端 150×3 三连稳（19 文件）；前端 22/22（6 文件）；check exit 0。
- 第七轮（2026-10-22 深夜·终）：2 项 P2 收尾——①登录操作菜单 Esc 改为返回供应商列表（面板重挂载并重载列表），不再是只刷数据的死菜单；②复制改为成功后才关闭弹窗（copyToClipboard 返回布尔；失败时弹窗保留、内容可重试，提示与实际状态一致）。neko-auth 测试新增断言：Esc 回列表后可再次进入菜单（无死端）；设备码弹窗在复制成功 toast 出现时才消失。未验证边界不变：真实订阅 OAuth 授权完成→发起模型请求（L01/L02）无真实凭据，未测。后端 150×3 三连稳（19 文件）；前端 22/22（6 文件）；check exit 0。
- 第八轮（2026-10-22 深夜·真机验证）：应用户提问做真实启动 smoke（pty 驱动 ./pi-test.sh）——启动画面/输入框正常，/connect 打开供应商面板（真实 modelRuntime，未连接态如实显示），/thinking 无会话时出守卫提示，误触发的提示词失败于无凭据（无真实模型调用、无 token 消耗，误产物已清理）。过程中定位并修复一个真实关闭竞态：TUI 在启动期资源请求（GET /api/skill 等）仍在等待 agent 创建时退出，close() 会因滞留 HTTP 连接永久挂起（回归测试以永不 resolve 的 createAgent 确定性复现挂死）——修复为 close() 对 backend 创建 Promise 设 3s 竞速超时＋server.close 后 closeAllConnections() 强断滞留连接，launcher 增加 10s 强制退出看门狗。修复后真实 smoke：单次 ctrl+c 0.1s 退出、退出码 0、无残留进程（早前"挂死"观察部分为探针把僵尸进程误判为存活）。后端 151×3 三连稳；前端 22/22（重跑两次确认早前 1 fail 为偶发）；check exit 0。未验证边界不变：真实订阅 OAuth（L01/L02）。
- 第九轮（2026-10-22 夜·bundle 重建）：应用户要求重建 `packages/coding-agent/dist/bundle`（此前为 10-21 13:40 的旧快照——无能力端点、integration 为空 stub，导致新前端配旧后端出现"unsupported capabilities protocol: undefined"警告与空的提供商面板）。重建后用构建产物真机验证（pty 启动 node_modules/.bin/neko-pi）：能力警告消失（live 桥 /api/neko/capabilities → protocol:1）、/api/integration 返回全部 42 个提供商且 zai 带 credential（已连接）、退出 0.1s 干净。面板列表按字母序渲染，40 行终端内 zai 位于列表末尾需滚动/搜索（正常列表行为，非缺失）。
- 第十轮（2026-10-22 深夜·用户提供实机报障）：用户实机两连报——①发消息 400 "模型不存在 code 1211"：根因是 ~/.neko_pi/models.json 里自定义的 glm-5.3-flash[1M] 条目——pi 把 models.json 的 id 原样作为上游 API 模型代号发送（openai-completions api model: model.id，无覆盖字段），zai 不认识 [1M] 后缀；已备份并移除两个 [1M] 条目（真实代号 glm-5.3/glm-5.3-flash 保留），面板空态补提示文案。②/models 面板打不开＋composer 全死：由第十轮修复过程的真机复现定位——会话保存的模型被删后，桥为该会话创建 agent 抛 "Model not found"，getFirstAgent 把异常级联进 /api/command、/api/skill → 500 → TUI location 同步链失败 → composer 被替换为 SessionLocationUnavailable 恢复屏（Enter 全被吞，普通 prompt 也发不出）。修复三处：createBridgeAgent 对已失效的保存模型降级为默认解析（不抛）；新增 ensureBackend——失败的创建不缓存（自指比较修正后可重试）；getFirstAgent 失败时资源端点降级 200 空列表。回归：bridge-round4 新增"消失的会话模型"用例（失败→200 空列表→重试成功，attempts=2）。bundle 已再次重建，失败会话原样真机验证：恢复屏消失、/models 正常打开。后端 152×2；前端 22/22；check exit 0。
- 第十一轮（2026-10-22 深夜·历史顺序错乱）：用户报「重新加载会话时记录错乱」——截图显示助手回复跑到用户消息上方。根因：TUI 请求 `GET /message?limit=20&order=desc` 后自己 `toReversed()`（client/data.ts sync 路径），而桥忽略 order/limit/cursor 永远返回正序，导致双重反转。修复：/message 实现 opencode 分页语义——order=desc 从末尾切片倒序返回、asc 正序；不透明 cursor（`d:<offset>`/`a:<offset>`）向更早翻页，`cursor.next` 仅在还有更早消息时出现；limit 默认 50、上限 200。回归双层：bridge-round4 断言 desc 严格等于 asc 反转、limit 切片、cursor 页无重复无缺口且按 TUI 的「各页反转后老在前后拼接」可完整重建；新增 TUI 真渲染测试 neko-order.test.tsx（自建 4 条历史，断言四个标记行按时间顺序自上而下），并做了红/绿验证——旧代码下该测试必红。bundle 已重建；后端 153×2、前端 23/23（7 文件）、check exit 0。
- 第十二轮（2026-10-23 凌晨·注入可审计＋外部编辑检测）：用户要求"后台对模型上下文所做的一切在前台清晰可见"。三项落地——①外部编辑检测缺口：syncExternalChanges 原本只挂在 pi write/edit 的 tool_result 上，外部编辑器改记忆文件后 DB hash/版本不动、作用域版本不 bump、catalog 不重注入；现在 before_agent_start 决定注入前扫 persona+project 两个作用域，改动在**下一条用户消息**即被登记并重注入（红/绿验证：去掉扫描测试必红）；②注入可见：送达时（普通＋steer 两条路径）发 session.synthetic 独立通知行「injected · time … · activity N · memory catalog vX/Y · images N」，TUI 渲染为独立 ◈ 行，不混入用户气泡；投影（fork/恢复）用 extractInjectedContext 把注入块与用户原文分离保留；③审计端点 GET /:id/context——persona 包（身份/语气字节数、注入段落名）、记忆两作用域（条数/版本/活跃字节/目录字节/连续字节/标题清单）、活动游标与事件、送达回据、最近 8 条消息的注入摘要＋原始快照（injectedDetail）。前端 /context 命令渲染审计面板。memory_recall 语义确认为分词子串匹配＋salience×衰减排序（非语义检索）；此前查询为空是记忆库当时未建。后端 156×2（新增 memory-external-edit 2＋round4 审计 1）；前端 23/23；check exit 0；bundle 已重建。
- 第十三轮（2026-10-23 凌晨·记忆全量预载＋工具边界监测）：用户提议以"对话之初全量加载＋变更驱动重读"取代关键词检索为主的 recall。四项落地——①MemoryChannel.fullContent：两作用域全量正文（persona 16KB/project 8KB 预算，超出部分降级为 catalog＋read 工具指引）；注入优先全量、catalog 为溢出回退；冻结快照新增 full 字段且**冻结路径永不回退活体状态**（P1-6 抓出的真 bug：排队消息曾泄漏验收后写入的记录，修复为 frozen.full ?? frozen.catalog）；②运行中变更检测：桥在每次 tool_execution_end 先 sweep 两作用域（bash/sed 直改文件、绕过 write/edit 钩子的"偷懒"路径由此覆盖）再对比 memoryDelivered，版本落后即自动排队 auto-steer"[memory] … re-read"指令——经原生 steer 队列送达模型（用户 steer 优先），但历史记录为 system 行＋synthetic 事件（◈ 样式），绝不渲染成用户气泡；同一版本组合去重只发一次；③run 起始记录 memoryDelivered（来自快照版本），idle 时不 nudge（下一轮 user query 的门控注入自然覆盖）；④旧断言按新语义更新（M12：正文进入 <runtime_memory> 数据区＋转义不变量保留；U10/P1-6 对应调整）。新增回归：mid-run nudge（v1→v2 文本＋system 行）＋bash 绕过变体（未管理文件被 sweep 认领、第二次 nudge、两行均 system）。memory_recall 工具保留为预算外内容的检索通道。后端 157/157（21 文件）；前端 23/23；check exit 0；bundle 已重建。
- 第十四轮（2026-10-23 凌晨·中间态防护＋缓存分析）：用户情景推演——模型用多次 cat/python 分步编辑记忆文件时，工具边界 sweep 可能把"frontmatter 完整但 body 半截"的中间态登记进 DB 并触发 nudge/重注入。修复：syncExternalChanges 增加 mtime 稳定窗口（默认 2s，刚写过的文件视为 mid-write 跳过，等下个边界或下一轮 query 兜住最终态——只丢中间态不丢结果）；**write/edit 工具完成的写入绕过窗口**（settle=0，工具返回即完整，窗口只防分步 shell 编辑）；三层区分——工具 hook 即时、工具边界与 before_agent_start 扫描带窗口。情景矩阵回归：分步 cat 半截不登记、无 frontmatter 杂文件与 .tmp 永不登记、写完 settle 后恰好登记一次且幂等；P1-3/P1-E/memory-channel 三个手改测试按窗口适配。缓存命中分析（代码核实）：persona 与 MEMORY_SECTION 均不写入 system prompt（只 delete）→ system 前缀稳定；记忆注入在 user 消息尾部且门控（版本不变不注入）→ 未变时前缀不变；版本变化导致的消息内容变化是真实语义变化的必然失效；nudge auto-steer 作为新消息追加、不改写历史 → 已有前缀缓存仍命中。后端 158/158（20 文件）；前端 23/23；check exit 0；bundle 已重建。
- 第十五轮（2026-10-23 凌晨·工作流情景矩阵＋共享状态覆盖审计）：用户要求推演正常工作流情景并审计全部共享状态的"轮询＋hook"覆盖。共享状态全景：①记忆（persona/project 记录）——已全覆盖（工具 hook 即时＋边界 sweep＋消息前扫描＋mtime 窗口）；②DB 态（活动/连续性/回执/会话）——本来就活体（同一 sqlite，WAL＋短事务＋有界重试），无需轮询；③persona 包——loadPersonaPack 每条消息从磁盘重读（实测：会话中编辑 persona.md，下一条消息的 system prompt 即生效；注意这会打断缓存前缀，属语义真实变化）；④models.json/settings.json/mcp.json/auth.json——启动期配置，各有明确刷新边界：models/settings 经 /api/reload 或新会话，auth 经登录/登出端点后目录刷新，mcp.json 随 agent 重建；外部直改这四类文件不经 reload 不生效——这是文档化行为而非缺陷（运行中静默换模型/凭据风险大于收益）。实测补证：跨通道共享 DB（双 MemoryChannel 实例模拟两个桥进程）——B 即时看到 A 的版本/记录、A 感知 B 写入、fullContent 含双方内容；pending-review 为迁移暂存区、刻意不注入（遗留 4 个空壳待用户授权清理）。多会话并发安全靠既有原语：proper-lockfile 守 run、withStorageLock 守记忆双写、WAL 短事务守 DB。
- 第十五轮补（2026-10-23 凌晨）：用户两处更正——①唤起边界：本系统唯一入口是 neko-pi；pi 命令属上游 pi（独立 agent 目录 ~/.pi），与 ~/.neko_pi 无任何路由关系，此前"终端跑 pi login 影响 auth"的说法作废——neko-pi 的凭据外改只能来自直接编辑 ~/.neko_pi/auth.json（生效边界不变：登录/登出端点或新会话）。②共享状态清单补全：**衣橱（persona/wardrobe.json 文件态）＋当前穿着（DB outfits/wardrobe_state）**——验证链路：loadWardrobe 每次调用从磁盘重读（实测：会话中途新建/编辑 wardrobe.json，下一条消息的 selectOutfit 即看到，含 locked；无效文件响亮报错不静默）；ActivityStore.prepare 每条消息把 wardrobe.json 同步进 DB（importWardrobe 保留仍有效的当前选择）、按 6 小时空闲窗重选（全局单一选择，全会话共享，locked 钉死）；穿着变化走活动流注入（outfit 块＋指纹回据，A→B→A 会重附描述）。其余补录：memory/persona/runtime.json＝记忆维护状态（readAt/维护开关展示）；~/.neko_pi/runtime.json＝memoryReflection 开关；tui/＝前端本地存储（不经桥）；mcp-auth.json＝MCP OAuth 凭据（凭据类，同 auth 边界）。至此共享状态全清单：记忆记录（轮询+hook 全覆盖）、DB 态六表（活体）、persona 包含 wardrobe.json（每消息重读）、四个启动期配置（显式刷新边界）、TUI 本地存储（前端自理）。
- 第十五轮补②（2026-10-23 凌晨）：用户实机报告"输入 pi 会进入 neko-pi"——查实：package.json 的 bin 字段同时注册了 pi 与 neko-pi，全局安装把两个名字链到同一 bundle（readlink 双双指向本仓库 dist/bundle/cli.js），上一轮"pi 属上游、零耦合"的结论是想当然（只对了 ~/.pi 不存在这一半）。修复：bin 只留 neko-pi，删除全局 pi 符号链接（用户已两次明确要求 pi 不得路由到 neko-pi）；install-lock 重新生成后 check 通过。验证：pi 现为 command not found，neko-pi --version 正常（1.3.0）。scripts/local-release.mjs 内部仍用 pi 作为二进制名（发布脚本自带，不影响本机路由），如未来做正式发布需一并改名。教训入册：判断"两个命令是否同一程序"要看 bin 解析目标，不是看文件头像不像。
- 第十六轮（2026-10-23 晨）：用户四条意见落地——①着装与文案解耦：persona.md 与 skills 中具体服装词（白衬衫等）全部泛化为"当前着装/衣扣/下摆/领口"，具体服装只存在于 wardrobe.json 数据；persona 形象行改为"着装以衣橱当前选择为准"。②外人规则具体化并升入 persona 铁律：四类外人渠道（工作产物/第三方可见输出/非主人受众/可被转发存档的通道）＋五不（称呼/语气词/括号动作/身体描述/今晚钩子）＋判定不确定按外人处理。③记忆双作用域确认对等：catalog/fullContent/continuity/收据机制相同，仅预算不同（活跃 64K/32K、注入 16K/8K）；默认归属 episode/procedure→project、其余→persona。④fork/compact 兼容确认：system prompt 每条消息从 persona 包现建（无"重载"事件），fork 复制的同前缀对 provider 缓存友好；compact 重置 memory_catalog×2＋continuity×2＋outfit 回执（下一消息重注入完整记忆正文＋两域连续性＋穿着描述；activity 游标保留只送新事件——旧事件细节由记忆承载，设计如此）；fork 视为新会话（新收据/新活动流/全局态共享：同一穿着与 lastUserAt 计时器）。另：wardrobe 工具完成（list/add/remove/lock/wear，锁定保护＋坏文件防御＋wardrobe-tool 回归 2 项）；8 场景 6h 空闲换装实测全过。后端 160/160；check exit 0；bundle 已重建。
- 第十七轮（2026-10-23 晨·home 目录精简）：用户参照 Claude/Codex dotfile 风格要求精简 ~/.neko_pi。盘点后清理：空目录 log/、repos/、cache/（含空 bin/tmp）；根目录 0 字节死 state.sqlite（真库在 runtime/）；models.json.bak-20261022（[1M] 修复已验证）；logs/smoke-20261020；persona.md.bak-before-slim（瘦身已验证）。migrations/ 的 backup-*/＋legacy-pi/（12MB）压缩为 archive-backups-20261023.tar.zst（2.5MB），pi.json 迁移完成标记保留并把 backup 路径改指压缩包（migrate-user-state 靠它判重）。保留：bin/（fd，config.ts getBinDir 引用）、tui/（launcher 活写 bridge.log）、全部活配置。顶层 17→13 项，26MB→16MB。
- 第十八轮（2026-10-23 午·用户实机抓 bug×3）：①老会话 wardrobe 工具不可见（模型翻 sqlite 自救）——根因：继续旧会话时工具集从 transcript 的 toolsAdded 恢复（_restoreToolsFromTranscript），冻结了当时的清单，新工具永远进不去；新会话正常（harness 复现 wardrobe 在场）。修复：runtime-context 在每条消息 before_agent_start 幂等确保 wardrobe 激活（pi 支持 handler 改工具集当轮生效；对最小 pi mock 加 typeof 守卫）——老会话**下一条消息即恢复**，无需重开。回归：wardrobe-tool 新增"旧会话工具集恢复"用例（先 setActiveToolsByName 模拟旧清单→prompt→断言 wardrobe 回归）。②用户问"今天的设计变更在老会话里重注入了吗"——证据充分：截图首行 ◈injected 标记（memory catalog v4/0 重注入成功）、模型从磁盘读到新 dress-sense skill；persona（每消息重读）/skill（按需读盘）/记忆（版本门控重注入）三条链在老会话全部生效，唯一被 transcript 冻结的是工具集（已修）。③repos/ 目录复活案——精简后 14:01 又出现；实测老会话启动即建、--version 不建；溯源到上游 TUI Global 服务 boot 时 mkdir 一串目录（data/config/state/log/bin/repos/tmp）；修复：util/global.ts 的 neko 分支把无消费者的 log/repos 别名到 tui 目录，启动 mkdir 循环不再多建任何东西；实测老会话启动后 repos/log 均不再出现。后端 161/161；check exit 0；bundle 已重建。
- 第十九轮（2026-10-23 午后）：①注入通知时区修复——通知行原先打 UTC ISO＋挂接收时区标签（06:38Z (Asia/Shanghai) 读作上海 06:38，差 8 小时），改为该时区墙钟"2026-10-23 14:38:49 (Asia/Shanghai)"与 <message_time> 一致；回归断言升级为墙钟格式。②用户问"能否让模型自己迁移 ~/.neko_mem 记忆＋指引是否充分"——结论：工具链通（read 任意路径＋memory_write＋skill 发现），但指引缺两块：迁移流程（对已手工迁入的 7 条查重、类型映射、预算纪律）与私域边界（欠欠本/余韵等亲密内容是否进 persona 记忆＝每次全量注入，必须主人钦定，禁止模型猜）。落地：新增 legacy-memory-migration skill（五步流程：摸两边→边界问主人→映射→预算→验收；边界分迁/问/不迁三档），persona skill 索引加入口；加载器验证 6 skills 全识别。161/161（组合跑的 1 失败为并行 worker 串扰，单独复跑全绿）；check exit 0；bundle 已重建。
- 第二十轮（2026-10-23 午后·右侧面板重构）：用户要求面板风格统一、树状分组、用途标注、外部修改警示。三项落地——①后端 /api/neko/files 每文件补 target（喂给哪个上下文块）/injection（full|catalog|state）/changeEffect（改动对运行中上下文的后果）元数据；②PersonaFilesPanel 重构为树状：身份/语气/配置/记忆/状态五组（◆◇▣◈◎ 图标），行悬停显示"目标 · 后果 · 注入方式"，面板头部计数；③外部修改检测：面板跨刷新对比 mtime，变更行标 ⚠ 已修改（警示色），头部显示"⚠ N 个文件已变更"，底部警示条列名被改文件并注明"变更将在下一条消息注入"（与记忆 sweep 链路语义一致）。测试：新增 neko-persona-warning（改 mtime→行标出现→计数→警示条→注入说明，全链路断言）；persona-files 套件适配树状 id（组.序号）＋三处时序加固（建议行门控防 Enter 竞态、组合键焦点复位、截断安全门控串）；组合 24/24 三连稳；check exit 0；bundle 重建。调试中顺带发现测试 fixture 会泄漏真实 ~/.neko_pi 记忆（未传 memoryRoot 时扫开发者家目录），已用隔离 memoryRoot 修复。
- 第二十一轮（2026-10-23 午后·侧栏卡片统一）：用户实机截图指出"会话卡片有边框、下面的人设面板没有——卡片要同样大小和风格"。修复：①PersonaFilesPanel 套上与 SessionTreePanel 完全一致的圆角边框卡片（borderStyle rounded＋theme.border.base＋paddingLeft/Right 1），两卡风格统一；②NekoPresence 中两卡之间的占位头像空档（neko.portrait-space，28×2 预留区）移除——预留头像区正式废弃，卡片直接相邻；③警示计数从头部挪进底部警示条（"⚠ N 个文件被外部修改：…"单行承载），34 列窄卡下头部双列布局会把标题和计数截成乱码；④卡片内 header/footer 文本行需 wrapMode none＋truncate，否则长文本把边框顶开换行；⑤scrollbox 高度公式修正为 files×2＋出现组数（组标题行 1 行高，旧公式按 3 行算导致空行）；⑥页脚缩短为"/persona-files · 打开全部"。neko-persona-warning 断言改为警示条措辞；前端 7/7（auth/order/warning/persona-files）、后端 161/161（wardrobe-tool＋bridge-round4 抽验）、check exit 0；bundle 重建（含 wardrobe.ts/server.ts 两处 useTemplate lint 清零）。
- 第二十二轮（2026-10-23 傍晚·记忆数量纪律＋收据驱动警示）：用户三条意见一次落地——①确认注入行为：版本门控是作用域级（persona/project 各一个 scope_version），作用域内任何记录的写入/手改都跳版本，下一条 user query 全量重注入该作用域快照（注入预算 persona 16KB/project 8KB 硬顶），版本不变则零注入；重注入频率由写入频率决定（记账随手＝常跳版本），与文件数无关，但文件越多账面越散。②记录数上限入代码：channel.write 新增 personaMaxRecords/projectMaxRecords（ChannelBudgets 扩展，默认 6/8），只拦"新建话题"不拦合并（合并是解法永不堵）；超额诚实拒绝＋note 提示合并；memory-channel 新增上限回归（触顶拒新建、合并仍过、按作用域独立）。③文档整合到 10：pending-review/ 四个空壳（2026-10-20 冒烟残留，仅 frontmatter 零正文）删除；persona 记忆 20→6 本"账册"（档案/铁律/工程经验（分域）/欠欠本（含悄悄话小节）/纪念日/近期余韵）——铁律 11 条版吞并 7 条重复版、研究方向与技术栈＋工作准则并入档案、pi 模型 id 约定迁去 project 作用域、七笔 promise 并成一本欠欠本（一笔一行带状态标记，悄悄话作尾节）、四条工程 procedure 并成分域合集；手改盘面走 sweep 登记（external_delete 墓碑/updated/imported），DB 版本自动跳。面板可见文档＝6 记录＋persona.md＋voice＋manifest＋continuity＝10。memory-hygiene skill 重写为六本书结构（新内容进对应的书不开新书）。④警示改收据驱动（用户问"跨会话提醒不一样对吧，测过吗"——老实承认旧实现是纯前端 mtime 轮询：不分会话、亮了永不消、重挂载基线重置）：/api/neko/files 支持 ?session=，按该会话 memory_catalog:persona 收据时间 vs 文件 mtime 标 pending（pack 文件每消息重载永不 pending；无 backend/无会话不标注）；前端面板在有会话时用 pending 集合（注入落地收据推进→2s 内自动消牌，切会话各看各的），home 路由保留 mtime 漂移兜底；警示条文案统一"⚠ N 个文件已变更：…——变更将在下一条消息注入"。新增 bridge-files-pending 协议级测试（A/B 双会话：双方未注入都亮→A 注入 A 消 B 仍亮→文件再改双双亮→A 再注入 A 又消 B 仍亮；pack 文件永不 pending；无 session 参数无 pending 字段）。后端 80/80（9 文件抽验含新测试）、前端 7/7、check exit 0；bundle 重建。
- 第二十三轮（2026-10-23 晚·三处诚实性修复）：用户报"不能改 reasoning effort"并要求修上一轮交代的三处文案/截断问题。①/thinking 假 415（真 bug，复现坐实）：端点只按 session.model 查 capabilities.reasoning——TUI 多条创建路径不传 model（会话在默认模型上跑、明明在思考），保存的模型被删后同样找不到；两类会话 POST 任何 level≠off 都被误拒 415 "Current model does not support thinking levels"。修复：判定改按"会话实际执行的模型"——session.model 命中目录用之，否则回退默认模型（defaultModel in active ?? active[0]）；另 loadPiModels（无 modelRuntime 的直读路径）根本没读 models.json 的 reasoning 字段，补 capabilities.reasoning 映射。新增 bridge-thinking 测试（无模型会话 204、已删模型会话回退 204、全无 reasoning 目录仍 415）。②injected 通知名不副实："memory catalog v40/0"是旧称（早已全文注入）且不区分"真的注入了"与"版本没变零注入"；emitInjectedNotice 改 async，按扩展同款收据门控（nativeSession 的 memory_catalog 收据 vs 冻结版本，无 backend/收据＝injected）标注 `memory v40/0 injected|cached`；steerRunning 连带 async 化（void 调用点三处）；bridge-round4 断言适配。③continuity_update 静默截断：schema 收 1000 字符但落盘 fitMemoryBudget 裁 300 字节（约 100 汉字），超长返回"Continuity updated."谎报成功；改诚实拒绝（超预算 not saved＋字节数＋预算说明），新增 continuity-budget harness 测试（超长拒、短摘要照常存）。验证：15＋66＋36 三批全绿、check exit 0、bundle 重建。
- 第二十三轮补（用户实机截图仍 415＋追问"pi 底层不是应该很完善吗"）：截图会话显式挂在 glm-5.3-flash，models.json 里该模型标 reasoning: false——这不再是代码 bug，是配置如实生效；但真机 curl 上游 anthropic-compat 实测 flash 接受 thinking（返回 thinking 块），即配置标错了。三层职责厘清：pi 核心层（AgentSession.setThinkingLevel/getSupportedThinkingLevels/clamp）本来就完善，经典 pi-tui 的 settings-selector 也正确走 getSupportedThinkingLevels——漏洞全在 Neko 自己加的桥＋vendored TUI 适配层（loadPiModels 丢字段、判定只看 session.model、选择器不预检）。修复：①models.json 的 glm-5.3-flash reasoning 翻 true（上游实测支持）；②GET /thinking 返回 executing model＋reasoning 能力，POST 的 415 文案带模型名；③NekoThinkingPicker 打开前预检，不支持的模型直接提示"models.json 中该模型 reasoning: false"而不是让用户选完再炸。bridge-thinking 断言扩 GET 形状（reasoning 目录 model.reasoning true、无 reasoning 目录 false）。35/35、check 0、bundle 重建；用户重启 neko-pi 后 /thinking 七档全部可用（xhigh/max 由 pi 按 thinkingLevelMap 自动钳到 high）。
- 第二十三轮补②（用户核对 continuity 注入时序）：用户确认"20:12 那条之前已注入过所以没重注入"——对：18:30 新会话首条注入便签（收据指纹 832405315），20:12 开头指纹一致零注入，20:13 轮中更新后指纹 1296961633 处于待注入；DB 指纹比对逐条核实，语义全部正确。顺带把◈标记的 continuity 段补成与记忆段同款的诚实标注：gateContinuity 按扩展同款指纹门控（continuity 收据 fingerprint vs 冻结文本哈希）标 `continuity persona injected|cached`，不再只标"带着"；36/36、check 0、bundle 重建。
- 依据：[spec](../specs/2026-10-22-tui-backend-capability-alignment.md)。
- 本轮仅编写本文件和配套 spec，不修改旧实施记录或功能源码。

## 1. 完成判据

一个任务完成需要同时具备：实际代码路径、成功/失败行为、相应定向测试和证据。只增加接口、只显示按钮、只跑通模拟后端都不能单独勾选完成。

状态统一为 `[ ]` 未完成、`[~]` 部分完成、`[x]` 完成且有证据。记录未覆盖项，不把“暂缓”记成“已实现”。

## 2. 分阶段任务

### P0：可靠输入和共同能力边界

- [ ] A01 盘点实际命令、别名、快捷键、菜单、自动补全、组件入口及所有前端请求，与 F01–F21 对应；标明纯本地功能。
- [ ] A02 为当前基础聊天、会话树、标签页、项目归属和原生历史保存建立可重复基线，不沿用旧完成记录。
- [x] A03 定义版本化 capability 对象和错误类型；将模型相关能力与全局能力区分。（`/api/neko/capabilities`：protocol:1，global/perModel 分离，partial 携带 limitations；bridge-capabilities K01 测试）
- [~] A04 实现能力查询及刷新，移除未知 GET 的空列表兜底；逐项处理启动必需请求。（未知 GET 一律 404 not-implemented；启动必需的 command/form/integration/mcp/provider/reference/shell/skill 返回各自合法空结构；持久终端 501 unsupported；K01/K02 测试）（[~]：capability 对象＋404＋启动端点已实现；TUI 端已接 CapabilitiesProvider 读取＋30s 轮询＋协议版本校验；但功能显隐控制和 K03/K4 刷新场景未覆盖）
- [~] A05 模型列表、认证可用性和默认选择接入执行使用的真实模型运行时，不读另一份独立目录猜测能力。（launcher 传入真实 ModelRuntime；catalogFromRuntime 带真实元数据与 auth 状态；默认模型＝首个 active，删除 flash 猜测；M01/M2 测试）（[~]：目录接真实注册表＋默认模型改读 SettingsManager 保存值；目录已过滤非聊天模型；但无认证时确认行为 409——P1 场景待覆盖）
- [~] A06 映射 thinking level；区分显示思考与推理强度；验证最终 provider 请求。（POST /thinking 接受 pi 级别；非 reasoning 模型 415；未知名 400；GET /:id/thinking 回读当前值，current 别名解析最近会话；前端 /thinking 入口修复为真实 DialogSelect＋真实 sessionID，unavailable 时按 capabilities 提示；M03 最终 provider 请求验证待 faux 端到端补充）
- [x] A07 对 files/images/skills/agents/variant 等提交字段逐项定义接受或拒绝行为，禁止静默丢弃。（files：inline 图片→images，URI/非图片/缺字段→400；agents/skills/variant 非空→400，空数组视为无操作；未知 delivery→400；bridge-input 测试）
- [~] A08 接通普通文件和图片附件，验证读取、模型能力、错误和草稿恢复；保留固定消息内容。（第二十四轮核对：普通文件早已有 data URI 解码/4096 字符截断及 prompt 断言；本轮补齐正文/图片/文件附件快照冻结，同 ID 失败重试复用原输入，气泡保留原文，编辑回填附件；bridge-attachments＋bridge-input＋bridge-p1 覆盖。整体组合发送与完整草稿恢复矩阵尚未补齐，保持部分验收。）
- [~] A09 将 steer/follow-up 接到原生执行边界；完成队列查询、模式变更、取消、幂等和恢复。（运行中 steer 直入原生 streamingBehavior（Q01 验证）；queue 排队并在运行结束后 drain；POST /queue/mode 校验 steer/followUp（Q2）；取消/幂等/恢复沿用既有测试）（[~]：steer 带完整冻结快照（received＋images）＋完成后 done/failed 状态转换；follow-up 排队 drain；/queue/mode 校验；但 steer 生命周期依赖原生 streaming 消费边界——faux 端到端验证 M3 未做）
- [x] A10 去除固定 Git 分支、伪模型能力和假状态；未知值明确显示未知。（/api/vcs 用 git branch --show-current，仓库外 branch:{} 不伪造；variants 相关入口已按 F18 清理）

### P1：完成常用工作流

- [~] B01 复用 Pi 认证流程，实现登录/取消/超时/刷新/退出及模型目录更新；不暴露凭据。（GET /api/integration 列出 provider＋auth 状态；POST /api/neko/auth/:provider/login 走 runtime.login，prompt 经 UI 通道、进度经 SSE neko.auth.event，成功后目录刷新；logout 真实清除凭据并刷新目录——OAuth 浏览器流待真实凭据端到端验证，L01/L02 未覆盖）
- [~] B02 MCP 面板接真实扩展状态和连接操作；区分未配置、未连接、认证失败、连接中和已连接。（GET /api/mcp 从全局/项目 mcp.json 列出服务器，disabled 如实标记、其余 pending 并在 capabilities 声明连接状态由 pi /mcp 管理；connect/disconnect 不可达——pi 连接状态在扩展闭包内，桥无法操作（partial，R01 未覆盖））
- [~] B03 Skills、模板和扩展命令接实际加载资源；实现列表、调用、未知命令和资源失败处理。（GET /api/skill＋/api/command 从 ResourceLoader.getSkills/getPrompts 取）
- [x] B04 建立扩展 UI 请求/答复通道：会话与请求 ID 关联、取消、超时、断开清理及通知。（两端接通：agent bindExtensions 把 ExtensionUIContext.select/confirm/input/notify 绑到通道；TUI NekoUiRequests 消费 neko.ui.request 逐个弹窗并 POST respond/cancel，notify 走 toast；无会话的全局请求（登录）照样广播；bridge-p1 验证通道从 createAgent 传入并可从扩展侧答复）
- [~] B05 接通原生 compact，显示开始/结束/失败并保持背景回执与压缩历史规则。（POST /:id/compact 调原生 session.compact()；运行中 409；bridge-p1 测试）
- [x] B06 接通直接 Shell，输出、错误、中断归原会话；不依赖上游 PTY 服务。（POST /:id/shell 先回 204，pi 原生 executeBashWithOperations 异步执行，session.shell.started/ended 事件携 Shell.Info＋Output；会话 interrupt abort 其活跃 shell；缺命令 400；bridge-p1 验证不阻塞并发请求）
- [x] B07 接通 reload，定义安全执行边界和资源刷新；不改变其他会话已接受请求。（POST /api/reload 与前端实际调用的 POST /api/location/reload 均接原生 session.reload()，后者回 204；运行中 409；bridge-p1 双路径验证）
- [x] B08 设置入口分为界面与运行两组；复用现有存储，保存后回读，注明作用域和生效时机。（GET /api/neko/settings 返回双分组＋RUNTIME_SETTING_DESCRIPTORS＋当前值；PUT 经 RuntimeSettings 写 pi SettingsManager 并回读返回，未知键 400，无适配器 501；TUI /runtime-settings 对话框展示描述/生效时机并保存回读；bridge-p1 验证回读与 SettingsManager 实际持值一致）
- [~] B09 状态/调试展示真实版本、模型、资源诊断及连接状态；保留敏感信息过滤。（/api/info 用真实 VERSION；/api/neko/capabilities 增 compact/shell/reload/export/statistics/fileAttachments）
- [x] B10 完整转换原生工具结果和进度；接通或关闭编辑器选区上下文，不发无实现 synthetic 请求。（tool_execution_update 事件映射到 SSE session.tool.update＋part.state.metadata.progress；工具执行中的增量输出实时投递）
- [x] B11 检查终端 environment 路径，支持则真实设置，否则不发送并明确限制。（PUT /:id/environment 按 opencode 线格式；变量存会话并注入该会话 shell spawn 的 env，绝不写 process.env——两会话互不污染；非法 body 400；bridge-p1 验证隔离与 backend setEnvironment 到位）

### C：清理不提供的入口（与 P0/P1 同步推进）

- [x] C01 清理 Agent 切换入口、循环快捷键和别名；保留全局单人设及底层扩展能力。（app.tsx 删除 agent.list/agent.cycle/agent.cycle.reverse/variant.list/variant.cycle 命令及 appBindingCommands 项；pi-bridge 全绿验证启动）
- [x] C02 清理 pair/web、上游服务管理、自更新和云分享入口；确认只清理当前产品不提供的功能。（删除 server.pair 与两处 opencode.update、service.restart 条件块；connect 改为本地模型配置说明保留）
- [x] C03 清理 worktree、持久终端、后台工具管理入口；保留独立的外部终端打开与普通工具执行。（删除 session.move worktrees 命令；持久终端端点返回 501 unsupported；外部终端打开未动）
- [x] C04 暂缓 undo/redo，清理命令、快捷键、消息菜单和帮助中的对应承诺。（删除 session.undo/session.redo 命令块）
- [ ] C05 清理无实现功能的间接入口和上游产品文案，保留法律声明及必要协议/依赖标识。
- [ ] C06 核对旧 TUI 配置，忽略废弃字段但保留有效主题、布局和快捷键，不整文件重置。

### P2：历史与高级诊断

- [x] D01 明确原生会话目录与 Bridge 展示投影的映射，支持符合范围的既有原生历史发现与恢复。（GET /api/neko/native-sessions 从 SessionManager.list(cwd) 发现原生会话，条目含 path；已桥的排除；POST /api/neko/native-sessions/:nativeId/open 打开原生文件、投影历史进新桥会话（native_<id>）、backend 即恢复的 AgentSession、重复打开幂等；bridge-p1 测试）
- [x] D02 实现 fork 边界的消息/entry ID 对应，新会话不修改原历史，不承诺文件回滚。（POST /:id/fork 接 opencode 线格式 before；runLocked 记录 entryByMessage（本轮 user＋assistant → 原生 entry）；SessionManager.forkFromEntry 保留边界前活跃分支；新会话带投影历史＋pointer 指向分叉文件，原历史不动；msg_* 无法解析 → 422，无 before → 全量分叉；bridge-p1 验证）
- [~] D03 实现导出适配，明确格式、脱敏、完整性与失败行为；删除未支持的格式选项。（POST /:id/export 支持 jsonl＋html，调原生 exportToJsonl/exportToHtml，未知格式 400；另接前端实际使用的 GET /api/experimental/session/:id/export 返回 info＋messages 投影；S05 脱敏矩阵未覆盖）
- [~] D04 接原生统计及上下文量，区分未知、估计值和实际值，保留缓存读写指标来源。（GET /:id/stats 调原生 getSessionStats()）

### E：文档与最终验收

- [x] E01 重写 `docs/neko-tui-capabilities.md`，每项注明前端入口、后端操作、限制、证据和当前状态。（第二十四轮纠正认证、扩展弹窗、异步 Shell 等过时描述，列明源码/发布产物与测试/真机的边界。）
- [ ] E02 更新用户命令与设置说明，移除已经取消的操作承诺。
- [x] E03 跑新增/修改的具体测试及必要回归；代码变更后按仓库规则执行 `npm run check`，完整处理输出。（后端定向 138/138（18 文件，新增 bridge-capabilities 5＋bridge-input 7）；前端 bun 17/17（4 文件）；npm run check exit 0）
- [ ] E04 检查全部验收 ID，记录通过、失败和未覆盖；真实账号、付费调用和供应商缓存不得假称已测。
- [ ] E05 汇报实际源码/启动产物是否一致；构建遵循用户授权，不用仅源码测试声称实际命令已更新。

### 2.1 剩余项可行性评估（2026-10-22）

| 项 | 可行性 | 评估 |
| --- | --- | --- |
| B04 扩展 UI 请求/答复通道 | **可做，需协议设计** | ExtensionUIContext 有 select/confirm/input/editor/notify 五个异步方法；需要在桥上建立 SSE 事件（UI 请求）＋HTTP 端点（答复）双向通道，并关联 session＋请求 ID。无技术障碍，需一轮专门协议设计。 |
| B08 设置分界面/运行两组 | **可做，需前端重构** | 替换 /settings 为双分组（界面=TUI 本地配置＋运行=Pi SettingsManager）。后端端点简单；前端需新组件。 |
| B10 工具结果完整转换 | **部分可做** | 文本和状态已完整。图片需要 ImageContent→SSE→TUI 渲染管线；details/进度需映射 toolExecutionUpdate。核心映射可做；富渲染取决于 TUI 端组件能力。 |
| D02 fork 边界映射 | **可做，需 ID 对应** | SessionManager.fork() 接受 entryId；桥需将 opencode messageID 映射到原生 entry ID（_entryIdsByMessage）。无技术障碍。 |

**结论：四项已于 2026-10-22 深夜全部实施（见各任务条目注释）。**

## 3. 联调与特殊情况验收矩阵

| ID | 操作与条件 | 必须观察的结果 | 状态 |
| --- | --- | --- | --- |
| K01 | 干净临时配置启动 | 每个初始化请求有真实实现；无需通用 GET 假成功 | [x] |
| K02 | 请求未知路径、未支持操作、合法空列表 | 分别得到明确错误或正确空结构，三者不混用 | [x] |
| K03 | capability 查询失败或协议版本不兼容 | 有可恢复错误，不默认显示全部操作可用 | [ ] |
| K04 | 登录、换模型或重载后刷新能力 | 相关控件更新，其他会话能力不串用 | [ ] |
| M01 | 只有内置模型、只有自定义模型、二者并存 | 列表与原生注册表一致，无重复或漏项 | [x] |
| M02 | 已有默认模型、默认不可用、无可用模型 | 按 Pi 规则选择或明确报错，不挑 flash 猜测 | [x] |
| M03 | 切模型与受支持思考等级 | faux provider 捕获的最终请求与界面一致 | [ ] |
| M04 | 不支持思考/图片的模型及切换后的旧选择 | 控件正确限制，非法输入明确拒绝 | [x] |
| L01 | OAuth 浏览器与设备码模拟成功 | 凭据进入临时私有存储，模型可用性更新 | [ ] |
| L02 | 取消、超时、回调失败、失效刷新、退出 | 无假成功、无悬挂等待、无 Token 日志或模型注入 | [ ] |
| I01 | 从真实输入框添加文件、图片并发送 | 原生请求包含应有内容，不仅捕获 HTTP text | [x] |
| I02 | 附件过大、读取失败、模型不支持、发送失败 | 有具体错误，草稿和附件可恢复，无半条成功输入 | [x] |
| I03 | 编辑器选区、文件引用、技能选择组合发送 | 顺序和会话正确，不漏字段、不重复注入 | [ ] |
| I04 | 新会话带终端环境或没有环境 | 首条消息可发送；环境实际生效或明确不提供 | [ ] |
| Q01 | A 执行中输入 steer 与 follow-up | 分别在原生允许边界消费与结束后消费，不全部退化为顺序 prompt | [x] |
| Q02 | 同 ID 重投、跨会话提交、切换投递模式、取消 | 幂等、归属校验和消费状态正确 | [x] |
| Q03 | 取消/失败/崩溃及重启 | 时间、固定快照、原生历史和通知补偿沿用基础规范 | [ ] |
| Q04 | 原生历史 append 失败后重试 | 送达回执不提前确认；恢复写入后可正确补交 | [ ] |
| W01 | 从 /compact 发起成功、取消及失败 | 真正调用原生压缩，显示正确状态；压缩后必要背景可补 | [ ] |
| W02 | 运行中 reload 或修改运行设置 | 明确冲突/安全边界，不偷偷改当前请求或其他会话 | [ ] |
| W03 | Shell 成功、非零退出、长输出与中断 | 原生直接执行，结果归原会话，错误非普通成功消息 | [ ] |
| R01 | MCP 无配置、配置失败、需认证、连接中、断开 | 面板展示真实状态，操作能改变后端状态 | [ ] |
| R02 | Skills/模板/扩展命令加载、执行及未知命令 | 列表与后端一致；执行不被误送成普通模型 query | [ ] |
| R03 | 扩展 select/confirm/input/editor/notify | 请求与回答匹配；关闭、超时和断开不悬挂 | [ ] |
| R04 | 两会话并行请求扩展交互 | 答复只到原会话；切标签不改变目标 | [ ] |
| R05 | 工具返回文本、图片、details、进度及失败 | 支持内容完整映射，UI 不假装都只是文本成功 | [ ] |
| S01 | 项目树/最近列表鼠标点击及键盘打开 | 正确标签、cwd、模型、项目作用域；重复打开复用 | [ ] |
| S02 | 后台运行切标签、改名、归档、删除、重启 | 结果归原会话，状态与持久数据一致，运行中限制明确 | [ ] |
| S03 | 原生既有会话首次纳入当前 UI | 原生历史不重写，映射可恢复，不凭文件名猜测归属 | [ ] |
| S04 | 在指定消息前分叉、完整分叉、无效边界 | 新旧会话独立；原消息不变；无效边界明确失败 | [ ] |
| S05 | 导出不同支持格式，包含思考/工具及脱敏 | 格式合法、范围准确、不泄露认证信息 | [ ] |
| S06 | 统计存在/缺失、未知价格、缓存读写 | 不用 0 代替未知，不把估计值当供应商计量 | [ ] |
| U01 | 设置修改后退出重开，保留既有配置 | 界面/运行分组各自持久化，主题和快捷键不丢 | [ ] |
| U02 | 全部已清理功能的命令/别名/菜单/快捷键 | 不再能打开无效操作，不残留错误引导 | [ ] |
| U03 | 宽窄终端、长标题、鼠标和键盘 | 主聊天可用，卡片布局可退化，图片/状态常驻区仍为空 | [ ] |
| U04 | 服务断开、请求失败、SSE 重连 | 错误可恢复，状态不假装成功，不重复执行 | [ ] |
| H01 | 对比连续两轮最终模型请求 | 旧消息和固定背景不变；无每轮额外总结调用 | [ ] |
| H02 | 观察产品运行目录及受保护文件 | 仅使用临时 NEKO_PI_HOME；不接触 .neko_mem 或外部 AGENTS.md | [ ] |

## 4. 测试方法与证据

- 协议测试使用临时状态目录和受控服务；不读取开发者真实凭据或改实际记忆。
- 模型参数、附件及隐藏上下文通过 `test/suite/harness.ts` + faux provider 检查最终输入。
- 渲染测试从实际命令、按键、点击和输入框触发；直接 API 测试作为补充，不能代替 UI 调用链。
- 会话 ID、消息 ID、project_id 和原生 entry ID 的关联分别验证；不只比较显示标题。
- 持久化测试在真实 append 成功/失败边界断言，不用模拟 `message_end` 等事件代替实际保存。
- 针对修改文件运行具体测试，禁止全量 vitest 和未经授权的 `npm test`/构建。
- 若需测试经典交互界面，先核对仓库当前交互测试指引的有效路径，不为测试恢复废弃产品运行目录。

| 验收 ID | 测试文件/操作入口 | 执行命令 | 实际结果 | 限制与证据 |
| --- | --- | --- | --- | --- |
| K01/K02/M01/M02/M04/A10 | `test/bridge-capabilities.test.ts` | `node …/vitest --run test/bridge-capabilities.test.ts` | 5 通过 | capability 协议、目录镜像、默认规则、vcs 真实分支 |
| B01–B03/B05–B07/B09/D03/D04/A08/M03 | `test/bridge-p1.test.ts`＋`test/suite/steer-lifecycle.test.ts` | `node …/vitest --run test/bridge-p1.test.ts test/suite/steer-lifecycle.test.ts` | 12 通过 | 认证列表/压缩/Shell/重载/导出/统计/Skills/普通文件附件/模型切换最终请求 |
| A06/A07/A08/Q01/Q2 | `test/bridge-input.test.ts` | `node …/vitest --run test/bridge-input.test.ts` | 7 通过 | 图片直达原生、text-only 415、字段拒绝矩阵、steer 原生路径、队列模式、thinking 级别、未知模型 400 |
| C01–C04/U02 | `vendor/opencode/tui/test/pi-bridge*.test.ts`（真渲染） | `bun test test/pi-bridge.test.ts test/pi-bridge-e2e.test.ts …` | 17 通过 | 清理后启动、投递、尺寸、端到端全部仍绿；被删命令不再注册 |
| 回归 | 后端 18 文件 | `node …/vitest --run <全部定向文件>` | 138 通过 | 既有记忆/桥接/评审回执套件无回归 |

## 5. 实施开始前确认

- [ ] 用户审阅本轮范围及功能处置矩阵；之后才开始代码实施。
- [ ] 确认先完成 P0 与对应入口清理，再做 P1；P2 单独报告进度，不提前声明整轮完成。
- [ ] 当前工作区既有修改属于其他工作，先记录归属；不重置、不自动提交、不覆盖旧 spec/todo。
- [ ] 如发现本表之外需移除的有意功能，列出具体入口和原因再确认，不扩大删除范围。

本轮不包含：远程控制、RAG、自动人格评分、生成图片、子代理平台、worktree 管理、上游持久终端、文件撤销/重做。
