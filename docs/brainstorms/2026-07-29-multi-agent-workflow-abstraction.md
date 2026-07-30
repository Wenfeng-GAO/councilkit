# 多 Agent 工作流抽象:专门命令 vs 纯 prompt —— review / design 的命令形态设计

日期:2026-07-29
定位:设计讨论稿。回答「code review 该用专门命令还是纯 prompt」「未来 design 是否又要新写一个命令」两个问题,给出推荐架构与待拍板决策点。**不是实施计划,暂不动代码。**

## 0. 问题

当前 CouncilKit 只有一种工作流:串行多轮对话讨论(浏览器 Room 编排 / CLI `run` 命令)。两个待决问题:

1. 多 Agent 并行 code review(同时独立评审同一份 diff,再汇总对比)——该做一个专门的 `review` 命令,还是用户直接把「review 这个 PR + diff」写进 prompt、用现有 `run` 去做?
2. 推而广之:以后做方案设计(design)、debug、research…… 是否每来一个领域就要先实现一个对应命令?

## 1. 分析框架:一个「工作流」由什么组成

把 code review 这类工作流拆成五个组成部分,分别看 prompt 能否表达:

| 组成部分 | code review 的具体形态 | prompt 能否表达 |
|---|---|---|
| 输入通道 | diff/PR 全文(stdin/文件,体积守卫) | ❌ 现有 `--topic/--background` 是短字符串旗标,无文件/stdin 通道 |
| 轮次拓扑 | **并行盲评波 + 聚合 turn** | ❌ 现有 run 只有串行游标循环(浏览器 runLoop / CLI 均如此) |
| 指令模板 | reviewer 指令、聚合指令 | ✅ 这是 prompt 层面,唯一的重合点 |
| 报告形态 | 固定章节 + 确定性 per-reviewer 对比附录 | ❌ 附录是渲染逻辑,不能指望模型稳定产出 |
| 失败语义 | 单 reviewer 失败容忍,其余继续、聚合照常 | ❌ 现有 run 任一 turn 失败即整 run 中止 |

## 2. 三个候选形态

### 形态 A:纯 prompt(不建新命令)

用户:`councilkit run --agents '[...]' --topic "review this PR" --background "<diff 全文>" --reporter ...`。

表面上零开发能跑,但丢失的是**结构**而非内容:

- **Anchoring 摧毁独立评审。** round 1 是串行的,后面的 agent 能看到前面的发言。「多 Agent 评审」的核心价值恰是独立、多样的发现再对比——ADR-0010 明确推迟的 blind review 正是为此。串行可见 = 评审名存实亡。
- **慢 N 倍。** N 个模型串行执行;Host 本就支持同 scope 内 per-participant 并发(`maxConcurrentExecutions: 4`),纯 prompt 路线用不上。
- **失败即中止。** 任一 agent 失败整个 run 停,拿不到其余人的发现;评审场景「3 个里成了 2 个」仍有高价值。
- **无对比附录。** 报告只有 reporter 一家之言,没有确定性的「每人 findings 原文」附录,模型漏引即丢。
- 另有大体积 diff 塞进 `--background` 的转义/长度问题。

结论:纯 prompt 适合一次性、非正式的提问;**作为产品能力,它交付不了「独立评审 + 汇总对比」的承诺。**

### 形态 B:每个领域一个硬编码命令

`councilkit review`、`councilkit design`、`councilkit debug`…… 每个命令一个独立编排器。

结构保证最强,但粒度错误:每个新领域 = 新编排器,而引擎逻辑(scope 生命周期、persist-before-ACK、清理预算、退出码体系、transcript/报告落盘)大量复制;命令面与维护面同步爆炸。第二个领域落地时就会开始复制粘贴。

### 形态 C(推荐):拓扑引擎 + 工作流模板

观察各领域的真实差异:**80% 是数据**(指令文本、报告章节、输入通道、失败策略),**20% 是轮次拓扑**——而拓扑种类极少,目前可枚举为三种原语:

| 原语 | 语义 | 可见性 |
|---|---|---|
| `parallel-wave` | 所有 participant 同时独立执行一遍,互不可见(天然盲评,复用 Host per-participant 并发,≤4 分批) | 只见输入,不见彼此产出 |
| `serial-rounds` | 现有 discuss 的串行多轮,按序发言 | 可见此前全部发言 |
| `aggregate` | 一个 aggregator 看全部前序产出,做汇总对比(等价现有 Reporter turn) | 见全部 |

架构:

```
WorkflowTemplate(数据,注册在 cli/src/workflows/<name>.ts)
  = { name, inputChannels, topology: 原语序列,
      instructions(每种 turn 的指令模板), reportSections, failurePolicy }

workflow-orchestrator(一个引擎)
  = scope 生命周期 + 按 topology 执行原语
    + persist-before-ACK + 原子落盘 + 退出码体系
    (全部复用现有 runCouncil 已验收的机制)

councilkit review        = review 模板的薄命令层(参数解析 + --diff 读取)
councilkit design(未来)  = 新增一个模板文件 + 薄命令,不动引擎
```

- **review 模板**:topology = `[parallel-wave, aggregate]`;失败策略 = 单 reviewer 失败容忍(其余继续、聚合照常,全部失败才判 failed);报告 = 固定章节 + 确定性 per-reviewer 附录。
- **design 模板推演**(方案设计):盲提方案波(避免先入为主)→ 互评 1-2 轮(看到彼此方案后批评/补充)→ 聚合对比取舍。topology = `[parallel-wave, serial-rounds(n), aggregate]` —— 完全由三个原语组合,**不需要新引擎**。design 因此成为抽象的验证者:如果它只需要新增数据文件,抽象成立;如果需要改引擎,说明拓扑枚举不全,回头修正。

YAGNI 边界:V1 引擎从 review 的真实需求长出来,模板是代码内注册表,**不做** YAML 插件机制、不做用户自定义模板、不做浏览器端。

## 3. 关键设计点

1. **盲评即默认**:`parallel-wave` 原语内,participant 的快照只含输入项(topic/focus/diff 全文作为稳定首项 contextItem),天然满足 Host reconciler 的 append-only 约束(共享 items 全局只增不改)。这同时是 ADR-0010 推迟的 blind review 的首次落地——以 CLI 拓扑的方式,而非浏览器快照过滤的方式。
2. **输入通道是模板声明的**:review 声明 `--diff <path|->`(stdin 用 `-`,1MB 守卫,超限 usage 错误);未来 design 可能声明 `--brief <path>`。输入内容进入快照稳定首项,不进指令文本。
3. **失败策略是模板声明的**:review = reviewer 失败容忍(`reviewerFailures` 进 transcript 与 outcome,报告标 PARTIAL,聚合照常);discuss 保持现状(任一失败即中止)。这是对现有「失败即停」不变式的首次有界放宽,需在 ADR 中显式记录。
4. **报告 = 模型正文 + 确定性附录**:聚合 turn 产出对比章节(共识/独有/分歧/结论),渲染层追加 per-reviewer findings 原文附录——「汇总」靠模型,「对比不丢」靠渲染。沿用 render.ts 的确定性头部模式。
5. **transcript schema 不变**:wave turn 记 `role: "message"`,aggregate 记 `role: "report"`,避免 TRANSCRIPT_VERSION 迁移。
6. **复用不改造**:Host、driver、shared schema、浏览器端全部零改动;引擎复用 runCouncil 的 `TurnDriver` 注入、`executeTurn` 接线、`createRunCleanup`、原子落盘、退出码体系。

## 4. 待拍板决策点

| # | 决策点 | 选项 | 倾向 |
|---|---|---|---|
| 1 | 命令形态 | (a) 每模板一个 sugar 子命令(`councilkit review`/`design`);(b) 统一入口 `councilkit run --workflow <name>` | (a):模板少时参数更直白(`--diff` 有归属);模板超过 ~4 个再评估统一入口 |
| 2 | design 拓扑 | 盲提波 → 互评 n 轮 → 聚合;互评轮数与收敛规则 | 互评默认 1 轮,`--rounds` 可调;不做机械收敛(ADR-0011 是 discuss 的规则) |
| 3 | review 输入 | `--diff <path|->` 是否够用;是否要 `--pr <url>`(gh/antcode 集成) | V1 只做 `--diff`;`--pr` 留作后续增强 |
| 4 | 浏览器端 | 并行拓扑是否进浏览器 | 本设计只覆盖 CLI;浏览器端(并行 runLoop 改造 + 盲评快照过滤 + UI)单独立项,风险与工作量另评 |

## 5. 分期建议

- **V1**:workflow-orchestrator + review 模板 + `councilkit review` 命令;单测覆盖并发分批/失败容忍/聚合快照 append-only/persist-before-ACK;文档(AGENTS.md、README)。
- **V2**:design 模板(含互评轮)——验证抽象;若只需加数据文件,固化 `docs/adr/0014-workflow-topology-engine.md`。
- **V3+**(均不在本次范围):用户自定义模板、`--pr` 输入、浏览器端并行拓扑与对比 UI。

## 6. 对原始两个问题的直接回答

1. **要专门命令,但不是因为 prompt 不好,而是因为价值在结构里。** 盲评拓扑、输入通道、失败容忍、对比附录都不是 prompt 能表达的;纯 prompt 路线交付的是「 anchored 的串行读后感」,不是「独立评审 + 汇总对比」。
2. **不需要每个领域一个新引擎。** 正确抽象是「三种拓扑原语 + 数据化模板」:review 是第一个模板,design 是第二个,后者应当只新增模板数据与一个薄命令。如果做到这点,未来新领域的边际成本 ≈ 写一份指令模板 + 一组报告章节。
