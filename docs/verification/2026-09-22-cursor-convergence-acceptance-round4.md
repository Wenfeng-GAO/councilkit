# Cursor 候选第四次验收快照

候选：767bb8648891955a3b428e6f839c6fa726197582。结论：尚未批准最终交付。

独立复跑：六个受影响测试文件、60 个测试通过；上轮两个外部反例（无 intent 恢复、同 SHA 跨缓存身份复用）均由错误接受变为拒绝。工作树干净，实际 HEAD 与 Cursor 回执一致。证据在 /tmp/councilkit-cursor-convergence-20260921/codex-round4-tests.log 与 codex-round4-edge-probes.jsonl。

现存具体缺口：cli/src/auto/squadctl-bridge.ts:1136 的 policyFileForTask(_taskDir) 仍只返回 defaultSupervisedPolicy()，没有把既有 delivery-authority.json 授权带入正式 gate policy。此项已列入上一轮反馈；当前候选没有实现。正例闭环测试仍覆写 requestPublish，不能据此证明官方发布 gate 能接受合法候选。须在原有授权范围内绑定官方策略，并以临时本地仓库和实际官方发布 gate 验证；不得触碰真实用户 PR 或扩大授权。

Cursor 还主动声明 plan/format 没有独立 consumeRetry 接线，应继续按冻结的 R4 验收条目核实覆盖范围；不能将字段存在等同于预算已生效。此处未新增发现式全审。

本次用户主要询问用量；详细核对见 2026-09-22-codex-cursor-token-usage.md。新候选不得因 60 测试通过而被报告为最终验收通过。
