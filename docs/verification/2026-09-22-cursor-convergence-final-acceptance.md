# CouncilKit 控制协议最终工程验收

结论：**受控环境工程验收通过**。固定候选 `3892dc16df76d3d52a0385c1428990a387dc5341`，本地分支 `hengzhuo/repair-convergence-control`。验收时工作树干净，Cursor 回执与实际 HEAD 一致。本结论针对 CouncilKit 控制协议候选，不是 agentrun PR #128 的准出结论。

## 本轮关闭项

1. 正式发布授权接线：冻结的 profile 与 authority 文件一致时，实际 SquadctlBridge 将授权纳入官方 gate policy。独立运行官方 `squadctl integrate push-remote` 测试：无授权拒绝、授权引用漂移拒绝，两次远端 SHA 均未变化；匹配授权的合格候选成功推至临时 bare remote。未以模拟 requestPublish 绕过官方门禁。
2. 重试预算核对：生产写入入口先持久占用同链预算，下一 Run 继承使用量，耗尽不再调用 writer。独立测试覆盖一次允许、重载继承与下次拒绝。verify 有生产占用路径；diagnose 当前占用后进入需要处理，没有额外模型进程。plan/format 没有独立生产重试执行器，其预留持久字段不宣称为已生效限额；没有为字段新增循环。同一次写入槽恢复不重复计算源码派工次数。

## 证据

- Cursor：真实 `cursor-agent`，初始化记录 `Grok 4.7 256K Extra High`，CLI model ID `grok-4.7-xhigh`；同一会话，本轮 1762.6 秒，进程退出 0。
- Codex 在固定候选独立复跑 3 文件 **19 项测试通过、0 跳过**；CLI / Host 构建均通过。
- Cursor 类型检查通过；日志 `/tmp/councilkit-cursor-convergence-20260921/logs/gap-typecheck.log`。
- 先前 `767bb86` 上独立复跑的 60 项测试与两项外部反例证据按原 SHA 保留。本轮没有改对应 UI；复用其真实 React + API fixture 冒烟，并独立查看截图，不宣称是用户 live Host 冒烟。
- 机器回执：`/tmp/councilkit-cursor-convergence-20260921/codex-acceptance-final.json`；独立日志同目录 `codex-final-3892-tests.log` / `codex-final-3892-build-cli.log` / `codex-final-3892-build-host.log`。

## 交付边界

v2 为显式选择的试行协议；当前适配器支持明确标识的 collaborative，整条流水线的 strong 隔离不可用时拒绝，不能静默降级。真实用户 Host、已安装 skill、COUNCILKIT_HOME 和 PR 均未改动；未 push、merge、部署或重启服务。官方门禁集成验证使用冻结的兼容 Squad skill 版本与临时本地远端，不宣称已安装版本/真实环境已经部署验证。

此次证明了关键控制路径的准出正例、拒绝反例与预算继承；不能据此宣称 PR #128 已修复，或已经通过可比真实任务证明成功交付率、token 成本改善。现有停止条件能够终止预算内不收敛的运行，不保证所有研发问题都能自动修好。

## 本轮可观测用量快照

截至最终记录前：Codex 输入 5,500,002（其中缓存 5,465,984），输出 10,773，总量 5,510,775；Cursor 非缓存输入 1,394,387、缓存读取 16,007,680、输出 67,611，总量 17,469,678。Codex 非缓存输入加输出 44,791，约占两者同口径已记录量的 3.0%；含缓存总量约占 24.0%。本轮未增加 Codex 子代理或多模型 CouncilKit 全审。最终写回/回复的少量后续用量不包含在此快照中。
