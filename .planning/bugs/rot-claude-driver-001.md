# claude-stream-json.ts never labels close()-caught prewarm handshake failures CANCELLED (H4 fix not ported from kimi)

- **Status**: FIXED @ 3c2c2a2d801056906c128c0c18a6f3b04ebd5a76 (H4 CANCELLED port to claude+codex, squad 20260723-fix-rotclaude-h4-cancel-3205, 2 fix rounds)

- **Severity**: P2

- **Priority**: medium

## Tracing

- **scan_id**: 20260723T144328Z-410232b2-2d79

- **fingerprint**: 229c23258cb9e3c16b6ccff425326bfa2717d6999f99cd45956a4e2977501137

- **base_sha**: 410232b273457eff98dc50ae48609c3ab99454b2

- **base_ref**: main

- **repo_root**: /Users/hengzhuo/code/github/Wenfeng-GAO/councilkit

- **target_squad**: hengzhuo-engineering-squad

- **publish_mode**: project-ticket

- **protocol_version**: bug-hunter-v1

- **runtime_profile**: hengzhuo-default

- **candidate_id**: rot-claude-driver-001

## Bug 描述 (description)

Port the CK-RS-001 H4 CANCELLED lifecycle label to claude-stream-json.ts (and the sibling codex-app-server.ts which has the identical 0-CANCELLED gap). In onProcessExit (claude-stream-json.ts:441-470), when state==='closing'||'closed', reject pending controls / prewarm with runtimeCode 'CANCELLED' instead of the plain 'driver process exited' (e.g. failAllPendingControls(Object.assign(new Error('claude driver closed during prewarm'), { runtimeCode: 'CANCELLED' })) when isClosingOrClosed()), and surface CANCELLED unchanged from the prewarm catch (L772-774) so scope-manager.prewarmParticipant (scope-manager.ts:284) short-circuits to entry.runtime='cold' + entry.binding=null + entry.readiness=null + scope.prewarm_cancelled.\n\nAcceptance criteria (all must PASS):\nAC1 (unit, driver): start a claude-stream-json prewarm whose initialize control is in flight; invoke close() (or drive onProcessExit with state='closing') so the process is killed before the 15000ms initialize deadline; assert prewarm rejects with error.runtimeCode==='CANCELLED' (NOT a plain 'driver process exited'), and that scope-manager.prewarmParticipant sets entry.runtime='cold', entry.binding=null, entry.readiness=null and emits scope.prewarm_cancelled with NO scope.prewarm_failed and NO readiness.runtime_unavailable on the closing scope.\nAC2 (regression): a genuine handshake failure with NO close() (initialize returns INCOMPATIBLE_DRIVER, or an INSTALLATION_INVALID spawn error) still yields the existing non-CANCELLED failure path unchanged (runtime='failed' + readiness + scope.prewarm_failed).\nAC3 (static): grep claude-stream-json.ts and codex-app-server.ts for CANCELLED shows >=1 isClosingOrClosed()-gated CANCELLED emission on the exit/prewarm-close path, matching the kimi-stream-json.ts pattern.\nAC4 (reachability): the fix covers the three close triggers - controller-close (scope-manager.ts:635), host closeAll (:640), and the 30s creating-TTL sweeper (:178) - all of which call closeScopeInternal -> driver.close() during an in-flight initialize handshake.

## 代码位置 (locations)

- `runtime-host/drivers/claude-stream-json.ts:451`
- `runtime-host/drivers/claude-stream-json.ts:772`
- `runtime-host/drivers/claude-stream-json.ts:859`
- `runtime-host/scopes/scope-manager.ts:277`

## 生产可达性 (production reachability)

- **entrypoint**: `createClaudeStreamJsonDriver().prewarm (awaited by scope-manager.prewarmParticipant at scope-manager.ts:248 for a participant whose profile.driverId is 'claude-stream-json', itself awaited by createScope's Promise.all at scope-manager.ts:373); a concurrent close() (controller-close scope-manager.ts:635 / host closeAll :640 / 30s creating-TTL sweeper :175-178 -> closeScopeInternal :604 -> driver.close()) during a healthy in-flight handshake`
- **call chain**:
  - scope-manager createScope awaits Promise.all(prewarmParticipant) (scope-manager.ts:373); prewarmParticipant awaits entry.driver.prewarm (scope-manager.ts:248) for a claude-stream-json participant, which in spawnAndHandshake awaits sendControl({subtype:'initialize'}) (claude-stream-json.ts:557) that registers a pendingControl (:179) and awaits withDeadline(handshakeMs=15000) (:177)
  - concurrent closeScopeInternal (controller-close / host closeAll / 30s creating-TTL sweeper) calls claude.close() (claude-stream-json.ts:859): state='closing', current.shutdown(shutdownGraceMs=10000) at :873; process-supervisor shutdownRecord (process-supervisor.ts:482-505) SIGKILL-escalates and settleDriver (:310-316) emits 'exit', which claude wires to onProcessExit at claude-stream-json.ts:474-478
  - claude onProcessExit (claude-stream-json.ts:441-470) calls failAllPendingControls(new Error('driver process exited')) at :451 UNCONDITIONALLY - including when state==='closing' (the only closing-sensitive branch is the rebuild skip at :446) - so it rejects the in-flight initialize pendingControl with a plain Error carrying no runtimeCode
  - claude.prewarm catch (claude-stream-json.ts:772-774) does state='cold'; throw error - re-throws the close-caught plain Error unchanged; scope-manager.prewarmParticipant catch (scope-manager.ts:277-294) sees runtimeCode undefined (!=='CANCELLED') and takes the non-CANCELLED branch at :295-309: entry.runtime='failed', readiness.state='runtime_unavailable', logger.warn('scope.prewarm_failed', {code:'UNKNOWN'}) on the closing scope

## 违反的契约 (violated contract)

H4 (documented kimi-stream-json.ts:874-879,904-910,1182-1189 and enforced at scope-manager.ts:277-294): a prewarm failure caused by close() shutting down the probe/handshake must carry runtimeCode CANCELLED - the lifecycle label - so scope-manager.prewarmParticipant short-circuits to entry.runtime='cold' + entry.binding=null + entry.readiness=null and logs scope.prewarm_cancelled, and does NOT land readiness.runtime_unavailable or emit scope.prewarm_failed on a closing/closed scope. claude-stream-json.ts emits no CANCELLED on any close-caught path, so the close-caught 'driver process exited' prewarm rejection is mislabelled as a non-CANCELLED failure and poisons teardown diagnostics on the closing scope.

## 根因 (root cause)

The CK-RS-001 H4 fix (isClosingOrClosed()->CANCELLED labelling of close-caught failures, 6 guards in kimi-stream-json.ts) was never ported to the sibling claude-stream-json.ts, which has zero isClosingOrClosed()/CANCELLED machinery; onProcessExit (claude-stream-json.ts:441-470) rejects close-killed handshakes via failAllPendingControls with a runtimeCode-less 'driver process exited', so scope-manager's runtimeCode==='CANCELLED' H4 gate at scope-manager.ts:284 never matches for claude and the close-caught prewarm rejection is mislabelled as a non-CANCELLED failure.

## 复现 (reproduction)

- **kind**: static-proof

- **steps**:
  - Read claude-stream-json.ts:512-591 spawnAndHandshake and :173-190 sendControl: after spawn and waitSupervised resolve, sendControl({subtype:'initialize'}) registers a pendingControl (:179) and awaits withDeadline(handshakeMs=15000) (:177); prewarm (:751-782) sets state='starting' and awaits this handshake.
  - Read claude-stream-json.ts:441-470 onProcessExit: failAllPendingControls(new Error('driver process exited')) at :451 runs unconditionally - it executes even when state==='closing'; the only closing-sensitive branch is the rebuild skip at :446, so the pending control IS rejected during an intentional close.
  - Read claude-stream-json.ts:859-877 close and process-supervisor.ts:482-505 shutdownRecord + :310-316 settleDriver: close() sets state='closing' then current.shutdown(10000) kills the driver; settleDriver emits 'exit'; claude wires 'exit' to onProcessExit at :474-478.
  - Construct the race: a claude-stream-json participant prewarm is in flight (initialize control awaited) when closeScopeInternal fires - controller-close (scope-manager.ts:629-637), host closeAll (:639-641), or the 30s creating-TTL sweeper (:175-178) - and calls driver.close(); close()'s shutdown kills the process before the 15000ms initialize deadline elapses on a healthy handshake.
  - Trace the label: the exit reject propagates as a plain Error('driver process exited') (no runtimeCode) through prewarm catch (:772-774) into scope-manager.prewarmParticipant catch (:277-294); runtimeCode undefined !== 'CANCELLED' so the non-CANCELLED branch runs.

- **observed**: A close()-caused prewarm handshake shutdown on a claude-stream-json participant is labelled a non-CANCELLED failure: scope-manager sets entry.runtime='failed', readiness.state='runtime_unavailable', and emits scope.prewarm_failed (code='UNKNOWN') on the closing scope, instead of runtime='cold' + scope.prewarm_cancelled.

- **expected**: A close()-caused prewarm shutdown carries runtimeCode CANCELLED (H4 lifecycle label), so scope-manager.prewarmParticipant short-circuits to entry.runtime='cold' + entry.binding=null + entry.readiness=null and logs scope.prewarm_cancelled, leaving no failed readiness and no scope.prewarm_failed on the closing scope.

## 验收方法 (validation / acceptance criteria)

- unit test (driver): start a claude-stream-json prewarm whose initialize control is in flight, invoke close() (or drive onProcessExit with state='closing') so the process is killed before the initialize deadline, then assert prewarm rejects with runtimeCode CANCELLED (not a plain 'driver process exited') and that scope-manager.prewarmParticipant sets entry.runtime='cold' with scope.prewarm_cancelled and emits no scope.prewarm_failed / runtime_unavailable on the closing scope.
- regression test: a genuine handshake failure with NO close() (e.g. initialize returns INCOMPATIBLE_DRIVER, or a spawn-error) still yields the existing non-CANCELLED failure path unchanged.

## 修复方向 (suggested fix)

Port the H4 CANCELLED lifecycle label to claude-stream-json.ts: in onProcessExit (and a pre-arm prewarm close guard mirroring kimi-stream-json.ts:877/921), when the driver is closing/closed, reject/throw with runtimeCode 'CANCELLED' instead of the plain 'driver process exited' - e.g. failAllPendingControls(Object.assign(new Error('claude driver closed during prewarm'), { runtimeCode: 'CANCELLED' })) when state==='closing'||'closed' - and surface CANCELLED unchanged from the prewarm catch, so scope-manager.prewarmParticipant short-circuits to runtime='cold' + scope.prewarm_cancelled. Apply the same isClosingOrClosed()->CANCELLED pattern to codex-app-server.ts, which has the identical 0-CANCELLED gap.

## 证据 (evidence)

- cross-driver guard census: kimi-stream-json.ts has 6 isClosingOrClosed() calls and 6 CANCELLED runtimeCode emissions (the CK-RS-001 H4 fix); claude-stream-json.ts and codex-app-server.ts have 0 of each - the H4 fix was applied only to kimi and never ported to the sibling drivers.
- claude-stream-json.ts:441-470 onProcessExit calls failAllPendingControls(new Error('driver process exited')) at :451 UNCONDITIONALLY, before the state!=='closing'/'closed' rebuild-skip guard at :446, so a close()-killed process rejects the in-flight initialize control with a plain Error that has no runtimeCode.
- claude-stream-json.ts:859-877 close() sets state='closing' and awaits current.shutdown(shutdownGraceMs) (:873) but never sets turn.cancelling and never labels the shutdown CANCELLED; process-supervisor shutdownRecord (process-supervisor.ts:482-505) kills the driver and settleDriver (:310-316) emits 'exit', wired to onProcessExit at claude-stream-json.ts:474-478.
- claude-stream-json.ts:772-774 prewarm catch re-throws the close-caught plain Error unchanged with no CANCELLED labelling, unlike kimi-stream-json.ts:877/921/1187 which gate the same path on isClosingOrClosed() and throw runtimeCode 'CANCELLED'.
- scope-manager.ts:277-294 prewarmParticipant catch short-circuits ONLY on runtimeCode==='CANCELLED'; a plain 'driver process exited' (runtimeCode undefined) falls through to :295-309 entry.runtime='failed' + readiness.state='runtime_unavailable' + logger.warn('scope.prewarm_failed', {code:'UNKNOWN'}), and this catch has NO scope.state guard, so the failed readiness and prewarm_failed land on a closing/closed scope - the exact H4 poisoning pattern CK-RS-001 removed for kimi.
- contract values (shared/runtime/contracts.ts:38-53): handshakeMs=15000, shutdownGraceMs=10000, creatingScopeTtlMs=30000; close()'s process-exit reject fires before the 15s initialize withDeadline when close() arrives during a healthy handshake, so close() is the cause of the rejection rather than a deadline that would fire regardless (c.f. the disproved CK-RS-003 which relied on a deadline that fires identically with or without close).

## 追溯 (traceability)

- **scan_id**: 20260723T144328Z-410232b2-2d79

- **fingerprint**: 229c23258cb9e3c16b6ccff425326bfa2717d6999f99cd45956a4e2977501137

---

_Generated by bug-hunter finalize.py (publish_mode=project-ticket). Edit this file directly; bug-hunter will not overwrite an existing ticket._

## Fix (integrated 2026-07-23)

- **final candidate SHA**: 3c2c2a2d801056906c128c0c18a6f3b04ebd5a76(经 3 个候选迭代:89ea62e → 994e1d2 → 3c2c2a2)
- **branch**: squad/20260723-fix-rotclaude-h4-cancel-3205(ff-only merged to main;tree hash 与候选一致)
- **runtime profile**: hengzhuo-default(simple;orchestrator=kimi 主会话,planner/reviewer=codex gpt-5.6-sol,coder=cfuse,verifier=codex gpt-5.6-terra)

### Summary(两 driver 同形)

1. `isClosingOrClosed()` helper + onProcessExit 条件化:closing/closed 时 failAllPending* 带 `runtimeCode:"CANCELLED"`,真实崩溃保留 plain error。
2. pendingSpawn 跟踪(登记完整 spawn→guard continuation)+ post-spawn guard(closing 时 shutdown 晚到进程、抛 CANCELLED、不 adopt)+ close() await 完整 teardown。
3. H3 pre-spawn guard(mkdir 后、spawn 前最后一次生命周期检查)。
4. waitSupervised 拒绝点 closing→CANCELLED 守卫(adopt→initialize 窗口)。
5. prewarm catch:close 路径原样 rethrow(不写 cold),非 close 路径保持 cold+throw。

### 窗口审计结论

prewarm 路径每个 await 边界:mkdir(H3 guard)/ spawn(post-spawn guard + continuation)/ waitSupervised(catch guard)/ initialize 及各 RPC(onProcessExit 标记 pending)——close-caught 拒绝全部带 CANCELLED,无残余窗口(review-2 独立复核确认)。

### Tests(两 driver 各 5 类)

AC1 close-during-in-flight-initialize→CANCELLED;AC1c close-during-pending-spawn→CANCELLED+不 adopt;AC2 无 close 的真实 exit→plain error(不回归);AC3 close-during-waitSupervised→CANCELLED;AC4 close-during-pre-spawn(mkdir)→CANCELLED+不 spawn。全部 frame 同步、无固定 sleep、mock shutdown 异步。

### Verdicts

- **review-0**: CHANGES_REQUESTED(P1 pending-spawn 泄漏+catch 兜底掩盖;P2 测试 sleep+守卫不可区分)→ fix-1。
- **review-1**: CHANGES_REQUESTED(F1 waitSupervised 窗口;F2 mkdir 窗口+close 未等完整 teardown;F3 AC2 sleep)→ fix-2(系统性窗口审计)。
- **review-2**: LGTM,0 findings。
- **verify-2 + host gates**: AC1/AC1b/AC1c/AC2/AC3 静态 PASS;scope 组合 2/2 PASS;typecheck/lint PASS;全量 847/847 PASS;AC6 四类反证(整文件/onProcessExit/waitSupervised 守卫/H3 守卫)均 revert→FAIL、恢复→PASS、diff clean。
