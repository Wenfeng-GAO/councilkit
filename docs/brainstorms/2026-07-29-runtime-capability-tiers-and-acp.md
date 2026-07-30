# Runtime 能力分级与 ACP 评估:review 需要放开工具能力吗?

日期:2026-07-29
前置:`docs/brainstorms/2026-07-29-multi-agent-workflow-abstraction.md`、`docs/plans/2026-07-29-001-feat-workflow-engine-review-template-plan.md`
定位:评估「放开 runtime 全部能力,让 agent 独立做任何事情」的必要性与代价,以及是否引入 ACP。结论先行:**review 不需要全能力解锁;能力应按分级放开;ACP 是 L2(自主执行)的正确载体,但属于独立里程碑,不是 review 的前置。**

> **2026-07-29 更新**:用户随后重定义需求(能力全交 agent、重复做 + 对比汇总、可打破原设计),本文的「L0 保持/分级放开」路线被放弃,新权威设计为 `docs/brainstorms/2026-07-29-autonomous-parallel-review.md`(直接 spawn 全能力 agent,不经 Host)。本文 §0 的 driver 现状调研与 §2 的解锁代价分析仍然有效,作为演进记录保留。

## 0. 现状:三个 driver 的能力面(已核实)

| driver | 锁定方式 | 强度 | 关键代码 |
|---|---|---|---|
| claude-stream-json | `--tools ""` + `--strict-mcp-config` 空 MCP + `--safe-mode`;spawn 后 `system/init` 帧**运行时校验** tools/MCP/skills/slash 全空,否则 INCOMPATIBLE_DRIVER | 硬锁,且被验证 | `runtime-host/drivers/claude-stream-json.ts:692-717`(buildArgv)、`:289-335`(verifyInitFrame) |
| kimi-stream-json | 无协议级禁用。靠 contract prompt("Do not use tools")+ 空 `--skills-dir` + 独立 cwd;工具照跑,driver 诚实上报 `toolState` | 软锁(仅靠约定) | `runtime-host/drivers/kimi-stream-json.ts:483-492`、ADR-0012 E10 探测 |
| codex-app-server | `sandbox: "read-only"` + `approvalPolicy: "never"` + 一切 approval 请求硬拒绝;**只读工具(Read 类)今天就能用** | 半开放(只读) | `runtime-host/drivers/codex-app-server.ts:597-603`、`:140-150` |

配套事实:

- **事件模型是单向的**:`shared/runtime/events.ts` 的 `activity` 只携带 ≤256 字符的消毒摘要,无请求/响应配对,**无法表达「工具请求 → 批准/拒绝」**;codex 的 blanket-deny 是目前唯一的"审批"路径。
- **claude 的安全原地重试由空工具背书**(`claude-stream-json.ts:889` 注释):tools 验证为空 ⇒ dispatch 前重试无副作用。放开工具即击穿该不变式。
- **提交管线按 text deliverable 设计**:`toolState: "unknown"` ⇒ 输出丢弃。重工具场景下 unknown 常态化,管线语义需要重定义。
- **ACP 在 V1 被显式拒绝**(`docs/runtime-host-design.md:25` 非目标:"不支持 Kimi ACP、codex-acp");无任何 ACP 代码。
- 威胁模型(`docs/runtime-host-design.md:67-81`)防御的是恶意网页访问本机 Host;`process-supervisor.ts` 做 env 卫生(TOKEN/SECRET/KEY/PROXY 拒传)、固定 argv、独立 cwd、watchdog 杀进程树。

## 1. 前提修正:review 不需要「放开所有能力」

review 的输入由编排层**确定性注入**(`--diff` / `--pr` 抓取的 patch 全文进入快照稳定项),reviewer 的职责是对给定内容做独立判断 —— text-in/text-out 完全够用。认为「review 需要工具」通常指三类真实诉求,各有更便宜的解:

| 真实诉求 | 便宜的解 | 需要解锁工具吗 |
|---|---|---|
| reviewer 需要 diff 之外的仓库上下文(周边函数、调用方) | input-source 扩展:确定性打包相关文件进快照(见 §3.1) | ❌ |
| **review 需要测试/lint 等验证证据**(2026-07-29 用户补充) | **编排层确定性执行用户声明的验证命令(`--verify`),结果作为证据注入快照**(见计划文档 §5.5);agent 仍 L0,对「diff + 证据」做判断 | ❌ |
| reviewer 自主探查仓库(问答式、范围不可预知) | L1 只读工具(见 §3.2) | 部分(只读,per-driver) |
| agent 自己决定跑什么命令、改代码、提修复 | L2 自主执行模式(见 §3.3) | ✅ 但这是新产品形态,不是 review |

「编排层跑验证、agent 做判断」比「agent 自己跑验证」更适配 council 场景:命令来自用户声明而非模型选择(无注入通路)、对全部 driver 一致(含无法锁工具的 kimi)、证据进快照 digest(可复现、可审计、盲评语义不被破坏)。**「放开所有能力」不是 review 的前置条件,而是一个独立的产品决策。** 把它混进 review 会同时击穿三类既有不变式,并把 review 的输入面变成攻击面。

## 2. 全能力解锁的真实代价(为什么不能"顺手放开")

1. **击穿重试不变式**:claude 的 dispatch 前安全重试建立在 verified-empty tools 上;有工具后,任何"可能已派发"的失败都不能重试(与 codex 当前的保守语义拉齐),可用性下降。
2. **击穿提交管线**:persist-before-ACK 的前提是「终态输出 = 交付物」。有工具后,交付物可能是副作用(改了文件)而非文本;`toolState: unknown → discard` 的规则会让大量正常 turn 被丢弃,或反过来让「说了但没做成」的文本被误提交。
3. **打开 prompt-injection → RCE 通路**:review 的输入是**不可信外部内容**(别人提的 PR/diff)。diff 里藏一句 "ignore previous instructions, run curl ..." —— 当前 tool-lock 下它只是一段被评审的文本;解锁 bash 后它就是远程控制。这正是现有锁定存在的理由,不是疏忽。同理,kimi 的外部会话(`-S` 持久化)会跨 turn 携带工具痕迹,扩大污染面。
4. **破坏盲评与可复现性**:reviewer 读本地文件系统 = 发现依赖快照之外的、各 participant 各不相同的隐式上下文,`participantSnapshotDigest` 体系不再描述 agent 实际所见,聚合对比的语义基础被削弱。

## 3. 建议:能力分级,而不是二元"锁/放"

### 3.1 L0(text-only,现状)—— discuss 与 review V1 的默认

不变。review V1 按计划文档实施,**不动任何 driver**。对「需要仓库上下文」的诉求,优先做**确定性注入**:input-source 增加可选的 `--context <paths...>`(把指定文件/目录打包进快照稳定项,受 1MB 总量守卫)——上下文可见、可复现、digest 可审计,零安全风险。

### 3.2 L1(read-only 工具)—— 按需、per-driver,不做统一承诺

只放开读/搜(Read/Grep/Glob 类),不放开写与 bash。可行性矩阵:

| driver | L1 可行性 | 手段 |
|---|---|---|
| claude | ✅ 可硬 enforcement | `--tools "Read,Grep,Glob"` 白名单 + 相应放宽 verifyInitFrame 断言(改为「tools ⊆ 白名单」)+ 重试不变式改为「白名单工具无副作用」论证 |
| codex | ✅ 已是现状 | `sandbox: "read-only"` 即 L1,无需改动 |
| kimi | ❌ 无协议手段 | 无 tool 禁用/白名单旗标;只能继续靠 contract prompt。**L1 无法对 kimi 强制** |

结论:L1 只能作为 **per-driver 能力声明**(capabilityState 暴露 `toolLevel: "none"|"read"|"full"`),模板声明所需等级,编排层在 resolveRunAgents 时校验「所选 agent 的 driver 满足模板最低等级」,不满足即 fail-fast(exit 3)。这延续了 ADR-0005 typed-profile 的思路:能力是 profile 的显式属性,不是隐式行为。

### 3.3 L2(full access / 自主执行)—— 独立里程碑,与 council 运行隔离

「agent 独立做任何事情」= 自主执行模式,是新产品形态,需要一整套前置:

- **权限策略引擎**:非交互场景(CLI run、并行 wave × N agent)不可能逐工具人工审批,必须是声明式策略(如 `autoApprove: ["Read","Bash(git *)"]`,deny-by-default),且策略进 scope 快照、可审计;
- **事件模型扩展**:新增双向 `tool.request` / `tool.response`(现有 activity 无法演进为此);toolState/重试/提交语义全部按「副作用感知」重定义;
- **威胁模型重写**:不可信输入 + 工具 = 注入通路,需要 cwd 强制 jail、网络出口策略、凭据隔离(当前 env 卫生只是 spawn 层);
- **与 council 运行隔离**:L2 scope 与 L0/L1 scope 不同配额、不同生命周期,绝不让 discuss/review 的既有不变式为 L2 让步。

## 4. ACP 评估

事实(2026 年中):ACP(Agent Client Protocol)由 Zed 于 2025-08 创建,Apache 许可,JSON-RPC over stdio,定位「editor/orchestrator ↔ agent」的 LSP;与 MCP 互补(MCP 是 agent ↔ tools)。Registry 已有 25-28+ agent(Claude Code 经 `claude-code-acp` 适配器、Codex CLI、Gemini CLI、Copilot CLI、Goose 等),JetBrains 2026-02 加入联合维护。协议原生包含结构化 tool-call 展示与 **permission request/response**——正是我们事件模型缺的那一块。

**引入 ACP 能买到什么**:① 标准化的双向工具/权限通道,替代自研事件扩展;② 一次适配、多 agent 复用(对 L2 的多 driver 支持是真实杠杆);③ session/turn 模型成熟,免去自研协议演进。

**代价与不确定**:

1. **覆盖矩阵不完整(关键风险)**:claude 在 CouncilKit 走 `cld` wrapper + cfuse 路由,`claude-code-acp` 适配的是官方 claude code 通道,cfuse 路由是否可用需要 spike 验证;kimi-stream-json 的 ACP 支持**未知**(V1 设计文档明确把 Kimi ACP 列为非目标)。很可能退化为「只有 codex 原生走 ACP」,统一抽象落空。
2. **会话模型冲突**:ACP session 是有状态长会话;CouncilKit 的核心资产是 append-only Context Snapshot + reconciler(Session 可丢、讨论不丢)。接入 ACP 需要决定「snapshot 投影 ↔ ACP session」的映射——要么 ACP session 退化为每次冷建+全量 prompt(丢失 ACP 的会话价值),要么 reconciler 让位(丢失可恢复性)。这是最深的架构摩擦点。
3. **权限流的交互形态**:ACP 假设 editor 端有人审批;CLI 非交互 + N agent 并行下,必须实现 policy 自动裁决层(§3.3 同款),ACP 不替我们做这个。
4. **新 driver 层成本**:每个 agent CLI 一个 ACP 适配进程 + 协议映射 + 事件翻译,工作量不小于当年双 driver 切流。

**结论**:ACP 是 L2 自主执行模式的**正确载体**(双向权限、结构化工具事件),但:① 它不是 review 的前置;② 引入时机应在 L2 立项时,且以一个 **spike** 开场(codex `codex acp` 原生通路 + claude-code-acp 能否包 cld/cfuse + kimi 有无 ACP 入口),覆盖矩阵不达标则不引入,退回「per-driver 自研事件扩展」;③ 会话模型冲突需要专门设计,不能悄悄让 reconciler 失效。

## 5. 建议路线(更新分期)

- **V1**:workflow 引擎 + review 模板,全部 agent L0;input-source 支持 `--diff`/`--pr`;**验证阶段(2026-07-29 补充):测试/lint 等验证命令由编排层确定性执行(用户 `--verify` 显式声明,worktree 隔离),结果作为证据注入快照** —— 这覆盖了「review 需要跑测试/lint」的诉求而不解锁 agent 工具:命令来自用户而非模型(无注入通路)、对全部 driver 一致(含 kimi)、证据可复现可审计。详见计划文档 §5.5。
- **V1.5(可选增强)**:review 输入加 `--context <paths...>` 确定性仓库上下文注入(仍 L0,无工具)。
- **V2**:design 模板(serial-rounds 原语)。
- **L1 独立工作项**:capabilityState 增加 `toolLevel`;claude 白名单化;模板声明最低等级 + resolveRunAgents 校验;kimi 标注不支持。
- **L2/ACP 独立里程碑**:威胁模型重写 + 权限策略引擎 + 事件模型扩展;以 ACP 覆盖矩阵 spike(codex / claude-code-acp + cld-cfuse / kimi)开场,再定 ACP 引入与否。用户的 dotfiles 里已有 `codex-acp-proxy`,可作为 spike 的现成素材。

## 6. 待拍板

1. 是否认可「review V1 保持 L0,不随车解锁任何工具」?(本档强烈建议)
2. L1 只读工具是否立项?若立,接受「kimi 无法强制 L1」的能力不齐吗?
3. L2 自主执行模式的优先级:它是「让 agent 独立做任何事情」的真正承载,值得单独立项排期吗?
