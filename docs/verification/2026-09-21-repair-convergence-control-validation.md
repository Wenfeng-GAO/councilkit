---
date: 2026-09-21
topic: repair-convergence-control
status: self-reviewed
---

# 修复链目标保持与收敛控制：Cursor 交付验证

本文件是 **Cursor self-review + 实测证据**，不是 Codex 最终验收。工作区 `/Users/hengzhuo/.codex/worktrees/repair-convergence-control/councilkit`，基线 `ad62658d6775497ea12a200dbc11702c9f86bab0`。

## R1–R9 完成矩阵

| Req | 状态 | 实现 | 证据 |
| --- | --- | --- | --- |
| R1 目标合同 | 已接线 | `shared/runtime/repair-contract.ts`；v2 启动写 `goal-contract.json` | `tests/unit/repair-contract.test.ts`；`cli/src/auto/repair-run.ts` v2 分支 |
| R2 裁决投影 | 已接线 | `repair-adjudication.ts` 供派工/进展/准出 | `tests/unit/repair-adjudication.test.ts` |
| R3 验收资产 | 部分 | 回执评估器已实现；循环仍以 review findings + journal 为主要准出证据，未把 Squad 测试 stdout 逐项收成 receipt | 合同单测拒绝脏树/skip/zero/builder 自证 |
| R4 单一写入 | 已接线 | execution ID、intent 落盘、无 commit 计派工、未知 writer 拒绝、可识别接管 | `repair-chain-execution.test.ts`；`repair-run.ts` `bindExecutionPids` |
| R5 跨 Run 预算 | 已接线 | `repair-chains/<id>.json` 继承；追加不清零；终验预留 `writeCutoff` | 同文件模拟时钟 |
| R6 进展/诊断 | 已接线 | v2 两次有效同源失败 → `same_root_cause`；格式/环境不计根因；无「无新增验收2次」停写 | `repair-isolation-progress.test.ts`；`repair-command.test.ts` v2 |
| R7 任务卡 | 已接线 | 由合同生成 `task-card.json`，不另存权威 | `generateTaskCard` + repair-run 写入 |
| R8 准出 | 已接线 | expected = `journalFromSquadStatus(官方 snapshot)`；未知身份保留 unknown；发布读回 | `repair-gate-assembly.test.ts` |
| R9 CLI/Host/UI | 已接线 | `--protocol/--isolation`；一键用已存 profile；面板原目标/覆盖/预算/interrupted≠业务终态 | `repair-command` 40；`repair-mutation` 14；`repair-run-panel` 14 |

## Self-review（诚实）

1. **Policy hash（已修）**：初版用自造 `REPAIR_GATE_POLICY_DOCUMENT` 哈希，与真实 Squad journal 不通。已改为冻结 `TRUSTED_SQUAD_GATE_STATUS_SNAPSHOT`（与 `tests/fixtures/squad-status-official.json` 相同对象），`frozenRepairGatePolicyHash()` = `journalFromSquadStatus(snapshot).gatePolicyHash`。装配永不复制 live candidate hash。
2. **隔离（已修）**：仅 probe sandbox-exec 不够。现 `SquadctlBridge.spawnChild` 在 strong 且未注入 fake spawn 时用 `sandbox-exec` 包住 Orchestrator（Builder 及其子进程测试）。SBPL 不能用 `(param HOME)` / `(subpath (literal …))`（Darwin 会 exit 65）。写路径必须 `realpath`（`/var` → `/private/var`）。凭据拒绝用最后规则 `(deny file-read* (regex #"/.ssh/"))`。
3. **Orchestrator 控制流**：live `squadctl` + `fake-grokb` 在 strong 下仍能拿到 `nativeSession`，且能写 worktree；控制面 `ledger.json` 不被 Builder/子测试改写。
4. **未做成的**：Linux 无 sandbox-exec → strong 启动拒绝（设计如此）。`evaluateVerificationAsset` 未消费真实 Squad 验证日志为 receipt。`consumeRetry(plan/format/verify)` 有预算字段，并非每条失败路径都递增。未跑真实 PR / 真实 push。Host `:43127` 已被 PID 41812 占用，未杀、未共用。无浏览器截图，UI 证据是组件测试。

## 真实检查

被测树 SHA（提交前 HEAD）：`ad62658d6775497ea12a200dbc11702c9f86bab0`。冻结 Squad policy：`b07590c09986aadf0b193743e3cf82026709003d2ffa8cec95a86ceaffbaf263`（与官方 fixture 映射一致）。

| command | exit | log |
| --- | --- | --- |
| `pnpm exec vitest run tests/unit … cli/tests/repair-*.test.ts tests/host/repair-mutation.test.ts` | 0 | `/tmp/councilkit-cursor-convergence-20260921/unit-host-repair.log`（76 files / 938 tests） |
| `pnpm exec vitest run tests/unit/repair-gate-assembly.test.ts` 等 | 0 | `repair-core-tests.log`（含 repair-command 40、host mutation 14） |
| `pnpm exec vitest run cli/tests/squadctl-bridge.adapter.test.ts cli/tests/repair-deadline-isolation.test.ts tests/unit/repair-isolation-progress.test.ts` | 0 | `isolation-bridge-4.log`（18 tests；含 live squadctl strong 隔离 + 父进程退出后 deadline） |
| `pnpm typecheck` | 0 | `typecheck-2.log` |
| `pnpm exec biome check`（本任务 34 文件） | 0 | `lint-task.log` |
| `pnpm lint`（全仓） | 1 | `lint.log`（既有 ideate-policy 等，非本任务文件） |
| `pnpm build:cli` | 0 | `build-cli-2.log` |
| `pnpm build:host` | 0 | `build-host.log` |

## 冒烟观察

- **准出正例**：官方 journal 映射 + 独立冻结 hash → `evaluateRepairGate.passed === true`。
- **准出反例**：live candidate 换成 `a{64}` 不能当 expected；`frozenPolicyHash: null` → `policy_unknown`；缺 base/prOpen/receipt → `identity_unknown`。
- **隔离**：Darwin `/usr/bin/sandbox-exec` 存在。候选探针不能写控制面、读 `~/.ssh`、网络发布。strong + 真 squadctl：Orchestrator 仍出 native session；Builder/子脚本不能改 `COUNCILKIT_HOME/ledger.json`。
- **deadline**：detached 监督进程在父进程退出后 SIGTERM sleeper，execution `deadline_enforced`。
- **v2 CLI**：`--pin-sha` 进入 follow-up review argv；两次同源失败 → `same_root_cause`。v1 仍逐轮发布、10 外循环。
- **Host**：`runtime-host/cli-launcher.ts` 仍只 spawn `councilkit repair run --profile`，不 spawn squadctl。`:43127` LISTEN pid 41812，未触碰。

## 运行能力范围

- strong OS 隔离：**Darwin + sandbox-exec**。
- 父死后 deadline：Darwin/Linux 监督进程模型；本机用 detached node 监督冒烟。
- 协作模式：必须 `--isolation collaborative` 或 v2 profile 显式字段；不静默降级。
- 无 sandbox 时 strong **拒绝启动**，不伪造成功。
