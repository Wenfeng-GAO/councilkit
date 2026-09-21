---
date: 2026-09-22
topic: repair-convergence-control
status: self-reviewed
---

# 修复链目标保持与收敛控制：Cursor 交付验证（官方 freeze + 候选独立验收）

本文件是 **Cursor self-review + 实测证据**，不是 Codex 最终验收。工作区 `/Users/hengzhuo/.codex/worktrees/repair-convergence-control/councilkit`，基线 `6c9a8d5a474bf1773896229f56acd9efc2c3c304`。本批次针对 `/tmp/councilkit-cursor-convergence-20260921/implementation-after-diagnosis.md`：官方 `squadctl gate policy-freeze`、候选快照/独立验证、`code_trace` 进同一必需验收、verify 预算前置、整条真实 Squad strong 启动前拒绝、collaborative 真实可用、临时仓 v2 闭环与独立端口 UI 冒烟。已闭合叶子反例未重开。外部探针文件未改。未触用户 Host `:43127`、真实 `COUNCILKIT_HOME`、真实 PR。

## R1–R9 完成矩阵

| Req | 状态 | 实现 | 证据 |
| --- | --- | --- | --- |
| R1 目标合同 | 保持 | 合同只冻一次；chain 身份 = repo+prUrl+originalRequest | 既有路径未回退 |
| R2 裁决投影 | 保持 | `ingestAdjudication` 持久化版本 | 既有单测未回退 |
| R3 验收资产 | 已接线 | 控制器 detached candidate checkout；实测 HEAD/dirty；cache = SHA+assertion+test-asset 版本；command receipt 与 `code_trace`(locations+source) 同进 required；无 command 不消失；verify peek+consume 在未缓存命令执行前 | `repair-candidate-verify.ts`；`repair-v2-closed-loop.test.ts`；`repair-chain-store.test.ts` peek |
| R4 单一写入 | 保持 | 到期须确认死亡才 `deadline_enforced` | 既有 deadline 测试 |
| R5 跨 Run 预算 | 已接线 | verify 额度耗尽则不执行命令；budget 0 用例无命令日志 | `repair-v2-closed-loop.test.ts` budget-0 |
| R6 进展/诊断 | 保持 | 同源失败诊断消耗 diagnose | 既有路径 |
| R7 任务卡 | 保持 | 由冻结合同生成 | 既有路径 |
| R8 准出 | 已接线 | 生产 expected 只绑官方 freeze 记录；CK catalog / candidate 自报 / fixture hash 不是 expected；live A/B freeze 各自合法且互不等；同 task 二次 freeze 非 0 | `squad-gate-policy.test.ts`（live squadctl）；`bindOfficialExpectedPolicy`；adapter collaborative freeze 文件 |
| R9 CLI/Host/UI | 已接线 | v2 `--isolation strong` usage 拒绝；bridge `prepare` 在写源码前拒绝；collaborative 清除凭据并真实 freeze；面板文案诚实 | `repair.ts`；`squadctl-bridge.ts`；`RepairRunPanel.tsx`；独立端口 4188 静态截图 |

## 本批次核心

| ID | 结果 |
| --- | --- |
| 官方 freeze | 控制器调用 `squadctl gate policy-freeze --policy-file --json`；持久化 `councilkit-policy-freeze.json`；崩溃恢复读已登记 intent + 不可变 freeze，不盲目再 freeze |
| 候选独立验收 | `ensureCandidateSnapshot` 在 source HEAD ≠ candidate SHA 时 detached worktree；日志带 `sha=`/`dirty=`/`cache=`；缺快照 = unknown |
| 预算前置 | 仅当存在未缓存命令时 peek+consume；耗尽停在执行前 |
| strong | CLI / `assertSquadPipelineIsolation` / `SquadctlBridge.prepare` 均拒绝；`canDenyPublish=false`；不静默降级 |
| collaborative | adapter 临时仓可 freeze 且官方 hash ≠ catalog hash |
| v2 闭环 | 临时仓+bare remote：source≠candidate 准出、第二 SHA 重测、policy mismatch、budget 0 不执行、缺快照 unknown、v1 旧路径、strong CLI 拒绝 |
| UI 冒烟 | `127.0.0.1:4188` 静态面板文案截图 `/tmp/councilkit-cursor-convergence-20260921/ui-smoke.png`。**不是** live Host `:43127` |

## Self-review（诚实）

1. 官方 policy hash 是 Squad freeze 对 canonical `{schema_version, brief_hash, required_gates, independence[, delivery_authority]}` 的 SHA-256。CK catalog hash 仍存在于最低准出目录，但生产 `expected` 不再绑它。
2. UI 冒烟是独立端口静态 HTML（含诚实 isolation 文案），不是完整 Host 报告页。Host 仍硬编码 43127，本批次未起第二 Host。
3. 候选命令 sandbox-exec 仍可作为局部加固写在 command receipt 的 mode 字段；**不**等于整条 Squad 流水线 strong。
4. `plan`/`format` 仍无独立 `consumeRetry` 调用点；由整段 deadline + 有限重试覆盖，不声称虚假计数器。
5. FakeSquad / fake-grokb 是明确标识的 agent 边界 fixture；官方 freeze 与 git/verify/persist 走真实控制器。live freeze 用 `/tmp/councilkit-squad-bridge-20260921/skill-history-worktree/hengzhuo-engineering-squad/scripts/squadctl`。
6. 未跑真实用户 PR / 未 push / 未改已安装 skill / 未占杀 43127。

## 真实检查

| command | exit |
| --- | --- |
| `pnpm exec vitest run`（10 files：gate-policy / candidate-verify / repair-command / v2-loop / chain-store / squadctl-adapter / contract / isolation） | 0（98 tests，先前批次） |
| `pnpm exec vitest run cli/tests/repair-command.test.ts cli/tests/repair-v2-closed-loop.test.ts cli/tests/squad-gate-policy.test.ts` | 0（50 tests） |
| `pnpm typecheck` | 0 |
| `pnpm exec biome check`（本任务文件） | 0 |
| `pnpm build:cli` | 0 |
| `pnpm build:host` | 0 |
| UI screenshot `127.0.0.1:4188` | 文件存在（31499 bytes） |
