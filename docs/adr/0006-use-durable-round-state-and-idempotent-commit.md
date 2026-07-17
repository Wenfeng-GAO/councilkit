# 使用持久化 Round 状态机与幂等提交

Discussion Orchestrator 必须把 Round phase、`pausedFrom`、Participant 顺序快照、下一位游标、活动 `executionId` 和重试状态持久化到 Dexie；Room 另行持久化共享讨论上下文的 `contextRevision` 与确定性 `contextDigest`，Participant 保存独立的 `participantSnapshotDigest`，不能继续依赖页面内一次性的 `runRound()` 循环。启动模型调用前先保存活动 execution；模型完成后，在同一个事务中校验当前 `controllerId + leaseEpoch + activeExecutionId`，再按唯一 `sourceExecutionId` 提交 Message 或 Summary、把对应 ModelExecution 标记为 `committed` 与 `ackState: pending`、保存最终 eventSeq、增长 Room context revision、重算 digest 并推进 Round 状态，事务成功后才 ACK Runtime Host。任何改变共享持久讨论上下文的写操作都必须增长 Room revision；Participant 快照和单次 execution instruction 分别具有独立 digest，不混入 Room digest。页面刷新时先补发持久化的 ACK 待办，再重连已记录的 active execution；它已经丢失时按中断策略恢复。

这套事务 fencing 与 `persist → ACK` 协议让 Controller 接管、流式连接、页面刷新、commit→ACK 崩溃和 ACK 丢失都不会产生重复 Message，也使下一位 Participant 只会看到已经提交的权威上下文。代价是需要新增 `participants`、`modelExecutions`、ACK 状态和 runtime binding 数据，并把现有内存编排迁移为显式状态机。
