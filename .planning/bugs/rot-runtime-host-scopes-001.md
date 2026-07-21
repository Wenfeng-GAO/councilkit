# BUG: rot-runtime-host-scopes-001

- **Status**: FIXED @ `9c91a8a1fa7453bc04d209fd9f6b17eea6723c7e`(squad 20260721-fix-scopes-1575,claude-only,已集成 main)
- **Severity**: P2
- **Confidence**: high(7/7 主张经独立静态核对与代码一致)
- **Type**: bug(race-condition 资源泄漏)
- **Discovered by**: bug-hunter v1,scout-rotation
- **scan_id**: `20260720T153529Z-7149e3af-752f`
- **fingerprint**: `d56a0ba18122c243c69495f312791fbee65844b6421aee3e581a0543e2d9ea1d`
- **base_sha**: `7149e3af5420658d7da0d69ed52998148d2928b8`(CouncilKit main)
- **target_squad**: claude-only(见 README;handoff JSON 的 codex 字段为 schema 遗留)
- **machine-readable**: `rot-runtime-host-scopes-001.handoff.json`

## Title

scope-manager creating-TTL sweeper 与并发 prewarm 竞争,致驱动进程泄漏与 maxDriverProcesses 配额耗尽

## Bug 描述

`runtime-host/scopes/scope-manager.ts` 中 `createScope` 在 `await Promise.all(prewarmParticipant)` **之前**就 arm 一把 30s(`creatingScopeTtlMs`)的 sweeper。sweeper fire 时调用的 `closeScopeInternal` 与并发的 `prewarmParticipant` 之间**无互斥、无取消、无 scope.state 二次检查**,且 `closeScopeInternal` 从不 `scopes.delete`。

当 `driver.close()` 先于 `driver.prewarm()` resolve(生产现实可达:prewarm 拉子进程+握手慢,close 仅 SIGKILL 立即返回),后 resolve 的 prewarm 会把已 closed scope 的 `entry.runtime` 覆盖为 `'ready'`,该 entry 随后**永久**被 `liveDriverProcessCount` 计入(map 从不 delete),缓慢累积到 `> QUOTAS.maxDriverProcesses(16)` 触发 429 `RESOURCE_LIMIT`,关闭语义与资源回收被破坏。

非确定性触发(窗口依赖),需 `prewarm() > 30s` 且 `close()` 先 resolve。低频但累积性故障。

## 代码位置

- `runtime-host/scopes/scope-manager.ts:325` — `scheduleCreatingSweep(scope)` 在 `await Promise.all(prewarm)`(L328)之前 arm
- `runtime-host/scopes/scope-manager.ts:164-173` — `scheduleCreatingSweep`,TTL fire 时 `void closeScopeInternal(scope,'creating-ttl')`,无互斥
- `runtime-host/scopes/scope-manager.ts:244-247` — `prewarmParticipant` 在 `await entry.driver.prewarm()` 后**无条件**写 `entry.runtime='ready'`/`entry.binding`,不检查 `scope.state`(最关键一处)
- `runtime-host/scopes/scope-manager.ts:536-559` — `closeScopeInternal` set state=closing/closed、`await driver.close()`、set `entry.runtime='cold'`,**从不 `scopes.delete`**;不取消飞行中 prewarm
- `runtime-host/scopes/scope-manager.ts:118-132` — `liveDriverProcessCount` 遍历 `scopes.values()` 把 ready/busy/prewarming 全计入,**不过滤 `scope.state`**
- `runtime-host/scopes/scope-manager.ts:289-291` — `liveDriverProcessCount()+participants.length > QUOTAS.maxDriverProcesses` 判定配额 → 429 RESOURCE_LIMIT
- `shared/runtime/contracts.ts:38` — `QUOTAS.maxDriverProcesses = 16`

## 根因

`scheduleCreatingSweep` 的 creating-ttl 分支与 `createScope` 中的并行 prewarm 缺乏互斥:sweeper 在 prewarm 仍在 `await spawnAndHandshake` 时执行 `closeScopeInternal`,`driver.close()` 跑在 spawn 解析之前且不会再次清理,随后 prewarm 成功完成并把 `entry.runtime/binding` 落到已 closed 的 scope 上;又因 closed scope 不从 `scopes` map 删除,`liveDriverProcessCount` 永久计入该 ready 条目,缓慢累积即耗尽 `maxDriverProcesses` 配额。

## 复现(static-proof)

注入 fake driver factory + `creatingScopeTtlMs=1s` + prewarm delay 35s:

1. `createScope` 中让 `prewarm(p)` 慢于 `creatingScopeTtlMs`:注入 fake factory,prewarm 35s 后才 resolve,同时 `creatingScopeTtlMs=1s`
2. `POST /api/v1/scopes` 创建单 participant scope,`scopeRequestId='r1'`
3. 等 sweeper 在 1s 后触发 `closeScopeInternal(scope,'creating-ttl')`,记录此时 `entry.runtime` 已被 close 设为 `'cold'`
4. 35s 后 prewarm resolve:`prewarmParticipant` 把 `entry.runtime='ready'`、`entry.binding` 设置到已 `'closed'` 的 scope
5. 读 `scopeManager._scopes.get(scopeId)`:state=`'closed'`,participants[0].runtime=`'ready'`
6. 读 `scopeManager.counts().liveDriverProcesses`:包含该 closed scope 的 ready 条目
7. 重复 16 次创建(每次 participantId 不同),第 17 次 `createScope` 因 `liveDriverProcessCount()+1 > maxDriverProcesses` 抛 429 RESOURCE_LIMIT

- **observed**:一个已关闭的 scope 仍持有 `runtime='ready'` 的 participant 且被 `liveDriverProcessCount` 计数;多次慢预热后新建 scope 因触达 `maxDriverProcesses(16)` 被 RESOURCE_LIMIT 拒绝
- **expected**:scope 被 creating-ttl 关闭后,飞行中的 prewarm 必须被取消/其 spawn 被回收,closed scope 不应再出现 `runtime='ready'` participant,`liveDriverProcessCount` 不应统计泄漏进程,新建 scope 不应因历史慢预热被配额拒绝

## 验收方法(Acceptance Criteria)

修复后须全部 PASS:

- **AC1(静态复现)**:注入 fake factory + `creatingScopeTtlMs=1s` + prewarm delay 35s,断言 close 后无 `runtime=='ready'` 的 participant,且 `liveDriverProcesses` 不含泄漏条目。
- **AC2(压力)**:连续 20 次 slow-prewarm 创建,断言不触发 `maxDriverProcesses` RESOURCE_LIMIT。
- **AC3(回归)**:扩展 V3 测试集合增加 create-vs-prewarm 竞争用例(现有 `runtime-host.test.ts:1003` 仅覆盖 close-vs-late-terminal,未覆盖 create-vs-prewarm)。

## 修复方向(suggested,非强制)

1. `prewarmParticipant` 完成时检查 `scope.state`:若 scope 已不在 `'creating'`/`'active'` 则立即 `entry.driver.close()` 并保持 `runtime='cold'`,不落 binding/readiness(最关键,直击 L244-247)。
2. `createScope` 的 `await Promise.all` 之后若发现 `scope.state==='closed'`,对已 ready 的 entry 再做一次兜底 close。
3. 可选:`closeScopeInternal` 末尾 `scopes.delete(scope.scopeId)`,或让 `liveDriverProcessCount`/scope 状态机显式排除 closed scope 的 ready 计数(防御层)。
4. 引入 AbortSignal 让 `scheduleCreatingSweep` fire 时能取消 prewarm。

## 证据链(独立读取的代码,非 scout 文字结论)

- `scope-manager.ts:322-325` 先 `scopes.set` 再 `scheduleCreatingSweep(scope)`,L328 才 `await Promise.all(prewarmParticipant)` —— sweeper 先于 prewarm arm
- `scope-manager.ts:167-170` TTL fire 仅判 `state==='creating'` 就 close,**不取消 prewarm**
- `scope-manager.ts:225-266` `prewarmParticipant` 全程无 `scope.state` 读取/guard
- `scope-manager.ts:536-559` `closeScopeInternal` 只 set state='closed',`rg 'scopes.delete'` 全仓 0 命中 —— closed scope 永久驻留 map
- `scope-manager.ts:118-132` `liveDriverProcessCount` 仅看 `entry.runtime`,不看 `scope.state`
- `scope-manager.ts:289-291` 配额判定用 `liveDriverProcessCount()+participants.length > QUOTAS.maxDriverProcesses`
- `contracts.ts:38` `QUOTAS.maxDriverProcesses = 16`
- 测试覆盖核查:`rg 'creating-ttl|scheduleCreatingSweep' tests/` 仅命中 `runtime-contract.test.ts:112` 常量值断言;FakeDriver(`tests/` `createFakeDriver` 的 `prewarm` 用 `Promise.resolve`)无慢 prewarm 注入 —— 无 create-vs-prewarm 竞争测试

## 追溯

- bug-hunter run:`~/.local/state/squad-bug-hunter/councilkit/runs/20260720T153529Z-7149e3af-752f/`
- engineering-handoff(JSON):`rot-runtime-host-scopes-001.handoff.json`(本目录)
- validator CONFIRMED verdict:7 gate 全 PASS(`production_entrypoint/production_reachability/contract_violation/closed_evidence/independent_validation/head_current/deduplicated`),证据见上
- 注意:bug-hunter 在 `7149e3a` 的后续 deep 重跑因模型非确定性 scout 跑空(0 candidate),此 bug 仅在首次 scout-rotation 出现;CONFIRMED 结论由独立静态核对(squad claude-only subagent)补强,非纯模型输出

## 修复结果(FIXED @ 9c91a8a)

squad `20260721-fix-scopes-1575`(claude-only,--simple)按 ticket suggested_fix 三层修复,集成入 main `9c91a8a`:

1. **prewarmParticipant scope.state 守卫**(scope-manager.ts):`await entry.driver.prewarm()` 后若 scope 已非 creating/active → 保持 runtime='cold'、清 binding/readiness、幂等 driver.close,不落 readiness 到 closed scope。
2. **createScope 兜底 sweep**:Promise.all 后若 scope closed/closing,清残留 ready/prewarming entry。
3. **liveDriverProcessCount 防御层**:排除 closed/closing scope,堵住配额泄漏直接根因。

验收:AC1(sweeper-closes-during-slow-prewarm → entry cold)+ AC2(20 连续慢 prewarm 创建无 RESOURCE_LIMIT)+ AC3(回归)全 PASS,typecheck + lint + 607 测试全绿。负向验证:移除各层对应 AC fail。Reviewer APPROVED(无 P0/P1/P2)。裁决遵守:无 scopes.delete、无 contracts.ts 改、无 fakeTimer、无其它 runtime-host 模块改。

squad 产物:`.squad/20260721-fix-scopes-1575/`(brief/plan/runs/reviews/verifications)。
