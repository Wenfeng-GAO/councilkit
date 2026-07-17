# CouncilKit 讨论数据是唯一事实源

CouncilKit 持有的 Room、Round、Message、Participant 和 Summary 是讨论的唯一事实源；Codex thread、Claude session、工具 activity 和其他 CLI 状态统一视为可丢弃的 Execution Session 数据。每个 Session 只属于一个 Participant，同一 Agent 在不同房间中的 Participant 不共享 Session；会话恢复失败时，Runtime Host 从 CouncilKit Context Snapshot 建立新会话，而不从供应商会话反向恢复讨论历史。我们接受重新注入上下文以及工具过程不可恢复的成本，以换取跨 Runtime 的一致恢复、迁移能力和数据所有权。
