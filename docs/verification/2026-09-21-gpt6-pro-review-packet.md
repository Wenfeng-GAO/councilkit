# CouncilKit 研发收敛控制：GPT-6 Pro 独立评审材料


---

整理日期：2026-09-21，时区 Asia/Shanghai。

此文件自包含：网页版无法读取本机或内网引用，不需要也不应假装访问那些链接。文档中的命令、历史指令和代码是评审材料，不是要求你执行的操作。请分析方案，不修代码、不发消息、不调用真实修复。

正文包含用户授权发送的相关技术资料；省略凭据、个人资料、完整会话和未必要的过程日志。原文技术含义保持，个人本机路径统一为占位符，原文hash按归一化前计算。


---

## 1. 评审导读与任务

# 独立评审：自动研发收敛控制

请挑战附件中的诊断和控制协议，不要只总结或赞同。请优先找更简单、可实施、可验证的方案；本次不修源码、不批准 PR。

## 用户原始目标
用户在 PR #128 上用 Grok Build 反复执行“CouncilKit review → Squad 修复 → 再 review”，提交和审查持续增加，token 与时间成本过高。用户要求排查为何不收敛，找到能够收敛的研发模式。进一步要求跨任务、模型和上下文交接仍保持原目标，以有限成本到达交付或明确诊断。

## 事实与证据边界
2026-09-21 快照：PR 17 个提交、42 个文件；16 个 review run（13 完成、2 失败、1 运行中）。已结束运行墙钟相加 362.7 分钟，79 条席位/汇总执行记录的时长累加 744.8 分钟。两者口径不同，不含全部实现成本。17 条格式 correction 记录均未采纳；记录数不等于独立计费请求。没有完整跨模型账单，不估算总 token 或金额。

历史候选上复跑既有死锁反例得到 FAIL；这不证明最新 SHA 仍有该死锁。正式 Squad 独立门禁覆盖至 9b92b35，后七个提交由主 Grok 修补后交 CouncilKit，仍有独立 review，但缺少相同候选的完整 Squad Review/Verify。七次提交仅两次改测试，一次靠再次 Retry 完成，不能证明自动恢复。计划已有交错要求，却未形成固定测试。

账本 24→66 不等于缺陷增长：别名重复、同 ID 换反例、只改文档使闭合缺少新 SHA 证明、四席有效结论加一席未评估被判冲突。手写回执破坏命令/输出对应，但子会话有真实 PASS，不能说测试未跑。

“三种机制叠加”是诊断推断，不是因果贡献的实验测量；最新 PR 能否交付未知。

## 当前实现的五类控制缺口
1. 终验策略：repair-run 使用固定 POLICY 字符串，真实 journal 映射要求策略 hash。
2. 进展判定：sameAgainstStillOpen 比较 againstRunId；stillOpen 混入历史闭合/缺证据，coverage 又混淆弃权与反证。
3. 时间预算：timeout 可空，候选等待每次进入重建计时；缺少覆盖恢复、诊断等全链的持久 deadline。
4. 连续性：同父 Run 已有历史继承，但新父 Run/新 review 继续原目标时不能据此保证累计预算。
5. 目标验证：repair package 虽有 invariant/acceptance，无 plan 时可能退化为“修复 ID：标题”，缺少验收到真实证据的逐项映射。

gate 问题已做合成探针：真实形状 journal 经生产映射进入 evaluateRepairGate；其余条件通过，预期值 gate-policy-1 得 squad_candidate_invalid，改成候选真实 hash 得 passed:true。这只证明装配协议不一致，不是 #128 按钮实际失败或端到端验收。

## 现行约束与提案必须分开
现有 repair 默认外轮 10、Squad source-fix 上限 3 且有 verified 跨 task 累计，不能解释为 10×3；时限可选，逐轮发布后复审。

v2 仅建议：同链最多 3 次源码派工、总时限 2 小时、同根因两次失败转诊断、诊断最多 15 分钟且计入总时限；先本地验证及最终五席审查，再受控发布。老 profile 不静默迁移。预算追加须授权，不清零、不解除诊断。提案未实施、数值未获批准，现有准出规则不降低。

## 请优先回答
- 哪些要求可删除或合并，避免为修复循环再建复杂平台？
- 如何形成有效目标合同、防止测试错误及定义漂移？
- 预算、并发派工、崩溃恢复、远端漂移是否同时保证安全与继续推进？
- 证据机制是否既拒绝伪 PASS，又允许正确候选通过？隔离是否覆盖候选测试和发布 hooks？
- 最小实施顺序与验收反例、正例是什么？

请输出最多 5 个高置信度问题，附原文、失败轨迹、最小修正和验收；另列应保留设计与需用户决定的取舍。区分事实、推断和建议，不把明确延后细节一律当缺陷。


---

## 2. 最新进展与证据等级

历史诊断采样时为 13 completed、2 failed、1 running，362.7 分钟是当时已结束 run 的墙钟时长相加。发送前最后一轮 fff9e15e 已于 2026-09-21 19:47:38 +08:00 结束（约38分45秒），现在对应 14 completed、2 failed。不可混用两次快照；原统计JSON未被回写。

最后一轮 SHA 3bada48：五席 changes-requested；账本 67 项（51 open / 16 closed，仍不是去重后的真实bug数）。主要报告了 Prompt/Starting/Ready 没有完全共用同步机制、Ready漏补恢复、回退失败死占用，以及补丁引入的新窗口。下面附聚合正文。它是其他模型的审查结论，不代表整理者已独立复跑全部探针。

证据等级：
- 实测：历史 1888f84 的已有死锁探针被本次独立复跑，FAIL约1.65秒。
- 合成契约探针：当前 journal映射→repair gate 在合法64位策略hash与固定 gate-policy-1 下终验拒绝；只改预期为相同真实hash后通过。不是已证明发生在PR#128自动修复按钮的事故。
- 源码/日志核查：模式偏离、预算/超时/身份匹配/coverage行为。
- 待验证方案：新目标合同、全链写入派工预算、执行隔离以及v2数值；没有改现有自动修复策略。

内3次限制补充：现有已安装Squad的begin_fix有硬限制，verified历史会累加；不能表述为纯prompt，也不能按外10×内3机械等于30次。尚缺的是新父Run连续性、首次实现/无候选执行等统一派工覆盖以及同根因诊断硬门禁。


---

## 3. 控制协议提案全文（主要评审对象，proposed，未实施）

来源：`docs/brainstorms/2026-09-21-repair-convergence-control-requirements.md`
原文 SHA256：`9a127de6a2dad14e5d752697b335fb7926eea5381b912b7c492ad3d3b2440bfc`

---
date: 2026-09-21
topic: repair-convergence-control
status: proposed
---

# 自动修复的目标保持与收敛控制：需求增补提案

## 问题与边界

用户希望 CouncilKit 的「Squad 自动修复」在长时间执行、跨 Agent 交接和多轮审查后仍保持原研发目标，并在有限成本内到达可验证的交付或明确的诊断结论。

PR #128 已证明三种失败可叠加：真实修复回归；计划验收未形成固定测试；循环脱离控制面。CouncilKit 的账本身份、覆盖判定和格式纠正进一步放大成本。详见 [PR #128 诊断](${COUNCILKIT_REPO}/docs/verification/2026-09-21-pr128-convergence-diagnosis.md)。

本提案扩展现有 repair 控制器、Squad journal 和验收机制，不建设通用工作流平台。它不直接修改运行配置、不改变用户已经授予的权限、不重写旧账本、不降低当前“全部非有效 accepted 项闭合”的准出规则。

原需求 [Squad 自动修复](${COUNCILKIT_REPO}/docs/brainstorms/2026-09-20-squad-repair-until-approved-requirements.md) 已锁定外循环 10 次、内层修复 3 次、可选整段时限、逐轮发布再复审。本文将涉及这些行为的改变显式列为 v2 建议，未视为用户已经批准。

## 核心原则

**Agent 提出方案、实现候选、给出证据；确定性的控制器管理目标版本、执行许可、预算、状态转移和准出。**

系统分别保证三件事：

- 目标保持：后续任务仍能追溯到原请求和冻结验收，不能通过改题变成完成。
- 有界执行：所有写入、验证、诊断、格式修补和恢复共享有限执行预算，不因换 run/session 清零。
- 有证据的准出：只为满足当前合同且证据完整的 SHA 发出通过结论。

有界执行不等于问题必能修好；目标语义和测试有效性仍需独立判断，hash 或状态机不能替代这些判断。

## 当前代码中已经具备与尚有差距的能力

| 能力 | 当前实现事实 | 本提案要求 |
|---|---|---|
| 真实 Squad、独立门禁 | 已接入 SquadctlBridge；journal 映射检查同 SHA、不同 session/worktree、必需 gate | 保留并增加验收项到证据的逐项映射 |
| 外循环上限 | repair state 默认最多 10 次 | 增加原修复链层面的写入派工和总时限预算 |
| Squad 修复次数 | 已安装 Squad 对 source-fix 3 次有硬门禁，并累加 verified 跨 task 历史；不能理解为 10×3 次 | 保留已有门禁，补上初次实现、无候选退出及新父 Run 的统一记账 |
| 同根因检测 | repair-run 的 sameAgainstStillOpen 只比较 againstRunId；stillOpen 统计全部非 accepted 行 | 按稳定根因和实际 still_open 证据计数；缺证明与真复发分开 |
| 超时 | timeout 可空；waitForCandidate 每次进入重建 startedAt | 用持久化 deadline 覆盖全流程和恢复 |
| 历史继承 | 同父 Run 的后续任务要求冻结历史导出和来源映射 | 新父 Run/新 review/session 继续同目标时也不能重置 |
| 目标/验收 | repair package 有 invariant/acceptance 字段；无 plan 时可退化为“修复 ID：标题” | 写入前形成可执行目标合同，标题不能充当完整验收 |
| 终验策略 | repair-run 使用固定 POLICY 字符串，真实 Squad 映射要求 64 位策略 hash | 两端绑定同一份真实冻结策略；测试必须覆盖生产装配 |

上述为当前源码读取结论；不等同于已对按钮进行完整真实 PR 验收。终验 hash 问题另用无副作用探针确认：将真实形状的 journal 经 journalFromSquadStatus 映射，再交 evaluateRepairGate；其他条件均通过时，预期值为 gate-policy-1 则仅报 squad_candidate_invalid，换成候选的真实 hash 即 passed:true。未将此合成探针称为 #128 的实际运行失败。先修复协议不一致，再评价自动循环效果。

## 拟议执行路径

```mermaid
flowchart TD
  A[读取原目标与修复链历史] --> B[裁决发现并冻结验收合同]
  B --> C[固定反例及验证方法]
  C --> D[控制器登记预算并派发有限写入任务]
  D --> E[独立验证全部验收项与累计回归]
  E --> F[独立审查本次改动及受影响路径]
  F --> G{控制器核对证据}
  G -->|本地门禁通过| H[固定候选的最终五席审查]
  H --> N{最终审查及证据完整?}
  N -->|是| P[受控发布并核对远端身份]
  P -->|身份一致| I[已准出：绑定 SHA 和合同版本]
  P -->|发布失败或远端漂移| M
  N -->|缺证据| K
  N -->|新重大反例或冲突| J
  G -->|证实缺陷且仍有预算| D
  G -->|冲突、重复、无进展或越界| J[有界只读诊断]
  E -->|缺记录或执行故障| K[有界补证或重试]
  K --> E
  J --> L{有新证据且仍有原预算?}
  L -->|是：记录裁决后恢复| C
  L -->|否| M[需要处理：明确残余问题与决策]
```

图示为 v2 建议的“本地候选验证后发布”路径，区别于现有逐轮发布。最终完整 CouncilKit 审查及远端核验仍必需；本地候选审查须先补齐能力，不能仅改文案就切换路径。

## 需求

**目标、发现与验收**

- **R1 原目标合同。** 保存原始用户请求及其引用，形成版本化合同：目标、非目标、产品不变量、允许修改范围、验收项、已授权例外、准出策略与成本上限。每项验收要说明如何观察结果、对应何种证据。合同完整性检查通过后才允许写源码。用户已明确的意图直接落入合同；不要求用户逐条确认机械性细节。新增目标、削弱验收或接受风险须回到明确的授权变更，旧历史和预算继续保留。

- **R2 发现裁决与范围分流。** 原始 reviewer finding 是待判定的发现，不直接等于修复任务。它必须绑定候选 SHA、触发条件、违反的不变量、错误终态和证据。分类为：当前改动引入的回归、原范围内遗漏、范围外问题、未证实假设、重复别名、证据冲突。控制器只派发经裁决且在合同范围内的修复；范围外问题保持记录，重大未决不得因“范围外”而批准整个 PR。not_evaluated 不是反证；有验证责任却未评估则属于覆盖缺口。

- **R3 可累积的验收资产。** 每个被接受的缺陷必须形成可重复反例，优先成为版本控制中的测试；确实不可执行的项保留具体 code trace、环境限制及替代证据。修复必须保存坏版本失败、新版本通过的对应证据。验收项与测试/验证方法逐项映射，整体 go test PASS 不能替代未覆盖的验收。Builder 不能自行降低验收或删除失败反例；测试本身错误可经独立裁决修订，保留旧版本和理由。所有候选重跑累计契约测试，模型只需重新判断受影响的语义与真实证据冲突。

**受控执行、连续性与预算**

- **R4 单一写入派工入口。** 控制器在启动 Builder 前持久化合同版本、根因集合、输入 SHA、范围、截止时间和本次执行 ID，并登记本次预算；不能等提交成功才计数。检查同链预算、取得唯一活跃写入身份和预留次数必须构成一次原子授权，并继续遵守 repo＋source branch 的单 writer 约束；未取得授权不能启动子进程。失败、取消、无提交退出仍消耗该次派工预算；同一次执行的基础设施恢复不重复计写入轮，但有独立重试额度且总时限继续累计。Writer 只写候选工作树；Reviewer/Verifier 对候选源码独立只读核验，测试输出写到各自临时目录；发布由已授权控制器执行。只靠 skill 或 worktree 不构成权限隔离，见安全实施边界。

- **R5 跨任务的有限预算。** 项目＋PR＋原始目标对应一条持久修复链，新 task/run/session 自动继承。改标题、换模型、重建父 Run、压缩上下文均不能清零；同一 PR 上真正新目标须显式关联为新的目标版本或新链，不自动猜测切断。以当前 10 外轮/3 内轮为兼容上限，同时引入总写入派工数、整段 deadline、验证/格式/诊断的独立有限重试数。token 可观测时记录，缺失必须标 unknown；时间和次数仍可硬限制，不能宣称精确限额。恢复在发起任何新工作前重新核对预算、身份、合同和旧 writer 退出状态。

- **R6 基于证据的进展与诊断。** 进展记录包括：原目标验收覆盖、经证实根因的关闭/新增/复发、累计反例结果、证据缺口和已用预算；不用 commit 数、原始 finding 数或模型自评分代表进展。同一规范根因在两个完成的修复尝试后仍被有效反例证实，停止同类写入进入诊断。根因关联需记录语义裁决，不能依靠标题匹配。连续两次候选没有新增有效验收或缺陷关闭证据也进入诊断；明确的新反例会保留，不因“坏消息影响进度”而忽略。诊断只能输出新假设、最小反例、必要合同变更或阻塞原因；有新证据且旧预算足够才恢复，否则需要处理。诊断、裁决和计划本身也有 deadline/调用次数上限，不形成新的无限外循环。

- **R7 每次交接重新定位目标。** 每次启动、恢复、模型替换或上下文压缩后，从控制器读取短任务卡：合同版本、当前候选、责任验收项、原反例、已经否证的方案、仍缺证据和剩余预算；需要详情时按证据引用读取。Agent 的长聊天摘要不是权威状态。卡片与控制器不一致时只能先核对，不能继续写入或沿用旧 PASS。计划中的每条必需验收都必须有当前候选证据，不因新 finding 把旧验收挤出上下文。

**准出与产品行为**

- **R8 独立证据准出。** 保存执行器直接采集的命令、cwd、退出码、日志工件、候选 SHA、合同与测试版本、角色/session 身份及验证责任；结构化 envelope 只索引真实证据，不能手写替代 stdout 或 exit-code。语义审核负责判断反例是否代表目标，控制器负责核验来源、覆盖和身份。终验采用同一冻结 gate policy 的实际 hash，未知或不匹配拒绝准出。成功同时满足原目标、冻结范围、现有 finding 准出规则、独立门禁和最终远端身份；任务已完成、进程 exit 0、observe closed 均不代替成功。

- **R9 操作界面表达真实状态。** 启动摘要展示原目标、验收摘要、预算、范围和已有发布授权；用已保存策略可一键执行，正常步骤不反复询问。运行中优先显示“验收完成几项、真实根因关闭几项、当前阻塞原因、剩余预算”，详细日志折叠。明确分开源码修复、补证、事实裁决和根因诊断；提供与原因相符的恢复入口。终态仅为已准出、需要处理、用户停止；展示绑定 SHA、未满足验收和下一项所需决策，不以运行 completed 代替研发目标完成。

预算耗尽后的继续沿用原需求已有的显式授权规则：可结束并导出交接；也可在看到诊断证据、耗尽项和所需增量后，由用户一次授权追加预算。追加是同链的版本化预算修订，保留全部已用量、历史及原目标，不重置计数。普通“恢复”不能暗中追加；已触发同根因重复诊断时，仅追加预算不足以解除诊断要求。

## 安全实施边界

必须区分“控制器拒绝派发/发布”和“Agent 在操作系统层不能绕过”。清除 token 环境变量不够：SSH agent、Git credential helper、宿主目录、共享同用户文件权限都可能保留发布或改账本能力。

首版最小工程边界是：Builder 只写自己的工作树；控制器合同、账本、证据目录不可写；不得访问发布凭据和 SSH socket；发布动作由独立控制器执行。此隔离覆盖所有会执行候选代码的角色及其子进程，包括构建、测试和验证执行器；不能让 Builder 借候选测试获得 Verifier 的更高权限。发布执行器不得以发布权限运行候选提供的脚本或 Git hooks。具体用受限 runner、隔离用户或容器由实施阶段核验，不能把普通 worktree 称为安全边界。若某 runtime 暂不支持，就明确标为协作约定模式，不声称“不可绕过”；策略要求强隔离时不能静默降级。

任何停止/超时只终止本任务持有的执行；旧 writer 无法确认退出时不能发放新 writer。范围内的常规修复沿用现有授权，权限隔离不是逐步弹窗批准。

## 实施顺序与验收

先建设一个能用历史轨迹和模拟执行器重放的控制协议测试集，日常验证不调用真实模型。测试输入为明确状态/证据/事件，断言可执行动作与准出结果；少量真实隔离仓验收再验证 runtime 是否遵守能力边界。

| 阶段 | 交付 | 必过验收 |
|---|---|---|
| A 协议修正 | 当前 gate hash、coverage、同根因判定、整段时限语义一致 | 一个真实形状的合格 Squad 候选能通过；未知/不匹配策略不能通过；弃权不制造假冲突；已关闭项不计复发 |
| B 目标与证据闭环 | 合同、验收映射、规范根因、原反例和执行器回执 | 重放 #128 的旧 Prompt 问题换定义、Ready 测试手动触发、旧 PASS 沿用等轨迹，均不能虚假准出 |
| C 全链控制 | 新父 Run 继承预算、写入前原子登记、有限补证/诊断、恢复核验 | 两个控制器同时启动最多一方取得写许可且预算不超限；换 run/session 后预算不变；无 commit 的长任务到期限停止；崩溃恢复不重复发 writer/push；格式失败不派源码修复；追加授权只增加同链上限不清零 |
| D 候选验证与执行隔离 | 本地受控候选复审、发布隔离、界面目标卡 | 独立角色拿到同一候选；Builder 原始 shell 或候选测试均无法修改控制面、读取发布凭据或越权发布；发布权限不能被候选脚本/hooks 继承；门禁后发布一次并核对远端 |

附加防过度阻塞测试：两个不同新根因不能误判为同一根因重复；合法测试纠错可通过版本化裁决恢复；一席未评估不否定另一席的有效证明，但未分配责任或未覆盖的必需验收不能放行；范围外重大项仍阻止整个 PR 准出。

准出测试与终止测试都必须有正例。一个“永远拒绝通过”的控制器不满足本提案。

## 候选默认策略（待实施时确认，不修改当前配置）

建议为新 v2 profile 提供“有限自主修复”：整条链最多 3 次源码修复派工、总时限 2 小时、同根因 2 次失败转诊断；只读诊断最多 15 分钟且仍受总时限约束。已有 profile 保留旧合同，不能静默迁移。数值是起始策略建议，可按任务规模预设；并非“2 小时一定修好”的承诺。

默认保留最终五席完整审查。内层先跑累计测试和定向独立检查；缩减的是重复发现过程，不能减少已冻结的验收责任。最终发现新重大反例时沿同链处理，禁止改记新链绕过上限。

## 待实施阶段确定

- 基于用户授权选择 v2 数值和发布节奏；本次不把提案默认值写成已批准策略。
- 核验各 adapter 的真实权限隔离及子进程停止能力；无法硬隔离时确定产品中的能力标识。
- 根因/测试语义争议由独立裁决角色处理一次，有证据可自动解决；涉及目标变更或风险接受再请求用户决策。
- 旧修复链无可靠历史时保留 unknown，完成历史导入或明确重建基线裁决后再启用自动写入，不能记零。

## 当前实现依据

- [repair-run](${COUNCILKIT_REPO}/cli/src/auto/repair-run.ts:663)：重复判断、候选等待超时与父 Run 身份。
- [repair-persist](${COUNCILKIT_REPO}/cli/src/auto/repair-persist.ts:18)：现有外循环上限与持久字段。
- [squadctl-bridge](${COUNCILKIT_REPO}/cli/src/auto/squadctl-bridge.ts:593)：跨任务历史继承与真实执行。
- [squad-journal-map](${COUNCILKIT_REPO}/shared/runtime/squad-journal-map.ts:10)：独立性和真实策略 hash。
- [repair-gate](${COUNCILKIT_REPO}/shared/runtime/repair-gate.ts:98)：准出条件。
- [repair-package](${COUNCILKIT_REPO}/shared/runtime/repair-package.ts:159)：目标/验收输入当前可能退化为 finding 标题。


---

## 4. PR #128 诊断全文（历史快照）

来源：`docs/verification/2026-09-21-pr128-convergence-diagnosis.md`
原文 SHA256：`effb649cc732f317965c25e376f959b7d7f77b1d6b611c37bfc62c3a882e0d7e`

# PR #128：审查—修复循环不收敛的诊断与收敛协议

日期：2026-09-21。取证快照约 19:36–19:40（Asia/Shanghai）。

对象：[paas-core/agentrun #128](https://code.alipay.com/paas-core/agentrun/pull_requests/128)。Grok Build session：`01a0bf28-47f7-7410-adf9-5c4a3ee723f1`。

本次只分析运行工件、提交、执行记录与 CouncilKit 实现；复跑一个既有历史反例。没有启动新模型审查、修改 PR 源码、推送、改账本或中止正在执行的运行。本文不是当前 PR 的准出结论。

## 结论

不收敛来自三个相互加强的机制：

1. **工程问题真实存在，但修复没有持续积累防回归证据。** 同一恢复状态机在 generation、store 事务、flight ownership、Prompt 外部副作用之间反复移动保护点；修一个窗口又暴露另一个窗口。
2. **实际外循环脱离了 Squad 的约束。** 正式独立 Review/Verify 只覆盖到 `9b92b35`；后七个提交由主 Grok 直接修补再交 CouncilKit，缺少按修复链累计的停止条件。
3. **CouncilKit 把发现、验证和裁决混在同一本账里。** 别名膨胀、旧结论每 SHA 失效、未评估被判冲突、格式纠错重新调用模型，使真实工作和记账工作一起增长。

可收敛的单位应是“已裁决的根因 + 固定反例 + 当前候选的验证”，而不是“下一轮所有模型都不再产生任何文字意见”。预算耗尽必须进入诊断或升级，不能冒充通过。

## 事实规模与统计口径

远端 `git ls-remote` 核验：PR source 为 `3bada48be6948e8a6a0e6a6cf42a03cc38ff215c`，master 为 `7fc5095b4b607ef36c4008581d28d7e63c76192d`。源分支相对 master 有 17 个提交，42 个文件，新增 1585 / 删除 105 行。

PR #128 对应 16 个 CouncilKit review run：13 completed、2 failed、1 running。已结束 run 的墙钟时长逐项相加约 **362.7 分钟（6.0 小时）**；这是各 run 时长之和，不是人的连续等待时长，也不包含 Squad 实现成本。已结束 run 有 79 条席位/聚合执行记录（执行时长累加 744.8 分钟），运行中另有 4 条；另有 17 条 assessment correction 记录，后者不能直接等同于 17 次独立计费请求。没有跨运行完整 token 账单，不估算总 token 或金额。

以下“重大未决”是账本口径，包含缺少当前 SHA 验证的历史项，**不是已证实 bug 数**；“闭合”是当前 SHA 有验证的条目数，也未做别名去重。

| 开始时间 | SHA | 账本总项 | 重大未决 | 当前 SHA 闭合 | 本轮墙钟 |
|---|---|---:|---:|---:|---:|
| 00:25 | efcc75b | 15 | 3 | 0 | 12.6 分钟 |
| 01:08 | 1151790 | 16 | 0 | 5 | 10.9 分钟 |
| 01:21 | 2dc1541 | 17 | 2 | 0 | 9.3 分钟 |
| 10:54 | 3f251af | 21 | 9 | 0 | 15.1 分钟 |
| 13:13 | 9b92b35 | 24 | 4 | 0 | 27.4 分钟 |
| 15:06 | 690db5c | 30 | 4 | 0 | 29.4 分钟 |
| 15:39 | 846ca2b | 34 | 6 | 0 | 26.1 分钟 |
| 16:10 | 1888f84 | 37 | 5 | 3 | 26.5 分钟 |
| 16:41 | 8deaad6 | 49 | 16 | 0 | 42.6 分钟 |
| 17:28 | 4fd41df | 59 | 11 | 9 | 34.6 分钟 |
| 18:05 | f72e942 | 66 | 16 | 5 | 52.1 分钟 |
| 19:08 | 3bada48 | 尚无最终账本 | — | — | 取证时仍运行 |

特别有区分力的对照：`1151790 → 2dc1541` 只增加 Stop 行为文档，但 5 个已验证关闭项在新 SHA 上变成未验证，重大未决由 0 变为 2。这不能解释为这次文档提交引入了两个代码 bug。同 SHA `3f251af` 的 08:26 对照审查与 10:54 新审查，账本重大未决分别是 2 与 9，也说明计数受审查范围/账本身份影响。

## 原因一：真实并发回归与补丁振荡

连续提交自身说明了振荡：

| 提交 | 保护点变化 | 下一轮暴露的约束 |
|---|---|---|
| 1888f84 | failure persist 跨 store 写持 flightsMu | 与 store mutator → flightsMu 形成反向锁序 |
| 8deaad6 | 去掉跨 store 持锁、去掉部分 mutator 内检查 | generation 检查与 durable commit 的窗口重新暴露 |
| 4fd41df | 恢复 mutator 内检查；先落 Starting 再 bump | Starting 写失败时，旧 flight 没失效 |
| f72e942 | bump 改回 persist 前；Prompt 增加检查 | 检查通过后的提交仍可失代；SubmitPrompt 已产生外部副作用 |
| 3bada48 | 增加会话锁、补调度、失败后回退 | 当前是否满足全部不变量尚需冻结候选验证 |

这不是单一锁位置问题。内存 generation、durable phase 和远端 runtime 副作用属于不同状态域，局部检查不自动构成整个操作的原子性。

本次独立复跑历史已有测试：

```text
工作树：~/.config/councilkit/runs/ck-review-6d7df10f-dfe6-4cfc-b1be-834171f104ab/workspaces/attempt-3
候选：1888f84da27addb060117dee85f68421eaba1b65
命令：go test -mod=vendor ./pkg/runtime/manager \
  -run '^TestAdversarialMarkRecoveryFailedDeadlocksIdleCommit$' -count=1 -timeout=8s
结果：FAIL (1.65s)
session_recovery_adversarial_probe_test.go:107:
deadlock: markRecoveryFailed holds flightsMu across UpdateSession while idle commit callback needs flightsMu
```

该探针用串行写 store 包装器模拟 bbolt 单写者并施加交错；它证明历史候选上的可复现回归，不证明当前 SHA 仍有该死锁。

后七个提交仅两个触及测试：`690db5c` 新增一个失败恢复测试；`4fd41df` 把既有断言改成 `Eventually` 内再次调用 Retry。后者在观察终态时主动推动了系统恢复，不能证明“Ready 后无需外部再次 Retry 就会自动恢复”。见目标工作树 `pkg/runtime/manager/session_recovery_test.go:252–255`。

审查工件保存了大量有名字的失败探针，但未作为修复提交的回归测试进入分支。结果是每轮重新花模型成本发现窗口，常规测试仍然绿。

## 原因二：外循环没有遵守修复链的停止合同

Squad 当前规则明确：默认最多 3 个逻辑 fix 轮、同根因第二次未闭环转诊断，不能通过新建同一任务重置预算；Builder 修复沿用同一 session，独立 Review/Verify 对应相同候选 SHA。

实际 session 与 journal 取证显示：正式门禁覆盖截至 `9b92b35`，后续七个提交仍引用 `Squad-Task: 20260921-ck981a-r4w8`，但未再次执行相应的独立 Squad Review/Verify。commit trailer 只能表明关联，不能证明该提交受门禁覆盖。CouncilKit 有真实独立审查，不能将后续循环称为“完全没有独立 review”；缺失的是完整的 Squad 候选交付协议和独立验证。

新任务创建使用 `--new-repair-chain`，继承历史为空；本 session 未执行 history export，新任务未运行 convergence。这些事实支持“收敛状态没有贯穿外循环”，但不据此推断操作者故意绕过。

PR 描述仍写 Candidate `efcc75b` 和该 SHA 的 PASS，与现在远端 `3bada48` 不一致。旧 PASS 不能沿用为当前候选的准出证据。

这也不只是“计划没有考虑到”。新 Squad 的 `plan.md:23–24` 已要求旧 Retry 清理后补恢复，`plans/plan-b.md:7` 已要求同时保护 commit/compensation/cleanup/finish/already-idle，并用 barrier 验证；后续仍反复补这些边界，说明计划要求没有一一映射到门禁。

另有证据绑定问题：Grok session L1187 人工组装 review/verify 回执及 stdout，用单条测试输出登记整包测试命令，并显式登记 exit 0。独立子 session 确实跑过相关测试且报告 PASS，因此不能据此声称测试没有运行或失败；但这种转录破坏了命令、输出、退出码的一一对应，应直接保存真实执行回执。

## 原因三：CouncilKit 自身放大成本与未决数量

### A. 增量意图没有变成增量输入和验证责任

`review-context.ts:143–145` 总是冻结 merge-base→head 的完整 PR diff。`--against` 仅补充旧 SHA→新 SHA 的指令。各席实际报告确实有按增量工作，不能一概称为全量重审；但每轮仍派全班，且输入没有把 patch delta 与背景分开。

`ledger.ts:277–303` 给模型的账本每项只有 ID、级别、状态、标题，每状态最多 40 项，总长 12,000 字符；却在 `:437` 要求所有历史非 accepted 项的 assessment，包括 closed、minor、nit。原反例与证明的缺失，使稳定验证变成根据标题重新推断问题。

### B. “未检查”被判成“反对关闭”

`shared/runtime/reviewer-assessment.ts:243–260` 将所有 outcome 放入同一集合；任何差异都令 coverageComplete=false。

真实命中：a67fc61f 的 `h-254c2a1f26cd` 有四席 `verified_closed`（回归测试）及维护席 `not_evaluated`，仍被标记 `contradictory_outcome`。`h-a6f278d6eff2` 四席 `still_open` 加一席 `not_evaluated` 也被判冲突。未评估应记录责任覆盖缺口，不应冒充反证。

### C. 同一问题的别名与定义漂移

`ledger.ts:586,657` 的 ID/匹配依赖文件、标题、严重级别和 token 重合。a67 报告中单个 failure-commit 根因列了三个 ID；Prompt 的原“占用期间写 running”已被多个席位验证关闭，另一席却用同一 ID 跟踪新的“SubmitPrompt 已接受但返回 busy”问题。新后果需要新反例和关联关系，不能悄悄改变旧项关闭条件。

`ledger.ts:390–424` 会补回 Aggregator 未采纳的独立发现；`:777–786` 任意 still_open 或匹配的文字发现均可阻止关闭。保留少数意见是合理的，直接把它当作未经裁决的修复要求则会扩张工作。

页面“重复出现”依据 `shared/runtime/review-case.ts:104–115` 统计历史 openIds 的继承次数，并非统计“修好以后又被复现”的次数。页面的 16 项和重复警告不能直接用于评估实际工程进展。

### D. 格式修补消耗了实际推理时间

a67fc61f 共 52 分钟；其中 assessment correction 的额外阶段墙钟约 18 分 37 秒，三条 correction 均因 `substantial_rejudgment` 未采纳。跨链 17 条 correction 记录均未被采纳。不能为修 JSON 重新做事实裁决，更不能把格式重试当新的源码修复轮。

所给 Grok session 自报 876 次 modelCalls、181,743,937 input tokens，其中 167,900,928 为 cached read，559,876 output tokens。该数字包含整个长会话的交接、实现、环境排查和轮询，且不含全部子模型成本；不能说成 PR 七轮消耗了 1.82 亿新增 token，也不能直接折算费用。

## PR #128 下一轮应该交付什么

### 1. 先做一次证据整理，不再直接派发修复

冻结 `source SHA / base SHA / 最近完整报告 / 当前未完运行状态`。基于已落盘证据把 66 条记录整理成规范根因卡；保留旧 ID→规范 ID 映射，不直接改原账本。每张卡必须含：不变量、触发序列、预期/实测结果、来源 SHA、可执行反例、修复范围、独立验证责任人。

用四种状态区分：已证实且未解决、已解决待更新验证、重复别名、尚未证实/需要裁决。不因缺少复现直接判假；无可运行测试时，允许可核对的具体 code trace，但必须说明为何不可执行及边界。

### 2. 把反例组成一个小型恢复契约测试集

优先整理以下五组，不预先假定它们恰好等于五个独立 bug：

| 契约 | 必须覆盖的交错与断言 |
|---|---|
| epoch/身份隔离 | 旧 Resume 成功/失败跨 Starting，不得污染新代；旧完成不得清掉后继 flight；UUID 不换、无 New fallback |
| durable 提交 | 检查前/后/提交后推进 generation；持久化失败、回退失败后仍可恢复，不能暴露假 idle 或永久 error |
| 恢复活性 | Ready 遇到 startup/runtime/retry flight，释放后必须按约定补调度；测试只能观察终态，不能再次调用 Retry 帮它完成 |
| Prompt 外部副作用 | 接受/拒绝语义与 SubmitPrompt、Resume 的交错一致；返回 busy 不得遗留未记账的已接受 turn |
| 锁序和停机 | 真实或等价单写者 store 的双会话交错；Stop/cancel 有界；锁序固定，无全局元数据锁跨 I/O |

每个接受为缺陷的反例，先在对应历史坏 SHA 上失败，再在候选上通过，并纳入版本控制。使用 channel/barrier 控制时序，避免靠 sleep 撞概率；`-race` 补充检测数据竞争，不能代替上述业务交错断言。

### 3. 对这一小块状态机做一次设计裁决

用状态转移表明确 New / startup recovery / runtime recovery / Retry / Prompt / Stop 的占用者、generation、durable phase、远端副作用及失败补偿。每个操作回答“何时算接受、何时生效、谁释放、失败后谁保证继续恢复”。

先选择一套一致的 ownership 与提交协议，再实现；不要继续逐条听取“把检查移进去/移出来”的局部建议。可以评估按会话串行化或显式 owner token 的统一机制，但本次证据不足以替项目直接选定重构方案，也不主张顺带重写整个 Runtime。

### 4. 在本地候选完成内循环，再发布

一个连续 Builder 负责实现；一位独立 Reviewer 检查协议与 delta；一位独立 Verifier 在同 SHA 跑完整契约测试集及必要现有检查。源码变动使候选门禁失效；更新候选后重新运行受影响证明。

中间修复保留本地提交即可，不在每个小补丁后 push 并启动五席 CouncilKit。候选通过后发布一次，运行一次完整的最终审查。后续只有重大新反例或架构/协议变化才重新做全面探索；普通修复只做反例验证、受影响路径检查和回归测试。少用席位的前提是责任覆盖明确，不能把“少人看”当质量保证。

### 5. 预先冻结成功和停止条件

成功需要同时满足：当前候选/远端身份一致；所有约定的 critical/major 有证据关闭；其余项按冻结合同处理；独立 review 与 verify 对应候选；契约测试和相关检查通过；不存在未裁决的重大反证。未决 minor/nit 可否延后需明确授权，不能擅自改现有 gate 或 accepted。

同一根因第二次仍成立、两轮经证实根因数未下降、出现新的严重回归，进入诊断并冻结补丁循环；修复链最多三轮，不随 task/run 重建清零。证据不足、模型分歧、格式失败分别进入定向验证、裁决、格式修补，不能全部转成“再改代码”。

这保证有限步到达“通过或明确阻塞/升级”，不保证任意复杂问题必在三轮内修好。

## CouncilKit / Squad 改造优先级

| 优先级 | 改动 | 验收信号 |
|---|---|---|
| P0 | 修复 abstain/未覆盖与事实反证的区分 | 四席 closed + 一席 not_evaluated 不再生成事实冲突；无人验证仍不通过 |
| P0 | 将 finding 提案、证据裁决、修复任务分开；稳定根因卡/alias | 同一反例不因行号/标题改变增生阻塞；新反例不覆盖旧关闭条件 |
| P0 | PR/repair-chain 级累计预算与强制转诊断 | 新建 task 仍继承轮次；每个新候选必须有独立门禁，trailer 不算凭据 |
| P1 | 真正 delta 输入 + 原反例测试工件交接 | Builder 可直接复跑已发现反例；Verifier 不需从标题重新发明测试 |
| P1 | 关闭证明拆为稳定测试资产和当前 SHA 运行回执 | 文档变动后可重跑契约测试获得新回执，避免对每个旧项重新写一篇 review |
| P1 | 格式错误只修格式；按责任指定验证席位 | correction 不再重判；记录耗时、输入输出 token（若可得）、覆盖根因数 |
| P2 | UI 区分真实重大阻塞、历史未验证、别名、未裁决假设 | 用户能看见实际根因是否减少，而非只看原始 finding 数 |

不要简单以多数票关单，也不要删掉历史账本或放松 SHA 绑定来换取“通过”。需要减少的是重复推理和未经裁决的工作，保留的是能复查的候选证据。

## 可交给 Grok 的下一阶段指令

```text
PR #128 改为根因收敛阶段。先停止新增补丁和新的全量 review；保留现有 run 和历史，不重开 repair chain 清零预算。
先交付根因卡、旧 ID 映射和固定反例测试集，再改源码。复用所有现存 review 工作树中的探针，但逐一核对真实调用交错；每个被接受的反例要证明历史坏 SHA 失败。
冻结恢复状态机的 ownership、generation、durable commit、Prompt 副作用、锁序和补调度合同。由同一 Builder 统一实现，一位独立 Reviewer 裁决，一位独立 Verifier 在同候选 SHA 运行所有契约测试。
任何修复必须把对应反例纳入版本控制。不得在 Eventually 中再次调用 Retry 来证明自动恢复，不把 go test -race 通过等同于恢复协议正确。
同根因第二次未闭环立即转诊断；修复链最多三轮。格式错误只修格式，未验证意见先证伪/证实，重大事实冲突先裁决，不自动追加源码补丁。
本地候选完整通过后再发布并做一次全量 CouncilKit 审查。准出条件是冻结合同和当前 SHA 的证据，不能用旧 PASS、completed、预算耗尽或零文字意见替代。
```

## 证据入口

- [最近完整报告 a67fc61f](http://127.0.0.1:43127/reports/ck-review-a67fc61f-800d-41d5-83bf-a32e4bf2b8c7)：真实剩余反例、同 ID 定义漂移、关闭争议。
- [最新运行 fff9e15e](http://127.0.0.1:43127/reports/ck-review-fff9e15e-2173-40c7-849c-177f0959b826)：取证时未完成，不作最终准出依据。
- 本文同目录 `2026-09-21-pr128-review-history.json`：16 run 统计快照。
- 本文同目录 `2026-09-21-pr128-session-evidence.md`：Grok session/journal 的精确引用。
- 代码基线：CouncilKit `ad62658d6775497ea12a200dbc11702c9f86bab0`；目标 PR `3bada48be6948e8a6a0e6a6cf42a03cc38ff215c`。


---

## 5. Grok 执行记录证据索引

来源：`docs/verification/2026-09-21-pr128-session-evidence.md`
原文 SHA256：`2938c3f9ca839932313256d81e5adab15785a8e6599868a9ed789b7c89bb9cc5`

# PR #128：Grok session 证据索引

只读取证，2026-09-21。会话 ID：`01a0bf28-47f7-7410-adf9-5c4a3ee723f1`。

源文件（L 为一基 JSONL 行号）：

```text
${GROK_SESSIONS}/%2FUsers%2Fhengzhuo%2F.grok%2Fworktrees%2Fant-agentrun%2Fresume/01a0bf28-47f7-7410-adf9-5c4a3ee723f1/chat_history.jsonl
```

仅引用可见 user/assistant 消息、工具调用和持久工件，不转录模型内部推理。

| 证据 | 原记录位置 | 核实结论 |
|---|---|---|
| 正式门禁候选 | L1176、L1193；`.squad/20260921-ck981a-r4w8/runs/review-1.json` 与 `verify-1.json` | 两个独立 Grok subagent 在不同 detached worktree 核对相同 `9b92b35`；门禁是真实存在的 |
| 后续外循环 | L1239 用户要求继续修复直到准出；L1297/1351/1435/1513/1605/1660/1796 启动 review | 此后七个提交没有新的 squadctl 候选登记或独立 Squad verifier；CouncilKit review 本身仍有独立席位 |
| 新修复链 | L946；`.squad/20260921-ck981a-r4w8/repair-history.v1.json:1` | intake 使用 `--new-repair-chain --repair-chain-id ck981a31fd-pr128`，历史 entries 为空 |
| 收敛检查 | L60、L156；session 工具调用检索 | convergence 只针对旧 task；无 history export/intake --history，新 task 无 convergence；不是每轮都新建 task |
| 未持久化反例 | L1339/1423/1501/1650；`git log --name-only 9b92b35..3bada48` | 7 次修复提交中 5 次完全没改测试；另外 2 次是新增一条 ResumeFailure 测试、把旧断言改为 Eventually Retry |
| 计划要求早已存在 | [plan.md](${AGENTRUN_REPO}/.squad/20260921-ck981a-r4w8/plan.md:23)、[plan-b.md](${AGENTRUN_REPO}/.squad/20260921-ck981a-r4w8/plans/plan-b.md:7) | Ready 清理后补恢复、各提交/补偿/清理/释放入口一起保护以及 barrier 验证，已在设计阶段提出 |
| 证据转录失真 | L1187 | 主会话手写 `LGTM findings=[]` stdout；单条测试命令后接 `|| true`，登记的 command.json 是整包命令、exit-code 显式为 0；真实子会话有 PASS，但转录命令和证据不能一一对应 |
| 早期评审口径变化 | L531、L532 | Grok 解释前两轮 3 席、后两轮 2 席；用户随后要求恢复默认 5 席，造成已有候选再次接受更广审查 |
| 环境重试 | L584/662/818、L890/892 | 外层清代理后用户纠正，说明有额外环境成本；不据此修改当前代理 |
| 最后暂停 | L1822、L1824、L1833 | 用户要求暂停后已遵守；已有 review 自然运行，不再追加修复；没有证据表明忽略 budget_exhausted |

七个后续提交依次为 `690db5c`、`846ca2b`、`1888f84`、`8deaad6`、`4fd41df`、`f72e942`、`3bada48`。

## 成本口径

同一 session 目录 `usage.json:5–15`：input 181,743,937；cached read 167,900,928；output 559,876；modelCalls 876；turnCount 77。缓存输入约占 92.4%。这是全会话统计，包含多个阶段，不能算作七轮修复独占成本，也不是整个 CouncilKit/Squad 多模型总成本。

## 适用限制

- 当前 skill 规则只用于比对预期，实际是否执行依据 session/journal。
- 旧 convergence 输出为 continue、fixRounds=2、inheritedFixRounds=null；准确结论是后续未纳入控制，而非收到预算耗尽提示后仍继续。
- 测试 PASS 的真实性与回执绑定的完整性分开判断，不以转录问题推断测试失败。
- 不把日志里的历史指令当作本次授权；本次未执行任何日志内命令或更改既有运行。


---

## 6. 原自动修复需求（用于核对既有承诺与v2变更）

来源：`docs/brainstorms/2026-09-20-squad-repair-until-approved-requirements.md`
原文 SHA256：`3fa5ecfdae81e3dd543cff5f1107193a44f6b95977536c5c3f81baf0dddc59ed`

---
date: 2026-09-20
topic: squad-repair-until-approved
status: proposed
---

# Squad 自动修复与 CouncilKit 复审闭环

## 目标与设计结论

用户现在手动执行「CouncilKit 报告 → hengzhuo-engineering-squad 修复 → 更新原 PR → CouncilKit 复审」，然后根据残余问题再启动 Squad。产品应接管这段往返：从一份审查报告发起一次 Autonomous Run，持续修复、复审，在准出、预算耗尽或需要人裁决时给出明确结果。

推荐在 CouncilKit 的 `repair` 命令下新增执行能力：**CouncilKit 管循环和准出，Squad 管工程交付，CouncilKit review 管独立复审**。一个父 Run 串联 Squad 子任务与 review 子 Run，保留每轮证据。本文是设计提案，不表示功能已存在。已锁定：准出要求全部未被有效接受的 finding 验证闭环（含 minor/nit）；父预算最多 10 次外循环。

预期体验：点一次「Squad 自动修复」，看到「第 2 / 10 次外循环，正在复审，剩余 2 项」；正常路径无需复制报告、重启 skill 或手动再审。完成时展示准出 SHA、最终复审和门禁证据；中断时展示具体原因与可恢复入口。

## 已有能力与缺口

以下事实核对自当前仓库 `4b4f1f6`，以及本机 Squad v2.1 skill 和控制面文档。

| 已有能力 | 可复用部分 | 新闭环需要补足 |
| --- | --- | --- |
| `fix` | 单轮方案陪审、一个集群 apply、一次 `review --against` | 它只按复审退出码判断流程结束，没有准出循环 |
| `repair export` | 完整 SHA、稳定 finding ID、rootCause、范围、不变量、验收、deferred | 自动交接、可信完成回执、跨轮预算 |
| `review --against` | 延续账本、验证旧问题、保留回归和新发现 | 强制同 PR、候选和 against 链关联；冻结复审班子 |
| 关闭证据 | 独立 reviewer 在同 SHA 上提供测试命令或代码位置 | 将全部必要证据合并成严格机器准出判定 |
| Squad `intake/convergence` | 严格导入、最多 3 个逻辑 fix 轮、同根因两次未闭环转诊断、跨任务历史 | 无人值守的 Orchestrator 启动与受监督交付 |
| Squad observe | 过程、任务文档、handoff | 父 Run 的进度、决策、停止与恢复 |

关键事实：

- review 部分席位失败时可能仍是 `exitCode=0/status=completed`，而 `incomplete=true`；账本落盘失败也可能只记诊断。零退出码不能当准出。
- `canExportRepairPackage` 为兼容旧记录接受未定义的 `evidenceComplete`。自动准出必须要求明确、可核验的完整性，不能照搬兼容判断。
- 现有 `review <PR URL>` 获取远端 PR HEAD，没有公开的本地候选 SHA 参数。首版已锁定为每轮发布候选到原 PR，再复审；不在本版做本地钉 SHA 复审。
- `squadctl` 是控制面，没有“一条命令完整执行 skill”的接口；worktree、角色运行、裁决、commit 和交付仍需 Orchestrator。
- `intake` 只允许未冻结的 briefing，不能每轮向已冻结 task 再导入新包。
- Squad 已有跨任务历史格式和 `intake --history`，但当前入口仅绑定本任务目录，含外部祖先的历史不能完整核验，会进入 `inspect_history`。可验证的祖先目录解析/历史交接是本次必补能力，不能仅传一个历史 JSON 就宣称继承成功。
- 现有 apply 的测试 gate 失败可能仅记日志再 push。新闭环使用 Squad 的严格门禁，不能继承这种推进条件。

## 方案选择

| 方案 | 做法 | 代价与适用性 |
| --- | --- | --- |
| A：交给一个长期 Agent 全程决定 | Agent 反复调用 skill 和 review，最后读报告决定停止 | 接入快，但完成判定、恢复、预算容易依赖自然语言和会话；适合验证流程，不适合作为产品准出契约 |
| B：CouncilKit 父 Run + Squad 执行桥接 | 持久控制器决定阶段与准出；Agent 只在受约束的 Squad 子任务中规划、实现和裁决 | 复用现有资产，需补执行契约；推荐 |
| C：将 Squad 工程引擎搬入 CouncilKit | CouncilKit 自行调度 Planner/Builder/Reviewer/Verifier 和全部门禁 | 消除外部 skill 安装依赖，但形成第二份工程协议，维护成本高；首版不选 |

另一个可选方向是「先在本地反复修复与复审，准出后只 push 一次」。它减少 PR 上的中间提交，但需要新增本地候选 review、发布后再校验等能力。首版采用逐轮更新原 PR，保留该方向作为后续独立设计。

## 用户流程

```mermaid
flowchart TB
  A[审查报告：Squad 自动修复] --> B[核对 PR、证据、执行配置与预算]
  B --> C[导出当前问题，启动 Squad 子任务]
  C --> D[规划、修复、独立评审与验证]
  D --> E{Squad 候选门禁通过}
  E -->|未通过且可继续| C1[原 Builder 会话修复]
  C1 --> D
  E -->|通过| F[发布同一候选到原 PR 并核对 SHA]
  F --> G[CouncilKit 完整复审，延续 against 链]
  G --> H{机器准出判定}
  H -->|满足全部条件| I[已准出：SHA 与证据]
  H -->|问题明确且预算足够| C
  H -->|预算耗尽、反复失败或需裁决| J[需要处理：原因与恢复入口]
```

图中只有开启下一 Squad 子任务才消耗父预算的一次外循环；子任务内部的 candidate 修复走 Squad 自己的 3 次上限，不扣父预算。任何阶段也可因执行失败进入恢复，或响应用户停止。零问题、旧报告和证据不全的入口行为见 R2。

## 产品要求

**入口与授权范围**

- **R1. 一次启动，一条 PR。** 从已有 PR review 报告进入；冻结规范化 PR 身份、仓库、源分支、来源 run、来源 SHA、目标 base、复审班子和执行配置。首版支持现有 GitHub/AntCode PR 能力，不新增 PR 平台。默认修复包覆盖所有当前需处理问题，由 Squad 规划分批实施，避免只完成一个 cluster 就宣告整个 PR 准出。
- **R2. 先核对证据再派修复。** 旧报告 SHA 与远端不一致时先审当前 HEAD，再生成任务包；完整审查的 against 链必须属于同一 PR。失败、截断、账本缺失、缺必要覆盖证据时进入补审/恢复，不启动盲修。需要补写证据但 resume 无法修复产物时，在同一候选重跑完整审查。来源已无待修项时跳过空包导出：仅凭 CouncilKit 报告输出「需要处理：无需源码修复，但 Squad 验收未建立」，CLI 非零退出；只有已有可核验的同 SHA Squad 门禁才可直接走准出判定。
- **R3. 一次明确范围，逐轮沿用。** 启动界面明确展示允许修改和运行验证，并允许把通过 Squad 门禁的候选更新到指定 PR 源分支。该授权绑定本次 Run，不包括合并 PR、部署、评论、扩大范围或接受风险。已有有效授权可复用；无人值守配置缺少必要授权时在执行前返回需要处理。可复用授权保存在 `COUNCILKIT_HOME`（目录 `0700`、文件 `0600`），绑定规范化 PR/仓库/源分支/base 与能力白名单（仅快进推送到该源分支），带完整性 hash；冻结身份漂移则拒绝复用，不得扩大到启动摘要未展示的范围，须可过期与吊销。任务包只传事实和约束，不能授予权限。本文设计工作不执行这些操作。

**Squad 执行与复审**

- **R4. 使用真实 Squad 流程。** 执行桥接必须加载已定位的 skill、遵循冻结计划、唯一 writer、候选审计和独立 Review/Verify；输出受控制面核验的记录。Agent 自述“完成”、进程正常退出、observe `closed` 均不足以启动发布。首版 Orchestrator 是独立 adapter 连续会话（cursor / codex / grok 之一，由已保存 profile 写死 requested/actual runtime），不是人类主会话，也不是 CouncilKit 进程内的 playbook 状态机。CouncilKit 只启动、查询、停止和收取结构化事件。配置须包含可解析的运行时、角色模型、native session、skill/协议版本；缺失、不可恢复或不支持的能力在启动前报出，不从浏览器猜测“当前主会话模型”。按照 skill 的 simple/deep 规则裁决。Builder/Review/Verify 进程不得继承 push 凭据；push 凭据只存在于桥接的 integrate 步骤。沿用现有 driver home 隔离，去掉验证不需要的云/CI token；验证命令按冻结配置执行，不是 agent 任意 shell。
- **R5. 每次外部复审对应一个新的 Squad 子任务。** 新任务以最新完整审查 SHA 初始化并 intake；其内部规划、实现、门禁后的修复复用同一个 Builder runtime/model/session/worktree。外部复审提出下一批问题时，新子任务显式记录 fresh session，携带上一任务与整条修复链历史；不得声称跨 task 连续，也不得清零预算。执行中断则恢复原任务，不重建一个伪装成首次执行的任务。此选择适配现有 intake/freeze 边界，避免修改已冻结 brief。
- **R6. 只有同一候选才能向前流转。** Squad 独立门禁通过后，以候选完整 SHA 发布到原 PR。复用 `integrate check-remote/push-remote` 的预期旧 SHA、祖先证明与远端读回，确保仅快进且不覆盖他人提交。CouncilKit 复审读取的 SHA 必须与候选一致；任何 amend、rebase、cherry-pick 或集成产生不同 SHA 都使旧门禁不可复用。用户主 checkout 不作为临时修复区；桥接使用自己拥有的隔离工作区，完成远端交付无需移动用户工作分支。Push 只用本机已有 git/gh 凭据助手，CouncilKit 不另存长期 token；禁止把凭据写入任务包、CLI argv、pipeline.log、父 Run 记录、Squad journal 或交接文件。隔离工作区路径在启动时冻结，且不得等于 CouncilKit checkout 或用户脏工作树。
- **R7. 延续问题与检查新问题。** 每轮 `--against` 指向上一份完整有效复审；失败子 Run 保留用于恢复，不替换有效基线。复审包含候选 PR 上下文、修复差异、全部需复核的历史 finding，保留新问题、回归和独立少数派发现。新发现若属于冻结目标中的缺陷修复可自动进入下一子任务；新功能、范围外重构或验收规则变化进入待裁决。范围内也不能凭 Builder 声明认定旧 finding 关闭。

**准出与收敛**

- **R8. 机器判定准出。** 采用下一节的准出矩阵，失败项返回稳定原因码和证据引用。所有未被有效接受的问题都必须在当前候选上验证闭环，包含 minor/nit；不能改成仅 critical/major 阻塞。严重级别使用仓库原生枚举，不能直接把 Squad 的 P0/P1 当成 CouncilKit severity。Aggregator 的 approve 可展示，但不单独授予准出；changes-requested 或其他未解释的裁决与账本矛盾必须先解决。
- **R9. 全链预算，完成末轮验证。** 父 Run 默认最多 10 次外循环。一次外循环 = 启动一个 Squad 子任务 + 该候选的独立门禁 +（门禁通过后）发布到原 PR + CouncilKit 复审 + 准出判定。首次子任务也计一次。Squad 子任务内部的 candidate fix 仍受 Squad 自身最多 3 次上限约束，不扣父预算；不得把两套计数乘成 10 × 3，也不得把内部修复当成一次新的外循环。父预算在启动下一可写 Squad 子任务前消耗 1；该子任务内部门禁失败后的原 session 修复不另计。第 10 次外循环完成后仍允许其独立门禁、发布、CouncilKit 复审和准出判定；未通过才记预算耗尽，禁止第 11 次外循环。旧历史未知不能初始化为零。默认没有整段墙钟上限，只靠 10 次外循环和现有席位 timeout；启动时可另设总时限。若设置了总时限并到期，复用 R13 的停止流程：停止调度、保存检查点并取消所属执行，确认所有 writer 已终止才释放互斥。终止状态无法确认则保持写入阻塞；在途发布结果不明确时按 R12 读回核对。恢复不自动重置预算。
- **R10. 识别不收敛。** 同稳定 finding/rootCause 在两次有效源码修复后仍成立，先进入只读根因诊断；诊断必须给出新复现证据、被破坏的不变量与不同的修复方向。同范围、剩余预算足够且诊断形成可验证方案时才能继续；无新证据、超范围或预算耗尽则需要处理。只读复审重试不算根因失败次数。无源码变化而原问题仍未解决时不得反复审同一 SHA 空转。零新增 finding、deferred、预算耗尽都不是成功；运行器不能自行 accept、降级 severity、删问题或放宽门禁。

**可恢复运行与可见性**

- **R11. 持久父 Run。** 记录阶段、每次修复与复审、当前有效 SHA、against 链、Squad task/observe ID、策略快照、累计预算、操作 intent/结果及下一动作。使用独立父 Run（`ck-repair-<uuid>`），不覆盖来源报告及旧轮次，也不把 `pipeline.pid` 写入来源 `ck-review` 目录。浏览器关闭和 Host 重启不终止独立 CLI 控制器；机器/控制器退出后存储/API 状态为 `interrupted`，用户文案为「执行中断」，需显式恢复，不承诺后台自启动服务。
- **R12. 幂等和互斥。** 同一规范化仓库、PR 源分支只能有一个自动写入控制器；同机旧 `fix/apply` 的写入入口也须遵守此互斥。重复点击返回已有 Run。远端外部改动无法靠本机锁阻止，必须在发布前和读回时核对；异常时不自动覆盖。恢复先核验进程身份、租约、Squad journal、候选、远端和已落盘结果；push 成功但记录未完成时先读远端，复审完成但父记录缺失时先关联子 Run，避免重复执行。
- **R13. 区分业务结果与进程状态。** 对用户展示「已准出」「需要处理」「已停止」「执行中断」。预算耗尽、远端漂移、席位失败、证据不足都是「需要处理」的原因码，不是并列终态。执行阶段单独展示「准备、Squad 修复、Squad 验收、更新 PR、CouncilKit 复审、根因诊断、最终核对」。停止先保存检查点并停止本 Run 所有的活动子进程，再释放 writer；停止不回滚已提交或已推送内容。不得标记停止却留下可继续写入的 Builder。
- **R14. CLI 与页面能力一致。** CLI 支持发起、查询、停止和恢复；报告页对应相同动作。父 Run 展示剩余项、已关闭/仍成立/新增/回归差异、轮数、当前阶段、候选 SHA、两套门禁和实际耗时，并链接 Squad 过程与每份复审。只有存在用户可执行的恢复动作才显示按钮，并说明会从哪一步继续。新增页面写动作沿用现有 `auth:mutation` 的 Host/session/Origin/CSRF 校验和严格请求 schema，查询使用 `auth:session`；不能用请求体中的 authorized/passed 布尔值代替本 Run 授权与门禁核验。父 Run 持久化授权 grant id/hash；可能再次 push 的 resume 必须核验同一 grant 与冻结 PR 身份，不能仅凭新的 loopback session+CSRF 重新武装远端写入。observe 继续作为只读投影；Host 仍只以结构化参数启动同 checkout 的 CouncilKit CLI，不直接启动 squadctl，不读取 `.squad/`。Host 启动动作是枚举（`repair run/stop/resume`）映射到固定 CLI argv，不接受请求体或 profile 里的自由命令行。

## 准出矩阵

准出是对「指定 PR、指定候选、指定规则、指定时间」的结论，不能表示未来 HEAD 也已通过。

| 条件 | 必须核验的事实 |
| --- | --- |
| 身份一致 | 来源、任务包、Squad 候选、发布结果、复审都属于同一 PR 和连续修复链 |
| Squad 候选有效 | 当前候选未 invalidate；journal 确认 Review/Verify 独立、冻结的全部 required gates 通过，结果均绑定同一 SHA 和 gate policy |
| CouncilKit 运行完整 | 冻结席位全部成功，Aggregator 完成，incomplete=false；所需产物真实存在且 schema、runId、SHA 匹配 |
| 复审覆盖完整 | 必要 assessments 明确完整，uncovered 为空；不能以字段缺失、旧记录兼容或“聚合未提到”代替覆盖 |
| 问题闭环 | 所有非有效 accepted finding 均通过当前 SHA 的 `isFindingVerifiedClosed`（含 minor/nit）；修复声明均有独立证据，没有仍成立、未评估和证据矛盾 |
| 裁决一致 | Aggregator 已完成只证明执行完整；changes-requested 或其他裁决与账本矛盾且未获解释时不能通过，返回矛盾的证据引用 |
| 例外可追溯 | accepted/deferred 不等于关闭。只有用户已明确授权且适用范围未变的 accepted 可作为例外；无理由、来源不明或条件失效的旧 accepted 须核实。运行器无权新增例外 |
| 当前 PR 未漂移 | 最终读回远端 source HEAD 等于候选 SHA；目标分支/base 与复审冻结上下文仍一致，PR 未关闭或改投分支 |

门禁输出需要包含 `passed`、候选 SHA、检查时间、策略 hash、来源/最终 reviewRunId、Squad task 与门禁引用、未满足原因和已授权例外列表。证据不足输出 unknown，业务结果为「需要处理」，不能折算成通过。通过后的 PR 后续变化只使“当前有效”标识过期，保留原 SHA 的历史准出事实。

## 执行桥接与职责

| 参与方 | 拥有的决定和数据 |
| --- | --- |
| CouncilKit 父控制器 | 冻结启动范围、预算、阶段推进、子任务关联、发布请求、against 链、机器准出结论 |
| Squad Orchestrator 执行桥接 | 按 skill 规划与裁决、角色启动、唯一 writer、候选/门禁、受授权远端交付；只通过 squadctl 合法命令更改控制面 |
| Squad 控制面 | journal、runtime identity、候选生命周期、独立门禁、修复历史和交付回执的权威 |
| CouncilKit review | 独立审查、逐条验证、账本与覆盖证据；不替代 Squad 内部门禁 |
| Runtime Host / 浏览器 | 启动和展示父 Run、发送停止/恢复请求，展示现有只读 Squad sidecar |

桥接是此次跨仓库必做工作，首版随 Squad skill 一侧交付一个版本化、受监督的入口。CouncilKit 只集成这一种执行器，不先建通用工作流引擎或插件注册框架。

桥接最小能力：启动/恢复一个子任务，查询其权威状态，请求停止，收取 `candidate_ready / blocked / failed / stopped` 等结构化事件，并在 CouncilKit 请求发布时返回可核验的交付回执。`candidate_ready` 只代表可交付候选；控制器还须核验 Squad journal/门禁引用，不能信任模型输出里的布尔值。父控制器通过桥接查询权威数据，Host 只读取其已验证投影。远端交付只用固定 `squadctl integrate` 动词（`check-remote`/`push-remote`）和结构化参数，禁止 shell `-c`，禁止任务包或 profile 提供 argv。

运行配置须保存 requested/actual runtime、模型、native session 与版本指纹。Orchestrator 与 Builder 都走已支持的 adapter 连续会话，不能把任意 PID 或 CouncilKit Host 进程当作原生 session。runtime 替换、角色降级或版本不兼容不得静默发生。复审班子与 Builder/内部门禁使用独立 session/worktree；无需为了“独立”强制新增模型供应商。

每次外部复审开启下一子任务时继承完整的 `repair-history.v1.json`，通过项目/修复链/rootCause/task/逻辑轮关联。桥接必须新增受控的祖先任务目录解析与历史导出/导入，校验原 journal、来源包 hash 及项目身份；禁止从不可信包任意指定祖先目录。父控制器持有外循环次数的权威记录（默认上限 10）；Squad 保留子任务内 candidate fix 记录（默认上限 3）。两者在启动下一外循环前对账，不在每次内部 writer 启动时扣父预算。缺失或冲突的历史进入待核实，不采用乐观较小值。这一交接和计数映射是桥接契约的一部分，必须有契约测试。

任务包使用现有 schema v1；执行配置与授权单独传递，不经由任务包下发命令。导出文件落在 `COUNCILKIT_HOME` 下受控交接目录（目录 `0700`、文件 `0600`，拒绝 symlink），父 Run 只保存路径及 hash；Host 不静态提供原始包内容。遵守现有 `repair export` 不覆盖历史、独占创建的约束。保留恢复所需文件，准出/停止后也不自动删除证据。

## 拟定 CLI 与界面

以下为新增接口草案，当前不能直接执行：

```bash
councilkit repair run --from <ck-review-id> --profile <saved-profile> --json
councilkit repair status <ck-repair-id> --json
councilkit repair stop <ck-repair-id> --json
councilkit repair resume <ck-repair-id> --json
```

`repair export` 保持现有语义。首版 `repair run` 固定使用 Squad，运行次数/时限是本 Run 的可配置上限，省略时使用 R9 默认值；不能隐含无限模式。`--json` 保持 stderr 进度、stdout 一个最终结果。异步页面启动立即返回父 Run ID，CLI 前台执行只在终止或需要处理时输出最终结果。CLI 仅「已准出」返回成功；「需要处理」（含预算耗尽）为非零，具体码在实现时沿用当前错误分类，用户停止沿用 130。

报告页新增主动作「Squad 自动修复」，原「立即修复」注明「内置修复」并保留兼容，避免混淆。启动摘要展示 PR、范围、全部 finding 清零、最多 10 次外循环、可选总时限和逐轮更新 PR 的授权；使用已保存配置时一键启动，不每轮弹确认。进度文案「第 N / 10 次」只表示外循环，不表示 Squad 内部 candidate 次数。

父 Run 顶部示例：

```text
PR #123 · Squad 自动修复
第 2 / 10 次外循环 · CouncilKit 正在复审
上一轮 5 项 → 已验证解决 3 项 / 仍成立 1 项 / 新增 1 项
候选 abc123… · Squad 验收通过 · CouncilKit 复审进行中
[查看 Squad 过程] [查看本轮复审] [停止]
```

复审未完成时上轮计数明确标注“上一轮”，不提前显示清零。成功时主卡片显示「已准出 · SHA」，附最终检查时间与例外；需要处理时给出「同根因两次未闭环」「远端已变化」「复审席位失败」等实际原因。停止确认仅用于存在活动写入且用户需要了解保存点的情形，不阻碍无副作用停止请求。

建议的恢复交互如下；这是本提案的产品选择，用户可在实施前调整，不能将所有需要处理原因都绑定到同一个无条件继续按钮。

| 需要处理原因 | 页面动作与恢复条件 |
| --- | --- |
| 复审席位失败 / 可修复的产物缺失 | 「恢复复审」；确认候选和 base 未变后复用成功席或重建缺失证据，跳过源码修复和 push |
| runtime 暂不可用 | 「检查配置」；原 runtime 恢复后继续原任务；需换 runtime 则先明确展示变更及失效证据，不静默降级 |
| 历史缺失 / writer 是否终止不明 | 「查看待核实项」；权威历史、进程和租约核验通过后才出现「恢复」 |
| 两次同根因未闭环 | 「查看诊断」；有新证据、同范围且预算足够才可继续；诊断失败时提供交接资料 |
| 外循环预算耗尽 | 「查看残余问题 / 导出交接」；无第 11 次外循环按钮。末轮缺失的验证可恢复；追加外循环需要另行明确授权，保留累计历史，不能重开 Run 清零 |
| 时限到期 | 「查看检查点」；确认旧执行终止后，可明确延长时限再恢复剩余阶段，保留已用时和外循环预算 |
| 远端 HEAD / base 已变化 | 「查看分支变化 / 从最新审查重新发起」；先重审当前状态，保留原候选和累计历史，不自动迁移旧门禁或应用旧候选 |
| 没有待修项但缺 Squad 门禁 | 「查看现有审查 / 补充验收后重新核对」；首版不创建空修复任务、不宣告准出 |

## 首版范围与实现顺序

首版必须完整打通 CLI + 报告页。只做已有报告驱动、单 PR、固定 Squad 执行桥接、逐轮发布、独立复审、严格准出、有限预算、停止和恢复；一次最多一个写入者。新问题自动回流和失败恢复属于闭环本身，不留给后续手工操作。

不包含：自动合并/部署/PR 评论、定时轮询、跨仓库批量修复、无人值守任意扩范围、自动接受风险、本地候选复审模式，以及通用多执行器平台。

实施按三个可验收阶段推进，不依赖真实 PR 去试错：

1. **契约与准出**：给缺失的权威执行/交付回执补契约，实现严格门禁评估，固定源身份、产物完整性和预算映射；验证真实 Squad runtime 的启动与恢复能力。
2. **CLI 闭环**：接通 export → 子任务 → 发布 → review → gate，加入持久记录、共享互斥、停止、恢复；复用原流程但不继承宽松成功判断。
3. **产品入口**：父 Run 的索引和详情、启动摘要、动作与原因提示，串联旧 Squad observe/review 页面；完成真实隔离仓库验收。

计划阶段要给跨仓库 bridge 变更安排明确交付版本；CouncilKit 在该版本缺失时启动前报出依赖，不能先展示一个实际上无法执行的自动修复按钮。

## 验收场景

| 场景 | 预期结果 |
| --- | --- |
| 修复一次、两套门禁均通过 | 自动更新原 PR，完成复审，输出同一 SHA 的准出证据 |
| 复审仍有旧问题或发现新回归 | 在范围与预算内自动创建下一任务，稳定 ID/根因历史不丢 |
| Squad 内部门禁先失败后修好 | 原 Builder session 继续，内部修复扣 Squad 自己的 3 次上限，不扣父预算外循环 |
| 第十次外循环终于通过 / 仍未通过 | 允许完成第十次候选的全部验证；前者准出，后者需要处理，无第十一次外循环 |
| 同根因修复两次仍成立 | 先只读诊断；无新证据不继续相同补丁，不自动重开预算 |
| review 零退出码但有失败席/缺账本/缺 assessments | 不准出，恢复或重跑必要审查，不额外让 Squad 改代码 |
| 只有历史 closed、repairClaim、accepted 无授权依据 | 不计为已验证闭环；不因问题计数减少而通过 |
| Squad closed、模型声称完成但独立门禁不全 | 不发布，不准出，显示缺少的证据 |
| 来源 SHA 已旧 / 推送前远端变化 / base 漂移 | 首次派工前补审；执行中漂移保存候选并需要处理，不覆盖别人代码或复用失效证据 |
| push 成功后断电 / review 完成后父进程退出 | 恢复核对既有副作用，复用同一候选和子 Run，不重复提交、发布或计轮 |
| 页面双击/两标签页/同时运行旧 fix | 返回现有 Run 或写入冲突，最多一个 writer |
| 用户停止、浏览器关闭、Host 重启 | 停止终止所属执行且保留证据；关闭浏览器/重启 Host 不取消独立控制器 |
| 初始无待修项、缺 runtime、权限不满足或旧历史未知 | 不导出空包、不空跑、不伪造准出；输出明确的无需修复或需要处理原因 |

## 待反馈的默认值与计划阶段核查

**已锁定**：准出要求全部未被有效接受的 finding 验证闭环（含 minor/nit）；父预算最多 10 次外循环；Squad 每子任务最多 3 次内部 candidate fix，不扣父预算；默认没有整段墙钟上限（只靠外循环 + 席位 timeout，启动时可另设总时限）；Orchestrator 为独立 adapter 连续会话；首版逐轮更新原 PR 再复审。不能隐式降低门禁，也不能对每个子任务重新发放外循环次数。

**计划阶段必须核验、不得改掉的前提**：现网 `review` 经常覆盖不全或产不出 `verified_closed`，准出环要把「同 SHA 覆盖完整 + 可重复关闭证据」当作前置里程碑，不能靠兼容字段放行。AntCode `inspectPullRequest` 目前不返回 `headSha`，身份一致/未漂移要么补上 PR HEAD 读回，要么 GitHub 路径先准出、AntCode 启动前失败。

**计划阶段核查**：在 cursor / codex / grok 中选定第一个能启动并恢复的独立 adapter Orchestrator，写入 profile 的 requested/actual；核验跨任务 history 导入/导出和预算对齐的实际 CLI；为缺失/损坏产物的同 SHA 复审定义兼容现有 resume 的重建路径；核验托管隔离工作区通过现有远端交付接口的参数；确定产物 schema、状态码和前后端扩展位置。上述行为要求已确定，具体实现不能降低证据、会话或授权约束。

## 代码依据

- 单轮修复与复审：`cli/src/commands/fix.ts`（runApply 和 startFollowUpReview）。
- 复审部分失败与冻结上下文：`cli/src/commands/review.ts`（finalize、freezeReviewContext 调用、persistFindingsFromReport 调用）。
- 任务包与导出目录限制：`shared/runtime/repair-package.ts`、`cli/src/commands/repair.ts`。
- 当前 SHA 的关闭证据：`shared/runtime/cli-ledger.ts`、`cli/src/auto/ledger.ts`。
- 完整性和历史兼容：`shared/runtime/review-case.ts`、`shared/runtime/cli-runs-index.ts`。
- 稳定根因身份：`shared/runtime/finding-groups.ts`、`cli/src/auto/finding-groups.ts`。
- 页面与启动：`src/components/report/FixPipeline.tsx`、`src/lib/squad-workspace.ts`、`runtime-host/cli-launcher.ts`、`runtime-host/routes/cli-runs.ts`。
- 外部依赖：已安装的 `hengzhuo-engineering-squad/SKILL.md`，及其 `references/repair-workflow.md`、`references/builder-continuity.md`、`references/playbook.md`、`references/squadctl.md`；安装路径通过运行配置解析，不写死个人机器绝对路径。


---

## 7. 最新一轮审查聚合正文（模型评审证据，未全部独立复验）

# Autonomous Review Report

- Run: ck-review-fff9e15e-2173-40c7-849c-177f0959b826
- Task: review PR https://code.alipay.com/paas-core/agentrun/pull_requests/128
- Aggregator: review-adversarial (grok-stream-json/grok-4.6)

| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |
| --- | --- | --- | --- | --- |
| review-security | cursor-stream-json/auto | ok | 11m46s | 63 |
| review-correctness | codex-app-server/gpt-6-astra | ok | 11m56s | 23 |
| review-maintainability | kimi-stream-json/kimi-code/k3 | ok | 8m25s | 18 |
| review-adversarial | grok-stream-json/grok-4.6 | ok | 16m51s | 79 |
| review-cursor | claude-stream-json/antchat/GLM-5.2[1m] | ok | 32m22s | 81 |
- Status: complete
- Started: 2026-09-21T11:08:53.694Z
- Ended: 2026-09-21T11:47:38.691Z

---

已核对增量代码与各席反例。下面按账本做对抗式汇总：不把弱关闭证据当成共识，独有且可证伪的洞全部保留。

## 概览

五席（review-security、review-correctness、review-maintainability、review-adversarial、review-cursor）均 `changes-requested`。HEAD `3bada48be6948e8a6a0e6a6cf42a03cc38ff215c`；增量 4 文件 `+67/-7`、零已跟踪测试。

本增量声称「Prompt 与恢复同锁」和「leftover creating 补调度」。代码只把 `lockSession` 包在 Prompt / `recoverOpenSession` / Retry 上；`markRuntimeSessionsRecovering` 与 `resumeOwnedRecovery` 不取这把锁。`errNeedsLeftover` 只覆盖提交后失代，且只在 startup/Retry 调用点补调度。Ready 仍跳过 startup/retry 占用。把「Error 被收成 Creating」或「占用不再被丢掉」当成原洞已修，是错误前提：终态仍是无自愈的 Creating/Idle+死占用，仓库 `TestRuntimeReadyDoesNotResumeRetryOccupancy` 仍靠第二次手动 Retry 测绿。

历史 ABBA、`finishFlight` 指针相等、`persistRetryableFailure` 删除、Idle-only revert 覆盖 Running，四到五席在本 SHA 有独立 code_trace，保持关闭。不能据此把未修的 Prompt 窗口和 Ready 漏调度一并关掉。

## 共识发现

仍成立（账本 id）：

- [major] `h-4d3932d38281` / `session_operations.go--错误前提-去掉-mutator-内代次检查-提交后-revert` / `pkg.runtime.manager.session_operations.go--pkg-runtime-manager-session_operations.go-255-280` — `lockSession` 拦不住 Starting checkpoint 与 Ready Resume。Prompt 已进入 `SubmitPrompt` 后恢复仍可占会话；runtime 接受 turn，RPC 软 busy，无 Cancel，durable 非 running。客户端按 busy 重试即双 turn。反例：review-security `TestSecurityIncr2PromptSubmitDuringStartingLeavesAcceptedTurn`（`promptCalls==1`、busy、相位非 running）；review-correctness `TestReviewPromptGateStartingStillCrossesAcceptedPrompt`（Submit=1 后重试 Submit=2）；review-adversarial `TestReviewAdversarialPromptOverlapsReadyResume`（200ms 内 `resumeStart` 与 Submit 重叠）；review-cursor `TestReviewCursorPromptAcceptedThenStartingRecovery`（`cancelCalls=0`、durable=creating）。security 把「占用期内写 running」子路径标 `verified_closed`，原 Submit 窗口仍开，不能关整条。

- [major] `pkg.runtime.manager.session_manager.go--pkg-runtime-manager-session_manager.go-370-375` / `h-0210835c153c` / `...-369-374` / `h-fab964b9a5cd` — Ready 仍只续跑 `owned && kind==runtime && flightCurrent`；startup/retry 占用被跳过。`recoverLeftoverIfReady` 不覆盖 `errStaleFlight`（提交前失代）和 Ready 的 `resumeOwnedRecovery`。本增量加 `flightCurrent` 后，失代 runtime 占用也被跳过，随后 `finishRecoveriesForRuntime` 只按名丢掉 runtime kind。反例：security `TestSecurityIncr2ReadySkipsRetryOccupancyAndDoesNotReschedule`（80ms `resumeCalls==1`、creating）；correctness `TestReviewReadyEarlyStaleRetryGetsHandoff`（owned=false、Resume=1）；adversarial `TestReviewAdversarialReadyPathReschedulesLeftover`（`resumeCalls>=2` 从未满足）；cursor `TestReviewCursorStaleRetryNeedsSecondManualTrigger`（300ms 无自愈）。仓库 `TestRuntimeReadyDoesNotResumeRetryOccupancy`（`session_recovery_test.go:252-255`）仍 `Eventually Retry→idle`，把「必须再打 Retry」写成成功；本增量零测试文件。五席一致 still_open。

- [major] `h-f22b441b38d6` — 原「三次 revert 写失败后 `finishFlight`、暴露无占用 idle」在 startup/Retry 上已死（`errRevertDurable` 不 `finishFlight`）。新合同更糟：Idle+owned 永久楔死，Retry `ErrSessionOpening`、Prompt busy、Ready 不接管。Ready 路径仍 `defer finishFlight`，同一写失败在 Ready 上会回到无占用。反例：security `TestSecurityIncr2StaleCommitWriteFailuresKeepOccupancyAndRetryOpening`（`recoveryOwned==true`、`failedWrites==3`、第二次 Retry 不增加 Resume）；cursor `TestReviewCursorRevertWriteFailureWedgesSession`（裸 sentinel 回客户端、500ms Ready no-op）。correctness / adversarial 关原反例但另列死占用回归——症状变了，会话仍不可恢复，账本项不能关。

- [minor] `h-2fa280eb1eda` / `flightswg.go--session_recovery.go-446-retry-flightswg.go-之前用-daemonctx` / `session_recovery.go--session_recovery.go-463-后台-resume-只用-daemonctx` — Retry 在 `flightsWG.Go` 前用 `daemonCtx` 等 lifecycle gate，后台 Resume 只用 `daemonCtx`。correctness：`TestReviewHistoryRetryRetainsTrace`（`traceparent==nil`）、`TestReviewHistoryRetryCancelWhileRuntimeGateHeld`（取消 150ms 不返回）。本增量未改调用点，且现额外持 `sessionGates`。

- [minor] `session_recovery.go--session_recovery.go-302-308-resume-成功后-requirehealthyeventlog` / `...-302-偶现` / `h-59a5be9af7dd`（后半） — Resume 成功后 eventlog 失败仍 `forgetOpenedOn` + `markRecoveryFailed`，不 `CloseSession`。correctness `TestReviewHistoryLogFailureLeavesRemoteSessionOpen`：Resume=1、Close=0、Forget=1。

- [minor] `resources.stopped--session_recovery.go-224-requirehealthyeventlog-无锁读-resources.stopped-关闭路径在` — `:266` 裸读 `resources.stopped` vs `session_events.go:305` 持 `publishMu` 写。security `-race TestSecurityIncr2StoppedFieldDataRace` 与 correctness `-race TestReviewHistoryEventLogStoppedRace` 均 DATA RACE。

- [minor] `pkg.events.sessionstate.sessionstate.go--pkg-events-sessionstate-sessionstate.go-76-77` 族 / `h-59a5be9af7dd`（前半） — recovering 启发式仍吞 Creating+UUID 上的 Idle/Running/Error。correctness `TestReviewHistoryRuntimeClosedDuringResume`：终态 idle、`reason=nil`。本增量未碰该文件。

- [minor] `h-1472723c253b` / `h-bd3cd89c3f90` / `h-04e898b973fa` / `pkg.runtime.manager.session_recovery.go--pkg-runtime-manager-session_recovery.go-413-419` — identity CAS + phase switch 仍约 5 份；本轮又加 leftover / `errRevertDurable`；`for range 3` 仍在 `:456`。maintainability / cursor / adversarial 一致。

- [minor] `h-0210835c153c-2` — mutator 仍在 bolt 回调里 `flightCurrent`（`:205` / `:389`）。五席同意：不是活 ABBA，合同已破，不阻塞。

- [nit] `h-005ddf58628a` / `docs.plans.2026-09-20-session-shutdown-recovery.md--...` / `cmd.agentd.commands.root.go--...-229-237` / `h-65d0a68a0b96` — CHANGELOG 无 Retry RPC / leftover；plan 仍 `in-progress`；增量零已跟踪测试；生产仍 `Run` 后再 `RecoverSessions`。

- [nit] `manager.go--manager.go-513-516-新注释末句-phase-persist` / `h-c2d47f4f412a` — persist 失败注释与 bump-first 相反；mismatch 错误串相邻分支重复构造。

本增量新洞、多席交叉验证：

- [minor] Prompt 的 `lockSession` 是不可取消 Mutex，恢复可持锁穿过 `SubmitPrompt` / runtime gate。correctness：请求取消后仍不返回；cursor：handler 延迟等于恢复时长。反例方向：TryLock 或 ctx 感知 gate，拿不到立即 busy。

- [minor] `sessionGates` 只 `LoadOrStore` 不 `Delete`（`manager.go:107` / `session_recovery.go:83-88`）。maintainability / adversarial / cursor 均指出：会话删除路径不清理，与 `promptBusy` 形成第二套无注释锁。长跑按历史会话名泄漏。

已验证关闭（不列入阻塞；关闭证据来自本 SHA 独立验证，不是未提及）：

- ABBA `pkg.runtime.manager.session_recovery.go--...-177-183`：五席 code_trace，`markRecoveryFailed` 不再持 `flightsMu` 进 store。
- `finishFlight` 指针相等：`session_recovery.go:158-168`，后继槽不误删。
- `h-254c2a1f26cd` / `h-eeda034ce495`：`revertOpenedToCreating` 含 Idle/Running/Error。
- `h-0002481d93fc` / `h-6d235e6b077c`：`persistRetryableFailure` 不存在。
- `session_operations.go--session_operations.go-276-288-同一-busy-两种`：mutator `ErrSessionBusy` 已收成 `PromptRejectReasonBusy` 软结果（过宽文案是新洞，见独有）。

## 独有发现

少数意见，有反例，不因无人重复而删。

- [major] review-correctness `session_recovery.go:437-451` — **新增回归**：`recoverLeftoverIfReady` 名含 Ready，实现不读 runtime 相位。Starting 打断 idle 提交后立即再 `recoverOpenSession`；Resume 临时失败被 `markRecoveryFailed` 写成 Error，Ready 不处理 Error。指定时序必现。→ Starting 期间只留 creating，等 Ready 再恢复。security / cursor / adversarial 未单独打这条「leftover × Starting」时序。

- [major] review-adversarial `session_operations.go:249-260` — `lockSession` 加在 `requireSession` 之后，锁内仍用锁前快照做 `checkSessionPhase`。反例 `TestReviewAdversarialPromptSerializedBehindStartupResume`：`RecoverSessions` 已写成 idle，排队 Prompt 仍 `ErrSessionUnavailable`（Creating 快照）。→ 先抢同一把锁再读库，或锁内重读 phase。这是本增量锁引入的相反实现：串行化后读到的是过期 Creating，不是恢复后的 Idle。

- [major] review-adversarial `session_operations.go:278-291` — 把 mutator 里所有 `ErrSessionBusy`（含 `checkSessionPhase(Running)`）映射成 `"session is recovering"`。前置检查 Running 仍是 `"session is busy"`。反例 `TestReviewAdversarialPromptMapsRunningBusyAsRecovering`：无恢复、Submit 期间 durable 已 Running，RPC 文案却是 recovering；客户端当真恢复重试会双 turn。→ 只映射 `recoveryOwned` 分支。其他席把 276-288 nit 关掉后没再查文案过宽。

- [major] review-cursor `session_recovery.go:286-296,:580-590` + `pkg/agentd/server/service_errors.go:58-62` — `errRevertDurable` 是未导出 sentinel，`mapManagerError` 走 default 原样返回。反例 `TestReviewCursorRevertWriteFailureWedgesSession`：Retry 向客户端吐 `revert opened session to creating failed: ...`，随后永久 `ErrSessionOpening`。security 打到占用滞留，未打 RPC 合同泄漏。

- [minor] review-correctness `session_recovery.go:221-222` — 旧失败通过代次检查后仍可提交 error；三次回退写失败被 `_ = revertOpenedToCreating` 丢掉，随后释放占用，留下旧 Error。`TestReviewFailureFenceStaleErrorRollbackFailure`：phase=error、owned=false、rollbackAttempts=3。与 security 关闭 `h-a6f278d6eff2` 的探针（revert 成功后再 Ready）不是同一反例。

- [minor] review-adversarial `session_recovery.go:285-295` — leftover 成功后外层仍把 `err` 改成 `ErrSessionUnavailable`。`TestReviewAdversarialLeftoverCreatingResumedAfterStaleIdle`：durable 已 idle 且 `resumeCalls>=2`，日志仍 `recovered=0 failed=1`。不可测的「补调度成功」断言。

- [minor] review-adversarial `session_recovery.go:525-572` — Retry 持 `sessionGates` 调 `runtimeForName(daemonCtx)`，lifecycle gate 等待期间 Prompt 也被堵住。这是 daemonCtx 洞在新锁上的范围外副作用；其他席只追取消时延/trace，未打跨 RPC 堵门。

- [minor] review-maintainability `session_recovery.go:285-296,:580-591` vs `session_manager.go:391-406` — 三处调用点手写 postlude 已漂移：startup/Retry 保 `errRevertDurable` 占用并跑 leftover；`resumeOwnedRecovery` 无条件 `finishFlight` 且不 leftover。sentinel 当控制流 + defer 改写命名返回值掩盖分叉。→ 收敛成一个 postlude helper。这是 leftover「已修」声明的可证伪点。

- [minor] review-cursor `session_recovery.go:194-223` — `markRecoveryFailed` 在 mutator no-op（相位已非 Creating）时仍走 `:221` revert，可把新 Idle/Running 无差别拉回 creating。低概率，补偿应仅在实际写入 error 之后触发。

- [nit] review-maintainability `session_recovery.go:437-452` — leftover 静默吞掉 `GetSession` 与内层 `recoverOpenSession` 错误，与周边 Warn 风格不一致。

`pkg.runtime.acp.controller.go--...-131-默认权限策略从` 本增量未触及；security 明确不列入发现。保持开放合同决策，不升为阻塞。

## 分歧

- `h-a6f278d6eff2` / `...session_recovery.go-357-uuid` / `...-143-517`：security / adversarial / cursor 用「失代 error 被 revert 成 Creating，之后 Ready 能 Resume」标 `verified_closed`（`TestSecurityIncr2FailureCommitAfterBumpRevertsThenReadyRecovers`、`TestReviewAdversarialStaleErrorRevertedToCreating`、`TestReviewCursorStaleResumeFailureErrorRevertedAndResumed`）。correctness 两条 FAIL 仍成立：回退写失败留下 error；回退成功但 Ready 已过则 creating、Resume=1、无 flight。关闭前提把「相位不再是 Error」当成原伤害消失。原伤害是 Starting/Ready 跳过且无后续 Resume。Creating 无补调度 = 同一终态。**本汇总不关这三条。**

- `h-f22b441b38d6`：correctness / adversarial `verified_closed`（不再暴露无占用 idle）；security / cursor `still_open`（死占用 + RPC 楔死）。原反例死了，修复引入不可恢复占用。**按仍成立处理，症状改为 Idle+owned 空转。**

- `pkg.runtime.manager.session_operations.go--...-255-280`：security `verified_closed`（占用期内写 running 仍被 `recoveryOwned` 拒绝）；correctness / adversarial / cursor `still_open`（已接受 turn 仍报 recovering busy）。durable 写 running 子路径可单独记关闭，Submit 窗口不能关。**整条保持 still_open。**

- `h-51138a159116`：security / correctness / adversarial 因 Running 进入 revert switch 关闭；cursor 因 Retry 对 Idle/Running 直接返回现状仍 `still_open`。后者是 Ready 漏调度的伴随现象，已由 `h-0210835c153c` 跟踪，不单独升阻塞。

- `session_operations.go--session_operations.go-276-288-同一-busy-两种`：四席关 wire 类型分叉。adversarial 另开 Running→`"session is recovering"` major。关 nit、开新洞，不冲突。

- correctness 未评估 `root.go--session_recovery.go-266-271-resume-失败只看-ctx.err`；adversarial 未评估 ACP 默认策略。未评估 ≠ 关闭。

## 结论

changes-requested



---

## 8. 关键实现摘录（供检验诊断，不要求全仓代码审查）


---

### cli/src/auto/repair-run.ts:80-86

```typescript
80:   pollIntervalMs?: number;
81:   workspaceCwd?: string;
82: }
83: 
84: const POLICY = "gate-policy-1";
85: 
86: export async function defaultRepairReviewImpl(
```


---

### cli/src/auto/repair-run.ts:625-688

```typescript
625:     const snapshot = bridge.status({ taskId });
626:     const reviewGate = toGateReview(child, identitySha);
627:     const gate = evaluateRepairGate({
628:       source: { runId: input.sourceRunId, prUrl, sha: identitySha },
629:       candidateSha: identitySha,
630:       publishedSha: state.publishedSha ?? identitySha,
631:       remoteHead: remote.headSha?.toLowerCase() ?? null,
632:       baseUnchanged:
633:         remote.baseBranch === profile.base &&
634:         (state.frozenBaseSha === null ||
635:           state.frozenBaseSha === undefined ||
636:           !remote.baseSha ||
637:           remote.baseSha.toLowerCase() === state.frozenBaseSha.toLowerCase()),
638:       prOpen: remote.prOpen !== false,
639:       squad: {
640:         taskId,
641:         invalidated: snapshot.event.journal.invalidated,
642:         independentReview: snapshot.event.journal.independentReview,
643:         independentVerify: snapshot.event.journal.independentVerify,
644:         requiredGatesPassed: snapshot.event.journal.requiredGatesPassed,
645:         sha: snapshot.event.journal.candidateSha,
646:         gatePolicyHash: snapshot.event.journal.gatePolicyHash,
647:       },
648:       review: reviewGate,
649:       policyHash: POLICY,
650:       checkedAt: now(),
651:     });
652:     state = patchCycle(input.runDir, state, cycleN, { phase: "gated" });
653:     if (gate.passed) {
654:       releaseWriterQuietly(profile, input.runId);
655:       return finish(input, {
656:         businessResult: "approved",
657:         reasonCode: null,
658:         message: "approved",
659:         latestReviewId: childId,
660:         outerUsed: state.outerUsed,
661:       });
662:     }
663:     const stillOpen = reviewGate.findings.filter((row) => row.status !== "accepted").length;
664:     const publishedFixes = (state.cycles ?? []).filter((row) => row.phase !== "reserved").length;
665:     if (publishedFixes >= 2 && stillOpen > 0 && sameAgainstStillOpen(child, against)) {
666:       writeRepairLive(input.runDir, { status: "running", phase: "repair-diagnosing" });
667:       return finish(input, {
668:         businessResult: "needs_attention",
669:         reasonCode: "findings_open",
670:         message: "same against-id still open after two published fixes",
671:         latestReviewId: childId,
672:         outerUsed: state.outerUsed,
673:       });
674:     }
675:     const canRetry =
676:       stillOpen > 0 &&
677:       gate.reasons.every((reason) => reason.code === "findings_open") &&
678:       state.outerUsed < state.outerMax;
679:     if (!canRetry) {
680:       return finish(input, {
681:         businessResult: "needs_attention",
682:         reasonCode: gate.reasons[0]?.code ?? "findings_open",
683:         message: gate.reasons[0]?.evidence ?? "repair gate failed",
684:         latestReviewId: childId,
685:         outerUsed: state.outerUsed,
686:       });
687:     }
688:     state = patchCycle(input.runDir, state, cycleN, { phase: "closed" });
```


---

### cli/src/auto/repair-run.ts:779-819

```typescript
779: async function waitForCandidate(
780:   bridge: SquadBridge,
781:   taskId: string,
782:   snapshot: ReturnType<SquadBridge["status"]>,
783:   runDir: string,
784:   now: () => string,
785:   deps: RepairLoopDeps,
786:   state: RepairState,
787: ): Promise<ReturnType<SquadBridge["status"]>> {
788:   const sleep = deps.sleep ?? defaultSleep;
789:   const nowMs = deps.nowMs ?? (() => Date.now());
790:   const startedAt = nowMs();
791:   const interval = deps.pollIntervalMs ?? 2_000;
792:   let current = snapshot;
793:   while (!deps.abortSignal?.aborted) {
794:     writeRepairLive(runDir, { status: "running", phase: "repair-squad-repair" });
795:     if (canRequestPublish(current.event)) return current;
796:     if (
797:       current.event.kind === "blocked" ||
798:       current.event.kind === "failed" ||
799:       current.event.kind === "stopped"
800:     ) {
801:       appendRepairJournal(runDir, {
802:         kind: "squad.event",
803:         event: current.event.kind,
804:         taskId,
805:         at: now(),
806:       });
807:       return current;
808:     }
809:     if (state.timeoutMs !== null && nowMs() - startedAt >= state.timeoutMs) {
810:       appendRepairJournal(runDir, { kind: "squad.wait.timeout", taskId, at: now() });
811:       try {
812:         bridge.stop({ taskId });
813:       } catch {
814:         // persist timeout even if stop races
815:       }
816:       return {
817:         ...current,
818:         event: { ...current.event, kind: "blocked" },
819:       };
```


---

### cli/src/auto/repair-run.ts:1104-1109

```typescript
1104: function sameAgainstStillOpen(
1105:   child: NonNullable<ReturnType<typeof readCliRun>>,
1106:   against: string,
1107: ): boolean {
1108:   return child.reviewEvidence?.againstRunId === against;
1109: }
```


---

### cli/src/auto/repair-run.ts:1132-1157

```typescript
1132: function buildSquadDelivery(input: {
1133:   grantHash: string;
1134:   profile: RepairProfile;
1135:   packageBody: RepairPackage;
1136:   state: RepairState;
1137:   preflightSha: string;
1138:   runId: string;
1139:   cycleN: number;
1140:   history: FrozenHistoryLaunch | null;
1141: }): SquadBridgeDelivery {
1142:   return {
1143:     grantHash: input.grantHash,
1144:     repo: input.profile.repo,
1145:     sourceBranch: input.profile.sourceBranch,
1146:     sourceSha: input.packageBody.source.sha,
1147:     expectedOldSha: (input.state.publishedSha ?? input.preflightSha).toLowerCase(),
1148:     remote: "origin",
1149:     originUrl: input.state.frozenOriginUrl ?? undefined,
1150:     pushUrl: input.state.frozenPushUrl ?? input.state.frozenOriginUrl ?? undefined,
1151:     parentRunId: input.runId,
1152:     newRepairChain: input.cycleN === 1,
1153:     previousTaskId: input.history?.previousTaskId,
1154:     previousTaskDir: input.history?.previousTaskDir,
1155:     historyExportPath: input.history?.historyExportPath,
1156:     historyExportHash: input.history?.historyExportHash,
1157:   };
```


---

### shared/runtime/squad-journal-map.ts:10-54

```typescript
10: const POLICY_HASH = /^[a-f0-9]{64}$/;
11: 
12: export function journalFromSquadStatus(view: unknown): SquadJournalRefs {
13:   const row = asRecord(view);
14:   const candidate = asRecord(row.candidate);
15:   const sha = fullSha(candidate.candidate_sha) ?? ZERO_SHA;
16:   const completed = candidate.status === "completed";
17:   const policyHash =
18:     typeof candidate.policy_hash === "string" && POLICY_HASH.test(candidate.policy_hash)
19:       ? candidate.policy_hash
20:       : "unknown";
21:   const projection = asRecord(row.projection);
22:   const aggregate = asRecord(projection.aggregate_verdict);
23:   const independence = asRecord(row.independence);
24:   const sameSha = completed && sha !== ZERO_SHA && fullSha(aggregate.candidate_sha) === sha;
25:   const gapsEmpty =
26:     isEmptyArray(aggregate.binding_gaps) &&
27:     isEmptyArray(aggregate.independence_gaps) &&
28:     isEmptyArray(aggregate.required_gate_gaps);
29:   const policyOk =
30:     independence.policy_status === "satisfied" &&
31:     independence.bound_same_sha === true &&
32:     independence.provenance_complete === true &&
33:     independence.shared_run === false &&
34:     independence.shared_session === false &&
35:     independence.shared_worktree === false;
36:   const independentReview = sameSha && aggregate.reviewer_pass === true;
37:   const independentVerify = sameSha && aggregate.verifier_pass === true;
38:   const requiredGatesPassed =
39:     sameSha &&
40:     independentReview &&
41:     independentVerify &&
42:     aggregate.approved === true &&
43:     aggregate.verdict === "pass" &&
44:     gapsEmpty &&
45:     policyOk &&
46:     policyHash !== "unknown";
47:   return squadJournalRefsSchema.parse({
48:     candidateSha: sha.toLowerCase(),
49:     invalidated: candidate.invalidated === true || candidate.status === "invalidated",
50:     independentReview,
51:     independentVerify,
52:     requiredGatesPassed,
53:     gatePolicyHash: policyHash,
54:     observeClosed: projection.observe_status === "closed",
```


---

### shared/runtime/repair-gate.ts:98-138

```typescript
98: export function evaluateRepairGate(input: RepairGateInput): RepairGateResult {
99:   const reasons: RepairGateReason[] = [];
100:   const candidate = input.candidateSha.toLowerCase();
101: 
102:   if (
103:     !sha40(candidate) ||
104:     input.source.sha.toLowerCase() !== candidate ||
105:     input.review.sha.toLowerCase() !== candidate ||
106:     (input.publishedSha !== null && input.publishedSha.toLowerCase() !== candidate) ||
107:     !input.source.prUrl ||
108:     !input.source.runId
109:   ) {
110:     reasons.push({
111:       code: "identity_mismatch",
112:       evidence: `source=${input.source.sha} review=${input.review.sha} published=${input.publishedSha}`,
113:     });
114:   }
115: 
116:   const squad = input.squad;
117:   if (
118:     squad === null ||
119:     squad.invalidated ||
120:     !squad.independentReview ||
121:     !squad.independentVerify ||
122:     !squad.requiredGatesPassed ||
123:     squad.sha.toLowerCase() !== candidate ||
124:     squad.gatePolicyHash !== input.policyHash
125:   ) {
126:     reasons.push({
127:       code: "squad_candidate_invalid",
128:       evidence:
129:         squad === null ? "missing squad candidate" : `task=${squad.taskId} sha=${squad.sha}`,
130:     });
131:   }
132: 
133:   if (
134:     input.review.incomplete ||
135:     !input.review.seatsAllSuccess ||
136:     !input.review.aggregatorComplete ||
137:     !input.review.artifactsOk
138:   ) {
```


---

### shared/runtime/reviewer-assessment.ts:232-260

```typescript
232:   const covered = new Set(valid.map((row) => row.assessment.findingId));
233:   for (const id of input.requiredFindingIds) {
234:     if (!covered.has(id)) {
235:       items.push({
236:         findingId: id,
237:         attemptId: "coverage",
238:         status: "missing",
239:         errorClass: "missing_required_id",
240:         errorPath: `/required/${id}`,
241:       });
242:     }
243:     const outcomes = new Set(
244:       valid.filter((row) => row.assessment.findingId === id).map((row) => row.assessment.outcome),
245:     );
246:     if (outcomes.size > 1) {
247:       items.push({
248:         findingId: id,
249:         attemptId: "coverage",
250:         status: "semantic_mismatch",
251:         errorClass: "contradictory_outcome",
252:         errorPath: `/required/${id}/outcome`,
253:       });
254:     }
255:   }
256:   const coverageComplete = input.requiredFindingIds.every((id) => {
257:     const valids = valid.filter((row) => row.assessment.findingId === id);
258:     if (valids.length === 0) return false;
259:     const outcomes = new Set(valids.map((row) => row.assessment.outcome));
260:     return outcomes.size === 1;
```


---

### cli/src/auto/ledger.ts:277-303

```typescript
277: export function formatLedgerForPrompt(file: FindingsFile, range: string | null): string {
278:   const lines: string[] = [
279:     `对照账本 run ${file.runId}${file.sha ? ` @ ${file.sha.slice(0, 12)}` : ""}。`,
280:     "这是增量复审：不要把整份 PR 相对 master 再发现一遍。",
281:     "检查未解决、声明已修复和历史未验证项；仅有绑定本次完整 SHA 的独立验证可关闭。未提及不等于关闭。",
282:     "账本标 accepted 的项不要再当成阻塞，除非实现偏离了已接受的合同。",
283:   ];
284:   if (range) {
285:     lines.push(`对照 git 区间：\`${range}\`（在当前 worktree 里 \`git diff ${range}\`）。`);
286:   }
287:   const byStatus = (status: FindingStatus): LedgerFinding[] =>
288:     file.findings.filter((row) => row.status === status);
289:   for (const status of FINDING_STATUS_ORDER) {
290:     const rows = byStatus(status);
291:     lines.push("", `${status} (${rows.length})`);
292:     if (rows.length === 0) {
293:       lines.push("- （无）");
294:       continue;
295:     }
296:     for (const row of sortLedgerFindings(rows).slice(0, 40)) {
297:       lines.push(
298:         `- ${row.id} [${row.severity}] [${findingStatusLabel(row, file.sha)}] ${row.title}`,
299:       );
300:     }
301:     if (rows.length > 40) lines.push(`- …另有 ${rows.length - 40} 条`);
302:   }
303:   return lines.join("\n").slice(0, 12_000);
```


---

### cli/src/auto/ledger.ts:773-788

```typescript
773:   return {
774:     findings: sortLedgerFindings(
775:       findings.map((row) => {
776:         if (row.status === "accepted") return row;
777:         const receipts = assessments.get(row.id) ?? [];
778:         const stillOpen = receipts.find((receipt) => receipt.outcome === "still_open");
779:         if (stillOpen) return { ...row, status: "open" as const, verification: stillOpen };
780:         const reported = matchFinding(row, input.reportedFindings, new Set()) !== null;
781:         const closure = receipts.find((receipt) => receipt.outcome === "verified_closed");
782:         if (closure && input.complete && !reported) {
783:           return { ...row, status: "closed" as const, verification: closure };
784:         }
785:         const unevaluated = receipts.find((receipt) => receipt.outcome === "not_evaluated");
786:         return unevaluated ? { ...row, verification: unevaluated } : row;
787:       }),
788:     ),
```


---

### shared/runtime/repair-package.ts:157-172

```typescript
157:     const plans = selected.filter((cluster) => cluster.closes.includes(row.id));
158:     return {
159:       id: row.id,
160:       title: row.title,
161:       severity: row.severity,
162:       rootCause: resolveRootCause(row.id, input.findingGroups),
163:       invariant:
164:         plans
165:           .map((cluster) => cluster.invariants.trim())
166:           .filter(Boolean)
167:           .join("\n") || `修复 ${row.id}：${row.title}`,
168:       evidence: row.text.trim() || row.title,
169:       files: unique([...row.files, ...plans.flatMap((cluster) => cluster.files)]),
170:     };
171:   });
172:   const deferred = remaining
```


---

## 9. 请给出的交付

请独立判断，不以多角色一致或已有提案作为正确性依据。重点区分：目标保持、安全性（不能假通过）、活性（合格候选能通过）、有界终止、实际交付率。固定预算只是终止条件，不能作为收敛成功证据。

请用中文给出：
1. 总结判断：是否支持此方向，现方案最危险的3–5个问题及反例；资料不足的地方明确标注。
2. 哪些机制必须由机器强制，哪些必须依赖语义裁决，哪些可以删除/延后；避免建设通用工作流平台。
3. 对R1–R9逐项给保留/修改/删除结论。必要时提出更小而完整的替代协议。
4. 可执行的状态转移与准入/准出/停止/续接条件；特别审查新发现扩范围、证据冲突、预算耗尽、两控制器竞争、候选脚本权限、崩溃恢复。
5. “固定原反例”会否过拟合？怎样兼顾未知回归、最终五席审查与时间预算？“同根因两次”及“三次写入/两小时”是否合理，怎样用历史数据校准而非拍脑袋？
6. 当前最小实施顺序与验收场景（含应该通过的正例和必须拒绝的反例），并说明如何证明交付率改善而非仅更快失败。
7. 给出修订后的精简控制协议摘要，列出仍需用户决策的项目，避免把未批准默认值写成事实。

可以否定或显著简化我们的方案，但每项关键建议应绑定具体失效场景。不要用“多加一个Agent审查”作为通用答案，不要假装已访问本地链接或执行了测试。请先检查材料中是否混淆历史快照、现行代码、模型报告和设计建议。
