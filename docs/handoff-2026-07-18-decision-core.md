# CouncilKit 决策内核与可靠性体验 — 实施交接文档

日期：2026-07-18（计划定稿日）
工作目录：`/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit`
权威计划：`docs/plans/2026-07-18-001-feat-decision-core-and-reliability-plan.md`（**已定稿**，grill-with-docs 敲定）
方向依据：`docs/brainstorms/2026-07-18-next-iteration-directions.md`
基线验证：`docs/verification/runtime-host-v1-cutover.md`（V1 切流全部验收通过，含真人验收）

## 一句话状态

**V1 切流（U1–U7）已全部交付并验收；下一阶段实施计划 S1–S9 已定稿、关键决策已落 ADR/glossary，一行实现代码未写。**

- git：`9065678`（清理 host 误提交文件）。工作区干净，无未提交内容。
- 基线：vitest **321/321**、e2e **17/17**、typecheck（三程序）/lint/build 全绿；真实冒烟矩阵 3/3、soak（72 轮/15.1min/31 轮转）通过。

## 规则（延续 + 新增，勿违）

- 提交节奏：上阶段用户授权了 stage 级自动 commit；新 session 开始前**先与用户确认**沿用此节奏，否则回到"先问再提"。
- `pnpm typecheck`（三程序：app tsconfig、tsconfig.host.json、tsconfig.integration.json）、`pnpm lint`、`pnpm test` 全绿才算完；e2e/真实冒烟**不得与 vitest 并发**（43127 端口 + pgrep 断言互斥）。
- 新模型产出（focus/report）**必须走既有幂等提交管线**（ModelExecution 全局锚点 + persist→ACK），禁止裸 `db.*.add`。
- 不削弱任何已验收机制：stall/discard 语义、Web Lock + leaseEpoch fencing、SafeMarkdown 约束、legacy 数据零读取。
- 报告/导出/日志/诊断不记录 prompt 正文、token、Cookie、模型正文。
- CONTEXT.md 只放 glossary（无实现细节）；够三条（难逆转/无背景会困惑/真实权衡）才写 ADR。

## 已定稿决策（Q1–Q10，不要重新翻案）

- **范围**（Q1）：S1–S9 全做；D9 Host 运维只做最小版（launchd plist + 诊断导出，无自动更新/托盘）；D10 多标签只做 UI 子集（显式接管按钮/修复指引/控制者标识），**协议级 lease 心跳续约另行立项**。
- **状态词法**（Q2，ADR-0008）：双轴 `Room.runState`（用户门，UI「已暂停调度」）+ `Round.phase`（「本轮已暂停」）；新增 `Room.status: open|concluded`；`concluding` 是瞬态不落库；**不采用** product.md 六态单轴。
- **Report 实体**（Q3，ADR-0009）：新 `reports` 表，`&sourceExecutionId` 唯一；concluded Room 拒绝 startRound（硬锁定），继续讨论走「复制房间」逃生口。
- **focus 事务**（Q4a）：专用 begin/commit 变体——participantId 必须是 facilitator、**不推进 cursor**、写 `round.focusMessageId`、revision 照常 +1；每轮必有，三模式同事务。
- **模式承载**（Q4b，ADR-0010）：三模式**仅 instruction 模板族**，编排零分支；product.md 的盲评有意推迟（共享上下文锚定风险已记录）。
- **收敛信号**（Q5）：summary 末行文本 `收敛建议：是|否`，解析失败=否；收敛 = (建议=是 && ≥1 轮) || 达 maxRounds。
- **retry/skip**（Q6）：自动重试仍严格 once；**用户手动重试不限次数**（UI 计数）；skip 仅限非 facilitator，记入失败记录并进 Summary 快照。
- **探针缓存**（Q7）：readiness（profileDigest+modelId）与 catalog（driverId+installationId+route）各 60s；失败退避 2/10/30s；Profile 编辑/revalidate 即失效；`refresh=1` 绕过；响应带 `cachedAt`。
- **idle TTL**（Q8）：最后执行结束后 30min（HostConfig `idleScopeTtlMs` 可配），复用 creating TTL 的 timer 模式。
- **轮转**（Q9）：`rotateScope` 一键手动触发（abort→closeScope→startRound），**不做自动轮转**；时间线留结构化轮转条目。
- **诊断包**（Q10）：保留 realpath（本机自诊需要，文档注明）；绝不含 prompt/正文/token/Cookie/env。

## 待办（按计划 S1–S9，每阶段给入口提示）

### S1 数据模型与迁移（先做）

- `src/models/discussion/entities.ts`：Room 增 `mode`（brainstorm|planning|review，默认 brainstorm）、`targetOutput`（""）、`maxRounds`（null）、`status`（open|concluded）；新增 `DecisionReport` 类型；`ResultKind` 增 `"focus"|"report"`（`committedEntityType` 对应 `"message"|"summary"|"report"`）。
- `src/lib/runtime-db.ts`：`version(2).stores({ reports: "id, roomId, &sourceExecutionId, createdAt", ...}).upgrade(tx => 存量 rooms 填默认值)`；迁移纯函数单测（fake-indexeddb v1 数据 → v2 → 默认值正确 + 内容零变化，模式照抄 `tests/unit/domain-models.test.ts`）。
- CONTEXT.md 词条已备（本 commit e2fda0f），S1 只需引用。

### S2 模式与收敛编排

- `src/lib/discussion-transactions.ts`：focus 需要 begin/commit 变体（现有 beginExecution/commitModelMessage 的 cursor 校验对 focus 会误伤——新增 `beginFocusExecution`/`commitFocusMessage`，写 `round.focusMessageId`，不推进 cursor；`commitReport` 落 reports 表并同事务置 Room.status=concluded）。
- `src/orchestrator/discussion-orchestrator.ts`：startRound 在 prewarm 门之后、runLoop 之前插 focus dispatch；commitSummary 后解析末行收敛标记 → concluding → report execution；`concludeRoom`（手动路径同链）；`startRoundWithUserMessage`（建 Round → appendUserMessage → prewarm/runLoop）；concluded 拒绝 startRound。
- instruction 模板族集中一处（context-snapshot 模块或新文件），按 mode 分支文案。
- 测试基建照抄 `tests/unit/discussion-orchestrator.test.ts` 的 fake Host/seed。

### S3 失败恢复与轮转

- transactions：`skipParticipant`（cursor+1 + 结构化记录，禁 facilitator）；`retryParticipant`（同 cursor 新 executionId + retryOfExecutionId）。
- orchestrator：`rotateScope`（abortPausedRound → client.closeScope → markBindingClosed 经 ensureScope 收敛 → startRound）——ensureScope 的 closed-status 冷重建**已在 f4ae766 修好**，直接复用。
- `PausedPanel.tsx` 按 pauseReason.code 分流（needs_rebase→轮转主行动；其余→三件套；facilitator→修复+终止）；轮转条目进时间线（bindings 历史 + rounds 失败记录，不新造表）。

### S4 报告视图与导出

- `ReportView.tsx`：SafeMarkdown 渲染（**必须复用** `src/components/markdown/SafeMarkdown.tsx`）+ 复制 + Blob 下载；九段结构（product.md §5.5）。
- RoomPage 三态（讨论中 / concluding 报告生成中 / concluded 只读+报告卡）；RoomHeader/ListItem 徽章。

### S5 探针与 Scope 治理

- `runtime-host/profiles/probe.ts`：加内存 Map 缓存（键与失效规则见 Q7）；`runtime-host/routes/*` 透传 `refresh=1`。
- `runtime-host/scopes/scope-manager.ts`：idle TTL（deps 注入 `idleScopeTtlMs` + 可选 `now`，照 `creatingScopeTtlMs` 模式；`runtime-host/config.ts` 加配置）。
- orchestrator `releaseRuntime(roomId)`（无活动执行才可）+ RoomHeader warm 指示/释放按钮/配额提示。
- 测试：`tests/host/profile-readiness.test.ts`、`model-catalog.test.ts` 加缓存用例；TTL 用假时钟。

### S6 运维面

- `runtime-host/routes/diagnostics.ts`（GET /api/v1/diagnostics，session，强 sanitize；测试扫敏感字段）+ main.ts 注册 + Settings 下载按钮。
- `scripts/install-service.mjs` / `uninstall-service.mjs`（写 `~/Library/LaunchAgents/com.councilkit.host.plist`，KeepAlive，不自动 load）+ README 托管章节。人工验证，不进自动门。

### S7 房间/Agent 资产 + 用量

- `src/lib/room-admin.ts`：deleteRoomCascade（九表相关行 + warm scope 关闭 + 二次确认；**legacy 探针须保持零读取**）、duplicateRoom（按 agent 重 join、profileDigest 现算、不复制消息）、rename（复用 updateRoomSharedConfig）。
- Agent：`enabled` 字段（并入 S1 的 v2 迁移，别单开 v3）、Duplicate、JSON 导入导出（schema 校验 + 未知 profile 标"待绑定"）、测试调用 = readiness handshake（不烧模型）。
- `UsageBadge`：聚合 `modelExecutions.usage`（Room 累计 + 每轮行 + 列表排序选项），纯展示。

### S8 体验打磨

- 通知：tab hidden 时 `document.title` 前缀 + favicon 状态点（**不引入** Notification API）。
- Participant 状态条（由 cursor + activeExecution + executions 推导，不新增状态机）。
- 接管按钮走 `controlRoom` takeover 路径；预检 badge（profiles ready + agents≥2 + facilitator）；搜索用 Dexie 扫描即可；Cmd/Ctrl+Enter 快捷键；两种"暂停"文案按 Q2 词法全面替换。

### S9 全量验收

- 全门 + e2e 新增场景（focus/收敛/报告/三件套/轮转/释放/删除/复制/启停/导入导出/接管/预检）连跑两遍；perf 门复跑（focus/report 各多一次执行后 warm spawn 仍=1/scope）；真实矩阵 3/3 + soak 复跑；写 `docs/verification/2026-07-18-decision-core-acceptance.md`；更新 README/roadmap。

## 关键命令

```sh
pnpm test / pnpm typecheck / pnpm lint / pnpm build
pnpm vitest run <files>
pnpm exec biome check --write <files>
# Playwright（串行锁，防并发抢 43127）：
mkdir /tmp/councilkit-e2e.lock && pnpm exec playwright test; rmdir /tmp/councilkit-e2e.lock
# 真实冒烟（绝不与 vitest 并发）：
TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx tests/smoke/live-runtime-smoke.ts [--route all|--soak] [--out f.json] [--dry-run]
```

## 环境事实（live 验证过，勿重探）

- Node v22.17.0、macOS arm64；受信安装 `cld-178240c6225e`、`codex-fdd3ce2d94ea`。
- canonical 模型现状：ant→`GLM-5.2[1m]`、moonshot→**`Kimi-K3[1m]`**（2026-07-18 provider 漂移后定修，旧 K2.5 已无）、deepseek→`deepseek-v4-pro[1m]`、codex→`gpt-5.6-sol`（contextWindow 258400）。
- codex 每 turn input 恒 ~20k → soak 中 needs_rebase 轮转是**设计内常态**（每 ~3 轮一次）；claude 路由窗口已声明 1M。
- **跨域测试文件**（同时 import `@/`+`@host/`）进 `tsconfig.integration.json` 的 include + `tsconfig.host.json` 的 exclude（先例：discussion-runtime.test.ts、live-runtime-smoke.ts）。
- e2e host-entry 已在 reset 时拨快 `now()` 规避 scope create 10/min 配额——新增测试房间多时不要撤销这个机制。
- Playwright 浏览器若需重装：`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright pnpm exec playwright install chromium`（官方源在本机不可达）。
- biome 已覆盖 tests/e2e（ignore 已解除），新文件直接过 `pnpm lint`。
- 教训：对共享 IndexedDB 的双页测试必须用**同一 browser context 开两个 page**（独立 context 有独立 Web Lock 管理器，测不出 fencing）。
- `.kimi-code/` 是宿主生成物，已 gitignore；`git add -A` 前留意同类杂物。
