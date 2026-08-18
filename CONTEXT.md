# CouncilKit

CouncilKit 组织本地、结构化的多 Agent 讨论，并通过统一的本地执行边界获得模型能力。

## Language

**Runtime Host**:
CouncilKit 的本地模型执行边界；一个 Runtime Host 提供一种或多种 **Runtime Driver**，同时服务构建后的 Web UI 与同源 `/api/v1`，但不理解或调度房间与轮次。浏览器不直接执行 HTTP 或 CLI 模型调用，也不在 Host 不可用时绕过它。
_Avoid_: Runtime、daemon、gateway、backend

**Discussion Orchestrator**:
组织房间讨论的领域角色，负责 Participant 的发言顺序、轮次、上下文、总结与业务持久化；它使用 **Runtime Host** 执行模型，但不把讨论规则交给 Host。
_Avoid_: Runtime Host、Runtime Driver、facilitator

**Runtime Driver**:
Runtime Host 内置的一种模型执行协议实现；同一种 Runtime Driver 可以形成零个或多个 **Execution Profile**，且不由用户创建。V1 四个内置 Driver：`claude-stream-json`、`codex-app-server`、`kimi-stream-json`、`grok-stream-json`。
_Avoid_: Provider、Runtime、Agent、Execution Profile

**Runtime Installation**:
Runtime Host 已确认可用于某个 **Runtime Driver** 的本机程序安装；它只能由 Host 本机发现或用户显式批准，不能由导入数据建立信任。一个 Driver 可以有零个或多个 Installation，CLI 类型的 **Execution Profile** 引用其中一个。
_Avoid_: Runtime Driver、Execution Profile、arbitrary executable

**Execution Profile**:
用户可选择的无秘密执行配置，基于一个 **Runtime Driver**，引用一个 **Runtime Installation**，并只包含 Driver 声明的类型化选项。Profile 不保存模型；模型只由 **Agent** 的 `modelId` 指定。
_Avoid_: Runtime、Gateway、Provider account、model selection

**Driver Selection**:
CLI 侧 Agent 对模型执行能力的无秘密引用：一个 **Runtime Driver** 的标识与其类型化选项（如 cld route），不引用具体 **Runtime Installation**——Installation 由 Runtime Host 在每次运行时动态解析。它不是 Execution Profile；CLI 上下文不创建或持久化 Execution Profile。
_Avoid_: Execution Profile、profile、installationId binding

**Council**:
CLI 侧保存的可复用静态讨论配置：topic、background、目标输出、agent 组合与轮次配置。它只是配置，不是讨论实例；`run` 执行一场讨论时才产生讨论实例。Council 与浏览器的 Room 数据不互通。**Autonomous Run** 可复用 Council 的 agent 组合与 Reporter（映射为 **Aggregator**），忽略轮次配置。
_Avoid_: Room、room、template

**Reporter**:
CLI 上下文中 Council 显式指定、负责在固定轮次结束后做一次最终总结调用的 agent。CLI 讨论没有每轮摘要与提前收敛，因此 Reporter 不是浏览器的 Facilitator。
_Avoid_: Facilitator、summarizer

**Run**:
CLI 执行一个 **Council** 产生的一场讨论实例：有序消息记录（transcript）与最终报告，由 CLI 持久化在本地存储。Run 与浏览器的 Room 实例语义对应，但数据不互通。与 **Autonomous Run** 并列；需要强调区分时可称 Discussion Run。
_Avoid_: Room、session、execution

**Autonomous Run**:
CLI 直接并行发起的一组全能力 Agent 执行实例：同一 **Task Template** 与同一输入，N 个 **Attempt** 各自独立完成后由 **Aggregator** 对比汇总。它不经过 Runtime Host，不使用 Execution Scope / Context Snapshot / Discussion Orchestrator；与 Run（Discussion Run）共享 runs/ 落盘样式与退出码体系，但数据不互通。子进程以用户本人权限运行、继承正常用户环境，信任级等同用户亲手执行该 CLI（2026-07-29 用户决策：安全不作为约束，全部权限可接受）。
_Avoid_: Discussion、Council、Execution Scope、Context Snapshot

**Attempt**:
一个 **Agent** 在 **Autonomous Run** 中对同一任务的一次独立全能力执行：一个子进程、一个隔离 workspace、一份最终文本交付物。Attempt 之间互不可见，不共享 workspace 与会话；单个 Attempt 失败不中止 Run，其余继续。
_Avoid_: Participant、Execution Session、turn

**Aggregator**:
**Autonomous Run** 显式指定、在全部 Attempt 结束后做一次汇总对比调用的 agent；它本身也是一个 Attempt（先独立完成任务，再看到全部 Attempt 产出做聚合），不可用时不得静默替换。
_Avoid_: Reporter、Facilitator、summarizer

**Task Template**:
**Autonomous Run** 的任务说明与输出契约（工作方式授权 + 最终消息结构约定），只决定 prompt 文本，不改变执行与持久化规则；V1 内置 `review`。
_Avoid_: Discussion Mode、workflow、Council

**Credential Source**:
Runtime Installation 获得认证能力的方式；秘密内容不属于 Profile 或讨论数据。V1 只支持 `installation-managed`：Codex 复用本地 Codex 登录，`cld` 自行读取其本地配置，Runtime Host 不读取或转存凭据。
_Avoid_: API key field、local-cli-login、Execution Profile、Agent

**Execution Session**:
模型调用之间可保留的临时连续状态；它属于且仅属于一个 **Participant**，每个 Participant 同时至多关联一个当前 Session。Session 可以被丢弃并从 CouncilKit 的讨论记录重新建立；同一 Agent 的不同 Participant 不共享 Session。Claude/Codex 的 Session 由单一长期进程承载；Kimi 的 Session 跨每 turn 短进程经 `-S <session_id>` resume 保持连续（ADR-0012），但仍属于单 Participant、可丢弃。
_Avoid_: Room、transcript、source of truth

**Execution Scope**:
Discussion Orchestrator 为一组活跃 **Participant** 建立的不透明、带租约的执行生命周期；Runtime Host 只用它预热、保留和回收执行资源，不把它解释为房间。
_Avoid_: Room、Execution Session、browser connection

**Scope Controller**:
当前唯一可以对一个 **Execution Scope** 发起执行、取消、ACK、续租或关闭操作的浏览器实例。其他页面只能观察；Runtime Host 使用单调递增的 `leaseEpoch` 拒绝旧 Controller 的请求，Discussion Orchestrator 的 Dexie 写事务也校验当前 `controllerId + leaseEpoch + activeExecutionId`，阻止已被接管的页面提交结果或推进 Round。
_Avoid_: Room owner、browser tab、Participant

**Context Snapshot**:
Discussion Orchestrator 为一次模型调用生成的权威输入，分为 Room 共享上下文、当前 Participant 快照和本次 execution instruction。共享部分包含 `contextRevision`、确定性的 `contextDigest`、有序消息与摘要；Participant 使用独立的 `participantSnapshotDigest`；本次指令使用 `instructionDigest`，不增长 Room revision。任何影响共享投影的写操作都增长 Room revision，Participant 快照变化则更新自己的 digest；Host 可以对健康 Session 增量应用 Snapshot，但不能自行决定历史窗口、摘要或裁剪规则。
_Avoid_: CLI history、Execution Session、prompt cache

**Model Execution**:
Discussion Orchestrator 提交给 Runtime Host 的一次模型调用，由全局唯一的 `executionId` 标识；同一 `executionId` 的重试只能重连已有执行，不能再次调用模型。它产生带递增 `eventSeq` 的临时事件流，不等同于讨论 turn 或持久化消息。
_Avoid_: Round、Message、Execution Session

**Agent**:
本地保存、可跨房间复用的讨论角色，组合了人格定义、一个 **Execution Profile** 和一个 `modelId`；相同人格绑定不同 Profile 或模型时，视为不同 Agent。Agent 不是房间成员关系或执行会话；Driver 是否提供工具能力不属于 Agent 身份。CLI 上下文中 Agent 的执行绑定是 **Driver Selection** 而非 Execution Profile，两者数据不互通。
_Avoid_: Participant、session、process、Execution Profile

**Participant**:
一个 **Agent** 在特定房间中的一次参与关系，保存 Agent 加入房间时的人格、Profile 解析结果、Profile revision/digest 和 `modelId` 快照，并为完整快照维护独立的 `participantSnapshotDigest`；首次发言前可以更新，发言后改变配置则结束旧 Participant 并创建新的活跃 Participant。一个房间包含一个或多个 Participant，同一 Agent 在同一房间可以有多个先后发生的 Participant，但同时至多一个处于活跃状态。
_Avoid_: Agent、Runtime、process

**Facilitator**:
Room 显式指定、负责生成 Round Summary 的 **Participant**。Summary 是独立 Model Execution，但复用该 Participant 的长期 Driver 进程和 Session；Facilitator 不可用时不得静默切换其他 Participant。
_Avoid_: Discussion Orchestrator、first successful Agent、fallback model

**Discussion Mode**:
Room 的讨论范式（brainstorm / planning / review），只决定 Facilitator 的引导方式与 Summary、Decision Report 的章节侧重，不改变执行与持久化规则。
_Avoid_: workflow、template（Room 模板是后续独立概念）

**Convergence**:
讨论的收敛判定：Facilitator 在 Round Summary 中给出收敛建议，或达到 Room 设定的 maxRounds；触发 Decision Report 的生成。
_Avoid_: completion、finish

**Decision Report**:
Room 收敛后由 Facilitator 的一次独立 Model Execution 产出的结构化 Markdown 决策报告；与 Message/Summary 一样是幂等提交的持久化事实，一个 Room 至多一份。
_Avoid_: summary、transcript、chat log

**Concluded**:
Room 的生命周期终态：Decision Report 已提交。Concluded Room 的讨论事实保持只读，不再开启新 Round；报告生成过程（concluding）是编排瞬态，不是持久状态。
_Avoid_: closed、finished、archived

**RunState / Round Phase**:
两个独立维度：Room 的用户调度门（idle / running / paused，UI 称「已暂停调度」）与 Round 的状态机（UI 称「本轮已暂停」）。暂停调度不改写 Round 的 phase，暂停 Round 不改变 Room 的门。
_Avoid_: 用「暂停」同时指代两者

**Idle Scope**:
Execution Scope 进入空闲后的回收判据：最后一个 Model Execution 结束超过 `idleScopeTtlMs`（默认 30 分钟）后，Runtime Host 自动 close 该 Scope 的预热资源，浏览器侧下一次开轮走冷建恢复。它不是用户意图，而是一个后台超时；在 TTL 之前 Scope 仍保持 warm 并可被复用。
_Avoid_: Release Runtime、pauseRoom、Session discard

**Release Runtime**:
用户显式释放当前 Room 的 warm Execution Scope 的意图（UI「释放运行时」）：仅当没有活动 Model Execution 时允许，立即 close 预热资源，下一轮 `startRound` 经 ensureScope 冷建续跑。与 Idle Scope 的自动超时不同，这是用户主动行为；与 pauseRoom 不同，它不动 Room 的调度门，只是回收执行资源。
_Avoid_: Idle Scope、pauseRoom、delete Room

## Example dialogue

> **开发者**：房间需要直接连接 Codex 吗？
>
> **领域专家**：不需要。房间记录讨论，模型执行统一交给 Runtime Host。
>
> **开发者**：用户是在设置里添加 Runtime Driver 吗？
>
> **领域专家**：不是。Driver 由产品内置；用户添加的是引用本机 Runtime Installation 的 Execution Profile。
>
> **开发者**：Profile 里也保存模型吗？
>
> **领域专家**：不保存。Agent 绑定 `executionProfileId + modelId`；同一人格使用不同 Profile 或模型时，视为不同 Agent。
>
> **开发者**：Profile 里要保存 DeepSeek token 或 Codex 登录吗？
>
> **领域专家**：不保存。V1 使用 `installation-managed`：`cld` 或 Codex Installation 自行解析本机凭据，Host 不读取秘密。
>
> **开发者**：同一个“安全审查员”加入两个房间，需要复制两个 Agent 吗？
>
> **领域专家**：不需要。它是一个 Agent，通过两个 Participant 分别参与两个房间，并拥有隔离的 Execution Session。
>
> **开发者**：Agent 加入房间后从 Codex 改成 GLM，房间会自动切换吗？
>
> **领域专家**：不会。Participant 保存加入时的配置快照；已经发言后切换会结束旧 Participant，并从下一轮创建新的活跃 Participant。
>
> **开发者**：Codex thread 丢失后，房间历史也丢失了吗？
>
> **领域专家**：没有。thread 只是 Execution Session；CouncilKit 仍保有完整讨论记录，可以用 Context Snapshot 建立新 Session。
>
> **开发者**：两个标签页同时打开一个房间，会不会重复调度？
>
> **领域专家**：不会。一个 Scope 只有一个 Scope Controller；Host 使用 `leaseEpoch` 拒绝旧页面的写请求，其他页面只读观察。
>
> **开发者**：刷新页面会结束 Participant 的进程吗？
>
> **领域专家**：不会。页面使用同一 Scope 和 `executionId` 重连，并从最后收到的 `eventSeq` 继续；Scope 属于租约，不属于单条浏览器连接。
>
> **开发者**：暂停房间会释放 Execution Scope 吗？
>
> **领域专家**：默认不会。页面继续续租时，暂停只阻止新的 Model Execution，Participant 进程仍保持 warm；用户可以显式释放运行时。
>
> **开发者**：Host 已完成输出，但 Message 提交后的 ACK 丢了，会不会重复写入？
>
> **领域专家**：不会。Message 保存唯一 `sourceExecutionId`；Host 重放完成事件后，Orchestrator 幂等提交并再次 ACK。
>
> **开发者**：流式 delta 已经完整显示，可以把页面拼接的字符串直接落库吗？
>
> **领域专家**：不可以。delta 只用于预览，最终 Message 使用 Host `completed` 事件中的规范化完整输出，并且必须先持久化再 ACK。
>
> **开发者**：长期 CLI Session 已有历史，下一次还要提交完整上下文吗？
>
> **领域专家**：要。Orchestrator 每次提交权威 Context Snapshot；Host 在纯追加时只向健康 Session 注入增量，无法衔接时用完整 Snapshot 重建。
>
> **开发者**：页面刷新后，当前 Round 怎么知道从哪里继续？
>
> **领域专家**：Round 是 Dexie 中的持久化状态机，保存 Participant 顺序、活动 execution 和下一位游标；Orchestrator 从最近一次原子提交边界恢复。
>
> **开发者**：谁负责生成 Summary？
>
> **领域专家**：Room 显式指定的 Facilitator。它不可用时 Round 进入 `paused` 并记录 `pausedFrom: summarizing`，不会静默换模型。
>
> **开发者**：Codex Agent 能使用 app-server 的内建工具吗？
>
> **领域专家**：可以。V1 不以 zero-tools 作为兼容性门槛；CouncilKit 使用专用 cwd、`read-only` sandbox 和无审批交互，但不承诺工具列表为空。
>
> **开发者**：Codex turn 中断后也会自动重试一次吗？
>
> **领域专家**：只有 `dispatchState: not_dispatched`，即能证明请求没有交给 app-server 时才可以自动重试。请求可能已写出但确认未到属于 `unknown`，与 `accepted` 一样暂停并等待用户确认；空工具的 Claude 路径仍可按策略自动重试一次。
>
> **开发者**：升级 Codex CLI 后需要先升级 CouncilKit 吗？
>
> **领域专家**：通常不需要。Driver 不按 Codex 版本号做白名单，而使用最小稳定协议、能力握手和宽容事件解析；只有必需协议能力确实缺失时才报告 Installation 不可用。
>
> **开发者**：可以在 Profile 里填一段 Shell 命令启动自定义模型吗？
>
> **领域专家**：不可以。Profile 只能填写 Runtime Driver 明确定义的字段，启动命令由 Driver 构造。
>
> **开发者**：导入 Profile 时，可以顺便信任并执行它指定的程序吗？
>
> **领域专家**：不可以。导入 Profile 只能进入待绑定状态，必须绑定本机已发现或由用户明确批准的 Runtime Installation。
>
> **开发者**：「本轮已暂停」和「已暂停调度」是一回事吗？
>
> **领域专家**：不是。「本轮已暂停」是 Round 状态机在等待处理；「已暂停调度」是用户关闭了 Room 的发言调度门，Round 的 phase 不受影响。
>
> **开发者**：讨论怎么算结束？
>
> **领域专家**：Facilitator 在 Summary 里建议收敛、或轮数达到 maxRounds，就触发生成 Decision Report；报告提交后 Room 进入 Concluded，内容保持只读。
