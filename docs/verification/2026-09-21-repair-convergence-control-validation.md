---
date: 2026-09-22
topic: repair-convergence-control
status: self-reviewed
---

# 修复链目标保持与收敛控制：Cursor 交付验证（acceptance-1 修正）

本文件是 **Cursor self-review + 实测证据**，不是 Codex 最终验收。工作区 `/Users/hengzhuo/.codex/worktrees/repair-convergence-control/councilkit`，基线 `ad62658d6775497ea12a200dbc11702c9f86bab0`。Codex 已独立拒绝 `689f6eb`；本批次是针对 `/tmp/councilkit-cursor-convergence-20260921/acceptance-feedback-1.md` 的聚焦修正。外部探针文件未改。

## R1–R9 完成矩阵

| Req | 状态 | 实现 | 证据 |
| --- | --- | --- | --- |
| R1 目标合同 | 已接线 | 合同只冻一次；chain 身份 = repo+prUrl+originalRequest，不吃 finding title；缺真实验收方法记 missingEvidence，不写占位完成 | `goalIdentityFingerprint`；`loadOrCreateChain` 按 PR 继承；`repair-run.ts` 复用 `goal-contract.json` |
| R2 裁决投影 | 已接线 | `ingestAdjudication` 持久化；同 ID 含义变则保留旧断言并绑新版本；`not_evaluated` 不再与 `verified_closed` 伪冲突 | `repair-adjudication.test.ts`；`assessment-correction.test.ts`；repair-run 写 `adjudication.json` |
| R3 验收资产 | 已接线 | 版本不符/未声明探针拒绝；独立隔离执行写 `verification/*.log`；gate 消费 asset | `evaluateVerificationAsset`；`assembleProductionGate` `verificationAssets`；`materializeIndependentVerification` |
| R4 单一写入 | 已接线 | 到期须 TERM→KILL→确认死亡才 `deadline_enforced`；停不掉或空 pid 保留 `unknown_writer` | `superviseDeadlineOnce`；deadline isolation 11 |
| R5 跨 Run 预算 | 已接线 | 同 PR 默认继承；source-fix 在锁内读最新 budget 再记账；diagnose/verify 走 `consumeLockedRetry` | `repair-chain-store.test.ts`；`repair-run.ts` |
| R6 进展/诊断 | 已接线 | 两次有效同源失败 → 诊断并消耗 diagnose 预算 | 既有 v2 路径 + `consumeLockedRetry("diagnose")` |
| R7 任务卡 | 已接线 | 由冻结合同生成；missingEvidence 如实列出 | `task-card.json` |
| R8 准出 | 已接线 | 删除全局 fixture expected；缺 frozen hash 生产装配拒绝；两份目录策略正例；官方 snapshot 只能显式 attest | `repair-gate-assembly.test.ts`；`cli/tests/repair-chain-store.test.ts` production wrapper |
| R9 CLI/Host/UI | 保持 | 本批次未改 UI；面板测试仍过 | `repair-run-panel` 14；`repair-mutation` 14 |

## Acceptance-1 六组

| ID | 修正 |
| --- | --- |
| F1 | `assembleProductionGate(null)` → `policy_unknown`。目录策略 v1/v2 各自哈希，匹配则过、替换则拒。 |
| F2 | chain 按 repo+prUrl 继承，finding 改标题不清预算。 |
| F3 | 持久裁决 + diagnostics 弃权语义。 |
| F4 | receipt 版本必须等于 asset；独立执行回执进 gate。 |
| F5 | kill 失败不再 `deadline_enforced`；锁内消费 source-fix。 |
| F6 | 最后规则拒绝 `.config/gh`；去掉 `/tmp` 全写；strong+allowNetwork 读 dummy gh hosts.yml 被拒。 |

## Self-review（诚实）

1. 控制器目录策略哈希 **不等于** 官方 Squad fixture `b07590c…`。后者只能经 `attestTrustedSquadPolicy(trustedStatus)` 显式冻结，不再当全局默认。活候选 journal 仍只作 observed。
2. 没有 `verification.command` 的 finding 不会被编成假验收方法；gate 不要求空资产。有 command 时才跑隔离执行并绑定 receipt。
3. `consumeRetry("plan"|"format")` 仍少独立生产调用点（当前循环没有单独的 plan/format execution）。diagnose 与有验证资产时的 verify 已接线。
4. 外部探针 `/tmp/councilkit-cursor-convergence-20260921/codex-acceptance-probes.ts` **未修改**。对应反例已移植进仓库测试。
5. Host `:43127` 仍占用，未杀。本批次无 UI 代码变更，无新浏览器截图。
6. 未跑真实用户 PR / 真实 push。`squadctl-bridge.adapter` 使用临时 bare remote。

## 真实检查

| command | exit |
| --- | --- |
| `pnpm exec vitest run`（gate/contract/adjudication/chain/isolation/deadline/repair-command/chain-store/assessment-correction/squadctl-adapter/host-mutation） | 0（124 tests） |
| `pnpm exec vitest run tests/unit/repair-run-panel.test.ts` | 0（14） |
| `pnpm typecheck` | 0 |
| `pnpm exec biome check`（本任务文件） | 0 |
| `pnpm build:cli` | 0 |
| `pnpm build:host` | 0 |

强隔离冒烟：Darwin `sandbox-exec` 下 `cat $HOME/.config/gh/hosts.yml` 非 0 且无 sentinel；squadctl adapter 3 tests 含临时 remote。
