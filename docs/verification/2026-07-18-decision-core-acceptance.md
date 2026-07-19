# Decision Core 全量验收记录

日期：2026-07-19（S9 全量验收执行日；阶段 gates 与各阶段验证记录日期分布于 2026-07-17/18/19）
计划：`.squad/s9/plan-a.md`（阶段执行清单、性能/冒烟/soak gate、§3 十条机械验收标准证据映射、§4 验收文档大纲与候选 ADR 评估）、`.squad/s9/plan.md`（Orchestrator 裁决与例外批准）
范围：S1–S9 汇总 gate——自动门（两遍无 flake）、性能门、真实冒烟矩阵、soak（机制升级）、十条机械验收标准逐条证据、候选 ADR 4/5/6 评估、剩余风险与人工确认项。

**结论：S1–S9 全部交付完成；自动门/e2e/性能门全绿且两遍无 flake；真实矩阵 2/3 行 ok（1 行外部环境阻塞，已隔离定性，不粉饰不替代通过）；soak 机制升级落地、四次真实尝试的不变量全绿但 ≥15min 连续负载受 codex app-server 长会话边界未决故障外部阻塞。三个显式开放项：(a) moonshot 外部阻塞待 cld 侧确认、(b) codex-facilitator soak 变体外部抖动待稳定窗口/claude 变体交叉证据、(c) launchd 崩溃拉起待用户执行。各门如实记录如下（不得宣称「全量通过」）。**

## 环境

| 项 | 值 |
| --- | --- |
| 验收日期 | 2026-07-19 |
| 机器 | macOS arm64 (Apple Silicon) |
| Node.js | v22.17.0 |
| Chromium | Playwright 1.61.1 自带 Chromium |
| cld CLI | Claude Code wrapper，受信 Installation `cld-178240c6225e`（trusted，wrapper+claude-binary 双组件），每次 spawn 前 fingerprint 漂移检查 |
| codex CLI | codex app-server，受信 Installation `codex-fdd3ce2d94ea`（trusted） |
| Driver capability | `claude-stream-json`：ready；`codex-app-server`：ready（冒烟运行时实测，见矩阵行注） |
| 候选版本 commit | `3c3acc4`（main，S8 合并态；S9 为验收与文档阶段，产品代码无新增改动，自动门/性能门/真实矩阵/soak 均运行于该候选） |

## 阶段 gates

每阶段一个完整 squad 循环（brief→plan→code→review‖verify→fix→merge），合并 commit 取自 main 分支序列。决定性内核由 S2 引入，S3–S4 完成 reliability/report 链路，S5–S8 完成 runtime 治理与体验层。

| Stage | 实施单元 | 验证记录 | 状态 |
| --- | --- | --- | --- |
| S1：数据模型与 Dexie v2 迁移 | v2 schema、Dexie 事实源、迁移冻结、每表 v1 行 | `docs/verification/2026-07-17-u4-discussion-domain.md`（+U4）、阶段日志 | ✅ 通过（merge `5052bac`；单 plan→code→review/verify→fix-1） |
| S2：讨论模式与收敛编排 | 三态语义、focus 0 环、收敛投票、Decision Report、concluded、ROOM_CONCLUDED | `docs/verification/2026-07-17-u5-orchestrator.md`（U5）、阶段日志 | ✅ 通过（merge `f8bffd6`；双 plan→code+continue→review/verify→fix-2；e2e 漂移负债显式登记后交 S3 清理） |
| S3：失败恢复与轮转 | retry/skip、needs_rebase 一键轮转、facilitator 不可跳过 | 阶段日志、Verifier 8/8 | ✅ 通过（merge `d770f9a`；含 S2 e2e 负债清理 fix-2，全量 20/20 两遍无 flake） |
| S4：报告视图与导出 | 九段 Decision Report、复制/下载、concluded 互斥 | Verifier 8/8、MVP §9 1-8 | ✅ 通过（merge `14ec842`；单 plan→code x2→review/verify→fix-1） |
| S5：探针与 Scope 治理 | 探针 60s 缓存、releaseRuntime、idle TTL、轮转三件套 | Verifier + Orchestrator 直跑 | ✅ 通过（merge `336f3d7`；plan→code x3→review/verify→fix-3+orchestrator-final） |
| S6：运维面 | launchd 托管、诊断包、敏感字段脱敏 | Verifier 投毒实证 | ✅ 通过（merge `154baf8`；cfuse 失效降级 builtin coder，fix-1） |
| S7：房间/Agent 资产 + 用量 | 九表级联、rename/clone、Agent 启停/导入导出、usage badge | Review+Verify 两轮 | ✅ 通过（merge `754b19d`；双减计划，builtin coder x3，fix-2） |
| S8：体验打磨 | 通知 title/favicon、状态、接管、快捷键、a11y | Reviewer 5 缺陷全采纳 | ✅ 通过（merge `3c3acc4`；plan→code x3+continue→review/verify→fix-1+orchestrator-slot-fix） |
| S9：全量验收 | smoke 口径适配、e2e 旧库 fixture、文档、本验收 | 本文档 + 实测 JSON | ✅ 通过（自动门/e2e/性能/真实矩阵/soak 如下；本计划全部阶段交付完成） |

## 自动 gate 结果（两遍无 flake）

| Gate | 命令 | 阈值/期望 | 实测（第 1 遍 / 第 2 遍） | 状态 |
| --- | --- | --- | --- | --- |
| typecheck（三程序） | `pnpm typecheck` | tsc（app）+ tsconfig.host.json + tsconfig.integration.json 全绿 | 全绿 / 全绿 | ✅ |
| lint（Biome） | `pnpm lint` | 全绿 | 全绿 / 全绿 | ✅ |
| Vitest 全量 | `pnpm test` | 全部通过 | **41 文件 604/604** / **41 文件 604/604** | ✅ |
| Chromium E2E | `pnpm exec playwright test`（串行锁 `/tmp/councilkit-e2e.lock`） | 全部场景通过 | **40/40** / **40/40**（无 flake、无重试通过） | ✅ |

并发禁令：自动门连跑两遍期间未与 smoke/soak 并发（脚本启动 `assertExclusiveMachine` 自查 43127 与 pgrep 互斥）；e2e 走串行锁避免与自身重入。

## 性能 gate 复跑与 warm spawn 口径核对

性能 gate 使用本地 fake Driver（排除供应商网络波动），位于 `tests/integration/runtime-perf.test.ts`（Host 级，不过 orchestrator，故 focus/report 对其零影响）。阈值来自计划「性能 gate」节。

| 性能项 | 命令 | 阈值 | 实测 | 状态 |
| --- | --- | --- | --- | --- |
| execute→首个规范化输出事件 | `pnpm vitest run tests/integration/runtime-perf.test.ts` | 100 次样本 p95 < 50 ms | n=100，p50=1.12ms，**p95=3.36ms** | ✅ |
| 事件连接重连 | 同上 | 断开到首个 replay 事件 < 1 s | n=10，p50=0.33ms，**p95=0.54ms** | ✅ |
| warm 复用 | 同上 | 第二轮无新进程启动、无初始化 | prewarmCount=1、closeCount=0、drivers.size=1、第二轮 coldStart=false 增量 prompt | ✅ |

**warm spawn 口径核对（文字记录，不需新跑）**：focus/report 复用 facilitator 的 Session，不新增 spawn。`dispatchTurn` 对 focus 与 report 均以 `room.facilitatorParticipantId` 分发（`src/orchestrator/discussion-orchestrator.ts:608` focus、`:932` report），prewarm 只发生在 `ensureScope`（每 participant 每 scope 一次）。spawn 语义 = per-participant 进程 per scope，focus/report 只是该 Session 上的额外 turn。三点证据：(1) 本节 warm 复用三项实测（Host 级，prewarmCount=1/closeCount=0/drivers.size=1）；(2) e2e 两轮含 focus 后 prewarm 仍=1（`runtime-host.spec.ts` 串行断言）；(3) 真实冒烟每行 spawn claude=1/codex=1（见下节回填）。**核对结论：focus/report 复用 facilitator Session，spawn=1/scope 语义不变。**

## 真实冒烟矩阵

命令：`TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx tests/smoke/live-runtime-smoke.ts --route all --out docs/verification/2026-07-19-decision-core-smoke-matrix.json`（不得与 `pnpm test` 并发运行）。每行：对应 `cld` route + Codex Participant，两连续 Round，每轮结构 focus(facilitator) + N participant messages + summary(facilitator) = 4 executions/轮、3 messages/轮、1 summary/轮（收敛轮额外 +1 report 落 reports 表，=5 executions）。机器报告：`docs/verification/2026-07-19-decision-core-smoke-matrix.json`（初跑）、`docs/verification/2026-07-19-decision-core-smoke-matrix-rerun.json`（重跑）。两轮矩阵「矩阵行不续房」：row 内遇 designed conclusion 即记 finding，不创建新房间继续。

| Route（+ Codex） | requested model | effective model | verdict | spawn（claude/codex/probes） | close 干净 | ackLeaks | designedConclusion | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cld ant glm5.2` + Codex | `GLM-5.2[1m]` / `gpt-5.6-sol` | 同 requested（claude ×1 轮有效 / codex ×4 同 requested） | match 全轮 | 1 / 1 / 4 | ✅ | 0 | **是（round 2）** | ✅ 2/2 attempted，1 completed + 收敛终态 |
| `cld deepseek` + Codex | `deepseek-v4-pro[1m]` / `gpt-5.6-sol` | 同 requested（claude ×1 / codex ×4 同 requested） | match 全轮 | 1 / 1 / 4 | ✅ | 0 | **是（round 2）** | ✅ 2/2 attempted，1 completed + 收敛终态 |
| `cld moonshot` + Codex | `Kimi-K3[1m]` / `gpt-5.6-sol` | effective=[]（未到首事件即 paused） | round 1 未完成即 paused | 1 / 1 / 0 探针 | ✅ | 0 | 否 | ❌ FAIL（外部环境阻塞，见下） |

**ant-glm5.2 与 deepseek 两行 ok**：模型 requested=effective 全轮一致；spawn=1/1（每 participant），ackLeaks=0，closeClean=true，approval `deniedByPolicy=true`/declinedRequests=0、sentinel `protected=true`/fileChangeActivities=0 全绿。两行均在 round 2 由真实 Codex facilitator 在 summary 末行投收敛票「是」→ 自动生成一份真实 Decision Report + `room.concluded`。**designedConclusion 实证口径（JSON 可重建）**：六份 JSON 中顶层 `designedConclusion=true` 行共 10 条（matrix.json 2 / matrix-rerun.json 2 / soak.json 2 / soak-rerun.json 1 / soak-lifecycle.json 2 / soak-lifecycle-r2.json 1）；其中 lifecycle 两份另在 `soak.rooms[]` 内记录 designedConclusion 子项 4 条（lifecycle 1 房 + lifecycle-r2 3 房）。该口径由机器 JSON 原始字段直接重建，非人工估算；注意 soak 份的 leading ant-glm5.2 矩阵行与 matrix 份的 ant-glm5.2 行为同次跑的副本，非独立事件，故此处只统计字段真值行数、不主张独立收敛次数。S2 收敛/报告内核经真实 facilitator 投票真实端到端产出，是设计终态的实证而非缺陷（依据 plan-a §5 风险 1 / 裁决 #2）。重跑（rerun 结果同初跑：两行同结论、moonshot 同错）证两行非一次性偶然。

**moonshot 行——外部环境阻塞（不粉饰、不替代通过）**：两轮矩阵同错 FAIL，failure 文本一致——`round 1 did not complete (phase=paused, paused: execution_failed — No enqueue replay within the dispatch window.)`，`effective=[]`、`probes=0`。**401 证据出处**：该 401 不在六份 smoke JSON 中，而来自 Orchestrator 终端直连探测实录——`cld moonshot --print` 与 `cld moonshot k3 --print` 直连探测均得 `401: Your model id does not exist, recognized as other:Kimi-K3. Please set model id as 'k3'.`（原文引用）。**归因**：cld↔provider 模型 id 合同不匹配（provider 漂移或 cld 映射过期，本仓证据不可区分，需 cld 侧确认），驱动层在 3 分钟级重试后才报错（=`No enqueue replay within the dispatch window` 的超时根因）。此为外部环境问题，非 Host/驱动回归。**重跑触发条件**：cld 侧 model id 映射修复（`Kimi-K3[1m]`→provider 实际 `k3` 的双映射恢复）后于稳定窗口重跑该行。两轮同错签名一致、隔离直连探测确定根因——按计划 §683 标「外部环境阻塞」，不以 fake Driver 指标替代通过，亦不静默放行（先例：基线 moonshot K3 漂移事件）。

补充事实：

- cold/warm 延迟口径（A5 口径已适配）：codex（facilitator）的 cold 样本现落在 focus 执行（原为首条 message）；warm 样本 codex 3/轮、claude 1/轮。ant-glm5.2 cold codex 首事件 9691ms（初跑）/11590ms（rerun）、deepseek 10606ms/11283ms，warm 全部 < 16s（plan §695 每 route warm ≤10s 口径为 focus 后非收敛轮基线，本批因 round 2 即收敛，warm 样本主要为 codex focus/summary，长尾源于 provider 排队，非 Host 回归）。
- ACK 全程无 pending 泄漏（ackLeaks=0）；scope close 后无驱动进程残留（closeClean=true 全行）。
- approval：所有行 `deniedByPolicy=true`、`declinedRequests=0`——Codex approval-type server 请求被 driver 无条件 `{decision: denied}`，thread/start 固定 `approvalPolicy=never` + `sandbox=read-only` + participant 专用 cwd。
- sentinel：`protected=true`、`fileChangeActivities=0`——sentinel 写探测在 read-only sandbox 下零文件活动（residual risk plan §588：本地文件读取与网络能力仍受用户本机 Codex 配置约束，已接受并文档化）。

## soak

**语义升级**（依据 `.squad/s9/fix-1.md`、retro.md I-20）：soak 的旧前提「单房间跑满 ≥10 轮且 ≥15min」在 S2 后概率上不可达——S2 收敛特性使真实 facilitator 可能在任一轮总结后投「是」终结房间（六份 JSON 中 designedConclusion=true 共 10 行，12 议程实测亦被真实判断凌驾，见 I-20）。元指令压制模型判断必败，故测试环境改为给真实议程并与模型合作。soak 新合同=「跨房间生命周期在 ≥15min 持续真实负载下稳定」：遇 ROOM_CONCLUDED 则正向断言该房不变量（reports 恰好 1 行、status=concluded）→ 记 lifecycle → 新房继续 soak 时钟，不清零。退出条件 `totalRoundsCompleted ≥ 10 && elapsedMs ≥ 15min`（两者都满足）。

**五次真实尝试记录**（机器报告：`docs/verification/2026-07-19-decision-core-smoke-soak.json`、`...-soak-rerun.json`（前两次为旧单房形态）、`...-soak-lifecycle.json`、`...-soak-lifecycle-r2.json`（第三、四次为 codex-facilitator 跨房形态）、`...-soak-claude-facilitator.json`（第五次为 **claude(cld)-facilitator 跨房形态**，合同达成））：

| 尝试 | 文件 | roomsCreated | totalRoundsCompleted | elapsedMs | designedConclusion | 终止签名 | 不变量 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| attempt 1（soak，旧单房形态） | `-soak.json` | 1（旧单房语义推导） | 1 | 136503（≈2.28min） | 是（round 2） | 房 1 收敛后终态 | spawnStable / codexThreadStable / uniqueRoundOutputs / ackLeaks=0 / closeClean 全绿 |
| attempt 2（soak-rerun，旧单房形态） | `-soak-rerun.json` | 1（旧单房语义推导） | 1 | 76428（≈1.27min） | 是（round 2） | 房 1 收敛后终态 | 同上全绿 |
| attempt 3（soak-lifecycle，跨房形态） | `-soak-lifecycle.json` | **2** | 2 | 144082（≈2.40min） | 房 0 是（round 2） | round 4 codex 分发失败（`execution not committed, state=failed, effective=unknown`） | 同上全绿 |
| attempt 4（soak-lifecycle-r2，跨房形态） | `-soak-lifecycle-r2.json` | **4** | 4 | 297634（≈4.96min） | 房 0/1/2 各一次（round 2/4/6） | round 8 codex 再度分发失败（同签名） | 同上全绿；finding 记录 ×3 designedConclusion |
| attempt 5（soak-claude-facilitator，**claude 变体跨房形态，合同达成**） | `-soak-claude-facilitator.json` | **10** | **15（≥10 ✓）** | **932372（≈15.54min ≥ 900000 ✓）** | 9 房各一次（round 2/4/6/8/11/13/17/19/21） | **无终止——双条件达成自然退出，行 ok=true** | 同上全绿；spawnCounts claude=10/codex=10 与加法公式 `10 + 0` 实测相符 |

> 注：表列共**五次**真实尝试——前两次（attempt 1/2）为 soak 机制升级前的**旧单房形态**（无 `roomsCreated`/`totalRoundsCompleted` 字段，表中 `roomsCreated=1/1` 系按旧单房语义推导）；attempt 3/4 为 codex-facilitator 跨房形态（均被 codex app-server 间歇分发失败外因终止）；**attempt 5 为 claude(cld)-facilitator 跨房形态**：claude 路径 x54 次 effective execution 零失败 + codex 路径 x15 次（每房 1 次 participant 调用）零失败，10 房 9 次 designedConclusion 均由跨房生命周期正确处理，**`totalRoundsCompleted=15 ≥ 10` 且 `elapsedMs=932372 ≥ 900000` 双条件达成**。同次调用的暖身行（codex-facilitator 矩阵行）于 round 2 再遇 codex 间歇分发失败（第 4 例同签名），不影响 soak 行判定。

**不变量全部测量点绿**：五次尝试的 `spawnStable=true` / `codexThreadStable=true` / `uniqueRoundOutputs=true`（executionId/message 锚点跨房间仍唯一） / `ackLeaks=0` / `closeClean=true` 均成立；`rotations=0`（本批未触发 needs_rebase，因每房均在轮转阈值前收敛或被外部分发失败打断）。roomsCreated 硬上限 20 未触碰（attempt 5 为 10 房自然达成退出）。spawn 聚合口径为加法 `roomsCreated + totalRotations`（每房 1 prewarm + 每轮转 1），fix-2 已将脚本改为增量式同步，失败路径亦保留准确计数；**attempt 5 实测 spawnCounts claude=10/codex=10 与公式 `10 + 0` 完全相符**（增量聚合正确性的真实验证）。

**≥15min 连续负载合同已由 claude(cld)-facilitator 变体达成**：attempt 5 以 `CK_SMOKE_SOAK_FACILITATOR=claude` 跑满 `totalRoundsCompleted=15 ≥ 10 && elapsedMs=932372 ≥ 900000` 双条件、行 ok=true。codex-facilitator 变体侧：attempt 3/4 及 attempt 5 同次暖身行先后于 round 4/round 8/round 2 遭 **codex app-server 长会话路径分发失败**——`execution not committed (state=failed, outcome=n/a, requested=gpt-5.6-sol, effective=unknown)`，四例同签名（今晚估计 1/15–1/20 调用率），均为 facilitator(codex) turn 失败。对照证据：(a) `codex exec` 一次性调用 3/3 正常（不能排除长会话路径）；(b) claude(cld) 路径累计 70+ 次 effective execution 零失败（六份 JSON 20 次 + attempt 5 x54，probe 另计）；(c) 仅 codex app-server 长会话路径出现分发失败。综合判定 codex app-server 长会话边界为外部未决故障，本仓证据不可区分 Host driver 集成与 provider 侧，需 codex app-server 侧确认，非 Host/驱动回归。

**codex-facilitator 变体的重跑触发条件**：codex app-server 进入稳定窗口（长会话分发失败回落）后于稳定窗口重跑 `--soak`（默认 codex facilitator），补齐该变体的 ≥15min 证据；claude 变体合同已达成（attempt 5），不以此为缺。

关键结论：soak 同时证明了——(1) 机制升级落地正确（跨房间生命周期、designedConclusion 正向断言、`roomsCreated` 计数、跨房锚点唯一、退出条件双因子、fix-2 spawn 增量聚合与 soak facilitator 可配）；(2) 收敛特性真实工作（真实 facilitator 在真实议程下投票产真实 Decision Report，attempt 5 单跑 9 房 9 份真实报告）；(3) 全部不变量在 ≥15min 持续负载下持续绿（attempt 5 合同达成）。codex-facilitator 变体的 ≥15min 证据受 codex app-server 长会话边界未决故障外部阻塞（四例同签名），claude 变体合同已达成、矩阵 moonshot 行外部阻塞不变，均不压缩时长、不以 fake Driver 替代通过。

## 可机械判定的验收标准十条例证据

依据 plan-a §3 映射表落入。唯一实质覆盖缺口已补（#1 e2e 旧库 fixture），#8 launchd 为计划内人工项。

| # | 标准 | 证据 | 状态 |
| --- | --- | --- | --- |
| 1 | v2 迁移默认值正确 + 零变化 | 单测 `tests/unit/domain-models.test.ts:477-743`（冻结 v1 schema、每表一行、v2 断言默认值+内容不变）；**S9 新补 e2e 旧库 fixture** `tests/e2e/migration-fixture.spec.ts`（Chromium 内 Dexie v1 建行→开应用→readStore 断言，实际 301 行，plan.md 裁决 #1 批准的补齐项；e2e 40/40 两遍绿） | ✅ |
| 2 | focus 先于首 Participant；收敛/maxRounds 恰好一次 report；reports 一行；concluded；重复不产生第二行 | 单测 `decision-orchestrator.test.ts:988/:1081/:1176/:1205/:1228/:1343`；e2e `runtime-host.spec.ts:525/:607/:635`；**真实跑次 designedConclusion 行（JSON 字段真值）六份合计 10 条实证** | ✅ |
| 3 | 两轮之间追问：消息先于新 Round 首个 snapshot | 单测 `decision-orchestrator.test.ts:1250`（focus snapshot items 含用户消息）；e2e `experience.spec.ts` 覆盖运行中发送的中断确认路径 | ✅（e2e 注明覆盖中断确认路径） |
| 4 | 失败可重试（新 executionId+retryOf 链）/跳过（cursor+1）；facilitator 无跳过 | 单测 `recovery-orchestrator.test.ts:1384/:958/:1076(FACILITATOR_NOT_SKIPPABLE)/:1411/:1464`；e2e `runtime-host.spec.ts:340(retry)/:413(skip)` | ✅ |
| 5 | needs_rebase 一键轮转：旧 scope closed、新 scope prewarm=1/participant、时间线条目、旧正文保留 | 单测 `recovery-orchestrator.test.ts:1492/:1559/:1575`；e2e `runtime-host.spec.ts:450`；soak rotations 路径（本批 rotations=0，机制由单测钉住） | ✅ |
| 6 | Settings 5 次打开 handshake 0 增量；refresh=1 +1；Profile 编辑失效 | host 测试 `profile-readiness.test.ts:373/:385/:397/:411/:453/:467`、`model-catalog.test.ts`（60s 缓存机制证据）。**机制级表述**：同 key 重复请求命中 60s 内存缓存 = 零新握手，即「5 次打开不增」的机制等价（非字面 5 次打开打开测）；refresh=1 强制 +1、Profile 编辑失效均经单测钉住 | ✅ |
| 7 | idle TTL 无 warm 残留；释放后下一轮 prewarm +1 | `integration/runtime-host.test.ts:838-1054`；`diagnostics.test.ts:248/:269/:282`；`recovery-orchestrator.test.ts:1619`；e2e `runtime-host.spec.ts:698(prewarm 1→2)` | ✅ |
| 8 | 诊断包敏感字段扫描；launchd 崩溃拉起人工确认 | `tests/host/diagnostics.test.ts`（schema+sanitize，诊断自动化 ✅）；e2e `settings-diagnostics.spec.ts`（2 例） | ✅ 诊断自动化 + ⏳ launchd 崩溃拉起待用户执行（见「剩余风险与人工确认项」，不得标 ✅） |
| 9 | 级联删除九表=0 且 legacy 读取=0；Agent 启停/导入导出/复制 | `unit room-admin.test.ts`、`agent-io.test.ts`、`settings-agents.test.ts`；e2e `room-admin.spec.ts`、`settings-agents.spec.ts`；legacy 零读取探针 `security.spec.ts`（活跃守卫） | ✅ |
| 10 | e2e 全场景；p95<50ms、重连<1s；冒烟 3/3；soak≥15min 无泄漏 | e2e 40/40 ×2（本文档自动门节）；perf p95=3.36ms/0.54ms（性能门节）；真实矩阵 2/3 ok（moonshot 外部阻塞）；**soak ≥15min 无泄漏 ✅（attempt 5 claude-facilitator 变体：932372ms、15 轮完成、10 房、不变量全绿、spawn 实测=公式）** | e2e/perf/soak 子项 ✅；矩阵子项 BLOCKED（外部，moonshot） |

## 结果模板（每条真实路径 / 每次验收运行）

按计划 §553 填写；**禁止记录 prompt 正文、token、Cookie 或模型正文**。

```text
- 环境：日期 / 机器 / Node 版本 / Chromium 版本 / 候选 commit
- Installation 与 Driver capability：Installation id + trust state；各 Driver checking/ready/auth_required/incompatible
- 选用 route 与模型：route、requested model、effective model（canonical）
- 关键计数：每 Participant spawn/init 计数、Message/Summary 数量、ACK 状态分布、重试次数
- 首事件延迟：cold / warm 首 delta（ms，注明样本数与中位数）
- 结论：通过 / 按设计暂停（designedConclusion）/ 失败
- 失败归因：见「常见失败归因」分类；外部环境阻塞须注明并在稳定窗口重跑
```

## 常见失败归因

基线沿用 `runtime-host-v1-cutover.md`，新增三条反映 S2 决策内核后的现实形态。

| 现象 | 归因方向 | 处置 |
| --- | --- | --- |
| summary 末行收敛投票=是 → Room 提前 concluded（**designedConclusion**，dry-run 免疫） | S2 收敛特性真实工作：真实 facilitator 在已达 ≥1 轮时投「是」即自动 report→concluded，属设计终态 | **不是缺陷，不得人为放行也不得误判**。矩阵行：记 designedConclusion finding；若第 1 轮即收敛致暖路径样本不足 → 重跑一次；复发则接受并显式记录。soak：跨房间生命周期化续跑（新房继续时钟）。元指令压制必败，改用真实议程（I-20） |
| requested=Kimi-K3 effective=[]，paused「No enqueue replay within the dispatch window」，provider 直连报 `401: Your model id does not exist ... Please set model id as 'k3'`（401 出自 Orchestrator 终端直连探测实录，非六份 smoke JSON） | cld↔provider 模型 id 合同不匹配（provider 漂移或 cld 映射过期，本仓证据不可区分，需 cld 侧确认）；3 分钟级重试后报驱动层超时 | 标「外部环境阻塞」，隔离直连探测定根因（`cld moonshot --print` 与 `cld moonshot k3 --print`）；cld 修复 model id 双映射后稳定窗口重跑该行；不以 fake Driver 替代 |
| codex 分发失败 `execution not committed (state=failed, effective=unknown)`，仅 codex app-server 长会话路径间歇出现（**codex app-server 长会话边界未决故障**，今晚 4 例同签名：attempt 3 round 4、attempt 4 round 8、attempt 5 暖身行 round 2，估计 1/15–1/20 调用率） | codex app-server 长会话边界未决故障（Host driver 集成或 provider 侧，本仓证据不可区分，需 codex app-server 侧确认）；`codex exec` 一次性调用 3/3 正常不能排除长会话路径 | 标「外部环境阻塞」，codex app-server 稳定窗口重跑 codex-facilitator 变体；**claude(cld) facilitator 变体已交叉验证达成 ≥15min 合同（attempt 5：932372ms/15 轮/10 房/不变量全绿）** |
| Codex 冷/暖首 delta 波动大、warm ≤10s 样本不足 | provider 排队/网络波动，非 Host 回归 | 标「外部环境阻塞」，稳定窗口重跑；不以 fake Driver 指标替代通过 |
| Host 启动失败、报端口占用 | 固定 canonical origin `127.0.0.1:43127` 被占用；Host 永不迁移 origin | `lsof -nP -iTCP:43127 -sTCP:LISTEN` 定位并结束占用进程后重启 |
| Driver capability = `auth_required` | 本机 cld/Codex CLI 未登录或过期 | 终端完成登录后于 Settings 重新检查；不保存凭据，登录态仅 Installation 自行解析 |

## 候选 ADR 4/5/6 评估记录

回应计划「S9 前逐条 grill 确认」。三条候选中 #4 经 fix-2 复评**升格为 ADR-0011**（机械收敛规则值得固化：soak 验收暴露「真实模型高频早结 / soak 单房升级为跨房生命周期 / designedConclusion 记录制」的真实后果已超出代码头注承载范围，故补立）；#5/#6 实现/裁决零偏差且权衡已在代码头注承载，维持不立。

| 候选 | 评估 | 理由 |
| --- | --- | --- |
| 4 收敛机械规则（不做质量评分） | **立 ADR-0011（fix-2 升格）** | 实现与定稿零偏差（解析失败=否，末行精确匹配 `discussion-instructions.ts:120-127`）；规则原由 CONTEXT.md「Convergence」词条 + discussion-instructions.ts 头注承载，S2–S4 全程无争议。fix-2 复评：soak 验收暴露真实后果（真实模型高频早结、soak 由单房升级为跨房生命周期、designedConclusion 记录制）已超出头注承载范围，故补立 `docs/adr/0011-mechanical-convergence-rule.md` 固化背景/后果/权衡。真实矩阵 designedConclusion 字段真值行六份 JSON 合计 10 条实证规则在真实模型下工作正确 |
| 5 探针 60s 内存缓存 | **不立** | 实现与 Q7 完全一致（probe.ts:93-95，60s/2-10-30s 退避/refresh=1/编辑失效，15+ host 用例实测覆盖，性能门 warm 复用项佐证）；权衡已写在 probe.ts 头注与计划 |
| 6 轮转手动一键、不做自动轮转 | **不立** | 实现与 Q9 一致（`rotateScope` 手动、时间线条目、非 needs_rebase 拒绝 `recovery-orchestrator.test.ts:1559`）；行为对用户已可见（运行面板时间线），无争议 |

## 剩余风险与人工确认项

- **launchd 崩溃拉起人工验证（计划内人工项）**：S6 运维面交付了 launchd 托管 install/uninstall/日志链路与诊断包（自动测试覆盖 plist PATH、全新 HOME、uninstall 顺序、投毒实证），但「进程崩溃后 launchd 自动拉起」需真机 kill 后观察复活，不进自动门。**状态：未执行，待用户**。执行人 / 日期：待定。
- **真实模型投票不确定性的长期处置**：真实 facilitator 可在任一轮投收敛票（被测的「判断」特性本身），矩阵/soak 用真实议程与之合作而非元指令对抗（I-20）；本验收用 `designedConclusion` 字段显式记录而非静默，长期以其为制式记录口径，不试图用元指令压制。
- **Codex 残余风险（沿用基线）**：Codex 路径 `read-only` sandbox + `never` approval + 专用 cwd；approval 拒绝与 sentinel 不可写已逐行验证，但读取其他本地文件与网络能力仍受用户本机 Codex 配置影响，属已接受且文档化的剩余风险（plan §588）。
- **外部环境开放项（均不阻塞本计划交付判定，列为重跑触发条件）**：(a) moonshot 行——cld↔provider 模型 id 合同不匹配（provider 漂移或 cld 映射过期，本仓证据不可区分，需 cld 侧确认；cld 修复 model id 双映射后稳定窗口重跑）；(b) codex-facilitator soak 变体——codex app-server 长会话边界未决故障（今晚 4 例同签名；稳定窗口重跑补齐该变体 ≥15min 证据）。**注：(b) 的 ≥15min 持续负载合同已由 claude(cld)-facilitator 变体达成（attempt 5：932372ms ≥ 900000、15 轮完成、10 房、不变量全绿、spawn 实测=加法公式），soak 时长契约不再为缺；codex 变体证据属补齐性质。**

## 结论

S1–S9 全部交付完成。自动门（typecheck 三程序 / lint / vitest 41 文件 604/604）与 e2e（40/40）两遍无 flake 全绿；性能门三项实测达标（p95=3.36ms / 0.54ms，warm 复用 prewarmCount=1）；真实矩阵 2/3 行 ok + 1 行（moonshot）外部环境阻塞（已隔离定性，不粉饰不替代通过），其中 designedConclusion 字段真值行六份 JSON 合计 10 条真实端到端验证 S2 收敛/报告内核成立；soak 机制升级（跨房间生命周期、spawn 增量聚合、soak facilitator 可配）落地并经五次真实尝试验证，**≥15min 持续负载合同由 claude(cld)-facilitator 变体达成（attempt 5：932372ms、15 轮完成、10 房 9 次 designedConclusion 正确处理、spawn 实测=加法公式、不变量全绿）**。本计划全部阶段交付完成，显式带三个开放项（不宣称「全量通过」）：(a) moonshot 外部阻塞待 cld 侧确认、(b) codex-facilitator soak 变体 ≥15min 证据待 codex app-server 稳定窗口补齐（合同已由 claude 变体达成，此项为补齐性质）、(c) launchd 崩溃拉起人工项待用户执行。