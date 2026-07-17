# U4 验证记录 — 新领域模型、Dexie 事务与确定性 Context Snapshot

日期：2026-07-17
计划：`docs/plans/2026-07-17-001-feat-runtime-host-dual-driver-v1-cutover-plan.md` U4 节

## 结论

U4 完成信号达成：**已 committed 的讨论进度可以仅从 Dexie 恢复**（Message/Summary/ModelExecution/Round/Room/RuntimeBinding 全部落 `councilkit-runtime-v1`，CLI thread/process 全丢不影响已提交事实）；重复或冲突终态不会重复推进 Round（幂等重放 + IDEMPOTENCY_CONFLICT + 唯一索引，27 个事务用例覆盖）。验证：新增 46 用例全绿；全量回归 **318/318**；typecheck/lint/`pnpm build` 全绿。

## 交付文件

- `src/models/discussion/`（entities / model-execution / runtime-binding / factories / index）：目标领域模型——全局 Agent（persona+executionProfileId+modelId）、Participant（加入快照 + participantSnapshotDigest）、Room（facilitatorParticipantId / runState / activeRoundId / contextRevision / contextDigest）、Round（顺序快照 / phase / pausedFrom / cursor / activeExecutionId）、Message & Summary（sourceExecutionId）、ModelExecution（全局提交锚点）、RuntimeBinding（creating/active/closing/closed）。
- `src/lib/runtime-db.ts`：`councilkit-runtime-v1` 九张表；唯一索引 `messages.&sourceExecutionId`、`summaries.&roundId` + `&sourceExecutionId`、`runtimeBindings.&scopeRequestId`。
- `src/orchestrator/context-snapshot.ts`：`digestVersion: 1` canonical 序列化；contextDigest（共享投影）/ participantSnapshotDigest / instructionDigest 三段分离；buildContextSnapshot 经共享 zod schema 校验（与 Host 同契约）。
- `src/lib/discussion-transactions.ts`：共享写（appendUserMessage / updateRoomSharedConfig，各恰好 +1 revision）、Round 生命周期（createRound CAS activeRoundId / pause/resume/abort）、beginExecution（dispatch 前持久化锚点）、commitModelMessage / commitSummary（正文 + committed + ackState pending + Room revision/digest + Round 游标/phase 同事务；stale context/participant 走 discarded+paused 内部路径且不涨 revision）、discardExecution / failExecution（failed/interrupted 不可转 committed/discarded）、ACK 生命周期（pending/acknowledged/expired）、RuntimeBinding 全生命周期（scopeRequestId 幂等）。
- `tests/unit/{context-snapshot,domain-models,discussion-transactions}.test.ts`：9 + 10 + 27 = 46 用例。

## 与计划文件清单的偏差（有意为之，已评估）

计划列了「修改 `src/models/agent.ts` 等 + `src/lib/db.ts`」。实际采用 **side-by-side**：目标模型放 `src/models/discussion/`，目标 DB 放 `src/lib/runtime-db.ts`，legacy `src/models/*`、`src/lib/db.ts` 及其 112 个 legacy 测试一律未动。理由：in-place 改形会打破全部 legacy 测试（Stage C 前必须保留 legacy，且规则不允许为接口变化改写既有测试语义）；U7 删除 legacy 后殊途同归。语义层面零偏差：schema、不变量、事务边界、digest 规则均按计划与设计文档实现。

## 过程中修掉的实现 bug

`failExecution` 事务表清单漏 `db.participants`（`loadCommitContext` 访问越界 → 必然 NotFoundError）。子任务测试如实记录了现状，修复后两个用例改写为直接断言正确语义（failed + round paused(execution_failed) + revision 不增长 + failed 后 commit 拒 EXECUTION_NOT_COMMITTABLE）。

## 覆盖的计划验收点

- digest 稳定性（构造顺序无关 + 2 组 pinned sha256 测试向量）；revision/digest 三段分离规则 ✓
- 并发同 execution 提交只有一个成功（唯一索引兜底）；resultKind 定胜负；异事实重放 IDEMPOTENCY_CONFLICT 整体回滚 ✓
- stale controller/execution/room digest/participant digest：不提交、不推进、paused 持久化、不涨 revision ✓
- prewarm pausedFrom=prewarming → abort → 新开 Round（roundNumber=2）；并发 createRound 只有一个成功 ✓
- completed 不变量（committed Summary + cursor 末尾 + 无 activeExecutionId）；终态不回退 ✓
- RuntimeBinding 状态机 + scopeRequestId 唯一 + 重试返回同一 binding ✓
- fake-indexeddb 验 fresh schema/索引/约束；indexedDB.open 记录证明双轮流程只打开 `councilkit-runtime-v1`，legacy 库零接触 ✓

## 遗留（U5 边界）

- 未提交 execution 的启动审计（转可解释 paused）、ACK 补发扫描、`takeoverRuntimeBinding` 的真实 Host takeover 接线：均为 U5 范围。
- legacy localStorage 读取计数：node 测试环境无 localStorage，目标代码不触碰；App 入口级验证随 U5/U6 进行。
- `pnpm build` 的 >500kB chunk 警告为 legacy bundle 既有现象，与 U4 无关。
