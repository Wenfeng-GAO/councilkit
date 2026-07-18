# feat: CouncilKit 决策内核与可靠性体验（下一阶段实施计划）

- 状态：待评审（grill-with-docs 细节敲定中）
- 日期：2026-07-18
- 输入：`docs/brainstorms/2026-07-18-next-iteration-directions.md`（方向评审）、`docs/product.md`（MVP 原始承诺）、`docs/plans/2026-07-17-001-feat-runtime-host-dual-driver-v1-cutover-plan.md`（执行基座）、`docs/verification/runtime-host-v1-cutover.md`（已验收基线）
- 前置：V1 Runtime Host 切流全部验收通过（commit `c45e68e`），工作区干净

## 目标

把 CouncilKit 从"可靠的执行基座"推进为"完整的决策产品"：用户从配置 Agent 到获得一份可导出的 Markdown 决策报告的全流程闭环，同时消除日常可靠性体验断点（轮转死胡同、探针进程磨损、Scope 常驻、失败只能终止），并补齐资源治理与运维面。

**核心判断（继承方向报告）**：下一阶段的第一优先级是兑现 `docs/product.md` 的 MVP 决策承诺（D1–D6），可靠性体验（D7–D10）与体验项（D11–D16 + 快清单）按阶段并入，**不触碰已验收的 Host/Driver 协议与持久化一致性机制**。

## 非目标（本计划不做）

- 云同步/多人实时协作/账号体系（product.md V2 愿景，架构上继续杜绝浏览器直连外部服务的通道）
- Agent 插件市场、长期记忆、复杂工具权限
- Host 自动更新通道（本期只到 launchd 托管与诊断导出）
- 60 分钟与三 route soak（沿用既有冒烟/soak 口径即可，不扩大）
- PDF 导出（Markdown 先行；PDF 待报告结构稳定后单独立项）

## 总体设计约束（延续，勿违）

- 不 `git commit/push` 除非用户当次明确要求；每阶段完成先过该阶段验收再提交。
- 持久化一致性机制不得削弱：persist→ACK、幂等提交、stall/discard 语义、Web Lock + leaseEpoch fencing、SafeMarkdown 渲染约束、legacy 数据零读取。
- `pnpm typecheck`（三程序）、`pnpm lint`、`pnpm test` 必须全绿才算完；e2e/冒烟不得与 vitest 并发。
- 新写入路径必须复用既有幂等提交管线（ModelExecution 全局锚点），禁止裸 `db.*.add` 写模型产出。
- 报告/导出/日志/诊断**不记录** prompt 正文、token、Cookie、模型正文（沿用 §553 口径）。

## 阶段总览

| 阶段 | 名称 | 交付 | 依赖 |
| --- | --- | --- | --- |
| S1 | 数据模型与迁移 | Dexie v2：Room 扩展字段、Report 实体表、resultKind 扩展、默认值迁移 | 无 |
| S2 | 讨论模式与收敛编排 | mode 驱动 instruction、facilitator focus、收敛信号、maxRounds、concluding→report、startRoundWithUserMessage | S1 |
| S3 | 失败恢复与轮转产品化 | 重试/跳过/终止三件套、一键轮转、时间线轮转记录 | S1 |
| S4 | 报告视图与导出 UI | 报告页、复制/下载、模式徽章、concluding 状态呈现 | S2 |
| S5 | 探针与 Scope 资源治理 | Host readiness/catalog 缓存+退避+手动刷新、idle TTL、释放运行时、配额提示 | 无 |
| S6 | Host 运维面 | 诊断导出路由 + Settings 下载、launchd 安装脚本 | 无 |
| S7 | 房间管理 + Agent 资产化 + 用量 | 删除/重命名/复制房间、Agent 启停/复制/导入导出/测试、成本可视化 | S1 |
| S8 | 体验打磨 | 通知、Participant 状态条、搜索、快捷键、文案、接管 UI、预检 badge | S2/S3 |
| S9 | 全量验收 | 测试扩充、全门、e2e 扩充、冒烟+soak 复跑、文档 | 全部 |

---

## S1：数据模型与迁移

**目标**：为决策内核建立持久化基础，且对既有 `councilkit-runtime-v1` 数据做无损默认值迁移。

**主要文件**

- 修改：`src/models/discussion/entities.ts`（Room 增 `mode`/`targetOutput`/`maxRounds`/`status`；新增 `DecisionReport`、`DiscussionMode` 类型）
- 修改：`src/models/discussion/model-execution.ts`（`ResultKind` 增 `"focus" | "report"`；`committedEntityType` 同义扩展）
- 修改：`src/models/discussion/factories.ts`（`createDecisionReport`、Room 工厂默认值）
- 修改：`src/lib/runtime-db.ts`（`version(2)`：`reports` 表 `id, roomId, &sourceExecutionId, createdAt`；upgrade 为存量 Room 写默认值）
- 新增/修改：`tests/unit/domain-models.test.ts`、`tests/unit/models.test.ts`

**实现要点**

- Room 新增字段：`mode: "brainstorm" | "planning" | "review"`（默认 `"brainstorm"`）、`targetOutput: string`（默认 `""`）、`maxRounds: number | null`（默认 `null` = 不限）、`status: "open" | "concluded"`（默认 `"open"`；`concluding` 是编排瞬态，不落库——落库的只有 open/concluded 与 Report 行）。
- `DecisionReport { id, roomId, content, sourceExecutionId, createdAt }`：与 Message/Summary 同纪律——只由一次 report ModelExecution 的幂等提交产生，`sourceExecutionId` 唯一索引。
- `ResultKind` 扩展为 `"message" | "summary" | "focus" | "report"`；`committedEntityType` 对应 `"message" | "summary" | "report"`（focus 的实体是普通 Message，由 participantId=facilitator + round.focusExecutionId 关联标识，见 S2）。
- Dexie `version(2).stores(...).upgrade(tx)`：存量 rooms 填默认值（mode/targetOutput/maxRounds/status），不动任何既有行内容；迁移逻辑纯函数可测（fake-indexeddb 起 v1 数据→开 v2→断言默认值与内容不变）。
- CONTEXT.md 增补词条（glossary，不含实现细节）：Decision Report、Discussion Mode、Convergence、Idle Scope、Release Runtime。

**测试与验证**

- 迁移单测：v1 数据升级后默认值正确、既有 Room/Round/Message/Summary/Execution/Binding 全部原样保留。
- 新工厂验证：Report 必填字段、sourceExecutionId 非空、唯一索引冲突转 IDEMPOTENCY_CONFLICT。
- 全量 typecheck/lint/vitest 绿。

**完成信号**：Dexie v2 上线且既有数据无损；resultKind/report 类型全链路可用。

---

## S2：讨论模式与收敛编排

**目标**：Room 有模式、Round 有 focus、讨论有结束条件，收敛后自动产出决策报告。

**主要文件**

- 修改：`src/orchestrator/discussion-orchestrator.ts`（focus 执行、收敛解析、maxRounds、concluding、report 执行、startRoundWithUserMessage）
- 修改：`src/orchestrator/context-snapshot.ts`（模式化 instruction 模板）
- 修改：`src/lib/discussion-transactions.ts`（focus message 提交复用 commitModelMessage；新增 `commitReport`；Round 增 `focusMessageId` 字段（v2 迁移默认 null））
- 修改：`src/app/pages/NewRoomPage.tsx`（模式与目标输出输入、maxRounds 可选）
- 修改：`src/stores/runtime-queries.ts`（useRoomReport 等只读 hooks）
- 新增：`tests/unit/decision-orchestrator.test.ts`

**实现要点**

- **模式 instruction**：三种模式各一套 message/summary/focus/report 的 instruction 文案模板（集中常量在 context-snapshot 或新模块；instructionDigest 体系不变——不同模式=不同 instruction=不同 digest，快照语义自洽）。
- **Round focus**：`startRound` 在 prewarm 后、第一位 Participant 发言前，先做一次 facilitator 的 focus ModelExecution（resultKind `"focus"`，committedEntityType `"message"`，落 messages 表，Round.focusMessageId 关联）；失败按既有失败语义处理（不重试超过 retry-once 规则）。review 模式下 focus 必含评审维度；brainstorm 必含本轮方向；planning 必含约束确认。
- **收敛信号**：summary instruction 追加结构化末行要求（`收敛建议：是|否`）；orchestrator 提交 Summary 后解析该行（解析失败=否，不阻塞提交）。判定收敛 `(建议=是 && roundsCompleted ≥ 1) || (maxRounds !== null && roundsCompleted ≥ maxRounds)` → 进入 concluding。
- **concluding → report**：收敛判定后自动发起一次 facilitator report ModelExecution（resultKind `"report"`，committedEntityType `"report"`，快照含全部 Round Summary 与 targetOutput/mode；走同一 persist→ACK 管线）→ `commitReport` 事务落 `reports` 表并把 Room.status 置 `concluded`（同事务）。concluded Room 拒绝 startRound（ROOM_CONCLUDED），UI 只读展示时间线与报告。用户手动「总结并结束」走同一 concluding 路径（新增 intent `concludeRoom`，要求 controlling + 当前无运行中 execution）。
- **startRoundWithUserMessage(roomId, content)**：建 Round → `appendUserMessage` → 正常 prewarm/runLoop（追问落 shared context 后再开轮，消除"两轮之间不能发言"断点）；运行中发送的 UI 文案改为「将中断当前生成（stale_context）」并需确认。
- **迁移兼容**：S1 的默认 mode 适用于全部存量房间；focus 为可选环节——focus 失败的 Round 按失败语义暂停，不阻塞"focus 完成前无人发言"的不变量（focus 是 Round 的第 0 个 execution，纳入 cursor 语义：participantOrder 不变，focus 不占 cursor）。

**测试与验证**

- 编排单测（沿用 fake Host 基建）：三种模式 instruction 差异（digest 断言）；focus 先于首 Participant（execute 顺序 focus→p1→p2→summary）；收敛=是 → 自动 report → Room concluded + reports 表一行 + sourceExecutionId 锚点；maxRounds=2 到点收敛；解析失败不收敛不阻塞；concluded 拒绝 startRound；startRoundWithUserMessage 顺序（用户消息先入快照→p1 快照含该消息）；concludeRoom 手动路径等价。
- 幂等：report 重放只一行；concluding 中崩溃 → startupAudit 分类为可解释 paused，committed report 不降级。
- 全门绿。

**完成信号**：话题→focus→讨论→收敛→报告全链在 fake Host 下确定性通过；既有 15+ 编排用例不受影响。

---

## S3：失败恢复与轮转产品化

**目标**：Participant 失败不再只有"终止本轮"；needs_rebase 轮转成为一等可见动作。

**主要文件**

- 修改：`src/lib/discussion-transactions.ts`（`skipParticipant`：cursor 前进一格 + 失败记录结构化、不重试；`retryParticipant`：同 cursor 新 execution 链 retryOfExecutionId）
- 修改：`src/orchestrator/discussion-orchestrator.ts`（`retryFailedParticipant`/`skipFailedParticipant`/`rotateScope` intents）
- 修改：`src/components/room/PausedPanel.tsx`（按 pauseReason 给出三件套/轮转/直达修复）
- 修改：`src/components/room/ExecutionFailureRecord.tsx` + `round-timeline.ts`（轮转记录呈现）
- 新增：`tests/unit/recovery-orchestrator.test.ts`（或并入 decision 编排测试文件）

**实现要点**

- **三件套语义**（对齐 product.md §143）：`execution_failed`/`model_mismatch`/`tool_state_unknown`/`empty_output`/`stale_context` 暂停时——「重试该 Participant」（同 cursor 全新 executionId，retryOfExecutionId 链接，仍受 retry-once 上限约束：只允许原失败非 retryable 用尽后的**用户显式**重试，用户重试次数不设自动上限但 UI 记录次数）、「跳过并继续」（cursor+1 持久化 + 失败记录保留在折叠区；跳过 summary/facilitator 不允许——facilitator 失败仍只有修复/终止）、「终止本轮」（既有）。
- **轮转 intent** `rotateScope(roomId)`：对 needs_rebase 系暂停（detail 含 `session reconciliation:`）——`abortPausedRound` → `client.closeScope` → `markBindingClosed`（经 ensureScope 冷重建路径，已有）→ `startRound`。全链编排在一个 intent 内，任一步失败保持可解释 paused。
- **时间线轮转记录**：轮转在时间线留下结构化条目（"执行环境已重建（needs_rebase · 第 N 次）"），绑定变更事实来自 Dexie（bindings 历史）+ rounds 失败记录，不新造表。
- paused 面板动作按 code 分流：needs_rebase → 主行动轮转；其余可恢复失败 → 三件套；facilitator 失败 → 修复入口 + 终止。

**测试与验证**

- 跳过：cursor 前进、后续 Participant 正常发言、摘要含跳过记录、revision 只涨实际提交。
- 重试：新 executionId + retryOf 链、成功后 Round 继续、计数正确；用户重试不受自动上限、但同一 execution 永不重放。
- 轮转：fake Host 下 needs_rebase 暂停 → 一键轮转 → 旧 scope closed、新 scope 创建（prewarm=1/participant）、新 Round 完成、轮转条目可见、旧正文保留。
- e2e 扩充：暂停面板三动作各一条 Chromium 场景。

**完成信号**：product.md §143 的 retry/skip/pause 语义全部产品化；轮转零死胡同。

---

## S4：报告视图与导出 UI

**目标**：决策报告成为房间的一等页面产出，可复制可下载。

**主要文件**

- 新增：`src/components/room/ReportView.tsx`（SafeMarkdown 渲染 + 复制 Markdown + 下载 .md）
- 修改：`src/app/pages/RoomPage.tsx`（concluding 状态条、concluded 只读态 + 报告入口）
- 修改：`src/components/room/RoomHeader.tsx`（mode 徽章、status 徽章）
- 修改：`src/components/room/RoomListItem.tsx`（concluded 标识、报告快捷入口）
- 修改：`src/app/pages/NewRoomPage.tsx`（S2 字段的表单收尾）

**实现要点**

- RoomPage 三态：讨论中（现状）、concluding（报告生成中·preview 复用现有 preview 机制）、concluded（时间线只读 + 报告卡）。
- ReportView：九段结构（product.md §5.5），SafeMarkdown 渲染；「复制 Markdown」「下载 <topic>-report.md」（Blob 下载，无新依赖）；报告不受信渲染约束不变。
- 列表页：concluded 房间显示报告徽章，点击进入报告锚点。
- 模式徽章：brainstorm/planning/review 在 RoomHeader 与 NewRoom 回显。

**测试与验证**

- e2e：全流程（brainstorm 房间两轮 → 收敛建议=是 → 自动报告可见 → 复制/下载断言内容包含九段标题与已提交正文；maxRounds=1 路径一条）。
- 安全：报告正文注入套件复用 §580 断言（SafeMarkdown 同一渲染器）。
- 全门绿。

**完成信号**：用户能从设置一路走到一份可导出的决策报告；MVP §9 验收 1-8 条全部成立。

---

## S5：探针与 Scope 资源治理

**目标**：Settings 不再为每次打开支付 N 次 CLI handshake；Scope 资源可见、可释放、可自动回收。

**主要文件**

- 修改：`runtime-host/profiles/probe.ts`（readiness/catalog 短缓存 + 失败退避 + `refresh=1` 绕过）
- 修改：`runtime-host/routes/models.ts` + `runtime-host/routes/installations.ts`（refresh 参数透传）
- 修改：`runtime-host/scopes/scope-manager.ts`（idle TTL 清扫：无执行 N 分钟自动 close；配置项进 HostConfig）
- 修改：`src/orchestrator/discussion-orchestrator.ts`（`releaseRuntime(roomId)` intent：仅无活动执行时允许）
- 修改：`src/app/pages/SettingsPage.tsx`（手动「重新检查」、行级时间戳、退避中提示）
- 修改：`src/components/room/RoomHeader.tsx`（warm 指示 + 释放按钮 + 配额提示）
- 新增/修改：`tests/host/profile-readiness.test.ts`、`tests/host/model-catalog.test.ts`、`tests/integration/` 相关

**实现要点**

- **缓存口径**：readiness 以 `profileDigest + modelId` 为键缓存 60s，catalog 以 `driverId + installationId + route` 为键缓存 60s；握手失败按 2s/10s/30s 退避且缓存失败结果（同样可手动刷新）；任何 Profile/Installation 写操作（revalidate、Profile 编辑落库后的下次请求带 refresh=1）使对应键失效；响应带 `cachedAt` 字段供 UI 显示"X 秒前检查"。缓存只在 Host 内存，不落盘、不影响既有 200/4xx 语义。
- **idle TTL**：scope 自最后一次执行结束起超过 `idleScopeTtlMs`（默认 30min，HostConfig 可配）→ closeScopeInternal("idle-ttl")；计时器沿用 creating TTL 同款模式；close 后 binding 由浏览器侧 ensureScope 冷重建（已验收路径）。
- **释放运行时**：`releaseRuntime`（要求 room 无活动 round/执行）→ closeScope + markBindingClosed + 下一轮自动冷建；RoomHeader 显示 warm/cold 与配额占用（`GET /api/v1/scopes` 状态可得），接近 maxActiveScopes 时提示先释放。
- Settings：全局「重新检查」按钮（refresh=1 全量）、每行 `cachedAt`、退避中禁用提交并说明。

**测试与验证**

- Host 测试：同键 60s 内 handshake 计数=1、refresh=1 强制新握手、失败退避序列、Profile 编辑后键失效。
- idle TTL：注入小 TTL + 假时钟，断言超时 close 与 binding 冷重建续跑。
- e2e：释放按钮后 execute 计数与 prewarm 重新计数正确。

**完成信号**：连续打开 Settings 5 次 handshake 计数不增长；idle 30min 后无残留进程；释放入口可用且文案清楚。

---

## S6：Host 运维面

**目标**：Host 可后台托管、可自恢复、可导出诊断。

**主要文件**

- 新增：`runtime-host/routes/diagnostics.ts`（`GET /api/v1/diagnostics`，session）
- 修改：`runtime-host/main.ts`（注册路由）
- 修改：`src/app/pages/SettingsPage.tsx`（「导出诊断包」按钮，Host 段）
- 新增：`scripts/install-service.mjs`（写入 `~/Library/LaunchAgents/com.councilkit.host.plist` + load 指引；`scripts/uninstall-service.mjs`）
- 修改：`README.md`（托管运行与诊断章节）
- 新增：`tests/host/diagnostics.test.ts`

**实现要点**

- **诊断包**（强 sanitize）：health、installations（state/detail，无路径以外的敏感信息——路径属本机信息，保留 realpath？决定：**保留**，本机自诊需要；文档注明）、scope/execution 计数与状态、最近 N 条 warn/error 日志（已 sanitize 的结构化行）、config 非敏感项（mode/port/Node 版本）；**绝不包含** prompt/正文/token/Cookie/密钥/ env。下载为单个 JSON。
- **launchd**：plist 指向 `node <repo>/dist-host/main.mjs`，KeepAlive=true、ThrottleInterval=10、StandardOut/Err 到 `~/Library/Logs/CouncilKit/`；脚本只写文件并打印 `launchctl` 指引（不自动 load，由用户确认）；README 给出卸载与日志位置。手动验证，不纳入自动门。

**测试与验证**

- diagnostics 测试：200 + schema 完整 + 敏感字段扫描（无 csrf/session/prompt/output 字样值）。
- 手动验证 launchd：重启后自恢复、日志可读（记入验收文档）。

**完成信号**：一键导出安全诊断包；Host 崩溃由 launchd 拉起（人工确认）。

---

## S7：房间管理 + Agent 资产化 + 用量可视化

**目标**：房间与 Agent 成为可管理的一等资产；成本透明。

**主要文件**

- 修改：`src/app/pages/HomePage.tsx`（删除/重命名/复制、搜索过滤、排序）
- 修改：`src/components/settings/AgentsSection.tsx`（启停/Duplicate/导入导出/测试）
- 修改：`src/models/discussion/entities.ts`（Agent 增 `enabled: boolean`，v3 轻迁移或并入 S1 的 v2——**建议并入 v2**）
- 新增：`src/lib/room-admin.ts`（deleteRoomCascade、duplicateRoom、renameRoom 事务）
- 新增：`src/lib/agent-io.ts`（导出 schema + 导入校验，secret-free by construction）
- 新增：`src/components/room/UsageBadge.tsx`（Room/轮级 usage 汇总）
- 新增/修改：对应单测

**实现要点**

- **删除房间**：级联删除 participants/rounds/messages/summaries/executions/bindings/reports + 关闭可能存在的 warm scope（先 releaseRuntime 语义），二次确认，不可撤销文案；**不触碰**任何 legacy 数据。
- **复制房间**：新 Room + 复制 topic/background/mode/targetOutput/maxRounds/facilitator 指向（按 agent 重 join 生成新 Participant，profileDigest 现算），不复制消息。
- **重命名**：复用 `updateRoomSharedConfig`（已是共享写 + revision 语义）。
- **Agent 启停**：`enabled=false` 在 NewRoom 列表隐藏（存量 Participant 不受影响）；Duplicate 复制 persona/profile/model（新 id、revision=1）；导入导出 JSON（schema 校验 + 引用 profile 必须存在，否则标"待绑定"态并按既有 needsProfile 语义处理——不自动猜测安装）；**测试调用** = 一次 readiness handshake 的显式触发与结果展示（不烧模型生成，V1.1 口径；ui 注明"仅验证执行环境"）。
- **用量**：`modelExecutions.usage` 聚合——Room 头部累计（input/output/costUsd）、每轮小结行、房间列表按最近成本排序选项；仅展示已落库数据，零新增采集。

**测试与验证**

- 级联删除完整性（各表计数归零 + scope 关闭 + legacy 探针仍零读取）；复制后新 Participant 快照 digest 正确；导入：坏 schema/未知 profile/缺字段分别拒绝，合法导入可立即可用；启停后 NewRoom 过滤。
- e2e：删除/复制/启停/导出导入各一条。

**完成信号**：房间与 Agent 全生命周期可管理；成本在房间级可见。

---

## S8：体验打磨（通知/进度/搜索/快捷键/文案/接管/预检）

**目标**：高频感知断点清零。

**主要文件**

- 修改：`src/app/pages/RoomPage.tsx`（标题栏/favicon 完成与失败指示、Participant 状态条、两种"暂停"文案区分、发送前中断确认）
- 修改：`src/components/room/RoomHeader.tsx`（Participant 状态条：等待中/生成中/已完成/失败）
- 修改：`src/app/pages/HomePage.tsx`（搜索框、下一步引导）
- 修改：`src/components/room/ControlBanner.tsx`（显式「取得控制权」按钮 + takeover_failed 修复指引 + 控制者标识）
- 修改：`src/components/room/PausedPanel.tsx`（按 code 直达修复对象：mismatch→Agent 编辑、prewarm→Installation 行）
- 新增：`src/app/shortcuts.ts`（Cmd/Ctrl+Enter 发送/开始新一轮、焦点语义）
- 修改：`src/styles/globals.css`（焦点轮廓、prefers-reduced-motion）

**实现要点**

- **通知**：tab hidden 时 round 完成/暂停 → `document.title` 前缀与 favicon 状态点（无新依赖、无系统通知权限请求——本期不引入 Notification API，避免权限摩擦）。
- **Participant 状态条**：由 Round cursor + activeExecution + executions 表推导（不新增状态机），展示每位 Participant 本轮状态。
- **文案**：Room runState「暂停调度」（用户门）与 Round「本轮已暂停」全文统一；运行中发送用户消息前确认「将中断当前生成」。
- **接管 UI**：observing 时显示「取得控制权」主按钮（trigger controlRoom 的 takeover 路径）、takeover_failed 时给修复文案（检查 Host/刷新）、显示当前控制者 controllerId 前缀（同 controller 多 tab 场景可辨）。
- **预检 badge**：NewRoom 提交前与 RoomHeader 显示「此房间可运行」（profiles ready + agents ≥2 + facilitator 已选），把 prewarm_failed 前移。
- **搜索**：HomePage 按 topic/消息内容过滤（Dexie 扫描，千级行内可接受，无新索引）。
- **快捷键**：Cmd/Ctrl+Enter = 发送/开始新一轮（按焦点上下文）；Esc 关闭已有；快捷键表写入 README。
- **a11y**：全局焦点轮廓、reduced-motion 关闭非必要动画、状态条全键盘可达。

**测试与验证**

- e2e：接管按钮、预检 badge、暂停文案、中断确认各一条；a11y 复查（焦点轮廓/reduced-motion 静态断言）。
- 全门绿。

**完成信号**：真实使用中不再有"为什么没反应"的时刻（进度/通知/预检/文案全覆盖）。

---

## S9：全量验收与文档

**目标**：与切流同规格的验收闭环。

**主要工作**

- 测试扩充：上述各阶段新增单测/host/e2e 全部入仓并连跑两遍无 flake；typecheck/lint/vitest 全绿。
- e2e 全量：既有 17 场景 + 新增场景（focus/收敛/报告/三件套/轮转/释放/删除/复制/启停/导入导出/接管/预检）全套通过。
- 性能门复跑（fake Driver p95/重连/warm 复用不因新环节退化——重点：focus 与 report 各多一次执行后，warm spawn 计数仍=1/scope）。
- 真实冒烟矩阵（3 route + Codex 两轮）与 soak（≥15min）复跑：轮转计数可有（needs_rebase 属设计），**进程/init 口径含 focus/report 执行仍稳定**；requested/effective 一致；无 ACK 泄漏。
- 文档：README 更新（决策报告流程、快捷键、运维托管、诊断）；`docs/verification/2026-07-18-decision-core-acceptance.md`（同切流规格：环境/门/实测/归因）；CONTEXT.md 词条（S1 已定）；按需 ADR（见下「候选 ADR」）；roadmap.md 更新为实际状态。

**完成信号**：自动门 + 真实门全绿；文档可让另一位开发者复现；本计划全部阶段交付。

---

## 可机械判定的验收标准（摘要）

1. 存量 Dexie 数据经 v2 迁移后默认值正确且内容零变化（迁移测试 + e2e 旧库 fixture）。
2. 任一模式房间：focus 先于首 Participant；收敛信号或 maxRounds 触发恰好一次 report 执行；reports 表一行；Room.status=concluded；重复触发不产生第二行（唯一索引兜底）。
3. 用户追问在两轮之间可用：消息先于新 Round 首个 snapshot 落库（快照 items 含该消息）。
4. Participant 失败可重试（新 executionId + retryOf 链）或跳过（cursor+1），Round 继续；facilitator 失败无跳过入口。
5. needs_rebase 暂停一键轮转：旧 scope closed、新 scope prewarm=1/participant、轮转条目入时间线、旧正文保留。
6. Settings 连续打开 5 次 handshake 计数=0 增量（缓存窗口内）；refresh=1 强制 +1；Profile 编辑后下次请求强制 +1。
7. idle TTL 到点无 warm 进程残留；释放运行时后下一轮 prewarm 重新计数=+1。
8. 诊断包通过敏感字段扫描（无 prompt/正文/token/Cookie/env）；launchd 崩溃拉起人工确认。
9. 房间级联删除后九表相关行=0 且 legacy 读取=0；Agent 启停/导入导出/复制语义如文。
10. e2e 全场景（旧 17 + 新增）通过；性能门 p95<50ms、重连<1s；冒烟 3/3、soak ≥15min 无泄漏。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 报告质量不达预期（只是 Summary 拼接） | 决策内核价值落空 | 模式化 report instruction + targetOutput 注入；报告章节模板强约束；人工评审首版报告再调模板 |
| v2/v3 迁移破坏存量数据 | 用户已验收房间丢失 | 迁移纯函数单测 + e2e 旧库 fixture + 迁移前自动备份提示（导出 Dexie JSON 的运维说明，不自动执行） |
| focus/report 增加执行次数 | 轮次时长与成本上升 | focus 为轻量短输出（模板限长）；warm spawn 不变；用量可视化同步给出成本对照 |
| 探针缓存导致状态滞后 | 用户按旧状态误操作 | 60s 短窗 + cachedAt 时间戳 + 手动刷新 + 编辑即失效 |
| idle TTL 误杀长讨论 | 冷启动惩罚 | 30min 级保守 TTL + RoomHeader warm 状态可见 + 冷建路径已验收 |
| 跳过 Participant 破坏讨论完整性 | 摘要语义缺失一角 | 跳过记入结构化失败记录并进入 Summary 快照（facilitator 知道谁缺席） |
| 轮转对用户不可见 | 不信任 | 轮转时间线条目 + 面板明示，不静默 |
| launchd 平台差异 | 非 macOS 不可用 | 本期仅 macOS launchd；其他平台 README 保持前台运行 |

## 候选 ADR（grill 后按需落）

1. Decision Report 作为新的一等持久化产出物（而非 Summary 的衍生视图）。
2. 讨论模式仅由 instruction 模板承载（不引入编排分支）。
3. 收敛判定采用" facilitator 建议或 maxRounds"的机械规则（不做质量评分）。
4. 探针结果 Host 内存短缓存（换取 Settings 可用性，放弃实时性）。
5. needs_rebase 轮转可见化（时间线一等记录而非静默恢复）。

## 文档交付

- 本计划 + 阶段验收记录（`docs/verification/2026-07-18-decision-core-acceptance.md`）
- CONTEXT.md 词条更新（S1）
- README 更新（S6/S8/S9）
- roadmap.md 现状更新（S9）
- 候选 ADR 按需（S9 前逐条 grill 确认）
