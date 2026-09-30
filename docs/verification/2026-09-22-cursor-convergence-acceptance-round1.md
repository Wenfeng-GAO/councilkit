# Cursor 候选最终验收：第一轮未通过

日期：2026-09-22。候选 `689f6eb44279bc464a3b1f7fd9ee349def5d8f33`，分支 `hengzhuo/repair-convergence-control`。

Cursor 已开发、自审、本地提交。Codex 未认可为完整交付；保留该候选和原始证据，反馈回原 Cursor 会话修正。

## 独立检查

独立运行 5 个测试文件，64 项通过（准出装配、合同、裁决、deadline/isolation、repair command）。日志 `/tmp/councilkit-cursor-convergence-20260921/codex-acceptance-selected.log`。

另以工作树外的声明式探针资产调用当前候选真实导出函数，并执行一次 Darwin sandbox 子进程，发现以下 7 个反例：

| 探针 | 实际观察 | 违反的要求 |
|---|---|---|
| 同PR同目标只变review标题 | chainKey 改变 | 原目标预算不应重置 |
| 同finding ID改写断言含义 | assertion ID/version均不变，含义变化 | 断言不可静默改题 |
| 已验证关闭＋另一席未评估 | coverage=false，contradictory_outcome | 弃权不能制造事实冲突 |
| receipt测试资产版本与asset不符 | ok=true | 受测资产版本必须绑定 |
| 生产准出装配缺可信policy | passed=true | 未知策略不能回退为通过 |
| 停止调用失败、进程仍存活 | state=deadline_enforced | 发信号不能冒充确认终止 |
| strong沙箱读取工作树外dummy gh凭据 | exit0，读到哨兵 | 宣称的凭据隔离不成立 |

模拟凭据由本次验收创建，不包含任何真实秘密；没有访问真实PR、推送、改用户授权或终止非本任务进程。停止失败探针使用模拟kill回调，不向真实PID发信号。

探针源：`/tmp/councilkit-cursor-convergence-20260921/codex-acceptance-probes.ts`。结果：同目录 `codex-acceptance-probes.jsonl`。命令 exit 0 仅表示证据采集成功，不表示这些行为通过验收。

## 接线缺口

- production policy 来自复制的测试fixture，不是本task可信冻结策略；生产装配还有null→fixture fallback。
- R1合同从当前findings标题重建；R2未持久消费真实裁决，所有断言仍从raw行重建v1。
- R3评估器与实际Squad逐项测试回执未接线（Cursor也主动声明此限制）。
- consumeRetry没有生产调用；deadline对终止确认、执行身份及子进程范围的保证不足。
- strong能力宣称超过实际sandbox规则；仅探测sandbox-exec存在不足以证明能力。

六组聚焦反馈见 `/tmp/councilkit-cursor-convergence-20260921/acceptance-feedback-1.md`。这些均属于原有规格的未闭环项，不增加新的功能范围。
