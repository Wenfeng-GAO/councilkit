# CouncilKit 文档索引

本文档提供 CouncilKit 完整文档的导航指南，帮助你快速找到所需信息。

## 快速入口

### 我想...

- **快速上手** → [README.md](../README.md) 60 秒快速开始
- **用 CLI 审查 PR** → [AGENTS.md](../AGENTS.md) 最短路径
- **理解核心概念** → [CONTEXT.md](../CONTEXT.md) 术语权威定义
- **部署 Host 服务** → [Runtime Host 运维](host-operations.md)
- **查看审查报告** → [报告页与账本](report-page.md)
- **调试问题** → [Runtime Host 运维 - 诊断](host-operations.md#诊断包)

## 文档结构

### 入门文档

| 文档 | 用途 | 受众 |
|---|---|---|
| [README.md](../README.md) | 产品介绍、快速开始、文档导航 | 所有用户 |
| [AGENTS.md](../AGENTS.md) | Coding agent 的最短路径与硬约束 | Coding agents |
| [CONTEXT.md](../CONTEXT.md) | 领域词汇与边界的权威定义 | 开发者、技术写作 |

### 操作手册

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [CLI 手册](cli-handbook.md) | 完整命令参考、退出码、认证模型、审查流程 | 使用 CLI 时 |
| [Runtime Host 运维](host-operations.md) | 启动、launchd 托管、诊断、端口管理 | 部署或调试 Host 时 |
| [报告页与账本](report-page.md) | 审查报告查看、finding 决策、修复流程 | 审查 PR 后 |

### 设计文档

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [Runtime Host 设计](runtime-host-design.md) | 本地模型执行边界的详细设计 | 理解 Host 架构时 |
| [技术设计](technical-design.md) | 系统架构概览 | 理解整体架构时 |
| [产品文档](product.md) | 产品定位与功能概述 | 理解产品定位时 |

### 决策记录

#### 架构决策记录（ADR）

ADR 记录关键架构决策与历史背景。按时间倒序：

| ADR | 标题 | 关键点 |
|---|---|---|
| [0015](adr/0015-add-cursor-stream-json-driver.md) | Add cursor-stream-json driver | cursor-agent CLI 支持 |
| [0014](adr/0014-add-grok-stream-json-driver.md) | Add grok-stream-json driver | grok CLI 支持 |
| [0013](adr/0013-cli-as-orchestrator-with-separate-data-world.md) | CLI as its own orchestrator with a separate data world | CLI 独立编排、数据不互通 |
| [0012](adr/0012-add-cfuse-route-and-kimi-cli-driver.md) | Add cfuse route and kimi CLI driver | cfuse route + kimi 支持 |
| [0011](adr/0011-mechanical-convergence-rule.md) | Mechanical convergence rule | Facilitator 收敛建议机制 |
| [0010](adr/0010-discussion-modes-as-instruction-templates-blind-review-deferred.md) | Discussion modes as instruction templates | 讨论模式只改引导不改执行 |
| [0009](adr/0009-decision-report-as-first-class-persisted-entity.md) | Decision report as first-class persisted entity | Decision Report 持久化 |
| [0008](adr/0008-two-state-axes-for-room-and-round.md) | Two state axes for room and round | Room 门与 Round 状态分离 |
| [0007](adr/0007-negotiate-codex-capabilities-instead-of-pinning-versions.md) | Negotiate Codex capabilities instead of pinning versions | Codex 能力协商 |
| [0006](adr/0006-use-durable-round-state-and-idempotent-commit.md) | Use durable round state and idempotent commit | Round 幂等提交 |
| [0005](adr/0005-use-typed-runtime-profiles-instead-of-raw-commands.md) | Use typed runtime profiles instead of raw commands | Execution Profile 类型化 |
| [0004](adr/0004-separate-discussion-orchestration-from-model-execution.md) | Separate discussion orchestration from model execution | 编排与执行分离 |
| [0003](adr/0003-keep-councilkit-discussion-data-as-source-of-truth.md) | Keep CouncilKit discussion data as source of truth | Dexie 是唯一事实源 |
| [0002](adr/0002-snapshot-agent-configuration-in-room-participants.md) | Snapshot agent configuration in room participants | Participant 配置快照 |
| [0001](adr/0001-use-local-runtime-host-for-model-execution.md) | Use local runtime host for model execution | 本地 Runtime Host 架构 |

**何时阅读**：
- 理解为什么做这个设计决策
- 需要修改相关设计时
- 与历史架构对比时

#### Brainstorms（需求与设计讨论）

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [2026-09-20 Squad repair until approved requirements](brainstorms/2026-09-20-squad-repair-until-approved-requirements.md) | Squad 自动修复需求 | 理解 repair 功能时 |
| [2026-09-21 Repair convergence control requirements](brainstorms/2026-09-21-repair-convergence-control-requirements.md) | Repair 收敛控制需求 | 理解 repair 收敛机制时 |
| [2026-08-25 Squad observe handoff](brainstorms/2026-08-25-squad-observe-handoff.md) | Squad 观察交接 | 理解 squad observe 时 |
| [2026-07-29 Autonomous parallel review](brainstorms/2026-07-29-autonomous-parallel-review.md) | 自主并行审查设计 | 理解 review 架构时 |
| [2026-07-29 Multi-agent workflow abstraction](brainstorms/2026-07-29-multi-agent-workflow-abstraction.md) | 多 Agent 工作流抽象 | 理解工作流设计时 |
| [2026-07-29 Runtime capability tiers and ACP](brainstorms/2026-07-29-runtime-capability-tiers-and-acp.md) | Runtime 能力分层 | 理解能力分层时 |
| [2026-07-22 V1.1 product requirements](brainstorms/2026-07-22-v1-1-product-requirements.md) | V1.1 产品需求 | 理解 V1.1 功能范围时 |
| [2026-07-18 Next iteration directions](brainstorms/2026-07-18-next-iteration-directions.md) | 下一迭代方向 | 理解路线图时 |
| [2026-07-08 CouncilKit discussion MVP requirements](brainstorms/2026-07-08-councilkit-discussion-mvp-requirements.md) | CouncilKit 讨论 MVP | 理解核心功能时 |

### 验证记录

验证记录包含功能验收、测试记录与问题修复。按时间倒序（部分列表）：

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [2026-09-28 Review workspace v2](verification/2026-09-28-review-workspace-v2.md) | Review 工作区 v2 验收 | 理解 review 工作区时 |
| [2026-09-23 Review explainer final acceptance](verification/2026-09-23-review-explainer-final-acceptance.md) | Review 解释器最终验收 | 理解解释功能时 |
| [2026-09-21 Unified review problem list](verification/2026-09-21-unified-review-problem-list.md) | 统一 review 问题列表 | 理解 review 问题时 |
| [2026-09-21 Repair convergence control validation](verification/2026-09-21-repair-convergence-control-validation.md) | Repair 收敛控制验收 | 理解 repair 收敛时 |
| [2026-09-20 B0 execution identity](verification/2026-09-20-b0-execution-identity.md) | 执行身份推导 | 理解 execution identity 时 |
| [2026-07-18 Decision core acceptance](verification/2026-07-18-decision-core-acceptance.md) | Decision core 验收 | 理解决策核心时 |
| [Runtime host v1 cutover](verification/runtime-host-v1-cutover.md) | Runtime Host V1 切换 | 理解 V1 切换时 |

完整列表见 [verification/](verification/) 目录。

### 设计方案（Design）

详细的功能设计方案：

| 目录 | 内容 | 何时阅读 |
|---|---|---|
| [design/2026-09-22-squad-observability/](design/2026-09-22-squad-observability/) | Squad 可观察性设计 | 实现 squad observe 时 |
| [design/2026-09-20-review-workspace/](design/2026-09-20-review-workspace/) | Review 工作区设计（多版本） | 实现 review 工作区时 |

### 交接文档（Handoff）

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [handoff-2026-07-18-decision-core](handoff-2026-07-18-decision-core.md) | Decision core 交接 | 理解 decision core 交接时 |
| [handoff-2026-07-17-u5](handoff-2026-07-17-u5.md) | U5 交接 | 理解 U5 交接时 |

### 其他文档

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [roadmap.md](roadmap.md) | 产品路线图 | 了解未来规划时 |
| [repair-role-config.md](repair-role-config.md) | Repair 角色配置 | 配置 repair 角色时 |

## 按场景查找

### 场景：我想部署 CouncilKit

1. [README.md](../README.md) — 前置条件与快速开始
2. [Runtime Host 运维](host-operations.md) — launchd 托管
3. [CLI 手册](cli-handbook.md) — CLI 构建与安装

### 场景：我想用 CLI 审查 PR

1. [AGENTS.md](../AGENTS.md) — 最短路径
2. [CLI 手册 - 自主并行审查](cli-handbook.md#自主并行审查-review)
3. [报告页与账本](report-page.md) — 查看报告

### 场景：我想理解 CouncilKit 架构

1. [CONTEXT.md](../CONTEXT.md) — 术语定义
2. [技术设计](technical-design.md) — 架构概览
3. [Runtime Host 设计](runtime-host-design.md) — Host 详细设计
4. [ADR 0004](adr/0004-separate-discussion-orchestration-from-model-execution.md) — 编排与执行分离
5. [ADR 0013](adr/0013-cli-as-orchestrator-with-separate-data-world.md) — CLI 独立编排

### 场景：我想调试 Host 问题

1. [Runtime Host 运维 - 常见问题](host-operations.md#常见问题)
2. [Runtime Host 运维 - 诊断包](host-operations.md#诊断包)
3. [Runtime Host 运维 - 端口管理](host-operations.md#端口管理)

### 场景：我想理解审查报告与修复流程

1. [报告页与账本](report-page.md)
2. [CLI 手册 - 修复流程](cli-handbook.md#修复流程-fix--apply--repair)
3. [Brainstorm - Autonomous parallel review](brainstorms/2026-07-29-autonomous-parallel-review.md)
4. [Brainstorm - Squad repair until approved](brainstorms/2026-09-20-squad-repair-until-approved-requirements.md)

### 场景：我想添加新的 Runtime Driver

1. [ADR 0001](adr/0001-use-local-runtime-host-for-model-execution.md) — Runtime Host 架构
2. [ADR 0005](adr/0005-use-typed-runtime-profiles-instead-of-raw-commands.md) — Execution Profile 设计
3. [ADR 0007](adr/0007-negotiate-codex-capabilities-instead-of-pinning-versions.md) — 能力协商
4. [ADR 0012](adr/0012-add-cfuse-route-and-kimi-cli-driver.md) — cfuse + kimi 实现参考
5. [ADR 0014](adr/0014-add-grok-stream-json-driver.md) — grok 实现参考
6. [ADR 0015](adr/0015-add-cursor-stream-json-driver.md) — cursor-agent 实现参考

### 场景：我想理解 CLI 与浏览器的关系

1. [ADR 0013](adr/0013-cli-as-orchestrator-with-separate-data-world.md) — CLI 独立编排
2. [CONTEXT.md - Council vs Room](../CONTEXT.md#council) — 术语区分
3. [CLI 手册 - Host 依赖与例外](cli-handbook.md#host-依赖与例外)

## 文档维护指南

### 文档类型与更新策略

| 类型 | 更新时机 | 示例 |
|---|---|---|
| **入门文档** | 产品变化时同步更新 | README, AGENTS.md, CONTEXT.md |
| **操作手册** | 命令/流程变化时更新 | CLI 手册, Host 运维, 报告页 |
| **ADR** | 只追加，不修改历史 ADR | adr/*.md |
| **Brainstorm** | 只追加，历史文档标注"已实现"或"已取消" | brainstorms/*.md |
| **验证记录** | 只追加，不修改历史记录 | verification/*.md |
| **设计方案** | 实现后标注"已实现"，设计变更时新建版本 | design/*/*.md |

### 标注过时文档

当某个设计文档、需求文档或验证记录已过时时，在文件头部添加：

```markdown
> **状态**：已实现 / 已取消 / 已被 X 替代
> 
> 本文档记录了 [日期] 的设计/需求，已在 [版本/PR] 实现。当前实现见 [链接]。
```

### 新增文档时

1. 在对应目录创建文档
2. 更新本 INDEX.md 添加导航链接
3. 如果是入门文档或常用文档，也在 README.md 添加链接

## 贡献文档

欢迎改进文档！提交 PR 时请：

1. 保持中文文档，英文术语见 CONTEXT.md
2. 更新本 INDEX.md 的导航链接
3. 验证内部链接有效
4. 确保代码示例可执行

## 另见

- [GitHub Issues](https://github.com/Wenfeng-GAO/councilkit/issues) — 问题跟踪
- [GitHub Pull Requests](https://github.com/Wenfeng-GAO/councilkit/pulls) — 代码变更
