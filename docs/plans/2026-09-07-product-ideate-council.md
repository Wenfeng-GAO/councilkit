# 多模型产品创意决策：councilkit ideate

更新：2026-09-07。替代 Cursor 的 Product Ideate Council 初稿。本文是实现与验收依据；用户已授权 Cursor 完成实际开发和验证。

## 1. 目标与边界

让 Grok、GPT（Codex）、Kimi 等模型围绕同一产品创意，先独立提案，再互相质疑，最终输出有取舍依据、可执行、保留分歧的产品决策。允许结论是「先验证」或「不做」，不强迫生成开发方案。

采用专用命令 `councilkit ideate`，编排为并行提案 → 串行辩论 → Aggregator。复用进程调度、超时取消、Live 采集、报告存储；不用通用 Workflow/YAML 引擎。现有串行 Run 目前不提供该拓扑，但这不是其永远不可扩展的限制；独立命令是本次控制范围的选择。

模型执行不依赖 Runtime Host；浏览器发起时 Host 仅 spawn 同 checkout CLI。Codex 沿用 `codex-app-server` Driver Selection，自主执行路径实际调用 `codex exec`，不新建 OpenAI HTTP driver。

不改变 review/apply/fix/repair、审查账本、现有 Run、浏览器讨论的数据语义；不做 ideate resume/against/fix/apply。允许为真正共享的执行与展示能力做小范围兼容扩展。

## 2. 用户路径与输入

```bash
pnpm exec councilkit init --json
pnpm exec councilkit ideate "一句话创意" --json
pnpm exec councilkit ideate "创意" --background "用户、资源、时间和约束" --debate-rounds 1 --json
pnpm exec councilkit ideate "创意" --council product-jury --debate-rounds 0 --json
```

- 默认 Council 为 `product-jury`；缺失时给出具体初始化命令，不静默创建或改写其他 Council。
- `--debate-rounds` 为整数 0/1/2，默认 1；0 是主动跳过辩论，不算故障。
- 一次性模型选择使用中性的 `--models` 参数和 `models` 请求字段，复用现有模型选择数据结构，不把 review 专用 persona 带入 ideate。与 `--council` 的互斥/优先规则在 CLI help 和校验中保持一致。
- 输入支持 idea 和 background；表单引导填写目标用户、要解决的问题、可用时间/预算及非目标，除 idea 外可选。缺少信息要在报告中列为假设，不伪造用户事实。
- Host 关闭不影响 CLI；不自动启动 Host；`--json` stdout 恰好一个最终 JSON，进度只在 stderr。
- 输出目录遵循现有 `COUNCILKIT_HOME` 解析：`runs/ck-ideate-<uuid>/`，包含 transcript、report、live 及必要的执行工作目录。

## 3. Council、角色与模型

`init` 加法创建 product-jury 与 ideate 专用 Agent，保持 pr-jury 原有行为。默认三席：

| Agent | 默认驱动 | 职责 |
| --- | --- | --- |
| ideate-product | grok | 用户价值、范围和验证 |
| ideate-engineering | kimi | 可行性、实现成本和约束 |
| ideate-challenger | codex | 独立替代方案、质疑前提与失败条件 |

角色与模型解耦，可通过已有 Agent/Council 能力替换。缺少可执行文件则明确记录未创建的席位及原因；PATH 存在不等于已登录或模型可用，执行前应做有界预检。模型 ID 来自现有可用配置/目录或驱动支持的发现途径，不猜测 GPT 型号。

- 2–8 席才能发起；默认不为了凑席数复制同一个模型。
- 记录 configured/successful model configurations，按 Driver Selection（含 route/options）与 modelId 去重；明确这是可观察的模型配置多样性，不能证明底层模型独立。两个相同配置的角色不能表述为两个模型。
- 用户显式选择同一模型的多个角色可以运行，但显示「单模型多角色」，不能称多模型共识。缺失 GPT 必须在初始化/结果中可见。
- Reporter 必须属于 Council；默认选择已创建的 Codex 席，其次 product，再其次 engineering。初始化时选择并持久化；已配置 Reporter 不静默换人。
- Aggregator 阶段使用单独的中立决策指令，替换该席原有辩论 persona；不增加一票、不强行抹平分歧，也不按席位数投票。
- init 幂等保留用户定制。若已有 `--force` 为全默认重建，明确它影响 pr-jury 和 product-jury；分别只重建各自 Council，不删除其他 Council 引用的 Agent，不因创建一方覆盖另一方。

## 4. 三阶段决策协议

### 4.1 并行独立提案

所有席位只收到相同的用户输入和各自 persona，不能收到他人提案。每席独立提出至少一个方案，使用稳定的方案引用（如 `proposal-seat1`）；不要求一定彼此不同。

统一维度：目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。估算必须标明假设；市场判断不能包装成已验证事实。

每份提案提供短摘要，并将正文控制在规定输出预算。空输出或不可提取的输出不能计作成功提案。

### 4.2 串行辩论

按固定 roster 顺序执行，第二轮可轮转起始席，顺序写入 transcript 便于复核。V1 无自动收敛判定；只执行用户选择的 0–2 轮。

输入为全部成功提案的有界摘录/摘要与此前成功辩论的有界记录。每次发言必须说明：支持或反对哪个方案/主张、理由或证据、建议怎样修改、什么条件会改变判断。允许明确「没有新增异议」，不为了满足反驳要求编造问题。

单席失败记录后继续；零成功提案不进入辩论或汇总。仅一份成功提案时仍允许其他可用席对它交叉质疑，但结果始终标为提案来源不足。

### 4.3 Aggregator

只依据用户输入、成功提案和成功辩论生成建议；区分事实、假设、推断和待验证项，不把失败/缺席当支持票。核心输出必须覆盖：

1. 推荐行动：做 / 先验证 / 不做，及理由。
2. 方案对比：统一维度比较，解释弃选方案；若实际只有一个方案，明确无法完成多方案比较。
3. 做什么与不做什么，产品形态与关键流程。
4. 关键分歧、支持依据及仍未解决的问题。
5. MVP 技术方案和里程碑；不做时可明确这些章节不适用。
6. 第一步验证：具体动作、目标观察/指标、成功条件和停止或调整条件。数字为建议阈值时明确标记。

固定正文章节为：背景与问题 / 目标用户与场景 / 方案对比 / 辩论要点与分歧 / 决策与范围 / 产品形态与关键流程 / 技术方案与约束 / 里程碑 / 验证计划 / 风险与未决问题。

轻量检查空输出和缺失关键章节；失败有可诊断状态，不把进程 exit 0 自动视为合格决策。格式约束使用稳定模板与测试，不为此增加复杂语义打分系统。确定性报告头和各席完整输出附录由程序生成，不依赖模型复述。

## 5. 执行权限与预算

这是讨论能力，不是代码执行任务。必须给 ideate 独立的 invocation policy；复用 runAttempts/spawnOnce 不代表沿用 review 的权限参数。

- 每个阶段/席位使用独立执行目录，原始提案不能因辩论或重试被覆盖。
- 默认纯文本/受限讨论，禁止修改用户项目、提交、推送和发布。不能继承 `--dangerously-bypass-approvals-and-sandbox`、`--dangerously-skip-permissions`、`--always-approve`、`--force` 等审查参数。
- 按本机各 CLI 的真实 help/能力实现只读或禁工具模式，并验证实际 argv；不能仅用 prompt 声称权限受限。无法满足约束的驱动明确报不支持，不静默退回全权限。输出文件由 CLI 或允许的专用工作目录承载。
- 受限策略必须覆盖预检与重试，不得在预检中回退到 review 的全能力调用。隔离配置时只使用当前驱动所需的最小认证信息；不得把 credentials/oauth/token 复制进长期保留的 Run/report/workspaces。确需独立认证目录时放在 Run 之外的临时目录，权限限定到当前用户，并在成功、失败、超时、取消和重试中清理；测试验证产物中没有认证文件。
- V1 不要求实时市场研究；无检索的内容只能作为待验证假设。以后是否引入只读检索另行设计。
- 单条提案与辩论给出短输出预算；最终发给模型的完整 prompt（含输入、模板、所有引用）统一做 UTF-8 字节预算。推荐初始总上限 128 KiB，原始 idea/background 合计 16 KiB，并按席位公平分配剩余额度。采用确定性截取/摘要块，截断明确标注，不静默省略某一席。
- 附录保留 runner 输出上限内的完整原文；模型上下文裁剪不裁剪落盘原文。超过底层输出上限时报告注明截断。
- prompt/spec 构造失败和 spawn 失败都进入阶段终态，不能因 argv 超限抛出而丢失已完成产物。
- per-attempt timeout 与全 Run deadline 均明确实现和展示，可沿用已有 timeout 风格；建议默认单次 300 秒、全 Run 1800 秒，可配置。整个 Run 预算覆盖探测、重试与汇总，取消/总超时阻止后续 spawn，并清理自身子进程。

## 6. 状态、完整性与报告

运行状态和内容完整性分开记录，不依赖模型自己声明：

| 情况 | 产物与表达 |
| --- | --- |
| 全部计划步骤成功 | completed；统计完整 |
| 部分提案/辩论失败，Aggregator 成功 | completed + incomplete:true；「降级建议」及原因 |
| 只有一份成功提案 | 「单份提案，比较不足」；不得表述为多模型共识 |
| 成功来源只有一种模型配置 | 「单模型来源」；与运行是否成功分别表达 |
| 主动 rounds=0 | 「未安排辩论」；不因此标故障 |
| rounds>0 且辩论全失败 | 「未完成交叉讨论」；保留提案和汇总 |
| 无成功提案或 Aggregator 失败/关键正文无效 | failed + incomplete:true；仍写失败说明与已有原文 |
| 用户取消/全局超时 | interrupted/明确超时失败，保持已有产物，停止新 spawn |

JSON、报告首屏和索引包含：计划/成功提案数、计划/成功辩论发言数、配置/成功模型来源数、失败阶段/席位、incomplete、降级原因、contextTruncated。不要只显示「成功」。新增字段对旧 Run 可选或有兼容默认。

Exit code 复用仓库现有契约（包括取消 130）；完整性通过字段表达，不能擅自重新定义 review 等命令退出码。

## 7. Transcript、Live 与 Host/UI

- `kind=ideate`、`ck-ideate-<uuid>`。
- 每次模型执行拥有独立 attemptId，如 `proposal-seat1`、`debate-r1-seat1`、`aggregate-final`；记录 stage、round、agentId 和逻辑方案引用。重试沿用现有物理 attemptNumber 语义。
- 事件至少覆盖 ideate.started、阶段切换、每个执行的开始/终态、aggregation.finished、ideate.finished；可复用 attempt.finished，但不得重复计数。不要同时为同一次完成发两类可计数事件。
- 扩展 `cli/src/auto/transcript.ts`、`shared/runtime/schemas.ts`、`cli-runs-index.ts`，以及 `cli-run-progress.ts` 的 `liveStateFromRecords`。仅增加 phase enum 不够：提案完成后不能立即被旧逻辑推为 aggregating。
- Live 文件按独立 attemptId 保存，详情按「提案 / 第 N 轮辩论 / 汇总」分组，同一席跨阶段不覆盖；保留失败过程。
- Host 新增 ideate 启动 action 和请求 `{ idea, background?, debateRounds?, models? }`，复用现有验证、同 checkout launcher、预分配 runId、启动握手和错误回传。参数通过 argv 数组传递，不用 shell 拼接。
- ReportsPage 加「讨论产品创意」入口与「创意」筛选；显示实际角色、模型、Reporter 和辩论轮次。可以抽取 ReviewModelPicker 的中性展示部分，不复用 `reviewModelAgents()` 的代码审查 persona。
- 发起后进入对应报告，可见阶段进度、独立 Live 过程、完整性和决策正文。详情不提供 PR、账本、立即修复、apply 或 re-review 动作。
- 保持 review/discuss/squad 旧记录合法，已有审查页面行为不回归。UI 不暴露驱动参数等无关实现细节。

## 8. 开发顺序与现有 WIP

1. 先读取 AGENTS.md 和当前 git 状态，将当前 diff（含未跟踪文件清单及必要备份）保存到仓库外的本地基线目录；记录 HEAD。现有 review WIP 不作为可删除内容。
2. 优先在当前 checkout 做可归因的加法，与现有 WIP 共存；需要隔离时复制当前工作状态到独立工作区，不 reset/clean/stash 用户改动，不自动合并、提交或推送。已批准开发，不再以「脏工作区」为由等待批准；若检测到并发修改，仅暂停受影响文件并继续独立部分。
3. 完成执行策略、默认席位、CLI 三阶段、状态与报告的纵向切片，先跑针对性测试。
4. 跑真实模型 CLI smoke，验证协作质量与只读边界，修复发现。
5. 接 Host/UI，完成自动化和浏览器验证；真实模型 smoke 遇环境问题时可继续这部分，不以未完成 smoke 冒充全部验收通过。
6. 更新 README/AGENTS.md 最短路径；输出开发与验证记录，不止停在计划或实现完成。

## 9. 验收与证据

### 自动验证

- roster/init：幂等、用户定制、缺驱动、Reporter 合法性、同模型去重、一次性 persona 与 review 隔离。
- 编排：rounds 0/1/2、并行盲提不可见他人内容、串行可见已完成内容、失败继续、零提案拒绝汇总、单提案降级、汇总失败/空正文、取消/超时不再启动后续阶段。
- 权限与预算：各支持驱动的安全 argv、长 UTF-8 输入/多席上下文预算、构造阶段失败记录、原文附录保留、模型来源和引用可追踪。
- 预检/重试同样受限；主动超时在并行提案执行期间也能取消子进程；认证临时目录在所有终态清理，不污染持久化产物。
- 状态/索引：各阶段唯一 attemptId、Live 不覆盖、阶段转换正确、重复/损坏记录兼容、旧 review/discuss/squad fixtures 通过。
- Host：参数与 schema 校验、相同 checkout、runId/握手、启动失败、输入特殊字符。
- 前端：发起 → 列表/筛选 → 详情/Live；完整与降级结果；不存在修复/PR 操作。
- 执行仓库适用的 typecheck、build、相关 CLI/Host/unit/E2E；报告具体命令及结果。全量检查若有既有失败，基于前置基线证明，不自动归咎于 WIP，不修无关问题。

### 真实模型 smoke（必须实际尝试并保留证据）

使用独立临时 `COUNCILKIT_HOME`，不覆盖日常 Council。先确认本机 Grok/Kimi/Codex 的模型配置、登录及受限调用能力，再跑三席、一轮辩论。已有本机配置可读用于调用，凭据不得写进日志、报告或文档。

公开、非敏感示例：为独立开发者做一个每周整理用户反馈并给出下周验证任务的本地工具；目标用户是单人开发者，开发时间两周，不接付费第三方数据，第一版不自动向用户发消息。

保存命令、模型配置、runId、耗时、reportPath、各阶段状态。人工检查：提案独立、至少出现可比较的不同思路或明确说明相同、辩论引用具体主张、保留未解决分歧、报告有首个验证动作和成功/停止条件。不得为了“通过”编造分歧或证据。

调用本机已配置模型和执行本地验证已在用户授权范围内；若额度、登录、驱动只读能力或网络阻塞，记录精确原因和真实部分结果，继续可完成的工作，不静默换模型假装三模型通过。不要开启自动付费、改变鉴权或放宽权限。

### 浏览器与最终交付

检查 43127 占用；不 kill 非自身 Host。复用同 checkout 且版本匹配的 Host，或按仓库测试约定启自己的实例；若受占用限制，保留证据并使用可隔离的测试路径。

实际走一次：填写创意 → 发起 → 创意列表 → 阶段与 Live → 最终报告；自动 E2E 可用 fixture，真实 smoke 报告再人工查看。保存必要截图/测试产物到验证目录。

将最终改动摘要、测试命令/结果、真实 smoke runId 与报告路径、UI 验证证据、剩余限制写入 `docs/ideation/2026-09-07-product-ideate-validation.md`。未完成事项明确列出；实现和自动测试通过不等于真实三模型验收通过。
