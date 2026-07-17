# U5 验证记录 — Runtime Client、持久化 Discussion Orchestrator 与暂停语义

日期：2026-07-17
计划：`docs/plans/2026-07-17-001-feat-runtime-host-dual-driver-v1-cutover-plan.md` U5 节
交接：`docs/handoff-2026-07-17-u5.md`（实现清单与设计点以该文档为准）

## 结论

U5 两套测试落地，完成信号达成：**已提交 Room 状态不再依赖组件存活**（重启后仅从 Dexie 恢复，审计零 execute/ack）；**未提交工作被确定性审计为可解释 paused**（SAFE_INTERRUPTION / INTERRUPTED_UNKNOWN，已 committed 绝不降级）；正常、重放、ACK acknowledged/expired、stale context 与三类结构化丢弃均有确定性结果。验证：新增 **25 用例**（单测 21 含 3 个 `it.fails` 钉住已知 bug + 集成 4）两套连跑 2 遍无 flake；全量回归 **343/343**；`pnpm typecheck`（三程序）与 `pnpm lint` 全绿。`src/`、`runtime-host/` 实现一行未改。

## 交付文件（本次会话新增）

- `tests/unit/discussion-orchestrator.test.ts`：fake-indexeddb + 脚本化内存 fake Host（单 fetch handler `vi.stubGlobal("fetch", h)`，SSE 用 `new Response(new ReadableStream(...))`，事件递增 seq + ISO at，可脚本化 health/createScope/takeover/execute/events/ack/cancel/close 与 prewarm 失败、ACK 三种故障、Host 重启）；内存可控 LockProvider。
- `tests/integration/discussion-runtime.test.ts`：真 HTTP Host（createTestHost + scopeRoutes + 真 scope-manager/registry/reconciler + in-process fake driver，组装照抄 `tests/integration/runtime-host.test.ts`）+ 真 RuntimeClient + 真 orchestrator + fake-indexeddb。
- `tsconfig.integration.json`（新增）+ `tsconfig.host.json`（exclude 该文件）+ `package.json` `typecheck` 追加第三程序：集成文件跨 `@/`（orchestrator/client/db）与 `@host/`（Host 组装）两个世界，既有两个 tsconfig 各缺一边路径，无法覆盖；第三程序只 include 该文件，沿传递闭包检查。`pnpm typecheck` 语义只增不减。

## 覆盖的计划验收点（对照交接待办 1 的用例清单）

单测（编号对应交接用例）：

1. 正常双轮：execute 顺序 p1→p2→p1(summary)×2 轮、cursor=2/phase=completed、revision 精确 +3/轮（3→6）、**每次 commit 后 ack committed**（fake Host 在 ACK 时刻进程内读 Dexie，断言 `stateAtAck === "committed"`，即先 Dexie 后 ACK）、终态全 acknowledged ✓
2. persist→ACK 三边界：completed 重放只一次正文/重放返回同一 entity/重 ACK（2a，直调 handleCompletedExecution）；ACK 网络错 pending 保留、审计重发 acknowledged（2b）；ACK 成功但响应丢失 → tombstone 幂等、不重复处理、不重发模型（2c）✓
3. commit 后 Host 重启：正文/摘要/revision 不变、pending ACK→expired、新 Host execute/ack 计数 0 ✓
4. mismatch/unknown verdict → paused(model_mismatch)、execution 留 requested/effective+MODEL_MISMATCH、正文 0、无重试、discarded ACK ✓
5. toolState unknown → paused(tool_state_unknown)、预览只到 display 不落库、无重试 ✓
6. 空输出 → paused(empty_output) ✓
7. p2 prewarm 失败 → paused(prewarm_failed, pausedFrom=prewarming)、execute 计数 0 ✓
8. 执行中 appendUserMessage → stale_context discarded+paused、模型正文 0、revision 只涨用户消息那 1 次、不重试 ✓（另 8b：SSE 断连后 getExecution→afterSeq 重连、回放严格大于、同 executionId 不重发）
9. 三边界 startupAudit：prepared→failed(SAFE_INTERRUPTION)；running+Host 404→interrupted(SAFE_INTERRUPTION)；running+Host 有→interrupted(INTERRUPTED_UNKNOWN)；已 committed 不降级（且 Host 只被查询后两者）✓
10. 双客户端：A 持锁 B observing → A 释放 B takeover（epoch 2→3）→ A 旧 token 被 Dexie CAS（STALE_CONTROLLER）与 Host fencing（409）双拒 ✓
11. creating 边界：同 scopeRequestId 重试同一行；activate CAS 失败 → 用返回 token 补偿 close（scopeId/controllerId/leaseEpoch 全对）；startupAudit 收敛 creating（无 Host 事实）与 closing（补发 close）✓
12. 完成后重建 orchestrator：startupAudit 零 execute/ack/getExecution，状态全来自 Dexie ✓
13. pauseRoom：runState=paused + cancel 发出；interrupted(user_cancelled)→discarded+round paused(user_cancelled)；discarded ACK 由审计补发（见「取舍」）✓
14. abortPausedRound：paused→aborted（清 active execution 与 room.activeRoundId、runState=idle）；非 paused 抛错 ✓
15. retry-once：第一次 failed{retryable,not_dispatched} 第二次成 → p1 恰好 2 次 execute 且 executionId 不同（retryOfExecutionId 链为已知 bug，见下）；第二次也败（非 retryable）→ paused、无第三次 ✓

集成（真 Host）：

1. 端到端双轮：dispatch 顺序（p1,p2,p1)×2、prewarmCount=每 participant 1、Dexie 正文 4/摘要 2/revision 6、全 execution committed+acknowledged、ACK tombstone 幂等（重复 acknowledged、异 disposition 409）✓
2. SSE afterSeq 重连：`src/runtime/event-stream.ts` 真模块对真 Host，afterSeq=2 回放严格 [3,4,5]、driver executeCalls 1（不重发模型）✓
3. cancel：hangUntilCancel + cancelActiveExecution → Dexie discarded(user_cancelled)+paused；审计补发 discarded ACK，Host 侧 record disposition=discarded、tombstone ✓
4. Host 重启（不同 hostInstanceId 第二实例）：startupAudit → pending ACK expired、未完结 interrupted(SAFE_INTERRUPTION)+round paused、已提交正文/revision 不变、新 Host dispatch 计数 0 ✓

## 发现的实现 bug（如实报告；按交接约束未改 src/，测试侧绕开/钉住）

> **2026-07-17 后续（U6 前置修复）**：以下 bug 1–4 已在 U6 前置 commit 中修复（ensureScope 增加 Host activate；dispatchTurn 透传 retryOfExecutionId；重试路径返回嵌套 dispatchTurn 结果；startRound pause 路径改返回新读行）。原 3 个 `it.fails` 已转为普通回归测试，并新增「RETRY 上再次 retryable 失败 → paused、无第三次派发」用例；集成套件移除 ActivatingClient 绕开，裸 RuntimeClient 对真 Host 全绿即修复实证。bug 5 为设计内行为（见下），保持不变。

1. **ensureScope 从不调用 Host 的 `POST /scopes/:id/activate`**（`src/orchestrator/discussion-orchestrator.ts` ensureScope；client 的 `activateScope` 全 src 无调用）。真 Host 上 scope 永远停在 `creating`，execute 被 409 SCOPE_CLOSED 拒绝，30s TTL 后还会被回收——**U6 的真实 UI/E2E/冒烟必经此路径，属阻塞级**。实证：集成套件把 ActivatingClient 换回裸 RuntimeClient 后 4/4 全挂（"Scope is not active."）。单测 `it.fails` 钉住（fake 对 scope 状态宽松）；集成用测试侧子类 `ActivatingClient`（create 后立即 activate）绕开。
2. **retry 链断链**：`handleTerminal` 重试时 `dispatchTurn`→`createModelExecution` 未传 `retryOfExecutionId`（恒 null），"最多重试一次"上限不可达——第二次 retryable+not_dispatched 失败会无限重试。用例 15 只能覆盖「重试成功」与「第二次非 retryable 失败暂停」，链本身以 `it.fails` 钉住。
3. **重试成功后 runLoop 停转**：重试路径 `handleTerminal` 无条件 `return false`，runLoop 在 cursor 已推进的 running Round 上退出，后续 Participant 永不再派发。用例 15 以显式 `orchestrator.runLoop(roomId)` 补偿，bug 以 `it.fails` 钉住。
4. **startRound prewarm-pause 路径返回陈旧 Round 对象**（createRound 时的内存副本，phase 仍 "pending"；runLoop 路径则返回新读行）。durable 状态正确，属 API 一致性 wart；用例 7 断言改读 Dexie 行。U6 UI 消费该返回值前宜修。
5. **user_cancelled 无 inline discarded ACK**：`handleTerminal` 的 user_cancelled 分支 discardExecution 后不发 ACK（ackState 留 pending），由恢复扫描补发收敛。与设计点「user_cancelled 走 discarded（ACK discarded）」的最终语义一致、但时机靠审计。用例 13/集成 3 按实际行为断言（pending → 审计 → acknowledged）。

`it.fails` 的语义：bug 修复后对应测试会以 "expected to fail but passed" 变红，提示摘除标记——三个 bug 各有一个活的最小复现留在套件里。（修复落地后已按此机制摘标转正，见本节顶部后续注。）

## 取舍与偏差（同 U4 口径，有意为之）

- **SSE 断连重连的覆盖拆分**：真 Host 只在客户端关闭或未知 execution 时结束 SSE 连接，无法在不改 Host 的前提下制造「中途干净断流」。orchestrator 内部重连环（closed→getExecution→afterSeq 续传）由单测 8b（fake Host 可控断流）覆盖；集成 2 在真 Host 上验证 event-stream 模块的 afterSeq 恢复语义与零重发。两层合并覆盖交接要求的断言点。
- **首个 Round 的 boot 路径**：`startRound` 在无任何 binding 的全新 Room 上必抛 `no active controller`（`currentToken` 先于 `ensureScope`，createRound 的事务也要求 active binding）。测试以公开的 `ensureScope` API 先建 scope 再 startRound（产品侧建房/加 agent 流程理应同样先调 ensureScope）；该死代码分支（`if (!token) { controlRoom; currentToken }` 对新房必抛）建议 U6 前一并评估。
- **seed 的 participant 顺序**：`activeParticipants` 按 createdAt 排序，同一毫秒内并列会退化为随机 id 序；seed 显式写递增 createdAt 保确定性（实现本身的排序规则未动）。
- **typecheck 第三程序**：见「交付文件」。legacy 排除先例（tsconfig.json 对 3 个 legacy 测试文件的 exclude）同款处理思路，但本次选择让文件被真实检查而非排除。

## 门

- `pnpm vitest run tests/unit/discussion-orchestrator.test.ts tests/integration/discussion-runtime.test.ts`：25/25，连跑 2 遍无 flake。
- `pnpm typecheck`：tsc（app）+ tsc -p tsconfig.host.json + tsc -p tsconfig.integration.json 全绿。
- `pnpm lint`（biome）：全绿。
- `pnpm test`：**343/343**（U4 基线 318 + 新增 25）。
- 真实 CLI 门：U5 不触碰 driver/host，按交接规则无需重跑；全量 vitest 未与真实 CLI 门并发执行。
