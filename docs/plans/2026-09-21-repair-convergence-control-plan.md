---
title: "feat: repair convergence control (goal hold + bounded execution)"
type: feat
status: implemented
date: 2026-09-21
origin: docs/brainstorms/2026-09-21-repair-convergence-control-requirements.md
---

# feat: 修复链目标保持与收敛控制

## Overview

在现有 `repair` 控制器、Squad 桥、journal、CLI/Host/UI 上落实有界修复协议。权威数据仍是四类逻辑投影（目标合同、经裁决验收清单、执行记录、准出回执），不新建工作流引擎。v2 为显式 opt-in；v1 profile 的外循环数值、全部非有效 accepted 准出、逐轮发布语义不静默迁移。

## Requirements Trace

| Req | 交付 | 验收 |
| --- | --- | --- |
| R1 目标合同 | `repair-contract.ts` + 父 Run 落盘；写源码前冻结 | 合同含原请求/范围/不变量/验收观察方法/策略引用；削弱验收须显式授权 |
| R2 裁决投影 | `repair-adjudication.ts`；派工/进展/准出共用 | 原始 finding 不绕过；E1/E2 分断言；别名不增根因；not_evaluated ≠ 反证；缺映射不能准出 |
| R3 验收资产 | 合同项绑定 snapshot+test asset+执行回执 | 零测试/全 skip/脏树 SHA/手写 PASS 不准出；合法纠错可恢复 |
| R4 单一写入入口 | execution ID + 原子许可/预算/租约 | 意图后崩溃不双开；无 commit 仍计派工；有效失败后再改=新派工 |
| R5 跨 Run 预算 | `repair-chains/<id>.json` 继承 | 同 PR 同目标续链不清零；显式追加保留已用量 |
| R6 证据进展 | 根因失败计数 + 只读诊断 | 两次有效源码失败→诊断；格式/环境不计根因；无「无新增验收 2 次」停写 |
| R7 任务卡 | 由合同/清单/执行记录生成 | 不另存权威状态；过期重生成 |
| R8 准出 | 冻结 policy hash + 未知身份事实 + 发布读回 | 候选不能自证 expected；缺 source/base/prOpen/receipt 保留未知；采用既有远端可过 |
| R9 界面 | CLI/Host/UI 投影 | 原目标/覆盖/根因/预算/恢复动作；interrupted ≠ 业务终态 |

## Key Technical Decisions

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 可信 policy | 控制器冻结 `REPAIR_GATE_POLICY_DOCUMENT` 的 SHA-256；装配时作 expected，永不复制候选 journal hash | Pro 修订：候选自证 expected 非法 |
| 身份事实 | `Fact<T> = known \| unknown`；assemble 不把缺省变成 true | 现 parser 允许缺 baseSha/prOpen |
| v2 profile | 可选 `protocolVersion: "v2"` + 独立 protocolHash；缺省=v1 | 不改现有 integrityHash |
| v2 试运行默认 | 3 次源码派工 / 2h 总时限 / 15min 诊断；可配置 | 不写进用户已存 profile |
| 发布路径 | v1 逐轮发布；v2 本地固定候选审查 → 受控发布 → 远端核验 | 须补 `--pin-sha` 真实 review，不用 fake |
| 隔离 | Darwin `sandbox-exec` 为强模式最小实现；不可用则强模式启动拒绝；协作模式须显式 | env/worktree/prompt 不是 OS 隔离 |
| 期限监督 | 脱离父进程的 deadline supervisor（detached） | 父控制器死亡后仍落实；不支持则降低保证并拒绝强期限承诺 |
| 终验预留 | writeCutoff = deadline − reservedFinalMs | 不足不再开写；已有合格候选可完成终验 |

## Implementation Units

1. **A 生产准出装配** — policy hash、identity facts、`assembleRepairGateInput`、production-shaped tests。
2. **B 裁决与合同** — 验收投影、目标合同、验证资产、任务卡。
3. **C 链与执行** — chain 继承、原子授权、幂等 execution、deadline、隔离 runner。
4. **D v2 路径与界面** — pin-sha 审查、诊断路由、发布读回、CLI/Host/UI。

## Out of Scope

- 不建通用工作流引擎；不改用户 COUNCILKIT_HOME/现存 profile/真实 PR。
- 不重审 agentrun #128；不修改已安装 skill。
- 复杂根因自动聚类、独立任务卡存储、多 adapter 同时铺开延后。
