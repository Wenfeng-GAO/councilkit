---
date: 2026-09-22
topic: repair-convergence-control
status: self-reviewed
---

# 修复链目标保持与收敛控制：Cursor 交付验证（四组边界）

本文件是 **Cursor self-review + 实测证据**，不是 Codex 最终验收。工作区 `/Users/hengzhuo/.codex/worktrees/repair-convergence-control/councilkit`，基线 `faa3de47e070b33d9384e5c6bb0bb709b9d3f7b8`。只修 `/tmp/councilkit-cursor-convergence-20260921/final-edge-feedback.md` 四组边界；官方 freeze 与 detached 候选快照方向保留。未触用户 Host `:43127`、真实 `COUNCILKIT_HOME`、真实 PR。外部探针未改。

## 四组边界

| ID | 结果 |
| --- | --- |
| 1 恢复须有落盘 intent | `recoverWrittenFreeze` 只读 `councilkit-policy-intent.json`；弱 journal、无 intent、caller 换政策、投影被篡改均拒绝。完整 freeze 文件在父 receipt 丢失后仍可恢复。 |
| 2 验证缓存身份 | `receiptFromIsolatedLog` 解析 header（sha/cache/cwd/command），全部同时匹配；日志按 cacheKey 分文件。执行后实测 HEAD/dirty；命令改 tracked 源码则不准出。命令 timeout 走剩余 deadline，TERM 后 KILL。 |
| 3 AntCode baseSha | 元数据无 `baseSha` 时对 **target 仓库** + `target_branch` 做只读 `ls-remote`；fork 不猜 source 同名分支；解析失败保持 unknown。 |
| 4 真实 React UI | Vite `127.0.0.1:4188` + Playwright，API fixture 标明受控，abort 所有 43127。验证启动表单 collaborative 显式选择、strong disabled、needs_attention 恢复按钮。截图 `ui-smoke.png`。 |

## R1–R9

R1/R2/R4/R6/R7 保持。R3/R5 补执行后快照与有界取消。R8 补 intent 绑定恢复。R9 补真实面板入口与隔离选择。

## Self-review（诚实）

1. 官方 freeze 路径未回退。projection-only 恢复要求 canonical hash 与 intent 一致；完整 freeze 文件以官方 stdout `policy_hash` + intent 内容为准（live squadctl 规范化可能与 CK canonical 不完全同构）。
2. UI 冒烟是独立端口真实 React，不是 Host `:43127`。Vite HMR websocket 在 Chromium 本地网络限制下失败，测试已过滤该噪声，不是产品错误。
3. `plan` / `format` 不是未接线的执行器。`cli/src` 全库只有两处生产 `consumeLockedRetry`：`repair-run.ts` 的 `materializeIndependentVerification` 在未缓存验证命令前占用 `verify`；`handleFailedGate` 在同根因停机前占用 `diagnose`，随后直接 `needs_attention`，没有诊断子进程。`consumeLockedRetry("plan"|"format")`、`classifyFailure` 均无生产调用。规划与格式补证没有可重复的模型/命令入口，因此不新增循环；`planRetry*` / `formatRetry*` 只是链 JSON 的持久字段，不是运行时限额。
4. 环境恢复是同一写入槽的 `resumeSlot`：已占用的 `sourceFixUsed` 不第二次递增。已启动的周期若 resume 被拒，`cycleAlreadyLaunched` 直接停机，不再 `prepare`。没有独立的环境重试执行器，因此不新增额度字段。
5. 未跑真实用户 PR / 未 push。

## 767bb86 后续

发布授权：`policyWithFrozenDelivery` 只在 `delivery-authority.json` 与 `councilkit-pr-profile.json` 的 canonical grant 一致时写入官方 policy；`SquadctlBridge.policyFileForTask` 使用该结果。恢复时投影若发明、漂移或丢掉已登记 grant，则拒绝。官方 `squadctl integrate push-remote` 在临时 repo + bare remote 上验证：无冻结授权拒绝且远端不变；漂移 `authority_ref` 拒绝且远端不变；匹配 grant 后远端 SHA 等于候选。

## 真实检查

| command | exit |
| --- | --- |
| vitest（gate-policy / candidate-verify / checkout-pr / v2-loop / panel / host-mutation）于 `767bb86` | 0（60 tests，Codex 复跑；本轮未重跑） |
| `pnpm typecheck` / `pnpm build:cli` / `pnpm build:host` 于 `767bb86` | 0 |
| Playwright UI 于 `767bb86` | 0（1 test；本轮纯后端未重跑） |
| vitest `squad-gate-policy` + `repair-v2-closed-loop` + `squadctl-bridge.adapter` | 0（19 tests） |
| `pnpm typecheck` | 0 |
| 日志 | `/tmp/councilkit-cursor-convergence-20260921/logs/gap-affected.log`、`gap-typecheck.log` |
