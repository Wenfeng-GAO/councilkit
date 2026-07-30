# 自主并行运行:N 个全能力 Agent 独立做同一任务 + 对比汇总

日期:2026-07-29
定位:**需求重定义后的权威设计**,取代 `docs/plans/2026-07-29-001-feat-workflow-engine-review-template-plan.md` 与 `docs/brainstorms/2026-07-29-runtime-capability-tiers-and-acp.md` 中与本文冲突的部分(后者保留其 driver 现状调研价值)。
状态:**共识已确认**(2026-07-29 grilling 三轮 26 问定稿,用户逐轮批准),可按 §7-§9 实现。术语(Autonomous Run / Attempt / Aggregator / Task Template)已入 `CONTEXT.md`。

## 0. 需求(用户 2026-07-29 定稿)

- 用户只给简单意图,如「帮我 review 这个 PR(PR 链接)」;
- **能力全部交给 agent**——怎么做(agent 自己 fetch PR、跑测试、跑 lint、查仓库)与有没有 councilkit 基本无关,councilkit 最多给**规范化的 prompt**;
- councilkit 的价值 = **让 N 个不同 agent 独立重复做同一件事,然后对比结果并汇总**;
- 可以打破原有设计;
- **安全不作为约束,全部权限可接受**(2026-07-29 用户决策):Attempt 与 Aggregator 走完全相同的全能力 spawn,不做任何工具锁特例。workspace 隔离保留,但理由是「N 个 agent 并发写同一目录会互相踩踏」的工程理由,不是安全理由。

## 1. 关键架构判断:这个需求下,Host 讨论基座是负资产

既有 Runtime Host 体系(scope / Context Snapshot / reconciler / SSE / ACK / persist-before-ACK)存在的理由是**多轮共享上下文、会话续接、讨论可恢复**。「单发自主任务」里这些全都不存在:每个 agent 拿一段 prompt,独立做完,交出最终文本。经 Host 反而要付出:放松 tool-lock 击穿重试/提交不变式、事件模型无双向权限通道、kimi 无法强制任何约束(参见能力分级文档 §0-§2 的调研)。

**结论:新功能走「直接 spawn 的并行运行器」,不经 Runtime Host。** 这打破「CLI 只与同 checkout Host 互通」的约定——仅限本命令,显式记录。discuss/run 等既有功能完全不动。

- **复用**:agent store(Driver Selection:driverId + 类型化 options + modelId)、runs/<run-id>/ 落盘样式、退出码体系、report 渲染模式。
- **可执行文件解析**:CLI 直接按 PATH 解析 `cld`/`kimi`/`codex`(2026-07-29 用户决策:信任级 = 用户亲手敲该命令;显式打破「Installation 只能由 Host 发现/批准」的约定,仅限本命令),不依赖 Host 的 installations API——Host 不需要运行。
- **绕过**:Runtime Host、scope 生命周期、Context Snapshot、reconciler、SSE/ACK。
- **可借鉴不直接复用**:三个 host driver 的 stream-json 解析逻辑(进程管理、事件归类),它们与 ParticipantDriver 接口耦合,不直接 import。

## 2. 执行模型(已在本机核实 CLI 能力)

每个 Attempt = 一个独立子进程 + 一个**隔离空 cwd**(`runs/<run-id>/workspaces/<attemptId>/`),无人值守单发:

| driver | 无人值守全能力调用(实现时逐一核实 flags) | 权限模式 |
|---|---|---|
| claude(cld) | `cld cfuse --print --output-format stream-json --dangerously-skip-permissions`(**只用 cfuse 路由**,2026-07-29 用户锁定;flags 透传到 claude-code;凭据走 `~/.config/cld/env`,与 Host driver 同源) | 跳过全部审批 |
| kimi | `kimi -p <prompt> --auto --output-format stream-json`(`--auto` = 完全自主,不问问题;skills 走默认发现,即用户真实环境) | 完全自主 |
| codex | `codex exec -s workspace-write --dangerously-bypass-approvals-and-sandbox <prompt>`(或 `-s danger-full-access`;`codex exec` 还有内建 `review` 子命令,可作 prompt 参考) | 跳过审批 + 沙箱 |

**driver 支持范围(V1)**:claude 只支持 `cld cfuse` 单一路由(忽略 agent store 里 claude-stream-json 的其它 route option;选到非 cfuse 路由的 agent 直接 usage 报错)。kimi、codex 按上表。

**信任模型(显式选择,必须写进 README/AGENTS.md)**:全能力 + auto-approve + 隔离 cwd。子进程以**用户本人权限**运行、继承正常用户环境(agent CLI 需要自己的凭据与网络,env 卫生裁剪在此模式不适用)——信任级等同于「用户亲手跑这个 CLI」。评审不可信 PR = PR 代码会被执行(测试/lint/构建脚本),与 CI 同级风险,用户以一条命令显式发起即视为知情同意。**替代 permission flow 的不是策略引擎,而是「隔离 cwd + 用户同级信任 + 显式发起」三件套。**

**运行参数**:并发池默认 `min(3, Attempt 数)`(`--concurrency` 可调;不对齐 Host 的 4,那是 Host 配额,这里是我们自己的池);单 Attempt 默认超时 30min(`--timeout` 可调),超时 = 该 Attempt 失败;SIGINT → kill 进程组;**Attempt 失败不重试**(成本高、副作用不可判定),tolerate:进 `attemptFailures`,其余继续、聚合照常,全失败才判 failed;**启动时打印 Attempt 清单**(driver+model+任务),让用户发起前对成本知情;workspace 默认保留(报告记录路径,用户自查自删,V1 不做 GC)。

**进度与落盘(V1)**:只捕获 ① 每 Attempt 最终文本 ② meta(时长 / exitCode / workspace 路径);原始 stream-json 事件流不落盘(调试靠 workspace 保留 + `--verbose` 打 stderr)。进度输出:human 模式每 Attempt 一行开始/结束(含耗时、exitCode);`--json` 时进度走 stderr,stdout 只出最终 ReviewOutcome(与 `run` 一致)。V1.5 解析 stream-json 提取**过程摘要**(各 Attempt 跑了哪些命令/工具调用计数)——报告不止对比结论,还能对比过程(谁跑了测试、谁只读了 diff)。

## 3. councilkit 唯一的注入:规范化 prompt 模板

任务模板 = 数据,与运行器解耦。review 模板要点:

1. 任务陈述:PR URL(或 `--task` 自由任务文本)+ 可选 focus;`--council` 时 `council.topic` 非空则作为额外上下文注入;
2. 工作方式:**完全自主**——自己 fetch PR(gh/antcode)、checkout、跑测试/lint/任何认为必要的验证;
3. 输出契约(关键,聚合的前提;软契约——不遵守则原样进附录、聚合指令按原文理解,不算失败):最终消息只输出 Markdown,固定三段:
   - `## Findings` —— 每条 `- [critical|major|minor|nit] 文件:位置 — 描述 → 建议`;
   - `## Verification` —— 实际跑过的命令 + 结果(没跑就写"未验证");
   - `## Verdict` —— 一行 `approve` / `changes-requested` / `comment`;
4. 明确「最终消息即交付物,过程输出不算」。

design 模板(未来)= 换一份 prompt 模板,运行器零改动——「模板 = prompt 数据」的抽象在这个形态下依然成立,且比原拓扑引擎更轻。

## 4. 对比与汇总

- 聚合 = 一次与 Attempt **完全相同的全能力 spawn**(2026-07-29 用户决策:不做工具锁特例)。Aggregator 本身也是一个 Attempt(先独立做一遍,其 findings 进对比),再看到全部产出做聚合;
- **Aggregator 的输入** = 任务原文 + 每个 Attempt 的「名字 + 最终输出全文」;**不给 workspace 路径**——聚合基于交付物,防止它去翻别人目录。聚合指令沿用五章节:Overview / Consensus findings / Unique findings / Disagreements / Verdict,要求点名引用各 Attempt,并明确「失败缺席的 Attempt 不得被引用为共识来源」;
- 报告 = 确定性头部(runId / 任务 / 各 Attempt 的 driver+model / 时长 / 退出码 / PARTIAL 标记)→ 聚合正文 → `## Appendix: per-attempt outputs`,逐 Attempt 原文(失败 Attempt 列「failed: 原因」);V1.5 加过程摘要对比表;
- 落盘 `runs/<run-id>/{report.md, transcript.jsonl}`(复用样式;transcript 记录每 Attempt 最终文本 + meta)+ `runs/<run-id>/workspaces/<attemptId>/`(Attempt 工作区,保留);`--out` 额外复制报告。

## 5. ACP 再评估(新事实)

**kimi-code 有 `kimi acp`(本机核实)**,codex 有 ACP 模式,claude-code-acp 生态成熟——覆盖矩阵比前次评估乐观。但本需求下 ACP **仍非必需**:print/exec 单发模式已能拿到最终交付物,ACP 的价值(结构化权限请求、会话内多轮交互)在「无人值守单发 + auto-approve」里没有落点。ACP 留作未来「需要中途交互/结构化权限」时的选项,不为此引入。

## 6. 命令面

```
councilkit review --agents '["<id>","<id>",...]' --aggregator <id>
  (--pr <url|number> | --task "<自由任务>")   # 互斥,必居其一
  [--focus "..."] [--timeout 30m] [--concurrency 3] [--json] [--out <path>]

councilkit review --council <ref>            # 复用 store 里的 Council(2026-07-29 用户决策:V1 即支持)
  (--pr <url|number> | --task "...") [...]
```

- `--council` 与 `--agents`/`--aggregator` 互斥;映射:`council.agentIds` → Attempts、`council.reporterAgentId` → Aggregator;`council.rounds` 忽略;`council.topic` 非空时作为额外上下文注入任务模板。Council schema 零改动。
- `--aggregator` 必填 ∈ `--agents`;`--pr` 只进 prompt(抓取由 agent 自己做),councilkit 不内置 pr-fetch;
- 不内置 `--verify` / worktree 管理——验证是 agent 自己的工作;
- ReviewOutcome 形状:status / attemptFailures / incomplete / reportPath / transcriptPath,沿用退出码体系。

## 7. 文件清单(全部在 cli/)

新增:
- `cli/src/auto/runner.ts` —— 并行自主运行器(spawn 池、隔离 cwd、超时、kill 树、tolerate);
- `cli/src/auto/driver-commands.ts` —— 每 driver 的 argv 构造(PATH 解析 executable;store 的 Driver Selection → argv)+ 最终输出提取;
- `cli/src/auto/templates/review.ts` —— review prompt 模板 + 输出契约 + 聚合指令;
- `cli/src/auto/aggregate.ts` —— 聚合调用 + 报告渲染(沿用 review-render 思路);
- `cli/src/commands/review.ts`(注册进 cli.ts)。

修改:`AGENTS.md`(新命令 + 信任模型 + 「本命令不经 Host」的约定打破)、README CLI 章节。

不改:`runtime-host/`、`src/`、`shared/`、既有 `run`/`agent`/`council` 命令。

## 8. 测试

- runner:并发池上限(默认 3)、tolerate、全失败判 failed、超时 kill、SIGINT kill 进程组、隔离 cwd 互不可见、失败不重试;
- driver-commands:三种 driver 的 argv/权限 flags 正确(claude 固定 `cfuse` 路由,非 cfuse 报 usage)、PATH 解析、输出提取;
- 模板:输出契约含 Findings/Verification/Verdict 三段要求;聚合指令含全部 Attempt 名 + 「失败 Attempt 不得引用为共识」+ 不含 workspace 路径;
- 命令层:`--pr/--task` 互斥、`--council` 映射(agentIds→Attempts、reporter→Aggregator、忽略 rounds)、`--aggregator ∈ --agents`;
- 端到端假 runner 注入:完整跑通 review 流程产出 report.md(含失败 Attempt 附录)。

## 9. 冒烟与分期

- **V1**:runner + review 模板 + 报告;冒烟 = 真实 `--pr`(一个 GitHub PR + 一个 AntCode MR)各跑一次 2-agent review,人工检查报告质量与过程合理性;
- **V1.5**:stream-json 过程摘要(命令/工具对比表);
- **V2**:design 模板(仅新增 prompt 数据);若成立,固化 ADR(自主并行运行 = 直接 spawn,不经 Host)。
