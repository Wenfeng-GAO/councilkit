# 分离讨论编排与模型执行

CouncilKit 应用层中的 Discussion Orchestrator 拥有 Execution Profile 记录、Participant 顺序、Room/Round 状态、上下文组装、总结与业务持久化；Runtime Host 拥有 Runtime Driver、Runtime Installation 信任、Execution Session、Execution Scope、子进程、取消和标准化执行事件。Host 负责验证 Orchestrator 提交的 Profile 解析结果，可以使用 Participant 标识隔离 Session，但不理解讨论领域或接管编排。我们选择这条边界以复用 Multica 的本地执行模式，同时避免把 CouncilKit 重构成 Multica 的任务与工作区系统。
