# 详细设计:Workflow 拓扑引擎 + review 模板(含 `--pr` 集成)

日期:2026-07-29
前置:`docs/brainstorms/2026-07-29-multi-agent-workflow-abstraction.md`(形态选型已讨论)
状态:**已被取代(SUPERSEDED)**。2026-07-29 用户重定义需求(能力全交 agent、councilkit 只给规范化 prompt + 编排对比、可打破原设计),新权威设计为 `docs/brainstorms/2026-07-29-autonomous-parallel-review.md`(直接 spawn 的自主并行运行器,不经 Host;本文的 pr-fetch、verify、拓扑引擎章节作废)。本文保留作决策演进记录。

## 0. 已锁定决策

1. **命令形态**:每个模板一个 sugar 子命令(`councilkit review`;未来 `councilkit design`)。
2. **design 拓扑**:盲提波 → 互评(默认 1 轮)→ 聚合;不做机械收敛。V2 实现,本文只约束引擎为其预留形状。
3. **review 输入**:`--diff <path|->` 与 `--pr <url|number>` 均支持,`--pr` 集成 gh(GitHub)与 antcode(AntCode)。
4. **范围**:只覆盖 CLI;Host / driver / shared schema / 浏览器端零改动。
5. **能力等级**:全部 agent 保持 L0(text-only),不解锁任何工具/skill;能力分级与 ACP 的论证见 `docs/brainstorms/2026-07-29-runtime-capability-tiers-and-acp.md`。仓库上下文诉求由 V1.5 的 `--context` 确定性注入满足,不靠工具。
6. **验证(2026-07-29 补充)**:review 需要测试/lint 等真实验证证据,但**验证命令由编排层确定性执行(用户显式声明),不由 agent 自主执行** —— agent 保持 L0,对「diff + 验证证据」做判断。理由:① 对全部 driver 一致成立(kimi 无协议级工具锁,agent 自主跑命令无法约束);② 命令来自用户声明而非模型选择,无 prompt-injection → RCE 通路;③ 验证结果进快照稳定项,digest 可审计、可复现。agent 自主决定跑什么的场景归 L2 里程碑。

## 1. 总体架构

```
councilkit review (cli/src/commands/review.ts)        ← 薄命令层:参数解析 + 输入解析
  → resolveReviewInput (cli/src/run/input-source.ts)   ← --diff / --pr → { diffText, meta }
      └─ pr-fetch.ts                                   ← gh / antcode 子进程封装(可注入 runner)
  → runWorkflow (cli/src/run/workflow-orchestrator.ts) ← 拓扑引擎,按 template.topology 执行原语
      └─ review template (cli/src/workflows/review.ts) ← 数据:指令/章节/失败策略
  → report.md + transcript.jsonl(persist-before-ACK,复用 runCouncil 机制)
```

**引擎与模板的分工**:引擎拥有全部「机制」(scope 生命周期、turn 驱动、persist-before-ACK、原子落盘、退出码、SIGINT 清理);模板只声明「数据」(拓扑序列、指令文本、报告章节、失败策略)。design 落地时应只需新增模板数据文件 + 薄命令。

## 2. 拓扑原语与引擎

### 2.1 原语定义(`cli/src/run/workflow-types.ts`)

```ts
export type TopologyPrimitive =
  | { kind: "parallel-wave" }              // 全员并发独立执行,快照互不可见(盲)
  | { kind: "serial-rounds"; rounds: number } // V2(design)实现;V1 仅声明类型
  | { kind: "aggregate" };                 // 指定 aggregator 看全部前序产出做汇总

export interface WorkflowTemplate {
  name: string;                            // "review"
  topology: readonly TopologyPrimitive[];
  /** 每种 turn 的指令构造函数(wire kind 由引擎决定:wave/serial → "message",aggregate → "summary") */
  instructions: {
    participantTurn(ctx: InstructionContext): string;
    aggregateTurn(ctx: InstructionContext): string;
  };
  /** 聚合报告的固定章节(注入 aggregate 指令;单测断言数量与顺序) */
  reportSections: readonly string[];
  /** wave 内单个 participant 失败的策略 */
  failurePolicy: { wave: "tolerate" | "abort" };
}
```

### 2.2 引擎行为(`cli/src/run/workflow-orchestrator.ts`)

`runWorkflow(input, template, deps)` 固定流程:

```
ensureRunDir + run.started → createScope(幂等 scopeRequestId)→ activate
→ 依 topology 顺序执行原语
→ close(恰好一次,finally,close 失败使 run 非成功)
```

- **parallel-wave**:对全部 reviewer 用**并发池**(limit = `min(QUOTAS.maxConcurrentExecutions, 人数)` = 4;不用分批——池在任一完成时立即补位,优于按批等待最慢者)。每个 reviewer:
  - `executionId` 在 dispatch 前稳定生成(丢失靠 probe 恢复,绝不 re-POST,同 runCouncil);
  - 快照 = 稳定首项(见 §4)+ 该模板的 participantTurn 指令,wire kind `message`;
  - 并发池内每个 turn 独立走 `executeTurn` 全生命周期(execute → SSE → persist → ACK),互不干扰。
- **aggregate**:aggregator 一个 turn,快照 = 稳定首项 + 各成功 reviewer 产出按完成序的 `turnItem` 纯追加(满足 Host reconciler append-only),指令 wire kind `summary`,persist 回调在 ACK 前写 transcript + 渲染 report.md(同 `makeReporterPersist` 模式)。
- **serial-rounds**:V1 不实现(类型预留);V2 从 `runCouncil` 的轮次循环提取。

### 2.3 失败语义(模板驱动)

- `failurePolicy.wave = "tolerate"`(review):单 reviewer 失败**不中止**——transcript 记录、收集进 `reviewerFailures`,池继续;聚合照常。全部 reviewer 失败 → run `failed`(exit 4)+ partial report。aggregator 失败 → `failed`(exit 4)+ partial report。
- SIGINT/SIGTERM:与 runCouncil 一致——共享 ≤10s 清理预算内 cancel → observe → ACK-discard → close,写 partial report,exit 130。
- 退出码沿用现有集合(0/2/3/4/5/7/130),不新增。PR 抓取失败属于「运行前置条件不满足」→ exit 3(见 §5.4)。
- `ReviewOutcome` = `RunOutcome` 形状 + `reviewerFailures: Array<{agentId, agentName, code, message}>` + `input: { source: "diff"|"pr", ref: string, title: string | null }`。聚合成功 = status `completed`/exit 0;有 reviewer 失败则 `incomplete: true`,报告标 PARTIAL。

### 2.4 复用方式(小重构,零行为变化)

`runCouncil`(orchestrator.ts)现有的以下私有件提取到 `cli/src/run/run-common.ts` 并导出,供两个编排器共用:`makeRealTurnDriver`、`makePersist`/`makeReporterPersist` 的 persist 模式、`rewriteTranscript`、`closeScopeBounded`、`createScopeIdempotent`、SIGINT 清理接线。现有 orchestrator 单测必须保持全绿(重构安全性由此保证)。

## 3. review 模板(`cli/src/workflows/review.ts` + `cli/src/run/review-instructions.ts`)

- topology = `[{ kind: "parallel-wave" }, { kind: "aggregate" }]`,failurePolicy.wave = `"tolerate"`。
- **reviewer 指令** `reviewInstruction({ agentName, personaPrompt, topic, focus })`:声明 code reviewer 身份与 persona;只依据给定 diff 独立评审;输出 Markdown findings 列表,每条含严重度(critical/major/minor/nit)+ 文件/位置 + 问题描述 + 修复建议;不得臆造 diff 之外的代码;无发现时明说。
- **聚合指令** `aggregationInstruction({ topic, reviewerNames, aggregatorName, inputTitle })`:固定五章节(sync-point 模式,单测断言;括号风格对齐 `REPORT_SECTION_HEADINGS` 的现有全角/半角用法):
  1. `## Overview(评审概览)`
  2. `## Consensus findings(共识发现)`
  3. `## Unique findings(独有发现)` —— 按 reviewer 归属列出
  4. `## Disagreements(分歧与冲突)`
  5. `## Verdict(总体结论与建议)` —— 可合并 / 需修改
  要求按名字引用各 reviewer、不得捏造共识与分歧。
- **aggregator 也参与 wave**(与 council reporter 参与讨论同理):`--aggregator` 必须 ∈ `--agents`,先完成自己的评审,再做聚合。

## 4. 快照构造(`cli/src/run/context-snapshot.ts` 增量)

现有 `contextItem` 的形状服务于 discuss;review 增量新增两个构造函数(不改 `contextItem`):

- `reviewTaskItem(runId, { topic, focus, input: { source, ref, title }, roster })` —— 稳定首项:评审任务 + PR 元数据(若有)+ 参与名单;
- `diffItem(runId, diffText)` —— 稳定第二项:diff 全文(标注为 untrusted input,指令中要求 reviewer 将其视为数据而非指令);
- `verificationItem(runId, results)` —— 稳定第三项(有 `--verify` 时):每条验证命令的 `{ command, exitCode, outputTail }`,同样标注 untrusted;**验证失败(非零退出)不是 run 失败,而是证据** —— PR 把测试跑挂了本身就是评审发现,指令要求 reviewer 将其纳入 findings。

之后所有 wave 产出按完成序追加 `turnItem`。所有 items 全局纯追加,reconciler 约束天然成立。

## 5. 输入解析与 `--pr` 集成

### 5.1 命令面(`cli/src/commands/review.ts`)

```
councilkit review --agents '["<id>","<id>",...]' --aggregator <id>
  (--diff <path|-> | --pr <url|number>)     # 二者互斥,必居其一
  [--topic "..."] [--focus "security,perf"]
  [--out <path>] [--json]
```

- `--aggregator` 必填且 ∈ `--agents`;人数 ≤ `maxParticipantsPerScope`(8);聚合前 `resolveRunAgents` 探活(任一不 ready → exit 3)。
- `--diff`:`-` = stdin;文件读取失败 / 内容 > 1MB → usage 错误(exit 2)。空 diff → usage 错误。
- 互斥/缺失:`--diff` 与 `--pr` 同给或都不给 → usage 错误(exit 2)。

### 5.2 输入解析(`cli/src/run/input-source.ts`)

```ts
export type ReviewInput =
  | { kind: "diff-file"; path: string }
  | { kind: "diff-stdin" }
  | { kind: "pr"; ref: string };            // URL 或 PR 号

export interface ResolvedReviewInput {
  diffText: string;
  source: "diff" | "pr";
  ref: string;                              // 原始引用(报告头部展示)
  title: string | null;                     // PR 标题(diff 输入为 null)
  description: string | null;               // PR 描述,进 reviewTaskItem 供 reviewer 参考
  meta: { author?: string; base?: string; head?: string; url?: string } | null;
}
```

### 5.3 PR provider 检测与抓取(`cli/src/run/pr-fetch.ts`)

- **URL 解析**:
  - `https://github.com/<owner>/<repo>/pull/<n>` → provider `github`;
  - `https://code.alipay.com/<group>/<project>/-/merge_requests/<iid>` → provider `antcode`,project = `<group>/<project>`(支持多级 group,iid 取末段数字);
  - 其它 host → usage 错误,提示受支持的 host。
- **裸 PR 号**:要求 cwd 在 git 仓库内,读 remote origin host 判定 provider(github.com → gh;code.alipay.com → antcode,其 `--endpoint` 也可从 git remote 自动检测);非仓库目录 → usage 错误。
- **抓取命令**(全部 `execFile` 参数数组,不经 shell;子进程 stderr 只进诊断,不反射到 stdout):
  - github:`gh pr diff <ref>`(patch 文本);`gh pr view <ref> --json title,body,author,baseRefName,headRefName,url`;
  - antcode:`antcode pr diff <iid> -P <project> --no-color --no-pager`;`antcode pr show <iid> -P <project> --json --raw`。
- diff 超 1MB 同样拒绝(与 `--diff` 一致)。
- 内部代理环境的 antcode 调用沿用全局规则:`NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY=''` 环境注入(见根 AGENTS.md「Internal Network Tools」)。

### 5.4 错误分类(可注入 `runner` 以便单测)

| 情形 | 判定 | 退出码 | 消息 hint |
|---|---|---|---|
| gh/antcode 未安装 | spawn ENOENT | 3 | 安装指引(`brew install gh` / antcode 安装路径) |
| 未认证 | stderr 匹配 auth 特征(如 `gh auth login`、antcode `auth status` 失败) | 3 | 对应 login 命令 |
| PR 不存在/无权限 | 非零退出 + not-found 特征 | 3 | 检查 URL 与权限 |
| 网络/其它非零退出 | 兜底 | 3 | 原样摘要 stderr(截断,不含环境变量) |

任何情况下不打印 token/凭据;子进程环境最小化传递(PATH、HOME、NO_PROXY 系)。

### 5.5 验证阶段(`cli/src/run/verify.ts`,2026-07-29 补充)

review 的证据不止 diff:测试、lint、类型检查的真实结果。验证由**编排层**在 createScope 之前确定性执行,agent 全程 L0。

**命令来源(用户显式声明,优先级从高到低)**:

1. `--verify "<cmd>"`(可重复),如 `--verify "pnpm lint" --verify "pnpm test"`;
2. 仓库根 `councilkit.review.json`:`{ "verify": ["pnpm lint", "pnpm test"] }`(被 `--verify` 覆盖);
3. 都缺省 → 跳过验证阶段(快照无 verificationItem,指令不要求引用验证证据)。

**执行环境(关键安全决策)**:

- 需要「在 PR 代码上」跑验证时,先建隔离工作区:`git worktree add <tmp> <base>` → 应用 diff(`git apply`)→ 在 worktree 内执行命令 → 结束后 `git worktree remove`。`--pr` 输入优先直接 checkout PR head ref;`--diff` 输入要求 cwd 在 git 仓库内(否则 usage 错误并提示:无仓库则验证不可用)。
- **信任边界必须显式**:对不可信 PR 跑测试 = 执行该 PR 的代码(与 CI 同级风险)。因此:① 验证仅在用户通过 `--verify` 或配置文件**显式声明**时发生,绝不默认开启;② 命令执行前在 progress/human 输出中回显命令清单与工作区路径;③ 命令继承最小 env(PATH/HOME/NO_PROXY 系,沿用 pr-fetch 的卫生规则)并带超时(默认 300s/条,可 `--verify-timeout` 调整)。
- 命令经 shell 执行(用户声明的字符串,信任级同用户手敲);**绝不**把 diff/PR 内容、模型输出拼进命令。

**结果处理**:每条命令记录 `{ command, exitCode, durationMs, outputTail }`(stdout+stderr 合并取尾部,≤64KB,防撑爆快照)。任一命令非零退出**不中止 run** —— 验证失败是要评审的证据,不是编排故障;仅当工作区准备本身失败(worktree/apply 失败)时才按 exit 5(IO)处理。结果经 `verificationItem` 进快照稳定项,聚合报告头部含验证摘要表(命令 → 通过/失败/退出码)。

**与 L2 的边界**:验证命令是用户声明的固定集合;「agent 看情况自己决定跑什么」属于 L2 自主执行模式,不在此处开口子。

## 6. 报告渲染(`cli/src/report/review-render.ts`)

- `renderReviewSuccessReport`:确定性头部(Run / Topic / Input(source+ref+title,PR 时含 author/base→head/url)/ Aggregator / Reviewers / **Verification(命令 → 通过/失败/退出码摘要表,无验证时省略)** / Status / PARTIAL 标记)→ `---` → aggregator 五章节正文 → 确定性附录 `## Appendix: per-reviewer findings`,逐 reviewer 原文列出(含失败 reviewer 的缺席说明)。
- `renderReviewPartialReport`:零模型调用,INCOMPLETE banner + 已完成 findings + 失败列表(phase/code/message)+ 下一步诊断。沿用 render.ts 既有模式。
- 复用 `writeCanonicalReport` / `writeReportCopy` / `assertNonEmptyMarkdown`;落盘 `runs/<run-id>/{transcript.jsonl, report.md}` 布局不变。
- transcript schema 不变:wave turn 记 `role: "message"`,aggregate 记 `role: "report"`。

## 7. 文件清单

新增:
- `cli/src/run/workflow-types.ts` —— 原语、WorkflowTemplate、WorkflowInput/ReviewOutcome
- `cli/src/run/workflow-orchestrator.ts` —— `runWorkflow`(wave 并发池 + aggregate)
- `cli/src/run/run-common.ts` —— 从 orchestrator.ts 提取的共用机制(小重构)
- `cli/src/run/review-instructions.ts`、`cli/src/workflows/review.ts` —— review 模板
- `cli/src/run/input-source.ts`、`cli/src/run/pr-fetch.ts` —— 输入解析与 PR 抓取
- `cli/src/run/verify.ts` —— 验证阶段(worktree 隔离 + 命令执行 + outputTail 截断,可注入 runner)
- `cli/src/report/review-render.ts`
- `cli/src/commands/review.ts`(并在 `cli/src/cli.ts` 注册 `review`)

修改:
- `cli/src/run/orchestrator.ts` —— 提取共用件到 run-common(行为不变)
- `cli/src/run/context-snapshot.ts` —— 新增 `reviewTaskItem` / `diffItem` / `verificationItem`
- `cli/src/run/types.ts` —— `ReviewOutcome` 及进度事件增量(`wave.start` 等)
- `AGENTS.md`(最短路径章节 + 关键约束)+ `README.md` CLI 章节

不改:`runtime-host/`、`shared/`、`src/`(浏览器)、transcript schema、配额常量。

## 8. 测试设计(`cli/tests/`)

- `workflow-orchestrator.test.ts`(假 TurnDriver + 假 Host):①并发池上限 ≤4 且补位;②单 reviewer 失败 → tolerate,进 `reviewerFailures`,聚合照常;③全失败 → exit 4 + partial report;④聚合快照含全部成功产出且 append-only;⑤SIGINT → exit 130 + partial report;⑥persist-before-ACK 顺序;⑦close 失败使 run 非成功。
- `review-instructions.test.ts`:五章节表固定;聚合指令含全部 reviewer 名与 inputTitle。
- `review-render.test.ts`:附录含每个 reviewer 原文;PARTIAL 标记;空 body 兜底。
- `input-source.test.ts`:URL 解析(github/antcode/多级 group/未知 host)、裸 PR 号的 remote 判定、互斥与 1MB 守卫、stdin。
- `pr-fetch.test.ts`(注入假 runner):命令参数数组正确;ENOENT/auth/not-found/兜底四类错误映射;stderr 不进 stdout。
- `verify.test.ts`(注入假 runner + tmp git 仓库):worktree 生命周期(add/apply/remove,失败兜底清理);非零退出不中止且进结果;outputTail ≤64KB 截断;`--verify` 覆盖配置文件;无仓库 + `--diff` + `--verify` → usage 错误;聚合快照含 verificationItem。
- orchestrator 既有测试全绿(验证 run-common 提取零行为变化)。

## 9. 验证计划

1. `pnpm build:cli` 通过;cli 单测全绿;biome 检查通过。
2. 手动冒烟(Host 运行中):`git diff HEAD~1 | pnpm exec councilkit review --agents '[...]' --aggregator ... --diff - --json`,检查 report.md 五章节 + 附录、transcript 完整、`reviewerFailures` 形状。
3. `--pr` 冒烟:一个 GitHub PR URL + 一个 AntCode MR URL(内部网络按 NO_PROXY 规则),确认 diff 抓取、元数据进报告头部。
4. 失败路径冒烟:一个 agent 用不 ready 的 driver 配置 → 确认 tolerate 语义与 PARTIAL 报告。
5. 验证冒烟:在本仓库对一个故意引入 lint 错误的 diff 跑 `--verify "pnpm lint"`,确认:验证失败不中止 run、verificationItem 进快照、报告头部验证摘要标失败、reviewer findings 引用该证据。

## 10. 分期

- **V1(本文档)**:run-common 提取 + 引擎(wave/aggregate)+ review 模板 + `--diff`/`--pr` + 验证阶段(`--verify`)+ 测试 + 文档。
- **V2**:design 模板(盲提波 → 互评 serial-rounds → 聚合);serial-rounds 原语从 runCouncil 轮次循环提取;若 design 只需加数据与薄命令,抽象成立,固化 `docs/adr/0014-workflow-topology-engine.md`。
- **V3+**(不在范围):用户自定义模板、浏览器端并行拓扑与对比 UI、review findings 结构化 schema。
