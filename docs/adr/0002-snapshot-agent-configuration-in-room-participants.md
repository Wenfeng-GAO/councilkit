# Participant 保存 Agent 配置快照

Agent 加入房间时，Participant 保存当时的人格、`modelId`、Execution Profile 解析后的安全字段及 Profile revision/digest；之后编辑可复用 Agent 或 Profile，不会静默改变已有房间中的 Participant。首次发言前可以直接更新快照；一旦产生发言，显式切换配置会结束旧 Participant，并从下一轮创建新的活跃 Participant，历史消息仍引用旧 Participant。我们接受这部分数据重复，而不让 Participant 实时引用 Agent 最新值，以保证房间后续行为稳定、讨论历史可解释。
