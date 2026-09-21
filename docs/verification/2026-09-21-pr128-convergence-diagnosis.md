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
