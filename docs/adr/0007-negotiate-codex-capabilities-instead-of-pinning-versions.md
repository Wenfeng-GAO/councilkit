# Codex 兼容性基于能力而非 CLI 版本

`codex-app-server` Driver 不维护 Codex CLI 版本 allowlist，也不因为未知版本号、schema 中出现新字段或事件而拒绝启动。Driver 使用最小稳定协议完成 initialize、认证状态、模型目录、thread、turn、流式输出和 interrupt，并将输入解析为开放集：未知字段与未知通知默认忽略，只有运行所需的协议能力确实缺失时才把 Runtime Installation 标记为不兼容。这样升级 Codex CLI 通常不要求同步升级 CouncilKit，也不要求迁移 Agent 或 Profile。

V1 不以 zero-tools 作为兼容性门槛。CouncilKit 为 Codex thread 提供专用 cwd、`read-only` sandbox 和 `approvalPolicy: never`，不注册额外 dynamic tools，但不要求 app-server 的有效工具列表为空。工具和命令 item 只作为临时 activity 事件，不成为讨论 Message。每次调用显式记录 `dispatchState: not_dispatched | accepted | unknown`；只有请求字节确定没有交给 Runtime 的 `not_dispatched` 才能自动重试，请求可能已写出但接受确认未到必须记为 `unknown`。`accepted` 与 `unknown` 都无法证明工具没有产生副作用，因此 Orchestrator 暂停并等待用户确认。我们接受本机 Codex 配置和 app-server 能力随安装变化的事实，换取复用本地登录与无版本绑定的升级路径。
