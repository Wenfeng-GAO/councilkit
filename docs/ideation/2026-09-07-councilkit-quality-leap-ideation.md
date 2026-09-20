---
date: 2026-09-07
topic: councilkit-quality-leap
focus: 基于当前代码、Git 演变和本机运行记录判断质变方向
source_commit: d8ebebb
status: analysis-only
---

# CouncilKit 还有哪些值得投入的质变方向

**判断：有。下一阶段最值得投入的目标，是让一次代码变更获得可信、可解释、能收敛的完成判断。**

当前已经有独立并行审查、聚合报告、问题账本、方案陪审、修复与复审、外部 Squad 观察。真正欠缺的是这些能力之间的证据约束：一个问题为什么成立、为什么可以关闭、旧判断何时失效、下一轮究竟还要证明什么。

建议优先级：**可信的问题生命周期 → 有停止条件的复审 → 围绕 PR 的持续工作台**。项目经验与陪审团效果评测建立在这三项之上。当前代码和个人使用记录足以支持这个方向，但不足以证明外部市场需求或多 Agent 相对单 Agent 的总体收益。

## 证据范围与统计口径

- 代码基线：当前 checkout 的 main@d8ebebb，最近提交日期 2026-08-26；分析开始时工作区干净。
- 代码范围：CLI review/apply/fix、runner、prompt、ledger、Host 报告接口、报告列表/对比/详情页面、共享 schema。
- 历史范围：Git、ADR、brainstorms、7/30–31 真实使用复盘、Squad 修复历史和独立缺陷验证记录。
- 使用范围：本机 /Users/hengzhuo/.config/councilkit/runs，留存时间 2026-07-23 至 2026-09-07。
- 不包含浏览器 IndexedDB、已删除记录、其他机器或其他 COUNCILKIT_HOME。数据目录优先级可核对 [cli-home.ts](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/shared/runtime/cli-home.ts:15)。
- 本次只读分析业务代码与运行数据；另新增此文档。没有运行真实 Agent、启动 Host、触发修复或改写历史账本。

| 观察对象 | 实际留存结果 | 解读边界 |
|---|---|---|
| 全部 Run 目录 | 82 | 包含开发/观察测试 |
| PR review | 47，覆盖 8 个 PR | 是本机留存样本，不是产品总体用户量 |
| review 终态 | 40 completed、6 failed、1 interrupted | completed 中 4 次仍有失败席位；仅 36 次全席成功 |
| 增量关系 | 27 次 against，20 次无 against | 已经存在增量复审习惯 |
| discussion | 4，全部在 7/23；2 completed、2 failed | 不含浏览器讨论，不能据此断言讨论功能无人使用 |
| squad sidecar | 31；20 closed、2 interrupted、9 无 finished | 9 条同 taskId、空席 briefing 疑似开发测试；另有 1 次明确观察空跑 |
| 近 14 个中国自然日，8/25–9/7 | 24 review、29 squad、0 CLI discussion | 29 squad 含上述测试样本 |
| 8/31 起 20 次 review | 中位 19.43 分钟，P90 22.08 分钟 | 执行耗时，不是用户注意力时间或模型费用 |
| 全部 completed review | 中位 21.13 分钟，P90 37.97 分钟 | 旧记录可能跨 resume，不应把最大跨度当单次连续执行 |
| 恢复/重试记录 | 2 个 run 含 resume，共 3 条 resumed；2 条 retryOf | 仅说明现存记录的使用，不推断能力缺失 |

**实际工作已经跨越工具边界。**20 个 review 目录带 pipeline 最新快照：19 个 skipped apply、1 个 failure，18 个记录了 followUpRunId。结合报告上下文，近期常见路径是 CouncilKit 审查、外部 Squad 实施、CouncilKit 复审。skipped apply 多数对应只复审入口，不是 19 次修复失败。

apply.json 是覆盖式快照，3 个文件不能等同于只执行 3 次 apply。2 处 landings.jsonl 共 7 条落地记录，结合旧 apply 快照至少能确认 8 个不同候选提交的落地证据。不能用目录前缀统计 apply/fix 次数。

## 产品已经完成的变化

2026-07-29 的需求重定义明确把价值放在“不同 Agent 独立完成同一任务后对比汇总”，并让 Autonomous Run 直接 spawn Agent。这里的自主性是用户主动选择，见 [权威设计](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/brainstorms/2026-07-29-autonomous-parallel-review.md:7)。

Git 对应演变：

| 日期 | 提交 | 行为变化 |
|---|---|---|
| 7/29 | aaba02c | 自主并行 review |
| 8/19 | 9ce59e8 | live progress、同 PR 对比、apply |
| 8/21 | d806b65、c39fc25 | fix、方案陪审、账本、Live Transcript |
| 8/24–26 | da627aa、9183219、61ce895 | 外部 Squad 观察、交接与收工状态、文档展示 |

探针、有限自动重试、review --resume、部分成功报告、隔离 worktree、过程观察均已存在，不能重复包装成下一阶段的新能力。7/31 复盘已经记录它们如何救场，也记录过 correctness 和 maintainability 的高价值独有发现，见 [真实使用复盘](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/plans/2026-07-31-001-feat-review-report-ux-plan.md:12)。

旧 roadmap 与当前实现存在时间差，不能把“报告历史、自动化工作流尚未完成”等旧规划直接当现状。浏览器与 CLI 分离也是有意取舍，见 [ADR-0013](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/adr/0013-cli-as-orchestrator-with-separate-data-world.md:14)。统一用户视图可以先于底层迁移。

## 最重要的发现：关闭状态缺少验证保证

这既是明确的可靠性问题，也是最有价值的产品升级切入点。

当前链路：

1. 先生成聚合 Markdown，再从指定章节提取 Finding；ID 来自文件与标题，匹配还会依赖严重度和标题词重叠。见 [提取入口](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/src/auto/ledger.ts:73)、[ID 与匹配](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/src/auto/ledger.ts:415)。
2. 复审中旧 Finding 没有匹配项就直接 closed，见 [classifyAgainstPrior](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/src/auto/ledger.ts:116)。
3. review 的 finalize 在写账本前没有要求复审成功、覆盖完整或证据有效，见 [review.ts](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/src/commands/review.ts:1228)。
4. apply 在 Agent 成功返回、处理提交与 push 后，按计划中的 closes 标记关闭，尚未独立验证每个关闭主张，见 [apply.ts](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/src/commands/apply.ts:406)。
5. fix 的后续复审对非中断 ReviewExit 返回 runId，外层可完成；UI 会另外读取后续 Run 的失败状态，但 CLI 外层终态仍不能代表复审通过，见 [fix.ts](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/src/commands/fix.ts:711)、[UI 补充判断](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/src/components/report/FixPipeline.tsx:50)。

本机反例：

| Run | 实际终态 | 该 Run 的账本 |
|---|---|---|
| ck-review-54bb945b-9fc7-4d06-be87-658eb1142bb0 | Aggregator 探针失败，未拿到被审 SHA | 17 条全 closed |
| ck-review-87c2cf77-768f-4aa2-959f-d13cc9f3ab3a | Aggregator 探针失败，未拿到被审 SHA | 28 条全 closed |
| ck-review-458934d7-7729-4688-a7c1-ee4cdd88c8b3 | 用户信号中断，ABORTED | 34 条全 closed |

第一个例子的 [失败 transcript](/Users/hengzhuo/.config/councilkit/runs/ck-review-54bb945b-9fc7-4d06-be87-658eb1142bb0/transcript.jsonl:6) 与 [账本](/Users/hengzhuo/.config/councilkit/runs/ck-review-54bb945b-9fc7-4d06-be87-658eb1142bb0/findings.json:1) 可直接对照。

不能把三行相加宣称“79 个原本未关闭的问题被错误关闭”：父账本本身已有 closed，且可能被后续 apply 修改。能够确认的是：**没有完成复审，也会产出全部 closed 的账本。因此 closed 不能当作已验证修复的真值。**

已用当前源码执行最小行为验证：向 classifyAgainstPrior 传入一条 open 的 major Finding 和空的新 Finding 数组，输出为 closed。现有 [单测](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/cli/tests/ledger.test.ts:133) 也将这个行为写成预期；它反映的是状态语义不足，单纯增加同类单测无法解决。

## 另一条强信号：复审需要明确“够好了”的条件

一个 SDK PR 在 8/31–9/3 有 16 个不同 SHA、16 个唯一 review、15 条连续 against 关系，累计审查运行时长 304.76 分钟。末次账本有 116 条快照项，109 closed、7 open，剩余 3 minor 和 4 nit；末次聚合 verdict 为 comment，正文认为不阻塞。

证据：[首次报告](/Users/hengzhuo/.config/councilkit/runs/ck-review-90c5a9b8-0594-47d8-901f-2c5a6183f0c0/report.md:20)、[末次报告](/Users/hengzhuo/.config/councilkit/runs/ck-review-0e70f600-3641-48d4-8f32-ed7863ee9357/report.md:23)。

16 个不同 SHA 表明工作范围持续变化，不能把约 305 分钟全算作浪费，也不能断言都是同一问题来回反复。真正缺少的是可量化的判断：每轮新增了什么有效发现、哪些验证因变更失效、已接受的取舍是否又被重开、什么时候该停止。

另有独立的工程历史证据：外部 Squad 任务 20260731-report-ux-c4m7 的提交 fba3ac3、4ec7d33、b19e065 分别记录 fix round 12、16、28，涉及修复引入语法错误、Markdown 处理震荡、扩大 retry 范围后按冻结 brief 回滚。这是 Squad 的修复轮次，不能混入 CouncilKit review 次数，但说明真实工作流确实承担审修反复与范围漂移的成本。

## 排序后的五个方向

以下信心为基于本次证据的主观判断，不是收益概率。统一考虑证据强度、用户价值、新增能力、落地成本和后续复用；重复方向合并，不以功能数量加分。各项均为待进一步定义的方向，本次不制定实现计划。

### 1. 用验证证据推进问题生命周期

**描述：**在现有账本上明确区分候选问题、已确认问题、修复声称、待验证、验证关闭、已接受取舍。每条关闭结论关联适用 SHA、触发条件、修复提交、验证方法与结果。Markdown 继续承担阅读和导出，自动化决策读取有来源的结构化记录。

**理由：**这是已发生的信任问题。即使只修复“失败复审不得关闭旧项”，也有立即价值；质变来自进一步把整个关闭依据做成可追溯事实。严重或有争议的独有发现可交给另一席位定向证伪，保护独有价值，也避免把相同说法的票数当真实性。

**能力边界：**验证不能一律等价为测试命令退出 0。并发、语义或设计问题可能需要生产可达路径、静态推导、反例或人工裁决。记录验证方式及局限，没有充分证据就保持未验证。

**代价：**旧数据缺证据，需兼容为“历史关闭、未验证”；全面逐项验证会增加耗时，应先覆盖阻塞项和争议项。不能通过重新生成 Markdown 给旧结论补造证明。

**信心：95%；复杂度：中到高；状态：部分落地（2026-09-20）。** 失败/中断不再关闭旧项；apply 只写 repairClaim；覆盖率可见但不挡 review 退出。身份稳定、accepted 写入、施工回执仍未完成。

**验证成效：**失败/中断/未覆盖的复审不会新增验证关闭；每条验证关闭都可追溯到证据；修复提交成功与复审成功分别表达。

### 2. 让每一轮复审有明确目标与停止条件

**描述：**在现有 against 和 plan.lock 上固定本轮必须满足的不变量、阻塞项、接受保留项、候选 SHA 与复审覆盖。下一轮围绕变更使哪些旧判断失效来取证；只有新证据或前提变化才推翻已接受结论。剩余非阻塞项可以留存，不为了“零 Finding”无限继续。

**理由：**已有 16 次连续审查和工程审修震荡。需要把“再审一遍”变成“补齐这几项证明”，并允许预算到达时明确停在未决状态。

**能力边界：**停止条件是“所需证据达到约定水平”，不是“大家都说 approve”。超出时间或轮次预算必须报告仍缺什么，不得因预算耗尽自动放行。不能因只看增量就忽视被本次修改影响的跨文件不变量。

**代价：**覆盖与失效判断比按 diff 文件过滤复杂，过度缩小范围会漏回归。初期对高风险改动保留完整陪审和人工确认覆盖范围。

**信心：90%；复杂度：中到高；状态：待探索。**

**验证成效：**在相同证据要求下，达到可交付状态所需复审次数、累计耗时和人工翻阅下降；独有严重问题保留率、回归检出率不下降。

### 3. 围绕 PR 串联审查、外部实施和待决事项

**描述：**在已有按 PR 分组、compare、followUpRunId、Squad handoff 上，形成持续工作台：当前有效 SHA、未决问题、最新候选提交、验证覆盖、外部实施进展、下一步需要谁处理。用户可以继续一个 PR，系统选择有效基线。

**理由：**47 次 review 对应 8 个 PR，说明用户长期处理的是代码变更。当前 [首页主入口](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/src/components/home/Landing.tsx:66) 仍是新建讨论；[报告列表](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/src/app/pages/ReportsPage.tsx:54) 虽按 PR 分组，核心仍是 Run 列表和最近两份报告对比。

**能力边界：**向外部执行者交付包含 Finding、修复边界、SHA 和验收要求的任务包，再接收候选提交与证据。继续沿用既有只读 sidecar 分工，观察数据不自动赋予执行权限；没有必要让 Host 接管 Squad 或重造其编排器。

**用户收益：**首页突出需判断的阻塞、冲突、失效证据、恢复操作；运行期间可以离开，回来直接看到变化。已有 CLI 独立运行，新增的是可靠恢复与待办表达，不是再建一次后台执行能力。

**代价：**跨工具身份、版本关联和多来源状态需严谨处理。浏览器独立数据是否迁移可以后置；先统一这个使用最强的 PR 视图。

**信心：85%；复杂度：中；状态：待探索。**

**验证成效：**继续一个 PR 时不需手工找 runId、拷贝整份报告或核对多个 SHA；查看下一动作的操作数与人工注意力时间减少。

### 4. 把已确认的取舍和缺陷沉淀为可失效的项目经验

**描述：**记录“真实缺陷、误报、接受取舍”的裁决及依据，附作用范围、相关代码、适用版本和失效条件。后续 PR 使用仍有效的仓库事实、验证方式和已接受合同，并在前提变化时重新审视。

**理由：**当前 accepted 主要在单条 against 链中继承，schema 缺裁决理由、来源和失效条件；[Finding UI](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/src/components/report/FindingLedger.tsx:24) 主要是展示。历史范围漂移说明重复解释设计意图有实际成本。

**能力边界：**只沉淀有验证或明确裁决支持的信息；共享仓库事实与证据，不把前一席的结论强塞给其他席位。项目级存储，保持可纠正、可失效，避免积累成永久提示词偏见。

**代价：**需要低摩擦的裁决入口和知识过期规则；用户可能不愿逐条标注，应从重大问题和反复争议项开始。

**信心：80%；复杂度：中；状态：待探索。**

**验证成效：**已接受取舍的重复争议下降；前提已改变的旧经验能够失效；新 PR 的重复环境摸索减少，同时维持独立发现能力。

### 5. 用本地真实缺陷评测陪审团，再决定如何投入席位

**描述：**从已独立确认的缺陷和修复构建固定 SHA 的评测样本，比较完整 Council 与不同组合的有效独有发现、误报、反驳、遗漏、耗时及聚合保真。获得足够证据后，再推出按风险和目标分配席位的运行策略。

**理由：**现在能知道谁跑完、用了多久，却不能可靠回答谁提高了质量。[ledger schema](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/shared/runtime/cli-ledger.ts:27) 的 closed 不是评测标签；7/31 的独有发现个案又证明不能简单保留最快席位。

**已有资产：**[ROT-BYPART-001](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/.planning/bugs/ROT-BYPART-001.md:60) 中，独立 Validator 先推翻 Scout 声称的入口，再确认真实生产路径。这种“有缺陷、有反驳、有独立验证”的记录比报告票数更适合建立评测集。

**能力边界：**隐藏修复答案，使用固定环境并保留独立裁定；先比较单席基线、完整多席和精简组合。不得直接拿自动生成的 299 个不同 Finding ID 当真值；没有足够样本时保持现有选择，不默认削减席位或替换模型。

**代价：**标注和历史环境重放有成本，小样本容易过拟合。当前没有可靠 token/金额记录，先量化耗时与有效发现，不伪造费用。

**信心：75%；复杂度：中到高；状态：待探索。**

**验证成效：**能用固定案例回答“这一席多抓了哪些确认问题、错报了什么、移除后漏掉什么”；在证据充分后，目标是在保持关键检出能力的条件下降低等待和重复执行。

## 候选筛选记录

三个独立视角共产生 24 个候选。先汇总再筛选，合并为上述 5 个方向。没有因功能数量多就保留；下表保留每个原始候选的去向。

| 来源/编号 | 原始候选 | 筛选结果与原因 |
|---|---|---|
| 用户摩擦 1 | PR 持续工作台 | 合并到 3；与其他两组的 PR 案件重复 |
| 用户摩擦 2 | 关闭凭证 | 保留为 1 的核心，存在真实反例 |
| 用户摩擦 3 | 只处理需人决定事项 | 合并到 3；独立收件箱缺少可信状态基础 |
| 用户摩擦 4 | 复审只购买新判断 | 合并到 2；超出已有 against 的增量价值是覆盖失效 |
| 用户摩擦 5 | 恢复整个目标 | 合并到 3；已有 resume，不单列重试项目 |
| 用户摩擦 6 | 用户纠正持续受益 | 合并到 4；需要作用范围与失效条件 |
| 用户摩擦 7 | 按目标选服务 | 合并到 5；立即自动选席缺乏质量真值 |
| 用户摩擦 8 | 跨执行器任务包 | 合并到 3；独立编排平台超出需求 |
| 重新定位 1 | PR 案卷 | 合并到 3 |
| 重新定位 2 | 分开执行与解决状态 | 合并到 1 |
| 重新定位 3 | 独立证伪 | 合并到 1；拒绝每条 Finding 无差别增加一整轮 |
| 重新定位 4 | CouncilKit 合同、Squad 施工 | 合并到 3；避免新建通用工作流引擎 |
| 重新定位 5 | 允许待裁定分歧 | 合并到 1/2；单独新功能与证据生命周期重叠 |
| 重新定位 6 | 可失效的“不改”知识 | 合并到 4 |
| 重新定位 7 | 历史缺陷考试题 | 合并到 5 |
| 重新定位 8 | 按需追加席位 | 延后为 5 的结果；没有基准就默认降配风险大 |
| 复利 1 | 持续审查案件 | 合并到 3 |
| 复利 2 | Finding 可执行证据 | 合并到 1；补充支持非命令形式证据 |
| 复利 3 | 效果数据集 | 合并到 5；自动账本不能直接当训练/评测真值 |
| 复利 4 | 独有价值盲测 | 合并到 5 |
| 复利 5 | 复用调查材料 | 合并到 4；无失效条件的缓存会传播错误 |
| 复利 6 | 收益导向收敛 | 合并到 2 |
| 复利 7 | 标准外部修复交接 | 合并到 3 |
| 复利 8 | 仓库专属经验 | 合并到 4 |

同时审视了浅扫描与旧 roadmap 中的常见方向：

| 未优先选择 | 原因 |
|---|---|
| 更多 Driver、模型或人格 | 现有多视角已有价值，但没有证据证明数量仍是主要瓶颈 |
| PDF、模板商城、报告装饰 | 可作为局部便利，无法解决本次实证的可信关闭与复审成本 |
| 首先统一全部 Browser/CLI 存储 | 是可能的架构终局，但迁移成本高；先统一 PR 工作视图更贴合使用 |
| 重启通用 Host 拓扑引擎 | 已被 7/29 需求重定义替代；当前自主运行与 Squad 分工有明确价值 |
| 只缩短 timeout 或取消慢席位 | 会伤害独有问题检出，现有数据无法证明净收益 |
| 全部自动修复直到零问题 | 把非阻塞项也拉入循环，且目前关闭状态尚无证据保证 |

## 如何判断下一版发生了质变

先修正状态真实性，再收集基线。建议用少量已确认案例与后续真实 PR 观察以下指标，目标数值应在取得基线后确定：

1. **错误关闭率：**复审失败、未覆盖、证据不足却标验证关闭的比例。
2. **证据可追溯率：**验证关闭中可定位到对应 SHA 与验证记录的比例。
3. **有效独有贡献：**其他席未发现但后来确认成立的问题，以及成功推翻误报的次数。
4. **收敛成本：**达到相同交付标准的复审次数、累计执行时长、人工翻阅/操作时间。
5. **修复可靠性：**声称修复后仍成立的比例、新引入回归、因旧经验失效而漏检的案例。

不要以“报告数量、总 Finding 行数、closed 总数、Agent 数量、总体 completed 比例”替代质量。35 份账本累计 1,716 行、299 个不同 ID，存在继承重复和文本身份漂移；它们不是 1,716 或 299 个真实缺陷。8 个 PR 的本机样本也不足以宣称某个 Driver 或多 Agent 架构普遍更优。

## 会话记录

- 2026-09-07：扫描当前代码、产品与工程历史、本机 82 个 Run 目录；三个独立视角生成 24 个候选，合并并筛选为 5 个方向。
- 2026-09-07：根代理复核三个失败/中断账本反例，执行 classifyAgainstPrior 最小行为验证；未修改业务代码或运行数据。
- 2026-09-07：将可信问题生命周期、复审收敛、PR 持续工作台列为前三项。后续若选定方向，再展开需求与验收讨论；本次不启动实现。
- 2026-09-20：repair protocol + follow-up 终态 + 同 SHA 守卫 + 浏览器 against；方向 1 从「待探索」改为部分落地。身份/accepted/施工回执仍缺。
