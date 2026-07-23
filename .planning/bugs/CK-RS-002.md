# [CK-RS-002] kimi cancel() 不清 turnMs 定时器:慢 SIGTERM 退出让 turn_timeout 抢占 user_cancelled

- **Status**: FIXED @ 2661244164df36f524ae9bba2ec1c0106874bb1c (kimi cancel/turnMs race, squad 20260723-fix-ckrs002-cancel-turnms-e189)

- **Severity**: P2

- **Priority**: medium

## Tracing

- **scan_id**: 20260723T111643Z-066e4acb-04b7

- **fingerprint**: 0816f6ffca27accb2b8f71098b8230314eb053d44777a8edf125686e6125ccbb

- **base_sha**: 066e4acb781b66ff28c7b990bbc948b40aad2fcf

- **base_ref**: main

- **repo_root**: /Users/hengzhuo/code/github/Wenfeng-GAO/councilkit

- **target_squad**: hengzhuo-engineering-squad

- **publish_mode**: project-ticket(orchestrator 手动落地,见下注)

- **protocol_version**: bug-hunter-v1

- **runtime_profile**: hengzhuo-default

- **candidate_id**: CK-RS-002

> 注:本次 bug-hunter run 的 validator 实质判定 CONFIRMED(7 gate PASS,summary confirmed=1),但其输出 envelope 混入散文与终端转义码,runner 解析失败 exit 67,finalize 未生成 ticket。本 ticket 由 Orchestrator 从 `artifacts/validator-verdict.json` 抢救并按 .planning/bugs/README 的 bridge 职责手动落地;根因已经 Orchestrator 逐行独立核对(2026-07-23,HEAD 066e4acb)。

## Bug 描述 (description)

`cancel()`(runtime-host/drivers/kimi-stream-json.ts:983-1022)设置 `turn.cancelling=true` 后 SIGTERM 并轮询等待退出,但**从不调用 `clearTurnTimers`**。turnMs 处理器(L815-824)仅以 `activeTurn===turn && !turn.settled` 为守卫,**不检查 `turn.cancelling`**。若 turnMs 在 cancel 的 SIGTERM→exit 窗口内触发(进程忽略 SIGTERM 缓慢退出),`interruptTurn(turn,"timeout")` 先结算 turn,`settleOnExit`(L351-352 `if (turn.settled) return`)的 cancelling 分支(L354-366)不再有机会发出 `user_cancelled`。编排器(discussion-orchestrator.ts:832)只对 `user_cancelled` 做 clean-discard;`timeout` 落入 failExecution,execution 以 `interrupted (timeout)` 持久化,用户主动的暂停/取消被错误记为超时失败。

## 代码位置 (locations)

- `runtime-host/drivers/kimi-stream-json.ts:815`(turnMs 处理器无 cancelling 守卫)
- `runtime-host/drivers/kimi-stream-json.ts:986`(cancel 设置 cancelling 后未 clearTurnTimers)
- `runtime-host/drivers/kimi-stream-json.ts:351-366`(settleOnExit cancelling 分支,被抢占后不可达)

## 生产可达性 (production reachability)

- **entrypoint**: `pauseRoom / cancelActiveExecution → runtime client.cancel → POST /api/v1/scopes/:id/executions/:eid/cancel → scope-manager.cancel(L585)→ driver.cancel(executionId)`
- **call chain**:
  - 用户暂停/取消进行中的 kimi turn,driver.cancel 设置 cancelling、SIGTERM、轮询
  - 被kill进程忽略 SIGTERM 缓慢退出,turnMs(生产 600_000ms)恰在窗口内到期
  - turnMs 处理器 settle turn 为 timeout;settleOnExit 的 cancelling 分支被 `turn.settled` 短路
  - 编排器收到 interrupted/timeout(非 user_cancelled)→ failExecution,轮次暂停原因变成 execution_failed

## 违反的契约 (violated contract)

用户取消必须产生 `interrupted(user_cancelled)` 并由编排器 clean-discard(pauseRoom docstring L939-941;settleOnExit cancelling 分支 L354-366);cancel 路径不得被 turnMs 超时抢占为 timeout 失败。

## 根因 (root cause)

cancel() 未解除 turnMs 定时器,且 turnMs 处理器未把 `turn.cancelling` 作为豁免条件,两条防线同时缺失。

## 复现 (reproduction)

- **kind**: static-proof(orchestrator 独立核对)

- **steps**:
  - 读 cancel() L983-1022:无 clearTurnTimers 调用(对照 settleOnExit L353 存在该函数)
  - 读 turnMs 处理器 L815-824:守卫仅 activeTurn===turn && !turn.settled
  - 构造:turn 进行中(turnMs 已 arm),调用 cancel(),被 kill 进程在 interruptGraceMs 内不退出;turnMs 到期 → interruptTurn(turn,"timeout")
  - settleOnExit 后续 exit 事件到达时 turn.settled=true,cancelling 分支跳过

- **observed**: terminal 为 interrupted/timeout;编排器 failExecution;execution.state='interrupted',pauseReason 含 'interrupted (timeout)'

- **expected**: cancel 窗口内 turnMs 不得抢占;terminal 为 interrupted/user_cancelled,编排器 discardExecution(outcome user_cancelled)

## 验收方法 (validation / acceptance criteria)

- unit test(driver):kimi turn 进行中(short turnMs),被 cancel 的进程忽略 SIGTERM 撑过 turnMs 到期,断言 terminal reason 为 `user_cancelled`(非 timeout),session 失效原因为 `user_cancelled`(非 turn_timeout)
- unit test(driver,防回归):无 cancel 时 turnMs 到期仍产生 `timeout` 中断与 `turn_timeout` session 失效(既有行为不变)

## 修复方向 (suggested fix)

cancel() 在 `turn.cancelling=true` 之后、SIGTERM 之前调用 `clearTurnTimers(turn)`;并/或在 turnMs 处理器守卫中加入 `!turn.cancelling`(防御纵深)。二者均为一行级改动,镜像 settleOnExit L353 既有用法。

## 证据 (evidence)

- validator-verdict.json(scan 20260723T111643Z-066e4acb-04b7):7 gate 全 PASS,CONFIRMED,含完整调用链与编排器分支证据
- Orchestrator 独立核对(066e4acb):cancel() L983-1022 无 clearTurnTimers;turnMs L815-824 无 cancelling 守卫;settleOnExit L351-352 settled 短路、L354-366 cancelling 分支;orchestrator L832 仅 user_cancelled discard

## 追溯 (traceability)

- **scan_id**: 20260723T111643Z-066e4acb-04b7

- **fingerprint**: 0816f6ffca27accb2b8f71098b8230314eb053d44777a8edf125686e6125ccbb

## Fix (integrated 2026-07-23)

- **candidate SHA**: 2661244164df36f524ae9bba2ec1c0106874bb1c
- **branch**: squad/20260723-fix-ckrs002-cancel-turnms-e189 (ff-only merged to main; tree hash 与候选一致)
- **runtime profile**: hengzhuo-default(simple;orchestrator=kimi 主会话,planner/reviewer=codex gpt-5.6-sol,coder=cfuse,verifier=codex gpt-5.6-terra;0 fix 轮)

### Summary of the fix(两道一行级防线)

1. `cancel()` 在 `turn.cancelling = true` 之后、await pendingSpawn/SIGTERM 之前调用 `clearTurnTimers(turn)`(主修复)。
2. turnMs 回调守卫加 `!turn.cancelling`(竞态防线)。Planner 发现 ticket 未覆盖的竞态:pending-spawn continuation 可能在 cancel 初次 clear **之后**才 adopt 进程并安装 timer,单 clear 不足;守卫同时覆盖已入队回调与 `close()` 路径(同样设 cancelling)。不改 close()/SIGTERM 时序/fallback/epoch 规则。

### Tests

- AC1 `tests/host/kimi-stream-json.test.ts`「cancel wins when turnMs expires while SIGTERM exit is pending」:真实 turn 建 session + 内存 DriverProcess seam(忽略 SIGTERM)+ 短 turnMs + adoption gate,确定性构造 cancel 窗口内 turnMs 到期;断言唯一 terminal=interrupted/user_cancelled、session 失效原因 user_cancelled、无 turn_timeout。
- AC2 既有覆盖(silent turn L424、F3 L688)防回归,无 cancel 的 turnMs timeout 语义不变。

### Verdicts

- **Reviewer**(codex gpt-5.6-sol):LGTM,0 findings(两道防线闭环,fallback 仍保证 user_cancelled,AC1 确定性命中)。
- **Verifier**(codex gpt-5.6-terra):AC1/AC2/AC3/AC4/AC6 PASS;AC6 revert-test 反证明确显示 `timeout` 抢占;AC5 因沙箱 listen EPERM 阻塞 → Orchestrator host gate 补全:全量 837/837 PASS。
