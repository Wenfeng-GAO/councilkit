# Squad Cursor 500K 与角色模型配置：最终验收和部署

CouncilKit 已合并并推送 main，提交 `97e8476e584bb8ec0b6db167a1d6b1a112dea61c`，完整构建通过并重启现有 Host；新实例 `08b9a0b3-65ba-4657-85cb-805775f148f6` 健康检查通过。此处是本机配置与受控冒烟，不是实际 PR 的修复准出。

所有新 Squad 角色（orchestrator、planner_a、coder、planner_b、reviewer、verifier）明确配置为 Cursor `grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]`。编排/主规划/编码保持同一原生会话，独立角色保持独立会话、工作树和权限边界。原 pr-jury 五席配置保持不变。

Codex 独立复跑 36 项测试通过（默认关闭的真实 smoke 1 项跳过）；完整 pnpm typecheck、pnpm build 通过。真实 Cursor 与官方 Squad 的独立冒烟另有回执：编排启动/恢复均为 Grok 4.7 500K Extra High；Reviewer 与 Verifier 的原生会话与 Builder 互不相同；补齐正式现代 brief/gate/planning 后，连续 Builder 的 session 保持 `5a6abc56-54e7-4139-bbc3-aec61f6604e9` 且 succeeded。曾有一次 Cursor 参数化模型请求被上游拒绝，同一参数重试成功；未静默换模型。

角色配置已有 CLI：repair roles show / set / reset。可单独覆盖 Reviewer、Verifier、Planner B 为 Cursor 或 Codex 的明确模型；更改 Orchestrator 会同时更新连续 Builder 的模型。坏 JSON/读取错误明确拒绝，原子写入；不会把损坏配置静默当默认付费模型。自动付费模型 fallback 未开启。

依赖补丁：本机安装的个人 Squad skill 已增加该 500K 模型的精确身份映射，个人技能仓库本地提交 `2a3b3bf11015550cb34a48c5fe78dcadb3be634d`，未推送该仓库。映射保留 CLI 参数化原串，500K与256K、不同effort不等价；未改变全局默认角色/模型。旧 Squad 任务可能因工具链指纹变化拒绝恢复，不能绕过该检查；需要按同PR/同目标创建新的执行，而非冒充原会话。

换席不是运行中会话热切换。v2 可以停止旧writer后，以同PR同目标的新parent Run继承CouncilKit持久链的sourceFixUsed；新执行额外消耗正常派工预算，不能删除旧预算。旧工作树和未提交改动保留但不自动复制到新候选。新Squad子任务自己的repair-history计数重新开始，不自动导入旧Squad历史。v1不具备这里的跨Run预算保证。见 docs/repair-role-config.md 的具体命令及限制。

配置备份：/Users/hengzhuo/.config/councilkit/backups/20260922-squad-cursor-500k/。验收机器回执与日志：/tmp/councilkit-cursor-runtime-20260922/。本文件为部署后本地记录，未额外提交。
