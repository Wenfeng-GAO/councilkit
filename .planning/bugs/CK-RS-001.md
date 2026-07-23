# kimi provider probe labels close()-caused shutdown as AUTH_REQUIRED instead of CANCELLED (H4 violation)

- **Status**: FIXED @ 2f775670cd5f19b286953923b5627deb0af1d6a7 (kimi probe close → CANCELLED, squad 20260723-fix-ckrs001-probe-cancel-f82d)

- **Severity**: P2

- **Priority**: medium

## Tracing

- **scan_id**: 20260723T085433Z-229d8521-34d5

- **fingerprint**: d9da9abdd3a8cb7f0684685d912f36cb4b394a7de30e7b4672df6d328436d115

- **base_sha**: 229d85210348875314573ab6cebc2bc5b828acad

- **base_ref**: main

- **repo_root**: /Users/hengzhuo/code/github/Wenfeng-GAO/councilkit

- **target_squad**: hengzhuo-engineering-squad

- **publish_mode**: project-ticket

- **protocol_version**: bug-hunter-v1

- **runtime_profile**: hengzhuo-default

- **candidate_id**: CK-RS-001

## Bug 描述 (description)

runProviderProbe (runtime-host/drivers/kimi-stream-json.ts:1174-1178) throws AUTH_REQUIRED on any `exitCode !== 0` without checking isClosingOrClosed(), unlike every other failure site in the driver. When a concurrent close() (creating-TTL sweep, controller-close, or host-shutdown closeAll) SIGTERMs the in-flight `kimi provider list` probe while prewarm is awaiting its exit, the probe exits with code=null, the branch throws AUTH_REQUIRED, the prewarm catch (896-911) passes it through, and prewarmParticipant (scope-manager.ts:277-294) labels the participant readiness runtime_unavailable and logs scope.prewarm_failed with code AUTH_REQUIRED. This poisons teardown diagnostics/readiness with a spurious auth failure, violating the documented H4 lifecycle-label invariant.

## 代码位置 (locations)

- `runtime-host/drivers/kimi-stream-json.ts:1163`
- `runtime-host/drivers/kimi-stream-json.ts:1174`
- `runtime-host/drivers/kimi-stream-json.ts:896`

## 生产可达性 (production reachability)

- **entrypoint**: `createKimiStreamJsonDriver().prewarm -> runProviderProbe`
- **call chain**:
  - scope-manager prewarmParticipant awaits driver.prewarm which awaits runProviderProbe
  - closeScopeInternal/closeAll shuts down the in-flight probe process while runProviderProbe is still awaiting exit
  - runProviderProbe resolves exitCode=null (SIGTERM) and throws AUTH_REQUIRED because the exitCode!==0 branch has no isClosingOrClosed guard
  - prewarm catch passes AUTH_REQUIRED through to prewarmParticipant which labels readiness runtime_unavailable

## 违反的契约 (violated contract)

H4 (documented at kimi-stream-json.ts:698,901-907,1127): a failure caused by close() must be labelled CANCELLED, never remapped to AUTH_REQUIRED, because AUTH_REQUIRED poisons readiness/diagnostics. runProviderProbe's non-zero-exit branch violates this.

## 根因 (root cause)

runProviderProbe's `exitCode !== 0` AUTH_REQUIRED throw lacks the isClosingOrClosed() guard that every other failure path in the driver applies, so a Host-initiated close() shutdown of the probe is indistinguishable from a genuine provider-auth failure

## 复现 (reproduction)

- **kind**: static-proof

- **steps**:
  - read runProviderProbe lines 1150-1178: after withDeadline resolves, timedOut is false on a clean SIGTERM exit, so control reaches the `exitCode !== 0` branch
  - note that branch throws AUTH_REQUIRED with no isClosingOrClosed() check, unlike every other failure site in the file
  - trace concurrent close(): it nulls activeProbe and calls probe.shutdown(), yielding exitCode=null on the probe's exit event
  - trace prewarm catch lines 896-911: AUTH_REQUIRED is not remapped to CANCELLED, and line 917 is skipped because the probe threw

- **observed**: a provider probe shut down by close() (creating-TTL sweep or host closeAll during prewarm) is reported as AUTH_REQUIRED / readiness runtime_unavailable instead of CANCELLED

- **expected**: a close()-caused probe termination is labelled CANCELLED so diagnostics and readiness are not poisoned with a spurious auth failure during teardown

## 验收方法 (validation / acceptance criteria)

- unit test: start a kimi prewarm, invoke close() while runProviderProbe is awaiting the probe exit, assert prewarm rejects with runtimeCode CANCELLED (not AUTH_REQUIRED) and the participant readiness is not labelled runtime_unavailable/AUTH_REQUIRED on the closing scope

## 修复方向 (suggested fix)

in runProviderProbe, before the `if (exitCode !== 0)` AUTH_REQUIRED throw, add `if (isClosingOrClosed()) throw Object.assign(new Error('kimi driver closed during the provider probe'), { runtimeCode: 'CANCELLED' })`, mirroring the spawn-side CANCELLED guards and the H4 invariant

## 证据 (evidence)

- kimi-stream-json.ts:1174-1178: `if (exitCode !== 0) throw ... runtimeCode: AUTH_REQUIRED` runs unconditionally with no isClosingOrClosed() check, unlike the timedOut branch (HANDSHAKE_TIMEOUT) and the spawn-side guards
- kimi-stream-json.ts:1165: the probe always calls `await spawned.shutdown(...)` then reads exitCode; a close()-triggered SIGTERM produces exitCode=null which satisfies `!== 0`
- kimi-stream-json.ts:896-911: prewarm's probe catch only preserves HANDSHAKE_TIMEOUT and CANCELLED labels; an AUTH_REQUIRED thrown by the probe is passed straight through as AUTH_REQUIRED
- kimi-stream-json.ts:917: the post-probe `if (isClosingOrClosed()) throw CANCELLED` guard is unreachable when the probe throws, so a close-during-probe bypasses the CANCELLED path
- close() at kimi-stream-json.ts:1048-1052 sets activeProbe=null and awaits probe.shutdown(), which is what drives the probe's non-zero exit from the Host side

## 追溯 (traceability)

- **scan_id**: 20260723T085433Z-229d8521-34d5

- **fingerprint**: d9da9abdd3a8cb7f0684685d912f36cb4b394a7de30e7b4672df6d328436d115

---

_Generated by bug-hunter finalize.py (publish_mode=project-ticket). Edit this file directly; bug-hunter will not overwrite an existing ticket._

## Fix (integrated 2026-07-23)

- **candidate SHA**: 2f775670cd5f19b286953923b5627deb0af1d6a7
- **branch**: squad/20260723-fix-ckrs001-probe-cancel-f82d (ff-only merged to main; tree hash 与候选一致)
- **runtime profile**: hengzhuo-default(orchestrator=kimi 主会话,planner/reviewer=codex gpt-5.6-sol,coder=cfuse,verifier=codex gpt-5.6-terra;simple 模式,0 fix 轮)

### Summary of the fix

1. `runtime-host/drivers/kimi-stream-json.ts` — `runProviderProbe` 在 `if (exitCode !== 0)` AUTH_REQUIRED 分支前补 `isClosingOrClosed()` 守卫,close()-caused 的 probe 终止(exitCode=null)抛 `runtimeCode:"CANCELLED"`,镜像 spawn 侧 G2 守卫(L1124-1129);timedOut→HANDSHAKE_TIMEOUT 优先级与真实非零退出→AUTH_REQUIRED 行为不变。
2. `runtime-host/scopes/scope-manager.ts` — `prewarmParticipant` catch 新增 `runtimeCode==="CANCELLED"` 分支:`entry.runtime="cold"`、`binding=null`、`readiness=null`,`logger.info("scope.prewarm_cancelled")`,立即 return;不再落 runtime_unavailable、不再记 scope.prewarm_failed;不重复 close driver。其余错误路径行为不变。(brief v2 扩入:Planner intent_check 发现 ticket AC 的 readiness 要求超出 driver-only 范围,经 Orchestrator 裁决修订。)

### Tests

- AC1 `tests/host/kimi-stream-json.test.ts`「provider probe awaiting exit」:内存 DriverProcess + seam supervisor 确定性构造 close-during-exit-wait,断言 prewarm reject CANCELLED(非 AUTH_REQUIRED)、driver 未 ready。
- AC2 同文件「non-zero provider probe exit」:fake-kimi `{providerExit:7}` 无 close,断言仍 AUTH_REQUIRED(防回归)。
- AC3 `tests/integration/runtime-host.test.ts`:FakeDriver 扩展 `prewarmError`/`prewarmRejectOnClose`;CANCELLED 用例(closeAll during prewarm → participant cold/null/null + scope.prewarm_cancelled,无 prewarm_failed)与 AUTH_REQUIRED 对照(failed + runtime_unavailable 不变)。

### Verdicts

- **Reviewer**(codex gpt-5.6-sol):LGTM,无 finding。
- **Verifier**(codex gpt-5.6-terra):AC1/AC2/AC4/AC5 PASS,AC7-driver 反证 PASS;AC3/AC6/AC7-scope 因沙箱 listen EPERM 阻塞 → Orchestrator host gates 补全:AC3 PASS(2/2)、AC6 全量 PASS(836/836)、AC7-scope 反证 PASS(revert→FAIL,恢复→clean+PASS)。
- 备注:Coder 为解除 integration 门阻塞,kill 了主仓库一个占用 43127 的 `pnpm dev` Host(pid 23453);如需可用 `pnpm dev` 重启。
